import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CLASSIFICATIONS,
  EXPECTED_ROOT_CLASSIFICATIONS,
  checkProjectWorkbookContract,
  compareUnicodeScalarStrings,
  compareWorkbookPrimaryKey,
  computeWorkbookHashes,
  importableIdentityExactFields,
  parseWorkspaceStateRoots,
  preservedTypeGraphHash,
  validateMachineCell,
  validateDiagnosticRootCatalog,
  validateDiagnosticEnvelope,
  validateDiagnosticRows,
  validateImportableExactFields,
  validatePreservedRootCatalog,
  validatePreservedCandidateSet,
  validateProjectWorkbookManifest,
validateRecordEnvelope,
validateTrustedPreservedExactMatch,
  validateRecordSheetCardinality,
  validateRootSummary,
validateServerRefEnvelope,
  validateSourceProvenancePolicyCatalog,
  validateTechnologySuccessorAction,
  validateTechnologyProductionAction,
  validateWorkbookEnvelope,
  validateWorkbookRemovalIntentRoot,
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

function projectAffixDefinition(
  affixId,
  {
    enabled = true,
    itemPartId = "part:rod",
    semanticContributionKey = affixId,
    stackingPolicy = "dedupe",
  } = {},
) {
  const payload = {
    name: affixId,
    category: "attribute",
    itemPartId,
    semanticContributionKey,
    stackingPolicy,
    generationPolicy: "technology_only",
    rarity: "common",
    valueScore: 1,
    tags: [],
    description: "",
    enabled,
    operations: [{
      operationId: `operation:${affixId}`,
      operationIndex: 0,
      sourceAffixId: affixId,
      sourceAffixRevision: 1,
      parameterKey: "pull",
      operation: "flat_adjust",
      direction: "increase",
      magnitude: 1,
      publishedMagnitudeRange: { min: 0, max: 2, ruleSetVersion: "rules:v1" },
    }],
    passivePayload: null,
  };
  return {
    affixId,
    revision: 1,
    contentHash: createHash("sha256")
      .update(canonicalPayload({ affixId, revision: 1, payload }))
      .digest("hex"),
    payload,
  };
}

function trustedAffixState(definitions) {
  const affixDefinitions = clone(definitions).sort((left, right) => {
    const leftIdentity = canonicalPayload([left.affixId, left.revision, left.contentHash]);
    const rightIdentity = canonicalPayload([right.affixId, right.revision, right.contentHash]);
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  });
  return {
    affixDefinitions,
    affixStateSha256: createHash("sha256")
      .update(canonicalPayload(affixDefinitions))
      .digest("hex"),
  };
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

function serverRefRow(manifest, root, workspaceId = "workspace:1", baseRevision = "1") {
  const row = {
    transport_contract_version: manifest.transportRefPolicy.schema,
    workspace_id: workspaceId,
    base_workspace_revision: baseRevision,
    root,
    classification: "server_owned",
    root_content_sha256: "null",
    opaque_server_ref: "",
  };
  const identity = manifest.transportRefPolicy.tokenHashInput
    .map((field) => [field, row[field]]);
  row.opaque_server_ref =
    `opaque_${createHash("sha256").update(canonicalPayload(identity)).digest("hex")}`;
  return row;
}

function workbookContext(manifest, manifestSource) {
  const singletonPayloads = {
    ruleSettings: { patchOffsetLimits: {} },
    affinityAxisWeights: {
      method_type: 1,
      type_weight: 1,
      type_function: 1,
      function_performance: 1,
      material_function: 1,
      quality_specialization: 1,
      model_component: 1,
      series_coherence: 1,
    },
    notes: "",
  };
  const currentRows = Object.entries(manifest.recordSchemas)
    .filter(([, schema]) => (
      schema.identityFields.length === 1 && schema.identityFields[0] === "$singleton"
    ))
    .map(([root, schema]) => {
      assert.ok(Object.hasOwn(singletonPayloads, root), `${root} needs a singleton test payload`);
      const row = {
        root,
        record_schema_id: schema.schemaId,
        record_key: '["$singleton"]',
        record_revision: "null",
        record_content_sha256: "0".repeat(64),
        payload_json: canonicalPayload(singletonPayloads[root]),
      };
      row.record_content_sha256 = expectedRecordHash(manifest, row, "payload_json");
      return row;
    });
  const preservedRows = Object.entries(manifest.preservedRootCatalog)
    .filter(([, catalog]) => catalog.singleton === true)
    .map(([root]) => {
      const catalog = manifest.preservedRootCatalog[root];
      assert.equal(catalog.typeRef, "lib/types.ts#string|null");
      const row = {
        root,
        record_schema_id: manifest.preservedSchemaCatalog[root],
        record_key: '["$singleton"]',
        record_revision: "null",
        record_content_sha256: "0".repeat(64),
        opaque_canonical_payload_json: "null",
      };
      row.record_content_sha256 = expectedRecordHash(
        manifest,
        row,
        "opaque_canonical_payload_json",
      );
      return row;
    });
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
      __TF_CURRENT: currentRows,
      __TF_PRESERVED: preservedRows,
      __TF_SERVER_REFS: manifest.classifications.server_owned.map((root) =>
        serverRefRow(manifest, root)),
      __TF_FORBIDDEN: manifest.classifications.forbidden.map((root) => ({
        root,
        classification: "forbidden",
        policy_marker: "FORBIDDEN_PAYLOAD_OMITTED",
      })),
    },
    trustedPreservedContext: {
      schema: manifest.preservedExactComparePolicy.schema,
      authority: manifest.preservedExactComparePolicy.authority,
      workspace_id: manifestFields.workspace_id,
      base_workspace_revision: manifestFields.base_workspace_revision,
      rows: clone(preservedRows),
    },
  };
}

function trustedPreservedContext(manifest, rows, workspaceId = "workspace:1", revision = "1") {
  return {
    schema: manifest.preservedExactComparePolicy.schema,
    authority: manifest.preservedExactComparePolicy.authority,
    workspace_id: workspaceId,
    base_workspace_revision: revision,
    rows: clone(rows),
  };
}

function workbookEnvelope(manifest, context) {
  const hashes = computeWorkbookHashes(manifest, context);
  return {
    ...context.manifestFields,
    machine_content_sha256: hashes.machineContentSha256,
  };
}

function diagnosticEnvelopeValues(row) {
  return {
    root: row.root,
    record_key: JSON.parse(row.record_key),
    diagnostic_schema_version: row.diagnostic_schema_version,
    subject_payload: JSON.parse(row.subject_payload_json),
    severity: row.severity,
    code: row.code,
    message: row.message,
    subject_ref: row.subject_ref === "null" ? null : row.subject_ref,
    issue_fingerprint: row.issue_fingerprint,
  };
}

function diagnosticHash(manifest, row, inputField) {
  const values = diagnosticEnvelopeValues(row);
  return createHash("sha256").update(canonicalPayload(
    manifest.canonicalization[inputField].map((field) => [field, values[field]]),
  )).digest("hex");
}

function diagnosticFingerprint(manifest, row) {
  return diagnosticHash(manifest, row, "diagnosticIssueFingerprintInput");
}

function diagnosticEvidence(manifest, row) {
  return diagnosticHash(manifest, row, "diagnosticEvidenceHashInput");
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
  return {
    rows,
    rootRecordContext,
    trustedPreservedContext: trustedPreservedContext(manifest, []),
  };
}

test("canonical project workbook contract binds all current WorkspaceState roots", () => {
  const result = checkProjectWorkbookContract();
  assert.equal(result.rootCount, 93);
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
});

test("canonicalization fixed values reject every display or machine mutation", async () => {
  const { manifest, roots } = await fixture();
  for (const [field, mutation] of Object.entries({
    textEncoding: "UTF-16",
    unicodeNormalization: "NFD",
    lineEndings: "CRLF",
    finiteNumbersOnly: false,
    negativeZero: "PRESERVE",
    blankAndNullDistinct: false,
    rowOrder: "CALLER_ORDER",
  })) {
    const changed = clone(manifest);
    changed.canonicalization[field] = mutation;
    assert.throws(
      () => validateProjectWorkbookManifest(changed, roots),
      new RegExp(`canonicalization\\.${field}`),
      `${field} must be exact and cannot be changed by display prose`,
    );
  }
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
    [15, 23, 30, 15, 10],
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
    "affixScorePolicy",
  ]) {
    assert.ok(manifest.classifications.server_owned.includes(root), root);
    assert.equal(Object.hasOwn(manifest.recordSchemas, root), false, root);
    assert.equal(Object.hasOwn(manifest.preservedRootCatalog, root), false, root);
    assert.equal(Object.hasOwn(manifest.preservedSchemaCatalog, root), false, root);
  }

  assert.deepEqual(
    Object.keys(manifest.importableSuccessorCatalog),
    manifest.classifications.importable_current,
  );
  for (const root of manifest.classifications.importable_current) {
    const successor = manifest.importableSuccessorCatalog[root];
    assert.ok(successor, `${root} requires a proven production successor`);
    if (root === "skuDrawers" || root === "v23TechnologyDefinitions") {
      assert.match(successor.semanticMutationAuthority, /^DOMAIN_ACTION_/);
    } else {
      assert.equal(successor.transportBoundary, "PUT /api/state");
      assert.notEqual(
        successor.semanticMutationAuthority,
        "DEFAULT_ALLOW_REVISION_GUARDED",
      );
    }
    assert.equal(successor.specBasis, "§14.3.7");
  }
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "affixScorePolicy",
      { sameAxisFactors: [], synergyBonus: 0, conflictPenalty: 0 },
      { sameAxisFactors: [], synergyBonus: 0, conflictPenalty: 0 },
    ),
    /not an importable record root/,
  );

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
  for (const root of [
    "compatibilityRules",
    "affinityRules",
    "purchasableModels",
    "v3Affixes",
    "technologies",
    "qualityBands",
    "ruleGraphs",
  ]) {
    assert.ok(manifest.classifications.server_owned.includes(root), root);
    assert.equal(Object.hasOwn(manifest.recordSchemas, root), false, root);
  }
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

test("v23 technology uses create/update successor actions and never rewrites one revision", async () => {
  const { manifest } = await fixture();
  assert.deepEqual(
    manifest.recordSchemas.v23TechnologyDefinitions.exactFields,
    manifest.recordSchemas.v23TechnologyDefinitions.allowedFields,
  );
  const member = projectAffixDefinition("affix:member");
  const affixState = trustedAffixState([member]);
  const memberRef = {
    id: member.affixId,
    revision: member.revision,
    contentHash: member.contentHash,
  };
  const technologyWithoutHash = {
    technologyId: "technology:1",
    revision: 1,
    itemPartId: "part:rod",
    name: "力量技术",
    description: "",
    memberAffixRefs: [memberRef],
    enabled: true,
  };
  const technology = {
    ...technologyWithoutHash,
    contentHash: createHash("sha256").update(canonicalPayload(technologyWithoutHash)).digest("hex"),
  };
  const request = {
    schema: "project-workbook-technology-successor-request/v1",
    workspaceId: "workspace:1",
    baseWorkspaceRevision: 7,
    expectedCurrentHead: null,
    expectedAffixStateSha256: affixState.affixStateSha256,
  };
  const trustedCreate = {
    schema: "project-workbook-technology-successor-context/v1",
    workspaceId: "workspace:1",
    baseWorkspaceRevision: 7,
    technologyId: "technology:1",
    targetRevision: 1,
    technologyIdExists: false,
    targetRevisionExists: false,
    currentHead: null,
    affixStateSha256: affixState.affixStateSha256,
    affixDefinitions: affixState.affixDefinitions,
  };
  const createProductionInput = {
    expectedWorkspaceRevision: 7,
    technologyId: "technology:1",
    itemPartId: "part:rod",
    name: "力量技术",
    description: "",
    memberAffixRefs: [memberRef],
    enabled: true,
  };
  const createAction = validateTechnologySuccessorAction(
    manifest,
    technology,
    request,
    trustedCreate,
  );
  assert.deepEqual(
    createAction,
    {
      schema: "project-workbook-technology-successor-action/v1",
      actionCode: "create_technology",
      actionPayload: {
        expectedWorkspaceRevision: 7,
        inputHash: createHash("sha256")
          .update(canonicalPayload(createProductionInput))
          .digest("hex"),
        technologyId: "technology:1",
        itemPartId: "part:rod",
        name: "力量技术",
        description: "",
        memberAffixRefs: [memberRef],
        enabled: true,
      },
    },
    "F2 emits the complete production create payload and never forwards derived fields",
  );
  assert.equal(
    validateTechnologyProductionAction(
      manifest,
      createAction,
      technology,
      request,
      trustedCreate,
    ),
    true,
  );
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "v23TechnologyDefinitions",
      technology,
      undefined,
    ),
    /requires validateTechnologySuccessorAction trusted context/,
    "the generic create branch cannot infer stable-ID absence from a missing composite record",
  );
  assert.throws(
    () => validateTechnologySuccessorAction(
      manifest,
      { ...technology, revision: 2 },
      request,
      { ...trustedCreate, targetRevision: 2 },
    ),
    /requires revision 1/,
  );
  assert.throws(
    () => validateTechnologySuccessorAction(
      manifest,
      { ...technology, contentHash: "a".repeat(64) },
      request,
      trustedCreate,
    ),
    /does not match V23_TECHNOLOGY_CONTENT_HASH/,
  );
  for (const [contextMutation, message] of [
    [{ technologyIdExists: true }, /requires trusted Technology ID absence/],
    [{ targetRevisionExists: true }, /target revision must not already exist/],
    [{ workspaceId: "workspace:2" }, /workspace must match trusted context/],
    [{ baseWorkspaceRevision: 8 }, /base revision must match trusted context/],
  ]) {
    assert.throws(
      () => validateTechnologySuccessorAction(
        manifest,
        technology,
        request,
        { ...trustedCreate, ...contextMutation },
      ),
      message,
    );
  }
  const technologyWithMembers = (memberAffixRefs, overrides = {}) => {
    const withoutHash = { ...technologyWithoutHash, memberAffixRefs, ...overrides };
    return {
      ...withoutHash,
      contentHash: createHash("sha256").update(canonicalPayload(withoutHash)).digest("hex"),
    };
  };
  assert.throws(
    () => validateTechnologySuccessorAction(
      manifest,
      technologyWithMembers([]),
      request,
      trustedCreate,
    ),
    /requires at least one member affix/,
  );
  assert.throws(
    () => validateTechnologySuccessorAction(
      manifest,
      technologyWithMembers([memberRef, memberRef]),
      request,
      trustedCreate,
    ),
    /stable IDs must be unique/,
  );
  const unresolvedRef = { id: "affix:missing", revision: 1, contentHash: "f".repeat(64) };
  assert.throws(
    () => validateTechnologySuccessorAction(
      manifest,
      technologyWithMembers([unresolvedRef]),
      request,
      trustedCreate,
    ),
    /unresolved or ambiguous/,
  );
  for (const [invalidMember, message] of [
    [projectAffixDefinition("affix:disabled", { enabled: false }), /must be enabled/],
    [projectAffixDefinition("affix:cross-part", { itemPartId: "part:reel" }), /same itemPartId/],
  ]) {
    const invalidState = trustedAffixState([invalidMember]);
    const invalidRef = {
      id: invalidMember.affixId,
      revision: invalidMember.revision,
      contentHash: invalidMember.contentHash,
    };
    assert.throws(
      () => validateTechnologySuccessorAction(
        manifest,
        technologyWithMembers([invalidRef]),
        { ...request, expectedAffixStateSha256: invalidState.affixStateSha256 },
        {
          ...trustedCreate,
          affixStateSha256: invalidState.affixStateSha256,
          affixDefinitions: invalidState.affixDefinitions,
        },
      ),
      message,
    );
  }
  const conflictFirst = projectAffixDefinition(
    "affix:conflict-a",
    { semanticContributionKey: "semantic:same" },
  );
  const conflictSecond = projectAffixDefinition(
    "affix:conflict-b",
    { semanticContributionKey: "semantic:same" },
  );
  const conflictState = trustedAffixState([conflictFirst, conflictSecond]);
  const conflictRefs = conflictState.affixDefinitions.map((definition) => ({
    id: definition.affixId,
    revision: definition.revision,
    contentHash: definition.contentHash,
  }));
  assert.throws(
    () => validateTechnologySuccessorAction(
      manifest,
      technologyWithMembers(conflictRefs),
      { ...request, expectedAffixStateSha256: conflictState.affixStateSha256 },
      {
        ...trustedCreate,
        affixStateSha256: conflictState.affixStateSha256,
        affixDefinitions: conflictState.affixDefinitions,
      },
    ),
    /semantic contribution conflict/,
  );
  const extraMember = projectAffixDefinition("affix:later");
  const changedAffixState = trustedAffixState([member, extraMember]);
  assert.throws(
    () => validateTechnologySuccessorAction(
      manifest,
      technology,
      request,
      {
        ...trustedCreate,
        affixStateSha256: changedAffixState.affixStateSha256,
        affixDefinitions: changedAffixState.affixDefinitions,
      },
    ),
    /affix state is stale/,
  );
  const tamperedTrustedState = clone(trustedCreate);
  tamperedTrustedState.affixDefinitions[0].payload.name = "tampered";
  assert.throws(
    () => validateTechnologySuccessorAction(
      manifest,
      technology,
      request,
      tamperedTrustedState,
    ),
    /trusted affix state does not match/,
  );
  assert.throws(
    () => validateTechnologySuccessorAction(
      manifest,
      technology,
      request,
      { ...trustedCreate, unknownAffixState: true },
    ),
    /trusted context must use the closed schema/,
  );

  const currentHead = {
    technologyId: technology.technologyId,
    revision: technology.revision,
    contentHash: technology.contentHash,
    itemPartId: technology.itemPartId,
  };
  const updateWithoutHash = {
    ...technologyWithoutHash,
    revision: 2,
    name: "力量技术（修订）",
  };
  const update = {
    ...updateWithoutHash,
    contentHash: createHash("sha256").update(canonicalPayload(updateWithoutHash)).digest("hex"),
  };
  const updateRequest = { ...request, expectedCurrentHead: currentHead };
  const trustedUpdate = {
    ...trustedCreate,
    targetRevision: 2,
    technologyIdExists: true,
    currentHead,
  };
  const updateProductionInput = {
    expectedWorkspaceRevision: 7,
    technologyId: "technology:1",
    expectedTechnologyRevision: 1,
    itemPartId: "part:rod",
    name: "力量技术（修订）",
    description: "",
    memberAffixRefs: [memberRef],
    enabled: true,
  };
  const updateAction = validateTechnologySuccessorAction(
    manifest,
    update,
    updateRequest,
    trustedUpdate,
  );
  assert.deepEqual(
    updateAction,
    {
      schema: "project-workbook-technology-successor-action/v1",
      actionCode: "update_technology",
      actionPayload: {
        expectedWorkspaceRevision: 7,
        inputHash: createHash("sha256")
          .update(canonicalPayload(updateProductionInput))
          .digest("hex"),
        technologyId: "technology:1",
        expectedTechnologyRevision: 1,
        itemPartId: "part:rod",
        name: "力量技术（修订）",
        description: "",
        memberAffixRefs: [memberRef],
        enabled: true,
      },
    },
    "F2 emits executable revision/hash guards but not candidate revision/contentHash",
  );
  assert.equal(
    validateTechnologyProductionAction(
      manifest,
      updateAction,
      update,
      updateRequest,
      trustedUpdate,
    ),
    true,
  );
  for (const [baseline, candidate, requestValue, context] of [
    [createAction, technology, request, trustedCreate],
    [updateAction, update, updateRequest, trustedUpdate],
  ]) {
    const missingRevision = clone(baseline);
    delete missingRevision.actionPayload.expectedWorkspaceRevision;
    assert.throws(
      () => validateTechnologyProductionAction(
        manifest,
        missingRevision,
        candidate,
        requestValue,
        context,
      ),
      /production payload/,
    );
    const forgedRevision = clone(baseline);
    forgedRevision.actionPayload.expectedWorkspaceRevision += 1;
    const withoutRevisionHash = clone(forgedRevision.actionPayload);
    delete withoutRevisionHash.inputHash;
    forgedRevision.actionPayload.inputHash = createHash("sha256")
      .update(canonicalPayload(withoutRevisionHash))
      .digest("hex");
    assert.throws(
      () => validateTechnologyProductionAction(
        manifest,
        forgedRevision,
        candidate,
        requestValue,
        context,
      ),
      /must bind request base/,
    );
    const missingHash = clone(baseline);
    delete missingHash.actionPayload.inputHash;
    assert.throws(
      () => validateTechnologyProductionAction(
        manifest,
        missingHash,
        candidate,
        requestValue,
        context,
      ),
      /production payload/,
    );
    const forgedHash = clone(baseline);
    forgedHash.actionPayload.inputHash = "f".repeat(64);
    assert.throws(
      () => validateTechnologyProductionAction(
        manifest,
        forgedHash,
        candidate,
        requestValue,
        context,
      ),
      /inputHash does not match/,
    );
    const changedPayload = clone(baseline);
    changedPayload.actionPayload.name = "篡改";
    const changedHashInput = clone(changedPayload.actionPayload);
    delete changedHashInput.inputHash;
    changedPayload.actionPayload.inputHash = createHash("sha256")
      .update(canonicalPayload(changedHashInput))
      .digest("hex");
    assert.throws(
      () => validateTechnologyProductionAction(
        manifest,
        changedPayload,
        candidate,
        requestValue,
        context,
      ),
      /does not match the trusted candidate projection/,
    );
  }
  for (const [candidate, requestValue, context, message] of [
    [
      { ...update, revision: 3 },
      updateRequest,
      { ...trustedUpdate, targetRevision: 3 },
      /current head plus one/,
    ],
    [{ ...update, contentHash: "a".repeat(64) }, updateRequest, trustedUpdate, /does not match/],
    [{ ...update, itemPartId: "part:reel" }, updateRequest, trustedUpdate, /cannot change itemPartId/],
    [
      { ...update, technologyId: "technology:2" },
      updateRequest,
      { ...trustedUpdate, technologyId: "technology:2" },
      /cannot change technologyId/,
    ],
    [update, updateRequest, { ...trustedUpdate, targetRevisionExists: true }, /target revision must not already exist/],
    [update, { ...updateRequest, expectedCurrentHead: { ...currentHead, revision: 2 } }, trustedUpdate, /expected head is stale/],
    [update, updateRequest, { ...trustedUpdate, technologyIdExists: false }, /requires an existing trusted Technology ID/],
    [update, updateRequest, { ...trustedUpdate, currentHead: null }, /expected head is stale/],
    [update, updateRequest, { ...trustedUpdate, technologyId: "technology:other" }, /must bind candidate technologyId/],
    [update, updateRequest, { ...trustedUpdate, targetRevision: 3 }, /must bind candidate revision/],
  ]) {
    assert.throws(
      () => validateTechnologySuccessorAction(
        manifest,
        candidate,
        requestValue,
        context,
      ),
      message,
    );
  }

  assert.equal(
    validateImportableExactFields(
      manifest,
      "v23TechnologyDefinitions",
      technology,
      technology,
    ),
    true,
    "an existing immutable revision remains a generic no-op",
  );
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "v23TechnologyDefinitions",
      { ...technology, name: "forbidden rewrite" },
      technology,
    ),
    /is exact-equal for an existing record/,
  );

  const compositeIdentityRoots = Object.entries(manifest.recordSchemas)
    .filter(([, schema]) => schema.identityFields.length > 1)
    .map(([root]) => root);
  assert.deepEqual(
    compositeIdentityRoots,
    ["v23TechnologyDefinitions"],
    "Technology is the only importable composite-identity successor",
  );
  assert.equal(
    manifest.importableCreatePolicies.skuDrawers.policy,
    "REJECT",
    "the other server-derived revision/hash root cannot create a successor through the workbook",
  );
  assert.throws(
    () => validateTechnologySuccessorAction(
      manifest,
      update,
      updateRequest,
      { ...trustedUpdate, currentHead: { ...currentHead, contentHash: "b".repeat(64) } },
    ),
    /expected head is stale/,
    "a changed current-head hash invalidates the successor request",
  );
  assert.throws(
    () => validateTechnologySuccessorAction(
      manifest,
      update,
      { ...updateRequest, unexpected: true },
      trustedUpdate,
    ),
    /closed schema/,
    "display or caller fields cannot bypass the closed successor request",
  );
});

test("every importable existing record exact-compares its complete schema identity", async () => {
  const { manifest } = await fixture();
  for (const [root, schema] of Object.entries(manifest.recordSchemas)) {
    const expected = schema.identityFields[0] === "$singleton" ? [] : schema.identityFields;
    assert.deepEqual(
      importableIdentityExactFields(schema),
      expected,
      `${root} must derive existing exact fields from every identity path`,
    );
  }
  assert.deepEqual(
    importableIdentityExactFields({ identityFields: ["owner.id", "revision"] }),
    ["owner.id", "revision"],
    "future nested and composite identity paths remain exact without root-specific logic",
  );
  assert.deepEqual(
    importableIdentityExactFields(manifest.recordSchemas.ruleSettings),
    [],
    "$singleton is a row identity sentinel, not a payload path",
  );
  assert.throws(
    () => importableIdentityExactFields({ identityFields: ["$singleton", "id"] }),
    /\$singleton cannot be combined/,
  );
  assert.equal(
    validateImportableExactFields(
      manifest,
      "ruleSettings",
      { patchOffsetLimits: {}, reductionStackingPolicyVersion: "policy:2" },
      { patchOffsetLimits: {}, reductionStackingPolicyVersion: "policy:1" },
    ),
    true,
    "singleton pseudo identity must not trigger a missing payload field comparison",
  );

  const itemPart = {
    id: "part:rod",
    name: "竿",
    activeInGeneration: true,
    parameterKeys: [],
    notes: "",
  };
  assert.deepEqual(manifest.recordSchemas.itemParts.exactFields, []);
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "itemParts",
      { ...itemPart, id: "part:reel" },
      itemPart,
    ),
    /id is exact-equal/,
    "an existing itemPart cannot escape matching by changing its id",
  );
  const missingId = clone(itemPart);
  delete missingId.id;
  assert.throws(
    () => validateImportableExactFields(manifest, "itemParts", missingId, itemPart),
    /itemParts payload\.id is required/,
  );
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "itemParts",
      { ...itemPart, id: 1 },
      itemPart,
    ),
    /itemParts payload\.id must be NFC text/,
  );

  const technology = {
    technologyId: "technology:1",
    revision: 1,
    itemPartId: "part:rod",
    name: "技术",
    description: "",
    memberAffixRefs: [],
    enabled: true,
    contentHash: "a".repeat(64),
  };
  for (const mutation of [
    { technologyId: "technology:2" },
    { revision: 2 },
  ]) {
    assert.throws(
      () => validateImportableExactFields(
        manifest,
        "v23TechnologyDefinitions",
        { ...technology, ...mutation },
        technology,
      ),
      /is exact-equal for an existing record/,
    );
  }
});

test("parameter key is exact for existing records while new keys remain declarative", async () => {
  const { manifest } = await fixture();
  const parameter = {
    id: "parameter:power",
    key: "power",
    label: "力量",
    itemKind: "rod",
    unit: "kg",
    precision: 1,
    notes: "",
  };
  assert.deepEqual(manifest.recordSchemas.parameters.exactFields, ["id", "key"]);
  assert.equal(
    validateImportableExactFields(manifest, "parameters", parameter, undefined),
    true,
    "a new parameter may declare its initial key",
  );
  assert.equal(
    validateImportableExactFields(
      manifest,
      "parameters",
      { ...parameter, label: "力量（显示）" },
      parameter,
    ),
    true,
  );
  const crossRootReferences = {
    templateValues: { power: 1 },
    modifierRule: { parameterKey: "power", operation: "add", value: 1 },
  };
  const before = clone(crossRootReferences);
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "parameters",
      { ...parameter, key: "strength" },
      parameter,
    ),
    /key is exact-equal/,
    "parameter rename requires a future dedicated cross-root migration",
  );
  assert.deepEqual(
    crossRootReferences,
    before,
    "a rejected workbook rename cannot rewrite template or rule references",
  );
});

test("source-derived profiles freeze fully while templates retain authorized layered edits", async () => {
  const { manifest } = await fixture();
  assert.equal(validateSourceProvenancePolicyCatalog(manifest), true);
  const rule = {
    id: "rule:1",
    parameterKey: "power",
    operation: "add",
    value: 1,
  };
  const method = {
    id: "method:float",
    name: "浮钓",
    rules: [rule],
    enabled: true,
    sourceRevisionId: "source:1",
    notes: "",
  };
  const methodMutations = {
    id: "method:other",
    name: "其他",
    rules: [{ ...rule, value: 2 }],
    enabled: false,
    sourceRevisionId: "source:2",
    notes: "changed",
  };
  assert.equal(
    validateImportableExactFields(manifest, "methodProfiles", method, method),
    true,
  );
  for (const [field, value] of Object.entries(methodMutations)) {
    assert.throws(
      () => validateImportableExactFields(
        manifest,
        "methodProfiles",
        { ...method, [field]: value },
        method,
      ),
      /is exact-equal/,
      `source-derived methodProfiles.${field} must be fully exact`,
    );
  }

  const itemType = {
    id: "type:spinning",
    name: "纺车",
    methodIds: ["method:float"],
    itemPartIds: ["part:rod"],
    rules: [rule],
    enabled: true,
    sourceRevisionId: "source:1",
    notes: "",
  };
  const itemTypeMutations = {
    id: "type:other",
    name: "其他",
    methodIds: ["method:other"],
    itemPartIds: ["part:reel"],
    rules: [{ ...rule, value: 2 }],
    enabled: false,
    sourceRevisionId: "source:2",
    notes: "changed",
  };
  assert.equal(
    validateImportableExactFields(manifest, "itemTypeProfiles", itemType, itemType),
    true,
  );
  for (const [field, value] of Object.entries(itemTypeMutations)) {
    assert.throws(
      () => validateImportableExactFields(
        manifest,
        "itemTypeProfiles",
        { ...itemType, [field]: value },
        itemType,
      ),
      /is exact-equal/,
      `source-derived itemTypeProfiles.${field} must be fully exact`,
    );
  }

  const localMethod = { ...method };
  delete localMethod.sourceRevisionId;
  assert.equal(
    validateImportableExactFields(
      manifest,
      "methodProfiles",
      { ...localMethod, rules: [{ ...rule, value: 3 }] },
      localMethod,
    ),
    true,
    "a schema-declared local profile remains normally editable",
  );
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "methodProfiles",
      method,
      undefined,
    ),
    /cannot fabricate trusted source provenance/,
  );
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "methodProfiles",
      { ...method, sourceRevisionId: "" },
      method,
    ),
    /must be non-empty/,
  );

  const template = {
    id: "template:1",
    name: "模板",
    fishMinKg: 1,
    fishMaxKg: 2,
    nominalFishKg: 1.5,
    tier: "A",
    values: { power: 1 },
    notes: "",
    sourceRevisionId: "source:1",
    sourceSheetId: "sheet:1",
    sourceRow: 2,
  };
  assert.equal(
    validateImportableExactFields(
      manifest,
      "templates",
      { ...template, name: "模板 Patch", values: { power: 2 } },
      template,
    ),
    true,
    "§14.3.7 template values remain editable through the declared patch layer",
  );
  for (const [field, value] of [
    ["sourceRevisionId", "source:2"],
    ["sourceSheetId", "sheet:2"],
    ["sourceRow", 3],
  ]) {
    assert.throws(
      () => validateImportableExactFields(
        manifest,
        "templates",
        { ...template, [field]: value },
        template,
      ),
      /is exact-equal/,
      `templates.${field} remains exact`,
    );
  }
  const missingSheet = { ...template };
  delete missingSheet.sourceSheetId;
  const missingRow = { ...template };
  delete missingRow.sourceRow;
  for (const partial of [missingSheet, missingRow, { ...template, sourceRow: 0 }]) {
    assert.throws(
      () => validateImportableExactFields(manifest, "templates", partial, template),
      /all-present or all-absent|positive safe integer/,
    );
  }
  const localTemplate = { ...template };
  delete localTemplate.sourceRevisionId;
  delete localTemplate.sourceSheetId;
  delete localTemplate.sourceRow;
  assert.equal(
    validateImportableExactFields(
      manifest,
      "templates",
      { ...localTemplate, values: { power: 4 } },
      localTemplate,
    ),
    true,
  );
  assert.throws(
    () => validateImportableExactFields(manifest, "templates", template, undefined),
    /cannot fabricate trusted source provenance/,
  );
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "templates",
      { ...localTemplate, provenanceToken: "forged" },
      localTemplate,
    ),
    /outside allowedFields/,
  );

  const sourcedRule = {
    ...rule,
    sourceRevisionId: "source:1",
    sourceSheetId: "sheet:1",
    sourceCell: "C2",
  };
  const layeredRoots = {
    modifiers: {
      id: "modifier:1",
      dimension: "structure",
      name: "结构",
      level: 1,
      itemKinds: ["rod"],
      rules: [sourcedRule],
      notes: "",
      enabled: true,
    },
    layers: {
      id: "layer:1",
      name: "规则层",
      order: 1,
      enabled: true,
      mode: "global",
      optionIds: [],
      rules: [sourcedRule],
      notes: "",
    },
    affixes: {
      id: "affix:1",
      name: "词条",
      category: "stat",
      itemKinds: ["rod"],
      score: 1,
      rarity: "common",
      tags: [],
      conflicts: [],
      synergies: [],
      rules: [sourcedRule],
      description: "",
      notes: "",
      enabled: true,
    },
  };
  for (const [root, existing] of Object.entries(layeredRoots)) {
    const edited = clone(existing);
    edited.rules[0].value = 2;
    assert.equal(
      validateImportableExactFields(manifest, root, edited, existing),
      true,
      `${root} retains its §14.3.7 editor while preserving rule provenance`,
    );
    const changedSource = clone(edited);
    changedSource.rules[0].sourceCell = "D2";
    assert.throws(
      () => validateImportableExactFields(manifest, root, changedSource, existing),
      /sourceCell is exact-equal/,
    );
    const partialRule = clone(edited);
    delete partialRule.rules[0].sourceSheetId;
    assert.throws(
      () => validateImportableExactFields(manifest, root, partialRule, existing),
      /all-present or all-absent/,
    );
    const removedRule = clone(existing);
    removedRule.rules = [];
    assert.throws(
      () => validateImportableExactFields(manifest, root, removedRule, existing),
      /cannot remove a source-derived rule/,
    );
    assert.throws(
      () => validateImportableExactFields(manifest, root, existing, undefined),
      /cannot fabricate trusted rule source provenance/,
    );
  }

  const futureSelector = clone(manifest);
  futureSelector.recordSchemas.notes.allowedFields.push("sourceArtifactId");
  assert.throws(
    () => validateSourceProvenancePolicyCatalog(futureSelector),
    /needs an explicit semantic policy/,
  );
});

test("server-owned rule, quality, legacy version and model roots reject workbook add update and removal", async () => {
  const { manifest } = await fixture();
  assert.deepEqual(
    Object.keys(manifest.conditionalExactFieldPolicies),
    ["methodProfiles", "itemTypeProfiles", "templates", "modifiers", "layers", "affixes"],
  );
  const serverOwned = [
    "compatibilityRules",
    "affinityRules",
    "purchasableModels",
    "v3Affixes",
    "technologies",
    "qualityBands",
    "ruleGraphs",
  ];
  for (const root of serverOwned) {
    assert.ok(manifest.classifications.server_owned.includes(root), root);
    assert.deepEqual(manifest.serverOwnedRootCatalog[root], {
      hashPolicy: "NO_CONTENT_HASH",
      refPolicy: "DETERMINISTIC_IDENTITY_BOUND_NON_SENSITIVE",
    });
    assert.throws(
      () => validateImportableExactFields(manifest, root, {}, undefined),
      /is not an importable record root/,
      `${root} workbook create is rejected`,
    );
    assert.throws(
      () => validateImportableExactFields(manifest, root, {}, {}),
      /is not an importable record root/,
      `${root} workbook update is rejected`,
    );
    assert.throws(
      () => validateWorkbookRemovalIntentRoot(manifest, root),
      /cannot express workbook removal intent/,
      `${root} workbook deletion is rejected`,
    );
  }
  for (const forgedQuality of [
    { id: "yellow", name: "黄", color: "#ffff00", minScore: 100, maxScore: null, priceIndex: 9 },
    { id: "green", name: "绿", color: "#000000", minScore: 0, maxScore: 7.99, priceIndex: 1 },
    { id: "green", name: "绿", color: "#43b581", minScore: 1, maxScore: 7.99, priceIndex: 1 },
    { id: "green", name: "绿", color: "#43b581", minScore: 0, maxScore: 7.99, priceIndex: 2 },
  ]) {
    assert.throws(
      () => validateImportableExactFields(manifest, "qualityBands", forgedQuality, undefined),
      /is not an importable record root/,
    );
  }
  const engineSource = await readFile(new URL("../lib/engine.ts", import.meta.url), "utf8");
  assert.match(engineSource, /export function scoreAffixes\(/);
  assert.match(engineSource, /finalScore >= band\.minScore/);
  assert.match(engineSource, /band\.maxScore === null \|\| finalScore <= band\.maxScore/);
  assert.match(
    engineSource,
    /qualityId: quality\?\.id \?\? "green"/,
    "server-owning qualityBands must not alter the existing engine selection path",
  );
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
    defaultModelId: "model:1",
    displayOrder: 1,
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.deepEqual(manifest.importableCreatePolicies.skuDrawers, {
    policy: "REJECT",
    requiredActionCode: "create_sku",
  });
  assert.throws(
    () => validateImportableExactFields(manifest, "skuDrawers", sku, undefined),
    /use create_sku/,
    "new SKU drawers must use the v23 create_sku command path",
  );
  assert.equal(
    validateImportableExactFields(
      manifest,
      "skuDrawers",
      { ...sku, targetPullKg: 6 },
      sku,
    ),
    true,
    "an existing SKU drawer may revise only targetPullKg",
  );
  const exactMutations = {
    id: "sku:2",
    revision: 4,
    seriesId: "series:2",
    patchIds: ["patch:1"],
    modelIds: ["model:2"],
    defaultModelId: "model:2",
    displayOrder: 2,
    status: "approved",
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
  };
  assert.deepEqual(
    manifest.recordSchemas.skuDrawers.exactFields,
    Object.keys(exactMutations),
  );
  for (const [field, value] of Object.entries(exactMutations)) {
    assert.throws(
      () => validateImportableExactFields(
        manifest,
        "skuDrawers",
        { ...sku, [field]: value },
        sku,
      ),
      new RegExp(`${field} is exact-equal`),
      `${field} must remain exact for an existing SKU drawer`,
    );
  }
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "skuDrawers",
      { ...sku, revision: 4 },
      sku,
    ),
    /revision is exact-equal/,
  );
  assert.ok(manifest.classifications.preserved_frozen.includes("v23SkuDrawerRevisions"));
  assert.ok(manifest.classifications.server_owned.includes("v23SkuDrawerHeads"));
  assert.equal(Object.hasOwn(manifest.recordSchemas, "v23SkuDrawerRevisions"), false);
  assert.equal(Object.hasOwn(manifest.recordSchemas, "v23SkuDrawerHeads"), false);
});

test("terminal lifecycle policy freezes every applicable existing payload without root exceptions", async () => {
  const { manifest } = await fixture();
  assert.deepEqual(manifest.terminalLifecyclePolicy.applicableRoots, [
    "skuDrawers",
    "seriesShowcases",
  ]);
  const discovered = Object.entries(manifest.recordSchemas)
    .filter(([, schema]) => manifest.terminalLifecyclePolicy.selectors.some(
      (selector) => schema.allowedFields.includes(selector.field),
    ))
    .map(([root]) => root);
  assert.deepEqual(discovered, manifest.terminalLifecyclePolicy.applicableRoots);

  const functionProfile = {
    id: "function:1",
    name: "远投",
    status: "draft",
    supportedIntensities: [1],
    rules: [],
    intensityRules: [],
    enabled: true,
    sourceRevisionId: "source:1",
    notes: "",
  };
  assert.ok(manifest.classifications.server_owned.includes("functionProfiles"));
  assert.equal(Object.hasOwn(manifest.recordSchemas, "functionProfiles"), false);
  assert.equal(Object.hasOwn(manifest.recordSchemaAuthority.typeRefs, "functionProfiles"), false);
  for (const [candidate, existing] of [
    [functionProfile, undefined],
    [{ ...functionProfile, name: "伪造覆盖" }, functionProfile],
    [undefined, functionProfile],
    [{ ...functionProfile, status: "ACTIVE" }, { ...functionProfile, status: "ACTIVE" }],
  ]) {
    assert.throws(
      () => validateImportableExactFields(manifest, "functionProfiles", candidate, existing),
      /not an importable record root/,
      "server-owned function profiles reject create, update, removal, and legacy lifecycle aliases",
    );
  }

  const terminalSku = {
    id: "sku:terminal",
    revision: 1,
    seriesId: "series:1",
    targetPullKg: 5,
    patchIds: [],
    modelIds: [],
    displayOrder: 1,
    status: "approved",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "skuDrawers",
      { ...terminalSku, targetPullKg: 6 },
      terminalSku,
    ),
    /targetPullKg is exact-equal/,
  );

  const showcase = {
    id: "showcase:1",
    seriesId: "series:1",
    description: "已发布",
    templateIds: [],
    structureIds: [],
    fishingMethod: "路亚",
    functionId: "function:1",
    qualityId: "quality_c_green",
    fishMinKg: 0,
    fishMaxKg: 1,
    tensionMinKgf: 0,
    tensionMaxKgf: 1,
    affixIds: [],
    notes: "",
    publishedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.throws(
    () => validateImportableExactFields(
      manifest,
      "seriesShowcases",
      { ...showcase, description: "伪造覆盖" },
      showcase,
    ),
    /description is exact-equal/,
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

  assert.ok(manifest.classifications.server_owned.includes("technologies"));
  assert.equal(Object.hasOwn(manifest.recordSchemas, "technologies"), false);
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
    /transport identity/,
  );
  const omittedSheet = clone(context);
  delete omittedSheet.machineSheets.__TF_SERVER_REFS;
  assert.throws(
    () => validateWorkbookEnvelope(manifest, row, omittedSheet),
    /semantic and transport sets exactly/,
  );
  const includeMutation = clone(manifest);
  includeMutation.canonicalization.machineContentHashInput.push("__TF_DIAGNOSTICS");
  assert.throws(
    () => validateWorkbookEnvelope(
      includeMutation,
      row,
      { ...context, rootManifestSource: JSON.stringify(includeMutation) },
    ),
    /semantic and transport sets exactly|not a declared machine-content sheet/,
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

test("all workbook primary keys use Unicode scalar lexicographic order", async () => {
  const { manifest, manifestSource } = await fixture();
  const privateUse = "\uE000";
  const supplementary = "\u{10000}";
  assert.equal(compareUnicodeScalarStrings(privateUse, supplementary), -1);
  assert.equal(compareUnicodeScalarStrings(supplementary, privateUse), 1);
  assert.equal(compareUnicodeScalarStrings("前缀", "前缀甲"), -1);
  assert.equal(compareUnicodeScalarStrings("甲乙", "甲申"), -1);
  assert.equal(compareUnicodeScalarStrings("é", "ê"), -1);
  assert.equal(compareUnicodeScalarStrings("é", "e\u0301"), 1,
    "the comparator is scalar-based; machine-cell validation separately enforces NFC");

  const nonRootPrimaryKeyFields = [...new Set(
    Object.values(manifest.workbookSchema.sheets)
      .flatMap((sheet) => sheet.primaryKey)
      .filter((field) => field !== "root"),
  )];
  for (const field of nonRootPrimaryKeyFields) {
    assert.equal(
      compareWorkbookPrimaryKey(
        manifest,
        { [field]: `shared${privateUse}` },
        { [field]: `shared${supplementary}` },
        [field],
      ),
      -1,
      `${field} must use Unicode scalar order`,
    );
  }
  assert.equal(
    compareWorkbookPrimaryKey(
      manifest,
      { root: "ruleSettings" },
      { root: "itemParts" },
      ["root"],
    ),
    -1,
    "root ordering remains the manifest order rather than Unicode order",
  );

  const context = workbookContext(manifest, manifestSource);
  const itemPartRow = (id) => {
    const payload = {
      id,
      name: id,
      activeInGeneration: true,
      parameterKeys: [],
      notes: "",
    };
    const row = {
      root: "itemParts",
      record_schema_id: manifest.recordSchemas.itemParts.schemaId,
      record_key: canonicalPayload([id]),
      record_revision: "null",
      record_content_sha256: "0".repeat(64),
      payload_json: canonicalPayload(payload),
    };
    row.record_content_sha256 = expectedRecordHash(manifest, row, "payload_json");
    return row;
  };
  context.machineSheets.__TF_CURRENT.splice(
    1,
    0,
    itemPartRow(`item:${privateUse}`),
    itemPartRow(`item:${supplementary}`),
  );
  assert.doesNotThrow(() => computeWorkbookHashes(manifest, context));
  const reversed = clone(context);
  [
    reversed.machineSheets.__TF_CURRENT[1],
    reversed.machineSheets.__TF_CURRENT[2],
  ] = [
    reversed.machineSheets.__TF_CURRENT[2],
    reversed.machineSheets.__TF_CURRENT[1],
  ];
  assert.throws(
    () => computeWorkbookHashes(manifest, reversed),
    /canonical primary-key order/,
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
  assert.equal(validateMachineCell(byFormat.get("diagnostic-severity"), "BLOCKER"), true);
  assert.throws(() => validateMachineCell(byFormat.get("diagnostic-severity"), "warn"));
  assert.throws(() => validateMachineCell(byFormat.get("diagnostic-severity"), "CRITICAL"));
  assert.equal(validateMachineCell(byFormat.get("stable-code"), "SCHEMA_CONFLICT"), true);
  assert.throws(() => validateMachineCell(byFormat.get("stable-code"), "schema-conflict"));
  assert.equal(validateMachineCell(byFormat.get("classification"), "preserved_frozen"), true);
  assert.throws(() => validateMachineCell(byFormat.get("classification"), "mutable"));
  assert.equal(validateMachineCell(byFormat.get("display-text"), "安全说明"), true);
  assert.equal(validateMachineCell(byFormat.get("display-text"), "第一行\n第二行"), true);
  assert.equal(validateMachineCell(byFormat.get("display-text"), "é"), true);
  for (const nonCanonicalDisplayText of [
    "第一行\r\n第二行",
    "第一行\r第二行",
    "e\u0301",
  ]) {
    assert.throws(
      () => validateMachineCell(byFormat.get("display-text"), nonCanonicalDisplayText),
      /already use LF line endings and NFC/,
    );
  }
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
    () => validateMachineCell(
      keyColumn,
      `["tech:1",${Number.MAX_SAFE_INTEGER + 1}]`,
      "string",
      {
        manifest,
        root: "v23TechnologyDefinitions",
        payload: { technologyId: "tech:1", revision: Number.MAX_SAFE_INTEGER + 1 },
      },
    ),
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
  for (const ordinaryNumber of [
    1e20,
    Number.MAX_SAFE_INTEGER + 1,
    0.125,
  ]) {
    assert.equal(
      validate("affinityAxisWeights", {
        ...affinityWeights,
        method_type: ordinaryNumber,
      }),
      true,
      "ordinary finite payload numbers are not identity/revision safe integers",
    );
  }
  for (const nonFinite of [Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(
      () => validateImportableExactFields(
        manifest,
        "affinityAxisWeights",
        { ...affinityWeights, method_type: nonFinite },
      ),
      /finite number/,
    );
  }
  const incompleteWeights = { ...affinityWeights };
  delete incompleteWeights.series_coherence;
  assert.throws(
    () => validate("affinityAxisWeights", incompleteWeights),
    /complete closed record key set/,
  );
  assert.equal(validate("v23TechnologyDefinitions", {
    technologyId: "technology:1",
    revision: 1,
    itemPartId: "part:rod",
    name: "力量技术",
    description: "",
    memberAffixRefs: [],
    enabled: true,
    contentHash: "a".repeat(64),
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
  for (const unsafeRevision of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => validateMachineCell(
        revisionColumn,
        JSON.stringify(unsafeRevision),
        "string",
        {
          ...revisionedContext,
          payload: { id: "sku:1", revision: unsafeRevision },
        },
      ),
      /safe integer/,
    );
  }
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
  const preservedContext = trustedPreservedContext(manifest, [preservedRow]);
  assert.equal(validateRecordEnvelope(manifest, preservedRow, {
    workspaceId: "workspace:1",
    baseWorkspaceRevision: "1",
    trustedPreservedContext: preservedContext,
  }), true);
  assert.throws(
    () => validateRecordEnvelope(manifest, preservedRow),
    /requires trusted server expected context/,
  );
  const preservedMutation = clone(preservedRow);
  preservedMutation.opaque_canonical_payload_json = canonicalPayload({
    ...preservedPayload,
    values: {},
  });
  preservedMutation.record_content_sha256 = expectedRecordHash(
    manifest,
    preservedMutation,
    "opaque_canonical_payload_json",
  );
  assert.throws(
    () => validateRecordEnvelope(manifest, preservedMutation, {
      workspaceId: "workspace:1",
      baseWorkspaceRevision: "1",
      trustedPreservedContext: preservedContext,
    }),
    /trusted server expected content|not exact-equal/,
  );
});

test("nullable preserved singleton binds its exact WorkspaceState scalar union", async () => {
  const { manifest, roots } = await fixture();
  const nullableSingletons = Object.entries(manifest.preservedRootCatalog)
    .filter(([, catalog]) => catalog.singleton && catalog.typeRef === "lib/types.ts#string|null");
  assert.equal(nullableSingletons.length, 1);
  const [[root]] = nullableSingletons;
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
  const nullRow = {
    root,
    record_schema_id: manifest.preservedSchemaCatalog[root],
    record_key: '["$singleton"]',
    record_revision: "null",
    record_content_sha256: "0".repeat(64),
    opaque_canonical_payload_json: "null",
  };
  nullRow.record_content_sha256 = expectedRecordHash(
    manifest,
    nullRow,
    "opaque_canonical_payload_json",
  );
  assert.equal(validateRecordEnvelope(manifest, nullRow, {
    workspaceId: "workspace:1",
    baseWorkspaceRevision: "1",
    trustedPreservedContext: trustedPreservedContext(manifest, [nullRow]),
  }), true);
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

test("every preserved root uses trusted workspace/revision/key exact comparison", async () => {
  const { manifest } = await fixture();
  for (const root of manifest.classifications.preserved_frozen) {
    const schemaCatalog = manifest.preservedSchemaCatalog[root];
    const schemaId = typeof schemaCatalog === "string"
      ? schemaCatalog
      : Object.values(schemaCatalog)[0];
    const row = {
      root,
      record_schema_id: schemaId,
      record_key: canonicalPayload([`key:${root}`]),
      record_revision: "null",
      record_content_sha256: "0".repeat(64),
      opaque_canonical_payload_json: canonicalPayload({ proof: root }),
    };
    row.record_content_sha256 = expectedRecordHash(
      manifest,
      row,
      "opaque_canonical_payload_json",
    );
    const trusted = trustedPreservedContext(manifest, [row]);
    const context = {
      workspaceId: "workspace:1",
      baseWorkspaceRevision: "1",
      trustedPreservedContext: trusted,
    };
    assert.equal(validateTrustedPreservedExactMatch(manifest, row, context), true, root);
    assert.throws(
      () => validateTrustedPreservedExactMatch(manifest, row, {}),
      /requires trusted server expected context/,
      root,
    );
    const wrongWorkspace = clone(trusted);
    wrongWorkspace.workspace_id = "workspace:other";
    assert.throws(
      () => validateTrustedPreservedExactMatch(manifest, row, {
        ...context,
        trustedPreservedContext: wrongWorkspace,
      }),
      /another workspace/,
      root,
    );
    const wrongRevision = clone(trusted);
    wrongRevision.base_workspace_revision = "2";
    assert.throws(
      () => validateTrustedPreservedExactMatch(manifest, row, {
        ...context,
        trustedPreservedContext: wrongRevision,
      }),
      /another workspace revision/,
      root,
    );
    const wrongKey = clone(row);
    wrongKey.record_key = canonicalPayload([`other:${root}`]);
    assert.throws(
      () => validateTrustedPreservedExactMatch(manifest, wrongKey, context),
      /missing or ambiguous/,
      root,
    );
    for (const field of ["record_schema_id", "record_revision"]) {
      const forged = clone(row);
      forged[field] = `${row[field]}:forged`;
      assert.throws(
        () => validateTrustedPreservedExactMatch(manifest, forged, context),
        new RegExp(`preserved ${field} drift`),
        `${root}.${field}`,
      );
    }
    for (const field of ["opaque_canonical_payload_json", "record_content_sha256"]) {
      const forged = clone(row);
      forged[field] = field === "record_content_sha256"
        ? "f".repeat(64)
        : canonicalPayload({ proof: `${root}:forged` });
      assert.throws(
        () => validateTrustedPreservedExactMatch(manifest, forged, context),
        /trusted server expected content|not exact-equal/,
        `${root}.${field}`,
      );
    }
    const duplicate = clone(trusted);
    duplicate.rows.push(clone(row));
    assert.throws(
      () => validateTrustedPreservedExactMatch(manifest, row, {
        ...context,
        trustedPreservedContext: duplicate,
      }),
      /missing or ambiguous/,
      root,
    );
  }
});

test("preserved candidates equal the complete trusted root key and schema set", async () => {
  const { manifest } = await fixture();
  const rows = manifest.classifications.preserved_frozen.map((root) => {
    const schemaCatalog = manifest.preservedSchemaCatalog[root];
    const recordSchemaId = typeof schemaCatalog === "string"
      ? schemaCatalog
      : Object.values(schemaCatalog)[0];
    return {
      root,
      record_schema_id: recordSchemaId,
      record_key: canonicalPayload([`key:${root}`]),
      record_revision: "null",
      record_content_sha256: "0".repeat(64),
      opaque_canonical_payload_json: canonicalPayload({ proof: root }),
    };
  });
  const trusted = trustedPreservedContext(manifest, rows);
  const context = {
    workspaceId: "workspace:1",
    baseWorkspaceRevision: "1",
  };
  assert.equal(validatePreservedCandidateSet(manifest, rows, trusted, context), true);
  for (const root of manifest.classifications.preserved_frozen) {
    assert.throws(
      () => validatePreservedCandidateSet(
        manifest,
        rows.filter((row) => row.root !== root),
        trusted,
        context,
      ),
      /must not omit or add trusted rows|omits a trusted row/,
      `${root} trusted non-singleton rows cannot disappear in MERGE or REPLACE`,
    );
  }
  const duplicate = clone(rows);
  duplicate.push(clone(rows[0]));
  assert.throws(
    () => validatePreservedCandidateSet(manifest, duplicate, trusted, context),
    /duplicate preserved root\/record_key/,
  );
  const extra = clone(rows);
  extra.push({ ...clone(rows[0]), record_key: canonicalPayload(["extra"]) });
  assert.throws(
    () => validatePreservedCandidateSet(manifest, extra, trusted, context),
    /missing or ambiguous|must not omit or add trusted rows|extra row/,
  );
  const wrongRoot = clone(rows);
  wrongRoot[0].root = manifest.classifications.importable_current[0];
  assert.throws(
    () => validatePreservedCandidateSet(manifest, wrongRoot, trusted, context),
    /non-preserved root/,
  );
  const wrongKey = clone(rows);
  wrongKey[0].record_key = canonicalPayload(["wrong-key"]);
  assert.throws(
    () => validatePreservedCandidateSet(manifest, wrongKey, trusted, context),
    /must not omit or add trusted rows|omits a trusted row/,
  );
  const wrongSchema = clone(rows);
  wrongSchema[0].record_schema_id = "project-workbook/preserved/forged/v1";
  assert.throws(
    () => validatePreservedCandidateSet(manifest, wrongSchema, trusted, context),
    /schema drift/,
  );
  const wrongRecordRevision = clone(rows);
  wrongRecordRevision[0].record_revision = '"forged"';
  assert.throws(
    () => validatePreservedCandidateSet(manifest, wrongRecordRevision, trusted, context),
    /revision drift/,
  );
  assert.throws(
    () => validatePreservedCandidateSet(
      manifest,
      rows,
      { ...clone(trusted), workspace_id: "workspace:other" },
      context,
    ),
    /another workspace/,
  );
  assert.throws(
    () => validatePreservedCandidateSet(
      manifest,
      rows,
      { ...clone(trusted), base_workspace_revision: "2" },
      context,
    ),
    /another workspace revision/,
  );

  const summary = rootSummaryFixture(manifest);
  const trustedWithOneNonSingleton = trustedPreservedContext(manifest, [rows[0]]);
  assert.throws(
    () => validateRootSummary(
      manifest,
      summary.rows,
      summary.rootRecordContext,
      process.cwd(),
      trustedWithOneNonSingleton,
    ),
    /must not omit or add trusted rows|omits a trusted row/,
    "ROOT_SUMMARY zero count/hash cannot bypass preserved-set omission",
  );
});

test("every manifest-derived current and preserved singleton requires exactly one row", async () => {
  const { manifest } = await fixture();
  const currentSingletons = Object.entries(manifest.recordSchemas)
    .filter(([, schema]) => (
      schema.identityFields.length === 1 && schema.identityFields[0] === "$singleton"
    ))
    .map(([root]) => root);
  const preservedSingletons = Object.entries(manifest.preservedRootCatalog)
    .filter(([, catalog]) => catalog.singleton === true)
    .map(([root]) => root);
  const currentNonSingleton = Object.keys(manifest.recordSchemas)
    .find((root) => !currentSingletons.includes(root));
  const preservedNonSingleton = Object.keys(manifest.preservedRootCatalog)
    .find((root) => !preservedSingletons.includes(root));
  const currentRows = currentSingletons.map((root) => ({ root }));
  const preservedRows = preservedSingletons.map((root) => ({ root }));
  assert.ok(currentSingletons.length > 0);
  assert.ok(preservedSingletons.length > 0);
  assert.equal(
    validateRecordSheetCardinality(manifest, currentRows, preservedRows),
    true,
  );
  for (const root of currentSingletons) {
    assert.throws(
      () => validateRecordSheetCardinality(
        manifest,
        currentRows.filter((row) => row.root !== root),
        preservedRows,
      ),
      new RegExp(`${root} requires EXACTLY_ONE`),
    );
    assert.throws(
      () => validateRecordSheetCardinality(
        manifest,
        [...currentRows, { root }],
        preservedRows,
      ),
      new RegExp(`${root} requires EXACTLY_ONE`),
    );
    assert.throws(
      () => validateRecordSheetCardinality(
        manifest,
        currentRows.map((row) => row.root === root ? { root: preservedNonSingleton } : row),
        preservedRows,
      ),
      /__TF_CURRENT contains a row for the wrong root/,
    );
  }
  for (const root of preservedSingletons) {
    assert.throws(
      () => validateRecordSheetCardinality(
        manifest,
        currentRows,
        preservedRows.filter((row) => row.root !== root),
      ),
      new RegExp(`${root} requires EXACTLY_ONE`),
    );
    assert.throws(
      () => validateRecordSheetCardinality(
        manifest,
        currentRows,
        [...preservedRows, { root }],
      ),
      new RegExp(`${root} requires EXACTLY_ONE`),
    );
    assert.throws(
      () => validateRecordSheetCardinality(
        manifest,
        currentRows,
        preservedRows.map((row) => row.root === root ? { root: currentNonSingleton } : row),
      ),
      /__TF_PRESERVED contains a row for the wrong root/,
    );
  }
  assert.equal(
    validateRecordSheetCardinality(
      manifest,
      [...currentRows, { root: currentNonSingleton }, { root: currentNonSingleton }],
      [...preservedRows, { root: preservedNonSingleton }, { root: preservedNonSingleton }],
    ),
    true,
    "non-singleton roots retain ZERO_OR_MORE cardinality",
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
  const diagnosticRow = {
    root: "derivedProjections",
    record_key: diagnosticKey(manifest, "derivedProjections", payloads.derivedProjections),
    diagnostic_schema_version: "project-workbook-diagnostic/v1",
    subject_payload_json: canonicalPayload(payloads.derivedProjections),
    severity: "WARNING",
    code: "PROJECTION_STALE",
    message: "派生结果已过期",
    subject_ref: "null",
    issue_fingerprint: "",
    diagnostic_evidence_sha256: "",
  };
  diagnosticRow.issue_fingerprint = diagnosticFingerprint(manifest, diagnosticRow);
  diagnosticRow.diagnostic_evidence_sha256 = diagnosticEvidence(manifest, diagnosticRow);
  assert.equal(validateDiagnosticEnvelope(manifest, diagnosticRow), true);
  const blockerRow = {
    ...diagnosticRow,
    severity: "BLOCKER",
    message: "派生结果不可重放",
    issue_fingerprint: "",
    diagnostic_evidence_sha256: "",
  };
  blockerRow.issue_fingerprint = diagnosticFingerprint(manifest, blockerRow);
  blockerRow.diagnostic_evidence_sha256 = diagnosticEvidence(manifest, blockerRow);
  const diagnosticRows = [blockerRow, diagnosticRow].sort((left, right) =>
    compareWorkbookPrimaryKey(
      manifest,
      left,
      right,
      manifest.workbookSchema.sheets.__TF_DIAGNOSTICS.primaryKey,
    ));
  assert.equal(
    validateDiagnosticRows(manifest, diagnosticRows),
    true,
    "same subject and code retain distinct issues through their closed fingerprint",
  );
  assert.throws(
    () => validateDiagnosticRows(manifest, [...diagnosticRows].reverse()),
    /canonical primary-key order/,
  );
  assert.notEqual(blockerRow.issue_fingerprint, diagnosticRow.issue_fingerprint);
  assert.throws(
    () => validateDiagnosticRows(manifest, [diagnosticRow, { ...diagnosticRow }]),
    /duplicate primary key/,
    "an exact duplicate issue is rejected deterministically",
  );
  assert.throws(
    () => validateDiagnosticEnvelope(manifest, {
      ...diagnosticRow,
      issue_fingerprint: "f".repeat(64),
    }),
    /issue_fingerprint does not match/,
  );
  const subjectMutation = {
    ...diagnosticRow,
    subject_payload_json: canonicalPayload({ id: "projection:2" }),
  };
  assert.throws(
    () => validateDiagnosticEnvelope(manifest, subjectMutation),
    /does not match the safe subject payload/,
  );
  const issueMutation = { ...diagnosticRow, message: "被篡改的显示信息" };
  assert.throws(
    () => validateDiagnosticEnvelope(manifest, issueMutation),
    /issue_fingerprint does not match/,
  );
  const evidenceMutation = {
    ...diagnosticRow,
    diagnostic_evidence_sha256: "e".repeat(64),
  };
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

test("server-owned transport refs bind public identity outside the semantic content hash", async () => {
  const { manifest, manifestSource, roots } = await fixture();
  assert.deepEqual(
    Object.keys(manifest.serverOwnedRootCatalog),
    manifest.classifications.server_owned,
  );
  assert.ok(!manifest.canonicalization.machineContentHashInput.includes("__TF_SERVER_REFS"));
  assert.ok(manifest.canonicalization.machineContentHashExcludes.includes("__TF_SERVER_REFS"));
  assert.deepEqual(manifest.canonicalization.transportIntegritySheets, ["__TF_SERVER_REFS"]);
  for (const root of manifest.classifications.server_owned) {
    assert.deepEqual(manifest.serverOwnedRootCatalog[root], {
      hashPolicy: "NO_CONTENT_HASH",
      refPolicy: "DETERMINISTIC_IDENTITY_BOUND_NON_SENSITIVE",
    });
    const row = serverRefRow(manifest, root);
    assert.equal(validateServerRefEnvelope(manifest, row, {
      workspaceId: "workspace:1",
      baseWorkspaceRevision: "1",
    }), true);
    assert.equal(
      row.opaque_server_ref,
      serverRefRow(manifest, root).opaque_server_ref,
      "the same public transport identity must reproduce the same non-sensitive token",
    );
  }
  for (const rawRoot of ["patchLedger", "partConstraintSets", "configIdGovernance"]) {
    const forged = serverRefRow(manifest, rawRoot);
    forged.root_content_sha256 = "a".repeat(64);
    assert.throws(
      () => validateServerRefEnvelope(manifest, forged, {
        workspaceId: "workspace:1",
        baseWorkspaceRevision: "1",
      }),
      /null/,
    );
  }
  const forgedToken = serverRefRow(manifest, "patchLedger");
  forgedToken.opaque_server_ref = `opaque_${"b".repeat(64)}`;
  assert.throws(
    () => validateServerRefEnvelope(manifest, forgedToken, {
      workspaceId: "workspace:1",
      baseWorkspaceRevision: "1",
    }),
    /transport identity/,
  );
  assert.throws(
    () => validateServerRefEnvelope(
      manifest,
      serverRefRow(manifest, "patchLedger", "workspace:2"),
      { workspaceId: "workspace:1", baseWorkspaceRevision: "1" },
    ),
    /another workspace/,
  );
  assert.throws(
    () => validateServerRefEnvelope(
      manifest,
      serverRefRow(manifest, "patchLedger", "workspace:1", "2"),
      { workspaceId: "workspace:1", baseWorkspaceRevision: "1" },
    ),
    /another workspace revision/,
  );

  const first = workbookContext(manifest, manifestSource);
  const repeated = workbookContext(manifest, manifestSource);
  assert.equal(
    computeWorkbookHashes(manifest, first).machineContentSha256,
    computeWorkbookHashes(manifest, repeated).machineContentSha256,
    "repeated export of one semantic state must retain one semantic hash",
  );
  const nextRevision = workbookContext(manifest, manifestSource);
  nextRevision.manifestFields.base_workspace_revision = "2";
  nextRevision.trustedPreservedContext.base_workspace_revision = "2";
  nextRevision.machineSheets.__TF_SERVER_REFS =
    manifest.classifications.server_owned.map((root) =>
      serverRefRow(manifest, root, "workspace:1", "2"));
  assert.notEqual(
    computeWorkbookHashes(manifest, first).machineContentSha256,
    computeWorkbookHashes(manifest, nextRevision).machineContentSha256,
    "the manifest revision boundary remains semantic even though transport refs are excluded",
  );
  assert.deepEqual(
    Object.keys(serverRefRow(manifest, "patchLedger")),
    manifest.workbookSchema.sheets.__TF_SERVER_REFS.columns.map((column) => column.name),
    "the closed transport row has no raw or sensitive payload input",
  );
  const weakened = clone(manifest);
  weakened.serverOwnedRootCatalog.patchLedger.hashPolicy = "HASH_RAW_PAYLOAD";
  assert.throws(
    () => validateProjectWorkbookManifest(weakened, roots),
    /raw-derived content hashes/,
  );
});

test("ROOT_SUMMARY binds all 93 roots without hashing server-owned or forbidden content", async () => {
  const { manifest } = await fixture();
  const {
    rows,
    rootRecordContext,
    trustedPreservedContext: trusted,
  } = rootSummaryFixture(manifest);
  const validateSummary = (candidateRows, context = rootRecordContext) =>
    validateRootSummary(manifest, candidateRows, context, process.cwd(), trusted);
  assert.equal(validateSummary(rows), true);
  assert.equal(rows.length, 93);

  const notesRecord = {
    root: "notes",
    record_schema_id: manifest.recordSchemas.notes.schemaId,
    record_key: '["$singleton"]',
    record_revision: "null",
    record_content_sha256: "0".repeat(64),
    payload_json: canonicalPayload("actual note"),
  };
  notesRecord.record_content_sha256 = expectedRecordHash(manifest, notesRecord, "payload_json");
  const populatedRows = clone(rows);
  const populatedContext = clone(rootRecordContext);
  populatedContext.notes = [notesRecord];
  const notesSummary = populatedRows.find((row) => row.root === "notes");
  notesSummary.record_count = "1";
  notesSummary.root_content_sha256 = createHash("sha256")
    .update(canonicalPayload([notesRecord]))
    .digest("hex");
  assert.equal(validateSummary(populatedRows, populatedContext), true);

  const wrongClassification = clone(rows);
  wrongClassification[0].classification = "server_owned";
  assert.throws(
    () => validateSummary(wrongClassification),
    /classification mismatch/,
  );
  const missingRoot = rows.slice(1);
  assert.throws(
    () => validateSummary(missingRoot),
    /exactly 93 roots/,
  );
  const duplicatedRoot = clone(rows);
  duplicatedRoot[1].root = duplicatedRoot[0].root;
  assert.throws(
    () => validateSummary(duplicatedRoot),
    /each root once/,
  );

  const hashedAsNull = clone(rows);
  hashedAsNull.find((row) => row.classification === "importable_current")
    .root_content_sha256 = "null";
  assert.throws(
    () => validateSummary(hashedAsNull),
    /requires a closed root hash/,
  );
  const diagnosticHashMutation = clone(rows);
  diagnosticHashMutation.find((row) => row.classification === "export_only_diagnostic")
    .root_content_sha256 = "a".repeat(64);
  assert.throws(
    () => validateSummary(diagnosticHashMutation),
    /does not match its closed records/,
  );
  for (const classification of ["server_owned", "forbidden"]) {
    const rawHashLeak = clone(rows);
    rawHashLeak.find((row) => row.classification === classification)
      .root_content_sha256 = "b".repeat(64);
    assert.throws(
      () => validateSummary(rawHashLeak),
      /must not expose a raw-derived root hash/,
    );
    const nonzeroCount = clone(rows);
    nonzeroCount.find((row) => row.classification === classification).record_count = "1";
    assert.throws(
      () => validateSummary(nonzeroCount),
      /must not claim protected records/,
    );
    const missingCount = clone(rows);
    delete missingCount.find((row) => row.classification === classification).record_count;
    assert.throws(
      () => validateSummary(missingCount),
      /closed field order/,
    );
  }
  const missingContext = clone(rootRecordContext);
  delete missingContext[Object.keys(missingContext)[0]];
  assert.throws(
    () => validateSummary(rows, missingContext),
    /every and only hash-bearing roots/,
  );
  assert.throws(
    () => validateRootSummary(manifest, rows, rootRecordContext),
    /requires trusted preserved expected context/,
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
