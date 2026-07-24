import * as XLSX from "xlsx";
import type { FeishuSheetRegistryEntry, FeishuSourceRevision, RemoteFeishuSheet } from "./feishu-workbook";
import type { FeishuSheetRangeRequest, FeishuValueRange } from "./feishu-sheets";
import { REDACTED } from "./workspace-xlsx-export";

/**
 * 方向 B（只读派生导出）：把应用从飞书规则源实际读到的原始 range/values 序列化
 * 为多 sheet xlsx，供与工作区状态逐表对照、排查源数据结构。
 *
 * 设计约束（与 CLAUDE.md / v3 规范一致）：
 * - 纯函数、确定性：相同输入产生相同的 sheet 名、列顺序与单元格值；不读取系统
 *   时钟、不生成随机 ID、不触发任何写操作或新 revision。
 * - 只读派生：不修改任何正式数据/快照/规则源；调用方负责权限校验与实际联网读取。
 * - 敏感字段：源修订中的 spreadsheetToken 一律脱敏为 `<redacted>`；cell values
 *   原样保留（飞书规则源 cell 内容不含凭据；若后续发现敏感 cell，应在读取端
 *   增加按列脱敏策略，不在本模块硬编码领域假设）。
 * - 不硬编码未决领域语义：导出哪些 sheet、范围上限均为合理默认并文档化，开放
 *   决策（是否纳入非规则源 sheet、范围上限取值）在响应/注释中列出，由调用方
 *   或后续决策确认，不在本模块固定为产品语义。
 */

/** 默认导出的 sheet 角色：仅规则源。开发计划/暂存输出默认不导出（开放决策）。 */
export const DEFAULT_EXPORT_ROLES: ReadonlySet<FeishuSheetRegistryEntry["role"]> = new Set(["rule_source"]);

/**
 * 当 sheet 缺少可验证的 grid 元信息时使用的保守读取上限。选择 500 行 × 60 列：
 * 覆盖当前 canonical 规则源各 sheet 的实测行数（最大约 70 行），同时避免读到
 * 意外超大的暂存区域。该取值是工程默认，不是领域语义。
 */
export const DEFAULT_ROW_CAP = 500;
export const DEFAULT_COLUMN_CAP = 60;

/** 把 1-based 列号转为飞书/Excel 列字母（1→A，26→Z，27→AA）。 */
export function columnLetter(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new Error(`列号必须为正整数，收到 ${index}。`);
  }
  let result = "";
  let n = index;
  while (n > 0) {
    const mod = (n - 1) % 26;
    result = String.fromCharCode(65 + mod) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/**
 * 为单个远端 sheet 构造整表读取范围 `A1:<lastCol><lastRow>`。grid 元信息缺失或
 * 非安全整数时回退到保守默认上限（文档化），不猜测别名或截断机器 ID。
 */
export function feishuSourceSheetRange(
  sheet: RemoteFeishuSheet,
  options: { rowCap?: number; columnCap?: number } = {},
): string {
  const rowCap = options.rowCap ?? DEFAULT_ROW_CAP;
  const columnCap = options.columnCap ?? DEFAULT_COLUMN_CAP;
  const rowCount =
    Number.isSafeInteger(sheet.rowCount) && sheet.rowCount! > 0
      ? Math.min(sheet.rowCount!, rowCap)
      : rowCap;
  const columnCount =
    Number.isSafeInteger(sheet.columnCount) && sheet.columnCount! > 0
      ? Math.min(sheet.columnCount!, columnCap)
      : columnCap;
  return `A1:${columnLetter(columnCount)}${rowCount}`;
}

export interface FeishuSourceRangeRead {
  sheetId: string;
  range: string;
  valueRange: FeishuValueRange;
  /** registry 登记名（对照用）；若 sheet 未登记则为 undefined。 */
  expectedName?: string;
  /** pull 时远端返回的 sheet 名（稳定 ID 读取，不依赖名）。 */
  observedName?: string;
}

export interface FeishuSourceRangeFailure {
  sheetId: string;
  range: string;
  expectedName?: string;
  observedName?: string;
  error: string;
}

export interface FeishuSourceExportInput {
  sourceRevision: FeishuSourceRevision;
  registry: FeishuSheetRegistryEntry[];
  reads: ReadonlyArray<FeishuSourceRangeRead>;
  /** 读取失败但仍需在元信息 sheet 中透明化的 sheet（不影响成功 sheet 的导出）。 */
  failures?: ReadonlyArray<FeishuSourceRangeFailure>;
  /** 导出时使用的行/列上限，用于在元信息 sheet 中文档化默认。 */
  options?: { rowCap?: number; columnCap?: number };
}

/** xlsx sheet 名清洗：飞书/Excel 限制 31 字符，且不得含 `[]:*?/\`。 */
function sanitizeSheetName(rawName: string): string {
  const cleaned = rawName.replace(/[[\]:*?/\\]/g, "_").trim();
  return cleaned.slice(0, 31) || "Sheet";
}

/** 在已用名称集合内返回唯一 sheet 名（冲突时追加 `(2)`、`(3)`……）。 */
function uniqueSheetName(baseName: string, used: Set<string>): string {
  if (!used.has(baseName)) return baseName;
  let index = 2;
  while (used.has(`${baseName.slice(0, 28)}(${index})`)) index += 1;
  return `${baseName.slice(0, 28)}(${index})`;
}

function readDisplayName(read: FeishuSourceRangeRead): string {
  return read.expectedName ?? read.observedName ?? read.sheetId;
}

/**
 * 构造默认导出范围请求：仅 `rule_source` 角色且在 sourceRevision.sheets 中存在
 * grid 记录的 sheet。未登记或缺席的 sheet 不在此构造（元信息 sheet 会记录缺席）。
 * 顺序遵循 registry 顺序，保证确定性。
 */
export function buildFeishuSourceExportRequests(
  sourceRevision: FeishuSourceRevision,
  registry: FeishuSheetRegistryEntry[],
  options: { rowCap?: number; columnCap?: number; roles?: ReadonlySet<FeishuSheetRegistryEntry["role"]> } = {},
): FeishuSheetRangeRequest[] {
  const roles = options.roles ?? DEFAULT_EXPORT_ROLES;
  const byId = new Map(sourceRevision.sheets.map((sheet) => [sheet.sheetId, sheet]));
  const requests: FeishuSheetRangeRequest[] = [];
  for (const entry of registry) {
    if (!roles.has(entry.role)) continue;
    const sheet = byId.get(entry.sheetId);
    if (!sheet) continue;
    requests.push({
      sheetId: entry.sheetId,
      range: feishuSourceSheetRange(sheet, options),
    });
  }
  return requests;
}

/** 列出 registry 中应导出但 sourceRevision.sheets 缺席的 sheet（用于元信息透明化）。 */
export function missingSourceSheets(
  sourceRevision: FeishuSourceRevision,
  registry: FeishuSheetRegistryEntry[],
  roles: ReadonlySet<FeishuSheetRegistryEntry["role"]> = DEFAULT_EXPORT_ROLES,
): FeishuSheetRegistryEntry[] {
  const byId = new Set(sourceRevision.sheets.map((sheet) => sheet.sheetId));
  return registry.filter((entry) => roles.has(entry.role) && !byId.has(entry.sheetId));
}

/**
 * 构建导出工作簿：
 * - 「源数据说明」sheet：源修订元信息（token 脱敏）+ 各 range 摘要 + 缺席 sheet。
 * - 每个 range 一个数据 sheet：内容为飞书返回的原始 values（保留源表结构）。
 *
 * 相同输入产生相同 sheet 顺序、相同 sheet 名、相同单元格内容。
 */
export function buildFeishuSourceExportWorkbook(input: FeishuSourceExportInput): XLSX.WorkBook {
  const { sourceRevision, registry, reads, failures, options } = input;
  const rowCap = options?.rowCap ?? DEFAULT_ROW_CAP;
  const columnCap = options?.columnCap ?? DEFAULT_COLUMN_CAP;

  const metaRows: (string | number)[][] = [
    ["字段", "值"],
    ["源修订ID", sourceRevision.id],
    ["工作簿引用", sourceRevision.workbookRefId],
    ["源revision", sourceRevision.sourceRevision],
    ["spreadsheetToken", REDACTED],
    ["拉取时间", sourceRevision.pulledAt],
    ["拉取人", sourceRevision.pulledBy],
    ["anchorSheetId", sourceRevision.anchorSheetId ?? ""],
    ["syncScope", sourceRevision.syncScope],
    ["registryHash", sourceRevision.registryHash],
    ["修订状态", sourceRevision.state],
    ["行上限（默认）", rowCap],
    ["列上限（默认）", columnCap],
    [],
    ["各 range 摘要", "sheetId", "range", "revision", "行数"],
    ...reads.map((read) => [
      readDisplayName(read),
      read.sheetId,
      read.range,
      read.valueRange.revision,
      (read.valueRange.values ?? []).length,
    ]),
  ];
  const missing = missingSourceSheets(sourceRevision, registry);
  if (missing.length) {
    metaRows.push([], ["缺席的规则源 sheet（默认未导出）", "sheetId", "登记名"]);
    for (const entry of missing) {
      metaRows.push([entry.expectedName, entry.sheetId, entry.role]);
    }
  }
  if (failures && failures.length) {
    metaRows.push([], ["读取失败（仍导出其余成功 sheet）", "sheetId", "range", "错误"]);
    for (const failure of failures) {
      metaRows.push([
        failure.expectedName ?? failure.observedName ?? failure.sheetId,
        failure.sheetId,
        failure.range,
        failure.error,
      ]);
    }
  }
  metaRows.push(
    [],
    ["说明"],
    ["本导出为只读派生：从工作区已记录的飞书源修订读取各规则源 sheet 的原始 range/values。"],
    ["默认仅导出 role=rule_source 的 sheet；开发计划/暂存输出默认不导出（开放决策）。"],
    ["spreadsheetToken 等凭据已脱敏；cell values 原样保留源表内容。"],
    ["范围上限与是否纳入非规则源 sheet 属开放决策，见路由返回说明与代码注释。"],
  );

  const workbook = XLSX.utils.book_new();
  // 不设置 Props 时钟字段，保证二进制可复现。
  const metaSheet = XLSX.utils.aoa_to_sheet(metaRows);
  XLSX.utils.book_append_sheet(workbook, metaSheet, "源数据说明");

  const usedNames = new Set<string>(["源数据说明"]);
  // reads 顺序由调用方（路由）保证稳定；此处按读入顺序追加。
  for (const read of reads) {
    const baseName = sanitizeSheetName(readDisplayName(read));
    const name = uniqueSheetName(baseName, usedNames);
    usedNames.add(name);
    const values = read.valueRange.values ?? [];
    const sheet = XLSX.utils.aoa_to_sheet(values.length ? values : [[""]]);
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  return workbook;
}

/** 序列化为 xlsx ArrayBuffer。相同输入产生相同输出。 */
export function serializeFeishuSourceExport(input: FeishuSourceExportInput): ArrayBuffer {
  const workbook = buildFeishuSourceExportWorkbook(input);
  return XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
    compression: true,
  }) as ArrayBuffer;
}

/** 生成确定性下载文件名（仅依赖源 revision，不含时间戳）。 */
export function feishuSourceExportFilename(input: FeishuSourceExportInput): string {
  const rev = input.sourceRevision.sourceRevision;
  return `飞书源数据_r${rev}.xlsx`;
}
