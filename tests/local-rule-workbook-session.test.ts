import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { projectLocalRuleWorkbookSession } from "../lib/local-rule-workbook-session";
import { createSeedState } from "../lib/seed";

/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures use broad types */

/**
 * 依赖边界：local-rule-workbook-session 是纯函数模块，
 * 不得导入飞书网络/鉴权/持久化模块。
 */
const FORBIDDEN_IMPORT = [
  /from\s+["']\.\/feishu-sheets["']/,
  /from\s+["']\.\/feishu["']/,
  /from\s+["']\.\/auth(?:-[^"']+)?["']/,
  /from\s+["']\.\/storage["']/,
  /from\s+["']\.\/sqlite(?:-[^"']+)?["']/,
];

test("local-rule-workbook-session 不导入飞书网络/鉴权/持久化模块", () => {
  const source = readFileSync("lib/local-rule-workbook-session.ts", "utf8");
  for (const pattern of FORBIDDEN_IMPORT) {
    const match = source.match(pattern);
    assert.equal(match, null, `违禁导入: ${match?.[0]}`);
  }
});

test("有效 inspection 投影后核心字段非空", () => {
  const baseState = createSeedState({ mode: "production" });
  const result = projectLocalRuleWorkbookSession(makeFixture() as any, baseState);

  assert.ok(result.parameters.length > 0, "parameters 应非空");
  assert.ok(result.templates.length > 0, "templates 应非空");
  assert.ok(result.seriesDefinitions.length > 0, "seriesDefinitions 应非空");
  assert.ok(Array.isArray(result.itemTypeProfiles), "itemTypeProfiles 应为数组");
  assert.ok(Array.isArray(result.functionProfiles), "functionProfiles 应为数组");
  assert.ok(Array.isArray(result.methodProfiles), "methodProfiles 应为数组");
  assert.ok(Array.isArray(result.modifiers), "modifiers 应为数组");
});

test("治理字段始终为空", () => {
  const baseState = createSeedState({ mode: "production" });
  const result = projectLocalRuleWorkbookSession(makeFixture() as any, baseState);

  assert.equal(result.feishuSourceRevisions.length, 0);
  assert.equal(result.ruleSetVersions.length, 0);
  assert.equal(result.sourceIdentityMigrationReports.length, 0);
  assert.equal(result.canonicalRuleSourceDrafts.length, 0);
  assert.equal(result.weightTemplatePolicyDrafts.length, 0);
  assert.equal(result.qualityValuePolicyDrafts.length, 0);
  assert.equal(result.pricingPolicyDrafts.length, 0);
  assert.equal(result.revisions.length, 0);
});

test("seed 的非投影字段保留原值", () => {
  const baseState = createSeedState({ mode: "production" });
  const result = projectLocalRuleWorkbookSession(makeFixture() as any, baseState);

  assert.equal(result.layers.length, baseState.layers.length);
  assert.equal(result.affixes.length, baseState.affixes.length);
  assert.equal(result.qualityBands.length, baseState.qualityBands.length);
  assert.deepEqual(result.affixScorePolicy, baseState.affixScorePolicy);
});

test("确定性——同输入得到同输出", () => {
  const baseState = createSeedState({ mode: "production" });
  const fixture = makeFixture() as any;

  const a = projectLocalRuleWorkbookSession(fixture, baseState);
  const b = projectLocalRuleWorkbookSession(fixture, baseState);

  assert.deepEqual(a, b);
});

test("不修改入参", () => {
  const baseState = createSeedState({ mode: "production" });
  const originalTemplates = baseState.templates.length;
  const originalParams = baseState.parameters.length;

  projectLocalRuleWorkbookSession(makeFixture() as any, baseState);

  assert.equal(baseState.templates.length, originalTemplates);
  assert.equal(baseState.parameters.length, originalParams);
});

// ── helpers ──

function makeFixture() {
  const now = "2026-07-27T00:00:00.000Z";
  return {
    observedAt: now,
    sourceRevision: {
      id: "test-src-rev", workbookRefId: "WQ8w", sourceRevision: "test-hash-001",
      sheets: [] as Array<{ sheetId: string; name: string; rowCount: number; columnCount: number }>,
      issues: [] as Array<{ sheetId: string; severity: "warning" | "error"; code: string; message: string }>,
    },
    identityRows: [] as Array<{
      itemId: string; displayName: string; proposedStableId?: string;
      state: string; requiresHumanConfirmation?: boolean;
    }>,
    identityReport: {
      reportId: "test-report", importedAt: now,
      sourceIdentityPolicy: { version: 1, sheetSpecs: [] },
      items: [] as Array<{
        itemId: string; displayName: string; proposedStableId?: string;
        state: string; requiresHumanConfirmation?: boolean;
      }>,
    },
    pricingDraft: {
      id: "test-pricing", sourceRevisionId: "test-src-rev", sourceRevision: "test-hash-001",
      sheetId: "", executionPolicies: [], lookupEntries: [], qualityPricingMappings: [],
      issues: [], formalStatus: "NON_FORMAL" as const,
      inputHash: "test-input-hash", importedAt: now,
    },
    qualityDraft: {
      id: "test-quality", sourceRevisionId: "test-src-rev", sourceRevision: "test-hash-001",
      sheetId: "", tableDescriptors: [], qualityValueRanges: [], aliasBindings: [],
      issues: [], formalStatus: "NON_FORMAL" as const,
      inputHash: "test-input-hash", importedAt: now,
    },
    canonicalRuleDraft: {
      id: "test-canonical", sourceRevisionId: "test-src-rev", sourceRevision: "test-hash-001",
      contentHash: "test-content-hash", importedAt: now,
      parameters: [{ key: "test_param", label: "测试参数", itemKind: "rod" as const, unit: "kg", precision: 2, notes: "" }],
      templates: [{ id: "test-tpl", name: "测试模板", fishMinKg: 0, fishMaxKg: 100, nominalFishKg: 50, tier: "M", values: {}, notes: "" }],
      methodProfiles: [], itemTypeProfiles: [], functionProfiles: [], modifiers: [], layers: [], issues: [],
    },
    weightTemplateDraft: {
      id: "test-wt-draft", sourceRevisionId: "test-src-rev", sourceRevision: "test-hash-001",
      sheetId: "", templates: [], issues: [],
      formalStatus: "NON_FORMAL" as const, inputHash: "test-input-hash", importedAt: now,
    },
    pricingWeightBandPolicy: "MATCHED_STRUCTURAL_SOURCE_BAND" as const,
    seriesDefinitions: [{
      id: "series_test_001", name: "测试系列", itemPartId: "part:rod" as const,
      status: "draft" as const, concept: "测试概念",
      planningPullRange: { minKgf: 1, maxKgf: 10 },
      signatureAxes: [] as Array<{ key: string; label: string }>,
      intensity: "fixed" as const, intensityValue: 1,
      coreAffixIds: [], secondaryAffixPoolIds: [], forbiddenAffixIds: [],
    }],
    seriesParseIssues: [] as Array<{ level: "error" | "warning"; code: string; message: string; sheetId: string; row: number }>,
  };
}
