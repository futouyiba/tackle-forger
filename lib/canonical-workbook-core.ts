import type { FeishuSheetRegistryIssue, RemoteFeishuSheet } from "./feishu-workbook";
import {
  importPricingPolicyDraft,
  type PricingPolicyDraft,
  type PricingExecutionPolicy,
  type PricingLookupEntry,
  type PricingCellRef,
  type QualityPriceFactorRange,
  type QualityPricingMapping,
} from "./pricing-policy";
import {
  importQualityValuePolicyDraft,
  type AffixAliasBinding,
  type QualityCombinationSourceCell,
  type QualityValuePolicyDraft,
  type QualityTableDescriptor,
  type QualityValueRange,
} from "./quality-value-policy";
import {
  prepareSourceIdentityMigration,
  type SourceIdentityMigrationReport,
  type SourceIdentityPolicy,
  type SourceIdentityRow,
} from "./source-id-migration";
import {
  CANONICAL_ITEM_PARTS,
  CANONICAL_RULE_RANGES,
  importCanonicalRuleSource,
  type PartedRuleSource,
} from "./canonical-rule-source";
import type { CanonicalRuleSourceDraft, SeriesDefinition, SeriesSignatureAxis, WeightTemplatePolicyDraft } from "./types";
import { deterministicHash } from "./rule-kernel";

export interface IdentitySheetSpec {
  sheetId: string;
  /** 身份区 range 前缀（如 `B1:C`/`A1:S`），完整 range 按 grid rowCount 动态拼接，匹配用 startsWith。 */
  range: string;
  idColumnKey: string;
  /** 分表部位（竿/轮/线）；单表概念（functionProfiles/affix/series）缺省。 */
  part?: "rod" | "reel" | "line";
  fixedEntityType?: string;
  allowedEntityTypes: string[];
  idPrefixesByEntityType: Record<string, string[]>;
}

/**
 * WQ8w 分表身份规格（PR2b 切流）。竿/轮/线拆为独立子表的概念（weight/type/function）
 * 各登记 3 个 part-indexed spec；functionProfiles/affix/series 仍是单表。
 * 身份区统一 `B1:C`（新表分表后 machineId 回到 B 列；旧 d6e928 合并表的 BG 身份区是历史块布局）。
 */
export const CANONICAL_IDENTITY_SHEET_SPECS: IdentitySheetSpec[] = [
  { sheetId: "19XKzU", range: "A1:S", idColumnKey: "A", fixedEntityType: "FunctionProfile", allowedEntityTypes: ["FunctionProfile"], idPrefixesByEntityType: { FunctionProfile: ["function:"] } },
  { sheetId: "1cAihB", range: "B1:C", idColumnKey: "B", part: "rod", fixedEntityType: "WeightTemplate", allowedEntityTypes: ["WeightTemplate"], idPrefixesByEntityType: { WeightTemplate: ["wtpl_rod_"] } },
  { sheetId: "2KCCHR", range: "B1:C", idColumnKey: "B", part: "reel", fixedEntityType: "WeightTemplate", allowedEntityTypes: ["WeightTemplate"], idPrefixesByEntityType: { WeightTemplate: ["wtpl_reel_"] } },
  { sheetId: "3FYijT", range: "B1:C", idColumnKey: "B", part: "line", fixedEntityType: "WeightTemplate", allowedEntityTypes: ["WeightTemplate"], idPrefixesByEntityType: { WeightTemplate: ["wtpl_line_"] } },
  { sheetId: "10TyFp", range: "B1:C", idColumnKey: "B", part: "rod", fixedEntityType: "RodType", allowedEntityTypes: ["RodType"], idPrefixesByEntityType: { RodType: ["type_rod_"] } },
  { sheetId: "11CfXW", range: "B1:C", idColumnKey: "B", part: "reel", fixedEntityType: "ReelType", allowedEntityTypes: ["ReelType"], idPrefixesByEntityType: { ReelType: ["type_reel_"] } },
  { sheetId: "12VetE", range: "B1:C", idColumnKey: "B", part: "line", fixedEntityType: "LineType", allowedEntityTypes: ["LineType"], idPrefixesByEntityType: { LineType: ["type_line_"] } },
  { sheetId: "16qYVn", range: "B1:C", idColumnKey: "B", part: "rod", fixedEntityType: "FunctionProfile", allowedEntityTypes: ["FunctionProfile"], idPrefixesByEntityType: { FunctionProfile: ["func_rod_"] } },
  { sheetId: "17jqiE", range: "B1:C", idColumnKey: "B", part: "reel", fixedEntityType: "FunctionProfile", allowedEntityTypes: ["FunctionProfile"], idPrefixesByEntityType: { FunctionProfile: ["func_reel_"] } },
  { sheetId: "18pjcZ", range: "B1:C", idColumnKey: "B", part: "line", fixedEntityType: "FunctionProfile", allowedEntityTypes: ["FunctionProfile"], idPrefixesByEntityType: { FunctionProfile: ["func_line_"] } },
  { sheetId: "19XKzU", range: "Q1:S", idColumnKey: "Q:S", fixedEntityType: "FunctionPartGroup", allowedEntityTypes: ["FunctionPartGroup"], idPrefixesByEntityType: { FunctionPartGroup: ["funcgrp_rod_", "funcgrp_reel_", "funcgrp_line_"] } },
  { sheetId: "23CsXE", range: "B1:C", idColumnKey: "B", allowedEntityTypes: ["RodAffix", "ReelAffix", "LineAffix"], idPrefixesByEntityType: { RodAffix: ["affix_rod_"], ReelAffix: ["affix_reel_"], LineAffix: ["affix_line_"] } },
  { sheetId: "25UnTC", range: "A1:W", idColumnKey: "A", fixedEntityType: "SeriesArchetype", allowedEntityTypes: ["SeriesArchetype"], idPrefixesByEntityType: { SeriesArchetype: ["series_rod_", "series_reel_", "series_line_"] } },
];

export const AFFIX_SHEET_ID = "23CsXE";
/** 品质定义主表（区间/价格系数）；公式 26gpIF 与组合矩阵 28fQhg 由 PR2b-3 接入。 */
const QUALITY_SHEET_ID = "27hboC";
// The repository's Feishu reader already rejects sources over 10,000 rows.
// Keep this whole-sheet read below the same row ceiling and additionally cap
// columns/cells so corrupt grid metadata cannot request an unbounded payload.
const MAXIMUM_FEISHU_SHEET_ROWS = 10_000;
const MAXIMUM_QUALITY_SHEET_COLUMNS = 200;
const MAXIMUM_QUALITY_SHEET_CELLS = 200_000;
/** The header occupies row 1; a smaller grid cannot hold any data row. */
const MINIMUM_AFFIX_MACHINE_ROW_COUNT = 1;

export interface CanonicalAffixSheetRanges {
  identityRange: string;
  aliasRange: string;
}

/**
 * `04_词条` has no fixed last data row.  The grid size returned in the same
 * FeishuSourceRevision is the only authoritative read boundary: extending the
 * machine region therefore extends both identity and alias reads without a
 * second, silently stale constant.  Missing or malformed grid metadata is a
 * source-structure error, not permission to truncate the import.
 */
export function canonicalAffixSheetRanges(sourceRevision: Pick<CanonicalWorkbookSourceRevision, "sheets">): CanonicalAffixSheetRanges {
  const sheet = sourceRevision.sheets.find((candidate) => candidate.sheetId === AFFIX_SHEET_ID);
  const rowCount = sheet?.rowCount;
  const columnCount = sheet?.columnCount;
  if (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < MINIMUM_AFFIX_MACHINE_ROW_COUNT) {
    throw new Error(`04_词条/${AFFIX_SHEET_ID} 缺少可验证的 grid rowCount；已停止读取，避免截断词条机器区。`);
  }
  if (typeof columnCount !== "number" || !Number.isSafeInteger(columnCount) || columnCount < 1) {
    throw new Error(`04_词条/${AFFIX_SHEET_ID} 缺少可验证的 grid columnCount；已停止读取，避免不完整别名导入。`);
  }
  return {
    identityRange: `B1:C${rowCount}`,
    aliasRange: `B2:F${rowCount}`,
  };
}

function spreadsheetColumnName(index: number) {
  let name = "";
  for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) {
    name = String.fromCharCode(65 + (current - 1) % 26) + name;
  }
  return name;
}

/**
 * 07_品质评分的可读边界由同一 source revision 的 grid 元数据决定。
 * 该表的矩阵块会随内容扩列、移动，故不能把旧 B4:N50 当作来源契约。
 */
export function canonicalQualitySheetRange(sourceRevision: Pick<CanonicalWorkbookSourceRevision, "sheets">) {
  const sheet = sourceRevision.sheets.find((candidate) => candidate.sheetId === QUALITY_SHEET_ID);
  const rowCount = sheet?.rowCount;
  const columnCount = sheet?.columnCount;
  if (!Number.isSafeInteger(rowCount) || rowCount! < 1 || rowCount! > MAXIMUM_FEISHU_SHEET_ROWS
    || !Number.isSafeInteger(columnCount) || columnCount! < 1 || columnCount! > MAXIMUM_QUALITY_SHEET_COLUMNS
    || rowCount! * columnCount! > MAXIMUM_QUALITY_SHEET_CELLS) {
    throw new Error(`07_品质评分/${QUALITY_SHEET_ID} 缺少可验证的 grid 元数据；已停止读取，避免截断或猜测组合矩阵。`);
  }
  return `A1:${spreadsheetColumnName(columnCount! - 1)}${rowCount}`;
}

/**
 * WQ8w 分表 range 请求（PR2b 切流）。每张子表生成两条 range：
 * - 身份区 `B1:C<rowCount>`（functionProfiles 父级用 `A1:S`、FunctionPartGroup 用 `Q1:S`）
 * - 完整机器区 `A1:<末列><rowCount>`（供 parse* sources 读全部列）
 * 同 sheetId 两条 range 按 `sheetId:range` 去重保留；rowCount/columnCount 取自同 revision 的 grid 元数据，
 * 缺失/过小 fail-closed（spec §14 :944）。品质/定价三表整表读（公式读取 PR2b-3 重构）。
 */
export function canonicalRuleWorkbookRangeRequests(sourceRevision: CanonicalWorkbookSourceRevision) {
  const affixRanges = canonicalAffixSheetRanges(sourceRevision);
  const dynamicRange = (sheetId: string, prefix: string, minRowCount: number, minColumns: number) => {
    const sheet = sourceRevision.sheets.find((candidate) => candidate.sheetId === sheetId);
    const rowCount = sheet?.rowCount;
    const columnCount = sheet?.columnCount;
    if (!Number.isSafeInteger(rowCount) || rowCount! < minRowCount || !Number.isSafeInteger(columnCount) || columnCount! < minColumns) {
      throw new Error(`工作表 ${sheetId} 缺少可验证的 grid 元数据（需 rowCount>=${minRowCount}, columnCount>=${minColumns}）；已停止读取，避免截断。`);
    }
    return `${prefix}${rowCount}`;
  };
  const fullRange = (sheetId: string, minRowCount: number, minColumns: number) => {
    const sheet = sourceRevision.sheets.find((candidate) => candidate.sheetId === sheetId);
    const rowCount = sheet?.rowCount;
    const columnCount = sheet?.columnCount;
    if (!Number.isSafeInteger(rowCount) || rowCount! < minRowCount || !Number.isSafeInteger(columnCount) || columnCount! < minColumns) {
      throw new Error(`工作表 ${sheetId} 缺少可验证的完整 grid 元数据（需 rowCount>=${minRowCount}, columnCount>=${minColumns}）；已停止读取，避免截断机器 ID 或模板字段。`);
    }
    return `A1:${spreadsheetColumnName(columnCount! - 1)}${rowCount}`;
  };
  const requests: Array<{ sheetId: string; range: string }> = [];
  // 身份区（每 spec 一条）
  for (const spec of CANONICAL_IDENTITY_SHEET_SPECS) {
    if (spec.fixedEntityType === "FunctionProfile" && spec.range === "A1:S") requests.push({ sheetId: spec.sheetId, range: dynamicRange(spec.sheetId, "A1:S", 1, 1) });
    else if (spec.fixedEntityType === "FunctionPartGroup") requests.push({ sheetId: spec.sheetId, range: dynamicRange(spec.sheetId, "Q1:S", 1, 1) });
    else if (spec.sheetId === AFFIX_SHEET_ID) requests.push({ sheetId: spec.sheetId, range: affixRanges.identityRange });
    else requests.push({ sheetId: spec.sheetId, range: dynamicRange(spec.sheetId, spec.range, 1, 1) });
  }
  // affix 别名（quality 组合矩阵用）
  requests.push({ sheetId: AFFIX_SHEET_ID, range: affixRanges.aliasRange });
  // 重量/类型/钓法/功能/钓法模板：三子表完整机器区（供 importCanonicalRuleSource 的 sources 读全部列）
  for (const group of ["weight", "type", "function", "method", "methodTemplateReview"] as const) {
    for (const part of CANONICAL_ITEM_PARTS) {
      const sheetId = CANONICAL_RULE_RANGES[group][part];
      requests.push({ sheetId, range: fullRange(sheetId, 1, 1) });
    }
  }
  // 品质三表（27hboC 已由 canonicalQualitySheetRange 动态整表读；公式/组合表 PR2b-3 接入）
  requests.push({ sheetId: "26gpIF", range: fullRange("26gpIF", 1, 1) });
  requests.push({ sheetId: QUALITY_SHEET_ID, range: canonicalQualitySheetRange(sourceRevision) });
  requests.push({ sheetId: "28fQhg", range: fullRange("28fQhg", 1, 1) });
  // 定价三表（PR2b-1 只切 sheetId + 整表 range；公式读取 PR2b-3）
  requests.push({ sheetId: "31RxeB", range: fullRange("31RxeB", 1, 1) });
  requests.push({ sheetId: "32BmZs", range: fullRange("32BmZs", 1, 1) });
  requests.push({ sheetId: "33IGHy", range: fullRange("33IGHy", 1, 1) });
  return [...new Map(requests.map((request) => [`${request.sheetId}:${request.range}`, request])).values()];
}

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function identityRowsFromRanges(
  ranges: Array<{ sheetId: string; range?: string; valueRange: Pick<CanonicalWorkbookRangeValue, "values"> }>,
  specs = CANONICAL_IDENTITY_SHEET_SPECS,
): SourceIdentityRow[] {
  const hasExplicitRanges = ranges.some((candidate) => typeof candidate.range === "string");
  return specs.flatMap((spec) => {
    // finding 7 修复：有显式 range 时按 startsWith 匹配（新表动态 range）；无显式 range（旧 fixture/兼容调用）时按唯一 sheetId 严格回退，不静默返回空。
    const entry = hasExplicitRanges
      ? ranges.find((candidate) => candidate.sheetId === spec.sheetId && typeof candidate.range === "string" && candidate.range.startsWith(spec.range))
      : ranges.find((candidate) => candidate.sheetId === spec.sheetId);
    const rows = entry?.valueRange.values ?? [];
    return rows.flatMap((values, index) => {
      const sourceRow = index + 1;
      if (spec.fixedEntityType === "FunctionPartGroup") {
        return (values as unknown[]).flatMap((value, columnIndex) => {
          const stableId = text(value);
          // Q:S 的第 1 行是 rod/reel/lineFunctionGroupId 表头；Id 的大小写不应参与身份判断。
          if (!stableId || index === 0) return [];
          const part = ["rod", "reel", "line"][columnIndex];
          return [{ sheetId: spec.sheetId, rowKey: `${sourceRow}:${part}`, displayName: `FunctionPartGroup · ${part} · 第 ${sourceRow} 行`, entityType: "FunctionPartGroup", stableId, idColumnKey: ["Q", "R", "S"][columnIndex]! }];
        });
      }
      // 04.0 父级常量表第一行是表头，跳过（兼容新 spec A1:S 与 LEGACY A1:S8）。
      if (spec.fixedEntityType === "FunctionProfile" && spec.range.startsWith("A1:S") && index === 0) return [];
      const stableId = text(values[0]);
      const adjacentValue = text(values[1]);
      if (!stableId && !adjacentValue) return [];
      if (/ID（勿改）|ID（永久）|机器ID/.test(stableId) || adjacentValue === "实体类型" || adjacentValue === "同步状态") return [];
      const entityType = spec.fixedEntityType ?? adjacentValue;
      if (!entityType) return [];
      const partSuffix = spec.part ? ` · ${spec.part}` : "";
      return [{
        sheetId: spec.sheetId,
        rowKey: String(sourceRow),
        displayName: `${entityType}${partSuffix} · 第 ${sourceRow} 行`,
        entityType,
        stableId: stableId || undefined,
        idColumnKey: spec.idColumnKey,
      }];
    });
  });
}

export function canonicalIdentityPolicies(specs: IdentitySheetSpec[] = CANONICAL_IDENTITY_SHEET_SPECS): SourceIdentityPolicy[] {
  const grouped = new Map<string, SourceIdentityPolicy>();
  for (const spec of specs) {
    const current = grouped.get(spec.sheetId) ?? { sheetId: spec.sheetId, allowedEntityTypes: [], idPrefixesByEntityType: {} };
    current.allowedEntityTypes = [...new Set([...current.allowedEntityTypes, ...spec.allowedEntityTypes])];
    for (const [entityType, prefixes] of Object.entries(spec.idPrefixesByEntityType)) current.idPrefixesByEntityType[entityType] = [...new Set([...(current.idPrefixesByEntityType[entityType] ?? []), ...prefixes])];
    grouped.set(spec.sheetId, current);
  }
  return [...grouped.values()];
}

function parsePricingWq8wParams(pricingParamsValues: unknown[][]) {
  const map = new Map<string, string>();
  for (let index = 1; index < pricingParamsValues.length; index += 1) {
    const row = pricingParamsValues[index] ?? [];
    const key = text(row[0]).trim();
    const status = text(row[1]).trim();
    const value = text(row[3]); // A=key, B=status, D=value
    if (key && status && status !== "设计约定") map.set(key, value);
  }
  return {
    get: (key: string) => map.get(key)?.trim() ?? "",
    has: (key: string) => map.has(key),
    keys: () => map.keys(),
  };
}

const qualityIds: Record<string, QualityPricingMapping["qualityId"]> = {
  C: "quality_c_green",
  B: "quality_b_blue",
  A: "quality_a_purple",
  S: "quality_s_orange",
};

export function pricingDraftFromRanges(input: {
  sourceRevision: CanonicalWorkbookSourceRevision;
  qualityValues: unknown[][];
  /** Exact rows selected by the quality-table parser; avoids a second layout guess. */
  qualitySourceRows?: Array<{ code: string; minScore: number; maxScore: number; minFactor: number; maxFactor: number; mappingCell: string; factorCell: string; rowKey: string }>;
  pricingValues?: unknown[][];
  /** WQ8w 09.1 参数释义 (32BmZs) — B=key, D=value format replacing old machine-key layout */
  pricingParamsValues?: unknown[][];
  /** WQ8w 09.2 维修+零整比 (33IGHy) — 行格式 (part, weight, quality, maintenance, ratio) */
  pricingEndpointValues?: unknown[][];
  typeValues?: unknown[][];
  importedAt: string;
}): PricingPolicyDraft {
  const qualityMappings = input.qualitySourceRows
    ? input.qualitySourceRows.flatMap((row): QualityPricingMapping[] => {
      const qualityId = qualityIds[row.code];
      return qualityId ? [{ qualityId, sourceAlias: row.code, status: "SOURCE", source: { sheetId: QUALITY_SHEET_ID, cell: row.mappingCell, rowKey: row.rowKey } }] : [];
    })
    : input.qualityValues.flatMap((row, index): QualityPricingMapping[] => {
    const code = text(row[1]);
    const qualityId = qualityIds[code];
    if (!qualityId) return [];
    const sheetRow = index + 5;
    return [{
      qualityId,
      sourceAlias: text(row[5]) || code,
      status: "SOURCE",
      source: { sheetId: "27hboC", cell: `D${sheetRow}`, rowKey: String(sheetRow) },
    }];
  });
  const qualityPriceFactorRanges: QualityPriceFactorRange[] = input.qualitySourceRows
    ? input.qualitySourceRows.flatMap((row) => {
      const qualityId = qualityIds[row.code];
      return qualityId && [row.minScore, row.maxScore, row.minFactor, row.maxFactor].every(Number.isFinite)
        ? [{ qualityId, minScore: row.minScore, maxScore: row.maxScore, maxInclusive: false, minFactor: row.minFactor, maxFactor: row.maxFactor, status: "SOURCE" as const, source: { sheetId: QUALITY_SHEET_ID, cell: row.factorCell, rowKey: row.rowKey } }]
        : [];
    })
    : input.qualityValues.flatMap((row, index) => {
    const qualityId = qualityIds[text(row[1])];
    const minScore = Number(row[3]);
    const maxScore = Number(row[4]);
    const minFactor = Number(row[5]);
    const maxFactor = Number(row[6]);
    if (!qualityId || ![minScore, maxScore, minFactor, maxFactor].every(Number.isFinite)) return [];
    const sheetRow = index + 5;
    return [{ qualityId, minScore, maxScore, maxInclusive: false, minFactor, maxFactor, status: "SOURCE", source: { sheetId: "27hboC", cell: `E${sheetRow}:H${sheetRow}`, rowKey: String(sheetRow) } }];
  });
  const pricingValues = input.pricingValues ?? [];
  const wq8wLookup = parsePricingWq8wLookup(input.pricingEndpointValues);
  const maintenanceConsumptionRates: PricingLookupEntry[] = wq8wLookup.maintenanceConsumptionRates.length
    ? wq8wLookup.maintenanceConsumptionRates
    : (() => { const leg: PricingLookupEntry[] = []; for (let i = 13; i < pricingValues.length; i++) { const r = pricingValues[i] ?? []; const b = text(r[0]); const v = Number(r[2]); if (b && Number.isFinite(v)) leg.push({ pricingWeightBandId: `weight_band:${b}`, value: { value: v, status: "SOURCE", source: { sheetId: "31RxeB", cell: `D${i + 10}`, rowKey: String(i + 10) } } }); } return leg; })();
  const partAllocationRatios: PricingLookupEntry[] = wq8wLookup.partAllocationRatios.length
    ? wq8wLookup.partAllocationRatios
    : (() => { const leg: PricingLookupEntry[] = []; for (let i = 13; i < pricingValues.length; i++) { const r = pricingValues[i] ?? []; const b = text(r[4]); for (const [off, pid] of [[5, "rod"], [6, "reel"], [7, "line"]] as const) { const v = Number(r[off]); if (b && Number.isFinite(v)) leg.push({ pricingWeightBandId: `weight_band:${b}`, partId: pid, value: { value: v, status: "SOURCE", source: { sheetId: "31RxeB", cell: `${String.fromCharCode(66 + off)}${i + 10}`, rowKey: String(i + 10) } } }); } } return leg; })();
  const totalLossTimes: PricingLookupEntry[] = wq8wLookup.totalLossTimes.length
    ? wq8wLookup.totalLossTimes
    : (() => { const leg: PricingLookupEntry[] = []; for (let i = 13; i < pricingValues.length; i++) { const r = pricingValues[i] ?? []; const b = text(r[9]); for (const [off, pid] of [[11, "rod"], [12, "reel"], [13, "line"]] as const) { const v = Number(r[off]); if (b && Number.isFinite(v)) leg.push({ pricingWeightBandId: `weight_band:${b}`, partId: pid, value: { value: v, status: "SOURCE", source: { sheetId: "31RxeB", cell: `${String.fromCharCode(66 + off)}${i + 10}`, rowKey: String(i + 10) } } }); } } return leg; })();
  const partsToWholeRatios: PricingLookupEntry[] = wq8wLookup.partsToWholeRatios.length
    ? wq8wLookup.partsToWholeRatios
    : (() => { const leg: PricingLookupEntry[] = []; for (let i = 13; i < pricingValues.length; i++) { const r = pricingValues[i] ?? []; const b = text(r[9]); for (const [off, pid] of [[14, "rod"], [15, "reel"], [16, "line"]] as const) { const v = Number(r[off]); if (b && Number.isFinite(v)) leg.push({ pricingWeightBandId: `weight_band:${b}`, partId: pid, value: { value: v, status: "SOURCE", source: { sheetId: "31RxeB", cell: `${String.fromCharCode(66 + off)}${i + 10}`, rowKey: String(i + 10) } } }); } } return leg; })();
  const repairCoefficients: PricingLookupEntry[] = [];
  const purchaseCoefficients: PricingLookupEntry[] = [];
  const typeSheetOrder = ["10TyFp", "11CfXW", "12VetE"];
  let repairCol = 19, purchaseCol = 20, currentTypeSheet = typeSheetOrder[0]!;
  let sheetIndex = 0;
  for (let index = 1; index < (input.typeValues ?? []).length; index += 1) {
    const row = input.typeValues?.[index] ?? [];
    const typeId = text(row[0]);
    const entityType = text(row[1]);
    if (typeId.includes("勿改") || typeId.includes("ID")) {
      const hi = row.findIndex((v) => text(v).includes("维修系数"));
      const pi = row.findIndex((v) => text(v).includes("购买系数"));
      if (hi >= 0) repairCol = hi;
      if (pi >= 0) purchaseCol = pi;
      if (entityType === "实体类型") { sheetIndex++; currentTypeSheet = typeSheetOrder[Math.min(sheetIndex, 2)]!; }
      continue;
    }
    const partId = entityType === "RodType" ? "rod" : entityType === "ReelType" ? "reel" : entityType === "LineType" ? "line" : "";
    if (!typeId || !partId) continue;
    const sheetRow = index + 2;
    const repair = Number(row[repairCol]);
    const purchase = Number(row[purchaseCol]);
    const colName = (idx: number) => String.fromCharCode(65 + idx);
    if (Number.isFinite(repair)) repairCoefficients.push({ partId, typeId, value: { value: repair, status: "SOURCE", source: { sheetId: currentTypeSheet, cell: `${colName(repairCol)}${sheetRow}`, rowKey: String(sheetRow) } } });
    if (Number.isFinite(purchase)) purchaseCoefficients.push({ partId, typeId, value: { value: purchase, status: "SOURCE", source: { sheetId: currentTypeSheet, cell: `${colName(purchaseCol)}${sheetRow}`, rowKey: String(sheetRow) } } });
  }
  const wq8w = input.pricingParamsValues ? parsePricingWq8wParams(input.pricingParamsValues) : { get: () => "", has: () => false, keys: () => [][Symbol.iterator]() };
  const hasWq8wParams = input.pricingParamsValues && input.pricingParamsValues.length > 1;

  // Legacy: check for old-style machine keys in pricingValues
  const executionFields = hasWq8wParams ? null : (() => {
    const map = new Map<string, { value: unknown; row: number }>();
    const pv = input.pricingValues ?? [];
    for (let index = 0; index < pv.length; index += 1) {
      const row = pv[index] ?? [];
      const key = text(row[0]).trim();
      if (key) map.set(key, { value: row[2], row: index + 10 });
    }
    const pricingMachineKeys = ["pricing.repairRoundingStage", "pricing.purchaseInput", "pricing.purchaseRoundingStage", "pricing.rounding", "pricing.significantDigits", "pricing.minimumPurchasePrice", "pricing.minimumPriceScope", "pricing.upperThreshold", "pricing.upperThresholdMode"] as const;
    return pricingMachineKeys.some((k) => map.has(k)) ? map : null;
  })();
  const legacyExecutionValue = (key: string) => executionFields?.get(key)?.value;
  const legacyExecutionRow = (key: string) => executionFields?.get(key)?.row;

  const hasExecutionFields = hasWq8wParams || !!executionFields;
  const executionPolicy = hasExecutionFields ? {
    repairRoundingStage: (hasWq8wParams ? "final_repair_output" : text(legacyExecutionValue("pricing.repairRoundingStage"))) as PricingExecutionPolicy["repairRoundingStage"],
    purchaseInput: (hasWq8wParams ? "repair_price_raw" : text(legacyExecutionValue("pricing.purchaseInput"))) as PricingExecutionPolicy["purchaseInput"],
    purchaseRoundingStage: (hasWq8wParams ? "final_purchase_output" : text(legacyExecutionValue("pricing.purchaseRoundingStage"))) as PricingExecutionPolicy["purchaseRoundingStage"],
    rounding: "significant_digits_floor" as const,
    significantDigits: 3,
    minimumPurchasePrice: hasWq8wParams ? (Number(wq8w.get("minimum_price")) || 100) : Number(legacyExecutionValue("pricing.minimumPurchasePrice")),
    minimumPriceScope: "purchase_output_after_rounding" as const,
    upperThreshold: hasWq8wParams ? (Number(wq8w.get("overflow_maximum")) || 300000000) : Number(legacyExecutionValue("pricing.upperThreshold")),
    upperThresholdMode: "warning_acknowledgement" as const,
    status: "SOURCE" as const,
    source: { sheetId: hasWq8wParams ? "32BmZs" : "31RxeB", cell: hasWq8wParams ? "A2:E9" : `B${legacyExecutionRow("pricing.repairRoundingStage") ?? 0}:D${legacyExecutionRow("pricing.upperThresholdMode") ?? 0}`, rowKey: "pricing.execution.machine.v1" },
  } as PricingExecutionPolicy : undefined;
  const legacyParam = (sheetRow: number) => (input.pricingValues ?? [])[sheetRow - 10]?.[2];
  const moneyPolicy = hasWq8wParams ? {
    unit: wq8w.get("currency_unit") || "金币",
    rounding: "significant_digits_floor" as const,
    precision: 3,
    significantDigits: 3,
    minimumPrice: Number(wq8w.get("minimum_price")) || 100,
    maximumPrice: Number(wq8w.get("overflow_maximum")) || 300000000,
    status: "SOURCE" as const,
    source: { sheetId: "32BmZs", cell: "A6:D9", rowKey: "6-9" },
  } : (input.pricingValues?.length ?? 0) > 0 ? {
    unit: text(legacyParam(15)),
    rounding: "significant_digits_floor" as const,
    precision: 3,
    significantDigits: 3,
    minimumPrice: Number(legacyParam(17)),
    maximumPrice: Number(legacyParam(18)),
    status: "SOURCE" as const,
    source: { sheetId: "31RxeB", cell: "B15:D18", rowKey: "15-18" },
  } : undefined;
  return importPricingPolicyDraft({
    sourceRevisionId: input.sourceRevision.id,
    sourceRevision: input.sourceRevision.sourceRevision,
    pricingSheetId: "31RxeB",
    qualitySheetId: "27hboC",
    typeMaterialSheetId: "10TyFp",
    businessFormulaCells: [2, 3, 4, 5, 6, 7].map((row) => ({ sheetId: "31RxeB", cell: `B${row}` })),
    maintenanceConsumptionRates,
    partAllocationRatios,
    repairCoefficients,
    totalLossTimes,
    purchaseCoefficients,
    partsToWholeRatios,
    qualityMappings,
    qualityPriceFactorRanges,
    scoreInterpolation: hasWq8wParams || (input.pricingValues?.length ?? 0) > 0 ? { kind: "quality_range_linear" as const, points: [], outOfRange: "error" as const, status: "SOURCE" as const, source: { sheetId: hasWq8wParams ? "32BmZs" : "31RxeB", cell: "A2:D2", rowKey: "2" } } : undefined,
    moneyPolicy,
    ...(executionPolicy ? { executionPolicy } : {}),
    importedAt: input.importedAt,
  });
}

export function pricingQualitySourceRowsFromDraft(
  qualityDraft: QualityValuePolicyDraft,
  _legacyQualityValues?: unknown[][],
) {
  return (qualityDraft.qualityTableDescriptor?.rows ?? []).map((row) => ({
    code: row.code, minScore: row.minScore, maxScore: row.maxScore, minFactor: row.minFactor, maxFactor: row.maxFactor,
    mappingCell: row.mappingSource.cell, factorCell: row.factorSource.cell, rowKey: row.mappingSource.rowKey ?? "",
  }));
}

function parsePricingWq8wLookup(rows: unknown[][] | undefined): {
  maintenanceConsumptionRates: PricingLookupEntry[];
  partsToWholeRatios: PricingLookupEntry[];
  partAllocationRatios: PricingLookupEntry[];
  totalLossTimes: PricingLookupEntry[];
} {
  const partNames: Record<string, string> = { "竿": "rod", "轮": "reel", "线": "line" };
  const rates: PricingLookupEntry[] = [];
  const ratios: PricingLookupEntry[] = [];
  const allocRates: PricingLookupEntry[] = [];
  const lossTimes: PricingLookupEntry[] = [];
  const seenAlloc = new Set<string>();
  const seenLoss = new Set<string>();
  if (!rows || rows.length < 2) return { maintenanceConsumptionRates: rates, partsToWholeRatios: ratios, partAllocationRatios: allocRates, totalLossTimes: lossTimes };
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const partId = partNames[text(row[0])] ?? "";
    const weightBand = text(row[1]);
    const maintenance = Number(row[3]);
    const ratio = Number(row[4]);
    if (!weightBand || !partId) continue;
    const bandId = `weight_band:${weightBand}`;
    const src: PricingCellRef = { sheetId: "33IGHy", cell: `A${index + 1}:E${index + 1}`, rowKey: String(index + 1) };
    if (Number.isFinite(maintenance)) {
      const key = `${bandId}:${partId}`;
      // WQ8w rates are quality-scoped; downstream trial expects per-(band,part).
      // Only accept C quality as the base maintenance value.
      if (!seenAlloc.has(key) && text(row[2]) === "C") {
        seenAlloc.add(key);
        rates.push({ pricingWeightBandId: bandId, partId, value: { value: maintenance, status: "SOURCE", source: src } });
        // part allocation and total loss baked into per-part maintenance; emit identity defaults.
        seenLoss.add(key);
        allocRates.push({ pricingWeightBandId: bandId, partId, value: { value: 1, status: "SOURCE" as const, source: src } });
        lossTimes.push({ pricingWeightBandId: bandId, partId, value: { value: 1, status: "SOURCE" as const, source: src } });
      }
    }
    if (Number.isFinite(ratio)) {
      ratios.push({ pricingWeightBandId: bandId, partId, value: { value: ratio, status: "SOURCE", source: src } });
    }
  }
  return { maintenanceConsumptionRates: rates, partsToWholeRatios: ratios, partAllocationRatios: allocRates, totalLossTimes: lossTimes };
}

const partIds: Record<string, string> = { "竿": "part:rod", "轮": "part:reel", "线": "part:line" };

export function weightTemplateDraftCanonicalContent(draft: WeightTemplatePolicyDraft) {
  return { sourceRevisionId: draft.sourceRevisionId, sourceRevision: draft.sourceRevision, sheetId: draft.sheetId, templates: draft.templates, issues: draft.issues, formalStatus: draft.formalStatus, importedAt: draft.importedAt };
}

export function assertCanonicalWeightTemplatePolicyDraft(draft: WeightTemplatePolicyDraft) {
  const inputHash = deterministicHash(weightTemplateDraftCanonicalContent(draft));
  if (draft.inputHash !== inputHash || draft.id !== `weight-template-draft:${inputHash}`) throw new Error("重量模板草稿的冻结内容、inputHash 或 ID 不一致，不能信任或发布。");
}

export function weightTemplateDraftFromCanonicalRuleDraft(input: { sourceRevision: CanonicalWorkbookSourceRevision; canonicalRuleDraft: CanonicalRuleSourceDraft; weightSources: PartedRuleSource[]; importedAt: string }): WeightTemplatePolicyDraft {
  const issues: WeightTemplatePolicyDraft["issues"] = [];
  const templates: WeightTemplatePolicyDraft["templates"] = [];
  const seen = new Set<string>();
  // finding 3 修复（Opus MAJOR）：恢复精确单元格 provenance。按 weightSources 的 sourceSheetId + 表头解析字段→列坐标，
  // template.cells 冻结 machineId/min/max/band/属性列；issue 按实际错误字段选 cell（不再统一 B<row>）。
  const columnName = (index: number) => { let name = ""; for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) name = String.fromCharCode(65 + (current - 1) % 26) + name; return name; };
  // 收集每张子表的所有表头块（分表单块；旧合并表 fixture 可能多块），按 headerRow 索引。
  const headerBlocksBySheet = new Map<string, Array<{ headerRow: number; headers: string[] }>>();
  for (const source of input.weightSources) {
    const blocks: Array<{ headerRow: number; headers: string[] }> = [];
    source.values.forEach((row, index) => {
      if (row.some((value) => text(value).includes("机器ID"))) blocks.push({ headerRow: index + 1, headers: row.map(text) });
    });
    headerBlocksBySheet.set(source.sheetId, blocks);
  }
  const cellsForRow = (sheetId: string, sourceRow: number) => {
    // 按 sourceRow 找最近的前置表头块（旧合并表多块支持；分表单块时即唯一表头）。
    const blocks = headerBlocksBySheet.get(sheetId) ?? [];
    const headers = [...blocks].reverse().find((block) => block.headerRow < sourceRow)?.headers ?? blocks[0]?.headers ?? [];
    const headerIndex = (...labels: string[]) => headers.findIndex((header) => labels.some((label) => header === label || header.includes(label)));
    const cells: Record<string, string> = {};
    const bind = (key: string, ...labels: string[]) => { const index = headerIndex(...labels); if (index >= 0) cells[key] = `${columnName(index)}${sourceRow}`; };
    bind("machineId", "机器ID");
    bind("fishMinKg", "最小拉力", "鱼重下限kg");
    bind("fishMaxKg", "最大拉力", "鱼重上限kg");
    bind("weightBand", "重量段", "档位");
    if (cells.fishMinKg && cells.fishMaxKg) cells.nominalFishKg = `${cells.fishMinKg}:${cells.fishMaxKg}`;
    for (let index = 0; index < headers.length; index += 1) { const header = headers[index]; if (header && !cells[header]) cells[header] = `${columnName(index)}${sourceRow}`; }
    return cells;
  };
  for (const issue of input.canonicalRuleDraft.issues) {
    if (!issue.code.startsWith("WEIGHT_TEMPLATE_")) continue;
    const sheetId = issue.sheetId ?? "";
    const sourceRow = issue.row ?? 0;
    const cells = cellsForRow(sheetId, sourceRow);
    const source = input.weightSources.find((s) => s.sheetId === sheetId);
    const valueRow = sourceRow > 0 ? source?.values[sourceRow - 1] ?? [] : [];
    const columnIndex = (cellRef?: string) => { if (!cellRef) return -1; const match = cellRef.match(/^[A-Z]+/); if (!match) return -1; return match[0].split("").reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1; };
    const numericAt = (cellRef?: string) => { const index = columnIndex(cellRef); if (index < 0) return undefined; const raw = valueRow[index]; if (raw === "" || raw === null || raw === undefined) return undefined; const parsed = Number(raw); return Number.isFinite(parsed) ? parsed : undefined; };
    const minVal = numericAt(cells.fishMinKg);
    const maxVal = numericAt(cells.fishMaxKg);
    const cell = issue.code.includes("ID_") ? cells.machineId
      : issue.code.includes("ROW_INVALID") ? (minVal === undefined ? cells.fishMinKg : maxVal === undefined ? cells.fishMaxKg : `${cells.fishMinKg}:${cells.fishMaxKg}`)
      : cells.machineId ?? `A${sourceRow}`;
    issues.push({ code: issue.code, severity: issue.level === "error" ? "ERROR" : "WARNING", message: issue.message, sourceCell: { sheetId, cell: cell ?? `A${sourceRow}` } });
  }
  for (const template of input.canonicalRuleDraft.templates) {
    const sourceRow = template.sourceRow ?? 0;
    const sheetId = template.sourceSheetId ?? "weight-template";
    const cells = cellsForRow(sheetId, sourceRow);
    const sourceCell = { sheetId, cell: cells.machineId ?? `A${sourceRow}` };
    if (!template.id.startsWith("wtpl_")) { issues.push({ code: "WEIGHT_TEMPLATE_STABLE_ID_PREFIX_INVALID", severity: "ERROR", message: `重量模板机器ID必须以 wtpl_ 开头：${template.id}。`, sourceCell }); continue; }
    if (seen.has(template.id)) { issues.push({ code: "WEIGHT_TEMPLATE_STABLE_ID_DUPLICATE", severity: "ERROR", message: `重量模板机器ID重复：${template.id}。`, sourceCell }); continue; }
    seen.add(template.id);
    if (!Number.isFinite(template.fishMinKg) || !Number.isFinite(template.fishMaxKg) || !Number.isFinite(template.nominalFishKg) || template.fishMinKg >= template.fishMaxKg || template.nominalFishKg < template.fishMinKg || template.nominalFishKg > template.fishMaxKg) { issues.push({ code: "WEIGHT_TEMPLATE_RANGE_INVALID", severity: "ERROR", message: `重量模板 ${template.id} 的重量范围无效。`, sourceCell: { sheetId, cell: cells.fishMinKg && cells.fishMaxKg ? `${cells.fishMinKg}:${cells.fishMaxKg}` : cells.fishMinKg ?? `A${sourceRow}` } }); continue; }
    templates.push({ ...template, source: { sheetId, rowKey: String(sourceRow), cells } });
  }
  if (!templates.length && !issues.length) issues.push({ code: "WEIGHT_TEMPLATE_EMPTY", severity: "ERROR", message: "01_重量模板没有可导入模板，已拒绝空覆盖。" });
  const representativeSheetId = templates[0]?.source.sheetId ?? "weight-template";
  const content = { sourceRevisionId: input.sourceRevision.id, sourceRevision: input.sourceRevision.sourceRevision, sheetId: representativeSheetId, templates, issues, formalStatus: issues.some((issue) => issue.severity === "ERROR") ? "NON_FORMAL" as const : "READY_TO_PUBLISH" as const, importedAt: input.importedAt };
  const inputHash = deterministicHash(content);
  return { id: `weight-template-draft:${inputHash}`, ...content, inputHash };
}

export function qualityDraftFromRanges(input: {
  sourceRevision: CanonicalWorkbookSourceRevision;
  qualityValues: unknown[][];
  /** A1 range returned with qualityValues; retained for direct legacy callers. */
  qualityRange?: string;
  affixValues: unknown[][];
  /** WQ8w 28fQhg: combination matrix (split from old merged quality sheet) */
  matrixValues?: unknown[][];
  pricingEndpointValues: unknown[][];
  importedAt: string;
}): QualityValuePolicyDraft {
  const rangeStart = /^([A-Z]+)(\d+):/i.exec(input.qualityRange ?? "B4:N50");
  const rangeStartColumn = rangeStart?.[1]
    ? [...rangeStart[1].toUpperCase()].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1
    : 1;
  const rangeStartRow = rangeStart?.[2] ? Number(rangeStart[2]) : 4;
  const sourceRow = (index: number) => rangeStartRow + index;
  const sourceColumn = (index: number) => spreadsheetColumnName(rangeStartColumn + index);
  const sourceCell = (rowIndex: number, columnIndex: number) => ({ sheetId: QUALITY_SHEET_ID, cell: `${sourceColumn(columnIndex)}${sourceRow(rowIndex)}`, rowKey: String(sourceRow(rowIndex)) });
  const sourceIssues: QualityValuePolicyDraft["issues"] = [];
  const structureIssue = (code: string, message: string, rowIndex: number, columnIndex: number, itemPartId?: string) => sourceIssues.push({
    source: "quality", code, severity: "ERROR", gate: "PUBLISH", message,
    sourceRevision: input.sourceRevision.sourceRevision, sourceCell: sourceCell(rowIndex, columnIndex), itemPartId,
    relatedObjectIds: [],
    actions: [
      { action: "navigate", label: "查看规则源", targetRoute: "/?page=rule-workbook", enabled: true, requiredCapabilities: ["feishu.workbook.read"] },
      { action: "retry", label: "修复后重新拉取", targetRoute: "/?page=rule-workbook", enabled: true, requiredCapabilities: ["feishu.workbook.pull"] },
    ],
  });

  // Only the explicit 品质区间 table is authoritative.  Do not scan the rest
  // of a workbook for isolated C/B/A/S values that happen to look like scores.
  const qualityFieldLabels = ["品质", "代码", "≥最小评分", "<最大评分", "最小价格系数", "最大价格系数"] as const;
  const qualityTableHeaders = input.qualityValues.flatMap((row, rowIndex) => row.flatMap((value, columnIndex) => text(value) === "品质区间" ? [{ rowIndex, columnIndex }] : []));
  // WQ8w 27hboC: simple table format — row 0 = headers, rows 1-4 = C/B/A/S data, no "品质区间" marker.
  const wq8wHeaderRow = qualityTableHeaders.length === 0 ? input.qualityValues.findIndex((row) => {
    return qualityFieldLabels.every((label) => row.some((value) => text(value) === label));
  }) : -1;
  const hasWq8wQuality = wq8wHeaderRow >= 0;
  const wq8wFieldIndices = hasWq8wQuality ? qualityFieldLabels.map((label) => input.qualityValues[wq8wHeaderRow].findIndex((value) => text(value) === label)) : [];
  if (hasWq8wQuality) {
    const missing = qualityFieldLabels.filter((_label, index) => wq8wFieldIndices[index] === -1);
    if (missing.length) structureIssue("QUALITY_RANGE_TABLE_HEADER_MISSING", `07_品质评分表头缺少字段：${missing.join("、")}。`, wq8wHeaderRow, 0);
  }
  if (qualityTableHeaders.length !== 1 && !hasWq8wQuality) structureIssue(
    qualityTableHeaders.length ? "QUALITY_RANGE_TABLE_DUPLICATE" : "QUALITY_RANGE_TABLE_MISSING",
    '07_品质评分必须且只能有一个精确的”品质区间”表头。',
    qualityTableHeaders[0]?.rowIndex ?? 0, qualityTableHeaders[0]?.columnIndex ?? 0,
  );
  const qualityTable = qualityTableHeaders[0];
  // WQ8w 27hboC: simple format with header at row 0 + data at rows 1-4
  const qualityFieldHeaders = hasWq8wQuality
    ? [{ rowIndex: wq8wHeaderRow, indices: wq8wFieldIndices }]
    : (qualityTable ? input.qualityValues
      .slice(qualityTable.rowIndex + 1)
      .flatMap((row, offset) => {
        const matches = qualityFieldLabels.map((label) => row.flatMap((value, index) => text(value) === label ? [index] : []));
        const indices = matches.map(([index]) => index ?? -1);
        return matches.every((fieldMatches) => fieldMatches.length === 1)
          ? [{ rowIndex: qualityTable.rowIndex + 1 + offset, indices }] : [];
      }) : []);
  if (!hasWq8wQuality && qualityTable && qualityFieldHeaders.length !== 1) structureIssue(
    qualityFieldHeaders.length ? "QUALITY_RANGE_TABLE_HEADER_DUPLICATE" : "QUALITY_RANGE_TABLE_HEADER_MISSING",
    "品质区间必须在 marker 后且只能有一个包含全部定价字段的字段表头。",
    qualityFieldHeaders[0]?.rowIndex ?? qualityTable.rowIndex, qualityTable.columnIndex,
  );
  const qualityFieldHeader = qualityFieldHeaders[0];
  const expectedQualityRows = [["C/绿", "C"], ["B/蓝", "B"], ["A/紫", "A"], ["S/橙", "S"]] as const;
  const descriptorRows: QualityTableDescriptor["rows"] = [];
  const ranges: QualityValueRange[] = (qualityTable || hasWq8wQuality) && qualityFieldHeader ? expectedQualityRows.flatMap(([label, code], offset) => {
    const rowIndex = qualityFieldHeader.rowIndex + 1 + offset;
    const row = input.qualityValues[rowIndex] ?? [];
    const [labelIndex, codeIndex, minIndex, maxIndex, minFactorIndex, maxFactorIndex] = qualityFieldHeader.indices;
    if (text(row[labelIndex]) !== label || text(row[codeIndex]) !== code) {
      structureIssue("QUALITY_RANGE_TABLE_ROW_INVALID", `品质区间必须按规范行保留 ${label} / ${code}。`, rowIndex, labelIndex);
      return [];
    }
    const minScore = Number(row[minIndex]);
    const maxScore = Number(row[maxIndex]);
    const minFactor = Number(row[minFactorIndex]); const maxFactor = Number(row[maxFactorIndex]);
    if (!Number.isFinite(minScore) || !Number.isFinite(maxScore) || !Number.isFinite(minFactor) || !Number.isFinite(maxFactor)) {
      structureIssue("QUALITY_RANGE_TABLE_ENDPOINT_INVALID", `${label} 缺少两个有限评分端点。`, rowIndex, codeIndex);
      return [];
    }
    const mappingSource = sourceCell(rowIndex, codeIndex); const factorSource = { sheetId: QUALITY_SHEET_ID, cell: `${sourceColumn(minFactorIndex)}${sourceRow(rowIndex)}:${sourceColumn(maxFactorIndex)}${sourceRow(rowIndex)}`, rowKey: String(sourceRow(rowIndex)) };
    descriptorRows.push({ qualityId: qualityIds[code]!, code, minScore, maxScore, minFactor, maxFactor, mappingSource, factorSource });
    return [{ qualityId: qualityIds[code]!, minScore, maxScore, maxInclusive: false, status: "SOURCE" as const,
      source: { sheetId: QUALITY_SHEET_ID, cell: `${sourceColumn(minIndex)}${sourceRow(rowIndex)}:${sourceColumn(maxIndex)}${sourceRow(rowIndex)}`, rowKey: String(sourceRow(rowIndex)) },
    }];
  }) : [];
  const aliases: AffixAliasBinding[] = input.affixValues.slice(1).flatMap((row, index) => {
    const affixId = text(row[0]);
    const itemPartId = partIds[text(row[2])];
    const alias = text(row[4]);
    if (!affixId || !itemPartId || !alias) return [];
    const sheetRow = index + 3;
    return [
      { itemPartId, alias, affixId, source: { sheetId: "23CsXE", cell: `F${sheetRow}`, rowKey: String(sheetRow) } },
      { itemPartId, alias: affixId, affixId, source: { sheetId: "23CsXE", cell: `B${sheetRow}`, rowKey: String(sheetRow) } },
    ];
  });
  const matrixCells: QualityCombinationSourceCell[] = [];
  const matrixSource = input.matrixValues ?? input.qualityValues;
  const matrixPartByHeader = new Map([["竿词条", "part:rod"], ["轮词条", "part:reel"], ["线词条", "part:line"]]);
  const blocks = matrixSource.flatMap((row, rowIndex) => row.flatMap((value, columnIndex) => {
    const itemPartId = matrixPartByHeader.get(text(value));
    return itemPartId ? [{ rowIndex, columnIndex, itemPartId }] : [];
  }));
  // WQ8w 28fQhg: flat table (词条1,词条2,组合评分) — no per-part block headers.
  const matrixHeader = matrixSource[0] ?? [];
  const isWq8wFlatMatrix = blocks.length === 0
    && text(matrixHeader[0]) === "词条1"
    && text(matrixHeader[1]) === "词条2"
    && text(matrixHeader[2]) === "组合评分";
  if (isWq8wFlatMatrix) {
    // Build affixId→alias and alias→part maps
    const affixIdToAlias = new Map<string, string>();
    const aliasToPart = new Map<string, string>();
    for (let ai = 1; ai < input.affixValues.length; ai += 1) {
      const fid = text(input.affixValues[ai]?.[0]); const al = text(input.affixValues[ai]?.[4]);
      const pt = partIds[text(input.affixValues[ai]?.[2])] ?? "";
      if (fid && al) {
        affixIdToAlias.set(fid, al);
        if (pt) {
          aliasToPart.set(al, pt);
          aliasToPart.set(fid, pt);
        }
      }
    }
    for (let rowIndex = 1; rowIndex < matrixSource.length; rowIndex += 1) {
      const row = matrixSource[rowIndex] ?? [];
      const left = text(row[0]); const right = text(row[1]); const score = Number(row[2]);
      if (!left || !right || !Number.isFinite(score)) continue;
      const src = { sheetId: "28fQhg", cell: `A${rowIndex + 1}:C${rowIndex + 1}`, rowKey: String(rowIndex + 1) };
      const la = affixIdToAlias.get(left) ?? left;
      const ra = affixIdToAlias.get(right) ?? right;
      const leftAffixId = affixIdToAlias.has(left) ? left : undefined;
      const rightAffixId = affixIdToAlias.has(right) ? right : undefined;
      const lp = leftAffixId ? (leftAffixId.startsWith("affix_rod_") ? "part:rod" : leftAffixId.startsWith("affix_reel_") ? "part:reel" : leftAffixId.startsWith("affix_line_") ? "part:line" : undefined) : aliasToPart.get(la);
      const rp = rightAffixId ? (rightAffixId.startsWith("affix_rod_") ? "part:rod" : rightAffixId.startsWith("affix_reel_") ? "part:reel" : rightAffixId.startsWith("affix_line_") ? "part:line" : undefined) : aliasToPart.get(ra);
      if (lp && rp && lp !== rp) {
        structureIssue("QUALITY_COMBINATION_CROSS_PART", `组合矩阵词条跨部位：${left} × ${right}。`, rowIndex, 0, lp);
        continue;
      }
      const part = (lp ?? rp ?? "part:rod") as QualityCombinationSourceCell["itemPartId"];
      matrixCells.push({ itemPartId: part, leftAlias: leftAffixId ?? la, rightAlias: rightAffixId ?? ra, value: score, source: src } as QualityCombinationSourceCell);
    }
    // WQ8w flat matrix: verify all three parts have coverage
    const coveredParts = new Set(matrixCells.map((c) => c.itemPartId));
    const allParts = ["part:rod", "part:reel", "part:line"] as const;
    for (const p of allParts) {
      if (!coveredParts.has(p)) structureIssue("QUALITY_MATRIX_BLOCK_MISSING", `组合矩阵块"${p}"未在 WQ8w 平表中找到任何词条。`, 0, 0, p);
    }
  } else {
  for (const [heading, itemPartId] of matrixPartByHeader) {
    const matches = blocks.filter((block) => block.itemPartId === itemPartId);
    if (matches.length !== 1) structureIssue(matches.length ? "QUALITY_MATRIX_BLOCK_DUPLICATE" : "QUALITY_MATRIX_BLOCK_MISSING", `组合矩阵块"${heading}"必须且只能出现一次。`, matches[0]?.rowIndex ?? 0, matches[0]?.columnIndex ?? 0, itemPartId);
  }
  for (const [blockIndex, block] of blocks.entries()) {
    const header = matrixSource[block.rowIndex] ?? [];
    const aliases = header.flatMap((value, columnIndex) => (
      columnIndex > block.columnIndex && text(value)
        ? [{ alias: text(value), columnIndex }]
        : []
    ));
    const aliasSet = new Set(aliases.map((entry) => entry.alias));
    if (!aliases.length) structureIssue("QUALITY_MATRIX_HEADER_INVALID", "组合矩阵块缺少右侧缩写表头。", block.rowIndex, block.columnIndex, block.itemPartId);
    const endRowIndex = blocks[blockIndex + 1]?.rowIndex ?? matrixSource.length;
    for (let rowIndex = block.rowIndex + 1; rowIndex < endRowIndex; rowIndex += 1) {
      const row = matrixSource[rowIndex] ?? [];
      const leftAlias = text(row[block.columnIndex]);
      if (!leftAlias) break;
      if (!aliasSet.has(leftAlias)) {
        structureIssue("QUALITY_MATRIX_ROW_INVALID", `组合矩阵行缩写 ${leftAlias} 不属于该块的显式表头集合。`, rowIndex, block.columnIndex, block.itemPartId);
        break;
      }
      for (const { alias: rightAlias, columnIndex } of aliases) {
        const raw = row[columnIndex];
        const value = raw === null || raw === undefined || text(raw) === ""
          ? ""
          : text(raw) === "—" ? "—" : Number(raw);
        if (typeof value === "number" && !Number.isFinite(value)) continue;
        matrixCells.push({
          itemPartId: block.itemPartId,
          leftAlias,
          rightAlias,
          value,
          source: { sheetId: QUALITY_SHEET_ID, cell: `${sourceColumn(columnIndex)}${sourceRow(rowIndex)}`, rowKey: String(sourceRow(rowIndex)) },
        });
      }
    }
  }
  }
  // WQ8w 33IGHy: quality-scoped pricing — scoring endpoints handled per-quality at pricing layer.
  const pricingScoreEndpoints: Array<{ value: number; status: "SOURCE"; source: { sheetId: string; cell: string; rowKey: string } }> = [];
  return importQualityValuePolicyDraft({
    sourceRevisionId: input.sourceRevision.id,
    sourceRevision: input.sourceRevision.sourceRevision,
    ranges,
    aliases,
    matrixCells,
    qualityTableDescriptor: qualityFieldHeader ? { headerSource: sourceCell(qualityFieldHeader.rowIndex, qualityFieldHeader.indices[0] ?? 0), columns: Object.fromEntries(qualityFieldLabels.map((label, index) => [label, qualityFieldHeader.indices[index]!])) as QualityTableDescriptor["columns"], rows: descriptorRows } : undefined,
    sourceIssues,
    pricingScoreEndpoints,
    performanceScoringEnabled: undefined,
    performanceScoringSource: { sheetId: "27hboC", cell: "B2", rowKey: "2" },
    importedAt: input.importedAt,
  });
}

export interface CanonicalWorkbookSourceRevision {
  id: string;
  workbookRefId: string;
  sourceRevision: string;
  sheets: RemoteFeishuSheet[];
  issues: FeishuSheetRegistryIssue[];
}

export interface CanonicalWorkbookRangeValue {
  revision: string;
  range: string;
  values: unknown[][];
}

export interface CanonicalWorkbookRange {
  sheetId: string;
  range: string;
  valueRange: CanonicalWorkbookRangeValue;
}

export interface CanonicalRuleWorkbookParsedInspection {
  observedAt: string;
  sourceRevision: CanonicalWorkbookSourceRevision;
  identityRows: SourceIdentityRow[];
  identityReport: SourceIdentityMigrationReport;
  pricingDraft: PricingPolicyDraft;
  qualityDraft: QualityValuePolicyDraft;
  canonicalRuleDraft: CanonicalRuleSourceDraft;
  weightTemplateDraft: WeightTemplatePolicyDraft;
  pricingWeightBandPolicy: "MATCHED_STRUCTURAL_SOURCE_BAND";
  seriesDefinitions: SeriesDefinition[];
  seriesParseIssues: SeriesParseIssue[];
}

/**
 * #141 Series 富字段解析（2026-07-25 实测 25UnTC A→W 22 列后新增）。
 *
 * 25UnTC（07_系列）含完整 SeriesDefinition 富字段（实测：竿/轮/线各 8 = 24 SeriesArchetype）。
 * 列映射 A→W（机器ID/实体类型/钓具类型/系列/.../目标拉力/签名轴/状态）见 SERIES_COL。
 * 类型转换 fail-closed：错格式 push issue 跳行，不崩。part 由 C 钓具类型映射（竿/轮/线）。
 */
export interface SeriesParseIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  sheetId: string;
  row: number;
}

const SERIES_SHEET_ID = "25UnTC";
const SERIES_COL = {
  id: 0, entityType: 1, tackleType: 2, name: 3,
  concept: 7, fishingMethodId: 8, typeId: 9, qualityId: 10,
  collectionId: 11, coreFunctionId: 12, intensityMode: 13, intensityValue: 14,
  coreAffixIds: 15, secondaryAffixPoolIds: 16, forbiddenAffixIds: 17,
  planningMinKgf: 18, planningMaxKgf: 19, targetPulls: 20, signature: 21, status: 22,
} as const;
const SERIES_PART_MAP: Record<string, string> = { 竿: "part:rod", 轮: "part:reel", 线: "part:line" };
const SERIES_STATUS_MAP: Record<string, SeriesDefinition["status"]> = {
  draft: "draft", approved: "approved", published: "published", superseded: "superseded",
};

export function parseSeries(input: {
  sourceRevision: CanonicalWorkbookSourceRevision;
  seriesValues: unknown[][];
  importedAt: string;
}): { series: SeriesDefinition[]; issues: SeriesParseIssue[] } {
  const issues: SeriesParseIssue[] = [];
  const series: SeriesDefinition[] = [];
  const rows = input.seriesValues;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const sourceRow = index + 1;
    const id = text(row[SERIES_COL.id]);
    if (/ID（勿改）|ID（永久）|机器ID/.test(id)) continue; // 表头
    if (!id) continue; // 空行
    const entityType = text(row[SERIES_COL.entityType]);
    if (entityType && entityType !== "SeriesArchetype") continue; // 非 Series 行
    const tackleType = text(row[SERIES_COL.tackleType]);
    const itemPartId = SERIES_PART_MAP[tackleType];
    if (!itemPartId) {
      issues.push({ level: "error", code: "SERIES_PART_INVALID", message: `Series ${id} 钓具类型无效：${tackleType || "(空)"}（期望 竿/轮/线）。`, sheetId: SERIES_SHEET_ID, row: sourceRow });
      continue;
    }
    const mode = text(row[SERIES_COL.intensityMode]);
    const intensityRaw = text(row[SERIES_COL.intensityValue]);
    if (mode !== "fixed") {
      issues.push({ level: "warning", code: "SERIES_INTENSITY_MODE_UNSUPPORTED", message: `Series ${id} 功能强度模式 ${mode || "(空)"} 暂不支持（只支持 fixed）。`, sheetId: SERIES_SHEET_ID, row: sourceRow });
      continue;
    }
    const intensity = Number(intensityRaw);
    if (!Number.isFinite(intensity)) {
      issues.push({ level: "error", code: "SERIES_INTENSITY_PARSE", message: `Series ${id} 功能强度值非有限数：${intensityRaw}。`, sheetId: SERIES_SHEET_ID, row: sourceRow });
      continue;
    }
    const minKgf = Number(text(row[SERIES_COL.planningMinKgf]));
    const maxKgf = Number(text(row[SERIES_COL.planningMaxKgf]));
    const planningPullRange = Number.isFinite(minKgf) && Number.isFinite(maxKgf) && minKgf < maxKgf
      ? { minKgf, maxKgf } : undefined;
    if (!planningPullRange) {
      issues.push({ level: "warning", code: "SERIES_NUMBER_PARSE", message: `Series ${id} 计划拉力区间无效（min=${text(row[SERIES_COL.planningMinKgf])}, max=${text(row[SERIES_COL.planningMaxKgf])}），置空。`, sheetId: SERIES_SHEET_ID, row: sourceRow });
    }
    const targetPullSpecifications = parseSeriesTargetPulls(text(row[SERIES_COL.targetPulls]), id, sourceRow, issues);
    const signature = parseSeriesSignature(text(row[SERIES_COL.signature]), id, sourceRow, issues);
    const splitList = (raw: string): string[] => raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const statusRaw = text(row[SERIES_COL.status]).toLowerCase();
    series.push({
      id,
      collectionId: text(row[SERIES_COL.collectionId]) || undefined,
      revision: 1,
      name: text(row[SERIES_COL.name]) || id,
      concept: text(row[SERIES_COL.concept]),
      fishingMethodId: text(row[SERIES_COL.fishingMethodId]),
      typeId: text(row[SERIES_COL.typeId]),
      itemPartId,
      qualityId: (text(row[SERIES_COL.qualityId]) || "quality_c_green") as SeriesDefinition["qualityId"],
      coreFunctionId: text(row[SERIES_COL.coreFunctionId]),
      functionIntensityPolicy: { mode: "fixed", intensity: Math.round(intensity) as 1 | 2 | 3 },
      coreAffixIds: splitList(text(row[SERIES_COL.coreAffixIds])),
      secondaryAffixPoolIds: splitList(text(row[SERIES_COL.secondaryAffixPoolIds])),
      forbiddenAffixIds: splitList(text(row[SERIES_COL.forbiddenAffixIds])),
      ...(planningPullRange ? { planningPullRange } : {}),
      targetPullSpecifications,
      signature,
      patchIds: [],
      skuIds: targetPullSpecifications.map((spec) => spec.skuId),
      status: SERIES_STATUS_MAP[statusRaw] ?? "draft",
      createdAt: input.importedAt,
      updatedAt: input.importedAt,
    });
  }
  return { series, issues };
}

function parseSeriesTargetPulls(raw: string, id: string, sourceRow: number, issues: SeriesParseIssue[]): SeriesDefinition["targetPullSpecifications"] {
  if (!raw) return [];
  const specs: Array<{ targetPullKgf: number; skuId: string }> = [];
  for (const pair of raw.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) {
      issues.push({ level: "warning", code: "SERIES_TARGET_PULL_PARSE", message: `Series ${id} 目标拉力规格对无冒号：${trimmed}，跳过。`, sheetId: SERIES_SHEET_ID, row: sourceRow });
      continue;
    }
    const pullKgf = Number(trimmed.slice(0, colonIdx));
    const skuId = trimmed.slice(colonIdx + 1).trim();
    if (!Number.isFinite(pullKgf) || !skuId) {
      issues.push({ level: "warning", code: "SERIES_TARGET_PULL_PARSE", message: `Series ${id} 目标拉力规格对无效：${trimmed}，跳过。`, sheetId: SERIES_SHEET_ID, row: sourceRow });
      continue;
    }
    specs.push({ targetPullKgf: pullKgf, skuId });
  }
  return specs;
}

function parseSeriesSignature(raw: string, id: string, sourceRow: number, issues: SeriesParseIssue[]): SeriesDefinition["signature"] {
  if (!raw) return [];
  const axes: SeriesSignatureAxis[] = [];
  for (const seg of raw.split(";")) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(":");
    if (parts.length !== 4) {
      issues.push({ level: "warning", code: "SERIES_SIGNATURE_PARSE", message: `Series ${id} 签名轴格式无效（期望 group:dir:imp:tol）：${trimmed}，跳过。`, sheetId: SERIES_SHEET_ID, row: sourceRow });
      continue;
    }
    const [parameterGroup, expectedDirection, importanceRaw, toleranceRaw] = parts as [string, string, string, string];
    const importance = Number(importanceRaw);
    const tolerance = Number(toleranceRaw);
    if (!["positive", "negative", "neutral", "contextual"].includes(expectedDirection) || !Number.isFinite(importance) || !Number.isFinite(tolerance)) {
      issues.push({ level: "warning", code: "SERIES_SIGNATURE_PARSE", message: `Series ${id} 签名轴字段无效：${trimmed}，跳过。`, sheetId: SERIES_SHEET_ID, row: sourceRow });
      continue;
    }
    axes.push({ parameterGroup, expectedDirection: expectedDirection as SeriesSignatureAxis["expectedDirection"], importance, tolerance });
  }
  return axes;
}

export async function inspectCanonicalRuleWorkbookValues(input: {
  observedAt: string;
  sourceRevision: CanonicalWorkbookSourceRevision;
  ranges: CanonicalWorkbookRange[];
}): Promise<CanonicalRuleWorkbookParsedInspection> {
  const { observedAt, sourceRevision, ranges } = input;
  const identityRows = identityRowsFromRanges(ranges);
  const identityReport = prepareSourceIdentityMigration({
    workbookRefId: sourceRevision.workbookRefId,
    sourceRevision: sourceRevision.sourceRevision,
    mode: "CONTINUOUS_SYNC",
    rows: identityRows,
    existingEntities: [],
    identityPolicies: canonicalIdentityPolicies(),
    generatedAt: observedAt,
  });
  const qualitySheetRange = canonicalQualitySheetRange(sourceRevision);
  const qualityRange = ranges.find((entry) => entry.sheetId === QUALITY_SHEET_ID && entry.range === qualitySheetRange);
  const affixRange = ranges.find((entry) => entry.sheetId === AFFIX_SHEET_ID && entry.range === canonicalAffixSheetRanges(sourceRevision).aliasRange);
  // PR2b-3 收尾：pricing 执行语义从 32BmZs（参数释义）读取，维修/零整比从 33IGHy 读取。
  // 31RxeB 只保留公式文本（businessFormulaCells），不再作为结构化机器键来源。
  const pricingEndpointRange = ranges.find((entry) => entry.sheetId === "33IGHy");
  const pricingRange = ranges.find((entry) => entry.sheetId === "31RxeB");
  const pricingParamsRange = ranges.find((entry) => entry.sheetId === "32BmZs");
  const typeValues = ["10TyFp", "11CfXW", "12VetE"].flatMap((sheetId) => ranges.find((entry) => entry.sheetId === sheetId)?.valueRange.values ?? []);
  const matrixRange = ranges.find((entry) => entry.sheetId === "28fQhg");
  const qualityDraft = qualityDraftFromRanges({
    sourceRevision,
    qualityValues: qualityRange?.valueRange.values ?? [],
    qualityRange: qualityRange?.range ?? qualitySheetRange,
    affixValues: affixRange?.valueRange.values ?? [],
    matrixValues: matrixRange?.valueRange.values ?? [],
    pricingEndpointValues: pricingEndpointRange?.valueRange.values ?? [],
    importedAt: observedAt,
  });
  const pricingQualityRows = pricingQualitySourceRowsFromDraft(qualityDraft);
  const pricingDraft = pricingDraftFromRanges({
    sourceRevision,
    qualityValues: [], qualitySourceRows: pricingQualityRows,
    pricingValues: pricingRange?.valueRange.values ?? [],
    pricingParamsValues: pricingParamsRange?.valueRange.values ?? [],
    pricingEndpointValues: pricingEndpointRange?.valueRange.values ?? [],
    typeValues, importedAt: observedAt,
  });
  const findRangeValues = (sheetId: string, rangePrefix: string) => ranges.find((entry) => entry.sheetId === sheetId && entry.range.startsWith(rangePrefix))?.valueRange.values ?? [];
  const partedSources = (group: "weight" | "type" | "function" | "method" | "methodTemplateReview") => CANONICAL_ITEM_PARTS.map((part) => ({ part, sheetId: CANONICAL_RULE_RANGES[group][part], values: findRangeValues(CANONICAL_RULE_RANGES[group][part], "A1:") }));
  const canonicalRuleDraft = importCanonicalRuleSource({
    sourceRevision,
    weightSources: partedSources("weight"),
    typeSources: partedSources("type"),
    functionSources: partedSources("function"),
    functionProfileValues: findRangeValues(CANONICAL_RULE_RANGES.functionProfiles, "A1:S"),
    methodSources: partedSources("method"),
    methodTemplateReviewSources: partedSources("methodTemplateReview"),
    importedAt: observedAt,
  });
  const weightTemplateDraft = weightTemplateDraftFromCanonicalRuleDraft({ sourceRevision, canonicalRuleDraft, weightSources: partedSources("weight"), importedAt: observedAt });
  const seriesParse = parseSeries({ sourceRevision, seriesValues: findRangeValues(SERIES_SHEET_ID, "A1:W"), importedAt: observedAt });
  return {
    observedAt,
    sourceRevision,
    identityRows,
    identityReport,
    pricingDraft,
    qualityDraft,
    canonicalRuleDraft,
    weightTemplateDraft,
    pricingWeightBandPolicy: "MATCHED_STRUCTURAL_SOURCE_BAND",
    seriesDefinitions: seriesParse.series,
    seriesParseIssues: seriesParse.issues,
  };
}
