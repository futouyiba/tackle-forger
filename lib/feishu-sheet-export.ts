import { feishuApiBase, feishuTenantAccessToken } from "./feishu";
import { FeishuApiError, feishuEndpointPath, maskToken, type FeishuApiErrorInfo } from "./feishu-api-error";
import { readFeishuSheetRange } from "./feishu-sheets";
import { buildWorkspaceSheetSpecs, type WorkspaceSheetSpec } from "./workspace-xlsx-export";
import { columnLetter } from "./feishu-source-xlsx-export";
import type { WorkspaceState } from "./types";

/**
 * 方向 A（受控写入导出）：把当前工作区数据**复制**写到一张**新的**飞书电子表格
 * （多 sheet，与 Excel 导出同构）。
 *
 * 治理边界（与 CLAUDE.md / v3 规范一致）：
 * - 受控写入：创建新电子表格 + 写入 cells；**不**写回 canonical 规则源、不绕过
 *   stable ID、不修改 CANONICAL_FEISHU_WORKBOOK/CANONICAL_FEISHU_SHEET_REGISTRY
 *   等常量、不调用 inspect/pull/draft/publish、不自动发布。
 * - 独立动作：本模块不与 pull/草稿/发布共享状态变更路径；它只产出一份工作区
 *   当前数据的**副本**到新表。
 * - 错误可观测：所有飞书 open-apis 失败抛 `FeishuApiError`，携带 code/msg/
 *   httpStatus/endpoint；token 永远以 maskToken 形式进入 tokenContext，不进
 *   日志/响应体。
 * - 凭据安全：FEISHU_APP_ID/FEISHU_APP_SECRET 仅用于换取 tenant_access_token；
 *   app secret 不出现在任何返回值或日志。
 *
 * 开放决策（默认值见本模块常量与注释；需用户确认，已在 manifest 中返回）：
 *  1. 目标文件夹 folderToken：默认空（创建到应用根目录）。调用方可通过入参覆盖。
 *  2. sheet 命名：复用 Excel 导出同构的中文 sheet 名（来自 buildWorkspaceSheetSpecs），
 *     按飞书 31 字符限制清洗。
 *  3. 覆盖策略：始终**创建新表**，不覆盖/不删除既有电子表格；多余默认 sheet
 *     不自动删除（见 OPEN: 默认 sheet 清理）。
 *  4. 单批写入单元格上限 4000 cells（飞书 values_batch_update 限制的保守值）。
 */

type FetchLike = typeof fetch;

/** 飞书电子表格标题长度上限（v3 创建接口约束）。 */
const SPREADSHEET_TITLE_CAP = 100;
/** 单批写入的单元格上限（保守低于飞书 valueRange 5000 cells 限制）。 */
const BATCH_CELL_CAP = 4000;

export interface FeishuSheetExportDefaults {
  /** 目标文件夹 token（脱敏回显）；空串表示应用根目录（飞书默认）。raw token 不得进入响应。 */
  folderToken: string;
  /** sheet 命名来源说明（文档化用）。 */
  sheetNameSource: string;
  /** 覆盖策略说明（文档化用）。 */
  overwritePolicy: string;
  /** 单批单元格上限（文档化用）。 */
  batchCellCap: number;
}

export interface FeishuSheetExportSheetResult {
  name: string;
  sheetId?: string;
  rowsWritten: number;
  result: "written" | "skipped_empty" | "failed";
  error?: FeishuApiErrorInfo;
  /** 写入后回读核对的结论（仅 result==="written" 时出现）。 */
  verified?: boolean;
  /** 核对不一致或回读失败的证据（verified:false 时提供，不含 raw token）。 */
  verifyEvidence?: string;
}

export interface FeishuSheetExportManifest {
  /**
   * 新表 URL（飞书开放平台返回），是用户打开/分享新表的唯一资源句柄。
   * 保守默认（审核要求）：新建电子表格的 spreadsheet_token 是给用户用的资源
   * 句柄（非凭据），但本工具不将其作为独立字段返回——用户通过 url 即可访问
   * 新表，token 不单独暴露。服务端日志中 url/token 一律脱敏。
   */
  url: string;
  /** 新表标题。 */
  title: string;
  /** 实际使用的目标文件夹 token（脱敏回显）。 */
  folderTokenMasked: string;
  sheetResults: FeishuSheetExportSheetResult[];
  totalRowsWritten: number;
  failedCount: number;
  /** 默认值与开放决策回显，便于用户确认。 */
  defaults: FeishuSheetExportDefaults;
  /** 未能自动处理的开放事项，需用户确认/手动跟进。 */
  openQuestions: string[];
}

interface FeishuEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

async function sheetOpenApi<T>(
  path: string,
  init: RequestInit = {},
  fetcher: FetchLike = fetch,
  tokenContext?: string,
): Promise<T> {
  const token = await feishuTenantAccessToken();
  const response = await fetcher(feishuApiBase() + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const payload = (await response.json()) as FeishuEnvelope<T>;
  if (!response.ok || payload.code !== 0 || payload.data === undefined) {
    throw new FeishuApiError({
      reason: "飞书电子表格接口失败",
      code: payload.code,
      msg: payload.msg,
      httpStatus: response.status,
      endpoint: feishuEndpointPath(path),
      tokenContext,
    });
  }
  return payload.data;
}

function sanitizeSheetName(rawName: string): string {
  const cleaned = rawName.replace(/[[\]:*?/\\]/g, "_").trim();
  return cleaned.slice(0, 31) || "Sheet";
}

/** 创建一张新的飞书电子表格。folderToken 为空时创建到应用根目录。 */
export async function createFeishuSpreadsheet(input: {
  name: string;
  folderToken?: string;
  fetcher?: FetchLike;
}): Promise<{ spreadsheetToken: string; url: string; title: string }> {
  const title = input.name.slice(0, SPREADSHEET_TITLE_CAP);
  const body: Record<string, unknown> = { name: title };
  if (input.folderToken?.trim()) body.folder_token = input.folderToken.trim();
  const data = await sheetOpenApi<{
    spreadsheet?: { title?: string; url?: string; spreadsheet_token?: string };
  }>(
    "/open-apis/sheets/v3/spreadsheets",
    { method: "POST", body: JSON.stringify(body) },
    input.fetcher,
    input.folderToken?.trim() ? `folder:${maskToken(input.folderToken.trim())}` : "folder:root",
  );
  const spreadsheetToken = data.spreadsheet?.spreadsheet_token;
  const url = data.spreadsheet?.url;
  if (!spreadsheetToken || !url) {
    throw new FeishuApiError({
      reason: "飞书创建电子表格失败：响应缺少 spreadsheet_token 或 url",
      httpStatus: 200,
      endpoint: "/open-apis/sheets/v3/spreadsheets",
      tokenContext: "spreadsheet:create",
    });
  }
  return { spreadsheetToken, url, title: data.spreadsheet?.title ?? title };
}

/** 查询电子表格下的所有 sheet（创建后默认至少有一个）。 */
async function queryFeishuSheets(input: {
  spreadsheetToken: string;
  fetcher?: FetchLike;
}): Promise<Array<{ sheetId: string; title: string; index: number }>> {
  const data = await sheetOpenApi<{
    sheets?: Array<{ sheet_id?: string; title?: string; index?: number; sheet_name?: string }>;
  }>(
    `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/sheets/query`,
    {},
    input.fetcher,
    `spreadsheet:${maskToken(input.spreadsheetToken)}`,
  );
  return (data.sheets ?? []).flatMap((sheet) =>
    sheet.sheet_id
      ? [{ sheetId: sheet.sheet_id, title: sheet.title || sheet.sheet_name || sheet.sheet_id, index: sheet.index ?? 0 }]
      : [],
  );
}

interface PreparedSheet {
  specIndex: number;
  sheetId: string;
}

/**
 * 准备目标 sheets：把第一个默认 sheet 重命名为第一个数据 sheet，其余通过 addSheet
 * 新增。多余默认 sheet 不自动删除（列为开放问题）。
 */
async function prepareFeishuSheets(input: {
  spreadsheetToken: string;
  sheetNames: string[];
  fetcher?: FetchLike;
}): Promise<PreparedSheet[]> {
  const existing = await queryFeishuSheets(input);
  if (!existing.length) {
    throw new FeishuApiError({
      reason: "飞书新表未返回任何工作表，无法写入",
      httpStatus: 200,
      endpoint: "/open-apis/sheets/v3/spreadsheets/<redacted>/sheets/query",
      tokenContext: `spreadsheet:${maskToken(input.spreadsheetToken)}`,
    });
  }
  const prepared: PreparedSheet[] = [];
  const addRequests: object[] = [];
  // 第一个数据 sheet 复用第一个默认 sheet（rename）。
  const defaultSheet = existing[0]!;
  prepared.push({ specIndex: 0, sheetId: defaultSheet.sheetId });
  addRequests.push({
    updateSheet: { properties: { sheetId: defaultSheet.sheetId, title: input.sheetNames[0] ?? "Sheet1" } },
  });
  // 其余数据 sheet 走 addSheet。
  const addTitles = input.sheetNames.slice(1);
  const replyIndexes: number[] = [];
  addTitles.forEach((_, idx) => {
    addRequests.push({ addSheet: { properties: { title: addTitles[idx], index: idx + 1 } } });
    replyIndexes.push(addRequests.length - 1);
  });
  if (addRequests.length) {
    const data = await sheetOpenApi<{ replies?: Array<Record<string, unknown>> }>(
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/sheets/batch_update`,
      { method: "POST", body: JSON.stringify({ requests: addRequests }) },
      input.fetcher,
      `spreadsheet:${maskToken(input.spreadsheetToken)}`,
    );
    const replies = data.replies ?? [];
    for (let i = 0; i < replyIndexes.length; i++) {
      const reply = replies[replyIndexes[i]!];
      const addReply = reply?.addReply as { properties?: { sheetId?: string } } | undefined;
      const sheetId = addReply?.properties?.sheetId;
      if (!sheetId) {
        throw new FeishuApiError({
          reason: "飞书 addSheet 未返回 sheetId",
          httpStatus: 200,
          endpoint: "/open-apis/sheets/v2/spreadsheets/<redacted>/sheets/batch_update",
          tokenContext: `spreadsheet:${maskToken(input.spreadsheetToken)}`,
        });
      }
      prepared.push({ specIndex: i + 1, sheetId });
    }
  }
  return prepared;
}

/** 计算分批行数：受单批单元格上限与列数约束。 */
function batchSizeForRows(columnCount: number): number {
  const safeCols = Math.max(1, columnCount);
  return Math.max(1, Math.floor(BATCH_CELL_CAP / safeCols));
}

function cellRange(sheetId: string, firstRow: number, lastRow: number, columnCount: number): string {
  const lastCol = columnLetter(Math.max(1, columnCount));
  return `${sheetId}!A${firstRow}:${lastCol}${lastRow}`;
}

/** 把任意错误规约为脱敏的 FeishuApiErrorInfo（不携带 token）。 */
function toErrorInfo(error: unknown): FeishuApiErrorInfo {
  if (error instanceof FeishuApiError) return error.toErrorInfo();
  return {
    endpoint: "/open-apis/sheets/v2/spreadsheets/<redacted>/values_batch_update",
    httpStatus: 0,
    msg: error instanceof Error ? error.message : String(error),
  };
}

/** 单元格值规整为字符串用于抽样比对（容忍飞书对数字等的格式化差异）。 */
function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * 写入结果回读核对（Issue #125 方向 A 验收要求）。
 *
 * 复用 `readFeishuSheetRange`（GET /values）回读刚写入的范围，校验：
 *  - 非空、行数不少于写入行数（含表头）；
 *  - 抽样：表头首列与末数据行首列与写入值一致。
 *
 * 回读失败或核对不一致只返回 `verified:false` + 证据，**不抛错**，保持「单
 * sheet 失败不中断其余 sheet」的语义。证据中不含 raw token（回读错误经
 * `FeishuApiError.message` 仅含中文 reason/code/msg，endpoint 不进入证据）。
 */
async function verifyWrittenValues(input: {
  spreadsheetToken: string;
  sheetId: string;
  header: WorkspaceSheetSpec["header"];
  rows: WorkspaceSheetSpec["rows"];
  fetcher?: FetchLike;
}): Promise<{ verified: boolean; evidence?: string }> {
  const headerLen = input.header.length;
  const dataRows = input.rows.length;
  const expectedRows = headerLen ? dataRows + 1 : dataRows;
  if (!expectedRows) return { verified: true };
  const columnCount = Math.max(headerLen, ...input.rows.map((row) => row.length), 1);
  const lastCol = columnLetter(columnCount);
  // range 必须是纯 A1 形式（不含 sheetId 前缀）：readFeishuSheetRange 内部会拼接
  // `${sheetId}!${range}`。这里若再带前缀会让生产 GET 变成 `sheetId!sheetId!A1:...`，
  // 飞书返回错误/空 → 回读全部失败。写入路径的 cellRange 是另一套约定（飞书
  // values_batch_update 的 range 字段需要 sheetId 前缀），不要混用。
  const range = `A1:${lastCol}${expectedRows}`;
  let values: unknown[][];
  try {
    const valueRange = await readFeishuSheetRange({
      spreadsheetToken: input.spreadsheetToken,
      sheetId: input.sheetId,
      range,
      fetcher: input.fetcher,
    });
    values = valueRange.values ?? [];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { verified: false, evidence: `回读失败：${msg}` };
  }
  if (!values.length) {
    return { verified: false, evidence: `回读结果为空（期望 ${expectedRows} 行）` };
  }
  if (values.length < expectedRows) {
    return { verified: false, evidence: `回读行数 ${values.length} 少于写入 ${expectedRows}` };
  }
  if (headerLen) {
    const expected = stringifyCell(input.header[0]);
    const actual = stringifyCell(values[0]?.[0]);
    if (expected !== actual) {
      return { verified: false, evidence: `表头 A1 期望「${expected}」实读「${actual}」` };
    }
  }
  if (dataRows) {
    const lastInputRow = input.rows[dataRows - 1] ?? [];
    const expected = stringifyCell(lastInputRow[0]);
    const lastIndex = headerLen ? expectedRows - 1 : expectedRows - 1;
    const actual = stringifyCell(values[lastIndex]?.[0]);
    if (expected !== actual) {
      return { verified: false, evidence: `末行 A${lastIndex + 1} 期望「${expected}」实读「${actual}」` };
    }
  }
  return { verified: true };
}

/**
 * 把单个数据 sheet 的 [header, ...rows] 分批写入飞书，并在全部批次成功后回读
 * 核对。返回写入的行数（不含表头）、可能的 FeishuApiErrorInfo（写入失败时）与
 * 回读核对结论（写入成功时）。
 */
async function writeSheetValues(input: {
  spreadsheetToken: string;
  sheetId: string;
  header: WorkspaceSheetSpec["header"];
  rows: WorkspaceSheetSpec["rows"];
  fetcher?: FetchLike;
}): Promise<{ rowsWritten: number; error?: FeishuApiErrorInfo; verified?: boolean; verifyEvidence?: string }> {
  const header = input.header;
  const rows = input.rows;
  const valuesEndpoint = `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values_batch_update`;
  const tokenContext = `spreadsheet:${maskToken(input.spreadsheetToken)}`;
  const writeBatch = async (range: string, values: unknown[][]) =>
    sheetOpenApi(
      valuesEndpoint,
      { method: "POST", body: JSON.stringify({ valueRanges: [{ range, values }] }) },
      input.fetcher,
      tokenContext,
    );

  if (!rows.length) {
    if (!header.length) return { rowsWritten: 0 };
    // 即便没有数据行，仍写入表头，便于空 sheet 可识别。
    try {
      await writeBatch(cellRange(input.sheetId, 1, Math.max(1, header.length), header.length), [header]);
    } catch (error) {
      return { rowsWritten: 0, error: toErrorInfo(error) };
    }
    const verify = await verifyWrittenValues({
      spreadsheetToken: input.spreadsheetToken,
      sheetId: input.sheetId,
      header,
      rows,
      fetcher: input.fetcher,
    });
    return { rowsWritten: 0, verified: verify.verified, verifyEvidence: verify.evidence };
  }
  const columnCount = Math.max(header.length, ...rows.map((row) => row.length));
  const batchRows = batchSizeForRows(columnCount);
  for (let start = 0; start < rows.length; start += batchRows) {
    const batch = rows.slice(start, start + batchRows);
    const firstRow = start + 2; // 第1行为 header，数据从第2行开始
    const lastRow = firstRow + batch.length - 1;
    const values = start === 0 ? [header, ...batch] : batch;
    const rangeFirstRow = start === 0 ? 1 : firstRow;
    try {
      await writeBatch(cellRange(input.sheetId, rangeFirstRow, lastRow, columnCount), values);
    } catch (error) {
      return { rowsWritten: start, error: toErrorInfo(error) };
    }
  }
  // 全部批次写入成功：回读核对（验收要求）。核对失败不阻断、不计入 failedCount。
  const verify = await verifyWrittenValues({
    spreadsheetToken: input.spreadsheetToken,
    sheetId: input.sheetId,
    header,
    rows,
    fetcher: input.fetcher,
  });
  return { rowsWritten: rows.length, verified: verify.verified, verifyEvidence: verify.evidence };
}

/**
 * 默认电子表格标题（确定性，不含时钟）：仅依赖工作区 revision 与 schemaVersion。
 */
function defaultSpreadsheetTitle(input: { state: WorkspaceState; revision: number }): string {
  return `Tackle Forger 工作区导出 r${input.revision}`.slice(0, SPREADSHEET_TITLE_CAP);
}

/**
 * 高层入口：构造与 Excel 导出同构的多 sheet 数据 → 创建新电子表格 → 操作 sheets
 * → 分批写入 cells → 返回 manifest（含 url、各 sheet 写入状态、开放决策回显）。
 *
 * 任一 sheet 写入失败不中断其余 sheet；失败明细汇总在 manifest.sheetResults 与
 * failedCount 中，供前端展示与人工跟进。创建电子表格或准备 sheets 魏失败会直接
 * 抛 FeishuApiError（此时无新表可返回，路由层应返回 502 + errorInfo）。
 */
export async function exportWorkspaceToFeishuSheet(input: {
  state: WorkspaceState;
  revision: number;
  folderToken?: string;
  fetcher?: FetchLike;
  /** 测试/调用方可覆盖默认标题；生产路径用基于 revision 的确定性标题。 */
  title?: string;
}): Promise<FeishuSheetExportManifest> {
  const specs = buildWorkspaceSheetSpecs({ state: input.state, revision: input.revision });
  const title = (input.title ?? defaultSpreadsheetTitle(input)).slice(0, SPREADSHEET_TITLE_CAP) || "Tackle Forger 导出";
  const folderToken = input.folderToken?.trim() ?? "";

  const created = await createFeishuSpreadsheet({ name: title, folderToken: folderToken || undefined, fetcher: input.fetcher });
  const sheetNames = specs.map((spec) => sanitizeSheetName(spec.name));
  const prepared = await prepareFeishuSheets({
    spreadsheetToken: created.spreadsheetToken,
    sheetNames,
    fetcher: input.fetcher,
  });

  const sheetResults: FeishuSheetExportSheetResult[] = [];
  let totalRowsWritten = 0;
  let failedCount = 0;
  for (const item of prepared) {
    const spec = specs[item.specIndex];
    if (!spec) continue;
    if (!spec.rows.length && !spec.header.length) {
      sheetResults.push({ name: spec.name, sheetId: item.sheetId, rowsWritten: 0, result: "skipped_empty" });
      continue;
    }
    const outcome = await writeSheetValues({
      spreadsheetToken: created.spreadsheetToken,
      sheetId: item.sheetId,
      header: spec.header,
      rows: spec.rows,
      fetcher: input.fetcher,
    });
    totalRowsWritten += outcome.rowsWritten;
    if (outcome.error) {
      failedCount += 1;
      sheetResults.push({ name: spec.name, sheetId: item.sheetId, rowsWritten: outcome.rowsWritten, result: "failed", error: outcome.error });
    } else {
      sheetResults.push({
        name: spec.name,
        sheetId: item.sheetId,
        rowsWritten: outcome.rowsWritten,
        result: "written",
        verified: outcome.verified,
        verifyEvidence: outcome.verifyEvidence,
      });
    }
  }

  return {
    url: created.url,
    title: created.title,
    folderTokenMasked: folderToken ? maskToken(folderToken) : "（应用根目录）",
    sheetResults,
    totalRowsWritten,
    failedCount,
    defaults: {
      folderToken: folderToken ? maskToken(folderToken) : "",
      sheetNameSource: "复用 Excel 导出同构的中文 sheet 名（buildWorkspaceSheetSpecs）",
      overwritePolicy: "始终创建新表，不覆盖/不删除既有电子表格",
      batchCellCap: BATCH_CELL_CAP,
    },
    openQuestions: [
      "目标文件夹 token：默认创建到应用根目录，是否应固定到指定团队文件夹？",
      "新表默认会包含飞书自动创建的空工作表（未自动删除），是否需要自动清理？",
      "sheet 命名与顺序：是否需要对齐飞书源表命名（01_/02_…）而非工作区语义名？",
      "部分 sheet 写入失败后是否需要重试/回滚策略（当前保留已写入部分并报告）？",
      "回读核对仅在写入成功后抽样校验非空/行数/首末列；是否需要全量逐单元格核对？",
    ],
  };
}
