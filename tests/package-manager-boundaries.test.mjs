import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const historicalPackagePaths = [
  "apps/web/package.json",
  "packages/db/package.json",
  "packages/domain/package.json",
  "packages/excel/package.json",
  "packages/ui/package.json",
];
const expectedImporters = [
  "../apps/web",
  "../packages/db",
  "../packages/domain",
  "../packages/excel",
  "../packages/ui",
];

async function exists(relativePath) {
  try {
    await access(join(repositoryRoot, relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function importerKeys(lockfile) {
  const importerBlock = lockfile.match(/\nimporters:\n([\s\S]*?)\npackages:\n/);
  assert.ok(importerBlock, "pnpm lockfile must contain importers and packages sections");
  return [...importerBlock[1].matchAll(/^ {2}(\S[^:]*):$/gm)].map((match) => match[1]);
}

async function copyFixtureFile(fixtureRoot, relativePath) {
  const destination = join(fixtureRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(repositoryRoot, relativePath), destination);
}

async function createPackageManagerFixture(t) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "tackle-forger-pnpm-boundary-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  for (const relativePath of [
    "package.json",
    "package-lock.json",
    "legacy-workspace/pnpm-workspace.yaml",
    "legacy-workspace/pnpm-lock.yaml",
    ...historicalPackagePaths,
  ]) {
    await copyFixtureFile(fixtureRoot, relativePath);
  }
  return fixtureRoot;
}

function runFrozenHistoricalInstall(fixtureRoot) {
  return spawnSync(
    "pnpm",
    [
      "--dir",
      "legacy-workspace",
      "install",
      "--frozen-lockfile",
      "--lockfile-only",
      "--offline",
      "--ignore-scripts",
    ],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
    },
  );
}

test("historical pnpm metadata excludes the authoritative root npm application", async () => {
  assert.equal(await exists("pnpm-workspace.yaml"), false);
  assert.equal(await exists("pnpm-lock.yaml"), false);
  assert.equal(await exists("legacy-workspace/package.json"), false);

  const workspace = await readFile(
    join(repositoryRoot, "legacy-workspace/pnpm-workspace.yaml"),
    "utf8",
  );
  assert.match(workspace, /^  - \.\.\/apps\/\*$/m);
  assert.match(workspace, /^  - \.\.\/packages\/\*$/m);

  const lockfile = await readFile(
    join(repositoryRoot, "legacy-workspace/pnpm-lock.yaml"),
    "utf8",
  );
  assert.deepEqual(importerKeys(lockfile), expectedImporters);
});

test("root npm-only manifest and lock drift leave the historical frozen lock valid", async (t) => {
  if (spawnSync("pnpm", ["--version"], { encoding: "utf8" }).error?.code === "ENOENT") {
    t.skip("pnpm is not installed in the root npm-only validation job");
    return;
  }

  const fixtureRoot = await createPackageManagerFixture(t);
  const rootManifestPath = join(fixtureRoot, "package.json");
  const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8"));
  rootManifest.dependencies["root-only-boundary-probe"] = "1.0.0";
  await writeFile(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`);
  const rootLockPath = join(fixtureRoot, "package-lock.json");
  await writeFile(rootLockPath, `${await readFile(rootLockPath, "utf8")}\n`);

  const result = runFrozenHistoricalInstall(fixtureRoot);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("historical workspace manifest drift is rejected by frozen install", async (t) => {
  if (spawnSync("pnpm", ["--version"], { encoding: "utf8" }).error?.code === "ENOENT") {
    t.skip("pnpm is not installed in the root npm-only validation job");
    return;
  }

  const fixtureRoot = await createPackageManagerFixture(t);
  const domainManifestPath = join(fixtureRoot, "packages/domain/package.json");
  const domainManifest = JSON.parse(await readFile(domainManifestPath, "utf8"));
  domainManifest.dependencies["decimal.js"] = "10.5.0";
  await writeFile(domainManifestPath, `${JSON.stringify(domainManifest, null, 2)}\n`);

  const result = runFrozenHistoricalInstall(fixtureRoot);
  assert.notEqual(result.status, 0, "frozen install unexpectedly accepted stale workspace lock data");
  assert.match(`${result.stdout}\n${result.stderr}`, /ERR_PNPM_OUTDATED_LOCKFILE/);
});
