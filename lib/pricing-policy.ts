import { deterministicHash } from "./rule-kernel";

export type PricingInputStatus = "SOURCE" | "PROPOSED" | "CONFIRMED";
export type QualityId =
  | "quality_c_green"
  | "quality_b_blue"
  | "quality_a_purple"
  | "quality_s_orange";

export interface PricingCellRef {
  sheetId: string;
  cell: string;
  rowKey?: string;
}

export interface SourcedPricingValue<T> {
  value: T;
  status: PricingInputStatus;
  source: PricingCellRef;
}

export interface PricingLookupEntry {
  pricingWeightBandId?: string;
  pricingBasketId?: string;
  partId?: string;
  typeId?: string;
  value: SourcedPricingValue<number>;
}

export interface QualityPricingBasketMapping {
  qualityId: QualityId;
  pricingBasketId: string;
  sourceAlias: string;
  status: PricingInputStatus;
  source: PricingCellRef;
}

export interface QualityPriceFactorRange {
  qualityId: QualityId;
  minScore: number;
  maxScore: number;
  maxInclusive: boolean;
  minFactor: number;
  maxFactor: number;
  status: PricingInputStatus;
  source: PricingCellRef;
}

export interface ScoreInterpolationPolicyDraft {
  kind: "constant" | "piecewise_linear" | "quality_range_linear";
  points: Array<{ valueScore: number; factor: number }>;
  outOfRange: "clamp" | "error" | "extrapolate";
  status: PricingInputStatus;
  source: PricingCellRef;
}

export interface PerformanceScoringPolicyDraft {
  enabled: boolean;
  status: PricingInputStatus;
  source: PricingCellRef;
}

export interface PricingMoneyPolicyDraft {
  unit: string;
  rounding: "none" | "floor" | "ceil" | "half_up" | "significant_digits_floor";
  precision: number;
  significantDigits?: number;
  minimumPrice?: number;
  maximumPrice?: number;
  roundingStage?: "part_purchase_price" | "model_total_price";
  minimumPriceScope?: "part_purchase_price" | "model_total_price";
  overflowMode?: "error" | "clamp";
  status: PricingInputStatus;
  source: PricingCellRef;
}

export interface PricingPolicyIssue {
  code: string;
  severity: "warning" | "error";
  message: string;
  source?: PricingCellRef;
}

export interface PricingPolicyDraft {
  id: string;
  sourceRevisionId: string;
  sourceRevision: string;
  pricingSheetId: "u87sRh";
  qualitySheetId?: "FqD4j7";
  typeMaterialSheetId: "fATowU";
  businessFormulaCells: PricingCellRef[];
  pricingBaskets: Array<{ id: string; sourceAlias: string; source: PricingCellRef }>;
  maintenanceConsumptionRates: PricingLookupEntry[];
  partAllocationRatios: PricingLookupEntry[];
  repairCoefficients: PricingLookupEntry[];
  totalLossTimes: PricingLookupEntry[];
  purchaseCoefficients: PricingLookupEntry[];
  partsToWholeRatios: PricingLookupEntry[];
  qualityMappings: QualityPricingBasketMapping[];
  qualityPriceFactorRanges?: QualityPriceFactorRange[];
  scoreInterpolation?: ScoreInterpolationPolicyDraft;
  performanceScoringPolicy?: PerformanceScoringPolicyDraft;
  moneyPolicy?: PricingMoneyPolicyDraft;
  issues: PricingPolicyIssue[];
  formalStatus: "INCOMPLETE_DRAFT" | "TRIAL_READY" | "READY_TO_PUBLISH";
  inputHash: string;
  importedAt: string;
}

export interface PricingPolicyVersion extends Omit<PricingPolicyDraft, "formalStatus"> {
  version: string;
  formalStatus: "PUBLISHED";
  publishedAt: string;
  publishedBy: string;
}

export interface PricingTraceEntry {
  sequence: number;
  formulaStep: string;
  sourceRevision: string;
  source: PricingCellRef;
  before: number;
  operation: "set" | "multiply" | "divide" | "round" | "clamp";
  operand: number;
  after: number;
  inputStatus: PricingInputStatus;
}

export interface PricingTrialResult {
  formal: boolean;
  pricingPolicyRef: string;
  pricingWeightBandId: string;
  pricingBasketId: string;
  repairPriceUnrounded: number;
  purchasePriceUnrounded: number;
  purchasePrice: number | null;
  moneyUnit?: string;
  trace: PricingTraceEntry[];
  issues: PricingPolicyIssue[];
  warnings: string[];
  inputHash: string;
}

const QUALITY_ORDER: QualityId[] = [
  "quality_c_green",
  "quality_b_blue",
  "quality_a_purple",
  "quality_s_orange",
];

function exactlyOne<T>(values: T[], description: string): T {
  if (values.length !== 1) throw new Error(`${description}必须唯一命中，实际 ${values.length} 条。`);
  return values[0];
}

function validPositive(entry: { value: SourcedPricingValue<number> }, name: string, issues: PricingPolicyIssue[]) {
  if (!Number.isFinite(entry.value.value) || entry.value.value <= 0) {
    issues.push({ code: "PRICING_VALUE_INVALID", severity: "error", message: `${name}必须是正数。`, source: entry.value.source });
  }
}

function validateQualityRanges(ranges: QualityPriceFactorRange[], issues: PricingPolicyIssue[]) {
  for (const qualityId of QUALITY_ORDER) {
    const matches = ranges.filter((entry) => entry.qualityId === qualityId);
    if (matches.length !== 1) {
      issues.push({
        code: matches.length ? "QUALITY_PRICE_FACTOR_DUPLICATE" : "QUALITY_PRICE_FACTOR_MISSING",
        severity: "error",
        message: `${qualityId} 必须且只能有一组评分区间和价格系数。`,
      });
    }
  }
  const ordered = [...ranges].sort((left, right) => left.minScore - right.minScore);
  for (const range of ordered) {
    if (
      !Number.isFinite(range.minScore)
      || !Number.isFinite(range.maxScore)
      || range.maxScore <= range.minScore
      || !Number.isFinite(range.minFactor)
      || !Number.isFinite(range.maxFactor)
      || range.minFactor <= 0
      || range.maxFactor <= 0
    ) {
      issues.push({
        code: "QUALITY_PRICE_FACTOR_INVALID",
        severity: "error",
        message: `${range.qualityId} 的评分区间和价格系数必须是有效正数区间。`,
        source: range.source,
      });
    }
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].maxScore !== ordered[index].minScore) {
      issues.push({
        code: "QUALITY_SCORE_RANGE_GAP_OR_OVERLAP",
        severity: "error",
        message: "品质评分区间必须互斥且无空洞。",
        source: ordered[index].source,
      });
      break;
    }
  }
}

export function importPricingPolicyDraft(input: Omit<PricingPolicyDraft, "id" | "issues" | "formalStatus" | "inputHash">): PricingPolicyDraft {
  const issues: PricingPolicyIssue[] = [];
  if (
    input.pricingSheetId !== "u87sRh"
    || input.typeMaterialSheetId !== "fATowU"
    || (input.qualitySheetId !== undefined && input.qualitySheetId !== "FqD4j7")
  ) {
    issues.push({ code: "PRICING_SHEET_ID_MISMATCH", severity: "error", message: "定价草稿必须按稳定 sheet_id 联合读取 07_品质评分、08_价格计算与 02_类型材质。" });
  }
  for (const [name, entries] of [
    ["维修消耗速度", input.maintenanceConsumptionRates],
    ["部位占比", input.partAllocationRatios],
    ["维修系数", input.repairCoefficients],
    ["全损时间", input.totalLossTimes],
    ["购买系数", input.purchaseCoefficients],
    ["零整比", input.partsToWholeRatios],
  ] as const) {
    for (const entry of entries) validPositive(entry, name, issues);
  }

  for (const qualityId of QUALITY_ORDER) {
    const mappings = input.qualityMappings.filter((mapping) => mapping.qualityId === qualityId);
    if (mappings.length !== 1) {
      issues.push({
        code: mappings.length ? "QUALITY_PRICING_MAPPING_DUPLICATE" : "QUALITY_PRICING_MAPPING_MISSING",
        severity: "error",
        message: `${qualityId} 到 PricingBasket 的映射必须且只能有一条。`,
      });
    }
  }
  const basketIds = new Set(input.pricingBaskets.map((basket) => basket.id));
  for (const mapping of input.qualityMappings) {
    if (!basketIds.has(mapping.pricingBasketId)) {
      issues.push({ code: "QUALITY_PRICING_MAPPING_UNKNOWN", severity: "error", message: `${mapping.qualityId} 指向未知 PricingBasket ${mapping.pricingBasketId}。`, source: mapping.source });
    }
  }

  const ranges = input.qualityPriceFactorRanges ?? [];
  if (ranges.length) validateQualityRanges(ranges, issues);
  else issues.push({ code: "QUALITY_PRICE_FACTOR_MISSING", severity: "warning", message: "品质评分区间和价格系数尚未完整导入；只能非正式试算。" });

  if (!input.scoreInterpolation) {
    issues.push({ code: "PRICING_INTERPOLATION_MISSING", severity: "warning", message: "评分插值策略尚未导入；正式定价不可发布。" });
  }
  if (!input.partsToWholeRatios.length) {
    issues.push({ code: "PARTS_TO_WHOLE_RATIO_MISSING", severity: "warning", message: "重量段×PricingBasket×部位零整比尚未导入；正式定价不可发布。" });
  }
  if (!input.moneyPolicy) {
    issues.push({ code: "PRICING_MONEY_POLICY_MISSING", severity: "warning", message: "金额单位、舍入和价格边界尚未导入；正式定价不可发布。" });
  }
  if (input.moneyPolicy && (
    !input.moneyPolicy.roundingStage
    || !input.moneyPolicy.minimumPriceScope
    || !input.moneyPolicy.overflowMode
  )) {
    issues.push({
      code: "PRICING_EXECUTION_SEMANTICS_MISSING",
      severity: "error",
      message: "定价源尚未明确舍入阶段、最低价作用域或溢出处理方式；新策略只能用于非正式试算。",
      source: input.moneyPolicy.source,
    });
  }

  const allStatuses = [
    ...input.maintenanceConsumptionRates.map((entry) => entry.value.status),
    ...input.partAllocationRatios.map((entry) => entry.value.status),
    ...input.repairCoefficients.map((entry) => entry.value.status),
    ...input.totalLossTimes.map((entry) => entry.value.status),
    ...input.purchaseCoefficients.map((entry) => entry.value.status),
    ...input.partsToWholeRatios.map((entry) => entry.value.status),
    ...input.qualityMappings.map((entry) => entry.status),
    ...ranges.map((entry) => entry.status),
    ...(input.scoreInterpolation ? [input.scoreInterpolation.status] : []),
    ...(input.moneyPolicy ? [input.moneyPolicy.status] : []),
  ];
  const hasErrors = issues.some((issue) => issue.severity === "error");
  const requiredPresent = Boolean(
    input.scoreInterpolation
    && input.moneyPolicy
    && input.partsToWholeRatios.length
    && ranges.length
    && input.moneyPolicy.roundingStage
    && input.moneyPolicy.minimumPriceScope
    && input.moneyPolicy.overflowMode,
  );
  const formalStatus: PricingPolicyDraft["formalStatus"] = hasErrors || !requiredPresent
    ? "INCOMPLETE_DRAFT"
    : allStatuses.every((status) => status === "CONFIRMED")
      ? "READY_TO_PUBLISH"
      : "TRIAL_READY";
  const content = { ...structuredClone(input), issues, formalStatus };
  const inputHash = deterministicHash(content);
  return { id: `pricing-draft:${inputHash}`, ...content, inputHash };
}

function interpolationFactor(
  policy: ScoreInterpolationPolicyDraft,
  ranges: QualityPriceFactorRange[],
  valueScore: number,
  qualityId: QualityId,
) {
  if (policy.kind === "quality_range_linear") {
    const range = exactlyOne(ranges.filter((entry) => entry.qualityId === qualityId), "品质价格系数区间");
    const ratio = (valueScore - range.minScore) / (range.maxScore - range.minScore);
    if (ratio < 0 || ratio > 1 || (ratio === 1 && !range.maxInclusive)) {
      if (policy.outOfRange === "error") return Number.NaN;
      if (policy.outOfRange === "clamp") return ratio < 0 ? range.minFactor : range.maxFactor;
    }
    return range.minFactor + (range.maxFactor - range.minFactor) * ratio;
  }
  if (policy.kind === "constant") return policy.points[0]?.factor ?? Number.NaN;
  const points = [...policy.points].sort((left, right) => left.valueScore - right.valueScore);
  if (points.length < 2) return Number.NaN;
  let left = points[0];
  let right = points[points.length - 1];
  if (valueScore < left.valueScore) {
    if (policy.outOfRange === "error") return Number.NaN;
    if (policy.outOfRange === "clamp") return left.factor;
    right = points[1];
  } else if (valueScore > right.valueScore) {
    if (policy.outOfRange === "error") return Number.NaN;
    if (policy.outOfRange === "clamp") return right.factor;
    left = points[points.length - 2];
  } else {
    for (let index = 1; index < points.length; index += 1) {
      if (valueScore <= points[index].valueScore) {
        left = points[index - 1];
        right = points[index];
        break;
      }
    }
  }
  if (right.valueScore === left.valueScore) return Number.NaN;
  const ratio = (valueScore - left.valueScore) / (right.valueScore - left.valueScore);
  return left.factor + (right.factor - left.factor) * ratio;
}

export function floorToSignificantDigits(value: number, digits: number) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(digits) || digits <= 0) {
    return Number.NaN;
  }
  const step = 10 ** (Math.floor(Math.log10(value)) - digits + 1);
  return Math.floor(value / step) * step;
}

function roundMoney(value: number, policy: PricingMoneyPolicyDraft) {
  if (policy.rounding === "significant_digits_floor") {
    return floorToSignificantDigits(value, policy.significantDigits ?? policy.precision);
  }
  const multiplier = 10 ** policy.precision;
  const scaled = value * multiplier;
  const rounded = policy.rounding === "floor" ? Math.floor(scaled)
    : policy.rounding === "ceil" ? Math.ceil(scaled)
      : policy.rounding === "half_up" ? Math.floor(scaled + 0.5)
        : scaled;
  return rounded / multiplier;
}

function lookupRatio(
  entries: PricingLookupEntry[],
  input: { partId: string; pricingWeightBandId: string; pricingBasketId: string },
) {
  return exactlyOne(entries.filter((entry) =>
    entry.partId === input.partId
    && (entry.pricingWeightBandId === input.pricingWeightBandId || entry.pricingWeightBandId === "" || entry.pricingWeightBandId === undefined)
    && (entry.pricingBasketId === input.pricingBasketId || entry.pricingBasketId === undefined)
  ), "零整比");
}

export function calculatePricingTrial(input: {
  policy: PricingPolicyDraft | PricingPolicyVersion;
  partId: string;
  typeId: string;
  pricingWeightBandId: string;
  valueScore: number;
  qualityId: QualityId;
}): PricingTrialResult {
  const policy = input.policy;
  const mapping = exactlyOne(policy.qualityMappings.filter((entry) => entry.qualityId === input.qualityId), "品质定价映射");
  const basketId = mapping.pricingBasketId;
  const consumption = exactlyOne(policy.maintenanceConsumptionRates.filter((entry) => entry.pricingWeightBandId === input.pricingWeightBandId && entry.pricingBasketId === basketId), "维修消耗速度");
  const allocation = exactlyOne(policy.partAllocationRatios.filter((entry) => entry.pricingWeightBandId === input.pricingWeightBandId && entry.partId === input.partId), "部位占比");
  const repairCoefficient = exactlyOne(policy.repairCoefficients.filter((entry) => entry.partId === input.partId && entry.typeId === input.typeId), "维修系数");
  const lossTime = exactlyOne(policy.totalLossTimes.filter((entry) => entry.pricingWeightBandId === input.pricingWeightBandId && entry.pricingBasketId === basketId && entry.partId === input.partId), "全损时间");
  const purchaseCoefficient = exactlyOne(policy.purchaseCoefficients.filter((entry) => entry.partId === input.partId && entry.typeId === input.typeId), "购买系数");
  const partsToWhole = lookupRatio(policy.partsToWholeRatios, {
    partId: input.partId,
    pricingWeightBandId: input.pricingWeightBandId,
    pricingBasketId: basketId,
  });
  if (!policy.scoreInterpolation) throw new Error("定价草稿缺少评分插值策略，无法试算。");
  const factor = interpolationFactor(
    policy.scoreInterpolation,
    policy.qualityPriceFactorRanges ?? [],
    input.valueScore,
    input.qualityId,
  );
  if (!Number.isFinite(factor) || factor <= 0) throw new Error("评分插值策略无法为当前 valueScore 生成正数系数。");

  const trace: PricingTraceEntry[] = [];
  let value = 1;
  const multiply = (formulaStep: string, item: SourcedPricingValue<number>) => {
    const before = value;
    value *= item.value;
    trace.push({ sequence: trace.length + 1, formulaStep, sourceRevision: policy.sourceRevision, source: item.source, before, operation: "multiply", operand: item.value, after: value, inputStatus: item.status });
  };
  multiply("maintenanceConsumptionRate", consumption.value);
  multiply("partAllocationRatio", allocation.value);
  multiply("repairCoefficient", repairCoefficient.value);
  multiply("totalLossTime", lossTime.value);
  multiply("scoreInterpolationFactor", { value: factor, status: policy.scoreInterpolation.status, source: policy.scoreInterpolation.source });
  const repairPriceUnrounded = value;
  multiply("purchaseCoefficient", purchaseCoefficient.value);
  const beforeDivision = value;
  value /= partsToWhole.value.value;
  trace.push({ sequence: trace.length + 1, formulaStep: "partsToWholeRatio", sourceRevision: policy.sourceRevision, source: partsToWhole.value.source, before: beforeDivision, operation: "divide", operand: partsToWhole.value.value, after: value, inputStatus: partsToWhole.value.status });
  const purchasePriceUnrounded = value;
  let purchasePrice: number | null = null;
  const issues: PricingPolicyIssue[] = [];
  if (policy.moneyPolicy?.roundingStage === "part_purchase_price") {
    const rounded = roundMoney(value, policy.moneyPolicy);
    trace.push({ sequence: trace.length + 1, formulaStep: "moneyRounding", sourceRevision: policy.sourceRevision, source: policy.moneyPolicy.source, before: value, operation: "round", operand: policy.moneyPolicy.significantDigits ?? policy.moneyPolicy.precision, after: rounded, inputStatus: policy.moneyPolicy.status });
    purchasePrice = rounded;
    if (
      policy.moneyPolicy.minimumPriceScope === "part_purchase_price"
      && policy.moneyPolicy.minimumPrice !== undefined
      && purchasePrice < policy.moneyPolicy.minimumPrice
    ) {
      const before = purchasePrice;
      purchasePrice = policy.moneyPolicy.minimumPrice;
      trace.push({ sequence: trace.length + 1, formulaStep: "minimumPrice", sourceRevision: policy.sourceRevision, source: policy.moneyPolicy.source, before, operation: "clamp", operand: policy.moneyPolicy.minimumPrice, after: purchasePrice, inputStatus: policy.moneyPolicy.status });
    }
    if (policy.moneyPolicy.maximumPrice !== undefined && value > policy.moneyPolicy.maximumPrice) {
      if (!policy.moneyPolicy.overflowMode) {
        issues.push({
          code: "PRICE_OVERFLOW_POLICY_MISSING",
          severity: "error",
          message: `未舍入价格 ${value} 超过上限 ${policy.moneyPolicy.maximumPrice}，但规则源没有指定溢出处理方式。`,
          source: policy.moneyPolicy.source,
        });
        purchasePrice = null;
      } else if (policy.moneyPolicy.overflowMode === "clamp") {
        const before = purchasePrice;
        purchasePrice = policy.moneyPolicy.maximumPrice;
        trace.push({ sequence: trace.length + 1, formulaStep: "maximumPrice", sourceRevision: policy.sourceRevision, source: policy.moneyPolicy.source, before, operation: "clamp", operand: policy.moneyPolicy.maximumPrice, after: purchasePrice, inputStatus: policy.moneyPolicy.status });
      } else {
        issues.push({
          code: "PRICE_OVERFLOW",
          severity: "error",
          message: `未舍入价格 ${value} 超过上限 ${policy.moneyPolicy.maximumPrice}，策略要求阻断。`,
          source: policy.moneyPolicy.source,
        });
        purchasePrice = null;
      }
    }
  } else if (policy.moneyPolicy) {
    issues.push({
      code: "PRICING_EXECUTION_SEMANTICS_MISSING",
      severity: "error",
      message: "当前价格只能保留未舍入试算；规则源尚未指定适用于部件购买价的舍入阶段。",
      source: policy.moneyPolicy.source,
    });
  }
  const formal = policy.formalStatus === "PUBLISHED" && issues.every((issue) => issue.severity !== "error");
  const warnings = formal ? [] : [
    ...(policy.formalStatus === "PUBLISHED" ? [] : ["非正式价格试算：未发布 PricingPolicyVersion，不得用于正式 Store 导出。"]),
    ...issues.map((issue) => `${issue.code}：${issue.message}`),
  ];
  const result = {
    formal,
    pricingPolicyRef: policy.id,
    pricingWeightBandId: input.pricingWeightBandId,
    pricingBasketId: basketId,
    repairPriceUnrounded,
    purchasePriceUnrounded,
    purchasePrice,
    moneyUnit: policy.moneyPolicy?.unit,
    trace,
    issues,
    warnings,
  };
  return { ...result, inputHash: deterministicHash({ input, result }) };
}

export function publishPricingPolicyDraft(input: {
  draft: PricingPolicyDraft;
  version: string;
  publishedAt: string;
  publishedBy: string;
}): PricingPolicyVersion {
  if (input.draft.formalStatus !== "READY_TO_PUBLISH") {
    const codes = input.draft.issues.filter((issue) => issue.severity === "error").map((issue) => issue.code);
    throw new Error(`PricingPolicyDraft 尚未满足正式发布条件${codes.length ? `：${codes.join("、")}` : "。"}`);
  }
  const { formalStatus: _draftStatus, ...content } = structuredClone(input.draft);
  void _draftStatus;
  return { ...content, version: input.version, formalStatus: "PUBLISHED", publishedAt: input.publishedAt, publishedBy: input.publishedBy };
}
