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
} from "./rule-workbook-inspection";
import { deterministicHash } from "./rule-kernel";

const MAXIMUM_WORKBOOK_BYTES = 20 * 1024 * 1024;
const MAXIMUM_WORKBOOK_SHEETS = 64;
const MAXIMUM_SHEET_ROWS = 10_000;
const MAXIMUM_SHEET_COLUMNS = 200;
const MAXIMUM_SHEET_CELLS = 200_000;
const MAXIMUM_WORKBOOK_CELLS = 1_000_000;
const MAXIMUM_CELL_STRING_LENGTH = 100_000;

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
      | "XLSX_FORMULA_RESULT_MISSING",
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
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(input.bytes, { type: "array", cellDates: true, cellFormula: true, dense: false });
  } catch {
    throw new BrowserCanonicalWorkbookError("XLSX_INVALID", "无法读取本地规则工作簿；请选择有效的 .xlsx 文件。");
  }
  const registry = input.registry ?? CANONICAL_FEISHU_SHEET_REGISTRY;
  const { bindings, warnings } = workbookSheetBindings(workbook.SheetNames, registry);
  let totalCells = 0;
  const sheets = bindings.map(({ entry, sheetName }) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new BrowserCanonicalWorkbookError("XLSX_REQUIRED_SHEET_MISSING", `本地规则工作簿缺少工作表“${sheetName}”。`);
    const grid = decodeSheetGrid(sheet, sheetName);
    totalCells += grid.rowCount * grid.columnCount;
    return { sheetId: entry.sheetId, name: sheetName, ...grid };
  });
  if (totalCells > MAXIMUM_WORKBOOK_CELLS) {
    throw new BrowserCanonicalWorkbookError("XLSX_WORKBOOK_TOO_LARGE", `本地规则工作簿总单元格数超过 ${MAXIMUM_WORKBOOK_CELLS}。`);
  }
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
