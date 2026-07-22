import { deterministicHash } from "./rule-kernel";
import { seriesTargetPullSpecifications } from "./product-model";
import type {
  ProjectionMatch,
  SeriesDefinition,
  SkuDrawer,
} from "./types";

export interface SeriesPullPlanningProposal {
  proposalId: string;
  seriesId: string;
  seriesRevision: number;
  planningPullRange?: { minKgf: number; maxKgf: number };
  suggestedPullsKgf: number[];
  existingPullsKgf: number[];
  source: "explicit_user_input" | "standard_load_grades";
  createdAt: string;
  inputHash: string;
}

function normalizePulls(values: number[]) {
  return [...new Set(values)]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
}

function assertRange(range: { minKgf: number; maxKgf: number }) {
  if (
    !Number.isFinite(range.minKgf)
    || !Number.isFinite(range.maxKgf)
    || range.minKgf <= 0
    || range.maxKgf < range.minKgf
  ) {
    throw new Error("规划拉力范围必须是有效的正数闭区间。");
  }
}

export function createSeriesPullPlanningProposal(input: {
  series: SeriesDefinition;
  planningPullRange?: { minKgf: number; maxKgf: number };
  candidatePullsKgf: number[];
  source: SeriesPullPlanningProposal["source"];
  createdAt: string;
}): SeriesPullPlanningProposal {
  if (input.planningPullRange) assertRange(input.planningPullRange);
  const suggestedPullsKgf = normalizePulls(input.candidatePullsKgf)
    .filter((value) => !input.planningPullRange
      || (value >= input.planningPullRange.minKgf && value <= input.planningPullRange.maxKgf));
  if (!suggestedPullsKgf.length) {
    throw new Error("规划范围内没有可供确认的离散目标拉力规格。");
  }
  const content = {
    seriesId: input.series.id,
    seriesRevision: input.series.revision,
    planningPullRange: structuredClone(input.planningPullRange),
    suggestedPullsKgf,
    existingPullsKgf: seriesTargetPullSpecifications(input.series).map((entry) => entry.targetPullKgf),
    source: input.source,
    createdAt: input.createdAt,
  };
  const inputHash = deterministicHash(content);
  return { proposalId: `series-pull-plan:${inputHash}`, ...content, inputHash };
}

export function updateSeriesPlanningRange(input: {
  series: SeriesDefinition;
  planningPullRange: { minKgf: number; maxKgf: number };
  updatedAt: string;
}): SeriesDefinition {
  assertRange(input.planningPullRange);
  return {
    ...structuredClone(input.series),
    revision: input.series.revision + 1,
    planningPullRange: structuredClone(input.planningPullRange),
    updatedAt: input.updatedAt,
  };
}

export function materializeConfirmedPullSpecifications(input: {
  series: SeriesDefinition;
  existingSkus: SkuDrawer[];
  proposal: SeriesPullPlanningProposal;
  confirmedPullsKgf: number[];
  skuIdByPull: Record<string, string>;
  projectionMatchByPull: Record<string, ProjectionMatch>;
  createdAt: string;
}): { series: SeriesDefinition; skus: SkuDrawer[]; createdSkuIds: string[] } {
  if (input.proposal.seriesId !== input.series.id || input.proposal.seriesRevision !== input.series.revision) {
    throw new Error("规划建议的 Series revision 已过期，必须重新生成建议。");
  }
  const confirmed = normalizePulls(input.confirmedPullsKgf);
  if (!confirmed.length || confirmed.some((pull) => !input.proposal.suggestedPullsKgf.includes(pull))) {
    throw new Error("只能物化本次建议中经用户明确确认的离散拉力。");
  }
  const specifications = seriesTargetPullSpecifications(input.series);
  const existingByPull = new Map(specifications.map((entry) => [entry.targetPullKgf, entry]));
  const allSkus = structuredClone(input.existingSkus);
  const createdSkuIds: string[] = [];
  for (const pull of confirmed) {
    if (existingByPull.has(pull)) continue;
    const key = String(pull);
    const skuId = input.skuIdByPull[key];
    const projectionMatch = input.projectionMatchByPull[key];
    if (!skuId || !projectionMatch) {
      throw new Error(`离散拉力 ${pull}kgf 缺少稳定 skuId 或独立结构标杆匹配结果。`);
    }
    if (allSkus.some((sku) => sku.id === skuId || (sku.seriesId === input.series.id && sku.targetPullKg === pull))) {
      throw new Error(`离散拉力 ${pull}kgf 或 SKU ID ${skuId} 已存在，禁止重复物化。`);
    }
    if (projectionMatch.targetPullKg !== pull) {
      throw new Error(`离散拉力 ${pull}kgf 的 ProjectionMatch 目标值不一致。`);
    }
    specifications.push({ targetPullKgf: pull, skuId });
    allSkus.push({
      id: skuId,
      revision: 1,
      seriesId: input.series.id,
      targetPullKg: pull,
      projectionMatch: structuredClone(projectionMatch),
      patchIds: [],
      modelIds: [],
      displayOrder: 0,
      validationSummary: [],
      status: "draft",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    createdSkuIds.push(skuId);
  }
  const ordered = [...specifications]
    .sort((left, right) => left.targetPullKgf - right.targetPullKgf || left.skuId.localeCompare(right.skuId));
  const displayOrderBySku = new Map(ordered.map((entry, index) => [entry.skuId, index + 1]));
  const skus = allSkus.map((sku) => sku.seriesId === input.series.id && displayOrderBySku.has(sku.id)
    ? { ...sku, displayOrder: displayOrderBySku.get(sku.id)! }
    : sku);
  return {
    series: {
      ...structuredClone(input.series),
      revision: input.series.revision + 1,
      ...(input.proposal.planningPullRange ? { planningPullRange: structuredClone(input.proposal.planningPullRange) } : {}),
      targetPullSpecifications: ordered,
      skuIds: ordered.map((entry) => entry.skuId),
      updatedAt: input.createdAt,
    },
    skus,
    createdSkuIds,
  };
}
