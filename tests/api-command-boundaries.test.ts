import assert from "node:assert/strict";
import test from "node:test";
import { createSeedState } from "../lib/seed";
import { findGovernedStateChanges, stableAuditActor } from "../lib/api-command-boundaries";
import { parseDiscretePulls } from "../lib/series-create-contract";

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
