import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  BrowserCanonicalWorkbookError,
  inspectBrowserCanonicalWorkbook,
  observeBrowserCanonicalWorkbook,
} from "../lib/browser-canonical-workbook";
import { CANONICAL_FEISHU_SHEET_REGISTRY } from "../lib/feishu-workbook";
import {
  canonicalRuleWorkbookRangeRequests,
  inspectCanonicalRuleWorkbookValues,
  type CanonicalWorkbookRange,
  type CanonicalWorkbookSourceRevision,
} from "../lib/rule-workbook-inspection";

function dimensions(sheetId: string) {
  if (sheetId === "23CsXE") return { rows: 3, columns: 6 };
  if (sheetId === "27hboC") return { rows: 5, columns: 6 };
  if (sheetId === "28fQhg") return { rows: 2, columns: 3 };
  if (sheetId === "19XKzU") return { rows: 2, columns: 19 };
  if (sheetId === "25UnTC") return { rows: 2, columns: 23 };
  return { rows: 2, columns: 30 };
}

function fixtureSheets() {
  return CANONICAL_FEISHU_SHEET_REGISTRY.map((entry) => {
    const { rows, columns } = dimensions(entry.sheetId);
    const values = Array.from({ length: rows }, () => Array.from({ length: columns }, () => null as unknown));
    values[0]![0] = `fixture:${entry.sheetId}`;
    values[rows - 1]![columns - 1] = "";
    if (entry.sheetId === "23CsXE") {
      values[0] = ["机器ID（勿改）", "实体类型", "钓具部位", "词条名称", "缩写", "程序开发"];
      values[1] = ["affix_rod_0001", "RodAffix", "竿", "拉力强化", "拉强", "不需要"];
    }
    if (entry.sheetId === "27hboC") {
      values[0] = ["品质", "代码", "≥最小评分", "<最大评分", "最小价格系数", "最大价格系数"];
      values[1] = ["C/绿", "C", 0, 20, 0.8, 1];
      values[2] = ["B/蓝", "B", 20, 40, 1, 1.2];
      values[3] = ["A/紫", "A", 40, 65, 1.2, 1.5];
      values[4] = ["S/橙", "S", 65, 100, 1.5, 2];
    }
    if (entry.sheetId === "28fQhg") {
      values[0] = ["词条1", "词条2", "组合评分"];
      values[1] = ["affix_rod_0001", "affix_rod_0001", 0];
    }
    return { entry, values };
  });
}

function workbookBytes(sheets = fixtureSheets()) {
  const workbook = XLSX.utils.book_new();
  for (const { entry, values } of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(values), entry.expectedName);
  }
  const output = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return output instanceof ArrayBuffer ? output : new Uint8Array(output).buffer;
}

function rangeValues(values: unknown[][], rangeText: string) {
  const range = XLSX.utils.decode_range(rangeText);
  return Array.from({ length: range.e.r - range.s.r + 1 }, (_, rowOffset) =>
    Array.from({ length: range.e.c - range.s.c + 1 }, (_, columnOffset) => values[range.s.r + rowOffset]?.[range.s.c + columnOffset] ?? null));
}

function physicalRange(sheetId: string, rangeText: string) {
  if (rangeText.startsWith("B1:C") && sheetId !== "19XKzU") return rangeText.replace(/^B1:C/, "A1:B");
  if (sheetId === "23CsXE" && rangeText.startsWith("B2:F")) return rangeText.replace(/^B2:F/, "A1:E");
  return rangeText;
}

function semanticProjection(inspection: Awaited<ReturnType<typeof inspectCanonicalRuleWorkbookValues>>) {
  return {
    identityRows: inspection.identityRows,
    identityReport: inspection.identityReport,
    canonicalRuleDraft: inspection.canonicalRuleDraft,
    weightTemplateDraft: inspection.weightTemplateDraft,
    qualityDraft: inspection.qualityDraft,
    pricingDraft: inspection.pricingDraft,
    seriesDefinitions: inspection.seriesDefinitions,
    seriesParseIssues: inspection.seriesParseIssues,
  };
}

test("浏览器 canonical XLSX adapter 严格映射 registry，并与同一 AOA range 产生相同解析语义", async () => {
  const observedAt = "2026-07-26T00:00:00.000Z";
  const sheets = fixtureSheets();
  const observed = await observeBrowserCanonicalWorkbook({ bytes: workbookBytes(sheets), fileName: "fixture.xlsx", observedAt });
  assert.equal(observed.sourceRevision.sheets.length, CANONICAL_FEISHU_SHEET_REGISTRY.length);
  assert.deepEqual(observed.warnings, []);

  const directRevision: CanonicalWorkbookSourceRevision = structuredClone(observed.sourceRevision);
  const valuesById = new Map(sheets.map(({ entry, values }) => [entry.sheetId, values]));
  const directRanges: CanonicalWorkbookRange[] = canonicalRuleWorkbookRangeRequests(directRevision).map((request) => ({
    sheetId: request.sheetId,
    range: request.range,
    valueRange: {
      revision: directRevision.sourceRevision,
      range: `${request.sheetId}!${request.range}`,
      values: rangeValues(valuesById.get(request.sheetId)!, physicalRange(request.sheetId, request.range)),
    },
  }));
  const fromRanges = await inspectCanonicalRuleWorkbookValues({ observedAt, sourceRevision: directRevision, ranges: directRanges });
  const fromXlsx = await inspectBrowserCanonicalWorkbook({ bytes: workbookBytes(sheets), fileName: "fixture.xlsx", observedAt });
  assert.deepEqual(semanticProjection(fromXlsx.inspection), semanticProjection(fromRanges));
});

test("浏览器 canonical XLSX adapter 的语义 revision 由工作簿内容决定", async () => {
  const bytes = workbookBytes();
  const first = await observeBrowserCanonicalWorkbook({ bytes, fileName: "first.xlsx", observedAt: "2026-07-26T00:00:00.000Z" });
  const second = await observeBrowserCanonicalWorkbook({ bytes, fileName: "renamed.xlsx", observedAt: "2026-07-27T00:00:00.000Z" });
  assert.equal(first.sourceRevision.sourceRevision, second.sourceRevision.sourceRevision);

  const changed = fixtureSheets();
  changed.find(({ entry }) => entry.sheetId === "27hboC")!.values[1]![2] = 1;
  const third = await observeBrowserCanonicalWorkbook({ bytes: workbookBytes(changed), fileName: "changed.xlsx", observedAt: "2026-07-27T00:00:00.000Z" });
  assert.notEqual(first.sourceRevision.sourceRevision, third.sourceRevision.sourceRevision);
});

test("浏览器 canonical XLSX adapter 对缺失、错名和附加表 fail-closed/告警", async () => {
  const missing = fixtureSheets().filter(({ entry }) => entry.sheetId !== "1cAihB");
  await assert.rejects(
    observeBrowserCanonicalWorkbook({ bytes: workbookBytes(missing), fileName: "missing.xlsx", observedAt: "2026-07-26T00:00:00.000Z" }),
    (error: unknown) => error instanceof BrowserCanonicalWorkbookError && error.code === "XLSX_REQUIRED_SHEET_MISSING",
  );

  const typo = fixtureSheets();
  typo.find(({ entry }) => entry.sheetId === "1cAihB")!.entry = { ...typo.find(({ entry }) => entry.sheetId === "1cAihB")!.entry, expectedName: "01.0_重量模板-竿-错名" };
  await assert.rejects(
    observeBrowserCanonicalWorkbook({ bytes: workbookBytes(typo), fileName: "typo.xlsx", observedAt: "2026-07-26T00:00:00.000Z" }),
    (error: unknown) => error instanceof BrowserCanonicalWorkbookError && error.code === "XLSX_REQUIRED_SHEET_MISSING",
  );

  const workbook = XLSX.read(workbookBytes(), { type: "array" });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["额外"]]), "用户附加说明");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const observed = await observeBrowserCanonicalWorkbook({ bytes, fileName: "extra.xlsx", observedAt: "2026-07-26T00:00:00.000Z" });
  assert.deepEqual(observed.warnings.map((warning) => warning.sheetName), ["用户附加说明"]);
});

test("浏览器 canonical XLSX adapter 拒绝超限文件和无效工作簿", async () => {
  await assert.rejects(
    observeBrowserCanonicalWorkbook({ bytes: new ArrayBuffer(20 * 1024 * 1024 + 1), fileName: "large.xlsx", observedAt: "2026-07-26T00:00:00.000Z" }),
    (error: unknown) => error instanceof BrowserCanonicalWorkbookError && error.code === "XLSX_FILE_TOO_LARGE",
  );

  await assert.rejects(
    observeBrowserCanonicalWorkbook({ bytes: new TextEncoder().encode("not an xlsx").buffer, fileName: "invalid.xlsx", observedAt: "2026-07-26T00:00:00.000Z" }),
    (error: unknown) => error instanceof BrowserCanonicalWorkbookError && ["XLSX_INVALID", "XLSX_REQUIRED_SHEET_MISSING"].includes(error.code),
  );
});
