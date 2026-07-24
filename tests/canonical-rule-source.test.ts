import assert from "node:assert/strict";
import test from "node:test";
import { importCanonicalRuleSource } from "../lib/canonical-rule-source";
import { calculateCandidate } from "../lib/engine";
import { CURRENT_WORKSPACE_SCHEMA_VERSION, migrateWorkspaceState } from "../lib/migrations";
import { identityRowsFromRanges, weightTemplateDraftFromCanonicalRuleDraft } from "../lib/rule-workbook-inspection";
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

test("重量模板草稿继承 canonical 坏行错误并冻结表头驱动单元格来源", () => {
  const values = [
    ["", "机器ID（勿改）", "同步状态", "钓法", "备注", "重量段", "最小拉力", "最大拉力", "鱼重等级", "竿拉力"],
    ["", "wtpl_ok", "BOUND", "路亚", "说明", "轻", 1, 2, 3, 10],
    ["", "", "BOUND", "路亚", "坏行", "中", "", 3, 4, 12],
    ["", "重量段", "最大拉力", "机器ID（勿改）", "最小拉力", "备注", "同步状态", "鱼重等级", "竿拉力"],
    ["", "重", 6, "wtpl_second", 4, "第二块", "BOUND", 5, 20],
    ["", "重", "", "wtpl_blank_max", 4, "空最大值", "BOUND", 5, 20],
    ["", "重", 3, "wtpl_inverted", 4, "倒置区间", "BOUND", 5, 20],
  ];
  const canonicalRuleDraft = importCanonicalRuleSource({ sourceRevision: revision, ...baseFixture(), weightValues: values, importedAt: revision.pulledAt });
  const draft = weightTemplateDraftFromCanonicalRuleDraft({ sourceRevision: revision, canonicalRuleDraft, weightValues: values, importedAt: revision.pulledAt });
  assert.equal(draft.formalStatus, "NON_FORMAL");
  assert.ok(draft.issues.some((issue) => issue.code === "WEIGHT_TEMPLATE_ID_MISSING"));
  assert.equal(draft.issues.find((issue) => issue.code === "WEIGHT_TEMPLATE_ID_MISSING")?.sourceCell?.cell, "B3");
  const invalidCells = draft.issues.filter((issue) => issue.code === "WEIGHT_TEMPLATE_ROW_INVALID").map((issue) => issue.sourceCell?.cell);
  assert.ok(invalidCells.includes("C6"));
  assert.ok(invalidCells.includes("E7:C7"));
  assert.deepEqual(draft.templates[0]?.source.cells, {
    machineId: "B2", fishMinKg: "G2", fishMaxKg: "H2", nominalFishKg: "G2:H2", weightBand: "F2",
    "机器ID（勿改）": "B2", "同步状态": "C2", "钓法": "D2", "备注": "E2", "重量段": "F2", "最小拉力": "G2", "最大拉力": "H2", "鱼重等级": "I2", "竿拉力": "J2",
  });
  assert.deepEqual(draft.templates.find((template) => template.id.startsWith("wtpl_second"))?.source.cells, {
    machineId: "D5", fishMinKg: "E5", fishMaxKg: "C5", nominalFishKg: "E5:C5", weightBand: "B5",
    "重量段": "B5", "最大拉力": "C5", "机器ID（勿改）": "D5", "最小拉力": "E5", "备注": "F5", "同步状态": "G5", "鱼重等级": "H5", "竿拉力": "I5",
  });
});

function baseFixture() {
  const weightHeader = row({ 1: "机器ID（勿改）", 2: "同步状态", 3: "钓法", 4: "备注", 5: "重量段", 6: "最小拉力", 7: "最大拉力", 8: "鱼重等级", 9: "竿拉力", 10: "轮拉力", 11: "线拉力", 12: "竿调性" });
  const typeHeader = row({ 1: "机器ID（勿改）", 2: "实体类型", 3: "重量段", 4: "钓法", 5: "具体类型", 6: "竿拉力", 7: "修理系数" });
  const methodHeader = row({ 1: "机器ID（勿改）", 2: "钓具大类", 3: "钓法", 4: "竿拉力" });
  const functionHeader = (parameter: string) => row({ 1: "机器ID（勿改）", 2: "实体类型", 3: "功能定位", 4: "定位/类型", 5: "级别", 6: "评分系数", 7: "功能分组ID（勿改）", 8: parameter });
  const functionProfileValues = [
    ["functionProfileId（永久）", "displayName", "status", "supportedIntensities", "", "", "", "", "", "", "", "", "", "", "", "", "rodFunctionGroupId", "reelFunctionGroupId", "lineFunctionGroupId"],
    ["function:cast", "远投", "ACTIVE", "[1,2,3]", "", "", "", "", "", "", "", "", "", "", "", "", "funcgrp_rod_0001", "funcgrp_reel_0001", "funcgrp_line_0001"],
  ];
  const functionBlock = (part: "rod" | "reel" | "line", parameter: string) => [
    functionHeader(parameter),
    ...[1, 2, 3].map((intensity) => row({ 1: `func_${part}_${String(intensity).padStart(4, "0")}`, 2: "FunctionProfile", 3: `远投|${intensity}`, 4: "远投", 5: intensity, 6: intensity, 7: `funcgrp_${part}_0001`, 8: 1 + intensity / 10 })),
  ];
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
    functionProfileValues,
    functionValues: [[], ...functionBlock("rod", "竿拉力"), [], ...functionBlock("reel", "轮拉力"), [], ...functionBlock("line", "线拉力")],
    methodValues: [[], methodHeader,
      row({ 1: "fishing_rod_0001", 2: "竿", 3: "路亚", 4: 1 }),
      row({ 1: "fishing_reel_0001", 2: "轮", 3: "泛用", 4: 1 }),
      row({ 1: "fishing_line_0001", 2: "线", 3: "泛用", 4: 1 }),
    ],
  };
}

function productionShapeFixture() {
  const source = baseFixture();
  const profiles = [
    ["function:all_round", "泛用", "all_round"],
    ["function:distance_casting", "远投", "distance_casting"],
    ["function:finesse_feedback", "精细感知", "finesse_feedback"],
    ["function:rapid_control", "快速操控", "rapid_control"],
    ["function:cover_power", "障碍强攻", "cover_power"],
    ["function:big_bait_power", "大饵动力", "big_bait_power"],
    ["function:endurance", "持久征服", "endurance"],
  ] as const;
  source.functionProfileValues = [
    ["functionProfileId（永久）", "displayName", "englishKey", "status", "supportedIntensities", "", "", "", "", "", "", "", "", "", "", "", "rodFunctionGroupId", "reelFunctionGroupId", "lineFunctionGroupId"],
    ...profiles.map(([id, name, key], index) => {
      const row = Array.from({ length: 19 }, () => "");
      row[0] = id; row[1] = name; row[2] = key; row[3] = "ACTIVE"; row[4] = index === 0 ? "[1]" : "[1,2,3]";
      row[16] = `funcgrp_rod_${String(index + 1).padStart(4, "0")}`;
      row[17] = `funcgrp_reel_${String(index + 1).padStart(4, "0")}`;
      row[18] = `funcgrp_line_${String(index + 1).padStart(4, "0")}`;
      return row;
    }),
  ];
  const block = (part: "rod" | "reel" | "line", parameter: string) => {
    const header = row({ 1: "机器ID（勿改）", 2: "实体类型", 3: "功能定位", 4: "定位/类型", 5: "级别", 6: "评分系数", 7: "功能分组ID（勿改）", 8: "覆盖重量段", 9: part === "rod" ? "适用竿类型" : part === "reel" ? "适用轮类型" : "适用线类型", 10: parameter });
    return [header, ...profiles.flatMap(([, name], profileIndex) => {
      const intensities = profileIndex === 0 ? [1] : [1, 2, 3];
      return intensities.map((intensity) => row({
        1: `func_${part}_${String(profileIndex + 1).padStart(4, "0")}_${intensity}`,
        2: "FunctionRuleRow", 3: `${name}|${intensity}`, 4: name, 5: intensity, 6: 1,
        7: `funcgrp_${part}_${String(profileIndex + 1).padStart(4, "0")}`,
        8: "W01", 9: "适用类型", 10: 1 + intensity / 10,
      }));
    })];
  };
  source.functionValues = [[], ...block("rod", "竿拉力"), [], ...block("reel", "轮拉力"), [], ...block("line", "线拉力")];
  return source;
}

function fixture() {
  return productionShapeFixture();
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
  assert.equal(draft.templates[0].id, "wtpl_0001:fishing_rod_0001");
  assert.equal(draft.templates[0].methodId, "fishing_rod_0001");
  assert.equal(draft.templates[0].fishWeightLevel, 1);
  assert.equal(draft.templates[0].nominalTargetPullKgf, 0.8);
  assert.equal(draft.templates[0].rangeSemantics, "target_pull");
  assert.equal(draft.templates[0].values["杆最大拉力kgf"], 10);
  assert.equal(draft.parameters.find((entry) => entry.key === "杆最大拉力kgf")?.label, "竿拉力");
  assert.equal(draft.parameters.find((entry) => entry.key === "竿修理系数")?.itemKind, "rod");
  assert.equal(draft.methodProfiles.length, 3);
  assert.equal(draft.itemTypeProfiles.find((entry) => entry.id === "type_rod_0001")?.rules[0].value, 1.1);
  assert.equal(draft.itemTypeProfiles.find((entry) => entry.id === "type_rod_0001")?.rules[0].sourceCell, "G3");
  assert.deepEqual(draft.modifiers.find((entry) => entry.id === "type_rod_0001")?.methodIds, ["method:lure"]);
  assert.equal(draft.functionProfiles.length, 7);
  assert.deepEqual(draft.functionProfiles[0]?.intensityRules.map((entry) => [entry.itemPartId, entry.intensity]), [["part:rod", 1], ["part:reel", 1], ["part:line", 1]]);
});

test("显式拉取只生成草稿，不发布或改写历史 Snapshot", () => {
  const initial = createSeedState();
  const registered = recordFeishuSourceRevision(withoutReplaceableRuleReferences(initial), revision);
  const sourceDraft = importCanonicalRuleSource({ sourceRevision: revision, ...fixture(), importedAt: revision.pulledAt });
  const applied = applyCanonicalRuleSourceDraft(registered, sourceDraft);
  assert.equal(applied.templates[0]?.id, "wtpl_0001:fishing_rod_0001");
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
  assert.deepEqual(empty.issues.filter((issue) => issue.level === "error").map((issue) => issue.code).sort(), ["FUNCTION_PROFILE_EMPTY", "FUNCTION_RULE_MEMBER_SET_MISMATCH", "ITEM_TYPE_EMPTY", "WEIGHT_TEMPLATE_EMPTY"]);

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

test("FunctionProfile 只按两级稳定外键归组，并拒绝未知、重复或缺失的部件强度", () => {
  const unknownGroup = fixture();
  unknownGroup.functionValues[2]![7] = "funcgrp_rod_unknown";
  assert.ok(importCanonicalRuleSource({ sourceRevision: revision, ...unknownGroup, importedAt: revision.pulledAt }).issues.some((issue) => issue.code === "FUNCTION_PROFILE_PARENT_UNKNOWN"));

  const renamed = fixture();
  renamed.functionValues[2]![4] = "任意改名";
  const renamedDraft = importCanonicalRuleSource({ sourceRevision: revision, ...renamed, importedAt: revision.pulledAt });
  assert.deepEqual(renamedDraft.issues, []);
  assert.equal(renamedDraft.functionProfiles[0]?.id, "function:all_round");

  const duplicateIntensity = fixture();
  duplicateIntensity.functionValues[4]![5] = 1;
  const duplicate = importCanonicalRuleSource({ sourceRevision: revision, ...duplicateIntensity, importedAt: revision.pulledAt });
  assert.ok(duplicate.issues.some((issue) => issue.code === "FUNCTION_GROUP_PART_INTENSITY_DUPLICATE"));

  const missingIntensity = fixture();
  missingIntensity.functionValues.splice(4, 1);
  const missing = importCanonicalRuleSource({ sourceRevision: revision, ...missingIntensity, importedAt: revision.pulledAt });
  assert.ok(missing.issues.some((issue) => issue.code === "FUNCTION_GROUP_PART_INTENSITY_MISSING"));
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

test("02 缺少已启用部位的稳定钓法块时 fail closed", () => {
  const source = fixture();
  source.methodValues = [];
  const draft = importCanonicalRuleSource({ sourceRevision: revision, ...source, importedAt: revision.pulledAt });
  assert.ok(draft.issues.some((issue) => issue.code === "METHOD_PART_COVERAGE_MISSING"));
});

test("schema v15 顺序迁移保留历史状态并补 canonical 草稿集合", () => {
  const current = createSeedState();
  const v15 = { ...structuredClone(current), schemaVersion: 15 } as unknown as Record<string, unknown>;
  delete v15.canonicalRuleSourceDrafts;
  const migrated = migrateWorkspaceState(v15);
  assert.equal(migrated.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.deepEqual(migrated.canonicalRuleSourceDrafts, []);
  assert.deepEqual(migrated.weightTemplatePolicyDrafts, []);
  assert.deepEqual(migrated.configurationSnapshots, current.configurationSnapshots);
});

test("重量模板稳定身份只读取精确 BG:BH 区间，不被同表完整值区覆盖", () => {
  const rows = identityRowsFromRanges([
    { sheetId: "d6e928", range: "BG1:BH66", valueRange: { values: [["机器ID", "同步状态"], ["wtpl_0001", "BOUND"]] } },
    { sheetId: "d6e928", range: "A1:BH66", valueRange: { values: [["展示名", "机器ID"], ["路亚", "wtpl_0001"]] } },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.stableId, "wtpl_0001");
});

test("04.0 Q:S 的真实 Id 表头不作为 FunctionPartGroup 实体", () => {
  const rows = identityRowsFromRanges([{
    sheetId: "mLpTLK",
    range: "Q1:S8",
    valueRange: { values: [["rodFunctionGroupId", "reelFunctionGroupId", "lineFunctionGroupId"], ["funcgrp_rod_0001", "funcgrp_reel_0001", "funcgrp_line_0001"]] },
  }]);
  assert.deepEqual(rows.map((entry) => entry.stableId), ["funcgrp_rod_0001", "funcgrp_reel_0001", "funcgrp_line_0001"]);
  assert.ok(rows.every((entry) => entry.entityType === "FunctionPartGroup"));
});

test("04.0 父级常量的真实 functionProfileId 表头不作为 FunctionProfile 实体", () => {
  const rows = identityRowsFromRanges([{
    sheetId: "mLpTLK",
    range: "A1:S8",
    valueRange: { values: [["functionProfileId（永久）", "displayName"], ["function:all_round", "泛用"]] },
  }]);
  assert.deepEqual(rows.map((entry) => entry.stableId), ["function:all_round"]);
  assert.deepEqual(rows.map((entry) => entry.entityType), ["FunctionProfile"]);
});

test("ACTIVE FunctionProfile 整组成员缺失时 fail closed", () => {
  const source = fixture();
  source.functionValues = [[]];
  const draft = importCanonicalRuleSource({ sourceRevision: revision, ...source, importedAt: revision.pulledAt });
  assert.ok(draft.issues.some((issue) => issue.code === "FUNCTION_PROFILE_PARENT_MEMBERS_MISSING"));
});

test("04 生产同形的 7 父级、21 分组与 57 成员规则可确定导入", () => {
  const source = productionShapeFixture();
  const first = importCanonicalRuleSource({ sourceRevision: revision, ...source, importedAt: revision.pulledAt });
  const second = importCanonicalRuleSource({ sourceRevision: revision, ...source, importedAt: revision.pulledAt });
  assert.deepEqual(first.issues, []);
  assert.equal(first.functionProfiles.length, 7);
  assert.equal(first.modifiers.filter((entry) => entry.dimension === "function").length, 57);
  assert.equal(first.functionProfiles.find((entry) => entry.id === "function:all_round")?.intensityRules.length, 3);
  assert.ok(first.functionProfiles.filter((entry) => entry.id !== "function:all_round").every((entry) => entry.intensityRules.length === 9));
  assert.ok(first.functionProfiles.every((entry) => entry.intensityRules.every((rule) => ["part:rod", "part:reel", "part:line"].includes(rule.itemPartId ?? ""))));
  assert.equal(second.contentHash, first.contentHash);
  assert.deepEqual(second.functionProfiles, first.functionProfiles);
  const identityRanges = [
    { sheetId: "mLpTLK", range: "A1:S8", valueRange: { values: source.functionProfileValues } },
    { sheetId: "mLpTLK", range: "Q1:S8", valueRange: { values: source.functionProfileValues.map((entry) => entry.slice(16, 19)) } },
  ];
  const identities = identityRowsFromRanges(identityRanges);
  assert.equal(identities.filter((entry) => entry.entityType === "FunctionProfile").length, 7);
  assert.equal(identities.filter((entry) => entry.entityType === "FunctionPartGroup").length, 21);
  assert.deepEqual(identityRowsFromRanges(identityRanges), identities);

  const invalid = productionShapeFixture();
  invalid.functionValues[2]![5] = 2;
  assert.ok(importCanonicalRuleSource({ sourceRevision: revision, ...invalid, importedAt: revision.pulledAt }).issues.some((issue) => issue.code === "FUNCTION_INTENSITY_UNSUPPORTED"));

  const removedParent = productionShapeFixture();
  removedParent.functionProfileValues.pop();
  removedParent.functionValues = removedParent.functionValues.filter((entry) => entry[7] !== "funcgrp_rod_0007" && entry[7] !== "funcgrp_reel_0007" && entry[7] !== "funcgrp_line_0007");
  assert.ok(importCanonicalRuleSource({ sourceRevision: revision, ...removedParent, importedAt: revision.pulledAt }).issues.some((issue) => issue.code === "FUNCTION_PROFILE_PARENT_SET_MISMATCH"));

  const swappedGroup = productionShapeFixture();
  [swappedGroup.functionProfileValues[1]![16], swappedGroup.functionProfileValues[2]![16]] = [swappedGroup.functionProfileValues[2]![16], swappedGroup.functionProfileValues[1]![16]];
  assert.ok(importCanonicalRuleSource({ sourceRevision: revision, ...swappedGroup, importedAt: revision.pulledAt }).issues.some((issue) => issue.code === "FUNCTION_PROFILE_PART_GROUP_BINDING_MISMATCH"));

  const wrongPart = productionShapeFixture();
  wrongPart.functionProfileValues[1]![17] = "funcgrp_reel_0002";
  assert.ok(importCanonicalRuleSource({ sourceRevision: revision, ...wrongPart, importedAt: revision.pulledAt }).issues.some((issue) => issue.code === "FUNCTION_PROFILE_PART_GROUP_BINDING_MISMATCH"));

  const replacedGroup = productionShapeFixture();
  replacedGroup.functionProfileValues[1]![18] = "funcgrp_line_0999";
  assert.ok(importCanonicalRuleSource({ sourceRevision: revision, ...replacedGroup, importedAt: revision.pulledAt }).issues.some((issue) => issue.code === "FUNCTION_PROFILE_PART_GROUP_BINDING_MISMATCH"));

  const shared = productionShapeFixture();
  shared.functionValues[22]![10] = "修理系数";
  shared.functionValues[43]![10] = "购买系数";
  const sharedDraft = importCanonicalRuleSource({ sourceRevision: revision, ...shared, importedAt: revision.pulledAt });
  assert.deepEqual(sharedDraft.issues, []);
  assert.ok(sharedDraft.parameters.some((entry) => entry.key === "轮修理系数" && entry.itemPartId === "part:reel"));
  assert.ok(sharedDraft.parameters.some((entry) => entry.key === "线购买系数" && entry.itemPartId === "part:line"));
  assert.ok(sharedDraft.functionProfiles.some((profile) => profile.intensityRules.some((rule) => rule.itemPartId === "part:reel" && rule.rules.some((entry) => entry.parameterKey === "轮修理系数"))));
  assert.ok(sharedDraft.functionProfiles.some((profile) => profile.intensityRules.some((rule) => rule.itemPartId === "part:line" && rule.rules.some((entry) => entry.parameterKey === "线购买系数"))));
  assert.ok(sharedDraft.functionProfiles.every((profile) => profile.intensityRules.every((entry) => entry.rules.every((rule) => sharedDraft.parameters.filter((parameter) => parameter.key === rule.parameterKey).length === 1))));
});

test("钓法不兼容的类型不会套用规则，且作为硬错误返回", () => {
  const draft = importCanonicalRuleSource({ sourceRevision: revision, ...fixture(), importedAt: revision.pulledAt });
  const state = applyCanonicalRuleSourceDraft(
    recordFeishuSourceRevision(withoutReplaceableRuleReferences(), revision),
    draft,
  );
  const candidate = structuredClone(createSeedState().candidates[0]!);
  candidate.templateId = "wtpl_0002:fishing_rod_0001";
  candidate.selections.structureId = "type_rod_0001";
  candidate.selections.functionId = "func_rod_0001_1";
  const result = calculateCandidate(state, candidate);
  assert.equal(result.calculated.values["杆最大拉力kgf"], 9.9);
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
