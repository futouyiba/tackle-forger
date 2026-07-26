/**
 * 浏览器 XLSX 导出生成器测试
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  BROWSER_COMPILER_TABLES,
  BROWSER_EXPORT_MAPPING,
  BROWSER_FIELD_LABELS,
  filterMappingForPart,
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
  return formalExportSnapshot(
    createSeedState().configurationSnapshots[0]!,
  );
}

test("BROWSER_EXPORT_MAPPING 与 compilerTables 自洽，校验零问题", () => {
  const issues = validateConfigExportMapping({
    mapping: BROWSER_EXPORT_MAPPING,
    compilerTables: BROWSER_COMPILER_TABLES,
  });
  assert.deepEqual(issues, []);
});

test("按部位筛选映射后物化产出有效行", () => {
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
  assert.ok(result.rows.length > 0, "至少应有 4 行（rod+item+goods+store）");
  for (const row of result.rows) {
    assert.ok(row.values.id, `每行必须有 id: ${row.rowMappingId}`);
  }
  // rod 行应包含真实字段值
  const rodRow = result.rows.find((r) => r.rowMappingId === "rod");
  assert.ok(rodRow, "应有 rod 行");
  assert.ok(typeof rodRow.values.drag === "number");
  assert.ok(typeof rodRow.values.weight === "number");
  assert.ok(typeof rodRow.values.length === "number");
});

test("generatePreviewXlsx 生成可被 SheetJS 回读的有效 XLSX（含 NON_FORMAL sheet）", () => {
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
  const bytes = generatePreviewXlsx({
    rows: materialized.rows,
    mapping: partMapping,
    labels: BROWSER_FIELD_LABELS,
  });
  assert.ok(bytes.length > 0);
  const workbook = XLSX.read(bytes, { type: "array" });
  // NON_FORMAL + 4 个数据 sheet (Rods + Item + GoodsBasic + StoreBuy)
  assert.ok(workbook.SheetNames.includes("NON_FORMAL"), "应有 NON_FORMAL 声明 sheet");
  assert.ok(workbook.SheetNames.includes("Rods"));
  const rods = workbook.Sheets.Rods;
  // Row 1 = 类型行（STRING 或 INT32 等）
  assert.ok(rods.A1?.v);
  // Row 2 = 字段名（id）
  assert.equal(rods.A2?.v, "id");
  // Row 3 = 中文标签
  assert.equal(rods.A3?.v, "ID");
  // Row 5 = 首行数据（modelId）
  assert.ok(rods.A5?.v);
  // drag 应在 COL C (index 2) — 检查类型行
  assert.equal(rods.C1?.v, "FLOAT", "drag 应为 FLOAT 类型");
  assert.equal(rods.C2?.v, "drag");
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

test("filterMappingForPart 为竿只保留 rod+通用行，不包含 reel/line", () => {
  const rodMapping = filterMappingForPart(BROWSER_EXPORT_MAPPING, "part:rod");
  const ids = rodMapping.rows.map((r) => r.rowMappingId).sort();
  assert.deepEqual(ids, ["goods", "item", "rod", "store"]);
});

test("filterMappingForPart 为轮只保留 reel+通用行", () => {
  const reelMapping = filterMappingForPart(BROWSER_EXPORT_MAPPING, "part:reel");
  const ids = reelMapping.rows.map((r) => r.rowMappingId).sort();
  assert.deepEqual(ids, ["goods", "item", "reel", "store"]);
});
