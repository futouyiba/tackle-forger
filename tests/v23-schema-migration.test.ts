import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_WORKSPACE_SCHEMA_VERSION, migrateWorkspaceState } from "../lib/migrations";
import { verifySnapshotIntegrity } from "../lib/publishing";
import { deterministicHash } from "../lib/rule-kernel";
import { createSeedState } from "../lib/seed";
import type {
  SeriesPartRevision,
  SkuDrawerRevision,
  V23AffixDefinition,
  V23LegacyReadAdapter,
} from "../lib/types";

function legacyInput(version: 9 | 22) {
  const state = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  state.schemaVersion = version;
  delete state.v23SeriesPartRevisions;
  delete state.v23SkuDrawerRevisions;
  delete state.v23AffixDefinitions;
  delete state.v23MigrationSourceEvidence;
  delete state.v23LegacyReadAdapters;
  return state;
}

const hash = (value: string) => value.repeat(64).slice(0, 64);

function directV23State(partCount = 1) {
  const state = migrateWorkspaceState(legacyInput(22));
  const affix = { affixId: "affix:project", revision: 1, contentHash: hash("a"), payload: { preserved: true } };
  const ref = { id: affix.affixId, revision: affix.revision, contentHash: affix.contentHash };
  const parts = Array.from({ length: partCount }, (_, index) => ({
    partId: `part:${index}`, seriesId: "series:one", revision: 1,
    partType: (["rod", "reel", "line", "rod"] as const)[index]!,
    fishingMethodId: "method:lure", materialTypeId: "material:carbon", functionProfileId: "function:cast", functionIntensity: 2 as const,
    defaultEntryRefs: [], technologyRefs: [], inputFingerprint: hash("b"), contentHash: hash("c"),
  }));
  state.v23SeriesPartRevisions = parts;
  state.v23AffixDefinitions = [affix];
  state.v23MigrationSourceEvidence = [];
  state.v23LegacyReadAdapters = [];
  state.v23SkuDrawerRevisions = [{
    skuId: "sku:one", revision: 1, seriesId: "series:one", partId: "part:0", weightBandId: "band:one",
    functionTemplateRef: { templateId: "template:one", revisionId: "r1", contentHash: hash("d") }, inputFingerprint: hash("e"), validity: "VALID",
    removedInheritedEntryIds: [], addedEntryRefs: [{ kind: "STABLE_AFFIX_REF", ref }], localEntryCopies: [], technologyRefs: [],
    recommendedQualityId: "quality_a_purple", selectedQualityId: "quality_a_purple", qualityOverrideReason: null, contentHash: hash("f"),
  }];
  return state;
}

test("v23 closed carriers express Parts, SKU drawers, and non-interchangeable affix entries", () => {
  const part: SeriesPartRevision = {
    partId: "part:rod", seriesId: "series:one", revision: 1, partType: "rod",
    fishingMethodId: "method:lure", materialTypeId: "material:carbon",
    functionProfileId: "function:cast", functionIntensity: 2,
    defaultEntryRefs: [{ id: "affix:project", revision: 1, contentHash: "a".repeat(64) }],
    technologyRefs: [], inputFingerprint: "b".repeat(64), contentHash: "c".repeat(64),
  };
  const definition: V23AffixDefinition = {
    affixId: "affix:project", revision: 1, contentHash: "a".repeat(64), payload: { preserved: true },
  };
  const sku: SkuDrawerRevision = {
    skuId: "sku:one", revision: 1, seriesId: part.seriesId, partId: part.partId,
    weightBandId: "band:one", functionTemplateRef: { templateId: "template:one", revisionId: "r1", contentHash: "d".repeat(64) },
    inputFingerprint: "e".repeat(64), validity: "VALID", removedInheritedEntryIds: [],
    addedEntryRefs: [{ kind: "STABLE_AFFIX_REF", ref: { id: definition.affixId, revision: definition.revision, contentHash: definition.contentHash } }],
    localEntryCopies: [{ kind: "LOCAL_AFFIX_COPY", localCopyId: "copy:one", sourceRef: { id: definition.affixId, revision: 1, contentHash: definition.contentHash }, payload: { value: 1 }, copyHash: "f".repeat(64) }],
    technologyRefs: [], recommendedQualityId: null, selectedQualityId: null, qualityOverrideReason: null,
    contentHash: "0".repeat(64),
  };
  assert.equal(sku.partId, part.partId);
  assert.equal(sku.addedEntryRefs[0]?.kind, "STABLE_AFFIX_REF");
  assert.equal(sku.localEntryCopies[0]?.kind, "LOCAL_AFFIX_COPY");
});

test("v22 to v23 creates explicit review adapters, preserves unknown fields, and leaves snapshots frozen", () => {
  const legacy = legacyInput(22);
  legacy.unknownTopLevel = { retain: ["exact", 23] };
  const sku = (legacy.skuDrawers as Array<Record<string, unknown>>)[0]!;
  sku.unknownSkuField = { retain: true };
  const snapshotsBefore = structuredClone(legacy.configurationSnapshots);
  const snapshotJsonBefore = JSON.stringify(snapshotsBefore);
  const snapshotHashesBefore = (snapshotsBefore as Array<unknown>).map((snapshot) => deterministicHash(snapshot));

  const migrated = migrateWorkspaceState(legacy);
  assert.equal(CURRENT_WORKSPACE_SCHEMA_VERSION, 23);
  assert.equal(migrated.schemaVersion, 23);
  assert.deepEqual(migrated.v23SeriesPartRevisions, []);
  assert.deepEqual(migrated.v23SkuDrawerRevisions, []);
  assert.deepEqual(migrated.v23AffixDefinitions, []);
  assert.equal(migrated.v23MigrationSourceEvidence.length, 1);
  assert.equal(migrated.v23MigrationSourceEvidence[0]?.sourceSchemaVersion, 22);
  assert.deepEqual(migrated.v23MigrationSourceEvidence[0]?.rawWorkspacePayload, legacy);
  assert.equal(migrated.v23LegacyReadAdapters.length, (legacy.skuDrawers as unknown[]).length);
  const adapter = migrated.v23LegacyReadAdapters[0]!;
  assert.deepEqual(adapter.rawSkuPayload, sku);
  assert.deepEqual(adapter.diagnosticCodes, ["V23_PART_UNRESOLVED", "V23_WEIGHT_BAND_UNRESOLVED", "V23_FUNCTION_TEMPLATE_UNRESOLVED"]);
  assert.equal(adapter.status, "NEEDS_REVIEW");
  assert.deepEqual((migrated as unknown as Record<string, unknown>).unknownTopLevel, legacy.unknownTopLevel);
  assert.equal(JSON.stringify(migrated.configurationSnapshots), snapshotJsonBefore);
  assert.deepEqual(migrated.configurationSnapshots.map((snapshot) => deterministicHash(snapshot)), snapshotHashesBefore);
  assert.equal(migrated.configurationSnapshots.every(verifySnapshotIntegrity), true);
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});

test("v9 original input is retained as evidence after the existing sequential chain reaches v23", () => {
  const legacy = legacyInput(9);
  legacy.v9OnlyUnknown = { retained: "verbatim" };
  const snapshotsBefore = structuredClone(legacy.configurationSnapshots);
  const migrated = migrateWorkspaceState(legacy);
  assert.equal(migrated.schemaVersion, 23);
  assert.equal(migrated.v23MigrationSourceEvidence[0]?.sourceSchemaVersion, 9);
  assert.deepEqual(migrated.v23MigrationSourceEvidence[0]?.rawWorkspacePayload, legacy);
  assert.deepEqual(migrated.configurationSnapshots, snapshotsBefore);
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});

test("missing and duplicate legacy stable SKU identities fail closed without mutating the input", () => {
  const missing = legacyInput(22);
  delete (missing.skuDrawers as Array<Record<string, unknown>>)[0]!.id;
  const missingBefore = structuredClone(missing);
  assert.throws(() => migrateWorkspaceState(missing), /V23_MIGRATION_SKU_ID_INVALID/);
  assert.deepEqual(missing, missingBefore);

  const duplicate = legacyInput(22);
  const sourceSku = (duplicate.skuDrawers as Array<Record<string, unknown>>)[0]!;
  (duplicate.skuDrawers as Array<Record<string, unknown>>).push(structuredClone(sourceSku));
  const duplicateBefore = structuredClone(duplicate);
  assert.throws(() => migrateWorkspaceState(duplicate), /V23_MIGRATION_SKU_ID_CONFLICT/);
  assert.deepEqual(duplicate, duplicateBefore);
});

test("partial v23 state on a v22 payload is rejected instead of completing a mixed migration", () => {
  const legacy = legacyInput(22);
  legacy.v23LegacyReadAdapters = [{ adapterId: "stale" }] satisfies Partial<V23LegacyReadAdapter>[];
  const before = structuredClone(legacy);
  assert.throws(() => migrateWorkspaceState(legacy), /V23_MIGRATION_PARTIAL_STATE_CONFLICT/);
  assert.deepEqual(legacy, before);
});

test("schema v23 directly validates one, two, and three unique enabled Parts", () => {
  for (const count of [1, 2, 3]) {
    const state = directV23State(count);
    assert.deepEqual(migrateWorkspaceState(state), state);
  }
});

test("schema v23 rejects duplicate or overlong Part groups and a SKU without its own Series Part", () => {
  const duplicate = directV23State(2);
  (duplicate.v23SeriesPartRevisions[1] as { partType: string }).partType = "rod";
  assert.throws(() => migrateWorkspaceState(duplicate), /V23_SERIES_PART_TYPE_DUPLICATE/);

  const overlong = directV23State(4);
  assert.throws(() => migrateWorkspaceState(overlong), /V23_SERIES_PART_COUNT_INVALID/);

  const missing = directV23State();
  missing.v23SkuDrawerRevisions[0]!.partId = "part:missing";
  assert.throws(() => migrateWorkspaceState(missing), /V23_SKU_PART_UNRESOLVED/);

  const crossSeries = directV23State();
  crossSeries.v23SkuDrawerRevisions[0]!.seriesId = "series:other";
  assert.throws(() => migrateWorkspaceState(crossSeries), /V23_SKU_PART_UNRESOLVED/);
});

test("schema v23 rejects malformed revisions, hashes, discriminated entries, and quality overrides", () => {
  const revision = directV23State();
  revision.v23SeriesPartRevisions[0]!.revision = 0;
  assert.throws(() => migrateWorkspaceState(revision), /V23_PART_REVISION_INVALID/);

  const hashInvalid = directV23State();
  hashInvalid.v23SkuDrawerRevisions[0]!.contentHash = "uppercase";
  assert.throws(() => migrateWorkspaceState(hashInvalid), /V23_SKU_CONTENT_HASH_INVALID/);

  const union = directV23State();
  union.v23SkuDrawerRevisions[0]!.addedEntryRefs = [{ kind: "STABLE_AFFIX_REF", ref: { id: "affix:project", revision: 1, contentHash: hash("a") }, extra: true } as never];
  assert.throws(() => migrateWorkspaceState(union), /V23_SKU_ADDED_ENTRY_REF_SCHEMA_INVALID/);

  const quality = directV23State();
  quality.v23SkuDrawerRevisions[0]!.selectedQualityId = "quality_s_orange";
  assert.throws(() => migrateWorkspaceState(quality), /V23_QUALITY_OVERRIDE_REASON_REQUIRED/);

  const localOnAddedPath = directV23State();
  localOnAddedPath.v23SkuDrawerRevisions[0]!.addedEntryRefs = [{
    kind: "LOCAL_AFFIX_COPY", localCopyId: "copy:wrong-path",
    sourceRef: { id: "affix:project", revision: 1, contentHash: hash("a") }, payload: {}, copyHash: hash("c"),
  } as never];
  assert.throws(() => migrateWorkspaceState(localOnAddedPath), /V23_SKU_ADDED_ENTRY_REF_KIND_INVALID/);

  const danglingPartAffix = directV23State();
  danglingPartAffix.v23SeriesPartRevisions[0]!.defaultEntryRefs = [{ id: "affix:missing", revision: 1, contentHash: hash("a") }];
  assert.throws(() => migrateWorkspaceState(danglingPartAffix), /V23_PART_DEFAULT_ENTRY_UNRESOLVED/);
});

test("schema v23 rejects duplicate identities and malformed adapter/source-evidence closure", () => {
  const duplicateSku = directV23State();
  duplicateSku.v23SkuDrawerRevisions.push(structuredClone(duplicateSku.v23SkuDrawerRevisions[0]!));
  assert.throws(() => migrateWorkspaceState(duplicateSku), /V23_SKU_ID_DUPLICATE/);

  const malformedEvidence = directV23State();
  malformedEvidence.v23MigrationSourceEvidence = [{ sourceEvidenceId: "source:one", sourceSchemaVersion: 22, rawWorkspacePayload: { x: 1 }, rawWorkspacePayloadHash: hash("a"), extra: true } as never];
  assert.throws(() => migrateWorkspaceState(malformedEvidence), /V23_SOURCE_EVIDENCE_SCHEMA_INVALID/);

  const danglingAdapter = directV23State();
  danglingAdapter.v23LegacyReadAdapters = [{
    adapterId: "adapter:one", kind: "LEGACY_NEEDS_REVIEW", sourceEvidenceId: "source:missing", sourceSeriesId: null, sourceSkuId: null,
    rawSeriesPayload: null, rawSkuPayload: null, diagnosticCodes: ["V23_PART_UNRESOLVED"], status: "NEEDS_REVIEW",
  }];
  assert.throws(() => migrateWorkspaceState(danglingAdapter), /V23_LEGACY_ADAPTER_EVIDENCE_UNRESOLVED/);
});

test("v23 identity resolution remains unambiguous when stable IDs contain old key separators", () => {
  const state = directV23State();
  state.v23SeriesPartRevisions[0]!.seriesId = "series:alpha";
  state.v23SeriesPartRevisions[0]!.partId = "beta:part:one";
  state.v23SkuDrawerRevisions[0]!.seriesId = "series:alpha";
  state.v23SkuDrawerRevisions[0]!.partId = "beta:part:one";
  state.v23SeriesPartRevisions.push({
    ...structuredClone(state.v23SeriesPartRevisions[0]!),
    seriesId: "series:alpha:beta",
    partId: "part:one",
    partType: "reel",
  });
  const secondAffix = { affixId: "affix:project@revision:1", revision: 1, contentHash: hash("b"), payload: { second: true } };
  state.v23AffixDefinitions.push(secondAffix);
  state.v23SeriesPartRevisions[0]!.defaultEntryRefs = [
    { id: "affix:project", revision: 1, contentHash: hash("a") },
    { id: secondAffix.affixId, revision: secondAffix.revision, contentHash: secondAffix.contentHash },
  ];
  state.v23SkuDrawerRevisions[0]!.addedEntryRefs = [{
    kind: "STABLE_AFFIX_REF",
    ref: { id: secondAffix.affixId, revision: secondAffix.revision, contentHash: secondAffix.contentHash },
  }];
  assert.equal(migrateWorkspaceState(state).v23SeriesPartRevisions.length, 2);
});
