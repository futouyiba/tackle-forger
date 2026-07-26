/**
 * 浏览器 XLSX 导出生成器测试（NON_FORMAL 预览）
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  BROWSER_COMPILER_TABLES,
  BROWSER_EXPORT_MAPPING,
  BROWSER_FIELD_LABELS,
  filterMappingForPart,
  nonFormalRef,
  OBJECT_KINDS,
} from "../lib/config-export-browser-mapping";
import {
  materializeConfigExport,
  validateConfigExportMapping,
} from "../lib/config-export-mapping";
import { generatePreviewXlsx } from "../lib/config-export-xlsx-generator";
import { formalExportSnapshot } from "./helpers/formal-export-snapshot";
import { testReductionPolicy } from "./helpers/reduction-policy";
import { createSeedState } from "../lib/seed";

const AVAILABLE_REDUCTION_POLICIES = [testReductionPolicy()];

function exportableSnapshot() {
  return formalExportSnapshot(createSeedState().configurationSnapshots[0]!);
}

test("BROWSER_EXPORT_MAPPING 与 compilerTables 自洽，校验零问题", () => {
  const issues = validateConfigExportMapping({
    mapping: BROWSER_EXPORT_MAPPING,
    compilerTables: BROWSER_COMPILER_TABLES,
  });
  assert.deepEqual(issues, []);
});

test("按部位筛选映射后物化产出有效行（NON_FORMAL 身份列）", () => {
  const snapshot = exportableSnapshot();
  const partMapping = filterMappingForPart(
    BROWSER_EXPORT_MAPPING,
    snapshot.projectionMatch!.itemPartId,
  );
  const result = materializeConfigExport({
    snapshot,
    availableReductionPolicies: AVAILABLE_REDUCTION_POLICIES,
    mapping: partMapping,
    compilerTables: BROWSER_COMPILER_TABLES,
  });
  assert.ok(result.rows.length > 0, `至少应有行，issues=${JSON.stringify(result.issues.map(i => i.code))}`);
  for (const row of result.rows) {
    assert.ok(row.values.non_formal_ref, `每行必须有 non_formal_ref: ${row.rowMappingId}`);
  }
  const rodRow = result.rows.find((r) => r.rowMappingId === "rod");
  assert.ok(rodRow, "应有 rod 行");
  assert.ok(typeof rodRow.values.drag === "number");
  assert.ok(typeof rodRow.values.weight === "number");
  assert.ok(typeof rodRow.values.length === "number");
});

test("nonFormalRef 生成正确 NON_FORMAL 引用", () => {
  assert.equal(nonFormalRef("model_1", "rod"), "NON_FORMAL:model_1:tackle");
  assert.equal(nonFormalRef("model_1", "item"), "NON_FORMAL:model_1:item");
  assert.equal(nonFormalRef("model_1", "goods"), "NON_FORMAL:model_1:goods_basic");
  assert.equal(nonFormalRef("model_1", "store"), "NON_FORMAL:model_1:store_buy");
});

test("generatePreviewXlsx 生成 NON_FORMAL XLSX，身份列为符号引用", () => {
  const snapshot = exportableSnapshot();
  const partMapping = filterMappingForPart(
    BROWSER_EXPORT_MAPPING,
    snapshot.projectionMatch!.itemPartId,
  );
  const materialized = materializeConfigExport({
    snapshot,
    availableReductionPolicies: AVAILABLE_REDUCTION_POLICIES,
    mapping: partMapping,
    compilerTables: BROWSER_COMPILER_TABLES,
  });
  // 按字段确定引用目标种类（与 API route 一致）
  const REF_KIND: Record<string, string> = {
    non_formal_ref: "", tackle_ref: "tackle", item_ref: "item", goods_ref: "goods_basic",
  };
  const nonFormalRows = materialized.rows.map((row) => ({
    ...row,
    values: Object.fromEntries(
      Object.entries(row.values).map(([key, value]) => {
        const refKind = REF_KIND[key];
        if (refKind === undefined) return [key, value];
        const kind = refKind || OBJECT_KINDS[row.rowMappingId] || row.rowMappingId;
        return [key, nonFormalRef(String(value), kind)];
      }),
    ),
  }));
  const bytes = generatePreviewXlsx({
    rows: nonFormalRows,
    mapping: partMapping,
    labels: BROWSER_FIELD_LABELS,
  });
  assert.ok(bytes.length > 0);
  const workbook = XLSX.read(bytes, { type: "array" });
  assert.ok(workbook.SheetNames.includes("NON_FORMAL"), "应有 NON_FORMAL 声明 sheet");
  assert.ok(workbook.SheetNames.includes("Rods"));
  const rods = workbook.Sheets.Rods;
  // Row 2 = 字段名 non_formal_ref
  assert.equal(rods.A2?.v, "non_formal_ref");
  // Row 5 = 首行数据应为 NON_FORMAL:xxx:tackle 格式
  const firstRef = String(rods.A5?.v ?? "");
  assert.ok(firstRef.startsWith("NON_FORMAL:"), `身份列应为 NON_FORMAL 引用，实际: ${firstRef}`);
  assert.ok(firstRef.endsWith(":tackle"));
  // 验证关联引用链：Item→Tackle, GoodsBasic→Item, StoreBuy→GoodsBasic
  const itemSheet = workbook.Sheets["item.xlsx>Item"] ?? workbook.Sheets.Item;
  const goodsSheet = workbook.Sheets["store.xlsx>GoodsBasic"] ?? workbook.Sheets.GoodsBasic;
  const storeSheet = workbook.Sheets["store.xlsx>StoreBuy"] ?? workbook.Sheets.StoreBuy;
  assert.ok(itemSheet, "应有 Item sheet");
  assert.ok(goodsSheet, "应有 GoodsBasic sheet");
  assert.ok(storeSheet, "应有 StoreBuy sheet");
  const tackleRef = String(rods.A5?.v ?? "");
  const itemNonFormal = String(itemSheet.A5?.v ?? "");
  const itemTackleRef = String(itemSheet.B5?.v ?? ""); // tackle_ref 在 B 列
  const goodsNonFormal = String(goodsSheet.A5?.v ?? "");
  const goodsItemRef = String(goodsSheet.B5?.v ?? ""); // item_ref 在 B 列
  const storeNonFormal = String(storeSheet.A5?.v ?? "");
  const storeGoodsRef = String(storeSheet.B5?.v ?? ""); // goods_ref 在 B 列
  assert.ok(tackleRef.endsWith(":tackle"));
  assert.ok(itemNonFormal.endsWith(":item"), `Item non_formal_ref: ${itemNonFormal}`);
  assert.ok(itemTackleRef.endsWith(":tackle"), `Item tackle_ref 应指向 tackle，实际: ${itemTackleRef}`);
  assert.ok(goodsNonFormal.endsWith(":goods_basic"), `GoodsBasic non_formal_ref: ${goodsNonFormal}`);
  assert.ok(goodsItemRef.endsWith(":item"), `GoodsBasic item_ref 应指向 item，实际: ${goodsItemRef}`);
  assert.ok(storeNonFormal.endsWith(":store_buy"), `StoreBuy non_formal_ref: ${storeNonFormal}`);
  assert.ok(storeGoodsRef.endsWith(":goods_basic"), `StoreBuy goods_ref 应指向 goods_basic，实际: ${storeGoodsRef}`);
});

test("中文标签映射对已知字段均有值", () => {
  for (const rowMapping of BROWSER_EXPORT_MAPPING.rows) {
    for (const field of Object.keys(rowMapping.columns)) {
      const label = BROWSER_FIELD_LABELS[field];
      assert.ok(
        label && label.trim(),
        `${rowMapping.logicalTable}.${field} 缺少中文标签`,
      );
    }
  }
});

test("filterMappingForPart 为竿只保留 rod+通用行", () => {
  const rodMapping = filterMappingForPart(BROWSER_EXPORT_MAPPING, "part:rod");
  const ids = rodMapping.rows.map((r) => r.rowMappingId).sort();
  assert.deepEqual(ids, ["goods", "item", "rod", "store"]);
});

test("filterMappingForPart 为轮只保留 reel+通用行", () => {
  const reelMapping = filterMappingForPart(BROWSER_EXPORT_MAPPING, "part:reel");
  const ids = reelMapping.rows.map((r) => r.rowMappingId).sort();
  assert.deepEqual(ids, ["goods", "item", "reel", "store"]);
});

test("enabled 默认为 false", () => {
  const storeRow = BROWSER_EXPORT_MAPPING.rows.find((r) => r.rowMappingId === "store")!;
  const enabledCol = storeRow.columns.enabled;
  assert.equal(enabledCol.kind, "target_existing_or_constant");
  assert.equal(enabledCol.value, false);
});
