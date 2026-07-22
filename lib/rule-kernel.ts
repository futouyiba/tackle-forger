import { evaluateFormula } from "./engine";
import type {
  AdjustmentRule,
  AttributeContribution,
  DerivedProjection,
  FunctionIntensity,
  FunctionProfile,
  ItemTypeProfile,
  MethodProfile,
  PerformanceProfile,
  ProjectionLayer,
  ProjectionPatchRuleSource,
  ProjectionTraceContribution,
  ProjectionTraceStep,
  ProjectionWarning,
  QualityProfile,
  ReductionStackingMode,
  RuleSetVersion,
  WeightTemplate,
} from "./types";

type ProjectionValues = Record<string, number | string>;

export interface DeriveProjectionInput {
  id?: string;
  weightTemplate: WeightTemplate;
  methodProfile: MethodProfile;
  itemTypeProfile: ItemTypeProfile;
  functionProfile: FunctionProfile;
  functionIntensity: FunctionIntensity;
  performanceProfile?: PerformanceProfile;
  qualityProfile?: QualityProfile;
  ruleSet: RuleSetVersion;
  attributeContributions?: AttributeContribution[];
  patches?: ProjectionPatchRuleSource[];
  createdAt?: string;
}

const TRACE_LAYERS: ProjectionLayer[] = [
  "base_weight_template",
  "method",
  "item_type",
  "function",
  "performance",
  "quality",
  "series_patch",
  "sku_patch",
  "model_patch",
  "attribute_affix",
  "final_review_patch",
  "validation",
];

const PATCH_LAYER: Record<ProjectionPatchRuleSource["scope"], ProjectionLayer> = {
  series: "series_patch",
  sku: "sku_patch",
  model: "model_patch",
  final_review: "final_review_patch",
};

function round(value: number, precision = 12): number {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortRecord(values: ProjectionValues): ProjectionValues {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => compareText(left, right)),
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function deterministicHash(value: unknown): string {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function applyReduction(
  base: number,
  totalReduction: number,
  mode: ReductionStackingMode,
): number {
  if (!Number.isFinite(base) || !Number.isFinite(totalReduction)) {
    throw new Error("降低类聚合只接受有限数字。");
  }
  const result = mode === "linear_subtraction"
    ? base * (1 - totalReduction)
    : base / (1 + totalReduction);
  if (!Number.isFinite(result)) {
    throw new Error("降低类聚合结果不是有限数字。");
  }
  return round(result);
}

function addSource(step: ProjectionTraceStep, sourceId: string): void {
  if (!step.sourceIds.includes(sourceId)) step.sourceIds.push(sourceId);
}

function addWarning(
  warnings: ProjectionWarning[],
  warning: ProjectionWarning,
): void {
  warnings.push(warning);
}

function applyRule(
  values: ProjectionValues,
  rule: AdjustmentRule,
  layer: ProjectionLayer,
  sourceId: string,
  sourceName: string,
  sequence: number,
  warnings: ProjectionWarning[],
): ProjectionTraceContribution | null {
  const before = values[rule.parameterKey] ?? null;
  const current = typeof before === "number" ? before : 0;
  let after: number | string | null = before;

  try {
    if (rule.operation === "set") {
      after = rule.value;
    } else if (rule.operation === "add") {
      after = round(current + Number(rule.value));
    } else if (rule.operation === "multiply") {
      after = round(current * Number(rule.value));
    } else if (rule.operation === "min") {
      after = round(Math.min(current, Number(rule.value)));
    } else if (rule.operation === "max") {
      after = round(Math.max(current, Number(rule.value)));
    } else {
      after = round(
        evaluateFormula(String(rule.value), {
          current,
          ...Object.fromEntries(
            Object.entries(values).filter(
              (entry): entry is [string, number] => typeof entry[1] === "number",
            ),
          ),
        }),
      );
    }

    if (typeof after === "number" && !Number.isFinite(after)) {
      throw new Error("规则结果不是有限数字。");
    }
    values[rule.parameterKey] = after;
    return {
      sequence,
      ruleId: rule.id,
      sourceId,
      sourceName,
      parameterKey: rule.parameterKey,
      operation: rule.operation,
      before,
      operand: rule.value,
      after,
    };
  } catch (error) {
    addWarning(warnings, {
      level: "error",
      code: "RULE_APPLY_FAILED",
      message:
        "规则 " + rule.id + " 执行失败：" +
        (error instanceof Error ? error.message : String(error)),
      layer,
      parameterKey: rule.parameterKey,
      sourceId,
    });
    return null;
  }
}

function applyRuleSource(
  values: ProjectionValues,
  step: ProjectionTraceStep,
  rules: AdjustmentRule[],
  sourceId: string,
  sourceName: string,
  warnings: ProjectionWarning[],
  sequence: { value: number },
  setRules: Map<string, string>,
): void {
  addSource(step, sourceId);
  for (const rule of rules) {
    if (rule.operation === "set") {
      const conflictKey = step.layer + ":" + rule.parameterKey;
      const previous = setRules.get(conflictKey);
      if (previous) {
        addWarning(warnings, {
          level: "error",
          code: "SET_RULE_CONFLICT",
          message:
            "同一层参数 " + rule.parameterKey + " 同时存在 set 规则 " +
            previous + " 与 " + rule.id + "。",
          layer: step.layer,
          parameterKey: rule.parameterKey,
          sourceId,
        });
      } else {
        setRules.set(conflictKey, rule.id);
      }
    }
    sequence.value += 1;
    const contribution = applyRule(
      values,
      rule,
      step.layer,
      sourceId,
      sourceName,
      sequence.value,
      warnings,
    );
    if (contribution) step.contributions.push(contribution);
  }
}

function applyAttributeContributions(
  values: ProjectionValues,
  step: ProjectionTraceStep,
  contributions: AttributeContribution[],
  mode: ReductionStackingMode,
  warnings: ProjectionWarning[],
  sequence: { value: number },
): void {
  const grouped = new Map<string, AttributeContribution[]>();
  for (const contribution of contributions) {
    const entries = grouped.get(contribution.parameterKey) ?? [];
    entries.push(contribution);
    grouped.set(contribution.parameterKey, entries);
    addSource(step, contribution.sourceId);
  }

  for (const parameterKey of Array.from(grouped.keys()).sort()) {
    const entries = grouped.get(parameterKey) ?? [];
    const original = values[parameterKey];
    if (typeof original !== "number") {
      addWarning(warnings, {
        level: "error",
        code: "ATTRIBUTE_BASE_NOT_NUMERIC",
        message: "属性词条 " + parameterKey + " 的基础值不是数字。",
        layer: "attribute_affix",
        parameterKey,
      });
      continue;
    }

    let current = original;
    let percentTotal = 0;
    for (const entry of entries.filter((item) => item.operation === "percent_bonus")) {
      percentTotal += entry.value;
      const after = round(original * (1 + percentTotal));
      sequence.value += 1;
      step.contributions.push({
        sequence: sequence.value,
        ruleId: entry.id,
        sourceId: entry.sourceId,
        sourceName: entry.sourceName,
        parameterKey,
        operation: entry.operation,
        before: current,
        operand: entry.value,
        after,
      });
      current = after;
    }

    for (const entry of entries.filter((item) => item.operation === "flat_bonus")) {
      const after = round(current + entry.value);
      sequence.value += 1;
      step.contributions.push({
        sequence: sequence.value,
        ruleId: entry.id,
        sourceId: entry.sourceId,
        sourceName: entry.sourceName,
        parameterKey,
        operation: entry.operation,
        before: current,
        operand: entry.value,
        after,
      });
      current = after;
    }

    const reductionBase = current;
    let reductionTotal = 0;
    for (const entry of entries.filter((item) => item.operation === "reduction")) {
      reductionTotal += entry.value;
      if (entry.value < 0) {
        addWarning(warnings, {
          level: "warning",
          code: "NEGATIVE_REDUCTION",
          message: "降低类词条 " + entry.id + " 使用了负值，需人工复核。",
          layer: "attribute_affix",
          parameterKey,
          sourceId: entry.sourceId,
        });
      }
      const after = applyReduction(reductionBase, reductionTotal, mode);
      sequence.value += 1;
      step.contributions.push({
        sequence: sequence.value,
        ruleId: entry.id,
        sourceId: entry.sourceId,
        sourceName: entry.sourceName,
        parameterKey,
        operation: entry.operation,
        before: current,
        operand: entry.value,
        after,
      });
      current = after;
    }
    if (mode === "linear_subtraction" && reductionTotal > 1) {
      addWarning(warnings, {
        level: "warning",
        code: "LINEAR_REDUCTION_OVER_100_PERCENT",
        message: "线性降低总量超过 100%，结果可能为负值。",
        layer: "attribute_affix",
        parameterKey,
      });
    }
    values[parameterKey] = current;
  }
}

function validateProjection(
  input: DeriveProjectionInput,
  values: ProjectionValues,
  warnings: ProjectionWarning[],
  validationStep: ProjectionTraceStep,
): void {
  addSource(validationStep, input.ruleSet.id);
  if (
    input.weightTemplate.fishMinKg >= input.weightTemplate.fishMaxKg ||
    input.weightTemplate.nominalFishKg < input.weightTemplate.fishMinKg ||
    input.weightTemplate.nominalFishKg > input.weightTemplate.fishMaxKg
  ) {
    addWarning(warnings, {
      level: "error",
      code: "WEIGHT_TEMPLATE_RANGE_INVALID",
      message: "重量模板范围无效或标称重量不在范围内。",
      layer: "validation",
      sourceId: input.weightTemplate.id,
    });
  }
  for (const [parameterKey, value] of Object.entries(values)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      addWarning(warnings, {
        level: "error",
        code: "NON_FINITE_VALUE",
        message: "参数 " + parameterKey + " 不是有限数字。",
        layer: "validation",
        parameterKey,
      });
    }
  }
  if (input.ruleSet.status !== "published") {
    addWarning(warnings, {
      level: "warning",
      code: "RULE_SET_NOT_PUBLISHED",
      message: "当前派生使用的规则集尚未发布。",
      layer: "validation",
      sourceId: input.ruleSet.id,
    });
  }
  if (!warnings.some((warning) => warning.level === "error")) {
    addWarning(warnings, {
      level: "info",
      code: "PROJECTION_VALID",
      message: "派生投影通过基础确定性校验。",
      layer: "validation",
      sourceId: input.ruleSet.id,
    });
  }
}

export function deriveProjection(
  input: DeriveProjectionInput,
): DerivedProjection {
  const values: ProjectionValues = sortRecord(
    structuredClone(input.weightTemplate.values),
  );
  const warnings: ProjectionWarning[] = [];
  const trace: ProjectionTraceStep[] = TRACE_LAYERS.map((layer) => ({
    layer,
    sourceIds: [],
    contributions: [],
  }));
  const step = (layer: ProjectionLayer) =>
    trace.find((entry) => entry.layer === layer) as ProjectionTraceStep;
  const sequence = { value: 0 };
  const setRules = new Map<string, string>();

  const baseStep = step("base_weight_template");
  addSource(baseStep, input.weightTemplate.id);
  for (const [parameterKey, value] of Object.entries(values)) {
    sequence.value += 1;
    baseStep.contributions.push({
      sequence: sequence.value,
      ruleId: "base:" + parameterKey,
      sourceId: input.weightTemplate.id,
      sourceName: input.weightTemplate.name,
      parameterKey,
      operation: "base",
      before: null,
      operand: value,
      after: value,
    });
  }

  if (!input.methodProfile.enabled) {
    addWarning(warnings, {
      level: "error",
      code: "METHOD_PROFILE_DISABLED",
      message: "钓法规则层已禁用。",
      layer: "method",
      sourceId: input.methodProfile.id,
    });
  }
  applyRuleSource(
    values,
    step("method"),
    input.methodProfile.rules,
    input.methodProfile.id,
    input.methodProfile.name,
    warnings,
    sequence,
    setRules,
  );

  if (!input.itemTypeProfile.enabled) {
    addWarning(warnings, {
      level: "error",
      code: "TYPE_PROFILE_DISABLED",
      message: "类型规则层已禁用。",
      layer: "item_type",
      sourceId: input.itemTypeProfile.id,
    });
  }
  applyRuleSource(
    values,
    step("item_type"),
    input.itemTypeProfile.rules,
    input.itemTypeProfile.id,
    input.itemTypeProfile.name,
    warnings,
    sequence,
    setRules,
  );

  const intensityRules = input.functionProfile.intensityRules.find(
    (entry) => entry.intensity === input.functionIntensity,
  );
  if (!intensityRules) {
    addWarning(warnings, {
      level: "warning",
      code: "FUNCTION_INTENSITY_RULES_MISSING",
      message:
        "功能 " + input.functionProfile.name + " 没有强度 " +
        input.functionIntensity + " 的专用规则，仅应用基础规则。",
      layer: "function",
      sourceId: input.functionProfile.id,
    });
  }
  applyRuleSource(
    values,
    step("function"),
    input.functionProfile.rules,
    input.functionProfile.id,
    input.functionProfile.name,
    warnings,
    sequence,
    setRules,
  );
  const structuralValues = sortRecord(structuredClone(values));
  applyRuleSource(
    values,
    step("function"),
    intensityRules?.rules ?? [],
    input.functionProfile.id,
    input.functionProfile.name + " / 强度 " + input.functionIntensity,
    warnings,
    sequence,
    setRules,
  );

  if (input.performanceProfile) {
    applyRuleSource(
      values,
      step("performance"),
      input.performanceProfile.rules,
      input.performanceProfile.id,
      input.performanceProfile.name,
      warnings,
      sequence,
      setRules,
    );
  }

  if (input.qualityProfile) {
    applyRuleSource(
      values,
      step("quality"),
      input.qualityProfile.rules,
      input.qualityProfile.id,
      input.qualityProfile.letter + "/" + input.qualityProfile.colorName,
      warnings,
      sequence,
      setRules,
    );
  }

  const patches = [...(input.patches ?? [])]
    .filter((patch) => patch.status === "approved")
    .sort((left, right) => {
      const scopeOrder = { series: 0, sku: 1, model: 2, final_review: 3 };
      return (
        scopeOrder[left.scope] - scopeOrder[right.scope] ||
        left.order - right.order ||
        compareText(left.id, right.id)
      );
    });
  // 权威执行顺序（规范 §3.2 / §8 / §21.1）：
  // SeriesPatch → SkuPatch → ModelPatch 必须先于 Affix/Technology 结算，
  // FinalReviewPatch 位于词条结算之后，最后做边界校验。
  for (const patch of patches.filter((patch) => patch.scope !== "final_review")) {
    applyRuleSource(
      values,
      step(PATCH_LAYER[patch.scope]),
      patch.rules,
      patch.id,
      patch.reason,
      warnings,
      sequence,
      setRules,
    );
  }

  applyAttributeContributions(
    values,
    step("attribute_affix"),
    input.attributeContributions ?? [],
    input.ruleSet.settings.reductionStackingMode,
    warnings,
    sequence,
  );

  for (const patch of patches.filter((patch) => patch.scope === "final_review")) {
    applyRuleSource(
      values,
      step("final_review_patch"),
      patch.rules,
      patch.id,
      patch.reason,
      warnings,
      sequence,
      setRules,
    );
  }

  validateProjection(input, values, warnings, step("validation"));
  const finalValues = sortRecord(values);
  const sourceHash = deterministicHash({
    weightTemplate: input.weightTemplate,
    methodProfile: input.methodProfile,
    itemTypeProfile: input.itemTypeProfile,
    functionProfile: input.functionProfile,
    functionIntensity: input.functionIntensity,
    performanceProfile: input.performanceProfile ?? null,
    qualityProfile: input.qualityProfile ?? null,
    ruleSet: input.ruleSet,
    attributeContributions: input.attributeContributions ?? [],
    patches,
    structuralValues,
    values: finalValues,
    trace,
    warnings,
  });

  return {
    id: input.id ?? "projection-" + sourceHash,
    weightTemplateId: input.weightTemplate.id,
    methodId: input.methodProfile.id,
    typeId: input.itemTypeProfile.id,
    functionId: input.functionProfile.id,
    functionIntensity: input.functionIntensity,
    performanceId: input.performanceProfile?.id,
    qualityId: input.qualityProfile?.id,
    ruleSetVersion: input.ruleSet.id,
    reductionStackingMode: input.ruleSet.settings.reductionStackingMode,
    structuralValues,
    values: finalValues,
    trace,
    warnings,
    sourceHash,
    createdAt: input.createdAt ?? input.ruleSet.createdAt,
  };
}
