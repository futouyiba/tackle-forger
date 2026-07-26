import * as XLSX from "xlsx";
import {
  CANONICAL_FEISHU_SHEET_REGISTRY,
  type FeishuSheetRegistryEntry,
  type FeishuSheetRegistryIssue,
} from "./feishu-workbook";
import {
  canonicalRuleWorkbookRangeRequests,
  inspectCanonicalRuleWorkbookValues,
  type CanonicalRuleWorkbookParsedInspection,
  type CanonicalWorkbookRange,
  type CanonicalWorkbookSourceRevision,
} from "./canonical-workbook-core";
import { deterministicHash } from "./rule-kernel";

const MAXIMUM_WORKBOOK_BYTES = 20 * 1024 * 1024;
const MAXIMUM_WORKBOOK_SHEETS = 64;
const MAXIMUM_SHEET_ROWS = 10_000;
const MAXIMUM_SHEET_COLUMNS = 200;
const MAXIMUM_SHEET_CELLS = 200_000;
const MAXIMUM_WORKBOOK_CELLS = 1_000_000;
/** 单元格字符串深度防御上限：Excel 物理上限 32767，此处兜底防异常超长输入。 */
const MAXIMUM_CELL_STRING_LENGTH = 100_000;
/** ZIP central-directory 预检上限，在 SheetJS 完整解包前拦截压缩炸弹。 */
const MAXIMUM_ZIP_ENTRIES = 1_000;
const MAXIMUM_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;

export interface BrowserCanonicalWorkbookWarning {
  code: "UNREGISTERED_SHEET";
  sheetName: string;
  message: string;
}

export interface BrowserCanonicalWorkbookObservation {
  sourceRevision: CanonicalWorkbookSourceRevision;
  ranges: CanonicalWorkbookRange[];
  warnings: BrowserCanonicalWorkbookWarning[];
  fileName: string;
  fileSize: number;
}

export class BrowserCanonicalWorkbookError extends Error {
  constructor(
    readonly code:
      | "XLSX_FILE_TOO_LARGE"
      | "XLSX_INVALID"
      | "XLSX_TOO_MANY_SHEETS"
      | "XLSX_REQUIRED_SHEET_MISSING"
      | "XLSX_SHEET_NAME_DUPLICATE"
      | "XLSX_SHEET_GRID_INVALID"
      | "XLSX_WORKBOOK_TOO_LARGE"
      | "XLSX_CELL_STRING_TOO_LONG"
      | "XLSX_FORMULA_RESULT_MISSING"
      | "XLSX_TOO_MANY_ZIP_ENTRIES"
      | "XLSX_UNCOMPRESSED_TOO_LARGE"
      | "XLSX_ZIP_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "BrowserCanonicalWorkbookError";
  }
}

function normalizeSheetName(value: string) {
  return value.normalize("NFC").trim();
}

function sheetNamesForEntry(entry: FeishuSheetRegistryEntry) {
  const aliases: Record<string, string[]> = {
    "37YLZE": ['11.0_校验规则-枚举-分隔符为","'],
    "45qauz": ["13_打包竿组-价格用加总"],
  };
  return [entry.expectedName, ...(aliases[entry.sheetId] ?? [])].map(normalizeSheetName);
}

function workbookSheetBindings(sheetNames: string[], registry: FeishuSheetRegistryEntry[]) {
  if (sheetNames.length > MAXIMUM_WORKBOOK_SHEETS) {
    throw new BrowserCanonicalWorkbookError("XLSX_TOO_MANY_SHEETS", `本地规则工作簿最多允许 ${MAXIMUM_WORKBOOK_SHEETS} 张工作表。`);
  }
  const byNormalizedName = new Map<string, string[]>();
  for (const sheetName of sheetNames) {
    const normalized = normalizeSheetName(sheetName);
    const current = byNormalizedName.get(normalized) ?? [];
    current.push(sheetName);
    byNormalizedName.set(normalized, current);
  }
  const duplicates = [...byNormalizedName.entries()].filter(([, names]) => names.length !== 1);
  if (duplicates.length) {
    throw new BrowserCanonicalWorkbookError("XLSX_SHEET_NAME_DUPLICATE", `本地规则工作簿存在重复工作表名称：${duplicates.map(([name]) => name).join("、")}。`);
  }

  const consumedNames = new Set<string>();
  const bindings = registry.flatMap((entry) => {
    const matches = sheetNames.filter((sheetName) => sheetNamesForEntry(entry).includes(normalizeSheetName(sheetName)));
    if (matches.length === 0) {
      if (entry.required) {
        throw new BrowserCanonicalWorkbookError("XLSX_REQUIRED_SHEET_MISSING", `本地规则工作簿缺少必需工作表“${entry.expectedName}”（${entry.sheetId}）。`);
      }
      return [];
    }
    if (matches.length !== 1) {
      throw new BrowserCanonicalWorkbookError("XLSX_SHEET_NAME_DUPLICATE", `工作表“${entry.expectedName}”（${entry.sheetId}）匹配到多个候选：${matches.join("、")}。`);
    }
    consumedNames.add(matches[0]!);
    return [{ entry, sheetName: matches[0]! }];
  });
  const warnings = sheetNames
    .filter((sheetName) => !consumedNames.has(sheetName))
    .map((sheetName): BrowserCanonicalWorkbookWarning => ({
      code: "UNREGISTERED_SHEET",
      sheetName,
      message: `工作表“${sheetName}”未登记为 canonical 规则来源，已忽略。`,
    }));
  return { bindings, warnings };
}

function decodeSheetGrid(sheet: XLSX.WorkSheet, sheetName: string) {
  const reference = sheet["!ref"];
  if (!reference) return { rowCount: 1, columnCount: 1 };
  let range: XLSX.Range;
  try {
    range = XLSX.utils.decode_range(reference);
  } catch {
    throw new BrowserCanonicalWorkbookError("XLSX_SHEET_GRID_INVALID", `工作表“${sheetName}”的使用区域无效。`);
  }
  const rowCount = range.e.r + 1;
  const columnCount = range.e.c + 1;
  if (!Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > MAXIMUM_SHEET_ROWS
    || !Number.isSafeInteger(columnCount) || columnCount < 1 || columnCount > MAXIMUM_SHEET_COLUMNS
    || rowCount * columnCount > MAXIMUM_SHEET_CELLS) {
    throw new BrowserCanonicalWorkbookError("XLSX_SHEET_GRID_INVALID", `工作表“${sheetName}”超出安全读取边界（${rowCount} 行 × ${columnCount} 列）。`);
  }
  return { rowCount, columnCount };
}

function canonicalCellValue(cell: XLSX.CellObject | undefined, sheetName: string, address: string): unknown {
  if (!cell) return null;
  // SheetJS 不执行公式；有缓存的公式单元格返回缓存值。无缓存的公式单元格在默认
  // 读取下不会被物化（cell 缺失），这里只防御“读到公式文本却无值”的异常形态。
  if (cell.f && cell.v === undefined) {
    throw new BrowserCanonicalWorkbookError("XLSX_FORMULA_RESULT_MISSING", `工作表“${sheetName}”单元格 ${address} 含公式但没有缓存结果；本工具不会执行 Excel 公式。`);
  }
  const value = cell.v ?? null;
  if (typeof value === "string" && value.length > MAXIMUM_CELL_STRING_LENGTH) {
    throw new BrowserCanonicalWorkbookError("XLSX_CELL_STRING_TOO_LONG", `工作表“${sheetName}”单元格 ${address} 的文本过长。`);
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/**
 * 在 SheetJS 完整解包前建立可证明的解压硬边界。SheetJS 0.20.3 的 ZIP 路径
 * 信任 local file header 并对 `_inflateRawSync` 输出无上限，因此不能把
 * central-directory 声明当作预算。这里逐条目：
 *   1. 验证 local header 与 central 一致（签名、压缩方法、名称、压缩/解压尺寸）；
 *   2. 拒绝数据描述符（flags bit 3）、ZIP64、非 stored/deflate 方法；
 *   3. 用 `DecompressionStream("deflate-raw")` 流式解压，累计真实输出字节，
 *      超过 `MAXIMUM_UNCOMPRESSED_BYTES` 立即终止。
 * 只有全部条目实际输出累计在预算内，才允许进入 `XLSX.read`。
 */
async function verifyZipInflateBudget(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  const length = bytes.byteLength;
  if (length < 22) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "文件过小，不是有效的 .xlsx 工作簿。");
  const searchStart = Math.max(0, length - 65557 - 22);
  let eocd = -1;
  for (let index = length - 22; index >= searchStart; index -= 1) {
    if (view.getUint32(index, true) === ZIP_EOCD_SIGNATURE) { eocd = index; break; }
  }
  if (eocd < 0) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "未找到 ZIP 结束记录；不是有效的 .xlsx 工作簿。");
  const totalEntries = view.getUint16(eocd + 10, true);
  const centralDirectoryOffset = view.getUint32(eocd + 16, true);
  if (totalEntries > MAXIMUM_ZIP_ENTRIES) throw new BrowserCanonicalWorkbookError("XLSX_TOO_MANY_ZIP_ENTRIES", `工作簿包含 ${totalEntries} 个 ZIP 条目，超过上限 ${MAXIMUM_ZIP_ENTRIES}。`);
  if (centralDirectoryOffset < 0 || centralDirectoryOffset + 46 > length) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "ZIP central directory 偏移无效。");
  type CentralEntry = { method: number; compressedSize: number; uncompressedSize: number; localOffset: number; name: Uint8Array };
  const entries: CentralEntry[] = [];
  let cursor = centralDirectoryOffset;
  for (let entry = 0; entry < totalEntries; entry += 1) {
    if (cursor + 46 > length) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "ZIP central directory 截断。");
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_HEADER_SIGNATURE) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "ZIP central directory 条目签名无效。");
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "工作簿使用 ZIP64，本工具不支持。");
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (cursor + 46 + nameLength > length) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "ZIP central directory 名称截断。");
    entries.push({ method, compressedSize, uncompressedSize, localOffset, name: new Uint8Array(bytes, cursor + 46, nameLength) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  let totalActual = 0;
  for (const entry of entries) {
    if (entry.method !== 0 && entry.method !== 8) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "工作簿含不支持的 ZIP 压缩方法。");
    if (entry.localOffset + 30 > length) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "ZIP local header 偏移无效。");
    if (view.getUint32(entry.localOffset, true) !== ZIP_LOCAL_HEADER_SIGNATURE) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "ZIP local header 签名无效。");
    const localFlags = view.getUint16(entry.localOffset + 6, true);
    if ((localFlags & 0x01) !== 0) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "加密 ZIP 不被支持。");
    const usesDataDescriptor = (localFlags & 0x08) !== 0;
    const localMethod = view.getUint16(entry.localOffset + 8, true);
    const localNameLength = view.getUint16(entry.localOffset + 26, true);
    const localExtraLength = view.getUint16(entry.localOffset + 28, true);
    if (localMethod !== entry.method) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "ZIP central/local 压缩方法不一致。");
    if (!usesDataDescriptor) {
      const localCompressedSize = view.getUint32(entry.localOffset + 18, true);
      const localUncompressedSize = view.getUint32(entry.localOffset + 22, true);
      if (localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "ZIP central/local 尺寸不一致。");
    }
    if (entry.localOffset + 30 + localNameLength > length) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "ZIP local header 名称截断。");
    if (!bytesEqual(new Uint8Array(bytes, entry.localOffset + 30, localNameLength), entry.name)) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "ZIP central/local 名称不一致。");
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + entry.compressedSize > length) throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "ZIP 压缩数据超出文件边界。");
    const compressed = bytes.slice(dataStart, dataStart + entry.compressedSize);
    totalActual += entry.method === 0 ? entry.compressedSize : await inflateCounted(compressed, MAXIMUM_UNCOMPRESSED_BYTES - totalActual);
    if (totalActual > MAXIMUM_UNCOMPRESSED_BYTES) throw new BrowserCanonicalWorkbookError("XLSX_UNCOMPRESSED_TOO_LARGE", `工作簿实际解压后总字节超过 ${MAXIMUM_UNCOMPRESSED_BYTES}。`);
  }
}

async function inflateCounted(input: ArrayBuffer, remainingBudget: number): Promise<number> {
  if (typeof DecompressionStream === "undefined") throw new BrowserCanonicalWorkbookError("XLSX_ZIP_INVALID", "当前运行时不支持流式解压验证。");
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > remainingBudget) {
      await reader.cancel();
      throw new BrowserCanonicalWorkbookError("XLSX_UNCOMPRESSED_TOO_LARGE", `工作簿实际解压后总字节超过 ${MAXIMUM_UNCOMPRESSED_BYTES}。`);
    }
  }
  return total;
}

function excelPhysicalRange(sheetId: string, rangeText: string) {
  // Feishu inspection 的 identity/alias logical ranges 按远端 API 返回形状定义；
  // WQ8w 导出的 XLSX 将机器 ID 放在 A 列，因此本地适配器在传输边界
  // 把这些 logical ranges 映射回同一 parser 所需的列集合。
  if (rangeText.startsWith("B1:C") && sheetId !== "19XKzU") return rangeText.replace(/^B1:C/, "A1:B");
  if (sheetId === "23CsXE" && rangeText.startsWith("B2:F")) return rangeText.replace(/^B2:F/, "A1:E");
  return rangeText;
}

function readRange(sheet: XLSX.WorkSheet, sheetName: string, rangeText: string) {
  const range = XLSX.utils.decode_range(rangeText);
  const values: unknown[][] = [];
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    const output: unknown[] = [];
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      output.push(canonicalCellValue(sheet[address], sheetName, address));
    }
    values.push(output);
  }
  return values;
}

function semanticWorkbookRevision(input: {
  sheets: Array<{ sheetId: string; name: string; rowCount: number; columnCount: number }>;
  bySheetId: Map<string, { sheetName: string; sheet: XLSX.WorkSheet }>;
}) {
  return deterministicHash({
    schemaVersion: "local-canonical-workbook/v1",
    sheets: input.sheets.map((sheet) => ({
      sheetId: sheet.sheetId,
      name: sheet.name,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      values: readRange(input.bySheetId.get(sheet.sheetId)!.sheet, input.bySheetId.get(sheet.sheetId)!.sheetName, `A1:${XLSX.utils.encode_col(sheet.columnCount - 1)}${sheet.rowCount}`),
    })),
  });
}

export async function observeBrowserCanonicalWorkbook(input: {
  bytes: ArrayBuffer;
  fileName: string;
  observedAt: string;
  registry?: FeishuSheetRegistryEntry[];
}): Promise<BrowserCanonicalWorkbookObservation> {
  if (input.bytes.byteLength > MAXIMUM_WORKBOOK_BYTES) {
    throw new BrowserCanonicalWorkbookError("XLSX_FILE_TOO_LARGE", `本地规则工作簿不能超过 ${MAXIMUM_WORKBOOK_BYTES / 1024 / 1024}MB。`);
  }
  await verifyZipInflateBudget(input.bytes);
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(input.bytes, { type: "array", cellDates: true, cellFormula: true, dense: false });
  } catch {
    throw new BrowserCanonicalWorkbookError("XLSX_INVALID", "无法读取本地规则工作簿；请选择有效的 .xlsx 文件。");
  }
  // 资源预算覆盖所有工作表（含未登记附加表），在 bindings 前拒绝巨大网格。
  const gridsBySheetName = new Map<string, { rowCount: number; columnCount: number }>();
  let totalCells = 0;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const grid = decodeSheetGrid(sheet, sheetName);
    gridsBySheetName.set(sheetName, grid);
    totalCells += grid.rowCount * grid.columnCount;
    if (totalCells > MAXIMUM_WORKBOOK_CELLS) {
      throw new BrowserCanonicalWorkbookError("XLSX_WORKBOOK_TOO_LARGE", `本地规则工作簿总单元格数超过 ${MAXIMUM_WORKBOOK_CELLS}。`);
    }
  }
  const registry = input.registry ?? CANONICAL_FEISHU_SHEET_REGISTRY;
  const { bindings, warnings } = workbookSheetBindings(workbook.SheetNames, registry);
  const sheets = bindings.map(({ entry, sheetName }) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new BrowserCanonicalWorkbookError("XLSX_REQUIRED_SHEET_MISSING", `本地规则工作簿缺少工作表“${sheetName}”。`);
    const grid = gridsBySheetName.get(sheetName) ?? decodeSheetGrid(sheet, sheetName);
    return { sheetId: entry.sheetId, name: sheetName, ...grid };
  });
  const bySheetId = new Map(bindings.map(({ entry, sheetName }) => [entry.sheetId, { sheetName, sheet: workbook.Sheets[sheetName]! }]));
  const semanticRevision = semanticWorkbookRevision({ sheets, bySheetId });
  const sourceRevision: CanonicalWorkbookSourceRevision = {
    id: `local-canonical-workbook:${semanticRevision}`,
    workbookRefId: "local-canonical-workbook:browser-session",
    sourceRevision: semanticRevision,
    sheets,
    issues: warnings.map((warning): FeishuSheetRegistryIssue => ({
      code: "UNREGISTERED_SHEET",
      severity: "warning",
      sheetId: warning.sheetName,
      observedName: warning.sheetName,
      message: warning.message,
    })),
  };
  const ranges = canonicalRuleWorkbookRangeRequests(sourceRevision).map((request): CanonicalWorkbookRange => {
    const binding = bySheetId.get(request.sheetId);
    if (!binding) throw new BrowserCanonicalWorkbookError("XLSX_REQUIRED_SHEET_MISSING", `本地规则工作簿缺少请求所需工作表 ${request.sheetId}。`);
    return {
      sheetId: request.sheetId,
      range: request.range,
      valueRange: {
        revision: semanticRevision,
        range: `${request.sheetId}!${request.range}`,
        values: readRange(binding.sheet, binding.sheetName, excelPhysicalRange(request.sheetId, request.range)),
      },
    };
  });
  return { sourceRevision, ranges, warnings, fileName: input.fileName, fileSize: input.bytes.byteLength };
}

export async function inspectBrowserCanonicalWorkbook(input: {
  bytes: ArrayBuffer;
  fileName: string;
  observedAt: string;
}): Promise<{ observation: BrowserCanonicalWorkbookObservation; inspection: CanonicalRuleWorkbookParsedInspection }> {
  const observation = await observeBrowserCanonicalWorkbook(input);
  const inspection = await inspectCanonicalRuleWorkbookValues({
    observedAt: input.observedAt,
    sourceRevision: observation.sourceRevision,
    ranges: observation.ranges,
  });
  return { observation, inspection };
}
