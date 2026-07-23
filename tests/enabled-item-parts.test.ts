import assert from "node:assert/strict";
import test from "node:test";
import {
  ITEM_PART_CHAIN_INCONSISTENT_CODE,
  ITEM_PART_NOT_ENABLED_CODE,
  ItemPartNotEnabledError,
  enabledProductItemParts,
  isProductItemPartEnabled,
  seriesItemPartId,
} from "../lib/enabled-item-parts";
import { createSeedState } from "../lib/seed";
import { migrateWorkspaceState } from "../lib/migrations";
import { querySeriesGantt } from "../lib/series-gantt-query";
import { resolveProductDeepLink } from "../lib/interaction-contracts";
import {
  candidateGenerationInputHash,
  generateModelCandidateRun,
  materializeCandidateRun,
} from "../lib/model-candidate-generation";
import { publishConfigurationSnapshot, verifySnapshotIntegrity } from "../lib/publishing";
import { planSnapshotBatch } from "../lib/snapshot-batch";
import { deterministicHash } from "../lib/rule-kernel";
import type {
  CandidateGenerationRequest,
  CandidateSearchRecipe,
  ConfigurationSnapshot,
  ModelVariantInput,
} from "../lib/types";

function extendedSnapshot(source: ConfigurationSnapshot, itemPartId: string): ConfigurationSnapshot {
  const cloned = structuredClone(source);
  cloned.projectionMatch.itemPartId = itemPartId;
  const content = structuredClone(cloned);
  Reflect.deleteProperty(content, "contentHash");
  return { ...content, contentHash: deterministicHash(content) };
}

function candidateFixture() {
  const state = createSeedState();
  const series = state.seriesDefinitions[0]!;
  const skus = state.skuDrawers.filter((sku) => sku.seriesId === series.id).slice(0, 1);
  const recipe: CandidateSearchRecipe = {
    id: "recipe:enabled-parts",
    revision: 1,
    name: "部位门禁测试",
    methodIds: [series.fishingMethodId],
    typeIds: [series.typeId],
    functionIds: [series.coreFunctionId],
    performanceIds: series.performanceProfileId ? [series.performanceProfileId] : [],
    qualityIds: [series.qualityId],
    targetWeightRangeKg: { min: 0, max: 1000 },
    maxCandidates: 5,
    notes: "test",
  };
  state.candidateSearchRecipes = [recipe];
  const variants: ModelVariantInput[] = [{
    modelVariantKey: "stable",
    label: "稳定路线",
    action: "Fast",
    hardness: "M",
    lengthM: 2,
    componentSelections: [],
    technologyIds: [],
    attributeAffixIds: [],
    passiveAffixIds: [],
    patchIds: [],
    tags: [],
  }];
  const requestOptions = {
    seriesRef: { entityId: series.id, revisionId: String(series.revision) },
    skuRefs: skus.map((sku) => ({ entityId: sku.id, revisionId: String(sku.revision) })),
    recipeRef: { entityId: recipe.id, revisionId: String(recipe.revision) },
    recipeInput: {},
    enabledVariantKeys: ["stable"],
    perSkuLimit: 1,
    minimumAffinity: undefined,
    acceptWarnings: true,
    sortDefinitionVersion: "candidate-sort-v1",
    checkpointMode: "AUTO_CONTINUE" as const,
  };
  const request: CandidateGenerationRequest = {
    requestId: "request:enabled-parts",
    ...requestOptions,
    inputHash: candidateGenerationInputHash({
      series,
      skus,
      recipe,
      variants,
      ruleSetVersion: state.ruleSetVersions.find((entry) => entry.status === "published")?.id ?? "",
      requestOptions,
    }),
    idempotencyKey: "candidate:enabled-parts",
  };
  return { state, series, skus, recipe, variants, request, requestOptions };
}

test("OPEN-003 fail-closed 策略只启用竿轮线且不信任 activeInGeneration", () => {
  const state = createSeedState();
  const parts = structuredClone(state.itemParts);
  const hook = parts.find((part) => part.id === "part:hook")!;
  const rod = parts.find((part) => part.id === "part:rod")!;
  hook.activeInGeneration = true;
  rod.activeInGeneration = false;
  assert.deepEqual(enabledProductItemParts(parts).map((part) => part.id), [
    "part:rod",
    "part:reel",
    "part:line",
  ]);
  for (const deferredPartId of [
    "part:hook",
    "part:float",
    "part:natural_bait",
    "part:artificial_lure",
  ]) {
    assert.equal(isProductItemPartEnabled(deferredPartId), false);
  }
  assert.equal(isProductItemPartEnabled("part:unknown"), false);
});

test("扩展部位历史 Payload、未知字段与稳定引用在迁移和重启后不变", () => {
  const input = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  const itemParts = input.itemParts as Array<Record<string, unknown>>;
  const hook = itemParts.find((part) => part.id === "part:hook")!;
  hook.activeInGeneration = true;
  hook.legacyPayload = {
    stableExternalId: "legacy-hook-001",
    nestedUnknown: { keep: [1, "two", null] },
  };
  const before = structuredClone(hook);
  const migrated = migrateWorkspaceState(input);
  const afterMigration = migrated.itemParts.find((part) => part.id === "part:hook") as unknown;
  assert.deepEqual(afterMigration, before);
  const restarted = migrateWorkspaceState(structuredClone(migrated));
  assert.deepEqual(
    restarted.itemParts.find((part) => part.id === "part:hook"),
    before,
  );
});

test("甘特图和产品深链不披露扩展部位 Series/SKU/Model/Snapshot", () => {
  const state = createSeedState();
  const sourceSeries = state.seriesDefinitions[0]!;
  const sourceSku = state.skuDrawers.find((sku) => sku.seriesId === sourceSeries.id)!;
  const sourceModel = state.purchasableModels.find((model) => model.skuId === sourceSku.id)!;
  const sourceSnapshot = state.configurationSnapshots.find((snapshot) => snapshot.modelId === sourceModel.id)!;
  const series = { ...structuredClone(sourceSeries), id: "series:hook", itemPartId: "part:hook" };
  const sku = {
    ...structuredClone(sourceSku),
    id: "sku:hook",
    seriesId: series.id,
    projectionMatch: { ...structuredClone(sourceSku.projectionMatch), itemPartId: "part:hook" },
    modelIds: ["model:hook"],
  };
  const model = { ...structuredClone(sourceModel), id: "model:hook", skuId: sku.id };
  const snapshot = extendedSnapshot({ ...structuredClone(sourceSnapshot), id: "snapshot:hook", modelId: model.id }, "part:hook");
  const blocks = querySeriesGantt({
    query: { sort: "quality_type" },
    series: [...state.seriesDefinitions, series],
    skus: [...state.skuDrawers, sku],
    models: [...state.purchasableModels, model],
    itemTypes: state.itemTypeProfiles,
    upgrades: state.upgradeCandidates,
  });
  assert.equal(blocks.some((block) => block.seriesId === series.id), false);
  const deepLink = resolveProductDeepLink({
    workspaceId: "workspace:test",
    requested: { snapshotId: snapshot.id },
    collections: state.collections,
    series: [...state.seriesDefinitions, series],
    skus: [...state.skuDrawers, sku],
    models: [...state.purchasableModels, model],
    snapshots: [...state.configurationSnapshots, snapshot],
  });
  assert.equal(deepLink.series, undefined);
  assert.equal(deepLink.sku, undefined);
  assert.equal(deepLink.model, undefined);
  assert.equal(deepLink.snapshot, undefined);
  assert.equal(deepLink.integrityIssues[0]?.code, ITEM_PART_NOT_ENABLED_CODE);
});

test("缺少声明部位的历史 Series 从启用后代推导，延期 sibling 不隐藏合法产品视图", () => {
  const state = createSeedState();
  const sourceSeries = state.seriesDefinitions[0]!;
  const legacySeries = { ...structuredClone(sourceSeries), itemPartId: undefined };
  const enabledSku = state.skuDrawers.find((sku) => sku.seriesId === legacySeries.id)!;
  const retainedHookSku = {
    ...structuredClone(enabledSku),
    id: "sku:retained-hook-read-history",
    projectionMatch: {
      ...structuredClone(enabledSku.projectionMatch),
      itemPartId: "part:hook",
    },
    modelIds: [],
  };
  const series = state.seriesDefinitions.map((entry) => entry.id === legacySeries.id ? legacySeries : entry);
  const skus = [...state.skuDrawers, retainedHookSku];
  assert.equal(seriesItemPartId(legacySeries, skus), enabledSku.projectionMatch.itemPartId);

  const blocks = querySeriesGantt({
    query: { sort: "quality_type" },
    series,
    skus,
    models: state.purchasableModels,
    itemTypes: state.itemTypeProfiles,
    upgrades: state.upgradeCandidates,
  });
  const block = blocks.find((entry) => entry.seriesId === legacySeries.id);
  assert.ok(block);
  assert.ok(block.skuNodes.some((node) => node.skuId === enabledSku.id));
  assert.equal(block.skuNodes.some((node) => node.skuId === retainedHookSku.id), false);

  const matchingPartBlocks = querySeriesGantt({
    query: { itemPartIds: [enabledSku.projectionMatch.itemPartId] },
    series,
    skus,
    models: state.purchasableModels,
    itemTypes: state.itemTypeProfiles,
    upgrades: state.upgradeCandidates,
  });
  const otherEnabledPartId = enabledSku.projectionMatch.itemPartId === "part:reel"
    ? "part:rod"
    : "part:reel";
  const mismatchedPartBlocks = querySeriesGantt({
    query: { itemPartIds: [otherEnabledPartId] },
    series,
    skus,
    models: state.purchasableModels,
    itemTypes: state.itemTypeProfiles,
    upgrades: state.upgradeCandidates,
  });
  assert.ok(matchingPartBlocks.some((entry) => entry.seriesId === legacySeries.id));
  assert.equal(mismatchedPartBlocks.some((entry) => entry.seriesId === legacySeries.id), false);
});

test("声明部位与启用后代冲突时产品读取 fail-closed", () => {
  const state = createSeedState();
  const sourceSeries = state.seriesDefinitions[0]!;
  const sourceSku = state.skuDrawers.find((sku) => sku.seriesId === sourceSeries.id)!;
  const conflictingPartId = sourceSeries.itemPartId === "part:reel" ? "part:rod" : "part:reel";
  const conflictingSku = {
    ...structuredClone(sourceSku),
    id: "sku:enabled-part-conflict",
    projectionMatch: {
      ...structuredClone(sourceSku.projectionMatch),
      itemPartId: conflictingPartId,
    },
    modelIds: [],
  };
  const skus = [...state.skuDrawers, conflictingSku];

  assert.equal(seriesItemPartId(sourceSeries, skus), undefined);
  const blocks = querySeriesGantt({
    query: {},
    series: state.seriesDefinitions,
    skus,
    models: state.purchasableModels,
    itemTypes: state.itemTypeProfiles,
    upgrades: state.upgradeCandidates,
  });
  assert.equal(blocks.some((entry) => entry.seriesId === sourceSeries.id), false);
});

test("扩展部位候选生成和物化在任何模型写入前拒绝且状态不变", () => {
  const current = candidateFixture();
  const allowedRun = generateModelCandidateRun({
    state: current.state,
    request: current.request,
    variants: current.variants,
    startedAt: "2026-07-23T00:00:00.000Z",
    completedAt: "2026-07-23T00:00:00.001Z",
  });
  current.series.itemPartId = "part:hook";
  current.skus[0]!.projectionMatch.itemPartId = "part:hook";
  const hook = current.state.itemParts.find((part) => part.id === "part:hook")!;
  hook.activeInGeneration = true;
  current.request.inputHash = candidateGenerationInputHash({
    series: current.series,
    skus: current.skus,
    recipe: current.recipe,
    variants: current.variants,
    ruleSetVersion: current.state.ruleSetVersions.find((entry) => entry.status === "published")?.id ?? "",
    requestOptions: current.requestOptions,
  });
  const beforeGeneration = JSON.stringify(current.state);
  assert.throws(
    () => generateModelCandidateRun({
      state: current.state,
      request: current.request,
      variants: current.variants,
      startedAt: "2026-07-23T00:00:00.000Z",
      completedAt: "2026-07-23T00:00:00.001Z",
    }),
    (error) => error instanceof ItemPartNotEnabledError && error.code === ITEM_PART_NOT_ENABLED_CODE,
  );
  assert.equal(JSON.stringify(current.state), beforeGeneration);

  const beforeMaterialization = JSON.stringify(current.state);
  assert.throws(
    () => materializeCandidateRun({
      state: current.state,
      run: { ...allowedRun, candidates: [] },
      actor: "tester",
      occurredAt: "2026-07-23T00:01:00.000Z",
    }),
    (error) => error instanceof ItemPartNotEnabledError && error.action === "candidate_materialization",
  );
  assert.equal(JSON.stringify(current.state), beforeMaterialization);
});

test("选中的启用 SKU 不被历史延期兄弟节点阻断，显式选择延期 SKU 仍拒绝", () => {
  const current = candidateFixture();
  const retainedHookSku = {
    ...structuredClone(current.skus[0]!),
    id: "sku:retained-hook-history",
    projectionMatch: {
      ...structuredClone(current.skus[0]!.projectionMatch),
      itemPartId: "part:hook",
    },
    modelIds: [],
  };
  current.state.skuDrawers.push(retainedHookSku);

  const allowedRun = generateModelCandidateRun({
    state: current.state,
    request: current.request,
    variants: current.variants,
    startedAt: "2026-07-23T00:00:00.000Z",
    completedAt: "2026-07-23T00:00:00.001Z",
  });
  assert.equal(allowedRun.status, "completed");
  assert.doesNotThrow(() => materializeCandidateRun({
    state: current.state,
    run: allowedRun,
    actor: "tester",
    occurredAt: "2026-07-23T00:01:00.000Z",
  }));

  const hookRequestOptions = {
    ...current.requestOptions,
    skuRefs: [{ entityId: retainedHookSku.id, revisionId: String(retainedHookSku.revision) }],
  };
  const hookRequest: CandidateGenerationRequest = {
    ...current.request,
    requestId: "request:retained-hook-history",
    ...hookRequestOptions,
    inputHash: candidateGenerationInputHash({
      series: current.series,
      skus: [retainedHookSku],
      recipe: current.recipe,
      variants: current.variants,
      ruleSetVersion: current.state.ruleSetVersions.find((entry) => entry.status === "published")?.id ?? "",
      requestOptions: hookRequestOptions,
    }),
  };
  assert.throws(() => generateModelCandidateRun({
    state: current.state,
    request: hookRequest,
    variants: current.variants,
    startedAt: "2026-07-23T00:02:00.000Z",
    completedAt: "2026-07-23T00:02:00.001Z",
  }), (error) => error instanceof ItemPartNotEnabledError && error.itemPartId === "part:hook");
});

test("SnapshotBatch 只校验所选 Model 的 SKU，不要求删除延期兄弟节点", () => {
  const state = createSeedState();
  const snapshot = state.configurationSnapshots[0]!;
  const model = state.purchasableModels.find((entry) => entry.id === snapshot.modelId)!;
  const selectedSku = state.skuDrawers.find((entry) => entry.id === model.skuId)!;
  state.skuDrawers.push({
    ...structuredClone(selectedSku),
    id: "sku:retained-hook-snapshot-history",
    projectionMatch: {
      ...structuredClone(selectedSku.projectionMatch),
      itemPartId: "part:hook",
    },
    modelIds: [],
  });

  const plan = planSnapshotBatch({
    models: state.purchasableModels,
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    snapshots: state.configurationSnapshots,
    selectedModelIds: [model.id],
  });
  assert.notEqual(plan.items[0]?.decision, "skip");
  assert.equal(plan.items[0]?.reasons.includes(ITEM_PART_NOT_ENABLED_CODE), false);
  assert.equal(plan.items[0]?.reasons.includes(ITEM_PART_CHAIN_INCONSISTENT_CODE), false);
});

test("扩展部位不能发布或进入 SnapshotBatch，历史 Snapshot/hash 保持冻结", () => {
  const state = createSeedState();
  const snapshot = state.configurationSnapshots[0]!;
  assert.equal(verifySnapshotIntegrity(snapshot), true);
  const frozen = JSON.stringify(snapshot);
  const model = structuredClone(state.purchasableModels.find((entry) => entry.id === snapshot.modelId)!);
  const sku = structuredClone(state.skuDrawers.find((entry) => entry.id === model.skuId)!);
  const series = structuredClone(state.seriesDefinitions.find((entry) => entry.id === sku.seriesId)!);
  const projection = state.derivedProjections.find((entry) => entry.id === snapshot.projectionId)!;
  series.itemPartId = "part:hook";
  sku.projectionMatch.itemPartId = "part:hook";
  assert.throws(() => publishConfigurationSnapshot({
    publicationMode: "historical_import",
    model,
    sku,
    series,
    projection,
    finalPanelValues: snapshot.finalPanelValues,
    componentSelections: snapshot.componentSelections,
    patches: [],
    attributeAffixIds: snapshot.attributeAffixIds,
    passiveAffixIds: snapshot.passiveAffixIds,
    technologyIds: snapshot.technologyIds,
    passiveAffixPayloads: snapshot.passiveAffixPayloads,
    compatibilityReport: snapshot.compatibilityReport,
    affinityReport: snapshot.affinityReport,
    qualityReport: snapshot.qualityReport,
    validationReport: [],
    warningConfirmations: {},
    publishedBy: "tester",
    publishedAt: "2026-07-23T00:00:00.000Z",
  }), (error) => error instanceof ItemPartNotEnabledError && error.action === "model_publish");
  const plan = planSnapshotBatch({
    models: [model],
    series: [series],
    skus: [sku],
    snapshots: [snapshot],
    selectedModelIds: [model.id],
  });
  assert.equal(plan.items[0]?.decision, "skip");
  assert.deepEqual(plan.items[0]?.reasons, [ITEM_PART_NOT_ENABLED_CODE]);
  assert.equal(JSON.stringify(snapshot), frozen);
  assert.equal(verifySnapshotIntegrity(snapshot), true);
});

test("甘特图逐 SKU 过滤扩展部位并同步移除其 Model 后代", () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0]!;
  const sourceSku = state.skuDrawers.find((sku) => sku.seriesId === series.id)!;
  const sourceModel = state.purchasableModels.find((model) => model.skuId === sourceSku.id)!;
  const hookSku = {
    ...structuredClone(sourceSku),
    id: "sku:hook-descendant",
    projectionMatch: { ...structuredClone(sourceSku.projectionMatch), itemPartId: "part:hook" },
    modelIds: ["model:hook-descendant"],
  };
  const hookModel = { ...structuredClone(sourceModel), id: "model:hook-descendant", skuId: hookSku.id };
  const blocks = querySeriesGantt({
    query: { sort: "quality_type" },
    series: state.seriesDefinitions,
    skus: [...state.skuDrawers, hookSku],
    models: [...state.purchasableModels, hookModel],
    itemTypes: state.itemTypeProfiles,
    upgrades: state.upgradeCandidates,
  });
  const block = blocks.find((entry) => entry.seriesId === series.id)!;
  assert.equal(block.skuNodes.some((node) => node.skuId === hookSku.id), false);
  assert.equal(block.skuNodes.some((node) => node.modelIds.includes(hookModel.id)), false);
});

test("产品深链分别校验 Series、SKU 与冻结 Snapshot 的部位链", () => {
  const state = createSeedState();
  const sourceSnapshot = state.configurationSnapshots[0]!;
  const forgedSnapshot = extendedSnapshot({
    ...structuredClone(sourceSnapshot),
    id: "snapshot:forged-hook-chain",
    version: sourceSnapshot.version + 1,
  }, "part:hook");
  const resolution = resolveProductDeepLink({
    workspaceId: "workspace:test",
    requested: { snapshotId: forgedSnapshot.id },
    collections: state.collections,
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    models: state.purchasableModels,
    snapshots: [...state.configurationSnapshots, forgedSnapshot],
  });
  assert.equal(resolution.snapshot, undefined);
  assert.equal(resolution.model, undefined);
  assert.equal(resolution.integrityIssues[0]?.code, ITEM_PART_NOT_ENABLED_CODE);
});

test("SnapshotBatch 校验 Series/SKU/冻结 Snapshot 全链并拒绝伪造快照", () => {
  const state = createSeedState();
  const sourceSnapshot = state.configurationSnapshots[0]!;
  const model = state.purchasableModels.find((entry) => entry.id === sourceSnapshot.modelId)!;
  const forgedSnapshot = extendedSnapshot({
    ...structuredClone(sourceSnapshot),
    id: "snapshot:batch-forged-hook",
    version: sourceSnapshot.version + 1,
  }, "part:hook");
  const plan = planSnapshotBatch({
    models: state.purchasableModels,
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    snapshots: [forgedSnapshot],
    selectedModelIds: [model.id],
  });
  assert.equal(plan.items[0]?.decision, "skip");
  assert.deepEqual(plan.items[0]?.reasons, [ITEM_PART_NOT_ENABLED_CODE]);

  const sku = structuredClone(state.skuDrawers.find((entry) => entry.id === model.skuId)!);
  sku.projectionMatch.itemPartId = "part:reel";
  const inconsistent = planSnapshotBatch({
    models: [model],
    series: state.seriesDefinitions,
    skus: [sku],
    snapshots: [],
    selectedModelIds: [model.id],
  });
  assert.deepEqual(inconsistent.items[0]?.reasons, [ITEM_PART_CHAIN_INCONSISTENT_CODE]);
});
