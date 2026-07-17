import source from "@/data/imported-workbooks.json";
import type {
  AdjustmentRule,
  Affix,
  Candidate,
  DimensionKey,
  ItemKind,
  ModifierOption,
  ParameterDefinition,
  QualityBand,
  RuleLayer,
  SeriesRecipe,
  WeightTemplate,
  WorkspaceState,
} from "./types";
import { defaultRuleGraphs } from "./workflow";

type Cell = string | number | boolean | null;
type SheetData = { values: Cell[][]; formulas: Cell[][] };
const sheets = source as Record<string, SheetData>;

const importedAt = "2026-07-16T00:00:00.000Z";
const templateValues = sheets["主表/01重量模板"].values;

function itemKindFor(label: string): ItemKind {
  if (
    label.startsWith("轮") ||
    label.startsWith("上线量") ||
    label.startsWith("传动比") ||
    label.startsWith("PE号") ||
    label.startsWith("耐力值") ||
    label.startsWith("过热")
  ) return "reel";
  if (
    label.startsWith("线") ||
    label.startsWith("PE线号") ||
    label.startsWith("基础材质") ||
    label.startsWith("浮沉")
  ) return "line";
  return "rod";
}

function unitFor(label: string): string {
  if (label.includes("kgf")) return "kgf";
  if (label.endsWith("kg")) return "kg";
  if (label.includes("重量g") || label.includes("饵重")) return "g";
  if (label.includes("长m") || label.includes("上线量m")) return "m";
  if (label.includes("指数") || label.includes("基础") || label.includes("加成")) return "指数";
  if (label.includes("号")) return "号";
  return "";
}

function precisionFor(label: string): number {
  if (label.includes("重量g") || label.includes("耐力")) return 0;
  if (label.includes("指数") || label.includes("基础") || label.includes("加成")) return 3;
  return 2;
}

export const parameterDefinitions: ParameterDefinition[] = (templateValues[2] as string[])
  .slice(5)
  .filter(Boolean)
  .map((label) => ({
    key: label,
    label,
    itemKind: itemKindFor(label),
    unit: unitFor(label),
    precision: precisionFor(label),
    notes: "由《淡水路亚杆轮线装备设计》重量模板导入，可在参数管理中改名或删除。",
  }));

export const weightTemplates: WeightTemplate[] = templateValues
  .slice(3)
  .filter((row) => typeof row[0] === "string" && row[0])
  .map((row) => {
    const values: Record<string, number | string> = {};
    (templateValues[2] as string[]).slice(5).forEach((header, offset) => {
      const value = row[offset + 5];
      if (header && value !== null && value !== undefined) {
        values[header] = value as number | string;
      }
    });
    return {
      id: String(row[0]),
      name: String(row[4] ?? row[0]),
      fishMinKg: Number(row[1] ?? 0),
      fishMaxKg: Number(row[2] ?? 0),
      nominalFishKg: Number(row[3] ?? 0),
      tier: String(row[4] ?? ""),
      values,
      notes: "主表导入的中性杆+轮+线基准。",
    };
  });

const parameterAlias: Record<string, string[]> = {
  "杆长": ["杆长m"],
  "杆拉力": ["杆最大拉力kgf"],
  "饵重下限": ["饵重下限g"],
  "饵重上限": ["饵重上限g"],
  "杆抛投": ["杆抛投基础"],
  "杆耐力": ["杆最大耐力"],
  "杆自重": ["杆自重g"],
  "回弹": ["回弹指数"],
  "轮自重": ["轮自重g"],
  "轮拉力": ["轮最大拉力kgf"],
  "适用线号": ["PE号下限", "PE号上限"],
  "上线量": ["上线量m"],
  "传动比": ["传动比"],
  "轮抛投": ["轮抛投基础"],
  "轮耐力": ["轮最大耐力"],
  "耐力加成": ["耐力值加成"],
  "过热保护": ["过热保护指数"],
  "线拉力": ["线最大拉力kgf"],
  "线号": ["PE线号"],
  "线张力": ["线张力指数"],
  "线抛投": ["线抛投基础"],
};

function headerRules(
  prefix: string,
  header: string,
  value: Cell,
  rowIndex: number,
): AdjustmentRule[] {
  if (typeof value !== "number") return [];
  const operation = header.endsWith("+") ? "add" : "multiply";
  const base = header.replace(/[+×]$/, "");
  const parameters = parameterAlias[base] ?? [base];
  return parameters.map((parameterKey, index) => ({
    id: prefix + "-r" + rowIndex + "-" + index + "-" + parameterKey,
    parameterKey,
    operation,
    value,
    notes: "从 Excel 系数矩阵导入。",
  }));
}

function parseModifierSheet(
  sheetName: string,
  dimension: DimensionKey,
  endRow?: number,
): ModifierOption[] {
  const rows = sheets["主表/" + sheetName].values;
  const headers = rows[2] as string[];
  return rows
    .slice(3, endRow)
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => typeof row[0] === "string" && row[0])
    .map(({ row, index }) => {
      const id = dimension + ":" + String(row[0]);
      const rules = headers
        .slice(3, 24)
        .flatMap((header, offset) =>
          headerRules(id, String(header ?? ""), row[offset + 3], index),
        );
      return {
        id,
        dimension,
        name: String(row[1] ?? row[0]),
        level: (row[2] ?? "—") as string | number,
        itemKinds: ["rod", "reel", "line"],
        rules,
        notes: String(row[24] ?? ""),
        enabled: true,
      };
    });
}

const structureModifiers = parseModifierSheet("02类型材质", "structure", 5);
const functionModifiers = parseModifierSheet("03功能定位", "function");
const performanceModifiers = parseModifierSheet("04性能定位", "performance");

const materialRows = sheets["主表/02类型材质"].values.slice(9, 12);
const materialModifiers: ModifierOption[] = materialRows.map((row, index) => ({
  id: "material:" + String(row[0]),
  dimension: "material",
  name: String(row[1]),
  level: "—",
  itemKinds: ["line"],
  rules: [
    {
      id: "material-" + index + "-force",
      parameterKey: "线最大拉力kgf",
      operation: "multiply",
      value: Number(row[2]),
      notes: "同线号强度口径。",
    },
    {
      id: "material-" + index + "-number",
      parameterKey: "PE线号",
      operation: "multiply",
      value: Number(row[3]),
      notes: "等强线号换算口径。",
    },
    {
      id: "material-" + index + "-tension",
      parameterKey: "线张力指数",
      operation: "multiply",
      value: Number(row[4]),
    },
    {
      id: "material-" + index + "-cast",
      parameterKey: "线抛投基础",
      operation: "add",
      value: Number(row[5]),
    },
    {
      id: "material-" + index + "-base",
      parameterKey: "基础材质",
      operation: "set",
      value: String(row[1]),
    },
    {
      id: "material-" + index + "-sink",
      parameterKey: "浮沉属性",
      operation: "set",
      value: String(row[8]),
    },
  ],
  notes: String(row[9] ?? ""),
  enabled: true,
}));

const technologyModifiers: ModifierOption[] = [
  {
    id: "technology:特种碳纤维",
    dimension: "technology",
    name: "特种碳纤维",
    level: 1,
    itemKinds: ["rod"],
    rules: [
      { id: "tech-carbon-weight", parameterKey: "杆自重g", operation: "multiply", value: 0.9 },
      { id: "tech-carbon-rebound", parameterKey: "回弹指数", operation: "multiply", value: 1.08 },
      { id: "tech-carbon-force", parameterKey: "杆最大拉力kgf", operation: "multiply", value: 1.04 },
    ],
    notes: "示例技术层：轻量并提升回弹，拉力小幅增加。",
    enabled: true,
  },
  {
    id: "technology:强化齿组",
    dimension: "technology",
    name: "强化齿组",
    level: 1,
    itemKinds: ["reel"],
    rules: [
      { id: "tech-gear-force", parameterKey: "轮最大拉力kgf", operation: "multiply", value: 1.08 },
      { id: "tech-gear-dur", parameterKey: "轮最大耐力", operation: "multiply", value: 1.1 },
      { id: "tech-gear-weight", parameterKey: "轮自重g", operation: "multiply", value: 1.03 },
    ],
    notes: "示例技术层：强度和耐久提升，付出重量代价。",
    enabled: true,
  },
  {
    id: "technology:纳米耐磨涂层",
    dimension: "technology",
    name: "纳米耐磨涂层",
    level: 1,
    itemKinds: ["line"],
    rules: [
      { id: "tech-line-force", parameterKey: "线最大拉力kgf", operation: "multiply", value: 1.05 },
      { id: "tech-line-cast", parameterKey: "线抛投基础", operation: "add", value: -0.01 },
    ],
    notes: "示例技术层：耐磨增益伴随轻微抛投损失。",
    enabled: true,
  },
];

export const modifiers: ModifierOption[] = [
  ...structureModifiers,
  ...materialModifiers,
  ...functionModifiers,
  ...performanceModifiers,
  ...technologyModifiers,
];

export const defaultLayers: RuleLayer[] = [
  { id: "layer-baseline", name: "基准模板", order: 10, enabled: true, mode: "global", optionIds: [], rules: [], notes: "钓法 × 大重量段的标准杆轮线。" },
  { id: "layer-structure", name: "结构类型", order: 20, enabled: true, mode: "selection", dimension: "structure", optionIds: [], rules: [], notes: "枪柄/直柄与水滴/纺车结构差异。" },
  { id: "layer-material", name: "类型材质", order: 30, enabled: true, mode: "selection", dimension: "material", optionIds: [], rules: [], notes: "默认 SKU 不暴露线材选择，但材质仍可作为高级规则层。" },
  { id: "layer-function", name: "功能定位", order: 40, enabled: true, mode: "selection", dimension: "function", optionIds: [], rules: [], notes: "远投、操控、强攻等横向取舍。" },
  { id: "layer-performance", name: "性能定位", order: 50, enabled: true, mode: "selection", dimension: "performance", optionIds: [], rules: [], notes: "轻量、回弹、耐久等工艺投入。" },
  { id: "layer-technology", name: "技术与特殊系列", order: 60, enabled: true, mode: "selection", dimension: "technology", optionIds: [], rules: [], notes: "可叠加多项技术。" },
  { id: "layer-series", name: "系列共性", order: 70, enabled: true, mode: "selection", dimension: "series", optionIds: [], rules: [], notes: "从精调中沉淀的系列级共性。" },
  { id: "layer-affix", name: "词条效果", order: 80, enabled: true, mode: "global", optionIds: [], rules: [], notes: "SKU 指定词条；词条同时改变属性并贡献品质分。" },
  { id: "layer-manual", name: "手工精调", order: 90, enabled: true, mode: "global", optionIds: [], rules: [], notes: "最后覆盖，候选池中的改单不会污染前层。" },
];

export const defaultAffixes: Affix[] = [
  {
    id: "affix-precision",
    name: "精准导向",
    category: "stat",
    itemKinds: ["rod", "reel"],
    score: 3,
    rarity: "common",
    tags: ["精准", "操控"],
    conflicts: [],
    synergies: ["affix-sensitive"],
    rules: [
      { id: "ap-rod", parameterKey: "杆抛投基础", operation: "add", value: 0.04 },
      { id: "ap-reel", parameterKey: "轮抛投基础", operation: "add", value: 0.02 },
    ],
    description: "直接提高抛投精度与操控稳定性。",
    notes: "",
    enabled: true,
  },
  {
    id: "affix-distance",
    name: "远投矩阵",
    category: "stat",
    itemKinds: ["rod", "reel", "line"],
    score: 5,
    rarity: "rare",
    tags: ["远投", "抛投"],
    conflicts: ["affix-impact"],
    synergies: ["affix-light"],
    rules: [
      { id: "ad-rod", parameterKey: "杆抛投基础", operation: "add", value: 0.06 },
      { id: "ad-reel", parameterKey: "轮抛投基础", operation: "add", value: 0.05 },
      { id: "ad-line", parameterKey: "线抛投基础", operation: "add", value: 0.03 },
    ],
    description: "线杯、导环和线组共同优化，显著提高抛投距离。",
    notes: "",
    enabled: true,
  },
  {
    id: "affix-impact",
    name: "抗冲击",
    category: "passive",
    itemKinds: ["rod", "reel", "line"],
    score: 6,
    rarity: "epic",
    tags: ["强攻", "防护"],
    conflicts: ["affix-distance"],
    synergies: ["affix-core"],
    rules: [
      { id: "ai-rod", parameterKey: "杆最大耐力", operation: "multiply", value: 1.12 },
      { id: "ai-reel", parameterKey: "轮最大耐力", operation: "multiply", value: 1.08 },
      { id: "ai-line", parameterKey: "线最大拉力kgf", operation: "multiply", value: 1.05 },
    ],
    description: "受到瞬时冲击时降低耐力损耗，属于被动机制词条。",
    notes: "",
    enabled: true,
  },
  {
    id: "affix-abrasion",
    name: "耐磨保护",
    category: "passive",
    itemKinds: ["line"],
    score: 4,
    rarity: "common",
    tags: ["耐久", "线"],
    conflicts: [],
    synergies: ["affix-core"],
    rules: [
      { id: "aa-force", parameterKey: "线最大拉力kgf", operation: "multiply", value: 1.04 },
      { id: "aa-tension", parameterKey: "线张力指数", operation: "multiply", value: 1.08 },
    ],
    description: "摩擦环境下延缓线材性能衰减。",
    notes: "",
    enabled: true,
  },
  {
    id: "affix-light",
    name: "轻量碳布",
    category: "stat",
    itemKinds: ["rod"],
    score: 6,
    rarity: "epic",
    tags: ["轻量", "回弹"],
    conflicts: ["affix-core"],
    synergies: ["affix-distance"],
    rules: [
      { id: "al-weight", parameterKey: "杆自重g", operation: "multiply", value: 0.9 },
      { id: "al-rebound", parameterKey: "回弹指数", operation: "multiply", value: 1.06 },
    ],
    description: "减轻杆体重量并提升启动回弹。",
    notes: "",
    enabled: true,
  },
  {
    id: "affix-thermal",
    name: "热衰减隔离",
    category: "passive",
    itemKinds: ["reel"],
    score: 5,
    rarity: "rare",
    tags: ["持久", "散热"],
    conflicts: [],
    synergies: ["affix-smooth"],
    rules: [
      { id: "at-heat", parameterKey: "过热保护指数", operation: "multiply", value: 1.12 },
      { id: "at-dur", parameterKey: "轮最大耐力", operation: "multiply", value: 1.05 },
    ],
    description: "高负载状态下延缓过热造成的性能下降。",
    notes: "",
    enabled: true,
  },
  {
    id: "affix-smooth",
    name: "顺滑齿组",
    category: "stat",
    itemKinds: ["reel"],
    score: 3,
    rarity: "common",
    tags: ["传动", "操控"],
    conflicts: [],
    synergies: ["affix-thermal"],
    rules: [
      { id: "as-ratio", parameterKey: "传动比", operation: "multiply", value: 1.03 },
      { id: "as-cast", parameterKey: "轮抛投基础", operation: "add", value: 0.02 },
    ],
    description: "提高传动顺畅度与出线稳定性。",
    notes: "",
    enabled: true,
  },
  {
    id: "affix-core",
    name: "高韧芯材",
    category: "passive",
    itemKinds: ["rod", "line"],
    score: 6,
    rarity: "epic",
    tags: ["强度", "巨物"],
    conflicts: ["affix-light"],
    synergies: ["affix-impact", "affix-abrasion"],
    rules: [
      { id: "ac-rod", parameterKey: "杆最大拉力kgf", operation: "multiply", value: 1.08 },
      { id: "ac-line", parameterKey: "线最大拉力kgf", operation: "multiply", value: 1.08 },
    ],
    description: "强化持续受力与峰值载荷承受能力。",
    notes: "",
    enabled: true,
  },
  {
    id: "affix-sensitive",
    name: "感度放大",
    category: "passive",
    itemKinds: ["rod", "line"],
    score: 5,
    rarity: "rare",
    tags: ["感度", "精细"],
    conflicts: [],
    synergies: ["affix-precision"],
    rules: [
      { id: "ase-rebound", parameterKey: "回弹指数", operation: "multiply", value: 1.06 },
      { id: "ase-tension", parameterKey: "线张力指数", operation: "multiply", value: 1.08 },
    ],
    description: "放大轻微触底、咬口与线组状态反馈。",
    notes: "",
    enabled: true,
  },
];

export const defaultQualityBands: QualityBand[] = [
  { id: "green", name: "绿", color: "#43b581", minScore: 0, maxScore: 7.99, priceIndex: 1, notes: "合格入门" },
  { id: "blue", name: "蓝", color: "#4f8cff", minScore: 8, maxScore: 15.99, priceIndex: 1.8, notes: "主力标准" },
  { id: "purple", name: "紫", color: "#9a6cff", minScore: 16, maxScore: 25.99, priceIndex: 3.6, notes: "专精高阶" },
  { id: "gold", name: "金", color: "#d79b2d", minScore: 26, maxScore: null, priceIndex: 7, notes: "顶级系列" },
];

function affixesForSeries(series: string, quality: string, fn: string, perf: string): string[] {
  const ids: string[] = [];
  if (fn.includes("远投")) ids.push("affix-distance");
  if (fn.includes("操控")) ids.push("affix-precision");
  if (fn.includes("障碍") || fn.includes("强攻")) ids.push("affix-impact");
  if (fn.includes("持久")) ids.push("affix-abrasion");
  if (fn.includes("精细") || series.includes("感度")) ids.push("affix-sensitive");
  if (fn.includes("大饵") || series.includes("巨物")) ids.push("affix-core");
  if (perf.includes("轻量")) ids.push("affix-light");
  if (perf.includes("散热") || perf.includes("耐久")) ids.push("affix-thermal");
  if (perf.includes("传动")) ids.push("affix-smooth");
  const targetCount = quality === "金" ? 5 : quality === "紫" ? 4 : quality === "蓝" ? 3 : 1;
  const fallback = ["affix-precision", "affix-abrasion", "affix-smooth", "affix-core", "affix-impact"];
  for (const id of fallback) {
    if (ids.length >= targetCount) break;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, targetCount);
}

const skuRows = sheets["主表/06组合SKU"].values;
const skuHeader = skuRows[2] as string[];
function skuValue(row: Cell[], name: string): Cell {
  return row[skuHeader.indexOf(name)];
}

const seriesGroups = new Map<string, Cell[][]>();
for (const row of skuRows.slice(3)) {
  if (!row[0]) continue;
  const key = String(skuValue(row, "系列"));
  seriesGroups.set(key, [...(seriesGroups.get(key) ?? []), row]);
}

export const defaultRecipes: SeriesRecipe[] = Array.from(seriesGroups.entries()).map(
  ([series, rows], index) => {
    const first = rows[0];
    const quality = String(skuValue(first, "品质"));
    const fn = String(skuValue(first, "功能定位"));
    const perf = String(skuValue(first, "性能定位"));
    const required = affixesForSeries(series, quality, fn, perf);
    return {
      id: "recipe-" + String(index + 1).padStart(2, "0"),
      name: series,
      platformId: String(skuValue(first, "平台ID")),
      platformPosition: String(skuValue(first, "平台定位")),
      templateIds: Array.from(new Set(rows.map((row) => String(skuValue(row, "模板ID"))))),
      structureIds: Array.from(new Set(rows.map((row) => "structure:" + String(skuValue(row, "结构类型"))))),
      functionIds: Array.from(new Set(rows.map((row) => "function:" + String(skuValue(row, "功能定位")) + "|" + String(skuValue(row, "功能级"))))),
      performanceIds: Array.from(new Set(rows.map((row) => "performance:" + String(skuValue(row, "性能定位")) + "|" + String(skuValue(row, "性能级"))))),
      technologyIds: [],
      requiredAffixIds: required,
      optionalAffixPoolIds: defaultAffixes.map((affix) => affix.id).filter((id) => !required.includes(id)),
      optionalSlots: quality === "金" ? 2 : quality === "紫" ? 1 : 0,
      qualityTarget: quality,
      fishMinKg: Math.min(...rows.map((row) => Number(skuValue(row, "鱼重下限kg")))),
      fishMaxKg: Math.max(...rows.map((row) => Number(skuValue(row, "鱼重上限kg")))),
      useScene: String(skuValue(first, "使用场景")),
      maxCandidates: 50,
      notes: "由 06组合SKU 聚合为系列生成配方；词条已按系列定位补全。",
      enabled: true,
    };
  },
);

function emptyCalculated() {
  return {
    values: {},
    quality: {
      rawScore: 0,
      finalScore: 0,
      qualityId: "green",
      contributions: [],
      bonuses: [],
      penalties: [],
    },
    trace: [],
    issues: [],
    safeWorkingForce: 0,
    priceIndex: 1,
  };
}

export const importedCandidates: Candidate[] = skuRows
  .slice(3)
  .filter((row) => row[0])
  .map((row, index) => {
    const series = String(skuValue(row, "系列"));
    const quality = String(skuValue(row, "品质"));
    const fn = String(skuValue(row, "功能定位"));
    const perf = String(skuValue(row, "性能定位"));
    const recipe = defaultRecipes.find((item) => item.name === series);
    return {
      id: "candidate-import-" + String(index + 1).padStart(3, "0"),
      recipeId: recipe?.id ?? "",
      comboId: String(skuValue(row, "组合ID")),
      platformId: String(skuValue(row, "平台ID")),
      platformPosition: String(skuValue(row, "平台定位")),
      seriesName: series,
      templateId: String(skuValue(row, "模板ID")),
      fishMinKg: Number(skuValue(row, "鱼重下限kg")),
      fishMaxKg: Number(skuValue(row, "鱼重上限kg")),
      selections: {
        structureId: "structure:" + String(skuValue(row, "结构类型")),
        functionId: "function:" + fn + "|" + String(skuValue(row, "功能级")),
        performanceId: "performance:" + perf + "|" + String(skuValue(row, "性能级")),
        technologyIds: [],
      },
      affixIds: affixesForSeries(series, quality, fn, perf),
      useScene: String(skuValue(row, "使用场景")),
      toneOverride: String(skuValue(row, "钓性覆盖")),
      overrides: {},
      status: "candidate",
      calculated: emptyCalculated(),
      notes: "从 06组合SKU 导入，等待新版词条品质引擎重算。",
      createdAt: importedAt,
      updatedAt: importedAt,
    };
  });

export function createSeedState(): WorkspaceState {
  return {
    schemaVersion: 1,
    parameters: parameterDefinitions,
    templates: weightTemplates,
    modifiers,
    layers: defaultLayers,
    affixes: defaultAffixes,
    qualityBands: defaultQualityBands,
    affixScorePolicy: {
      sameAxisFactors: [1, 0.8, 0.6, 0.45, 0.35],
      synergyBonus: 2,
      conflictPenalty: 2,
      passiveWeight: 1,
      directWeight: 1,
      notes: "同标签词条按递减因子有损相加；协同奖励、冲突扣分均可配置。",
    },
    recipes: defaultRecipes,
    candidates: importedCandidates,
    officialSkus: [],
    detailOverrides: [],
    ruleGraphs: structuredClone(defaultRuleGraphs),
    ruleRuns: [],
    revisions: [
      {
        revision: 1,
        author: "Excel 导入",
        message: "从两份钓具工作簿创建初始版本",
        createdAt: importedAt,
      },
    ],
    notes: "以《淡水路亚杆轮线装备设计》为权威主表，旧版母表仅用于参数与验算迁移参考。",
    importedAt,
  };
}
