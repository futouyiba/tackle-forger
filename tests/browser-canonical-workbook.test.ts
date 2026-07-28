import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
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

/** 构造仅含 central directory + EOCD 的受控 ZIP 字节流，用于测预检签名级拒绝（不构造 local headers）。 */
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

interface RealZipEntry {
  name: string;
  content: Uint8Array;
  method?: 0 | 8;
  dataDescriptor?: boolean;
  encrypted?: boolean;
  /** 覆盖 local header 的压缩尺寸（central 仍写真实值），用于测 central/local 不一致。 */
  localCszOverride?: number;
}

/** 构造真实可解压 ZIP（local header + 压缩数据 + central directory + EOCD），用于测流式 inflate 预检。 */
function buildRealZip(entries: RealZipEntry[]): ArrayBuffer {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralRec: Array<{ localStart: number; name: Uint8Array; method: number; csz: number; usz: number; flags: number }> = [];
  let localLen = 0;
  for (const entry of entries) {
    const localStart = localLen;
    const name = enc.encode(entry.name);
    const method = entry.method ?? 8;
    const data = method === 8 ? deflateRawSync(entry.content) : entry.content;
    const usz = entry.content.length;
    const csz = data.length;
    const dd = entry.dataDescriptor ?? false;
    const flags = (dd ? 0x08 : 0) | (entry.encrypted ? 0x01 : 0);
    const header = new Uint8Array(30);
    const hdv = new DataView(header.buffer);
    hdv.setUint32(0, 0x04034b50, true);
    hdv.setUint16(4, 20, true);
    hdv.setUint16(6, flags, true);
    hdv.setUint16(8, method, true);
    hdv.setUint32(18, entry.localCszOverride ?? (dd ? 0 : csz), true);
    hdv.setUint32(22, dd ? 0 : usz, true);
    hdv.setUint16(26, name.length, true);
    const ddBytes = dd ? Uint8Array.of(...u32le(0x08074b50), 0, 0, 0, ...u32le(csz), ...u32le(usz)) : new Uint8Array(0);
    localParts.push(header, name, new Uint8Array(data), ddBytes);
    localLen += header.length + name.length + data.length + ddBytes.length;
    centralRec.push({ localStart, name, method, csz, usz, flags });
  }
  const centralParts: Uint8Array[] = [];
  let cdLen = 0;
  for (const c of centralRec) {
    const ch = new Uint8Array(46);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, c.flags, true);
    cdv.setUint16(10, c.method, true);
    cdv.setUint32(20, c.csz, true);
    cdv.setUint32(24, c.usz, true);
    cdv.setUint16(28, c.name.length, true);
    cdv.setUint32(42, c.localStart, true);
    centralParts.push(ch, c.name);
    cdLen += ch.length + c.name.length;
  }
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, cdLen, true);
  edv.setUint32(16, localLen, true);
  const out = new Uint8Array(localLen + cdLen + 22);
  let off = 0;
  for (const part of localParts) { out.set(part, off); off += part.length; }
  for (const part of centralParts) { out.set(part, off); off += part.length; }
  out.set(eocd, off);
  return out.buffer;
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

  const duplicate = XLSX.read(workbookBytes(), { type: "array" });
  XLSX.utils.book_append_sheet(duplicate, XLSX.utils.aoa_to_sheet([["one"]]), "重复说明");
  XLSX.utils.book_append_sheet(duplicate, XLSX.utils.aoa_to_sheet([["two"]]), " 重复说明 ");
  await rejectsCode(
    observeBrowserCanonicalWorkbook({
      bytes: XLSX.write(duplicate, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
      fileName: "duplicate-normalized-sheet.xlsx",
      observedAt: "2026-07-26T00:00:00.000Z",
    }),
    "XLSX_SHEET_NAME_DUPLICATE",
  );

  const legacy = XLSX.read(workbookBytes(), { type: "array" });
  XLSX.utils.book_append_sheet(
    legacy,
    XLSX.utils.aoa_to_sheet([["legacy workspace payload"]]),
    "_TackleForgerState",
  );
  await rejectsCode(
    observeBrowserCanonicalWorkbook({
      bytes: XLSX.write(legacy, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
      fileName: "legacy-workspace.xlsx",
      observedAt: "2026-07-26T00:00:00.000Z",
    }),
    "XLSX_LEGACY_WORKSPACE_EXPORT_REJECTED",
  );
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

  const uncached = XLSX.read(workbookBytes(), { type: "array", cellFormula: true });
  uncached.Sheets["08.1_品质评分-品质定义"]!.E2 = {
    t: "n",
    f: "0.4+0.4",
  };
  await rejectsCode(
    observeBrowserCanonicalWorkbook({
      bytes: XLSX.write(uncached, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
      fileName: "uncached-formula.xlsx",
      observedAt: "2026-07-26T00:00:00.000Z",
    }),
    "XLSX_FORMULA_RESULT_MISSING",
  );
});

test("浏览器 canonical XLSX adapter 在 SheetJS 解包前用 ZIP central directory 预检拦截声明级压缩炸弹", async () => {
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: buildControlledZip([], 1001), fileName: "many.zip", observedAt: "x" }), "XLSX_TOO_MANY_ZIP_ENTRIES");
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: buildControlledZip([{ uncompressed: 0xffffffff }]), fileName: "zip64.zip", observedAt: "x" }), "XLSX_ZIP_INVALID");
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: new Uint8Array(64).buffer, fileName: "noeocd.zip", observedAt: "x" }), "XLSX_ZIP_INVALID");
});

test("ZIP 流式解压验证：拒绝 central/local 不一致、实际超预算、加密；数据描述符通过预检", async () => {
  const ts = "2026-07-27T00:00:00.000Z";
  // central/local 尺寸不一致（非数据描述符）→ 在 inflate 前拒绝
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: buildRealZip([{ name: "a", content: new Uint8Array([1, 2, 3]), localCszOverride: 999 }]), fileName: "mismatch.zip", observedAt: ts }), "XLSX_ZIP_INVALID");
  // 高压缩比、实际解压输出超过预算（central 声明小但 inflate 真实 210MB）→ 流式计数拒绝
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: buildRealZip([{ name: "a", content: new Uint8Array(Buffer.alloc(210_000_000, 0x61)) }]), fileName: "bomb.xlsx", observedAt: ts }), "XLSX_UNCOMPRESSED_TOO_LARGE");
  // 加密 ZIP → 拒绝
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: buildRealZip([{ name: "a", content: new Uint8Array([1]), encrypted: true }]), fileName: "enc.zip", observedAt: ts }), "XLSX_ZIP_INVALID");
  // 数据描述符通过流式预检（仅因不是合法 XLSX 才在 read 阶段失败，证明未被预检误拒）
  await rejectsCode(observeBrowserCanonicalWorkbook({ bytes: buildRealZip([{ name: "a", content: new Uint8Array([1, 2, 3]), dataDescriptor: true }]), fileName: "dd.zip", observedAt: ts }), "XLSX_INVALID");
});

test("浏览器 canonical XLSX adapter 接受合法长字符串单元格（≤物理上限不误伤）", async () => {
  const sheets = fixtureSheets();
  sheets.find(({ entry }) => entry.sheetId === "1cAihB")!.values[1]![0] = "说明".repeat(5000);
  const observed = await observeBrowserCanonicalWorkbook({ bytes: workbookBytes(sheets), fileName: "long-ok.xlsx", observedAt: "2026-07-27T00:00:00.000Z" });
  assert.equal(observed.sourceRevision.sheets.length, CANONICAL_FEISHU_SHEET_REGISTRY.length);

  const tooLong = fixtureSheets();
  tooLong.find(({ entry }) => entry.sheetId === "1cAihB")!.values[1]![0] = "x".repeat(16_385);
  await rejectsCode(
    observeBrowserCanonicalWorkbook({
      bytes: workbookBytes(tooLong),
      fileName: "long-rejected.xlsx",
      observedAt: "2026-07-27T00:00:00.000Z",
    }),
    "XLSX_CELL_STRING_TOO_LONG",
  );
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

  const longTextExtra = XLSX.read(workbookBytes(), { type: "array" });
  XLSX.utils.book_append_sheet(
    longTextExtra,
    XLSX.utils.aoa_to_sheet([["x".repeat(16_385)]]),
    "附加超长文本",
  );
  await rejectsCode(
    observeBrowserCanonicalWorkbook({
      bytes: XLSX.write(longTextExtra, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
      fileName: "extra-long-text.xlsx",
      observedAt: ts,
    }),
    "XLSX_CELL_STRING_TOO_LONG",
  );

  const formulaExtra = XLSX.read(workbookBytes(), { type: "array", cellFormula: true });
  XLSX.utils.book_append_sheet(
    formulaExtra,
    { A1: { t: "n", f: "1+1" }, "!ref": "A1" },
    "附加无缓存公式",
  );
  await rejectsCode(
    observeBrowserCanonicalWorkbook({
      bytes: XLSX.write(formulaExtra, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
      fileName: "extra-uncached-formula.xlsx",
      observedAt: ts,
    }),
    "XLSX_FORMULA_RESULT_MISSING",
  );
});
