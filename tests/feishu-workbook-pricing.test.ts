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
  canonicalRuleWorkbookRangeRequests,
  identityRowsFromRanges,
  pricingDraftFromRanges,
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
    sheets: observedSheets.map((sheet) => sheet.sheetId === "zrVOxd"
      ? { ...sheet, rowCount, columnCount: 6 }
      : sheet.sheetId === "d6e928" ? { ...sheet, rowCount: 66, columnCount: 60 }
      : sheet),
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
  assert.equal(requests.find((entry) => entry.sheetId === "zrVOxd" && entry.range === "B1:C86")?.range, "B1:C86");
  assert.equal(requests.find((entry) => entry.sheetId === "zrVOxd" && entry.range === "B2:F86")?.range, "B2:F86");
  assert.equal(requests.find((entry) => entry.sheetId === "fATowU" && entry.range === "B2:AD20")?.range, "B2:AD20");
  for (const range of Object.values(CANONICAL_RULE_RANGES).filter((range) => range.sheetId !== "d6e928")) {
    assert.equal(requests.find((entry) => entry.sheetId === range.sheetId && entry.range === range.range)?.range, range.range);
  }
  assert.equal(requests.find((entry) => entry.sheetId === "d6e928" && entry.range === "BG1:BH66")?.range, "BG1:BH66");
  assert.equal(requests.find((entry) => entry.sheetId === "d6e928" && entry.range === "A1:BH66")?.range, "A1:BH66");
  const identities = identityRowsFromRanges([{
    sheetId: "zrVOxd", range: "B1:C86", valueRange: { values: [["机器ID（勿改）", "实体类型"], ...Array.from({ length: 84 }, () => []), ["affix_rod_high", "RodAffix"]] },
  }]);
  assert.ok(identities.some((entry) => entry.stableId === "affix_rod_high"));
});

test("04_词条 grid 元数据不完整时 fail-closed，不以旧行号截断", () => {
  for (const sheets of [
    observedSheets,
    sourceRevisionWithAffixGrid(2).sheets,
    sourceRevisionWithAffixGrid(86).sheets.map((sheet) => sheet.sheetId === "zrVOxd" ? { ...sheet, rowCount: Number.NaN } : sheet),
    sourceRevisionWithAffixGrid(86).sheets.map((sheet) => sheet.sheetId === "zrVOxd" ? { ...sheet, columnCount: 5 } : sheet),
  ]) {
    assert.throws(() => canonicalAffixSheetRanges({ ...sourceRevisionWithAffixGrid(), sheets }));
  }
});

test("高行号的竿轮线合法缩写均能绑定稳定 ID，真实未知缩写与跨部位错误仍阻断", () => {
  const sourceRevision = sourceRevisionWithAffixGrid();
  const qualityValues = Array.from({ length: 47 }, () => [] as unknown[]);
  qualityValues[1] = ["C/绿", "C", "", 0, 20];
  qualityValues[2] = ["B/蓝", "B", "", 20, 40];
  qualityValues[3] = ["A/紫", "A", "", 40, 65];
  qualityValues[4] = ["S/橙", "S", "", 65, 100];
  for (const { headerRow, dataRow, alias } of [
    { headerRow: 10, dataRow: 11, alias: "竿高行" },
    { headerRow: 24, dataRow: 25, alias: "轮高行" },
    { headerRow: 38, dataRow: 39, alias: "线高行" },
  ]) {
    qualityValues[headerRow - 4] = ["", alias];
    qualityValues[dataRow - 4] = [alias.replace("高", "低"), 0];
  }
  const affixValues = Array.from({ length: 85 }, () => [] as unknown[]);
  affixValues[0] = ["机器ID（勿改）", "", "部位", "", "缩写"];
  affixValues[1] = ["affix_rod_low", "", "竿", "", "竿低行"];
  affixValues[3] = ["affix_reel_low", "", "轮", "", "轮低行"];
  affixValues[5] = ["affix_line_low", "", "线", "", "线低行"];
  affixValues[80] = ["affix_rod_high", "", "竿", "", "竿高行"];
  affixValues[82] = ["affix_reel_high", "", "轮", "", "轮高行"];
  affixValues[84] = ["affix_line_high", "", "线", "", "线高行"];
  const valid = qualityDraftFromRanges({
    sourceRevision,
    qualityValues,
    affixValues,
    pricingEndpointValues: [[100]],
    importedAt: "2026-07-24T00:00:00.000Z",
  });
  assert.equal(valid.issues.some((issue) => issue.code === "QUALITY_COMBINATION_ALIAS_UNKNOWN"), false);

  qualityValues[11 - 4] = ["不存在", 0];
  const unknown = qualityDraftFromRanges({ sourceRevision, qualityValues, affixValues, pricingEndpointValues: [[100]], importedAt: "2026-07-24T00:00:00.000Z" });
  assert.ok(unknown.issues.some((issue) => issue.code === "QUALITY_COMBINATION_ALIAS_UNKNOWN"));

  qualityValues[11 - 4] = ["轮高行", 0];
  const crossPart = qualityDraftFromRanges({ sourceRevision, qualityValues, affixValues, pricingEndpointValues: [[100]], importedAt: "2026-07-24T00:00:00.000Z" });
  assert.ok(crossPart.issues.some((issue) => issue.code === "QUALITY_COMBINATION_ALIAS_UNKNOWN"));
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

test("当前整本工作簿注册表覆盖 00–17、FunctionProfile 常量与钓法审核表，并包含真实 sheet_id", () => {
  assert.equal(CANONICAL_FEISHU_SHEET_REGISTRY.length, 21);
  assert.equal(CANONICAL_FEISHU_SHEET_REGISTRY.find((entry) => entry.expectedName === "00_使用说明")?.sheetId, "4IfBoX");
  assert.equal(CANONICAL_FEISHU_SHEET_REGISTRY.find((entry) => entry.expectedName === "04.0_FunctionProfile常量")?.sheetId, "mLpTLK");
  assert.equal(CANONICAL_FEISHU_SHEET_REGISTRY.find((entry) => entry.expectedName === "02.5_钓法模板")?.sheetId, "m3eQCg");
  assert.equal(CANONICAL_FEISHU_SHEET_REGISTRY.find((entry) => entry.expectedName === "12_打包竿组")?.sheetId, "lf4wIM");
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
  const values = new Map<string, unknown[][]>([
    ["d6e928", sequential("wtpl_", 64, "WeightTemplate", "BOUND")],
    ["fATowU", typed([["type_rod_", 8, "RodType"], ["type_reel_", 3, "ReelType"], ["type_line_", 3, "LineType"]])],
    ["vviXo0", sequential("func_", 19, "FunctionProfile")],
    ["zrVOxd", typed([["affix_rod_", 12, "RodAffix"], ["affix_reel_", 12, "ReelAffix"], ["affix_line_", 12, "LineAffix"]])],
    ["9nE3Rx", typed([["series_rod_", 8, "SeriesArchetype"], ["series_reel_", 8, "SeriesArchetype"], ["series_line_", 8, "SeriesArchetype"]])],
  ]);
  const rows = identityRowsFromRanges(CANONICAL_IDENTITY_SHEET_SPECS.map((spec) => ({
    sheetId: spec.sheetId,
    valueRange: { values: values.get(spec.sheetId) ?? [] },
  })));
  const report = prepareSourceIdentityMigration({
    workbookRefId: CANONICAL_FEISHU_WORKBOOK.id,
    sourceRevision: "2352",
    mode: "CONTINUOUS_SYNC",
    rows,
    existingEntities: [],
    identityPolicies: canonicalIdentityPolicies(),
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

test("工作簿按 sheet_id 校验，改名只告警，同名新表不冒充原表", async () => {
  const renamed = observedSheets.map((sheet) =>
    sheet.sheetId === "9nE3Rx" ? { ...sheet, name: "06_系列原型" } : sheet,
  );
  renamed.push({ sheetId: "new-series-sheet", name: "06_系列" });
  let revision = "2352";
  const adapter = {
    async resolveWorkbook() {
      return { spreadsheetToken: "spreadsheet:1", sourceRevision: revision, sheets: renamed };
    },
  };
  const first = await pullFeishuWorkbookRevision({
    workbook: CANONICAL_FEISHU_WORKBOOK,
    adapter,
    pulledAt: "2026-07-21T10:00:00.000Z",
    pulledBy: "tester",
  });
  assert.equal(first.sourceRevision, "2352");
  assert.equal(first.syncScope, "workbook");
  assert.equal(first.anchorSheetId, "9nE3Rx");
  assert.ok(first.issues.some((issue) => issue.code === "SHEET_RENAMED" && issue.sheetId === "9nE3Rx"));
  assert.ok(first.issues.some((issue) => issue.code === "UNREGISTERED_SHEET" && issue.sheetId === "new-series-sheet"));

  revision = "2353";
  const second = await pullFeishuWorkbookRevision({
    workbook: CANONICAL_FEISHU_WORKBOOK,
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
  return { value, status, source: { sheetId: cell.startsWith("AC") ? "fATowU" : "u87sRh", cell } };
}

function pricingInput(overrides: Partial<PricingPolicyDraft> = {}) {
  return {
    sourceRevisionId: "feishu-revision:2352",
    sourceRevision: "2352",
    pricingSheetId: "u87sRh" as const,
    typeMaterialSheetId: "fATowU" as const,
    businessFormulaCells: ["B2", "B3", "B4", "B5", "B6", "B7"].map((cell) => ({ sheetId: "u87sRh", cell })),
    pricingBaskets: [
      { id: "pricing_basket:run", sourceAlias: "跑刀", source: { sheetId: "u87sRh", cell: "B10" } },
      { id: "pricing_basket:steady", sourceAlias: "稳健", source: { sheetId: "u87sRh", cell: "B11" } },
      { id: "pricing_basket:attack", sourceAlias: "猛攻", source: { sheetId: "u87sRh", cell: "B12" } },
    ],
    maintenanceConsumptionRates: [{ pricingWeightBandId: "band:matched", pricingBasketId: "pricing_basket:attack", value: sourced(10, "C20") }],
    partAllocationRatios: [{ pricingWeightBandId: "band:matched", partId: "rod", value: sourced(0.2, "D20") }],
    repairCoefficients: [{ pricingWeightBandId: "band:matched", partId: "rod", typeId: "RodType:spinning", value: sourced(1, "AC5") }],
    totalLossTimes: [{ pricingWeightBandId: "band:matched", pricingBasketId: "pricing_basket:attack", partId: "rod", value: sourced(5, "E20") }],
    purchaseCoefficients: [{ pricingWeightBandId: "band:matched", partId: "rod", typeId: "RodType:spinning", value: sourced(1, "AC6") }],
    partsToWholeRatios: [],
    qualityMappings: [
      ["quality_c_green", "pricing_basket:run", "C/绿→跑刀", "Q9"],
      ["quality_b_blue", "pricing_basket:steady", "B/蓝→稳健", "Q10"],
      ["quality_a_purple", "pricing_basket:attack", "A/紫→猛攻", "Q11"],
      ["quality_s_orange", "pricing_basket:attack", "S/橙→猛攻", "Q12"],
    ].map(([qualityId, pricingBasketId, sourceAlias, cell]) => ({ qualityId, pricingBasketId, sourceAlias, status: "SOURCE" as const, source: { sheetId: "u87sRh", cell } })),
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
    scoreInterpolation: { kind: "constant", points: [{ valueScore: 0, factor: 2 }], outOfRange: "clamp", status: "PROPOSED", source: { sheetId: "u87sRh", cell: "Q3:T3" } },
    moneyPolicy: { unit: "未确认币种", rounding: "half_up", precision: 0, minimumPrice: 1, maximumPrice: 999999, roundingStage: "part_purchase_price", minimumPriceScope: "part_purchase_price", overflowMode: "error", status: "PROPOSED", source: { sheetId: "u87sRh", cell: "Q8:T12" } },
  }));
  const result = calculatePricingTrial({ policy: draft, partId: "rod", typeId: "RodType:spinning", pricingWeightBandId: "band:matched", valueScore: 24, qualityId: "quality_a_purple" });
  assert.equal(result.pricingBasketId, "pricing_basket:attack");
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
