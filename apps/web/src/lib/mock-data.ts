import { parameterSeeds, type ParameterDefinition } from "@tackle-forger/domain";

export type { ParameterDefinition };
export type { WeightTemplate, ModifierRule, CalculationLayer, AffixDefinition } from "@tackle-forger/domain";

export const parameters: ParameterDefinition[] = parameterSeeds.map((parameter) => ({ ...parameter }));

export interface WeightTemplateRow {
  id: string;
  code: string;
  name: string;
  fishingMethod: string;
  weightBand: string;
  nominalWeight: number;
  coverageMin: number;
  coverageMax: number;
  values: Record<string, number | string>;
  notes: string;
}

export const templates: WeightTemplateRow[] = [
  {
    id: "T01", code: "T01", name: "微物标准", fishingMethod: "淡水路亚", weightBand: "微物",
    nominalWeight: 0.2, coverageMin: 0.1, coverageMax: 0.25,
    values: { "rod.length": 168, "rod.maxFishWeight": 250, "rod.lureWeightMin": 1, "rod.lureWeightMax": 5, "reel.maxPull": 800, "line.maxPull": 1500, "line.length": 15000 },
    notes: "微物精细作钓基准",
  },
  {
    id: "T05", code: "T05", name: "中型标准", fishingMethod: "淡水路亚", weightBand: "中型",
    nominalWeight: 4, coverageMin: 2.5, coverageMax: 6,
    values: { "rod.length": 213, "rod.maxFishWeight": 4000, "rod.lureWeightMin": 7, "rod.lureWeightMax": 21, "reel.maxPull": 4000, "line.maxPull": 9000, "line.length": 15000 },
    notes: "主流泛用基准段",
  },
  {
    id: "T08", code: "T08", name: "超重标准", fishingMethod: "淡水路亚", weightBand: "超重",
    nominalWeight: 25, coverageMin: 16, coverageMax: 32,
    values: { "rod.length": 225, "rod.maxFishWeight": 25000, "rod.lureWeightMin": 25, "rod.lureWeightMax": 80, "reel.maxPull": 9000, "line.maxPull": 22000, "line.length": 15000 },
    notes: "重装障碍基准段",
  },
  {
    id: "T12", code: "T12", name: "怪物标准", fishingMethod: "淡水路亚", weightBand: "怪物",
    nominalWeight: 100, coverageMin: 75, coverageMax: 100,
    values: { "rod.length": 229, "rod.maxFishWeight": 100000, "rod.lureWeightMin": 80, "rod.lureWeightMax": 300, "reel.maxPull": 23000, "line.maxPull": 45000, "line.length": 15000 },
    notes: "巨物段，外推区间",
  },
];

export interface RuleLayer {
  id: string;
  order: number;
  name: string;
  key: string;
  enabled: boolean;
  version: number;
  notes: string;
}

export const ruleLayers: RuleLayer[] = [
  { id: "L1", order: 1, name: "标准模板", key: "template", enabled: true, version: 1, notes: "钓法 × 大重量段的中性基准" },
  { id: "L2", order: 2, name: "定位 / 类型 / 材质", key: "position", enabled: true, version: 3, notes: "远投、精准、结构、线族" },
  { id: "L3", order: 3, name: "技术", key: "technology", enabled: true, version: 2, notes: "碳布、耐久、传动工艺" },
  { id: "L4", order: 4, name: "特殊系列", key: "series", enabled: true, version: 2, notes: "系列身份与专属词条" },
  { id: "L5", order: 5, name: "功能定位", key: "function", enabled: true, version: 4, notes: "三级特化包" },
  { id: "L6", order: 6, name: "性能定位", key: "performance", enabled: true, version: 3, notes: "纵向工艺增益" },
  { id: "L7", order: 7, name: "特殊规则", key: "special", enabled: true, version: 1, notes: "高层数可浮动或覆盖低层数" },
  { id: "L8", order: 8, name: "手工筛选", key: "manual", enabled: true, version: 1, notes: "精调、对比、采纳或驳回" },
];

export interface ModifierRuleCell {
  optionId: string;
  parameterKey: string;
  operation: "ADD" | "MULTIPLY" | "SET";
  operand: number;
  notes: string;
}

export interface DimensionOption {
  id: string;
  catalog: string;
  key: string;
  name: string;
  level?: number;
  notes: string;
}

export const dimensionOptions: DimensionOption[] = [
  { id: "POS-LONG", catalog: "定位", key: "long-cast", name: "远投", notes: "牺牲精度换距离" },
  { id: "POS-PRECISE", catalog: "定位", key: "precise", name: "精准", notes: "近距精细作钓" },
  { id: "POS-LIGHT", catalog: "定位", key: "light-sens", name: "轻量灵敏", notes: "轻饵高感度" },
  { id: "POS-OBS", catalog: "定位", key: "obstacle", name: "障碍控鱼", notes: "强拉防挂" },
  { id: "TYPE-SPIN", catalog: "类型", key: "spinning", name: "纺车 + 直柄", notes: "通用广覆盖" },
  { id: "TYPE-BC", catalog: "类型", key: "baitcast", name: "水滴 + 枪柄", notes: "精确抛投" },
  { id: "TECH-CARBON", catalog: "技术", key: "carbon-layup", name: "特种碳纤维", notes: "高回弹低自重" },
  { id: "TECH-WEAR", catalog: "技术", key: "abrasion", name: "超耐磨", notes: "线材工艺" },
  { id: "SER-DEEP", catalog: "系列", key: "deep-flow", name: "深流·远投", notes: "远投专属系列" },
  { id: "SER-ABYSS", catalog: "系列", key: "abyss", name: "深渊·征服", notes: "巨物专属系列" },
];

export const modifierRules: ModifierRuleCell[] = [
  { optionId: "POS-LONG", parameterKey: "rod.distanceCoeff", operation: "ADD", operand: 8, notes: "远投增益" },
  { optionId: "POS-LONG", parameterKey: "rod.length", operation: "MULTIPLY", operand: 1.05, notes: "略加长" },
  { optionId: "POS-PRECISE", parameterKey: "rod.sensitivity", operation: "ADD", operand: 5, notes: "感度提升" },
  { optionId: "POS-OBS", parameterKey: "rod.maxFishWeight", operation: "MULTIPLY", operand: 1.1, notes: "强拉" },
  { optionId: "TECH-CARBON", parameterKey: "rod.weight", operation: "MULTIPLY", operand: 0.92, notes: "减重" },
  { optionId: "TECH-CARBON", parameterKey: "rod.durability", operation: "ADD", operand: 10, notes: "耐久提升" },
  { optionId: "TECH-WEAR", parameterKey: "line.durability", operation: "MULTIPLY", operand: 1.3, notes: "耐磨" },
];

export interface AffixRow {
  id: string;
  key: string;
  name: string;
  kind: "ATTRIBUTE" | "PASSIVE";
  score: number;
  scope: "杆" | "轮" | "线" | "通用";
  description: string;
  tags: string[];
}

export const affixes: AffixRow[] = [
  { id: "A1", key: "cast-acc-10", name: "+10 抛投精度", kind: "ATTRIBUTE", score: 3, scope: "杆", description: "直接增加抛投能力系数", tags: ["抛投"] },
  { id: "A2", key: "cast-dist-5", name: "+5 抛投距离", kind: "ATTRIBUTE", score: 3, scope: "杆", description: "直接增加抛投距离参数", tags: ["抛投"] },
  { id: "A3", key: "impact-resist", name: "抗冲击", kind: "PASSIVE", score: 6, scope: "杆", description: "博鱼时降低断杆概率", tags: ["博鱼"] },
  { id: "A4", key: "drag-cool", name: "散热传动", kind: "PASSIVE", score: 6, scope: "轮", description: "长时间卸力不衰减", tags: ["耐久"] },
  { id: "A5", key: "anti-wear", name: "超耐磨", kind: "PASSIVE", score: 5, scope: "线", description: "耐磨耗大幅提升", tags: ["耐久"] },
  { id: "A6", key: "low-wind", name: "低风阻", kind: "PASSIVE", score: 5, scope: "线", description: "逆风抛投距离衰减降低", tags: ["抛投"] },
  { id: "A7", key: "high-modulus", name: "特种碳纤维", kind: "PASSIVE", score: 8, scope: "杆", description: "高模量碳布，回弹与轻量兼得", tags: ["轻量", "回弹"] },
  { id: "A8", key: "reinf-frame", name: "强化骨架", kind: "PASSIVE", score: 6, scope: "轮", description: "整体刚性提升", tags: ["强度"] },
];

export interface SkuRow {
  id: string;
  comboCode: string;
  platformId: string;
  platformPositioning: string;
  templateId: string;
  targetWeightMin: number;
  targetWeightMax: number;
  seriesName: string;
  quality: "绿" | "蓝" | "紫" | "金";
  score: number;
  selectedOptions: string[];
  affixes: string[];
  rodPull: number;
  reelPull: number;
  linePull: number;
  price: number;
  status: "草稿" | "待评审" | "已发布";
  usageScenario: string;
}

export const skus: SkuRow[] = [
  { id: "FW-01", comboCode: "FW-01", platformId: "P01", platformPositioning: "微物 / BFS", templateId: "T01", targetWeightMin: 0.1, targetWeightMax: 0.3, seriesName: "青芦·入门", quality: "绿", score: 2.5, selectedOptions: ["TYPE-SPIN"], affixes: ["A1"], rodPull: 800, reelPull: 800, linePull: 1500, price: 515, status: "已发布", usageScenario: "溪流微物精细" },
  { id: "FW-12", comboCode: "FW-12", platformId: "P03", platformPositioning: "中型泛用", templateId: "T05", targetWeightMin: 2.5, targetWeightMax: 6, seriesName: "青芦·标准", quality: "蓝", score: 7.5, selectedOptions: ["TYPE-SPIN", "POS-LONG"], affixes: ["A1", "A2"], rodPull: 3600, reelPull: 4000, linePull: 9000, price: 790, status: "已发布", usageScenario: "湖库泛用" },
  { id: "FW-24", comboCode: "FW-24", platformId: "P06", platformPositioning: "超重远投", templateId: "T08", targetWeightMin: 16, targetWeightMax: 32, seriesName: "深流·远投", quality: "紫", score: 17.2, selectedOptions: ["TYPE-BC", "POS-LONG", "TECH-CARBON"], affixes: ["A2", "A3", "A6"], rodPull: 8200, reelPull: 9000, linePull: 22000, price: 1740, status: "待评审", usageScenario: "远投重装障碍" },
  { id: "FW-30", comboCode: "FW-30", platformId: "P08", platformPositioning: "巨物征服", templateId: "T12", targetWeightMin: 75, targetWeightMax: 100, seriesName: "深渊·征服", quality: "金", score: 22.4, selectedOptions: ["TYPE-BC", "POS-OBS", "TECH-WEAR"], affixes: ["A3", "A5", "A4"], rodPull: 23000, reelPull: 23000, linePull: 45000, price: 3950, status: "待评审", usageScenario: "巨物强拉" },
];

export interface QualityTierRow {
  key: string;
  name: string;
  min: number;
  max: number;
  color: string;
}

export const qualityTiers: QualityTierRow[] = [
  { key: "green", name: "绿", min: 0, max: 4.99, color: "#49c779" },
  { key: "blue", name: "蓝", min: 5, max: 9.99, color: "#57a9e8" },
  { key: "purple", name: "紫", min: 10, max: 19.99, color: "#9a70e8" },
  { key: "gold", name: "金", min: 20, max: 999, color: "#e0ad4e" },
];

export interface ReviewRow {
  id: string;
  skuId: string;
  issue: string;
  severity: "高" | "中" | "低";
  field: string;
  before: number;
  after: number;
  reviewer: string;
  reason: string;
  createdAt: string;
}

export const reviews: ReviewRow[] = [
  { id: "R1", skuId: "FW-24", issue: "强度比例失衡", severity: "高", field: "reel.maxPull", before: 9000, after: 9500, reviewer: "设计师·林", reason: "轮拉力略低于杆，补齐比例", createdAt: "2026-07-15" },
  { id: "R2", skuId: "FW-30", issue: "覆盖缺口", severity: "中", field: "targetWeightMin", before: 75, after: 70, reviewer: "设计师·陈", reason: "衔接上一段区间", createdAt: "2026-07-15" },
  { id: "R3", skuId: "FW-12", issue: "抛投感度偏低", severity: "低", field: "rod.sensitivity", before: 50, after: 55, reviewer: "设计师·林", reason: "用户反馈手感发闷", createdAt: "2026-07-14" },
];

export interface ProposalRow {
  id: string;
  summary: string;
  scope: string;
  affected: number;
  confidence: number;
  status: "待审批" | "已采纳" | "已驳回";
}

export const proposals: ProposalRow[] = [
  { id: "PR1", summary: "障碍控鱼场景：杆拉力 ×1.1 改为 ×1.08", scope: "规则层 L2 · 障碍控鱼", affected: 12, confidence: 0.86, status: "待审批" },
  { id: "PR2", summary: "深流系列统一附加『低风阻』词条", scope: "系列 L4 · 深流·远投", affected: 6, confidence: 0.72, status: "待审批" },
  { id: "PR3", summary: "金品质感度下限设为 60", scope: "校验 · 品质规则", affected: 9, confidence: 0.65, status: "待审批" },
];

export function parameterByKey(key: string): ParameterDefinition | undefined {
  return parameters.find((parameter) => parameter.key === key);
}

export function templateById(id: string): WeightTemplateRow | undefined {
  return templates.find((template) => template.id === id);
}

export function optionById(id: string): DimensionOption | undefined {
  return dimensionOptions.find((option) => option.id === id);
}

export function affixById(id: string): AffixRow | undefined {
  return affixes.find((affix) => affix.id === id);
}
