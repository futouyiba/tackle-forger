import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePricingTrial,
  floorToSignificantDigits,
  importPricingPolicyDraft,
  publishPricingPolicyDraft,
  type PricingMoneyPolicyDraft,
  type PricingPolicyDraft,
  type PricingPolicyVersion,
  type QualityId,
} from "../lib/pricing-policy";
import { publishConfigurationSnapshot, verifySnapshotIntegrity } from "../lib/publishing";
import {
  hashAffixRuntimeEvidence,
  numberToBinary64Hex,
} from "../lib/reduction-stacking-policy";
import { createSeedState } from "../lib/seed";
import {
  formalAffixRuntimeEvidence,
  formalProjection,
  testReductionPolicy,
} from "./helpers/reduction-policy";

const REVISION = "2922";
const ref = (cell: string, sheetId = "u87sRh") => ({ sheetId, cell });
const sourced = (value: number, cell: string) => ({ value, status: "CONFIRMED" as const, source: ref(cell) });

function completeInput(overrides: Partial<PricingPolicyDraft> = {}) {
  const baskets = ["run", "steady", "attack"];
  const moneyPolicy: PricingMoneyPolicyDraft = {
    unit: "金币",
    rounding: "significant_digits_floor",
    precision: 3,
    significantDigits: 3,
    minimumPrice: 100,
    maximumPrice: 300_000_000,
    roundingStage: "part_purchase_price",
    minimumPriceScope: "part_purchase_price",
    overflowMode: "error",
    status: "CONFIRMED",
    source: ref("B15:B18"),
  };
  return {
    sourceRevisionId: `feishu-revision:${REVISION}`,
    sourceRevision: REVISION,
    pricingSheetId: "u87sRh" as const,
    qualitySheetId: "FqD4j7" as const,
    typeMaterialSheetId: "fATowU" as const,
    businessFormulaCells: [ref("B2"), ref("B8")],
    pricingBaskets: baskets.map((id, index) => ({ id: `pricing_basket:${id}`, sourceAlias: ["跑刀", "稳健", "猛攻"][index], source: ref(`C${5 + index}`) })),
    maintenanceConsumptionRates: baskets.map((id, index) => ({ pricingWeightBandId: "band:matched", pricingBasketId: `pricing_basket:${id}`, value: sourced(12_345_678, `D${23 + index}`) })),
    partAllocationRatios: [{ pricingWeightBandId: "band:matched", partId: "rod", value: sourced(1, "G23") }],
    repairCoefficients: [{ partId: "rod", typeId: "RodType:spinning", value: { ...sourced(1, "U3"), source: ref("U3", "fATowU") } }],
    totalLossTimes: baskets.map((id, index) => ({ pricingWeightBandId: "band:matched", pricingBasketId: `pricing_basket:${id}`, partId: "rod", value: sourced(1, `M${23 + index}`) })),
    purchaseCoefficients: [{ partId: "rod", typeId: "RodType:spinning", value: { ...sourced(1, "V3"), source: ref("V3", "fATowU") } }],
    partsToWholeRatios: baskets.map((id, index) => ({ pricingWeightBandId: "band:matched", pricingBasketId: `pricing_basket:${id}`, partId: "rod", value: sourced(1, `P${23 + index}`) })),
    qualityMappings: [
      ["quality_c_green", "run"], ["quality_b_blue", "steady"],
      ["quality_a_purple", "attack"], ["quality_s_orange", "attack"],
    ].map(([qualityId, basket], index) => ({
      qualityId: qualityId as QualityId,
      pricingBasketId: `pricing_basket:${basket}`,
      sourceAlias: basket,
      status: "CONFIRMED" as const,
      source: ref(`D${5 + index}`, "FqD4j7"),
    })),
    qualityPriceFactorRanges: [
      ["quality_c_green", 0, 20, .5, 1.1],
      ["quality_b_blue", 20, 40, .8, 1.2],
      ["quality_a_purple", 40, 65, .7, 1.3],
      ["quality_s_orange", 65, 100, 2, 3],
    ].map(([qualityId, minScore, maxScore, minFactor, maxFactor], index) => ({
      qualityId: qualityId as QualityId,
      minScore: Number(minScore), maxScore: Number(maxScore), maxInclusive: false,
      minFactor: Number(minFactor), maxFactor: Number(maxFactor),
      status: "CONFIRMED" as const, source: ref(`E${5 + index}:H${5 + index}`, "FqD4j7"),
    })),
    scoreInterpolation: { kind: "quality_range_linear" as const, points: [], outOfRange: "error" as const, status: "CONFIRMED" as const, source: ref("B11") },
    performanceScoringPolicy: { enabled: false, status: "CONFIRMED" as const, source: ref("B2", "FqD4j7") },
    moneyPolicy,
    importedAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  } as Parameters<typeof importPricingPolicyDraft>[0];
}

function trial(draft: PricingPolicyDraft | PricingPolicyVersion, qualityId: QualityId, valueScore: number) {
  return calculatePricingTrial({
    policy: draft,
    partId: "rod",
    typeId: "RodType:spinning",
    pricingWeightBandId: "band:matched",
    qualityId,
    valueScore,
  });
}

test("B score=30 在 0.8~1.2 区间线性插值得到 1.0", () => {
  const result = trial(importPricingPolicyDraft(completeInput()), "quality_b_blue", 30);
  assert.equal(result.trace.find((entry) => entry.formulaStep === "scoreInterpolationFactor")?.operand, 1);
  assert.equal(result.pricingBasketId, "pricing_basket:steady");
});

test("A/S 共用猛攻篮子但分别使用自己的品质价格系数", () => {
  const draft = importPricingPolicyDraft(completeInput());
  const a = trial(draft, "quality_a_purple", 52.5);
  const s = trial(draft, "quality_s_orange", 82.5);
  assert.equal(a.pricingBasketId, "pricing_basket:attack");
  assert.equal(s.pricingBasketId, "pricing_basket:attack");
  assert.equal(a.trace.find((entry) => entry.formulaStep === "scoreInterpolationFactor")?.operand, 1);
  assert.equal(s.trace.find((entry) => entry.formulaStep === "scoreInterpolationFactor")?.operand, 2.5);
});

test("明确舍入阶段时 12,345,678 按三位有效数字向下取整", () => {
  assert.equal(floorToSignificantDigits(12_345_678, 3), 12_300_000);
  const result = trial(importPricingPolicyDraft(completeInput()), "quality_b_blue", 30);
  assert.equal(result.purchasePrice, 12_300_000);
});

test("缺舍入阶段、最低价作用域或溢出方式时新策略不可发布", () => {
  const moneyPolicy: PricingMoneyPolicyDraft = { ...completeInput().moneyPolicy! };
  delete moneyPolicy.roundingStage;
  delete moneyPolicy.minimumPriceScope;
  delete moneyPolicy.overflowMode;
  const draft = importPricingPolicyDraft(completeInput({ moneyPolicy }));
  assert.equal(draft.formalStatus, "INCOMPLETE_DRAFT");
  assert.ok(draft.issues.some((issue) => issue.code === "PRICING_EXECUTION_SEMANTICS_MISSING"));
  assert.throws(() => publishPricingPolicyDraft({ draft, version: "new", publishedAt: "2026-07-22T00:00:00.000Z", publishedBy: "tester" }), /PRICING_EXECUTION_SEMANTICS_MISSING/);
});

test("超上限且 overflowMode 缺失时仅返回 NON_FORMAL，不生成正式价格", () => {
  const base = completeInput();
  const moneyPolicy: PricingMoneyPolicyDraft = { ...base.moneyPolicy! };
  delete moneyPolicy.overflowMode;
  const draft = importPricingPolicyDraft(completeInput({
    moneyPolicy,
    maintenanceConsumptionRates: base.maintenanceConsumptionRates.map((entry) => ({
      ...entry, value: { ...entry.value, value: 400_000_000 },
    })),
  }));
  const result = trial(draft, "quality_b_blue", 30);
  assert.equal(result.formal, false);
  assert.equal(result.purchasePrice, null);
  assert.ok(result.issues.some((issue) => issue.code === "PRICE_OVERFLOW_POLICY_MISSING"));
});

test("同输入同规则版本的数值和 Trace hash 确定一致", () => {
  const draft = importPricingPolicyDraft(completeInput());
  const left = trial(draft, "quality_b_blue", 30);
  const right = trial(draft, "quality_b_blue", 30);
  assert.deepEqual(left.trace, right.trace);
  assert.equal(left.inputHash, right.inputHash);
});

test("完整已发布品质结果与 PricingPolicyVersion 可冻结进新 Snapshot", () => {
  const draft = importPricingPolicyDraft(completeInput());
  const version = publishPricingPolicyDraft({
    draft,
    version: "pricing-policy:v1",
    publishedAt: "2026-07-22T00:00:00.000Z",
    publishedBy: "tester",
  });
  const automaticPricing = trial(version, "quality_b_blue", 30);
  assert.equal(automaticPricing.formal, true);
  const state = createSeedState();
  const oldSnapshot = state.configurationSnapshots[0];
  const model = state.purchasableModels.find((entry) => entry.id === oldSnapshot.modelId)!;
  const sku = state.skuDrawers.find((entry) => entry.id === model.skuId)!;
  const series = state.seriesDefinitions.find((entry) => entry.id === sku.seriesId)!;
  const projection = state.derivedProjections.find((entry) => entry.id === oldSnapshot.projectionId)!;
  const qualityValueAssessment = {
    modelRevisionId: `${model.id}@${model.revision}`,
    selectedQualityId: oldSnapshot.qualityReport.qualityId,
    baseAffixScore: oldSnapshot.qualityReport.totalScore,
    combinationScore: 0,
    functionScoreFactor: 1,
    performanceScoreFactor: 1,
    finalValueScore: oldSnapshot.qualityReport.totalScore,
    affixBreakdown: [],
    combinationBreakdown: [],
    qualityRangePolicyVersion: "quality-policy:v1",
    scoringPolicyVersion: "quality-scoring:v1",
    inSelectedQualityRange: true,
    formal: true,
    issues: [],
    trace: [],
    inputHash: "quality-assessment-hash",
  };
  const reductionStackingPolicy = testReductionPolicy();
  const publishProjection = formalProjection(projection, reductionStackingPolicy);
  const publishInput = {
    publicationMode: "new_formal" as const,
    model,
    sku,
    series,
    seriesSkus: state.skuDrawers,
    projection: publishProjection,
    reductionStackingPolicy,
    affixRuntimeEvidence: formalAffixRuntimeEvidence(
      publishProjection,
      reductionStackingPolicy,
      oldSnapshot.finalPanelValues,
    ),
    finalPanelValues: oldSnapshot.finalPanelValues,
    componentSelections: oldSnapshot.componentSelections,
    patches: [],
    attributeAffixIds: oldSnapshot.attributeAffixIds,
    passiveAffixIds: oldSnapshot.passiveAffixIds,
    technologyIds: oldSnapshot.technologyIds,
    passiveAffixPayloads: oldSnapshot.passiveAffixPayloads,
    compatibilityReport: oldSnapshot.compatibilityReport,
    affinityReport: oldSnapshot.affinityReport,
    qualityReport: { ...oldSnapshot.qualityReport, blockingIssues: [] },
    qualityValueAssessment,
    pricingPolicyVersion: version.id,
    automaticPricing,
    validationReport: [],
    warningConfirmations: {},
    publishedBy: "tester",
    publishedAt: "2026-07-22T00:00:00.000Z",
    snapshotId: "snapshot:new-formal",
  };
  assert.throws(() => publishConfigurationSnapshot({
    ...publishInput,
    qualityReport: {
      ...publishInput.qualityReport,
      blockingIssues: [
        "[REDUCTION_POLICY_SOURCE_MISSING] 词条聚合证据仍缺策略源。",
      ],
    },
  }), /REDUCTION_POLICY_SOURCE_MISSING/);
  const detachedEvidence = structuredClone(publishInput.affixRuntimeEvidence);
  const detachedKey = Object.keys(detachedEvidence.values)[0];
  detachedEvidence.values[detachedKey] = "detached";
  detachedEvidence.traceHash = hashAffixRuntimeEvidence({
    reductionStackingPolicyVersion: detachedEvidence.reductionStackingPolicyVersion,
    values: detachedEvidence.values,
    postReviewValues: detachedEvidence.postReviewValues,
    finalValues: detachedEvidence.finalValues,
    trace: detachedEvidence.trace,
    issues: detachedEvidence.issues,
  });
  assert.throws(() => publishConfigurationSnapshot({
    ...publishInput,
    affixRuntimeEvidence: detachedEvidence,
  }), /AFFIX_RUNTIME_TRACE_INVALID/);
  const stagedEvidence = structuredClone(publishInput.affixRuntimeEvidence);
  const stagedKey = Object.keys(stagedEvidence.finalValues).find(
    (key) => typeof stagedEvidence.finalValues[key] === "number",
  )!;
  const stagedFinal = stagedEvidence.finalValues[stagedKey] as number;
  stagedEvidence.values[stagedKey] = stagedFinal - 2;
  stagedEvidence.postReviewValues[stagedKey] = stagedFinal - 1;
  stagedEvidence.trace.push(
    {
      sequence: 10_001,
      ruleId: "final-review:test",
      sourceId: "patch:final-review:test",
      sourceName: "最终复核",
      parameterKey: stagedKey,
      operation: "set",
      before: stagedFinal - 2,
      operand: stagedFinal - 1,
      after: stagedFinal - 1,
      numericEvidence: {
        stage: "final_review_patch",
        beforeBinary64: numberToBinary64Hex(stagedFinal - 2),
        operandBinary64: numberToBinary64Hex(stagedFinal - 1),
        afterBinary64: numberToBinary64Hex(stagedFinal - 1),
        anomaly: "none",
      },
    },
    {
      sequence: 10_002,
      ruleId: `parameter-definition:${stagedKey}`,
      sourceId: `parameter-definition:${stagedKey}`,
      sourceName: stagedKey,
      parameterKey: stagedKey,
      operation: "set",
      before: stagedFinal - 1,
      operand: 0,
      after: stagedFinal,
      numericEvidence: {
        stage: "parameter_definition",
        beforeBinary64: numberToBinary64Hex(stagedFinal - 1),
        operandBinary64: numberToBinary64Hex(0),
        afterBinary64: numberToBinary64Hex(stagedFinal),
        anomaly: "none",
      },
    },
  );
  stagedEvidence.traceHash = hashAffixRuntimeEvidence({
    reductionStackingPolicyVersion: stagedEvidence.reductionStackingPolicyVersion,
    values: stagedEvidence.values,
    postReviewValues: stagedEvidence.postReviewValues,
    finalValues: stagedEvidence.finalValues,
    trace: stagedEvidence.trace,
    issues: stagedEvidence.issues,
  });
  const snapshot = publishConfigurationSnapshot({
    ...publishInput,
    affixRuntimeEvidence: stagedEvidence,
  });
  assert.equal(snapshot.pricingPolicyVersion, version.id);
  assert.equal(snapshot.automaticPricing?.formal, true);
  assert.equal(snapshot.qualityValueAssessment?.formal, true);
  assert.equal(
    snapshot.attributeAffixTraceHash,
    stagedEvidence.traceHash,
  );
  assert.deepEqual(
    snapshot.attributeAffixRuntimeTrace,
    stagedEvidence.trace,
  );
  assert.deepEqual(snapshot.attributeAffixOutputValues, stagedEvidence.values);
  assert.deepEqual(snapshot.attributePostReviewValues, stagedEvidence.postReviewValues);
  assert.equal(verifySnapshotIntegrity(snapshot), true);
});
