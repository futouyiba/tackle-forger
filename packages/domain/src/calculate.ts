import Decimal from "decimal.js";
import type {
  AffixDefinition,
  AchievedQuality,
  CalculationLayer,
  CalculatedSku,
  CombinationSkuInput,
  ManualOverride,
  ModifierRule,
  ParameterValue,
  QualityRubric,
  ValidationResult,
  WeightTemplate,
} from "./model";
import { evaluateFormula } from "./formula";

export interface CalculationRequest {
  input: CombinationSkuInput;
  template: WeightTemplate;
  layers: CalculationLayer[];
  rules: ModifierRule[];
  affixDefinitions: AffixDefinition[];
  qualityRubric: QualityRubric;
  overrides?: ManualOverride[];
  qualityOverrideTierKey?: string;
}

function numeric(value: ParameterValue | undefined, parameterKey: string): number {
  if (typeof value !== "number") throw new Error(`Parameter '${parameterKey}' must be numeric for this rule`);
  return value;
}

function calculateQuality(
  input: CombinationSkuInput,
  definitions: AffixDefinition[],
  rubric: QualityRubric,
  overrideTierKey?: string,
): AchievedQuality {
  const affixById = new Map(definitions.map((affix) => [affix.id, affix]));
  const ordered = input.affixes.map((selection) => {
    const definition = affixById.get(selection.affixId);
    if (!definition) throw new Error(`Unknown affix: ${selection.affixId}`);
    return { selection, definition, score: selection.scoreOverride ?? definition.score };
  });

  const factor = rubric.diminishingFactor ?? 0.85;
  let total = new Decimal(0);
  const contributions = ordered.map((item, index) => {
    const effectiveScore = rubric.aggregation === "DIMINISHING_RETURNS"
      ? new Decimal(item.score).times(new Decimal(factor).pow(index)).toNumber()
      : item.score;
    total = total.plus(effectiveScore);
    return {
      affixId: item.definition.id,
      name: item.definition.name,
      baseScore: item.score,
      effectiveScore,
    };
  });

  const score = total.toDecimalPlaces(2).toNumber();
  const automaticTier = rubric.tiers.find((tier) =>
    score >= tier.minimumScore && (tier.maximumScore === undefined || score <= tier.maximumScore)
  ) ?? rubric.tiers.at(-1);
  if (!automaticTier) throw new Error("Quality rubric has no tiers");

  const effectiveTier = overrideTierKey
    ? rubric.tiers.find((tier) => tier.key === overrideTierKey)
    : automaticTier;
  if (!effectiveTier) throw new Error(`Unknown quality override tier: ${overrideTierKey}`);

  return {
    automaticScore: score,
    automaticTier,
    effectiveTier,
    contributions,
    isOverridden: automaticTier.id !== effectiveTier.id,
  };
}

function validate(
  template: WeightTemplate,
  input: CombinationSkuInput,
  values: Record<string, ParameterValue>,
): ValidationResult[] {
  const results: ValidationResult[] = [];
  const nominalCovered = input.targetWeightMin <= template.nominalWeight && template.nominalWeight <= input.targetWeightMax;
  results.push({
    key: "target.nominal-covered",
    severity: "ERROR",
    passed: nominalCovered,
    message: nominalCovered ? "Target range contains template nominal weight" : "Target range misses template nominal weight",
    evidence: { nominalWeight: template.nominalWeight, minimum: input.targetWeightMin, maximum: input.targetWeightMax },
  });

  const withinSupportedRange = input.targetWeightMin >= template.coverageMin && input.targetWeightMax <= template.coverageMax;
  results.push({
    key: "target.within-template-range",
    severity: "WARNING",
    passed: withinSupportedRange,
    message: withinSupportedRange ? "Target range stays within template support" : "Target range extends outside template support",
    evidence: { coverageMin: template.coverageMin, coverageMax: template.coverageMax },
  });

  const rodPull = typeof values["rod.maxPull"] === "number" ? values["rod.maxPull"] : undefined;
  const reelPull = typeof values["reel.maxPull"] === "number" ? values["reel.maxPull"] : undefined;
  const linePull = typeof values["line.maxPull"] === "number" ? values["line.maxPull"] : undefined;
  if (rodPull !== undefined && reelPull !== undefined && linePull !== undefined && rodPull > 0 && reelPull > 0) {
    const safePull = Math.min(rodPull * 0.9, reelPull, linePull * 0.35);
    const reelRodRatio = reelPull / rodPull;
    const lineReelRatio = linePull / reelPull;
    results.push({
      key: "strength.safe-pull",
      severity: "INFO",
      passed: true,
      message: "Safe working pull calculated from the limiting component",
      evidence: { safePull },
    });
    results.push({
      key: "strength.match",
      severity: "WARNING",
      passed: reelRodRatio >= 0.55 && reelRodRatio <= 1.2 && lineReelRatio >= 1.4 && lineReelRatio <= 4,
      message: "Rod, reel, and line pull ratios should remain inside the configured envelope",
      evidence: { reelRodRatio, lineReelRatio },
    });
  }

  return results;
}

export function calculateSku(request: CalculationRequest): CalculatedSku {
  const selectedOptions = new Set(request.input.selectedOptionIds);
  const orderedLayers = [...request.layers].filter((layer) => layer.isEnabled).sort((a, b) => a.order - b.order);
  const layerOrder = new Map(orderedLayers.map((layer, index) => [layer.id, index]));
  const applicableRules = request.rules
    .filter((rule) => selectedOptions.has(rule.optionId) && layerOrder.has(rule.layerId))
    .sort((a, b) => (layerOrder.get(a.layerId)! - layerOrder.get(b.layerId)!) || a.priority - b.priority);

  const automatic: Record<string, ParameterValue> = { ...request.template.values };
  const traces: CalculatedSku["parameters"] = {};

  for (const [parameterKey, value] of Object.entries(automatic)) {
    traces[parameterKey] = {
      parameterKey,
      automaticValue: value,
      effectiveValue: value,
      trace: [],
      isOverridden: false,
    };
  }

  const affixById = new Map(request.affixDefinitions.map((affix) => [affix.id, affix]));
  const affixRules = request.input.affixes.flatMap((selection) => affixById.get(selection.affixId)?.rules ?? []);

  for (const rule of [...applicableRules, ...affixRules]) {
    const before = numeric(automatic[rule.parameterKey], rule.parameterKey);
    const operand = rule.operandMode === "FORMULA"
      ? evaluateFormula(String(rule.operand), {
          base: numeric(request.template.values[rule.parameterKey], rule.parameterKey),
          current: before,
          "target.min": request.input.targetWeightMin,
          "target.max": request.input.targetWeightMax,
          "template.nominalWeight": request.template.nominalWeight,
        })
      : Number(rule.operand);

    let after = before;
    if (rule.operation === "ADD") after = new Decimal(before).plus(operand).toNumber();
    if (rule.operation === "MULTIPLY") after = new Decimal(before).times(operand).toNumber();
    if (rule.operation === "SET") after = operand;
    if (rule.precision !== undefined) after = new Decimal(after).toDecimalPlaces(rule.precision).toNumber();

    automatic[rule.parameterKey] = after;
    traces[rule.parameterKey] ??= {
      parameterKey: rule.parameterKey,
      automaticValue: before,
      effectiveValue: before,
      trace: [],
      isOverridden: false,
    };
    traces[rule.parameterKey]!.automaticValue = after;
    traces[rule.parameterKey]!.effectiveValue = after;
    traces[rule.parameterKey]!.trace.push({
      layerId: rule.layerId,
      ruleId: rule.id,
      operation: rule.operation,
      operand,
      before,
      after,
    });
  }

  for (const override of request.overrides ?? []) {
    const computed = traces[override.parameterKey];
    if (!computed) {
      traces[override.parameterKey] = {
        parameterKey: override.parameterKey,
        automaticValue: automatic[override.parameterKey] ?? override.value,
        effectiveValue: override.value,
        trace: [],
        isOverridden: true,
      };
    } else {
      computed.effectiveValue = override.value;
      computed.isOverridden = true;
    }
  }

  const effectiveValues = Object.fromEntries(Object.values(traces).map((value) => [value.parameterKey, value.effectiveValue]));
  const quality = calculateQuality(request.input, request.affixDefinitions, request.qualityRubric, request.qualityOverrideTierKey);

  return {
    input: request.input,
    parameters: traces,
    quality,
    componentIds: {
      rod: `${request.input.comboCode}_R`,
      reel: `${request.input.comboCode}_W`,
      line: `${request.input.comboCode}_L`,
    },
    validations: validate(request.template, request.input, effectiveValues),
  };
}
