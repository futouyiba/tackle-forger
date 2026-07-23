import {
  CANONICAL_FEISHU_SHEET_REGISTRY,
  CANONICAL_FEISHU_WORKBOOK,
  pullFeishuWorkbookRevision,
  type FeishuSourceRevision,
} from "./feishu-workbook";
import {
  createFeishuWorkbookPullAdapter,
  readFeishuSheetRanges,
  type FeishuValueRange,
} from "./feishu-sheets";
import {
  importPricingPolicyDraft,
  type PricingPolicyDraft,
  type PricingLookupEntry,
  type QualityPriceFactorRange,
  type QualityPricingBasketMapping,
} from "./pricing-policy";
import {
  importQualityValuePolicyDraft,
  type AffixAliasBinding,
  type QualityCombinationSourceCell,
  type QualityValuePolicyDraft,
  type QualityValueRange,
} from "./quality-value-policy";
import {
  prepareSourceIdentityMigration,
  type SourceIdentityMigrationReport,
  type SourceIdentityPolicy,
  type SourceIdentityRow,
} from "./source-id-migration";
import {
  CANONICAL_RULE_RANGES,
  importCanonicalRuleSource,
} from "./canonical-rule-source";
import type { CanonicalRuleSourceDraft, WeightTemplatePolicyDraft } from "./types";
import { deterministicHash } from "./rule-kernel";

export interface IdentitySheetSpec {
  sheetId: string;
  range: string;
  idColumnKey: string;
  fixedEntityType?: string;
  allowedEntityTypes: string[];
  idPrefixesByEntityType: Record<string, string[]>;
}

export const CANONICAL_IDENTITY_SHEET_SPECS: IdentitySheetSpec[] = [
  { sheetId: "mLpTLK", range: "A1:S8", idColumnKey: "A", fixedEntityType: "FunctionProfile", allowedEntityTypes: ["FunctionProfile"], idPrefixesByEntityType: { FunctionProfile: ["function:"] } },
  { sheetId: "d6e928", range: "B1:C54", idColumnKey: "B", fixedEntityType: "WeightTemplate", allowedEntityTypes: ["WeightTemplate"], idPrefixesByEntityType: { WeightTemplate: ["wtpl_"] } },
  { sheetId: "fATowU", range: "B1:C20", idColumnKey: "B", allowedEntityTypes: ["RodType", "ReelType", "LineType"], idPrefixesByEntityType: { RodType: ["type_rod_"], ReelType: ["type_reel_"], LineType: ["type_line_"] } },
  { sheetId: "vviXo0", range: "B1:C63", idColumnKey: "B", fixedEntityType: "FunctionProfile", allowedEntityTypes: ["FunctionProfile"], idPrefixesByEntityType: { FunctionProfile: ["func_"] } },
  { sheetId: "mLpTLK", range: "Q1:S8", idColumnKey: "Q:S", fixedEntityType: "FunctionPartGroup", allowedEntityTypes: ["FunctionPartGroup"], idPrefixesByEntityType: { FunctionPartGroup: ["funcgrp_rod_", "funcgrp_reel_", "funcgrp_line_"] } },
  { sheetId: "zrVOxd", range: "B1:C38", idColumnKey: "B", allowedEntityTypes: ["RodAffix", "ReelAffix", "LineAffix"], idPrefixesByEntityType: { RodAffix: ["affix_rod_"], ReelAffix: ["affix_reel_"], LineAffix: ["affix_line_"] } },
  { sheetId: "9nE3Rx", range: "B1:C10", idColumnKey: "B", fixedEntityType: "SeriesArchetype", allowedEntityTypes: ["SeriesArchetype"], idPrefixesByEntityType: { SeriesArchetype: ["series_rod_", "series_reel_", "series_line_"] } },
];

const AFFIX_SHEET_ID = "zrVOxd";
const WEIGHT_TEMPLATE_SHEET_ID = "d6e928";
/** The header occupies row 2; a smaller grid cannot hold an affix machine row. */
const MINIMUM_AFFIX_MACHINE_ROW_COUNT = 3;

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
export function canonicalAffixSheetRanges(sourceRevision: FeishuSourceRevision): CanonicalAffixSheetRanges {
  const sheet = sourceRevision.sheets.find((candidate) => candidate.sheetId === AFFIX_SHEET_ID);
  const rowCount = sheet?.rowCount;
  const columnCount = sheet?.columnCount;
  if (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < MINIMUM_AFFIX_MACHINE_ROW_COUNT) {
    throw new Error("04_词条/zrVOxd 缺少可验证的 grid rowCount；已停止读取，避免截断词条机器区。");
  }
  if (typeof columnCount !== "number" || !Number.isSafeInteger(columnCount) || columnCount < 6) {
    throw new Error("04_词条/zrVOxd 缺少至少 6 列的可验证 grid 元数据；已停止读取，避免不完整别名导入。");
  }
  return {
    identityRange: `B1:C${rowCount}`,
    aliasRange: `B2:F${rowCount}`,
  };
}

export function canonicalRuleWorkbookRangeRequests(sourceRevision: FeishuSourceRevision) {
  const affixRanges = canonicalAffixSheetRanges(sourceRevision);
  const weightSheet = sourceRevision.sheets.find((sheet) => sheet.sheetId === WEIGHT_TEMPLATE_SHEET_ID);
  if (!Number.isSafeInteger(weightSheet?.rowCount) || !Number.isSafeInteger(weightSheet?.columnCount) || weightSheet!.rowCount! < 4 || weightSheet!.columnCount! < 60) {
    throw new Error("01_重量模板/d6e928 缺少可验证的完整 grid 元数据；已停止读取，避免截断机器 ID 或模板字段。");
  }
  const requests = [
    ...CANONICAL_IDENTITY_SHEET_SPECS.map(({ sheetId, range }) => ({
      sheetId,
      range: sheetId === AFFIX_SHEET_ID ? affixRanges.identityRange : sheetId === WEIGHT_TEMPLATE_SHEET_ID ? `BG1:BH${weightSheet!.rowCount!}` : range,
    })),
    { sheetId: "FqD4j7", range: "B4:N50" },
    { sheetId: AFFIX_SHEET_ID, range: affixRanges.aliasRange },
    { sheetId: "u87sRh", range: "B10:R70" },
    { sheetId: "fATowU", range: "B2:AD20" },
    { sheetId: "u87sRh", range: "B179:E179" },
    { sheetId: WEIGHT_TEMPLATE_SHEET_ID, range: `A1:BH${weightSheet!.rowCount!}` },
    CANONICAL_RULE_RANGES.type,
    CANONICAL_RULE_RANGES.function,
    CANONICAL_RULE_RANGES.functionProfiles,
    CANONICAL_RULE_RANGES.method,
    CANONICAL_RULE_RANGES.methodTemplateReview,
  ];
  return [...new Map(requests.map((request) => [`${request.sheetId}:${request.range}`, request])).values()];
}

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function identityRowsFromRanges(
  ranges: Array<{ sheetId: string; range?: string; valueRange: Pick<FeishuValueRange, "values"> }>,
  specs = CANONICAL_IDENTITY_SHEET_SPECS,
): SourceIdentityRow[] {
  const hasExplicitRanges = ranges.some((entry) => entry.range !== undefined);
  const rangeByIdentitySpec = new Map(ranges.filter((entry) => entry.range).map((entry) => [`${entry.sheetId}:${entry.range}`, entry.valueRange.values]));
  const legacyRangeBySheet = new Map(ranges.map((entry) => [entry.sheetId, entry.valueRange.values]));
  return specs.flatMap((spec) => (
    (spec.sheetId === AFFIX_SHEET_ID && spec.range === "B1:C38"
      ? ranges.find((entry) => entry.sheetId === AFFIX_SHEET_ID && /^B1:C\d+$/.test(entry.range ?? ""))?.valueRange.values
      : spec.sheetId === WEIGHT_TEMPLATE_SHEET_ID
        ? ranges.find((entry) => entry.sheetId === WEIGHT_TEMPLATE_SHEET_ID && /^BG1:BH\d+$/.test(entry.range ?? ""))?.valueRange.values
      : rangeByIdentitySpec.get(`${spec.sheetId}:${spec.range}`))
    ?? (hasExplicitRanges ? [] : legacyRangeBySheet.get(spec.sheetId) ?? [])
  ).flatMap((values, index) => {
    if (spec.fixedEntityType === "FunctionPartGroup") {
      return (values as unknown[]).flatMap((value, columnIndex) => {
        const stableId = text(value);
        // Q:S 的第 1 行是 rod/reel/lineFunctionGroupId 表头；Id 的大小写不应参与身份判断。
        if (!stableId || index === 0) return [];
        const part = ["rod", "reel", "line"][columnIndex];
        return [{ sheetId: spec.sheetId, rowKey: `${index + 1}:${part}`, displayName: `FunctionPartGroup · ${part} · 第 ${index + 1} 行`, entityType: "FunctionPartGroup", stableId, idColumnKey: ["Q", "R", "S"][columnIndex]! }];
      });
    }
    if (spec.sheetId === "mLpTLK" && spec.range === "A1:S8" && index === 0) return [];
    const stableId = text(values[0]);
    const adjacentValue = text(values[1]);
    if (!stableId && !adjacentValue) return [];
    if (/ID（勿改）|ID（永久）|机器ID/.test(stableId) || adjacentValue === "实体类型" || adjacentValue === "同步状态") return [];
    const entityType = spec.fixedEntityType ?? adjacentValue;
    if (!entityType) return [];
    return [{
      sheetId: spec.sheetId,
      rowKey: String(index + 1),
      displayName: `${entityType} · 第 ${index + 1} 行`,
      entityType,
      stableId: stableId || undefined,
      idColumnKey: spec.idColumnKey,
    }];
  }));
}

export function canonicalIdentityPolicies(): SourceIdentityPolicy[] {
  const grouped = new Map<string, SourceIdentityPolicy>();
  for (const spec of CANONICAL_IDENTITY_SHEET_SPECS) {
    const current = grouped.get(spec.sheetId) ?? { sheetId: spec.sheetId, allowedEntityTypes: [], idPrefixesByEntityType: {} };
    current.allowedEntityTypes = [...new Set([...current.allowedEntityTypes, ...spec.allowedEntityTypes])];
    for (const [entityType, prefixes] of Object.entries(spec.idPrefixesByEntityType)) current.idPrefixesByEntityType[entityType] = [...new Set([...(current.idPrefixesByEntityType[entityType] ?? []), ...prefixes])];
    grouped.set(spec.sheetId, current);
  }
  return [...grouped.values()];
}

const qualityIds: Record<string, QualityPricingBasketMapping["qualityId"]> = {
  C: "quality_c_green",
  B: "quality_b_blue",
  A: "quality_a_purple",
  S: "quality_s_orange",
};

const basketIds: Record<string, string> = {
  跑刀: "pricing_basket_fast",
  稳健: "pricing_basket_steady",
  猛攻: "pricing_basket_aggressive",
};

export function pricingDraftFromRanges(input: {
  sourceRevision: FeishuSourceRevision;
  qualityValues: unknown[][];
  pricingValues?: unknown[][];
  typeValues?: unknown[][];
  importedAt: string;
}): PricingPolicyDraft {
  const qualityMappings = input.qualityValues.flatMap((row, index): QualityPricingBasketMapping[] => {
    const code = text(row[1]);
    const basketAlias = text(row[2]);
    const qualityId = qualityIds[code];
    const pricingBasketId = basketIds[basketAlias];
    if (!qualityId || !pricingBasketId) return [];
    const sheetRow = index + 5;
    return [{
      qualityId,
      pricingBasketId,
      sourceAlias: text(row[5]) || code,
      status: "SOURCE",
      source: { sheetId: "FqD4j7", cell: `D${sheetRow}`, rowKey: String(sheetRow) },
    }];
  });
  const pricingBaskets = Array.from(new Map(qualityMappings.map((mapping) => [mapping.pricingBasketId, {
    id: mapping.pricingBasketId,
    sourceAlias: Object.entries(basketIds).find(([, id]) => id === mapping.pricingBasketId)?.[0] ?? mapping.pricingBasketId,
    source: mapping.source,
  }])).values());
  const qualityPriceFactorRanges: QualityPriceFactorRange[] = input.qualityValues.flatMap((row, index) => {
    const qualityId = qualityIds[text(row[1])];
    const minScore = Number(row[3]);
    const maxScore = Number(row[4]);
    const minFactor = Number(row[5]);
    const maxFactor = Number(row[6]);
    if (!qualityId || ![minScore, maxScore, minFactor, maxFactor].every(Number.isFinite)) return [];
    const sheetRow = index + 5;
    return [{ qualityId, minScore, maxScore, maxInclusive: false, minFactor, maxFactor, status: "SOURCE", source: { sheetId: "FqD4j7", cell: `E${sheetRow}:H${sheetRow}`, rowKey: String(sheetRow) } }];
  });
  const pricingValues = input.pricingValues ?? [];
  const maintenanceConsumptionRates: PricingLookupEntry[] = [];
  const partAllocationRatios: PricingLookupEntry[] = [];
  const totalLossTimes: PricingLookupEntry[] = [];
  const partsToWholeRatios: PricingLookupEntry[] = [];
  for (let index = 13; index < pricingValues.length; index += 1) {
    const row = pricingValues[index] ?? [];
    const sheetRow = index + 10;
    const sourceValue = (value: number, cell: string) => ({ value, status: "SOURCE" as const, source: { sheetId: "u87sRh", cell, rowKey: String(sheetRow) } });
    const maintenanceBand = text(row[0]);
    const maintenanceBasket = basketIds[text(row[1])];
    const maintenance = Number(row[2]);
    if (maintenanceBand && maintenanceBasket && Number.isFinite(maintenance)) {
      maintenanceConsumptionRates.push({ pricingWeightBandId: `weight_band:${maintenanceBand}`, pricingBasketId: maintenanceBasket, value: sourceValue(maintenance, `D${sheetRow}`) });
    }
    const allocationBand = text(row[4]);
    for (const [offset, partId] of [[5, "rod"], [6, "reel"], [7, "line"]] as const) {
      const value = Number(row[offset]);
      if (allocationBand && Number.isFinite(value)) {
        const column = String.fromCharCode("B".charCodeAt(0) + offset);
        partAllocationRatios.push({ pricingWeightBandId: `weight_band:${allocationBand}`, partId, value: sourceValue(value, `${column}${sheetRow}`) });
      }
    }
    const lossBand = text(row[9]);
    const lossBasket = basketIds[text(row[10])];
    for (const [offset, partId] of [[11, "rod"], [12, "reel"], [13, "line"]] as const) {
      const value = Number(row[offset]);
      if (lossBand && lossBasket && Number.isFinite(value)) {
        const column = String.fromCharCode("B".charCodeAt(0) + offset);
        totalLossTimes.push({ pricingWeightBandId: `weight_band:${lossBand}`, pricingBasketId: lossBasket, partId, value: sourceValue(value, `${column}${sheetRow}`) });
      }
    }
    for (const [offset, partId] of [[14, "rod"], [15, "reel"], [16, "line"]] as const) {
      const value = Number(row[offset]);
      if (lossBand && lossBasket && Number.isFinite(value)) {
        const column = String.fromCharCode("B".charCodeAt(0) + offset);
        partsToWholeRatios.push({ pricingWeightBandId: `weight_band:${lossBand}`, pricingBasketId: lossBasket, partId, value: sourceValue(value, `${column}${sheetRow}`) });
      }
    }
  }
  const repairCoefficients: PricingLookupEntry[] = [];
  const purchaseCoefficients: PricingLookupEntry[] = [];
  for (let index = 1; index < (input.typeValues ?? []).length; index += 1) {
    const row = input.typeValues?.[index] ?? [];
    const typeId = text(row[0]);
    const entityType = text(row[1]);
    const partId = entityType === "RodType" ? "rod" : entityType === "ReelType" ? "reel" : entityType === "LineType" ? "line" : "";
    if (!typeId || !partId) continue;
    const sheetRow = index + 2;
    const repair = Number(row[19]);
    const purchase = Number(row[20]);
    if (Number.isFinite(repair)) repairCoefficients.push({ partId, typeId, value: { value: repair, status: "SOURCE", source: { sheetId: "fATowU", cell: `U${sheetRow}`, rowKey: String(sheetRow) } } });
    if (Number.isFinite(purchase)) purchaseCoefficients.push({ partId, typeId, value: { value: purchase, status: "SOURCE", source: { sheetId: "fATowU", cell: `V${sheetRow}`, rowKey: String(sheetRow) } } });
  }
  const parameterValue = (sheetRow: number) => pricingValues[sheetRow - 10]?.[2];
  const moneyPolicy = pricingValues.length ? {
    unit: text(parameterValue(15)),
    rounding: "significant_digits_floor" as const,
    precision: 3,
    significantDigits: 3,
    minimumPrice: Number(parameterValue(17)),
    maximumPrice: Number(parameterValue(18)),
    status: "SOURCE" as const,
    source: { sheetId: "u87sRh", cell: "B15:D18", rowKey: "15-18" },
  } : undefined;
  return importPricingPolicyDraft({
    sourceRevisionId: input.sourceRevision.id,
    sourceRevision: input.sourceRevision.sourceRevision,
    pricingSheetId: "u87sRh",
    qualitySheetId: "FqD4j7",
    typeMaterialSheetId: "fATowU",
    businessFormulaCells: [2, 3, 4, 5, 6, 7].map((row) => ({ sheetId: "u87sRh", cell: `B${row}` })),
    pricingBaskets,
    maintenanceConsumptionRates,
    partAllocationRatios,
    repairCoefficients,
    totalLossTimes,
    purchaseCoefficients,
    partsToWholeRatios,
    qualityMappings,
    qualityPriceFactorRanges,
    scoreInterpolation: pricingValues.length ? { kind: "quality_range_linear", points: [], outOfRange: "error", status: "SOURCE", source: { sheetId: "u87sRh", cell: "B11:D11", rowKey: "11" } } : undefined,
    moneyPolicy,
    importedAt: input.importedAt,
  });
}

const partIds: Record<string, string> = { "竿": "part:rod", "轮": "part:reel", "线": "part:line" };

export function weightTemplateDraftCanonicalContent(draft: WeightTemplatePolicyDraft) {
  return { sourceRevisionId: draft.sourceRevisionId, sourceRevision: draft.sourceRevision, sheetId: draft.sheetId, templates: draft.templates, issues: draft.issues, formalStatus: draft.formalStatus, importedAt: draft.importedAt };
}

export function assertCanonicalWeightTemplatePolicyDraft(draft: WeightTemplatePolicyDraft) {
  const inputHash = deterministicHash(weightTemplateDraftCanonicalContent(draft));
  if (draft.inputHash !== inputHash || draft.id !== `weight-template-draft:${inputHash}`) throw new Error("重量模板草稿的冻结内容、inputHash 或 ID 不一致，不能信任或发布。");
}

export function weightTemplateDraftFromCanonicalRuleDraft(input: { sourceRevision: FeishuSourceRevision; canonicalRuleDraft: CanonicalRuleSourceDraft; weightValues?: unknown[][]; importedAt: string }): WeightTemplatePolicyDraft {
  const issues: WeightTemplatePolicyDraft["issues"] = [];
  const templates: WeightTemplatePolicyDraft["templates"] = [];
  const seen = new Set<string>();
  const columnName = (index: number) => {
    let name = "";
    for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) name = String.fromCharCode(65 + (current - 1) % 26) + name;
    return name;
  };
  const headerBlocks = (input.weightValues ?? []).flatMap((row, index) => row.some((value) => text(value).includes("机器ID")) ? [{ row: index + 1, headers: row.map(text) }] : []);
  const blockFor = (sourceRow: number) => [...headerBlocks].reverse().find((block) => block.row < sourceRow);
  const sourceCellsFor = (sourceRow: number) => {
    const block = blockFor(sourceRow);
    const headers = block?.headers ?? [];
    const headerIndex = (...labels: string[]) => headers.findIndex((header) => labels.some((label) => header === label || header.includes(label)));
    const cells: Record<string, string> = {};
    const bind = (key: string, ...labels: string[]) => {
      const index = headerIndex(...labels);
      if (index >= 0) cells[key] = `${columnName(index)}${sourceRow}`;
    };
    bind("machineId", "机器ID");
    bind("fishMinKg", "最小拉力", "鱼重下限kg");
    bind("fishMaxKg", "最大拉力", "鱼重上限kg");
    bind("nominalFishKg", "标称鱼重kg", "标称拉力");
    bind("weightBand", "重量段", "档位");
    // Canonical 01 normally derives its nominal value from min/max; freeze the
    // two actual source cells rather than inventing a nonexistent column.
    if (!cells.nominalFishKg && cells.fishMinKg && cells.fishMaxKg) cells.nominalFishKg = `${cells.fishMinKg}:${cells.fishMaxKg}`;
    const row = sourceRow > 0 ? input.weightValues?.[sourceRow - 1] ?? [] : [];
    headers.forEach((header, index) => {
      if (header && row[index] !== null && row[index] !== undefined && text(row[index]) !== "") cells[header] = `${columnName(index)}${sourceRow}`;
    });
    return cells;
  };
  const issueSourceCell = (issue: CanonicalRuleSourceDraft["issues"][number]) => {
    const cells = sourceCellsFor(issue.row ?? 0);
    const cell = issue.code.includes("ID_") ? cells.machineId
      : issue.code.includes("ROW_INVALID") ? (cells.fishMinKg ?? cells.fishMaxKg)
      : cells.machineId ?? cells.fishMinKg ?? `A${issue.row ?? 1}`;
    return { sheetId: "d6e928" as const, cell };
  };
  for (const issue of input.canonicalRuleDraft.issues) {
    if (issue.sheetId !== WEIGHT_TEMPLATE_SHEET_ID || !issue.code.startsWith("WEIGHT_TEMPLATE_")) continue;
    issues.push({ code: issue.code, severity: issue.level === "error" ? "ERROR" : "WARNING", message: issue.message, sourceCell: issueSourceCell(issue) });
  }
  for (const template of input.canonicalRuleDraft.templates) {
    const sourceRow = template.sourceRow ?? 0;
    const cells = sourceCellsFor(sourceRow);
    const sourceCell = { sheetId: "d6e928" as const, cell: cells.machineId ?? `BG${sourceRow || 1}` };
    if (!template.id.startsWith("wtpl_")) { issues.push({ code: "WEIGHT_TEMPLATE_STABLE_ID_PREFIX_INVALID", severity: "ERROR", message: `重量模板机器ID必须以 wtpl_ 开头：${template.id}。`, sourceCell }); continue; }
    if (seen.has(template.id)) { issues.push({ code: "WEIGHT_TEMPLATE_STABLE_ID_DUPLICATE", severity: "ERROR", message: `重量模板机器ID重复：${template.id}。`, sourceCell }); continue; }
    seen.add(template.id);
    if (!Number.isFinite(template.fishMinKg) || !Number.isFinite(template.fishMaxKg) || !Number.isFinite(template.nominalFishKg) || template.fishMinKg >= template.fishMaxKg || template.nominalFishKg < template.fishMinKg || template.nominalFishKg > template.fishMaxKg) { issues.push({ code: "WEIGHT_TEMPLATE_RANGE_INVALID", severity: "ERROR", message: `重量模板 ${template.id} 的重量范围无效。`, sourceCell }); continue; }
    templates.push({ ...template, source: { sheetId: WEIGHT_TEMPLATE_SHEET_ID, rowKey: String(sourceRow), cells } });
  }
  if (!templates.length && !issues.length) issues.push({ code: "WEIGHT_TEMPLATE_EMPTY", severity: "ERROR", message: "01_重量模板没有可导入模板，已拒绝空覆盖。" });
  const content = { sourceRevisionId: input.sourceRevision.id, sourceRevision: input.sourceRevision.sourceRevision, sheetId: "d6e928" as const, templates, issues, formalStatus: issues.some((issue) => issue.severity === "ERROR") ? "NON_FORMAL" as const : "READY_TO_PUBLISH" as const, importedAt: input.importedAt };
  const inputHash = deterministicHash(content);
  return { id: `weight-template-draft:${inputHash}`, ...content, inputHash };
}

export function qualityDraftFromRanges(input: {
  sourceRevision: FeishuSourceRevision;
  qualityValues: unknown[][];
  affixValues: unknown[][];
  pricingEndpointValues: unknown[][];
  importedAt: string;
}): QualityValuePolicyDraft {
  const ranges: QualityValueRange[] = input.qualityValues.slice(1, 5).flatMap((row, index) => {
    const qualityId = qualityIds[text(row[1])];
    const minScore = Number(row[3]);
    const maxScore = Number(row[4]);
    if (!qualityId || !Number.isFinite(minScore) || !Number.isFinite(maxScore)) return [];
    const sheetRow = index + 5;
    return [{
      qualityId,
      minScore,
      maxScore,
      maxInclusive: false,
      status: "SOURCE",
      source: { sheetId: "FqD4j7", cell: `E${sheetRow}:F${sheetRow}`, rowKey: String(sheetRow) },
    }];
  });
  const aliases: AffixAliasBinding[] = input.affixValues.slice(1).flatMap((row, index) => {
    const affixId = text(row[0]);
    const itemPartId = partIds[text(row[2])];
    const alias = text(row[4]);
    if (!affixId || !itemPartId || !alias) return [];
    const sheetRow = index + 3;
    return [{ itemPartId, alias, affixId, source: { sheetId: "zrVOxd", cell: `F${sheetRow}`, rowKey: String(sheetRow) } }];
  });
  const matrixCells: QualityCombinationSourceCell[] = [];
  for (const section of [
    { headerRow: 10, firstDataRow: 11, lastDataRow: 22, itemPartId: "part:rod" },
    { headerRow: 24, firstDataRow: 25, lastDataRow: 36, itemPartId: "part:reel" },
    { headerRow: 38, firstDataRow: 39, lastDataRow: 50, itemPartId: "part:line" },
  ]) {
    const header = input.qualityValues[section.headerRow - 4] ?? [];
    for (let sheetRow = section.firstDataRow; sheetRow <= section.lastDataRow; sheetRow += 1) {
      const row = input.qualityValues[sheetRow - 4] ?? [];
      const leftAlias = text(row[0]);
      for (let columnOffset = 1; columnOffset <= 12; columnOffset += 1) {
        const rightAlias = text(header[columnOffset]);
        if (!leftAlias || !rightAlias) continue;
        const raw = row[columnOffset];
        const value = raw === null || raw === undefined || text(raw) === ""
          ? ""
          : text(raw) === "—" ? "—" : Number(raw);
        if (typeof value === "number" && !Number.isFinite(value)) continue;
        const column = String.fromCharCode("B".charCodeAt(0) + columnOffset);
        matrixCells.push({
          itemPartId: section.itemPartId,
          leftAlias,
          rightAlias,
          value,
          source: { sheetId: "FqD4j7", cell: `${column}${sheetRow}`, rowKey: String(sheetRow) },
        });
      }
    }
  }
  const pricingScoreEndpoints = input.pricingEndpointValues.flatMap((row) => {
    const value = Number(row[0]);
    return Number.isFinite(value)
      ? [{ value, status: "SOURCE" as const, source: { sheetId: "u87sRh", cell: "B179", rowKey: "179" } }]
      : [];
  });
  return importQualityValuePolicyDraft({
    sourceRevisionId: input.sourceRevision.id,
    sourceRevision: input.sourceRevision.sourceRevision,
    ranges,
    aliases,
    matrixCells,
    pricingScoreEndpoints,
    performanceScoringEnabled: undefined,
    performanceScoringSource: { sheetId: "FqD4j7", cell: "B2", rowKey: "2" },
    importedAt: input.importedAt,
  });
}

export interface CanonicalRuleWorkbookInspection {
  observedAt: string;
  sourceRevision: FeishuSourceRevision;
  identityRows: SourceIdentityRow[];
  identityReport: SourceIdentityMigrationReport;
  pricingDraft: PricingPolicyDraft;
  qualityDraft: QualityValuePolicyDraft;
  canonicalRuleDraft: CanonicalRuleSourceDraft;
  weightTemplateDraft: WeightTemplatePolicyDraft;
  pricingWeightBandPolicy: "MATCHED_STRUCTURAL_SOURCE_BAND";
}

let testInspectionOverride: ((input: { observedAt: string; observedBy: string }) => Promise<CanonicalRuleWorkbookInspection>) | undefined;
/** Test-only connector boundary: routes still execute their production command,
 * persistence, draft and publish paths against the returned observation. */
export function setCanonicalRuleWorkbookInspectionForTests(override?: typeof testInspectionOverride) {
  testInspectionOverride = override;
}

export async function inspectCanonicalRuleWorkbook(input: {
  observedAt: string;
  observedBy: string;
}): Promise<CanonicalRuleWorkbookInspection> {
  if (testInspectionOverride) return testInspectionOverride(input);
  const sourceRevision = await pullFeishuWorkbookRevision({
    workbook: CANONICAL_FEISHU_WORKBOOK,
    registry: CANONICAL_FEISHU_SHEET_REGISTRY,
    adapter: createFeishuWorkbookPullAdapter(),
    pulledAt: input.observedAt,
    pulledBy: input.observedBy,
  });
  const requests = canonicalRuleWorkbookRangeRequests(sourceRevision);
  const ranges = await readFeishuSheetRanges({
    spreadsheetToken: sourceRevision.spreadsheetToken,
    requests,
  });
  const identityRows = identityRowsFromRanges(ranges);
  const identityReport = prepareSourceIdentityMigration({
    workbookRefId: CANONICAL_FEISHU_WORKBOOK.id,
    sourceRevision: sourceRevision.sourceRevision,
    mode: "CONTINUOUS_SYNC",
    rows: identityRows,
    existingEntities: [],
    identityPolicies: canonicalIdentityPolicies(),
    generatedAt: input.observedAt,
  });
  const qualityRange = ranges.find((entry) => entry.sheetId === "FqD4j7" && entry.range === "B4:N50");
  const affixRange = ranges.find((entry) => entry.sheetId === AFFIX_SHEET_ID && entry.range === canonicalAffixSheetRanges(sourceRevision).aliasRange);
  const pricingEndpointRange = ranges.find((entry) => entry.sheetId === "u87sRh" && entry.range === "B179:E179");
  const pricingRange = ranges.find((entry) => entry.sheetId === "u87sRh" && entry.range === "B10:R70");
  const typeRange = ranges.find((entry) => entry.sheetId === "fATowU" && entry.range === "B2:AD20");
  const pricingDraft = pricingDraftFromRanges({
    sourceRevision,
    qualityValues: (qualityRange?.valueRange.values ?? []).slice(1, 5),
    pricingValues: pricingRange?.valueRange.values ?? [],
    typeValues: typeRange?.valueRange.values ?? [],
    importedAt: input.observedAt,
  });
  const qualityDraft = qualityDraftFromRanges({
    sourceRevision,
    qualityValues: qualityRange?.valueRange.values ?? [],
    affixValues: affixRange?.valueRange.values ?? [],
    pricingEndpointValues: pricingEndpointRange?.valueRange.values ?? [],
    importedAt: input.observedAt,
  });
  const canonicalRuleDraft = importCanonicalRuleSource({
    sourceRevision,
    weightValues: ranges.find((entry) => entry.sheetId === WEIGHT_TEMPLATE_SHEET_ID && /^A1:BH\d+$/.test(entry.range))?.valueRange.values ?? [],
    typeValues: ranges.find((entry) => entry.sheetId === CANONICAL_RULE_RANGES.type.sheetId && entry.range === CANONICAL_RULE_RANGES.type.range)?.valueRange.values ?? [],
    functionValues: ranges.find((entry) => entry.sheetId === CANONICAL_RULE_RANGES.function.sheetId && entry.range === CANONICAL_RULE_RANGES.function.range)?.valueRange.values ?? [],
    functionProfileValues: ranges.find((entry) => entry.sheetId === CANONICAL_RULE_RANGES.functionProfiles.sheetId && entry.range === CANONICAL_RULE_RANGES.functionProfiles.range)?.valueRange.values ?? [],
    methodValues: ranges.find((entry) => entry.sheetId === CANONICAL_RULE_RANGES.method.sheetId && entry.range === CANONICAL_RULE_RANGES.method.range)?.valueRange.values ?? [],
    methodTemplateReviewValues: ranges.find((entry) => entry.sheetId === CANONICAL_RULE_RANGES.methodTemplateReview.sheetId && entry.range === CANONICAL_RULE_RANGES.methodTemplateReview.range)?.valueRange.values ?? [],
    importedAt: input.observedAt,
  });
  const weightTemplateDraft = weightTemplateDraftFromCanonicalRuleDraft({ sourceRevision, canonicalRuleDraft, weightValues: ranges.find((entry) => entry.sheetId === WEIGHT_TEMPLATE_SHEET_ID && /^A1:BH\d+$/.test(entry.range))?.valueRange.values ?? [], importedAt: input.observedAt });
  return {
    observedAt: input.observedAt,
    sourceRevision,
    identityRows,
    identityReport,
    pricingDraft,
    qualityDraft,
    canonicalRuleDraft,
    weightTemplateDraft,
    pricingWeightBandPolicy: "MATCHED_STRUCTURAL_SOURCE_BAND",
  };
}
