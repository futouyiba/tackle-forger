#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const CLASSIFICATIONS = [
  "importable_current",
  "preserved_frozen",
  "server_owned",
  "forbidden",
  "export_only_diagnostic",
];

const EXPECTED_TOP_LEVEL_KEYS = [
  "schema",
  "contractVersion",
  "workspaceStateSource",
  "workbookSchema",
  "canonicalization",
  "recordSchemaAuthority",
  "recordSchemas",
  "classifications",
  "modes",
  "removal",
  "conflicts",
  "plan",
  "actions",
  "transaction",
];

export const EXPECTED_ROOT_CLASSIFICATIONS = {
  importable_current: [
    "ruleSettings", "itemParts", "methodProfiles", "itemTypeProfiles", "functionProfiles",
    "performanceProfiles", "qualityProfiles", "compatibilityRules", "affinityRules",
    "affinityAxisWeights", "collections", "seriesDefinitions", "v23SeriesPartHeads",
    "v23SkuDrawerHeads", "v23AffixDefinitions", "v23TechnologyDefinitions",
    "v23TechnologyHeads", "skuDrawers", "purchasableModels", "v3Affixes", "technologies",
    "qualityValuePolicyDrafts", "pricingPolicyDrafts", "parameters", "templates", "modifiers",
    "layers", "affixes", "qualityBands", "affixScorePolicy", "recipes", "seriesShowcases",
    "candidates", "officialSkus", "detailOverrides", "ruleGraphs", "notes",
  ],
  preserved_frozen: [
    "ruleSetVersions", "performanceSummaryDefinitions", "projectionPatches",
    "v23SeriesPartRevisions", "v23SkuDrawerRevisions", "v23FunctionTemplates",
    "partConstraintSets", "candidateSearchRecipes", "configurationSnapshots",
    "reductionStackingPolicyVersions",
    "fiveAxisDispositionCatalogRevisions", "fiveAxisViewDefinitions", "fiveAxisVertexSets",
    "currentFiveAxisDispositionCatalogRevisionId", "patchReviewBatches",
    "patchValidationWaivers", "patchValidationWaiverDecisions", "ruleChangeProposals",
    "revisions",
  ],
  server_owned: [
    "workspaceId", "schemaVersion", "configIdGovernance", "patchLedger",
    "canonicalRuleSourceDrafts", "weightTemplatePolicyDrafts", "workspacePolicies",
    "pricingPolicyVersions", "identityAuditLog", "commandIdempotencyRecords",
    "governanceAuditLog", "importedAt",
  ],
  forbidden: [
    "feishuWorkbooks", "feishuSourceRevisions", "aiRuleSourceChangeDrafts",
    "aiArtifactProvenanceSyncRecords", "exportTargetProfiles", "configEnvironmentProfiles",
    "configExportMappings", "dataSources", "dataSourceImports", "dataSourceBindings",
    "dataSourceWritebacks", "feishuShareLinkHistory", "v23MigrationSourceEvidence",
    "v23LegacyReadAdapters", "migrationReviewItems",
  ],
  export_only_diagnostic: [
    "derivedProjections", "projectionMatches", "candidateRuns", "candidateMaterializations",
    "sourceIdentityMigrationReports", "modelPricingEvaluations", "aiAssessments",
    "upgradeCandidates", "fiveAxisVertexGroupStates", "ruleRuns",
  ],
};

const EXPECTED_ACTIONS = {
  preview: {
    actionCode: "preview_project_workbook_import",
    requiredCapability: "project.workbook.preview",
  },
  commit: {
    actionCode: "commit_project_workbook_import",
    requiredCapability: "project.workbook.commit",
  },
  export: {
    actionCode: "export_project_workbook",
    requiredCapability: "project.workbook.export",
  },
};

const EXPECTED_SHEETS = {
  __TF_MANIFEST: {
    kind: "machine",
    columns: [
      "contract_version", "workspace_id", "base_workspace_revision", "root_manifest_sha256",
      "workbook_schema_sha256", "exporter_version", "machine_content_sha256",
    ],
    primaryKey: ["contract_version"],
    cardinality: "EXACTLY_ONE",
  },
  __TF_CURRENT: {
    kind: "machine",
    columns: [
      "root", "record_schema_id", "record_key", "record_revision",
      "record_content_sha256", "payload_json",
    ],
    primaryKey: ["root", "record_key"],
    cardinality: "ZERO_OR_MORE",
  },
  __TF_PRESERVED: {
    kind: "machine",
    columns: [
      "root", "record_key", "record_revision", "record_content_sha256",
      "opaque_canonical_payload_json",
    ],
    primaryKey: ["root", "record_key"],
    cardinality: "ZERO_OR_MORE",
  },
  __TF_ROOT_REFS: {
    kind: "machine",
    columns: ["root", "classification", "root_content_sha256", "opaque_server_ref"],
    primaryKey: ["root"],
    cardinality: "EXACTLY_ALL_SERVER_OWNED_AND_FORBIDDEN_ROOTS",
  },
  __TF_DIAGNOSTICS: {
    kind: "machine",
    columns: [
      "root", "record_key", "severity", "code", "message", "subject_ref", "content_sha256",
    ],
    primaryKey: ["root", "record_key", "code"],
    cardinality: "ZERO_OR_MORE",
  },
  README: {
    kind: "derived_readable",
    columns: ["section", "content"],
    primaryKey: ["section"],
    cardinality: "ONE_OR_MORE",
  },
  ROOT_SUMMARY: {
    kind: "derived_readable",
    columns: ["root", "classification", "record_count", "root_content_sha256", "status"],
    primaryKey: ["root"],
    cardinality: "EXACTLY_93",
  },
};

const EXPECTED_RECORD_SCHEMAS_SHA256 =
  "982135f85821536056738db0dd5de56b105a5ec21767e7ad87d75cb120cea9a8";
const EXPECTED_RECORD_SCHEMA_AUTHORITY_SHA256 =
  "2b3a44e11b1cf4fb2f56c4bdd9ce5a9fd19475ee8716fdbd1e99630db0f6f552";

function fail(message) {
  throw new Error(message);
}

function sha256(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function matchingBrace(source, openingIndex) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  fail("WorkspaceState interface is not closed");
}

export function parseWorkspaceStateRoots(source) {
  const declaration = source.match(/\bexport\s+interface\s+WorkspaceState\s*\{/);
  if (!declaration || declaration.index === undefined) {
    fail("Missing exported WorkspaceState interface");
  }
  const openingIndex = source.indexOf("{", declaration.index);
  const body = source.slice(openingIndex + 1, matchingBrace(source, openingIndex));
  const roots = [];
  let depth = 0;
  for (const line of body.split(/\r?\n/)) {
    if (depth === 0) {
      const property = line.match(/^\s{2}([A-Za-z_$][A-Za-z0-9_$]*)(?:\?)?:/);
      if (property) roots.push(property[1]);
    }
    depth += [...line].filter((character) => character === "{").length;
    depth -= [...line].filter((character) => character === "}").length;
  }
  if (roots.length === 0) fail("WorkspaceState has no machine-readable top-level roots");
  return roots;
}

export function parseExportedInterfaceFields(source, interfaceName) {
  const declaration = source.match(
    new RegExp(`\\bexport\\s+interface\\s+${interfaceName}\\s*(?:extends[^\\{]+)?\\{`),
  );
  if (!declaration || declaration.index === undefined) return null;
  const openingIndex = source.indexOf("{", declaration.index);
  const body = source
    .slice(openingIndex + 1, matchingBrace(source, openingIndex))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const fields = [];
  let depth = 0;
  let segment = "";
  for (const character of body) {
    segment += character;
    if ("{[(".includes(character)) depth += 1;
    if ("}])".includes(character)) depth -= 1;
    if (character === ";" && depth === 0) {
      const field = segment.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\?)?:/)?.[1];
      if (field) fields.push(field);
      segment = "";
    }
  }
  return fields;
}

function assertExactKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value), expected, `${label} must use the closed schema`);
}

export function validateProjectWorkbookManifest(manifest, workspaceRoots) {
  assertExactKeys(manifest, EXPECTED_TOP_LEVEL_KEYS, "project workbook manifest");
  assert.equal(manifest.schema, "project-workbook-root-manifest/v1");
  assert.equal(manifest.contractVersion, "project-workbook/v1");
  assert.deepEqual(manifest.workspaceStateSource, {
    path: "lib/types.ts",
    interface: "WorkspaceState",
    rootCount: 93,
  });
  assert.equal(workspaceRoots.length, manifest.workspaceStateSource.rootCount);
  assertExactKeys(manifest.classifications, CLASSIFICATIONS, "root classifications");
  assert.deepEqual(
    manifest.classifications,
    EXPECTED_ROOT_CLASSIFICATIONS,
    "all 93 WorkspaceState roots must retain their exact expected classifications",
  );

  const classified = [];
  for (const classification of CLASSIFICATIONS) {
    const roots = manifest.classifications[classification];
    assert.ok(Array.isArray(roots) && roots.length > 0, `${classification} must be non-empty`);
    assert.equal(new Set(roots).size, roots.length, `${classification} contains a duplicate root`);
    classified.push(...roots);
  }
  assert.equal(new Set(classified).size, classified.length, "a WorkspaceState root is classified more than once");
  assert.deepEqual(
    [...classified].sort(),
    [...workspaceRoots].sort(),
    "every current WorkspaceState root must be classified exactly once",
  );

  assertExactKeys(manifest.workbookSchema, [
    "schema",
    "sheetOrder",
    "rejectUnknownSheets",
    "rejectUnknownColumns",
    "rejectFormulaCellsInMachineSheets",
    "sheets",
    "classificationProjection",
  ], "workbook schema");
  assert.equal(manifest.workbookSchema.schema, "project-workbook-machine-sheets/v1");
  assert.equal(manifest.workbookSchema.rejectUnknownSheets, true);
  assert.equal(manifest.workbookSchema.rejectUnknownColumns, true);
  assert.equal(manifest.workbookSchema.rejectFormulaCellsInMachineSheets, true);
  assert.deepEqual(
    Object.keys(manifest.workbookSchema.sheets),
    manifest.workbookSchema.sheetOrder,
    "sheet catalog and order must be exact",
  );
  assert.deepEqual(
    manifest.workbookSchema.sheets,
    EXPECTED_SHEETS,
    "sheet columns, keys and cardinalities must retain their exact closed schema",
  );
  assert.equal(new Set(manifest.workbookSchema.sheetOrder).size, 7);
  for (const [sheetName, sheet] of Object.entries(manifest.workbookSchema.sheets)) {
    assertExactKeys(sheet, ["kind", "columns", "primaryKey", "cardinality"], `sheet ${sheetName}`);
    assert.ok(["machine", "derived_readable"].includes(sheet.kind));
    assert.ok(Array.isArray(sheet.columns) && sheet.columns.length > 0);
    assert.equal(new Set(sheet.columns).size, sheet.columns.length, `${sheetName} has duplicate columns`);
    assert.ok(sheet.primaryKey.every((column) => sheet.columns.includes(column)));
  }
  assert.deepEqual(Object.keys(manifest.workbookSchema.classificationProjection), CLASSIFICATIONS);
  assert.deepEqual(manifest.workbookSchema.classificationProjection, {
    importable_current: { sheet: "__TF_CURRENT", payloadPolicy: "CLOSED_RECORD_SCHEMA" },
    preserved_frozen: { sheet: "__TF_PRESERVED", payloadPolicy: "OPAQUE_EXACT_SERVER_EXPORT_ONLY" },
    server_owned: { sheet: "__TF_ROOT_REFS", payloadPolicy: "HASH_AND_OPAQUE_REF_ONLY" },
    forbidden: { sheet: "__TF_ROOT_REFS", payloadPolicy: "HASH_AND_OPAQUE_REF_ONLY" },
    export_only_diagnostic: {
      sheet: "__TF_DIAGNOSTICS",
      payloadPolicy: "CLOSED_DERIVED_DIAGNOSTIC_FIELDS_ONLY",
    },
  });

  assertExactKeys(manifest.canonicalization, [
    "textEncoding",
    "unicodeNormalization",
    "lineEndings",
    "jsonCanonicalization",
    "finiteNumbersOnly",
    "negativeZero",
    "blankAndNullDistinct",
    "rowOrder",
    "workbookSchemaHashInput",
    "recordHashInput",
    "machineContentHashInput",
    "machineContentHashExcludes",
    "hashAlgorithm",
    "semanticEquivalence",
  ], "canonicalization");
  assert.equal(manifest.canonicalization.jsonCanonicalization, "RFC8785_JCS");
  assert.equal(manifest.canonicalization.hashAlgorithm, "SHA-256");
  assert.deepEqual(manifest.canonicalization.workbookSchemaHashInput, [
    "workbookSchema",
    "canonicalization",
    "recordSchemaAuthority",
    "recordSchemas",
    "classifications",
  ]);
  assert.deepEqual(manifest.canonicalization.recordHashInput, [
    "root",
    "record_schema_id",
    "record_key",
    "record_revision",
    "canonical_payload",
  ]);
  assert.deepEqual(manifest.canonicalization.machineContentHashInput, [
    "__TF_CURRENT",
    "__TF_PRESERVED",
    "__TF_ROOT_REFS",
    "__TF_DIAGNOSTICS",
  ]);
  assert.deepEqual(manifest.canonicalization.machineContentHashExcludes, [
    "__TF_MANIFEST.machine_content_sha256",
    "README",
    "ROOT_SUMMARY",
  ]);
  assert.equal(
    manifest.canonicalization.semanticEquivalence,
    "CANONICAL_MACHINE_CONTENT_SHA256_EQUAL",
  );

  assertExactKeys(manifest.recordSchemaAuthority, [
    "format",
    "sources",
    "recursiveRules",
    "typeRefs",
  ], "record schema authority");
  assert.equal(manifest.recordSchemaAuthority.format, "typescript-closed-projection/v1");
  assert.equal(
    sha256(JSON.stringify(manifest.recordSchemaAuthority)),
    EXPECTED_RECORD_SCHEMA_AUTHORITY_SHA256,
    "recursive record schema authority drift",
  );
  assert.deepEqual(manifest.recordSchemaAuthority.recursiveRules, {
    unknownObjectFields: "REJECT",
    unknownUnionVariants: "REJECT",
    optionalFields: "DECLARATION_OPTIONALITY_ONLY",
    recordStringKeys: "ALLOW_ONLY_WHEN_DECLARATION_EXPLICITLY_USES_STRING_INDEX",
    unknownValues: "FORBIDDEN_IN_IMPORTABLE_PROJECTION",
    excludedSourceFields: "SERVER_PRESERVE_NOT_EXPORTED",
  });
  assert.deepEqual(
    Object.keys(manifest.recordSchemaAuthority.typeRefs),
    EXPECTED_ROOT_CLASSIFICATIONS.importable_current,
    "every importable root must bind one exact recursive type authority",
  );
  for (const [root, typeRef] of Object.entries(manifest.recordSchemaAuthority.typeRefs)) {
    assert.match(
      typeRef,
      /^lib\/(?:types|quality-value-policy|pricing-policy)\.ts#[A-Za-z][A-Za-z0-9]*$/,
      `${root} has an invalid recursive type authority`,
    );
  }

  assert.deepEqual(
    Object.keys(manifest.recordSchemas),
    EXPECTED_ROOT_CLASSIFICATIONS.importable_current,
    "every and only importable root must have one closed record schema",
  );
  assert.equal(
    sha256(JSON.stringify(manifest.recordSchemas)),
    EXPECTED_RECORD_SCHEMAS_SHA256,
    "record identity and allowed-field catalog drift",
  );
  for (const [root, schema] of Object.entries(manifest.recordSchemas)) {
    assertExactKeys(schema, [
      "schemaId",
      "identityFields",
      "revisionFields",
      "hashFields",
      "exactFields",
      "allowedFields",
    ], `record schema ${root}`);
    assert.equal(schema.schemaId, `project-workbook/root/${root}/v1`);
    assert.ok(schema.identityFields.length > 0);
    assert.ok(schema.allowedFields.length > 0);
    assert.equal(new Set(schema.allowedFields).size, schema.allowedFields.length);
    for (const field of [
      ...schema.identityFields.filter((field) => field !== "$singleton"),
      ...schema.revisionFields.filter((field) => !field.includes(".")),
      ...schema.hashFields,
      ...schema.exactFields,
    ]) {
      assert.ok(schema.allowedFields.includes(field), `${root}.${field} is outside allowedFields`);
    }
  }

  assert.deepEqual(manifest.modes, {
    MERGE_BY_STABLE_ID: {
      missingRecord: "NO_OP",
      identityRule: "MATCH_STABLE_ID_ONLY",
    },
    REPLACE_PROJECT: {
      missingRecord: "REMOVAL_INTENT",
      identityRule: "MATCH_STABLE_ID_ONLY",
    },
  });
  assert.deepEqual(manifest.removal, {
    allowed: "DEDICATED_SAFE_REMOVAL_COMMAND_ONLY",
    unsupportedCode: "REMOVAL_NOT_SUPPORTED",
  });
  assert.deepEqual(manifest.conflicts, {
    replanAndRehash: ["MUTABLE_VALUE_CONFLICT", "MUTABLE_REVISION_CONFLICT"],
    hardBlock: [
      "IDENTITY_CONFLICT",
      "FROZEN_CONTENT_CONFLICT",
      "REFERENCE_INTEGRITY_CONFLICT",
      "SCHEMA_CONFLICT",
      "WORKSPACE_CONFLICT",
    ],
  });
  assert.deepEqual(manifest.plan, {
    binds: [
      "workspaceId",
      "baseWorkspaceRevision",
      "workbookContentHash",
      "rootManifestHash",
      "mode",
      "normalizedOperationsHash",
    ],
    mutableConflictResolution: "REPLAN_REHASH_AND_REAUTHORIZE",
    commitRequiresExactPlanMatch: true,
  });
  assert.deepEqual(manifest.actions, EXPECTED_ACTIONS);
  assert.deepEqual(manifest.transaction, {
    authorizationAtExecution: true,
    atomicCommit: true,
    idempotentCommit: true,
    readbackRequired: true,
    sameWorkspaceOnly: true,
    crossWorkspaceCloneOrRestore: false,
  });

  return true;
}

export function checkProjectWorkbookContract(root = process.cwd()) {
  const manifestPath = path.join(root, "docs/spec-v3/project-workbook-v1-root-manifest.json");
  const manifestSource = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestSource);
  const workspaceSource = readFileSync(path.join(root, manifest.workspaceStateSource.path), "utf8");
  const workspaceRoots = parseWorkspaceStateRoots(workspaceSource);
  validateProjectWorkbookManifest(manifest, workspaceRoots);
  for (const source of manifest.recordSchemaAuthority.sources) {
    assertExactKeys(source, ["path", "sha256"], `record schema source ${source.path}`);
    assert.equal(
      sha256(readFileSync(path.join(root, source.path), "utf8")),
      source.sha256,
      `record schema source hash drift: ${source.path}`,
    );
  }
  for (const [rootName, typeRef] of Object.entries(manifest.recordSchemaAuthority.typeRefs)) {
    const [sourcePath, typeName] = typeRef.split("#");
    const fields = parseExportedInterfaceFields(
      readFileSync(path.join(root, sourcePath), "utf8"),
      typeName,
    );
    if (fields === null) {
      assert.ok(
        (rootName === "affinityAxisWeights" && typeName === "AffinityAxisWeights")
          || (rootName === "notes" && typeName === "string"),
        `${rootName} must resolve to an exported interface or an explicit scalar/map exception`,
      );
      continue;
    }
    for (const field of manifest.recordSchemas[rootName].allowedFields) {
      assert.ok(fields.includes(field), `${rootName}.${field} is absent from ${typeRef}`);
    }
  }

  const specManifest = JSON.parse(readFileSync(path.join(root, "docs/spec-v3/manifest.json"), "utf8"));
  const binding = specManifest.contracts?.find((contract) => contract.id === "project-workbook/v1");
  assert.deepEqual(binding, {
    id: "project-workbook/v1",
    path: "docs/spec-v3/project-workbook-v1-root-manifest.json",
    sha256: sha256(manifestSource),
  }, "v3 manifest must hash-bind the canonical project workbook manifest");

  const persistence = readFileSync(path.join(root, "docs/spec-v3/04-persistence-and-lifecycle.md"), "utf8");
  const interaction = readFileSync(path.join(root, "docs/spec-v3/07-interaction-contract.md"), "utf8");
  for (const token of [
    "project-workbook/v1",
    "MERGE_BY_STABLE_ID",
    "REPLACE_PROJECT",
    "REMOVAL_NOT_SUPPORTED",
    "REPLAN_REHASH_AND_REAUTHORIZE",
  ]) {
    assert.match(persistence, new RegExp(token), `section 15.1 must bind ${token}`);
  }
  for (const action of Object.values(manifest.actions)) {
    assert.match(
      interaction,
      new RegExp(action.actionCode),
      `section 24.1 must bind ${action.actionCode}`,
    );
    assert.match(
      interaction,
      new RegExp(action.requiredCapability.replaceAll(".", "\\.")),
      `section 24.1 must bind ${action.requiredCapability}`,
    );
  }
  return { manifestSha256: sha256(manifestSource), rootCount: workspaceRoots.length };
}

export function isDirectExecution(metaUrl, argv1 = process.argv[1]) {
  return typeof argv1 === "string"
    && path.resolve(fileURLToPath(metaUrl)) === path.resolve(argv1);
}

if (isDirectExecution(import.meta.url)) {
  try {
    const result = checkProjectWorkbookContract();
    process.stdout.write(
      `project-workbook/v1 contract is consistent (${result.rootCount} roots, manifest ${result.manifestSha256})\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
