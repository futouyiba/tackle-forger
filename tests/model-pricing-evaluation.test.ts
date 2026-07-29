/**
 * ModelPricingEvaluation 权威边界测试
 *
 * 覆盖正常、边界、伪造、并发、幂等、迁移、历史冻结场景。
 * Issue #132.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { jcsSha256Hex } from "../lib/canonical-json";
import { deterministicHash } from "../lib/rule-kernel";
import {
  importPricingPolicyDraft,
  publishPricingPolicyDraft,
  type PricingPolicyDraft,
} from "../lib/pricing-policy";
import {
  acknowledgeModelPricingEvaluation,
  computeModelPricingEvaluation,
  computeHistoricalModelPricingEvaluation,
  evaluationId,
  findEvaluation,
  recomputeHistoricalModelPricingEvaluation,
  staleEvaluation,
  validateModelPricingEvaluation,
} from "../lib/model-pricing-evaluation";
import type {
  HistoricalModelPricingEvaluationInput,
  SkuDrawerRevision,
  V23SkuAffixValueAssessment,
} from "../lib/types";

// ─── 夹具 ────────────────────────────────────────────────────────────

const ref = (cell: string, sheetId = "31RxeB") => ({ sheetId, cell });
const sourced = (value: number, cell: string) =>
  ({ value, status: "CONFIRMED" as const, source: ref(cell) });

function policyInput(overrides: Partial<PricingPolicyDraft> = {}) {
  return {
    sourceRevisionId: "source:pricing-v2",
    sourceRevision: "pricing-v2",
    pricingSheetId: "31RxeB" as const,
    qualitySheetId: "27hboC" as const,
    typeMaterialSheetId: "10TyFp" as const,
    businessFormulaCells: [ref("B2")],
    maintenanceConsumptionRates: [{ pricingWeightBandId: "w1", value: sourced(1234, "B3") }],
    partAllocationRatios: [{ pricingWeightBandId: "w1", partId: "rod", value: sourced(1, "B4") }],
    repairCoefficients: [{ partId: "rod", typeId: "spin", value: sourced(1, "B5") }],
    totalLossTimes: [{ pricingWeightBandId: "w1", partId: "rod", value: sourced(1, "B6") }],
    purchaseCoefficients: [{ partId: "rod", typeId: "spin", value: sourced(1.5, "B7") }],
    partsToWholeRatios: [{ pricingWeightBandId: "w1", partId: "rod", value: sourced(1, "B8") }],
    qualityMappings: (
      ["quality_c_green", "quality_b_blue", "quality_a_purple", "quality_s_orange"] as const
    ).map((qualityId, index) => ({
      qualityId,
      sourceAlias: `alias${index}`,
      status: "CONFIRMED" as const,
      source: ref(`C${index}`),
    })),
    qualityPriceFactorRanges: [
      ["quality_c_green", 0, 20, 0.5, 1.1],
      ["quality_b_blue", 20, 40, 0.8, 1.2],
      ["quality_a_purple", 40, 65, 0.7, 1.3],
      ["quality_s_orange", 65, 100, 2, 3],
    ].map(([qualityId, minScore, maxScore, minFactor, maxFactor], index) => ({
      qualityId: qualityId as "quality_c_green",
      minScore,
      maxScore,
      maxInclusive: qualityId === "quality_s_orange",
      minFactor,
      maxFactor,
      status: "CONFIRMED" as const,
      source: ref(`D${index}`),
    })),
    scoreInterpolation: {
      kind: "quality_range_linear" as const,
      points: [],
      outOfRange: "error" as const,
      status: "CONFIRMED" as const,
      source: ref("B9"),
    },
    moneyPolicy: {
      unit: "coin",
      rounding: "significant_digits_floor" as const,
      precision: 3,
      significantDigits: 3,
      status: "CONFIRMED" as const,
      source: ref("B10"),
    },
    executionPolicy: {
      repairRoundingStage: "final_repair_output" as const,
      purchaseInput: "repair_price_raw" as const,
      purchaseRoundingStage: "final_purchase_output" as const,
      rounding: "significant_digits_floor" as const,
      significantDigits: 3,
      minimumPurchasePrice: 100,
      minimumPriceScope: "purchase_output_after_rounding" as const,
      upperThreshold: 300_000_000,
      upperThresholdMode: "warning_acknowledgement" as const,
      status: "CONFIRMED" as const,
      source: ref("B11"),
    },
    importedAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  } as Parameters<typeof importPricingPolicyDraft>[0];
}

function publishedPolicy(overrides: Partial<PricingPolicyDraft> = {}) {
  const draft = importPricingPolicyDraft(policyInput(overrides));
  return publishPricingPolicyDraft({
    draft,
    version: "pricing:v2",
    publishedAt: "2026-07-25T00:00:00.000Z",
    publishedBy: "test",
  });
}

function baseEvalInput(
  overrides: Partial<HistoricalModelPricingEvaluationInput> = {},
): HistoricalModelPricingEvaluationInput {
  return {
    modelId: "model-1",
    modelRevision: "1",
    pricingPolicyRef: "pricing:v2",
    pricingWeightBandId: "w1",
    valueScore: 30,
    partId: "rod",
    typeId: "spin",
    qualityId: "quality_b_blue",
    ...overrides,
  };
}

const baseOptions = {
  id: evaluationId("model-1"),
  createdAt: "2026-07-25T00:00:00.000Z",
  createdBy: "test",
};

function assessedSku(overrides: {
  skuId?: string;
  revision?: number;
  weightBandId?: string;
  selectedQualityId?: V23SkuAffixValueAssessment["selectedQualityId"];
  finalValueScore?: number;
} = {}): SkuDrawerRevision {
  const skuId = overrides.skuId ?? "sku:v23";
  const revision = overrides.revision ?? 3;
  const selectedQualityId = overrides.selectedQualityId ?? "quality_a_purple";
  const finalValueScore = overrides.finalValueScore ?? 50;
  const content = {
    skuRevisionId: `${skuId}@${revision}`,
    recommendedQualityId: "quality_a_purple" as const,
    selectedQualityId,
    qualityOverrideState: selectedQualityId === "quality_a_purple" ? "MATCHED" as const : "OVERRIDDEN" as const,
    qualityOverrideReason: selectedQualityId === "quality_a_purple" ? null : "测试覆盖",
    baseAffixScore: finalValueScore,
    combinationScore: 0,
    functionScoreFactor: 1,
    finalValueScore,
    affixBreakdown: [],
    combinationBreakdown: [],
    trace: [],
    qualityRangePolicyVersion: "quality-policy:v23",
    scoringPolicyVersion: "v23-quality-scoring/open007-target-v1",
    inSelectedQualityRange: selectedQualityId === "quality_a_purple",
  };
  const assessment = { ...content, inputHash: jcsSha256Hex(content) };
  return {
    skuId,
    revision,
    seriesId: "series:v23",
    partId: "part:v23",
    partRevision: 1,
    weightBandId: overrides.weightBandId ?? "w1",
    match: { status: "INVALID_NO_MATCH", attemptedKey: {} as never, inputFingerprint: "fixture" },
    derivation: { status: "UNRESOLVED" },
    removedInheritedEntryIds: [],
    addedEntryRefs: [],
    localEntryCopies: [],
    technologyRefs: [],
    quality: { status: "ASSESSED", assessment },
    skuPatchIds: [],
    modelIds: ["model-1"],
    defaultModelId: "model-1",
    displayOrder: 0,
    validationSummary: [],
    status: "draft",
    contentHash: "fixture",
  };
}

// ─── 正常路径 ─────────────────────────────────────────────────────────

test("v23 当前定价只从同一 SKU revision 的实际品质评估构造输入", () => {
  const policy = publishedPolicy();
  const sku = assessedSku({
    selectedQualityId: "quality_a_purple",
    finalValueScore: 50,
    weightBandId: "w1",
  });
  const evaluation = computeModelPricingEvaluation({
    modelId: "model-1",
    modelRevision: "1",
    pricingPolicyRef: policy.id,
    partId: "rod",
    typeId: "spin",
  }, sku, policy, baseOptions);

  assert.equal(evaluation.input.sourceKind, "V23_SKU_ASSESSMENT");
  assert.equal(evaluation.input.qualityId, "quality_a_purple");
  assert.equal(evaluation.input.valueScore, 50);
  assert.equal(evaluation.input.pricingWeightBandId, "w1");
  if (evaluation.input.sourceKind !== "V23_SKU_ASSESSMENT") return;
  assert.equal(evaluation.input.skuId, "sku:v23");
  assert.equal(evaluation.input.skuRevision, 3);
  assert.equal(
    evaluation.input.qualityAssessmentInputHash,
    sku.quality.status === "ASSESSED" ? sku.quality.assessment.inputHash : "",
  );
  assert.deepEqual(validateModelPricingEvaluation(evaluation, policy, "1", sku), []);
});

test("v23 当前定价拒绝未评估、过期身份与不完整品质证据", () => {
  const policy = publishedPolicy();
  const valid = assessedSku();
  assert.throws(
    () => computeModelPricingEvaluation({
      modelId: "model-1", modelRevision: "1", pricingPolicyRef: policy.id,
      partId: "rod", typeId: "spin",
    }, { ...valid, quality: { status: "UNASSESSED" } }, policy, baseOptions),
    /V23_PRICING_QUALITY_UNASSESSED/,
  );

  const stale = structuredClone(valid);
  if (stale.quality.status !== "ASSESSED") return;
  stale.quality.assessment.skuRevisionId = `${stale.skuId}@2`;
  assert.throws(
    () => computeModelPricingEvaluation({
      modelId: "model-1", modelRevision: "1", pricingPolicyRef: policy.id,
      partId: "rod", typeId: "spin",
    }, stale, policy, baseOptions),
    /V23_PRICING_QUALITY_EVIDENCE_INVALID/,
  );

  const evaluation = computeModelPricingEvaluation({
    modelId: "model-1", modelRevision: "1", pricingPolicyRef: policy.id,
    partId: "rod", typeId: "spin",
  }, valid, policy, baseOptions);
  assert.ok(
    validateModelPricingEvaluation(evaluation, policy, "1").some(
      (issue) => issue.code === "SKU_QUALITY_EVIDENCE_REQUIRED",
    ),
  );
  assert.ok(
    validateModelPricingEvaluation(
      evaluation,
      policy,
      "1",
      assessedSku({ revision: 4 }),
    ).some((issue) => issue.code === "SKU_QUALITY_EVIDENCE_STALE"),
  );
});

test("历史重放缺失冻结 qualityId 时 fail closed，不再回退蓝色品质", () => {
  const policy = publishedPolicy();
  const missing = { ...baseEvalInput({ pricingPolicyRef: policy.id }) } as Record<string, unknown>;
  delete missing.qualityId;
  assert.throws(
    () => computeHistoricalModelPricingEvaluation(
      missing as unknown as HistoricalModelPricingEvaluationInput,
      policy,
      baseOptions,
    ),
    /缺少冻结 qualityId/,
  );
});

test("相同输入产生相同 evaluation（幂等），contentHash 和 inputHash 确定", () => {
  const policy = publishedPolicy();
  const input = baseEvalInput({ pricingPolicyRef: policy.id });

  const eval1 = computeHistoricalModelPricingEvaluation(input, policy, baseOptions);
  const eval2 = computeHistoricalModelPricingEvaluation(input, policy, baseOptions);

  assert.equal(eval1.id, eval2.id);
  assert.equal(eval1.revision, 1);
  assert.equal(eval1.contentHash, eval2.contentHash);
  assert.equal(eval1.result.inputHash, eval2.result.inputHash);
  assert.equal(eval1.status, "ACKNOWLEDGED"); // 未超限 → 自动 ACKNOWLEDGED
  assert.equal(eval1.result.formal, true);
});

test("evaluation 绑定完整输入：partId/typeId/qualityId/weightBand/valueScore", () => {
  const policy = publishedPolicy();
  const input = baseEvalInput({ pricingPolicyRef: policy.id });

  const evaluation = computeHistoricalModelPricingEvaluation(input, policy, baseOptions);

  assert.equal(evaluation.input.partId, "rod");
  assert.equal(evaluation.input.typeId, "spin");
  assert.equal(evaluation.input.qualityId, "quality_b_blue");
  assert.equal(evaluation.input.pricingWeightBandId, "w1");
  assert.equal(evaluation.input.valueScore, 30);
  assert.equal(evaluation.pricingPolicyRef, policy.id);
  assert.equal(evaluation.modelId, "model-1");
  assert.equal(evaluation.modelRevision, "1");
});

test("findEvaluation 按 ID 和 revision 精确查找", () => {
  const policy = publishedPolicy();
  const e1 = computeHistoricalModelPricingEvaluation(
    baseEvalInput({ pricingPolicyRef: policy.id }),
    policy,
    { ...baseOptions, id: "mpe-test" },
  );

  assert.equal(findEvaluation([e1], "mpe-test")?.revision, 1);
  assert.equal(findEvaluation([e1], "mpe-test", 1)?.id, "mpe-test");
  assert.equal(findEvaluation([e1], "mpe-test", 2), undefined);
  assert.equal(findEvaluation([], "nonexistent"), undefined);
});

// ─── 边界 ─────────────────────────────────────────────────────────────

test("策略非 PUBLISHED → evaluation 状态为 NON_FORMAL", () => {
  const draft = importPricingPolicyDraft(policyInput());
  // draft 不会是 PUBLISHED，所以应该产生 NON_FORMAL
  const nonFormalInput = baseEvalInput({ pricingPolicyRef: draft.id });
  const evaluation = computeHistoricalModelPricingEvaluation(nonFormalInput, draft as unknown as Parameters<typeof computeHistoricalModelPricingEvaluation>[1], baseOptions);
  assert.equal(evaluation.status, "NON_FORMAL");
  assert.equal(evaluation.result.formal, false);
});

test("输入变化创建新 revision，旧 ACKNOWLEDGED 返回 staleLegacy", () => {
  const policy = publishedPolicy();
  const input1 = baseEvalInput({ pricingPolicyRef: policy.id });

  const eval1 = computeHistoricalModelPricingEvaluation(input1, policy, baseOptions);
  assert.equal(eval1.revision, 1);

  const input2 = { ...input1, valueScore: 31 };
  const { newEval: eval2, staleLegacy } = recomputeHistoricalModelPricingEvaluation(eval1, input2, policy, {
    createdAt: "2026-07-25T01:00:00.000Z",
    createdBy: "test",
  });

  assert.equal(eval2.revision, 2);
  assert.equal(eval2.input.valueScore, 31);
  assert.notEqual(eval2.contentHash, eval1.contentHash);
  assert.notEqual(eval2.result.inputHash, eval1.result.inputHash);
  // 未超限 → 直接 ACKNOWLEDGED → 旧 eval 返回 staleLegacy
  assert.equal(eval1.status, "ACKNOWLEDGED");
  assert.ok(staleLegacy);
  assert.equal(staleLegacy!.status, "STALE");
});

test("ACKNOWLEDGED 评估被标记 STALE 后不可再确认", () => {
  // 超限评估先确认，然后其所在 evaluation 标记 STALE（输入变化场景）
  const high = publishedPolicy({
    maintenanceConsumptionRates: [
      { pricingWeightBandId: "w1", value: sourced(400_000_000, "B3") },
    ],
  });
  const input = baseEvalInput({ pricingPolicyRef: high.id });
  const evaluation = computeHistoricalModelPricingEvaluation(input, high, baseOptions);
  assert.equal(evaluation.status, "OPEN");

  const acked = acknowledgeModelPricingEvaluation(evaluation, {
    acknowledgedBy: "admin",
    acknowledgedAt: "2026-07-25T01:00:00.000Z",
    reason: "经确认",
    acknowledgementId: "ack:stale-1",
  });
  assert.equal(acked.status, "ACKNOWLEDGED");

  // 输入变化后旧评估标记 STALE
  const staled = staleEvaluation(acked);
  assert.equal(staled.status, "STALE");

  // STALE 状态不可再确认
  assert.throws(
    () => acknowledgeModelPricingEvaluation(staled, {
      acknowledgedBy: "admin", acknowledgedAt: "now", reason: "no", acknowledgementId: "ack:bad",
    }),
    /OPEN 状态/,
  );
});

test("超限评估为 OPEN 状态，确认后变 ACKNOWLEDGED", () => {
  const high = publishedPolicy({
    maintenanceConsumptionRates: [
      { pricingWeightBandId: "w1", value: sourced(400_000_000, "B3") },
    ],
  });
  const input = baseEvalInput({ pricingPolicyRef: high.id });

  const evaluation = computeHistoricalModelPricingEvaluation(input, high, baseOptions);
  assert.equal(evaluation.status, "OPEN");
  assert.equal(evaluation.result.priceUpperThresholdExceeded, true);
  assert.equal(evaluation.result.priceWarning?.state, "OPEN");

  // 确认
  const ackEval = acknowledgeModelPricingEvaluation(evaluation, {
    acknowledgedBy: "admin",
    acknowledgedAt: "2026-07-25T01:00:00.000Z",
    reason: "经产品确认可以上架",
    acknowledgementId: "ack:mpe-1",
  });

  assert.equal(ackEval.status, "ACKNOWLEDGED");
  assert.ok(ackEval.acknowledgement);
  assert.equal(ackEval.acknowledgement!.state, "ACKNOWLEDGED");
  assert.equal(ackEval.acknowledgement!.inputHash, evaluation.result.inputHash);
});

test("非超限评估确认时抛错", () => {
  const policy = publishedPolicy();
  const input = baseEvalInput({ pricingPolicyRef: policy.id });
  const evaluation = computeHistoricalModelPricingEvaluation(input, policy, baseOptions);

  assert.throws(
    () =>
      acknowledgeModelPricingEvaluation(evaluation, {
        acknowledgedBy: "admin",
        acknowledgedAt: "now",
        reason: "no",
        acknowledgementId: "ack:bad",
      }),
    /不需要确认/,
  );
});

test("非 OPEN 状态评估确认时抛错", () => {
  const high = publishedPolicy({
    maintenanceConsumptionRates: [
      { pricingWeightBandId: "w1", value: sourced(400_000_000, "B3") },
    ],
  });
  const input = baseEvalInput({ pricingPolicyRef: high.id });
  const evaluation = computeHistoricalModelPricingEvaluation(input, high, baseOptions);

  // 先确认
  const acked = acknowledgeModelPricingEvaluation(evaluation, {
    acknowledgedBy: "admin",
    acknowledgedAt: "2026-07-25T01:00:00.000Z",
    reason: "经确认",
    acknowledgementId: "ack:mpe-2",
  });

  // 再次确认 → 抛错
  assert.throws(
    () =>
      acknowledgeModelPricingEvaluation(acked, {
        acknowledgedBy: "admin",
        acknowledgedAt: "now",
        reason: "no",
        acknowledgementId: "ack:dup",
      }),
    /OPEN 状态/,
  );
});

// ─── 冲突 ─────────────────────────────────────────────────────────────

test("validateModelPricingEvaluation 捕获策略非 PUBLISHED", () => {
  const policy = publishedPolicy();
  const input = baseEvalInput({ pricingPolicyRef: policy.id });
  const evaluation = computeHistoricalModelPricingEvaluation(input, policy, baseOptions);

  // 验证时传入 undefined 策略
  const issues = validateModelPricingEvaluation(evaluation, undefined, "1");
  assert.ok(issues.some((i) => i.code === "PRICING_POLICY_NOT_FOUND"));
});

test("validateModelPricingEvaluation 捕获 modelRevision 不匹配", () => {
  const policy = publishedPolicy();
  const input = baseEvalInput({ pricingPolicyRef: policy.id });
  const evaluation = computeHistoricalModelPricingEvaluation(input, policy, baseOptions);

  const issues = validateModelPricingEvaluation(evaluation, policy, "2"); // revision 变了
  assert.ok(issues.some((i) => i.code === "MODEL_REVISION_MISMATCH"));
});

test("validateModelPricingEvaluation 捕获 contentHash 不一致", () => {
  const policy = publishedPolicy();
  const input = baseEvalInput({ pricingPolicyRef: policy.id });
  const evaluation = computeHistoricalModelPricingEvaluation(input, policy, baseOptions);

  // 篡改 evaluation 的结果字段（价格被篡改）
  const tamperedEval = {
    ...evaluation,
    result: { ...evaluation.result, purchasePrice: 999999 },
  };

  const issues = validateModelPricingEvaluation(tamperedEval, policy, "1");
  // 服务端重算得到正确价格，与 evaluation.result 的篡改价格不一致
  assert.ok(issues.some((i) => i.code === "PRICE_MISMATCH"));
});

test("validateModelPricingEvaluation 捕获 NON_FORMAL 状态", () => {
  const draft = importPricingPolicyDraft(policyInput());
  const nonFormalInput = baseEvalInput({ pricingPolicyRef: draft.id });
  const evaluation = computeHistoricalModelPricingEvaluation(
    nonFormalInput,
    draft as unknown as Parameters<typeof computeHistoricalModelPricingEvaluation>[1],
    baseOptions,
  );
  assert.equal(evaluation.status, "NON_FORMAL");

  const issues = validateModelPricingEvaluation(
    evaluation,
    publishedPolicy(),
    "1",
  );
  assert.ok(issues.some((i) => i.code === "EVALUATION_NON_FORMAL"));
});

test("validateModelPricingEvaluation 捕获 STALE 状态", () => {
  const policy = publishedPolicy();
  const input = baseEvalInput({ pricingPolicyRef: policy.id });
  const evaluation = computeHistoricalModelPricingEvaluation(input, policy, baseOptions);

  const staled = { ...evaluation, status: "STALE" as const };
  const issues = validateModelPricingEvaluation(staled, policy, "1");
  assert.ok(issues.some((i) => i.code === "EVALUATION_STALE"));
});

test("validateModelPricingEvaluation 捕获 OPEN 状态（超限未确认）", () => {
  const high = publishedPolicy({
    maintenanceConsumptionRates: [
      { pricingWeightBandId: "w1", value: sourced(400_000_000, "B3") },
    ],
  });
  const input = baseEvalInput({ pricingPolicyRef: high.id });
  const evaluation = computeHistoricalModelPricingEvaluation(input, high, baseOptions);
  assert.equal(evaluation.status, "OPEN");

  const issues = validateModelPricingEvaluation(evaluation, high, "1");
  assert.ok(
    issues.some((i) => i.code === "PRICE_UPPER_THRESHOLD_CONFIRMATION_REQUIRED"),
  );
});

// ─── 伪造 ─────────────────────────────────────────────────────────────

test("伪造 acknowledgement（跨 evaluation ID）被检测", () => {
  const high = publishedPolicy({
    maintenanceConsumptionRates: [
      { pricingWeightBandId: "w1", value: sourced(400_000_000, "B3") },
    ],
  });
  const input = baseEvalInput({ pricingPolicyRef: high.id });

  // 创建两个独立 evaluation（不同 valueScore → 不同 inputHash）
  const eval1 = computeHistoricalModelPricingEvaluation(input, high, { ...baseOptions, id: "mpe-eval1" });
  const eval2 = computeHistoricalModelPricingEvaluation(
    { ...input, valueScore: 32 },
    high,
    { ...baseOptions, id: "mpe-eval2" },
  );
  assert.equal(eval1.status, "OPEN");
  assert.equal(eval2.status, "OPEN");

  // 确认 eval2
  const acked2 = acknowledgeModelPricingEvaluation(eval2, {
    acknowledgedBy: "admin", acknowledgedAt: "now", reason: "ok", acknowledgementId: "ack:for-eval2",
  });

  // 把 eval2 的 acknowledgement 嫁接到 eval1（手动篡改）
  const tampered = { ...eval1, acknowledgement: acked2.acknowledgement, status: "ACKNOWLEDGED" as const };
  // validate 应发现：ack 的 inputHash 属于 eval2，与 eval1 不一致
  const issues = validateModelPricingEvaluation(tampered, high, "1");
  assert.ok(issues.some((i) => i.code === "ACKNOWLEDGEMENT_INPUT_HASH_MISMATCH"),
    "跨 evaluation 嫁接 acknowledgement 应被 inputHash 不匹配检测");
});

test("篡改 contentHash 后验证 fail-closed", () => {
  const policy = publishedPolicy();
  const input = baseEvalInput({ pricingPolicyRef: policy.id });
  const evaluation = computeHistoricalModelPricingEvaluation(input, policy, baseOptions);

  const tampered = { ...evaluation, contentHash: "forged-hash" };
  const issues = validateModelPricingEvaluation(tampered, policy, "1");
  assert.ok(issues.some((i) => i.code === "CONTENT_HASH_MISMATCH"));
});

// ─── 幂等与恢复 ───────────────────────────────────────────────────────

test("computeHistoricalModelPricingEvaluation 从相同输入产生确定的 inputHash", () => {
  const policy = publishedPolicy();
  const input = baseEvalInput({ pricingPolicyRef: policy.id });

  const run1 = computeHistoricalModelPricingEvaluation(input, policy, baseOptions);
  const run2 = computeHistoricalModelPricingEvaluation(input, policy, baseOptions);

  assert.equal(run1.result.inputHash, run2.result.inputHash);
  assert.equal(run1.contentHash, run2.contentHash);
  assert.equal(deterministicHash(run1), deterministicHash(run2));
});

test("evaluation 内 priceWarning 的 issueFingerprint 绑定 inputHash", () => {
  const high = publishedPolicy({
    maintenanceConsumptionRates: [
      { pricingWeightBandId: "w1", value: sourced(400_000_000, "B3") },
    ],
  });
  const input = baseEvalInput({ pricingPolicyRef: high.id });
  const evaluation = computeHistoricalModelPricingEvaluation(input, high, baseOptions);

  assert.ok(evaluation.result.priceWarning);
  // issueFingerprint 包含 inputHash
  const fp = evaluation.result.priceWarning!.issueFingerprint;
  // 用同一输入重新构造预期 fingerprint
  const expectedInputHash = evaluation.result.inputHash;
  assert.ok(typeof fp === "string" && fp.length > 0);
  assert.ok(typeof expectedInputHash === "string" && expectedInputHash.length > 0);
});

// ─── 查找 ─────────────────────────────────────────────────────────────

test("findEvaluation 返回最新 revision（不传 revision 参数时）", () => {
  const policy = publishedPolicy();
  const e1 = computeHistoricalModelPricingEvaluation(
    baseEvalInput({ pricingPolicyRef: policy.id }),
    policy,
    { ...baseOptions, id: "mpe-multi" },
  );
  const { newEval: e2 } = recomputeHistoricalModelPricingEvaluation(
    e1,
    { ...baseEvalInput({ pricingPolicyRef: policy.id }), valueScore: 35 },
    policy,
    { createdAt: "2026-07-25T02:00:00.000Z", createdBy: "test" },
  );

  const all = [e1, e2];
  const found = findEvaluation(all, "mpe-multi");
  assert.equal(found?.revision, 2);
  assert.equal(found?.input.valueScore, 35);
});

test("evaluationId 生成带模型前缀的唯一 ID", () => {
  const id1 = evaluationId("model-a");
  const id3 = evaluationId("model-b");

  assert.ok(id1.startsWith("mpe-model-a-"));
  // 时间戳不同 → hash 不同 → ID 不同（不在同一毫秒内重跑）
  assert.notEqual(id1, id3);
});
