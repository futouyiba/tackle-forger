import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CLASSIFICATIONS,
  EXPECTED_ROOT_CLASSIFICATIONS,
  checkProjectWorkbookContract,
  parseWorkspaceStateRoots,
  preservedTypeGraphHash,
  validateMachineCell,
  validateDiagnosticRootCatalog,
  validatePreservedRootCatalog,
  validateProjectWorkbookManifest,
} from "../scripts/check-project-workbook-contract.mjs";

const manifestPath = new URL("../docs/spec-v3/project-workbook-v1-root-manifest.json", import.meta.url);
const workspaceStatePath = new URL("../lib/types.ts", import.meta.url);

async function fixture() {
  const [manifestSource, workspaceSource] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(workspaceStatePath, "utf8"),
  ]);
  return {
    manifest: JSON.parse(manifestSource),
    roots: parseWorkspaceStateRoots(workspaceSource),
  };
}

function clone(value) {
  return structuredClone(value);
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

test("canonical project workbook contract binds all current WorkspaceState roots", () => {
  const result = checkProjectWorkbookContract();
  assert.equal(result.rootCount, 93);
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
});

test("F0 keeps raw constraints, revision heads and source-derived drafts server-owned", async () => {
  const { manifest, roots } = await fixture();
  assert.deepEqual(
    [
      manifest.classifications.importable_current.length,
      manifest.classifications.preserved_frozen.length,
      manifest.classifications.server_owned.length,
      manifest.classifications.forbidden.length,
      manifest.classifications.export_only_diagnostic.length,
    ],
    [28, 23, 17, 15, 10],
  );
  for (const root of [
    "partConstraintSets",
    "v23SeriesPartHeads",
    "v23SkuDrawerHeads",
    "qualityValuePolicyDrafts",
    "pricingPolicyDrafts",
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
  assert.deepEqual(
    manifest.recordSchemas.v23AffixDefinitions.identityFields,
    ["affixId", "revision"],
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
  for (const [root, fields] of Object.entries(
    manifest.recordSchemaAuthority.projectionExclusions,
  )) {
    assert.ok(fields.every((field) => !manifest.recordSchemas[root].allowedFields.includes(field)));
  }
  const weakened = clone(manifest);
  weakened.recordSchemas.skuDrawers.allowedFields.push("validationSummary");
  assert.throws(() => validateProjectWorkbookManifest(weakened, roots), /allowed-field catalog drift|rederived/);
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
    () => validateMachineCell(keyColumn, '["series:other"]', "string", {
      manifest,
      root: "seriesDefinitions",
      payload: { id: "series:actual" },
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
    () => validateMachineCell(keyColumn, '["series:1"]', "string", {
      manifest,
      root: "seriesDefinitions",
      payload: { revision: 1 },
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

test("record revision is typed RFC8785 scalar JSON and matches payload plus identity", async () => {
  const { manifest } = await fixture();
  const revisionColumn = manifest.workbookSchema.sheets.__TF_CURRENT.columns
    .find((entry) => entry.name === "record_revision");
  const seriesContext = {
    manifest,
    root: "seriesDefinitions",
    payload: { id: "series:1", revision: 1 },
    recordKey: ["series:1"],
  };
  assert.equal(validateMachineCell(revisionColumn, "1", "string", seriesContext), true);
  for (const invalid of ["v1", "01", "null", '"1"']) {
    assert.throws(
      () => validateMachineCell(revisionColumn, invalid, "string", seriesContext),
      /JSON|canonical|safe integer|required/,
    );
  }
  assert.throws(
    () => validateMachineCell(revisionColumn, "2", "string", seriesContext),
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
