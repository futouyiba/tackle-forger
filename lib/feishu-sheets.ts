import { feishuApiBase, feishuTenantAccessToken } from "./feishu";
import { FeishuApiError, feishuEndpointPath, maskToken } from "./feishu-api-error";
import type {
  FeishuWorkbookPullAdapter,
  FeishuWorkbookRef,
  RemoteFeishuSheet,
} from "./feishu-workbook";

interface FeishuEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

type FetchLike = typeof fetch;

export interface FeishuValueRange {
  revision: string;
  range: string;
  values: unknown[][];
}

export interface FeishuSheetRangeRequest {
  sheetId: string;
  range: string;
}

async function openApi<T>(
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

export async function resolveWikiSpreadsheetToken(
  ref: FeishuWorkbookRef,
  fetcher: FetchLike = fetch,
) {
  const data = await openApi<{
    node?: { obj_token?: string; obj_type?: string; node_token?: string };
  }>(
    `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(ref.wikiToken)}`,
    {},
    fetcher,
    `wiki:${maskToken(ref.wikiToken)}`,
  );
  if (!data.node?.obj_token || data.node.obj_type !== "sheet") {
    throw new Error("唯一规则链接没有解析到飞书电子表格节点。");
  }
  return data.node.obj_token;
}

export async function readFeishuSheetRange(input: {
  spreadsheetToken: string;
  sheetId: string;
  range: string;
  fetcher?: FetchLike;
}): Promise<FeishuValueRange> {
  const locatedRange = `${input.sheetId}!${input.range}`;
  const data = await openApi<{
    revision?: number;
    valueRange?: { range?: string; revision?: number; values?: unknown[][] };
  }>(
    `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values/${encodeURIComponent(locatedRange)}`,
    {},
    input.fetcher,
    `spreadsheet:${maskToken(input.spreadsheetToken)}`,
  );
  const revision = data.valueRange?.revision ?? data.revision;
  if (!Number.isFinite(revision)) throw new Error("飞书未返回工作簿 revision。");
  return {
    revision: String(revision),
    range: data.valueRange?.range ?? locatedRange,
    values: data.valueRange?.values ?? [],
  };
}

export async function readFeishuWorkbook(input: {
  ref: FeishuWorkbookRef;
  fetcher?: FetchLike;
}): Promise<{ spreadsheetToken: string; sourceRevision: string; sheets: RemoteFeishuSheet[] }> {
  const spreadsheetToken = input.ref.spreadsheetToken
    ?? await resolveWikiSpreadsheetToken(input.ref, input.fetcher);
  const data = await openApi<{
    sheets?: Array<{
      sheet_id?: string;
      title?: string;
      sheet_name?: string;
      grid_properties?: { row_count?: number; column_count?: number };
    }>;
  }>(
    `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/query`,
    {},
    input.fetcher,
    `spreadsheet:${maskToken(spreadsheetToken)}`,
  );
  const sheets: RemoteFeishuSheet[] = (data.sheets ?? []).flatMap((sheet) => {
    if (!sheet.sheet_id) return [];
    return [{
      sheetId: sheet.sheet_id,
      name: sheet.title || sheet.sheet_name || sheet.sheet_id,
      rowCount: sheet.grid_properties?.row_count,
      columnCount: sheet.grid_properties?.column_count,
    }];
  });
  if (!sheets.length) throw new Error("飞书工作簿没有返回任何工作表。");
  const revisionProbe = await readFeishuSheetRange({
    spreadsheetToken,
    sheetId: sheets[0].sheetId,
    range: "A1:A1",
    fetcher: input.fetcher,
  });
  return { spreadsheetToken, sourceRevision: revisionProbe.revision, sheets };
}

export function createFeishuWorkbookPullAdapter(fetcher?: FetchLike): FeishuWorkbookPullAdapter {
  return {
    resolveWorkbook: (ref) => readFeishuWorkbook({ ref, fetcher }),
  };
}

export async function readFeishuSheetRanges(input: {
  spreadsheetToken: string;
  requests: FeishuSheetRangeRequest[];
  fetcher?: FetchLike;
}) {
  return Promise.all(input.requests.map(async (request) => ({
    ...request,
    valueRange: await readFeishuSheetRange({
      spreadsheetToken: input.spreadsheetToken,
      sheetId: request.sheetId,
      range: request.range,
      fetcher: input.fetcher,
    }),
  })));
}

export async function writeFeishuSheetRanges(input: {
  spreadsheetToken: string;
  valueRanges: Array<{ sheetId: string; cell: string; value: string }>;
  fetcher?: FetchLike;
}) {
  if (!input.valueRanges.length) return;
  await openApi<{ revision?: number }>(
    `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values_batch_update`,
    {
      method: "POST",
      body: JSON.stringify({
        valueRanges: input.valueRanges.map((entry) => ({
          range: `${entry.sheetId}!${entry.cell}:${entry.cell}`,
          values: [[entry.value]],
        })),
      }),
    },
    input.fetcher,
    `spreadsheet:${maskToken(input.spreadsheetToken)}`,
  );
}
