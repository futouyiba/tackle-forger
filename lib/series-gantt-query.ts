import {
  buildSeriesGanttProjection,
  legacyEntityState,
  type AttentionState,
  type GanttSeriesBlock,
  type LifecycleState,
  type PrimaryDisplayState,
  type PublicationState,
  type RevisionState,
  type ValidationState,
} from "./interaction-contracts";
import type {
  ItemTypeProfile,
  PurchasableModel,
  SeriesDefinition,
  SkuDrawer,
  UpgradeCandidate,
  ValidationIssue,
} from "./types";
import { deterministicHash } from "./rule-kernel";
import { isActiveValidationIssue, validationIssueLevel, validationIssueSeverity } from "./validation-issues";
import {
  isProductItemPartEnabled,
  seriesItemPartId,
} from "./enabled-item-parts";

export interface SeriesGanttQuery {
  text?: string;
  collectionIds?: string[];
  methodIds?: string[];
  typeIds?: string[];
  qualityIds?: string[];
  functionIds?: string[];
  itemPartIds?: string[];
  lifecycle?: SeriesDefinition["status"][];
  lifecycleStates?: LifecycleState[];
  attention?: AttentionState[];
  attentionStates?: AttentionState[];
  issueCodes?: string[];
  issueSeverities?: Array<"INFO" | "WARNING" | "ERROR" | "BLOCKER">;
  hasUpgradeCandidate?: boolean;
  exactTargetPullKg?: number[];
  minTargetPullKg?: number;
  maxTargetPullKg?: number;
  ruleSetVersions?: string[];
  ruleSetVersion?: string;
  sort?: "name" | "quality_type" | "updated_desc" | "series_name" | "weight_span" | "attention" | "recently_changed";
  cursor?: string;
  pageSize?: number;
}

export interface SeriesGanttAggregate {
  lifecycle: LifecycleState;
  revisionState: RevisionState;
  validationState: ValidationState;
  publicationState: PublicationState;
  attention: AttentionState[];
  primary: PrimaryDisplayState;
  skuCount: number;
  modelCountTotal: number;
  modelCountMatched: number;
  descendantStateCounts: Record<string, number>;
  hardBlockingCount: number;
  warningCount: number;
  pendingUpgradeCount: number;
  issueCodes: string[];
  ruleSetVersions: string[];
  hasMoreChildren: boolean;
  readOnly: boolean;
  unknownStateCodes: string[];
}

export interface QueriedGanttSeriesBlock extends GanttSeriesBlock {
  revision: number;
  aggregate: SeriesGanttAggregate;
}

function attentionFor(
  issues: ValidationIssue[],
  pendingUpgradeCount: number,
): AttentionState[] {
  const result: AttentionState[] = [];
  if (issues.some((issue) => /REBASE/i.test(issue.code))) result.push("REBASE_REQUIRED");
  if (issues.some((issue) => /SOURCE.*STALE/i.test(issue.code))) result.push("SOURCE_STALE");
  if (issues.some((issue) => /IMPORT.*CONFLICT/i.test(issue.code))) result.push("IMPORT_CONFLICT");
  if (issues.some((issue) => /EXPORT.*RELATION/i.test(issue.code))) result.push("EXPORT_RELATION_BROKEN");
  if (pendingUpgradeCount > 0) result.push("HAS_UPGRADE_CANDIDATE");
  return result;
}

function intersects<T>(filter: T[] | undefined, values: Iterable<T>): boolean {
  if (!filter?.length) return true;
  const candidates = new Set(values);
  return filter.some((entry) => candidates.has(entry));
}

function matchesBoolean(filter: boolean | undefined, value: boolean): boolean {
  return filter === undefined || filter === value;
}

function issueSeverity(issue: ValidationIssue): "INFO" | "WARNING" | "ERROR" | "BLOCKER" {
  return validationIssueSeverity(issue);
}

function collectSeriesContext(input: {
  series: SeriesDefinition;
  skus: SkuDrawer[];
  models: PurchasableModel[];
  upgrades: UpgradeCandidate[];
}) {
  const skus = input.skus.filter(
    (sku) =>
      sku.seriesId === input.series.id && sku.status !== "superseded",
  );
  const modelIds = new Set(skus.flatMap((sku) => sku.modelIds));
  const models = input.models.filter((model) => modelIds.has(model.id));
  const issues = skus.flatMap((sku) => sku.validationSummary);
  const pendingUpgrades = input.upgrades.filter((upgrade) =>
    modelIds.has(upgrade.modelId) && upgrade.status === "pending");
  const attention = attentionFor(issues, pendingUpgrades.length);
  const state = legacyEntityState({ status: input.series.status, issues, attention });
  const descendantStateCounts = models.reduce<Record<string, number>>((counts, model) => {
    const modelState = legacyEntityState({
      status: model.status,
      hasPublishedSnapshot: Boolean(model.configurationSnapshotId),
    });
    for (const code of [modelState.lifecycle, modelState.revision, modelState.validation, modelState.publication, modelState.primary, ...modelState.attention]) {
      counts[code] = (counts[code] ?? 0) + 1;
    }
    return counts;
  }, {});
  return {
    skus,
    models,
    issues,
    pendingUpgrades,
    state,
    descendantStateCounts,
    ruleSetVersions: [...new Set(skus.map((sku) => sku.projectionMatch.ruleSetVersion))].sort(),
  };
}

function searchableText(values: Array<string | number | undefined>): string {
  return values.filter((value) => value !== undefined).join(" ").toLocaleLowerCase("zh-CN");
}

function matchesSkuQuery(sku: SkuDrawer, query: SeriesGanttQuery): boolean {
  if (!intersects(query.exactTargetPullKg, [sku.targetPullKg])) return false;
  if (query.minTargetPullKg !== undefined && sku.targetPullKg < query.minTargetPullKg) return false;
  if (query.maxTargetPullKg !== undefined && sku.targetPullKg > query.maxTargetPullKg) return false;
  if (!intersects(query.issueCodes, sku.validationSummary.map((issue) => issue.code))) return false;
  if (!intersects(query.issueSeverities, sku.validationSummary.map(issueSeverity))) return false;
  return true;
}

function matchingModelsForQuery(input: {
  query: SeriesGanttQuery;
  series: SeriesDefinition;
  skus: SkuDrawer[];
  models: PurchasableModel[];
  upgrades: UpgradeCandidate[];
}): { models: PurchasableModel[]; textMatches: boolean; matchingSkus: SkuDrawer[] } {
  const matchingSkus = input.skus.filter((sku) => matchesSkuQuery(sku, input.query));
  const matchingSkuIds = new Set(matchingSkus.map((sku) => sku.id));
  const text = input.query.text?.trim().toLocaleLowerCase("zh-CN");
  const seriesTextMatches = !text || searchableText([
    input.series.id,
    input.series.name,
    input.series.concept,
  ]).includes(text);
  const skuTextMatches = new Set(matchingSkus
    .filter((sku) => !text || searchableText([
      sku.id,
      sku.targetPullKg,
      `${sku.targetPullKg}kg`,
      `${sku.targetPullKg}kgf`,
    ]).includes(text))
    .map((sku) => sku.id));
  const pendingUpgradeModelIds = new Set(input.upgrades
    .filter((upgrade) => upgrade.status === "pending")
    .map((upgrade) => upgrade.modelId));
  const models = input.models.filter((model) => {
    if (!matchingSkuIds.has(model.skuId)) return false;
    if (input.query.hasUpgradeCandidate !== undefined
      && pendingUpgradeModelIds.has(model.id) !== input.query.hasUpgradeCandidate) return false;
    if (!text || seriesTextMatches || skuTextMatches.has(model.skuId)) return true;
    return searchableText([model.id, model.name, model.modelVariantKey]).includes(text);
  });
  const textMatches = !text
    || seriesTextMatches
    || skuTextMatches.size > 0
    || models.length > 0;
  return { models, textMatches, matchingSkus };
}

export function querySeriesGantt(input: {
  query: SeriesGanttQuery;
  series: SeriesDefinition[];
  skus: SkuDrawer[];
  models: PurchasableModel[];
  itemTypes: ItemTypeProfile[];
  upgrades: UpgradeCandidate[];
}): QueriedGanttSeriesBlock[] {
  const productSeries = input.series.filter((series) =>
    isProductItemPartEnabled(seriesItemPartId(series, input.skus)));
  const productSkus = input.skus.filter((sku) =>
    isProductItemPartEnabled(sku.projectionMatch.itemPartId)
    && productSeries.some((series) =>
      series.id === sku.seriesId
      && seriesItemPartId(series, input.skus) === sku.projectionMatch.itemPartId));
  const productSkuIds = new Set(productSkus.map((sku) => sku.id));
  const productModels = input.models.filter((model) => productSkuIds.has(model.skuId));
  const productModelIds = new Set(productModels.map((model) => model.id));
  const productUpgrades = input.upgrades.filter((upgrade) => productModelIds.has(upgrade.modelId));
  const projectionById = new Map(
    buildSeriesGanttProjection({
      series: productSeries,
      skus: productSkus,
      models: productModels,
    }).map((block) => [block.seriesId, block]),
  );

  const result = productSeries.flatMap((series): QueriedGanttSeriesBlock[] => {
    const block = projectionById.get(series.id);
    if (!block) return [];
    const context = collectSeriesContext({
      series,
      skus: productSkus,
      models: productModels,
      upgrades: productUpgrades,
    });
    const matched = matchingModelsForQuery({
      query: input.query,
      series,
      skus: context.skus,
      models: context.models,
      upgrades: context.pendingUpgrades,
    });
    const issueCodes = [...new Set(context.issues.map((issue) => issue.code))].sort();
    const typePartIds = [seriesItemPartId(series, input.skus)].filter(
      (itemPartId): itemPartId is string => Boolean(itemPartId),
    );
    if (!matched.textMatches) return [];
    if (!intersects(input.query.collectionIds, series.collectionId ? [series.collectionId] : [])) return [];
    if (!intersects(input.query.methodIds, [series.fishingMethodId])) return [];
    if (!intersects(input.query.typeIds, [series.typeId])) return [];
    if (!intersects(input.query.qualityIds, [series.qualityId])) return [];
    if (!intersects(input.query.functionIds, [series.coreFunctionId])) return [];
    if (!intersects(input.query.itemPartIds, typePartIds)) return [];
    if (!intersects(input.query.lifecycle, [series.status])) return [];
    if (!intersects(input.query.lifecycleStates, [context.state.lifecycle])) return [];
    if (!intersects(input.query.attention ?? input.query.attentionStates, context.state.attention)) return [];
    if ((input.query.issueCodes?.length || input.query.issueSeverities?.length)
      && matched.matchingSkus.length === 0) return [];
    if (!matchesBoolean(input.query.hasUpgradeCandidate, context.pendingUpgrades.length > 0)) return [];
    if ((input.query.exactTargetPullKg?.length
      || input.query.minTargetPullKg !== undefined
      || input.query.maxTargetPullKg !== undefined)
      && matched.matchingSkus.length === 0) return [];
    if (!intersects(input.query.ruleSetVersions, context.ruleSetVersions)) return [];
    if (input.query.ruleSetVersion && !context.ruleSetVersions.includes(input.query.ruleSetVersion)) return [];
    return [{
      ...block,
      revision: series.revision,
      aggregate: {
        lifecycle: context.state.lifecycle,
        revisionState: context.state.revision,
        validationState: context.state.validation,
        publicationState: context.state.publication,
        attention: context.state.attention,
        primary: context.state.primary,
        skuCount: context.skus.length,
        modelCountTotal: context.models.length,
        modelCountMatched: matched.models.length,
        descendantStateCounts: context.descendantStateCounts,
        hardBlockingCount: context.issues.filter((issue) => isActiveValidationIssue(issue) && validationIssueLevel(issue) === "error").length,
        warningCount: context.issues.filter((issue) => isActiveValidationIssue(issue) && validationIssueLevel(issue) === "warning").length,
        pendingUpgradeCount: context.pendingUpgrades.length,
        issueCodes,
        ruleSetVersions: context.ruleSetVersions,
        hasMoreChildren: false,
        readOnly: context.state.readOnly,
        unknownStateCodes: context.state.unknownCodes,
      },
    }];
  });

  const sort = input.query.sort ?? "name";
  return result.sort((left, right) => {
    if (sort === "quality_type") {
      return left.qualityId.localeCompare(right.qualityId) ||
        left.typeId.localeCompare(right.typeId) ||
        left.name.localeCompare(right.name) ||
        left.seriesId.localeCompare(right.seriesId);
    }
    if (sort === "updated_desc" || sort === "recently_changed") {
      const leftSeries = input.series.find((series) => series.id === left.seriesId)!;
      const rightSeries = input.series.find((series) => series.id === right.seriesId)!;
      return rightSeries.updatedAt.localeCompare(leftSeries.updatedAt) ||
        left.seriesId.localeCompare(right.seriesId);
    }
    if (sort === "weight_span") {
      return ((right.maxDisplayWeightKg ?? 0) - (right.minDisplayWeightKg ?? 0)) -
        ((left.maxDisplayWeightKg ?? 0) - (left.minDisplayWeightKg ?? 0)) ||
        left.seriesId.localeCompare(right.seriesId);
    }
    if (sort === "attention") {
      return right.aggregate.hardBlockingCount - left.aggregate.hardBlockingCount ||
        right.aggregate.warningCount - left.aggregate.warningCount ||
        right.aggregate.pendingUpgradeCount - left.aggregate.pendingUpgradeCount ||
        left.seriesId.localeCompare(right.seriesId);
    }
    return left.name.localeCompare(right.name) || left.seriesId.localeCompare(right.seriesId);
  });
}

export interface SeriesGanttPage {
  items: QueriedGanttSeriesBlock[];
  nextCursor?: string;
  totalMatched: number;
  pageSize: number;
}

function cursorHash(query: SeriesGanttQuery): string {
  const stableQuery = { ...query };
  delete stableQuery.cursor;
  return deterministicHash(stableQuery);
}

export function paginateSeriesGantt(input: {
  items: QueriedGanttSeriesBlock[];
  query: SeriesGanttQuery;
  workspaceRevision: number;
}): SeriesGanttPage {
  const pageSize = Math.max(1, Math.min(input.query.pageSize ?? 50, 100));
  const hash = cursorHash(input.query);
  let offset = 0;
  if (input.query.cursor) {
    const match = /^gantt\.([0-9]+)\.([0-9]+)\.([a-z0-9]+)$/i.exec(input.query.cursor);
    if (!match || Number(match[1]) !== input.workspaceRevision || match[3] !== hash) {
      throw new Error("SERIES_GANTT_CURSOR_STALE");
    }
    offset = Number(match[2]);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > input.items.length) {
      throw new Error("SERIES_GANTT_CURSOR_STALE");
    }
  }
  const items = input.items.slice(offset, offset + pageSize);
  const nextOffset = offset + items.length;
  return {
    items,
    totalMatched: input.items.length,
    pageSize,
    ...(nextOffset < input.items.length
      ? { nextCursor: `gantt.${input.workspaceRevision}.${nextOffset}.${hash}` }
      : {}),
  };
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
  "exactTargetPullKg",
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
    if (key === "exactTargetPullKg") {
      query.exactTargetPullKg = values
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
