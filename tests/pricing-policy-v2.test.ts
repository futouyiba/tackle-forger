import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgePriceWarning,
  calculatePricingTrial,
  importPricingPolicyDraft,
  publishPricingPolicyDraft,
  type PricingPolicyDraft,
} from "../lib/pricing-policy";

const ref = (cell: string, sheetId = "u87sRh") => ({ sheetId, cell });
const sourced = (value: number, cell: string) => ({ value, status: "CONFIRMED" as const, source: ref(cell) });

function policyInput(overrides: Partial<PricingPolicyDraft> = {}) {
  const baskets = ["run", "steady", "attack"];
  return {
    sourceRevisionId: "source:pricing-v2",
    sourceRevision: "pricing-v2",
    pricingSheetId: "u87sRh" as const,
    qualitySheetId: "FqD4j7" as const,
    typeMaterialSheetId: "fATowU" as const,
    businessFormulaCells: [ref("B2")],
    pricingBaskets: baskets.map((id) => ({ id, sourceAlias: id, source: ref(id) })),
    maintenanceConsumptionRates: baskets.map((pricingBasketId) => ({ pricingWeightBandId: "w1", pricingBasketId, value: sourced(1234, "B3") })),
    partAllocationRatios: [{ pricingWeightBandId: "w1", partId: "rod", value: sourced(1, "B4") }],
    repairCoefficients: [{ partId: "rod", typeId: "spin", value: sourced(1, "B5") }],
    totalLossTimes: baskets.map((pricingBasketId) => ({ pricingWeightBandId: "w1", pricingBasketId, partId: "rod", value: sourced(1, "B6") })),
    purchaseCoefficients: [{ partId: "rod", typeId: "spin", value: sourced(1.5, "B7") }],
    partsToWholeRatios: baskets.map((pricingBasketId) => ({ pricingWeightBandId: "w1", pricingBasketId, partId: "rod", value: sourced(1, "B8") })),
    qualityMappings: (["quality_c_green", "quality_b_blue", "quality_a_purple", "quality_s_orange"] as const).map((qualityId, index) => ({ qualityId, pricingBasketId: baskets[index === 3 ? 2 : index], sourceAlias: baskets[index === 3 ? 2 : index], status: "CONFIRMED" as const, source: ref(`C${index}`) })),
    qualityPriceFactorRanges: [
      ["quality_c_green", 0, 20, .5, 1.1], ["quality_b_blue", 20, 40, .8, 1.2], ["quality_a_purple", 40, 65, .7, 1.3], ["quality_s_orange", 65, 100, 2, 3],
    ].map(([qualityId, minScore, maxScore, minFactor, maxFactor], index) => ({ qualityId: qualityId as "quality_c_green", minScore, maxScore, maxInclusive: qualityId === "quality_s_orange", minFactor, maxFactor, status: "CONFIRMED" as const, source: ref(`D${index}`) })),
    scoreInterpolation: { kind: "quality_range_linear" as const, points: [], outOfRange: "error" as const, status: "CONFIRMED" as const, source: ref("B9") },
    moneyPolicy: { unit: "coin", rounding: "significant_digits_floor" as const, precision: 3, significantDigits: 3, status: "CONFIRMED" as const, source: ref("B10") },
    executionPolicy: { repairRoundingStage: "final_repair_output" as const, purchaseInput: "repair_price_raw" as const, purchaseRoundingStage: "final_purchase_output" as const, rounding: "significant_digits_floor" as const, significantDigits: 3, minimumPurchasePrice: 100, minimumPriceScope: "purchase_output_after_rounding" as const, upperThreshold: 300_000_000, upperThresholdMode: "warning_acknowledgement" as const, status: "CONFIRMED" as const, source: ref("B11") },
    importedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  } as Parameters<typeof importPricingPolicyDraft>[0];
}

function published(overrides: Partial<PricingPolicyDraft> = {}) {
  const draft = importPricingPolicyDraft(policyInput(overrides));
  return publishPricingPolicyDraft({ draft, version: "pricing:v2", publishedAt: "2026-07-24T00:00:00.000Z", publishedBy: "test" });
}

test("double-output policy rounds repair and purchase independently from raw repair", () => {
  const result = calculatePricingTrial({ policy: published(), partId: "rod", typeId: "spin", pricingWeightBandId: "w1", qualityId: "quality_b_blue", valueScore: 30, modelRevisionId: "model@1" });
  assert.equal(result.repairPriceRaw, 1234);
  assert.equal(result.repairPrice, 1230);
  assert.equal(result.purchasePriceRaw, 1851);
  assert.equal(result.purchasePriceRounded, 1850);
  assert.equal(result.purchasePrice, 1850);
});

test("minimum price applies only after rounded purchase output", () => {
  const result = calculatePricingTrial({ policy: published({ maintenanceConsumptionRates: ["run", "steady", "attack"].map((pricingBasketId) => ({ pricingWeightBandId: "w1", pricingBasketId, value: sourced(80, "B3") })) }), partId: "rod", typeId: "spin", pricingWeightBandId: "w1", qualityId: "quality_b_blue", valueScore: 30, modelRevisionId: "model@1" });
  assert.equal(result.repairPrice, 80);
  assert.equal(result.purchasePriceRounded, 120);
  assert.equal(result.purchasePrice, 120);
});

test("over-threshold price is a warning that requires exact acknowledgement and goes stale on input change", () => {
  const high = published({ maintenanceConsumptionRates: ["run", "steady", "attack"].map((pricingBasketId) => ({ pricingWeightBandId: "w1", pricingBasketId, value: sourced(400_000_000, "B3") })) });
  const first = calculatePricingTrial({ policy: high, partId: "rod", typeId: "spin", pricingWeightBandId: "w1", qualityId: "quality_b_blue", valueScore: 30, modelRevisionId: "model@1" });
  assert.equal(first.priceWarning?.state, "OPEN");
  assert.equal(first.formal, false);
  const acknowledgement = acknowledgePriceWarning({ trial: first, modelRevisionId: "model@1", acknowledgedBy: "test", acknowledgedAt: "2026-07-24T00:00:01.000Z", reason: "approved", id: "ack:1" });
  const confirmed = calculatePricingTrial({ policy: high, partId: "rod", typeId: "spin", pricingWeightBandId: "w1", qualityId: "quality_b_blue", valueScore: 30, modelRevisionId: "model@1", priceWarningAcknowledgement: acknowledgement });
  assert.equal(confirmed.priceWarning?.state, "ACKNOWLEDGED");
  assert.equal(confirmed.formal, true);
  const stale = calculatePricingTrial({ policy: high, partId: "rod", typeId: "spin", pricingWeightBandId: "w1", qualityId: "quality_b_blue", valueScore: 31, modelRevisionId: "model@1", priceWarningAcknowledgement: acknowledgement });
  assert.equal(stale.priceWarning?.state, "OPEN");
  assert.equal(stale.formal, false);
});

test("legacy execution fields stay non-formal and migration evidence is not a new contract", () => {
  const legacy = importPricingPolicyDraft(policyInput({ executionPolicy: undefined, moneyPolicy: { unit: "coin", rounding: "significant_digits_floor", precision: 3, significantDigits: 3, roundingStage: "part_purchase_price", minimumPriceScope: "part_purchase_price", overflowMode: "error", status: "CONFIRMED", source: ref("B10") } }));
  assert.equal(legacy.formalStatus, "INCOMPLETE_DRAFT");
  assert.ok(legacy.issues.some((entry) => entry.code === "PRICING_EXECUTION_SEMANTICS_MISSING"));
});
