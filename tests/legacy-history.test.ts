import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  LEGACY_COMPATIBLE_PAGE_KEYS,
  preserveReadOnlyLegacyProductHistory,
  resolveCompatibleWorkbenchPage,
} from "../lib/legacy-history";
import { createSeedState } from "../lib/seed";

test("普通配置与 v3 变化保留历史 payload 和 Candidate Trace", () => {
  const current = createSeedState();
  const proposed = structuredClone(current);
  proposed.notes = "允许保存的普通说明";
  proposed.seriesDefinitions[0] = {
    ...proposed.seriesDefinitions[0]!,
    name: "专用 v3 命令返回的新 Series 名称",
  };
  proposed.recipes = [];
  proposed.candidates[0]!.calculated.trace.push({
    source: "禁止写入的重算轨迹",
  } as never);
  proposed.officialSkus.push({ id: "legacy:injected" } as never);
  proposed.detailOverrides.push({ skuId: "legacy:injected" } as never);

  const merged = preserveReadOnlyLegacyProductHistory(current, proposed);

  assert.equal(merged.notes, "允许保存的普通说明");
  assert.equal(merged.seriesDefinitions[0]?.name, "专用 v3 命令返回的新 Series 名称");
  assert.deepEqual(merged.recipes, current.recipes);
  assert.deepEqual(merged.candidates, current.candidates);
  assert.deepEqual(merged.officialSkus, current.officialSkus);
  assert.deepEqual(merged.detailOverrides, current.detailOverrides);
  assert.deepEqual(
    merged.candidates[0]?.calculated.trace,
    current.candidates[0]?.calculated.trace,
  );
});

test("旧 page 深链继续解析，未知 page 回退但不重写历史别名", () => {
  const known = new Set(["overview", "v3flow", ...LEGACY_COMPATIBLE_PAGE_KEYS] as const);
  for (const key of LEGACY_COMPATIBLE_PAGE_KEYS) {
    assert.equal(resolveCompatibleWorkbenchPage(key, known, "overview"), key);
  }
  assert.equal(resolveCompatibleWorkbenchPage("missing", known, "overview"), "overview");
  assert.equal(resolveCompatibleWorkbenchPage(null, known, "v3flow"), "v3flow");
});

test("根工作台不再重算历史 Candidate，规则图也没有下发写入口", async () => {
  const [workbench, ruleGraph] = await Promise.all([
    readFile(new URL("../app/Workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/RuleGraphStudio.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(workbench, /recalculateWorkspace/);
  assert.doesNotMatch(workbench, /draft\.(recipes|candidates|officialSkus|detailOverrides)/);
  assert.doesNotMatch(ruleGraph, /commitRuleRunToCandidates/);
  assert.match(ruleGraph, /历史候选只读/);
});
