import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  ConfigExportCompanionController,
  validateCompanionRegistry,
  type ConfigExportCompanionRegistry,
} from "../lib/config-export-companion";
import type { FilesystemExportPreview } from "../lib/config-export-filesystem";
import { startConfigExportCompanion } from "../scripts/config-export-companion";
import type {
  FormalConfigExportAuthorization,
  FormalConfigExportEvidenceVerifier,
} from "../lib/config-export-stage";
import { formalConfigExportContextHash } from "../lib/config-export-stage";
import { deterministicHash } from "../lib/rule-kernel";
import type { ConfigurationSnapshot } from "../lib/types";

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
import { createSeedState } from "../lib/seed";

const identity = {
  workspaceId: "tenant:test",
  userId: "open:test",
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
  const root = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-companion-"));
  const workbookRoot = path.join(root, "xlsx");
  await mkdir(workbookRoot, { recursive: true });
  await writeFile(path.join(root, "config.toml"), `
[tables.rods]
sheet = ["Rods"]
workbook = "tackle.xlsx"
enums = []
`);
  await writeFile(path.join(workbookRoot, "tackle.xlsx"), workbookBytes());
  const registry: ConfigExportCompanionRegistry = {
    version: 1,
    capabilities: ["config.export.preview", "config.export.commit"],
    pairing: {
      workspaceId: identity.workspaceId,
      allowedOpenIds: [identity.userId],
    },
    profiles: [{
      profileId: "profile:test",
      label: "测试",
      executorKind: "local_companion",
      projectRoot: root,
      relativeWorkbookRoot: "xlsx",
      configTomlPath: "config.toml",
      enabled: true,
      environmentId: "test",
      channelKey: "1001",
      mappingId: "mapping:test",
      mappingVersion: "1",
    }],
    mappings: [{
      mappingId: "mapping:test",
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
      rows: [{
        rowMappingId: "rod",
        logicalTable: "rods",
        businessKeyField: "id",
        configNameKeyField: "name",
        columns: {
          id: { kind: "constant", value: 301499001 },
          name: { kind: "constant", value: "rod_qinglu_15_fast" },
          drag: { kind: "snapshot_value", key: "杆最大拉力kgf", scale: 1000, precision: 0 },
        },
      }],
    }],
  };
  return { root, workbookRoot, registry };
}

test("本地助手要求配对令牌，并以执行端登记 Profile 完成预览和精确确认提交", async () => {
  const current = await fixture();
  try {
    const controller = new ConfigExportCompanionController({
      registry: current.registry,
      token: "0123456789abcdef",
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    assert.throws(() => controller.health("wrong-token-value", identity), /配对令牌无效/);
    assert.equal(controller.health("0123456789abcdef", identity).status, "ready");

    const preview = await controller.preview("0123456789abcdef", identity, {
      packageId: "package-companion",
      profileIds: ["profile:test"],
      snapshot: replayableSnapshot(),
      formalAuthorization: FORMAL_AUTHORIZATION,
    });
    assert.equal(preview.results[0].status, "ready");
    assert.ok(preview.results[0].backupRoot?.includes("backups"));
    assert.match(preview.results[0].files[0].sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(preview.results[0].files[0].changes[0].excelRow, 5);
    await assert.rejects(
      () => controller.commit("0123456789abcdef", identity, {
        previewToken: preview.previewToken,
        confirmations: { "profile:test": "wrong" },
      }),
      /必须完整输入 profile:test/,
    );

    const committed = await controller.commit("0123456789abcdef", identity, {
      previewToken: preview.previewToken,
      confirmations: { "profile:test": "profile:test" },
      formalAuthorization: FORMAL_AUTHORIZATION,
    });
    assert.equal(committed.results[0].status, "committed");
    const restored = await controller.status("0123456789abcdef", identity, {
      packageId: preview.packageId,
      profileIds: ["profile:test"],
    });
    assert.equal(restored.results[0].status, "committed");
    assert.equal(restored.results[0].audit?.workspaceId, identity.workspaceId);
    assert.equal(restored.results[0].audit?.userId, identity.userId);
    const workbook = XLSX.read(
      await readFile(path.join(current.workbookRoot, "tackle.xlsx")),
      { type: "buffer" },
    );
    assert.equal(workbook.Sheets.Rods.B5.v, "rod_qinglu_15_fast");
  } finally {
    assert.ok(current.root.startsWith(os.tmpdir()));
    await rm(current.root, { recursive: true, force: true });
  }
});

test("本地助手提交在治理 verifier 和文件系统副作用前拒绝不可重放 Snapshot", async () => {
  const current = await fixture();
  try {
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
    const controller = new ConfigExportCompanionController({
      registry: current.registry,
      token: "0123456789abcdef",
      formalAuthorizationVerifier: verifier,
    });
    const previewResponse = await controller.preview("0123456789abcdef", identity, {
      packageId: "package-companion-non-replayable",
      profileIds: ["profile:test"],
      snapshot: replayableSnapshot(),
      formalAuthorization: FORMAL_AUTHORIZATION,
    });
    const storedPreviews = (controller as unknown as {
      previews: Map<string, {
        snapshot: ConfigurationSnapshot;
        previews: Map<string, FilesystemExportPreview>;
      }>;
    }).previews;
    const stored = storedPreviews.get(previewResponse.previewToken)!;
    stored.snapshot = withoutReplayPolicy(stored.snapshot);
    const filesystemPreview = stored.previews.get("profile:test")!;
    filesystemPreview.snapshotHash = stored.snapshot.contentHash;
    filesystemPreview.formalEvidence = {
      ...filesystemPreview.formalEvidence!,
      contextHash: formalConfigExportContextHash({
        packageId: filesystemPreview.packageId,
        profileId: filesystemPreview.profileId,
        environmentId: current.registry.profiles[0]!.environmentId ?? "",
        channelKey: current.registry.profiles[0]!.channelKey ?? "",
        mappingId: filesystemPreview.mappingId,
        mappingVersion: filesystemPreview.mappingVersion,
        snapshots: [{
          snapshotId: stored.snapshot.id,
          snapshotHash: stored.snapshot.contentHash,
        }],
        operations: filesystemPreview.operations.map((operation) => ({
          workbook: operation.workbook,
          targetRef: operation.targetRef,
          expectedOriginalHash: operation.expectedOriginalHash,
          stagedHash: operation.stagedHash,
        })),
      }),
    };
    verifierCalls = 0;

    await assert.rejects(
      () => controller.commit("0123456789abcdef", identity, {
        previewToken: previewResponse.previewToken,
        confirmations: { "profile:test": "profile:test" },
        formalAuthorization: FORMAL_AUTHORIZATION,
      }),
      (error) => error instanceof Error
        && "code" in error
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

test("仅有预览 Capability 的本地助手不能生成可人工搬运的正式暂存包", async () => {
  const current = await fixture();
  try {
    const controller = new ConfigExportCompanionController({
      registry: {
        ...current.registry,
        capabilities: ["config.export.preview"],
      },
      token: "0123456789abcdef",
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    await assert.rejects(
      () => controller.preview("0123456789abcdef", identity, {
        packageId: "package-preview-only",
        profileIds: ["profile:test"],
        snapshot: replayableSnapshot(),
        formalAuthorization: FORMAL_AUTHORIZATION,
      }),
      (error) => error instanceof Error
        && "code" in error
        && error.code === "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
    );
    await assert.rejects(
      () => readFile(path.join(current.root, ".tackle-forger", "staging")),
      (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  } finally {
    assert.ok(current.root.startsWith(os.tmpdir()));
    await rm(current.root, { recursive: true, force: true });
  }
});

test("已启用 Profile 缺少已登记映射时拒绝启动", () => {
  const registry: ConfigExportCompanionRegistry = {
    version: 1,
    capabilities: ["config.export.preview"],
    pairing: {
      workspaceId: identity.workspaceId,
      allowedOpenIds: [identity.userId],
    },
    profiles: [{
      profileId: "profile:missing",
      label: "缺少映射",
      executorKind: "local_companion",
      projectRoot: "D:\\workOnSsd\\configsDesign",
      relativeWorkbookRoot: "xlsx",
      configTomlPath: "config.toml",
      enabled: true,
      mappingId: "mapping:missing",
      mappingVersion: "1",
    }],
    mappings: [],
  };
  assert.throws(() => validateCompanionRegistry(registry), /映射未登记/);
});

test("HTTP 服务只接受本机来源和有效 Bearer 配对令牌", async () => {
  const current = await fixture();
  const registryPath = path.join(current.root, "registry.json");
  await writeFile(registryPath, JSON.stringify(current.registry));
  const started = await startConfigExportCompanion({
    registryPath,
    port: 0,
    token: "0123456789abcdef",
  });
  try {
    const accepted = await fetch(`${started.url}/health`, {
      headers: {
        authorization: "Bearer 0123456789abcdef",
        origin: "http://localhost:3000",
        "x-tackle-forger-workspace": identity.workspaceId,
        "x-tackle-forger-user": identity.userId,
      },
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json() as { status: string }).status, "ready");

    const wrongIdentity = await fetch(`${started.url}/health`, {
      headers: {
        authorization: "Bearer 0123456789abcdef",
        origin: "http://localhost:3000",
        "x-tackle-forger-workspace": identity.workspaceId,
        "x-tackle-forger-user": "open:other",
      },
    });
    assert.equal(wrongIdentity.status, 401);

    const unavailable = await fetch(`${started.url}/preview`, {
      method: "POST",
      headers: {
        authorization: "Bearer 0123456789abcdef",
        origin: "http://localhost:3000",
        "content-type": "application/json",
        "x-tackle-forger-workspace": identity.workspaceId,
        "x-tackle-forger-user": identity.userId,
      },
      body: JSON.stringify({
        packageId: "package-http-unavailable",
        profileIds: ["profile:test"],
        snapshot: replayableSnapshot(),
        formalAuthorization: FORMAL_AUTHORIZATION,
      }),
    });
    assert.equal(unavailable.status, 400);
    assert.equal(
      (await unavailable.json() as { code?: string }).code,
      "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
    );

    const rejected = await fetch(`${started.url}/health`, {
      headers: {
        authorization: "Bearer 0123456789abcdef",
        origin: "https://example.com",
      },
    });
    assert.equal(rejected.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
    assert.ok(current.root.startsWith(os.tmpdir()));
    await rm(current.root, { recursive: true, force: true });
  }
});
