import assert from "node:assert/strict";
import test from "node:test";
import { createSeedState } from "../lib/seed";
import {
  createSeriesPullPlanningProposal,
  materializeConfirmedPullSpecifications,
  updateSeriesPlanningRange,
} from "../lib/series-pull-planning";
import { validateSeriesInvariants } from "../lib/product-model";
import {
  ITEM_PART_CHAIN_INCONSISTENT_CODE,
  ITEM_PART_NOT_ENABLED_CODE,
} from "../lib/enabled-item-parts";

test("规划范围变化只更新规划元数据，不增删离散 SKU 或改写 Snapshot", () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0];
  const beforeSpecs = structuredClone(series.targetPullSpecifications);
  const beforeSkus = structuredClone(state.skuDrawers);
  const beforeSnapshots = structuredClone(state.configurationSnapshots);
  const updated = updateSeriesPlanningRange({
    series,
    planningPullRange: { minKgf: 1.5, maxKgf: 8.2 },
    updatedAt: "2026-07-22T01:00:00.000Z",
  });
  assert.deepEqual(updated.targetPullSpecifications, beforeSpecs);
  assert.deepEqual(state.skuDrawers, beforeSkus);
  assert.deepEqual(state.configurationSnapshots, beforeSnapshots);
  assert.deepEqual(updated.planningPullRange, { minKgf: 1.5, maxKgf: 8.2 });
});

test("范围内候选只形成建议，确认后才逐拉力物化 SKU 并要求独立 ProjectionMatch", () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0];
  const proposal = createSeriesPullPlanningProposal({
    series,
    planningPullRange: { minKgf: 1.5, maxKgf: 8.2 },
    candidatePullsKgf: [1.5, 3.8, 5.4, 8.2, 9.9],
    source: "standard_load_grades",
    createdAt: "2026-07-22T01:00:00.000Z",
  });
  assert.deepEqual(proposal.suggestedPullsKgf, [1.5, 3.8, 5.4, 8.2]);
  assert.equal(state.skuDrawers.some((sku) => sku.targetPullKg === 3.8), false);
  const match = {
    ...state.skuDrawers[0].projectionMatch,
    targetPullKg: 3.8,
    weightDistance: 0.2,
    trace: [{ stage: "weight_distance" as const, candidateId: state.skuDrawers[0].projectionMatch.projectionId, detail: "3.8kgf 独立匹配" }],
  };
  const result = materializeConfirmedPullSpecifications({
    series,
    existingSkus: state.skuDrawers,
    proposal,
    confirmedPullsKgf: [3.8],
    skuIdByPull: { "3.8": "sku:qinglu-obstacle-3.8" },
    projectionMatchByPull: { "3.8": match },
    createdAt: "2026-07-22T01:05:00.000Z",
  });
  assert.deepEqual(result.createdSkuIds, ["sku:qinglu-obstacle-3.8"]);
  assert.deepEqual(result.series.targetPullSpecifications.map((entry) => entry.targetPullKgf), [1.5, 1.8, 3.8]);
  assert.equal(result.skus.find((sku) => sku.id === "sku:qinglu-obstacle-3.8")?.projectionMatch.targetPullKg, 3.8);
  assert.equal(result.skus.filter((sku) => sku.seriesId === series.id && sku.targetPullKg === 3.8).length, 1);
});

test("每个规格必须恰好映射一个所属 SKU，缺失、重复或拉力不一致均阻断", () => {
  const state = createSeedState();
  const series = structuredClone(state.seriesDefinitions[0]);
  series.targetPullSpecifications = [
    ...series.targetPullSpecifications,
    { targetPullKgf: 1.5, skuId: "sku:missing" },
  ];
  const issues = validateSeriesInvariants({
    series,
    skus: state.skuDrawers,
    models: state.purchasableModels,
    projections: state.derivedProjections,
    resolvedPanels: [],
  });
  assert.ok(issues.some((issue) => issue.code === "SERIES_PULL_SPECIFICATION_DUPLICATE"));
  assert.ok(issues.some((issue) => issue.code === "SERIES_PULL_SPECIFICATION_NOT_MATERIALIZED"));
});

test("过期规划建议不能覆盖新 revision，已存在拉力不会重复创建", () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0];
  const proposal = createSeriesPullPlanningProposal({
    series,
    planningPullRange: { minKgf: 1.5, maxKgf: 3.8 },
    candidatePullsKgf: [1.5, 3.8],
    source: "explicit_user_input",
    createdAt: "2026-07-22T01:00:00.000Z",
  });
  assert.throws(() => materializeConfirmedPullSpecifications({
    series: { ...series, revision: series.revision + 1 },
    existingSkus: state.skuDrawers,
    proposal,
    confirmedPullsKgf: [3.8],
    skuIdByPull: { "3.8": "sku:3.8" },
    projectionMatchByPull: { "3.8": { ...state.skuDrawers[0].projectionMatch, targetPullKg: 3.8 } },
    createdAt: "2026-07-22T01:05:00.000Z",
  }), /revision 已过期/);
  const unchanged = materializeConfirmedPullSpecifications({
    series,
    existingSkus: state.skuDrawers,
    proposal,
    confirmedPullsKgf: [1.5],
    skuIdByPull: {},
    projectionMatchByPull: {},
    createdAt: "2026-07-22T01:05:00.000Z",
  });
  assert.deepEqual(unchanged.createdSkuIds, []);
  assert.equal(unchanged.skus.filter((sku) => sku.seriesId === series.id && sku.targetPullKg === 1.5).length, 1);
});

test("没有规划范围时，明确离散规格仍可形成可物化建议", () => {
  const state = createSeedState();
  const series = { ...structuredClone(state.seriesDefinitions[0]), planningPullRange: undefined };
  const proposal = createSeriesPullPlanningProposal({
    series,
    candidatePullsKgf: [8.2, 1.5, 3.8, 3.8],
    source: "explicit_user_input",
    createdAt: "2026-07-22T02:00:00.000Z",
  });
  assert.equal(proposal.planningPullRange, undefined);
  assert.deepEqual(proposal.suggestedPullsKgf, [1.5, 3.8, 8.2]);
});

test("混合部位批次在任何 SKU 构造前整体拒绝，不能留下半批结果", () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0]!;
  const proposal = createSeriesPullPlanningProposal({
    series,
    candidatePullsKgf: [3.8, 5.4],
    source: "explicit_user_input",
    createdAt: "2026-07-23T03:00:00.000Z",
  });
  const before = JSON.stringify(state.skuDrawers);
  assert.throws(() => materializeConfirmedPullSpecifications({
    series,
    existingSkus: state.skuDrawers,
    proposal,
    confirmedPullsKgf: [3.8, 5.4],
    skuIdByPull: { "3.8": "sku:mixed-rod", "5.4": "sku:mixed-hook" },
    projectionMatchByPull: {
      "3.8": { ...state.skuDrawers[0]!.projectionMatch, targetPullKg: 3.8 },
      "5.4": { ...state.skuDrawers[0]!.projectionMatch, targetPullKg: 5.4, itemPartId: "part:hook" },
    },
    createdAt: "2026-07-23T03:01:00.000Z",
  }), (error) => (
    error instanceof Error
    && "code" in error
    && (error.code === ITEM_PART_NOT_ENABLED_CODE || error.code === ITEM_PART_CHAIN_INCONSISTENT_CODE)
  ));
  assert.equal(JSON.stringify(state.skuDrawers), before);
});

test("历史启用 Series 缺 itemPartId 时从稳定 SKU 绑定派生，后代不一致则 fail-closed", () => {
  const state = createSeedState();
  const series = structuredClone(state.seriesDefinitions[0]!);
  delete series.itemPartId;
  const seriesSkus = state.skuDrawers.filter((sku) => sku.seriesId === series.id);
  assert.doesNotThrow(() => createSeriesPullPlanningProposal({
    series,
    existingSkus: seriesSkus,
    candidatePullsKgf: [3.8],
    source: "explicit_user_input",
    createdAt: "2026-07-23T03:10:00.000Z",
  }));

  const inconsistentSkus = structuredClone(seriesSkus);
  inconsistentSkus[0]!.projectionMatch.itemPartId = "part:reel";
  assert.throws(() => createSeriesPullPlanningProposal({
    series,
    existingSkus: inconsistentSkus,
    candidatePullsKgf: [3.8],
    source: "explicit_user_input",
    createdAt: "2026-07-23T03:11:00.000Z",
  }), (error) => (
    error instanceof Error
    && "code" in error
    && error.code === ITEM_PART_CHAIN_INCONSISTENT_CODE
  ));
});
