import type { ResolvedAffixConfiguration } from "./affix-engine";
import type { CapabilityCode } from "./interaction-contracts";
import type { PricingCellRef, PricingInputStatus, QualityId, SourcedPricingValue } from "./pricing-policy";
import { deterministicHash } from "./rule-kernel";

export interface QualityValueRange {
  qualityId: QualityId;
  minScore: number;
  maxScore: number;
  maxInclusive: boolean;
  source: PricingCellRef;
  status: PricingInputStatus;
}

export interface AffixAliasBinding {
  itemPartId: string;
  alias: string;
  affixId: string;
  source: PricingCellRef;
}

export interface QualityCombinationSourceCell {
  itemPartId: string;
  leftAlias: string;
  rightAlias: string;
  value: number | "" | "—";
  source: PricingCellRef;
}

export interface QualityCombinationRule {
  itemPartId: string;
  leftAffixId: string;
  rightAffixId: string;
  valueScore: number;
  source: PricingCellRef;
}

export interface QualityActionLink {
  action: "navigate" | "edit_rule" | "retry" | "recompute";
  label: string;
  targetRoute?: string;
  enabled: boolean;
  requiredCapabilities: CapabilityCode[];
}

export interface QualityValidationIssue {
  source: "quality";
  code: string;
  severity: "WARNING" | "ERROR" | "BLOCKER";
  gate: "REVIEW" | "PUBLISH";
  message: string;
  sourceRevision: string;
  sourceCell?: PricingCellRef;
  /** Explicit matrix-part evidence; absent on historical diagnostics. */
  itemPartId?: string;
  relatedObjectIds: string[];
  actions: QualityActionLink[];
}

export interface QualityValuePolicyDraft {
  id: string;
  sourceRevisionId: string;
  sourceRevision: string;
  qualitySheetId: "FqD4j7";
  affixSheetId: "zrVOxd";
  ranges: QualityValueRange[];
  combinationRules: QualityCombinationRule[];
  /** 旧规则源的性能计分字段仅作为迁移证据保留，正式评分不得消费。 */
  legacyPerformanceScoringEvidence?: {
    enabled?: boolean;
    source?: PricingCellRef;
  };
  issues: QualityValidationIssue[];
  formalStatus: "NON_FORMAL" | "READY_TO_PUBLISH";
  inputHash: string;
  importedAt: string;
}

export interface QualityScoreTraceEntry {
  sequence: number;
  step: "affix" | "combination" | "function_factor" | "performance_factor" | "quality_range";
  sourceRevision: string;
  source: PricingCellRef;
  subjectIds: string[];
  before: number;
  operation: "add" | "multiply" | "validate";
  operand: number;
  after: number;
}

export interface ModelAffixValueAssessment {
  modelRevisionId: string;
  selectedQualityId: QualityId;
  baseAffixScore: number;
  combinationScore: number;
  functionScoreFactor: number;
  /** 仅旧策略重放结果可能包含；新评分不得写入。 */
  performanceScoreFactor?: number;
  finalValueScore: number;
  affixBreakdown: Array<{ sourceAffixId: string; valueScore: number; sourceRef: string }>;
  combinationBreakdown: Array<{
    leftAffixId: string;
    rightAffixId: string;
    valueScore: number;
    sourceRef: string;
  }>;
  qualityRangePolicyVersion: string;
  scoringPolicyVersion: string;
  inSelectedQualityRange: boolean;
  formal: boolean;
  issues: QualityValidationIssue[];
  trace: QualityScoreTraceEntry[];
  inputHash: string;
}

function issue(input: Omit<QualityValidationIssue, "source" | "actions">): QualityValidationIssue {
  return {
    source: "quality",
    ...input,
    actions: [
      {
        action: "navigate",
        label: "查看规则源",
        targetRoute: "/?page=rule-workbook",
        enabled: true,
        requiredCapabilities: ["feishu.workbook.read"],
      },
      {
        action: "retry",
        label: "修复后重新拉取",
        targetRoute: "/?page=rule-workbook",
        enabled: true,
        requiredCapabilities: ["feishu.workbook.pull"],
      },
    ],
  };
}

function pairKey(left: string, right: string) {
  return [left, right].sort().join("\u0000");
}

export function importQualityValuePolicyDraft(input: {
  sourceRevisionId: string;
  sourceRevision: string;
  ranges: QualityValueRange[];
  aliases: AffixAliasBinding[];
  matrixCells: QualityCombinationSourceCell[];
  pricingScoreEndpoints?: SourcedPricingValue<number>[];
  performanceScoringEnabled?: boolean;
  performanceScoringSource?: PricingCellRef;
  /** Source-shape diagnostics retained with the draft; all are publish gates. */
  sourceIssues?: QualityValidationIssue[];
  importedAt: string;
}): QualityValuePolicyDraft {
  const issues: QualityValidationIssue[] = [...(input.sourceIssues ?? [])];
  const orderedRanges = [...input.ranges].sort((left, right) => left.minScore - right.minScore);
  const qualityIds: QualityId[] = ["quality_c_green", "quality_b_blue", "quality_a_purple", "quality_s_orange"];
  for (const qualityId of qualityIds) {
    const matches = input.ranges.filter((range) => range.qualityId === qualityId);
    if (matches.length !== 1) {
      issues.push(issue({
        code: matches.length ? "QUALITY_RANGE_DUPLICATE" : "QUALITY_RANGE_MISSING",
        severity: "ERROR",
        gate: "PUBLISH",
        message: `${qualityId} 必须且只能导入一个评分区间。`,
        sourceRevision: input.sourceRevision,
        relatedObjectIds: [qualityId],
      }));
    }
  }
  for (let index = 1; index < orderedRanges.length; index += 1) {
    if (orderedRanges[index - 1].maxScore !== orderedRanges[index].minScore) {
      issues.push(issue({
        code: "QUALITY_RANGE_GAP_OR_OVERLAP",
        severity: "ERROR",
        gate: "PUBLISH",
        message: "品质评分区间必须互斥且无空洞。",
        sourceRevision: input.sourceRevision,
        sourceCell: orderedRanges[index].source,
        relatedObjectIds: [orderedRanges[index - 1].qualityId, orderedRanges[index].qualityId],
      }));
      break;
    }
  }

  const aliasMap = new Map(input.aliases.map((entry) => [`${entry.itemPartId}\u0000${entry.alias}`, entry]));
  const rulesByPair = new Map<string, QualityCombinationRule>();
  for (const cell of input.matrixCells) {
    if (cell.value === "" || cell.value === "—") continue;
    const left = aliasMap.get(`${cell.itemPartId}\u0000${cell.leftAlias}`);
    const right = aliasMap.get(`${cell.itemPartId}\u0000${cell.rightAlias}`);
    if (!left || !right) {
      issues.push(issue({
        code: "QUALITY_COMBINATION_ALIAS_UNKNOWN",
        severity: "ERROR",
        gate: "PUBLISH",
        message: `组合矩阵缩写无法解析为稳定 affixId：${cell.leftAlias} × ${cell.rightAlias}。`,
        sourceRevision: input.sourceRevision,
        sourceCell: cell.source,
        itemPartId: cell.itemPartId,
        relatedObjectIds: [],
      }));
      continue;
    }
    if (left.itemPartId !== right.itemPartId) {
      issues.push(issue({
        code: "QUALITY_COMBINATION_CROSS_PART",
        severity: "ERROR",
        gate: "PUBLISH",
        message: "词条组合只能发生在相同部位。",
        sourceRevision: input.sourceRevision,
        sourceCell: cell.source,
        itemPartId: cell.itemPartId,
        relatedObjectIds: [left.affixId, right.affixId],
      }));
      continue;
    }
    if (left.affixId === right.affixId) continue;
    const key = pairKey(left.affixId, right.affixId);
    const current = rulesByPair.get(key);
    if (current && current.valueScore !== cell.value) {
      issues.push(issue({
        code: "QUALITY_COMBINATION_CONFLICT",
        severity: "ERROR",
        gate: "PUBLISH",
        message: `无序词条对 ${left.affixId} × ${right.affixId} 双侧值不一致。`,
        sourceRevision: input.sourceRevision,
        sourceCell: cell.source,
        itemPartId: cell.itemPartId,
        relatedObjectIds: [left.affixId, right.affixId],
      }));
      continue;
    }
    if (!current) {
      const [leftAffixId, rightAffixId] = [left.affixId, right.affixId].sort();
      rulesByPair.set(key, {
        itemPartId: cell.itemPartId,
        leftAffixId,
        rightAffixId,
        valueScore: cell.value,
        source: cell.source,
      });
    }
  }

  const sRange = input.ranges.find((range) => range.qualityId === "quality_s_orange");
  const conflictingEndpoint = input.pricingScoreEndpoints?.find(
    (entry) => entry.value === sRange?.maxScore,
  );
  if (sRange && !sRange.maxInclusive && conflictingEndpoint) {
    issues.push(issue({
      code: "QUALITY_SCORE_BOUNDARY_CONFLICT",
      severity: "ERROR",
      gate: "PUBLISH",
      message: "07_品质评分的 S 区间为 [65,100)，但 08_价格计算包含 score=100；评分100不得夹取。",
      sourceRevision: input.sourceRevision,
      sourceCell: conflictingEndpoint.source,
      relatedObjectIds: ["quality_s_orange"],
    }));
  }

  const content = {
    sourceRevisionId: input.sourceRevisionId,
    sourceRevision: input.sourceRevision,
    qualitySheetId: "FqD4j7" as const,
    affixSheetId: "zrVOxd" as const,
    ranges: structuredClone(input.ranges),
    combinationRules: [...rulesByPair.values()],
    ...(
      input.performanceScoringEnabled !== undefined || input.performanceScoringSource
        ? {
            legacyPerformanceScoringEvidence: {
              enabled: input.performanceScoringEnabled,
              source: input.performanceScoringSource,
            },
          }
        : {}
    ),
    issues,
    formalStatus: issues.some((entry) => entry.severity === "ERROR" || entry.severity === "BLOCKER")
      ? "NON_FORMAL" as const
      : "READY_TO_PUBLISH" as const,
    importedAt: input.importedAt,
  };
  const inputHash = deterministicHash(content);
  return { id: `quality-policy-draft:${inputHash}`, ...content, inputHash };
}

function inRange(value: number, range: QualityValueRange) {
  return value >= range.minScore && (value < range.maxScore || (range.maxInclusive && value === range.maxScore));
}

export function assessModelAffixValue(input: {
  policy: QualityValuePolicyDraft;
  modelRevisionId: string;
  selectedQualityId: QualityId;
  configuration: ResolvedAffixConfiguration;
  functionScoreFactor: SourcedPricingValue<number>;
  scoringPolicyVersion: string;
}): ModelAffixValueAssessment {
  return assessModelAffixValueInternal(input);
}

/**
 * 只供已冻结旧策略的审计重放。新 Model、候选、Snapshot 与定价链不得调用。
 */
export function assessLegacyModelAffixValue(input: {
  policy: QualityValuePolicyDraft;
  modelRevisionId: string;
  selectedQualityId: QualityId;
  configuration: ResolvedAffixConfiguration;
  functionScoreFactor: SourcedPricingValue<number>;
  performanceScoreFactor: SourcedPricingValue<number>;
  scoringPolicyVersion: string;
}): ModelAffixValueAssessment {
  return assessModelAffixValueInternal(input, input.performanceScoreFactor);
}

function assessModelAffixValueInternal(input: {
  policy: QualityValuePolicyDraft;
  modelRevisionId: string;
  selectedQualityId: QualityId;
  configuration: ResolvedAffixConfiguration;
  functionScoreFactor: SourcedPricingValue<number>;
  scoringPolicyVersion: string;
}, legacyPerformanceScoreFactor?: SourcedPricingValue<number>): ModelAffixValueAssessment {
  const trace: QualityScoreTraceEntry[] = [];
  const affixBreakdown = input.configuration.affixes.map((affix) => ({
    sourceAffixId: affix.id,
    valueScore: affix.valueScore,
    sourceRef: `affix:${affix.id}@${affix.version}`,
  }));
  let baseAffixScore = 0;
  for (const affix of input.configuration.affixes) {
    const before = baseAffixScore;
    baseAffixScore += affix.valueScore;
    trace.push({
      sequence: trace.length + 1,
      step: "affix",
      sourceRevision: input.policy.sourceRevision,
      source: { sheetId: "zrVOxd", cell: affix.id },
      subjectIds: [affix.id],
      before,
      operation: "add",
      operand: affix.valueScore,
      after: baseAffixScore,
    });
  }

  const selectedIds = new Set(input.configuration.affixes.map((affix) => affix.id));
  const combinationBreakdown = input.policy.combinationRules
    .filter((rule) => selectedIds.has(rule.leftAffixId) && selectedIds.has(rule.rightAffixId))
    .map((rule) => ({
      leftAffixId: rule.leftAffixId,
      rightAffixId: rule.rightAffixId,
      valueScore: rule.valueScore,
      sourceRef: `${rule.source.sheetId}!${rule.source.cell}`,
    }));
  let combinationScore = 0;
  for (const combination of combinationBreakdown) {
    const before = combinationScore;
    combinationScore += combination.valueScore;
    const rule = input.policy.combinationRules.find(
      (entry) => entry.leftAffixId === combination.leftAffixId && entry.rightAffixId === combination.rightAffixId,
    )!;
    trace.push({
      sequence: trace.length + 1,
      step: "combination",
      sourceRevision: input.policy.sourceRevision,
      source: rule.source,
      subjectIds: [combination.leftAffixId, combination.rightAffixId],
      before,
      operation: "add",
      operand: combination.valueScore,
      after: combinationScore,
    });
  }

  let finalValueScore = baseAffixScore + combinationScore;
  const beforeFunction = finalValueScore;
  finalValueScore *= input.functionScoreFactor.value;
  trace.push({
    sequence: trace.length + 1,
    step: "function_factor",
    sourceRevision: input.policy.sourceRevision,
    source: input.functionScoreFactor.source,
    subjectIds: [input.modelRevisionId],
    before: beforeFunction,
    operation: "multiply",
    operand: input.functionScoreFactor.value,
    after: finalValueScore,
  });

  let performanceScoreFactor: number | undefined;
  if (legacyPerformanceScoreFactor) {
    performanceScoreFactor = legacyPerformanceScoreFactor.value;
    const before = finalValueScore;
    finalValueScore *= performanceScoreFactor;
    trace.push({
      sequence: trace.length + 1,
      step: "performance_factor",
      sourceRevision: input.policy.sourceRevision,
      source: legacyPerformanceScoreFactor.source,
      subjectIds: [input.modelRevisionId],
      before,
      operation: "multiply",
      operand: performanceScoreFactor,
      after: finalValueScore,
    });
  }

  const selectedRange = input.policy.ranges.find((range) => range.qualityId === input.selectedQualityId);
  const inSelectedQualityRange = Boolean(selectedRange && inRange(finalValueScore, selectedRange));
  if (selectedRange) {
    trace.push({
      sequence: trace.length + 1,
      step: "quality_range",
      sourceRevision: input.policy.sourceRevision,
      source: selectedRange.source,
      subjectIds: [input.selectedQualityId],
      before: finalValueScore,
      operation: "validate",
      operand: selectedRange.maxScore,
      after: finalValueScore,
    });
  }
  const issues = structuredClone(input.policy.issues);
  if (!inSelectedQualityRange) {
    issues.push(issue({
      code: "QUALITY_SCORE_OUT_OF_RANGE",
      severity: "ERROR",
      gate: "PUBLISH",
      message: `最终评分 ${finalValueScore} 不在已选品质 ${input.selectedQualityId} 的区间内；系统不会自动改变品质。`,
      sourceRevision: input.policy.sourceRevision,
      sourceCell: selectedRange?.source,
      relatedObjectIds: [input.modelRevisionId, input.selectedQualityId],
    }));
  }
  const content = {
    modelRevisionId: input.modelRevisionId,
    selectedQualityId: input.selectedQualityId,
    baseAffixScore,
    combinationScore,
    functionScoreFactor: input.functionScoreFactor.value,
    ...(performanceScoreFactor === undefined ? {} : { performanceScoreFactor }),
    finalValueScore,
    affixBreakdown,
    combinationBreakdown,
    qualityRangePolicyVersion: input.policy.id,
    scoringPolicyVersion: input.scoringPolicyVersion,
    inSelectedQualityRange,
    formal: input.policy.formalStatus === "READY_TO_PUBLISH" && inSelectedQualityRange,
    issues,
    trace,
  };
  return { ...content, inputHash: deterministicHash(content) };
}
