/**
 * 端到端导出验证：用 mock Snapshot 跑完整 preview → commit 流程。
 * 不依赖切流、不依赖真实工作簿。
 *
 * 用法：npx tsx tests/manual-e2e-config-export.ts
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import {
  formalConfigExportContextHash,
  type FormalConfigExportAuthorization,
  type FormalConfigExportEvidenceVerifier,
} from "../lib/config-export-stage";
import { testReductionPolicy } from "./helpers/reduction-policy";

// ── 环境开关 ──
process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE = "PHASE_ONE_POINT_FIVE";
process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED = "true";

const POLICIES = [testReductionPolicy()];

// ── Mock 正式授权 + Verifier ──
const AUTHORIZATION: FormalConfigExportAuthorization = {
  packageKind: "EXPORT_PACKAGE", publicationState: "FORMAL", formal: true,
  configIdBundleId: "bundle:e2e", configIdPolicyVersionId: "config-id:e2e",
  configTargetCatalogVersionId: "catalog:e2e", approvedFreshManifestId: "manifest:e2e",
  governanceLeaseId: "lease:e2e", fencingToken: "1",
  expectedOldOid: "a".repeat(40), protectedRefCasAvailable: true,
};

const VERIFIER: FormalConfigExportEvidenceVerifier = {
  async verify(_auth, ctx) {
    return { verified: true, manifestSetHash: "ms:e2e",
      verifiedAt: new Date().toISOString(), contextHash: formalConfigExportContextHash(ctx) };
  },
};

// ── 构造可导出的 Snapshot ──
function fakeSnapshot(): ConfigurationSnapshot {
  const s = structuredClone(createSeedState().configurationSnapshots[0]!);
  s.reductionStackingPolicyVersion = POLICIES[0].version;
  s.qualityValueAssessment = { formal: true } as NonNullable<ConfigurationSnapshot["qualityValueAssessment"]>;
  s.pricingPolicyVersion = "pricing-policy:e2e";
  s.automaticPricing = { formal: true, pricingPolicyRef: s.pricingPolicyVersion } as NonNullable<ConfigurationSnapshot["automaticPricing"]>;
  // 填充一些 finalPanelValues 供 mapping 读取
  s.finalPanelValues = {
    "杆型号": "rod_qinglu_e2e",
    "杆最大拉力kgf": 1.5,
    "杆长度cm": 210,
    "杆自重g": 95,
  };
  const c = structuredClone(s); Reflect.deleteProperty(c, "contentHash");
  s.contentHash = deterministicHash(c);
  return s;
}

// ── Mapping ──
function e2eMapping(): ConfigExportMapping {
  return {
    mappingId: "mapping:e2e", version: "1", enumReferenceField: "name",
    logicalTables: {
      rods: { workbook: "tackle.xlsx", sheet: "Rods", required: true, stableBusinessKey: "id", dataStartRow: 5 },
      item: { workbook: "item.xlsx", sheet: "Item", required: true, stableBusinessKey: "id", dataStartRow: 5 },
      goods_basic: { workbook: "store.xlsx", sheet: "GoodsBasic", required: true, stableBusinessKey: "id", dataStartRow: 5 },
      store_buy: { workbook: "store.xlsx", sheet: "StoreBuy", required: true, stableBusinessKey: "id", dataStartRow: 5 },
    },
    rows: [
      { rowMappingId: "rod", logicalTable: "rods", businessKeyField: "id", configNameKeyField: "name",
        columns: {
          id: { kind: "snapshot_property", property: "id" },
          name: { kind: "snapshot_value", key: "杆型号" },
          drag: { kind: "snapshot_value", key: "杆最大拉力kgf", scale: 1000, precision: 0 },
          length: { kind: "snapshot_value", key: "杆长度cm", precision: 0 },
          weight: { kind: "snapshot_value", key: "杆自重g", precision: 2 },
        } },
      { rowMappingId: "item", logicalTable: "item", businessKeyField: "id", configNameKeyField: "name",
        columns: { id: { kind: "snapshot_property", property: "id" }, name: { kind: "snapshot_value", key: "杆型号" } } },
      { rowMappingId: "goods", logicalTable: "goods_basic", businessKeyField: "id", configNameKeyField: "name",
        columns: { id: { kind: "snapshot_property", property: "id" }, name: { kind: "snapshot_value", key: "杆型号" },
          item_id: { kind: "snapshot_value", key: "杆型号" } } },
      { rowMappingId: "store", logicalTable: "store_buy", businessKeyField: "id", configNameKeyField: "name",
        columns: { id: { kind: "snapshot_property", property: "id" }, name: { kind: "snapshot_value", key: "杆型号" },
          goods_id: { kind: "snapshot_value", key: "杆型号" }, enabled: { kind: "target_existing_or_constant", value: true } } },
    ],
  };
}

function xlsx(sheetName: string, rows: unknown[][]): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

// ── 主流程 ──
async function main() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tf-e2e-export-"));
  console.log(`临时目录: ${tmp}`);

  try {
    // 1. 搭建目录结构
    const xlsxDir = path.join(tmp, "xlsx");
    await mkdir(xlsxDir);

    const configToml = `
[tables.rods]
sheet = ["Rods"]
workbook = "tackle.xlsx"
enums = []
[tables.item]
sheet = ["Item"]
workbook = "item.xlsx"
enums = []
[tables.goods_basic]
sheet = ["GoodsBasic"]
workbook = "store.xlsx"
enums = [{ field = "item_id", table = "item" }]
[tables.store_buy]
sheet = ["StoreBuy"]
workbook = "store.xlsx"
enums = [{ field = "goods_id", table = "goods_basic" }]
`;
    await writeFile(path.join(tmp, "config.toml"), configToml);

    // 已有 xlsx（模拟真实配置表，已有部分数据）
    await writeFile(path.join(xlsxDir, "tackle.xlsx"), xlsx("Rods", [
      ["INT64", "STRING", "FLOAT", "FLOAT", "FLOAT"],  // 第1行
      ["id", "name", "drag", "length", "weight"],       // 第2行
      ["ID", "名称", "拉力", "长度", "重量"],           // 第3行
      [],                                                // 第4行（空）
      [301499001, "rod_old_one", 1500, 210, 95.0],      // 第5行（已存在）
    ]));
    await writeFile(path.join(xlsxDir, "item.xlsx"), xlsx("Item", [
      ["INT64", "STRING"], ["id", "name"], ["ID", "名称"], [],
      [601499001, "rod_old_one"],
    ]));
    const storeWb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(storeWb, XLSX.utils.aoa_to_sheet([
      ["INT64", "STRING", "STRING"], ["id", "name", "item_id"], ["ID", "名称", "物品"], [],
      [801499001, "rod_old_one", "rod_old_one"],
    ]), "GoodsBasic");
    XLSX.utils.book_append_sheet(storeWb, XLSX.utils.aoa_to_sheet([
      ["INT64", "STRING", "STRING", "BOOL"], ["id", "name", "goods_id", "enabled"], ["ID", "名称", "商品", "上架"], [],
      [1001499001, "rod_old_one", "rod_old_one", false],
    ]), "StoreBuy");
    await writeFile(path.join(xlsxDir, "store.xlsx"), new Uint8Array(XLSX.write(storeWb, { type: "buffer", bookType: "xlsx" })));

    console.log("✅ 临时目录已就绪（含 config.toml + 3 张 xlsx）");

    // 2. 准备 Snapshot + Profile + Mapping
    const snapshot = fakeSnapshot();
    const mapping = e2eMapping();
    const profile: ExportTargetProfile = {
      profileId: "profile:e2e", label: "E2E Test", executorKind: "local_companion",
      projectRoot: tmp, relativeWorkbookRoot: "xlsx", configTomlPath: "config.toml",
      enabled: true, mappingId: mapping.mappingId, mappingVersion: mapping.version,
      environmentId: "test", channelKey: "1001",
    };

    // 3. 预览
    console.log("\n--- 预览 ---");
    const preview = await previewFilesystemExport({
      packageId: "e2e-package",
      profile, mapping, snapshot,
      canCommit: true,
      formalAuthorization: AUTHORIZATION,
      formalAuthorizationVerifier: VERIFIER,
      availableReductionPolicies: POLICIES,
    });
    if (preview.status !== "ready") {
      console.error(`Preview blocked: ${JSON.stringify(preview.issues, null, 2)}`);
      process.exit(1);
    }
    console.log(`  操作数: ${preview.operations.length}`);
    assert.ok(preview.operations.length > 0);
    console.log(`  状态: ${preview.status}, issues: ${preview.issues.length}`);
    for (const i of preview.issues) {
      console.log(`    ${i.level} ${i.code}: ${i.message} [${i.workbook ?? ""}]`);
    }
    for (const op of preview.operations) {
      console.log(`  ${op.workbook}: ${op.changes.length} 处变更`);
      for (const ch of op.changes) {
        console.log(`    ${ch.logicalTable}@${ch.excelRow}: ${ch.operation} [${ch.changedFields.join(",")}]`);
      }
    }

    // 4. 提交
    console.log("\n--- 提交 ---");
    const result = await commitFilesystemExport({
      preview, snapshot, profile, mapping,
      confirmationProfileId: profile.profileId,
      idempotencyKey: `e2e-commit:${Date.now()}`,
      canCommit: true,
      formalAuthorization: AUTHORIZATION,
      formalAuthorizationVerifier: VERIFIER,
      availableReductionPolicies: POLICIES,
    });
    assert.equal(result.status, "committed");
    console.log(`  状态: ${result.status}`);
    console.log(`  替换文件: ${result.replacedWorkbooks.join(", ")}`);

    // 5. 验证写入结果
    console.log("\n--- 验证 ---");
    for (const wb of result.replacedWorkbooks) {
      const bytes = await readFile(path.join(xlsxDir, wb));
      const w = XLSX.read(bytes, { type: "buffer" });
      console.log(`  ${wb}: sheets=[${w.SheetNames.join(",")}] size=${bytes.length}`);
    }

    // 6. 验证幂等——相同参数再提交一次
    console.log("\n--- 幂等 ---");
    const result2 = await commitFilesystemExport({
      preview, snapshot, profile, mapping,
      confirmationProfileId: profile.profileId,
      idempotencyKey: `e2e-commit:${Date.now() - 1000}`,  // different key
      canCommit: true,
      formalAuthorization: AUTHORIZATION,
      formalAuthorizationVerifier: VERIFIER,
      availableReductionPolicies: POLICIES,
    });
    console.log(`  第二次提交状态: ${result2.status}`);

    console.log("\n✅ 端到端导出验证全部通过！");
  } finally {
    await rm(tmp, { recursive: true, force: true });
    console.log(`已清理: ${tmp}`);
  }
}

main().catch((err) => { console.error("❌", err); process.exit(1); });
