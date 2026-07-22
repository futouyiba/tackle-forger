import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isVercelNitroBuild } from "../build/deployment-target";

test("Vercel review builds select the Nitro adapter", () => {
  assert.equal(isVercelNitroBuild({ VERCEL: "1" }), true);
  assert.equal(isVercelNitroBuild({ NITRO_PRESET: "vercel" }), true);
  assert.equal(isVercelNitroBuild({ VERCEL: "0" }), false);
  assert.equal(isVercelNitroBuild({ NITRO_PRESET: "cloudflare_module" }), false);
});

test("Vercel uses the root lockfile and Build Output API contract", async () => {
  const [packageJsonSource, vercelJsonSource] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonSource);
  const vercelJson = JSON.parse(vercelJsonSource);

  assert.equal(packageJson.scripts["build:vercel"], "vite build");
  assert.match(packageJson.scripts.lint, /--ignore-pattern \.vercel(?:\s|$)/);
  assert.equal(packageJson.devDependencies.nitro, "3.0.260610-beta");
  assert.equal(vercelJson.framework, null);
  assert.equal(vercelJson.installCommand, "npm ci");
  assert.equal(vercelJson.buildCommand, "npm run build:vercel");
  assert.equal("outputDirectory" in vercelJson, false);
});
