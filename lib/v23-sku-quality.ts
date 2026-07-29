import { jcsSha256Hex } from "./canonical-json";
import type { QualityId } from "./pricing-policy";
import type { QualityValuePolicyDraft } from "./quality-value-policy";
import { deterministicHash } from "./rule-kernel";
import type {
  FunctionProfile,
  SeriesPartRevision,
  SkuDrawerRevision,
  V23ProjectAffixPayload,
  V23SkuAffixValueAssessment,
  V23SkuQualityTraceEntry,
  V23StableContentRef,
} from "./types";

export const V23_QUALITY_SCORING_POLICY_VERSION = "v23-quality-scoring/open007-target-v1";
const TARGET_RANGES: Array<{ qualityId: QualityId; min: number; max: number }> = [
  { qualityId: "quality_c_green", min: 0, max: 20 },
  { qualityId: "quality_b_blue", min: 20, max: 40 },
  { qualityId: "quality_a_purple", min: 40, max: 65 },
  { qualityId: "quality_s_orange", min: 65, max: 100 },
];

export class V23SkuQualityError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "V23SkuQualityError";
  }
}

export interface V23QualityEntry {
  ref: V23StableContentRef;
  payload: V23ProjectAffixPayload;
  localCopyId?: string;
  copyHash?: string;
}

function stableCompare(left: string, right: string) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function assertTargetPolicy(policy: QualityValuePolicyDraft) {
  if (policy.formalStatus !== "READY_TO_PUBLISH"
    || policy.issues.some((entry) => entry.severity === "ERROR" || entry.severity === "BLOCKER")
    || !policy.sourceRevisionId
    || !policy.sourceRevision
    || policy.inputHash !== deterministicHash(Object.fromEntries(
      Object.entries(policy).filter(([key]) => !["id", "inputHash"].includes(key)),
    ))) {
    throw new V23SkuQualityError("V23_QUALITY_POLICY_UNUSABLE", "目标品质策略必须来源完整、无冲突且内容哈希有效。");
  }
  if (policy.ranges.length !== TARGET_RANGES.length
    || TARGET_RANGES.some((target) => {
      const matches = policy.ranges.filter((entry) => entry.qualityId === target.qualityId);
      return matches.length !== 1
        || matches[0]!.minScore !== target.min
        || matches[0]!.maxScore !== target.max
        || matches[0]!.maxInclusive
        || matches[0]!.status !== "SOURCE";
    })) {
    throw new V23SkuQualityError("QUALITY_RANGE_SOURCE_OUTDATED", "品质源必须精确表达目标 [min,max) 区间。");
  }
}

export function resolveV23TargetQualityPolicy(policies: readonly QualityValuePolicyDraft[]) {
  const candidates = policies.filter((policy) => {
    try { assertTargetPolicy(policy); return true; } catch { return false; }
  });
  if (candidates.length !== 1) {
    throw new V23SkuQualityError(
      candidates.length ? "V23_QUALITY_POLICY_AMBIGUOUS" : "V23_QUALITY_POLICY_UNAVAILABLE",
      "必须唯一解析可用的 v23 目标品质策略。",
    );
  }
  return candidates[0]!;
}

function resolveFunctionFactor(
  profiles: readonly FunctionProfile[],
  part: SeriesPartRevision,
) {
  const profileMatches = profiles.filter((entry) => entry.id === part.functionProfileId && entry.enabled);
  if (profileMatches.length !== 1) {
    throw new V23SkuQualityError("V23_FUNCTION_PROFILE_UNRESOLVED", "Part 功能定位必须唯一解析。");
  }
  const itemPartId = `part:${part.partType}`;
  const members = profileMatches[0]!.intensityRules.filter(
    (entry) => entry.itemPartId === itemPartId && entry.intensity === part.functionIntensity,
  );
  if (members.length !== 1
    || !Number.isFinite(members[0]!.scoreFactor)
    || members[0]!.scoreFactor! <= 0
    || !members[0]!.scoreFactorSourceRef) {
    throw new V23SkuQualityError("V23_FUNCTION_SCORE_FACTOR_UNRESOLVED", "评分系数必须绑定精确部位、强度和源证据。");
  }
  return { value: members[0]!.scoreFactor!, sourceRef: members[0]!.scoreFactorSourceRef! };
}

function recommend(score: number): QualityId | null {
  return TARGET_RANGES.find((range) => score >= range.min && score < range.max)?.qualityId ?? null;
}

export function deriveV23SkuQuality(input: {
  skuRevisionId: string;
  part: SeriesPartRevision;
  entries: readonly V23QualityEntry[];
  policy: QualityValuePolicyDraft;
  functionProfiles: readonly FunctionProfile[];
  selectedQualityId?: QualityId;
  overrideReason?: string | null;
}): V23SkuAffixValueAssessment {
  assertTargetPolicy(input.policy);
  const functionFactor = resolveFunctionFactor(input.functionProfiles, input.part);
  const entriesById = new Map<string, V23QualityEntry>();
  for (const entry of input.entries) {
    const existing = entriesById.get(entry.ref.id);
    if (existing && jcsSha256Hex(existing) !== jcsSha256Hex(entry)) {
      throw new V23SkuQualityError("V23_QUALITY_AFFIX_IDENTITY_CONFLICT", "同一稳定词条 ID 出现不同 revision、来源或 Payload。");
    }
    if (!existing) entriesById.set(entry.ref.id, entry);
  }
  const entries = [...entriesById.values()].sort((a, b) => stableCompare(a.ref.id, b.ref.id));
  if (entries.some((entry) => entry.payload.itemPartId !== `part:${input.part.partType}`
    || !Number.isFinite(entry.payload.valueScore))) {
    throw new V23SkuQualityError("V23_QUALITY_AFFIX_INVALID", "品质评分词条必须属于同一部位并具有有限价值分。");
  }
  const trace: V23SkuQualityTraceEntry[] = [];
  let baseAffixScore = 0;
  const affixBreakdown = entries.map((entry) => {
    const before = baseAffixScore;
    baseAffixScore += entry.payload.valueScore;
    if (!Number.isFinite(baseAffixScore)) throw new V23SkuQualityError("V23_QUALITY_SCORE_NON_FINITE", "词条评分计算非有限。");
    const sourceRef = entry.localCopyId
      ? `local:${entry.localCopyId}@${entry.copyHash}`
      : `affix:${entry.ref.id}@${entry.ref.revision}#${entry.ref.contentHash}`;
    trace.push({ sequence: trace.length + 1, step: "affix", sourceRef, subjectIds: [entry.ref.id], before, operation: "add", operand: entry.payload.valueScore, after: baseAffixScore });
    return { sourceAffixId: entry.ref.id, valueScore: entry.payload.valueScore, sourceRef };
  });
  const selectedIds = new Set(entries.map((entry) => entry.ref.id));
  const seenPairs = new Set<string>();
  const combinationBreakdown = input.policy.combinationRules
    .filter((rule) => rule.itemPartId === `part:${input.part.partType}`
      && selectedIds.has(rule.leftAffixId) && selectedIds.has(rule.rightAffixId))
    .sort((a, b) => stableCompare(`${a.leftAffixId}\0${a.rightAffixId}`, `${b.leftAffixId}\0${b.rightAffixId}`))
    .map((rule) => {
      const [leftAffixId, rightAffixId] = [rule.leftAffixId, rule.rightAffixId].sort(stableCompare);
      const key = `${leftAffixId}\0${rightAffixId}`;
      if (leftAffixId === rightAffixId || seenPairs.has(key) || !Number.isFinite(rule.valueScore)) {
        throw new V23SkuQualityError("QUALITY_COMBINATION_CONFLICT", "组合策略包含重复、对角或非有限规则。");
      }
      seenPairs.add(key);
      return { leftAffixId, rightAffixId, valueScore: rule.valueScore, sourceRef: `${rule.source.sheetId}!${rule.source.cell}` };
    });
  let combinationScore = 0;
  for (const combination of combinationBreakdown) {
    const before = baseAffixScore + combinationScore;
    combinationScore += combination.valueScore;
    if (!Number.isFinite(combinationScore)) throw new V23SkuQualityError("V23_QUALITY_SCORE_NON_FINITE", "组合评分计算非有限。");
    trace.push({ sequence: trace.length + 1, step: "combination", sourceRef: combination.sourceRef, subjectIds: [combination.leftAffixId, combination.rightAffixId], before, operation: "add", operand: combination.valueScore, after: baseAffixScore + combinationScore });
  }
  const beforeFunction = baseAffixScore + combinationScore;
  const finalValueScore = beforeFunction * functionFactor.value;
  if (!Number.isFinite(beforeFunction) || !Number.isFinite(finalValueScore)) {
    throw new V23SkuQualityError("V23_QUALITY_SCORE_NON_FINITE", "功能系数计算产生非有限结果。");
  }
  trace.push({ sequence: trace.length + 1, step: "function_factor", sourceRef: functionFactor.sourceRef, subjectIds: [input.part.functionProfileId, String(input.part.functionIntensity)], before: beforeFunction, operation: "multiply", operand: functionFactor.value, after: finalValueScore });
  const recommendedQualityId = recommend(finalValueScore);
  const selectedQualityId = input.selectedQualityId ?? recommendedQualityId;
  if (selectedQualityId === null) {
    throw new V23SkuQualityError("V23_QUALITY_ACTUAL_SELECTION_REQUIRED", "评分没有推荐品质，必须显式选择实际品质并说明理由。");
  }
  const selectedRange = TARGET_RANGES.find((range) => range.qualityId === selectedQualityId)!;
  const inSelectedQualityRange = finalValueScore >= selectedRange.min && finalValueScore < selectedRange.max;
  trace.push({ sequence: trace.length + 1, step: "quality_range", sourceRef: `${input.policy.id}:${selectedQualityId}`, subjectIds: [selectedQualityId], before: finalValueScore, operation: "validate", operand: selectedRange.max, after: finalValueScore });
  const reason = input.overrideReason?.trim() || null;
  const qualityOverrideState: V23SkuAffixValueAssessment["qualityOverrideState"] = recommendedQualityId === null
    ? "NO_RECOMMENDATION"
    : recommendedQualityId === selectedQualityId ? "MATCHED" : "OVERRIDDEN";
  if (qualityOverrideState !== "MATCHED" && reason === null) {
    throw new V23SkuQualityError("V23_QUALITY_OVERRIDE_REASON_REQUIRED", "无推荐或选择非推荐品质时必须提供理由。");
  }
  if (qualityOverrideState === "MATCHED" && reason !== null) {
    throw new V23SkuQualityError("V23_QUALITY_OVERRIDE_REASON_FORBIDDEN", "采纳推荐时不得保存覆盖理由。");
  }
  const content = {
    skuRevisionId: input.skuRevisionId,
    recommendedQualityId,
    selectedQualityId,
    qualityOverrideState,
    qualityOverrideReason: reason,
    baseAffixScore,
    combinationScore,
    functionScoreFactor: functionFactor.value,
    finalValueScore,
    affixBreakdown,
    combinationBreakdown,
    trace,
    qualityRangePolicyVersion: input.policy.id,
    scoringPolicyVersion: V23_QUALITY_SCORING_POLICY_VERSION,
    inSelectedQualityRange,
  };
  return { ...content, inputHash: jcsSha256Hex(content) };
}

export function v23PricingInputFromAssessment(input: {
  sku: SkuDrawerRevision;
  pricingPolicyVersion: string;
}) {
  if (input.sku.quality.status !== "ASSESSED") {
    throw new V23SkuQualityError("V23_PRICING_QUALITY_UNASSESSED", "定价要求已冻结的 SKU 品质评估。");
  }
  const assessment = input.sku.quality.assessment;
  if (assessment.skuRevisionId !== `${input.sku.skuId}@${input.sku.revision}`
    || assessment.inputHash !== jcsSha256Hex(Object.fromEntries(
      Object.entries(assessment).filter(([key]) => key !== "inputHash"),
    ))
    || assessment.qualityRangePolicyVersion.length === 0
    || assessment.scoringPolicyVersion !== V23_QUALITY_SCORING_POLICY_VERSION) {
    throw new V23SkuQualityError("V23_PRICING_QUALITY_EVIDENCE_INVALID", "SKU 品质评估证据不完整或已过期。");
  }
  return {
    qualityId: assessment.selectedQualityId,
    finalValueScore: assessment.finalValueScore,
    pricingWeightBandId: input.sku.weightBandId,
    pricingPolicyVersion: input.pricingPolicyVersion,
    qualityAssessmentInputHash: assessment.inputHash,
  };
}
