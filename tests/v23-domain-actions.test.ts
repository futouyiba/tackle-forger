import assert from "node:assert/strict";
import test from "node:test";
import { jcsSha256Hex } from "../lib/canonical-json";
import { createSeedState } from "../lib/seed";
import {
  executeV23DomainAction,
  previewWeightBandSkus,
  v23ActionInputHash,
  V23DomainActionError,
  type V23WriteAction,
} from "../lib/v23-domain-actions";
import { ensureWorkflowFields } from "../lib/workflow";
import type { WorkspaceState } from "../lib/types";
import {
  importReductionStackingPolicyDraft,
  publishReductionStackingPolicyVersion,
} from "../lib/reduction-stacking-policy";
import { importQualityValuePolicyDraft } from "../lib/quality-value-policy";

const templateKey = {
  partType: "rod" as const,
  weightBandId: "band:light",
  fishingMethodId: "method:lure",
  materialTypeId: "material:carbon",
  functionProfileId: "function:cast",
  functionIntensity: 2 as const,
};

function publishedPolicy(sourceRevision: string) {
  return publishReductionStackingPolicyVersion({
    draft: importReductionStackingPolicyDraft({
      sourceRevision: {
        id: `source:${sourceRevision}`,
        workbookRefId: "feishu-workbook:tackle-design",
        sourceRevision,
        sheets: [{ sheetId: "23CsXE" }],
      } as never,
      machineRules: [{
        ruleId: "pull",
        parameterKey: "pull",
        strategy: "bidirectional_ratio",
        numericContract: "ieee754-binary64-v1",
        operationOrder: [
          "set", "percent_adjust", "flat_adjust", "clamp_add",
          "final_review_patch", "parameter_definition",
        ],
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    publishedAt: "2026-01-01T00:00:00.000Z",
    publishedBy: "test",
  });
}

function state(): WorkspaceState {
  const value = createSeedState({ mode: "production" });
  value.v23SeriesPartRevisions = [];
  value.v23SeriesPartHeads = [];
  value.v23SkuDrawerRevisions = [];
  value.v23SkuDrawerHeads = [];
  value.v23AffixDefinitions = [];
  value.v23MigrationSourceEvidence = [];
  value.v23LegacyReadAdapters = [];
  value.v23FunctionTemplates = [{
    ref: {
      templateId: "template:light",
      revisionId: "revision:1",
      contentHash: jcsSha256Hex({
        contractVersion: "v23-function-template/v1",
        key: templateKey,
        baselinePullKg: 5,
      }),
    },
    key: templateKey,
    baselinePullKg: 5,
  }];
  value.reductionStackingPolicyVersions = [publishedPolicy("99")];
  return ensureWorkflowFields(value);
}

function qualityReadyState(): WorkspaceState {
  const value = state();
  value.qualityValuePolicyDrafts = [importQualityValuePolicyDraft({
    sourceRevisionId: "source:quality@500",
    sourceRevision: "500",
    ranges: [
      { qualityId: "quality_c_green", minScore: 0, maxScore: 20, maxInclusive: false, source: { sheetId: "27hboC", cell: "B2" }, status: "SOURCE" },
      { qualityId: "quality_b_blue", minScore: 20, maxScore: 40, maxInclusive: false, source: { sheetId: "27hboC", cell: "B3" }, status: "SOURCE" },
      { qualityId: "quality_a_purple", minScore: 40, maxScore: 65, maxInclusive: false, source: { sheetId: "27hboC", cell: "B4" }, status: "SOURCE" },
      { qualityId: "quality_s_orange", minScore: 65, maxScore: 100, maxInclusive: false, source: { sheetId: "27hboC", cell: "B5" }, status: "SOURCE" },
    ],
    aliases: [],
    matrixCells: [],
    importedAt: "2026-07-29T00:00:00.000Z",
  })];
  value.functionProfiles = [{
    id: "function:cast",
    name: "远投",
    rules: [],
    intensityRules: [{
      intensity: 2,
      itemPartId: "part:rod",
      rules: [],
      scoreFactor: 1.03,
      scoreFactorSourceRef: "16qYVn!F2@source:quality@500",
      sourceRowId: "function:cast:2",
    }],
    enabled: true,
    sourceRevisionId: "source:quality@500",
    notes: "",
  }];
  return value;
}

function command<T extends Record<string, unknown>>(
  value: T,
): T & { expectedWorkspaceRevision: number; inputHash: string } {
  const input = { expectedWorkspaceRevision: 1, ...value };
  return { ...input, inputHash: v23ActionInputHash(input) };
}

function run(
  current: WorkspaceState,
  action: V23WriteAction,
  payload: Record<string, unknown>,
) {
  const result = executeV23DomainAction(current, 1, action, command(payload));
  return { ...result, state: ensureWorkflowFields(result.state) };
}

const part = {
  partId: "part:series-alpha:rod",
  partType: "rod",
  fishingMethodId: "method:lure",
  materialTypeId: "material:carbon",
  functionProfileId: "function:cast",
  functionIntensity: 2,
  weightBandIds: ["band:light"],
  defaultEntryRefs: [],
  technologyRefs: [],
};

function attributeAffixPayload(
  affixId: string,
  itemPartId = "part:rod",
  semanticContributionKey = affixId,
) {
  return {
    name: affixId,
    category: "attribute",
    itemPartId,
    semanticContributionKey,
    stackingPolicy: "dedupe",
    generationPolicy: "normal",
    rarity: "common",
    valueScore: 1,
    tags: [],
    description: "test",
    enabled: true,
    operations: [{
      operationId: `operation:${affixId}`,
      operationIndex: 0,
      sourceAffixId: affixId,
      sourceAffixRevision: 1,
      parameterKey: "pull",
      operation: "flat_adjust",
      direction: "increase",
      magnitude: 1,
      publishedMagnitudeRange: { min: 0, max: 2, ruleSetVersion: "ruleset-v3-migrated-1" },
    }],
    passivePayload: null,
  };
}

test("create_series creates one stable parent and 1–3 unique v23 parts without target pull", () => {
  const before = state();
  const frozenSnapshots = structuredClone(before.configurationSnapshots);
  const frozenLegacySkus = structuredClone(before.skuDrawers);
  const created = run(before, "create_series", {
    seriesId: "series:alpha",
    collectionId: null,
    name: "Alpha",
    concept: "Stable identity only",
    parts: [part],
  });
  const series = created.state.seriesDefinitions.find((entry) => entry.id === "series:alpha");
  assert.ok(series);
  assert.deepEqual(series.targetPullSpecifications, []);
  assert.deepEqual(series.skuIds, []);
  assert.equal(created.state.v23SeriesPartHeads.length, 1);
  assert.equal(created.state.v23SeriesPartRevisions[0]?.revision, 1);
  assert.deepEqual(created.state.configurationSnapshots, frozenSnapshots);
  assert.deepEqual(created.state.skuDrawers, frozenLegacySkus);

  assert.throws(
    () => run(before, "create_series", {
      seriesId: "series:duplicate",
      collectionId: null,
      name: "Bad",
      concept: "duplicate rod",
      parts: [part, { ...part, partId: "part:other" }],
    }),
    (error: unknown) => error instanceof V23DomainActionError
      && error.code === "V23_SERIES_PART_DUPLICATE",
  );
});

test("preview is read-only and create_sku supports multiple stable IDs in one Part+band", () => {
  const created = run(state(), "create_series", {
    seriesId: "series:alpha",
    collectionId: null,
    name: "Alpha",
    concept: "Multiple drawers",
    parts: [part],
  }).state;
  const previewBefore = structuredClone(created);
  const preview = previewWeightBandSkus(created, {
    partId: part.partId,
    expectedPartRevision: 1,
    weightBandId: "band:light",
  });
  assert.equal(preview.match.status, "VALID");
  assert.deepEqual(preview.skuHeads, []);
  assert.deepEqual(created, previewBefore);

  const first = run(created, "create_sku", {
    skuId: "sku:light:a",
    partId: part.partId,
    expectedPartRevision: 1,
    weightBandId: "band:light",
    displayOrder: 0,
  }).state;
  const second = run(first, "create_sku", {
    skuId: "sku:light:b",
    partId: part.partId,
    expectedPartRevision: 1,
    weightBandId: "band:light",
    displayOrder: 1,
  }).state;
  assert.deepEqual(
    second.v23SkuDrawerHeads.map((entry) => entry.skuId).sort(),
    ["sku:light:a", "sku:light:b"],
  );
  assert.ok(second.v23SkuDrawerRevisions.every((entry) => entry.derivation?.status === "VALID"));
});

test("SKU 创建采用推荐品质，人工实际品质作为新 revision 保存且理由 fail closed", () => {
  const withSeries = run(qualityReadyState(), "create_series", {
    seriesId: "series:alpha",
    collectionId: null,
    name: "Alpha",
    concept: "Quality",
    parts: [part],
  }).state;
  const created = run(withSeries, "create_sku", {
    skuId: "sku:quality",
    partId: part.partId,
    expectedPartRevision: 1,
    weightBandId: "band:light",
    displayOrder: 0,
  }).state;
  const initial = created.v23SkuDrawerRevisions[0]!;
  assert.equal(initial.quality.status, "ASSESSED");
  if (initial.quality.status !== "ASSESSED") return;
  assert.equal(initial.quality.assessment.recommendedQualityId, "quality_c_green");
  assert.equal(initial.quality.assessment.selectedQualityId, "quality_c_green");
  assert.equal(initial.quality.assessment.qualityOverrideState, "MATCHED");

  assert.throws(
    () => run(created, "set_sku_actual_quality", {
      skuId: "sku:quality",
      expectedSkuRevision: 1,
      selectedQualityId: "quality_b_blue",
      reason: null,
    }),
    /V23_QUALITY_OVERRIDE_REASON_REQUIRED/,
  );
  const overridden = run(created, "set_sku_actual_quality", {
    skuId: "sku:quality",
    expectedSkuRevision: 1,
    selectedQualityId: "quality_b_blue",
    reason: "人工实测品质",
  }).state;
  assert.equal(overridden.v23SkuDrawerHeads[0]?.revision, 2);
  assert.equal(overridden.v23SkuDrawerRevisions.length, 2);
  assert.deepEqual(overridden.v23SkuDrawerRevisions[0], initial);
  const actual = overridden.v23SkuDrawerRevisions[1]!.quality;
  assert.equal(actual.status, "ASSESSED");
  if (actual.status !== "ASSESSED") return;
  assert.equal(actual.assessment.selectedQualityId, "quality_b_blue");
  assert.equal(actual.assessment.qualityOverrideState, "OVERRIDDEN");
  assert.equal(actual.assessment.qualityOverrideReason, "人工实测品质");
});

test("评分达到 100 后人工选择实际品质仍保留正式发布阻断", () => {
  const withSeries = run(qualityReadyState(), "create_series", {
    seriesId: "series:alpha",
    collectionId: null,
    name: "Alpha",
    concept: "Out of range quality",
    parts: [part],
  }).state;
  const withAffix = run(withSeries, "create_project_affix", {
    affixId: "affix:score-100",
    affixPayload: { ...attributeAffixPayload("affix:score-100"), valueScore: 100 },
  }).state;
  const created = run(withAffix, "create_sku", {
    skuId: "sku:out-of-range",
    partId: part.partId,
    expectedPartRevision: 1,
    weightBandId: "band:light",
    displayOrder: 0,
  }).state;
  const withEntry = run(created, "add_sku_affix", {
    skuId: "sku:out-of-range",
    expectedSkuRevision: 1,
    affixRef: {
      id: "affix:score-100",
      revision: 1,
      contentHash: withAffix.v23AffixDefinitions[0]!.contentHash,
    },
  }).state;
  const assessed = run(withEntry, "set_sku_actual_quality", {
    skuId: "sku:out-of-range",
    expectedSkuRevision: 2,
    selectedQualityId: "quality_s_orange",
    reason: "评分越界后人工实测",
  }).state.v23SkuDrawerRevisions.at(-1)!;

  assert.equal(assessed.quality.status, "ASSESSED");
  if (assessed.quality.status !== "ASSESSED") return;
  assert.equal(assessed.quality.assessment.recommendedQualityId, null);
  assert.equal(assessed.quality.assessment.selectedQualityId, "quality_s_orange");
  assert.ok(assessed.validationSummary.some(
    (issue) => issue.code === "QUALITY_SCORE_OUT_OF_RANGE"
      && issue.gate === "PUBLISH"
      && issue.severity === "BLOCKER",
  ));
});

test("part update appends immutable revisions and atomically rederives every child SKU", () => {
  const withSeries = run(state(), "create_series", {
    seriesId: "series:alpha",
    collectionId: null,
    name: "Alpha",
    concept: "Part revision",
    parts: [part],
  }).state;
  const withSkuA = run(withSeries, "create_sku", {
    skuId: "sku:a",
    partId: part.partId,
    expectedPartRevision: 1,
    weightBandId: "band:light",
    displayOrder: 0,
  }).state;
  const withSkuB = run(withSkuA, "create_sku", {
    skuId: "sku:b",
    partId: part.partId,
    expectedPartRevision: 1,
    weightBandId: "band:light",
    displayOrder: 1,
  }).state;
  const changed = run(withSkuB, "update_part_configuration", {
    partId: part.partId,
    expectedPartRevision: 1,
    configuration: { ...part, functionIntensity: 3 },
  }).state;
  assert.equal(changed.v23SeriesPartRevisions.length, 2);
  assert.equal(changed.v23SeriesPartHeads[0]?.revision, 2);
  assert.deepEqual(changed.v23SkuDrawerHeads.map((entry) => entry.revision), [2, 2]);
  const current = changed.v23SkuDrawerRevisions.filter((entry) => entry.revision === 2);
  assert.ok(current.every((entry) => entry.partRevision === 2));
  assert.ok(current.every((entry) => entry.match.status === "INVALID_NO_MATCH"));
  assert.equal(withSkuB.v23SkuDrawerRevisions.length, 2);
});

test("project affix and SKU affix actions preserve identity and reject duplicate semantics", () => {
  let current = run(state(), "create_series", {
    seriesId: "series:alpha",
    collectionId: null,
    name: "Alpha",
    concept: "Affixes",
    parts: [part],
  }).state;
  current = run(current, "create_sku", {
    skuId: "sku:a",
    partId: part.partId,
    expectedPartRevision: 1,
    weightBandId: "band:light",
    displayOrder: 0,
  }).state;
  const affixPayload = {
    name: "Pull up",
    category: "attribute",
    itemPartId: "part:rod",
    semanticContributionKey: "pull-up",
    stackingPolicy: "dedupe",
    generationPolicy: "normal",
    rarity: "common",
    valueScore: 1,
    tags: [],
    description: "increase",
    enabled: true,
    operations: [{
      operationId: "operation:pull-up",
      operationIndex: 0,
      sourceAffixId: "affix:pull-up",
      sourceAffixRevision: 1,
      parameterKey: "pull",
      operation: "flat_adjust",
      direction: "increase",
      magnitude: 1,
      publishedMagnitudeRange: { min: 0, max: 2, ruleSetVersion: "ruleset-v3-migrated-1" },
    }],
    passivePayload: null,
  };
  current = run(current, "create_project_affix", {
    affixId: "affix:pull-up",
    affixPayload,
  }).state;
  const definition = current.v23AffixDefinitions[0]!;
  current = run(current, "add_sku_affix", {
    skuId: "sku:a",
    expectedSkuRevision: 1,
    affixRef: {
      id: definition.affixId,
      revision: definition.revision,
      contentHash: definition.contentHash,
    },
  }).state;
  const head = current.v23SkuDrawerHeads[0]!;
  assert.equal(head.revision, 2);
  const revision = current.v23SkuDrawerRevisions.find((entry) => entry.revision === 2)!;
  assert.equal(revision.skuId, "sku:a");
  assert.equal(revision.derivation?.status, "VALID");
  assert.throws(
    () => run(current, "add_sku_affix", {
      skuId: "sku:a",
      expectedSkuRevision: 2,
      affixRef: {
        id: definition.affixId,
        revision: definition.revision,
        contentHash: definition.contentHash,
      },
    }),
    /已包含同一稳定词条贡献/u,
  );
});

test("closed schema, canonical input hash and stale entity revisions fail closed", () => {
  const current = state();
  const payload = command({
    seriesId: "series:alpha",
    collectionId: null,
    name: "Alpha",
    concept: "Closed",
    parts: [part],
    displayTextBypass: true,
  });
  assert.throws(
    () => executeV23DomainAction(current, 1, "create_series", payload),
    (error: unknown) => error instanceof V23DomainActionError
      && error.code === "V23_ACTION_UNKNOWN_FIELD",
  );
  assert.throws(
    () => executeV23DomainAction(current, 1, "create_series", {
      ...command({
        seriesId: "series:alpha",
        collectionId: null,
        name: "Alpha",
        concept: "Hash",
        parts: [part],
      }),
      name: "tampered",
    }),
    (error: unknown) => error instanceof V23DomainActionError
      && error.code === "V23_ACTION_INPUT_HASH_MISMATCH",
  );
});

test("create_sku fails before mutation for zero or multiple six-key matches", () => {
  const withSeries = run(state(), "create_series", {
    seriesId: "series:match",
    collectionId: null,
    name: "Match",
    concept: "fail closed",
    parts: [part],
  }).state;
  for (const candidate of [
    { ...structuredClone(withSeries), v23FunctionTemplates: [] },
    {
      ...structuredClone(withSeries),
      v23FunctionTemplates: [
        ...withSeries.v23FunctionTemplates!,
        {
          ...withSeries.v23FunctionTemplates![0]!,
          ref: { ...withSeries.v23FunctionTemplates![0]!.ref, templateId: "template:duplicate" },
        },
      ],
    },
  ]) {
    const before = structuredClone(candidate);
    assert.throws(
      () => run(candidate, "create_sku", {
        skuId: "sku:must-not-exist",
        partId: part.partId,
        expectedPartRevision: 1,
        weightBandId: "band:light",
        displayOrder: 0,
      }),
      /INVALID_(NO_MATCH|AMBIGUOUS)/u,
    );
    assert.deepEqual(candidate, before);
    assert.equal(candidate.v23SkuDrawerRevisions.length, 0);
    assert.equal(candidate.v23SkuDrawerHeads.length, 0);
  }
});

test("Part update removing a weight band preserves SKU intent but appends an invalid revision", () => {
  let current = run(state(), "create_series", {
    seriesId: "series:band",
    collectionId: null,
    name: "Band",
    concept: "remove band",
    parts: [{ ...part, weightBandIds: ["band:light", "band:other"] }],
  }).state;
  current = run(current, "create_sku", {
    skuId: "sku:band",
    partId: part.partId,
    expectedPartRevision: 1,
    weightBandId: "band:light",
    displayOrder: 7,
  }).state;
  const original = current.v23SkuDrawerRevisions[0]!;
  const changed = run(current, "update_part_configuration", {
    partId: part.partId,
    expectedPartRevision: 1,
    configuration: { ...part, weightBandIds: ["band:other"] },
  }).state;
  const next = changed.v23SkuDrawerRevisions.find(
    (entry) => entry.skuId === "sku:band" && entry.revision === 2,
  )!;
  assert.equal(next.match.status, "INVALID_NO_MATCH");
  assert.equal(next.validationSummary[0]?.severity, "BLOCKER");
  assert.equal(next.validationSummary[0]?.gate, "PUBLISH");
  assert.deepEqual(next.addedEntryRefs, original.addedEntryRefs);
  assert.deepEqual(next.removedInheritedEntryIds, original.removedInheritedEntryIds);
  assert.deepEqual(next.localEntryCopies, original.localEntryCopies);
  assert.equal(next.displayOrder, original.displayOrder);
});

test("Part and SKU stable IDs can never be reused after their heads disappear", () => {
  const withSeries = run(state(), "create_series", {
    seriesId: "series:history",
    collectionId: null,
    name: "History",
    concept: "identity",
    parts: [part],
  }).state;
  const noPartHead = { ...structuredClone(withSeries), v23SeriesPartHeads: [] };
  assert.throws(
    () => run(noPartHead, "create_series", {
      seriesId: "series:other",
      collectionId: null,
      name: "Other",
      concept: "reuse",
      parts: [{ ...part }],
    }),
    /V23_PART_ID_HISTORY_CONFLICT/u,
  );
  const withSku = run(withSeries, "create_sku", {
    skuId: "sku:history",
    partId: part.partId,
    expectedPartRevision: 1,
    weightBandId: "band:light",
    displayOrder: 0,
  }).state;
  const noSkuHead = { ...structuredClone(withSku), v23SkuDrawerHeads: [] };
  assert.throws(
    () => run(noSkuHead, "create_sku", {
      skuId: "sku:history",
      partId: part.partId,
      expectedPartRevision: 1,
      weightBandId: "band:light",
      displayOrder: 1,
    }),
    /V23_SKU_ID_HISTORY_CONFLICT/u,
  );
});

test("create/update Part share closed affix and technology reference policy", () => {
  let current = run(state(), "create_project_affix", {
    affixId: "affix:reel-only",
    affixPayload: attributeAffixPayload("affix:reel-only", "part:reel"),
  }).state;
  current = run(current, "create_project_affix", {
    affixId: "affix:rod-default",
    affixPayload: attributeAffixPayload("affix:rod-default", "part:rod"),
  }).state;
  const ref = {
    id: "affix:reel-only",
    revision: 1,
    contentHash: current.v23AffixDefinitions.find(
      (entry) => entry.affixId === "affix:reel-only",
    )!.contentHash,
  };
  const rodRef = {
    id: "affix:rod-default",
    revision: 1,
    contentHash: current.v23AffixDefinitions.find(
      (entry) => entry.affixId === "affix:rod-default",
    )!.contentHash,
  };
  for (const [index, candidate] of [
    { ...part, defaultEntryRefs: [ref] },
    { ...part, defaultEntryRefs: [rodRef, rodRef] },
    { ...part, technologyRefs: [{ id: "technology:x", revision: 1, contentHash: "a".repeat(64) }] },
  ].entries()) {
    const before = structuredClone(current);
    assert.throws(
      () => run(current, "create_series", {
        seriesId: `series:invalid:${index}`,
        collectionId: null,
        name: "Invalid",
        concept: "reference",
        parts: [candidate],
      }),
      /V23_(AFFIX_ITEM_PART_MISMATCH|PART_DEFAULT_AFFIX_DUPLICATE|TECHNOLOGY_REF_WRITE_UNAVAILABLE)/u,
    );
    assert.deepEqual(current, before);
  }
  current = run(current, "create_series", {
    seriesId: "series:update-ref",
    collectionId: null,
    name: "Update",
    concept: "reference",
    parts: [part],
  }).state;
  for (const configuration of [
    { ...part, defaultEntryRefs: [ref] },
    { ...part, technologyRefs: [{ id: "technology:x", revision: 1, contentHash: "a".repeat(64) }] },
  ]) {
    assert.throws(
      () => run(current, "update_part_configuration", {
        partId: part.partId,
        expectedPartRevision: 1,
        configuration,
      }),
      /V23_(AFFIX_ITEM_PART_MISMATCH|TECHNOLOGY_REF_WRITE_UNAVAILABLE)/u,
    );
    assert.equal(current.v23SeriesPartHeads[0]?.revision, 1);
  }
});

test("project affix parser rejects every malformed nested branch before hash/write", () => {
  const base = state();
  const valid = attributeAffixPayload("affix:closed");
  const malformed = [
    { ...valid, unknown: true },
    { ...valid, valueScore: Number.POSITIVE_INFINITY },
    { ...valid, itemPartId: "part:hook" },
    { ...valid, operations: [{ ...valid.operations[0], sourceAffixId: "affix:other" }] },
    { ...valid, operations: [{ ...valid.operations[0], operationIndex: -1 }] },
    { ...valid, operations: [{ ...valid.operations[0], extra: true }] },
    { ...valid, operations: [
      valid.operations[0],
      { ...valid.operations[0], operationId: "operation:two" },
    ] },
    { ...valid, operations: [{
      ...valid.operations[0],
      magnitude: 3,
      publishedMagnitudeRange: { min: 0, max: 2, ruleSetVersion: "ruleset-v3-migrated-1" },
    }] },
    { ...valid, category: "passive", operations: valid.operations, passivePayload: {} },
  ];
  for (const [index, affixPayload] of malformed.entries()) {
    const before = structuredClone(base);
    assert.throws(
      () => run(base, "create_project_affix", {
        affixId: `affix:malformed:${index}`,
        affixPayload,
      }),
    );
    assert.deepEqual(base, before);
    assert.equal(base.v23AffixDefinitions.length, 0);
  }
  for (const invalidPart of [
    "part:hook", "part:float", "part:natural-bait", "part:artificial-lure", "part:unknown",
  ]) {
    const passivePayload = {
      name: "Passive",
      category: "passive",
      itemPartId: invalidPart,
      semanticContributionKey: "passive",
      stackingPolicy: "dedupe",
      generationPolicy: "normal",
      rarity: "common",
      valueScore: 1,
      tags: [],
      description: "passive",
      enabled: true,
      operations: [],
      passivePayload: {
        skillId: "skill:test",
        name: "Skill",
        itemPartId: invalidPart,
        triggerType: "manual",
        triggerDescription: "trigger",
        effectTarget: "self",
        effectLogicDescription: "effect",
        exampleParameters: {},
        durationDescription: "duration",
        cooldownDescription: "cooldown",
        resetDescription: "reset",
        stackingDescription: "stack",
        playerDescription: "player",
        simulatorReferenceKey: null,
      },
    };
    assert.throws(
      () => run(base, "create_project_affix", {
        affixId: `affix:${invalidPart}`,
        affixPayload: passivePayload,
      }),
      /V23_AFFIX_ITEM_PART_INVALID/u,
    );
  }
  const validPassivePayload = {
    name: "Passive",
    category: "passive",
    itemPartId: "part:line",
    semanticContributionKey: "passive:line",
    stackingPolicy: "dedupe",
    generationPolicy: "normal",
    rarity: "rare",
    valueScore: 2,
    tags: ["passive"],
    description: "passive",
    enabled: true,
    operations: [],
    passivePayload: {
      skillId: "skill:line",
      name: "Line passive",
      itemPartId: "part:line",
      triggerType: "manual",
      triggerDescription: "trigger",
      effectTarget: "self",
      effectLogicDescription: "effect",
      exampleParameters: { ratio: 0.5, label: "test", enabled: true },
      durationDescription: "duration",
      cooldownDescription: "cooldown",
      resetDescription: "reset",
      stackingDescription: "stack",
      playerDescription: "player",
      simulatorReferenceKey: null,
    },
  };
  const passive = run(base, "create_project_affix", {
    affixId: "affix:valid-passive",
    affixPayload: validPassivePayload,
  }).state.v23AffixDefinitions[0]!;
  assert.equal(passive.payload.category, "passive");
  assert.equal(passive.contentHash, jcsSha256Hex({
    affixId: passive.affixId,
    revision: passive.revision,
    payload: passive.payload,
  }));
});

test("SKU affix add rejects cross-Part definitions while copy remains source replacement", () => {
  let current = run(state(), "create_project_affix", {
    affixId: "affix:reel",
    affixPayload: attributeAffixPayload("affix:reel", "part:reel"),
  }).state;
  const definition = current.v23AffixDefinitions[0]!;
  current = run(current, "create_series", {
    seriesId: "series:rod",
    collectionId: null,
    name: "Rod",
    concept: "cross part",
    parts: [part],
  }).state;
  current = run(current, "create_sku", {
    skuId: "sku:rod",
    partId: part.partId,
    expectedPartRevision: 1,
    weightBandId: "band:light",
    displayOrder: 0,
  }).state;
  assert.throws(
    () => run(current, "add_sku_affix", {
      skuId: "sku:rod",
      expectedSkuRevision: 1,
      affixRef: {
        id: definition.affixId,
        revision: definition.revision,
        contentHash: definition.contentHash,
      },
    }),
    /V23_AFFIX_ITEM_PART_MISMATCH/u,
  );
  assert.equal(current.v23SkuDrawerHeads[0]?.revision, 1);
});

test("formal derivation refuses zero or multiple published policies without version guessing", () => {
  const current = run(state(), "create_series", {
    seriesId: "series:policy",
    collectionId: null,
    name: "Policy",
    concept: "unique authority",
    parts: [part],
  }).state;
  for (const policies of [
    [],
    [publishedPolicy("2"), publishedPolicy("10")],
  ]) {
    const candidate = { ...structuredClone(current), reductionStackingPolicyVersions: policies };
    const before = structuredClone(candidate);
    assert.throws(
      () => run(candidate, "create_sku", {
        skuId: `sku:policy:${policies.length}`,
        partId: part.partId,
        expectedPartRevision: 1,
        weightBandId: "band:light",
        displayOrder: 0,
      }),
      /V23_OPEN_001_POLICY_VERSION_REQUIRED/u,
    );
    assert.deepEqual(candidate, before);
  }
});

test("create_series collectionId accepts only null or one exact existing Collection", () => {
  const base = state();
  const collectionId = base.collections[0]!.id;
  const withNull = run(base, "create_series", {
    seriesId: "series:null-collection",
    collectionId: null,
    name: "Null",
    concept: "no collection",
    parts: [part],
  }).state;
  assert.equal(
    withNull.seriesDefinitions.find((entry) => entry.id === "series:null-collection")?.collectionId,
    undefined,
  );
  const withExisting = run(base, "create_series", {
    seriesId: "series:existing-collection",
    collectionId,
    name: "Existing",
    concept: "exact collection",
    parts: [{ ...part, partId: "part:existing:rod" }],
  }).state;
  assert.equal(
    withExisting.seriesDefinitions.find((entry) => entry.id === "series:existing-collection")?.collectionId,
    collectionId,
  );
  for (const invalid of [" ", "collection:missing", 42, {}, []]) {
    const before = structuredClone(base);
    assert.throws(
      () => run(base, "create_series", {
        seriesId: `series:invalid-collection:${typeof invalid}`,
        collectionId: invalid,
        name: "Invalid",
        concept: "orphan forbidden",
        parts: [part],
      }),
      /V23_SERIES_COLLECTION_(INVALID|UNRESOLVED)/u,
    );
    assert.deepEqual(base, before);
  }
});

test("local affix copy accepts only active inherited current-Part source", () => {
  let active = run(state(), "create_project_affix", {
    affixId: "affix:inherited",
    affixPayload: attributeAffixPayload("affix:inherited", "part:rod"),
  }).state;
  const definition = active.v23AffixDefinitions[0]!;
  const ref = {
    id: definition.affixId,
    revision: definition.revision,
    contentHash: definition.contentHash,
  };
  active = run(active, "create_series", {
    seriesId: "series:copy",
    collectionId: null,
    name: "Copy",
    concept: "active inherited only",
    parts: [{ ...part, defaultEntryRefs: [ref] }],
  }).state;
  active = run(active, "create_sku", {
    skuId: "sku:copy",
    partId: part.partId,
    expectedPartRevision: 1,
    weightBandId: "band:light",
    displayOrder: 0,
  }).state;
  const copied = run(active, "copy_sku_local_affix", {
    skuId: "sku:copy",
    expectedSkuRevision: 1,
    affixRef: ref,
    localCopyId: "copy:one",
  }).state;
  const copiedHead = copied.v23SkuDrawerRevisions.find(
    (entry) => entry.skuId === "sku:copy" && entry.revision === 2,
  )!;
  assert.equal(copiedHead.localEntryCopies[0]?.sourceRef.id, ref.id);
  assert.equal(copiedHead.addedEntryRefs.length, 0);
  assert.throws(
    () => run(copied, "copy_sku_local_affix", {
      skuId: "sku:copy",
      expectedSkuRevision: 2,
      affixRef: ref,
      localCopyId: "copy:two",
    }),
    /V23_LOCAL_AFFIX_COPY_CONFLICT/u,
  );

  const removed = run(active, "remove_inherited_affix", {
    skuId: "sku:copy",
    expectedSkuRevision: 1,
    inheritedEntryId: ref.id,
  }).state;
  assert.throws(
    () => run(removed, "copy_sku_local_affix", {
      skuId: "sku:copy",
      expectedSkuRevision: 2,
      affixRef: ref,
      localCopyId: "copy:removed",
    }),
    /V23_LOCAL_AFFIX_COPY_SOURCE_NOT_ACTIVE_INHERITED/u,
  );

  let addedOnly = run(state(), "create_project_affix", {
    affixId: "affix:added-only",
    affixPayload: attributeAffixPayload("affix:added-only", "part:rod"),
  }).state;
  const addedDefinition = addedOnly.v23AffixDefinitions[0]!;
  const addedRef = {
    id: addedDefinition.affixId,
    revision: addedDefinition.revision,
    contentHash: addedDefinition.contentHash,
  };
  addedOnly = run(addedOnly, "create_series", {
    seriesId: "series:added-only",
    collectionId: null,
    name: "Added",
    concept: "not inherited",
    parts: [part],
  }).state;
  addedOnly = run(addedOnly, "create_sku", {
    skuId: "sku:added-only",
    partId: part.partId,
    expectedPartRevision: 1,
    weightBandId: "band:light",
    displayOrder: 0,
  }).state;
  addedOnly = run(addedOnly, "add_sku_affix", {
    skuId: "sku:added-only",
    expectedSkuRevision: 1,
    affixRef: addedRef,
  }).state;
  assert.throws(
    () => run(addedOnly, "copy_sku_local_affix", {
      skuId: "sku:added-only",
      expectedSkuRevision: 2,
      affixRef: addedRef,
      localCopyId: "copy:added",
    }),
    /V23_LOCAL_AFFIX_COPY_SOURCE_NOT_ACTIVE_INHERITED/u,
  );

  let wrongPart = run(active, "create_project_affix", {
    affixId: "affix:wrong-part-copy",
    affixPayload: attributeAffixPayload("affix:wrong-part-copy", "part:reel"),
  }).state;
  const wrongDefinition = wrongPart.v23AffixDefinitions.find(
    (entry) => entry.affixId === "affix:wrong-part-copy",
  )!;
  const wrongRef = {
    id: wrongDefinition.affixId,
    revision: wrongDefinition.revision,
    contentHash: wrongDefinition.contentHash,
  };
  wrongPart = structuredClone(wrongPart);
  wrongPart.v23SeriesPartRevisions[0]!.defaultEntryRefs = [wrongRef];
  assert.throws(
    () => executeV23DomainAction(
      wrongPart,
      1,
      "copy_sku_local_affix",
      command({
        skuId: "sku:copy",
        expectedSkuRevision: 1,
        affixRef: wrongRef,
        localCopyId: "copy:wrong-part",
      }),
    ),
    /V23_AFFIX_ITEM_PART_MISMATCH/u,
  );
});
