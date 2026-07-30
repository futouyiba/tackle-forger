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
  "preservedRootCatalog",
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
    "qualityProfiles", "compatibilityRules", "affinityRules",
    "affinityAxisWeights", "collections", "seriesDefinitions", "v23SeriesPartHeads",
    "v23SkuDrawerHeads", "v23AffixDefinitions", "v23TechnologyDefinitions",
    "v23TechnologyHeads", "skuDrawers", "purchasableModels", "v3Affixes", "technologies",
    "qualityValuePolicyDrafts", "pricingPolicyDrafts", "parameters", "templates", "modifiers",
    "layers", "affixes", "qualityBands", "affixScorePolicy", "seriesShowcases",
    "ruleGraphs", "notes",
  ],
  preserved_frozen: [
    "ruleSetVersions", "performanceSummaryDefinitions", "projectionPatches",
    "v23SeriesPartRevisions", "v23SkuDrawerRevisions", "v23FunctionTemplates",
    "partConstraintSets", "candidateSearchRecipes", "configurationSnapshots",
    "reductionStackingPolicyVersions",
    "fiveAxisDispositionCatalogRevisions", "fiveAxisViewDefinitions", "fiveAxisVertexSets",
    "currentFiveAxisDispositionCatalogRevisionId", "patchReviewBatches",
    "patchValidationWaivers", "patchValidationWaiverDecisions", "ruleChangeProposals",
    "revisions", "performanceProfiles", "recipes", "candidates", "officialSkus",
    "detailOverrides",
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

const column = (name, format, type = "string") => ({ name, type, required: true, format });
const EXPECTED_SHEETS = {
  __TF_MANIFEST: {
    kind: "machine",
    columns: [
      column("contract_version", "literal:project-workbook/v1"),
      column("workspace_id", "stable-id"),
      column("base_workspace_revision", "safe-integer-text"),
      column("root_manifest_sha256", "lowercase-sha256"),
      column("workbook_schema_sha256", "lowercase-sha256"),
      column("exporter_version", "stable-version"),
      column("machine_content_sha256", "lowercase-sha256"),
    ],
    primaryKey: ["contract_version"],
    cardinality: "EXACTLY_ONE",
  },
  __TF_CURRENT: {
    kind: "machine",
    columns: [
      column("root", "workspace-root"), column("record_schema_id", "stable-id"),
      column("record_key", "rfc8785-key-json"),
      column("record_revision", "canonical-revision-or-null"),
      column("record_content_sha256", "lowercase-sha256"),
      column("payload_json", "rfc8785-json"),
    ],
    primaryKey: ["root", "record_key"],
    cardinality: "ZERO_OR_MORE",
  },
  __TF_PRESERVED: {
    kind: "machine",
    columns: [
      column("root", "workspace-root"), column("record_key", "rfc8785-key-json"),
      column("record_revision", "canonical-revision-or-null"),
      column("record_content_sha256", "lowercase-sha256"),
      column("opaque_canonical_payload_json", "rfc8785-json"),
    ],
    primaryKey: ["root", "record_key"],
    cardinality: "ZERO_OR_MORE",
  },
  __TF_SERVER_REFS: {
    kind: "machine",
    columns: [
      column("root", "workspace-root"), column("classification", "literal:server_owned"),
      column("root_content_sha256", "lowercase-sha256"),
      column("opaque_server_ref", "opaque-token-or-null"),
    ],
    primaryKey: ["root"],
    cardinality: "EXACTLY_ALL_SERVER_OWNED_ROOTS",
  },
  __TF_FORBIDDEN: {
    kind: "machine",
    columns: [
      column("root", "workspace-root"), column("classification", "literal:forbidden"),
      column("policy_marker", "literal:FORBIDDEN_PAYLOAD_OMITTED"),
    ],
    primaryKey: ["root"],
    cardinality: "EXACTLY_ALL_FORBIDDEN_ROOTS",
  },
  __TF_DIAGNOSTICS: {
    kind: "machine",
    columns: [
      column("root", "workspace-root"), column("record_key", "rfc8785-key-json"),
      column("diagnostic_schema_version", "literal:project-workbook-diagnostic/v1"),
      column("severity", "diagnostic-severity"), column("code", "stable-code"),
      column("message", "display-text"), column("subject_ref", "opaque-token-or-null"),
      column("diagnostic_evidence_sha256", "lowercase-sha256"),
    ],
    primaryKey: ["root", "record_key", "code"],
    cardinality: "ZERO_OR_MORE",
  },
  README: {
    kind: "derived_readable",
    columns: [column("section", "display-text"), column("content", "display-text")],
    primaryKey: ["section"],
    cardinality: "ONE_OR_MORE",
  },
  ROOT_SUMMARY: {
    kind: "derived_readable",
    columns: [
      column("root", "workspace-root"), column("classification", "classification"),
      column("record_count", "safe-integer-text"),
      column("root_content_sha256", "lowercase-sha256"), column("status", "stable-code"),
    ],
    primaryKey: ["root"],
    cardinality: "EXACTLY_93",
  },
};

const EXPECTED_RECORD_SCHEMAS_SHA256 =
  "038180ffbae6a7a7dde69a670cdea0d01be291fca70caf873894e41f1e70f23b";
const EXPECTED_RECORD_SCHEMA_AUTHORITY_SHA256 =
  "bec1fb7e3f8bde5dd82d2a6f3c9a2777bc92dd3f0000380e92bbddeee2fc5c70";

function fail(message) {
  throw new Error(message);
}

function sha256(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), "canonical JSON rejects non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key.normalize("NFC"))}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function validateMachineCell(columnSchema, value, cellKind = "string") {
  assert.equal(cellKind, "string", `${columnSchema.name} rejects Excel ${cellKind} cells`);
  assert.equal(typeof value, "string", `${columnSchema.name} must be encoded as text`);
  assert.notEqual(value, "", `${columnSchema.name} rejects blank cells`);
  const format = columnSchema.format;
  if (format === "safe-integer-text") {
    assert.match(value, /^(0|[1-9][0-9]*)$/);
    assert.ok(BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER), `${columnSchema.name} is not safe`);
  } else if (format === "lowercase-sha256") {
    assert.match(value, /^[0-9a-f]{64}$/);
  } else if (format === "canonical-revision-or-null") {
    assert.ok(value === "null" || /^(0|[1-9][0-9]*)$/.test(value) || /^[A-Za-z0-9._:-]+$/.test(value));
  } else if (format === "opaque-token-or-null") {
    assert.ok(value === "null" || /^opaque_[A-Za-z0-9_-]{22,}$/.test(value));
  } else if (format === "rfc8785-json" || format === "rfc8785-key-json") {
    const parsed = JSON.parse(value);
    assert.equal(canonicalJson(parsed), value, `${columnSchema.name} must use canonical JSON`);
    if (format === "rfc8785-key-json") assert.ok(Array.isArray(parsed));
  } else if (format.startsWith("literal:")) {
    assert.equal(value, format.slice("literal:".length));
  }
  return true;
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

function parseTypeDeclarations(source) {
  const declarations = new Map();
  const pattern = /^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const tail = source.slice(match.index + match[0].length);
    const opening = tail.search(/[={]/);
    if (opening < 0) continue;
    const absolute = match.index + match[0].length + opening;
    if (source[absolute] === "{") {
      declarations.set(name, source.slice(absolute + 1, matchingBrace(source, absolute)));
      continue;
    }
    let depth = 0;
    let end = absolute + 1;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if ("{[(".includes(character)) depth += 1;
      if ("}])".includes(character)) depth -= 1;
      if (character === ";" && depth === 0) break;
    }
    declarations.set(name, source.slice(absolute + 1, end));
  }
  return declarations;
}

function interfaceProjectionBody(source, typeName, allowedFields) {
  const declaration = source.match(
    new RegExp(`\\bexport\\s+interface\\s+${typeName}\\s*(?:extends[^\\{]+)?\\{`),
  );
  if (!declaration || declaration.index === undefined) return null;
  const openingIndex = source.indexOf("{", declaration.index);
  const body = source.slice(openingIndex + 1, matchingBrace(source, openingIndex));
  const segments = [];
  let depth = 0;
  let segment = "";
  for (const character of body) {
    segment += character;
    if ("{[(".includes(character)) depth += 1;
    if ("}])".includes(character)) depth -= 1;
    if (character === ";" && depth === 0) {
      const name = segment.replace(/\/\*[\s\S]*?\*\//g, "").trim()
        .match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\?)?:/)?.[1];
      if (name && allowedFields.includes(name)) segments.push(segment);
      segment = "";
    }
  }
  return segments.join("");
}

export function recursiveProjectionGraphHash(manifest, sourceByPath) {
  const declarations = new Map();
  for (const [sourcePath, source] of sourceByPath) {
    for (const [name, body] of parseTypeDeclarations(source)) {
      declarations.set(`${sourcePath}#${name}`, body);
      if (!declarations.has(name)) declarations.set(name, body);
    }
  }
  const proof = [];
  for (const root of manifest.recordSchemaAuthority.recursiveProofRoots) {
    const typeRef = manifest.recordSchemaAuthority.typeRefs[root];
    const [sourcePath, typeName] = typeRef.split("#");
    if (typeName === "string") {
      proof.push(`${root}:scalar:string`);
      continue;
    }
    const source = sourceByPath.get(sourcePath);
    const projected = interfaceProjectionBody(
      source,
      typeName,
      manifest.recordSchemas[root].allowedFields,
    ) ?? declarations.get(`${sourcePath}#${typeName}`);
    assert.ok(projected, `${root} recursive type graph is unresolved`);
    const queue = [[`${sourcePath}#${typeName}`, projected]];
    const visited = new Set();
    while (queue.length > 0) {
      const [name, body] = queue.shift();
      if (visited.has(name)) continue;
      visited.add(name);
      const semanticBody = body
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const typeTokens = semanticBody.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
      assert.doesNotMatch(
        typeTokens,
        /\b(?:unknown|any)\b/,
        `${root} has an unresolved dynamic value in ${name}`,
      );
      proof.push(`${root}:${name}:${sha256(semanticBody.replace(/\s+/g, " ").trim())}`);
      for (const identifier of semanticBody.match(/\b[A-Z][A-Za-z0-9_$]*\b/g) ?? []) {
        const nested = declarations.get(`${sourcePath}#${identifier}`) ?? declarations.get(identifier);
        if (nested) queue.push([identifier, nested]);
      }
    }
  }
  return sha256(proof.sort().join("\n"));
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
  assert.equal(new Set(manifest.workbookSchema.sheetOrder).size, 8);
  for (const [sheetName, sheet] of Object.entries(manifest.workbookSchema.sheets)) {
    assertExactKeys(sheet, ["kind", "columns", "primaryKey", "cardinality"], `sheet ${sheetName}`);
    assert.ok(["machine", "derived_readable"].includes(sheet.kind));
    assert.ok(Array.isArray(sheet.columns) && sheet.columns.length > 0);
    assert.equal(
      new Set(sheet.columns.map((entry) => entry.name)).size,
      sheet.columns.length,
      `${sheetName} has duplicate columns`,
    );
    for (const entry of sheet.columns) {
      assertExactKeys(entry, ["name", "type", "required", "format"], `${sheetName}.${entry.name}`);
      assert.equal(entry.type, "string", `${sheetName}.${entry.name} must be text-only`);
      assert.equal(entry.required, true, `${sheetName}.${entry.name} must reject blank cells`);
      assert.ok(entry.format.length > 0, `${sheetName}.${entry.name} needs an exact format`);
    }
    assert.ok(sheet.primaryKey.every((name) => sheet.columns.some((entry) => entry.name === name)));
  }
  assert.deepEqual(Object.keys(manifest.workbookSchema.classificationProjection), CLASSIFICATIONS);
  assert.deepEqual(manifest.workbookSchema.classificationProjection, {
    importable_current: { sheet: "__TF_CURRENT", payloadPolicy: "CLOSED_RECORD_SCHEMA" },
    preserved_frozen: { sheet: "__TF_PRESERVED", payloadPolicy: "OPAQUE_EXACT_SERVER_EXPORT_ONLY" },
    server_owned: { sheet: "__TF_SERVER_REFS", payloadPolicy: "HASH_AND_OPAQUE_REF_ONLY" },
    forbidden: {
      sheet: "__TF_FORBIDDEN",
      payloadPolicy: "CONSTANT_OMISSION_MARKER_ONLY_NO_CONTENT_DERIVED_HASH_OR_REF",
    },
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
    "preservedRootCatalog",
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
    "__TF_SERVER_REFS",
    "__TF_FORBIDDEN",
  ]);
  assert.deepEqual(manifest.canonicalization.machineContentHashExcludes, [
    "__TF_MANIFEST.machine_content_sha256",
    "__TF_DIAGNOSTICS",
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
    "projectionExclusions",
    "recursiveProofRoots",
    "recursiveTypeGraphSha256",
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
  assert.deepEqual(manifest.recordSchemaAuthority.recursiveProofRoots,
    EXPECTED_ROOT_CLASSIFICATIONS.importable_current);
  assert.deepEqual(manifest.recordSchemaAuthority.projectionExclusions, {
    skuDrawers: ["projectionMatch", "fiveAxisProjectionReferences", "validationSummary"],
    qualityValuePolicyDrafts: ["issues"],
    pricingPolicyDrafts: ["issues"],
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
    for (const excluded of manifest.recordSchemaAuthority.projectionExclusions[root] ?? []) {
      assert.ok(!schema.allowedFields.includes(excluded), `${root}.${excluded} must be rederived`);
    }
  }
  assert.deepEqual(manifest.recordSchemas.v23TechnologyDefinitions.identityFields,
    ["technologyId", "revision"]);
  assert.deepEqual(manifest.recordSchemas.v23AffixDefinitions.identityFields,
    ["affixId", "revision"]);
  for (const root of ["v3Affixes", "technologies", "ruleGraphs"]) {
    assert.ok(manifest.recordSchemas[root].identityFields.includes(
      manifest.recordSchemas[root].revisionFields[0],
    ), `${root} version must participate in workbook primary identity`);
  }

  assert.deepEqual(
    Object.keys(manifest.preservedRootCatalog),
    EXPECTED_ROOT_CLASSIFICATIONS.preserved_frozen,
    "every frozen root must bind one carrier and stable record identity",
  );
  for (const [root, catalog] of Object.entries(manifest.preservedRootCatalog)) {
    assertExactKeys(catalog, [
      "carrier", "recordKeyFields", "revisionFields", "hashFields", "singleton",
    ], `preserved root ${root}`);
    assert.ok(["records", "whole_root_singleton"].includes(catalog.carrier));
    assert.ok(catalog.recordKeyFields.length > 0, `${root} needs a stable record key`);
    assert.equal(new Set(catalog.recordKeyFields).size, catalog.recordKeyFields.length);
    assert.equal(catalog.singleton, catalog.carrier === "whole_root_singleton");
    if (catalog.singleton) assert.deepEqual(catalog.recordKeyFields, ["$singleton"]);
    if (!catalog.singleton) assert.ok(!catalog.recordKeyFields.includes("$singleton"));
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
  const sourceByPath = new Map();
  for (const source of manifest.recordSchemaAuthority.sources) {
    assertExactKeys(source, ["path", "sha256"], `record schema source ${source.path}`);
    const sourceText = readFileSync(path.join(root, source.path), "utf8");
    sourceByPath.set(source.path, sourceText);
    assert.equal(
      sha256(sourceText),
      source.sha256,
      `record schema source hash drift: ${source.path}`,
    );
  }
  assert.equal(
    recursiveProjectionGraphHash(manifest, sourceByPath),
    manifest.recordSchemaAuthority.recursiveTypeGraphSha256,
    "recursive closed projection graph drift",
  );
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
