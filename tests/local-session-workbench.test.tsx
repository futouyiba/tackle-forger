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
  assert.match(source, /后台切换仍在进行；本地会话保持不变/);
  assert.match(source, /disabled=\{localMutationsDisabled\}/);
});

test("shared loading disables and fail-closes every local mutation surface", () => {
  const source = readFileSync(
    new URL("../app/LocalSessionWorkbench.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const localMutationsDisabled = shell\.authority\.status === "shared_loading"[\s\S]*?\|\| localParsePending/,
  );
  assert.match(source, /const commit = [\s\S]*?if \(localMutationsDisabled\)/);
  assert.match(source, /const clear = [\s\S]*?if \(localMutationsDisabled\)/);
  assert.match(
    source,
    /<fieldset[\s\S]*?disabled=\{localMutationsDisabled\}[\s\S]*?aria-busy=\{localMutationsDisabled\}/,
  );
  assert.match(
    source,
    /disabled=\{localMutationsDisabled \|\| session\.history\.undo\.length === 0\}/,
  );
  assert.match(
    source,
    /disabled=\{localMutationsDisabled \|\| session\.history\.redo\.length === 0\}/,
  );
});

test("replacement parsing disables local mutations and exposes non-destructive cancel", () => {
  const source = readFileSync(
    new URL("../app/LocalSessionWorkbench.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const localParsePending = shell\.source\.status === "selecting"[\s\S]*?shell\.source\.status === "parsing"/,
  );
  assert.match(source, /const cancelLocalParse = [\s\S]*?loader\.cancelPending\(\)/);
  assert.match(source, /type: "local_operation_cancelled"/);
  assert.match(source, /const openShared = [\s\S]*?if \(localParsePending\)/);
  assert.match(
    source,
    /disabled=\{shell\.auth\.status !== "authenticated"[\s\S]*?\|\| localParsePending\}/,
  );
  assert.match(source, /取消解析/);
});

test("shared loading has abortable timeout and manual recovery", () => {
  const source = readFileSync(
    new URL("../app/LocalSessionWorkbench.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /new SharedWorkspaceLoadScope\(operationId/);
  assert.match(source, /signal: scope\.signal/);
  assert.match(source, /type: "shared_load_cancelled"/);
  assert.match(source, /取消共享加载/);
  assert.match(source, /if \(!scope\.complete\(\)\) return/);
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

test("selected derivation issues drive the visible count and validation panel", () => {
  const source = readFileSync(
    new URL("../app/LocalSessionWorkbench.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const visibleIssues = derivation\?\.issues \?\? issues/);
  assert.match(source, /派生与校验 \$\{visibleIssues\.length\}/);
  assert.match(source, /issues=\{visibleIssues\}/);
});
