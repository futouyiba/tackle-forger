import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_WORKSPACE_SCHEMA_VERSION, migrateWorkspaceState } from "../lib/migrations";
import { deterministicHash } from "../lib/rule-kernel";
import { verifySnapshotIntegrity } from "../lib/publishing";
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

test("schema v17 迁移仅适配活动对象的历史拉力字段，冻结快照保持逐字节不变", () => {
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
  const snapshot = (legacy.configurationSnapshots as Array<Record<string, unknown>>)[0];
  const snapshotBefore = structuredClone(snapshot);

  const migrated = migrateWorkspaceState(legacy);
  const migratedSku = migrated.skuDrawers[0] as unknown as Record<string, unknown>;
  assert.equal(migrated.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.equal(migratedSku.targetPullKg, 1.5);
  assert.equal(Object.hasOwn(migratedSku, "targetWeightKg"), false);
  assert.equal(Object.hasOwn(migratedSku.projectionMatch as object, "targetWeightKg"), false);
  assert.deepEqual(migrated.configurationSnapshots[0], snapshotBefore);
  assert.equal(deterministicHash(migrated.configurationSnapshots[0]), deterministicHash(snapshotBefore));
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});

test("schema v17 迁移拒绝矛盾的目标拉力，绝不静默择一", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 16;
  const sku = (legacy.skuDrawers as Array<Record<string, unknown>>)[0];
  sku.targetWeightKg = Number(sku.targetPullKg) + 0.1;
  assert.throws(() => migrateWorkspaceState(legacy), /TARGET_PULL_MIGRATION_CONFLICT.*SKU/);
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
