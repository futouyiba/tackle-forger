import type { ParameterDefinition } from "./model";

type SeedParameter = Omit<ParameterDefinition, "id" | "sortOrder" | "isActive">;

function withMetadata(scope: "ROD" | "REEL" | "LINE", values: SeedParameter[]): ParameterDefinition[] {
  return values.map((value, index) => ({ ...value, id: `${scope.toLowerCase()}-${value.key}`, sortOrder: index, isActive: true }));
}

const sharedAuxiliary = (scope: "ROD" | "REEL" | "LINE"): SeedParameter[] => [
  { key: `${scope.toLowerCase()}.weightBand`, displayName: "重量段", scope, valueType: "TEXT", category: "辅助字段" },
  { key: `${scope.toLowerCase()}.fishWeightLevel`, displayName: "鱼重等级", scope, valueType: "TEXT", category: "辅助字段" },
  { key: `${scope.toLowerCase()}.fishingMethod`, displayName: "钓法", scope, valueType: "TEXT", category: "辅助字段" },
  { key: `${scope.toLowerCase()}.affixPositioning`, displayName: "词条定位", scope, valueType: "TEXT", category: "辅助字段" },
  { key: `${scope.toLowerCase()}.qualityLabel`, displayName: "品质", scope, valueType: "TEXT", category: "辅助字段" },
];

export const rodParameterSeeds = withMetadata("ROD", [
  { key: "rod.id", displayName: "ID", scope: "ROD", valueType: "INTEGER", category: "钓具属性" },
  ...sharedAuxiliary("ROD"),
  { key: "rod.subType", displayName: "子类型", scope: "ROD", valueType: "ENUM", category: "钓具属性", enumOptions: ["#RodSubType"] },
  { key: "rod.maxFishWeight", displayName: "最大钓重", scope: "ROD", valueType: "INTEGER", unit: "g", category: "钓具属性" },
  { key: "rod.distanceCoeff", displayName: "抛投能力系数", scope: "ROD", valueType: "INTEGER", unit: "%", category: "钓具属性", minimum: 0, maximum: 99 },
  { key: "rod.durability", displayName: "耐久度", scope: "ROD", valueType: "INTEGER", category: "钓具属性" },
  { key: "rod.energyCostFactor", displayName: "能量消耗系数", scope: "ROD", valueType: "DECIMAL", category: "钓具属性" },
  { key: "rod.sensitivity", displayName: "感度", scope: "ROD", valueType: "INTEGER", category: "钓具属性" },
  { key: "rod.repairPrice", displayName: "维修锚定价格", scope: "ROD", valueType: "INTEGER", category: "钓具属性" },
  { key: "rod.weight", displayName: "重量", scope: "ROD", valueType: "INTEGER", unit: "0.01g", category: "钓具属性" },
  { key: "rod.lureWeightMin", displayName: "饵重范围下限", scope: "ROD", valueType: "INTEGER", unit: "g", category: "钓具属性" },
  { key: "rod.lureWeightMax", displayName: "饵重范围上限", scope: "ROD", valueType: "INTEGER", unit: "g", category: "钓具属性" },
  { key: "rod.length", displayName: "长度", scope: "ROD", valueType: "INTEGER", unit: "cm", category: "钓具属性" },
  { key: "rod.action", displayName: "调性", scope: "ROD", valueType: "ENUM", category: "钓具属性", enumOptions: ["#ActionType"] },
  { key: "rod.hardnessType", displayName: "硬度", scope: "ROD", valueType: "ENUM", category: "钓具属性", enumOptions: ["#HardnessType"] },
  { key: "rod.quality", displayName: "道具品质", scope: "ROD", valueType: "INTEGER", category: "物品属性" },
  { key: "rod.price", displayName: "锚定价格", scope: "ROD", valueType: "INTEGER", category: "物品属性" },
]);

export const reelParameterSeeds = withMetadata("REEL", [
  { key: "reel.id", displayName: "ID", scope: "REEL", valueType: "INTEGER", category: "钓具属性" },
  ...sharedAuxiliary("REEL"),
  { key: "reel.subType", displayName: "子类型", scope: "REEL", valueType: "ENUM", category: "钓具属性", enumOptions: ["#ReelSubType"] },
  { key: "reel.maxPull", displayName: "最大拉力", scope: "REEL", valueType: "INTEGER", unit: "g", category: "钓具属性" },
  { key: "reel.distanceCoeff", displayName: "抛投能力系数", scope: "REEL", valueType: "INTEGER", unit: "%", category: "钓具属性", minimum: 0, maximum: 99 },
  { key: "reel.durability", displayName: "耐久度", scope: "REEL", valueType: "INTEGER", category: "钓具属性" },
  { key: "reel.energyCostFactor", displayName: "能量消耗系数", scope: "REEL", valueType: "DECIMAL", category: "钓具属性" },
  { key: "reel.sensitivity", displayName: "感度", scope: "REEL", valueType: "INTEGER", category: "钓具属性" },
  { key: "reel.repairPrice", displayName: "维修锚定价格", scope: "REEL", valueType: "INTEGER", category: "钓具属性" },
  { key: "reel.modelNum", displayName: "型号", scope: "REEL", valueType: "INTEGER", category: "钓具属性" },
  { key: "reel.size", displayName: "大小", scope: "REEL", valueType: "INTEGER", category: "钓具属性" },
  { key: "reel.weight", displayName: "重量", scope: "REEL", valueType: "INTEGER", unit: "0.01g", category: "钓具属性" },
  { key: "reel.ratio", displayName: "传动比", scope: "REEL", valueType: "DECIMAL", category: "钓具属性" },
  { key: "reel.lureWeightMin", displayName: "饵重范围下限", scope: "REEL", valueType: "INTEGER", unit: "g", category: "钓具属性" },
  { key: "reel.lureWeightMax", displayName: "饵重范围上限", scope: "REEL", valueType: "INTEGER", unit: "g", category: "钓具属性" },
  { key: "reel.capacity", displayName: "绕线量", scope: "REEL", valueType: "INTEGER", unit: "cm", category: "钓具属性" },
  { key: "reel.capacitySize", displayName: "线杯大小", scope: "REEL", valueType: "INTEGER", category: "钓具属性" },
  { key: "reel.tensionFactor", displayName: "张力系数", scope: "REEL", valueType: "DECIMAL", category: "钓具属性" },
  { key: "reel.frictionFactor", displayName: "摩擦力系数", scope: "REEL", valueType: "DECIMAL", category: "钓具属性" },
  { key: "reel.quality", displayName: "道具品质", scope: "REEL", valueType: "INTEGER", category: "物品属性" },
  { key: "reel.price", displayName: "锚定价格", scope: "REEL", valueType: "INTEGER", category: "物品属性" },
]);

export const lineParameterSeeds = withMetadata("LINE", [
  { key: "line.id", displayName: "ID", scope: "LINE", valueType: "INTEGER", category: "钓具属性" },
  ...sharedAuxiliary("LINE"),
  { key: "line.subType", displayName: "子类型", scope: "LINE", valueType: "ENUM", category: "钓具属性", enumOptions: ["#LineSubType"] },
  { key: "line.maxPull", displayName: "最大拉力", scope: "LINE", valueType: "INTEGER", unit: "g", category: "钓具属性" },
  { key: "line.distanceCoeff", displayName: "抛投能力系数", scope: "LINE", valueType: "INTEGER", unit: "%", category: "钓具属性", minimum: 0, maximum: 99 },
  { key: "line.durability", displayName: "耐久度", scope: "LINE", valueType: "INTEGER", category: "钓具属性" },
  { key: "line.energyCostFactor", displayName: "能量消耗系数", scope: "LINE", valueType: "INTEGER", category: "钓具属性" },
  { key: "line.sensitivity", displayName: "感度", scope: "LINE", valueType: "INTEGER", category: "钓具属性" },
  { key: "line.length", displayName: "长度", scope: "LINE", valueType: "INTEGER", unit: "cm", category: "钓具属性" },
  { key: "line.diameter", displayName: "直径", scope: "LINE", valueType: "INTEGER", unit: "mm", category: "钓具属性" },
  { key: "line.frictionFactor", displayName: "摩擦系数", scope: "LINE", valueType: "DECIMAL", category: "钓具属性" },
  { key: "line.tensionFactor", displayName: "张力系数", scope: "LINE", valueType: "DECIMAL", category: "钓具属性" },
  { key: "line.weight", displayName: "重量", scope: "LINE", valueType: "INTEGER", unit: "0.01g", category: "钓具属性" },
  { key: "line.crypticity", displayName: "隐蔽性", scope: "LINE", valueType: "INTEGER", unit: "%", category: "钓具属性", minimum: 0, maximum: 99 },
  { key: "line.size", displayName: "大小（编号）", scope: "LINE", valueType: "DECIMAL", category: "钓具属性" },
  { key: "line.quality", displayName: "道具品质", scope: "LINE", valueType: "INTEGER", category: "物品属性" },
  { key: "line.price", displayName: "锚定价格", scope: "LINE", valueType: "INTEGER", category: "物品属性" },
]);

export const parameterSeeds = [...rodParameterSeeds, ...reelParameterSeeds, ...lineParameterSeeds];
