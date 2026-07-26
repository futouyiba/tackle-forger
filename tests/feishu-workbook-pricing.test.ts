import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_FEISHU_SHEET_REGISTRY,
  CANONICAL_FEISHU_WORKBOOK,
  pullFeishuWorkbookRevision,
} from "../lib/feishu-workbook";
import {
  buildStableIdWriteCommands,
  executeStableIdWrite,
  prepareSourceIdentityMigration,
  type SourceIdentityPolicy,
} from "../lib/source-id-migration";
import {
  calculatePricingTrial,
  importPricingPolicyDraft,
  type PricingPolicyDraft,
  type SourcedPricingValue,
} from "../lib/pricing-policy";
import {
  CANONICAL_IDENTITY_SHEET_SPECS,
  canonicalAffixSheetRanges,
  canonicalIdentityPolicies,
  canonicalQualitySheetRange,
  canonicalRuleWorkbookRangeRequests,
  identityRowsFromRanges,
  pricingDraftFromRanges,
  pricingQualitySourceRowsFromDraft,
  qualityDraftFromRanges,
} from "../lib/rule-workbook-inspection";
import { createExportManifest } from "../lib/config-export";
import { createSeedState } from "../lib/seed";
import { formalExportSnapshot } from "./helpers/formal-export-snapshot";
import { testReductionPolicy } from "./helpers/reduction-policy";
import { CANONICAL_RULE_RANGES } from "../lib/canonical-rule-source";

const observedSheets = CANONICAL_FEISHU_SHEET_REGISTRY.map((entry) => ({
  sheetId: entry.sheetId,
  name: entry.expectedName,
}));

function sourceRevisionWithAffixGrid(rowCount = 86) {
  return {
    id: "feishu-revision:fixture", workbookRefId: CANONICAL_FEISHU_WORKBOOK.id,
    sourceRevision: "fixture", spreadsheetToken: "spreadsheet:fixture", pulledAt: "2026-07-24T00:00:00.000Z",
    pulledBy: "tester", syncScope: "workbook" as const, registryHash: "hash",
    sheets: observedSheets.map((sheet) => {
      const base = { ...sheet, rowCount: 100, columnCount: 30 };
      if (sheet.sheetId === "23CsXE") return { ...base, rowCount, columnCount: 6 };
      if (["1cAihB", "2KCCHR", "3FYijT"].includes(sheet.sheetId)) return { ...base, rowCount: 20, columnCount: 60 };
      if (sheet.sheetId === "27hboC") return { ...base, rowCount: 60, columnCount: 19 };
      return base;
    }),
    issues: [], state: "PULLED" as const,
  };
}

test("04_词条的身份与别名读取共同跟随同 revision grid 上界，不遗留固定末行", () => {
  const sourceRevision = sourceRevisionWithAffixGrid(86);
  assert.deepEqual(canonicalAffixSheetRanges(sourceRevision), {
    identityRange: "B1:C86",
    aliasRange: "B2:F86",
  });
  const requests = canonicalRuleWorkbookRangeRequests(sourceRevision);
  assert.equal(requests.find((entry) => entry.sheetId === "23CsXE" && entry.range === "B1:C86")?.range, "B1:C86");
  assert.equal(requests.find((entry) => entry.sheetId === "23CsXE" && entry.range === "B2:F86")?.range, "B2:F86");
  assert.equal(canonicalQualitySheetRange(sourceRevision), "A1:S60");
  assert.equal(requests.find((entry) => entry.sheetId === "27hboC" && entry.range === "A1:S60")?.range, "A1:S60");
  for (const group of ["weight", "type", "function", "method"] as const) {
    for (const part of ["rod", "reel", "line"] as const) {
      const sheetId = CANONICAL_RULE_RANGES[group][part];
      assert.ok(requests.some((entry) => entry.sheetId === sheetId), `缺少 ${group} ${part} 子表 ${sheetId} 的 range 请求`);
    }
  }
  const identities = identityRowsFromRanges([{
    sheetId: "23CsXE", range: "B1:C86", valueRange: { values: [["机器ID（勿改）", "实体类型"], ...Array.from({ length: 84 }, () => []), ["affix_rod_high", "RodAffix"]] },
  }]);
  assert.ok(identities.some((entry) => entry.stableId === "affix_rod_high"));
});

test("04_词条 grid 元数据不完整时 fail-closed，不以旧行号截断", () => {
  for (const sheets of [
    observedSheets,
    sourceRevisionWithAffixGrid(0).sheets,
    sourceRevisionWithAffixGrid(86).sheets.map((sheet) => sheet.sheetId === "23CsXE" ? { ...sheet, rowCount: Number.NaN } : sheet),
    sourceRevisionWithAffixGrid(86).sheets.map((sheet) => sheet.sheetId === "23CsXE" ? { ...sheet, columnCount: 0 } : sheet),
  ]) {
    assert.throws(() => canonicalAffixSheetRanges({ ...sourceRevisionWithAffixGrid(), sheets }));
  }
});

test("07_品质评分 grid 元数据无效时 fail-closed，不回退旧 B4:N50", () => {
  const revision = sourceRevisionWithAffixGrid();
  for (const sheets of [
    revision.sheets.map((sheet) => sheet.sheetId === "27hboC" ? { ...sheet, rowCount: 0 } : sheet),
    revision.sheets.map((sheet) => sheet.sheetId === "27hboC" ? { ...sheet, columnCount: Number.NaN } : sheet),
  ]) assert.throws(() => canonicalQualitySheetRange({ ...revision, sheets }));
  const atLimit = revision.sheets.map((sheet) => sheet.sheetId === "27hboC" ? { ...sheet, rowCount: 10_000, columnCount: 20 } : sheet);
  assert.equal(canonicalQualitySheetRange({ ...revision, sheets: atLimit }), "A1:T10000");
  for (const sheets of [
    revision.sheets.map((sheet) => sheet.sheetId === "27hboC" ? { ...sheet, rowCount: 10_001, columnCount: 1 } : sheet),
    revision.sheets.map((sheet) => sheet.sheetId === "27hboC" ? { ...sheet, rowCount: 1, columnCount: 201 } : sheet),
    revision.sheets.map((sheet) => sheet.sheetId === "27hboC" ? { ...sheet, rowCount: 10_000, columnCount: 21 } : sheet),
  ]) assert.throws(() => canonicalQualitySheetRange({ ...revision, sheets }));
});

test("生产同形品质矩阵按显式块头解析扩展列、移动块、空白镜像与未知/跨部位", () => {
  const sourceRevision = sourceRevisionWithAffixGrid();
  const qualityValues = Array.from({ length: 60 }, () => Array.from({ length: 19 }, () => "") as unknown[]);
  qualityValues[2]![0] = "品质区间";
  qualityValues[3]![1] = "品质"; qualityValues[3]![2] = "代码"; qualityValues[3]![3] = "≥最小评分"; qualityValues[3]![4] = "<最大评分"; qualityValues[3]![5] = "最小价格系数"; qualityValues[3]![6] = "最大价格系数";
  for (const [row, label, code, min, max] of [[5, "C/绿", "C", 0, 20], [6, "B/蓝", "B", 20, 40], [7, "A/紫", "A", 40, 65], [8, "S/橙", "S", 65, 100]] as const) qualityValues[row - 1] = ["", label, code, min, max, .5, 1.1];
  const addBlock = (headerRow: number, heading: string, aliases: string[]) => {
    qualityValues[headerRow - 1]![0] = heading;
    aliases.forEach((alias, index) => { qualityValues[headerRow - 1]![index + 1] = alias; });
    qualityValues[headerRow]![0] = aliases[0]!;
    qualityValues[headerRow]![1] = "—";
    qualityValues[headerRow]![2] = 2;
  };
  addBlock(10, "竿词条", Array.from({ length: 15 }, (_, index) => `竿${index}`));
  addBlock(27, "轮词条", Array.from({ length: 17 }, (_, index) => `轮${index}`));
  addBlock(46, "线词条", Array.from({ length: 15 }, (_, index) => `线${index}`));
  const affixValues = Array.from({ length: 85 }, () => [] as unknown[]);
  affixValues[0] = ["机器ID（勿改）", "", "部位", "", "缩写"];
  let affixRow = 1;
  for (const [part, prefix, count] of [["竿", "rod", 15], ["轮", "reel", 17], ["线", "line", 15]] as const) for (let index = 0; index < count; index += 1) affixValues[affixRow++] = [`affix_${prefix}_${index}`, "", part, "", `${part}${index}`];
  const valid = qualityDraftFromRanges({
    sourceRevision,
    qualityValues,
    qualityRange: "A1:S60",
    affixValues,
    pricingEndpointValues: [[100]],
    importedAt: "2026-07-24T00:00:00.000Z",
  });
  assert.equal(valid.issues.some((issue) => issue.code === "QUALITY_COMBINATION_ALIAS_UNKNOWN"), false);
  assert.equal(valid.combinationRules.length, 3);
  assert.equal(valid.combinationRules.find((rule) => rule.itemPartId === "part:reel")?.source.cell, "C28");
  assert.deepEqual(valid.ranges.map((range) => [range.minScore, range.maxScore]), [[0, 20], [20, 40], [40, 65], [65, 100]]);
  const pricingQualityRows = pricingQualitySourceRowsFromDraft(valid, qualityValues);
  const pricing = pricingDraftFromRanges({
    sourceRevision,
    qualityValues: [],
    qualitySourceRows: pricingQualityRows,
    importedAt: "2026-07-24T00:00:00.000Z",
  });
  assert.equal(pricing.qualityMappings.length, 4);
  assert.equal(pricing.qualityPriceFactorRanges?.length, 4);
  assert.deepEqual(pricing.qualityMappings.map((mapping) => mapping.source.cell), ["C5", "C6", "C7", "C8"]);
  assert.deepEqual(pricing.qualityPriceFactorRanges?.map((range) => range.source.cell), ["F5:G5", "F6:G6", "F7:G7", "F8:G8"]);
  const moved = structuredClone(qualityValues);
  moved[3]![5] = ""; moved[3]![6] = "";
  moved[3]![10] = "最小价格系数"; moved[3]![11] = "最大价格系数";
  for (let row = 4; row < 8; row += 1) { moved[row]![10] = moved[row]![5]; moved[row]![11] = moved[row]![6]; moved[row]![5] = moved[row]![6] = ""; }
  const movedDraft = qualityDraftFromRanges({ sourceRevision, qualityValues: moved, qualityRange: "A1:S60", affixValues, pricingEndpointValues: [], importedAt: "2026-07-24T00:00:00.000Z" });
  assert.equal(movedDraft.formalStatus, "NON_FORMAL");
  assert.ok(movedDraft.issues.some((issue) => issue.code === "QUALITY_RANGE_SOURCE_OUTDATED"));
  assert.deepEqual(pricingQualitySourceRowsFromDraft(movedDraft).map((row) => [row.mappingCell, row.factorCell]), [["C5", "K5:L5"], ["C6", "K6:L6"], ["C7", "K7:L7"], ["C8", "K8:L8"]]);
  moved[3]![11] = "";
  assert.ok(qualityDraftFromRanges({ sourceRevision, qualityValues: moved, qualityRange: "A1:S60", affixValues, pricingEndpointValues: [], importedAt: "2026-07-24T00:00:00.000Z" }).issues.some((issue) => issue.code === "QUALITY_RANGE_TABLE_HEADER_MISSING"));
  const duplicated = structuredClone(qualityValues);
  duplicated[3]![15] = "代码";
  assert.ok(qualityDraftFromRanges({ sourceRevision, qualityValues: duplicated, qualityRange: "A1:S60", affixValues, pricingEndpointValues: [], importedAt: "2026-07-24T00:00:00.000Z" }).issues.some((issue) => issue.code === "QUALITY_RANGE_TABLE_HEADER_MISSING"));

  qualityValues[9]![2] = "不存在";
  const unknown = qualityDraftFromRanges({ sourceRevision, qualityValues, qualityRange: "A1:S60", affixValues, pricingEndpointValues: [[100]], importedAt: "2026-07-24T00:00:00.000Z" });
  assert.ok(unknown.issues.some((issue) => issue.code === "QUALITY_COMBINATION_ALIAS_UNKNOWN"));

  qualityValues[9]![2] = "轮0";
  const crossPart = qualityDraftFromRanges({ sourceRevision, qualityValues, qualityRange: "A1:S60", affixValues, pricingEndpointValues: [[100]], importedAt: "2026-07-24T00:00:00.000Z" });
  assert.ok(crossPart.issues.some((issue) => issue.code === "QUALITY_COMBINATION_ALIAS_UNKNOWN"));
});

test("品质矩阵结构错误保留草稿并发布阻断，尾部合法缩写不能被误读", () => {
  const sourceRevision = sourceRevisionWithAffixGrid();
  const values = Array.from({ length: 60 }, () => Array.from({ length: 19 }, () => "") as unknown[]);
  values[2]![0] = "品质区间";
  values[3]![1] = "品质"; values[3]![2] = "代码"; values[3]![3] = "≥最小评分"; values[3]![4] = "<最大评分"; values[3]![5] = "最小价格系数"; values[3]![6] = "最大价格系数";
  for (const [row, label, code, min, max] of [[5, "C/绿", "C", 0, 20], [6, "B/蓝", "B", 20, 40], [7, "A/紫", "A", 40, 65], [8, "S/橙", "S", 65, 100]] as const) values[row - 1] = ["", label, code, min, max, .5, 1.1];
  for (const [row, heading, prefix] of [[10, "竿词条", "竿"], [27, "轮词条", "轮"], [46, "线词条", "线"]] as const) {
    values[row - 1]![0] = heading; values[row - 1]![1] = `${prefix}0`; values[row - 1]![2] = `${prefix}2`;
    values[row]![0] = `${prefix}0`; values[row]![1] = "—"; values[row]![2] = 1;
  }
  // This is a valid affix-looking tail row after the rod matrix; it must end
  // the rod block and must not create a fourth matrix rule.
  values[11]![0] = "竿1"; values[11]![1] = 9;
  const affixValues = [["机器ID（勿改）", "", "部位", "", "缩写"], ["affix_rod_0", "", "竿", "", "竿0"], ["affix_rod_1", "", "竿", "", "竿1"], ["affix_rod_2", "", "竿", "", "竿2"], ["affix_reel_0", "", "轮", "", "轮0"], ["affix_reel_2", "", "轮", "", "轮2"], ["affix_line_0", "", "线", "", "线0"], ["affix_line_2", "", "线", "", "线2"]];
  const blocked = qualityDraftFromRanges({ sourceRevision, qualityValues: values, qualityRange: "A1:S60", affixValues, pricingEndpointValues: [], importedAt: "2026-07-24T00:00:00.000Z" });
  assert.equal(blocked.formalStatus, "NON_FORMAL");
  assert.ok(blocked.issues.some((issue) => issue.code === "QUALITY_MATRIX_ROW_INVALID" && issue.sourceCell?.cell === "A12"));
  assert.equal(blocked.combinationRules.length, 3);

  values[26]![0] = "竿词条";
  const duplicate = qualityDraftFromRanges({ sourceRevision, qualityValues: values, qualityRange: "A1:S60", affixValues, pricingEndpointValues: [], importedAt: "2026-07-24T00:00:00.000Z" });
  assert.ok(duplicate.issues.some((issue) => issue.code === "QUALITY_MATRIX_BLOCK_DUPLICATE"));
  assert.equal(duplicate.formalStatus, "NON_FORMAL");
  values[26]![0] = "";
  values[55]![10] = "C"; values[55]![11] = 0; values[55]![12] = 100;
  const tailQuality = qualityDraftFromRanges({ sourceRevision, qualityValues: values, qualityRange: "A1:S60", affixValues, pricingEndpointValues: [], importedAt: "2026-07-24T00:00:00.000Z" });
  assert.equal(tailQuality.ranges.length, 4);
});

test("同一完整高行号工作簿导入保持幂等", () => {
  const sourceRevision = sourceRevisionWithAffixGrid();
  const qualityValues = Array.from({ length: 47 }, () => [] as unknown[]);
  qualityValues[1] = ["C/绿", "C", "", 0, 20]; qualityValues[2] = ["B/蓝", "B", "", 20, 40];
  qualityValues[3] = ["A/紫", "A", "", 40, 65]; qualityValues[4] = ["S/橙", "S", "", 65, 100];
  qualityValues[6] = ["", "高行词条"]; qualityValues[7] = ["高行词条", "—"];
  const affixValues = Array.from({ length: 85 }, () => [] as unknown[]);
  affixValues[0] = ["机器ID（勿改）", "", "部位", "", "缩写"];
  affixValues[84] = ["affix_rod_high", "", "竿", "", "高行词条"];
  const input = { sourceRevision, qualityValues, affixValues, pricingEndpointValues: [[100]], importedAt: "2026-07-24T00:00:00.000Z" };
  assert.deepEqual(qualityDraftFromRanges(input), qualityDraftFromRanges(input));
});

test("当前整本工作簿注册表覆盖 00–19、FunctionProfile 常量与各部位分表，并包含真实 sheet_id", () => {
  assert.equal(CANONICAL_FEISHU_SHEET_REGISTRY.length, 48, "注册表登记 48 张分表（09.3/09.4 已移除）");
  assert.equal(CANONICAL_FEISHU_SHEET_REGISTRY.find((entry) => entry.expectedName === "00_系统接入")?.sheetId, "0iGCcx");
  assert.equal(CANONICAL_FEISHU_SHEET_REGISTRY.find((entry) => entry.expectedName === "04.00_FunctionProfile常量")?.sheetId, "19XKzU");
  assert.equal(CANONICAL_FEISHU_SHEET_REGISTRY.find((entry) => entry.expectedName === "01.0_重量模板-竿")?.sheetId, "1cAihB");
  assert.equal(CANONICAL_FEISHU_SHEET_REGISTRY.find((entry) => entry.expectedName === "05_词条")?.sheetId, "23CsXE");
});

test("历史已绑定机器 ID 在当前工作表拓扑下仍通过唯一性、前缀与实体类型校验", () => {
  const sequential = (prefix: string, count: number, entityType: string, status = entityType) => [
    ["", ""],
    ["机器ID（勿改）", status === "BOUND" ? "同步状态" : "实体类型"],
    ...Array.from({ length: count }, (_, index) => [
      `${prefix}${String(index + 1).padStart(4, "0")}`,
      status,
    ]),
  ];
  const typed = (groups: Array<[string, number, string]>) => [
    ["", ""],
    ...groups.flatMap(([prefix, count, entityType]) => [
      ["机器ID（勿改）", "实体类型"],
      ...Array.from({ length: count }, (_, index) => [`${prefix}${String(index + 1).padStart(4, "0")}`, entityType]),
      ["", ""],
    ]),
  ];
  // WQ8w 分表：竿/轮/线各独立子表，ID 带部位前缀（wtpl_rod_/func_reel_ 等）。合计 157 行身份。
  const values = new Map<string, unknown[][]>([
    ["1cAihB", sequential("wtpl_rod_", 22, "WeightTemplate", "BOUND")],
    ["2KCCHR", sequential("wtpl_reel_", 21, "WeightTemplate", "BOUND")],
    ["3FYijT", sequential("wtpl_line_", 21, "WeightTemplate", "BOUND")],
    ["10TyFp", sequential("type_rod_", 8, "RodType")],
    ["11CfXW", sequential("type_reel_", 3, "ReelType")],
    ["12VetE", sequential("type_line_", 3, "LineType")],
    ["16qYVn", sequential("func_rod_", 7, "FunctionProfile")],
    ["17jqiE", sequential("func_reel_", 6, "FunctionProfile")],
    ["18pjcZ", sequential("func_line_", 6, "FunctionProfile")],
    ["23CsXE", typed([["affix_rod_", 12, "RodAffix"], ["affix_reel_", 12, "ReelAffix"], ["affix_line_", 12, "LineAffix"]])],
    ["25UnTC", typed([["series_rod_", 8, "SeriesArchetype"], ["series_reel_", 8, "SeriesArchetype"], ["series_line_", 8, "SeriesArchetype"]])],
  ]);
  const rows = identityRowsFromRanges(CANONICAL_IDENTITY_SHEET_SPECS.map((spec) => ({
    sheetId: spec.sheetId,
    valueRange: { values: values.get(spec.sheetId) ?? [] },
  })), CANONICAL_IDENTITY_SHEET_SPECS);
  const report = prepareSourceIdentityMigration({
    workbookRefId: CANONICAL_FEISHU_WORKBOOK.id,
    sourceRevision: "2352",
    mode: "CONTINUOUS_SYNC",
    rows,
    existingEntities: [],
    identityPolicies: canonicalIdentityPolicies(CANONICAL_IDENTITY_SHEET_SPECS),
    generatedAt: "2026-07-21T11:00:00.000Z",
  });
  assert.equal(rows.length, 157);
  assert.equal(report.items.filter((item) => item.state === "ALREADY_IDENTIFIED").length, 157);
  assert.deepEqual(report.blockingIssueCodes, []);
});

test("仅导入品质映射时准确列出尚未导入的定价输入", () => {
  const sourceRevision = {
    id: "feishu-revision:observed-2352", workbookRefId: CANONICAL_FEISHU_WORKBOOK.id,
    sourceRevision: "2352", spreadsheetToken: "spreadsheet:observed", pulledAt: "2026-07-21T11:00:00.000Z",
    pulledBy: "tester", syncScope: "workbook" as const, registryHash: "hash", sheets: observedSheets,
    issues: [], state: "PULLED" as const,
  };
  const draft = pricingDraftFromRanges({
    sourceRevision,
    qualityValues: [
      ["C/绿", "C", "跑刀", 0, 20, "Q1"],
      ["B/蓝", "B", "稳健", 20, 40, "Q2"],
      ["A/紫", "A", "猛攻", 40, 65, "Q3"],
      ["S/橙", "S", "猛攻", 65, 100, "Q4"],
    ],
    importedAt: "2026-07-21T11:00:00.000Z",
  });
  assert.equal(draft.qualityMappings.length, 4);
  assert.equal(draft.issues.some((issue) => issue.code.startsWith("QUALITY_PRICING_MAPPING_")), false);
  assert.deepEqual(draft.issues.map((issue) => issue.code).sort(), [
    "PARTS_TO_WHOLE_RATIO_MISSING", "PRICING_INTERPOLATION_MISSING", "PRICING_MONEY_POLICY_MISSING", "QUALITY_PRICE_FACTOR_MISSING",
  ]);
});

test("07/08/02 同 revision 导入查表与金额事实，但不猜测三项执行语义", () => {
  const sourceRevision = {
    id: "feishu-revision:2922", workbookRefId: CANONICAL_FEISHU_WORKBOOK.id,
    sourceRevision: "2922", spreadsheetToken: "spreadsheet:observed", pulledAt: "2026-07-22T00:00:00.000Z",
    pulledBy: "tester", syncScope: "workbook" as const, registryHash: "hash", sheets: observedSheets,
    issues: [], state: "PULLED" as const,
  };
  const pricingValues = Array.from({ length: 61 }, () => [] as unknown[]);
  pricingValues[1] = ["score_interpolation_policy", "已显式定义", "Mathf.Lerp(...)"];
  pricingValues[5] = ["currency_unit", "已显式定义", "金币"];
  pricingValues[6] = ["rounding_mode", "已显式定义", "向下取整；3位有效数字"];
  pricingValues[7] = ["minimum_price", "已显式定义", 100];
  pricingValues[8] = ["overflow_maximum", "已显式定义", 300000000];
  pricingValues[13] = [1, "跑刀", 100, "", 1, .54, .4, .06, "", 1, "跑刀", 2, 3, 1, 1, 1, 1];
  const draft = pricingDraftFromRanges({
    sourceRevision,
    qualityValues: [
      ["C/绿", "C", "跑刀", 0, 20, .5, 1.1],
      ["B/蓝", "B", "稳健", 20, 40, .8, 1.2],
      ["A/紫", "A", "猛攻", 40, 65, .7, 1.3],
      ["S/橙", "S", "猛攻", 65, 100, 2, 3],
    ],
    pricingValues,
    typeValues: [
      ["机器ID（勿改）", "实体类型", "类型"],
      ["type_rod_0001", "RodType", "浮钓竿", ...Array.from({ length: 16 }, () => 1), 1, 1],
    ],
    importedAt: "2026-07-22T00:00:00.000Z",
  });
  assert.equal(draft.sourceRevision, "2922");
  assert.equal(draft.scoreInterpolation?.kind, "quality_range_linear");
  assert.equal(draft.moneyPolicy?.unit, "金币");
  assert.equal(draft.partsToWholeRatios.length, 3);
  assert.equal(draft.repairCoefficients[0]?.value.source.cell, "U3");
  assert.equal(draft.issues.some((issue) => issue.code === "PRICING_INTERPOLATION_MISSING"), false);
  assert.equal(draft.issues.some((issue) => issue.code === "PARTS_TO_WHOLE_RATIO_MISSING"), false);
  assert.ok(draft.issues.some((issue) => issue.code === "PRICING_EXECUTION_SEMANTICS_MISSING"));
});

test("WQ8w 路径（32BmZs + 33IGHy）生成完整 lookup 表并通过试算", () => {
  const sourceRevision = { id: "feishu-src:wq8w-test", workbookRefId: "feishu-workbook:tackle-design", sourceRevision: "wq8w-test", spreadsheetToken: "WQ8wstS4ch29E2tAKnVcoh5KnJg", pulledAt: "2026-07-26T00:00:00.000Z", pulledBy: "tester", syncScope: "workbook" as const, registryHash: "abc", sheets: [], issues: [], state: "PULLED" as const };
  const params = [
    ["参数键", "状态", "当前値", "说明"],
    ["currency_unit", "已显式定义", "金币", ""],
    ["rounding_mode", "已显式定义", "向下取整；3位有效数字", ""],
    ["minimum_price", "已显式定义", "100", ""],
    ["overflow_maximum", "已显式定义", "300000000", ""],
  ];
  const endpoints = [
    ["钓具大类", "重量段", "品质", "基础维修价格", "零整比"],
    ["竿", "1", "C", 29767, 1],
    ["竿", "1", "B", 73018, 0.8],
    ["竿", "2", "C", 101520, 0.96],
    ["竿", "2", "B", 258111, 0.76],
    ["线", "1", "C", 5000, 0.9],
    ["线", "1", "B", 12000, 0.7],
    ["线", "2", "C", 18000, 0.85],
    ["线", "2", "B", 40000, 0.65],
  ];
  const typeValues = [
    ["机器ID（勿改）", "实体类型", "类型"],
    ["type_rod_0001", "RodType", "浮钓竿", ...Array.from({ length: 16 }, () => 1), 1.5, 1.2],
    ["type_line_0001", "LineType", "尼龙线", ...Array.from({ length: 16 }, () => 1), 1.0, 0.9],
  ];
  const qualityRows = [
    { code: "C", minScore: 0, maxScore: 20, minFactor: 0.5, maxFactor: 1.1, mappingCell: "B2", factorCell: "E2:H2", rowKey: "2" },
    { code: "B", minScore: 20, maxScore: 40, minFactor: 0.8, maxFactor: 1.2, mappingCell: "B3", factorCell: "E3:H3", rowKey: "3" },
    { code: "A", minScore: 40, maxScore: 65, minFactor: 0.7, maxFactor: 1.3, mappingCell: "B4", factorCell: "E4:H4", rowKey: "4" },
    { code: "S", minScore: 65, maxScore: 100, minFactor: 2, maxFactor: 3, mappingCell: "B5", factorCell: "E5:H5", rowKey: "5" },
  ];
  const draft = pricingDraftFromRanges({
    sourceRevision,
    qualityValues: [], qualitySourceRows: qualityRows,
    pricingParamsValues: params,
    pricingEndpointValues: endpoints,
    typeValues,
    importedAt: "2026-07-26T00:00:00.000Z",
  });
  assert.equal(draft.maintenanceConsumptionRates.length, 4, "维修速度（去重后per-band+part）");
  assert.equal(draft.partAllocationRatios.length, 4, "部位占比");
  assert.equal(draft.totalLossTimes.length, 4, "全损时间");
  assert.equal(draft.partsToWholeRatios.length, 8, "零整比");
  assert.equal(draft.executionPolicy?.repairRoundingStage, "final_repair_output");
  assert.equal(draft.moneyPolicy?.unit, "金币");
  assert.equal(draft.issues.some((i) => i.code === "PARTS_TO_WHOLE_RATIO_MISSING"), false);
  assert.equal(draft.issues.some((i) => i.code === "PRICING_MONEY_POLICY_MISSING"), false);
  assert.equal(draft.issues.some((i) => i.code === "PRICING_EXECUTION_SEMANTICS_MISSING"), false);
});

test("工作簿按 sheet_id 校验，改名只告警，同名新表不冒充原表", async () => {
  const renamed = CANONICAL_FEISHU_SHEET_REGISTRY.map((sheet) => ({ sheetId: sheet.sheetId, name: sheet.expectedName })).map((sheet) =>
    sheet.sheetId === "25UnTC" ? { ...sheet, name: "07_系列原型" } : sheet,
  );
  renamed.push({ sheetId: "new-series-sheet", name: "07_系列" });
  let revision = "2352";
  const adapter = {
    async resolveWorkbook() {
      return { spreadsheetToken: "spreadsheet:1", sourceRevision: revision, sheets: renamed };
    },
  };
  const first = await pullFeishuWorkbookRevision({
    workbook: CANONICAL_FEISHU_WORKBOOK, registry: CANONICAL_FEISHU_SHEET_REGISTRY,
    adapter,
    pulledAt: "2026-07-21T10:00:00.000Z",
    pulledBy: "tester",
  });
  assert.equal(first.sourceRevision, "2352");
  assert.equal(first.syncScope, "workbook");
  assert.equal(first.anchorSheetId, "0iGCcx");
  assert.ok(first.issues.some((issue) => issue.code === "SHEET_RENAMED" && issue.sheetId === "25UnTC"));
  assert.ok(first.issues.some((issue) => issue.code === "UNREGISTERED_SHEET" && issue.sheetId === "new-series-sheet"));

  revision = "2353";
  const second = await pullFeishuWorkbookRevision({
    workbook: CANONICAL_FEISHU_WORKBOOK, registry: CANONICAL_FEISHU_SHEET_REGISTRY,
    adapter,
    pulledAt: "2026-07-21T10:01:00.000Z",
    pulledBy: "tester",
  });
  assert.equal(second.sourceRevision, "2353");
  assert.notEqual(second.id, first.id);
});

const identityPolicies: SourceIdentityPolicy[] = [
  { sheetId: "d6e928", allowedEntityTypes: ["WeightTemplate"], idPrefixesByEntityType: { WeightTemplate: ["wtpl_"] } },
  { sheetId: "9nE3Rx", allowedEntityTypes: ["SeriesArchetype"], idPrefixesByEntityType: { SeriesArchetype: ["series_proto_"] } },
];

test("首轮迁移识别已绑定 ID；未来缺 ID 行只进入 NEW_SOURCE_ROW", () => {
  const bound = prepareSourceIdentityMigration({
    workbookRefId: CANONICAL_FEISHU_WORKBOOK.id,
    sourceRevision: "2352",
    mode: "INITIAL_MIGRATION",
    rows: [{ sheetId: "d6e928", rowKey: "5", displayName: "轻型", entityType: "WeightTemplate", stableId: "wtpl_0001", idColumnKey: "机器ID" }],
    existingEntities: [],
    identityPolicies,
    generatedAt: "2026-07-21T10:00:00.000Z",
  });
  assert.equal(bound.items[0].state, "ALREADY_IDENTIFIED");
  assert.equal(bound.items[0].proposedStableId, undefined);

  const future = prepareSourceIdentityMigration({
    workbookRefId: CANONICAL_FEISHU_WORKBOOK.id,
    sourceRevision: "2353",
    mode: "CONTINUOUS_SYNC",
    rows: [{ sheetId: "d6e928", rowKey: "69", displayName: "新增模板", entityType: "WeightTemplate", idColumnKey: "机器ID" }],
    existingEntities: [{ entityId: "wtpl_old", displayName: "新增模板", entityType: "WeightTemplate" }],
    identityPolicies,
    generatedAt: "2026-07-21T10:02:00.000Z",
  });
  assert.equal(future.items[0].state, "NEW_SOURCE_ROW");
  assert.deepEqual(future.items[0].candidateEntityIds, []);
  assert.ok(future.items[0].proposedStableId?.startsWith("wtpl_"));
});

test("ID 唯一性、前缀和实体类型冲突会阻断；SeriesArchetype 不匹配运行时 Series", () => {
  const report = prepareSourceIdentityMigration({
    workbookRefId: CANONICAL_FEISHU_WORKBOOK.id,
    sourceRevision: "2352",
    mode: "INITIAL_MIGRATION",
    rows: [
      { sheetId: "d6e928", rowKey: "5", displayName: "轻型", entityType: "WeightTemplate", stableId: "bad_1", idColumnKey: "机器ID" },
      { sheetId: "d6e928", rowKey: "6", displayName: "中型", entityType: "SeriesArchetype", stableId: "bad_1", idColumnKey: "机器ID" },
      { sheetId: "9nE3Rx", rowKey: "7", displayName: "青芦", entityType: "SeriesArchetype", idColumnKey: "系列原型ID" },
    ],
    existingEntities: [{ entityId: "series:runtime", displayName: "青芦", entityType: "Series" }],
    identityPolicies,
    generatedAt: "2026-07-21T10:00:00.000Z",
  });
  assert.equal(report.items[0].state, "CONFLICT");
  assert.equal(report.items[1].state, "CONFLICT");
  assert.equal(report.items[2].candidateEntityIds.length, 0);
  assert.ok(report.blockingIssueCodes.includes("SOURCE_STABLE_ID_DUPLICATE"));
});

test("人工确认写回超时后以回读恢复，写回不等于拉取或发布", async () => {
  const rows = [{ sheetId: "d6e928", rowKey: "69", displayName: "新增模板", entityType: "WeightTemplate", idColumnKey: "机器ID" }];
  const report = prepareSourceIdentityMigration({
    workbookRefId: CANONICAL_FEISHU_WORKBOOK.id,
    sourceRevision: "2352",
    mode: "CONTINUOUS_SYNC",
    rows,
    existingEntities: [],
    identityPolicies,
    generatedAt: "2026-07-21T10:00:00.000Z",
  });
  const commands = buildStableIdWriteCommands({
    report,
    rows,
    confirmations: [{ itemId: report.items[0].itemId, confirmedStableId: report.items[0].proposedStableId!, decision: "ASSIGN_NEW", confirmedBy: "tester" }],
  });
  const written = new Map<string, string>();
  const result = await executeStableIdWrite({
    workbook: CANONICAL_FEISHU_WORKBOOK,
    report,
    commands,
    idempotencyKey: "id-write:1",
    adapter: {
      async getCurrentRevision() { return "2352"; },
      async writeStableIds({ commands: pending }) {
        for (const command of pending) written.set(`${command.sheetId}:${command.rowKey}`, command.stableId);
        throw new Error("timeout");
      },
      async readStableIds({ commands: pending }) {
        return pending.map((command) => ({ ...command, stableId: written.get(`${command.sheetId}:${command.rowKey}`) }));
      },
    },
  });
  assert.equal(result.state, "WRITE_VERIFIED");
  assert.equal(result.recoveredAfterWriteError, true);
});

function sourced(value: number, cell: string, status: SourcedPricingValue<number>["status"] = "SOURCE"): SourcedPricingValue<number> {
  return { value, status, source: { sheetId: cell.startsWith("AC") ? "10TyFp" : "31RxeB", cell } };
}

function pricingInput(overrides: Partial<PricingPolicyDraft> = {}) {
  return {
    sourceRevisionId: "feishu-revision:2352",
    sourceRevision: "2352",
    pricingSheetId: "31RxeB" as const,
    typeMaterialSheetId: "10TyFp" as const,
    businessFormulaCells: ["B2", "B3", "B4", "B5", "B6", "B7"].map((cell) => ({ sheetId: "31RxeB", cell })),
    maintenanceConsumptionRates: [{ pricingWeightBandId: "band:matched", value: sourced(10, "C20") }],
    partAllocationRatios: [{ pricingWeightBandId: "band:matched", partId: "rod", value: sourced(0.2, "D20") }],
    repairCoefficients: [{ pricingWeightBandId: "band:matched", partId: "rod", typeId: "RodType:spinning", value: sourced(1, "AC5") }],
    totalLossTimes: [{ pricingWeightBandId: "band:matched", partId: "rod", value: sourced(5, "E20") }],
    purchaseCoefficients: [{ pricingWeightBandId: "band:matched", partId: "rod", typeId: "RodType:spinning", value: sourced(1, "AC6") }],
    partsToWholeRatios: [],
    qualityMappings: [
      ["quality_c_green", "C/绿"],
      ["quality_b_blue", "B/蓝"],
      ["quality_a_purple", "A/紫"],
      ["quality_s_orange", "S/橙"],
    ].map(([qualityId, sourceAlias], index) => ({ qualityId, sourceAlias, status: "SOURCE" as const, source: { sheetId: "31RxeB", cell: `D${5 + index}` } })),
    importedAt: "2026-07-21T10:00:00.000Z",
    ...overrides,
  } as Parameters<typeof importPricingPolicyDraft>[0];
}

test("revision 2352 品质映射已存在；草稿只因其余必填参数未发布而非正式", () => {
  const draft = importPricingPolicyDraft(pricingInput());
  assert.equal(draft.formalStatus, "INCOMPLETE_DRAFT");
  assert.equal(draft.issues.some((issue) => issue.code.includes("QUALITY_PRICING_MAPPING")), false);
  assert.ok(draft.issues.some((issue) => issue.code === "PRICING_INTERPOLATION_MISSING"));
  assert.ok(draft.issues.some((issue) => issue.code === "PARTS_TO_WHOLE_RATIO_MISSING"));
  assert.ok(draft.issues.some((issue) => issue.code === "PRICING_MONEY_POLICY_MISSING"));
});

test("价格试算使用最近结构标杆源重量段，系数为 1 仍进入单元格级 Trace", () => {
  const draft = importPricingPolicyDraft(pricingInput({
    partsToWholeRatios: [{ partId: "rod", value: sourced(0.5, "Q7", "PROPOSED") }],
    scoreInterpolation: { kind: "constant", points: [{ valueScore: 0, factor: 2 }], outOfRange: "clamp", status: "PROPOSED", source: { sheetId: "31RxeB", cell: "Q3:T3" } },
    moneyPolicy: { unit: "未确认币种", rounding: "half_up", precision: 0, minimumPrice: 1, maximumPrice: 999999, roundingStage: "part_purchase_price", minimumPriceScope: "part_purchase_price", overflowMode: "error", status: "PROPOSED", source: { sheetId: "31RxeB", cell: "Q8:T12" } },
  }));
  const result = calculatePricingTrial({ policy: draft, partId: "rod", typeId: "RodType:spinning", pricingWeightBandId: "band:matched", valueScore: 24, qualityId: "quality_a_purple" });
  assert.equal(result.pricingWeightBandId, "band:matched");
  assert.equal(result.repairPriceUnrounded, 20);
  assert.equal(result.purchasePrice, 40);
  assert.equal(result.formal, false);
  assert.equal(result.trace.find((entry) => entry.formulaStep === "repairCoefficient")?.operand, 1);
  assert.equal(result.trace.find((entry) => entry.formulaStep === "purchaseCoefficient")?.operand, 1);
  assert.ok(result.trace.every((entry) => entry.sourceRevision === "2352" && entry.source.cell));
});

test("未发布 PricingPolicy 时正式 Store Manifest 阻断且不再误报品质映射缺失", () => {
  const snapshot = formalExportSnapshot(createSeedState().configurationSnapshots[0]);
  assert.throws(() => createExportManifest({
    packageId: "pkg:1",
    generatorVersion: "1",
    mapping: { mappingId: "m", version: "1", logicalTables: {}, rows: [], enumReferenceField: "name" },
    profile: { profileId: "profile:1", label: "test/1001", executorKind: "local_companion", projectRoot: "D:\\\\configs", relativeWorkbookRoot: "xlsx", configTomlPath: "config.toml", enabled: true },
    workspaceId: "workspace:test",
    snapshot,
    availableReductionPolicies: [testReductionPolicy()],
    originalFileHashes: {},
    entries: [{ logicalTable: "store_buy", workbook: "store.xlsx", sheet: "StoreBuy", businessKey: "buy:1", operation: "insert" }],
    createdAt: "2026-07-21T10:00:00.000Z",
  }), /精确缺参或执行语义问题/);
});
