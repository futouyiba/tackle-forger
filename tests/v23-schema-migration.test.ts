import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_WORKSPACE_SCHEMA_VERSION, migrateWorkspaceState } from "../lib/migrations";
import { verifySnapshotIntegrity } from "../lib/publishing";
import { deterministicHash } from "../lib/rule-kernel";
import { jcsSha256Hex } from "../lib/canonical-json";
import { createSeedState } from "../lib/seed";
import { migrateLegacyProductIdentity } from "../lib/legacy-product-migration";
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
  delete state.v23SeriesPartHeads;
  delete state.v23SkuDrawerRevisions;
  delete state.v23SkuDrawerHeads;
  delete state.v23AffixDefinitions;
  delete state.v23MigrationSourceEvidence;
  delete state.v23LegacyReadAdapters;
  return state;
}

const hash = (value: unknown) => jcsSha256Hex(value);
const withPartHashes = <T extends object>(part: T) => {
  const input = { ...(part as Record<string, unknown>) };
  delete input.inputFingerprint;
  delete input.contentHash;
  const inputFingerprint = hash(input);
  return { ...input, inputFingerprint, contentHash: hash({ ...input, inputFingerprint }) } as T;
};
const withSkuHashes = <T extends object>(sku: T) => {
  const input = { ...(sku as Record<string, unknown>) };
  delete input.contentHash;
  return { ...input, contentHash: hash(input) } as T;
};
const sixKey = (weightBandId = "band:one"): { partType: "rod"; weightBandId: string; fishingMethodId: string; materialTypeId: string; functionProfileId: string; functionIntensity: 1 | 2 | 3 } => ({ partType: "rod", weightBandId, fishingMethodId: "method:lure", materialTypeId: "material:carbon", functionProfileId: "function:cast", functionIntensity: 2 });
const validMatch = (key = sixKey()) => ({ status: "VALID" as const, functionTemplateRef: { templateId: "template:one", revisionId: "r1", contentHash: hash("template") }, matchedKey: key, inputFingerprint: hash(key) });
const affixPayload = (id = "affix:project", revision = 1) => ({ name: "Project", category: "attribute" as const, itemPartId: "part:rod", semanticContributionKey: "power", stackingPolicy: "dedupe" as const, generationPolicy: "normal" as const, rarity: "common" as const, valueScore: 1, tags: [], description: "project", enabled: true, operations: [{ operationId: "op:one", operationIndex: 0, sourceAffixId: id, sourceAffixRevision: revision, parameterKey: "power", operation: "flat_adjust" as const, direction: "increase" as const, magnitude: 1, publishedMagnitudeRange: { min: 0, max: 1, ruleSetVersion: "ruleset-v3-migrated-1" } }], passivePayload: null });

function directV23State(partCount = 1) {
  const state = migrateWorkspaceState(legacyInput(22));
  const seriesId = state.seriesDefinitions[0]!.id;
  const affixValue = affixPayload();
  const affix = { affixId: "affix:project", revision: 1, contentHash: hash({ affixId: "affix:project", revision: 1, payload: affixValue }), payload: affixValue };
  const ref = { id: affix.affixId, revision: affix.revision, contentHash: affix.contentHash };
  const parts = Array.from({ length: partCount }, (_, index) => withPartHashes({
    partId: `part:${index}`, seriesId, revision: 1,
    partType: (["rod", "reel", "line", "rod"] as const)[index]!,
    fishingMethodId: "method:lure", materialTypeId: "material:carbon", functionProfileId: "function:cast", functionIntensity: 2 as const, weightBandIds: ["band:one"],
    defaultEntryRefs: [], technologyRefs: [], inputFingerprint: "", contentHash: "",
  }));
  state.v23SeriesPartRevisions = parts;
  state.v23SeriesPartHeads = parts.map((part) => ({ seriesId: part.seriesId, partId: part.partId, revision: part.revision }));
  state.v23AffixDefinitions = [affix];
  state.v23MigrationSourceEvidence = [];
  state.v23LegacyReadAdapters = [];
  state.v23SkuDrawerRevisions = [withSkuHashes({
    skuId: "sku:one", revision: 1, seriesId, partId: "part:0", weightBandId: "band:one",
    partRevision: 1, match: { status: "NEEDS_MIGRATION_REVIEW" as const },
    removedInheritedEntryIds: [], addedEntryRefs: [{ kind: "STABLE_AFFIX_REF" as const, ref }], localEntryCopies: [], technologyRefs: [],
    quality: { status: "UNASSESSED" as const }, skuPatchIds: [], modelIds: [], defaultModelId: null, displayOrder: 0, validationSummary: [], status: "draft", contentHash: "",
  })];
  state.v23SkuDrawerHeads = [{ skuId: "sku:one", revision: 1 }];
  return state;
}

function assessedQuality(state: ReturnType<typeof directV23State>, overrides: Record<string, unknown> = {}) {
  const sku = state.v23SkuDrawerRevisions[0]!;
  const definition = state.v23AffixDefinitions[0]!;
  const ref = { id: definition.affixId, revision: definition.revision, contentHash: definition.contentHash };
  return {
    status: "ASSESSED" as const,
    assessment: {
      skuRevisionId: `${sku.skuId}@${sku.revision}`,
      recommendedQualityId: "quality_a_purple" as const,
      selectedQualityId: "quality_a_purple" as const,
      qualityOverrideState: "MATCHED" as const,
      qualityOverrideReason: null,
      baseAffixScore: 1,
      combinationScore: 0,
      functionScoreFactor: 1,
      finalValueScore: 1,
      affixBreakdown: [{ sourceAffixId: definition.affixId, valueScore: 1, sourceRef: "quality-sheet!B2" }],
      combinationBreakdown: [],
      qualityRangePolicyVersion: "quality:v1",
      scoringPolicyVersion: "score:v1",
      inSelectedQualityRange: true,
      inputHash: hash({ skuRevisionId: `${sku.skuId}@${sku.revision}`, affix: ref }),
      ...overrides,
    },
  };
}

test("v23 closed carriers express Parts, SKU drawers, and non-interchangeable affix entries", () => {
  const part: SeriesPartRevision = {
    partId: "part:rod", seriesId: "series:one", revision: 1, partType: "rod",
    fishingMethodId: "method:lure", materialTypeId: "material:carbon",
    functionProfileId: "function:cast", functionIntensity: 2, weightBandIds: [],
    defaultEntryRefs: [{ id: "affix:project", revision: 1, contentHash: hash({ affixId: "affix:project", revision: 1, payload: affixPayload() }) }],
    technologyRefs: [], inputFingerprint: "b".repeat(64), contentHash: "c".repeat(64),
  };
  const definition: V23AffixDefinition = {
    affixId: "affix:project", revision: 1, contentHash: hash({ affixId: "affix:project", revision: 1, payload: affixPayload() }), payload: affixPayload(),
  };
  const sku: SkuDrawerRevision = {
    skuId: "sku:one", revision: 1, seriesId: part.seriesId, partId: part.partId, partRevision: 1,
    weightBandId: "band:one", match: { status: "NEEDS_MIGRATION_REVIEW" },
    removedInheritedEntryIds: [],
    addedEntryRefs: [{ kind: "STABLE_AFFIX_REF", ref: { id: definition.affixId, revision: definition.revision, contentHash: definition.contentHash } }],
    localEntryCopies: [{ kind: "LOCAL_AFFIX_COPY", localCopyId: "copy:one", sourceRef: { id: definition.affixId, revision: 1, contentHash: definition.contentHash }, payload: affixPayload(), copyHash: hash({ localCopyId: "copy:one", sourceRef: { id: definition.affixId, revision: 1, contentHash: definition.contentHash }, payload: affixPayload() }) }],
    technologyRefs: [], quality: { status: "UNASSESSED" }, skuPatchIds: [], modelIds: [], defaultModelId: null, displayOrder: 0, validationSummary: [], status: "draft",
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
  assert.deepEqual(adapter.rawSourcePayload, sku);
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

test("implicit schema v1 source evidence remains verbatim while forged schema declarations fail closed", () => {
  const legacy = legacyInput(9);
  delete legacy.schemaVersion;
  const snapshotsBefore = structuredClone(legacy.configurationSnapshots);
  const migrated = migrateWorkspaceState(legacy);
  assert.equal(migrated.schemaVersion, 23);
  assert.equal(migrated.v23MigrationSourceEvidence[0]?.sourceSchemaVersion, 1);
  assert.deepEqual(migrated.v23MigrationSourceEvidence[0]?.rawWorkspacePayload, legacy);
  assert.equal(Object.hasOwn(migrated.v23MigrationSourceEvidence[0]!.rawWorkspacePayload, "schemaVersion"), false);
  assert.deepEqual(migrated.configurationSnapshots, snapshotsBefore);
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);

  const forged = directV23State();
  const raw = { schemaVersion: 2, legacy: true };
  forged.v23MigrationSourceEvidence = [{ sourceEvidenceId: "source:v1", sourceSchemaVersion: 1, rawWorkspacePayload: raw, rawWorkspacePayloadHash: deterministicHash(raw) }];
  assert.throws(() => migrateWorkspaceState(forged), /V23_SOURCE_SCHEMA_VERSION_MISMATCH/);
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
  for (const [key, value] of Object.entries({ v23SeriesPartRevisions: [], v23SkuDrawerRevisions: null, v23SkuDrawerHeads: [], v23AffixDefinitions: {}, v23MigrationSourceEvidence: [], v23LegacyReadAdapters: [] })) {
    const malformed = legacyInput(22);
    malformed[key] = value;
    const unchanged = structuredClone(malformed);
    assert.throws(() => migrateWorkspaceState(malformed), /V23_MIGRATION_PARTIAL_STATE_CONFLICT/);
    assert.deepEqual(malformed, unchanged);
  }
});

test("schema v23 directly validates one, two, and three unique enabled Parts", () => {
  for (const count of [1, 2, 3]) {
    const state = directV23State(count);
    assert.deepEqual(migrateWorkspaceState(state), state);
  }
});

test("schema v23 rejects duplicate or overlong Part groups and a SKU without its own Series Part", () => {
  const duplicate = directV23State(2);
  duplicate.v23SeriesPartRevisions[1] = withPartHashes({ ...duplicate.v23SeriesPartRevisions[1]!, partType: "rod" as const }) as SeriesPartRevision;
  assert.throws(() => migrateWorkspaceState(duplicate), /V23_SERIES_PART_TYPE_DUPLICATE/);

  const overlong = directV23State(4);
  assert.throws(() => migrateWorkspaceState(overlong), /V23_SERIES_PART_COUNT_INVALID/);

  const missing = directV23State();
  missing.v23SkuDrawerRevisions[0] = withSkuHashes({ ...missing.v23SkuDrawerRevisions[0]!, partId: "part:missing", match: { status: "NEEDS_MIGRATION_REVIEW" as const } });
  assert.throws(() => migrateWorkspaceState(missing), /V23_SKU_PART_UNRESOLVED/);

  const crossSeries = directV23State();
  crossSeries.v23SkuDrawerRevisions[0] = withSkuHashes({ ...crossSeries.v23SkuDrawerRevisions[0]!, seriesId: "series:other", match: { status: "NEEDS_MIGRATION_REVIEW" as const } });
  assert.throws(() => migrateWorkspaceState(crossSeries), /V23_SKU_PART_UNRESOLVED/);
});

test("v23 Parts close weight-band declarations and parent Series identity", () => {
  const duplicateBands = directV23State();
  duplicateBands.v23SeriesPartRevisions[0]!.weightBandIds = ["band:one", "band:one"];
  duplicateBands.v23SeriesPartRevisions[0] = withPartHashes(duplicateBands.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  assert.throws(() => migrateWorkspaceState(duplicateBands), /V23_PART_WEIGHT_BAND_DUPLICATE/);
  const invalidBand = directV23State();
  invalidBand.v23SeriesPartRevisions[0]!.weightBandIds = [""];
  invalidBand.v23SeriesPartRevisions[0] = withPartHashes(invalidBand.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  assert.throws(() => migrateWorkspaceState(invalidBand), /V23_PART_WEIGHT_BAND_ID_INVALID/);
  const orphan = directV23State();
  orphan.v23SeriesPartRevisions[0]!.seriesId = "series:missing";
  orphan.v23SeriesPartRevisions[0] = withPartHashes(orphan.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  assert.throws(() => migrateWorkspaceState(orphan), /V23_PART_SERIES_UNRESOLVED/);
  const repeated = directV23State();
  repeated.seriesDefinitions.push(structuredClone(repeated.seriesDefinitions[0]!));
  assert.throws(() => migrateWorkspaceState(repeated), /V23_PART_SERIES_DUPLICATE/);
});

test("v23 Part heads and local copy ownership are explicit rather than inferred", () => {
  const revisions = directV23State();
  revisions.v23SeriesPartRevisions.push(withPartHashes({ ...revisions.v23SeriesPartRevisions[0]!, revision: 2, functionIntensity: 3 }) as SeriesPartRevision);
  revisions.v23SeriesPartHeads = [{ seriesId: revisions.v23SeriesPartRevisions[0]!.seriesId, partId: "part:0", revision: 1 }];
  assert.deepEqual(migrateWorkspaceState(revisions).v23SeriesPartHeads, revisions.v23SeriesPartHeads);
  const noHead = directV23State(); noHead.v23SeriesPartHeads = [];
  assert.throws(() => migrateWorkspaceState(noHead), /V23_SERIES_PART_HEAD_REQUIRED/);
  const duplicateHead = directV23State(); duplicateHead.v23SeriesPartHeads.push(structuredClone(duplicateHead.v23SeriesPartHeads[0]!));
  assert.throws(() => migrateWorkspaceState(duplicateHead), /V23_SERIES_PART_HEAD_DUPLICATE/);
  const danglingHead = directV23State(); danglingHead.v23SeriesPartHeads[0]!.revision = 99;
  assert.throws(() => migrateWorkspaceState(danglingHead), /V23_SERIES_PART_HEAD_UNRESOLVED/);
  const copies = directV23State();
  const copyPayload = { ...affixPayload(), semanticContributionKey: "copy:shared" };
  const copy = { kind: "LOCAL_AFFIX_COPY" as const, localCopyId: "copy:shared", sourceRef: { id: copies.v23AffixDefinitions[0]!.affixId, revision: 1, contentHash: copies.v23AffixDefinitions[0]!.contentHash }, payload: copyPayload, copyHash: "" };
  copy.copyHash = hash({ localCopyId: copy.localCopyId, sourceRef: copy.sourceRef, payload: copy.payload });
  copies.v23SkuDrawerRevisions[0]!.localEntryCopies = [copy]; copies.v23SkuDrawerRevisions[0] = withSkuHashes(copies.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  copies.v23SkuDrawerRevisions.push(withSkuHashes({ ...copies.v23SkuDrawerRevisions[0]!, revision: 2 }) as SkuDrawerRevision);
  assert.equal(migrateWorkspaceState(copies).v23SkuDrawerRevisions.length, 2);
  const duplicateCopy = structuredClone(copies); duplicateCopy.v23SkuDrawerRevisions[0]!.localEntryCopies.push(structuredClone(copy));
  duplicateCopy.v23SkuDrawerRevisions[0] = withSkuHashes(duplicateCopy.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(duplicateCopy), /V23_LOCAL_COPY_ID_DUPLICATE/);
  const crossSkuCopy = structuredClone(copies); crossSkuCopy.v23SkuDrawerRevisions.push(withSkuHashes({ ...crossSkuCopy.v23SkuDrawerRevisions[0]!, skuId: "sku:other", revision: 1 }) as SkuDrawerRevision);
  assert.throws(() => migrateWorkspaceState(crossSkuCopy), /V23_LOCAL_COPY_ID_OWNER_CONFLICT/);
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
  quality.v23SkuDrawerRevisions[0]!.quality = assessedQuality(quality, { selectedQualityId: "bogus" }) as never;
  assert.throws(() => migrateWorkspaceState(quality), /V23_SKU_QUALITY_ID_INVALID/);

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
  assert.throws(() => migrateWorkspaceState(duplicateSku), /V23_SKU_ID_REVISION_DUPLICATE/);

  const malformedEvidence = directV23State();
  malformedEvidence.v23MigrationSourceEvidence = [{ sourceEvidenceId: "source:one", sourceSchemaVersion: 22, rawWorkspacePayload: { x: 1 }, rawWorkspacePayloadHash: hash("a"), extra: true } as never];
  assert.throws(() => migrateWorkspaceState(malformedEvidence), /V23_SOURCE_EVIDENCE_SCHEMA_INVALID/);

  const danglingAdapter = directV23State();
  danglingAdapter.v23LegacyReadAdapters = [{
    adapterId: "adapter:one", kind: "LEGACY_NEEDS_REVIEW", sourceEvidenceId: "source:missing", targetSkuId: "legacy:sku", sourceKind: "LEGACY_SKU_DRAWER", sourceRecordId: "legacy:sku", rawSourcePayload: { id: "legacy:sku" }, sourceSeriesId: null,
    rawSeriesPayload: null, lineage: { kind: "SINGLE_SOURCE" }, diagnosticCodes: ["V23_PART_UNRESOLVED"], status: "NEEDS_REVIEW",
  }];
  assert.throws(() => migrateWorkspaceState(danglingAdapter), /V23_LEGACY_ADAPTER_EVIDENCE_UNRESOLVED/);
});

test("v23 identity resolution remains unambiguous when stable IDs contain old key separators", () => {
  const state = directV23State();
  state.seriesDefinitions = [
    { ...state.seriesDefinitions[0]!, id: "series:alpha" },
    { ...state.seriesDefinitions[0]!, id: "series:alpha:beta" },
  ];
  state.v23SeriesPartRevisions[0]!.seriesId = "series:alpha";
  state.v23SeriesPartRevisions[0]!.partId = "beta:part:one";
  state.v23SkuDrawerRevisions[0]!.seriesId = "series:alpha";
  state.v23SkuDrawerRevisions[0]!.partId = "beta:part:one";
  state.v23SkuDrawerRevisions[0]!.match = { status: "NEEDS_MIGRATION_REVIEW" };
  state.v23SeriesPartRevisions.push({
    ...structuredClone(state.v23SeriesPartRevisions[0]!),
    seriesId: "series:alpha:beta",
    partId: "part:one",
    partType: "reel",
  });
  const secondPayload = { ...affixPayload("affix:project@revision:1", 1), semanticContributionKey: "second" };
  const secondAffix = { affixId: "affix:project@revision:1", revision: 1, contentHash: hash({ affixId: "affix:project@revision:1", revision: 1, payload: secondPayload }), payload: secondPayload };
  state.v23AffixDefinitions.push(secondAffix);
  state.v23SeriesPartRevisions[0]!.defaultEntryRefs = [
    { id: "affix:project", revision: 1, contentHash: state.v23AffixDefinitions[0]!.contentHash },
    { id: secondAffix.affixId, revision: secondAffix.revision, contentHash: secondAffix.contentHash },
  ];
  state.v23SkuDrawerRevisions[0]!.addedEntryRefs = [];
  state.v23SeriesPartRevisions[0] = withPartHashes(state.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  state.v23SeriesPartRevisions[1] = withPartHashes(state.v23SeriesPartRevisions[1]!) as SeriesPartRevision;
  state.v23SeriesPartHeads = state.v23SeriesPartRevisions.map((part) => ({ seriesId: part.seriesId, partId: part.partId, revision: part.revision }));
  state.v23SkuDrawerRevisions[0] = withSkuHashes(state.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.equal(migrateWorkspaceState(state).v23SeriesPartRevisions.length, 2);
});

test("v23 recomputes content identities and accepts only non-conflicting historical revisions", () => {
  const tampered = directV23State();
  (tampered.v23AffixDefinitions[0]!.payload as unknown as { description: string }).description = "tampered";
  assert.throws(() => migrateWorkspaceState(tampered), /V23_AFFIX_CONTENT_HASH_MISMATCH/);

  const conflicting = directV23State();
  const conflictingPayload = { ...affixPayload(), description: "different" };
  conflicting.v23AffixDefinitions.push({ ...conflicting.v23AffixDefinitions[0]!, payload: conflictingPayload, contentHash: hash({ affixId: "affix:project", revision: 1, payload: conflictingPayload }) });
  assert.throws(() => migrateWorkspaceState(conflicting), /V23_AFFIX_ID_REVISION_DUPLICATE/);

  const historical = directV23State();
  historical.v23SeriesPartRevisions.push(withPartHashes({ ...historical.v23SeriesPartRevisions[0]!, revision: 2, functionIntensity: 3 }) as SeriesPartRevision);
  historical.v23SkuDrawerRevisions.push(withSkuHashes({ ...historical.v23SkuDrawerRevisions[0]!, revision: 2, partRevision: 2, match: { status: "NEEDS_MIGRATION_REVIEW" as const } }) as SkuDrawerRevision);
  assert.equal(migrateWorkspaceState(historical).v23SeriesPartRevisions.length, 2);

  const forgedMatch = directV23State();
  forgedMatch.v23SkuDrawerRevisions[0]!.match = validMatch({ ...sixKey(), functionIntensity: 3 });
  forgedMatch.v23SkuDrawerRevisions[0] = withSkuHashes(forgedMatch.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(forgedMatch), /V23_SKU_MATCHED_KEY_MISMATCH/);

  const invalidWithTemplate = directV23State();
  invalidWithTemplate.v23SkuDrawerRevisions[0]!.match = { status: "INVALID_NO_MATCH", functionTemplateRef: { templateId: "x", revisionId: "1", contentHash: hash("x") } } as never;
  invalidWithTemplate.v23SkuDrawerRevisions[0] = withSkuHashes(invalidWithTemplate.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(invalidWithTemplate), /V23_SKU_MATCH_SCHEMA_INVALID/);
});

test("v23 closes quality, technology, source-evidence, and adapter chains", () => {
  const fingerprintIsolation = directV23State();
  const beforeFingerprint = (fingerprintIsolation.v23SkuDrawerRevisions[0]!.match as { inputFingerprint: string }).inputFingerprint;
  const beforeContent = fingerprintIsolation.v23SkuDrawerRevisions[0]!.contentHash;
  assert.equal((fingerprintIsolation.v23SkuDrawerRevisions[0]!.match as { inputFingerprint: string }).inputFingerprint, beforeFingerprint);
  assert.equal(fingerprintIsolation.v23SkuDrawerRevisions[0]!.contentHash, beforeContent);
  assert.deepEqual(migrateWorkspaceState(fingerprintIsolation).v23SkuDrawerRevisions, fingerprintIsolation.v23SkuDrawerRevisions);

  const affixIsolation = directV23State();
  const affixFingerprint = (affixIsolation.v23SkuDrawerRevisions[0]!.match as { inputFingerprint: string }).inputFingerprint;
  affixIsolation.v23AffixDefinitions[0]!.payload = { ...affixPayload(), description: "changed" };
  affixIsolation.v23AffixDefinitions[0]!.contentHash = hash({ affixId: "affix:project", revision: 1, payload: affixIsolation.v23AffixDefinitions[0]!.payload });
  affixIsolation.v23SkuDrawerRevisions[0]!.addedEntryRefs[0]!.ref.contentHash = affixIsolation.v23AffixDefinitions[0]!.contentHash;
  affixIsolation.v23SkuDrawerRevisions[0] = withSkuHashes(affixIsolation.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.equal((affixIsolation.v23SkuDrawerRevisions[0]!.match as { inputFingerprint: string }).inputFingerprint, affixFingerprint);
  assert.deepEqual(migrateWorkspaceState(affixIsolation).v23SkuDrawerRevisions, affixIsolation.v23SkuDrawerRevisions);

  const attempted = directV23State();
  const key = sixKey();
  attempted.v23SkuDrawerRevisions[0]!.match = { status: "INVALID_NO_MATCH", attemptedKey: key, inputFingerprint: hash(key) };
  attempted.v23SkuDrawerRevisions[0] = withSkuHashes(attempted.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.deepEqual(migrateWorkspaceState(attempted).v23SkuDrawerRevisions, attempted.v23SkuDrawerRevisions);
  attempted.v23SkuDrawerRevisions[0]!.match = { status: "NEEDS_MIGRATION_REVIEW", attemptedKey: key } as never;
  attempted.v23SkuDrawerRevisions[0] = withSkuHashes(attempted.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(attempted), /V23_SKU_MATCH_SCHEMA_INVALID/);

  const quality = directV23State();
  quality.v23SkuDrawerRevisions[0]!.quality = assessedQuality(quality, { selectedQualityId: "quality_unknown" }) as never;
  quality.v23SkuDrawerRevisions[0] = withSkuHashes(quality.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(quality), /V23_SKU_QUALITY_ID_INVALID/);

  const incompleteNoRecommendation = directV23State();
  incompleteNoRecommendation.v23SkuDrawerRevisions[0]!.quality = assessedQuality(incompleteNoRecommendation, { recommendedQualityId: null, qualityOverrideState: "NO_RECOMMENDATION", qualityOverrideReason: "" , inSelectedQualityRange: false }) as never;
  incompleteNoRecommendation.v23SkuDrawerRevisions[0] = withSkuHashes(incompleteNoRecommendation.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(incompleteNoRecommendation), /V23_SKU_QUALITY_OVERRIDE_INVALID/);
  const missingNoRecommendationReason = directV23State();
  missingNoRecommendationReason.v23SkuDrawerRevisions[0]!.quality = { status: "ASSESSED" } as never;
  missingNoRecommendationReason.v23SkuDrawerRevisions[0] = withSkuHashes(missingNoRecommendationReason.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(missingNoRecommendationReason), /V23_SKU_QUALITY_SCHEMA_INVALID/);

  const technology = directV23State();
  const source = technology.technologies[0]!;
  technology.v23SeriesPartRevisions[0]!.technologyRefs = [{ id: source.id, revision: source.version, contentHash: "0".repeat(64) }];
  technology.v23SeriesPartRevisions[0] = withPartHashes(technology.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  assert.throws(() => migrateWorkspaceState(technology), /V23_TECHNOLOGY_REGISTRY_UNAVAILABLE/);

  const evidence = directV23State();
  const raw = { schemaVersion: 22, original: true, skuDrawers: [{ id: "legacy:sku" }], seriesDefinitions: [] };
  evidence.v23MigrationSourceEvidence = [{ sourceEvidenceId: "source:one", sourceSchemaVersion: 22, rawWorkspacePayload: raw, rawWorkspacePayloadHash: deterministicHash(raw) }];
  evidence.v23LegacyReadAdapters = [{ adapterId: "adapter:one", kind: "LEGACY_NEEDS_REVIEW", sourceEvidenceId: "source:one", targetSkuId: "legacy:sku", sourceKind: "LEGACY_SKU_DRAWER", sourceRecordId: "legacy:sku", rawSourcePayload: { id: "legacy:sku" }, sourceSeriesId: null, rawSeriesPayload: null, lineage: { kind: "SINGLE_SOURCE" }, diagnosticCodes: ["V23_SERIES_UNRESOLVED", "V23_PART_UNRESOLVED"], status: "NEEDS_REVIEW" }];
  assert.deepEqual(migrateWorkspaceState(evidence).v23LegacyReadAdapters, evidence.v23LegacyReadAdapters);
  const rawTamper = structuredClone(evidence); rawTamper.v23LegacyReadAdapters[0]!.rawSourcePayload = { id: "legacy:sku", tampered: true };
  assert.throws(() => migrateWorkspaceState(rawTamper), /V23_LEGACY_ADAPTER_SKU_CHAIN_INVALID/);
  const wrongKind = structuredClone(evidence); wrongKind.v23LegacyReadAdapters[0]!.sourceKind = "LEGACY_OFFICIAL_SKU";
  assert.throws(() => migrateWorkspaceState(wrongKind), /V23_LEGACY_ADAPTER_SKU_CHAIN_INVALID|V23_LEGACY_ADAPTER_TARGET_SKU_INVALID/);
  const wrongTarget = structuredClone(evidence); wrongTarget.v23LegacyReadAdapters[0]!.targetSkuId = "other";
  assert.throws(() => migrateWorkspaceState(wrongTarget), /V23_LEGACY_ADAPTER_TARGET_SKU_INVALID/);
  const unknownAdapterField = structuredClone(evidence); (unknownAdapterField.v23LegacyReadAdapters[0] as unknown as Record<string, unknown>).extra = true;
  assert.throws(() => migrateWorkspaceState(unknownAdapterField), /V23_LEGACY_ADAPTER_SCHEMA_INVALID/);
  evidence.v23MigrationSourceEvidence[0]!.rawWorkspacePayload = { schemaVersion: 23 };
  assert.throws(() => migrateWorkspaceState(evidence), /V23_SOURCE_SCHEMA_VERSION_MISMATCH/);
});

test("v23 closes project affix, local copy, SKU lifecycle, and Phase-A template boundaries", () => {
  const rehashAffixAndSku = (state: ReturnType<typeof directV23State>) => {
    const affix = state.v23AffixDefinitions[0]!;
    affix.contentHash = hash({ affixId: affix.affixId, revision: affix.revision, payload: affix.payload });
    state.v23SkuDrawerRevisions[0]!.addedEntryRefs[0]!.ref.contentHash = affix.contentHash;
    state.v23SkuDrawerRevisions[0] = withSkuHashes(state.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  };
  const passivePayload = () => ({
    name: "Passive", category: "passive" as const, itemPartId: "part:rod", semanticContributionKey: "skill:one", stackingPolicy: "stack" as const, generationPolicy: "normal" as const, rarity: "common" as const,
    valueScore: 1, tags: [], description: "passive", enabled: true, operations: [] as [],
    passivePayload: { skillId: "skill:one", name: "Skill", itemPartId: "part:rod", triggerType: "manual", triggerDescription: "trigger", effectTarget: "target", effectLogicDescription: "effect", exampleParameters: { enabled: true, power: 1, label: "x" }, durationDescription: "duration", cooldownDescription: "cooldown", resetDescription: "reset", stackingDescription: "stacking", playerDescription: "player", simulatorReferenceKey: null },
  });
  const payloadExtra = directV23State();
  (payloadExtra.v23AffixDefinitions[0]!.payload as unknown as Record<string, unknown>).extra = true;
  payloadExtra.v23AffixDefinitions[0]!.contentHash = hash({ affixId: "affix:project", revision: 1, payload: payloadExtra.v23AffixDefinitions[0]!.payload });
  assert.throws(() => migrateWorkspaceState(payloadExtra), /V23_AFFIX_PAYLOAD_SCHEMA_INVALID/);
  const valid = directV23State();
  valid.v23SkuDrawerRevisions[0]!.match = validMatch(); valid.v23SkuDrawerRevisions[0] = withSkuHashes(valid.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(valid), /V23_TEMPLATE_REGISTRY_NO_MATCH/);
  const defaultModel = directV23State(); defaultModel.v23SkuDrawerRevisions[0]!.defaultModelId = "model:missing"; defaultModel.v23SkuDrawerRevisions[0] = withSkuHashes(defaultModel.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(defaultModel), /V23_SKU_ASSOCIATION_RESOLVER_UNAVAILABLE/);
  const order = directV23State(); order.v23SkuDrawerRevisions[0]!.displayOrder = -1; order.v23SkuDrawerRevisions[0] = withSkuHashes(order.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(order), /V23_SKU_DISPLAY_ORDER_INVALID/);
  const status = directV23State(); status.v23SkuDrawerRevisions[0]!.status = "invalid" as never; status.v23SkuDrawerRevisions[0] = withSkuHashes(status.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(status), /V23_SKU_STATUS_INVALID/);
  const summary = directV23State(); summary.v23SkuDrawerRevisions[0]!.validationSummary = [{ code: "x", severity: "error", gate: "NONE", state: "OPEN", message: "x" } as never]; summary.v23SkuDrawerRevisions[0] = withSkuHashes(summary.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(summary), /V23_SKU_VALIDATION_ISSUE_INVALID/);
  const summaryExtra = directV23State(); summaryExtra.v23SkuDrawerRevisions[0]!.validationSummary = [{ code: "x", severity: "ERROR", gate: "NONE", state: "OPEN", message: "x", extra: true } as never]; summaryExtra.v23SkuDrawerRevisions[0] = withSkuHashes(summaryExtra.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(summaryExtra), /V23_SKU_VALIDATION_ISSUE_SCHEMA_INVALID/);
  const local = directV23State(); const ref = { id: local.v23AffixDefinitions[0]!.affixId, revision: 1, contentHash: local.v23AffixDefinitions[0]!.contentHash }; local.v23SkuDrawerRevisions[0]!.localEntryCopies = [{ kind: "LOCAL_AFFIX_COPY", localCopyId: "copy:bad", sourceRef: ref, payload: {} as never, copyHash: hash({ localCopyId: "copy:bad", sourceRef: ref, payload: {} }) }]; local.v23SkuDrawerRevisions[0] = withSkuHashes(local.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(local), /V23_AFFIX_PAYLOAD_SCHEMA_INVALID/);
  const passive = directV23State(); passive.v23AffixDefinitions[0]!.payload = passivePayload(); rehashAffixAndSku(passive);
  assert.doesNotThrow(() => migrateWorkspaceState(passive));
  const passiveNan = structuredClone(passive); (passiveNan.v23AffixDefinitions[0]!.payload as unknown as { passivePayload: { exampleParameters: Record<string, unknown> } }).passivePayload.exampleParameters.power = Number.NaN;
  assert.throws(() => migrateWorkspaceState(passiveNan), /V23_AFFIX_PASSIVE_PARAMETERS_INVALID/);
  const passiveExtra = structuredClone(passive); (passiveExtra.v23AffixDefinitions[0]!.payload as unknown as { passivePayload: Record<string, unknown> }).passivePayload.extra = true; rehashAffixAndSku(passiveExtra);
  assert.throws(() => migrateWorkspaceState(passiveExtra), /V23_AFFIX_PASSIVE_SCHEMA_INVALID/);
  const setNan = directV23State(); (setNan.v23AffixDefinitions[0]!.payload as unknown as { operations: unknown[] }).operations[0] = { operationId: "op:set", operationIndex: 0, sourceAffixId: "affix:project", sourceAffixRevision: 1, parameterKey: "power", operation: "set", value: Number.NaN };
  assert.throws(() => migrateWorkspaceState(setNan), /V23_AFFIX_OPERATION_VALUE_INVALID/);
});

test("v23 Phase A keeps registry-dependent carriers closed and requires one head per Part", () => {
  const unheaded = directV23State(2);
  unheaded.v23SeriesPartHeads.pop();
  assert.throws(() => migrateWorkspaceState(unheaded), /V23_SERIES_PART_HEAD_REQUIRED/);

  const historical = directV23State();
  historical.v23SeriesPartRevisions.push(withPartHashes({ ...historical.v23SeriesPartRevisions[0]!, revision: 2, functionIntensity: 3 }) as SeriesPartRevision);
  assert.doesNotThrow(() => migrateWorkspaceState(historical));

  const partTechnology = directV23State();
  partTechnology.v23SeriesPartRevisions[0]!.technologyRefs = [{ id: "technology:one", revision: 1, contentHash: "a".repeat(64) }];
  partTechnology.v23SeriesPartRevisions[0] = withPartHashes(partTechnology.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  assert.throws(() => migrateWorkspaceState(partTechnology), /V23_TECHNOLOGY_REGISTRY_UNAVAILABLE/);

  const skuTechnology = directV23State();
  skuTechnology.v23SkuDrawerRevisions[0]!.technologyRefs = [{ id: "technology:one", revision: 1, contentHash: "a".repeat(64) }];
  skuTechnology.v23SkuDrawerRevisions[0] = withSkuHashes(skuTechnology.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(skuTechnology), /V23_TECHNOLOGY_REGISTRY_UNAVAILABLE/);

  const lifecycle = directV23State();
  lifecycle.v23SkuDrawerRevisions[0]!.status = "approved";
  lifecycle.v23SkuDrawerRevisions[0] = withSkuHashes(lifecycle.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(lifecycle), /V23_SKU_LIFECYCLE_UNAVAILABLE/);

  const associations = directV23State();
  associations.v23SkuDrawerRevisions[0]!.modelIds = ["model:one"];
  associations.v23SkuDrawerRevisions[0] = withSkuHashes(associations.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(associations), /V23_SKU_ASSOCIATION_RESOLVER_UNAVAILABLE/);

  const blockedLifecycle = directV23State();
  blockedLifecycle.v23SkuDrawerRevisions[0]!.status = "superseded";
  blockedLifecycle.v23SkuDrawerRevisions[0]!.validationSummary = [{ code: "block", severity: "BLOCKER", gate: "PUBLISH", state: "OPEN", message: "historical diagnostic" }];
  blockedLifecycle.v23SkuDrawerRevisions[0] = withSkuHashes(blockedLifecycle.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.doesNotThrow(() => migrateWorkspaceState(blockedLifecycle));
});

test("v23 affix references must match the authoritative Part itemPartId", () => {
  const linePayload = { ...affixPayload("affix:line"), itemPartId: "part:line" };
  const lineAffix = { affixId: "affix:line", revision: 1, contentHash: hash({ affixId: "affix:line", revision: 1, payload: linePayload }), payload: linePayload };
  const lineRef = { id: lineAffix.affixId, revision: lineAffix.revision, contentHash: lineAffix.contentHash };

  const partDefault = directV23State();
  partDefault.v23AffixDefinitions.push(lineAffix);
  partDefault.v23SeriesPartRevisions[0]!.defaultEntryRefs = [lineRef];
  partDefault.v23SeriesPartRevisions[0] = withPartHashes(partDefault.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  assert.throws(() => migrateWorkspaceState(partDefault), /V23_PART_DEFAULT_ENTRY_ITEM_PART_MISMATCH/);

  const added = directV23State();
  added.v23AffixDefinitions.push(lineAffix);
  added.v23SkuDrawerRevisions[0]!.addedEntryRefs = [{ kind: "STABLE_AFFIX_REF", ref: lineRef }];
  added.v23SkuDrawerRevisions[0] = withSkuHashes(added.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(added), /V23_SKU_ADDED_ENTRY_REF_ITEM_PART_MISMATCH/);

  const localSource = directV23State();
  localSource.v23AffixDefinitions.push(lineAffix);
  localSource.v23SkuDrawerRevisions[0]!.localEntryCopies = [{ kind: "LOCAL_AFFIX_COPY", localCopyId: "copy:line", sourceRef: lineRef, payload: linePayload, copyHash: hash({ localCopyId: "copy:line", sourceRef: lineRef, payload: linePayload }) }];
  localSource.v23SkuDrawerRevisions[0] = withSkuHashes(localSource.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(localSource), /V23_SKU_LOCAL_COPY_ITEM_PART_MISMATCH/);

  const localPayload = directV23State();
  const rodRef = { id: localPayload.v23AffixDefinitions[0]!.affixId, revision: 1, contentHash: localPayload.v23AffixDefinitions[0]!.contentHash };
  localPayload.v23SkuDrawerRevisions[0]!.localEntryCopies = [{ kind: "LOCAL_AFFIX_COPY", localCopyId: "copy:payload", sourceRef: rodRef, payload: { ...affixPayload(), itemPartId: "part:line" }, copyHash: "" }];
  const copy = localPayload.v23SkuDrawerRevisions[0]!.localEntryCopies[0]!;
  copy.copyHash = hash({ localCopyId: copy.localCopyId, sourceRef: copy.sourceRef, payload: copy.payload });
  localPayload.v23SkuDrawerRevisions[0] = withSkuHashes(localPayload.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(localPayload), /V23_SKU_LOCAL_COPY_ITEM_PART_MISMATCH/);

  assert.doesNotThrow(() => migrateWorkspaceState(directV23State()));
});

test("v23 closes SKU heads, affix contribution metadata, and Part weight-band membership", () => {
  const missingHead = directV23State();
  missingHead.v23SkuDrawerHeads = [];
  assert.throws(() => migrateWorkspaceState(missingHead), /V23_SKU_HEAD_REQUIRED/);

  const duplicateHead = directV23State();
  duplicateHead.v23SkuDrawerHeads.push({ skuId: "sku:one", revision: 1 });
  assert.throws(() => migrateWorkspaceState(duplicateHead), /V23_SKU_HEAD_DUPLICATE/);

  const danglingHead = directV23State();
  danglingHead.v23SkuDrawerHeads[0]!.revision = 99;
  assert.throws(() => migrateWorkspaceState(danglingHead), /V23_SKU_HEAD_UNRESOLVED/);

  const historicalHead = directV23State();
  historicalHead.v23SkuDrawerRevisions.push(withSkuHashes({ ...historicalHead.v23SkuDrawerRevisions[0]!, revision: 2 }) as SkuDrawerRevision);
  assert.doesNotThrow(() => migrateWorkspaceState(historicalHead));

  const missingContribution = directV23State();
  delete (missingContribution.v23AffixDefinitions[0]!.payload as unknown as Record<string, unknown>).semanticContributionKey;
  missingContribution.v23AffixDefinitions[0]!.contentHash = hash({ affixId: "affix:project", revision: 1, payload: missingContribution.v23AffixDefinitions[0]!.payload });
  assert.throws(() => migrateWorkspaceState(missingContribution), /V23_AFFIX_PAYLOAD_SCHEMA_INVALID/);

  const invalidStacking = directV23State();
  (invalidStacking.v23AffixDefinitions[0]!.payload as unknown as Record<string, unknown>).stackingPolicy = "implicit";
  invalidStacking.v23AffixDefinitions[0]!.contentHash = hash({ affixId: "affix:project", revision: 1, payload: invalidStacking.v23AffixDefinitions[0]!.payload });
  assert.throws(() => migrateWorkspaceState(invalidStacking), /V23_AFFIX_PAYLOAD_INVALID/);

  const missingBand = directV23State();
  missingBand.v23SkuDrawerRevisions[0]!.weightBandId = "band:missing";
  missingBand.v23SkuDrawerRevisions[0] = withSkuHashes(missingBand.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(missingBand), /V23_SKU_WEIGHT_BAND_UNDECLARED/);

  const historicalBand = directV23State();
  historicalBand.v23SeriesPartRevisions.push(withPartHashes({ ...historicalBand.v23SeriesPartRevisions[0]!, revision: 2, weightBandIds: ["band:two"] }) as SeriesPartRevision);
  historicalBand.v23SkuDrawerRevisions.push(withSkuHashes({ ...historicalBand.v23SkuDrawerRevisions[0]!, revision: 2, partRevision: 2, weightBandId: "band:two" }) as SkuDrawerRevision);
  historicalBand.v23SkuDrawerHeads = [{ skuId: "sku:one", revision: 2 }];
  assert.doesNotThrow(() => migrateWorkspaceState(historicalBand));
});

test("v23 deduplicates stable affix IDs within each Part and SKU revision only", () => {
  assert.doesNotThrow(() => migrateWorkspaceState(directV23State()));
  const secondPayload = affixPayload("affix:project", 2);
  const secondDefinition = { affixId: "affix:project", revision: 2, contentHash: hash({ affixId: "affix:project", revision: 2, payload: secondPayload }), payload: secondPayload };

  const partExact = directV23State();
  const firstRef = { id: partExact.v23AffixDefinitions[0]!.affixId, revision: 1, contentHash: partExact.v23AffixDefinitions[0]!.contentHash };
  partExact.v23SeriesPartRevisions[0]!.defaultEntryRefs = [firstRef, structuredClone(firstRef)];
  partExact.v23SeriesPartRevisions[0] = withPartHashes(partExact.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  assert.throws(() => migrateWorkspaceState(partExact), /V23_PART_DEFAULT_ENTRY_ID_DUPLICATE/);

  const partRevision = directV23State();
  partRevision.v23AffixDefinitions.push(secondDefinition);
  partRevision.v23SeriesPartRevisions[0]!.defaultEntryRefs = [{ id: "affix:project", revision: 1, contentHash: partRevision.v23AffixDefinitions[0]!.contentHash }, { id: "affix:project", revision: 2, contentHash: secondDefinition.contentHash }];
  partRevision.v23SeriesPartRevisions[0] = withPartHashes(partRevision.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  assert.throws(() => migrateWorkspaceState(partRevision), /V23_PART_DEFAULT_ENTRY_ID_DUPLICATE/);

  const skuExact = directV23State();
  const skuRef = { id: skuExact.v23AffixDefinitions[0]!.affixId, revision: 1, contentHash: skuExact.v23AffixDefinitions[0]!.contentHash };
  skuExact.v23SkuDrawerRevisions[0]!.addedEntryRefs = [{ kind: "STABLE_AFFIX_REF", ref: skuRef }, { kind: "STABLE_AFFIX_REF", ref: structuredClone(skuRef) }];
  skuExact.v23SkuDrawerRevisions[0] = withSkuHashes(skuExact.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(skuExact), /V23_SKU_ADDED_ENTRY_REF_ID_DUPLICATE/);

  const skuRevision = directV23State();
  skuRevision.v23AffixDefinitions.push(secondDefinition);
  skuRevision.v23SkuDrawerRevisions[0]!.addedEntryRefs = [{ kind: "STABLE_AFFIX_REF", ref: { id: "affix:project", revision: 1, contentHash: skuRevision.v23AffixDefinitions[0]!.contentHash } }, { kind: "STABLE_AFFIX_REF", ref: { id: "affix:project", revision: 2, contentHash: secondDefinition.contentHash } }];
  skuRevision.v23SkuDrawerRevisions[0] = withSkuHashes(skuRevision.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(skuRevision), /V23_SKU_ADDED_ENTRY_REF_ID_DUPLICATE/);
});

test("every legacy start rejects preloaded v23 roots and retained SKU evidence needs complete adapters", () => {
  for (const version of [1, 9, 21, 22]) {
    const preloaded = legacyInput(9);
    if (version === 1) delete preloaded.schemaVersion;
    else preloaded.schemaVersion = version;
    preloaded.v23SkuDrawerHeads = [];
    assert.throws(() => migrateWorkspaceState(preloaded), /V23_MIGRATION_PARTIAL_STATE_CONFLICT/);
  }

  const incomplete = directV23State();
  const raw = { schemaVersion: 22, skuDrawers: [{ id: "legacy:one" }, { id: "legacy:two" }], officialSkus: [], seriesDefinitions: [] };
  incomplete.v23MigrationSourceEvidence = [{ sourceEvidenceId: "source:coverage", sourceSchemaVersion: 22, rawWorkspacePayload: raw, rawWorkspacePayloadHash: deterministicHash(raw) }];
  incomplete.v23LegacyReadAdapters = [{ adapterId: "adapter:one", kind: "LEGACY_NEEDS_REVIEW", sourceEvidenceId: "source:coverage", targetSkuId: "legacy:one", sourceKind: "LEGACY_SKU_DRAWER", sourceRecordId: "legacy:one", rawSourcePayload: raw.skuDrawers[0]!, sourceSeriesId: null, rawSeriesPayload: null, lineage: { kind: "SINGLE_SOURCE" }, diagnosticCodes: ["V23_SERIES_UNRESOLVED"], status: "NEEDS_REVIEW" }];
  assert.throws(() => migrateWorkspaceState(incomplete), /V23_LEGACY_ADAPTER_SOURCE_COVERAGE_INVALID/);

  const complete = directV23State();
  const sourceOne = { schemaVersion: 22, skuDrawers: [{ id: "legacy:drawer" }], officialSkus: [{ id: "legacy:official" }], seriesDefinitions: [] };
  const sourceTwo = { schemaVersion: 21, skuDrawers: [{ id: "legacy:second" }], officialSkus: [], seriesDefinitions: [] };
  complete.v23MigrationSourceEvidence = [
    { sourceEvidenceId: "source:one", sourceSchemaVersion: 22, rawWorkspacePayload: sourceOne, rawWorkspacePayloadHash: deterministicHash(sourceOne) },
    { sourceEvidenceId: "source:two", sourceSchemaVersion: 21, rawWorkspacePayload: sourceTwo, rawWorkspacePayloadHash: deterministicHash(sourceTwo) },
  ];
  const adapter = (adapterId: string, sourceEvidenceId: string, sourceKind: "LEGACY_SKU_DRAWER" | "LEGACY_OFFICIAL_SKU", source: { id: string }) => ({
    adapterId, kind: "LEGACY_NEEDS_REVIEW" as const, sourceEvidenceId,
    targetSkuId: sourceKind === "LEGACY_SKU_DRAWER" ? source.id : `legacy-sku-drawer:${deterministicHash(source.id).slice(0, 12)}`,
    sourceKind, sourceRecordId: source.id, rawSourcePayload: source, sourceSeriesId: null, rawSeriesPayload: null, lineage: { kind: "SINGLE_SOURCE" as const },
    diagnosticCodes: ["V23_SERIES_UNRESOLVED"] as V23LegacyReadAdapter["diagnosticCodes"], status: "NEEDS_REVIEW" as const,
  });
  complete.v23LegacyReadAdapters = [
    adapter("adapter:drawer", "source:one", "LEGACY_SKU_DRAWER", sourceOne.skuDrawers[0]!),
    adapter("adapter:official", "source:one", "LEGACY_OFFICIAL_SKU", sourceOne.officialSkus[0]!),
    adapter("adapter:second", "source:two", "LEGACY_SKU_DRAWER", sourceTwo.skuDrawers[0]!),
  ];
  assert.doesNotThrow(() => migrateWorkspaceState(complete));
  const duplicate = structuredClone(complete);
  duplicate.v23LegacyReadAdapters.push(adapter("adapter:duplicate", "source:one", "LEGACY_SKU_DRAWER", sourceOne.skuDrawers[0]!));
  assert.throws(() => migrateWorkspaceState(duplicate), /V23_LEGACY_ADAPTER_SOURCE_DUPLICATE/);

  const officialId = "official:collision";
  const drawerId = `legacy-sku-drawer:${deterministicHash(officialId).slice(0, 12)}`;
  const collisionSource = { schemaVersion: 22, skuDrawers: [{ id: drawerId }], officialSkus: [{ id: officialId }], seriesDefinitions: [] };
  const sameEvidenceCollision = directV23State();
  sameEvidenceCollision.v23MigrationSourceEvidence = [{ sourceEvidenceId: "source:collision", sourceSchemaVersion: 22, rawWorkspacePayload: collisionSource, rawWorkspacePayloadHash: deterministicHash(collisionSource) }];
  sameEvidenceCollision.v23LegacyReadAdapters = [
    adapter("adapter:collision-drawer", "source:collision", "LEGACY_SKU_DRAWER", collisionSource.skuDrawers[0]!),
    adapter("adapter:collision-official", "source:collision", "LEGACY_OFFICIAL_SKU", collisionSource.officialSkus[0]!),
  ];
  assert.throws(() => migrateWorkspaceState(sameEvidenceCollision), /V23_LEGACY_ADAPTER_TARGET_SKU_DUPLICATE/);

  const crossEvidenceCollision = structuredClone(sameEvidenceCollision);
  crossEvidenceCollision.v23MigrationSourceEvidence = [
    { sourceEvidenceId: "source:drawer", sourceSchemaVersion: 22, rawWorkspacePayload: { schemaVersion: 22, skuDrawers: collisionSource.skuDrawers, officialSkus: [], seriesDefinitions: [] }, rawWorkspacePayloadHash: deterministicHash({ schemaVersion: 22, skuDrawers: collisionSource.skuDrawers, officialSkus: [], seriesDefinitions: [] }) },
    { sourceEvidenceId: "source:official", sourceSchemaVersion: 21, rawWorkspacePayload: { schemaVersion: 21, skuDrawers: [], officialSkus: collisionSource.officialSkus, seriesDefinitions: [] }, rawWorkspacePayloadHash: deterministicHash({ schemaVersion: 21, skuDrawers: [], officialSkus: collisionSource.officialSkus, seriesDefinitions: [] }) },
  ];
  crossEvidenceCollision.v23LegacyReadAdapters[0]!.sourceEvidenceId = "source:drawer";
  crossEvidenceCollision.v23LegacyReadAdapters[1]!.sourceEvidenceId = "source:official";
  assert.throws(() => migrateWorkspaceState(crossEvidenceCollision), /V23_LEGACY_ADAPTER_TARGET_SKU_DUPLICATE/);

  const dualOfficial = { id: "official:lineage", candidateId: "candidate:lineage", comboId: "combo", platformId: "platform", platformPosition: "position", templateId: "template", seriesName: "series", qualityId: "A", fishMinKg: 1, fishMaxKg: 2, structureName: "structure", functionName: "function", functionLevel: "2", performanceName: "performance", performanceLevel: "standard", affixIds: [], tone: "tone", hardness: "hard", lengthM: 2, useScene: "scene", rodId: "rod", reelId: "reel", lineId: "line", priceIndex: 1, rodForce: 1, reelForce: 1, lineForce: 1, safeWorkingForce: 1, values: { power: 1 }, overrides: {}, notes: "", publishedAt: "2025-01-01T00:00:00.000Z" };
  const dualBase = { ...structuredClone(createSeedState()), officialSkus: [dualOfficial], collections: [], seriesDefinitions: [], skuDrawers: [], purchasableModels: [], configurationSnapshots: [], governanceAuditLog: [], candidates: [], templates: [], detailOverrides: [], v3Affixes: [], technologies: [], projectionPatches: [] };
  const dualRebuilt = migrateLegacyProductIdentity(dualBase, dualBase.ruleSetVersions[0]!.id);
  const dualRaw = JSON.parse(JSON.stringify({ ...dualBase, ...dualRebuilt, schemaVersion: 22, officialSkus: [dualOfficial] })) as Record<string, unknown>;
  const dualDrawer = (dualRaw.skuDrawers as Array<Record<string, unknown>>)[0]!;
  const dualTarget = dualDrawer.id as string;
  const dual = directV23State();
  dual.v23MigrationSourceEvidence = [{ sourceEvidenceId: "source:dual", sourceSchemaVersion: 22, rawWorkspacePayload: dualRaw, rawWorkspacePayloadHash: deterministicHash(dualRaw) }];
  dual.v23LegacyReadAdapters = [{ adapterId: "adapter:dual", kind: "LEGACY_NEEDS_REVIEW", sourceEvidenceId: "source:dual", targetSkuId: dualTarget, sourceKind: "LEGACY_SKU_DRAWER", sourceRecordId: dualTarget, rawSourcePayload: dualDrawer, sourceSeriesId: null, rawSeriesPayload: null, lineage: { kind: "OFFICIAL_SKU_MIGRATED_DRAWER", officialSourceRecordId: dualOfficial.id, officialRawSourcePayload: dualOfficial, officialRawSourcePayloadHash: hash(dualOfficial), drawerRawSourcePayloadHash: hash(dualDrawer) }, diagnosticCodes: ["V23_SERIES_UNRESOLVED"], status: "NEEDS_REVIEW" }];
  const dualBefore = structuredClone(dual);
  const dualMigrated = migrateWorkspaceState(dual);
  assert.deepEqual(dual, dualBefore, "v23 read/validation must not mutate the retained dual-source evidence");
  assert.deepEqual(migrateWorkspaceState(dualMigrated), dualMigrated, "a validated v23 dual lineage is idempotent");
  const syncDualEvidence = (state: ReturnType<typeof directV23State>) => {
    const evidence = state.v23MigrationSourceEvidence[0]!;
    const rawPayload = evidence.rawWorkspacePayload as Record<string, unknown>;
    const adapter = state.v23LegacyReadAdapters[0]!;
    const sourceDrawer = (rawPayload.skuDrawers as Array<Record<string, unknown>>).find((entry) => entry.id === adapter.sourceRecordId)!;
    const lineage = adapter.lineage as Exclude<V23LegacyReadAdapter["lineage"], { kind: "SINGLE_SOURCE" }>;
    const sourceOfficial = (rawPayload.officialSkus as Array<Record<string, unknown>>).find((entry) => entry.id === lineage.officialSourceRecordId)!;
    adapter.rawSourcePayload = sourceDrawer;
    adapter.lineage = { ...lineage, officialRawSourcePayload: sourceOfficial, officialRawSourcePayloadHash: hash(sourceOfficial), drawerRawSourcePayloadHash: hash(sourceDrawer) };
    evidence.rawWorkspacePayloadHash = deterministicHash(rawPayload);
  };
  const laterRuleSets = structuredClone(dual);
  const laterRaw = laterRuleSets.v23MigrationSourceEvidence[0]!.rawWorkspacePayload as Record<string, unknown>;
  const originalRuleSet = (laterRaw.ruleSetVersions as Array<Record<string, unknown>>)[0]!;
  (laterRaw.ruleSetVersions as Array<Record<string, unknown>>).unshift(
    { ...structuredClone(originalRuleSet), id: "ruleset:later-published", version: 99, status: "published" },
    { ...structuredClone(originalRuleSet), id: "ruleset:later-draft", version: 100, status: "draft" },
  );
  syncDualEvidence(laterRuleSets);
  assert.doesNotThrow(() => migrateWorkspaceState(laterRuleSets), "later draft/published insertion must not change the frozen replay version");
  const inconsistentRuleSet = structuredClone(dual);
  const inconsistentRaw = inconsistentRuleSet.v23MigrationSourceEvidence[0]!.rawWorkspacePayload as Record<string, unknown>;
  ((inconsistentRaw.skuDrawers as Array<Record<string, unknown>>)[0]!.projectionMatch as Record<string, unknown>).ruleSetVersion = "ruleset:inconsistent";
  syncDualEvidence(inconsistentRuleSet);
  assert.throws(() => migrateWorkspaceState(inconsistentRuleSet), /V23_LEGACY_ADAPTER_LINEAGE_INVALID/);
  const missingSnapshotVersion = structuredClone(dual);
  delete ((missingSnapshotVersion.v23MigrationSourceEvidence[0]!.rawWorkspacePayload as Record<string, unknown>).configurationSnapshots as Array<Record<string, unknown>>)[0]!.ruleSetVersion;
  syncDualEvidence(missingSnapshotVersion);
  assert.throws(() => migrateWorkspaceState(missingSnapshotVersion), /V23_LEGACY_ADAPTER_LINEAGE_INVALID/);
  const duplicateReplayVersion = structuredClone(dual);
  const duplicateRaw = duplicateReplayVersion.v23MigrationSourceEvidence[0]!.rawWorkspacePayload as Record<string, unknown>;
  (duplicateRaw.ruleSetVersions as Array<Record<string, unknown>>).push(structuredClone((duplicateRaw.ruleSetVersions as Array<Record<string, unknown>>)[0]!));
  syncDualEvidence(duplicateReplayVersion);
  assert.throws(() => migrateWorkspaceState(duplicateReplayVersion), /V23_LEGACY_ADAPTER_LINEAGE_INVALID/);
  const laterVersionForgery = structuredClone(dual);
  const laterForgeryRaw = laterVersionForgery.v23MigrationSourceEvidence[0]!.rawWorkspacePayload as Record<string, unknown>;
  (laterForgeryRaw.ruleSetVersions as Array<Record<string, unknown>>).unshift({ ...structuredClone((laterForgeryRaw.ruleSetVersions as Array<Record<string, unknown>>)[0]!), id: "ruleset:later", version: 99, status: "published" });
  ((laterForgeryRaw.skuDrawers as Array<Record<string, unknown>>)[0]!.projectionMatch as Record<string, unknown>).ruleSetVersion = "ruleset:later";
  (laterForgeryRaw.configurationSnapshots as Array<Record<string, unknown>>)[0]!.ruleSetVersion = "ruleset:later";
  syncDualEvidence(laterVersionForgery);
  assert.throws(() => migrateWorkspaceState(laterVersionForgery), /V23_LEGACY_ADAPTER_LINEAGE_INVALID/, "selecting a later version without rebuilding every frozen artifact is self-inconsistent");
  for (const [label, mutate] of [
    ["drawer", (rawPayload: Record<string, unknown>) => { ((rawPayload.skuDrawers as Array<Record<string, unknown>>)[0]!.targetPullKg as number) += 1; }],
    ["model", (rawPayload: Record<string, unknown>) => { ((rawPayload.purchasableModels as Array<Record<string, unknown>>)[0]!.price as number) += 1; }],
    ["snapshot", (rawPayload: Record<string, unknown>) => { ((rawPayload.configurationSnapshots as Array<Record<string, unknown>>)[0]!.finalPanelValues as Record<string, unknown>).power = 2; }],
    ["audit", (rawPayload: Record<string, unknown>) => { ((rawPayload.governanceAuditLog as Array<Record<string, unknown>>)[0]!.details as Record<string, unknown>).summary = "forged audit"; }],
    ["series", (rawPayload: Record<string, unknown>) => { (rawPayload.seriesDefinitions as Array<Record<string, unknown>>)[0]!.concept = "forged series"; }],
  ] as const) {
    const forged = structuredClone(dual);
    mutate(forged.v23MigrationSourceEvidence[0]!.rawWorkspacePayload as Record<string, unknown>);
    syncDualEvidence(forged);
    assert.throws(() => migrateWorkspaceState(forged), /V23_LEGACY_ADAPTER_LINEAGE_INVALID/, `${label} must be compared as a complete reconstructed artifact`);
  }
  for (const [label, key] of [["missing", "purchasableModels"], ["duplicate", "configurationSnapshots"]] as const) {
    const forged = structuredClone(dual);
    const rawPayload = forged.v23MigrationSourceEvidence[0]!.rawWorkspacePayload as Record<string, unknown>;
    const entries = rawPayload[key] as Array<Record<string, unknown>>;
    if (label === "missing") entries.splice(0, 1); else entries.push(structuredClone(entries[0]!));
    syncDualEvidence(forged);
    assert.throws(() => migrateWorkspaceState(forged), /V23_LEGACY_ADAPTER_LINEAGE_INVALID/, `${label} reconstructed output must fail closed`);
  }
  const wrongRuleSet = structuredClone(dual);
  ((wrongRuleSet.v23MigrationSourceEvidence[0]!.rawWorkspacePayload as Record<string, unknown>).ruleSetVersions as Array<Record<string, unknown>>)[0]!.id = "ruleset:wrong";
  syncDualEvidence(wrongRuleSet);
  assert.throws(() => migrateWorkspaceState(wrongRuleSet), /V23_LEGACY_ADAPTER_LINEAGE_INVALID/);
  const frozenHash = structuredClone(dual);
  ((frozenHash.v23MigrationSourceEvidence[0]!.rawWorkspacePayload as Record<string, unknown>).configurationSnapshots as Array<Record<string, unknown>>)[0]!.contentHash = "f".repeat(64);
  syncDualEvidence(frozenHash);
  assert.throws(() => migrateWorkspaceState(frozenHash), /V23_LEGACY_ADAPTER_LINEAGE_INVALID/);
  const crossEvidence = structuredClone(dual);
  const crossRaw = crossEvidence.v23MigrationSourceEvidence[0]!.rawWorkspacePayload as Record<string, unknown>;
  const officialOnly = { ...crossRaw, skuDrawers: [], purchasableModels: [], configurationSnapshots: [], governanceAuditLog: [], seriesDefinitions: [], officialSkus: structuredClone(crossRaw.officialSkus) };
  crossRaw.officialSkus = [];
  const crossAdapter = crossEvidence.v23LegacyReadAdapters[0]!;
  const crossDrawer = (crossRaw.skuDrawers as Array<Record<string, unknown>>)[0]!;
  const crossLineage = crossAdapter.lineage as Exclude<V23LegacyReadAdapter["lineage"], { kind: "SINGLE_SOURCE" }>;
  crossAdapter.rawSourcePayload = crossDrawer;
  crossAdapter.lineage = { ...crossLineage, drawerRawSourcePayloadHash: hash(crossDrawer) };
  crossEvidence.v23MigrationSourceEvidence[0]!.rawWorkspacePayloadHash = deterministicHash(crossRaw);
  crossEvidence.v23MigrationSourceEvidence.push({ sourceEvidenceId: "source:dual-official", sourceSchemaVersion: 22, rawWorkspacePayload: officialOnly, rawWorkspacePayloadHash: deterministicHash(officialOnly) });
  assert.throws(() => migrateWorkspaceState(crossEvidence), /V23_LEGACY_ADAPTER_LINEAGE_INVALID/);
  const forgedDual = structuredClone(dual);
  forgedDual.v23LegacyReadAdapters[0]!.lineage = { ...forgedDual.v23LegacyReadAdapters[0]!.lineage as Exclude<V23LegacyReadAdapter["lineage"], { kind: "SINGLE_SOURCE" }>, drawerRawSourcePayloadHash: hash({ forged: true }) };
  assert.throws(() => migrateWorkspaceState(forgedDual), /V23_LEGACY_ADAPTER_LINEAGE_INVALID/);
});

test("v23 executes semantic contribution dedupe only where Phase A defines each entry set", () => {
  const secondPayload = affixPayload("affix:semantic-two");
  const second = { affixId: "affix:semantic-two", revision: 1, contentHash: hash({ affixId: "affix:semantic-two", revision: 1, payload: secondPayload }), payload: secondPayload };

  const part = directV23State();
  part.v23AffixDefinitions.push(second);
  part.v23SeriesPartRevisions[0]!.defaultEntryRefs = [{ id: "affix:project", revision: 1, contentHash: part.v23AffixDefinitions[0]!.contentHash }, { id: second.affixId, revision: 1, contentHash: second.contentHash }];
  part.v23SeriesPartRevisions[0] = withPartHashes(part.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  assert.throws(() => migrateWorkspaceState(part), /V23_PART_DEFAULT_ENTRY_SEMANTIC_CONTRIBUTION_CONFLICT/);

  const added = directV23State();
  added.v23AffixDefinitions.push(second);
  added.v23SkuDrawerRevisions[0]!.addedEntryRefs = [{ kind: "STABLE_AFFIX_REF", ref: { id: "affix:project", revision: 1, contentHash: added.v23AffixDefinitions[0]!.contentHash } }, { kind: "STABLE_AFFIX_REF", ref: { id: second.affixId, revision: 1, contentHash: second.contentHash } }];
  added.v23SkuDrawerRevisions[0] = withSkuHashes(added.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(added), /V23_SKU_EFFECTIVE_ENTRY_SEMANTIC_CONTRIBUTION_CONFLICT/);

  const local = directV23State();
  const ref = { id: local.v23AffixDefinitions[0]!.affixId, revision: 1, contentHash: local.v23AffixDefinitions[0]!.contentHash };
  local.v23SkuDrawerRevisions[0]!.addedEntryRefs = [];
  local.v23SkuDrawerRevisions[0]!.localEntryCopies = ["copy:one", "copy:two"].map((localCopyId) => ({ kind: "LOCAL_AFFIX_COPY" as const, localCopyId, sourceRef: ref, payload: affixPayload(), copyHash: hash({ localCopyId, sourceRef: ref, payload: affixPayload() }) }));
  local.v23SkuDrawerRevisions[0] = withSkuHashes(local.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(local), /V23_SKU_LOCAL_COPY_SOURCE_DUPLICATE/);

  const inheritedAndAdded = directV23State();
  inheritedAndAdded.v23AffixDefinitions.push(second);
  inheritedAndAdded.v23SeriesPartRevisions[0]!.defaultEntryRefs = [{ id: "affix:project", revision: 1, contentHash: inheritedAndAdded.v23AffixDefinitions[0]!.contentHash }];
  inheritedAndAdded.v23SeriesPartRevisions[0] = withPartHashes(inheritedAndAdded.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  inheritedAndAdded.v23SkuDrawerRevisions[0]!.addedEntryRefs = [{ kind: "STABLE_AFFIX_REF", ref: { id: second.affixId, revision: 1, contentHash: second.contentHash } }];
  inheritedAndAdded.v23SkuDrawerRevisions[0] = withSkuHashes(inheritedAndAdded.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(inheritedAndAdded), /V23_SKU_EFFECTIVE_ENTRY_SEMANTIC_CONTRIBUTION_CONFLICT/);

  const removedInherited = structuredClone(inheritedAndAdded);
  removedInherited.v23SkuDrawerRevisions[0]!.removedInheritedEntryIds = ["affix:project"];
  removedInherited.v23SkuDrawerRevisions[0] = withSkuHashes(removedInherited.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.doesNotThrow(() => migrateWorkspaceState(removedInherited));

  const stack = directV23State();
  const stackOne = { ...affixPayload(), stackingPolicy: "stack" as const };
  stack.v23AffixDefinitions[0] = { affixId: "affix:project", revision: 1, contentHash: hash({ affixId: "affix:project", revision: 1, payload: stackOne }), payload: stackOne };
  const stackTwoPayload = { ...affixPayload("affix:stack-two"), stackingPolicy: "stack" as const };
  const stackTwo = { affixId: "affix:stack-two", revision: 1, contentHash: hash({ affixId: "affix:stack-two", revision: 1, payload: stackTwoPayload }), payload: stackTwoPayload };
  stack.v23AffixDefinitions.push(stackTwo);
  stack.v23SeriesPartRevisions[0]!.defaultEntryRefs = [{ id: "affix:project", revision: 1, contentHash: stack.v23AffixDefinitions[0]!.contentHash }, { id: stackTwo.affixId, revision: 1, contentHash: stackTwo.contentHash }];
  stack.v23SeriesPartRevisions[0] = withPartHashes(stack.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  stack.v23SkuDrawerRevisions[0]!.addedEntryRefs = [];
  stack.v23SkuDrawerRevisions[0] = withSkuHashes(stack.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.doesNotThrow(() => migrateWorkspaceState(stack));

  const mixedPolicy = structuredClone(stack);
  (mixedPolicy.v23AffixDefinitions[1]!.payload as unknown as Record<string, unknown>).stackingPolicy = "dedupe";
  mixedPolicy.v23AffixDefinitions[1]!.contentHash = hash({ affixId: mixedPolicy.v23AffixDefinitions[1]!.affixId, revision: 1, payload: mixedPolicy.v23AffixDefinitions[1]!.payload });
  mixedPolicy.v23SeriesPartRevisions[0]!.defaultEntryRefs[1]!.contentHash = mixedPolicy.v23AffixDefinitions[1]!.contentHash;
  mixedPolicy.v23SeriesPartRevisions[0] = withPartHashes(mixedPolicy.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  assert.throws(() => migrateWorkspaceState(mixedPolicy), /V23_PART_DEFAULT_ENTRY_SEMANTIC_CONTRIBUTION_CONFLICT/);

  const blocker = directV23State();
  blocker.v23SkuDrawerRevisions[0]!.validationSummary = [{ code: "block", severity: "BLOCKER", gate: "PUBLISH", state: "WAIVED", message: "no waiver" }];
  blocker.v23SkuDrawerRevisions[0] = withSkuHashes(blocker.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(blocker), /V23_SKU_VALIDATION_BLOCKER_WAIVED/);
  const allowedSummary = directV23State();
  allowedSummary.v23SkuDrawerRevisions[0]!.validationSummary = [
    { code: "block-open", severity: "BLOCKER", gate: "PUBLISH", state: "OPEN", message: "blocks" },
    { code: "error-waived", severity: "ERROR", gate: "REVIEW", state: "WAIVED", message: "allowed" },
  ];
  allowedSummary.v23SkuDrawerRevisions[0] = withSkuHashes(allowedSummary.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.doesNotThrow(() => migrateWorkspaceState(allowedSummary));
});

test("v23 SKU quality carrier is closed, hash-bound, and unavailable before the Phase-B resolver", () => {
  const rehash = (state: ReturnType<typeof directV23State>) => {
    state.v23SkuDrawerRevisions[0] = withSkuHashes(state.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  };
  const unassessed = directV23State();
  assert.doesNotThrow(() => migrateWorkspaceState(unassessed));
  const wellFormed = directV23State();
  wellFormed.v23SkuDrawerRevisions[0]!.quality = assessedQuality(wellFormed);
  rehash(wellFormed);
  assert.throws(() => migrateWorkspaceState(wellFormed), /V23_SKU_QUALITY_RESOLVER_UNAVAILABLE/);
  for (const [label, mutate, expected] of [
    ["missing-field", (assessment: Record<string, unknown>) => { delete assessment.inputHash; }, /V23_SKU_QUALITY_ASSESSMENT_SCHEMA_INVALID/],
    ["unknown-quality", (assessment: Record<string, unknown>) => { assessment.selectedQualityId = "quality:unknown"; }, /V23_SKU_QUALITY_ID_INVALID/],
    ["non-finite", (assessment: Record<string, unknown>) => { assessment.finalValueScore = Number.NaN; }, /V23_SKU_QUALITY_SCORE_INVALID/],
    ["revision-identity", (assessment: Record<string, unknown>) => { assessment.skuRevisionId = "sku:other@1"; }, /V23_SKU_QUALITY_REVISION_ID_MISMATCH/],
    ["override-combination", (assessment: Record<string, unknown>) => { assessment.qualityOverrideState = "OVERRIDDEN"; assessment.qualityOverrideReason = null; }, /V23_SKU_QUALITY_OVERRIDE_INVALID/],
    ["input-hash-format", (assessment: Record<string, unknown>) => { assessment.inputHash = "forged"; }, /V23_SKU_QUALITY_INPUT_HASH_INVALID/],
  ] as const) {
    const invalid = directV23State();
    invalid.v23SkuDrawerRevisions[0]!.quality = assessedQuality(invalid) as never;
    mutate((invalid.v23SkuDrawerRevisions[0]!.quality as { assessment: Record<string, unknown> }).assessment);
    if (label !== "non-finite") rehash(invalid);
    assert.throws(() => migrateWorkspaceState(invalid), expected, label);
  }
  const duplicateBreakdown = directV23State();
  const duplicate = assessedQuality(duplicateBreakdown) as { assessment: { affixBreakdown: unknown[] } };
  duplicate.assessment.affixBreakdown.push(structuredClone(duplicate.assessment.affixBreakdown[0]!));
  duplicateBreakdown.v23SkuDrawerRevisions[0]!.quality = duplicate as never;
  rehash(duplicateBreakdown);
  assert.throws(() => migrateWorkspaceState(duplicateBreakdown), /V23_SKU_AFFIX_BREAKDOWN_INVALID/);
  const emptySource = directV23State();
  emptySource.v23SkuDrawerRevisions[0]!.quality = assessedQuality(emptySource, { affixBreakdown: [{ sourceAffixId: "affix:project", valueScore: 1, sourceRef: "" }] }) as never;
  rehash(emptySource);
  assert.throws(() => migrateWorkspaceState(emptySource), /V23_SKU_AFFIX_BREAKDOWN_SOURCE_REF_INVALID/);
  const unknownAffix = directV23State();
  unknownAffix.v23SkuDrawerRevisions[0]!.quality = assessedQuality(unknownAffix, { affixBreakdown: [{ sourceAffixId: "affix:unknown", valueScore: 1, sourceRef: "quality-sheet!B2" }] }) as never;
  rehash(unknownAffix);
  assert.throws(() => migrateWorkspaceState(unknownAffix), /V23_SKU_AFFIX_BREAKDOWN_INVALID/);
  const combinations = directV23State();
  const otherPayload = { ...affixPayload("affix:other"), semanticContributionKey: "other" };
  const other = { affixId: "affix:other", revision: 1, contentHash: hash({ affixId: "affix:other", revision: 1, payload: otherPayload }), payload: otherPayload };
  combinations.v23AffixDefinitions.push(other);
  combinations.v23SkuDrawerRevisions[0]!.addedEntryRefs = [
    { kind: "STABLE_AFFIX_REF", ref: { id: "affix:project", revision: 1, contentHash: combinations.v23AffixDefinitions[0]!.contentHash } },
    { kind: "STABLE_AFFIX_REF", ref: { id: other.affixId, revision: other.revision, contentHash: other.contentHash } },
  ];
  combinations.v23SkuDrawerRevisions[0]!.quality = assessedQuality(combinations, {
    affixBreakdown: [
      { sourceAffixId: "affix:project", valueScore: 1, sourceRef: "quality-sheet!B2" },
      { sourceAffixId: "affix:other", valueScore: 2, sourceRef: "quality-sheet!B3" },
    ],
    combinationBreakdown: [{ leftAffixId: "affix:project", rightAffixId: "affix:other", valueScore: 1, sourceRef: "quality-matrix!C4" }],
  }) as never;
  rehash(combinations);
  assert.throws(() => migrateWorkspaceState(combinations), /V23_SKU_QUALITY_RESOLVER_UNAVAILABLE/, "real string source refs are preserved until Phase B can resolve the assessment");
  const reversePair = structuredClone(combinations);
  (reversePair.v23SkuDrawerRevisions[0]!.quality as { assessment: { combinationBreakdown: unknown[] } }).assessment.combinationBreakdown.push({ leftAffixId: "affix:other", rightAffixId: "affix:project", valueScore: 1, sourceRef: "quality-matrix!C5" });
  rehash(reversePair);
  assert.throws(() => migrateWorkspaceState(reversePair), /V23_SKU_COMBINATION_BREAKDOWN_INVALID/);
  const unknownCombination = structuredClone(combinations);
  (unknownCombination.v23SkuDrawerRevisions[0]!.quality as { assessment: { combinationBreakdown: Array<{ leftAffixId: string }> } }).assessment.combinationBreakdown[0]!.leftAffixId = "affix:unknown";
  rehash(unknownCombination);
  assert.throws(() => migrateWorkspaceState(unknownCombination), /V23_SKU_COMBINATION_BREAKDOWN_INVALID/);
  const forgedInputHash = directV23State();
  forgedInputHash.v23SkuDrawerRevisions[0]!.quality = assessedQuality(forgedInputHash, { inputHash: "f".repeat(64) }) as never;
  rehash(forgedInputHash);
  assert.throws(() => migrateWorkspaceState(forgedInputHash), /V23_SKU_QUALITY_RESOLVER_UNAVAILABLE/, "Phase A retains a syntactically closed input hash but never accepts a self-reported assessment");
});

test("v23 effective stable IDs dedupe before semantic contribution while retaining SKU intent", () => {
  const same = directV23State();
  const ref = { id: same.v23AffixDefinitions[0]!.affixId, revision: 1, contentHash: same.v23AffixDefinitions[0]!.contentHash };
  same.v23SeriesPartRevisions[0]!.defaultEntryRefs = [ref];
  same.v23SeriesPartRevisions[0] = withPartHashes(same.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  same.v23SkuDrawerRevisions[0]!.addedEntryRefs = [{ kind: "STABLE_AFFIX_REF", ref: structuredClone(ref) }];
  same.v23SkuDrawerRevisions[0] = withSkuHashes(same.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.doesNotThrow(() => migrateWorkspaceState(same), "the local add intent survives although the stable contribution is effective once");

  const revisionConflict = structuredClone(same);
  const payload = affixPayload("affix:project", 2);
  const newer = { affixId: "affix:project", revision: 2, contentHash: hash({ affixId: "affix:project", revision: 2, payload }), payload };
  revisionConflict.v23AffixDefinitions.push(newer);
  revisionConflict.v23SkuDrawerRevisions[0]!.addedEntryRefs = [{ kind: "STABLE_AFFIX_REF", ref: { id: newer.affixId, revision: newer.revision, contentHash: newer.contentHash } }];
  revisionConflict.v23SkuDrawerRevisions[0] = withSkuHashes(revisionConflict.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(revisionConflict), /V23_SKU_EFFECTIVE_ENTRY_ID_CONFLICT/);
  const replace = structuredClone(revisionConflict);
  replace.v23SkuDrawerRevisions[0]!.removedInheritedEntryIds = ["affix:project"];
  replace.v23SkuDrawerRevisions[0] = withSkuHashes(replace.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.doesNotThrow(() => migrateWorkspaceState(replace));
  const localOverride = structuredClone(same);
  localOverride.v23SkuDrawerRevisions[0]!.addedEntryRefs = [];
  const localPayload = { ...affixPayload(), description: "SKU local" };
  localOverride.v23SkuDrawerRevisions[0]!.localEntryCopies = [{ kind: "LOCAL_AFFIX_COPY", localCopyId: "copy:override", sourceRef: ref, payload: localPayload, copyHash: hash({ localCopyId: "copy:override", sourceRef: ref, payload: localPayload }) }];
  localOverride.v23SkuDrawerRevisions[0] = withSkuHashes(localOverride.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.doesNotThrow(() => migrateWorkspaceState(localOverride), "a local copy replaces the matching effective source instead of adding a second contribution");
});

test("v23 numeric affix carriers freeze published magnitude ranges and RuleSet evidence (mapper replay N/A)", () => {
  const rehash = (state: ReturnType<typeof directV23State>) => {
    const definition = state.v23AffixDefinitions[0]!;
    definition.contentHash = hash({ affixId: definition.affixId, revision: definition.revision, payload: definition.payload });
    state.v23SkuDrawerRevisions[0]!.addedEntryRefs[0]!.ref.contentHash = definition.contentHash;
    state.v23SkuDrawerRevisions[0] = withSkuHashes(state.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  };
  const missing = directV23State();
  delete (missing.v23AffixDefinitions[0]!.payload.operations[0] as unknown as Record<string, unknown>).publishedMagnitudeRange;
  rehash(missing);
  assert.throws(() => migrateWorkspaceState(missing), /V23_AFFIX_OPERATION_SCHEMA_INVALID/);

  const unknown = directV23State();
  ((unknown.v23AffixDefinitions[0]!.payload.operations[0] as unknown as { publishedMagnitudeRange: { ruleSetVersion: string } }).publishedMagnitudeRange).ruleSetVersion = "ruleset:missing";
  rehash(unknown);
  assert.throws(() => migrateWorkspaceState(unknown), /V23_AFFIX_OPERATION_RANGE_INVALID/);

  const draft = directV23State();
  ((draft.v23AffixDefinitions[0]!.payload.operations[0] as unknown as { publishedMagnitudeRange: { ruleSetVersion: string } }).publishedMagnitudeRange).ruleSetVersion = "ruleset-v3-upgrade-candidate";
  rehash(draft);
  assert.throws(() => migrateWorkspaceState(draft), /V23_AFFIX_OPERATION_RANGE_INVALID/);

  const endpoints = directV23State();
  const range = (endpoints.v23AffixDefinitions[0]!.payload.operations[0] as unknown as { publishedMagnitudeRange: { min: number; max: number } }).publishedMagnitudeRange;
  range.min = 1; range.max = 1;
  rehash(endpoints);
  assert.doesNotThrow(() => migrateWorkspaceState(endpoints));

  for (const operation of ["percent_adjust", "flat_adjust", "clamp_add"] as const) {
    const valid = directV23State();
    valid.v23AffixDefinitions[0]!.payload.operations = [{
      operationId: `op:${operation}`, operationIndex: 0, sourceAffixId: "affix:project", sourceAffixRevision: 1,
      parameterKey: "power", operation, direction: "increase", magnitude: 1,
      ...(operation === "clamp_add" ? { clampMin: 0, clampMax: 2 } : {}),
      publishedMagnitudeRange: { min: 0, max: 1, ruleSetVersion: "ruleset-v3-migrated-1" },
    } as never];
    rehash(valid);
    assert.doesNotThrow(() => migrateWorkspaceState(valid), `${operation} must carry an accepted frozen published range`);
  }

  for (const [label, mutate] of [
    ["negative-min", (range: { min: number; max: number }) => { range.min = -1; }],
    ["inverted", (range: { min: number; max: number }) => { range.max = -1; }],
    ["outside", (range: { min: number; max: number }, operation: { magnitude: number }) => { operation.magnitude = 2; }],
  ] as const) {
    const invalid = directV23State();
    const operation = invalid.v23AffixDefinitions[0]!.payload.operations[0] as unknown as { magnitude: number; publishedMagnitudeRange: { min: number; max: number } };
    mutate(operation.publishedMagnitudeRange, operation);
    rehash(invalid);
    assert.throws(() => migrateWorkspaceState(invalid), /V23_AFFIX_OPERATION_RANGE_INVALID/, label);
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid = directV23State();
    (invalid.v23AffixDefinitions[0]!.payload.operations[0] as unknown as { publishedMagnitudeRange: { min: number } }).publishedMagnitudeRange.min = value;
    assert.throws(() => migrateWorkspaceState(invalid), /V23_AFFIX_OPERATION_RANGE_INVALID/, "non-finite numeric carrier is rejected before it can be accepted as published evidence");
  }
  for (const status of ["draft", "superseded"] as const) {
    const invalid = directV23State();
    invalid.ruleSetVersions[0]!.status = status;
    rehash(invalid);
    assert.throws(() => migrateWorkspaceState(invalid), /V23_AFFIX_OPERATION_RANGE_INVALID/, `${status} RuleSetVersion is not acceptable evidence`);
  }
  const duplicatePublished = directV23State();
  duplicatePublished.ruleSetVersions.push({ ...structuredClone(duplicatePublished.ruleSetVersions[0]!), status: "published" });
  rehash(duplicatePublished);
  assert.throws(() => migrateWorkspaceState(duplicatePublished), /V23_AFFIX_OPERATION_RANGE_INVALID/);

  const setRange = directV23State();
  setRange.v23AffixDefinitions[0]!.payload.operations = [{ operationId: "set", operationIndex: 0, sourceAffixId: "affix:project", sourceAffixRevision: 1, parameterKey: "power", operation: "set", value: 1, publishedMagnitudeRange: { min: 0, max: 1, ruleSetVersion: "ruleset-v3-migrated-1" } } as never];
  rehash(setRange);
  assert.throws(() => migrateWorkspaceState(setRange), /V23_AFFIX_OPERATION_SCHEMA_INVALID/);
  const enumRange = directV23State();
  enumRange.v23AffixDefinitions[0]!.payload.operations = [{ operationId: "enum", operationIndex: 0, sourceAffixId: "affix:project", sourceAffixRevision: 1, parameterKey: "power", operation: "enum_add", value: "x", publishedMagnitudeRange: { min: 0, max: 1, ruleSetVersion: "ruleset-v3-migrated-1" } } as never];
  rehash(enumRange);
  assert.throws(() => migrateWorkspaceState(enumRange), /V23_AFFIX_OPERATION_SCHEMA_INVALID/);

  const definitionHash = directV23State();
  definitionHash.v23AffixDefinitions[0]!.payload.operations[0] = { ...definitionHash.v23AffixDefinitions[0]!.payload.operations[0]!, publishedMagnitudeRange: { min: 0, max: 1, ruleSetVersion: "ruleset-v3-migrated-1" }, magnitude: 0 } as never;
  assert.throws(() => migrateWorkspaceState(definitionHash), /V23_AFFIX_CONTENT_HASH_MISMATCH/);
  const versionReplacement = directV23State();
  versionReplacement.ruleSetVersions.push({ ...structuredClone(versionReplacement.ruleSetVersions[0]!), id: "ruleset:published-replacement", version: 99, status: "published" });
  ((versionReplacement.v23AffixDefinitions[0]!.payload.operations[0] as unknown as { publishedMagnitudeRange: { ruleSetVersion: string } }).publishedMagnitudeRange).ruleSetVersion = "ruleset:published-replacement";
  assert.throws(() => migrateWorkspaceState(versionReplacement), /V23_AFFIX_CONTENT_HASH_MISMATCH/, "changing the published evidence without its frozen definition hash is rejected");

  const localCopy = directV23State();
  const definition = localCopy.v23AffixDefinitions[0]!;
  const sourceRef = { id: definition.affixId, revision: definition.revision, contentHash: definition.contentHash };
  const copyPayload = structuredClone(definition.payload);
  const copy = { kind: "LOCAL_AFFIX_COPY" as const, localCopyId: "copy:range", sourceRef, payload: copyPayload, copyHash: hash({ localCopyId: "copy:range", sourceRef, payload: copyPayload }) };
  localCopy.v23SkuDrawerRevisions[0]!.addedEntryRefs = [];
  localCopy.v23SkuDrawerRevisions[0]!.localEntryCopies = [copy];
  localCopy.v23SkuDrawerRevisions[0] = withSkuHashes(localCopy.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.doesNotThrow(() => migrateWorkspaceState(localCopy));
  const localRange = structuredClone(localCopy);
  const rangeOperation = localRange.v23SkuDrawerRevisions[0]!.localEntryCopies[0]!.payload.operations[0] as unknown as { publishedMagnitudeRange: { ruleSetVersion: string } };
  rangeOperation.publishedMagnitudeRange.ruleSetVersion = "ruleset:missing";
  const changedCopy = localRange.v23SkuDrawerRevisions[0]!.localEntryCopies[0]!;
  changedCopy.copyHash = hash({ localCopyId: changedCopy.localCopyId, sourceRef: changedCopy.sourceRef, payload: changedCopy.payload });
  localRange.v23SkuDrawerRevisions[0] = withSkuHashes(localRange.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(localRange), /V23_AFFIX_OPERATION_RANGE_INVALID/);
  const copyHash = structuredClone(localCopy);
  copyHash.v23SkuDrawerRevisions[0]!.localEntryCopies[0]!.copyHash = "0".repeat(64);
  copyHash.v23SkuDrawerRevisions[0] = withSkuHashes(copyHash.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(copyHash), /V23_SKU_LOCAL_COPY_COPY_HASH_MISMATCH/);
});
