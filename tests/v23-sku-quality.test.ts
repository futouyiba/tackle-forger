import assert from "node:assert/strict";
import test from "node:test";
import { jcsSha256Hex } from "../lib/canonical-json";
import { importQualityValuePolicyDraft, type QualityValueRange } from "../lib/quality-value-policy";
import type { PricingPolicyVersion } from "../lib/pricing-policy";
import {
  deriveV23SkuQuality,
  resolveV23TargetQualityPolicy,
  v23PricingInputFromAssessment,
  V23SkuQualityError,
} from "../lib/v23-sku-quality";
import type {
  FunctionProfile,
  SeriesPartRevision,
  SkuDrawerRevision,
  V23ProjectAffixPayload,
} from "../lib/types";

const ranges: QualityValueRange[] = [
  ["quality_c_green", 0, 20],
  ["quality_b_blue", 20, 40],
  ["quality_a_purple", 40, 65],
  ["quality_s_orange", 65, 100],
].map(([qualityId, minScore, maxScore], index) => ({
  qualityId: qualityId as QualityValueRange["qualityId"],
  minScore: Number(minScore),
  maxScore: Number(maxScore),
  maxInclusive: false,
  status: "SOURCE",
  source: { sheetId: "27hboC", cell: `E${index + 5}:F${index + 5}` },
}));

function policy(options: { combination?: number; target?: boolean } = {}) {
  return importQualityValuePolicyDraft({
    sourceRevisionId: "source:quality@500",
    sourceRevision: "500",
    ranges: options.target === false
      ? ranges.map((range) => range.qualityId === "quality_s_orange" ? { ...range, maxInclusive: true } : range)
      : ranges,
    aliases: [
      { itemPartId: "part:rod", alias: "甲", affixId: "affix:a", source: { sheetId: "23CsXE", cell: "B2" } },
      { itemPartId: "part:rod", alias: "乙", affixId: "affix:b", source: { sheetId: "23CsXE", cell: "B3" } },
    ],
    matrixCells: options.combination === undefined ? [] : [
      { itemPartId: "part:rod", leftAlias: "甲", rightAlias: "乙", value: options.combination, source: { sheetId: "27hboC", cell: "M2" } },
      { itemPartId: "part:rod", leftAlias: "乙", rightAlias: "甲", value: options.combination, source: { sheetId: "27hboC", cell: "N2" } },
    ],
    importedAt: "2026-07-29T00:00:00.000Z",
  });
}

const part: SeriesPartRevision = {
  partId: "part:one",
  seriesId: "series:one",
  revision: 1,
  partType: "rod",
  fishingMethodId: "method:lure",
  materialTypeId: "material:carbon",
  functionProfileId: "function:distance",
  functionIntensity: 2,
  weightBandIds: ["band:one"],
  defaultEntryRefs: [],
  technologyRefs: [],
  inputFingerprint: "1".repeat(64),
  contentHash: "2".repeat(64),
};

const functionProfiles: FunctionProfile[] = [{
  id: "function:distance",
  name: "远投",
  rules: [],
  intensityRules: [{
    intensity: 2,
    itemPartId: "part:rod",
    rules: [],
    scoreFactor: 1.03,
    scoreFactorSourceRef: "16qYVn!F2@source:quality@500",
    sourceRowId: "func:distance:2",
  }],
  enabled: true,
  sourceRevisionId: "source:quality@500",
  notes: "",
}];

function payload(score: number): V23ProjectAffixPayload {
  return {
    name: "词条",
    category: "passive",
    itemPartId: "part:rod",
    semanticContributionKey: "score",
    stackingPolicy: "dedupe",
    generationPolicy: "normal",
    rarity: "common",
    valueScore: score,
    tags: [],
    description: "",
    enabled: true,
    operations: [],
    passivePayload: {
      skillId: "skill:one", name: "技能", itemPartId: "part:rod", triggerType: "none",
      triggerDescription: "", effectTarget: "", effectLogicDescription: "", exampleParameters: {},
      durationDescription: "", cooldownDescription: "", resetDescription: "", stackingDescription: "",
      playerDescription: "", simulatorReferenceKey: null,
    },
  };
}

function entry(id: string, score: number) {
  const item = payload(score);
  return {
    ref: { id, revision: 1, contentHash: jcsSha256Hex({ id, item }) },
    payload: item,
  };
}

function pricingPolicy(options: { inclusive?: boolean; legacy?: boolean } = {}) {
  return {
    id: "pricing:v23",
    formalStatus: options.legacy ? "LEGACY_PUBLISHED" : "PUBLISHED",
    qualityPriceFactorRanges: ranges.map((range) => ({
      ...range,
      maxInclusive: options.inclusive && range.qualityId === "quality_s_orange",
      minFactor: 1,
      maxFactor: 2,
    })),
  } as PricingPolicyVersion;
}

function pricingContext(sku: SkuDrawerRevision, options: {
  qualityPolicy?: ReturnType<typeof policy>;
  profiles?: FunctionProfile[];
  canonicalProfiles?: FunctionProfile[];
  pricing?: PricingPolicyVersion;
} = {}) {
  return {
    sku,
    part,
    qualityPolicy: options.qualityPolicy ?? policy(),
    functionProfiles: options.profiles ?? functionProfiles,
    canonicalFunctionProfiles: options.canonicalProfiles ?? functionProfiles,
    pricingPolicy: options.pricing ?? pricingPolicy(),
  };
}

test("v23 SKU 品质按去重词条、同部位无序组合与精确功能系数确定性计算", () => {
  const assessment = deriveV23SkuQuality({
    skuRevisionId: "sku:one@1",
    part,
    entries: [entry("affix:a", 10), entry("affix:b", 5), entry("affix:a", 10)],
    policy: policy({ combination: 3 }),
    functionProfiles,
    canonicalFunctionProfiles: functionProfiles,
  });
  assert.equal(assessment.baseAffixScore, 15);
  assert.equal(assessment.combinationScore, 3);
  assert.equal(assessment.finalValueScore, 18.54);
  assert.equal(assessment.recommendedQualityId, "quality_c_green");
  assert.equal(assessment.selectedQualityId, "quality_c_green");
  assert.equal(assessment.qualityOverrideState, "MATCHED");
  assert.equal(assessment.combinationBreakdown.length, 1);
  assert.deepEqual(
    assessment.trace.map((step) => step.step),
    ["affix", "affix", "combination", "function_factor", "quality_range"],
  );
  assert.equal(assessment.trace[2]!.before, 15);
  assert.equal(assessment.trace[2]!.after, 18);
  assert.equal(assessment.trace[3]!.before, 18);

  const conflictingRevision = entry("affix:a", 10);
  conflictingRevision.ref.revision = 2;
  assert.throws(() => deriveV23SkuQuality({
    skuRevisionId: "sku:one@1",
    part,
    entries: [entry("affix:a", 10), conflictingRevision],
    policy: policy(),
    functionProfiles,
    canonicalFunctionProfiles: functionProfiles,
  }), /V23_QUALITY_AFFIX_IDENTITY_CONFLICT/);
});

test("目标 [min,max) 边界使 99.999 推荐 S，100 与更高分不推荐", () => {
  const profile = structuredClone(functionProfiles);
  profile[0]!.intensityRules[0]!.scoreFactor = 1;
  const assess = (score: number, selectedQualityId?: "quality_s_orange") => deriveV23SkuQuality({
    skuRevisionId: `sku:${score}@1`,
    part,
    entries: [entry("affix:a", score)],
    policy: policy(),
    functionProfiles: profile,
    canonicalFunctionProfiles: profile,
    ...(selectedQualityId ? { selectedQualityId, overrideReason: "评分越界后人工选择" } : {}),
  });
  assert.equal(assess(99.999).recommendedQualityId, "quality_s_orange");
  assert.throws(() => assess(100), (error) => error instanceof V23SkuQualityError && error.code === "V23_QUALITY_ACTUAL_SELECTION_REQUIRED");
  const hundred = assess(100, "quality_s_orange");
  assert.equal(hundred.recommendedQualityId, null);
  assert.equal(hundred.qualityOverrideState, "NO_RECOMMENDATION");
  assert.equal(hundred.inSelectedQualityRange, false);
});

test("实际品质覆盖必须有理由，定价输入只消费实际品质与 SKU 重量段", () => {
  const assessment = deriveV23SkuQuality({
    skuRevisionId: "sku:one@2",
    part,
    entries: [entry("affix:a", 10)],
    policy: policy(),
    functionProfiles,
    canonicalFunctionProfiles: functionProfiles,
    selectedQualityId: "quality_b_blue",
    overrideReason: "设计定位要求蓝色品质",
  });
  assert.equal(assessment.recommendedQualityId, "quality_c_green");
  assert.equal(assessment.selectedQualityId, "quality_b_blue");
  assert.throws(() => deriveV23SkuQuality({
    skuRevisionId: "sku:one@2", part, entries: [entry("affix:a", 10)],
    policy: policy(), functionProfiles, canonicalFunctionProfiles: functionProfiles,
    selectedQualityId: "quality_b_blue",
  }), /V23_QUALITY_OVERRIDE_REASON_REQUIRED/);
  const sku = {
    skuId: "sku:one", revision: 2, partId: part.partId, partRevision: part.revision,
    weightBandId: "band:one",
    quality: { status: "ASSESSED", assessment },
  } as SkuDrawerRevision;
  assert.deepEqual(v23PricingInputFromAssessment(pricingContext(sku)), {
    qualityId: "quality_b_blue",
    finalValueScore: assessment.finalValueScore,
    pricingWeightBandId: "band:one",
    pricingPolicyVersion: "pricing:v23",
    qualityAssessmentInputHash: assessment.inputHash,
  });
  assert.equal(assessment.inSelectedQualityRange, false, "合法 override 可位于推荐区间之外");
});

test("评分达到 100 的实际品质仍拒绝进入新的正式定价", () => {
  const profile = structuredClone(functionProfiles);
  profile[0]!.intensityRules[0]!.scoreFactor = 1;
  const assessment = deriveV23SkuQuality({
    skuRevisionId: "sku:score-100@1",
    part,
    entries: [entry("affix:score-100", 100)],
    policy: policy(),
    functionProfiles: profile,
    canonicalFunctionProfiles: profile,
    selectedQualityId: "quality_s_orange",
    overrideReason: "评分越界后人工实测",
  });
  const sku = {
    skuId: "sku:score-100",
    revision: 1,
    partId: part.partId,
    partRevision: part.revision,
    weightBandId: "band:one",
    quality: { status: "ASSESSED", assessment },
  } as SkuDrawerRevision;
  assert.throws(
    () => v23PricingInputFromAssessment(pricingContext(sku, {
      profiles: profile,
      canonicalProfiles: profile,
    })),
    (error) => error instanceof V23SkuQualityError
      && error.code === "V23_PRICING_QUALITY_SCORE_OUT_OF_RANGE",
  );
});

test("当前策略、功能源 revision 或 pricing 区间变化后旧 assessment 不可定价", () => {
  const assessment = deriveV23SkuQuality({
    skuRevisionId: "sku:stale@1",
    part,
    entries: [entry("affix:a", 10)],
    policy: policy(),
    functionProfiles,
    canonicalFunctionProfiles: functionProfiles,
  });
  const sku = {
    skuId: "sku:stale", revision: 1, partId: part.partId, partRevision: part.revision,
    weightBandId: "band:one", quality: { status: "ASSESSED", assessment },
  } as SkuDrawerRevision;
  const changedPolicy = policy();
  changedPolicy.sourceRevisionId = "source:quality@501";
  assert.throws(
    () => v23PricingInputFromAssessment(pricingContext(sku, { qualityPolicy: changedPolicy })),
    /V23_PRICING_QUALITY_EVIDENCE_INVALID/,
  );
  const changedProfile = structuredClone(functionProfiles);
  changedProfile[0]!.sourceRevisionId = "source:quality@501";
  assert.throws(
    () => v23PricingInputFromAssessment(pricingContext(sku, { profiles: changedProfile })),
    /V23_PRICING_QUALITY_EVIDENCE_INVALID/,
  );
  const changedRef = structuredClone(functionProfiles);
  changedRef[0]!.intensityRules[0]!.scoreFactorSourceRef = "16qYVn!F2@source:quality@501";
  assert.throws(
    () => v23PricingInputFromAssessment(pricingContext(sku, { profiles: changedRef })),
    /V23_PRICING_QUALITY_EVIDENCE_INVALID/,
  );
  const selfReportedFactor = structuredClone(functionProfiles);
  selfReportedFactor[0]!.intensityRules[0]!.scoreFactor = 1.5;
  assert.throws(
    () => v23PricingInputFromAssessment(pricingContext(sku, {
      profiles: selfReportedFactor,
      canonicalProfiles: functionProfiles,
    })),
    /V23_PRICING_QUALITY_EVIDENCE_INVALID/,
  );
  for (const pricing of [
    pricingPolicy({ inclusive: true }),
    pricingPolicy({ legacy: true }),
  ]) {
    assert.throws(
      () => v23PricingInputFromAssessment(pricingContext(sku, { pricing })),
      /V23_PRICING_POLICY_UNUSABLE/,
    );
  }
});

test("禁用 inherited、added 或 local-copy 词条及其组合均阻断评分", () => {
  const enabled = entry("affix:a", 10);
  const disabled = entry("affix:b", 5);
  disabled.payload.enabled = false;
  const withCombination = policy({ combination: 3 });
  for (const candidate of [
    disabled,
    { ...disabled, localCopyId: "copy:disabled", copyHash: "f".repeat(64) },
    { ...disabled, ref: { ...disabled.ref, id: "affix:disabled-added" } },
  ]) {
    assert.throws(
      () => deriveV23SkuQuality({
        skuRevisionId: "sku:disabled@1",
        part,
        entries: [enabled, candidate],
        policy: withCombination,
        functionProfiles,
        canonicalFunctionProfiles: functionProfiles,
      }),
      (error) => error instanceof V23SkuQualityError
        && error.code === "V23_QUALITY_AFFIX_DISABLED",
    );
  }
});

test("旧含上界策略、多个目标策略与缺失评分系数均 fail closed", () => {
  assert.throws(() => resolveV23TargetQualityPolicy([policy({ target: false })]), /V23_QUALITY_POLICY_UNAVAILABLE/);
  const target = policy();
  assert.throws(() => resolveV23TargetQualityPolicy([target, structuredClone(target)]), /V23_QUALITY_POLICY_AMBIGUOUS/);
  const noFactor = structuredClone(functionProfiles);
  delete noFactor[0]!.intensityRules[0]!.scoreFactor;
  assert.throws(() => deriveV23SkuQuality({
    skuRevisionId: "sku:one@1", part, entries: [], policy: target,
    functionProfiles: noFactor, canonicalFunctionProfiles: functionProfiles,
  }), /V23_FUNCTION_SCORE_FACTOR_UNRESOLVED/);
});
