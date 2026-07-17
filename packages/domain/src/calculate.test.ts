import { describe, expect, it } from "vitest";
import { calculateSku, evaluateFormula } from "./index";
import type { CalculationLayer, ModifierRule, QualityRubric, WeightTemplate } from "./index";

describe("formula evaluator", () => {
  it("evaluates whitelisted arithmetic and functions", () => {
    expect(evaluateFormula("round(max(base * 1.15, current + 2), 2)", { base: 10, current: 8 })).toBe(11.5);
  });

  it("rejects unknown references", () => {
    expect(() => evaluateFormula("secret + 1", {})).toThrow("Unknown formula reference");
  });
});

describe("dynamic SKU calculation", () => {
  const template: WeightTemplate = {
    id: "template-1",
    key: "T01",
    name: "Light standard",
    fishingMethod: "Freshwater lure",
    weightBand: "Light",
    nominalWeight: 1,
    coverageMin: 0.5,
    coverageMax: 2,
    notes: "",
    values: { "rod.maxPull": 10, "reel.maxPull": 7, "line.maxPull": 20, "rod.castAccuracy": 50 },
  };
  const layers: CalculationLayer[] = [
    { id: "position", key: "position", name: "Position", order: 1, isEnabled: true, version: 1, notes: "" },
    { id: "technology", key: "technology", name: "Technology", order: 2, isEnabled: true, version: 1, notes: "" },
  ];
  const rules: ModifierRule[] = [
    { id: "multiply", layerId: "position", optionId: "long-cast", parameterKey: "rod.castAccuracy", operation: "MULTIPLY", operandMode: "CONSTANT", operand: 1.1, priority: 1, notes: "" },
    { id: "add", layerId: "technology", optionId: "carbon", parameterKey: "rod.castAccuracy", operation: "ADD", operandMode: "CONSTANT", operand: 5, priority: 1, notes: "" },
    { id: "set", layerId: "technology", optionId: "special", parameterKey: "rod.castAccuracy", operation: "SET", operandMode: "CONSTANT", operand: 70, priority: 2, notes: "" },
  ];
  const rubric: QualityRubric = {
    id: "rubric",
    name: "Affix score",
    version: 1,
    aggregation: "SUM",
    tiers: [
      { id: "green", key: "green", name: "Green", minimumScore: 0, maximumScore: 4.99, color: "#4ade80" },
      { id: "blue", key: "blue", name: "Blue", minimumScore: 5, maximumScore: 9.99, color: "#60a5fa" },
      { id: "purple", key: "purple", name: "Purple", minimumScore: 10, color: "#c084fc" },
    ],
  };

  it("applies layers sequentially and derives quality from selected affix scores", () => {
    const result = calculateSku({
      input: {
        id: "sku",
        comboCode: "FW-01",
        platformId: "P01",
        platformPositioning: "Light",
        templateId: template.id,
        targetWeightMin: 0.8,
        targetWeightMax: 1.5,
        seriesName: "River",
        usageScenario: "Bank fishing",
        selectedOptionIds: ["long-cast", "carbon", "special"],
        affixes: [
          { affixId: "accuracy", source: "SERIES" },
          { affixId: "impact", source: "SKU" },
        ],
      },
      template,
      layers,
      rules,
      affixDefinitions: [
        { id: "accuracy", key: "accuracy", name: "+10 accuracy", kind: "ATTRIBUTE", score: 3, description: "", rules: [], tags: [] },
        { id: "impact", key: "impact", name: "Impact resistance", kind: "PASSIVE", score: 6, description: "", rules: [], tags: [] },
      ],
      qualityRubric: rubric,
    });

    expect(result.parameters["rod.castAccuracy"]?.automaticValue).toBe(70);
    expect(result.quality.automaticScore).toBe(9);
    expect(result.quality.automaticTier.name).toBe("Blue");
    expect(result.componentIds).toEqual({ rod: "FW-01_R", reel: "FW-01_W", line: "FW-01_L" });
    expect(result.validations.find((item) => item.key === "target.nominal-covered")?.passed).toBe(true);
  });
});
