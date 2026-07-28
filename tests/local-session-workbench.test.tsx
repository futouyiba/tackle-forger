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

test("local source actions reject shared-loading races before mutating the reducer", () => {
  const source = readFileSync(
    new URL("../app/LocalSessionWorkbench.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /applyAcceptedEvents/);
  assert.match(source, /共享工作区正在加载；本地会话保持不变/);
  assert.match(source, /disabled=\{shell\.authority\.status === "shared_loading"\}/);
});

test("selector-bound workbook profiles import disabled until explicitly chosen", () => {
  const source = readFileSync(
    new URL("../lib/local-session-parser-protocol.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /appendRules\("method"[\s\S]*?false\)/);
  assert.match(source, /appendRules\("item_type"[\s\S]*?false\)/);
  assert.match(source, /appendRules\("modifier"[\s\S]*?false\)/);
});
