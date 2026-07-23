import assert from "node:assert/strict";
import test from "node:test";
import { importCanonicalRuleSource } from "../lib/canonical-rule-source";
import { calculateCandidate } from "../lib/engine";
import { migrateWorkspaceState } from "../lib/migrations";
import { identityRowsFromRanges } from "../lib/rule-workbook-inspection";
import { createSeedState } from "../lib/seed";
import {
  applyCanonicalRuleSourceDraft,
  assertExplicitPullDidNotPublish,
  createRuleSetDraftFromPull,
  publishRuleSetVersion,
  recordFeishuSourceRevision,
} from "../lib/workbook-governance";
import type { FeishuSourceRevision } from "../lib/feishu-workbook";

function row(entries: Record<number, unknown>) {
  const result: unknown[] = [];
  for (const [index, value] of Object.entries(entries)) result[Number(index)] = value;
  return result;
}

const revision: FeishuSourceRevision = {
  id: "feishu-revision:canonical-3259",
  workbookRefId: "feishu-workbook:tackle-design",
  sourceRevision: "3259",
  spreadsheetToken: "spreadsheet:test",
  pulledAt: "2026-07-23T00:00:00.000Z",
  pulledBy: "tester",
  syncScope: "workbook",
  registryHash: "registry:test",
  sheets: [],
  issues: [],
  state: "PULLED",
};

function fixture() {
  const weightHeader = row({ 1: "机器ID（勿改）", 2: "同步状态", 3: "钓法", 4: "备注", 5: "重量段", 6: "最小拉力", 7: "最大拉力", 8: "鱼重等级", 9: "竿拉力", 10: "轮拉力", 11: "线拉力", 12: "竿调性" });
  const typeHeader = row({ 1: "机器ID（勿改）", 2: "实体类型", 3: "重量段", 4: "钓法", 5: "具体类型", 6: "竿拉力", 7: "修理系数" });
  const functionHeader = row({ 1: "机器ID（勿改）", 2: "实体类型", 3: "FunctionProfile ID（勿改）", 4: "功能定位", 5: "定位/类型", 6: "级别", 7: "评分系数", 8: "竿拉力" });
  return {
    weightValues: [[], weightHeader,
      row({ 1: "wtpl_0001", 2: "BOUND", 3: "路亚", 4: "源备注", 5: "W01", 6: 0.1, 7: 1.5, 8: 1, 9: 10, 10: 8, 11: 30, 12: "快" }),
      row({ 1: "wtpl_0002", 2: "BOUND", 3: "浮钓", 5: "W01", 6: 0.1, 7: 1.5, 8: 1, 9: 9, 10: 7, 11: 28, 12: "中" }),
    ],
    typeValues: [[], typeHeader,
      row({ 1: "type_rod_0001", 2: "RodType", 3: "W01", 4: "路亚", 5: "路亚直柄竿", 6: 1.1, 7: 0.9 }),
      [],
      row({ 1: "机器ID（勿改）", 2: "实体类型", 3: "重量段", 4: "钓法", 5: "具体类型", 6: "线拉力" }),
      row({ 1: "type_line_0001", 2: "LineType", 3: "W01", 4: "-", 5: "尼龙线", 6: 1.05 }),
    ],
    functionValues: [[], functionHeader,
      row({ 1: "func_0001", 2: "FunctionProfile", 3: "function:cast", 4: "远投|1", 5: "远投", 6: 1, 7: 1, 8: 1.2 }),
      row({ 1: "func_0002", 2: "FunctionProfile", 3: "function:cast", 4: "远投|2", 5: "远投", 6: 2, 7: 1.2, 8: 1.3 }),
      row({ 1: "func_0003", 2: "FunctionProfile", 3: "function:cast", 4: "远投|3", 5: "远投", 6: 3, 7: 1.4, 8: 1.4 }),
    ],
  };
}

function withoutReplaceableRuleReferences(state = createSeedState()) {
  return {
    ...state,
    candidates: [],
    recipes: [],
    seriesDefinitions: [],
    candidateSearchRecipes: [],
    derivedProjections: [],
    projectionMatches: [],
    skuDrawers: [],
    seriesShowcases: [],
    compatibilityRules: [],
    affinityRules: [],
  };
}

test("多区块表头按当前区块解析，并保留稳定 ID、显示值、规则和来源单元格", () => {
  const draft = importCanonicalRuleSource({ sourceRevision: revision, ...fixture(), importedAt: revision.pulledAt });
  assert.deepEqual(draft.issues, []);
  assert.equal(draft.templates.length, 2);
  assert.equal(draft.templates[0].id, "wtpl_0001");
  assert.equal(draft.templates[0].methodId, undefined);
  assert.equal(draft.templates[0].fishWeightLevel, 1);
  assert.equal(draft.templates[0].nominalTargetPullKgf, 0.8);
  assert.equal(draft.templates[0].rangeSemantics, "target_pull");
  assert.equal(draft.templates[0].values["杆最大拉力kgf"], 10);
  assert.equal(draft.parameters.find((entry) => entry.key === "杆最大拉力kgf")?.label, "竿拉力");
  assert.equal(draft.parameters.find((entry) => entry.key === "竿修理系数")?.itemKind, "rod");
  assert.deepEqual(draft.methodProfiles, []);
  assert.equal(draft.itemTypeProfiles.find((entry) => entry.id === "type_rod_0001")?.rules[0].value, 1.1);
  assert.equal(draft.itemTypeProfiles.find((entry) => entry.id === "type_rod_0001")?.rules[0].sourceCell, "G3");
  assert.deepEqual(draft.modifiers.find((entry) => entry.id === "type_rod_0001")?.methodIds, ["method:lure"]);
  assert.deepEqual(draft.functionProfiles.map((entry) => entry.id), ["function:cast"]);
  assert.deepEqual(draft.functionProfiles[0]?.intensityRules.map((entry) => [entry.intensity, entry.sourceRowId]), [[1, "func_0001"], [2, "func_0002"], [3, "func_0003"]]);
});

test("显式拉取只生成草稿，不发布或改写历史 Snapshot", () => {
  const initial = createSeedState();
  const registered = recordFeishuSourceRevision(withoutReplaceableRuleReferences(initial), revision);
  const sourceDraft = importCanonicalRuleSource({ sourceRevision: revision, ...fixture(), importedAt: revision.pulledAt });
  const applied = applyCanonicalRuleSourceDraft(registered, sourceDraft);
  assert.equal(applied.templates[0]?.id, "wtpl_0001");
  assertExplicitPullDidNotPublish(registered, applied);
  assert.deepEqual(registered.configurationSnapshots, initial.configurationSnapshots);
});

test("空表或重复稳定 ID 时 fail closed，不覆盖当前正式可用数据", () => {
  const initial = recordFeishuSourceRevision(createSeedState(), revision);
  const duplicate = fixture();
  duplicate.weightValues.push(structuredClone(duplicate.weightValues[2]));
  const invalid = importCanonicalRuleSource({ sourceRevision: revision, ...duplicate, importedAt: revision.pulledAt });
  assert.ok(invalid.issues.some((issue) => issue.code === "WEIGHT_TEMPLATE_ID_DUPLICATE"));
  assert.throws(() => applyCanonicalRuleSourceDraft(initial, invalid), /已保留当前可用规则/);
  assert.equal(initial.templates[0].id, "T01");

  const empty = importCanonicalRuleSource({ sourceRevision: revision, weightValues: [], typeValues: [], functionValues: [], importedAt: revision.pulledAt });
  assert.deepEqual(empty.issues.filter((issue) => issue.level === "error").map((issue) => issue.code).sort(), ["FUNCTION_PROFILE_EMPTY", "ITEM_TYPE_EMPTY", "WEIGHT_TEMPLATE_EMPTY"]);

  const missingId = fixture();
  missingId.weightValues.push(row({ 3: "路亚", 5: "W02", 6: 2, 7: 3 }));
  const missingIdDraft = importCanonicalRuleSource({ sourceRevision: revision, ...missingId, importedAt: revision.pulledAt });
  assert.ok(missingIdDraft.issues.some((issue) => issue.code === "WEIGHT_TEMPLATE_ID_MISSING"));
  assert.throws(() => applyCanonicalRuleSourceDraft(initial, missingIdDraft), /已保留当前可用规则/);

  const legacyMethodText = fixture();
  legacyMethodText.weightValues[2]![3] = "未绑定钓法";
  assert.deepEqual(importCanonicalRuleSource({ sourceRevision: revision, ...legacyMethodText, importedAt: revision.pulledAt }).issues, []);
});

test("缺失源机器 ID 或未绑定钓法时 fail closed", () => {
  const missing = fixture();
  missing.weightValues.push(row({ 3: "路亚", 5: "W99", 6: 1, 7: 2 }));
  missing.typeValues.push(row({ 2: "RodType", 3: "缺 ID 类型", 4: "路亚", 5: 1.1 }));
  missing.functionValues.push(row({ 3: "远投|3", 4: "远投", 5: 3, 7: 1.4 }));
  const invalid = importCanonicalRuleSource({ sourceRevision: revision, ...missing, importedAt: revision.pulledAt });
  assert.deepEqual(invalid.issues.filter((issue) => issue.level === "error").map((issue) => issue.code).sort(), [
    "FUNCTION_ROW_ID_MISSING",
    "ITEM_TYPE_ID_MISSING",
    "WEIGHT_TEMPLATE_ID_MISSING",
  ]);

  const legacyMethodText = fixture();
  legacyMethodText.weightValues[2]![3] = "未知钓法";
  assert.equal(importCanonicalRuleSource({ sourceRevision: revision, ...legacyMethodText, importedAt: revision.pulledAt }).issues.some((issue) => issue.code === "WEIGHT_TEMPLATE_ROW_INVALID"), false);

});

test("FunctionProfile 只按稳定父级归组，并验证改名、强度与缺失绑定", () => {
  const missingBinding = fixture();
  missingBinding.functionValues[1]![3] = "父级";
  const withoutBinding = importCanonicalRuleSource({ sourceRevision: revision, ...missingBinding, importedAt: revision.pulledAt });
  assert.ok(withoutBinding.issues.some((issue) => issue.code === "FUNCTION_PROFILE_GROUP_BINDING_MISSING"));

  const singleRename = fixture();
  singleRename.functionValues[2]![5] = "远投（改名）";
  const renamedOne = importCanonicalRuleSource({ sourceRevision: revision, ...singleRename, importedAt: revision.pulledAt });
  assert.ok(renamedOne.issues.some((issue) => issue.code === "FUNCTION_GROUP_DISPLAY_NAME_CONFLICT"));
  assert.equal(renamedOne.functionProfiles.length, 0);

  const renamedGroup = fixture();
  for (const sourceRow of renamedGroup.functionValues.slice(2)) sourceRow![5] = "远投（改名）";
  const renamedAll = importCanonicalRuleSource({ sourceRevision: revision, ...renamedGroup, importedAt: revision.pulledAt });
  assert.deepEqual(renamedAll.issues, []);
  assert.equal(renamedAll.functionProfiles[0]?.id, "function:cast");

  const duplicateIntensity = fixture();
  duplicateIntensity.functionValues[4]![4] = "远投|2";
  duplicateIntensity.functionValues[4]![6] = 2;
  const duplicate = importCanonicalRuleSource({ sourceRevision: revision, ...duplicateIntensity, importedAt: revision.pulledAt });
  assert.ok(duplicate.issues.some((issue) => issue.code === "FUNCTION_GROUP_INTENSITY_DUPLICATE"));
  assert.equal(duplicate.functionProfiles.length, 0);

  const missingIntensity = fixture();
  missingIntensity.functionValues.pop();
  const missing = importCanonicalRuleSource({ sourceRevision: revision, ...missingIntensity, importedAt: revision.pulledAt });
  assert.ok(missing.issues.some((issue) => issue.code === "FUNCTION_GROUP_INTENSITY_MISSING"));
  assert.equal(missing.functionProfiles.length, 0);
});

test("02 钓法稳定行对 01 标杆生成派生模板，02.5 不反向参与计算", () => {
  const source = fixture();
  const methodHeader = row({ 1: "机器ID（勿改）", 2: "钓具大类", 3: "钓法", 4: "竿拉力" });
  const methodValues = [[], methodHeader,
    row({ 1: "fishing_rod_0001", 2: "竿", 3: "路亚", 4: 1.5 }),
    [],
    methodHeader,
    row({ 1: "fishing_reel_0001", 2: "轮", 3: "泛用", 4: 0.5 }),
  ];
  const draft = importCanonicalRuleSource({ sourceRevision: revision, ...source, methodValues, methodTemplateReviewValues: [["故意错误的审核结果"]], importedAt: revision.pulledAt });
  assert.equal(draft.templates.find((entry) => entry.id === "wtpl_0001:fishing_rod_0001")?.values["杆最大拉力kgf"], 15);
  assert.equal(draft.templates.some((entry) => entry.id.includes("故意错误")), false);
  const once = structuredClone(draft);
  const twice = importCanonicalRuleSource({ sourceRevision: revision, ...source, methodValues, methodTemplateReviewValues: [["不同审核结果"]], importedAt: revision.pulledAt });
  assert.deepEqual(twice.templates, once.templates);
});

test("schema v15 顺序迁移保留历史状态并补 canonical 草稿集合", () => {
  const current = createSeedState();
  const v15 = { ...structuredClone(current), schemaVersion: 15 } as unknown as Record<string, unknown>;
  delete v15.canonicalRuleSourceDrafts;
  const migrated = migrateWorkspaceState(v15);
  assert.equal(migrated.schemaVersion, 18);
  assert.deepEqual(migrated.canonicalRuleSourceDrafts, []);
  assert.deepEqual(migrated.configurationSnapshots, current.configurationSnapshots);
});

test("稳定身份只读取精确 B:C 区间，不被同表 canonical A1 全表覆盖", () => {
  const rows = identityRowsFromRanges([
    { sheetId: "d6e928", range: "B1:C54", valueRange: { values: [["机器ID", "同步状态"], ["wtpl_0001", "BOUND"]] } },
    { sheetId: "d6e928", range: "A1:BJ66", valueRange: { values: [["展示名", "机器ID"], ["路亚", "wtpl_0001"]] } },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.stableId, "wtpl_0001");
});

test("钓法不兼容的类型不会套用规则，且作为硬错误返回", () => {
  const draft = importCanonicalRuleSource({ sourceRevision: revision, ...fixture(), importedAt: revision.pulledAt });
  const state = applyCanonicalRuleSourceDraft(
    recordFeishuSourceRevision(withoutReplaceableRuleReferences(), revision),
    draft,
  );
  const candidate = structuredClone(createSeedState().candidates[0]!);
  candidate.templateId = "wtpl_0002";
  candidate.selections.structureId = "type_rod_0001";
  candidate.selections.functionId = "func_0001";
  const result = calculateCandidate(state, candidate);
  assert.equal(result.calculated.values["杆最大拉力kgf"], 10.8);
  assert.ok(result.calculated.issues.some((issue) => issue.code === "METHOD_TYPE_INCOMPATIBLE"));
});

test("无法无损迁移旧 Candidate/Recipe 引用时不切换 canonical 规则", () => {
  const initial = recordFeishuSourceRevision(createSeedState(), revision);
  const draft = importCanonicalRuleSource({ sourceRevision: revision, ...fixture(), importedAt: revision.pulledAt });
  assert.throws(() => applyCanonicalRuleSourceDraft(initial, draft), /REFERENCE_MIGRATION_REQUIRED/);
  assert.equal(initial.templates[0]?.id, "T01");
});

test("当前 v3 CandidateSearchRecipe 与 legacy partConstraints 悬空时不切换规则", () => {
  const initial = createSeedState();
  initial.candidates = [];
  initial.recipes = [{
    ...initial.recipes[0]!,
    templateIds: [],
    structureIds: [],
    functionIds: [],
    performanceIds: [],
    technologyIds: [],
    partConstraints: {
      rod: {
        templateIds: ["T01"],
        typeIds: ["structure:旧直柄"],
        materialIds: [],
        requiredAffixIds: [],
        optionalAffixPoolIds: [],
        notes: "历史分部位引用",
      },
    },
  }];
  initial.candidateSearchRecipes = [{
    id: "candidate-search:legacy",
    revision: 1,
    name: "旧搜索",
    methodIds: ["method:legacy"],
    typeIds: ["type:legacy"],
    functionIds: ["function:legacy"],
    performanceIds: [],
    qualityIds: [],
    targetPullRangeKg: { min: 1, max: 2 },
    maxCandidates: 1,
    notes: "",
  }];
  const registered = recordFeishuSourceRevision(initial, revision);
  const draft = importCanonicalRuleSource({ sourceRevision: revision, ...fixture(), importedAt: revision.pulledAt });
  assert.throws(() => applyCanonicalRuleSourceDraft(registered, draft), /REFERENCE_MIGRATION_REQUIRED/);
  assert.equal(initial.candidateSearchRecipes[0]?.methodIds[0], "method:legacy");
  assert.equal(initial.recipes[0]?.partConstraints?.rod?.templateIds[0], "T01");
});

test("RuleSet 草稿冻结飞书内容哈希，发布前篡改会被阻断", () => {
  const initial = recordFeishuSourceRevision(withoutReplaceableRuleReferences(), revision);
  const sourceDraft = importCanonicalRuleSource({ sourceRevision: revision, ...fixture(), importedAt: revision.pulledAt });
  const applied = applyCanonicalRuleSourceDraft(initial, sourceDraft);
  const drafted = createRuleSetDraftFromPull({ state: applied, sourceRevisionId: revision.id, createdAt: "2026-07-23T00:01:00.000Z", createdBy: "author" });
  assert.equal(drafted.ruleSetDraft.sourceContentHash, sourceDraft.contentHash);
  const tampered = structuredClone(drafted.state);
  tampered.canonicalRuleSourceDrafts[0].templates[0].values["杆最大拉力kgf"] = 999;
  assert.throws(() => publishRuleSetVersion({ state: tampered, ruleSetDraftId: drafted.ruleSetDraft.id, publishedAt: "2026-07-23T00:02:00.000Z", publishedBy: "reviewer" }), /内容哈希不一致/);
});
