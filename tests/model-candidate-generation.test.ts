import assert from "node:assert/strict";
import test from "node:test";
import { createSeedState } from "../lib/seed";
import {
  SKU_NOT_CURRENT_SERIES_SPECIFICATION_CODE,
  SkuNotCurrentSeriesSpecificationError,
} from "../lib/enabled-item-parts";
import {
  candidateGenerationInputHash,
  generateModelCandidateRun,
  materializeCandidateRun,
} from "../lib/model-candidate-generation";
import type {
  CandidateGenerationRequest,
  CandidateSearchRecipe,
  ModelVariantInput,
  WorkspaceState,
} from "../lib/types";

function fixture() {
  const state = createSeedState();
  const series = state.seriesDefinitions[0];
  const skus = state.skuDrawers.filter((sku) => sku.seriesId === series.id).slice(0, 2);
  const recipe: CandidateSearchRecipe = {
    id: "recipe:candidate-test",
    revision: 3,
    name: "候选生成测试",
    methodIds: [series.fishingMethodId],
    typeIds: [series.typeId],
    functionIds: [series.coreFunctionId],
    performanceIds: series.performanceProfileId ? [series.performanceProfileId] : [],
    qualityIds: [series.qualityId],
    targetPullRangeKg: { min: 0, max: 1000 },
    maxCandidates: 20,
    notes: "test",
  };
  state.candidateSearchRecipes = [recipe];
  const variants: ModelVariantInput[] = [
    {
      modelVariantKey: "fast_short",
      label: "快调短款",
      action: "Fast",
      hardness: "M",
      lengthM: 1.8,
      componentSelections: [], technologyIds: [], attributeAffixIds: [], passiveAffixIds: [], patchIds: [],
      tags: ["fast"],
    },
    {
      modelVariantKey: "slow_long",
      label: "慢调长款",
      action: "Slow",
      hardness: "ML",
      lengthM: 2.1,
      componentSelections: [], technologyIds: [], attributeAffixIds: [], passiveAffixIds: [], patchIds: [],
      tags: ["slow"],
    },
  ];
  const options = {
    seriesRef: { entityId: series.id, revisionId: String(series.revision) },
    skuRefs: skus.map((sku) => ({ entityId: sku.id, revisionId: String(sku.revision) })),
    recipeRef: { entityId: recipe.id, revisionId: String(recipe.revision) },
    recipeInput: {},
    enabledVariantKeys: variants.map((variant) => variant.modelVariantKey),
    perSkuLimit: 8,
    minimumAffinity: undefined,
    acceptWarnings: true,
    sortDefinitionVersion: "candidate-sort-v1",
    checkpointMode: "AUTO_CONTINUE" as const,
  };
  const inputHash = candidateGenerationInputHash({
    series, skus, recipe, variants,
    ruleSetVersion: state.ruleSetVersions.find((entry) => entry.status === "published")?.id ?? "",
    requestOptions: options,
  });
  const request: CandidateGenerationRequest = {
    requestId: "request:test-1",
    ...options,
    inputHash,
    idempotencyKey: "candidate:test-1",
  };
  return { state, series, skus, recipe, variants, request };
}

function run(current: ReturnType<typeof fixture>) {
  return generateModelCandidateRun({
    state: current.state,
    request: current.request,
    variants: current.variants,
    startedAt: "2026-07-21T00:00:00.000Z",
    completedAt: "2026-07-21T00:00:00.025Z",
  });
}

test("同一冻结输入产生相同候选顺序、fingerprint 与输出 hash", () => {
  const current = fixture();
  const first = run(current);
  const second = run(current);
  assert.equal(first.status, "completed");
  assert.equal(first.enumerationTotal, current.skus.length * current.variants.length);
  assert.deepEqual(second, first);
  assert.equal(first.durationMs, 25);
});

test("旧 Performance 字段不参与配方筛选、兼容、Affinity 或候选 fingerprint", () => {
  const baseline = fixture();
  const expected = run(baseline);
  const withLegacyPerformance = fixture();
  withLegacyPerformance.series.performanceProfileId = "legacy:performance:heavy";
  withLegacyPerformance.recipe.performanceIds = ["legacy:performance:other"];
  withLegacyPerformance.state.compatibilityRules.push({
    id: "legacy-performance-deny",
    axis: "type_function",
    effect: "deny",
    selector: { performanceId: "legacy:performance:heavy" },
    requirements: [],
    priority: 999,
    ruleSetVersion: withLegacyPerformance.state.ruleSetVersions[0].id,
    reason: "旧 Performance 规则不得命中新候选",
    suggestion: "",
    enabled: true,
  });
  withLegacyPerformance.state.compatibilityRules.push({
    id: "legacy-performance-requirement",
    axis: "type_function",
    effect: "require",
    selector: {
      typeId: withLegacyPerformance.series.typeId,
      functionId: withLegacyPerformance.series.coreFunctionId,
    },
    requirements: [{
      kind: "field",
      key: "performanceId",
      value: "legacy:performance:required",
      message: "旧 Performance requirement 不得阻断 canonical 候选",
    }],
    priority: 998,
    ruleSetVersion: withLegacyPerformance.state.ruleSetVersions[0].id,
    reason: "旧 Performance requirement",
    suggestion: "",
    enabled: true,
  });
  withLegacyPerformance.state.affinityRules.push({
    id: "legacy-performance-affinity",
    axis: "function_performance",
    selector: {},
    score: -3,
    priority: 999,
    ruleSetVersion: withLegacyPerformance.state.ruleSetVersions[0].id,
    reason: "旧轴不得进入新 Affinity",
    enabled: true,
  });
  const actual = run(withLegacyPerformance);
  assert.deepEqual(
    actual.candidates.map((candidate) => candidate.candidateFingerprint),
    expected.candidates.map((candidate) => candidate.candidateFingerprint),
  );
  assert.equal(actual.excludedByCode.HARD_COMPATIBILITY_DENIED, undefined);
  assert.equal(
    actual.candidates.every((candidate) =>
      !candidate.affinity.matchedRuleIds.includes("legacy-performance-affinity")),
    true,
  );
});

test("高 Affinity 候选命中 deny 时只进入排除统计，合法候选仍保留", () => {
  const current = fixture();
  current.state.compatibilityRules.push({
    id: "deny-fast",
    axis: "model_component",
    effect: "deny",
    selector: { tags: ["fast"] },
    requirements: [],
    priority: 100,
    ruleSetVersion: current.state.ruleSetVersions[0].id,
    reason: "测试 deny",
    suggestion: "使用其他路线",
    enabled: true,
  });
  current.state.affinityRules.push({
    id: "affinity-fast",
    axis: "model_component",
    selector: { tags: ["fast"] },
    score: 100,
    priority: 100,
    ruleSetVersion: current.state.ruleSetVersions[0].id,
    reason: "测试高分",
    enabled: true,
  });
  const result = run(current);
  assert.equal(result.excludedByCode.HARD_COMPATIBILITY_DENIED, current.skus.length);
  assert.equal(result.candidates.every((candidate) => candidate.modelVariantKey === "slow_long"), true);
});

test("默认物化按 skuId + modelVariantKey 新建稳定 Model，重复执行不创建空 revision", () => {
  const current = fixture();
  const generated = run(current);
  const first = materializeCandidateRun({ state: current.state, run: generated, actor: "tester", occurredAt: "2026-07-21T01:00:00.000Z" });
  assert.equal(first.record.materializedModelIds.length, current.skus.length * current.variants.length);
  const nextState: WorkspaceState = {
    ...current.state,
    purchasableModels: first.models,
    skuDrawers: first.skus,
  };
  const second = materializeCandidateRun({ state: nextState, run: generated, actor: "tester", occurredAt: "2026-07-21T02:00:00.000Z" });
  assert.equal(second.models.length, first.models.length);
  for (const modelId of second.record.materializedModelIds) {
    assert.equal(second.models.find((model) => model.id === modelId)?.revision, 1);
  }
});

test("同一 SKU + modelVariantKey 多重命中时跳过并报告，不按名称猜测", () => {
  const current = fixture();
  const generated = run(current);
  const first = materializeCandidateRun({ state: current.state, run: generated, actor: "tester", occurredAt: "2026-07-21T01:00:00.000Z" });
  const duplicate = { ...structuredClone(first.models.find((model) => model.modelVariantKey === "fast_short")!), id: "model:duplicate" };
  const nextState = { ...current.state, purchasableModels: [...first.models, duplicate], skuDrawers: first.skus };
  const result = materializeCandidateRun({ state: nextState, run: generated, actor: "tester", occurredAt: "2026-07-21T02:00:00.000Z" });
  assert.ok(result.record.issues.some((issue) => issue.code === "MODEL_VARIANT_BINDING_AMBIGUOUS"));
});

test("候选生成和物化在领域边界拒绝 DEPRECATED 或非当前规格 SKU", () => {
  const current = fixture();
  const allowedRun = run(current);
  const selectedSku = current.skus[0]!;
  const originalStatus = selectedSku.status;

  selectedSku.status = "superseded";
  assert.throws(
    () => run(current),
    (error) =>
      error instanceof SkuNotCurrentSeriesSpecificationError &&
      error.code === SKU_NOT_CURRENT_SERIES_SPECIFICATION_CODE &&
      error.action === "candidate_generation" &&
      error.skuIds.includes(selectedSku.id),
  );
  assert.throws(
    () => materializeCandidateRun({
      state: current.state,
      run: allowedRun,
      actor: "tester",
      occurredAt: "2026-07-21T02:00:00.000Z",
    }),
    (error) =>
      error instanceof SkuNotCurrentSeriesSpecificationError &&
      error.action === "candidate_materialization" &&
      error.skuIds.includes(selectedSku.id),
  );

  selectedSku.status = originalStatus;
  current.series.targetPullSpecifications =
    current.series.targetPullSpecifications.filter(
      (entry) => entry.skuId !== selectedSku.id,
    );
  assert.throws(
    () => run(current),
    (error) =>
      error instanceof SkuNotCurrentSeriesSpecificationError &&
      error.action === "candidate_generation" &&
      error.skuIds.includes(selectedSku.id),
  );
});
