import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isLocalSessionEditorEnabled } from "../lib/local-session-feature";

test("feature flag is production-safe and only exact true enables", () => {
  assert.equal(isLocalSessionEditorEnabled(undefined), false);
  assert.equal(isLocalSessionEditorEnabled("false"), false);
  assert.equal(isLocalSessionEditorEnabled("TRUE"), false);
  assert.equal(isLocalSessionEditorEnabled("1"), false);
  assert.equal(isLocalSessionEditorEnabled("true"), true);
});

test("anonymous entry declares local create/open boundary without production objects", () => {
  const source = readFileSync(
    new URL("../app/LocalSessionWorkbench.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /打开 WQ8w 工作簿/);
  assert.match(source, /新建空白临时会话/);
  assert.match(source, /没有恢复点/);
  assert.match(source, /不含 Series \/ SKU \/ Model/);
  assert.doesNotMatch(source, /createSeedState/);
});
