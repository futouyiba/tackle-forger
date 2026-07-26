/**
 * Companion 逻辑测试——绕过 HTTP，直接调用 Controller。
 * 以 tests/config-export-companion.test.ts 的已验证 fixture 为基础扩展。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  ConfigExportCompanionController,
  validateCompanionRegistry,
  type ConfigExportCompanionRegistry,
} from "../lib/config-export-companion";
import type {
  FormalConfigExportAuthorization,
  FormalConfigExportEvidenceVerifier,
} from "../lib/config-export-stage";
import { formalConfigExportContextHash } from "../lib/config-export-stage";
import { deterministicHash } from "../lib/rule-kernel";
import type { ConfigurationSnapshot } from "../lib/types";
import { testReductionPolicy } from "./helpers/reduction-policy";
import { createSeedState } from "../lib/seed";

const AVAILABLE_REDUCTION_POLICIES = [testReductionPolicy()];

process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE = "PHASE_ONE_POINT_FIVE";
process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED = "true";

const FORMAL_AUTHORIZATION: FormalConfigExportAuthorization = {
  packageKind: "EXPORT_PACKAGE", publicationState: "FORMAL", formal: true,
  configIdBundleId: "bundle:logic", configIdPolicyVersionId: "config-id:logic",
  configTargetCatalogVersionId: "catalog:logic", approvedFreshManifestId: "manifest:logic",
  governanceLeaseId: "lease:logic", fencingToken: "1",
  expectedOldOid: "a".repeat(40), protectedRefCasAvailable: true,
};
const FORMAL_VERIFIER: FormalConfigExportEvidenceVerifier = {
  async verify(_a, ctx) {
    return { verified: true, manifestSetHash: "ms:logic",
      verifiedAt: new Date().toISOString(), contextHash: formalConfigExportContextHash(ctx) };
  },
};

const identity = { workspaceId: "tenant:logic", userId: "open:logic" };
const TOKEN = "0123456789abcdef";

// ── 复用已验证的 snapshot 构造 ──
function replayableSnapshot(): ConfigurationSnapshot {
  const snapshot = structuredClone(createSeedState().configurationSnapshots[0]!);
  snapshot.reductionStackingPolicyVersion = AVAILABLE_REDUCTION_POLICIES[0].version;
  snapshot.qualityValueAssessment = { formal: true } as NonNullable<ConfigurationSnapshot["qualityValueAssessment"]>;
  snapshot.pricingPolicyVersion = "pricing-policy:logic";
  snapshot.automaticPricing = { formal: true, pricingPolicyRef: snapshot.pricingPolicyVersion } as NonNullable<ConfigurationSnapshot["automaticPricing"]>;
  const content = structuredClone(snapshot);
  Reflect.deleteProperty(content, "contentHash");
  snapshot.contentHash = deterministicHash(content);
  return snapshot;
}

function workbookBytes() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["INT64", "STRING", "INT32"], ["id", "name", "drag"], ["ID", "名称", "拉力"],
    [null, null, null], [301499001, "rod_qinglu_15_fast", 1000],
  ]), "Rods");
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-companion-logic-"));
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
    version: 1, capabilities: ["config.export.preview", "config.export.commit"],
    pairing: { workspaceId: identity.workspaceId, allowedOpenIds: [identity.userId] },
    reductionStackingPolicyVersions: AVAILABLE_REDUCTION_POLICIES,
    profiles: [{
      profileId: "profile:logic",
      label: "逻辑测试", executorKind: "local_companion",
      projectRoot: root, relativeWorkbookRoot: "xlsx", configTomlPath: "config.toml",
      enabled: true, environmentId: "test", channelKey: "1001",
      mappingId: "mapping:logic", mappingVersion: "1",
    }],
    mappings: [{
      mappingId: "mapping:logic", version: "1", enumReferenceField: "name",
      logicalTables: {
        rods: { workbook: "tackle.xlsx", sheet: "Rods", required: true, stableBusinessKey: "id", dataStartRow: 5 },
      },
      rows: [{
        rowMappingId: "rod", logicalTable: "rods", businessKeyField: "id", configNameKeyField: "name",
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

// ═══ 正常路径 ═══

test("预览 + 提交 + 验证 xlsx 被修改", async () => {
  const current = await fixture();
  try {
    const controller = new ConfigExportCompanionController({
      registry: current.registry, token: TOKEN, formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    const preview = await controller.preview(TOKEN, identity, {
      packageId: "pkg-normal",
      profileIds: ["profile:logic"],
      snapshot: replayableSnapshot(),
      formalAuthorization: FORMAL_AUTHORIZATION,
    });
    assert.equal(preview.results[0].status, "ready");
    assert.match(preview.results[0].files[0].sourceHash, /^[a-f0-9]{64}$/);
    assert.match(preview.results[0].files[0].stagedHash, /^[a-f0-9]{64}$/);

    const committed = await controller.commit(TOKEN, identity, {
      previewToken: preview.previewToken,
      confirmations: { "profile:logic": "profile:logic" },
      formalAuthorization: FORMAL_AUTHORIZATION,
    });
    assert.equal(committed.results[0].status, "committed");
    // 验证 xlsx 被写入
    const written = XLSX.read(await readFile(path.join(current.workbookRoot, "tackle.xlsx")), { type: "buffer" });
    assert.equal(written.Sheets.Rods.A5?.v, 301499001);
    assert.equal(written.Sheets.Rods.B5?.v, "rod_qinglu_15_fast");
  } finally { await rm(current.root, { recursive: true, force: true }); }
});

test("Status 查询返回 committed", async () => {
  const current = await fixture();
  try {
    const controller = new ConfigExportCompanionController({
      registry: current.registry, token: TOKEN, formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    const preview = await controller.preview(TOKEN, identity, {
      packageId: "pkg-status",
      profileIds: ["profile:logic"],
      snapshot: replayableSnapshot(),
      formalAuthorization: FORMAL_AUTHORIZATION,
    });
    await controller.commit(TOKEN, identity, {
      previewToken: preview.previewToken,
      confirmations: { "profile:logic": "profile:logic" },
      formalAuthorization: FORMAL_AUTHORIZATION,
    });
    const s = await controller.status(TOKEN, identity, {
      packageId: preview.packageId, profileIds: ["profile:logic"],
    });
    assert.equal(s.results[0].status, "committed");
  } finally { await rm(current.root, { recursive: true, force: true }); }
});

// ═══ 错误路径 ═══

test("错误令牌拒绝", () => {
  const controller = new ConfigExportCompanionController({
    registry: {
      version: 1, capabilities: ["config.export.preview"],
      pairing: { workspaceId: "w", allowedOpenIds: ["u"] },
      reductionStackingPolicyVersions: [], profiles: [], mappings: [],
    }, token: TOKEN,
  });
  assert.throws(() => controller.health("wrong", identity), /配对令牌无效/);
});

test("确认 ID 不匹配拒绝提交", async () => {
  const current = await fixture();
  try {
    const controller = new ConfigExportCompanionController({
      registry: current.registry, token: TOKEN, formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    const preview = await controller.preview(TOKEN, identity, {
      packageId: "pkg-confirm-wrong",
      profileIds: ["profile:logic"],
      snapshot: replayableSnapshot(),
      formalAuthorization: FORMAL_AUTHORIZATION,
    });
    await assert.rejects(
      () => controller.commit(TOKEN, identity, {
        previewToken: preview.previewToken,
        confirmations: { "profile:logic": "wrong" },
      }),
      /必须完整输入 profile:logic/,
    );
  } finally { await rm(current.root, { recursive: true, force: true }); }
});

test("禁用 Profile 预览被拒绝", async () => {
  const current = await fixture();
  try {
    current.registry.profiles[0].enabled = false;
    const controller = new ConfigExportCompanionController({ registry: current.registry, token: TOKEN });
    await assert.rejects(
      () => controller.preview(TOKEN, identity, {
        packageId: "pkg-disabled", profileIds: ["profile:logic"], snapshot: replayableSnapshot(),
      }),
      /已停用/,
    );
  } finally { await rm(current.root, { recursive: true, force: true }); }
});

test("缺少 commit capability 时 preview 被拒绝", async () => {
  const current = await fixture();
  try {
    current.registry.capabilities = ["config.export.preview"];
    const controller = new ConfigExportCompanionController({ registry: current.registry, token: TOKEN });
    await assert.rejects(
      () => controller.preview(TOKEN, identity, {
        packageId: "pkg-nocommit", profileIds: ["profile:logic"], snapshot: replayableSnapshot(),
      }),
      /缺少 config.export.commit/,
    );
  } finally { await rm(current.root, { recursive: true, force: true }); }
});

test("Status 查询未知包返回 unknown", async () => {
  const current = await fixture();
  try {
    const controller = new ConfigExportCompanionController({ registry: current.registry, token: TOKEN });
    const s = await controller.status(TOKEN, identity, {
      packageId: "nonexistent", profileIds: ["profile:logic"],
    });
    assert.equal(s.results[0].status, "unknown");
  } finally { await rm(current.root, { recursive: true, force: true }); }
});

test("registry 重复 profileId 校验拒绝", () => {
  assert.throws(() => validateCompanionRegistry({
    version: 1, capabilities: ["config.export.preview"],
    pairing: { workspaceId: "w", allowedOpenIds: ["u"] },
    reductionStackingPolicyVersions: [], mappings: [],
    profiles: [
      { profileId: "dup", label: "A", executorKind: "local_companion", projectRoot: "/a", relativeWorkbookRoot: "xlsx", configTomlPath: "c.toml", enabled: false },
      { profileId: "dup", label: "B", executorKind: "local_companion", projectRoot: "/b", relativeWorkbookRoot: "xlsx", configTomlPath: "c.toml", enabled: false },
    ],
  }), /重复/);
});
