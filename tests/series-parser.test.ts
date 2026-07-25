import assert from "node:assert/strict";
import test from "node:test";
import { parseSeries } from "../lib/rule-workbook-inspection";
import type { FeishuSourceRevision } from "../lib/feishu-workbook";

const sourceRevision = {
  id: "feishu-revision:test",
  workbookRefId: "feishu-workbook:tackle-design",
  sourceRevision: "rev-1",
  spreadsheetToken: "WQ8wstS4ch29E2tAKnVcoh5KnJg",
  pulledAt: "2026-07-25T00:00:00Z",
  pulledBy: "test",
  syncScope: "workbook",
  registryHash: "hash",
  sheets: [],
  issues: [],
  state: "PULLED",
} as FeishuSourceRevision;
const IMPORTED_AT = "2026-07-25T00:00:00Z";

// 25UnTC 表头（A→W，实测 22 列）
const HEADER = [
  "机器ID（勿改）", "实体类型", "钓具类型", "系列", "包含技术", "推荐竿类型", "推荐功能定位", "概念定位",
  "钓法ID", "类型ID", "品质档位", "集合ID", "核心功能ID", "功能强度模式", "功能强度值",
  "核心词缀ID", "次级词缀池ID", "禁用词缀ID", "计划最小拉力kgf", "计划最大拉力kgf",
  "目标拉力规格", "签名轴", "状态",
];

// 实测样例行（series_rod_0001，#141 凭据读取）
const ROD_ROW = [
  "series_rod_0001", "SeriesArchetype", "竿", "入门·泛用", "无", "浮钓竿,直柄竿,台钓竿", "泛用", "入门级泛用型钓竿",
  "fishing_rod_0001", "type_rod_0001", "quality_c_green", "collection:rod", "function:all_round", "fixed", "1",
  "affix_rod_a", "affix_rod_b,affix_rod_c", "affix_rod_d", "1.0", "4.5",
  "1.0:sku:series_rod_0001-1.0;4.5:sku:series_rod_0001-4.5", "竿自重g:negative:0.7:0.05", "draft",
];

test("parseSeries：25UnTC 正常行解析为 SeriesDefinition（列映射 + 类型转换 + part）", () => {
  const { series, issues } = parseSeries({ sourceRevision, seriesValues: [HEADER, ROD_ROW], importedAt: IMPORTED_AT });
  assert.equal(issues.length, 0, JSON.stringify(issues));
  assert.equal(series.length, 1);
  const s = series[0]!;
  assert.equal(s.id, "series_rod_0001");
  assert.equal(s.itemPartId, "part:rod");
  assert.equal(s.name, "入门·泛用");
  assert.equal(s.concept, "入门级泛用型钓竿");
  assert.equal(s.fishingMethodId, "fishing_rod_0001");
  assert.equal(s.typeId, "type_rod_0001");
  assert.equal(s.qualityId, "quality_c_green");
  assert.equal(s.collectionId, "collection:rod");
  assert.equal(s.coreFunctionId, "function:all_round");
  assert.deepEqual(s.functionIntensityPolicy, { mode: "fixed", intensity: 1 });
  assert.deepEqual(s.coreAffixIds, ["affix_rod_a"]);
  assert.deepEqual(s.secondaryAffixPoolIds, ["affix_rod_b", "affix_rod_c"]);
  assert.deepEqual(s.forbiddenAffixIds, ["affix_rod_d"]);
  assert.deepEqual(s.planningPullRange, { minKgf: 1.0, maxKgf: 4.5 });
  assert.deepEqual(s.targetPullSpecifications, [
    { targetPullKgf: 1.0, skuId: "sku:series_rod_0001-1.0" },
    { targetPullKgf: 4.5, skuId: "sku:series_rod_0001-4.5" },
  ]);
  assert.deepEqual(s.signature, [{ parameterGroup: "竿自重g", expectedDirection: "negative", importance: 0.7, tolerance: 0.05 }]);
  assert.equal(s.status, "draft");
  assert.equal(s.revision, 1);
  assert.equal(s.createdAt, IMPORTED_AT);
  assert.equal(s.updatedAt, IMPORTED_AT);
  assert.deepEqual(s.skuIds, ["sku:series_rod_0001-1.0", "sku:series_rod_0001-4.5"]);
});

test("parseSeries：钓具类型 轮/线 映射 part:reel/line", () => {
  const reelRow = [...ROD_ROW]; reelRow[0] = "series_reel_0001"; reelRow[2] = "轮"; reelRow[8] = "fishing_reel_0001"; reelRow[9] = "type_reel_0001"; reelRow[11] = "collection:reel";
  const lineRow = [...ROD_ROW]; lineRow[0] = "series_line_0001"; lineRow[2] = "线"; lineRow[8] = "fishing_line_0001"; lineRow[9] = "type_line_0001"; lineRow[11] = "collection:line";
  const { series } = parseSeries({ sourceRevision, seriesValues: [HEADER, reelRow, lineRow], importedAt: IMPORTED_AT });
  assert.equal(series[0]!.itemPartId, "part:reel");
  assert.equal(series[1]!.itemPartId, "part:line");
});

test("parseSeries：无效钓具类型 fail-closed（issue + 跳行）", () => {
  const badRow = [...ROD_ROW]; badRow[2] = "网";
  const { series, issues } = parseSeries({ sourceRevision, seriesValues: [HEADER, badRow], importedAt: IMPORTED_AT });
  assert.equal(series.length, 0);
  assert.ok(issues.some((i) => i.code === "SERIES_PART_INVALID"));
});

test("parseSeries：非 fixed 功能强度模式跳行 + issue", () => {
  const badRow = [...ROD_ROW]; badRow[13] = "weight_curve"; badRow[14] = '{"rod":1}';
  const { series, issues } = parseSeries({ sourceRevision, seriesValues: [HEADER, badRow], importedAt: IMPORTED_AT });
  assert.equal(series.length, 0);
  assert.ok(issues.some((i) => i.code === "SERIES_INTENSITY_MODE_UNSUPPORTED"));
});

test("parseSeries：功能强度值非数跳行 + issue", () => {
  const badRow = [...ROD_ROW]; badRow[14] = "abc";
  const { series, issues } = parseSeries({ sourceRevision, seriesValues: [HEADER, badRow], importedAt: IMPORTED_AT });
  assert.equal(series.length, 0);
  assert.ok(issues.some((i) => i.code === "SERIES_INTENSITY_PARSE"));
});

test("parseSeries：表头 + 空行跳过（不计入 series/issues）", () => {
  const { series, issues } = parseSeries({ sourceRevision, seriesValues: [HEADER, [], ROD_ROW], importedAt: IMPORTED_AT });
  assert.equal(series.length, 1);
  assert.equal(issues.length, 0);
});

test("parseSeries：U 目标拉力格式错跳过对 + issue（不崩）", () => {
  const badRow = [...ROD_ROW]; badRow[20] = "1.0:sku:ok;badpair;2.0:sku:ok2";
  const { series, issues } = parseSeries({ sourceRevision, seriesValues: [HEADER, badRow], importedAt: IMPORTED_AT });
  assert.equal(series.length, 1);
  assert.equal(series[0]!.targetPullSpecifications.length, 2);
  assert.ok(issues.some((i) => i.code === "SERIES_TARGET_PULL_PARSE"));
});

test("parseSeries：V 签名轴格式错跳过 + issue（不崩）", () => {
  const badRow = [...ROD_ROW]; badRow[21] = "竿自重g:negative:0.7"; // 缺 tolerance
  const { series, issues } = parseSeries({ sourceRevision, seriesValues: [HEADER, badRow], importedAt: IMPORTED_AT });
  assert.equal(series.length, 1);
  assert.equal(series[0]!.signature.length, 0);
  assert.ok(issues.some((i) => i.code === "SERIES_SIGNATURE_PARSE"));
});

test("parseSeries：计划拉力区间无效置空 + warning issue", () => {
  const badRow = [...ROD_ROW]; badRow[18] = "5"; badRow[19] = "1"; // min > max
  const { series, issues } = parseSeries({ sourceRevision, seriesValues: [HEADER, badRow], importedAt: IMPORTED_AT });
  assert.equal(series.length, 1);
  assert.equal(series[0]!.planningPullRange, undefined);
  assert.ok(issues.some((i) => i.code === "SERIES_NUMBER_PARSE"));
});

test("parseSeries：实测 24 行 SeriesArchetype（rod/reel/line 各 8）全解析", () => {
  const rows: unknown[][] = [HEADER];
  for (const part of ["rod", "reel", "line"] as const) {
    for (let i = 1; i <= 8; i += 1) {
      const num = String(i).padStart(4, "0");
      const tackleType = part === "rod" ? "竿" : part === "reel" ? "轮" : "线";
      rows.push([
        `series_${part}_${num}`, "SeriesArchetype", tackleType, `${part}-${i}`, "无", "类型", "功能", "概念",
        `fishing_${part}_0001`, `type_${part}_0001`, "quality_c_green", `collection:${part}`, `function:all_round`, "fixed", String(((i - 1) % 3) + 1),
        "core", "sec1,sec2", "forb", "1.0", "4.5",
        `1.0:sku:series_${part}_${num}-1.0`, "竿自重g:negative:0.7:0.05", "draft",
      ]);
    }
  }
  const { series, issues } = parseSeries({ sourceRevision, seriesValues: rows, importedAt: IMPORTED_AT });
  assert.equal(series.length, 24);
  assert.equal(series.filter((s) => s.itemPartId === "part:rod").length, 8);
  assert.equal(series.filter((s) => s.itemPartId === "part:reel").length, 8);
  assert.equal(series.filter((s) => s.itemPartId === "part:line").length, 8);
  assert.equal(issues.length, 0);
});
