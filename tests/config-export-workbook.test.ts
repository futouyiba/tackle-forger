import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import type { ConfigExportMapping, MaterializedConfigRow } from "../lib/config-export-mapping";
import { extractLogicalTablesFromWorkbook, stageWorkbookRows } from "../lib/config-export-workbook";

function mapping(): ConfigExportMapping {
  return {
    mappingId: "workbook-test",
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
    rows: [],
  };
}

function sourceWorkbook(duplicateKey = false) {
  const workbook = XLSX.utils.book_new();
  const rods = XLSX.utils.aoa_to_sheet([
    ["INT64", "STRING", "INT32", "STRING"],
    ["id", "name", "drag", "unknown_formula"],
    ["ID", "名称", "拉力", "未管理公式"],
    [null, null, null, null],
    [301499001, "old_name", 1000, { f: "1+1" }],
    ...(duplicateKey ? [[301499001, "duplicate", 1000, null]] : []),
  ]);
  rods.A5.s = { fill: { fgColor: { rgb: "FFFF00" } } };
  const untouched = XLSX.utils.aoa_to_sheet([["keep"], [42]]);
  untouched.B2 = { t: "n", f: "A2*2", v: 84 };
  untouched["!ref"] = "A1:B2";
  XLSX.utils.book_append_sheet(workbook, rods, "Rods");
  XLSX.utils.book_append_sheet(workbook, untouched, "Untouched");
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx", cellStyles: true }));
}

function row(values: Record<string, unknown>): MaterializedConfigRow {
  return {
    rowMappingId: "rod",
    logicalTable: "rods",
    workbook: "tackle.xlsx",
    sheet: "Rods",
    businessKeyField: "id",
    configNameKeyField: "name",
    values,
  };
}

test("暂存 upsert 更新已有业务键并保留未知 sheet、列与公式", () => {
  const result = stageWorkbookRows({
    source: sourceWorkbook(),
    workbookName: "tackle.xlsx",
    mapping: mapping(),
    rows: [row({ id: 301499001, name: "old_name", drag: 3760 })],
  });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.preservedSheetNames, ["Rods", "Untouched"]);
  assert.equal(result.issues[0].code, "EXPORT_UNDECLARED_SHEET_PRESERVED");
  assert.equal(result.issues[0].level, "warning");
  assert.equal(result.changes[0].operation, "update");
  const workbook = XLSX.read(result.output, { type: "array", cellFormula: true, cellStyles: true });
  assert.equal(workbook.Sheets.Rods.B5.v, "old_name");
  assert.equal(workbook.Sheets.Rods.C5.v, 3760);
  assert.equal(workbook.Sheets.Rods.D5.f, "1+1");
  assert.equal(workbook.Sheets.Untouched.B2.f, "A2*2");
});

test("暂存 upsert 按显式 dataStartRow 追加新行", () => {
  const result = stageWorkbookRows({
    source: sourceWorkbook(),
    workbookName: "tackle.xlsx",
    mapping: mapping(),
    rows: [row({ id: 301499002, name: "second", drag: 4200 })],
  });
  assert.equal(result.status, "ready");
  assert.equal(result.changes[0].operation, "insert");
  assert.equal(result.changes[0].excelRow, 6);
  const workbook = XLSX.read(result.output, { type: "array" });
  assert.equal(workbook.Sheets.Rods.A6.v, 301499002);
});

test("目标字段缺失时返回原文件且不产生部分变更", () => {
  const source = sourceWorkbook();
  const result = stageWorkbookRows({
    source,
    workbookName: "tackle.xlsx",
    mapping: mapping(),
    rows: [row({ id: 301499001, missing_field: 1 })],
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.output, source);
  assert.deepEqual(result.changes, []);
  assert.ok(result.issues.some((entry) => entry.code === "EXPORT_FIELD_MISSING"));
});

test("目标工作表已有重复业务键时阻止 upsert", () => {
  const result = stageWorkbookRows({
    source: sourceWorkbook(true),
    workbookName: "tackle.xlsx",
    mapping: mapping(),
    rows: [row({ id: 301499001, name: "unsafe" })],
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.issues.some((entry) => entry.code === "EXPORT_EXISTING_IDENTITY_DUPLICATED"));
});
test("暂存工作簿按显式表头和数据起始行提取关系校验数据", () => {
  const extracted = extractLogicalTablesFromWorkbook({
    source: sourceWorkbook(),
    workbookName: "tackle.xlsx",
    mapping: mapping(),
  });
  assert.deepEqual(extracted.issues, []);
  assert.equal(extracted.tables.length, 1);
  assert.equal(extracted.tables[0].rows[0].excelRow, 5);
  assert.equal(extracted.tables[0].rows[0].values.id, 301499001);
});
