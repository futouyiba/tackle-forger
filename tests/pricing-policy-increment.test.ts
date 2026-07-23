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
import { deterministicHash } from "../lib/rule-kernel";
import {
  adaptRuleTraceToCanonical,
  createCalculationTraceArchive,
} from "../lib/calculation-trace";
import { createPerformanceSummaryDefinition } from "../lib/performance-summary";
import { createSeedState } from "../lib/seed";
import type { ProjectionTraceStep } from "../lib/types";

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

function finalSettlementTrace(values: Record<string, number | string>): ProjectionTraceStep[] {
  return [{
    layer: "final_review_patch",
    sourceIds: ["test:final-settlement"],
    contributions: Object.entries(values).map(([parameterKey, value], index) => ({
      sequence: index + 1,
      ruleId: `test:final:${parameterKey}`,
      sourceId: "test:final-settlement",
      sourceName: "最终结算",
      parameterKey,
      operation: "base",
      before: null,
      operand: value,
      after: value,
    })),
  }];
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
  const technologyAffixId = state.technologies
    .find((entry) => oldSnapshot.technologyIds.includes(entry.id))?.affixIds[0];
  assert.ok(technologyAffixId);
  const performanceDefinition = createPerformanceSummaryDefinition({
    definitionId: "performance-summary:test",
    definitionVersion: "1",
    publicationState: "PUBLISHED",
    rules: [{
      key: "technology_member",
      label: "技术成员词条",
      direction: "positive",
      order: 1,
      matcher: { source: "affix", affixId: technologyAffixId! },
    }],
  });
  const conflictingPerformanceDefinition = createPerformanceSummaryDefinition({
    ...performanceDefinition,
    rules: performanceDefinition.rules.map((rule) => ({
      ...rule,
      label: rule.label + "（冲突版本）",
    })),
  });
  state.performanceSummaryDefinitions = [performanceDefinition];
  const qualityValueAssessment = {
    modelRevisionId: `${model.id}@${model.revision}`,
    selectedQualityId: oldSnapshot.qualityReport.qualityId,
    baseAffixScore: 30,
    combinationScore: 0,
    functionScoreFactor: 1,
    finalValueScore: 30,
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
  const subjectRef = {
    workspaceId: "workspace:test",
    entityType: "model" as const,
    entityId: model.id,
    revisionId: String(model.revision),
  };
  const [changedParameterKey, changedBefore] = Object.entries(projection.values)
    .find((entry): entry is [string, number] => typeof entry[1] === "number")!;
  const finalPanelValues = {
    ...projection.values,
    [changedParameterKey]: changedBefore + 1,
  };
  const settlementTrace = finalSettlementTrace(finalPanelValues);
  const publishInput = {
    publicationMode: "new_formal",
    workspaceId: "workspace:test",
    model,
    sku,
    series,
    seriesSkus: state.skuDrawers,
    projection,
    finalPanelValues,
    componentSelections: oldSnapshot.componentSelections,
    patches: [],
    attributeAffixIds: oldSnapshot.attributeAffixIds,
    passiveAffixIds: oldSnapshot.passiveAffixIds,
    technologyIds: oldSnapshot.technologyIds,
    technologyDefinitions: state.technologies,
    finalSettlementTrace: settlementTrace,
    performanceSummaryDefinition: performanceDefinition,
    performanceSummaryDefinitions: state.performanceSummaryDefinitions,
    passiveAffixPayloads: oldSnapshot.passiveAffixPayloads,
    compatibilityReport: oldSnapshot.compatibilityReport,
    affinityReport: oldSnapshot.affinityReport,
    qualityReport: oldSnapshot.qualityReport,
    qualityValueAssessment,
    pricingPolicyVersion: version.id,
    automaticPricing,
    validationReport: [],
    warningConfirmations: {},
    publishedBy: "tester",
    publishedAt: "2026-07-22T00:00:00.000Z",
    snapshotId: "snapshot:new-formal",
  } satisfies Parameters<typeof publishConfigurationSnapshot>[0];
  assert.throws(
    () => publishConfigurationSnapshot({
      ...publishInput,
      performanceSummaryDefinitions: [
        performanceDefinition,
        conflictingPerformanceDefinition,
      ],
    }),
    /同一 definitionId \+ definitionVersion 存在内容冲突/,
  );
  const snapshot = publishConfigurationSnapshot(publishInput);
  assert.equal(snapshot.pricingPolicyVersion, version.id);
  assert.equal(snapshot.automaticPricing?.formal, true);
  assert.equal(snapshot.qualityValueAssessment?.formal, true);
  assert.equal(snapshot.calculationTrace?.schemaVersion, "calculation-trace/v1");
  assert.ok(snapshot.calculationTrace?.entries.length);
  const expectedPanelTrace = adaptRuleTraceToCanonical({
    projection: { ...projection, trace: settlementTrace },
    subjectRef,
  });
  assert.deepEqual(
    snapshot.calculationTrace?.entries.slice(0, expectedPanelTrace.length),
    expectedPanelTrace,
  );
  assert.deepEqual(snapshot.attributeTrace, settlementTrace);
  assert.equal(verifySnapshotIntegrity(snapshot), true);
  const tampered = structuredClone(snapshot);
  tampered.calculationTrace!.entries[0].outputHash = "tampered";
  tampered.contentHash = deterministicHash(
    Object.fromEntries(Object.entries(tampered).filter(([key]) => key !== "contentHash")),
  );
  assert.equal(verifySnapshotIntegrity(tampered), false);
  const ruleSetTampered = structuredClone(snapshot);
  const panelEntry = ruleSetTampered.calculationTrace!.entries.find((entry) =>
    !entry.parameterKey.startsWith("pricing:")
    && !entry.parameterKey.startsWith("five_axis:"))!;
  panelEntry.ruleSetVersion = "rules:tampered";
  ruleSetTampered.calculationTrace = createCalculationTraceArchive(
    ruleSetTampered.calculationTrace!.entries,
  );
  ruleSetTampered.contentHash = deterministicHash(
    Object.fromEntries(Object.entries(ruleSetTampered).filter(([key]) => key !== "contentHash")),
  );
  assert.equal(verifySnapshotIntegrity(ruleSetTampered), false);
  const pricingTampered = structuredClone(snapshot);
  pricingTampered.automaticPricing!.purchasePrice =
    pricingTampered.automaticPricing!.purchasePrice! + 1;
  pricingTampered.contentHash = deterministicHash(
    Object.fromEntries(Object.entries(pricingTampered).filter(([key]) => key !== "contentHash")),
  );
  assert.equal(verifySnapshotIntegrity(pricingTampered), false);
  const panelTampered = structuredClone(snapshot);
  panelTampered.finalPanelValues[changedParameterKey] =
    Number(panelTampered.finalPanelValues[changedParameterKey]) + 1;
  panelTampered.contentHash = deterministicHash(
    Object.fromEntries(Object.entries(panelTampered).filter(([key]) => key !== "contentHash")),
  );
  assert.equal(verifySnapshotIntegrity(panelTampered), false);
  const ghostSettlementTrace = structuredClone(settlementTrace);
  ghostSettlementTrace[0].contributions.push({
    sequence: ghostSettlementTrace[0].contributions.length + 1,
    ruleId: "test:final:ghost_panel_key",
    sourceId: "test:final-settlement",
    sourceName: "最终结算",
    parameterKey: "ghost_panel_key",
    operation: "base",
    before: null,
    operand: 99,
    after: 99,
  });
  assert.throws(
    () => publishConfigurationSnapshot({
      ...publishInput,
      finalSettlementTrace: ghostSettlementTrace,
    }),
    /最终结算 Trace 与面板值不一致：ghost_panel_key/,
  );
  assert.equal(snapshot.performanceSummary?.status, "AVAILABLE");
  if (snapshot.performanceSummary?.status === "AVAILABLE") {
    assert.deepEqual(
      snapshot.performanceSummary.summary.labels.map((entry) => entry.key),
      ["technology_member"],
    );
    assert.deepEqual(snapshot.performanceSummary.definitionRef.definition, performanceDefinition);
  }
  assert.equal(verifySnapshotIntegrity(snapshot), true);
  assert.equal(verifySnapshotIntegrity(oldSnapshot), true);
});

test("新正式 Snapshot 拒绝旧 Performance 评分及不匹配的定价分数", () => {
  const draft = importPricingPolicyDraft(completeInput());
  const version = publishPricingPolicyDraft({
    draft,
    version: "pricing-policy:guard-v1",
    publishedAt: "2026-07-22T00:00:00.000Z",
    publishedBy: "tester",
  });
  const state = createSeedState();
  const existing = state.configurationSnapshots[0]!;
  const model = state.purchasableModels.find((entry) => entry.id === existing.modelId)!;
  const sku = state.skuDrawers.find((entry) => entry.id === model.skuId)!;
  const series = state.seriesDefinitions.find((entry) => entry.id === sku.seriesId)!;
  const projection = state.derivedProjections.find((entry) => entry.id === existing.projectionId)!;
  const assessment = {
    modelRevisionId: `${model.id}@${model.revision}`,
    selectedQualityId: existing.qualityReport.qualityId,
    baseAffixScore: 30,
    combinationScore: 0,
    functionScoreFactor: 1,
    performanceScoreFactor: 1.1,
    finalValueScore: 33,
    affixBreakdown: [],
    combinationBreakdown: [],
    qualityRangePolicyVersion: "quality-policy:v1",
    scoringPolicyVersion: "quality-scoring:v1",
    inSelectedQualityRange: true,
    formal: true,
    issues: [],
    trace: [],
    inputHash: "legacy-quality-assessment",
  };
  const base = {
    publicationMode: "new_formal" as const,
    model, sku, series, seriesSkus: state.skuDrawers, projection,
    finalPanelValues: existing.finalPanelValues,
    componentSelections: existing.componentSelections,
    patches: [],
    attributeAffixIds: existing.attributeAffixIds,
    passiveAffixIds: existing.passiveAffixIds,
    technologyIds: existing.technologyIds,
    technologyDefinitions: state.technologies,
    finalSettlementTrace: finalSettlementTrace(existing.finalPanelValues),
    passiveAffixPayloads: existing.passiveAffixPayloads,
    compatibilityReport: existing.compatibilityReport,
    affinityReport: existing.affinityReport,
    qualityReport: existing.qualityReport,
    qualityValueAssessment: assessment,
    pricingPolicyVersion: version.id,
    automaticPricing: trial(version, "quality_b_blue", assessment.finalValueScore),
    validationReport: [],
    warningConfirmations: {},
    publishedBy: "tester",
    publishedAt: "2026-07-22T00:00:00.000Z",
  };
  assert.throws(
    () => publishConfigurationSnapshot(base),
    /不得冻结或定价包含旧 Performance 因子/,
  );
  assert.throws(
    () => publishConfigurationSnapshot({
      ...base,
      qualityValueAssessment: { ...assessment, performanceScoreFactor: undefined, finalValueScore: 30 },
    }),
    /valueScore 与规范品质评分结果不一致/,
  );
  assert.throws(
    () => publishConfigurationSnapshot({
      ...base,
      qualityValueAssessment: { ...assessment, performanceScoreFactor: undefined },
      finalSettlementTrace: finalSettlementTrace(existing.finalPanelValues).map((step) => ({
        ...step,
        contributions: step.contributions.slice(1),
      })),
    }),
    /最终结算 Trace 未覆盖面板参数/,
  );
  assert.throws(
    () => publishConfigurationSnapshot({
      ...base,
      qualityValueAssessment: { ...assessment, performanceScoreFactor: undefined },
      finalSettlementTrace: [{
        ...finalSettlementTrace(existing.finalPanelValues)[0],
        contributions: [{
          ...finalSettlementTrace(existing.finalPanelValues)[0].contributions[0],
          after: -1,
        }],
      }],
    }),
    /最终结算 Trace 与面板值不一致/,
  );
});
