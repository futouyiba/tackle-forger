import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { DELETE as deleteAssessment, GET as getAssessment } from "../app/api/ai/assessments/[assessmentId]/route";
import { createFileAIBackupPurgeAdapter } from "../lib/ai-backup-purge";
import { describeFancyHubModels } from "../lib/ai-outbound";
import {
  AI_RETENTION_POLICY_VERSION,
  encryptAIRawContent,
  type AIAssessmentRetentionRecord,
} from "../lib/ai-retention";
import { createAIRuntimeStoreFromEnvironment } from "../lib/ai-runtime-store";

function record(input: { assessmentId: string; actorStableId: string; createdAt: string }): AIAssessmentRetentionRecord {
  return {
    policyVersion: AI_RETENTION_POLICY_VERSION,
    visibility: "VISIBLE",
    metadata: {
      assessmentId: input.assessmentId,
      actorStableId: input.actorStableId,
      scopeStableRef: "model:model-1",
      modelDescriptor: describeFancyHubModels([{
        modelId: "model.alpha",
        modelVersion: "2026-07-23",
        deploymentRevision: "deploy.7",
        modelArtifactDigest: "sha256:abc",
      }]).models[0]!,
      promptTemplateVersion: "prompt-v1",
      promptTemplateHash: "a".repeat(64),
      schemaVersion: "ai-request/v1",
      allowlistPolicyVersion: "ai-provider/open006-v1",
      inputHash: "b".repeat(64),
      requestedAt: input.createdAt,
      completedAt: input.createdAt,
      resultCode: "SUCCESS",
      state: "ACTIVE",
    },
    encryptedRawContent: encryptAIRawContent({
      assessmentId: input.assessmentId,
      plaintext: "sensitive",
      key: Buffer.alloc(32, 1),
      keyVersion: "key-v1",
    }),
    semanticContent: {
      findings: [], recommendations: [], assumptions: [], uncoveredInformation: [], evidenceRefs: [],
    },
    rawContentCreatedAt: input.createdAt,
    semanticContentCreatedAt: input.createdAt,
    operationLogCreatedAt: input.createdAt,
    operationLog: { action: "AI_FANCY_HUB_ASSESSMENT", resultCode: "SUCCESS" },
  };
}

test("文件留存只允许所有者读取和删除，删除幂等且立即隐藏", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-retention-store-"));
  const previous = {
    dataDir: process.env.AI_RETENTION_DATA_DIR,
    key: process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64,
    keyVersion: process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION,
  };
  process.env.AI_RETENTION_DATA_DIR = path.join(root, "primary");
  process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString("base64");
  process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = "key-v1";
  try {
    const store = createAIRuntimeStoreFromEnvironment();
    await store.initialize();
    await store.saveAssessment(record({ assessmentId: "assessment-1", actorStableId: "owner-1", createdAt: "2026-07-23T00:00:00.000Z" }));

    assert.ok(await store.readAssessmentForActor({ assessmentId: "assessment-1", actorStableId: "owner-1" }));
    assert.equal(await store.readAssessmentForActor({ assessmentId: "assessment-1", actorStableId: "other-user" }), undefined);
    assert.equal(await store.requestAssessmentDeletion({ assessmentId: "assessment-1", actorStableId: "other-user" }), undefined);

    const deletionTime = new Date("2026-07-23T01:00:00.000Z");
    const deleted = await store.requestAssessmentDeletion({ assessmentId: "assessment-1", actorStableId: "owner-1", now: deletionTime });
    assert.equal(deleted?.visibility, "HIDDEN");
    assert.equal(deleted?.metadata?.state, "USER_DELETED");
    assert.equal(await store.readAssessmentForActor({ assessmentId: "assessment-1", actorStableId: "owner-1" }), undefined);
    assert.equal((await store.readAssessmentForActor({ assessmentId: "assessment-1", actorStableId: "owner-1", includeHidden: true }))?.deletionTombstone?.requestedAt, deletionTime.toISOString());

    const retried = await store.requestAssessmentDeletion({ assessmentId: "assessment-1", actorStableId: "owner-1", now: new Date("2026-07-24T00:00:00.000Z") });
    assert.equal(retried?.deletionTombstone?.requestedAt, deletionTime.toISOString());
    const audits = (await readFile(path.join(root, "primary", "audit.jsonl"), "utf8")).trim().split("\n");
    assert.equal(audits.length, 1);
    assert.match(audits[0]!, /"action":"AI_ASSESSMENT_HIDDEN"/);
    assert.match(audits[0]!, /"actorStableId":"owner-1"/);
  } finally {
    if (previous.dataDir === undefined) delete process.env.AI_RETENTION_DATA_DIR;
    else process.env.AI_RETENTION_DATA_DIR = previous.dataDir;
    if (previous.key === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = previous.key;
    if (previous.keyVersion === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = previous.keyVersion;
    await rm(root, { recursive: true, force: true });
  }
});

test("删除状态提交后审计进程中断，重试补写且不产生重复事件", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-retention-outbox-"));
  const previous = {
    dataDir: process.env.AI_RETENTION_DATA_DIR,
    key: process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64,
    keyVersion: process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION,
  };
  process.env.AI_RETENTION_DATA_DIR = path.join(root, "primary");
  process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString("base64");
  process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = "key-v1";
  let interruptAfterAppend = true;
  try {
    const store = createAIRuntimeStoreFromEnvironment({
      afterRetentionAuditAppended(event) {
        if (interruptAfterAppend && event.action === "AI_ASSESSMENT_HIDDEN") {
          interruptAfterAppend = false;
          throw new Error("INJECTED_CRASH_AFTER_AUDIT_APPEND");
        }
      },
    });
    await store.initialize();
    await store.saveAssessment(record({
      assessmentId: "assessment-outbox",
      actorStableId: "owner-outbox",
      createdAt: "2026-07-23T00:00:00.000Z",
    }));

    await assert.rejects(
      store.requestAssessmentDeletion({
        assessmentId: "assessment-outbox",
        actorStableId: "owner-outbox",
        now: new Date("2026-07-23T01:00:00.000Z"),
      }),
      /INJECTED_CRASH_AFTER_AUDIT_APPEND/,
    );
    const hidden = await store.readAssessmentForActor({
      assessmentId: "assessment-outbox",
      actorStableId: "owner-outbox",
      includeHidden: true,
    });
    assert.equal(hidden?.visibility, "HIDDEN");
    assert.equal("runtimeAuditOutbox" in (hidden ?? {}), false);

    const recovered = await store.requestAssessmentDeletion({
      assessmentId: "assessment-outbox",
      actorStableId: "owner-outbox",
      now: new Date("2026-07-24T00:00:00.000Z"),
    });
    assert.equal(recovered?.deletionTombstone?.requestedAt, "2026-07-23T01:00:00.000Z");
    const audits = (await readFile(path.join(root, "primary", "audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string; eventId?: string });
    assert.equal(audits.filter((event) => event.action === "AI_ASSESSMENT_HIDDEN").length, 1);
    assert.match(audits[0]?.eventId ?? "", /^[A-Za-z0-9_-]{32}$/);
    const stored = JSON.parse(await readFile(
      path.join(root, "primary", "assessments", "assessment-outbox.json"),
      "utf8",
    )) as { runtimeAuditOutbox?: unknown };
    assert.equal(stored.runtimeAuditOutbox, undefined);
  } finally {
    if (previous.dataDir === undefined) delete process.env.AI_RETENTION_DATA_DIR;
    else process.env.AI_RETENTION_DATA_DIR = previous.dataDir;
    if (previous.key === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = previous.key;
    if (previous.keyVersion === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = previous.keyVersion;
    await rm(root, { recursive: true, force: true });
  }
});

test("审计 append 前失败时保留待写事件，恢复后只写一次", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-retention-before-append-"));
  const previous = {
    dataDir: process.env.AI_RETENTION_DATA_DIR,
    key: process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64,
    keyVersion: process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION,
  };
  process.env.AI_RETENTION_DATA_DIR = path.join(root, "primary");
  process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString("base64");
  process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = "key-v1";
  let interruptBeforeAppend = true;
  try {
    const store = createAIRuntimeStoreFromEnvironment({
      beforeRetentionAuditAppend(event) {
        if (interruptBeforeAppend && event.action === "AI_ASSESSMENT_HIDDEN") {
          interruptBeforeAppend = false;
          throw new Error("INJECTED_FAILURE_BEFORE_AUDIT_APPEND");
        }
      },
    });
    await store.initialize();
    await store.saveAssessment(record({
      assessmentId: "assessment-before-append",
      actorStableId: "owner-before-append",
      createdAt: "2026-07-23T00:00:00.000Z",
    }));
    await assert.rejects(
      store.requestAssessmentDeletion({
        assessmentId: "assessment-before-append",
        actorStableId: "owner-before-append",
        now: new Date("2026-07-23T01:00:00.000Z"),
      }),
      /INJECTED_FAILURE_BEFORE_AUDIT_APPEND/,
    );
    assert.equal(
      await readFile(path.join(root, "primary", "audit.jsonl"), "utf8").then(() => true).catch(() => false),
      false,
    );

    await store.requestAssessmentDeletion({
      assessmentId: "assessment-before-append",
      actorStableId: "owner-before-append",
      now: new Date("2026-07-24T00:00:00.000Z"),
    });
    const audits = (await readFile(path.join(root, "primary", "audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string });
    assert.equal(audits.filter((event) => event.action === "AI_ASSESSMENT_HIDDEN").length, 1);
  } finally {
    if (previous.dataDir === undefined) delete process.env.AI_RETENTION_DATA_DIR;
    else process.env.AI_RETENTION_DATA_DIR = previous.dataDir;
    if (previous.key === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = previous.key;
    if (previous.keyVersion === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = previous.keyVersion;
    await rm(root, { recursive: true, force: true });
  }
});

test("全量 sweep 清除主内容，并按 assessmentId 删除所有备份且回读确认", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-retention-sweep-"));
  const primary = path.join(root, "primary");
  const backups = path.join(root, "backups");
  const previous = {
    dataDir: process.env.AI_RETENTION_DATA_DIR,
    key: process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64,
    keyVersion: process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION,
  };
  process.env.AI_RETENTION_DATA_DIR = primary;
  process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString("base64");
  process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = "key-v1";
  try {
    const store = createAIRuntimeStoreFromEnvironment();
    await store.initialize();
    await store.saveAssessment(record({ assessmentId: "assessment-2", actorStableId: "owner-2", createdAt: "2026-07-23T00:00:00.000Z" }));
    const deletedAt = new Date("2026-07-23T01:00:00.000Z");
    await store.requestAssessmentDeletion({ assessmentId: "assessment-2", actorStableId: "owner-2", now: deletedAt });

    const backupFiles = [
      path.join(backups, "2026-07-23T03-30-00-000Z", "ai-retention", "assessments", "assessment-2.json"),
      path.join(backups, "2026-07-24T03-30-00-000Z", "ai-retention", "assessments", "assessment-2.json"),
    ];
    for (const file of backupFiles) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "backup copy\n", "utf8");
    }
    const unrelated = path.join(backups, "2026-07-24T03-30-00-000Z", "ai-retention", "assessments", "assessment-other.json");
    await writeFile(unrelated, "keep\n", "utf8");

    const summary = await store.sweepRetention({
      now: new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
      backupAdapter: createFileAIBackupPurgeAdapter(backups),
    });
    assert.equal(summary.recordsScanned, 1);
    assert.equal(summary.recordsChanged, 1);
    assert.equal(summary.backupPurgeFailures, 0);
    for (const file of backupFiles) {
      assert.equal(await lstat(file).then(() => true).catch(() => false), false);
    }
    assert.equal(await readFile(unrelated, "utf8"), "keep\n");

    const swept = await store.readAssessmentForActor({ assessmentId: "assessment-2", actorStableId: "owner-2", includeHidden: true });
    assert.equal(swept?.encryptedRawContent, undefined);
    assert.equal(swept?.semanticContent, undefined);
    assert.equal(swept?.deletionTombstone?.backupPurgeState, "PURGED");
    assert.ok(swept?.deletionTombstone?.backupPurgedAt);
    const audit = await readFile(path.join(primary, "audit.jsonl"), "utf8");
    assert.match(audit, /"action":"AI_PRIMARY_CONTENT_PURGED"/);
    assert.match(audit, /"action":"AI_BACKUP_PURGED"/);
  } finally {
    if (previous.dataDir === undefined) delete process.env.AI_RETENTION_DATA_DIR;
    else process.env.AI_RETENTION_DATA_DIR = previous.dataDir;
    if (previous.key === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = previous.key;
    if (previous.keyVersion === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = previous.keyVersion;
    await rm(root, { recursive: true, force: true });
  }
});

test("备份清除审计中断后重试只补账，不重复执行物理删除", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-retention-purge-outbox-"));
  const primary = path.join(root, "primary");
  const backups = path.join(root, "backups");
  const previous = {
    dataDir: process.env.AI_RETENTION_DATA_DIR,
    key: process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64,
    keyVersion: process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION,
  };
  process.env.AI_RETENTION_DATA_DIR = primary;
  process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString("base64");
  process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = "key-v1";
  let interruptBeforeCommit = false;
  let interruptBackupAudit = false;
  let purgeCalls = 0;
  try {
    const store = createAIRuntimeStoreFromEnvironment({
      afterRetentionAuditAppended(event) {
        if (interruptBackupAudit && event.action === "AI_BACKUP_PURGED") {
          interruptBackupAudit = false;
          throw new Error("INJECTED_CRASH_AFTER_BACKUP_AUDIT_APPEND");
        }
      },
      beforeAssessmentMutationCommitted(input) {
        if (interruptBeforeCommit
          && input.auditEvents.some((event) => event.action === "AI_BACKUP_PURGED")) {
          interruptBeforeCommit = false;
          throw new Error("INJECTED_CRASH_AFTER_PHYSICAL_PURGE");
        }
      },
    });
    await store.initialize();
    await store.saveAssessment(record({
      assessmentId: "assessment-purge-outbox",
      actorStableId: "owner-purge",
      createdAt: "2026-07-23T00:00:00.000Z",
    }));
    const deletedAt = new Date("2026-07-23T01:00:00.000Z");
    await store.requestAssessmentDeletion({
      assessmentId: "assessment-purge-outbox",
      actorStableId: "owner-purge",
      now: deletedAt,
    });
    const backupFile = path.join(
      backups,
      "2026-07-23T03-30-00-000Z",
      "ai-retention",
      "assessments",
      "assessment-purge-outbox.json",
    );
    await mkdir(path.dirname(backupFile), { recursive: true });
    await writeFile(backupFile, "backup copy\n", "utf8");
    const fileAdapter = createFileAIBackupPurgeAdapter(backups);
    const adapter = {
      async purgeAssessmentBackups(input: Parameters<typeof fileAdapter.purgeAssessmentBackups>[0]) {
        purgeCalls += 1;
        await fileAdapter.purgeAssessmentBackups(input);
      },
      verifyAssessmentBackupsAbsent: fileAdapter.verifyAssessmentBackupsAbsent,
    };
    const sweepAt = new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1_000);
    interruptBeforeCommit = true;
    await assert.rejects(
      store.sweepRetention({ now: sweepAt, backupAdapter: adapter }),
      /INJECTED_CRASH_AFTER_PHYSICAL_PURGE/,
    );
    assert.equal(purgeCalls, 1);
    assert.equal(await lstat(backupFile).then(() => true).catch(() => false), false);
    const notCommitted = await store.readAssessmentForActor({
      assessmentId: "assessment-purge-outbox",
      actorStableId: "owner-purge",
      includeHidden: true,
    });
    assert.equal(notCommitted?.deletionTombstone?.backupPurgeState, undefined);

    interruptBackupAudit = true;
    await assert.rejects(
      store.sweepRetention({ now: sweepAt, backupAdapter: adapter }),
      /INJECTED_CRASH_AFTER_BACKUP_AUDIT_APPEND/,
    );
    assert.equal(purgeCalls, 1);

    await store.sweepRetention({ now: sweepAt, backupAdapter: adapter });
    assert.equal(purgeCalls, 1);
    const audits = (await readFile(path.join(primary, "audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string });
    assert.equal(audits.filter((event) => event.action === "AI_BACKUP_PURGED").length, 1);
    assert.equal(audits.filter((event) => event.action === "AI_PRIMARY_CONTENT_PURGED").length, 1);
    const swept = await store.readAssessmentForActor({
      assessmentId: "assessment-purge-outbox",
      actorStableId: "owner-purge",
      includeHidden: true,
    });
    assert.equal(swept?.deletionTombstone?.backupPurgeState, "PURGED");
  } finally {
    if (previous.dataDir === undefined) delete process.env.AI_RETENTION_DATA_DIR;
    else process.env.AI_RETENTION_DATA_DIR = previous.dataDir;
    if (previous.key === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = previous.key;
    if (previous.keyVersion === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = previous.keyVersion;
    await rm(root, { recursive: true, force: true });
  }
});

test("GET/DELETE assessment 路由不泄露非所有者记录并保持删除幂等", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-retention-route-"));
  const names = [
    "AI_RETENTION_DATA_DIR",
    "AI_RETENTION_ENCRYPTION_KEY_BASE64",
    "AI_RETENTION_ENCRYPTION_KEY_VERSION",
    "FEISHU_TRUST_PROXY_HEADERS",
    "FEISHU_PROXY_SHARED_SECRET",
    "FEISHU_TENANT_KEY",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.AI_RETENTION_DATA_DIR = path.join(root, "primary");
  process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString("base64");
  process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = "key-v1";
  process.env.FEISHU_TRUST_PROXY_HEADERS = "true";
  process.env.FEISHU_PROXY_SHARED_SECRET = "retention-route-secret";
  process.env.FEISHU_TENANT_KEY = "tenant";
  const request = (method: "GET" | "DELETE", openId: string) => new NextRequest("http://localhost/api/ai/assessments/assessment-route", {
    method,
    headers: {
      "x-feishu-tenant-key": "tenant",
      "x-feishu-open-id": openId,
      "x-feishu-display-name": openId,
      "x-tf-proxy-secret": "retention-route-secret",
    },
  });
  const context = { params: Promise.resolve({ assessmentId: "assessment-route" }) };
  try {
    const store = createAIRuntimeStoreFromEnvironment();
    await store.initialize();
    await store.saveAssessment(record({ assessmentId: "assessment-route", actorStableId: "route-owner", createdAt: "2026-07-23T00:00:00.000Z" }));

    assert.equal((await getAssessment(request("GET", "route-owner"), context)).status, 200);
    assert.equal((await getAssessment(request("GET", "other-user"), context)).status, 404);
    const deleted = await deleteAssessment(request("DELETE", "route-owner"), context);
    assert.equal(deleted.status, 200);
    assert.equal(((await deleted.json()) as { visibility: string }).visibility, "HIDDEN");
    assert.equal((await getAssessment(request("GET", "route-owner"), context)).status, 404);
    assert.equal((await deleteAssessment(request("DELETE", "route-owner"), context)).status, 200);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
