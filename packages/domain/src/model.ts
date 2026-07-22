export type EquipmentScope = "ROD" | "REEL" | "LINE" | "SHARED";
export type ParameterValueType = "DECIMAL" | "INTEGER" | "TEXT" | "BOOLEAN" | "ENUM";
export type RuleOperation = "ADD" | "MULTIPLY" | "SET";
export type RuleOperandMode = "CONSTANT" | "FORMULA";
export type ValidationSeverity = "ERROR" | "WARNING" | "INFO";

export interface ParameterDefinition {
  id: string;
  key: string;
  displayName: string;
  scope: EquipmentScope;
  valueType: ParameterValueType;
  unit?: string;
  category: string;
  precision?: number;
  minimum?: number;
  maximum?: number;
  enumOptions?: string[];
  sortOrder: number;
  isActive: boolean;
}

export type ParameterValue = number | string | boolean;
export type ParameterValues = Record<string, ParameterValue>;

export interface WeightTemplate {
  id: string;
  key: string;
  name: string;
  fishingMethod: string;
  weightBand: string;
  nominalWeight: number;
  coverageMin: number;
  coverageMax: number;
  notes: string;
  values: ParameterValues;
}

export interface DimensionCatalog {
  id: string;
  key: string;
  name: string;
  notes: string;
}

export interface DimensionOption {
  id: string;
  catalogId: string;
  parentOptionId?: string;
  key: string;
  name: string;
  level?: number;
  scope: EquipmentScope | "COMBINATION";
  notes: string;
}

export interface CalculationLayer {
  id: string;
  key: string;
  name: string;
  order: number;
  isEnabled: boolean;
  version: number;
  notes: string;
}

export interface ModifierRule {
  id: string;
  layerId: string;
  optionId: string;
  parameterKey: string;
  operation: RuleOperation;
  operandMode: RuleOperandMode;
  operand: number | string;
  condition?: string;
  priority: number;
  precision?: number;
  notes: string;
}

export interface AffixDefinition {
  id: string;
  key: string;
  name: string;
  kind: "ATTRIBUTE" | "PASSIVE";
  score: number;
  description: string;
  rules: ModifierRule[];
  tags: string[];
}

export interface SkuAffixSelection {
  affixId: string;
  source: "SERIES" | "SKU" | "GENERATED" | "MANUAL";
  scoreOverride?: number;
}

export interface QualityTier {
  id: string;
  key: string;
  name: string;
  minimumScore: number;
  maximumScore?: number;
  color: string;
}

export interface QualityRubric {
  id: string;
  name: string;
  version: number;
  aggregation: "SUM" | "DIMINISHING_RETURNS";
  diminishingFactor?: number;
  tiers: QualityTier[];
}

export interface CombinationSkuInput {
  id: string;
  comboCode: string;
  platformId: string;
  platformPositioning: string;
  templateId: string;
  targetWeightMin: number;
  targetWeightMax: number;
  seriesName: string;
  usageScenario: string;
  selectedOptionIds: string[];
  affixes: SkuAffixSelection[];
}

export interface ValueTraceStep {
  layerId: string;
  ruleId: string;
  operation: RuleOperation;
  operand: number;
  before: number;
  after: number;
}

export interface ComputedParameter {
  parameterKey: string;
  automaticValue: ParameterValue;
  effectiveValue: ParameterValue;
  trace: ValueTraceStep[];
  isOverridden: boolean;
}

export interface ManualOverride {
  parameterKey: string;
  value: ParameterValue;
  reason: string;
}

export interface AchievedQuality {
  automaticScore: number;
  automaticTier: QualityTier;
  effectiveTier: QualityTier;
  contributions: Array<{
    affixId: string;
    name: string;
    baseScore: number;
    effectiveScore: number;
  }>;
  isOverridden: boolean;
}

export interface ValidationResult {
  key: string;
  severity: ValidationSeverity;
  passed: boolean;
  message: string;
  evidence?: Record<string, number | string | boolean>;
}

export interface CalculatedSku {
  input: CombinationSkuInput;
  parameters: Record<string, ComputedParameter>;
  quality: AchievedQuality;
  componentIds: {
    rod: string;
    reel: string;
    line: string;
  };
  validations: ValidationResult[];
}
