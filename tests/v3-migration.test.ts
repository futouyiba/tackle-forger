import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CURRENT_WORKSPACE_SCHEMA_VERSION, migrateWorkspaceState } from "../lib/migrations";
import { verifySnapshotIntegrity } from "../lib/publishing";
import { deterministicHash } from "../lib/rule-kernel";
import { validateSeriesInvariants } from "../lib/product-model";
import {
  partConstraintSetBlockingTraceRefs,
  resolvePartConstraintSetRef,
} from "../lib/part-constraints";
import { createSeedState } from "../lib/seed";
import { ensureWorkflowFields } from "../lib/workflow";

test("v16 隔离旧独立偏移阈值、发布规范策略且不改写历史 Snapshot", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 15;
  const settings = legacy.ruleSettings as { patchOffsetLimits: { warning?: number; error?: number } };
  settings.patchOffsetLimits = { warning: 0.2, error: 0.4 };
  legacy.workspacePolicies = (legacy.workspacePolicies as Array<{ policyType: string }>)
    .filter((entry) => entry.policyType !== "patchOffsetPolicy");
  delete legacy.patchReviewBatches;
  delete legacy.patchValidationWaivers;
  delete legacy.patchValidationWaiverDecisions;
  const snapshotsBefore = structuredClone(legacy.configurationSnapshots);

  const migrated = migrateWorkspaceState(legacy);
  assert.equal(migrated.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.deepEqual(migrated.ruleSettings.patchOffsetLimits, {});
  assert.ok(migrated.patchLedger.migrationReviewItems.some((entry) =>
    entry.reason === "LEGACY_PATCH_OFFSET_THRESHOLDS_QUARANTINED"
    && (entry.preservedPayload as { warning: number }).warning === 0.2));
  assert.equal(
    migrated.workspacePolicies.filter((entry) =>
      entry.policyType === "patchOffsetPolicy" && entry.status === "published").length,
    1,
  );
  assert.deepEqual(migrated.patchReviewBatches, []);
  assert.deepEqual(migrated.patchValidationWaivers, []);
  assert.deepEqual(migrated.patchValidationWaiverDecisions, []);
  assert.deepEqual(migrated.configurationSnapshots, snapshotsBefore);
  assert.ok(migrated.configurationSnapshots.every(verifySnapshotIntegrity));
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});

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

test("schema v18 无损迁移旧 SeriesRecipe 为稳定 PartConstraintSet 且重复执行幂等", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 17;
  legacy.partConstraintSets = [];
  const recipes = legacy.recipes as Array<Record<string, unknown>>;
  const sourceRecipe = recipes[0];
  sourceRecipe.unknownLegacyField = { preserve: ["verbatim", 7] };
  const partConstraints = sourceRecipe.partConstraints as Record<string, Record<string, unknown>>;
  partConstraints.rod.unknownPartField = { preserve: true };
  for (const recipe of legacy.candidateSearchRecipes as Array<Record<string, unknown>>) {
    delete recipe.partConstraintSetRef;
  }
  for (const series of legacy.seriesDefinitions as Array<Record<string, unknown>>) {
    delete series.partConstraintSetRef;
  }
  const snapshotBefore = structuredClone(
    (legacy.configurationSnapshots as Array<Record<string, unknown>>)[0],
  );

  const migrated = migrateWorkspaceState(legacy);
  const constraintSetId =
    `part-constraint-set:legacy-series-recipe:${encodeURIComponent(String(sourceRecipe.id))}`;
  const constraintSet = migrated.partConstraintSets.find(
    (entry) => entry.constraintSetId === constraintSetId,
  );
  assert.ok(constraintSet);
  assert.equal(constraintSet.revision, 1);
  assert.equal(constraintSet.sourceRef.revisionId, null);
  assert.equal(constraintSet.reviewStatus, "NEEDS_REVIEW");
  assert.deepEqual(
    Object.values(constraintSet.parts).map((part) => part.reviewStatus),
    ["NEEDS_REVIEW", "NEEDS_REVIEW", "NEEDS_REVIEW"],
  );
  assert.deepEqual(
    (constraintSet.migrationEvidence.rawPayload as Record<string, unknown>).unknownLegacyField,
    { preserve: ["verbatim", 7] },
  );
  assert.equal(
    constraintSet.migrationEvidence.diagnosticCodes.includes(
      "UNKNOWN_PART_FIELDS_PRESERVED_RAW",
    ),
    true,
  );
  assert.equal(partConstraintSetBlockingTraceRefs(constraintSet).length, 15);
  for (const part of Object.values(constraintSet.parts)) {
    for (const traceRef of Object.values(part.fieldTraceRefs)) {
      assert.equal(
        constraintSet.traces.some((trace) => trace.traceId === traceRef),
        true,
      );
    }
  }
  const { contentHash, ...content } = constraintSet;
  assert.equal(contentHash, deterministicHash(content));

  const migratedRecipe = migrated.candidateSearchRecipes.find(
    (entry) => entry.sourceLegacyRecipeId === sourceRecipe.id,
  );
  assert.ok(migratedRecipe?.partConstraintSetRef);
  assert.equal(
    resolvePartConstraintSetRef(
      migrated.partConstraintSets,
      migratedRecipe.partConstraintSetRef,
    ).constraintSetId,
    constraintSetId,
  );
  for (const series of migrated.seriesDefinitions) {
    assert.ok(series.partConstraintSetRef);
    const seriesConstraint = resolvePartConstraintSetRef(
      migrated.partConstraintSets,
      series.partConstraintSetRef,
    );
    assert.equal(seriesConstraint.sourceRef.sourceType, "series_definition");
    assert.equal(seriesConstraint.reviewStatus, "NEEDS_REVIEW");
  }
  assert.equal(
    migrated.migrationReviewItems.some(
      (item) =>
        item.sourceType === "series_recipe"
        && item.sourceId === sourceRecipe.id
        && item.status === "pending",
    ),
    true,
  );
  assert.deepEqual(migrated.configurationSnapshots[0], snapshotBefore);
  assert.equal(
    deterministicHash(migrated.configurationSnapshots[0]),
    deterministicHash(snapshotBefore),
  );
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});

test("PartConstraintSet 稳定 ref 不存在或 hash 不符时 fail-closed", () => {
  const state = createSeedState();
  const constraintSet = state.partConstraintSets[0];
  assert.ok(constraintSet);
  assert.throws(
    () => resolvePartConstraintSetRef(state.partConstraintSets, {
      constraintSetId: constraintSet.constraintSetId,
      revision: constraintSet.revision + 1,
      contentHash: constraintSet.contentHash,
    }),
    /PART_CONSTRAINT_SET_REF_NOT_FOUND/,
  );
  assert.throws(
    () => resolvePartConstraintSetRef(state.partConstraintSets, {
      constraintSetId: constraintSet.constraintSetId,
      revision: constraintSet.revision,
      contentHash: "sha256:not-the-content",
    }),
    /PART_CONSTRAINT_SET_HASH_MISMATCH/,
  );
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
  const snapshotBefore = structuredClone((legacy.configurationSnapshots as Array<Record<string, unknown>>)[0]);

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

test("脱敏生产 schema v17 形态可直接读取，未知字段与已发布 Snapshot 完全冻结", () => {
  const fixtureUrl = new URL("./fixtures/workspace-production-schema-v17.json", import.meta.url);
  const productionShape = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8")) as Record<string, unknown>;
  const snapshotBefore = structuredClone((productionShape.configurationSnapshots as unknown[])[0]);
  const migrated = ensureWorkflowFields(productionShape as never);
  const sku = migrated.skuDrawers[0] as unknown as Record<string, unknown>;
  const projectionMatch = sku.projectionMatch as Record<string, unknown>;

  assert.equal(migrated.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.equal(sku.targetPullKg, 3.6);
  assert.equal(Object.hasOwn(sku, "targetWeightKg"), false);
  assert.equal(projectionMatch.targetPullKg, 3.6);
  assert.equal(Object.hasOwn(projectionMatch, "targetWeightKg"), false);
  assert.deepEqual(migrated.seriesDefinitions[0].targetPullSpecifications, [{ targetPullKgf: 3.6, skuId: "sku:production-redacted" }]);
  assert.equal(validateSeriesInvariants({ series: migrated.seriesDefinitions[0], skus: migrated.skuDrawers, models: [], projections: [] }).some((issue) => issue.code === "SERIES_PULL_SPECIFICATION_MISSING"), false);
  assert.deepEqual((migrated as unknown as Record<string, unknown>).legacyImportedField, { source: "production-redacted", preserve: true });
  assert.deepEqual(sku.legacySkuMetadata, { preserve: true });
  assert.deepEqual(migrated.configurationSnapshots[0], snapshotBefore);
  assert.equal(migrated.configurationSnapshots[0].contentHash, "sha256:production-published-snapshot-redacted");
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});
