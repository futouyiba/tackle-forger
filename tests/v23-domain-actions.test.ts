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

const templateKey = {
  partType: "rod" as const,
  weightBandId: "band:light",
  fishingMethodId: "method:lure",
  materialTypeId: "material:carbon",
  functionProfileId: "function:cast",
  functionIntensity: 2 as const,
};

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
  value.reductionStackingPolicyVersions = [publishReductionStackingPolicyVersion({
    draft: importReductionStackingPolicyDraft({
      sourceRevision: {
        id: "source:1",
        workbookRefId: "feishu-workbook:tackle-design",
        sourceRevision: "99",
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
  })];
  return ensureWorkflowFields(value);
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
