import { prepareDataSourcePreview, type FeishuRecord } from "./data-sources";
import {
  parseFeishuSourceLink,
  type FeishuTableOption,
  type FeishuViewOption,
  type ResolvedFeishuSource,
} from "./feishu-links";
import { FeishuApiError, feishuEndpointPath, maskToken } from "./feishu-api-error";
import type { DataSourceProfile, DataSourceWritebackRow, WorkspaceState } from "./types";

interface FeishuResponse<T> {
  code: number;
  msg: string;
  data?: T;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

export function feishuApiBase() {
  return (process.env.FEISHU_OPEN_API_BASE_URL || "https://open.feishu.cn").replace(/\/$/, "");
}

export async function feishuTenantAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error(
      "尚未配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。请在部署环境中配置后重试。",
    );
  }
  const response = await fetch(feishuApiBase() + "/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    cache: "no-store",
  });
  const payload = (await response.json()) as FeishuResponse<never> & {
    tenant_access_token?: string;
    expire?: number;
  };
  if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
    throw new FeishuApiError({
      reason: "飞书身份认证失败",
      code: payload.code,
      msg: payload.msg,
      httpStatus: response.status,
      endpoint: feishuEndpointPath("/open-apis/auth/v3/tenant_access_token/internal"),
    });
  }
  cachedToken = {
    value: payload.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, payload.expire ?? 7200) * 1000,
  };
  return cachedToken.value;
}


export async function resolveFeishuSourceLink(
  shareUrl: string,
  selectedTableId = "",
): Promise<ResolvedFeishuSource> {
  const parsed = parseFeishuSourceLink(shareUrl);
  const token = await feishuTenantAccessToken();
  const headers = {
    authorization: "Bearer " + token,
    "content-type": "application/json; charset=utf-8",
  };
  const tables: FeishuTableOption[] = [];
  let pageToken = "";

  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (pageToken) query.set("page_token", pageToken);
    const tablesUrl =
      feishuApiBase() +
      "/open-apis/bitable/v1/apps/" +
      encodeURIComponent(parsed.appToken) +
      "/tables?" +
      query;
    const response = await fetch(tablesUrl, { headers, cache: "no-store" });
    const payload = (await response.json()) as FeishuResponse<{
      items?: Array<{ table_id?: string; name?: string }>;
      has_more?: boolean;
      page_token?: string;
    }>;
    if (!response.ok || payload.code !== 0) {
      throw new FeishuApiError({
        reason: "读取飞书数据表列表失败",
        code: payload.code,
        msg: payload.msg,
        httpStatus: response.status,
        endpoint: feishuEndpointPath(tablesUrl),
        tokenContext: `bitable app:${maskToken(parsed.appToken)}`,
      });
    }
    for (const item of payload.data?.items ?? []) {
      if (item.table_id) tables.push({ id: item.table_id, name: item.name || item.table_id });
    }
    pageToken = payload.data?.has_more ? payload.data.page_token ?? "" : "";
  } while (pageToken);

  const tableId =
    selectedTableId.trim() || parsed.tableId.trim() || (tables.length === 1 ? tables[0].id : "");
  if (tableId && !tables.some((table) => table.id === tableId)) {
    throw new Error("链接中的数据表已不存在，或当前飞书应用没有访问权限。");
  }

  const views: FeishuViewOption[] = [];
  if (tableId) {
    let viewPageToken = "";
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (viewPageToken) query.set("page_token", viewPageToken);
      const viewsUrl =
        feishuApiBase() +
        "/open-apis/bitable/v1/apps/" +
        encodeURIComponent(parsed.appToken) +
        "/tables/" +
        encodeURIComponent(tableId) +
        "/views?" +
        query;
      const response = await fetch(viewsUrl, { headers, cache: "no-store" });
      const payload = (await response.json()) as FeishuResponse<{
        items?: Array<{ view_id?: string; view_name?: string; view_type?: string }>;
        has_more?: boolean;
        page_token?: string;
      }>;
      if (!response.ok || payload.code !== 0) {
        throw new FeishuApiError({
          reason: "读取飞书视图列表失败",
          code: payload.code,
          msg: payload.msg,
          httpStatus: response.status,
          endpoint: feishuEndpointPath(viewsUrl),
          tokenContext: `bitable app:${maskToken(parsed.appToken)}`,
        });
      }
      for (const item of payload.data?.items ?? []) {
        if (item.view_id) {
          views.push({
            id: item.view_id,
            name: item.view_name || item.view_id,
            type: item.view_type || "",
          });
        }
      }
      viewPageToken = payload.data?.has_more ? payload.data.page_token ?? "" : "";
    } while (viewPageToken);
  }

  const sameTableAsLink = !selectedTableId || selectedTableId === parsed.tableId;
  const viewId = sameTableAsLink ? parsed.viewId : "";
  if (viewId && !views.some((view) => view.id === viewId)) {
    throw new Error("链接中的视图已不存在，或不属于当前数据表。");
  }

  return {
    appToken: parsed.appToken,
    tableId,
    viewId,
    tables,
    views,
  };
}
export async function fetchFeishuRecords(source: DataSourceProfile): Promise<FeishuRecord[]> {
  if (!source.enabled) throw new Error("该数据源已停用。启用后才能拉取。");
  if (!source.appToken.trim() || !source.tableId.trim()) {
    throw new Error("请先填写飞书 app_token 和 table_id。");
  }
  const token = await feishuTenantAccessToken();
  const records: FeishuRecord[] = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({
      page_size: "500",
      text_field_as_array: "false",
    });
    if (source.viewId.trim()) query.set("view_id", source.viewId.trim());
    if (pageToken) query.set("page_token", pageToken);
    const url =
      feishuApiBase() +
      "/open-apis/bitable/v1/apps/" +
      encodeURIComponent(source.appToken.trim()) +
      "/tables/" +
      encodeURIComponent(source.tableId.trim()) +
      "/records?" +
      query;
    const response = await fetch(url, {
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json; charset=utf-8",
      },
      cache: "no-store",
    });
    const payload = (await response.json()) as FeishuResponse<{
      items?: FeishuRecord[];
      has_more?: boolean;
      page_token?: string;
    }>;
    if (!response.ok || payload.code !== 0) {
      throw new FeishuApiError({
        reason: "读取飞书表失败",
        code: payload.code,
        msg: payload.msg,
        httpStatus: response.status,
        endpoint: feishuEndpointPath(url),
        tokenContext: `bitable app:${maskToken(source.appToken)}`,
      });
    }
    records.push(...(payload.data?.items ?? []));
    if (records.length > 10_000) {
      throw new Error("源表超过 10000 行，已停止拉取以避免误发布。");
    }
    pageToken = payload.data?.has_more ? payload.data.page_token ?? "" : "";
  } while (pageToken);
  return records;
}

export async function updateFeishuRecords(
  source: DataSourceProfile,
  rows: DataSourceWritebackRow[],
) {
  if (!rows.length) return;
  const token = await feishuTenantAccessToken();
  for (let index = 0; index < rows.length; index += 500) {
    const batch = rows.slice(index, index + 500);
    const url =
      feishuApiBase() +
      "/open-apis/bitable/v1/apps/" +
      encodeURIComponent(source.appToken.trim()) +
      "/tables/" +
      encodeURIComponent(source.tableId.trim()) +
      "/records/batch_update";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        records: batch.map((row) => ({ record_id: row.recordId, fields: row.fields })),
      }),
      cache: "no-store",
    });
    const payload = (await response.json()) as FeishuResponse<unknown>;
    if (!response.ok || payload.code !== 0) {
      throw new FeishuApiError({
        reason: "回写飞书表失败",
        code: payload.code,
        msg: payload.msg,
        httpStatus: response.status,
        endpoint: feishuEndpointPath(url),
        tokenContext: `bitable app:${maskToken(source.appToken)}`,
      });
    }
  }
}

/**
 * 判断既有记录的待写字段是否已全部等于目标值。用于回写的幂等对账：
 * 写前命中表示上次写入已落地（跳过重复写）；写后命中表示写入已核实。
 */
export function feishuWritebackFieldsMatch(
  existing: Record<string, unknown> | undefined,
  fields: Record<string, unknown>,
): boolean {
  if (!existing) return false;
  for (const [key, value] of Object.entries(fields)) {
    if (JSON.stringify(existing[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

async function readFeishuRecordsByIdMap(
  source: DataSourceProfile,
  recordIds: string[],
): Promise<Map<string, FeishuRecord>> {
  const wanted = new Set(recordIds);
  const map = new Map<string, FeishuRecord>();
  for (const record of await fetchFeishuRecords(source)) {
    if (wanted.has(record.record_id)) map.set(record.record_id, record);
  }
  return map;
}

export interface FeishuWritebackEvidence {
  recordId: string;
  matched: boolean;
}

export interface FeishuWritebackResult {
  /** written=本次写入并核实；alreadyApplied=写前回读已全部命中，跳过；recovered=写入抛错但回读确认已落地；failed=抛错且回读未全部命中。 */
  result: "written" | "alreadyApplied" | "recovered" | "failed";
  evidence: FeishuWritebackEvidence[];
  error?: string;
}

/**
 * 幂等且可恢复的飞书数据源回写（规范 §14 / §24.9）：
 * 1. 写前回读——若所有待写字段均已为目标值，视为上次写入已落地，跳过重复写；
 * 2. 执行 batch_update；
 * 3. 写后回读校验；
 * 4. 写入抛错时回读对账，按记录判定已落地/未落地，返回逐条证据，支持安全重试。
 * records/batch_update 按 record_id 覆盖字段（非追加），叠加回读对账后重试不会重复写入。
 */
export async function commitFeishuWriteback(
  source: DataSourceProfile,
  rows: DataSourceWritebackRow[],
): Promise<FeishuWritebackResult> {
  if (!rows.length) return { result: "alreadyApplied", evidence: [] };
  const evidenceFor = (records: Map<string, FeishuRecord>): FeishuWritebackEvidence[] =>
    rows.map((row) => ({ recordId: row.recordId, matched: feishuWritebackFieldsMatch(records.get(row.recordId)?.fields, row.fields) }));

  const preRead = await readFeishuRecordsByIdMap(source, rows.map((row) => row.recordId));
  if (rows.every((row) => feishuWritebackFieldsMatch(preRead.get(row.recordId)?.fields, row.fields))) {
    return { result: "alreadyApplied", evidence: evidenceFor(preRead) };
  }

  try {
    await updateFeishuRecords(source, rows);
  } catch (error) {
    const readback = await readFeishuRecordsByIdMap(source, rows.map((row) => row.recordId)).catch(
      () => new Map<string, FeishuRecord>(),
    );
    const evidence = evidenceFor(readback);
    const allMatched = evidence.length > 0 && evidence.every((item) => item.matched);
    return {
      result: allMatched ? "recovered" : "failed",
      evidence,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const verify = await readFeishuRecordsByIdMap(source, rows.map((row) => row.recordId));
  return { result: "written", evidence: evidenceFor(verify) };
}

export async function pullDataSourcePreview(
  source: DataSourceProfile,
  state: WorkspaceState,
) {
  return prepareDataSourcePreview(source, await fetchFeishuRecords(source), state);
}
