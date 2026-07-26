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

/** 构造包含映射所需全部字段的正式化快照 */
function exportableSnapshot() {
  const snapshot = formalExportSnapshot(
    createSeedState().configurationSnapshots[0]!,
    (s) => {
      // 补齐映射需要的字段（种子数据使用不同命名）
      s.finalPanelValues["杆型号"] = "rod_qinglu_test";
      s.finalPanelValues["杆长度cm"] = Number(s.finalPanelValues["杆长m"] ?? 2.1) * 100;
    },
  );
  return snapshot;
}

test("BROWSER_EXPORT_MAPPING 与 compilerTables 自洽，校验零问题", () => {
  const issues = validateConfigExportMapping({
    mapping: BROWSER_EXPORT_MAPPING,
    compilerTables: BROWSER_COMPILER_TABLES,
  });
  assert.deepEqual(issues, []);
});

test("对正式化快照物化产出有效行", () => {
  const snapshot = exportableSnapshot();
  const result = materializeConfigExport({
    snapshot,
    availableReductionPolicies: AVAILABLE_REDUCTION_POLICIES,
    mapping: BROWSER_EXPORT_MAPPING,
    compilerTables: BROWSER_COMPILER_TABLES,
  });
  assert.ok(result.rows.length > 0);
  for (const row of result.rows) {
    assert.ok(row.values.id, "每行必须有 id");
    assert.ok(row.values.name, "每行必须有 name");
  }
});

test("generatePreviewXlsx 生成可被 SheetJS 回读的有效 XLSX", () => {
  const snapshot = exportableSnapshot();
  const materialized = materializeConfigExport({
    snapshot,
    availableReductionPolicies: AVAILABLE_REDUCTION_POLICIES,
    mapping: BROWSER_EXPORT_MAPPING,
    compilerTables: BROWSER_COMPILER_TABLES,
  });
  const bytes = generatePreviewXlsx({
    rows: materialized.rows,
    mapping: BROWSER_EXPORT_MAPPING,
    labels: BROWSER_FIELD_LABELS,
  });
  assert.ok(bytes.length > 0);
  const workbook = XLSX.read(bytes, { type: "array" });
  // 4 个有数据的 rowMapping 对应 4-6 张 sheet（可能更少，取决于部位）
  assert.ok(workbook.SheetNames.length >= 4);
  // Rods sheet 必须存在且包含数据
  assert.ok(workbook.SheetNames.includes("Rods"));
  const rods = workbook.Sheets.Rods;
  // Row 1 = 类型行
  assert.ok(rods.A1?.v);
  // Row 2 = 字段名（id）
  assert.equal(rods.A2?.v, "id");
  // Row 3 = 中文标签
  assert.equal(rods.A3?.v, "ID");
  // Row 5 = 首行数据
  assert.ok(rods.A5?.v);
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
