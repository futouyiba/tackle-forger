import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CLASSIFICATIONS,
  EXPECTED_ROOT_CLASSIFICATIONS,
  checkProjectWorkbookContract,
  computeWorkbookHashes,
  parseWorkspaceStateRoots,
  preservedTypeGraphHash,
  validateMachineCell,
  validateDiagnosticRootCatalog,
  validateDiagnosticEnvelope,
  validateImportableExactFields,
  validatePreservedRootCatalog,
  validateProjectWorkbookManifest,
  validateRecordEnvelope,
  validateRootSummary,
  validateServerRefEnvelope,
  validateWorkbookEnvelope,
} from "../scripts/check-project-workbook-contract.mjs";

const manifestPath = new URL("../docs/spec-v3/project-workbook-v1-root-manifest.json", import.meta.url);
const workspaceStatePath = new URL("../lib/types.ts", import.meta.url);

async function fixture() {
  const [manifestSource, workspaceSource] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(workspaceStatePath, "utf8"),
  ]);
  return {
    manifestSource,
    manifest: JSON.parse(manifestSource),
    roots: parseWorkspaceStateRoots(workspaceSource),
  };
}

function clone(value) {
  return structuredClone(value);
}

function canonicalPayload(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(",")}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalPayload(value[key])}`)
    .join(",")}}`;
}

function expectedRecordHash(manifest, row, payloadField) {
  const values = {
    root: row.root,
    record_schema_id: row.record_schema_id,
    record_key: JSON.parse(row.record_key),
    record_revision: JSON.parse(row.record_revision),
    canonical_payload: JSON.parse(row[payloadField]),
  };
  const input = manifest.canonicalization.recordHashInput.map(
    (field) => [field, values[field]],
  );
  return createHash("sha256").update(canonicalPayload(input)).digest("hex");
}

function atPath(value, fieldPath) {
  return fieldPath.split(".").reduce((current, part) => current[part], value);
}

function diagnosticKey(manifest, root, payload) {
  const projection = manifest.diagnosticRootCatalog[root].subjectProjectionFields
    .map((field) => [field, atPath(payload, field)]);
  const hash = createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex");
  return JSON.stringify([hash]);
}

function workbookSchemaHash(manifest) {
  return createHash("sha256").update(canonicalPayload(
    manifest.canonicalization.workbookSchemaHashInput.map((field) => [field, manifest[field]]),
  )).digest("hex");
}

function workbookContext(manifest, manifestSource) {
  const manifestFields = {
    contract_version: "project-workbook/v1",
    workspace_id: "workspace:1",
    base_workspace_revision: "1",
    root_manifest_sha256: createHash("sha256").update(manifestSource).digest("hex"),
    workbook_schema_sha256: workbookSchemaHash(manifest),
    exporter_version: "v1",
  };
  return {
    rootManifestSource: manifestSource,
    manifestFields,
    machineSheets: {
      __TF_CURRENT: [],
      __TF_PRESERVED: [],
      __TF_SERVER_REFS: manifest.classifications.server_owned.map((root) => ({
        root,
        classification: "server_owned",
        root_content_sha256: "null",
        opaque_server_ref: `opaque_${createHash("sha256").update(root).digest("hex")}`,
      })),
      __TF_FORBIDDEN: manifest.classifications.forbidden.map((root) => ({
        root,
        classification: "forbidden",
        policy_marker: "FORBIDDEN_PAYLOAD_OMITTED",
      })),
    },
  };
}

function workbookEnvelope(manifest, context) {
  const hashes = computeWorkbookHashes(manifest, context);
  return {
    ...context.manifestFields,
    machine_content_sha256: hashes.machineContentSha256,
  };
}

function diagnosticEvidence(manifest, row) {
  const values = {
    root: row.root,
    record_key: JSON.parse(row.record_key),
    diagnostic_schema_version: row.diagnostic_schema_version,
    subject_payload: JSON.parse(row.subject_payload_json),
    severity: row.severity,
    code: row.code,
    message: row.message,
    subject_ref: row.subject_ref === "null" ? null : row.subject_ref,
  };
  return createHash("sha256").update(canonicalPayload(
    manifest.canonicalization.diagnosticEvidenceHashInput.map((field) => [field, values[field]]),
  )).digest("hex");
}

function rootSummaryFixture(manifest) {
  const hashedRoots = [
    ...manifest.classifications.importable_current,
    ...manifest.classifications.preserved_frozen,
    ...manifest.classifications.export_only_diagnostic,
  ];
  const rootRecordContext = Object.fromEntries(hashedRoots.map((root) => [root, []]));
  const rows = Object.entries(manifest.classifications).flatMap(([classification, roots]) =>
    roots.map((root) => ({
      root,
      classification,
      record_count: "0",
      root_content_sha256:
        classification === "server_owned" || classification === "forbidden"
          ? "null"
          : createHash("sha256").update("[]").digest("hex"),
      status: "READY",
    })));
  return { rows, rootRecordContext };
}

test("canonical project workbook contract binds all current WorkspaceState roots", () => {
  const result = checkProjectWorkbookContract();
  assert.equal(result.rootCount, 93);
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
});

test("F0 keeps command-only and fixed-authority roots server-owned", async () => {
  const { manifest, roots } = await fixture();
  assert.deepEqual(
    [
      manifest.classifications.importable_current.length,
      manifest.classifications.preserved_frozen.length,
      manifest.classifications.server_owned.length,
      manifest.classifications.forbidden.length,
      manifest.classifications.export_only_diagnostic.length,
    ],
    [24, 23, 21, 15, 10],
  );
  for (const root of [
    "partConstraintSets",
    "v23SeriesPartHeads",
    "v23SkuDrawerHeads",
    "qualityValuePolicyDrafts",
    "pricingPolicyDrafts",
    "qualityProfiles",
    "seriesDefinitions",
    "v23AffixDefinitions",
    "v23TechnologyHeads",
  ]) {
    assert.ok(manifest.classifications.server_owned.includes(root), root);
    assert.equal(Object.hasOwn(manifest.recordSchemas, root), false, root);
    assert.equal(Object.hasOwn(manifest.preservedRootCatalog, root), false, root);
    assert.equal(Object.hasOwn(manifest.preservedSchemaCatalog, root), false, root);
  }

  for (const [root, unsafeTarget] of [
    ["partConstraintSets", "preserved_frozen"],
    ["v23SeriesPartHeads", "importable_current"],
    ["v23SkuDrawerHeads", "importable_current"],
    ["qualityValuePolicyDrafts", "importable_current"],
    ["pricingPolicyDrafts", "importable_current"],
    ["qualityProfiles", "importable_current"],
    ["seriesDefinitions", "importable_current"],
    ["v23AffixDefinitions", "importable_current"],
    ["v23TechnologyHeads", "importable_current"],
  ]) {
    const forged = clone(manifest);
    forged.classifications.server_owned =
      forged.classifications.server_owned.filter((candidate) => candidate !== root);
    forged.classifications[unsafeTarget].push(root);
    assert.throws(
      () => validateProjectWorkbookManifest(forged, roots),
      /exact expected classifications/,
      `${root} must reject a forged ${unsafeTarget} carrier`,
    );
  }

  assert.deepEqual(manifest.serverOwnedInvariants.qualityProfiles, [
    { id: "quality_c_green", letter: "C", colorName: "绿", rank: 1, enabled: true },
    { id: "quality_b_blue", letter: "B", colorName: "蓝", rank: 2, enabled: true },
    { id: "quality_a_purple", letter: "A", colorName: "紫", rank: 3, enabled: true },
    { id: "quality_s_orange", letter: "S", colorName: "橙", rank: 4, enabled: true },
  ]);
  for (const mutate of [
    (profiles) => {
      [profiles[0].colorName, profiles[1].colorName] =
        [profiles[1].colorName, profiles[0].colorName];
    },
    (profiles) => { profiles[2].enabled = false; },
    (profiles) => { profiles.pop(); },
    (profiles) => { profiles.push(clone(profiles[0])); },
  ]) {
    const forged = clone(manifest);
    mutate(forged.serverOwnedInvariants.qualityProfiles);
    assert.throws(
      () => validateProjectWorkbookManifest(forged, roots),
      /fixed invariants|unique/,
    );
  }
});

test("root classification rejects new, missing and duplicate roots", async () => {
  const { manifest, roots } = await fixture();
  assert.equal(validateProjectWorkbookManifest(manifest, roots), true);
  assert.throws(
    () => validateProjectWorkbookManifest(manifest, [...roots, "futureRoot"]),
    /94 !== 93|classified exactly once/,
  );

  const missing = clone(manifest);
  missing.classifications.importable_current =
    missing.classifications.importable_current.filter((root) => root !== "parameters");
  assert.throws(
    () => validateProjectWorkbookManifest(missing, roots),
    /exact expected classifications|classified exactly once/,
  );

  const duplicate = clone(manifest);
  duplicate.classifications.server_owned.push("parameters");
  assert.throws(
    () => validateProjectWorkbookManifest(duplicate, roots),
    /exact expected classifications|classified more than once/,
  );
});

test("every one of the 93 roots rejects movement to any other classification", async () => {
  const { manifest, roots } = await fixture();
  for (const [source, sourceRoots] of Object.entries(EXPECTED_ROOT_CLASSIFICATIONS)) {
    for (const root of sourceRoots) {
      for (const target of CLASSIFICATIONS.filter((classification) => classification !== source)) {
        const moved = clone(manifest);
        moved.classifications[source] =
          moved.classifications[source].filter((candidate) => candidate !== root);
        moved.classifications[target].push(root);
        assert.throws(
          () => validateProjectWorkbookManifest(moved, roots),
          /exact expected classifications/,
          `${root} moved from ${source} to ${target}`,
        );
      }
    }
  }
});

test("MERGE missing is no-op while REPLACE missing is removal intent", async () => {
  const { manifest, roots } = await fixture();
  assert.equal(manifest.modes.MERGE_BY_STABLE_ID.missingRecord, "NO_OP");
  assert.equal(manifest.modes.REPLACE_PROJECT.missingRecord, "REMOVAL_INTENT");
  assert.equal(manifest.removal.allowed, "DEDICATED_SAFE_REMOVAL_COMMAND_ONLY");
  assert.equal(manifest.removal.unsupportedCode, "REMOVAL_NOT_SUPPORTED");

  const weakened = clone(manifest);
  weakened.modes.REPLACE_PROJECT.missingRecord = "NO_OP";
  assert.throws(() => validateProjectWorkbookManifest(weakened, roots));
});

test("mutable conflicts replan but identity, frozen, reference, schema and workspace conflicts hard-block", async () => {
  const { manifest, roots } = await fixture();
  assert.deepEqual(manifest.conflicts.replanAndRehash, [
    "MUTABLE_VALUE_CONFLICT",
    "MUTABLE_REVISION_CONFLICT",
  ]);
  assert.deepEqual(manifest.conflicts.hardBlock, [
    "IDENTITY_CONFLICT",
    "FROZEN_CONTENT_CONFLICT",
    "REFERENCE_INTEGRITY_CONFLICT",
    "SCHEMA_CONFLICT",
    "WORKSPACE_CONFLICT",
  ]);
  assert.equal(manifest.plan.mutableConflictResolution, "REPLAN_REHASH_AND_REAUTHORIZE");

  const weakened = clone(manifest);
  weakened.conflicts.hardBlock.pop();
  assert.throws(() => validateProjectWorkbookManifest(weakened, roots));
});

test("frozen, server-owned, forbidden and diagnostic roots cannot become mutable imports", async () => {
  const { manifest, roots } = await fixture();
  assert.ok(manifest.classifications.preserved_frozen.includes("configurationSnapshots"));
  assert.ok(manifest.classifications.server_owned.includes("workspaceId"));
  assert.ok(manifest.classifications.forbidden.includes("feishuWorkbooks"));
  assert.ok(manifest.classifications.export_only_diagnostic.includes("derivedProjections"));

  for (const [root, source] of [
    ["configurationSnapshots", "preserved_frozen"],
    ["workspaceId", "server_owned"],
    ["feishuWorkbooks", "forbidden"],
    ["derivedProjections", "export_only_diagnostic"],
  ]) {
    const weakened = clone(manifest);
    weakened.classifications[source] =
      weakened.classifications[source].filter((candidate) => candidate !== root);
    weakened.classifications.importable_current.push(root);
    assert.throws(() => validateProjectWorkbookManifest(weakened, roots));
  }
});

test("sensitive and external-handle roots cannot enter preserved or importable payloads", async () => {
  const { manifest, roots } = await fixture();
  for (const root of [
    "feishuWorkbooks",
    "feishuSourceRevisions",
    "aiRuleSourceChangeDrafts",
    "dataSources",
    "v23MigrationSourceEvidence",
    "v23LegacyReadAdapters",
    "migrationReviewItems",
  ]) {
    assert.ok(manifest.classifications.forbidden.includes(root));
    for (const target of ["preserved_frozen", "importable_current"]) {
      const weakened = clone(manifest);
      weakened.classifications.forbidden =
        weakened.classifications.forbidden.filter((candidate) => candidate !== root);
      weakened.classifications[target].push(root);
      assert.throws(() => validateProjectWorkbookManifest(weakened, roots));
    }
  }
});

test("legacy, mixed-lifecycle and raw-evidence roots use safe projections", async () => {
  const { manifest } = await fixture();
  assert.ok(manifest.classifications.preserved_frozen.includes("projectionPatches"));
  assert.ok(manifest.classifications.preserved_frozen.includes("performanceSummaryDefinitions"));
  assert.ok(manifest.classifications.preserved_frozen.includes("fiveAxisViewDefinitions"));
  assert.ok(manifest.classifications.preserved_frozen.includes("fiveAxisVertexSets"));
  for (const root of [
    "performanceProfiles", "recipes", "candidates", "officialSkus", "detailOverrides",
  ]) {
    assert.ok(manifest.classifications.preserved_frozen.includes(root));
    assert.equal(Object.hasOwn(manifest.recordSchemas, root), false);
  }
  assert.ok(manifest.classifications.server_owned.includes("patchLedger"));
  assert.ok(manifest.classifications.server_owned.includes("canonicalRuleSourceDrafts"));
  assert.ok(manifest.classifications.server_owned.includes("weightTemplatePolicyDrafts"));
  assert.ok(manifest.classifications.server_owned.includes("pricingPolicyVersions"));
  assert.ok(manifest.classifications.server_owned.includes("partConstraintSets"));
  assert.ok(manifest.classifications.server_owned.includes("qualityValuePolicyDrafts"));
  assert.ok(manifest.classifications.server_owned.includes("pricingPolicyDrafts"));
  assert.equal(Object.hasOwn(manifest.recordSchemas, "patchLedger"), false);
  assert.equal(Object.hasOwn(manifest.recordSchemas, "canonicalRuleSourceDrafts"), false);
  assert.equal(Object.hasOwn(manifest.recordSchemas, "partConstraintSets"), false);
  assert.equal(Object.hasOwn(manifest.recordSchemas, "pricingPolicyDrafts"), false);
  assert.equal(Object.hasOwn(manifest.recordSchemas, "qualityValuePolicyDrafts"), false);
});

test("versioned definitions use composite identities and every frozen root has a carrier key", async () => {
  const { manifest, roots } = await fixture();
  assert.deepEqual(
    manifest.recordSchemas.v23TechnologyDefinitions.identityFields,
    ["technologyId", "revision"],
  );
  assert.deepEqual(manifest.preservedRootCatalog.performanceSummaryDefinitions, {
    carrier: "records",
    typeRef: "lib/performance-summary.ts#PerformanceSummaryDefinition",
    recordKeyFields: ["definitionId", "definitionVersion"],
    revisionFields: ["definitionVersion"],
    hashFields: ["definitionHash"],
    singleton: false,
    variants: [],
  });
  assert.deepEqual(
    manifest.preservedRootCatalog.fiveAxisVertexSets.variants.map((variant) => variant.type),
    ["LegacyFiveAxisVertexSet", "FiveAxisVertexSet"],
  );
  assert.equal(validatePreservedRootCatalog(manifest), true);
  for (const root of manifest.classifications.preserved_frozen) {
    const catalog = manifest.preservedRootCatalog[root];
    assert.ok(
      catalog.recordKeyFields.length > 0
        || catalog.variants.every((variant) => variant.recordKeyFields.length > 0),
    );
  }
  const weakened = clone(manifest);
  delete weakened.preservedRootCatalog.performanceProfiles;
  assert.throws(() => validateProjectWorkbookManifest(weakened, roots), /frozen root/);
  const singleton = clone(manifest);
  singleton.preservedRootCatalog.currentFiveAxisDispositionCatalogRevisionId.singleton = false;
  assert.throws(() => validateProjectWorkbookManifest(singleton, roots));

  const typo = clone(manifest);
  typo.preservedRootCatalog.performanceSummaryDefinitions.hashFields = ["contentHash"];
  assert.throws(() => validatePreservedRootCatalog(typo), /contentHash is absent/);

  const missingLegacy = clone(manifest);
  missingLegacy.preservedRootCatalog.fiveAxisVertexSets.variants.shift();
  assert.throws(() => validatePreservedRootCatalog(missingLegacy), /every union variant/);

  const legacyTypo = clone(manifest);
  legacyTypo.preservedRootCatalog.fiveAxisVertexSets.variants[0].recordKeyFields =
    ["vertexSetId"];
  assert.throws(() => validatePreservedRootCatalog(legacyTypo), /vertexSetId is absent/);

  const structurallyPlausibleWrongRoot = clone(manifest);
  structurallyPlausibleWrongRoot.preservedRootCatalog.recipes.typeRef =
    "lib/types.ts#Candidate";
  assert.throws(
    () => validatePreservedRootCatalog(structurallyPlausibleWrongRoot),
    /exact WorkspaceState property element\/scalar type/,
  );

  const wrongUnion = clone(manifest);
  wrongUnion.preservedRootCatalog.fiveAxisVertexSets.typeRef =
    "lib/types.ts#StoredFiveAxisViewDefinition";
  assert.throws(
    () => validatePreservedRootCatalog(wrongUnion),
    /exact WorkspaceState property element\/scalar type/,
  );

  const wrongImportedBinding = clone(manifest);
  wrongImportedBinding.preservedRootCatalog.performanceSummaryDefinitions.typeRef =
    "lib/performance-summary.ts#PerformanceSummarySnapshot";
  assert.throws(
    () => validatePreservedRootCatalog(wrongImportedBinding),
    /exact WorkspaceState property element\/scalar type/,
  );
});

test("existing v23 technology keeps itemPart exact while create may declare it", async () => {
  const { manifest } = await fixture();
  assert.deepEqual(
    manifest.recordSchemas.v23TechnologyDefinitions.exactFields,
    ["revision", "itemPartId", "contentHash"],
  );
  const technology = {
    technologyId: "technology:1",
    revision: 1,
    itemPartId: "part:rod",
    name: "力量技术",
    description: "",
    memberAffixRefs: [],
    enabled: true,
    contentHash: "a".repeat(64),
  };
  assert.equal(
    validateImportableExactFields(
      manifest,
      "v23TechnologyDefinitions",
      technology,
      undefined,
    ),
    true,
    "a new Technology may declare its initial itemPartId",
  );
  assert.equal(
    validateImportableExactFields(
      manifest,
      "v23TechnologyDefinitions",
      { ...technology, name: "力量技术（修订）" },
      technology,
    ),
    true,
    "mutable fields remain editable for an existing Technology",
  );
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "v23TechnologyDefinitions",
      { ...technology, itemPartId: "part:reel" },
      technology,
    ),
    /itemPartId is exact-equal/,
  );
});

test("reserved purchasable model identity is exact while unreserved and new models remain editable", async () => {
  const { manifest } = await fixture();
  assert.deepEqual(manifest.conditionalExactFieldPolicies.purchasableModels, {
    whenExistingFieldPresent: "configIdBundleRef",
    exactFields: ["skuId", "stableModelKey", "configIdBundleRef"],
  });
  const model = {
    id: "model:1",
    revision: 1,
    skuId: "sku:1",
    name: "Model 1",
    stableModelKey: "model_1",
    action: "M",
    hardness: "H",
    lengthM: 2.4,
    componentSelections: [],
    technologyIds: [],
    attributeAffixIds: [],
    passiveAffixIds: [],
    patchIds: [],
    price: 100,
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(validateImportableExactFields(
    manifest,
    "purchasableModels",
    { ...model, configIdBundleRef: "bundle:1" },
    undefined,
  ), true, "a new model may declare its reserved identity");
  assert.equal(validateImportableExactFields(
    manifest,
    "purchasableModels",
    { ...model, skuId: "sku:2", stableModelKey: "model_2" },
    model,
  ), true, "an existing unreserved model may still revise pre-reservation identity");
  const reserved = { ...model, configIdBundleRef: "bundle:1" };
  assert.equal(validateImportableExactFields(
    manifest,
    "purchasableModels",
    { ...reserved, name: "Model 1 revised" },
    reserved,
  ), true, "a reserved identity can be reused exactly");
  for (const mutation of [
    { skuId: "sku:2" },
    { stableModelKey: "model_2" },
    { configIdBundleRef: "bundle:2" },
  ]) {
    assert.throws(
      () => validateImportableExactFields(
        manifest,
        "purchasableModels",
        { ...reserved, ...mutation },
        reserved,
      ),
      /is exact-equal for an existing record/,
    );
  }
});

test("existing importable records exact-compare every typed revision field", async () => {
  const { manifest } = await fixture();
  const sku = {
    id: "sku:1",
    revision: 3,
    seriesId: "series:1",
    targetPullKg: 5,
    patchIds: [],
    modelIds: [],
    displayOrder: 1,
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(
    validateImportableExactFields(manifest, "skuDrawers", { ...sku, revision: 4 }, undefined),
    true,
    "new records may declare their initial numeric revision",
  );
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "skuDrawers",
      { ...sku, revision: 4 },
      sku,
    ),
    /revision is exact-equal/,
  );
  const compatibility = {
    id: "compatibility:1",
    axis: "method_type",
    effect: "allow",
    selector: {},
    requirements: [],
    priority: 1,
    ruleSetVersion: "rules:v1",
    reason: "test",
    suggestion: "",
    enabled: true,
  };
  assert.equal(
    validateImportableExactFields(
      manifest,
      "compatibilityRules",
      { ...compatibility },
      compatibility,
    ),
    true,
  );
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "compatibilityRules",
      { ...compatibility, ruleSetVersion: "rules:v2" },
      compatibility,
    ),
    /ruleSetVersion is exact-equal/,
  );

  const nestedManifest = clone(manifest);
  nestedManifest.recordSchemas.purchasableModels.revisionFields =
    ["componentSelections.0.componentId"];
  const model = {
    id: "model:nested",
    revision: 1,
    skuId: "sku:1",
    name: "Nested",
    action: "M",
    hardness: "H",
    lengthM: 2.4,
    componentSelections: [{
      itemPartId: "part:rod",
      componentId: "component:1",
      name: "组件",
      values: {},
    }],
    technologyIds: [],
    attributeAffixIds: [],
    passiveAffixIds: [],
    patchIds: [],
    price: 100,
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.throws(
    () => validateImportableExactFields(
      nestedManifest,
      "purchasableModels",
      {
        ...model,
        componentSelections: [
          { ...model.componentSelections[0], componentId: "component:2" },
        ],
      },
      model,
    ),
    /componentSelections\.0\.componentId is exact-equal/,
  );
  assert.throws(
    () => validateImportableExactFields(
      nestedManifest,
      "purchasableModels",
      { ...model, componentSelections: [] },
      model,
    ),
    /candidate revision is missing/,
  );
});

test("preserved rows bind a versioned schema id to the closed payload variant", async () => {
  const { manifest, roots } = await fixture();
  const schemaColumn = manifest.workbookSchema.sheets.__TF_PRESERVED.columns
    .find((entry) => entry.name === "record_schema_id");
  const legacyPayload = {
    definitionId: "definition:1",
    definitionVersion: "v1",
    fishWeightGradeId: "grade:1",
    fiveAxisRuleVersion: "rules:v1",
  };
  const currentPayload = { vertexSetId: "vertex:1" };

  assert.equal(
    validateMachineCell(
      schemaColumn,
      "project-workbook/preserved/performanceProfiles/v1",
      "string",
      {
        manifest,
        root: "performanceProfiles",
        payload: { id: "performance:1" },
      },
    ),
    true,
  );
  assert.equal(
    validateMachineCell(
      schemaColumn,
      "project-workbook/preserved/fiveAxisVertexSets/legacy-v1",
      "string",
      { manifest, root: "fiveAxisVertexSets", payload: legacyPayload },
    ),
    true,
  );
  assert.equal(
    validateMachineCell(
      schemaColumn,
      "project-workbook/preserved/fiveAxisVertexSets/current-v1",
      "string",
      { manifest, root: "fiveAxisVertexSets", payload: currentPayload },
    ),
    true,
  );
  assert.throws(
    () => validateMachineCell(
      schemaColumn,
      "project-workbook/preserved/fiveAxisVertexSets/current-v1",
      "string",
      { manifest, root: "fiveAxisVertexSets", payload: legacyPayload },
    ),
    /does not match its closed payload variant/,
  );

  const missingColumn = clone(manifest);
  missingColumn.workbookSchema.sheets.__TF_PRESERVED.columns =
    missingColumn.workbookSchema.sheets.__TF_PRESERVED.columns
      .filter((column) => column.name !== "record_schema_id");
  assert.throws(() => validateProjectWorkbookManifest(missingColumn, roots), /exact closed schema/);

  const unhashedSchemaId = clone(manifest);
  unhashedSchemaId.canonicalization.recordHashInput =
    unhashedSchemaId.canonicalization.recordHashInput
      .filter((field) => field !== "record_schema_id");
  assert.throws(() => validateProjectWorkbookManifest(unhashedSchemaId, roots));

  const swappedVariantSchemas = clone(manifest);
  [
    swappedVariantSchemas.preservedSchemaCatalog.fiveAxisVertexSets.LegacyFiveAxisVertexSet,
    swappedVariantSchemas.preservedSchemaCatalog.fiveAxisVertexSets.FiveAxisVertexSet,
  ] = [
    swappedVariantSchemas.preservedSchemaCatalog.fiveAxisVertexSets.FiveAxisVertexSet,
    swappedVariantSchemas.preservedSchemaCatalog.fiveAxisVertexSets.LegacyFiveAxisVertexSet,
  ];
  assert.throws(
    () => validateProjectWorkbookManifest(swappedVariantSchemas, roots),
    /variant schema identities/,
  );
});

test("preserved opaque rows hash-bind every recursively reachable type authority", async () => {
  const { manifest, roots } = await fixture();
  assert.equal(
    preservedTypeGraphHash(manifest),
    manifest.preservedSchemaAuthority.recursiveTypeGraphSha256,
  );

  const missingExternalAuthority = clone(manifest);
  missingExternalAuthority.preservedSchemaAuthority.sources =
    missingExternalAuthority.preservedSchemaAuthority.sources
      .filter((source) => source.path !== "lib/performance-summary.ts");
  assert.throws(
    () => preservedTypeGraphHash(missingExternalAuthority),
    /lib\/performance-summary\.ts.*(?:source|dependency).*omitted/,
  );

  const typesSource = await readFile(workspaceStatePath, "utf8");
  const nestedMutation = typesSource.replace(
    "export interface ModelComponentSelection {\n  itemPartId: string;\n  componentId: string;",
    "export interface ModelComponentSelection {\n  itemPartId: string;\n  componentId: string;\n  schemaEvidence?: string;",
  );
  assert.notEqual(nestedMutation, typesSource);
  const nestedManifest = clone(manifest);
  nestedManifest.preservedSchemaAuthority.sources
    .find((source) => source.path === "lib/types.ts").sha256 =
      createHash("sha256").update(nestedMutation).digest("hex");
  assert.notEqual(
    preservedTypeGraphHash(
      nestedManifest,
      process.cwd(),
      new Map([["lib/types.ts", nestedMutation]]),
    ),
    manifest.preservedSchemaAuthority.recursiveTypeGraphSha256,
  );

  const externalUrl = new URL("../lib/performance-summary.ts", import.meta.url);
  const externalSource = await readFile(externalUrl, "utf8");
  const externalMutation = externalSource.replace(
    "definitionHash: string;",
    "definitionHash: string;\n  schemaEvidence?: string;",
  );
  assert.notEqual(externalMutation, externalSource);
  const externalManifest = clone(manifest);
  externalManifest.preservedSchemaAuthority.sources
    .find((source) => source.path === "lib/performance-summary.ts").sha256 =
      createHash("sha256").update(externalMutation).digest("hex");
  assert.notEqual(
    preservedTypeGraphHash(
      externalManifest,
      process.cwd(),
      new Map([["lib/performance-summary.ts", externalMutation]]),
    ),
    manifest.preservedSchemaAuthority.recursiveTypeGraphSha256,
  );

  const weakenedDynamicBoundary = clone(manifest);
  weakenedDynamicBoundary.preservedSchemaAuthority.dynamicValuePolicy = "ALLOW_CLIENT_CONSTRUCTION";
  assert.throws(() => validateProjectWorkbookManifest(weakenedDynamicBoundary, roots));
});

test("safe projections rederive unresolved diagnostic payloads", async () => {
  const { manifest, roots } = await fixture();
  assert.deepEqual(manifest.recordSchemaAuthority.projectionExclusions.skuDrawers, [
    "projectionMatch", "fiveAxisProjectionReferences", "validationSummary",
  ]);
  assert.deepEqual(manifest.recordSchemaAuthority.projectionExclusions.technologies, [
    "compatiblePerformanceProfileIds",
  ]);
  for (const [root, fields] of Object.entries(
    manifest.recordSchemaAuthority.projectionExclusions,
  )) {
    assert.ok(fields.every((field) => !manifest.recordSchemas[root].allowedFields.includes(field)));
  }
  const weakened = clone(manifest);
  weakened.recordSchemas.skuDrawers.allowedFields.push("validationSummary");
  assert.throws(() => validateProjectWorkbookManifest(weakened, roots), /allowed-field catalog drift|rederived/);

  const technology = {
    id: "technology:legacy-compatible",
    version: 1,
    name: "兼容技术",
    description: "",
    affixIds: [],
    compatibleSeriesIds: [],
    generationPolicy: "normal",
    valueScorePolicy: "members_only",
    enabled: true,
  };
  assert.equal(
    validateImportableExactFields(manifest, "technologies", technology, undefined),
    true,
    "new Technology projection does not require historical Performance links",
  );
  assert.equal(
    validateImportableExactFields(
      manifest,
      "technologies",
      { ...technology, name: "兼容技术（修订）" },
      technology,
    ),
    true,
    "existing Technology remains editable without importing historical Performance links",
  );
  for (const existing of [undefined, technology]) {
    assert.throws(
      () => validateImportableExactFields(
        manifest,
        "technologies",
        { ...technology, compatiblePerformanceProfileIds: ["performance:legacy"] },
        existing,
      ),
      /compatiblePerformanceProfileIds is outside allowedFields/,
    );
  }
  const performanceLeak = clone(manifest);
  performanceLeak.recordSchemas.technologies.allowedFields.push("compatiblePerformanceProfileIds");
  assert.throws(
    () => validateProjectWorkbookManifest(performanceLeak, roots),
    /allowed-field catalog drift|must be rederived/,
  );
});

test("machine columns reject blank, null, numeric precision, date, boolean and error confusion", async () => {
  const { manifest } = await fixture();
  const columns = Object.fromEntries(
    manifest.workbookSchema.sheets.__TF_MANIFEST.columns.map((entry) => [entry.name, entry]),
  );
  assert.equal(validateMachineCell(columns.base_workspace_revision, "9007199254740991"), true);
  assert.throws(() => validateMachineCell(columns.base_workspace_revision, 1, "number"), /rejects/);
  assert.throws(
    () => validateMachineCell(columns.base_workspace_revision, "9007199254740993"),
    /not safe/,
  );
  for (const kind of ["date", "boolean", "error", "formula"]) {
    assert.throws(() => validateMachineCell(columns.workspace_id, "x", kind), /rejects/);
  }
  assert.throws(() => validateMachineCell(columns.workspace_id, ""), /blank/);
  assert.throws(() => validateMachineCell(columns.workspace_id, null), /text/);
  assert.equal(validateMachineCell(columns.machine_content_sha256, "a".repeat(64)), true);
  assert.throws(() => validateMachineCell(columns.machine_content_sha256, "A".repeat(64)));
  const payloadColumn = manifest.workbookSchema.sheets.__TF_CURRENT.columns
    .find((entry) => entry.name === "payload_json");
  assert.equal(validateMachineCell(payloadColumn, '{"a":2,"b":1}'), true);
  assert.throws(() => validateMachineCell(payloadColumn, '{"b":1,"a":2}'), /canonical JSON/);
  assert.throws(
    () => validateMachineCell(payloadColumn, '{"z":1,"K":2}'),
    /canonical JSON/,
  );
  assert.throws(
    () => validateMachineCell(payloadColumn, '{"é":1,"é":2}'),
    /NFC key collisions/,
  );
  for (const invalid of [
    '"\\ud800"',
    '"\\udc00"',
    '{"nested":{"\\ud800":1}}',
    '{"nested":{"value":"\\udc00"}}',
  ]) {
    assert.throws(
      () => validateMachineCell(payloadColumn, invalid),
      /unpaired UTF-16 surrogate/,
    );
  }
  assert.equal(
    validateMachineCell(payloadColumn, '{"emoji":"😀","nested":{"😀":"ok"}}'),
    true,
  );
  assert.equal(validateMachineCell(payloadColumn, '"line1\\nline2"'), true);
  for (const nonLf of [
    '"line1\\r\\nline2"',
    '"line1\\rline2"',
    '{"nested":{"note":"line1\\r\\nline2"}}',
  ]) {
    assert.throws(() => validateMachineCell(payloadColumn, nonLf), /canonical JSON/);
  }
  assert.throws(
    () => validateMachineCell(payloadColumn, '{"a\\r\\nb":1,"a\\nb":2}'),
    /NFC key collisions/,
  );
  assert.throws(
    () => validateMachineCell(payloadColumn, '{"é\\r\\n":1,"é\\n":2}'),
    /NFC key collisions/,
  );
});

test("workbook manifest recomputes every declared hash from a closed workbook context", async () => {
  const { manifest, manifestSource, roots } = await fixture();
  const context = workbookContext(manifest, manifestSource);
  const row = workbookEnvelope(manifest, context);
  assert.equal(validateWorkbookEnvelope(manifest, row, context), true);
  assert.equal(
    manifest.canonicalization.machineContentHashEncoding,
    "RFC8785_ORDERED_SHEET_ROW_PAIR_ARRAY_V1",
  );
  assert.throws(
    () => validateWorkbookEnvelope(manifest, row),
    /context is required/,
  );

  const fieldMutation = clone(row);
  fieldMutation.workspace_id = "workspace:2";
  assert.throws(
    () => validateWorkbookEnvelope(manifest, fieldMutation, context),
    /manifestFields do not match/,
  );
  const schemaMutation = clone(row);
  schemaMutation.workbook_schema_sha256 = "0".repeat(64);
  assert.throws(
    () => validateWorkbookEnvelope(manifest, schemaMutation, context),
    /workbook_schema_sha256 does not match/,
  );
  const rootManifestMutation = clone(row);
  rootManifestMutation.root_manifest_sha256 = "0".repeat(64);
  assert.throws(
    () => validateWorkbookEnvelope(manifest, rootManifestMutation, context),
    /root_manifest_sha256 does not match/,
  );

  const rowMutationContext = clone(context);
  rowMutationContext.machineSheets.__TF_FORBIDDEN[0].policy_marker = "FORGED";
  assert.throws(
    () => validateWorkbookEnvelope(manifest, row, rowMutationContext),
    /FORBIDDEN_PAYLOAD_OMITTED/,
  );
  const validRowMutation = clone(context);
  validRowMutation.machineSheets.__TF_SERVER_REFS[0].opaque_server_ref =
    `opaque_${"f".repeat(64)}`;
  assert.throws(
    () => validateWorkbookEnvelope(manifest, row, validRowMutation),
    /machine_content_sha256 does not match/,
  );
  const omittedSheet = clone(context);
  delete omittedSheet.machineSheets.__TF_SERVER_REFS;
  assert.throws(
    () => validateWorkbookEnvelope(manifest, row, omittedSheet),
    /include set exactly/,
  );
  const includeMutation = clone(manifest);
  includeMutation.canonicalization.machineContentHashInput.push("__TF_DIAGNOSTICS");
  assert.throws(
    () => validateWorkbookEnvelope(
      includeMutation,
      row,
      { ...context, rootManifestSource: JSON.stringify(includeMutation) },
    ),
    /include set exactly|not a declared machine-content sheet/,
  );
  for (const alternativeEncoding of [
    "RFC8785_OBJECT_BY_SHEET_V1",
    "CONCATENATED_ROWS_V1",
    "STREAMED_SHEETS_V1",
  ]) {
    const encodingMutation = clone(manifest);
    encodingMutation.canonicalization.machineContentHashEncoding = alternativeEncoding;
    assert.throws(
      () => computeWorkbookHashes(
        encodingMutation,
        { ...context, rootManifestSource: JSON.stringify(encodingMutation) },
      ),
      /hash encoding drift/,
    );
  }
  const reorderedInput = clone(manifest);
  [
    reorderedInput.canonicalization.machineContentHashInput[1],
    reorderedInput.canonicalization.machineContentHashInput[2],
  ] = [
    reorderedInput.canonicalization.machineContentHashInput[2],
    reorderedInput.canonicalization.machineContentHashInput[1],
  ];
  assert.throws(
    () => validateProjectWorkbookManifest(reorderedInput, roots),
    /__TF_CURRENT|__TF_PRESERVED/,
  );

  const rehashedMutation = clone(context);
  rehashedMutation.machineSheets.__TF_FORBIDDEN[0].root =
    rehashedMutation.machineSheets.__TF_FORBIDDEN[1].root;
  assert.throws(
    () => computeWorkbookHashes(manifest, rehashedMutation),
    /every forbidden root exactly once/,
  );
});

test("every closed format validates its domain and unknown formats fail closed", async () => {
  const { manifest } = await fixture();
  const byFormat = new Map(
    Object.values(manifest.workbookSchema.sheets)
      .flatMap((sheet) => sheet.columns)
      .map((entry) => [entry.format, entry]),
  );
  const genericStableId = {
    name: "workspace_id",
    type: "string",
    required: true,
    format: "stable-id",
  };
  assert.equal(validateMachineCell(genericStableId, "workspace:alpha-1"), true);
  assert.throws(() => validateMachineCell(genericStableId, "bad id"));
  assert.equal(validateMachineCell(byFormat.get("stable-version"), "v1.2.3+safe"), true);
  assert.throws(() => validateMachineCell(byFormat.get("stable-version"), "v 1"));
  assert.equal(validateMachineCell(byFormat.get("workspace-root"), "parameters"), true);
  assert.throws(() => validateMachineCell(byFormat.get("workspace-root"), "futureRoot"));
  assert.equal(validateMachineCell(byFormat.get("diagnostic-severity"), "WARNING"), true);
  assert.throws(() => validateMachineCell(byFormat.get("diagnostic-severity"), "warn"));
  assert.equal(validateMachineCell(byFormat.get("stable-code"), "SCHEMA_CONFLICT"), true);
  assert.throws(() => validateMachineCell(byFormat.get("stable-code"), "schema-conflict"));
  assert.equal(validateMachineCell(byFormat.get("classification"), "preserved_frozen"), true);
  assert.throws(() => validateMachineCell(byFormat.get("classification"), "mutable"));
  assert.equal(validateMachineCell(byFormat.get("display-text"), "安全说明"), true);
  assert.throws(() => validateMachineCell(byFormat.get("display-text"), "bad\u0000text"));
  assert.throws(
    () => validateMachineCell(
      { name: "future", type: "string", required: true, format: "future-format" },
      "value",
    ),
    /Unknown machine column format/,
  );
});

test("record key JSON binds root identity arity, primitive types and preserved variants", async () => {
  const { manifest } = await fixture();
  const keyColumn = manifest.workbookSchema.sheets.__TF_CURRENT.columns
    .find((entry) => entry.name === "record_key");
  assert.equal(
    validateMachineCell(keyColumn, '["tech:1",2]', "string", {
      manifest,
      root: "v23TechnologyDefinitions",
      payload: { technologyId: "tech:1", revision: 2 },
    }),
    true,
  );
  assert.throws(
    () => validateMachineCell(keyColumn, '["tech:1"]', "string", {
      manifest,
      root: "v23TechnologyDefinitions",
      payload: { technologyId: "tech:1", revision: 2 },
    }),
    /arity/,
  );
  assert.throws(
    () => validateMachineCell(keyColumn, '["tech:1",1.5]', "string", {
      manifest,
      root: "v23TechnologyDefinitions",
      payload: { technologyId: "tech:1", revision: 1.5 },
    }),
    /safe integer/,
  );
  assert.throws(
    () => validateMachineCell(keyColumn, '["tech:1","2"]', "string", {
      manifest,
      root: "v23TechnologyDefinitions",
      payload: { technologyId: "tech:1", revision: "2" },
    }),
    /revision must be a safe integer/,
  );
  assert.equal(
    validateMachineCell(keyColumn, '["definition:1","v1","grade:1","rules:v1"]', "string", {
      manifest,
      root: "fiveAxisVertexSets",
      variant: "LegacyFiveAxisVertexSet",
      payload: {
        definitionId: "definition:1",
        definitionVersion: "v1",
        fishWeightGradeId: "grade:1",
        fiveAxisRuleVersion: "rules:v1",
      },
    }),
    true,
  );
  assert.throws(
    () => validateMachineCell(
      keyColumn,
      '["definition:1","v1",1,"rules:v1"]',
      "string",
      {
        manifest,
        root: "fiveAxisVertexSets",
        variant: "LegacyFiveAxisVertexSet",
        payload: {
          definitionId: "definition:1",
          definitionVersion: "v1",
          fishWeightGradeId: 1,
          fiveAxisRuleVersion: "rules:v1",
        },
      },
    ),
    /fishWeightGradeId must be NFC text/,
  );
  assert.equal(
    validateMachineCell(keyColumn, '["vertex:1"]', "string", {
      manifest,
      root: "fiveAxisVertexSets",
      payload: { vertexSetId: "vertex:1" },
    }),
    true,
  );
  assert.throws(
    () => validateMachineCell(keyColumn, '["collection:other"]', "string", {
      manifest,
      root: "collections",
      payload: { id: "collection:actual" },
    }),
    /record key does not match payload identity/,
  );
  assert.throws(
    () => validateMachineCell(keyColumn, '["tech:other",1]', "string", {
      manifest,
      root: "v23TechnologyDefinitions",
      payload: { technologyId: "tech:actual", revision: 1 },
    }),
    /record key does not match payload identity/,
  );
  assert.equal(
    validateMachineCell(keyColumn, '["template:1","revision:2"]', "string", {
      manifest,
      root: "v23FunctionTemplates",
      payload: {
        ref: {
          templateId: "template:1",
          revisionId: "revision:2",
          contentHash: "a".repeat(64),
        },
      },
    }),
    true,
  );
  assert.equal(
    validateMachineCell(keyColumn, '["$singleton"]', "string", {
      manifest,
      root: "notes",
      payload: "note",
    }),
    true,
  );
  assert.throws(
    () => validateMachineCell(keyColumn, '["$singleton"]', "string", {
      manifest,
      root: "notes",
      payload: { value: "note" },
    }),
    /canonical scalar string representation/,
  );
  assert.throws(
    () => validateMachineCell(keyColumn, '["collection:1"]', "string", {
      manifest,
      root: "collections",
      payload: { name: "missing identity" },
    }),
    /identity is missing from payload/,
  );
  assert.throws(
    () => validateMachineCell(keyColumn, '["vertex:1"]', "string", {
      manifest,
      root: "fiveAxisVertexSets",
      variant: "LegacyFiveAxisVertexSet",
      payload: { vertexSetId: "vertex:1" },
    }),
    /caller variant contradicts/,
  );
});

test("notes has one canonical scalar payload representation", async () => {
  const { manifest, roots } = await fixture();
  const payloadColumn = manifest.workbookSchema.sheets.__TF_CURRENT.columns
    .find((entry) => entry.name === "payload_json");
  assert.deepEqual(manifest.recordSchemas.notes.allowedFields, ["$scalar"]);
  assert.equal(
    validateMachineCell(payloadColumn, '"note"', "string", {
      manifest,
      root: "notes",
    }),
    true,
  );
  assert.equal(
    validateMachineCell(payloadColumn, '""', "string", {
      manifest,
      root: "notes",
    }),
    true,
  );
  assert.equal(
    validateMachineCell(payloadColumn, '"line1\\nline2"', "string", {
      manifest,
      root: "notes",
    }),
    true,
  );
  for (const nonLf of ['"line1\\r\\nline2"', '"line1\\rline2"']) {
    assert.throws(
      () => validateMachineCell(payloadColumn, nonLf, "string", {
        manifest,
        root: "notes",
      }),
      /canonical JSON/,
    );
  }
  assert.throws(
    () => validateMachineCell(payloadColumn, '{"value":"note"}', "string", {
      manifest,
      root: "notes",
    }),
    /canonical scalar string representation/,
  );

  const objectWrapper = clone(manifest);
  objectWrapper.recordSchemas.notes.allowedFields = ["value"];
  assert.throws(
    () => validateProjectWorkbookManifest(objectWrapper, roots),
    /scalar payload|catalog drift/,
  );
});

test("RFC8785 payloads satisfy the bound closed recursive record schema", async () => {
  const { manifest } = await fixture();
  const payloadColumn = manifest.workbookSchema.sheets.__TF_CURRENT.columns
    .find((entry) => entry.name === "payload_json");
  const validate = (root, payload, variant) => validateMachineCell(
    payloadColumn,
    canonicalPayload(payload),
    "string",
    { manifest, root, variant },
  );
  const itemPart = {
    id: "part:rod",
    name: "竿",
    activeInGeneration: true,
    parameterKeys: ["power"],
    notes: "",
  };
  assert.equal(validate("itemParts", itemPart), true);
  assert.equal(validate("itemParts", { ...itemPart, legacyItemKind: "rod" }), true);

  for (const [payload, pattern] of [
    [{ ...itemPart, rawPayload: { secret: "x" } }, /outside allowedFields/],
    [{ id: itemPart.id, rawPayload: { secret: "x" } }, /outside allowedFields|required/],
    [{
      id: itemPart.id,
      activeInGeneration: true,
      parameterKeys: ["power"],
      notes: "",
    }, /name is required/],
    [{ ...itemPart, activeInGeneration: "true" }, /must be boolean/],
    [{ ...itemPart, parameterKeys: [1] }, /must be NFC text/],
    [{ ...itemPart, name: "e\u0301" }, /canonical JSON|must be NFC text/],
  ]) {
    assert.throws(() => validate("itemParts", payload), pattern);
  }

  const methodProfile = {
    id: "method:float",
    name: "浮钓",
    rules: [{
      id: "rule:1",
      parameterKey: "power",
      operation: "add",
      value: 1.5,
      condition: "enabled",
    }],
    enabled: true,
    notes: "",
  };
  assert.equal(validate("methodProfiles", methodProfile), true);
  assert.equal(
    validate("methodProfiles", {
      ...methodProfile,
      rules: [{ ...methodProfile.rules[0], value: "current * 2" }],
    }),
    true,
  );
  assert.throws(
    () => validate("methodProfiles", {
      ...methodProfile,
      rules: [{ ...methodProfile.rules[0], hidden: "server" }],
    }),
    /outside allowedFields/,
  );
  assert.throws(
    () => validate("methodProfiles", {
      ...methodProfile,
      rules: [{ ...methodProfile.rules[0], value: false }],
    }),
    /closed union variant/,
  );
  assert.throws(
    () => validate("methodProfiles", { ...methodProfile, rules: {} }),
    /must be an array/,
  );

  const template = {
    id: "template:1",
    name: "模板",
    fishMinKg: 1,
    fishMaxKg: 2,
    nominalFishKg: 1.5,
    tier: "A",
    values: { power: 1, label: "normal" },
    notes: "",
  };
  assert.equal(validate("templates", template), true);
  assert.throws(
    () => validate("templates", { ...template, values: { power: true } }),
    /closed union variant/,
  );
  const affinityWeights = {
    method_type: 1,
    type_weight: 1,
    type_function: 1,
    function_performance: 1,
    material_function: 1,
    quality_specialization: 1,
    model_component: 1,
    series_coherence: 1,
  };
  assert.equal(validate("affinityAxisWeights", affinityWeights), true);
  const incompleteWeights = { ...affinityWeights };
  delete incompleteWeights.series_coherence;
  assert.throws(
    () => validate("affinityAxisWeights", incompleteWeights),
    /complete closed record key set/,
  );
  assert.equal(validate("v3Affixes", {
    id: "affix:1",
    version: 1,
    name: "力量",
    category: "attribute",
    itemPartId: "part:rod",
    generationPolicy: "normal",
    rarity: "common",
    valueScore: 1,
    tags: [],
    attributeEffects: [{
      id: "effect:1",
      parameterKey: "power",
      operation: "flat_bonus",
      value: 1,
      publishedMagnitudeRange: {
        min: 0,
        max: 2,
        ruleSetVersion: "rules:v1",
      },
      unit: "kg",
      stackingGroup: "power",
      ruleSetVersion: "rules:v1",
    }],
    description: "",
    enabled: true,
  }), true);
  assert.throws(
    () => validate("itemParts", itemPart, "ForgedVariant"),
    /does not accept a caller variant/,
  );
});

test("record revision is typed RFC8785 scalar JSON and matches payload plus identity", async () => {
  const { manifest } = await fixture();
  const revisionColumn = manifest.workbookSchema.sheets.__TF_CURRENT.columns
    .find((entry) => entry.name === "record_revision");
  const revisionedContext = {
    manifest,
    root: "skuDrawers",
    payload: { id: "sku:1", revision: 1 },
    recordKey: ["sku:1"],
  };
  assert.equal(validateMachineCell(revisionColumn, "1", "string", revisionedContext), true);
  for (const invalid of ["v1", "01", "null", '"1"']) {
    assert.throws(
      () => validateMachineCell(revisionColumn, invalid, "string", revisionedContext),
      /JSON|canonical|safe integer|required/,
    );
  }
  assert.throws(
    () => validateMachineCell(revisionColumn, "2", "string", revisionedContext),
    /payload mismatch/,
  );
  assert.throws(
    () => validateMachineCell(revisionColumn, "1", "string", {
      manifest,
      root: "v23TechnologyDefinitions",
      payload: { technologyId: "tech:1", revision: 1 },
      recordKey: ["tech:1", 2],
    }),
    /identity mismatch/,
  );

  const optionalString = {
    manifest,
    root: "performanceProfiles",
    payload: { id: "performance:1" },
    recordKey: ["performance:1"],
  };
  assert.equal(validateMachineCell(revisionColumn, "null", "string", optionalString), true);
  assert.throws(
    () => validateMachineCell(revisionColumn, '"null"', "string", optionalString),
    /payload mismatch/,
  );
  assert.equal(
    validateMachineCell(revisionColumn, '"null"', "string", {
      ...optionalString,
      payload: { id: "performance:1", sourceRevisionId: "null" },
    }),
    true,
  );

  assert.equal(
    validateMachineCell(revisionColumn, '"v1"', "string", {
      manifest,
      root: "fiveAxisVertexSets",
      variant: "LegacyFiveAxisVertexSet",
      payload: {
        definitionId: "definition:1",
        definitionVersion: "v1",
        fishWeightGradeId: "grade:1",
        fiveAxisRuleVersion: "rules:v1",
      },
      recordKey: ["definition:1", "v1", "grade:1", "rules:v1"],
    }),
    true,
  );
  assert.equal(
    validateMachineCell(revisionColumn, '"v2"', "string", {
      manifest,
      root: "fiveAxisVertexSets",
      variant: "FiveAxisVertexSet",
      payload: { vertexSetId: "vertex:1", fiveAxisDefinitionVersion: "v2" },
      recordKey: ["vertex:1"],
    }),
    true,
  );
  assert.throws(
    () => validateMachineCell(revisionColumn, "2", "string", {
      manifest,
      root: "fiveAxisVertexSets",
      variant: "FiveAxisVertexSet",
      payload: { vertexSetId: "vertex:1", fiveAxisDefinitionVersion: "v2" },
      recordKey: ["vertex:1"],
    }),
    /non-empty NFC text/,
  );
});

test("record content hash binds the complete current and preserved row envelope", async () => {
  const { manifest } = await fixture();
  const currentPayload = {
    id: "part:rod",
    name: "竿",
    activeInGeneration: true,
    parameterKeys: ["power"],
    notes: "",
  };
  const currentRow = {
    root: "itemParts",
    record_schema_id: manifest.recordSchemas.itemParts.schemaId,
    record_key: '["part:rod"]',
    record_revision: "null",
    record_content_sha256: "0".repeat(64),
    payload_json: canonicalPayload(currentPayload),
  };
  currentRow.record_content_sha256 = expectedRecordHash(manifest, currentRow, "payload_json");
  assert.equal(validateRecordEnvelope(manifest, currentRow), true);
  const currentHashColumn = manifest.workbookSchema.sheets.__TF_CURRENT.columns
    .find((entry) => entry.name === "record_content_sha256");
  assert.equal(
    validateMachineCell(
      currentHashColumn,
      currentRow.record_content_sha256,
      "string",
      { manifest, row: currentRow },
    ),
    true,
  );

  for (const [mutate, pattern] of [
    [(row) => { row.record_content_sha256 = "0".repeat(64); }, /does not match/],
    [(row) => { row.payload_json = canonicalPayload({ ...currentPayload, name: "轮" }); }, /does not match/],
    [(row) => { row.record_key = '["part:reel"]'; }, /record key does not match/],
    [(row) => { row.record_revision = "1"; }, /has no revision field/],
    [(row) => { row.record_schema_id = manifest.recordSchemas.collections.schemaId; },
      /schema id does not match/],
    [(row) => { row.root = "collections"; }, /schema id does not match|required|outside allowedFields/],
  ]) {
    const forged = clone(currentRow);
    mutate(forged);
    assert.throws(() => validateRecordEnvelope(manifest, forged), pattern);
  }
  assert.throws(
    () => validateMachineCell(
      currentHashColumn,
      "0".repeat(64),
      "string",
      { manifest, row: currentRow },
    ),
    /hash cell must match|does not match/,
  );
  const lfReplay = {
    ...currentRow,
    payload_json: canonicalPayload({ ...currentPayload, notes: "line1\nline2" }),
  };
  const crlfHashInput = {
    ...lfReplay,
    payload_json: canonicalPayload({ ...currentPayload, notes: "line1\r\nline2" }),
  };
  lfReplay.record_content_sha256 = expectedRecordHash(
    manifest,
    crlfHashInput,
    "payload_json",
  );
  assert.throws(
    () => validateRecordEnvelope(manifest, lfReplay),
    /does not match/,
    "a pre-normalization CRLF hash cannot replay against the canonical LF row",
  );
  assert.throws(
    () => validateMachineCell(currentHashColumn, currentRow.record_content_sha256),
    /requires manifest|complete row envelope/,
  );

  const preservedPayload = {
    fishWeightGradeId: "grade:1",
    fiveAxisRuleVersion: "rules:v1",
    definitionId: "definition:1",
    definitionVersion: "v1",
  };
  const preservedRow = {
    root: "fiveAxisVertexSets",
    record_schema_id:
      manifest.preservedSchemaCatalog.fiveAxisVertexSets.LegacyFiveAxisVertexSet,
    record_key: '["definition:1","v1","grade:1","rules:v1"]',
    record_revision: '"v1"',
    record_content_sha256: "0".repeat(64),
    opaque_canonical_payload_json: canonicalPayload(preservedPayload),
  };
  preservedRow.record_content_sha256 = expectedRecordHash(
    manifest,
    preservedRow,
    "opaque_canonical_payload_json",
  );
  assert.equal(validateRecordEnvelope(manifest, preservedRow), true);
  const preservedMutation = clone(preservedRow);
  preservedMutation.opaque_canonical_payload_json = canonicalPayload({
    ...preservedPayload,
    values: {},
  });
  assert.throws(() => validateRecordEnvelope(manifest, preservedMutation), /does not match/);
});

test("nullable preserved singleton binds its exact WorkspaceState scalar union", async () => {
  const { manifest, roots } = await fixture();
  const root = "currentFiveAxisDispositionCatalogRevisionId";
  assert.equal(
    manifest.preservedRootCatalog[root].typeRef,
    "lib/types.ts#string|null",
  );
  assert.equal(validatePreservedRootCatalog(manifest), true);
  const payloadColumn = manifest.workbookSchema.sheets.__TF_PRESERVED.columns
    .find((entry) => entry.name === "opaque_canonical_payload_json");
  for (const payload of ['"revision:v1"', "null"]) {
    assert.equal(
      validateMachineCell(payloadColumn, payload, "string", { manifest, root }),
      true,
    );
  }
  for (const payload of ['{"value":"revision:v1"}', "1", "undefined"]) {
    assert.throws(
      () => validateMachineCell(payloadColumn, payload, "string", { manifest, root }),
      /nullable string representation|JSON/,
    );
  }
  const collapsed = clone(manifest);
  collapsed.preservedRootCatalog[root].typeRef = "lib/types.ts#string";
  assert.throws(
    () => validatePreservedRootCatalog(collapsed),
    /exact WorkspaceState property element\/scalar type/,
  );
  assert.equal(validateProjectWorkbookManifest(manifest, roots), true);
});

test("all diagnostic roots derive closed non-semantic subject keys from safe payloads", async () => {
  const { manifest, roots } = await fixture();
  const keyColumn = manifest.workbookSchema.sheets.__TF_DIAGNOSTICS.columns
    .find((entry) => entry.name === "record_key");
  const payloads = {
    derivedProjections: { id: "projection:1" },
    projectionMatches: {
      projectionId: "projection:1",
      itemPartId: "part:rod",
      ruleSetVersion: "rules:v1",
      targetPullKg: 2.5,
    },
    candidateRuns: { runId: "run:1" },
    candidateMaterializations: { materializationId: "materialization:1" },
    sourceIdentityMigrationReports: { reportId: "report:1" },
    modelPricingEvaluations: { id: "pricing:1", revision: 2 },
    aiAssessments: { assessmentId: "assessment:1" },
    upgradeCandidates: { id: "upgrade:1" },
    fiveAxisVertexGroupStates: {
      groupKey: {
        weightBandId: "band:1",
        weightBandPolicyVersion: "bands:v1",
        fiveAxisDefinitionId: "definition:1",
        fiveAxisDefinitionVersion: "v1",
        fiveAxisRuleVersion: "rules:v1",
      },
    },
    ruleRuns: { id: "rule-run:1" },
  };
  assert.deepEqual(Object.keys(payloads), manifest.classifications.export_only_diagnostic);
  assert.equal(validateDiagnosticRootCatalog(manifest), true);
  for (const [root, payload] of Object.entries(payloads)) {
    assert.equal(
      validateMachineCell(keyColumn, diagnosticKey(manifest, root, payload), "string", {
        manifest,
        root,
        payload,
      }),
      true,
      root,
    );
  }
  const diagnosticRow = {
    root: "derivedProjections",
    record_key: diagnosticKey(manifest, "derivedProjections", payloads.derivedProjections),
    diagnostic_schema_version: "project-workbook-diagnostic/v1",
    subject_payload_json: canonicalPayload(payloads.derivedProjections),
    severity: "WARNING",
    code: "PROJECTION_STALE",
    message: "派生结果已过期",
    subject_ref: "null",
    diagnostic_evidence_sha256: "",
  };
  diagnosticRow.diagnostic_evidence_sha256 = diagnosticEvidence(manifest, diagnosticRow);
  assert.equal(validateDiagnosticEnvelope(manifest, diagnosticRow), true);
  const subjectMutation = {
    ...diagnosticRow,
    subject_payload_json: canonicalPayload({ id: "projection:2" }),
  };
  assert.throws(
    () => validateDiagnosticEnvelope(manifest, subjectMutation),
    /does not match the safe subject payload/,
  );
  const evidenceMutation = { ...diagnosticRow, message: "被篡改的显示信息" };
  assert.throws(
    () => validateDiagnosticEnvelope(manifest, evidenceMutation),
    /diagnostic_evidence_sha256 does not match/,
  );
  assert.throws(
    () => validateDiagnosticEnvelope(manifest, { ...diagnosticRow, extra: "forbidden" }),
    /closed field order/,
  );

  assert.throws(
    () => validateMachineCell(keyColumn, '["' + "0".repeat(64) + '"]', "string", {
      manifest,
      root: "derivedProjections",
      payload: payloads.derivedProjections,
    }),
    /does not match/,
  );
  assert.throws(
    () => validateMachineCell(
      keyColumn,
      diagnosticKey(manifest, "derivedProjections", payloads.derivedProjections),
      "string",
      {
        manifest,
        root: "candidateRuns",
        payload: payloads.derivedProjections,
      },
    ),
    /safe projection fields/,
  );
  assert.throws(
    () => validateMachineCell(keyColumn, '["' + "0".repeat(64) + '"]', "string", {
      manifest,
      root: "futureDiagnosticRoot",
      payload: { id: "future:1" },
    }),
    /no diagnostic subject-key contract|not importable or preserved|no record payload authority/,
  );
  assert.throws(
    () => validateMachineCell(
      keyColumn,
      diagnosticKey(manifest, "derivedProjections", payloads.derivedProjections),
      "string",
      {
        manifest,
        root: "derivedProjections",
        payload: { ...payloads.derivedProjections, message: "must not enter subject payload" },
      },
    ),
    /safe projection fields/,
  );

  const wrongType = clone(manifest);
  wrongType.diagnosticRootCatalog.ruleRuns.typeRef = "lib/types.ts#CandidateRun";
  assert.throws(() => validateDiagnosticRootCatalog(wrongType), /must match WorkspaceState/);

  const semanticLeak = clone(manifest);
  semanticLeak.canonicalization.machineContentHashInput.push("__TF_DIAGNOSTICS");
  assert.throws(() => validateProjectWorkbookManifest(semanticLeak, roots));

  const importLeak = clone(manifest);
  importLeak.recordSchemas.derivedProjections = clone(importLeak.recordSchemas.notes);
  assert.throws(() => validateProjectWorkbookManifest(importLeak, roots));
});

test("forbidden roots have no content-derived hash while diagnostics are non-semantic", async () => {
  const { manifest, roots } = await fixture();
  assert.equal(manifest.workbookSchema.classificationProjection.forbidden.sheet, "__TF_FORBIDDEN");
  assert.deepEqual(
    manifest.workbookSchema.sheets.__TF_FORBIDDEN.columns.map((entry) => entry.name),
    ["root", "classification", "policy_marker"],
  );
  assert.ok(!manifest.canonicalization.machineContentHashInput.includes("__TF_DIAGNOSTICS"));
  assert.ok(manifest.canonicalization.machineContentHashExcludes.includes("__TF_DIAGNOSTICS"));
  const weakened = clone(manifest);
  weakened.workbookSchema.classificationProjection.forbidden =
    { sheet: "__TF_SERVER_REFS", payloadPolicy: "HASH_AND_OPAQUE_REF_ONLY" };
  assert.throws(() => validateProjectWorkbookManifest(weakened, roots));
});

test("server-owned roots expose only opaque non-replayable refs and no raw-derived hash", async () => {
  const { manifest, roots } = await fixture();
  assert.deepEqual(
    Object.keys(manifest.serverOwnedRootCatalog),
    manifest.classifications.server_owned,
  );
  for (const root of manifest.classifications.server_owned) {
    assert.deepEqual(manifest.serverOwnedRootCatalog[root], {
      hashPolicy: "NO_CONTENT_HASH",
      refPolicy: "OPAQUE_NON_REPLAYABLE",
    });
    assert.equal(validateServerRefEnvelope(manifest, {
      root,
      classification: "server_owned",
      root_content_sha256: "null",
      opaque_server_ref: `opaque_${createHash("sha256").update(root).digest("hex")}`,
    }), true);
  }
  for (const rawRoot of ["patchLedger", "partConstraintSets", "configIdGovernance"]) {
    assert.throws(
      () => validateServerRefEnvelope(manifest, {
        root: rawRoot,
        classification: "server_owned",
        root_content_sha256: "a".repeat(64),
        opaque_server_ref: `opaque_${"b".repeat(64)}`,
      }),
      /null/,
    );
  }
  const weakened = clone(manifest);
  weakened.serverOwnedRootCatalog.patchLedger.hashPolicy = "HASH_RAW_PAYLOAD";
  assert.throws(
    () => validateProjectWorkbookManifest(weakened, roots),
    /raw-derived content hashes/,
  );
});

test("ROOT_SUMMARY binds all 93 roots without hashing server-owned or forbidden content", async () => {
  const { manifest } = await fixture();
  const { rows, rootRecordContext } = rootSummaryFixture(manifest);
  assert.equal(validateRootSummary(manifest, rows, rootRecordContext), true);
  assert.equal(rows.length, 93);

  const wrongClassification = clone(rows);
  wrongClassification[0].classification = "server_owned";
  assert.throws(
    () => validateRootSummary(manifest, wrongClassification, rootRecordContext),
    /classification mismatch/,
  );
  const missingRoot = rows.slice(1);
  assert.throws(
    () => validateRootSummary(manifest, missingRoot, rootRecordContext),
    /exactly 93 roots/,
  );
  const duplicatedRoot = clone(rows);
  duplicatedRoot[1].root = duplicatedRoot[0].root;
  assert.throws(
    () => validateRootSummary(manifest, duplicatedRoot, rootRecordContext),
    /each root once/,
  );

  const hashedAsNull = clone(rows);
  hashedAsNull.find((row) => row.classification === "importable_current")
    .root_content_sha256 = "null";
  assert.throws(
    () => validateRootSummary(manifest, hashedAsNull, rootRecordContext),
    /requires a closed root hash/,
  );
  const diagnosticHashMutation = clone(rows);
  diagnosticHashMutation.find((row) => row.classification === "export_only_diagnostic")
    .root_content_sha256 = "a".repeat(64);
  assert.throws(
    () => validateRootSummary(manifest, diagnosticHashMutation, rootRecordContext),
    /does not match its closed records/,
  );
  for (const classification of ["server_owned", "forbidden"]) {
    const rawHashLeak = clone(rows);
    rawHashLeak.find((row) => row.classification === classification)
      .root_content_sha256 = "b".repeat(64);
    assert.throws(
      () => validateRootSummary(manifest, rawHashLeak, rootRecordContext),
      /must not expose a raw-derived root hash/,
    );
  }
  const missingContext = clone(rootRecordContext);
  delete missingContext[Object.keys(missingContext)[0]];
  assert.throws(
    () => validateRootSummary(manifest, rows, missingContext),
    /every and only hash-bearing roots/,
  );
});

test("machine sheet catalog, columns and record fields are closed", async () => {
  const { manifest, roots } = await fixture();

  const unknownSheet = clone(manifest);
  unknownSheet.workbookSchema.sheets.UNKNOWN = clone(
    unknownSheet.workbookSchema.sheets.README,
  );
  unknownSheet.workbookSchema.sheetOrder.push("UNKNOWN");
  assert.throws(() => validateProjectWorkbookManifest(unknownSheet, roots), /closed schema|exact/);

  const unknownColumn = clone(manifest);
  unknownColumn.workbookSchema.sheets.__TF_CURRENT.columns.push("unknown_column");
  assert.throws(() => validateProjectWorkbookManifest(unknownColumn, roots), /exact closed schema/);

  const unknownRecordField = clone(manifest);
  unknownRecordField.recordSchemas.parameters.allowedFields.push("unknown_field");
  assert.throws(
    () => validateProjectWorkbookManifest(unknownRecordField, roots),
    /allowed-field catalog drift/,
  );

  const changedRecursiveType = clone(manifest);
  changedRecursiveType.recordSchemaAuthority.typeRefs.parameters =
    "lib/types.ts#Candidate";
  assert.throws(
    () => validateProjectWorkbookManifest(changedRecursiveType, roots),
    /recursive record schema authority drift/,
  );
});

test("preview, commit and export require same-workspace atomic execution boundaries", async () => {
  const { manifest, roots } = await fixture();
  assert.equal(manifest.transaction.sameWorkspaceOnly, true);
  assert.equal(manifest.transaction.crossWorkspaceCloneOrRestore, false);
  assert.equal(manifest.transaction.authorizationAtExecution, true);
  assert.equal(manifest.transaction.atomicCommit, true);
  assert.equal(manifest.transaction.idempotentCommit, true);
  assert.equal(manifest.transaction.readbackRequired, true);
  assert.equal(manifest.plan.commitRequiresExactPlanMatch, true);

  const weakened = clone(manifest);
  weakened.transaction.atomicCommit = false;
  assert.throws(() => validateProjectWorkbookManifest(weakened, roots));
});

test("ActionCode to Capability mapping rejects deletion, swaps and reuse", async () => {
  const { manifest, roots } = await fixture();

  const missing = clone(manifest);
  delete missing.actions.commit.requiredCapability;
  assert.throws(() => validateProjectWorkbookManifest(missing, roots));

  const swapped = clone(manifest);
  [
    swapped.actions.preview.requiredCapability,
    swapped.actions.commit.requiredCapability,
  ] = [
    swapped.actions.commit.requiredCapability,
    swapped.actions.preview.requiredCapability,
  ];
  assert.throws(() => validateProjectWorkbookManifest(swapped, roots));

  const reused = clone(manifest);
  reused.actions.commit.requiredCapability = reused.actions.preview.requiredCapability;
  assert.throws(() => validateProjectWorkbookManifest(reused, roots));
});
