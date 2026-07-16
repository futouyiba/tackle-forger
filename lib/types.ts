export type ItemKind = "rod" | "reel" | "line";
export type RuleOperation = "add" | "multiply" | "set" | "min" | "max" | "formula";
export type DimensionKey =
  | "structure"
  | "material"
  | "function"
  | "performance"
  | "technology"
  | "series";

export interface ParameterDefinition {
  key: string;
  label: string;
  itemKind: ItemKind;
  unit: string;
  precision: number;
  notes: string;
}

export interface WeightTemplate {
  id: string;
  name: string;
  fishMinKg: number;
  fishMaxKg: number;
  nominalFishKg: number;
  tier: string;
  values: Record<string, number | string>;
  notes: string;
}

export interface AdjustmentRule {
  id: string;
  parameterKey: string;
  operation: RuleOperation;
  value: number | string;
  condition?: string;
  notes?: string;
}

export interface ModifierOption {
  id: string;
  dimension: DimensionKey;
  name: string;
  level: number | string;
  itemKinds: ItemKind[];
  rules: AdjustmentRule[];
  notes: string;
  enabled: boolean;
}

export interface RuleLayer {
  id: string;
  name: string;
  order: number;
  enabled: boolean;
  mode: "selection" | "global";
  dimension?: DimensionKey;
  optionIds: string[];
  rules: AdjustmentRule[];
  notes: string;
}

export interface Affix {
  id: string;
  name: string;
  category: "stat" | "passive";
  itemKinds: ItemKind[];
  score: number;
  rarity: "common" | "rare" | "epic";
  tags: string[];
  exclusiveGroup?: string;
  conflicts: string[];
  synergies: string[];
  rules: AdjustmentRule[];
  description: string;
  notes: string;
  enabled: boolean;
}

export interface QualityBand {
  id: string;
  name: string;
  color: string;
  minScore: number;
  maxScore: number | null;
  priceIndex: number;
  notes: string;
}

export interface AffixScorePolicy {
  sameAxisFactors: number[];
  synergyBonus: number;
  conflictPenalty: number;
  passiveWeight: number;
  directWeight: number;
  notes: string;
}

export interface SeriesRecipe {
  id: string;
  name: string;
  platformId: string;
  platformPosition: string;
  templateIds: string[];
  structureIds: string[];
  functionIds: string[];
  performanceIds: string[];
  technologyIds: string[];
  requiredAffixIds: string[];
  optionalAffixPoolIds: string[];
  optionalSlots: number;
  qualityTarget: string;
  fishMinKg: number;
  fishMaxKg: number;
  useScene: string;
  maxCandidates: number;
  notes: string;
  enabled: boolean;
}

export interface CandidateSelections {
  structureId?: string;
  materialId?: string;
  functionId?: string;
  performanceId?: string;
  technologyIds: string[];
  seriesId?: string;
}

export interface CalculationTraceItem {
  layer: string;
  source: string;
  parameterKey: string;
  operation: RuleOperation | "quality";
  before: number | string | null;
  operand: number | string;
  after: number | string | null;
}

export interface QualityResult {
  rawScore: number;
  finalScore: number;
  qualityId: string;
  contributions: Array<{
    affixId: string;
    base: number;
    factor: number;
    score: number;
    note: string;
  }>;
  bonuses: string[];
  penalties: string[];
}

export interface ValidationIssue {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  parameterKey?: string;
}

export interface CalculatedEquipment {
  values: Record<string, number | string>;
  quality: QualityResult;
  trace: CalculationTraceItem[];
  issues: ValidationIssue[];
  safeWorkingForce: number;
  priceIndex: number;
}

export interface Candidate {
  id: string;
  recipeId: string;
  comboId: string;
  platformId: string;
  platformPosition: string;
  seriesName: string;
  templateId: string;
  fishMinKg: number;
  fishMaxKg: number;
  selections: CandidateSelections;
  affixIds: string[];
  useScene: string;
  toneOverride?: string;
  hardnessOverride?: string;
  lengthOverride?: number;
  overrides: Record<string, number | string>;
  status: "candidate" | "shortlisted" | "rejected" | "published";
  calculated: CalculatedEquipment;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfficialSku {
  id: string;
  candidateId: string;
  comboId: string;
  platformId: string;
  platformPosition: string;
  templateId: string;
  seriesName: string;
  qualityId: string;
  fishMinKg: number;
  fishMaxKg: number;
  structureName: string;
  functionName: string;
  functionLevel: string;
  performanceName: string;
  performanceLevel: string;
  affixIds: string[];
  tone: string;
  hardness: string;
  lengthM: number;
  useScene: string;
  rodId: string;
  reelId: string;
  lineId: string;
  priceIndex: number;
  rodForce: number;
  reelForce: number;
  lineForce: number;
  safeWorkingForce: number;
  values: Record<string, number | string>;
  overrides: Record<string, number | string>;
  notes: string;
  publishedAt: string;
}

export interface DetailOverride {
  skuId: string;
  itemKind: ItemKind;
  model: string;
  name: string;
  values: Record<string, number | string>;
  notes: string;
}

export interface RevisionInfo {
  revision: number;
  author: string;
  message: string;
  createdAt: string;
}

export interface WorkspaceState {
  schemaVersion: number;
  parameters: ParameterDefinition[];
  templates: WeightTemplate[];
  modifiers: ModifierOption[];
  layers: RuleLayer[];
  affixes: Affix[];
  qualityBands: QualityBand[];
  affixScorePolicy: AffixScorePolicy;
  recipes: SeriesRecipe[];
  candidates: Candidate[];
  officialSkus: OfficialSku[];
  detailOverrides: DetailOverride[];
  revisions: RevisionInfo[];
  notes: string;
  importedAt: string;
}

export interface ApiStatePayload {
  state: WorkspaceState;
  revision: number;
  user: {
    email: string;
    name: string;
    role: "admin" | "editor" | "viewer";
  };
}
