import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_WORKSPACE_SCHEMA_VERSION, migrateWorkspaceState } from "../lib/migrations";
import { verifySnapshotIntegrity } from "../lib/publishing";
import { deterministicHash } from "../lib/rule-kernel";
import { jcsSha256Hex } from "../lib/canonical-json";
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
  delete state.v23SeriesPartHeads;
  delete state.v23SkuDrawerRevisions;
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
const affixPayload = (id = "affix:project", revision = 1) => ({ name: "Project", category: "attribute" as const, itemPartId: "part:rod", generationPolicy: "normal" as const, rarity: "common" as const, valueScore: 1, tags: [], description: "project", enabled: true, operations: [{ operationId: "op:one", operationIndex: 0, sourceAffixId: id, sourceAffixRevision: revision, parameterKey: "power", operation: "flat_adjust" as const, direction: "increase" as const, magnitude: 1 }], passivePayload: null });

function directV23State(partCount = 1) {
  const state = migrateWorkspaceState(legacyInput(22));
  const seriesId = state.seriesDefinitions[0]!.id;
  const affixValue = affixPayload();
  const affix = { affixId: "affix:project", revision: 1, contentHash: hash({ affixId: "affix:project", revision: 1, payload: affixValue }), payload: affixValue };
  const ref = { id: affix.affixId, revision: affix.revision, contentHash: affix.contentHash };
  const parts = Array.from({ length: partCount }, (_, index) => withPartHashes({
    partId: `part:${index}`, seriesId, revision: 1,
    partType: (["rod", "reel", "line", "rod"] as const)[index]!,
    fishingMethodId: "method:lure", materialTypeId: "material:carbon", functionProfileId: "function:cast", functionIntensity: 2 as const, weightBandIds: [],
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
    quality: { status: "MATCHED" as const, qualityId: "quality_a_purple" as const }, skuPatchIds: [], modelIds: [], defaultModelId: null, displayOrder: 0, validationSummary: [], status: "draft", contentHash: "",
  })];
  return state;
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
  for (const [key, value] of Object.entries({ v23SeriesPartRevisions: [], v23SkuDrawerRevisions: null, v23AffixDefinitions: {}, v23MigrationSourceEvidence: [], v23LegacyReadAdapters: [] })) {
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
  const copy = { kind: "LOCAL_AFFIX_COPY" as const, localCopyId: "copy:shared", sourceRef: { id: copies.v23AffixDefinitions[0]!.affixId, revision: 1, contentHash: copies.v23AffixDefinitions[0]!.contentHash }, payload: affixPayload(), copyHash: "" };
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
  quality.v23SkuDrawerRevisions[0]!.quality = { status: "MATCHED", qualityId: "bogus" } as never;
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
    rawSeriesPayload: null, diagnosticCodes: ["V23_PART_UNRESOLVED"], status: "NEEDS_REVIEW",
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
  const secondPayload = affixPayload("affix:project@revision:1", 1);
  const secondAffix = { affixId: "affix:project@revision:1", revision: 1, contentHash: hash({ affixId: "affix:project@revision:1", revision: 1, payload: secondPayload }), payload: secondPayload };
  state.v23AffixDefinitions.push(secondAffix);
  state.v23SeriesPartRevisions[0]!.defaultEntryRefs = [
    { id: "affix:project", revision: 1, contentHash: state.v23AffixDefinitions[0]!.contentHash },
    { id: secondAffix.affixId, revision: secondAffix.revision, contentHash: secondAffix.contentHash },
  ];
  state.v23SkuDrawerRevisions[0]!.addedEntryRefs = [{
    kind: "STABLE_AFFIX_REF",
    ref: { id: secondAffix.affixId, revision: secondAffix.revision, contentHash: secondAffix.contentHash },
  }];
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
  fingerprintIsolation.v23SkuDrawerRevisions[0]!.quality = { status: "NO_RECOMMENDATION", qualityId: "quality_a_purple", reason: "manual evidence" };
  fingerprintIsolation.v23SkuDrawerRevisions[0] = withSkuHashes(fingerprintIsolation.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.equal((fingerprintIsolation.v23SkuDrawerRevisions[0]!.match as { inputFingerprint: string }).inputFingerprint, beforeFingerprint);
  assert.notEqual(fingerprintIsolation.v23SkuDrawerRevisions[0]!.contentHash, beforeContent);
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
  quality.v23SkuDrawerRevisions[0]!.quality = { status: "MATCHED", qualityId: "quality_unknown" } as never;
  quality.v23SkuDrawerRevisions[0] = withSkuHashes(quality.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(quality), /V23_SKU_QUALITY_ID_INVALID/);

  const incompleteNoRecommendation = directV23State();
  incompleteNoRecommendation.v23SkuDrawerRevisions[0]!.quality = { status: "NO_RECOMMENDATION", qualityId: "quality_unknown", reason: "" } as never;
  incompleteNoRecommendation.v23SkuDrawerRevisions[0] = withSkuHashes(incompleteNoRecommendation.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(incompleteNoRecommendation), /V23_SKU_QUALITY_(ID_INVALID|INVALID)/);
  const missingNoRecommendationReason = directV23State();
  missingNoRecommendationReason.v23SkuDrawerRevisions[0]!.quality = { status: "NO_RECOMMENDATION", qualityId: "quality_a_purple" } as never;
  missingNoRecommendationReason.v23SkuDrawerRevisions[0] = withSkuHashes(missingNoRecommendationReason.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(missingNoRecommendationReason), /V23_SKU_QUALITY_SCHEMA_INVALID/);

  const technology = directV23State();
  const source = technology.technologies[0]!;
  technology.v23SeriesPartRevisions[0]!.technologyRefs = [{ id: source.id, revision: source.version, contentHash: "0".repeat(64) }];
  technology.v23SeriesPartRevisions[0] = withPartHashes(technology.v23SeriesPartRevisions[0]!) as SeriesPartRevision;
  assert.throws(() => migrateWorkspaceState(technology), /V23_PART_TECHNOLOGY_UNRESOLVED/);

  const evidence = directV23State();
  const raw = { schemaVersion: 22, original: true, skuDrawers: [{ id: "legacy:sku" }], seriesDefinitions: [] };
  evidence.v23MigrationSourceEvidence = [{ sourceEvidenceId: "source:one", sourceSchemaVersion: 22, rawWorkspacePayload: raw, rawWorkspacePayloadHash: deterministicHash(raw) }];
  evidence.v23LegacyReadAdapters = [{ adapterId: "adapter:one", kind: "LEGACY_NEEDS_REVIEW", sourceEvidenceId: "source:one", targetSkuId: "legacy:sku", sourceKind: "LEGACY_SKU_DRAWER", sourceRecordId: "legacy:sku", rawSourcePayload: { id: "legacy:sku" }, sourceSeriesId: null, rawSeriesPayload: null, diagnosticCodes: ["V23_SERIES_UNRESOLVED", "V23_PART_UNRESOLVED"], status: "NEEDS_REVIEW" }];
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
    name: "Passive", category: "passive" as const, itemPartId: "part:rod", generationPolicy: "normal" as const, rarity: "common" as const,
    valueScore: 1, tags: [], description: "passive", enabled: true, operations: [] as [],
    passivePayload: { skillId: "skill:one", name: "Skill", itemPartId: "part:rod", triggerType: "manual", triggerDescription: "trigger", effectTarget: "target", effectLogicDescription: "effect", exampleParameters: { enabled: true, power: 1, label: "x" }, durationDescription: "duration", cooldownDescription: "cooldown", resetDescription: "reset", stackingDescription: "stacking", playerDescription: "player", simulatorReferenceKey: null },
  });
  const payloadExtra = directV23State();
  (payloadExtra.v23AffixDefinitions[0]!.payload as unknown as Record<string, unknown>).extra = true;
  payloadExtra.v23AffixDefinitions[0]!.contentHash = hash({ affixId: "affix:project", revision: 1, payload: payloadExtra.v23AffixDefinitions[0]!.payload });
  assert.throws(() => migrateWorkspaceState(payloadExtra), /V23_AFFIX_PAYLOAD_SCHEMA_INVALID/);
  const valid = directV23State();
  valid.v23SkuDrawerRevisions[0]!.match = validMatch(); valid.v23SkuDrawerRevisions[0] = withSkuHashes(valid.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(valid), /V23_TEMPLATE_REGISTRY_UNAVAILABLE/);
  const defaultModel = directV23State(); defaultModel.v23SkuDrawerRevisions[0]!.defaultModelId = "model:missing"; defaultModel.v23SkuDrawerRevisions[0] = withSkuHashes(defaultModel.v23SkuDrawerRevisions[0]!) as SkuDrawerRevision;
  assert.throws(() => migrateWorkspaceState(defaultModel), /V23_SKU_DEFAULT_MODEL_UNRESOLVED/);
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
