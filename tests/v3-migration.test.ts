import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_WORKSPACE_SCHEMA_VERSION, migrateWorkspaceState } from "../lib/migrations";
import { verifySnapshotIntegrity } from "../lib/publishing";
import { deterministicHash } from "../lib/rule-kernel";
import { createSeedState } from "../lib/seed";

test("v14 将旧系列配方迁移为竿轮线约束且保留扁平字段", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 13;
  const recipes = legacy.recipes as Array<Record<string, unknown>>;
  const before = structuredClone(recipes[0]);
  delete recipes[0].partConstraints;

  const migrated = migrateWorkspaceState(legacy);
  const recipe = migrated.recipes[0];
  assert.equal(migrated.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.deepEqual(recipe.templateIds, before.templateIds);
  assert.deepEqual(recipe.structureIds, before.structureIds);
  assert.deepEqual(recipe.requiredAffixIds, before.requiredAffixIds);
  assert.deepEqual(recipe.partConstraints?.rod?.templateIds, before.templateIds);
  assert.deepEqual(recipe.partConstraints?.reel?.typeIds, before.structureIds);
  assert.deepEqual(recipe.partConstraints?.line?.requiredAffixIds, before.requiredAffixIds);
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});

test("v15 保留旧五维定义并明确迁移为未发布修订", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 14;
  legacy.fiveAxisViewDefinitions = [{
    definitionId: "five-axis:legacy",
    version: "legacy-v1",
    fiveAxisRuleVersion: "rule-v1",
    sourceRevision: "source-v1",
    axes: [],
    seriesBaselinePolicy: { mode: "projection_reference" },
    preservedUnknown: "keep-me",
  }];
  const migrated = migrateWorkspaceState(legacy);
  const definition = migrated.fiveAxisViewDefinitions[0] as unknown as Record<string, unknown>;
  assert.equal(migrated.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.equal(definition.publicationState, "UNPUBLISHED");
  assert.equal(definition.revision, 1);
  assert.equal(typeof definition.definitionHash, "string");
  assert.equal(definition.preservedUnknown, "keep-me");
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});

test("v16 为旧工作区增加持久化回写意图账本且迁移幂等", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 15;
  delete legacy.dataSourceWritebackIntents;
  const migrated = migrateWorkspaceState(legacy);
  assert.equal(migrated.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.deepEqual(migrated.dataSourceWritebackIntents, []);
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});

test("D-02 OfficialSku 无损迁移为抽屉、默认 Model 与冻结快照", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 2;
  legacy.collections = [];
  legacy.seriesDefinitions = [];
  legacy.skuDrawers = [];
  legacy.purchasableModels = [];
  legacy.configurationSnapshots = [];
  legacy.upgradeCandidates = [];
  legacy.ruleChangeProposals = [];
  legacy.governanceAuditLog = [];
  legacy.v3Affixes = [];
  legacy.technologies = [];
  legacy.officialSkus = [{
    id: "official-legacy-1",
    candidateId: "candidate-legacy-1",
    comboId: "QL-LEGACY-150",
    platformId: "PLATFORM-1",
    platformPosition: "障碍强攻",
    templateId: "T04",
    seriesName: "青芦·历史",
    qualityId: "A",
    fishMinKg: 1.2,
    fishMaxKg: 1.8,
    structureName: "水滴+枪柄",
    functionName: "障碍强攻",
    functionLevel: "2",
    performanceName: "灵敏",
    performanceLevel: "标准",
    affixIds: [],
    tone: "快调",
    hardness: "MH",
    lengthM: 2.13,
    useScene: "历史场景",
    rodId: "QL-LEGACY-150_R",
    reelId: "QL-LEGACY-150_W",
    lineId: "QL-LEGACY-150_L",
    priceIndex: 1.25,
    rodForce: 4.2,
    reelForce: 3.8,
    lineForce: 5.1,
    safeWorkingForce: 1.785,
    values: { "杆最大拉力kgf": 4.2, "轮最大拉力kgf": 3.8, "线最大拉力kgf": 5.1 },
    overrides: { "杆最大拉力kgf": 4.2 },
    notes: "必须保留",
    publishedAt: "2025-01-02T03:04:05.000Z",
  }];
  legacy.detailOverrides = [{
    skuId: "official-legacy-1",
    itemKind: "rod",
    model: "LEGACY-ROD",
    name: "历史杆",
    values: { "杆最大拉力kgf": 4.2 },
    notes: "历史明细",
  }];

  const migrated = migrateWorkspaceState(legacy);
  assert.equal(migrated.skuDrawers.length, 1);
  assert.equal(migrated.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.deepEqual(migrated.qualityValuePolicyDrafts, []);
  assert.deepEqual(migrated.seriesDefinitions[0].targetPullSpecifications, [{
    targetPullKgf: migrated.skuDrawers[0].targetPullKg,
    skuId: migrated.skuDrawers[0].id,
  }]);
  assert.deepEqual(migrated.seriesDefinitions[0].planningPullRange, {
    minKgf: migrated.skuDrawers[0].targetPullKg,
    maxKgf: migrated.skuDrawers[0].targetPullKg,
  });
  assert.equal(migrated.purchasableModels.length, 1);
  assert.equal(migrated.configurationSnapshots.length, 1);
  assert.equal(migrated.purchasableModels[0].configurationSnapshotId, migrated.configurationSnapshots[0].id);
  assert.deepEqual(migrated.configurationSnapshots[0].finalPanelValues, (legacy.officialSkus as Array<{ values: unknown }>)[0].values);
  assert.equal(migrated.purchasableModels[0].componentSelections[0].componentId, "LEGACY-ROD");
  assert.equal(verifySnapshotIntegrity(migrated.configurationSnapshots[0]), true);
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});

test("AUD-024 v17 顺序迁移收敛拉力字段、归档旧 payload 且不改冻结 Snapshot", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 16;
  const sku = (legacy.skuDrawers as Array<Record<string, unknown>>)[0];
  const match = sku.projectionMatch as Record<string, unknown>;
  sku.targetWeightKg = sku.targetPullKg;
  delete sku.targetPullKg;
  match.targetWeightKg = match.targetPullKg;
  match.anchorWeightKg = match.matchedStructuralPullKg;
  match.weightDistance = match.pullDistance;
  delete match.targetPullKg;
  delete match.matchedStructuralPullKg;
  delete match.pullDistance;
  const projectionMatches = legacy.projectionMatches as Array<Record<string, unknown>>;
  projectionMatches.splice(0, projectionMatches.length, structuredClone(match));
  const series = (legacy.seriesDefinitions as Array<Record<string, unknown>>)[0];
  series.targetWeightsKg = [1.5, 1.8];
  const recipe = (legacy.candidateSearchRecipes as Array<Record<string, unknown>>)[0];
  recipe.targetWeightRangeKg = recipe.targetPullRangeKg;
  delete recipe.targetPullRangeKg;
  const affinityRule = (legacy.affinityRules as Array<Record<string, unknown>>).find((rule) => {
    const selector = rule.selector as Record<string, unknown>;
    return typeof selector.minPullKg === "number" || typeof selector.maxPullKg === "number";
  });
  if (affinityRule) {
    const selector = affinityRule.selector as Record<string, unknown>;
    selector.minWeightKg = selector.minPullKg;
    selector.maxWeightKg = selector.maxPullKg;
    delete selector.minPullKg;
    delete selector.maxPullKg;
  }

  const snapshots = legacy.configurationSnapshots as Array<Record<string, unknown>>;
  const frozenSnapshot = snapshots[0];
  const frozenMatch = frozenSnapshot.projectionMatch as Record<string, unknown>;
  frozenMatch.targetWeightKg = frozenMatch.targetPullKg;
  frozenMatch.anchorWeightKg = frozenMatch.matchedStructuralPullKg;
  frozenMatch.weightDistance = frozenMatch.pullDistance;
  delete frozenMatch.targetPullKg;
  delete frozenMatch.matchedStructuralPullKg;
  delete frozenMatch.pullDistance;
  delete frozenSnapshot.modelFinalPullKg;
  const { contentHash: _oldHash, ...frozenContent } = frozenSnapshot;
  void _oldHash;
  frozenSnapshot.contentHash = deterministicHash(frozenContent);
  const frozenBefore = structuredClone(frozenSnapshot);

  const once = migrateWorkspaceState(legacy);
  const twice = migrateWorkspaceState(once);
  const migratedSku = once.skuDrawers[0] as unknown as Record<string, unknown>;
  const migratedMatch = migratedSku.projectionMatch as Record<string, unknown>;
  assert.equal(once.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.equal(migratedSku.targetPullKg, 1.5);
  assert.equal(Object.hasOwn(migratedSku, "targetWeightKg"), false);
  assert.equal(migratedMatch.targetPullKg, 1.5);
  assert.equal(typeof migratedMatch.matchedStructuralPullKg, "number");
  assert.equal(typeof migratedMatch.pullDistance, "number");
  assert.equal(Object.hasOwn(migratedMatch, "targetWeightKg"), false);
  assert.equal(Object.hasOwn(migratedMatch, "anchorWeightKg"), false);
  assert.equal(Object.hasOwn(migratedMatch, "weightDistance"), false);
  assert.equal((once.candidateSearchRecipes[0] as unknown as Record<string, unknown>).targetPullRangeKg !== undefined, true);
  assert.equal(Object.hasOwn(once.seriesDefinitions[0] as unknown as object, "targetWeightsKg"), false);
  assert.ok(once.migrationReviewItems.some((item) =>
    item.id === `target-pull-migration:sku:${String(migratedSku.id)}`
    && (item.preservedPayload as Record<string, unknown>).targetWeightKg === 1.5));
  assert.deepEqual(once.configurationSnapshots[0], frozenBefore);
  assert.equal(once.configurationSnapshots[0].contentHash, frozenBefore.contentHash);
  assert.equal(verifySnapshotIntegrity(once.configurationSnapshots[0]), true);
  assert.deepEqual(twice, once);
});

test("AUD-024 迁移拒绝新旧拉力冲突与非正边界，不静默选值", () => {
  const conflicting = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  conflicting.schemaVersion = 16;
  const conflictingSku = (conflicting.skuDrawers as Array<Record<string, unknown>>)[0];
  conflictingSku.targetWeightKg = Number(conflictingSku.targetPullKg) + 0.1;
  assert.throws(
    () => migrateWorkspaceState(conflicting),
    /TARGET_PULL_MIGRATION_CONFLICT.*SKU/,
  );

  const invalid = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  invalid.schemaVersion = 16;
  const invalidSku = (invalid.skuDrawers as Array<Record<string, unknown>>)[0];
  delete invalidSku.targetPullKg;
  invalidSku.targetWeightKg = 0;
  assert.throws(
    () => migrateWorkspaceState(invalid),
    /TARGET_PULL_MIGRATION_INVALID.*SKU/,
  );
});
