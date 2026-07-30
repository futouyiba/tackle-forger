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
  "classifications",
  "modes",
  "removal",
  "conflicts",
  "plan",
  "actions",
  "transaction",
];

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
  assert.deepEqual(manifest.actions, {
    preview: "preview_project_workbook_import",
    commit: "commit_project_workbook_import",
    export: "export_project_workbook",
  });
  assert.deepEqual(manifest.transaction, {
    authorizationAtExecution: true,
    atomicCommit: true,
    idempotentCommit: true,
    readbackRequired: true,
    sameWorkspaceOnly: true,
    crossWorkspaceCloneOrRestore: false,
  });

  const classificationOf = (root) => CLASSIFICATIONS.find(
    (classification) => manifest.classifications[classification].includes(root),
  );
  assert.equal(classificationOf("configurationSnapshots"), "preserved_frozen");
  assert.equal(classificationOf("workspaceId"), "server_owned");
  assert.equal(classificationOf("feishuWorkbooks"), "forbidden");
  assert.equal(classificationOf("feishuSourceRevisions"), "forbidden");
  assert.equal(classificationOf("aiRuleSourceChangeDrafts"), "forbidden");
  assert.equal(classificationOf("dataSources"), "forbidden");
  assert.equal(classificationOf("v23MigrationSourceEvidence"), "forbidden");
  assert.equal(classificationOf("v23LegacyReadAdapters"), "forbidden");
  assert.equal(classificationOf("migrationReviewItems"), "forbidden");
  assert.equal(classificationOf("derivedProjections"), "export_only_diagnostic");
  return true;
}

export function checkProjectWorkbookContract(root = process.cwd()) {
  const manifestPath = path.join(root, "docs/spec-v3/project-workbook-v1-root-manifest.json");
  const manifestSource = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestSource);
  const workspaceSource = readFileSync(path.join(root, manifest.workspaceStateSource.path), "utf8");
  const workspaceRoots = parseWorkspaceStateRoots(workspaceSource);
  validateProjectWorkbookManifest(manifest, workspaceRoots);

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
    assert.match(interaction, new RegExp(action), `section 24.1 must bind ${action}`);
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
