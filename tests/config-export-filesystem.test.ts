import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";
import { createSeedState } from "../lib/seed";
import { deterministicHash } from "../lib/rule-kernel";
import type { ConfigurationSnapshot } from "../lib/types";
import type { ConfigExportMapping } from "../lib/config-export-mapping";
import {
  commitFilesystemExport,
  previewFilesystemExport,
} from "../lib/config-export-filesystem";
import type { ExportTargetProfile } from "../lib/interaction-contracts";
import type {
  FormalConfigExportAuthorization,
  FormalConfigExportEvidenceVerifier,
} from "../lib/config-export-stage";
import {
  ConfigExportStageError,
  formalConfigExportContextHash,
} from "../lib/config-export-stage";
import { ConfigPreviewSnapshotError } from "../lib/config-preview-package";

process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE = "PHASE_ONE_POINT_FIVE";
process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED = "true";

const FORMAL_AUTHORIZATION: FormalConfigExportAuthorization = {
  packageKind: "EXPORT_PACKAGE",
  publicationState: "FORMAL",
  formal: true,
  configIdBundleId: "bundle:test",
  configIdPolicyVersionId: "config-id:test",
  configTargetCatalogVersionId: "catalog:test",
  approvedFreshManifestId: "manifest:test",
  governanceLeaseId: "lease:test",
  fencingToken: "1",
  expectedOldOid: "a".repeat(40),
  protectedRefCasAvailable: true,
};
const FORMAL_VERIFIER: FormalConfigExportEvidenceVerifier = {
  async verify(_authorization, context) {
    return {
      verified: true,
      manifestSetHash: "manifest-set:test",
      verifiedAt: "2026-07-23T00:00:00.000Z",
      contextHash: formalConfigExportContextHash(context),
    };
  },
};

function replayableSnapshot(): ConfigurationSnapshot {
  const snapshot = structuredClone(createSeedState().configurationSnapshots[0]!);
  snapshot.qualityValueAssessment = {
    formal: true,
  } as NonNullable<ConfigurationSnapshot["qualityValueAssessment"]>;
  snapshot.pricingPolicyVersion = "pricing-policy:test";
  snapshot.automaticPricing = {
    formal: true,
    pricingPolicyRef: snapshot.pricingPolicyVersion,
  } as NonNullable<ConfigurationSnapshot["automaticPricing"]>;
  const content = structuredClone(snapshot);
  Reflect.deleteProperty(content, "contentHash");
  snapshot.contentHash = deterministicHash(content);
  return snapshot;
}

function withoutReplayPolicy(snapshot: ConfigurationSnapshot): ConfigurationSnapshot {
  const blocked = structuredClone(snapshot);
  Reflect.deleteProperty(blocked, "pricingPolicyVersion");
  Reflect.deleteProperty(blocked, "automaticPricing");
  const content = structuredClone(blocked);
  Reflect.deleteProperty(content, "contentHash");
  blocked.contentHash = deterministicHash(content);
  return blocked;
}

function mapping(): ConfigExportMapping {
  return {
    mappingId: "mapping:filesystem-test",
    version: "1",
    enumReferenceField: "name",
    logicalTables: {
      rods: {
        workbook: "tackle.xlsx",
        sheet: "Rods",
        required: true,
        stableBusinessKey: "id",
        dataStartRow: 5,
      },
    },
    rows: [
      {
        rowMappingId: "rod",
        logicalTable: "rods",
        businessKeyField: "id",
        configNameKeyField: "name",
        columns: {
          id: { kind: "constant", value: 301499001 },
          name: { kind: "constant", value: "rod_qinglu_15_fast" },
          drag: { kind: "snapshot_value", key: "杆最大拉力kgf", scale: 1000, precision: 0 },
        },
      },
    ],
  };
}

function workbookBytes() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["INT64", "STRING", "INT32"],
    ["id", "name", "drag"],
    ["ID", "名称", "拉力"],
    [null, null, null],
    [301499001, "rod_qinglu_15_fast", 1000],
  ]), "Rods");
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-export-"));
  const workbookRoot = path.join(root, "xlsx");
  await mkdir(workbookRoot, { recursive: true });
  await writeFile(path.join(root, "config.toml"), `
[tables.rods]
sheet = ["Rods"]
workbook = "tackle.xlsx"
enums = []
`);
  await writeFile(path.join(workbookRoot, "tackle.xlsx"), workbookBytes());
  const profile: ExportTargetProfile = {
    profileId: "profile:test",
    label: "测试",
    executorKind: "server_mounted_workspace",
    projectRoot: root,
    relativeWorkbookRoot: "xlsx",
    configTomlPath: "config.toml",
    enabled: true,
    environmentId: "test",
    channelKey: "1001",
    mappingId: "mapping:filesystem-test",
    mappingVersion: "1",
  };
  return { root, workbookRoot, profile };
}

test("生产形态文件系统预览在本地读取前要求完整治理证据和提交能力", async () => {
  const profile: ExportTargetProfile = {
    profileId: "profile:unavailable",
    label: "不可用",
    executorKind: "server_mounted_workspace",
    projectRoot: path.join(os.tmpdir(), "tackle-forger-must-not-read"),
    relativeWorkbookRoot: "xlsx",
    configTomlPath: "config.toml",
    enabled: true,
    environmentId: "test",
    channelKey: "1001",
    mappingId: "mapping:filesystem-test",
    mappingVersion: "1",
  };
  for (const access of [
    {
      canCommit: false,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    },
    {
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: undefined,
    },
    {
      canCommit: true,
      formalAuthorization: undefined,
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    },
  ]) {
    await assert.rejects(
      () => previewFilesystemExport({
        packageId: "package-unavailable",
        profile,
        mapping: mapping(),
        snapshot: replayableSnapshot(),
        ...access,
      }),
      (error) => error instanceof ConfigExportStageError
        && error.code === "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
    );
  }
});

test("文件系统执行器预览不改正式文件，确认后备份并提交，重试幂等", async () => {
  const current = await fixture();
  try {
    const snapshot = replayableSnapshot();
    const target = path.join(current.workbookRoot, "tackle.xlsx");
    const before = await readFile(target);
    const verifiedTargetRefs: string[] = [];
    const verifier: FormalConfigExportEvidenceVerifier = {
      async verify(_authorization, context) {
        verifiedTargetRefs.push(
          ...context.operations.map((operation) => operation.targetRef),
        );
        return {
          verified: true,
          manifestSetHash: "manifest-set:test",
          verifiedAt: "2026-07-23T00:00:00.000Z",
          contextHash: formalConfigExportContextHash(context),
        };
      },
    };
    const preview = await previewFilesystemExport({
      packageId: "package-1",
      profile: current.profile,
      mapping: mapping(),
      snapshot,
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: verifier,
      createdAt: "2026-07-21T00:00:00.000Z",
    });
    assert.equal(preview.status, "ready");
    assert.deepEqual(await readFile(target), before);
    assert.equal(preview.operations.length, 1);
    assert.equal(preview.operations[0]?.targetRef, "tackle.xlsx");

    const committed = await commitFilesystemExport({
      preview,
      snapshot,
      profile: current.profile,
      confirmationProfileId: current.profile.profileId,
      idempotencyKey: "commit-1",
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: verifier,
    });
    assert.equal(committed.status, "committed");
    assert.deepEqual(verifiedTargetRefs, [
      "tackle.xlsx",
      "tackle.xlsx",
      "tackle.xlsx",
      "tackle.xlsx",
    ]);
    const workbook = XLSX.read(await readFile(target), { type: "buffer" });
    assert.equal(workbook.Sheets.Rods.B5.v, "rod_qinglu_15_fast");

    const retried = await commitFilesystemExport({
      preview,
      snapshot,
      profile: current.profile,
      confirmationProfileId: current.profile.profileId,
      idempotencyKey: "commit-1",
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: undefined,
    });
    assert.deepEqual(retried, committed);
  } finally {
    assert.ok(current.root.startsWith(os.tmpdir()));
    await rm(current.root, { recursive: true, force: true });
  }
});

test("文件系统提交在幂等读取、治理验证和控制目录 I/O 前拒绝不可重放 Snapshot", async () => {
  const current = await fixture();
  try {
    const snapshot = replayableSnapshot();
    const preview = await previewFilesystemExport({
      packageId: "package-non-replayable",
      profile: current.profile,
      mapping: mapping(),
      snapshot,
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    const blockedSnapshot = withoutReplayPolicy(snapshot);
    const blockedContext = {
      packageId: preview.packageId,
      profileId: preview.profileId,
      environmentId: current.profile.environmentId ?? "",
      channelKey: current.profile.channelKey ?? "",
      mappingId: preview.mappingId,
      mappingVersion: preview.mappingVersion,
      snapshots: [{
        snapshotId: blockedSnapshot.id,
        snapshotHash: blockedSnapshot.contentHash,
      }],
      operations: preview.operations.map((operation) => ({
        workbook: operation.workbook,
        targetRef: operation.targetRef,
        expectedOriginalHash: operation.expectedOriginalHash,
        stagedHash: operation.stagedHash,
      })),
    };
    const blockedPreview = {
      ...preview,
      snapshotHash: blockedSnapshot.contentHash,
      formalEvidence: {
        ...preview.formalEvidence!,
        contextHash: formalConfigExportContextHash(blockedContext),
      },
    };
    let verifierCalls = 0;
    const verifier: FormalConfigExportEvidenceVerifier = {
      async verify(_authorization, context) {
        verifierCalls += 1;
        return {
          verified: true,
          manifestSetHash: "manifest-set:test",
          verifiedAt: "2026-07-23T00:00:00.000Z",
          contextHash: formalConfigExportContextHash(context),
        };
      },
    };

    await assert.rejects(
      () => commitFilesystemExport({
        preview: blockedPreview,
        snapshot: blockedSnapshot,
        profile: current.profile,
        confirmationProfileId: current.profile.profileId,
        idempotencyKey: "commit-non-replayable",
        canCommit: true,
        formalAuthorization: FORMAL_AUTHORIZATION,
        formalAuthorizationVerifier: verifier,
      }),
      (error) => error instanceof ConfigPreviewSnapshotError
        && error.code === "SNAPSHOT_REPLAY_POLICY_MISSING",
    );

    assert.equal(verifierCalls, 0);
    for (const directory of ["commits", "locks", "backups"]) {
      await assert.rejects(
        () => stat(path.join(current.root, ".tackle-forger", directory)),
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
      );
    }
  } finally {
    assert.ok(current.root.startsWith(os.tmpdir()));
    await rm(current.root, { recursive: true, force: true });
  }
});

test("预览后正式文件变化触发 hash 冲突且不覆盖外部内容", async () => {
  const current = await fixture();
  try {
    const snapshot = replayableSnapshot();
    const target = path.join(current.workbookRoot, "tackle.xlsx");
    const preview = await previewFilesystemExport({
      packageId: "package-2",
      profile: current.profile,
      mapping: mapping(),
      snapshot,
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    assert.equal(preview.status, "ready");
    const externallyChanged = new Uint8Array([...(await readFile(target)), 0]);
    await writeFile(target, externallyChanged);
    const result = await commitFilesystemExport({
      preview,
      snapshot,
      profile: current.profile,
      confirmationProfileId: current.profile.profileId,
      idempotencyKey: "commit-2",
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    assert.equal(result.status, "conflict");
    assert.deepEqual(new Uint8Array(await readFile(target)), externallyChanged);
  } finally {
    assert.ok(current.root.startsWith(os.tmpdir()));
    await rm(current.root, { recursive: true, force: true });
  }
});

test("预览后暂存文件变化在替换前阻断且不覆盖正式文件", async () => {
  const current = await fixture();
  try {
    const snapshot = replayableSnapshot();
    const target = path.join(current.workbookRoot, "tackle.xlsx");
    const before = await readFile(target);
    const preview = await previewFilesystemExport({
      packageId: "package-staged-tampered",
      profile: current.profile,
      mapping: mapping(),
      snapshot,
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    assert.equal(preview.status, "ready");
    const operation = preview.operations[0]!;
    await writeFile(
      operation.stagedPath,
      new Uint8Array([...(await readFile(operation.stagedPath)), 0]),
    );

    const result = await commitFilesystemExport({
      preview,
      snapshot,
      profile: current.profile,
      confirmationProfileId: current.profile.profileId,
      idempotencyKey: "commit-staged-tampered",
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    });

    assert.equal(result.status, "failed");
    assert.match(result.issues[0]?.message ?? "", /stagedHash 不一致/);
    assert.deepEqual(await readFile(target), before);
  } finally {
    assert.ok(current.root.startsWith(os.tmpdir()));
    await rm(current.root, { recursive: true, force: true });
  }
});

test("Profile 相对路径越过允许根目录时在读取前阻止", async () => {
  const current = await fixture();
  try {
    const snapshot = replayableSnapshot();
    const preview = await previewFilesystemExport({
      packageId: "package-escape",
      profile: { ...current.profile, relativeWorkbookRoot: "../outside" },
      mapping: mapping(),
      snapshot,
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    assert.equal(preview.status, "blocked");
    assert.ok(preview.issues.some((entry) => entry.code === "EXPORT_PROFILE_PATH_INVALID"));
  } finally {
    assert.ok(current.root.startsWith(os.tmpdir()));
    await rm(current.root, { recursive: true, force: true });
  }
});

test("提交时拒绝被篡改到允许目录之外的 Manifest 路径", async () => {
  const current = await fixture();
  try {
    const snapshot = replayableSnapshot();
    const preview = await previewFilesystemExport({
      packageId: "package-tampered",
      profile: current.profile,
      mapping: mapping(),
      snapshot,
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    assert.equal(preview.status, "ready");
    const tampered = {
      ...preview,
      operations: preview.operations.map((operation) => ({
        ...operation,
        targetPath: path.join(current.root, "outside.xlsx"),
      })),
    };
    await assert.rejects(
      () => commitFilesystemExport({
        preview: tampered,
        snapshot,
        profile: current.profile,
        confirmationProfileId: current.profile.profileId,
        idempotencyKey: "commit-tampered",
        canCommit: true,
        formalAuthorization: FORMAL_AUTHORIZATION,
        formalAuthorizationVerifier: FORMAL_VERIFIER,
      }),
      /越过允许目录/,
    );
  } finally {
    assert.ok(current.root.startsWith(os.tmpdir()));
    await rm(current.root, { recursive: true, force: true });
  }
});
