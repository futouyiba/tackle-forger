import assert from "node:assert/strict";
import test from "node:test";
import { createSeedState } from "../lib/seed";
import {
  findGovernedStateChanges,
  GENERAL_WORKSPACE_SAVE_FIELDS,
  stableAuditActor,
} from "../lib/api-command-boundaries";
import { parseDiscretePulls } from "../lib/series-create-contract";

test("通用保存契约覆盖工作台直接编辑字段", () => {
  const current = createSeedState();
  const proposed = structuredClone(current);
  proposed.notes = "ordinary workspace note";
  proposed.parameters[0] = { ...proposed.parameters[0]!, label: "工作台参数编辑" };
  proposed.templates[0] = { ...proposed.templates[0]!, notes: "工作台模板编辑" };
  proposed.modifiers[0] = { ...proposed.modifiers[0]!, notes: "工作台修正规则编辑" };
  proposed.layers[0] = { ...proposed.layers[0]!, notes: "工作台规则层编辑" };
  proposed.affixes[0] = { ...proposed.affixes[0]!, description: "工作台词条编辑" };
  proposed.qualityBands[0] = { ...proposed.qualityBands[0]!, notes: "工作台品质编辑" };
  proposed.affixScorePolicy = { ...proposed.affixScorePolicy, synergyBonus: proposed.affixScorePolicy.synergyBonus + 1 };
  proposed.recipes[0] = { ...proposed.recipes[0]!, name: "工作台配方编辑" };
  proposed.seriesShowcases = [];
  proposed.candidates = [];
  proposed.officialSkus = [];
  proposed.detailOverrides = [];
  proposed.ruleGraphs = [];
  proposed.ruleRuns = [];
  proposed.dataSources[0] = { ...proposed.dataSources[0]!, notes: "工作台数据源编辑" };

  assert.deepEqual(findGovernedStateChanges(current, proposed), []);
  assert.deepEqual([...GENERAL_WORKSPACE_SAVE_FIELDS].sort(), [
    "affixScorePolicy", "affixes", "candidates", "dataSources", "detailOverrides",
    "layers", "modifiers", "notes", "officialSkus", "parameters", "qualityBands",
    "recipes", "ruleGraphs", "ruleRuns", "seriesShowcases", "templates",
  ]);
});

test("整包保存拒绝领域实体、账本、审计和未知字段变化", () => {
  const current = createSeedState();

  const bypass = structuredClone(current);
  bypass.seriesDefinitions.push({ ...bypass.seriesDefinitions[0]!, id: "series:bypass" });
  assert.deepEqual(findGovernedStateChanges(current, bypass), ["seriesDefinitions"]);

  const newDomainCollection = structuredClone(current);
  newDomainCollection.compatibilityRules = [];
  assert.deepEqual(findGovernedStateChanges(current, newDomainCollection), ["compatibilityRules"]);

  const settings = structuredClone(current);
  settings.ruleSettings = { ...settings.ruleSettings, reductionStackingMode: "linear_subtraction" };
  assert.deepEqual(findGovernedStateChanges(current, settings), ["ruleSettings"]);

  const commandLedger = structuredClone(current);
  commandLedger.commandIdempotencyRecords.push({ key: "bypass", inputHash: "hash", resultRef: "series:bypass" });
  assert.deepEqual(findGovernedStateChanges(current, commandLedger), ["commandIdempotencyRecords"]);

  const snapshots = structuredClone(current);
  snapshots.configurationSnapshots = [];
  assert.deepEqual(findGovernedStateChanges(current, snapshots), ["configurationSnapshots"]);

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
