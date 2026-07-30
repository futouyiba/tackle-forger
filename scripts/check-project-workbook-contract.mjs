#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
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
  "preservedSchemaCatalog",
  "preservedSchemaAuthority",
  "diagnosticRootCatalog",
  "serverOwnedRootCatalog",
  "conditionalExactFieldPolicies",
  "serverOwnedInvariants",
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
    "compatibilityRules", "affinityRules",
    "affinityAxisWeights", "collections",
    "v23TechnologyDefinitions",
    "skuDrawers", "purchasableModels", "v3Affixes", "technologies",
    "parameters", "templates", "modifiers",
    "layers", "affixes", "qualityBands", "affixScorePolicy", "seriesShowcases",
    "ruleGraphs", "notes",
  ],
  preserved_frozen: [
    "ruleSetVersions", "performanceSummaryDefinitions", "projectionPatches",
    "v23SeriesPartRevisions", "v23SkuDrawerRevisions", "v23FunctionTemplates",
    "candidateSearchRecipes", "configurationSnapshots",
    "reductionStackingPolicyVersions",
    "fiveAxisDispositionCatalogRevisions", "fiveAxisViewDefinitions", "fiveAxisVertexSets",
    "currentFiveAxisDispositionCatalogRevisionId", "patchReviewBatches",
    "patchValidationWaivers", "patchValidationWaiverDecisions", "ruleChangeProposals",
    "revisions", "performanceProfiles", "recipes", "candidates", "officialSkus",
    "detailOverrides",
  ],
  server_owned: [
    "workspaceId", "schemaVersion", "configIdGovernance", "patchLedger",
    "v23SeriesPartHeads", "v23SkuDrawerHeads", "partConstraintSets",
    "qualityProfiles", "seriesDefinitions", "v23AffixDefinitions", "v23TechnologyHeads",
    "canonicalRuleSourceDrafts", "weightTemplatePolicyDrafts",
    "qualityValuePolicyDrafts", "pricingPolicyDrafts", "workspacePolicies",
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

const EXPECTED_PRESERVED_VARIANT_SCHEMA_IDS = {
  fiveAxisVertexSets: {
    LegacyFiveAxisVertexSet: "project-workbook/preserved/fiveAxisVertexSets/legacy-v1",
    FiveAxisVertexSet: "project-workbook/preserved/fiveAxisVertexSets/current-v1",
  },
};

const EXPECTED_SERVER_OWNED_INVARIANTS = {
  qualityProfiles: [
    { id: "quality_c_green", letter: "C", colorName: "绿", rank: 1, enabled: true },
    { id: "quality_b_blue", letter: "B", colorName: "蓝", rank: 2, enabled: true },
    { id: "quality_a_purple", letter: "A", colorName: "紫", rank: 3, enabled: true },
    { id: "quality_s_orange", letter: "S", colorName: "橙", rank: 4, enabled: true },
  ],
};

const EXPECTED_SERVER_OWNED_ROOT_CATALOG = Object.fromEntries(
  EXPECTED_ROOT_CLASSIFICATIONS.server_owned.map((root) => [
    root,
    {
      hashPolicy: "NO_CONTENT_HASH",
      refPolicy: "OPAQUE_NON_REPLAYABLE",
    },
  ]),
);

const EXPECTED_CONDITIONAL_EXACT_FIELD_POLICIES = {
  purchasableModels: {
    whenExistingFieldPresent: "configIdBundleRef",
    exactFields: ["skuId", "stableModelKey", "configIdBundleRef"],
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
      column("record_revision", "rfc8785-revision-scalar"),
      column("record_content_sha256", "lowercase-sha256"),
      column("payload_json", "rfc8785-json"),
    ],
    primaryKey: ["root", "record_key"],
    cardinality: "ZERO_OR_MORE",
  },
  __TF_PRESERVED: {
    kind: "machine",
    columns: [
      column("root", "workspace-root"), column("record_schema_id", "stable-id"),
      column("record_key", "rfc8785-key-json"),
      column("record_revision", "rfc8785-revision-scalar"),
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
      column("root_content_sha256", "literal:null"),
      column("opaque_server_ref", "opaque-token"),
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
      column("subject_payload_json", "diagnostic-subject-json"),
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
      column("root_content_sha256", "lowercase-sha256-or-null"), column("status", "stable-code"),
    ],
    primaryKey: ["root"],
    cardinality: "EXACTLY_93",
  },
};

const EXPECTED_RECORD_SCHEMAS_SHA256 =
  "8a0d59f3ee6ba9fb02a9f1fc0c4900ddf559aadcad8ea61bdf1dc8391d188d03";
const EXPECTED_RECORD_SCHEMA_AUTHORITY_SHA256 =
  "8f0f5aca8831899913ed52a18ec66e874400e0d5f2d9d55516d27c7e1652ac51";

function fail(message) {
  throw new Error(message);
}

function sha256(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function normalizeUnicodeString(value, label = "canonical JSON string") {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      assert.ok(
        next >= 0xDC00 && next <= 0xDFFF,
        `${label} rejects unpaired UTF-16 surrogate`,
      );
      index += 1;
      continue;
    }
    assert.ok(
      codeUnit < 0xDC00 || codeUnit > 0xDFFF,
      `${label} rejects unpaired UTF-16 surrogate`,
    );
  }
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(normalizeUnicodeString(value));
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), "canonical JSON rejects non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  const normalizedEntries = Object.keys(value).map(
    (key) => [normalizeUnicodeString(key, "canonical JSON key"), value[key]],
  );
  assert.equal(
    new Set(normalizedEntries.map(([key]) => key)).size,
    normalizedEntries.length,
    "canonical JSON rejects NFC key collisions",
  );
  return `{${normalizedEntries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
    .join(",")}}`;
}

function expectedRecordKeyFields(manifest, root, variant) {
  const schema = manifest.recordSchemas[root];
  if (schema) return schema.identityFields;
  const catalog = manifest.preservedRootCatalog[root];
  assert.ok(catalog, `record key root ${root} is not importable or preserved`);
  if (catalog.carrier !== "variant_records") return catalog.recordKeyFields;
  const selected = catalog.variants.find((entry) => entry.type === variant);
  assert.ok(selected, `${root} requires an explicit preserved union variant`);
  return selected.recordKeyFields;
}

function resolvePayloadVariant(manifest, root, payload, callerVariant, repositoryRoot) {
  const catalog = manifest.preservedRootCatalog[root];
  if (!catalog || catalog.carrier !== "variant_records") {
    assert.equal(callerVariant, undefined, `${root} does not accept a caller variant`);
    return undefined;
  }
  assert.ok(payload && Object.getPrototypeOf(payload) === Object.prototype,
    `${root} variant resolution requires an object payload`);
  const [sourcePath] = catalog.typeRef.split("#");
  const source = readFileSync(path.join(repositoryRoot, sourcePath), "utf8");
  const candidates = catalog.variants.filter((variant) => {
    const fields = interfaceFieldDefinitions(source, variant.type);
    if (!fields) return false;
    if (!Object.keys(payload).every((field) => fields.has(field))) return false;
    return variant.recordKeyFields.every(
      (field) => valueAtFieldPath(payload, field) !== undefined,
    );
  });
  assert.equal(candidates.length, 1, `${root} payload must prove exactly one closed union variant`);
  const resolved = candidates[0].type;
  if (callerVariant !== undefined) {
    assert.equal(callerVariant, resolved, `${root} caller variant contradicts the closed payload`);
  }
  return resolved;
}

function expectedRecordSchemaId(manifest, root, payload, callerVariant, repositoryRoot) {
  validateRecordPayloadRepresentation(manifest, root, payload);
  const importableSchema = manifest.recordSchemas[root];
  if (importableSchema) {
    assert.equal(callerVariant, undefined, `${root} does not accept a caller variant`);
    return importableSchema.schemaId;
  }
  const catalog = manifest.preservedSchemaCatalog[root];
  assert.ok(catalog, `${root} has no versioned record schema`);
  const variant = resolvePayloadVariant(
    manifest,
    root,
    payload,
    callerVariant,
    repositoryRoot,
  );
  return typeof catalog === "string" ? catalog : catalog[variant];
}

function splitTopLevelType(source, delimiter) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if ("{[(<".includes(character)) depth += 1;
    else if ("}])>".includes(character)) depth -= 1;
    else if (character === delimiter && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function stripOuterTypeParentheses(type) {
  let current = type.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0;
    let closesAtEnd = false;
    for (let index = 0; index < current.length; index += 1) {
      if (current[index] === "(") depth += 1;
      else if (current[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          closesAtEnd = index === current.length - 1;
          break;
        }
      }
    }
    if (!closesAtEnd) break;
    current = current.slice(1, -1).trim();
  }
  return current;
}

function inlineFieldDefinitions(body) {
  const cleaned = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const fields = new Map();
  let depth = 0;
  let segment = "";
  for (const character of cleaned) {
    segment += character;
    if ("{[(".includes(character)) depth += 1;
    if ("}])".includes(character)) depth -= 1;
    if (character === ";" && depth === 0) {
      const field = segment.trim().match(
        /^(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(\?)?:\s*([\s\S]*);$/,
      );
      assert.ok(field, `closed record schema cannot parse field declaration: ${segment.trim()}`);
      fields.set(field[1], { optional: field[2] === "?", type: field[3].trim() });
      segment = "";
    }
  }
  if (segment.trim()) {
    const field = `${segment.trim()};`.match(
      /^(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(\?)?:\s*([\s\S]*);$/,
    );
    assert.ok(field, `closed record schema cannot parse final field: ${segment.trim()}`);
    fields.set(field[1], { optional: field[2] === "?", type: field[3].trim() });
  }
  return fields;
}

function closedInterfaceFields(source, interfaceName, visited = new Set()) {
  assert.ok(!visited.has(interfaceName), `closed record schema has cyclic interface ${interfaceName}`);
  const own = interfaceFieldDefinitions(source, interfaceName);
  if (!own) return null;
  const fields = new Map();
  const declaration = source.match(
    new RegExp(`\\bexport\\s+interface\\s+${interfaceName}\\s*(?:extends\\s+([^\\{]+))?\\{`),
  );
  const nextVisited = new Set(visited).add(interfaceName);
  for (const base of splitTopLevelType(declaration?.[1] ?? "", ",")) {
    if (!base) continue;
    const baseName = base.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/)?.[1];
    assert.ok(baseName, `${interfaceName} has an unsupported generic interface base ${base}`);
    const inherited = closedInterfaceFields(source, baseName, nextVisited);
    assert.ok(inherited, `${interfaceName} base ${baseName} is unresolved`);
    for (const [name, definition] of inherited) fields.set(name, definition);
  }
  for (const [name, definition] of own) fields.set(name, definition);
  return fields;
}

function assertClosedJsonNumber(value, label) {
  assert.ok(typeof value === "number" && Number.isFinite(value), `${label} must be a finite number`);
  if (Number.isInteger(value)) {
    assert.ok(Number.isSafeInteger(value), `${label} integer must be safe`);
  }
}

function parseTypeLiteralValue(type) {
  if (type === "true") return true;
  if (type === "false") return false;
  if (type === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(type)) return Number(type);
  if (/^"(?:\\.|[^"\\])*"$/.test(type)) return JSON.parse(type);
  if (/^'(?:\\.|[^'\\])*'$/.test(type)) {
    return type.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
  return undefined;
}

function stringKeyContract(source, declarations, keyType, label, depth) {
  const type = stripOuterTypeParentheses(keyType);
  if (type === "string") return { dynamic: true, keys: [] };
  const members = splitTopLevelType(type, "|").filter(Boolean);
  if (members.length > 1) {
    const keys = members.map((member) => {
      const literal = parseTypeLiteralValue(member);
      assert.equal(typeof literal, "string", `${label} record key union must contain only strings`);
      return literal;
    });
    return { dynamic: false, keys };
  }
  const alias = declarations.get(type);
  assert.ok(alias && depth < 64, `${label} record key type ${type} is unresolved`);
  return stringKeyContract(source, declarations, alias, label, depth + 1);
}

function closedFieldsForType(source, declarations, rawType, visited = new Set()) {
  const type = stripOuterTypeParentheses(rawType);
  const intersection = splitTopLevelType(type, "&").filter(Boolean);
  if (intersection.length > 1) {
    const combined = new Map();
    for (const member of intersection) {
      const fields = closedFieldsForType(source, declarations, member, visited);
      if (!fields) return null;
      for (const [name, definition] of fields) combined.set(name, definition);
    }
    return combined;
  }
  if (type.startsWith("{") && type.endsWith("}")) {
    return inlineFieldDefinitions(type.slice(1, -1));
  }
  const interfaceFields = closedInterfaceFields(source, type);
  if (interfaceFields) return interfaceFields;
  if (visited.has(type)) return null;
  const alias = declarations.get(type);
  if (!alias) return null;
  return closedFieldsForType(source, declarations, alias, new Set(visited).add(type));
}

function assertClosedTypeGrammar(source, declarations, rawType, label, visited = new Set()) {
  const type = stripOuterTypeParentheses(rawType.replace(/^readonly\s+/, "").trim());
  const union = splitTopLevelType(type, "|").filter(Boolean);
  if (union.length > 1) {
    for (const member of union) {
      assertClosedTypeGrammar(source, declarations, member, label, visited);
    }
    return;
  }
  const intersection = splitTopLevelType(type, "&").filter(Boolean);
  if (intersection.length > 1) {
    const fields = closedFieldsForType(source, declarations, type);
    assert.ok(fields, `${label} intersection must resolve to closed object fields`);
    for (const [name, definition] of fields) {
      assertClosedTypeGrammar(source, declarations, definition.type, `${label}.${name}`, visited);
    }
    return;
  }
  if (type.endsWith("[]")) {
    assertClosedTypeGrammar(source, declarations, type.slice(0, -2), `${label}[]`, visited);
    return;
  }
  const propertyAccess = type.match(
    /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\[\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']\s*\]$/,
  );
  if (propertyAccess) {
    const fields = closedFieldsForType(source, declarations, propertyAccess[1]);
    const definition = fields?.get(propertyAccess[2]);
    assert.ok(definition, `${label} indexed property ${type} is unresolved`);
    assertClosedTypeGrammar(source, declarations, definition.type, label, visited);
    return;
  }
  const arrayElementAccess = type.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\[\s*number\s*\]$/);
  if (arrayElementAccess) {
    const alias = declarations.get(arrayElementAccess[1]);
    assert.ok(alias, `${label} indexed array ${type} is unresolved`);
    const arrayType = stripOuterTypeParentheses(alias);
    const elementType = arrayType.endsWith("[]")
      ? arrayType.slice(0, -2)
      : arrayType.match(/^(?:Array|ReadonlyArray)\s*<([\s\S]+)>$/)?.[1];
    assert.ok(elementType, `${label} indexed array ${type} is not an array alias`);
    assertClosedTypeGrammar(source, declarations, elementType, label, visited);
    return;
  }
  const generic = type.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*<([\s\S]+)>$/);
  if (generic) {
    const parameters = splitTopLevelType(generic[2], ",");
    if (generic[1] === "Array" || generic[1] === "ReadonlyArray") {
      assert.equal(parameters.length, 1, `${label} array type arity mismatch`);
      assertClosedTypeGrammar(source, declarations, parameters[0], `${label}[]`, visited);
      return;
    }
    if (generic[1] === "Record") {
      assert.equal(parameters.length, 2, `${label} record type arity mismatch`);
      stringKeyContract(source, declarations, parameters[0], label, 0);
      assert.doesNotMatch(
        parameters[1].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, ""),
        /\b(?:unknown|any)\b/,
        `${label} dynamic values are forbidden in importable payloads`,
      );
      assertClosedTypeGrammar(source, declarations, parameters[1], `${label}.*`, visited);
      return;
    }
    if (generic[1] === "Partial" || generic[1] === "Readonly") {
      assert.equal(parameters.length, 1, `${label} ${generic[1]} type arity mismatch`);
      assertClosedTypeGrammar(source, declarations, parameters[0], label, visited);
      return;
    }
    assert.fail(`${label} uses unsupported generic type ${generic[1]}`);
  }
  if (type.startsWith("[") && type.endsWith("]")) {
    for (const [index, element] of splitTopLevelType(type.slice(1, -1), ",").entries()) {
      assertClosedTypeGrammar(source, declarations, element, `${label}[${index}]`, visited);
    }
    return;
  }
  if (type.startsWith("{") && type.endsWith("}")) {
    for (const [name, definition] of inlineFieldDefinitions(type.slice(1, -1))) {
      assertClosedTypeGrammar(source, declarations, definition.type, `${label}.${name}`, visited);
    }
    return;
  }
  if (["string", "number", "boolean", "null", "undefined", "void"].includes(type)) return;
  if (parseTypeLiteralValue(type) !== undefined) return;
  assert.doesNotMatch(
    type,
    /^(?:unknown|any|object)$/,
    `${label} dynamic type ${type} is forbidden in importable payloads`,
  );
  if (visited.has(type)) return;
  const fields = closedInterfaceFields(source, type);
  const nextVisited = new Set(visited).add(type);
  if (fields) {
    for (const [name, definition] of fields) {
      assertClosedTypeGrammar(source, declarations, definition.type, `${label}.${name}`, nextVisited);
    }
    return;
  }
  const alias = declarations.get(type);
  assert.ok(alias, `${label} type ${type} is unresolved`);
  assertClosedTypeGrammar(source, declarations, alias, label, nextVisited);
}

function assertClosedTypeValue(
  source,
  declarations,
  rawType,
  value,
  label,
  depth = 0,
  { optionalAll = false } = {},
) {
  assert.ok(depth < 64, `${label} exceeds the closed recursive type depth`);
  let type = stripOuterTypeParentheses(rawType.replace(/^readonly\s+/, "").trim());
  const union = splitTopLevelType(type, "|").filter(Boolean);
  if (union.length > 1) {
    const matches = [];
    for (const member of union) {
      try {
        assertClosedTypeValue(source, declarations, member, value, label, depth + 1);
        matches.push(member);
      } catch {
        // A closed union is accepted only when the payload proves exactly one member.
      }
    }
    assert.equal(matches.length, 1, `${label} must prove exactly one closed union variant`);
    return;
  }
  const intersection = splitTopLevelType(type, "&").filter(Boolean);
  if (intersection.length > 1) {
    const fields = closedFieldsForType(source, declarations, type);
    assert.ok(fields, `${label} intersection must resolve to closed object fields`);
    assertClosedObjectFields(source, declarations, fields, value, label, depth + 1);
    return;
  }
  if (type.endsWith("[]")) {
    assert.ok(Array.isArray(value), `${label} must be an array`);
    const elementType = type.slice(0, -2).trim();
    value.forEach((entry, index) => {
      assertClosedTypeValue(source, declarations, elementType, entry, `${label}[${index}]`, depth + 1);
    });
    return;
  }
  const propertyAccess = type.match(
    /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\[\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']\s*\]$/,
  );
  if (propertyAccess) {
    const fields = closedFieldsForType(source, declarations, propertyAccess[1]);
    const definition = fields?.get(propertyAccess[2]);
    assert.ok(definition, `${label} indexed property ${type} is unresolved`);
    assertClosedTypeValue(
      source,
      declarations,
      definition.type,
      value,
      label,
      depth + 1,
    );
    return;
  }
  const arrayElementAccess = type.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\[\s*number\s*\]$/);
  if (arrayElementAccess) {
    const alias = declarations.get(arrayElementAccess[1]);
    assert.ok(alias, `${label} indexed array ${type} is unresolved`);
    const arrayType = stripOuterTypeParentheses(alias);
    const elementType = arrayType.endsWith("[]")
      ? arrayType.slice(0, -2)
      : arrayType.match(/^(?:Array|ReadonlyArray)\s*<([\s\S]+)>$/)?.[1];
    assert.ok(elementType, `${label} indexed array ${type} is not an array alias`);
    assertClosedTypeValue(source, declarations, elementType, value, label, depth + 1);
    return;
  }
  const generic = type.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*<([\s\S]+)>$/);
  if (generic) {
    const parameters = splitTopLevelType(generic[2], ",");
    if (generic[1] === "Array" || generic[1] === "ReadonlyArray") {
      assert.equal(parameters.length, 1, `${label} array type arity mismatch`);
      assert.ok(Array.isArray(value), `${label} must be an array`);
      value.forEach((entry, index) => {
        assertClosedTypeValue(
          source,
          declarations,
          parameters[0],
          entry,
          `${label}[${index}]`,
          depth + 1,
        );
      });
      return;
    }
    if (generic[1] === "Record") {
      assert.equal(parameters.length, 2, `${label} record type arity mismatch`);
      assert.ok(value && Object.getPrototypeOf(value) === Object.prototype,
        `${label} must be a closed record object`);
      const keyContract = stringKeyContract(
        source,
        declarations,
        parameters[0],
        label,
        depth + 1,
      );
      const actualKeys = Object.keys(value);
      for (const key of actualKeys) {
        assert.equal(key, key.normalize("NFC"), `${label} record key must be NFC text`);
      }
      if (!keyContract.dynamic) {
        assert.deepEqual(
          [...actualKeys].sort(),
          [...keyContract.keys].sort(),
          `${label} must contain the complete closed record key set`,
        );
      }
      assert.doesNotMatch(
        parameters[1].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, ""),
        /\b(?:unknown|any)\b/,
        `${label} dynamic values are forbidden in importable payloads`,
      );
      for (const key of actualKeys) {
        assertClosedTypeValue(
          source,
          declarations,
          parameters[1],
          value[key],
          `${label}.${key}`,
          depth + 1,
        );
      }
      return;
    }
    if (generic[1] === "Partial" || generic[1] === "Readonly") {
      assert.equal(parameters.length, 1, `${label} ${generic[1]} type arity mismatch`);
      assertClosedTypeValue(
        source,
        declarations,
        parameters[0],
        value,
        label,
        depth + 1,
        { optionalAll: generic[1] === "Partial" },
      );
      return;
    }
    assert.fail(`${label} uses unsupported generic type ${generic[1]}`);
  }
  if (type.startsWith("[") && type.endsWith("]")) {
    const elements = splitTopLevelType(type.slice(1, -1), ",");
    assert.ok(Array.isArray(value), `${label} must be a tuple`);
    assert.equal(value.length, elements.length, `${label} tuple arity mismatch`);
    elements.forEach((element, index) => {
      assertClosedTypeValue(source, declarations, element, value[index], `${label}[${index}]`, depth + 1);
    });
    return;
  }
  if (type.startsWith("{") && type.endsWith("}")) {
    assertClosedObjectFields(
      source,
      declarations,
      inlineFieldDefinitions(type.slice(1, -1)),
      value,
      label,
      depth + 1,
      { optionalAll },
    );
    return;
  }
  if (type === "string") {
    assert.ok(typeof value === "string" && value === value.normalize("NFC"), `${label} must be NFC text`);
    return;
  }
  if (type === "number") {
    assertClosedJsonNumber(value, label);
    return;
  }
  if (type === "boolean") {
    assert.equal(typeof value, "boolean", `${label} must be boolean`);
    return;
  }
  if (type === "undefined" || type === "void") {
    assert.fail(`${label} cannot encode undefined in canonical JSON`);
  }
  if (type === "unknown" || type === "any" || type === "object") {
    assert.fail(`${label} dynamic type ${type} is forbidden in importable payloads`);
  }
  const literal = parseTypeLiteralValue(type);
  if (literal !== undefined || type === "null") {
    assert.equal(value, literal, `${label} must equal the declared literal`);
    return;
  }
  const fields = closedInterfaceFields(source, type);
  if (fields) {
    assertClosedObjectFields(
      source,
      declarations,
      fields,
      value,
      label,
      depth + 1,
      { optionalAll },
    );
    return;
  }
  const alias = declarations.get(type);
  assert.ok(alias, `${label} type ${type} is unresolved`);
  assertClosedTypeValue(source, declarations, alias, value, label, depth + 1);
}

function assertClosedObjectFields(
  source,
  declarations,
  fields,
  value,
  label,
  depth,
  { allowedFields, optionalAll = false } = {},
) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype,
    `${label} must be a closed object`);
  const selectedNames = allowedFields ?? [...fields.keys()];
  for (const name of selectedNames) {
    assert.ok(fields.has(name), `${label}.${name} is absent from the bound TypeScript schema`);
  }
  const actualNames = Object.keys(value);
  for (const name of actualNames) {
    assert.ok(selectedNames.includes(name), `${label}.${name} is outside allowedFields`);
  }
  for (const name of selectedNames) {
    const definition = fields.get(name);
    if (!Object.hasOwn(value, name)) {
      assert.ok(optionalAll || definition.optional, `${label}.${name} is required`);
      continue;
    }
    assertClosedTypeValue(
      source,
      declarations,
      definition.type,
      value[name],
      `${label}.${name}`,
      depth + 1,
    );
  }
}

function validateImportableRecordPayload(manifest, root, payload, repositoryRoot) {
  const typeRef = manifest.recordSchemaAuthority.typeRefs[root];
  const schema = manifest.recordSchemas[root];
  assert.ok(typeRef && schema, `${root} has no importable record schema authority`);
  const [sourcePath, typeName] = typeRef.split("#");
  if (typeName === "string") {
    assert.equal(typeof payload, "string", `${root} payload must use its canonical scalar string representation`);
    assert.equal(payload, payload.normalize("NFC"), `${root} payload must be NFC text`);
    return;
  }
  const source = readFileSync(path.join(repositoryRoot, sourcePath), "utf8");
  const declarations = parseTypeDeclarations(source);
  const fields = closedInterfaceFields(source, typeName);
  if (fields) {
    assertClosedObjectFields(
      source,
      declarations,
      fields,
      payload,
      `${root} payload`,
      0,
      { allowedFields: schema.allowedFields },
    );
    return;
  }
  assertClosedTypeValue(source, declarations, typeName, payload, `${root} payload`);
}

export function validateImportableExactFields(
  manifest,
  root,
  candidatePayload,
  existingPayload,
  repositoryRoot = process.cwd(),
) {
  assert.ok(manifest.recordSchemas[root], `${root} is not an importable record root`);
  validateImportableRecordPayload(manifest, root, candidatePayload, repositoryRoot);
  if (existingPayload === undefined) return true;
  validateImportableRecordPayload(manifest, root, existingPayload, repositoryRoot);
  const conditionalPolicy = manifest.conditionalExactFieldPolicies[root];
  const conditionalFields = conditionalPolicy
    && valueAtFieldPath(existingPayload, conditionalPolicy.whenExistingFieldPresent) !== undefined
    ? conditionalPolicy.exactFields
    : [];
  const revisionFields = manifest.recordSchemas[root].revisionFields;
  for (const field of new Set([
    ...revisionFields,
    ...manifest.recordSchemas[root].exactFields,
    ...conditionalFields,
  ])) {
    const candidateValue = valueAtFieldPath(candidatePayload, field);
    const existingValue = valueAtFieldPath(existingPayload, field);
    if (revisionFields.includes(field)) {
      assert.notEqual(
        existingValue,
        undefined,
        `${root}.${field} existing revision is missing`,
      );
      assert.notEqual(
        candidateValue,
        undefined,
        `${root}.${field} candidate revision is missing`,
      );
    }
    if (candidateValue === undefined || existingValue === undefined) {
      assert.equal(
        candidateValue,
        existingValue,
        `${root}.${field} is exact-equal for an existing record`,
      );
      continue;
    }
    assert.equal(
      canonicalJson(candidateValue),
      canonicalJson(existingValue),
      `${root}.${field} is exact-equal for an existing record`,
    );
  }
  return true;
}

function validateRecordPayloadAgainstSchema(
  manifest,
  root,
  payload,
  repositoryRoot = process.cwd(),
  callerVariant,
) {
  const typeRef = manifest.recordSchemaAuthority.typeRefs[root]
    ?? manifest.preservedRootCatalog[root]?.typeRef;
  assert.ok(typeRef, `${root} has no record payload authority`);
  if (manifest.recordSchemas[root]) {
    assert.equal(callerVariant, undefined, `${root} does not accept a caller variant`);
    validateImportableRecordPayload(manifest, root, payload, repositoryRoot);
    return true;
  }
  if (typeRef === "lib/types.ts#string|null") {
    assert.ok(
      payload === null
        || (typeof payload === "string" && payload === payload.normalize("NFC")),
      `${root} payload must use its canonical nullable string representation`,
    );
    return true;
  }
  if (typeRef === "lib/types.ts#string") {
    assert.equal(
      typeof payload,
      "string",
      `${root} payload must use its canonical scalar string representation`,
    );
  } else {
    assert.ok(
      payload && Object.getPrototypeOf(payload) === Object.prototype,
      `${root} payload must use its canonical object representation`,
    );
  }
  return true;
}

function validateRecordPayloadRepresentation(manifest, root, payload) {
  const typeRef = manifest.recordSchemaAuthority.typeRefs[root]
    ?? manifest.preservedRootCatalog[root]?.typeRef;
  assert.ok(typeRef, `${root} has no record payload authority`);
  if (typeRef === "lib/types.ts#string|null") {
    assert.ok(
      payload === null || typeof payload === "string",
      `${root} payload must use its canonical nullable string representation`,
    );
    return true;
  }
  if (typeRef === "lib/types.ts#string") {
    assert.equal(
      typeof payload,
      "string",
      `${root} payload must use its canonical scalar string representation`,
    );
  } else {
    assert.ok(
      payload && Object.getPrototypeOf(payload) === Object.prototype,
      `${root} payload must use its canonical object representation`,
    );
  }
  return true;
}

function fieldPathType(source, typeName, fieldPath) {
  let currentType = typeName;
  let fieldType = "";
  for (const part of fieldPath.split(".")) {
    const fields = interfaceFieldTypes(source, currentType);
    assert.ok(fields, `record key type ${currentType} must resolve to an interface`);
    fieldType = fields.get(part);
    assert.ok(fieldType, `${typeName}.${fieldPath} is absent`);
    currentType = fieldType.match(/\b([A-Z][A-Za-z0-9_$]*)\b/)?.[1] ?? "";
  }
  return fieldType;
}

function fieldPathDefinition(source, typeName, fieldPath) {
  let currentType = typeName;
  let definition = null;
  let optional = false;
  for (const part of fieldPath.split(".")) {
    const fields = interfaceFieldDefinitions(source, currentType);
    assert.ok(fields, `revision type ${currentType} must resolve to an interface`);
    definition = fields.get(part);
    assert.ok(definition, `${typeName}.${fieldPath} is absent`);
    optional ||= definition.optional;
    currentType = definition.type.match(/\b([A-Z][A-Za-z0-9_$]*)\b/)?.[1] ?? "";
  }
  return { type: definition.type, optional };
}

function recordKeyComponentKinds(manifest, root, variant, repositoryRoot) {
  const fields = expectedRecordKeyFields(manifest, root, variant);
  if (fields.length === 1 && fields[0] === "$singleton") return ["singleton"];
  const schema = manifest.recordSchemas[root];
  const catalog = manifest.preservedRootCatalog[root];
  const typeRef = schema
    ? manifest.recordSchemaAuthority.typeRefs[root]
    : catalog.typeRef;
  const [sourcePath, defaultTypeName] = typeRef.split("#");
  const typeName = variant ?? defaultTypeName;
  const source = readFileSync(path.join(repositoryRoot, sourcePath), "utf8");
  const declarations = parseTypeDeclarations(source);
  return fields.map((field) => {
    let type = fieldPathType(source, typeName, field);
    const alias = type.match(/^\s*([A-Z][A-Za-z0-9_$]*)\s*$/)?.[1];
    if (alias && declarations.has(alias)) type = declarations.get(alias);
    const acceptsNumber = /\bnumber\b/.test(type);
    const acceptsString = /\bstring\b/.test(type) || /["'`][^"'`]*["'`]/.test(type);
    assert.ok(acceptsNumber || acceptsString, `${root}.${field} is not a scalar record-key type`);
    return acceptsNumber && acceptsString ? "string-or-safe-integer"
      : acceptsNumber ? "safe-integer" : "string";
  });
}

function revisionContract(manifest, root, variant, repositoryRoot) {
  const schema = manifest.recordSchemas[root];
  const catalog = manifest.preservedRootCatalog[root];
  assert.ok(schema || catalog, `revision root ${root} is not importable or preserved`);
  const selected = schema
    ? schema
    : catalog.carrier === "variant_records"
      ? catalog.variants.find((entry) => entry.type === variant)
      : catalog;
  assert.ok(selected, `${root} requires an explicit preserved union variant`);
  const typeRef = schema
    ? manifest.recordSchemaAuthority.typeRefs[root]
    : catalog.typeRef;
  const [sourcePath, defaultTypeName] = typeRef.split("#");
  const typeName = variant ?? defaultTypeName;
  if (selected.revisionFields.length === 0) {
    return { field: null, keyFields: selected.identityFields ?? selected.recordKeyFields };
  }
  assert.equal(selected.revisionFields.length, 1, `${root} row revision must be scalar`);
  const source = readFileSync(path.join(repositoryRoot, sourcePath), "utf8");
  const field = selected.revisionFields[0];
  const definition = fieldPathDefinition(source, typeName, field);
  let fieldType = definition.type;
  const alias = fieldType.match(/^\s*([A-Z][A-Za-z0-9_$]*)\s*$/)?.[1];
  if (alias) fieldType = parseTypeDeclarations(source).get(alias) ?? fieldType;
  const acceptsNumber = /\bnumber\b/.test(fieldType);
  const acceptsString = /\bstring\b/.test(fieldType) || /["'`][^"'`]*["'`]/.test(fieldType);
  assert.notEqual(acceptsNumber, acceptsString, `${root}.${field} revision must have one scalar type`);
  return {
    field,
    kind: acceptsNumber ? "safe-integer" : "string",
    optional: definition.optional,
    keyFields: selected.identityFields ?? selected.recordKeyFields,
  };
}

function valueAtFieldPath(value, fieldPath) {
  return fieldPath.split(".").reduce(
    (current, part) => current !== null && typeof current === "object"
      ? current[part]
      : undefined,
    value,
  );
}

function diagnosticSubjectHash(manifest, root, payload) {
  const catalog = manifest.diagnosticRootCatalog[root];
  assert.ok(catalog, `${root} has no diagnostic subject-key contract`);
  assert.ok(payload && Object.getPrototypeOf(payload) === Object.prototype,
    `${root} diagnostic subject payload must be a closed object`);
  const leafPaths = [];
  const visit = (value, prefix) => {
    assert.ok(value !== undefined, `${root}.${prefix} diagnostic subject is missing`);
    if (value !== null && typeof value === "object") {
      assert.equal(Object.getPrototypeOf(value), Object.prototype);
      for (const key of Object.keys(value)) visit(value[key], prefix ? `${prefix}.${key}` : key);
      return;
    }
    assert.ok(
      (typeof value === "string" && value.length > 0 && value === value.normalize("NFC"))
        || (typeof value === "number" && Number.isFinite(value)),
      `${root}.${prefix} diagnostic subject must be NFC text or a finite number`,
    );
    leafPaths.push(prefix);
  };
  visit(payload, "");
  assert.deepEqual(
    leafPaths.sort(),
    [...catalog.subjectProjectionFields].sort(),
    `${root} diagnostic subject payload must contain exactly the safe projection fields`,
  );
  const projection = catalog.subjectProjectionFields.map(
    (field) => [field, valueAtFieldPath(payload, field)],
  );
  return sha256(canonicalJson(projection));
}

function recordEnvelopeHash(manifest, row, payloadField) {
  const values = {
    root: row.root,
    record_schema_id: row.record_schema_id,
    record_key: JSON.parse(row.record_key),
    record_revision: JSON.parse(row.record_revision),
    canonical_payload: JSON.parse(row[payloadField]),
  };
  const input = manifest.canonicalization.recordHashInput.map((field) => {
    assert.ok(Object.hasOwn(values, field), `record hash input ${field} is unresolved`);
    return [field, values[field]];
  });
  return sha256(canonicalJson(input));
}

export function validateRecordEnvelope(manifest, row, context = {}) {
  assert.ok(row && Object.getPrototypeOf(row) === Object.prototype,
    "record envelope must be a closed object");
  assert.ok(typeof row.root === "string", "record envelope root must be text");
  const isCurrent = manifest.classifications.importable_current.includes(row.root);
  const isPreserved = manifest.classifications.preserved_frozen.includes(row.root);
  assert.notEqual(isCurrent, isPreserved, `${row.root} is not exactly one record-envelope root`);
  const payloadField = isCurrent ? "payload_json" : "opaque_canonical_payload_json";
  assert.deepEqual(Object.keys(row), [
    "root",
    "record_schema_id",
    "record_key",
    "record_revision",
    "record_content_sha256",
    payloadField,
  ], `${row.root} record envelope must use the closed field order`);
  const sheet = manifest.workbookSchema.sheets[
    isCurrent ? "__TF_CURRENT" : "__TF_PRESERVED"
  ];
  const column = (name) => sheet.columns.find((entry) => entry.name === name);
  assert.ok(sheet && column(payloadField), `${row.root} record envelope sheet is unresolved`);
  const parsedPayload = JSON.parse(row[payloadField]);
  const commonContext = {
    manifest,
    root: row.root,
    payload: parsedPayload,
    variant: context.variant,
    repositoryRoot: context.repositoryRoot ?? process.cwd(),
  };
  validateMachineCell(column("root"), row.root);
  validateMachineCell(column(payloadField), row[payloadField], "string", commonContext);
  validateMachineCell(column("record_schema_id"), row.record_schema_id, "string", commonContext);
  validateMachineCell(column("record_key"), row.record_key, "string", commonContext);
  const parsedKey = JSON.parse(row.record_key);
  validateMachineCell(column("record_revision"), row.record_revision, "string", {
    ...commonContext,
    recordKey: parsedKey,
  });
  assert.match(row.record_content_sha256, /^[0-9a-f]{64}$/);
  const expectedHash = recordEnvelopeHash(manifest, row, payloadField);
  assert.ok(
    timingSafeEqual(
      Buffer.from(row.record_content_sha256, "hex"),
      Buffer.from(expectedHash, "hex"),
    ),
    `${row.root} record_content_sha256 does not match the closed row envelope`,
  );
  return true;
}

export function validateServerRefEnvelope(manifest, row) {
  assert.ok(row && Object.getPrototypeOf(row) === Object.prototype,
    "server ref envelope must be a closed object");
  assert.deepEqual(Object.keys(row), [
    "root",
    "classification",
    "root_content_sha256",
    "opaque_server_ref",
  ], "server ref envelope must use the closed field order");
  const catalog = manifest.serverOwnedRootCatalog[row.root];
  assert.ok(catalog, `${row.root} has no server-owned root policy`);
  assert.deepEqual(catalog, {
    hashPolicy: "NO_CONTENT_HASH",
    refPolicy: "OPAQUE_NON_REPLAYABLE",
  }, `${row.root} server-owned policy may not expose raw-derived hashes`);
  const sheet = manifest.workbookSchema.sheets.__TF_SERVER_REFS;
  for (const columnSchema of sheet.columns) {
    validateMachineCell(columnSchema, row[columnSchema.name]);
  }
  return true;
}

function diagnosticEvidenceHash(manifest, row) {
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
  return sha256(canonicalJson(
    manifest.canonicalization.diagnosticEvidenceHashInput.map((field) => {
      assert.ok(Object.hasOwn(values, field), `diagnostic hash input ${field} is unresolved`);
      return [field, values[field]];
    }),
  ));
}

export function validateDiagnosticEnvelope(manifest, row) {
  assert.ok(row && Object.getPrototypeOf(row) === Object.prototype,
    "diagnostic envelope must be a closed object");
  assert.deepEqual(Object.keys(row), [
    "root",
    "record_key",
    "diagnostic_schema_version",
    "subject_payload_json",
    "severity",
    "code",
    "message",
    "subject_ref",
    "diagnostic_evidence_sha256",
  ], "diagnostic envelope must use the closed field order");
  const sheet = manifest.workbookSchema.sheets.__TF_DIAGNOSTICS;
  const column = (name) => sheet.columns.find((entry) => entry.name === name);
  const payload = JSON.parse(row.subject_payload_json);
  validateMachineCell(column("root"), row.root);
  validateMachineCell(column("subject_payload_json"), row.subject_payload_json, "string", {
    manifest,
    root: row.root,
  });
  validateMachineCell(column("record_key"), row.record_key, "string", {
    manifest,
    root: row.root,
    payload,
  });
  for (const name of [
    "diagnostic_schema_version",
    "severity",
    "code",
    "message",
    "subject_ref",
    "diagnostic_evidence_sha256",
  ]) {
    validateMachineCell(column(name), row[name]);
  }
  const expectedHash = diagnosticEvidenceHash(manifest, row);
  assert.ok(
    timingSafeEqual(
      Buffer.from(row.diagnostic_evidence_sha256, "hex"),
      Buffer.from(expectedHash, "hex"),
    ),
    `${row.root} diagnostic_evidence_sha256 does not match the closed row envelope`,
  );
  return true;
}

function comparePrimaryKey(manifest, left, right, primaryKey) {
  for (const field of primaryKey) {
    if (field === "root") {
      const rootOrder = Object.values(manifest.classifications).flat();
      const comparison = rootOrder.indexOf(left.root) - rootOrder.indexOf(right.root);
      if (comparison !== 0) return comparison;
      continue;
    }
    const comparison = left[field] < right[field] ? -1 : left[field] > right[field] ? 1 : 0;
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function validateMachineContentSheets(manifest, machineSheets, repositoryRoot) {
  assert.ok(machineSheets && Object.getPrototypeOf(machineSheets) === Object.prototype,
    "workbook hash context requires closed machineSheets");
  assert.deepEqual(
    Object.keys(machineSheets),
    manifest.canonicalization.machineContentHashInput.filter(
      (entry) => entry !== "__TF_MANIFEST_EXCEPT_MACHINE_CONTENT_SHA256",
    ),
    "machineSheets must match the declared include set exactly",
  );
  for (const sheetName of manifest.canonicalization.machineContentHashInput) {
    if (sheetName === "__TF_MANIFEST_EXCEPT_MACHINE_CONTENT_SHA256") continue;
    const sheet = manifest.workbookSchema.sheets[sheetName];
    const rows = machineSheets[sheetName];
    assert.ok(sheet?.kind === "machine" && Array.isArray(rows), `${sheetName} rows are required`);
    if (sheetName === "__TF_SERVER_REFS") {
      assert.deepEqual(
        rows.map((row) => row.root),
        manifest.classifications.server_owned,
        "__TF_SERVER_REFS must contain every server-owned root exactly once",
      );
    }
    if (sheetName === "__TF_FORBIDDEN") {
      assert.deepEqual(
        rows.map((row) => row.root),
        manifest.classifications.forbidden,
        "__TF_FORBIDDEN must contain every forbidden root exactly once",
      );
    }
    const canonicalRows = [...rows].sort((left, right) =>
      comparePrimaryKey(manifest, left, right, sheet.primaryKey));
    const primaryKeys = rows.map((row) =>
      canonicalJson(sheet.primaryKey.map((field) => row[field])));
    assert.equal(
      new Set(primaryKeys).size,
      primaryKeys.length,
      `${sheetName} contains a duplicate primary key`,
    );
    assert.equal(
      canonicalJson(rows),
      canonicalJson(canonicalRows),
      `${sheetName} rows must use canonical primary-key order`,
    );
    for (const row of rows) {
      if (sheetName === "__TF_CURRENT" || sheetName === "__TF_PRESERVED") {
        validateRecordEnvelope(manifest, row, { repositoryRoot });
      } else if (sheetName === "__TF_SERVER_REFS") {
        validateServerRefEnvelope(manifest, row);
      } else if (sheetName === "__TF_FORBIDDEN") {
        assert.deepEqual(
          Object.keys(row),
          sheet.columns.map((entry) => entry.name),
          `${sheetName} row must use the closed field order`,
        );
        for (const columnSchema of sheet.columns) {
          validateMachineCell(columnSchema, row[columnSchema.name]);
        }
      } else {
        fail(`${sheetName} is not a declared machine-content sheet`);
      }
    }
  }
}

export function computeWorkbookHashes(
  manifest,
  context,
  repositoryRoot = process.cwd(),
) {
  assert.ok(context && Object.getPrototypeOf(context) === Object.prototype,
    "workbook hash context is required");
  assert.deepEqual(
    Object.keys(context),
    ["rootManifestSource", "manifestFields", "machineSheets"],
    "workbook hash context must be closed",
  );
  assert.equal(typeof context.rootManifestSource, "string", "root manifest source is required");
  assert.deepEqual(Object.keys(context.manifestFields), [
    "contract_version",
    "workspace_id",
    "base_workspace_revision",
    "root_manifest_sha256",
    "workbook_schema_sha256",
    "exporter_version",
  ], "manifestFields must exclude only machine_content_sha256");
  assert.deepEqual(
    JSON.parse(context.rootManifestSource),
    manifest,
    "root manifest context does not match the active manifest",
  );
  assert.deepEqual(
    manifest.canonicalization.rootManifestHashInput,
    ["project-workbook-v1-root-manifest.json:utf8-bytes"],
  );
  assert.equal(
    manifest.canonicalization.machineContentHashEncoding,
    "RFC8785_ORDERED_SHEET_ROW_PAIR_ARRAY_V1",
    "machine content hash encoding drift",
  );
  validateMachineContentSheets(manifest, context.machineSheets, repositoryRoot);
  const schemaInput = manifest.canonicalization.workbookSchemaHashInput.map((field) => {
    assert.ok(Object.hasOwn(manifest, field), `workbook schema hash input ${field} is unresolved`);
    return [field, manifest[field]];
  });
  const machineInput = manifest.canonicalization.machineContentHashInput.map((sheetName) => [
    sheetName,
    sheetName === "__TF_MANIFEST_EXCEPT_MACHINE_CONTENT_SHA256"
      ? context.manifestFields
      : context.machineSheets[sheetName],
  ]);
  return {
    rootManifestSha256: sha256(context.rootManifestSource),
    workbookSchemaSha256: sha256(canonicalJson(schemaInput)),
    machineContentSha256: sha256(canonicalJson(machineInput)),
  };
}

export function validateWorkbookEnvelope(
  manifest,
  row,
  context,
  repositoryRoot = process.cwd(),
) {
  assert.ok(row && Object.getPrototypeOf(row) === Object.prototype,
    "workbook manifest envelope must be a closed object");
  const sheet = manifest.workbookSchema.sheets.__TF_MANIFEST;
  assert.deepEqual(
    Object.keys(row),
    sheet.columns.map((entry) => entry.name),
    "workbook manifest envelope must use the closed field order",
  );
  for (const columnSchema of sheet.columns) {
    validateMachineCell(columnSchema, row[columnSchema.name]);
  }
  const hashes = computeWorkbookHashes(manifest, context, repositoryRoot);
  assert.equal(row.root_manifest_sha256, hashes.rootManifestSha256,
    "root_manifest_sha256 does not match its declared input");
  assert.equal(row.workbook_schema_sha256, hashes.workbookSchemaSha256,
    "workbook_schema_sha256 does not match its declared inputs");
  assert.deepEqual(
    context.manifestFields,
    Object.fromEntries(Object.entries(row).filter(([field]) => field !== "machine_content_sha256")),
    "workbook hash context manifestFields do not match the row",
  );
  assert.equal(row.machine_content_sha256, hashes.machineContentSha256,
    "machine_content_sha256 does not match its declared sheets");
  return true;
}

export function validateRootSummary(
  manifest,
  rows,
  rootRecordContext,
  repositoryRoot = process.cwd(),
) {
  assert.ok(Array.isArray(rows), "ROOT_SUMMARY rows are required");
  assert.ok(
    rootRecordContext && Object.getPrototypeOf(rootRecordContext) === Object.prototype,
    "ROOT_SUMMARY root record context is required",
  );
  const rootOrder = Object.values(manifest.classifications).flat();
  assert.equal(rows.length, rootOrder.length, "ROOT_SUMMARY must contain exactly 93 roots");
  assert.deepEqual(
    rows.map((row) => row.root),
    rootOrder,
    "ROOT_SUMMARY must contain each root once in manifest order",
  );
  const hashedRoots = [
    ...manifest.classifications.importable_current,
    ...manifest.classifications.preserved_frozen,
    ...manifest.classifications.export_only_diagnostic,
  ];
  assert.deepEqual(
    Object.keys(rootRecordContext),
    hashedRoots,
    "ROOT_SUMMARY context must contain every and only hash-bearing roots",
  );
  const sheet = manifest.workbookSchema.sheets.ROOT_SUMMARY;
  const classificationByRoot = new Map(
    Object.entries(manifest.classifications).flatMap(([classification, roots]) =>
      roots.map((root) => [root, classification])),
  );
  for (const row of rows) {
    assert.ok(row && Object.getPrototypeOf(row) === Object.prototype,
      `${row?.root ?? "unknown"} ROOT_SUMMARY row must be a closed object`);
    assert.deepEqual(
      Object.keys(row),
      sheet.columns.map((entry) => entry.name),
      `${row.root} ROOT_SUMMARY row must use the closed field order`,
    );
    for (const columnSchema of sheet.columns) {
      validateMachineCell(columnSchema, row[columnSchema.name]);
    }
    const classification = classificationByRoot.get(row.root);
    assert.equal(row.classification, classification, `${row.root} classification mismatch`);
    if (classification === "server_owned" || classification === "forbidden") {
      assert.equal(
        row.root_content_sha256,
        "null",
        `${row.root} must not expose a raw-derived root hash`,
      );
      continue;
    }
    assert.match(
      row.root_content_sha256,
      /^[0-9a-f]{64}$/,
      `${row.root} requires a closed root hash`,
    );
    const rootRecords = rootRecordContext[row.root];
    assert.ok(Array.isArray(rootRecords), `${row.root} root records are required`);
    assert.equal(
      row.record_count,
      String(rootRecords.length),
      `${row.root} record_count does not match its closed records`,
    );
    for (const record of rootRecords) {
      assert.equal(record.root, row.root, `${row.root} summary context contains another root`);
      if (classification === "export_only_diagnostic") {
        validateDiagnosticEnvelope(manifest, record);
      } else {
        validateRecordEnvelope(manifest, record, { repositoryRoot });
      }
    }
    assert.equal(
      row.root_content_sha256,
      sha256(canonicalJson(rootRecords)),
      `${row.root} root_content_sha256 does not match its closed records`,
    );
  }
  return true;
}

export function validateMachineCell(columnSchema, value, cellKind = "string", context = {}) {
  assert.equal(cellKind, "string", `${columnSchema.name} rejects Excel ${cellKind} cells`);
  assert.equal(typeof value, "string", `${columnSchema.name} must be encoded as text`);
  assert.notEqual(value, "", `${columnSchema.name} rejects blank cells`);
  const format = columnSchema.format;
  if (format === "safe-integer-text") {
    assert.match(value, /^(0|[1-9][0-9]*)$/);
    assert.ok(BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER), `${columnSchema.name} is not safe`);
  } else if (format === "lowercase-sha256") {
    assert.match(value, /^[0-9a-f]{64}$/);
    if (columnSchema.name === "record_content_sha256") {
      assert.ok(context.manifest, "record content hash requires manifest");
      assert.ok(context.row, "record content hash requires the complete row envelope");
      assert.equal(
        context.row.record_content_sha256,
        value,
        "record content hash cell must match its row envelope",
      );
      validateRecordEnvelope(context.manifest, context.row, context);
    }
  } else if (format === "lowercase-sha256-or-null") {
    assert.ok(value === "null" || /^[0-9a-f]{64}$/.test(value));
  } else if (format === "rfc8785-revision-scalar") {
    assert.ok(context.manifest && context.root, "record revision requires manifest and root");
    assert.ok(Object.hasOwn(context, "payload"), "record revision requires projected payload");
    validateRecordPayloadRepresentation(context.manifest, context.root, context.payload);
    const repositoryRoot = context.repositoryRoot ?? process.cwd();
    const effectiveVariant = resolvePayloadVariant(
      context.manifest,
      context.root,
      context.payload,
      context.variant,
      repositoryRoot,
    );
    const contract = revisionContract(
      context.manifest,
      context.root,
      effectiveVariant,
      repositoryRoot,
    );
    const parsed = JSON.parse(value);
    assert.equal(canonicalJson(parsed), value, `${columnSchema.name} must be canonical scalar JSON`);
    assert.ok(
      parsed === null || typeof parsed === "string" || typeof parsed === "number",
      `${columnSchema.name} must be a scalar JSON value`,
    );
    if (contract.field === null) {
      assert.equal(parsed, null, `${context.root} has no revision field`);
    } else {
      const payloadRevision = valueAtFieldPath(context.payload, contract.field);
      if (parsed === null) {
        assert.equal(contract.optional, true, `${context.root}.${contract.field} is required`);
        assert.equal(payloadRevision, undefined, `${context.root}.${contract.field} payload mismatch`);
      } else if (contract.kind === "safe-integer") {
        assert.ok(Number.isSafeInteger(parsed), `${context.root}.${contract.field} must be a safe integer`);
        assert.equal(payloadRevision, parsed, `${context.root}.${contract.field} payload mismatch`);
      } else {
        assert.ok(
          typeof parsed === "string" && parsed.length > 0 && parsed === parsed.normalize("NFC"),
          `${context.root}.${contract.field} must be non-empty NFC text`,
        );
        assert.equal(payloadRevision, parsed, `${context.root}.${contract.field} payload mismatch`);
      }
      const keyIndex = contract.keyFields.indexOf(contract.field);
      if (keyIndex >= 0) {
        assert.ok(Array.isArray(context.recordKey), "record revision identity requires recordKey");
        assert.equal(
          context.recordKey[keyIndex],
          parsed,
          `${context.root}.${contract.field} identity mismatch`,
        );
      }
    }
  } else if (format === "opaque-token-or-null") {
    assert.ok(value === "null" || /^opaque_[A-Za-z0-9_-]{22,}$/.test(value));
  } else if (format === "opaque-token") {
    assert.match(value, /^opaque_[A-Za-z0-9_-]{22,}$/);
  } else if (format === "diagnostic-subject-json") {
    const parsed = JSON.parse(value);
    assert.equal(canonicalJson(parsed), value, `${columnSchema.name} must use canonical JSON`);
    assert.ok(context.manifest && context.root, "diagnostic subject requires manifest and root");
    diagnosticSubjectHash(context.manifest, context.root, parsed);
  } else if (format === "rfc8785-json" || format === "rfc8785-key-json") {
    const parsed = JSON.parse(value);
    assert.equal(canonicalJson(parsed), value, `${columnSchema.name} must use canonical JSON`);
    if (format === "rfc8785-json" && context.manifest && context.root) {
      validateRecordPayloadAgainstSchema(
        context.manifest,
        context.root,
        parsed,
        context.repositoryRoot ?? process.cwd(),
        context.variant,
      );
    }
    if (format === "rfc8785-key-json") {
      assert.ok(Array.isArray(parsed));
      assert.ok(context.manifest && context.root, "record key validation requires manifest and root");
      assert.ok(Object.hasOwn(context, "payload"), "record key validation requires projected payload");
      const diagnosticCatalog = context.manifest.diagnosticRootCatalog[context.root];
      if (diagnosticCatalog) {
        assert.equal(parsed.length, 1, `${context.root} diagnostic key must contain one subject hash`);
        assert.match(parsed[0], /^[0-9a-f]{64}$/);
        assert.equal(
          parsed[0],
          diagnosticSubjectHash(context.manifest, context.root, context.payload),
          `${context.root} diagnostic key does not match the safe subject payload`,
        );
        return true;
      }
      validateRecordPayloadRepresentation(context.manifest, context.root, context.payload);
      const repositoryRoot = context.repositoryRoot ?? process.cwd();
      const effectiveVariant = resolvePayloadVariant(
        context.manifest,
        context.root,
        context.payload,
        context.variant,
        repositoryRoot,
      );
      const fields = expectedRecordKeyFields(context.manifest, context.root, effectiveVariant);
      const kinds = recordKeyComponentKinds(
        context.manifest,
        context.root,
        effectiveVariant,
        repositoryRoot,
      );
      assert.equal(parsed.length, fields.length, `${context.root} record key arity mismatch`);
      for (const [index, component] of parsed.entries()) {
        const isString = typeof component === "string"
          && component.length > 0
          && component === component.normalize("NFC");
        const isInteger = Number.isSafeInteger(component);
        if (kinds[index] === "singleton") assert.equal(component, "$singleton");
        else if (kinds[index] === "string") assert.ok(isString, `${fields[index]} must be NFC text`);
        else if (kinds[index] === "safe-integer") {
          assert.ok(isInteger, `${fields[index]} must be a safe integer`);
        } else {
          assert.ok(isString || isInteger, `${fields[index]} must be NFC text or a safe integer`);
        }
        if (fields[index] !== "$singleton") {
          const payloadIdentity = valueAtFieldPath(context.payload, fields[index]);
          assert.notEqual(
            payloadIdentity,
            undefined,
            `${context.root}.${fields[index]} identity is missing from payload`,
          );
          assert.deepEqual(
            component,
            payloadIdentity,
            `${context.root}.${fields[index]} record key does not match payload identity`,
          );
        }
      }
    }
  } else if (format.startsWith("literal:")) {
    assert.equal(value, format.slice("literal:".length));
  } else if (format === "stable-id") {
    assert.match(value, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
    if (columnSchema.name === "record_schema_id") {
      assert.ok(context.manifest && context.root, "record schema id requires manifest and root");
      assert.ok(Object.hasOwn(context, "payload"), "record schema id requires projected payload");
      assert.equal(
        value,
        expectedRecordSchemaId(
          context.manifest,
          context.root,
          context.payload,
          context.variant,
          context.repositoryRoot ?? process.cwd(),
        ),
        `${context.root} record schema id does not match its closed payload variant`,
      );
    }
  } else if (format === "stable-version") {
    assert.match(value, /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/);
  } else if (format === "workspace-root") {
    assert.ok(
      Object.values(EXPECTED_ROOT_CLASSIFICATIONS).flat().includes(value),
      `${value} is not a current WorkspaceState root`,
    );
  } else if (format === "diagnostic-severity") {
    assert.ok(["INFO", "WARNING", "ERROR"].includes(value));
  } else if (format === "stable-code") {
    assert.match(value, /^[A-Z][A-Z0-9_]{0,127}$/);
  } else if (format === "classification") {
    assert.ok(CLASSIFICATIONS.includes(value));
  } else if (format === "display-text") {
    assert.equal(value, value.normalize("NFC"));
    assert.doesNotMatch(value, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
  } else {
    fail(`Unknown machine column format: ${format}`);
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

function parseConstDeclarations(source) {
  const declarations = new Map();
  const pattern = /^\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)[^=]*=/gm;
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 0;
    let end = start;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if ("{[(".includes(character)) depth += 1;
      if ("}])".includes(character)) depth -= 1;
      if (character === ";" && depth === 0) break;
    }
    declarations.set(match[1], source.slice(start, end));
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

function interfaceFieldTypes(source, interfaceName) {
  const declaration = source.match(
    new RegExp(`\\bexport\\s+interface\\s+${interfaceName}\\s*(?:extends[^\\{]+)?\\{`),
  );
  if (!declaration || declaration.index === undefined) return null;
  const openingIndex = source.indexOf("{", declaration.index);
  const body = source.slice(openingIndex + 1, matchingBrace(source, openingIndex))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const fields = new Map();
  let depth = 0;
  let segment = "";
  for (const character of body) {
    segment += character;
    if ("{[(".includes(character)) depth += 1;
    if ("}])".includes(character)) depth -= 1;
    if (character === ";" && depth === 0) {
      const field = segment.trim().match(
        /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\?)?:\s*([\s\S]*);$/,
      );
      if (field) fields.set(field[1], field[2].trim());
      segment = "";
    }
  }
  return fields;
}

function interfaceFieldDefinitions(source, interfaceName) {
  const declaration = source.match(
    new RegExp(`\\bexport\\s+interface\\s+${interfaceName}\\s*(?:extends[^\\{]+)?\\{`),
  );
  if (!declaration || declaration.index === undefined) return null;
  const openingIndex = source.indexOf("{", declaration.index);
  const body = source.slice(openingIndex + 1, matchingBrace(source, openingIndex))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const fields = new Map();
  let depth = 0;
  let segment = "";
  for (const character of body) {
    segment += character;
    if ("{[(".includes(character)) depth += 1;
    if ("}])".includes(character)) depth -= 1;
    if (character === ";" && depth === 0) {
      const field = segment.trim().match(
        /^([A-Za-z_$][A-Za-z0-9_$]*)(\?)?:\s*([\s\S]*);$/,
      );
      if (field) fields.set(field[1], { optional: field[2] === "?", type: field[3].trim() });
      segment = "";
    }
  }
  return fields;
}

function assertFieldPathExists(source, typeName, fieldPath, label) {
  let currentType = typeName;
  for (const part of fieldPath.split(".")) {
    const fields = interfaceFieldTypes(source, currentType);
    assert.ok(fields, `${label} type ${currentType} must resolve to an interface`);
    const fieldType = fields.get(part);
    assert.ok(fieldType, `${label}.${fieldPath} is absent from ${currentType}`);
    currentType = fieldType.match(/\b([A-Z][A-Za-z0-9_$]*)\b/)?.[1] ?? "";
  }
}

function importedTypeBindings(source, sourcePath) {
  const bindings = new Map();
  const pattern = /import\s+type\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    let importedPath = match[2];
    if (!importedPath.endsWith(".ts")) importedPath += ".ts";
    const resolvedPath = path.posix.normalize(
      path.posix.join(path.posix.dirname(sourcePath.replaceAll("\\", "/")), importedPath),
    );
    for (const rawBinding of match[1].split(",")) {
      const binding = rawBinding.trim().replace(/^type\s+/, "");
      if (!binding) continue;
      const [importedName, localName = importedName] = binding.split(/\s+as\s+/);
      bindings.set(localName.trim(), {
        path: resolvedPath,
        importedName: importedName.trim(),
      });
    }
  }
  return bindings;
}

function actualWorkspaceRootTypeRef(manifest, rootName, repositoryRoot) {
  const workspacePath = manifest.workspaceStateSource.path;
  const workspaceSource = readFileSync(path.join(repositoryRoot, workspacePath), "utf8");
  const workspaceFields = interfaceFieldTypes(
    workspaceSource,
    manifest.workspaceStateSource.interface,
  );
  const propertyType = workspaceFields?.get(rootName);
  assert.ok(propertyType, `WorkspaceState.${rootName} type is unresolved`);
  const normalizedPropertyType = propertyType.replace(/\s+/g, "");
  if (normalizedPropertyType === "string|null" || normalizedPropertyType === "null|string") {
    return `${workspacePath}#string|null`;
  }
  const identifiers = [...new Set(
    propertyType.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) ?? [],
  )].filter((name) => !["Array", "ReadonlyArray", "null", "undefined"].includes(name));
  assert.equal(identifiers.length, 1, `WorkspaceState.${rootName} must expose one element/scalar alias`);
  const typeName = identifiers[0];
  if (["string", "number", "boolean"].includes(typeName)) {
    return `${workspacePath}#${typeName}`;
  }
  if (parseTypeDeclarations(workspaceSource).has(typeName)) {
    return `${workspacePath}#${typeName}`;
  }
  const imported = importedTypeBindings(workspaceSource, workspacePath).get(typeName);
  assert.ok(imported, `WorkspaceState.${rootName} imported type ${typeName} is unresolved`);
  assert.equal(
    imported.importedName,
    typeName,
    `WorkspaceState.${rootName} aliased imports require an explicit canonical binding`,
  );
  return `${imported.path}#${imported.importedName}`;
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
    server_owned: {
      sheet: "__TF_SERVER_REFS",
      payloadPolicy: "OPAQUE_NON_REPLAYABLE_REF_ONLY_NO_CONTENT_HASH",
    },
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
    "rootManifestHashInput",
    "workbookSchemaHashInput",
    "recordHashInput",
    "diagnosticEvidenceHashInput",
    "machineContentHashEncoding",
    "machineContentHashInput",
    "machineContentHashExcludes",
    "hashAlgorithm",
    "semanticEquivalence",
  ], "canonicalization");
  assert.equal(manifest.canonicalization.jsonCanonicalization, "RFC8785_JCS");
  assert.equal(manifest.canonicalization.hashAlgorithm, "SHA-256");
  assert.deepEqual(manifest.canonicalization.rootManifestHashInput, [
    "project-workbook-v1-root-manifest.json:utf8-bytes",
  ]);
  assert.deepEqual(manifest.canonicalization.workbookSchemaHashInput, [
    "workbookSchema",
    "canonicalization",
    "recordSchemaAuthority",
    "recordSchemas",
    "preservedRootCatalog",
    "preservedSchemaCatalog",
    "preservedSchemaAuthority",
    "diagnosticRootCatalog",
    "serverOwnedRootCatalog",
    "conditionalExactFieldPolicies",
    "serverOwnedInvariants",
    "classifications",
  ]);
  assert.deepEqual(manifest.canonicalization.recordHashInput, [
    "root",
    "record_schema_id",
    "record_key",
    "record_revision",
    "canonical_payload",
  ]);
  assert.deepEqual(manifest.canonicalization.diagnosticEvidenceHashInput, [
    "root",
    "record_key",
    "diagnostic_schema_version",
    "subject_payload",
    "severity",
    "code",
    "message",
    "subject_ref",
  ]);
  assert.equal(
    manifest.canonicalization.machineContentHashEncoding,
    "RFC8785_ORDERED_SHEET_ROW_PAIR_ARRAY_V1",
  );
  assert.deepEqual(manifest.canonicalization.machineContentHashInput, [
    "__TF_MANIFEST_EXCEPT_MACHINE_CONTENT_SHA256",
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
    technologies: ["compatiblePerformanceProfileIds"],
  });
  assert.deepEqual(
    Object.keys(manifest.recordSchemaAuthority.typeRefs),
    EXPECTED_ROOT_CLASSIFICATIONS.importable_current,
    "every importable root must bind one exact recursive type authority",
  );
  for (const [root, typeRef] of Object.entries(manifest.recordSchemaAuthority.typeRefs)) {
    assert.match(
      typeRef,
      /^lib\/types\.ts#[A-Za-z][A-Za-z0-9]*$/,
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
    if (manifest.recordSchemaAuthority.typeRefs[root] === "lib/types.ts#string") {
      assert.deepEqual(schema.allowedFields, ["$scalar"], `${root} must use one scalar payload`);
    } else {
      assert.ok(!schema.allowedFields.includes("$scalar"), `${root} cannot use scalar sentinel`);
    }
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
  assert.deepEqual(
    manifest.serverOwnedRootCatalog,
    EXPECTED_SERVER_OWNED_ROOT_CATALOG,
    "every server-owned root must forbid raw-derived content hashes",
  );
  assert.deepEqual(
    manifest.conditionalExactFieldPolicies,
    EXPECTED_CONDITIONAL_EXACT_FIELD_POLICIES,
    "conditional exact-field policies must retain reserved identities",
  );
  for (const [root, policy] of Object.entries(manifest.conditionalExactFieldPolicies)) {
    assert.ok(manifest.recordSchemas[root], `${root} conditional exact policy has no record schema`);
    assert.ok(
      manifest.recordSchemas[root].allowedFields.includes(policy.whenExistingFieldPresent),
      `${root}.${policy.whenExistingFieldPresent} conditional exact predicate is not importable`,
    );
    for (const field of policy.exactFields) {
      assert.ok(manifest.recordSchemas[root].allowedFields.includes(field),
        `${root}.${field} conditional exact field is not importable`);
    }
  }
  assert.deepEqual(manifest.recordSchemas.v23TechnologyDefinitions.identityFields,
    ["technologyId", "revision"]);
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
      "carrier", "typeRef", "recordKeyFields", "revisionFields", "hashFields", "singleton",
      "variants",
    ], `preserved root ${root}`);
    assert.ok(["records", "variant_records", "whole_root_singleton"].includes(catalog.carrier));
    assert.match(
      catalog.typeRef,
      /^lib\/[a-z0-9-]+\.ts#(?:[A-Za-z][A-Za-z0-9]*|string\|null)$/,
    );
    if (catalog.carrier !== "variant_records") {
      assert.ok(catalog.recordKeyFields.length > 0, `${root} needs a stable record key`);
      assert.deepEqual(catalog.variants, []);
    } else {
      assert.deepEqual(catalog.recordKeyFields, []);
      assert.deepEqual(catalog.revisionFields, []);
      assert.deepEqual(catalog.hashFields, []);
      assert.ok(catalog.variants.length > 1, `${root} mixed union needs explicit variants`);
      for (const variant of catalog.variants) {
        assertExactKeys(variant, [
          "type", "recordKeyFields", "revisionFields", "hashFields",
        ], `${root}.${variant.type}`);
        assert.ok(variant.recordKeyFields.length > 0);
      }
    }
    assert.equal(new Set(catalog.recordKeyFields).size, catalog.recordKeyFields.length);
    assert.equal(catalog.singleton, catalog.carrier === "whole_root_singleton");
    if (catalog.singleton) assert.deepEqual(catalog.recordKeyFields, ["$singleton"]);
    if (!catalog.singleton) assert.ok(!catalog.recordKeyFields.includes("$singleton"));
  }
  assert.deepEqual(
    Object.keys(manifest.preservedSchemaCatalog),
    EXPECTED_ROOT_CLASSIFICATIONS.preserved_frozen,
    "every preserved root must bind one versioned row schema",
  );
  for (const [root, schema] of Object.entries(manifest.preservedSchemaCatalog)) {
    const variants = manifest.preservedRootCatalog[root].variants;
    if (variants.length === 0) {
      assert.equal(schema, `project-workbook/preserved/${root}/v1`);
    } else {
      assert.deepEqual(Object.keys(schema), variants.map((variant) => variant.type));
      assert.deepEqual(
        schema,
        EXPECTED_PRESERVED_VARIANT_SCHEMA_IDS[root],
        `${root} variant schema identities must remain stable`,
      );
      for (const [variant, schemaId] of Object.entries(schema)) {
        assert.match(
          schemaId,
          new RegExp(`^project-workbook/preserved/${root}/[a-z0-9-]+-v1$`),
          `${root}.${variant} needs a versioned schema id`,
        );
      }
      assert.equal(new Set(Object.values(schema)).size, variants.length);
    }
  }
  assertExactKeys(manifest.preservedSchemaAuthority, [
    "format", "sources", "recursiveTypeGraphSha256", "dynamicValuePolicy",
  ], "preserved schema authority");
  assert.equal(manifest.preservedSchemaAuthority.format, "typescript-opaque-exact-graph/v1");
  assert.ok(manifest.preservedSchemaAuthority.sources.length > 0);
  assert.match(manifest.preservedSchemaAuthority.recursiveTypeGraphSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    manifest.preservedSchemaAuthority.dynamicValuePolicy,
    "OPAQUE_SERVER_EXPORT_ONLY_EXACT_COMPARE_NO_CLIENT_CONSTRUCTION",
  );
  assert.deepEqual(
    Object.keys(manifest.diagnosticRootCatalog),
    EXPECTED_ROOT_CLASSIFICATIONS.export_only_diagnostic,
    "every diagnostic root must bind one safe subject-key contract",
  );
  for (const [root, catalog] of Object.entries(manifest.diagnosticRootCatalog)) {
    assertExactKeys(catalog, [
      "typeRef", "subjectProjectionFields", "keyContract",
    ], `diagnostic root ${root}`);
    assert.match(catalog.typeRef, /^lib\/[a-z0-9-]+\.ts#[A-Za-z][A-Za-z0-9]*$/);
    assert.ok(catalog.subjectProjectionFields.length > 0);
    assert.equal(
      new Set(catalog.subjectProjectionFields).size,
      catalog.subjectProjectionFields.length,
    );
    assert.equal(catalog.keyContract, "SHA256_RFC8785_SUBJECT_PROJECTION_V1");
    assert.equal(Object.hasOwn(manifest.recordSchemas, root), false);
  }

  assert.deepEqual(
    manifest.serverOwnedInvariants,
    EXPECTED_SERVER_OWNED_INVARIANTS,
    "server-owned fixed invariants must remain complete, unique and canonical",
  );
  assert.equal(
    new Set(manifest.serverOwnedInvariants.qualityProfiles.map((profile) => profile.id)).size,
    4,
    "quality profile invariant ids must be unique",
  );
  assert.equal(
    new Set(manifest.serverOwnedInvariants.qualityProfiles.map((profile) => profile.letter)).size,
    4,
    "quality profile invariant letters must be unique",
  );

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

export function validatePreservedRootCatalog(manifest, repositoryRoot = process.cwd()) {
  for (const [rootName, catalog] of Object.entries(manifest.preservedRootCatalog)) {
    assert.equal(
      catalog.typeRef,
      actualWorkspaceRootTypeRef(manifest, rootName, repositoryRoot),
      `${rootName} typeRef must match the exact WorkspaceState property element/scalar type`,
    );
    const [sourcePath, typeName] = catalog.typeRef.split("#");
    const source = readFileSync(path.join(repositoryRoot, sourcePath), "utf8");
    if (catalog.carrier === "whole_root_singleton") {
      assert.ok(
        typeName === "string" || typeName === "string|null",
        `${rootName} singleton type must be an explicit JSON scalar`,
      );
      continue;
    }
    const declaration = parseTypeDeclarations(source).get(typeName);
    assert.ok(declaration, `${rootName} typeRef ${catalog.typeRef} is unresolved`);
    const declaredVariants = interfaceFieldTypes(source, typeName)
      ? [typeName]
      : [...new Set(
        (declaration.match(/\b[A-Z][A-Za-z0-9_$]*\b/g) ?? [])
          .filter((name) => interfaceFieldTypes(source, name)),
      )];
    const variantCatalog = catalog.variants.length > 0
      ? catalog.variants
      : declaredVariants.map((name) => ({
        type: name,
        recordKeyFields: catalog.recordKeyFields,
        revisionFields: catalog.revisionFields,
        hashFields: catalog.hashFields,
      }));
    if (catalog.variants.length > 0) {
      assert.deepEqual(
        catalog.variants.map((variant) => variant.type),
        declaredVariants,
        `${rootName} must enumerate every union variant exactly once`,
      );
    }
    for (const variant of variantCatalog) {
      for (const field of [
        ...variant.recordKeyFields,
        ...variant.revisionFields,
        ...variant.hashFields,
      ]) {
        assertFieldPathExists(source, variant.type, field, `${rootName}.${variant.type}`);
      }
    }
  }
  return true;
}

export function validateDiagnosticRootCatalog(manifest, repositoryRoot = process.cwd()) {
  for (const [rootName, catalog] of Object.entries(manifest.diagnosticRootCatalog)) {
    assert.equal(
      catalog.typeRef,
      actualWorkspaceRootTypeRef(manifest, rootName, repositoryRoot),
      `${rootName} diagnostic typeRef must match WorkspaceState`,
    );
    const [sourcePath, typeName] = catalog.typeRef.split("#");
    const source = readFileSync(path.join(repositoryRoot, sourcePath), "utf8");
    assert.ok(interfaceFieldDefinitions(source, typeName), `${rootName} diagnostic type is unresolved`);
    for (const field of catalog.subjectProjectionFields) {
      const definition = fieldPathDefinition(source, typeName, field);
      const type = definition.type;
      assert.ok(
        /\b(?:string|number)\b/.test(type) || /["'`][^"'`]*["'`]/.test(type),
        `${rootName}.${field} diagnostic subject must be a scalar`,
      );
    }
  }
  return true;
}

export function preservedTypeGraphHash(
  manifest,
  repositoryRoot = process.cwd(),
  sourceOverrides = new Map(),
) {
  const sourceByPath = new Map();
  for (const sourceBinding of manifest.preservedSchemaAuthority.sources) {
    assertExactKeys(sourceBinding, ["path", "sha256"], `preserved source ${sourceBinding.path}`);
    const source = sourceOverrides.has(sourceBinding.path)
      ? sourceOverrides.get(sourceBinding.path)
      : readFileSync(path.join(repositoryRoot, sourceBinding.path), "utf8");
    assert.equal(sha256(source), sourceBinding.sha256, `preserved source hash drift: ${sourceBinding.path}`);
    sourceByPath.set(sourceBinding.path, source);
  }
  const queue = Object.values(manifest.preservedRootCatalog).map((catalog) => {
    const [sourcePath, typeName] = catalog.typeRef.split("#");
    return { sourcePath, typeName };
  });
  const visited = new Set();
  const usedSources = new Set();
  const proof = [];
  const ignored = new Set([
    "Array", "ReadonlyArray", "Readonly", "Record", "Partial", "Required", "Pick", "Omit",
    "Extract", "Exclude", "NonNullable", "Date", "Map", "ReadonlyMap", "Set",
    "ReadonlySet", "Promise", "Uint8Array", "Object",
  ]);
  while (queue.length > 0) {
    const { sourcePath, typeName } = queue.shift();
    if (["string", "number", "boolean", "string|null"].includes(typeName)) {
      proof.push(`${sourcePath}#${typeName}:scalar`);
      continue;
    }
    const identity = `${sourcePath}#${typeName}`;
    if (visited.has(identity)) continue;
    visited.add(identity);
    const source = sourceByPath.get(sourcePath);
    assert.ok(source, `${identity} source is omitted from preserved authority`);
    usedSources.add(sourcePath);
    const localTypes = parseTypeDeclarations(source);
    const localConsts = parseConstDeclarations(source);
    const declaration = localTypes.get(typeName) ?? localConsts.get(typeName);
    assert.ok(declaration, `${identity} declaration is unresolved`);
    const semanticBody = declaration
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    proof.push(`${identity}:${sha256(semanticBody.replace(/\s+/g, " ").trim())}`);
    const traversalBody = semanticBody.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
    const imports = importedTypeBindings(source, sourcePath);
    for (const identifier of traversalBody.match(/\b[A-Z][A-Za-z0-9_$]*\b/g) ?? []) {
      if (ignored.has(identifier) || identifier.length === 1) continue;
      if (localTypes.has(identifier) || localConsts.has(identifier)) {
        queue.push({ sourcePath, typeName: identifier });
        continue;
      }
      const imported = imports.get(identifier);
      if (imported) {
        assert.ok(
          sourceByPath.has(imported.path),
          `${identity} dependency ${imported.path} is omitted from preserved authority`,
        );
        queue.push({ sourcePath: imported.path, typeName: imported.importedName });
        continue;
      }
      fail(`${identity} dependency ${identifier} is unresolved`);
    }
  }
  assert.deepEqual(
    [...sourceByPath.keys()].sort(),
    [...usedSources].sort(),
    "preserved authority must list exactly the recursively reachable sources",
  );
  return sha256(proof.sort().join("\n"));
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
  validatePreservedRootCatalog(manifest, root);
  validateDiagnosticRootCatalog(manifest, root);
  assert.equal(
    preservedTypeGraphHash(manifest, root),
    manifest.preservedSchemaAuthority.recursiveTypeGraphSha256,
    "preserved recursive type graph drift",
  );
  for (const [rootName, typeRef] of Object.entries(manifest.recordSchemaAuthority.typeRefs)) {
    const [sourcePath, typeName] = typeRef.split("#");
    const source = readFileSync(path.join(root, sourcePath), "utf8");
    const declarations = parseTypeDeclarations(source);
    const fields = parseExportedInterfaceFields(source, typeName);
    if (fields === null) {
      if (rootName === "notes" && typeName === "string") continue;
      assert.equal(
        rootName,
        "affinityAxisWeights",
        `${rootName} must resolve to an exported interface or an explicit scalar/map exception`,
      );
      assertClosedTypeGrammar(source, declarations, typeName, `${rootName} payload`);
      continue;
    }
    for (const field of manifest.recordSchemas[rootName].allowedFields) {
      assert.ok(fields.includes(field), `${rootName}.${field} is absent from ${typeRef}`);
      const definition = closedInterfaceFields(source, typeName)?.get(field);
      assert.ok(definition, `${rootName}.${field} has no closed type definition`);
      assertClosedTypeGrammar(
        source,
        declarations,
        definition.type,
        `${rootName} payload.${field}`,
      );
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
