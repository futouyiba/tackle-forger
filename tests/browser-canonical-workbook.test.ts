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
} from "../lib/canonical-workbook-core";

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

function u16le(n: number) { return [n & 0xff, (n >> 8) & 0xff]; }
function u32le(n: number) { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]; }

/** 构造仅含 central directory + EOCD 的受控 ZIP 字节流，用于测 preflight（不构造 local headers）。 */
function buildControlledZip(entries: Array<{ uncompressed: number; name?: string }>, declaredEntries?: number): ArrayBuffer {
  const enc = new TextEncoder();
  const central: number[] = [];
  for (const entry of entries) {
    const nameBytes = [...enc.encode(entry.name ?? "x")];
    central.push(...u32le(0x02014b50), ...u16le(20), ...u16le(20), ...u16le(0), ...u16le(0), ...u16le(0), ...u16le(0), ...u32le(0), ...u32le(0), ...u32le(entry.uncompressed), ...u16le(nameBytes.length), ...u16le(0), ...u16le(0), ...u16le(0), ...u16le(0), ...u32le(0), ...u32le(0));
    central.push(...nameBytes);
  }
  const declared = declaredEntries ?? entries.length;
  const eocd = [...u32le(0x06054b50), ...u16le(0), ...u16le(0), ...u16le(declared), ...u16le(declared), ...u32le(central.length), ...u32le(0), ...u16le(0)];
  return new Uint8Array([...central, ...eocd]).buffer;
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BrowserCanonicalWorkbookError, `expected BrowserCanonicalWorkbookError, got ${error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return true;
  });
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
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: workbookBytes(missing), fileName: "missing.xlsx", observedAt: "2026-07-26T00:00:00.000Z" }), "XLSX_REQUIRED_SHEET_MISSING");

  const typo = fixtureSheets();
  const typoSheet = typo.find(({ entry }) => entry.sheetId === "1cAihB")!;
  typoSheet.entry = { ...typoSheet.entry, expectedName: "01.0_重量模板-竿-错名" };
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: workbookBytes(typo), fileName: "typo.xlsx", observedAt: "2026-07-26T00:00:00.000Z" }), "XLSX_REQUIRED_SHEET_MISSING");

  const workbook = XLSX.read(workbookBytes(), { type: "array" });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["额外"]]), "用户附加说明");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const observed = await observeBrowserCanonicalWorkbook({ bytes, fileName: "extra.xlsx", observedAt: "2026-07-26T00:00:00.000Z" });
  assert.deepEqual(observed.warnings.map((warning) => warning.sheetName), ["用户附加说明"]);
});

test("浏览器 canonical XLSX adapter 拒绝超限文件、无效 ZIP 和无缓存公式单元格", async () => {
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: new ArrayBuffer(20 * 1024 * 1024 + 1), fileName: "large.xlsx", observedAt: "2026-07-26T00:00:00.000Z" }), "XLSX_FILE_TOO_LARGE");
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: new TextEncoder().encode("not an xlsx").buffer, fileName: "invalid.xlsx", observedAt: "2026-07-26T00:00:00.000Z" }), "XLSX_ZIP_INVALID");

  // 有缓存的公式单元格返回缓存值（不执行公式）
  const cached = XLSX.read(workbookBytes(), { type: "array", cellFormula: true });
  cached.Sheets["08.1_品质评分-品质定义"]!.E2 = { t: "n", v: 0.8, f: "0.4+0.4" };
  const cachedBytes = XLSX.write(cached, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const cachedObserved = await observeBrowserCanonicalWorkbook({ bytes: cachedBytes, fileName: "cached.xlsx", observedAt: "2026-07-26T00:00:00.000Z" });
  const qualityRange = cachedObserved.ranges.find((range) => range.sheetId === "27hboC");
  assert.ok(qualityRange?.valueRange.values.some((row) => row.includes(0.8)), "缓存值应被读出而非执行公式");
});

test("浏览器 canonical XLSX adapter 在 SheetJS 解包前用 ZIP central directory 预检拦截压缩炸弹", async () => {
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: buildControlledZip([], 1001), fileName: "many.zip", observedAt: "x" }), "XLSX_TOO_MANY_ZIP_ENTRIES");
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: buildControlledZip([{ uncompressed: 201 * 1024 * 1024 }]), fileName: "bomb.zip", observedAt: "x" }), "XLSX_UNCOMPRESSED_TOO_LARGE");
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: buildControlledZip([{ uncompressed: 0xffffffff }]), fileName: "zip64.zip", observedAt: "x" }), "XLSX_ZIP_INVALID");
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: new Uint8Array(64).buffer, fileName: "noeocd.zip", observedAt: "x" }), "XLSX_ZIP_INVALID");
});

test("浏览器 canonical XLSX adapter 对所有工作表（含未登记）强制资源边界", async () => {
  const ts = "2026-07-26T00:00:00.000Z";

  const tooManySheets = XLSX.utils.book_new();
  for (const { entry, values } of fixtureSheets()) XLSX.utils.book_append_sheet(tooManySheets, XLSX.utils.aoa_to_sheet(values), entry.expectedName);
  for (let index = 0; index < 17; index += 1) XLSX.utils.book_append_sheet(tooManySheets, XLSX.utils.aoa_to_sheet([["x"]]), `额外${index}`);
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: XLSX.write(tooManySheets, { type: "array", bookType: "xlsx" }) as ArrayBuffer, fileName: "many-sheets.xlsx", observedAt: ts }), "XLSX_TOO_MANY_SHEETS");

  const tooManyRows = fixtureSheets();
  tooManyRows.find(({ entry }) => entry.sheetId === "1cAihB")!.values = Array.from({ length: 10_001 }, () => Array.from({ length: 30 }, () => null));
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: workbookBytes(tooManyRows), fileName: "rows.xlsx", observedAt: ts }), "XLSX_SHEET_GRID_INVALID");

  const tooManyColumns = fixtureSheets();
  tooManyColumns.find(({ entry }) => entry.sheetId === "1cAihB")!.values = Array.from({ length: 2 }, () => Array.from({ length: 201 }, () => null));
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: workbookBytes(tooManyColumns), fileName: "cols.xlsx", observedAt: ts }), "XLSX_SHEET_GRID_INVALID");

  // 未登记附加表也计入全表预算：6 张 1000×199 合计约 119 万 > 100 万，单张 19.9 万 < 20 万单表上限
  const workbook = XLSX.read(workbookBytes(), { type: "array" });
  const big = Array.from({ length: 1000 }, () => Array.from({ length: 199 }, () => null));
  for (let index = 0; index < 6; index += 1) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(big), `巨大附加${index}`);
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer, fileName: "budget.xlsx", observedAt: ts }), "XLSX_WORKBOOK_TOO_LARGE");
});
