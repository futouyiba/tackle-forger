import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  checkProjectWorkbookContract,
  parseWorkspaceStateRoots,
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

test("canonical project workbook contract binds all current WorkspaceState roots", () => {
  const result = checkProjectWorkbookContract();
  assert.equal(result.rootCount, 93);
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
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
    /classified exactly once/,
  );

  const duplicate = clone(manifest);
  duplicate.classifications.server_owned.push("parameters");
  assert.throws(
    () => validateProjectWorkbookManifest(duplicate, roots),
    /classified more than once/,
  );
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
