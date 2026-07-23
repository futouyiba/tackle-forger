import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CURRENT_WORKSPACE_SCHEMA_VERSION,
  migrateWorkspaceState,
} from "../lib/migrations";
import { verifySnapshotIntegrity } from "../lib/publishing";
import { deterministicHash } from "../lib/rule-kernel";
import { validateSeriesInvariants } from "../lib/product-model";
import {
  createPartConstraintSetRevision,
  createNeedsReviewPartConstraintSet,
  partConstraintSourceContentHash,
  partConstraintSourceRevisionId,
  partConstraintSourceStableId,
  partConstraintSetContentHash,
  partConstraintSetRef,
  partConstraintSetBlockingTraceRefs,
  resolvePartConstraintSourceRevision,
  resolvePartConstraintSetRef,
} from "../lib/part-constraints";
import { createSeedState } from "../lib/seed";
import { ensureWorkflowFields } from "../lib/workflow";

function legacyV17ForPartConstraintMigration(): Record<string, unknown> {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 17;
  legacy.partConstraintSets = [];
  legacy.migrationReviewItems = (
    legacy.migrationReviewItems as Array<{ id: string }>
  ).filter((item) => !item.id.startsWith("part-constraint-set:"));
  for (const recipe of legacy.candidateSearchRecipes as Array<Record<string, unknown>>) {
    delete recipe.partConstraintSetRef;
  }
  for (const series of legacy.seriesDefinitions as Array<Record<string, unknown>>) {
    delete series.partConstraintSetRef;
  }
  return legacy;
}

test("legacy migration 不猜测 workspaceId，正式身份绑定留给存储/部署层", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  delete legacy.workspaceId;
  const migrated = migrateWorkspaceState(legacy);
  assert.equal(migrated.workspaceId, undefined);
});

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
  const legacy = legacyV17ForPartConstraintMigration();
  const recipes = legacy.recipes as Array<Record<string, unknown>>;
  const sourceRecipe = recipes[0];
  sourceRecipe.unknownLegacyField = { preserve: ["verbatim", 7] };
  const partConstraints = sourceRecipe.partConstraints as Record<string, Record<string, unknown>>;
  partConstraints.rod.unknownPartField = { preserve: true };
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
    ).sourceRef.sourceType,
    "candidate_search_recipe",
  );
  assert.notEqual(migratedRecipe.partConstraintSetRef.constraintSetId, constraintSetId);
  assert.equal(
    resolvePartConstraintSourceRevision(
      migrated.recipes,
      constraintSet.sourceRef,
    ).id,
    sourceRecipe.id,
  );
  for (const series of migrated.seriesDefinitions) {
    assert.ok(series.partConstraintSetRef);
    const seriesConstraint = resolvePartConstraintSetRef(
      migrated.partConstraintSets,
      series.partConstraintSetRef,
    );
    assert.equal(seriesConstraint.sourceRef.sourceType, "series_definition");
    assert.equal(seriesConstraint.reviewStatus, "NEEDS_REVIEW");
    assert.equal(
      resolvePartConstraintSourceRevision(
        migrated.seriesDefinitions,
        seriesConstraint.sourceRef,
      ).id,
      series.id,
    );
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

test("schema v18 保留非法部位容器并保持 NEEDS_REVIEW", () => {
  const legacy = legacyV17ForPartConstraintMigration();
  const recipes = legacy.recipes as Array<Record<string, unknown>>;
  const sourceRecipe = recipes[0];
  const partConstraints = sourceRecipe.partConstraints as Record<string, unknown>;
  partConstraints.rod = ["invalid", { preserve: true }];

  const migrated = migrateWorkspaceState(legacy);
  const constraintSet = migrated.partConstraintSets.find(
    (entry) => entry.sourceRef.sourceId === sourceRecipe.id,
  );
  assert.ok(constraintSet);
  assert.equal(constraintSet.parts.rod.reviewStatus, "NEEDS_REVIEW");
  assert.equal(
    constraintSet.migrationEvidence.diagnosticCodes.includes(
      "PART_CONSTRAINT_SOURCE_MISSING",
    ),
    true,
  );
  assert.deepEqual(
    (
      constraintSet.migrationEvidence.rawPayload as {
        partConstraints: { rod: unknown };
      }
    ).partConstraints.rod,
    ["invalid", { preserve: true }],
  );
});

test("schema v18 对复核项 ID 碰撞、错误 resolved 状态与重复记录 fail-closed", () => {
  const buildLegacy = () => {
    const legacy = legacyV17ForPartConstraintMigration();
    const recipe = (legacy.recipes as Array<Record<string, unknown>>)[0];
    const constraintSetId =
      `part-constraint-set:legacy-series-recipe:${encodeURIComponent(String(recipe.id))}`;
    return {
      legacy,
      recipe,
      reviewId: `${constraintSetId}:r1:review`,
    };
  };
  const conflict = buildLegacy();
  (conflict.legacy.migrationReviewItems as unknown[]).push({
    id: conflict.reviewId,
    sourceType: "series_recipe",
    sourceId: conflict.recipe.id,
    message: "collision",
    preservedPayload: { wrong: true },
    status: "resolved",
  });
  assert.throws(
    () => migrateWorkspaceState(conflict.legacy),
    /PART_CONSTRAINT_REVIEW_ITEM_CONFLICT/,
  );

  const duplicate = buildLegacy();
  const duplicateItem = {
    id: duplicate.reviewId,
    sourceType: "series_recipe",
    sourceId: duplicate.recipe.id,
    message: "duplicate",
    preservedPayload: {},
    status: "pending",
  };
  (duplicate.legacy.migrationReviewItems as unknown[]).push(
    duplicateItem,
    structuredClone(duplicateItem),
  );
  assert.throws(
    () => migrateWorkspaceState(duplicate.legacy),
    /PART_CONSTRAINT_REVIEW_ITEM_DUPLICATE/,
  );
});

test("schema v18 为已有 NEEDS_REVIEW ref 幂等补齐 pending 复核项", () => {
  const partial = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  partial.schemaVersion = 17;
  partial.migrationReviewItems = (
    partial.migrationReviewItems as Array<{ id: string }>
  ).filter((item) => !item.id.startsWith("part-constraint-set:"));
  const snapshotsBefore = structuredClone(partial.configurationSnapshots);

  const migrated = migrateWorkspaceState(partial);
  const needsReviewSets = migrated.partConstraintSets.filter(
    (constraintSet) => constraintSet.reviewStatus === "NEEDS_REVIEW",
  );
  const expectedReviewIds = new Set(
    needsReviewSets.map(
      (constraintSet) =>
        `${constraintSet.constraintSetId}:r${constraintSet.revision}:review`,
    ),
  );
  const actualReviewItems = migrated.migrationReviewItems.filter(
    (item) => expectedReviewIds.has(item.id),
  );

  assert.equal(actualReviewItems.length, expectedReviewIds.size);
  assert.equal(actualReviewItems.every((item) => item.status === "pending"), true);
  for (const constraintSet of needsReviewSets) {
    const item = actualReviewItems.find(
      (entry) =>
        entry.id
        === `${constraintSet.constraintSetId}:r${constraintSet.revision}:review`,
    );
    assert.ok(item);
    assert.deepEqual(
      (item.preservedPayload as { partConstraintSetRef: unknown })
        .partConstraintSetRef,
      partConstraintSetRef(constraintSet),
    );
  }
  assert.deepEqual(migrated.configurationSnapshots, snapshotsBefore);
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});

test("schema v18 对 00ff558 部分规范化约束集显式 fail-closed", () => {
  const fixtureUrl = new URL(
    "./fixtures/part-constraint-set-schema-v17-00ff558.json",
    import.meta.url,
  );
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(fixtureUrl), "utf8"),
  ) as {
    source: Record<string, unknown>;
    constraintSet: Record<string, unknown>;
  };
  const sourceRef = fixture.constraintSet.sourceRef as Record<string, unknown>;
  sourceRef.contentHash = deterministicHash(
    Object.fromEntries(
      Object.entries(fixture.source).filter(
        ([field]) => field !== "partConstraintSetRef",
      ),
    ),
  );
  for (const trace of fixture.constraintSet.traces as Array<Record<string, unknown>>) {
    (trace.sourceRef as Record<string, unknown>).contentHash = sourceRef.contentHash;
  }
  const { contentHash: _contentHash, ...constraintContent } = fixture.constraintSet;
  void _contentHash;
  fixture.constraintSet.contentHash = deterministicHash(constraintContent);
  const legacy = legacyV17ForPartConstraintMigration();
  legacy.partConstraintSets = [fixture.constraintSet];
  const before = structuredClone(legacy);

  assert.throws(
    () => migrateWorkspaceState(legacy),
    /PART_CONSTRAINT_SET_V17_NORMALIZATION_REQUIRED.*00ff558/,
  );
  assert.deepEqual(legacy, before);
});

test("schema v18 对既有 hash 一致约束集的 migrationEvidence 完整校验且不改写输入", () => {
  const cases: Array<{
    name: string;
    status: "CONFIRMED" | "NEEDS_REVIEW";
    referenced: boolean;
    mutate: (constraintSet: Record<string, unknown>) => void;
  }> = [
    {
      name: "confirmed unreferenced missing evidence",
      status: "CONFIRMED",
      referenced: false,
      mutate: (constraintSet) => {
        (constraintSet.migrationEvidence as Record<string, unknown>).migratorVersion = "";
      },
    },
    {
      name: "referenced needs-review invalid evidence",
      status: "NEEDS_REVIEW",
      referenced: true,
      mutate: (constraintSet) => {
        (constraintSet.migrationEvidence as Record<string, unknown>).sourceSchemaVersion = 0;
      },
    },
    {
      name: "non-integer source schema version",
      status: "NEEDS_REVIEW",
      referenced: true,
      mutate: (constraintSet) => {
        (constraintSet.migrationEvidence as Record<string, unknown>).sourceSchemaVersion = 17.5;
      },
    },
    {
      name: "blank migrated-at",
      status: "NEEDS_REVIEW",
      referenced: true,
      mutate: (constraintSet) => {
        (constraintSet.migrationEvidence as Record<string, unknown>).migratedAt = " ";
      },
    },
    {
      name: "unparseable migrated-at",
      status: "NEEDS_REVIEW",
      referenced: true,
      mutate: (constraintSet) => {
        (constraintSet.migrationEvidence as Record<string, unknown>).migratedAt = "not-a-date";
      },
    },
    {
      name: "missing raw payload field",
      status: "NEEDS_REVIEW",
      referenced: true,
      mutate: (constraintSet) => {
        delete (constraintSet.migrationEvidence as Record<string, unknown>).rawPayload;
      },
    },
    {
      name: "invalid diagnostics container",
      status: "NEEDS_REVIEW",
      referenced: true,
      mutate: (constraintSet) => {
        (constraintSet.migrationEvidence as Record<string, unknown>).diagnosticCodes = ["ok", 7];
      },
    },
    {
      name: "missing evidence object cannot throw a TypeError",
      status: "NEEDS_REVIEW",
      referenced: true,
      mutate: (constraintSet) => { constraintSet.migrationEvidence = null; },
    },
  ];

  for (const entry of cases) {
    const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 17;
    const constraintSet = (legacy.partConstraintSets as Array<Record<string, unknown>>)[0]!;
    constraintSet.reviewStatus = entry.status;
    const parts = constraintSet.parts as Record<string, Record<string, unknown>>;
    const traces = constraintSet.traces as Array<Record<string, unknown>>;
    for (const part of Object.values(parts)) part.reviewStatus = entry.status;
    for (const trace of traces) trace.reviewStatus = entry.status;
    if (!entry.referenced) {
      for (const consumer of [
        ...(legacy.candidateSearchRecipes as Array<Record<string, unknown>>),
        ...(legacy.seriesDefinitions as Array<Record<string, unknown>>),
      ]) {
        delete consumer.partConstraintSetRef;
      }
    }
    entry.mutate(constraintSet);
    constraintSet.contentHash = partConstraintSetContentHash(constraintSet as never);
    const before = structuredClone(legacy);

    assert.throws(
      () => migrateWorkspaceState(legacy),
      /PART_CONSTRAINT_SET_V17_NORMALIZATION_REQUIRED/,
      entry.name,
    );
    assert.deepEqual(legacy, before, entry.name);
  }
});

test("schema v18 允许 migrationEvidence.rawPayload 为 null，只要求字段存在", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 17;
  const series = (legacy.seriesDefinitions as Array<Record<string, unknown>>)[0]!;
  const sourceRef = {
    sourceType: "series_definition" as const,
    sourceId: partConstraintSourceStableId(series, "series_definition"),
    revisionId: partConstraintSourceRevisionId(series),
    hashProjectionVersion: "WITHOUT_PART_CONSTRAINT_SET_REF_V1" as const,
    contentHash: partConstraintSourceContentHash(series),
  };
  const constraintSet = createNeedsReviewPartConstraintSet({
    constraintSetId: "part-constraint-set:null-raw-payload",
    sourceRef,
    rawPayload: null,
    sourceSchemaVersion: 17,
    migratedAt: "2026-07-23T00:00:00.000Z",
  });
  legacy.partConstraintSets = [constraintSet];
  series.partConstraintSetRef = partConstraintSetRef(constraintSet);
  for (const recipe of legacy.candidateSearchRecipes as Array<Record<string, unknown>>) {
    delete recipe.partConstraintSetRef;
  }
  const migrated = migrateWorkspaceState(legacy);
  assert.equal(migrated.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.equal(
    migrated.partConstraintSets.find((entry) =>
      entry.constraintSetId === constraintSet.constraintSetId,
    )?.migrationEvidence.rawPayload,
    null,
  );
});

test("PartConstraintSet 稳定 ref 对缺失、重复、篡改或 hash 不符均 fail-closed", () => {
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
  const tampered = structuredClone(constraintSet);
  tampered.parts.rod.templateIds.push("template:tampered");
  assert.throws(
    () => resolvePartConstraintSetRef(
      [tampered],
      partConstraintSetRef(constraintSet),
    ),
    /PART_CONSTRAINT_SET_CONTENT_TAMPERED/,
  );
  assert.throws(
    () => resolvePartConstraintSetRef(
      [constraintSet, structuredClone(constraintSet)],
      partConstraintSetRef(constraintSet),
    ),
    /PART_CONSTRAINT_SET_REVISION_DUPLICATE/,
  );
});

test("schema v18 拒绝把已有 PartConstraintSet ref 复用于另一位 Series 或 Recipe 消费者", () => {
  const crossRecipe = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  crossRecipe.schemaVersion = 17;
  const recipes = crossRecipe.candidateSearchRecipes as Array<Record<string, unknown>>;
  const sourceRecipe = recipes[0]!;
  recipes.push({
    ...structuredClone(sourceRecipe),
    id: "candidate-recipe:other-consumer",
  });
  assert.throws(
    () => migrateWorkspaceState(crossRecipe),
    /PART_CONSTRAINT_SET_SOURCE_REF_MISMATCH/,
  );

  const crossSeries = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  crossSeries.schemaVersion = 17;
  const series = (crossSeries.seriesDefinitions as Array<Record<string, unknown>>)[0]!;
  const recipe = (crossSeries.candidateSearchRecipes as Array<Record<string, unknown>>)[0]!;
  series.partConstraintSetRef = structuredClone(recipe.partConstraintSetRef);
  assert.throws(
    () => migrateWorkspaceState(crossSeries),
    /PART_CONSTRAINT_SET_SOURCE_REF_MISMATCH/,
  );
});

test("schema v18 拒绝字段容器或 set/part/trace 状态枚举非法的 v17 规范对象", () => {
  const cases: Array<{
    mutate: (constraintSet: Record<string, unknown>) => void;
    error: RegExp;
  }> = [
    {
      mutate: (constraintSet) => {
        constraintSet.constraintSetId = " ";
      },
      error: /PART_CONSTRAINT_SET_ID_INVALID/,
    },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((revision) => ({
      mutate: (constraintSet: Record<string, unknown>) => {
        constraintSet.revision = revision;
      },
      error: /PART_CONSTRAINT_SET_REVISION_INVALID/,
    })),
    {
      mutate: (constraintSet) => {
        const parts = constraintSet.parts as Record<string, Record<string, unknown>>;
        parts.rod.templateIds = "template:not-an-array";
      },
      error: /PART_CONSTRAINT_FIELD_VALUES_INVALID/,
    },
    {
      mutate: (constraintSet) => {
        const parts = constraintSet.parts as Record<string, Record<string, unknown>>;
        parts.rod.templateIds = ["template:ok", 7];
      },
      error: /PART_CONSTRAINT_FIELD_VALUES_INVALID/,
    },
    {
      mutate: (constraintSet) => {
        constraintSet.reviewStatus = "INVALID";
      },
      error: /PART_CONSTRAINT_REVIEW_STATUS_INVALID/,
    },
    {
      mutate: (constraintSet) => {
        const parts = constraintSet.parts as Record<string, Record<string, unknown>>;
        parts.rod.reviewStatus = "INVALID";
      },
      error: /PART_CONSTRAINT_REVIEW_STATUS_INVALID/,
    },
    {
      mutate: (constraintSet) => {
        const traces = constraintSet.traces as Array<Record<string, unknown>>;
        traces[0].reviewStatus = "INVALID";
      },
      error: /PART_CONSTRAINT_REVIEW_STATUS_INVALID/,
    },
  ];

  for (const entry of cases) {
    const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 17;
    const constraintSet = (
      legacy.partConstraintSets as Array<Record<string, unknown>>
    )[0];
    entry.mutate(constraintSet);
    constraintSet.contentHash = partConstraintSetContentHash(
      constraintSet as never,
    );
    const before = structuredClone(legacy);
    assert.throws(() => migrateWorkspaceState(legacy), entry.error);
    assert.deepEqual(legacy, before);
  }
});

test("合成来源身份对缺失或空白 ID、非法 revision 可回读，重复身份 fail-closed", () => {
  for (const id of [undefined, ""]) {
    const source = {
      id,
      revision: { invalid: true },
      name: "anonymous-series",
    };
    const sourceId = partConstraintSourceStableId(source, "series_definition");
    const ref = {
      sourceType: "series_definition" as const,
      sourceId,
      revisionId: partConstraintSourceRevisionId(source),
      hashProjectionVersion: "WITHOUT_PART_CONSTRAINT_SET_REF_V1" as const,
      contentHash: partConstraintSourceContentHash(source),
    };
    assert.equal(ref.revisionId, null);
    assert.equal(resolvePartConstraintSourceRevision([source], ref), source);
    assert.throws(
      () => resolvePartConstraintSourceRevision(
        [source, structuredClone(source)],
        ref,
      ),
      /PART_CONSTRAINT_SOURCE_REVISION_DUPLICATE/,
    );
  }

  const legacy = legacyV17ForPartConstraintMigration();
  const series = legacy.seriesDefinitions as Array<Record<string, unknown>>;
  delete series[0].id;
  series[0].revision = { invalid: true };
  const migrated = migrateWorkspaceState(legacy);
  const migratedSeries = migrated.seriesDefinitions[0] as unknown as Record<string, unknown>;
  const constraintSet = resolvePartConstraintSetRef(
    migrated.partConstraintSets,
    migratedSeries.partConstraintSetRef as never,
  );
  assert.equal(
    resolvePartConstraintSourceRevision(
      migrated.seriesDefinitions,
      constraintSet.sourceRef,
    ),
    migrated.seriesDefinitions[0],
  );

  const duplicateLegacy = legacyV17ForPartConstraintMigration();
  const duplicateSeries = duplicateLegacy.seriesDefinitions as Array<Record<string, unknown>>;
  const anonymous = structuredClone(duplicateSeries[0]);
  delete anonymous.id;
  anonymous.revision = { invalid: true };
  duplicateLegacy.seriesDefinitions = [
    structuredClone(anonymous),
    structuredClone(anonymous),
  ];
  assert.throws(
    () => migrateWorkspaceState(duplicateLegacy),
    /PART_CONSTRAINT_SOURCE_REVISION_DUPLICATE/,
  );
});

test("人工确认创建单调新 PartConstraintSet revision 且不改写旧 revision", () => {
  const current = structuredClone(createSeedState().partConstraintSets[0]);
  const original = structuredClone(current);
  const parts = structuredClone(current.parts);
  const traces = structuredClone(current.traces);
  for (const part of Object.values(parts)) part.reviewStatus = "CONFIRMED";
  for (const trace of traces) trace.reviewStatus = "CONFIRMED";

  const next = createPartConstraintSetRevision({
    current,
    expectedCurrentRef: partConstraintSetRef(current),
    parts,
    traces,
    sourceRef: current.sourceRef,
    createdBy: "reviewer:test",
    createdAt: "2026-07-23T12:00:00.000Z",
  });

  assert.equal(next.constraintSetId, current.constraintSetId);
  assert.equal(next.revision, current.revision + 1);
  assert.equal(next.reviewStatus, "CONFIRMED");
  assert.equal(next.traces.length, 15);
  assert.equal(
    new Set(next.traces.map((trace) => `${trace.itemPartId}:${trace.field}`)).size,
    15,
  );
  assert.equal(
    next.traces.every((trace) =>
      trace.traceId.includes(
        `${next.constraintSetId}:r${next.revision}:trace:`,
      )
    ),
    true,
  );
  assert.equal(
    Object.values(next.parts).every((part) =>
      Object.values(part.fieldTraceRefs).every((traceRef) =>
        traceRef.includes(
          `${next.constraintSetId}:r${next.revision}:trace:`,
        )
      )
    ),
    true,
  );
  assert.equal(
    resolvePartConstraintSetRef([next], partConstraintSetRef(next)),
    next,
  );
  assert.deepEqual(current, original);
});

test("新 PartConstraintSet revision 拒绝 Trace 映射或复核状态矛盾", () => {
  const current = structuredClone(createSeedState().partConstraintSets[0]);
  const confirmedParts = structuredClone(current.parts);
  for (const part of Object.values(confirmedParts)) {
    part.reviewStatus = "CONFIRMED";
  }
  const baseInput = {
    current,
    expectedCurrentRef: partConstraintSetRef(current),
    parts: confirmedParts,
    traces: structuredClone(current.traces),
    sourceRef: current.sourceRef,
    createdBy: "reviewer:test",
    createdAt: "2026-07-23T12:00:00.000Z",
  };
  assert.throws(
    () => createPartConstraintSetRevision(baseInput),
    /PART_CONSTRAINT_PART_REVIEW_STATUS_MISMATCH/,
  );

  const confirmedTraces = structuredClone(current.traces);
  for (const trace of confirmedTraces) trace.reviewStatus = "CONFIRMED";
  confirmedTraces[1].traceId = confirmedTraces[0].traceId;
  assert.throws(
    () => createPartConstraintSetRevision({
      ...baseInput,
      traces: confirmedTraces,
    }),
    /PART_CONSTRAINT_TRACE_ID_DUPLICATE/,
  );
});

test("新 PartConstraintSet revision 拒绝非法当前身份或 revision", () => {
  for (const mutation of [
    (current: Record<string, unknown>) => {
      current.constraintSetId = "";
    },
    (current: Record<string, unknown>) => {
      current.revision = 0;
    },
    (current: Record<string, unknown>) => {
      current.revision = -1;
    },
    (current: Record<string, unknown>) => {
      current.revision = 1.5;
    },
    (current: Record<string, unknown>) => {
      current.revision = Number.MAX_SAFE_INTEGER + 1;
    },
  ]) {
    const current = structuredClone(
      createSeedState().partConstraintSets[0],
    ) as unknown as Record<string, unknown>;
    mutation(current);
    current.contentHash = partConstraintSetContentHash(current as never);
    const typedCurrent = current as unknown as ReturnType<
      typeof createSeedState
    >["partConstraintSets"][number];
    assert.throws(
      () => createPartConstraintSetRevision({
        current: typedCurrent,
        expectedCurrentRef: partConstraintSetRef(typedCurrent),
        parts: structuredClone(typedCurrent.parts),
        traces: structuredClone(typedCurrent.traces),
        sourceRef: structuredClone(typedCurrent.sourceRef),
        createdBy: "reviewer:test",
        createdAt: "2026-07-23T12:00:00.000Z",
      }),
      /PART_CONSTRAINT_SET_(?:ID|REVISION)_INVALID/,
    );
  }
});

test("D-02 OfficialSku 无损迁移为抽屉、默认 Model 与冻结快照", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 2;
  legacy.collections = [];
  legacy.seriesDefinitions = [];
  legacy.partConstraintSets = [];
  legacy.candidateSearchRecipes = [];
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

test("schema v17 归一化归档仅在 SKU 内嵌的历史 ProjectionMatch 字段", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 17;
  const sku = (legacy.skuDrawers as Array<Record<string, unknown>>)[0];
  const match = sku.projectionMatch as Record<string, unknown>;
  match.targetWeightKg = match.targetPullKg;
  match.anchorWeightKg = match.matchedStructuralPullKg;
  match.weightDistance = match.pullDistance;
  delete match.targetPullKg;
  delete match.matchedStructuralPullKg;
  delete match.pullDistance;
  legacy.projectionMatches = [];

  const migrated = migrateWorkspaceState(legacy);
  const migratedMatch = migrated.skuDrawers[0].projectionMatch as unknown as Record<string, unknown>;
  const archived = migrated.migrationReviewItems.find((item) =>
    item.id === `target-pull-migration:sku-projection-match:${migrated.skuDrawers[0].id}`);
  assert.equal(migratedMatch.targetPullKg, 1.5);
  assert.equal(Object.hasOwn(migratedMatch, "targetWeightKg"), false);
  assert.deepEqual(archived?.preservedPayload, match);
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
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
  const legacyConstraintSet = migrated.partConstraintSets.find(
    (entry) => entry.sourceRef.sourceId === "recipe:production-redacted",
  );
  assert.ok(legacyConstraintSet);
  const rodTypeTrace = legacyConstraintSet.traces.find(
    (trace) => trace.itemPartId === "part:rod" && trace.field === "typeIds",
  );
  assert.ok(rodTypeTrace);
  assert.equal(rodTypeTrace.sourcePath, "$.structureIds");
  assert.deepEqual(rodTypeTrace.rawPayload, ["structure:production-redacted"]);
  assert.deepEqual(rodTypeTrace.transformationCodes, [
    "COPY_LEGACY_FLAT_FIELD_TO_PART",
    "RENAME_STRUCTURE_IDS_TO_TYPE_IDS",
  ]);
  const rodMaterialTrace = legacyConstraintSet.traces.find(
    (trace) => trace.itemPartId === "part:rod" && trace.field === "materialIds",
  );
  assert.ok(rodMaterialTrace);
  assert.equal(rodMaterialTrace.sourcePath, "$");
  assert.deepEqual(
    rodMaterialTrace.transformationCodes,
    ["SYNTHESIZE_EMPTY_MATERIAL_IDS"],
  );
  assert.equal(
    (
      legacyConstraintSet.migrationEvidence.rawPayload as {
        legacyUnknownConstraintPayload: { preserve: boolean };
      }
    ).legacyUnknownConstraintPayload.preserve,
    true,
  );
  assert.equal(
    resolvePartConstraintSourceRevision(
      migrated.recipes,
      legacyConstraintSet.sourceRef,
    ).id,
    "recipe:production-redacted",
  );
  assert.deepEqual((migrated as unknown as Record<string, unknown>).legacyImportedField, { source: "production-redacted", preserve: true });
  assert.deepEqual(sku.legacySkuMetadata, { preserve: true });
  assert.deepEqual(migrated.configurationSnapshots[0], snapshotBefore);
  assert.equal(migrated.configurationSnapshots[0].contentHash, "sha256:production-published-snapshot-redacted");
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});

test("schema v18 补齐 AI 草稿、永久来源同步与 PerformanceSummary 定义注册表", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 17;
  delete legacy.aiRuleSourceChangeDrafts;
  delete legacy.aiArtifactProvenanceSyncRecords;
  delete legacy.performanceSummaryDefinitions;
  const snapshotsBefore = structuredClone(legacy.configurationSnapshots);

  const migrated = migrateWorkspaceState(legacy);
  assert.equal(migrated.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.deepEqual(migrated.aiRuleSourceChangeDrafts, []);
  assert.deepEqual(migrated.aiArtifactProvenanceSyncRecords, []);
  assert.deepEqual(migrated.performanceSummaryDefinitions, []);
  assert.deepEqual(migrated.configurationSnapshots, snapshotsBefore);
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});

test("已标记 schema v18 的分支形态会互补缺失集合且保持 Snapshot 冻结", () => {
  const withoutPerformance = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  withoutPerformance.schemaVersion = CURRENT_WORKSPACE_SCHEMA_VERSION;
  delete withoutPerformance.performanceSummaryDefinitions;
  const withoutAI = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  withoutAI.schemaVersion = CURRENT_WORKSPACE_SCHEMA_VERSION;
  delete withoutAI.aiRuleSourceChangeDrafts;
  delete withoutAI.aiArtifactProvenanceSyncRecords;
  const snapshotsBefore = structuredClone(withoutAI.configurationSnapshots);

  const performanceMigrated = migrateWorkspaceState(withoutPerformance);
  const aiMigrated = migrateWorkspaceState(withoutAI);
  assert.deepEqual(performanceMigrated.performanceSummaryDefinitions, []);
  assert.deepEqual(aiMigrated.aiRuleSourceChangeDrafts, []);
  assert.deepEqual(aiMigrated.aiArtifactProvenanceSyncRecords, []);
  assert.deepEqual(aiMigrated.configurationSnapshots, snapshotsBefore);
  assert.deepEqual(migrateWorkspaceState(performanceMigrated), performanceMigrated);
  assert.deepEqual(migrateWorkspaceState(aiMigrated), aiMigrated);
});
