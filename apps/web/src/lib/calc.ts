import {
  calculateSku,
  type AffixDefinition,
  type CalculationLayer,
  type CombinationSkuInput,
  type ManualOverride,
  type ModifierRule,
  type ParameterValue,
  type QualityRubric,
  type ValueTraceStep,
  type ValidationResult,
  type WeightTemplate,
} from "@tackle-forger/domain";
import {
  dimensionOptions,
  modifierRules,
  qualityTiers,
  ruleLayers,
  templates,
  type DimensionOption,
  type ModifierRuleCell,
  type RuleLayer,
  type WeightTemplateRow,
} from "./mock-data";

const LAYER_BY_CATALOG: Record<string, string> = {
  定位: "L2", 类型: "L2", 技术: "L3", 系列: "L4",
};

function domainLayers(): CalculationLayer[] {
  return ruleLayers.map((layer: RuleLayer) => ({
    id: layer.id, key: layer.key, name: layer.name, order: layer.order,
    isEnabled: layer.enabled, version: layer.version, notes: layer.notes,
  }));
}

function domainRules(): ModifierRule[] {
  return modifierRules.map((rule: ModifierRuleCell, index) => {
    const option = dimensionOptions.find((item: DimensionOption) => item.id === rule.optionId);
    const layerId = option ? LAYER_BY_CATALOG[option.catalog] ?? "L2" : "L2";
    return {
      id: `R${index}`, layerId, optionId: rule.optionId, parameterKey: rule.parameterKey,
      operation: rule.operation, operandMode: "CONSTANT", operand: rule.operand,
      priority: 1, notes: rule.notes,
    };
  });
}

const AFFIX_RULES: Record<string, Array<{ parameterKey: string; operation: "ADD" | "MULTIPLY"; operand: number }>> = {
  A1: [{ parameterKey: "rod.distanceCoeff", operation: "ADD", operand: 10 }],
  A2: [{ parameterKey: "rod.distanceCoeff", operation: "ADD", operand: 5 }],
  A7: [{ parameterKey: "rod.weight", operation: "MULTIPLY", operand: 0.92 }, { parameterKey: "rod.durability", operation: "ADD", operand: 10 }],
  A8: [{ parameterKey: "reel.maxPull", operation: "MULTIPLY", operand: 1.05 }],
};

const AFFIX_META: Array<{ id: string; key: string; name: string; kind: "ATTRIBUTE" | "PASSIVE"; score: number; description: string; tags: string[] }> = [
  { id: "A1", key: "cast-acc-10", name: "+10 抛投精度", kind: "ATTRIBUTE", score: 3, description: "抛投精度", tags: ["抛投"] },
  { id: "A2", key: "cast-dist-5", name: "+5 抛投距离", kind: "ATTRIBUTE", score: 3, description: "抛投距离", tags: ["抛投"] },
  { id: "A3", key: "impact-resist", name: "抗冲击", kind: "PASSIVE", score: 6, description: "降低断杆概率", tags: ["博鱼"] },
  { id: "A4", key: "drag-cool", name: "散热传动", kind: "PASSIVE", score: 6, description: "卸力不衰减", tags: ["耐久"] },
  { id: "A5", key: "anti-wear", name: "超耐磨", kind: "PASSIVE", score: 5, description: "耐磨耗", tags: ["耐久"] },
  { id: "A6", key: "low-wind", name: "低风阻", kind: "PASSIVE", score: 5, description: "逆风衰减低", tags: ["抛投"] },
  { id: "A7", key: "high-modulus", name: "特种碳纤维", kind: "PASSIVE", score: 8, description: "高模量碳布", tags: ["轻量"] },
  { id: "A8", key: "reinf-frame", name: "强化骨架", kind: "PASSIVE", score: 6, description: "整体刚性", tags: ["强度"] },
];

function domainAffixes(selectedAffixIds: string[]): AffixDefinition[] {
  return selectedAffixIds
    .map((id) => AFFIX_META.find((affix) => affix.id === id))
    .filter((affix): affix is NonNullable<typeof affix> => Boolean(affix))
    .map((affix) => ({
      id: affix.id, key: affix.key, name: affix.name, kind: affix.kind, score: affix.score,
      description: affix.description, tags: affix.tags,
      rules: (AFFIX_RULES[affix.id] ?? []).map((rule, index) => ({
        id: `${affix.id}-r${index}`, layerId: "L4", optionId: affix.id,
        parameterKey: rule.parameterKey, operation: rule.operation, operandMode: "CONSTANT",
        operand: rule.operand, priority: 1, notes: affix.name,
      })),
    }));
}

function domainRubric(): QualityRubric {
  return {
    id: "rubric", name: "词条评分", version: 1, aggregation: "SUM",
    tiers: qualityTiers.map((tier) => ({
      id: tier.key, key: tier.key, name: tier.name, minimumScore: tier.min,
      maximumScore: tier.max === 999 ? undefined : tier.max, color: tier.color,
    })),
  };
}

function domainTemplate(template: WeightTemplateRow, referencedKeys: Set<string>): WeightTemplate {
  const values: Record<string, ParameterValue> = { ...template.values };
  for (const key of referencedKeys) {
    if (values[key] === undefined) values[key] = 0;
  }
  if (values["rod.maxPull"] === undefined && typeof values["rod.maxFishWeight"] === "number") {
    values["rod.maxPull"] = Math.round((values["rod.maxFishWeight"] as number) * 0.9);
  }
  return {
    id: template.id, key: template.code, name: template.name, fishingMethod: template.fishingMethod,
    weightBand: template.weightBand, nominalWeight: template.nominalWeight,
    coverageMin: template.coverageMin, coverageMax: template.coverageMax, notes: template.notes, values,
  };
}

function referencedParameterKeys(): Set<string> {
  const keys = new Set<string>();
  for (const rule of modifierRules) keys.add(rule.parameterKey);
  for (const affixRules of Object.values(AFFIX_RULES)) for (const rule of affixRules) keys.add(rule.parameterKey);
  keys.add("rod.maxPull"); keys.add("reel.maxPull"); keys.add("line.maxPull");
  return keys;
}

export interface SkuComputation {
  parameters: Array<{ key: string; label: string; automatic: number; effective: number; overridden: boolean; trace: ValueTraceStep[] }>;
  quality: { score: number; tier: string; contributions: Array<{ name: string; score: number }> };
  componentIds: { rod: string; reel: string; line: string };
  safePull: number;
  validations: ValidationResult[];
  pulls: { rod: number; reel: number; line: number };
}

const PARAM_LABELS: Record<string, string> = {
  "rod.maxPull": "杆最大拉力", "reel.maxPull": "轮最大拉力", "line.maxPull": "线最大拉力",
  "rod.distanceCoeff": "抛投能力系数", "rod.weight": "杆自重", "rod.durability": "杆耐久",
  "reel.durability": "轮耐久", "line.durability": "线耐久",
};

export function computeSku(input: {
  comboCode: string;
  templateId: string;
  targetWeightMin: number;
  targetWeightMax: number;
  selectedOptions: string[];
  selectedAffixes: string[];
  overrides?: ManualOverride[];
}): SkuComputation | null {
  const templateRow = templates.find((item) => item.id === input.templateId);
  if (!templateRow) return null;
  const template = domainTemplate(templateRow, referencedParameterKeys());

  const skuInput: CombinationSkuInput = {
    id: input.comboCode, comboCode: input.comboCode, platformId: "P", platformPositioning: "",
    templateId: template.id, targetWeightMin: input.targetWeightMin, targetWeightMax: input.targetWeightMax,
    seriesName: "", usageScenario: "", selectedOptionIds: input.selectedOptions,
    affixes: input.selectedAffixes.map((affixId) => ({ affixId, source: "SERIES" })),
  };

  const result = calculateSku({
    input: skuInput, template, layers: domainLayers(), rules: domainRules(),
    affixDefinitions: domainAffixes(input.selectedAffixes), qualityRubric: domainRubric(),
    overrides: input.overrides,
  });

  const num = (parameterKey: string) => {
    const computed = result.parameters[parameterKey];
    return typeof computed?.effectiveValue === "number" ? computed.effectiveValue : 0;
  };

  const rodPull = num("rod.maxPull");
  const reelPull = num("reel.maxPull");
  const linePull = num("line.maxPull");

  const parameters = Object.entries(result.parameters)
    .filter(([key]) => PARAM_LABELS[key])
    .map(([key, computed]) => ({
      key, label: PARAM_LABELS[key] ?? key,
      automatic: typeof computed.automaticValue === "number" ? computed.automaticValue : 0,
      effective: typeof computed.effectiveValue === "number" ? computed.effectiveValue : 0,
      overridden: computed.isOverridden, trace: computed.trace,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    parameters,
    quality: {
      score: result.quality.automaticScore,
      tier: result.quality.effectiveTier.name,
      contributions: result.quality.contributions.map((item) => ({ name: item.name, score: item.effectiveScore })),
    },
    componentIds: result.componentIds,
    safePull: Math.min(rodPull * 0.9, reelPull, linePull * 0.35),
    validations: result.validations,
    pulls: { rod: rodPull, reel: reelPull, line: linePull },
  };
}
