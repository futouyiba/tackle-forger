import assert from "node:assert/strict";
import test from "node:test";
import { resolveAffixConfiguration } from "../lib/affix-engine";
import {
  assessLegacyModelAffixValue,
  assessModelAffixValue,
  importQualityValuePolicyDraft,
  type AffixAliasBinding,
  type QualityCombinationSourceCell,
  type QualityValueRange,
} from "../lib/quality-value-policy";
import type { Technology, V3Affix } from "../lib/types";

const REVISION = "2922";
const source = (sheetId: string, cell: string) => ({ sheetId, cell });
const ranges: QualityValueRange[] = [
  ["quality_c_green", 0, 20, false, "E5:F5"],
  ["quality_b_blue", 20, 40, false, "E6:F6"],
  ["quality_a_purple", 40, 65, false, "E7:F7"],
  ["quality_s_orange", 65, 100, false, "E8:F8"],
].map(([qualityId, minScore, maxScore, maxInclusive, cell]) => ({
  qualityId: qualityId as QualityValueRange["qualityId"],
  minScore: Number(minScore),
  maxScore: Number(maxScore),
  maxInclusive: Boolean(maxInclusive),
  status: "SOURCE",
  source: source("FqD4j7", String(cell)),
}));

function affix(id: string, alias: string, valueScore: number): V3Affix {
  return {
    id,
    version: 1,
    name: alias,
    category: "attribute",
    itemPartId: "part:rod",
    generationPolicy: "normal",
    rarity: "common",
    valueScore,
    tags: [],
    attributeEffects: [],
    description: "",
    enabled: true,
  };
}

function policy(input: {
  matrixCells?: QualityCombinationSourceCell[];
  aliases?: AffixAliasBinding[];
  pricingScoreEndpoints?: Array<{ value: number; status: "SOURCE"; source: { sheetId: string; cell: string } }>;
} = {}) {
  return importQualityValuePolicyDraft({
    sourceRevisionId: `feishu-revision:${REVISION}`,
    sourceRevision: REVISION,
    ranges,
    aliases: input.aliases ?? [],
    matrixCells: input.matrixCells ?? [],
    pricingScoreEndpoints: input.pricingScoreEndpoints,
    performanceScoringEnabled: false,
    performanceScoringSource: source("FqD4j7", "B2"),
    importedAt: "2026-07-22T00:00:00.000Z",
  });
}

test("品质评分：15 词条分 + 3 组合分，再乘功能系数 1.03 得到 18.54", () => {
  const a = affix("affix_rod_a", "甲", 8);
  const b = affix("affix_rod_b", "乙", 7);
  const aliases = [
    { itemPartId: "part:rod", alias: "甲", affixId: a.id, source: source("zrVOxd", "F3") },
    { itemPartId: "part:rod", alias: "乙", affixId: b.id, source: source("zrVOxd", "F4") },
  ];
  const draft = policy({
    aliases,
    matrixCells: [{ itemPartId: "part:rod", leftAlias: "甲", rightAlias: "乙", value: 3, source: source("FqD4j7", "D11") }],
  });
  const result = assessModelAffixValue({
    policy: draft,
    modelRevisionId: "model:1@1",
    selectedQualityId: "quality_c_green",
    configuration: resolveAffixConfiguration([a, b], [], [a.id, b.id], []),
    functionScoreFactor: { value: 1.03, status: "SOURCE", source: source("vviXo0", "G4") },
    scoringPolicyVersion: draft.id,
  });
  assert.equal(result.baseAffixScore, 15);
  assert.equal(result.combinationScore, 3);
  assert.equal(result.finalValueScore, 18.54);
  assert.equal(result.inSelectedQualityRange, true);
  assert.equal(result.performanceScoreFactor, undefined);
  assert.equal(result.trace.some((entry) => entry.step === "performance_factor"), false);
  assert.deepEqual(draft.legacyPerformanceScoringEvidence, {
    enabled: false,
    source: source("FqD4j7", "B2"),
  });
});

test("旧 Performance 评分只可通过显式历史重放入口恢复", () => {
  const a = affix("affix_rod_legacy", "旧词条", 10);
  const draft = policy();
  const result = assessLegacyModelAffixValue({
    policy: draft,
    modelRevisionId: "legacy:model@1",
    selectedQualityId: "quality_c_green",
    configuration: resolveAffixConfiguration([a], [], [a.id], []),
    functionScoreFactor: { value: 1, status: "SOURCE", source: source("vviXo0", "G3") },
    performanceScoreFactor: { value: 1.5, status: "SOURCE", source: source("legacy", "P1") },
    scoringPolicyVersion: "legacy-scoring-v1",
  });
  assert.equal(result.finalValueScore, 15);
  assert.equal(result.performanceScoreFactor, 1.5);
  assert.equal(result.trace.at(-2)?.step, "performance_factor");
});

test("直接词条与 Technology 成员重复时只计一次", () => {
  const a = affix("affix_rod_a", "甲", 15);
  const technology: Technology = {
    id: "tech:1", version: 1, name: "技术", affixIds: [a.id], description: "",
    compatiblePerformanceProfileIds: [], compatibleSeriesIds: [],
    generationPolicy: "normal", valueScorePolicy: "members_only", enabled: true,
  };
  const configuration = resolveAffixConfiguration([a], [technology], [a.id], [technology.id]);
  const draft = policy();
  const result = assessModelAffixValue({
    policy: draft, modelRevisionId: "model:2@1", selectedQualityId: "quality_c_green",
    configuration,
    functionScoreFactor: { value: 1, status: "SOURCE", source: source("vviXo0", "G3") },
    scoringPolicyVersion: draft.id,
  });
  assert.equal(configuration.affixes.length, 1);
  assert.equal(result.baseAffixScore, 15);
});

test("负组合分只按无序词条对计一次，不转成硬兼容 deny", () => {
  const light = affix("affix_rod_light", "轻量", 7);
  const heavy = affix("affix_rod_heavy", "增重", -5);
  const aliases = [
    { itemPartId: "part:rod", alias: "轻量", affixId: light.id, source: source("zrVOxd", "F5") },
    { itemPartId: "part:rod", alias: "增重", affixId: heavy.id, source: source("zrVOxd", "F6") },
  ];
  const draft = policy({
    aliases,
    matrixCells: [
      { itemPartId: "part:rod", leftAlias: "轻量", rightAlias: "增重", value: -20, source: source("FqD4j7", "D12") },
      { itemPartId: "part:rod", leftAlias: "增重", rightAlias: "轻量", value: -20, source: source("FqD4j7", "C13") },
    ],
  });
  assert.equal(draft.combinationRules.length, 1);
  assert.equal(draft.combinationRules[0].valueScore, -20);
  assert.equal(draft.issues.some((entry) => entry.code.includes("COMPATIBILITY")), false);
});

test("空白镜像半区与显式 0 可区分，双侧不一致阻断策略", () => {
  const aliases = [
    { itemPartId: "part:rod", alias: "甲", affixId: "affix_rod_a", source: source("zrVOxd", "F3") },
    { itemPartId: "part:rod", alias: "乙", affixId: "affix_rod_b", source: source("zrVOxd", "F4") },
  ];
  const zero = policy({
    aliases,
    matrixCells: [
      { itemPartId: "part:rod", leftAlias: "甲", rightAlias: "乙", value: "", source: source("FqD4j7", "C11") },
      { itemPartId: "part:rod", leftAlias: "乙", rightAlias: "甲", value: 0, source: source("FqD4j7", "D12") },
    ],
  });
  assert.equal(zero.combinationRules.length, 1);
  assert.equal(zero.combinationRules[0].valueScore, 0);
  const conflict = policy({
    aliases,
    matrixCells: [
      { itemPartId: "part:rod", leftAlias: "甲", rightAlias: "乙", value: 0, source: source("FqD4j7", "C11") },
      { itemPartId: "part:rod", leftAlias: "乙", rightAlias: "甲", value: 1, source: source("FqD4j7", "D12") },
    ],
  });
  assert.equal(conflict.formalStatus, "NON_FORMAL");
  assert.ok(conflict.issues.some((entry) => entry.code === "QUALITY_COMBINATION_CONFLICT"));
});

test("组合诊断保留服务端部位证据，移动矩阵单元格不会改变其部位", () => {
  const draft = policy({
    aliases: [],
    matrixCells: [{
      itemPartId: "part:line",
      leftAlias: "未知甲",
      rightAlias: "未知乙",
      value: 1,
      source: source("FqD4j7", "M12"),
    }],
  });
  const issue = draft.issues.find((entry) => entry.code === "QUALITY_COMBINATION_ALIAS_UNKNOWN");
  assert.equal(issue?.sourceCell?.cell, "M12");
  assert.equal(issue?.itemPartId, "part:line");
  assert.deepEqual(structuredClone(issue), issue);
});

test("同 revision 的定价端点 score=100 触发品质边界冲突且保留来源 Trace", () => {
  const draft = policy({
    pricingScoreEndpoints: [{ value: 100, status: "SOURCE", source: source("u87sRh", "B179") }],
  });
  const issue = draft.issues.find((entry) => entry.code === "QUALITY_SCORE_BOUNDARY_CONFLICT");
  assert.equal(draft.formalStatus, "NON_FORMAL");
  assert.equal(issue?.source, "quality");
  assert.equal(issue?.sourceCell?.sheetId, "u87sRh");
  assert.equal(issue?.sourceCell?.cell, "B179");
  assert.equal(issue?.sourceRevision, REVISION);
});
