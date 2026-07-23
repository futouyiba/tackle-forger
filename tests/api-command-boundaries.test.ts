import assert from "node:assert/strict";
import test from "node:test";
import { createSeedState } from "../lib/seed";
import {
  changesOnlyReadOnlyLegacyHistory,
  findGovernedStateChanges,
  findReadOnlyLegacyProductChanges,
  stableAuditActor,
} from "../lib/api-command-boundaries";
import { parseDiscretePulls } from "../lib/series-create-contract";

test("旧产品集合全部是整包保存的只读历史", () => {
  const current = createSeedState();
  const proposed = structuredClone(current);
  proposed.recipes[0] = { ...proposed.recipes[0]!, name: "禁止修改的旧配方" };
  proposed.candidates[0] = {
    ...proposed.candidates[0]!,
    notes: "禁止修改的旧 Candidate",
  };
  proposed.officialSkus.push({ id: "legacy:injected" } as never);
  proposed.detailOverrides.push({ skuId: "legacy:injected" } as never);

  assert.deepEqual(findGovernedStateChanges(current, proposed), [
    "recipes", "candidates", "officialSkus", "detailOverrides",
  ]);
  assert.deepEqual(findReadOnlyLegacyProductChanges(current, proposed), [
    "recipes", "candidates", "officialSkus", "detailOverrides",
  ]);
  assert.equal(changesOnlyReadOnlyLegacyHistory(["recipes", "candidates"]), true);
  assert.equal(changesOnlyReadOnlyLegacyHistory(["recipes", "seriesDefinitions"]), false);
  assert.equal(changesOnlyReadOnlyLegacyHistory([]), false);
});

test("整包保存拒绝受治理集合变化，但允许普通说明字段变化", () => {
  const current = createSeedState();
  const notesOnly = structuredClone(current);
  notesOnly.notes = "ordinary workspace note";
  assert.deepEqual(findGovernedStateChanges(current, notesOnly), []);

  const bypass = structuredClone(current);
  bypass.seriesDefinitions.push({ ...bypass.seriesDefinitions[0]!, id: "series:bypass" });
  assert.deepEqual(findGovernedStateChanges(current, bypass), ["seriesDefinitions"]);

  const newDomainCollection = structuredClone(current);
  newDomainCollection.compatibilityRules = [];
  assert.deepEqual(findGovernedStateChanges(current, newDomainCollection), ["compatibilityRules"]);

  const legacyDomainCollection = structuredClone(current);
  legacyDomainCollection.recipes = [];
  assert.deepEqual(findGovernedStateChanges(current, legacyDomainCollection), ["recipes"]);

  const settings = structuredClone(current);
  settings.ruleSettings = { ...settings.ruleSettings, reductionStackingMode: "linear_subtraction" };
  assert.deepEqual(findGovernedStateChanges(current, settings), ["ruleSettings"]);

  const injected = { ...structuredClone(current), unexpectedDomainState: { enabled: true } };
  assert.deepEqual(
    findGovernedStateChanges(current, injected as typeof current),
    ["unexpectedDomainState"],
  );
});

test("飞书审计身份优先使用稳定 tenant/openId，且永不为空", () => {
  assert.equal(stableAuditActor({
    authenticated: true, provider: "feishu", tenantKey: "tenant", openId: "open",
    email: "", name: "策划", role: "editor", capabilities: [],
  }), "feishu:tenant:open");
  assert.equal(stableAuditActor({
    authenticated: true, provider: "feishu", email: "", name: "策划",
    role: "editor", capabilities: [],
  }), "策划");
});

test("离散拉力解析完整报告非法 token 和重复项", () => {
  assert.deepEqual(parseDiscretePulls("1.5, abc, -3, 8.2, 1.5"), {
    values: [1.5, 8.2],
    invalidTokens: ["abc", "-3"],
    duplicateValues: [1.5],
  });
  assert.deepEqual(parseDiscretePulls("1.5；3.8 8.2"), {
    values: [1.5, 3.8, 8.2], invalidTokens: [], duplicateValues: [],
  });
});
