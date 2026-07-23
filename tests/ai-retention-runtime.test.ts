import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { DELETE as deleteAssessment, GET as getAssessment } from "../app/api/ai/assessments/[assessmentId]/route";
import { GET as getAssessmentIndex } from "../app/api/ai/assessments/route";
import { buildWorkspaceAssessmentRequestProjection } from "../lib/ai-assessment-request";
import { createFileAIBackupPurgeAdapter } from "../lib/ai-backup-purge";
import { describeFancyHubModels, prepareAIRequest } from "../lib/ai-outbound";
import {
  AI_RETENTION_POLICY_VERSION,
  encryptAIRawContent,
  evaluateAIAssessmentFreshness,
  type AIAssessmentRetentionRecord,
} from "../lib/ai-retention";
import {
  aiRuntimeStoreConfigFromEnvironment,
  createAIRuntimeStoreFromEnvironment,
} from "../lib/ai-runtime-store";
import { loadWorkspaceState } from "../lib/storage";

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

function indexedRecord(input: {
  assessmentId: string;
  actorStableId: string;
  createdAt: string;
  scopeType?: "series" | "model";
  scopeId?: string;
  scopeRevision?: string;
  inputHash?: string;
  ruleSetVersion?: string;
  fiveAxisRuleVersion?: string;
  resultCode?: string;
}): AIAssessmentRetentionRecord {
  const result = record(input);
  const metadata = result.metadata!;
  const scopeType = input.scopeType ?? "model";
  const scopeId = input.scopeId ?? "model-1";
  const scopeRevision = input.scopeRevision ?? "1";
  const inputHash = input.inputHash ?? "b".repeat(64);
  metadata.metadataSchemaVersion = "ai-operation-metadata/v2";
  metadata.scopeStableRef = `${scopeType}:${scopeId}`;
  metadata.scope = { scopeType, scopeId, inputRevision: scopeRevision };
  metadata.ruleSetVersion = input.ruleSetVersion ?? "rules-v1";
  metadata.fiveAxisRuleVersion = input.fiveAxisRuleVersion ?? "five-axis-v1";
  metadata.inputHash = inputHash;
  metadata.attempts = [{
    attemptNumber: 1,
    attemptKind: "INITIAL",
    modelDescriptor: structuredClone(metadata.modelDescriptor),
    requestedAt: input.createdAt,
    completedAt: input.createdAt,
    inputHash,
    resultCode: input.resultCode ?? "SUCCESS",
  }];
  metadata.retryCount = 0;
  metadata.cancellationStatus = "NOT_REQUESTED";
  metadata.resultCode = input.resultCode ?? "SUCCESS";
  if (metadata.resultCode !== "SUCCESS") delete result.semanticContent;
  return result;
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

test("独立删除墓碑阻止删除前 ai-retention 备份恢复后重新暴露内容", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-retention-restore-"));
  const previous = {
    dataDir: process.env.AI_RETENTION_DATA_DIR,
    tombstoneDir: process.env.AI_RETENTION_TOMBSTONE_DIR,
    key: process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64,
    keyVersion: process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION,
  };
  const primary = path.join(root, "ai-retention");
  const tombstones = path.join(root, "ai-deletion-tombstones");
  process.env.AI_RETENTION_DATA_DIR = primary;
  process.env.AI_RETENTION_TOMBSTONE_DIR = tombstones;
  process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString("base64");
  process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = "key-v1";
  try {
    const store = createAIRuntimeStoreFromEnvironment();
    await store.initialize();
    const source = record({
      assessmentId: "assessment-restore-blocked",
      actorStableId: "owner-restore",
      createdAt: "2026-07-23T00:00:00.000Z",
    });
    await store.saveAssessment(source);
    const assessmentFile = path.join(
      primary,
      "assessments",
      "assessment-restore-blocked.json",
    );
    const deletionPredecessor = await readFile(assessmentFile, "utf8");
    await store.requestAssessmentDeletion({
      assessmentId: "assessment-restore-blocked",
      actorStableId: "owner-restore",
      now: new Date("2026-07-23T01:00:00.000Z"),
    });

    // Simulate restoring the whole backed-up ai-retention directory while the
    // independent, non-backup tombstone directory remains authoritative.
    await writeFile(assessmentFile, deletionPredecessor, "utf8");
    const restoredStore = createAIRuntimeStoreFromEnvironment();
    await restoredStore.initialize();
    assert.equal(await restoredStore.readAssessmentForActor({
      assessmentId: "assessment-restore-blocked",
      actorStableId: "owner-restore",
    }), undefined);
    const hidden = await restoredStore.readAssessmentForActor({
      assessmentId: "assessment-restore-blocked",
      actorStableId: "owner-restore",
      includeHidden: true,
    });
    assert.equal(hidden?.visibility, "HIDDEN");
    assert.equal(hidden?.deletionTombstone?.requestedAt, "2026-07-23T01:00:00.000Z");
    assert.deepEqual(await restoredStore.listAssessmentsForActorScope({
      actorStableId: "owner-restore",
      scopeType: "model",
      scopeId: "model-1",
    }), []);
    await assert.rejects(
      restoredStore.saveAssessment(source),
      /永久删除墓碑占用/,
    );
  } finally {
    if (previous.dataDir === undefined) delete process.env.AI_RETENTION_DATA_DIR;
    else process.env.AI_RETENTION_DATA_DIR = previous.dataDir;
    if (previous.tombstoneDir === undefined) delete process.env.AI_RETENTION_TOMBSTONE_DIR;
    else process.env.AI_RETENTION_TOMBSTONE_DIR = previous.tombstoneDir;
    if (previous.key === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = previous.key;
    if (previous.keyVersion === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = previous.keyVersion;
    await rm(root, { recursive: true, force: true });
  }
});

test("删除墓碑目录与 AI 主存储或备份目录任一方向重叠都 fail-closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-retention-paths-"));
  const previous = new Map([
    "AI_RETENTION_DATA_DIR",
    "AI_RETENTION_TOMBSTONE_DIR",
    "AI_RETENTION_ENCRYPTION_KEY_BASE64",
    "AI_RETENTION_ENCRYPTION_KEY_VERSION",
    "WORKSPACE_BACKUP_DIR",
  ].map((name) => [name, process.env[name]]));
  const dataDir = path.join(root, "primary", "ai-retention");
  const backupDir = path.join(root, "backup-domain", "backups");
  process.env.AI_RETENTION_DATA_DIR = dataDir;
  process.env.WORKSPACE_BACKUP_DIR = backupDir;
  process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString("base64");
  process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = "key-v1";
  try {
    for (const tombstoneDir of [
      dataDir,
      path.join(dataDir, "tombstones"),
      path.dirname(dataDir),
      backupDir,
      path.join(backupDir, "tombstones"),
      path.dirname(backupDir),
    ]) {
      process.env.AI_RETENTION_TOMBSTONE_DIR = tombstoneDir;
      assert.equal(
        aiRuntimeStoreConfigFromEnvironment(),
        undefined,
        `overlap should fail closed: ${tombstoneDir}`,
      );
    }
    process.env.AI_RETENTION_TOMBSTONE_DIR = path.join(root, "independent", "tombstones");
    assert.ok(aiRuntimeStoreConfigFromEnvironment());
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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

test("仅剩独立墓碑时仍可驱动备份清理，失败状态与审计在主目录恢复后可重试且幂等", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-retention-tombstone-only-"));
  const primary = path.join(root, "primary");
  const tombstones = path.join(root, "deletion-tombstones");
  const backups = path.join(root, "backups");
  const previous = {
    dataDir: process.env.AI_RETENTION_DATA_DIR,
    tombstoneDir: process.env.AI_RETENTION_TOMBSTONE_DIR,
    key: process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64,
    keyVersion: process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION,
  };
  process.env.AI_RETENTION_DATA_DIR = primary;
  process.env.AI_RETENTION_TOMBSTONE_DIR = tombstones;
  process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = randomBytes(32).toString("base64");
  process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = "key-v1";
  let failPurge = true;
  let purgeCalls = 0;
  try {
    const assessmentId = "assessment-tombstone-only";
    const actorStableId = "owner-tombstone-only";
    const deletedAt = new Date("2026-07-23T01:00:00.000Z");
    const sweepAt = new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1_000);
    const store = createAIRuntimeStoreFromEnvironment();
    await store.initialize();
    await store.saveAssessment(record({
      assessmentId,
      actorStableId,
      createdAt: "2026-07-23T00:00:00.000Z",
    }));
    await store.requestAssessmentDeletion({ assessmentId, actorStableId, now: deletedAt });
    await rm(path.join(primary, "assessments", `${assessmentId}.json`));

    const backupFile = path.join(
      backups,
      "2026-07-24T03-30-00-000Z",
      "ai-retention",
      "assessments",
      `${assessmentId}.json`,
    );
    await mkdir(path.dirname(backupFile), { recursive: true });
    await writeFile(backupFile, "backup copy\n", "utf8");
    const fileAdapter = createFileAIBackupPurgeAdapter(backups);
    const adapter = {
      async purgeAssessmentBackups(input: Parameters<typeof fileAdapter.purgeAssessmentBackups>[0]) {
        purgeCalls += 1;
        if (failPurge) throw new Error("INJECTED_BACKUP_PURGE_FAILURE");
        await fileAdapter.purgeAssessmentBackups(input);
      },
      verifyAssessmentBackupsAbsent: fileAdapter.verifyAssessmentBackupsAbsent,
    };

    const failed = await store.sweepRetention({ now: sweepAt, backupAdapter: adapter });
    assert.deepEqual(failed, {
      recordsScanned: 1,
      recordsChanged: 1,
      auditEventsWritten: 2,
      backupPurgeFailures: 1,
    });
    assert.equal(purgeCalls, 1);
    const failedTombstone = JSON.parse(
      await readFile(path.join(tombstones, `${assessmentId}.json`), "utf8"),
    ) as {
      tombstone: {
        backupPurgeState?: string;
        backupPurgeAttempts?: number;
        backupPurgeLastErrorCode?: string;
      };
      cleanupAuditEvents?: Array<{ action: string }>;
    };
    assert.equal(failedTombstone.tombstone.backupPurgeState, "FAILED");
    assert.equal(failedTombstone.tombstone.backupPurgeAttempts, 1);
    assert.equal(failedTombstone.tombstone.backupPurgeLastErrorCode, "INJECTED_BACKUP_PURGE_FAILURE");
    assert.deepEqual(
      failedTombstone.cleanupAuditEvents?.map((event) => event.action),
      ["AI_BACKUP_PURGE_DUE", "AI_BACKUP_PURGE_FAILED"],
    );

    // Simulate restoring the primary AI domain from a snapshot that contains
    // neither the assessment nor its cleanup audit stream.
    await rm(primary, { recursive: true, force: true });
    failPurge = false;
    const restoredStore = createAIRuntimeStoreFromEnvironment();
    await restoredStore.initialize();
    const retried = await restoredStore.sweepRetention({ now: sweepAt, backupAdapter: adapter });
    assert.equal(retried.recordsScanned, 1);
    assert.equal(retried.recordsChanged, 1);
    assert.equal(retried.backupPurgeFailures, 0);
    assert.equal(purgeCalls, 2);
    assert.equal(await lstat(backupFile).then(() => true).catch(() => false), false);

    const completedTombstone = JSON.parse(
      await readFile(path.join(tombstones, `${assessmentId}.json`), "utf8"),
    ) as {
      tombstone: { backupPurgeState?: string; backupPurgeAttempts?: number; backupPurgedAt?: string };
    };
    assert.equal(completedTombstone.tombstone.backupPurgeState, "PURGED");
    assert.equal(completedTombstone.tombstone.backupPurgeAttempts, 2);
    assert.ok(completedTombstone.tombstone.backupPurgedAt);
    const restoredAudits = (await readFile(path.join(primary, "audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string });
    assert.deepEqual(
      restoredAudits.map((event) => event.action),
      ["AI_BACKUP_PURGE_DUE", "AI_BACKUP_PURGE_FAILED", "AI_BACKUP_PURGED"],
    );

    const idempotent = await restoredStore.sweepRetention({ now: sweepAt, backupAdapter: adapter });
    assert.equal(idempotent.recordsScanned, 1);
    assert.equal(idempotent.recordsChanged, 0);
    assert.equal(idempotent.auditEventsWritten, 0);
    assert.equal(idempotent.backupPurgeFailures, 0);
    assert.equal(purgeCalls, 2);
    const idempotentAudits = (await readFile(path.join(primary, "audit.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(idempotentAudits.length, 3);
  } finally {
    if (previous.dataDir === undefined) delete process.env.AI_RETENTION_DATA_DIR;
    else process.env.AI_RETENTION_DATA_DIR = previous.dataDir;
    if (previous.tombstoneDir === undefined) delete process.env.AI_RETENTION_TOMBSTONE_DIR;
    else process.env.AI_RETENTION_TOMBSTONE_DIR = previous.tombstoneDir;
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

test("评估新鲜度冻结完整输入账本，失败或语义到期时始终禁止转草稿", () => {
  const successful = indexedRecord({
    assessmentId: "assessment-freshness-success",
    actorStableId: "owner-freshness",
    createdAt: "2026-07-23T00:00:00.000Z",
  }).metadata!;
  const current = {
    scopeType: "model" as const,
    scopeId: "model-1",
    inputRevision: "1",
    ruleSetVersion: "rules-v1",
    fiveAxisRuleVersion: "five-axis-v1",
    inputHash: "b".repeat(64),
  };
  assert.deepEqual(
    evaluateAIAssessmentFreshness(successful, current, { semanticContentAvailable: true }),
    { state: "fresh", canCreateDraft: true, staleReasonCodes: [] },
  );

  const changed = evaluateAIAssessmentFreshness(successful, {
    ...current,
    inputRevision: "2",
    ruleSetVersion: "rules-v2",
    fiveAxisRuleVersion: "five-axis-v2",
    inputHash: "c".repeat(64),
  }, { semanticContentAvailable: true });
  assert.equal(changed.state, "stale");
  assert.equal(changed.canCreateDraft, false);
  assert.deepEqual(changed.staleReasonCodes, [
    "AI_INPUT_REVISION_CHANGED",
    "AI_INPUT_HASH_CHANGED",
    "AI_RULESET_VERSION_CHANGED",
    "AI_FIVE_AXIS_RULE_VERSION_CHANGED",
  ]);

  const failed = indexedRecord({
    assessmentId: "assessment-freshness-failed",
    actorStableId: "owner-freshness",
    createdAt: "2026-07-23T00:00:00.000Z",
    resultCode: "AI_MODEL_REVISION_MISMATCH",
  }).metadata!;
  const failedFreshness = evaluateAIAssessmentFreshness(
    failed,
    current,
    { semanticContentAvailable: false },
  );
  assert.equal(failedFreshness.canCreateDraft, false);
  assert.deepEqual(failedFreshness.staleReasonCodes, [
    "AI_ASSESSMENT_NOT_SUCCESSFUL",
    "AI_SEMANTIC_CONTENT_UNAVAILABLE",
  ]);
});

test("180 天 raw 到期后完整操作元数据继续保留，权威索引并发保存不覆盖", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-operation-index-"));
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
    const earlier = indexedRecord({
      assessmentId: "assessment-index-earlier",
      actorStableId: "owner-index",
      createdAt: "2026-07-23T00:00:00.000Z",
    });
    const latest = indexedRecord({
      assessmentId: "assessment-index-latest",
      actorStableId: "owner-index",
      createdAt: "2026-07-23T00:00:01.000Z",
    });
    await Promise.all([
      store.saveAssessment(earlier),
      store.saveAssessment(latest),
      store.saveAssessment(indexedRecord({
        assessmentId: "assessment-index-other-owner",
        actorStableId: "other-owner",
        createdAt: "2026-07-23T00:00:02.000Z",
      })),
    ]);

    const indexed = await store.listAssessmentsForActorScope({
      actorStableId: "owner-index",
      scopeType: "model",
      scopeId: "model-1",
    });
    assert.deepEqual(
      indexed.map((entry) => entry.metadata?.assessmentId),
      ["assessment-index-latest", "assessment-index-earlier"],
    );

    await store.sweepRetention({
      now: new Date("2027-01-21T00:00:02.000Z"),
      backupAdapter: {
        async purgeAssessmentBackups() {},
        async verifyAssessmentBackupsAbsent() { return true; },
      },
    });
    const retained = await store.readAssessmentForActor({
      assessmentId: "assessment-index-latest",
      actorStableId: "owner-index",
    });
    assert.equal(retained?.encryptedRawContent, undefined);
    assert.ok(retained?.semanticContent);
    assert.equal(retained?.metadata?.state, "ACTIVE");
    assert.deepEqual(retained?.metadata?.scope, {
      scopeType: "model",
      scopeId: "model-1",
      inputRevision: "1",
    });
    assert.equal(retained?.metadata?.ruleSetVersion, "rules-v1");
    assert.equal(retained?.metadata?.fiveAxisRuleVersion, "five-axis-v1");
    assert.equal(retained?.metadata?.attempts?.[0]?.attemptKind, "INITIAL");
    assert.equal(retained?.metadata?.retryCount, 0);
    assert.equal(retained?.metadata?.cancellationStatus, "NOT_REQUESTED");
    assert.equal(retained?.metadata?.resultCode, "SUCCESS");
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

test("GET 评估索引按 owner 和 scope 恢复最新记录，并按当前输入计算 freshness", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-index-route-"));
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
  process.env.FEISHU_PROXY_SHARED_SECRET = "retention-index-secret";
  process.env.FEISHU_TENANT_KEY = "tenant";
  const request = (openId: string, scopeType: string, scopeId: string) =>
    new NextRequest(`http://localhost/api/ai/assessments?scopeType=${scopeType}&scopeId=${encodeURIComponent(scopeId)}`, {
      method: "GET",
      headers: {
        "x-feishu-tenant-key": "tenant",
        "x-feishu-open-id": openId,
        "x-feishu-display-name": openId,
        "x-tf-proxy-secret": "retention-index-secret",
      },
    });
  try {
    const current = await loadWorkspaceState();
    const model = current.state.purchasableModels[0]!;
    const assessmentId = "assessment-index-route";
    const modelDescriptor = record({
      assessmentId,
      actorStableId: "route-index-owner",
      createdAt: "2026-07-23T00:00:00.000Z",
    }).metadata!.modelDescriptor;
    const projection = buildWorkspaceAssessmentRequestProjection({
      state: current.state,
      scope: { scopeType: "model", scopeId: model.id },
      assessmentId,
      model: modelDescriptor,
    });
    const inputHash = prepareAIRequest({ envelope: projection.envelope }).inputHash;
    const stored = indexedRecord({
      assessmentId,
      actorStableId: "route-index-owner",
      createdAt: "2026-07-23T00:00:00.000Z",
      scopeType: "model",
      scopeId: model.id,
      scopeRevision: projection.operationMetadataContext.scopeRevision,
      inputHash,
      ruleSetVersion: projection.operationMetadataContext.ruleSetVersion,
      fiveAxisRuleVersion: projection.operationMetadataContext.fiveAxisRuleVersion,
    });
    stored.metadata!.modelDescriptor = modelDescriptor;
    stored.metadata!.attempts![0]!.modelDescriptor = modelDescriptor;
    const store = createAIRuntimeStoreFromEnvironment();
    await store.initialize();
    await store.saveAssessment(stored);

    const restored = await getAssessmentIndex(request("route-index-owner", "model", model.id));
    assert.equal(restored.status, 200);
    const payload = await restored.json() as {
      assessmentId: string;
      freshness: { state: string; canCreateDraft: boolean };
      result?: { findings: unknown[] };
    };
    assert.equal(payload.assessmentId, assessmentId);
    assert.deepEqual(payload.freshness, { state: "fresh", canCreateDraft: true, staleReasonCodes: [] });
    assert.ok(payload.result);
    assert.equal((await getAssessmentIndex(request("other-user", "model", model.id))).status, 404);
    assert.equal((await getAssessmentIndex(request("route-index-owner", "model", "model:missing"))).status, 404);

    await store.requestAssessmentDeletion({
      assessmentId,
      actorStableId: "route-index-owner",
      now: new Date("2026-07-23T01:00:00.000Z"),
    });
    assert.equal((await getAssessmentIndex(request("route-index-owner", "model", model.id))).status, 404);

    const failedAssessmentId = "assessment-index-route-failed";
    const failedProjection = buildWorkspaceAssessmentRequestProjection({
      state: current.state,
      scope: { scopeType: "model", scopeId: model.id },
      assessmentId: failedAssessmentId,
      model: modelDescriptor,
    });
    const failed = indexedRecord({
      assessmentId: failedAssessmentId,
      actorStableId: "route-index-owner",
      createdAt: "2026-07-23T02:00:00.000Z",
      scopeType: "model",
      scopeId: model.id,
      scopeRevision: failedProjection.operationMetadataContext.scopeRevision,
      inputHash: prepareAIRequest({ envelope: failedProjection.envelope }).inputHash,
      ruleSetVersion: failedProjection.operationMetadataContext.ruleSetVersion,
      fiveAxisRuleVersion: failedProjection.operationMetadataContext.fiveAxisRuleVersion,
      resultCode: "AI_MODEL_REVISION_MISMATCH",
    });
    failed.metadata!.modelDescriptor = modelDescriptor;
    failed.metadata!.attempts![0]!.modelDescriptor = modelDescriptor;
    await store.saveAssessment(failed);
    const failedResponse = await getAssessmentIndex(request("route-index-owner", "model", model.id));
    assert.equal(failedResponse.status, 200);
    const failedPayload = await failedResponse.json() as {
      assessmentId: string;
      freshness: { canCreateDraft: boolean; staleReasonCodes: string[] };
      result?: unknown;
    };
    assert.equal(failedPayload.assessmentId, failedAssessmentId);
    assert.equal(failedPayload.freshness.canCreateDraft, false);
    assert.deepEqual(failedPayload.freshness.staleReasonCodes, [
      "AI_ASSESSMENT_NOT_SUCCESSFUL",
      "AI_SEMANTIC_CONTENT_UNAVAILABLE",
    ]);
    assert.equal(failedPayload.result, undefined);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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
