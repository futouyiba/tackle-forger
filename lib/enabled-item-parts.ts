import type { ConfigurationSnapshot, SeriesDefinition, SkuDrawer } from "./types";

export const ITEM_PART_NOT_ENABLED_CODE = "ITEM_PART_NOT_ENABLED";
export const ITEM_PART_CHAIN_INCONSISTENT_CODE = "ITEM_PART_CHAIN_INCONSISTENT";

/**
 * OPEN-003 当前没有可校验的已发布 enabledItemPartPolicy。
 * 因此运行时使用权威规范要求的 fail-closed 边界，而不信任注册表中的
 * activeInGeneration（该字段及未知字段必须继续作为历史 Payload 保存）。
 */
export const OPEN_003_FAIL_CLOSED_POLICY = Object.freeze({
  mode: "OPEN_003_FAIL_CLOSED" as const,
  publishedPolicyVersion: null,
  enabledItemPartIds: Object.freeze(["part:rod", "part:reel", "part:line"] as const),
});

const ENABLED_ITEM_PART_IDS: ReadonlySet<string> = new Set(
  OPEN_003_FAIL_CLOSED_POLICY.enabledItemPartIds,
);

export type ProductItemPartAction =
  | "product_ui"
  | "series"
  | "sku"
  | "projection_match"
  | "candidate_generation"
  | "candidate_materialization"
  | "model_publish"
  | "snapshot"
  | "config_export";

const ACTION_LABELS: Record<ProductItemPartAction, string> = {
  product_ui: "产品界面",
  series: "Series 流程",
  sku: "SKU 流程",
  projection_match: "结构标杆匹配",
  candidate_generation: "Model 候选生成",
  candidate_materialization: "Model 候选物化",
  model_publish: "Model 发布",
  snapshot: "ConfigurationSnapshot 流程",
  config_export: "配置导出",
};

export class ItemPartNotEnabledError extends Error {
  readonly code = ITEM_PART_NOT_ENABLED_CODE;
  readonly itemPartId: string;
  readonly action: ProductItemPartAction;
  readonly policyMode = OPEN_003_FAIL_CLOSED_POLICY.mode;

  constructor(itemPartId: string | undefined, action: ProductItemPartAction) {
    const stableItemPartId = itemPartId?.trim() || "unknown";
    super(`部位未启用：${stableItemPartId} 当前不能进入${ACTION_LABELS[action]}。`);
    this.name = "ItemPartNotEnabledError";
    this.itemPartId = stableItemPartId;
    this.action = action;
  }
}

export class ItemPartChainInconsistentError extends Error {
  readonly code = ITEM_PART_CHAIN_INCONSISTENT_CODE;
  readonly itemPartIds: string[];
  readonly action: ProductItemPartAction;
  readonly policyMode = OPEN_003_FAIL_CLOSED_POLICY.mode;

  constructor(itemPartIds: readonly string[], action: ProductItemPartAction) {
    const stableItemPartIds = [...new Set(itemPartIds.map((value) => value.trim()).filter(Boolean))].sort();
    super(`部位链不一致：${stableItemPartIds.join("、")} 不能共同进入${ACTION_LABELS[action]}。`);
    this.name = "ItemPartChainInconsistentError";
    this.itemPartIds = stableItemPartIds;
    this.action = action;
  }
}

export function isProductItemPartEnabled(itemPartId: string | undefined): boolean {
  return Boolean(itemPartId && ENABLED_ITEM_PART_IDS.has(itemPartId));
}

export function assertProductItemPartEnabled(
  itemPartId: string | undefined,
  action: ProductItemPartAction,
): asserts itemPartId is "part:rod" | "part:reel" | "part:line" {
  if (!isProductItemPartEnabled(itemPartId)) {
    throw new ItemPartNotEnabledError(itemPartId, action);
  }
}

export function enabledProductItemParts<T extends { id: string }>(parts: readonly T[]): T[] {
  return parts.filter((part) => isProductItemPartEnabled(part.id));
}

export function seriesItemPartId(
  series: SeriesDefinition,
  skus: readonly SkuDrawer[] = [],
): string | undefined {
  const declaredItemPartId = series.itemPartId?.trim();
  const descendantItemPartIds = [...new Set(
    skus
      .filter((sku) => sku.seriesId === series.id)
      .map((sku) => sku.projectionMatch.itemPartId?.trim())
      .filter((itemPartId): itemPartId is string => isProductItemPartEnabled(itemPartId)),
  )];
  if (declaredItemPartId) {
    return descendantItemPartIds.every((itemPartId) => itemPartId === declaredItemPartId)
      ? declaredItemPartId
      : undefined;
  }
  return descendantItemPartIds.length === 1 ? descendantItemPartIds[0] : undefined;
}

export function assertProductItemPartChainEnabled(
  itemPartIds: readonly (string | undefined)[],
  action: ProductItemPartAction,
): "part:rod" | "part:reel" | "part:line" {
  if (!itemPartIds.length || itemPartIds.some((itemPartId) => !itemPartId?.trim())) {
    throw new ItemPartNotEnabledError(undefined, action);
  }
  const normalized = itemPartIds.map((itemPartId) => itemPartId!.trim());
  for (const itemPartId of normalized) assertProductItemPartEnabled(itemPartId, action);
  const unique = [...new Set(normalized)];
  if (unique.length !== 1) throw new ItemPartChainInconsistentError(unique, action);
  return unique[0] as "part:rod" | "part:reel" | "part:line";
}

export function assertSeriesItemPartChainEnabled(
  series: SeriesDefinition,
  selectedSkus: readonly SkuDrawer[],
  action: ProductItemPartAction,
  additionalItemPartIds: readonly (string | undefined)[] = [],
): "part:rod" | "part:reel" | "part:line" {
  const selectedItemPartIds = selectedSkus
    .filter((sku) => sku.seriesId === series.id)
    .map((sku) => sku.projectionMatch.itemPartId);
  const declaredItemPartId = series.itemPartId?.trim();
  return assertProductItemPartChainEnabled([
    ...(declaredItemPartId ? [declaredItemPartId] : []),
    ...selectedItemPartIds,
    ...additionalItemPartIds,
  ], action);
}

export function enabledSeriesSkus(
  series: SeriesDefinition,
  skus: readonly SkuDrawer[],
): SkuDrawer[] {
  return skus.filter((sku) =>
    sku.seriesId === series.id
    && isProductItemPartEnabled(sku.projectionMatch.itemPartId));
}

export function snapshotItemPartId(snapshot: ConfigurationSnapshot): string | undefined {
  return snapshot.projectionMatch.itemPartId;
}

export function assertSnapshotItemPartEnabled(
  snapshot: ConfigurationSnapshot,
  action: "snapshot" | "config_export",
): void {
  assertProductItemPartEnabled(snapshotItemPartId(snapshot), action);
}
