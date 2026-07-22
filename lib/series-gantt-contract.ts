import type { ActionAvailability } from "./interaction-contracts";
import type { QueriedGanttSeriesBlock } from "./series-gantt-query";
import type { PurchasableModel, SeriesDefinition, SkuDrawer } from "./types";

export interface SeriesGanttQuery {
  text?: string;
  collectionIds?: string[];
  methodIds?: string[];
  typeIds?: string[];
  qualityIds?: string[];
  functionIds?: string[];
  itemPartIds?: string[];
  lifecycle?: SeriesDefinition["status"][];
  lifecycleStates?: Array<"ACTIVE" | "DEPRECATED" | "ARCHIVED">;
  attention?: Array<"HAS_UPGRADE_CANDIDATE" | "REBASE_REQUIRED" | "SOURCE_STALE" | "IMPORT_CONFLICT" | "EXPORT_RELATION_BROKEN">;
  attentionStates?: Array<"HAS_UPGRADE_CANDIDATE" | "REBASE_REQUIRED" | "SOURCE_STALE" | "IMPORT_CONFLICT" | "EXPORT_RELATION_BROKEN">;
  issueCodes?: string[];
  issueSeverities?: Array<"INFO" | "WARNING" | "ERROR" | "BLOCKER">;
  hasUpgradeCandidate?: boolean;
  exactTargetWeightKg?: number[];
  minTargetPullKg?: number;
  maxTargetPullKg?: number;
  ruleSetVersions?: string[];
  ruleSetVersion?: string;
  sort?: "name" | "quality_type" | "updated_desc" | "series_name" | "weight_span" | "attention" | "recently_changed";
  cursor?: string;
  pageSize?: number;
}

export interface SeriesGanttFacets {
  weights: number[];
  typeIds: string[];
  issueCodes: string[];
  ruleSetVersions: string[];
}

interface SeriesGanttPageMetadata {
  nextCursor?: string;
  totalVisible: number;
  pageSize: number;
}

export interface SeriesGanttListResponse {
  revision: number;
  query: SeriesGanttQuery;
  blocks: QueriedGanttSeriesBlock[];
  anchorBlock?: QueriedGanttSeriesBlock;
  page: SeriesGanttPageMetadata;
  facets: SeriesGanttFacets;
  actions: ActionAvailability[];
}

export interface SeriesGanttSkuResponse {
  revision: number;
  seriesId: string;
  skus: SkuDrawer[];
  page: SeriesGanttPageMetadata;
}

export interface SeriesGanttModelResponse {
  revision: number;
  skuId: string;
  models: PurchasableModel[];
  page: SeriesGanttPageMetadata;
}

const ARRAY_KEYS: Array<keyof SeriesGanttQuery> = [
  "collectionIds",
  "methodIds",
  "typeIds",
  "qualityIds",
  "functionIds",
  "itemPartIds",
  "lifecycle",
  "lifecycleStates",
  "attention",
  "attentionStates",
  "issueCodes",
  "issueSeverities",
  "exactTargetWeightKg",
  "ruleSetVersions",
];

export function seriesGanttQueryToSearchParams(query: SeriesGanttQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.text?.trim()) params.set("q", query.text.trim());
  for (const key of ARRAY_KEYS) {
    const values = query[key] as unknown[] | undefined;
    values?.forEach((value) => params.append(String(key), String(value)));
  }
  if (query.hasUpgradeCandidate !== undefined) {
    params.set("hasUpgradeCandidate", query.hasUpgradeCandidate ? "1" : "0");
  }
  if (query.minTargetPullKg !== undefined) params.set("minTargetPullKg", String(query.minTargetPullKg));
  if (query.maxTargetPullKg !== undefined) params.set("maxTargetPullKg", String(query.maxTargetPullKg));
  if (query.ruleSetVersion) params.set("ruleSetVersion", query.ruleSetVersion);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  if (query.sort) params.set("sort", query.sort);
  return params;
}

export function seriesGanttQueryFromSearchParams(params: URLSearchParams): SeriesGanttQuery {
  const query: SeriesGanttQuery = {};
  const text = params.get("q");
  if (text) query.text = text;
  for (const key of ARRAY_KEYS) {
    const values = params.getAll(String(key));
    if (!values.length) continue;
    if (key === "exactTargetWeightKg") {
      query.exactTargetWeightKg = values
        .map(Number)
        .filter((value) => Number.isFinite(value));
    } else {
      (query as Record<string, unknown>)[key] = [...new Set(values)];
    }
  }
  const upgrade = params.get("hasUpgradeCandidate");
  if (upgrade === "1" || upgrade === "0") query.hasUpgradeCandidate = upgrade === "1";
  const sort = params.get("sort");
  if (sort === "name" || sort === "quality_type" || sort === "updated_desc" || sort === "series_name" || sort === "weight_span" || sort === "attention" || sort === "recently_changed") {
    query.sort = sort;
  }
  for (const key of ["minTargetPullKg", "maxTargetPullKg"] as const) {
    const raw = params.get(key);
    if (raw === null || raw.trim() === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) query[key] = value;
  }
  query.ruleSetVersion = params.get("ruleSetVersion") || undefined;
  query.cursor = params.get("cursor") || undefined;
  const pageSize = Number(params.get("pageSize"));
  if (Number.isSafeInteger(pageSize) && pageSize > 0) query.pageSize = Math.min(pageSize, 100);
  return query;
}

export class SeriesGanttRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function responsePayload<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as (T & { error?: string; code?: string }) | null;
  if (!response.ok || !payload) {
    throw new SeriesGanttRequestError(
      payload?.error ?? "钓具系列甘特图加载失败。",
      response.status,
      payload?.code,
    );
  }
  return payload;
}

export async function fetchSeriesGanttList(input: {
  query: SeriesGanttQuery;
  cursor?: string;
  anchorSeriesId?: string;
  signal?: AbortSignal;
  fetcher?: Fetcher;
}): Promise<{ payload: SeriesGanttListResponse; recoveredFromStaleCursor: boolean }> {
  const fetcher = input.fetcher ?? fetch;
  const params = seriesGanttQueryToSearchParams({ ...input.query, cursor: input.cursor });
  params.set("view", "series");
  if (input.anchorSeriesId) params.set("anchorSeriesId", input.anchorSeriesId);
  const request = () => fetcher(`/api/series-gantt?${params.toString()}`, { signal: input.signal });
  let response = await request();
  let recoveredFromStaleCursor = false;
  if (response.status === 409 && input.cursor) {
    const conflict = await response.clone().json().catch(() => null) as { code?: string } | null;
    if (conflict?.code === "SERIES_GANTT_CURSOR_STALE") {
      params.delete("cursor");
      response = await request();
      recoveredFromStaleCursor = true;
    }
  }
  return { payload: await responsePayload<SeriesGanttListResponse>(response), recoveredFromStaleCursor };
}

export async function fetchSeriesGanttSkus(input: {
  seriesId: string;
  cursor?: string;
  pageSize?: number;
  signal?: AbortSignal;
  fetcher?: Fetcher;
}): Promise<{ payload: SeriesGanttSkuResponse; recoveredFromStaleCursor: boolean }> {
  const fetcher = input.fetcher ?? fetch;
  const params = new URLSearchParams({ view: "skus", seriesId: input.seriesId, pageSize: String(input.pageSize ?? 50) });
  if (input.cursor) params.set("cursor", input.cursor);
  const request = () => fetcher(`/api/series-gantt?${params.toString()}`, { signal: input.signal });
  let response = await request();
  let recoveredFromStaleCursor = false;
  if (response.status === 409 && input.cursor) {
    const conflict = await response.clone().json().catch(() => null) as { code?: string } | null;
    if (conflict?.code === "SERIES_GANTT_CURSOR_STALE") {
      params.delete("cursor");
      response = await request();
      recoveredFromStaleCursor = true;
    }
  }
  return { payload: await responsePayload<SeriesGanttSkuResponse>(response), recoveredFromStaleCursor };
}

export async function fetchSeriesGanttModels(input: {
  skuId: string;
  cursor?: string;
  pageSize?: number;
  signal?: AbortSignal;
  fetcher?: Fetcher;
}): Promise<{ payload: SeriesGanttModelResponse; recoveredFromStaleCursor: boolean }> {
  const fetcher = input.fetcher ?? fetch;
  const params = new URLSearchParams({ view: "models", skuId: input.skuId, pageSize: String(input.pageSize ?? 12) });
  if (input.cursor) params.set("cursor", input.cursor);
  const request = () => fetcher(`/api/series-gantt?${params.toString()}`, { signal: input.signal });
  let response = await request();
  let recoveredFromStaleCursor = false;
  if (response.status === 409 && input.cursor) {
    const conflict = await response.clone().json().catch(() => null) as { code?: string } | null;
    if (conflict?.code === "SERIES_GANTT_CURSOR_STALE") {
      params.delete("cursor");
      response = await request();
      recoveredFromStaleCursor = true;
    }
  }
  return { payload: await responsePayload<SeriesGanttModelResponse>(response), recoveredFromStaleCursor };
}
