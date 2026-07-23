import { evaluateAffinity, evaluateHardCompatibility } from "./compatibility";
import { deterministicHash } from "./rule-kernel";
import {
  assertSeriesItemPartChainEnabled,
} from "./enabled-item-parts";
import type {
  CandidateGenerationRequest,
  CandidateMaterializationRecord,
  CandidateRun,
  CandidateSearchRecipe,
  CompatibilityContext,
  ModelCandidate,
  ModelVariantInput,
  PurchasableModel,
  SeriesDefinition,
  SkuDrawer,
  ValidationIssue,
  WorkspaceState,
} from "./types";

function revisionId(value: number) { return String(value); }

export function candidateGenerationInputHash(input: {
  series: SeriesDefinition;
  skus: SkuDrawer[];
  recipe: CandidateSearchRecipe;
  variants: ModelVariantInput[];
  ruleSetVersion: string;
  requestOptions: Omit<CandidateGenerationRequest, "inputHash" | "idempotencyKey" | "requestId">;
}) {
  return deterministicHash({
    series: { id: input.series.id, revision: input.series.revision },
    skus: input.skus.map((sku) => ({ id: sku.id, revision: sku.revision })),
    recipe: { id: input.recipe.id, revision: input.recipe.revision },
    variants: input.variants,
    ruleSetVersion: input.ruleSetVersion,
    requestOptions: input.requestOptions,
  });
}

function recipeAccepts(recipe: CandidateSearchRecipe, series: SeriesDefinition, sku: SkuDrawer) {
  return recipe.methodIds.includes(series.fishingMethodId)
    && recipe.typeIds.includes(series.typeId)
    && recipe.functionIds.includes(series.coreFunctionId)
    && recipe.qualityIds.includes(series.qualityId)
    && (!series.performanceProfileId || recipe.performanceIds.includes(series.performanceProfileId))
    && sku.targetPullKg >= recipe.targetPullRangeKg.min
    && sku.targetPullKg <= recipe.targetPullRangeKg.max;
}

function contextFor(series: SeriesDefinition, sku: SkuDrawer, variant: ModelVariantInput): CompatibilityContext {
  const intensity = series.functionIntensityPolicy.mode === "fixed"
    ? series.functionIntensityPolicy.intensity
    : series.functionIntensityPolicy.values[String(sku.targetPullKg)] ?? 2;
  return {
    methodId: series.fishingMethodId,
    typeId: series.typeId,
    targetPullKg: sku.targetPullKg,
    functionId: series.coreFunctionId,
    functionIntensity: intensity,
    performanceId: series.performanceProfileId,
    qualityId: series.qualityId,
    componentIds: variant.componentSelections.map((entry) => entry.componentId),
    tags: variant.tags,
  };
}

function bump(counter: Record<string, number>, code: string) {
  counter[code] = (counter[code] ?? 0) + 1;
}

export function generateModelCandidateRun(input: {
  state: WorkspaceState;
  request: CandidateGenerationRequest;
  variants: ModelVariantInput[];
  startedAt: string;
  completedAt: string;
}): CandidateRun {
  const series = input.state.seriesDefinitions.find((entry) => entry.id === input.request.seriesRef.entityId);
  const recipe = input.state.candidateSearchRecipes.find((entry) => entry.id === input.request.recipeRef.entityId);
  if (!series || !recipe) throw new Error("CandidateGenerationRequest 引用的 Series 或 Recipe 不存在。");
  const skus = input.request.skuRefs.map((ref) => input.state.skuDrawers.find((entry) => entry.id === ref.entityId));
  if (skus.some((sku) => !sku)) throw new Error("CandidateGenerationRequest 引用了不存在的 SKU。");
  const selectedSkus = skus as SkuDrawer[];
  if (selectedSkus.some((sku) => sku.seriesId !== series.id)) {
    throw new Error("CandidateGenerationRequest 的 SKU 不属于请求的 Series。");
  }
  assertSeriesItemPartChainEnabled(
    series,
    selectedSkus,
    "candidate_generation",
    [],
    input.state.skuDrawers,
  );
  const ruleSetVersion = input.state.ruleSetVersions.find((entry) => entry.status === "published")?.id ?? "";
  const options = {
    seriesRef: input.request.seriesRef,
    skuRefs: input.request.skuRefs,
    recipeRef: input.request.recipeRef,
    recipeInput: input.request.recipeInput,
    enabledVariantKeys: input.request.enabledVariantKeys,
    perSkuLimit: input.request.perSkuLimit,
    minimumAffinity: input.request.minimumAffinity,
    acceptWarnings: input.request.acceptWarnings,
    sortDefinitionVersion: input.request.sortDefinitionVersion,
    checkpointMode: input.request.checkpointMode,
  };
  const expectedHash = candidateGenerationInputHash({ series, skus: selectedSkus, recipe, variants: input.variants, ruleSetVersion, requestOptions: options });
  if (expectedHash !== input.request.inputHash) throw new Error("候选生成 inputHash 与冻结输入不一致。");
  const revisionsChanged = revisionId(series.revision) !== input.request.seriesRef.revisionId
    || revisionId(recipe.revision) !== input.request.recipeRef.revisionId
    || selectedSkus.some((sku, index) => revisionId(sku.revision) !== input.request.skuRefs[index].revisionId);
  const runId = `candidate-run:${deterministicHash({ requestId: input.request.requestId, inputHash: expectedHash }).slice(0, 20)}`;
  if (revisionsChanged) {
    return {
      runId, request: structuredClone(input.request), status: "superseded", candidates: [], enumerationTotal: 0,
      legalCount: 0, excludedByCode: { REVISION_CHANGED: 1 }, truncatedCount: 0, inputHash: expectedHash,
      outputHash: deterministicHash({ runId, status: "superseded" }), startedAt: input.startedAt,
      completedAt: input.completedAt, durationMs: Math.max(0, Date.parse(input.completedAt) - Date.parse(input.startedAt)),
    };
  }
  const enabled = new Set(input.request.enabledVariantKeys);
  const variants = input.variants.filter((variant) => enabled.has(variant.modelVariantKey));
  const excludedByCode: Record<string, number> = {};
  const generated: ModelCandidate[] = [];
  let enumerationTotal = 0;
  for (const sku of selectedSkus) {
    for (const variant of variants) {
      enumerationTotal += 1;
      if (!recipeAccepts(recipe, series, sku)) { bump(excludedByCode, "RECIPE_SCOPE_MISMATCH"); continue; }
      const context = contextFor(series, sku, variant);
      const hard = evaluateHardCompatibility(context, input.state.compatibilityRules);
      if (!hard.allowed) { bump(excludedByCode, "HARD_COMPATIBILITY_DENIED"); continue; }
      const affinity = evaluateAffinity(context, input.state.affinityRules, input.state.affinityAxisWeights);
      if (input.request.minimumAffinity !== undefined && affinity.score < input.request.minimumAffinity) {
        bump(excludedByCode, "AFFINITY_BELOW_MINIMUM"); continue;
      }
      const invariantIssues = structuredClone(sku.validationSummary);
      const warningCount = invariantIssues.filter((issue) => issue.level === "warning").length + affinity.warnings.length;
      if (!input.request.acceptWarnings && warningCount) { bump(excludedByCode, "WARNING_NOT_ACCEPTED"); continue; }
      const proposedConfiguration = {
        projectionId: sku.projectionMatch.projectionId,
        projectionValues: structuredClone(input.state.derivedProjections.find((entry) => entry.id === sku.projectionMatch.projectionId)?.values ?? {}),
        targetPullKg: sku.targetPullKg,
        matchedStructuralPullKg: sku.projectionMatch.matchedStructuralPullKg,
        variant: structuredClone(variant),
      };
      const candidateFingerprint = deterministicHash({ skuId: sku.id, variantKey: variant.modelVariantKey, proposedConfiguration, ruleSetVersion });
      generated.push({
        candidateId: `model-candidate:${candidateFingerprint.slice(0, 24)}`,
        runId,
        skuRef: { entityId: sku.id, revisionId: revisionId(sku.revision) },
        modelVariantKey: variant.modelVariantKey,
        candidateFingerprint,
        projectionMatchRef: sku.projectionMatch.projectionId,
        proposedConfiguration,
        variant: structuredClone(variant),
        hardCompatibility: hard,
        affinity,
        invariantIssues,
        warningCount,
        pullDistance: sku.projectionMatch.pullDistance,
        rank: 0,
        rankReasons: [],
        state: "generated",
      });
    }
  }
  const candidates: ModelCandidate[] = [];
  let truncatedCount = 0;
  for (const sku of selectedSkus) {
    const ranked = generated.filter((candidate) => candidate.skuRef.entityId === sku.id).sort((left, right) =>
      left.modelVariantKey.localeCompare(right.modelVariantKey)
      || left.warningCount - right.warningCount
      || right.affinity.score - left.affinity.score
      || left.pullDistance - right.pullDistance
      || left.candidateFingerprint.localeCompare(right.candidateFingerprint));
    truncatedCount += Math.max(0, ranked.length - input.request.perSkuLimit);
    candidates.push(...ranked.slice(0, input.request.perSkuLimit).map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
      rankReasons: [
        `modelVariantKey=${candidate.modelVariantKey}`,
        `warning=${candidate.warningCount}`,
        `Affinity=${candidate.affinity.score}`,
        `拉力距离=${candidate.pullDistance}`,
        `fingerprint=${candidate.candidateFingerprint.slice(0, 12)}`,
      ],
    })));
  }
  const status = input.request.checkpointMode === "REVIEW_ON_CHANGE" ? "waiting_for_review" : "completed";
  const outputHash = deterministicHash({ runId, candidates, excludedByCode, truncatedCount, status });
  return {
    runId, request: structuredClone(input.request), status, candidates, enumerationTotal,
    legalCount: generated.length, excludedByCode, truncatedCount, inputHash: expectedHash, outputHash,
    startedAt: input.startedAt, completedAt: input.completedAt,
    durationMs: Math.max(0, Date.parse(input.completedAt) - Date.parse(input.startedAt)),
  };
}

function modelPayload(model: PurchasableModel) {
  return {
    skuId: model.skuId, modelVariantKey: model.modelVariantKey, name: model.name,
    action: model.action, hardness: model.hardness, lengthM: model.lengthM,
    componentSelections: model.componentSelections, technologyIds: model.technologyIds,
    attributeAffixIds: model.attributeAffixIds, passiveAffixIds: model.passiveAffixIds, patchIds: model.patchIds,
  };
}

export function materializeCandidateRun(input: {
  state: WorkspaceState;
  run: CandidateRun;
  actor: string;
  occurredAt: string;
  reviewConfirmed?: boolean;
}): { models: PurchasableModel[]; skus: SkuDrawer[]; record: CandidateMaterializationRecord } {
  if (
    input.run.status !== "completed"
    && !(input.run.status === "waiting_for_review" && input.reviewConfirmed)
  ) throw new Error("CandidateRun 未处于可物化状态，或 REVIEW_ON_CHANGE 尚未确认。");
  const requestSeries = input.state.seriesDefinitions.find(
    (entry) => entry.id === input.run.request.seriesRef.entityId,
  );
  if (!requestSeries) {
    throw new Error("CandidateRun 引用的 Series 不存在，禁止物化旧运行结果。");
  }
  if (String(requestSeries.revision) !== input.run.request.seriesRef.revisionId) {
    throw new Error("CandidateRun 引用的 Series revision 已变化，禁止物化旧运行结果。");
  }
  const requestSkus = input.run.request.skuRefs.map((ref) => {
    const sku = input.state.skuDrawers.find((entry) => entry.id === ref.entityId);
    if (!sku) throw new Error(`CandidateRun 引用的 SKU ${ref.entityId} 不存在，禁止物化旧运行结果。`);
    if (String(sku.revision) !== ref.revisionId) {
      throw new Error(`CandidateRun 引用的 SKU ${ref.entityId} revision 已变化，禁止物化旧运行结果。`);
    }
    if (sku.seriesId !== requestSeries.id) {
      throw new Error(`CandidateRun 引用的 SKU ${ref.entityId} 不属于请求的 Series。`);
    }
    return sku;
  });
  assertSeriesItemPartChainEnabled(
    requestSeries,
    requestSkus,
    "candidate_materialization",
    [],
    input.state.skuDrawers,
  );
  const requestedSkuIds = new Set(requestSkus.map((sku) => sku.id));
  for (const candidate of input.run.candidates) {
    if (!requestedSkuIds.has(candidate.skuRef.entityId)) {
      throw new Error(`Candidate ${candidate.candidateId} 引用了请求范围外的 SKU。`);
    }
    const sku = input.state.skuDrawers.find((entry) => entry.id === candidate.skuRef.entityId);
    const series = sku
      ? input.state.seriesDefinitions.find((entry) => entry.id === sku.seriesId)
      : undefined;
    if (!series || !sku) throw new Error(`Candidate ${candidate.candidateId} 的 SKU/Series 父链不存在。`);
    assertSeriesItemPartChainEnabled(
      series,
      [sku],
      "candidate_materialization",
      [],
      input.state.skuDrawers,
    );
  }
  const models = structuredClone(input.state.purchasableModels);
  const skus = structuredClone(input.state.skuDrawers);
  const issues: ValidationIssue[] = [];
  const materializedModelIds: string[] = [];
  const selected = new Map<string, ModelCandidate>();
  for (const candidate of input.run.candidates) {
    const key = `${candidate.skuRef.entityId}|${candidate.modelVariantKey}`;
    if (!selected.has(key)) selected.set(key, candidate);
  }
  for (const candidate of selected.values()) {
    const sku = skus.find((entry) => entry.id === candidate.skuRef.entityId);
    if (!sku || String(sku.revision) !== candidate.skuRef.revisionId) {
      issues.push({ level: "error", code: "CANDIDATE_SKU_REVISION_CHANGED", message: `${candidate.skuRef.entityId} revision 已变化，跳过物化。` });
      continue;
    }
    const matches = models.filter((model) => model.skuId === sku.id && model.modelVariantKey === candidate.modelVariantKey);
    if (matches.length > 1) {
      issues.push({ level: "error", code: "MODEL_VARIANT_BINDING_AMBIGUOUS", message: `${sku.id} + ${candidate.modelVariantKey} 命中多个 Model，禁止按名称猜测。` });
      continue;
    }
    const variant = candidate.variant;
    const desired = {
      skuId: sku.id, modelVariantKey: variant.modelVariantKey, name: variant.label,
      action: variant.action, hardness: variant.hardness, lengthM: variant.lengthM,
      componentSelections: variant.componentSelections, technologyIds: variant.technologyIds,
      attributeAffixIds: variant.attributeAffixIds, passiveAffixIds: variant.passiveAffixIds, patchIds: variant.patchIds,
    };
    const existing = matches[0];
    if (existing && deterministicHash(modelPayload(existing)) === deterministicHash(desired)) {
      materializedModelIds.push(existing.id);
      continue;
    }
    if (existing) {
      Object.assign(existing, structuredClone(desired), {
        revision: existing.revision + 1,
        status: "draft",
        updatedAt: input.occurredAt,
      });
      materializedModelIds.push(existing.id);
      continue;
    }
    const id = `model:${deterministicHash({ skuId: sku.id, variantKey: variant.modelVariantKey }).slice(0, 20)}`;
    const created: PurchasableModel = {
      id, revision: 1, ...structuredClone(desired), price: 0, status: "draft",
      createdAt: input.occurredAt, updatedAt: input.occurredAt,
    };
    models.push(created);
    if (!sku.modelIds.includes(id)) sku.modelIds.push(id);
    materializedModelIds.push(id);
  }
  const recordContent = {
    materializationId: `candidate-materialization:${deterministicHash({ runId: input.run.runId, actor: input.actor, occurredAt: input.occurredAt }).slice(0, 20)}`,
    runId: input.run.runId,
    runOutputHash: input.run.outputHash,
    selectedCandidateIds: Array.from(selected.values()).map((candidate) => candidate.candidateId),
    materializedModelIds,
    issues,
    actor: input.actor,
    occurredAt: input.occurredAt,
  };
  const record: CandidateMaterializationRecord = {
    ...recordContent,
    outputHash: deterministicHash(recordContent),
  };
  return { models, skus, record };
}
