import {
  canonicalizeAffixOperations,
  evaluateBidirectionalRatio,
} from "./reduction-stacking-policy";
import type {
  AffixQualityEvaluation,
  AffixRuntimeEvidence,
  AttributeContribution,
  CanonicalAttributeOperation,
  PassiveSkillPayload,
  QualityProfileId,
  ReductionStackingPolicyVersion,
  Technology,
  ValidationIssue,
  V3Affix,
} from "./types";

const QUALITY_LABELS: Record<QualityProfileId, {
  letter: "C" | "B" | "A" | "S";
  colorName: "绿" | "蓝" | "紫" | "橙";
}> = {
  quality_c_green: { letter: "C", colorName: "绿" },
  quality_b_blue: { letter: "B", colorName: "蓝" },
  quality_a_purple: { letter: "A", colorName: "紫" },
  quality_s_orange: { letter: "S", colorName: "橙" },
};

export interface ResolvedAffixConfiguration {
  affixes: V3Affix[];
  attributeAffixes: V3Affix[];
  passiveAffixes: V3Affix[];
  technologyAffixIds: string[];
  directAffixIds: string[];
  contributions: AttributeContribution[];
  canonicalOperations: CanonicalAttributeOperation[];
  validationIssues: ValidationIssue[];
  isolatedAffixRevisionIds: string[];
  passivePayloads: PassiveSkillPayload[];
  warnings: string[];
  blockingIssues: string[];
}

export function resolveAffixConfiguration(
  allAffixes: V3Affix[],
  allTechnologies: Technology[],
  directAffixIds: string[],
  technologyIds: string[],
): ResolvedAffixConfiguration {
  const affixById = new Map(allAffixes.map((affix) => [affix.id, affix]));
  const technologyById = new Map(
    allTechnologies.map((technology) => [technology.id, technology]),
  );
  const technologyAffixIds: string[] = [];
  const warnings: string[] = [];
  const blockingIssues: string[] = [];

  for (const technologyId of technologyIds) {
    const technology = technologyById.get(technologyId);
    if (!technology || !technology.enabled) {
      blockingIssues.push("Technology 不存在或已禁用：" + technologyId);
      continue;
    }
    for (const affixId of technology.affixIds) {
      if (!technologyAffixIds.includes(affixId)) technologyAffixIds.push(affixId);
    }
  }

  const uniqueDirect = Array.from(new Set(directAffixIds));
  const duplicateIds = uniqueDirect.filter((id) => technologyAffixIds.includes(id));
  if (duplicateIds.length) {
    warnings.push(
      "以下词条同时直接选择且来自 Technology，已去重：" +
        duplicateIds.join("、"),
    );
  }
  const resolvedIds = Array.from(
    new Set([...technologyAffixIds, ...uniqueDirect]),
  );
  const affixes = resolvedIds.flatMap((affixId): V3Affix[] => {
    const affix = affixById.get(affixId);
    if (!affix || !affix.enabled) {
      blockingIssues.push("Affix 不存在或已禁用：" + affixId);
      return [];
    }
    if (
      uniqueDirect.includes(affixId) &&
      affix.generationPolicy === "technology_only" &&
      !technologyAffixIds.includes(affixId)
    ) {
      blockingIssues.push("technology_only 词条不能直接选择：" + affix.name);
    }
    return [affix];
  });
  const attributeAffixes = affixes.filter(
    (affix) => affix.category === "attribute",
  );
  const passiveAffixes = affixes.filter((affix) => affix.category === "passive");

  const canonical = canonicalizeAffixOperations(attributeAffixes);
  const affixNameById = new Map(attributeAffixes.map((affix) => [affix.id, affix.name]));
  const contributions = canonical.operations.map((operation): AttributeContribution => ({
    id: operation.operationId,
    sourceId: operation.sourceAffixId,
    sourceName: affixNameById.get(operation.sourceAffixId) ?? operation.sourceAffixId,
    parameterKey: operation.parameterKey,
    operation: operation.operation,
    value: operation.magnitude ?? (
      typeof operation.value === "number" ? operation.value : 0
    ),
    sourceAffixRevision: operation.sourceAffixRevision,
    operationIndex: operation.operationIndex,
    operationId: operation.operationId,
    direction: operation.direction,
    magnitude: operation.magnitude,
    publishedMagnitudeRange: operation.publishedMagnitudeRange,
    rawLexical: operation.rawLexical,
    clampMin: operation.clampMin,
    clampMax: operation.clampMax,
    setValue: operation.value,
  }));
  blockingIssues.push(
    ...canonical.issues.map((entry) => `[${entry.code}] ${entry.message}`),
  );
  const passivePayloads = passiveAffixes.flatMap((affix) => {
    if (affix.passivePayload) return [structuredClone(affix.passivePayload)];
    blockingIssues.push("被动词条缺少结构化设计 Payload：" + affix.name);
    return [];
  });

  return {
    affixes,
    attributeAffixes,
    passiveAffixes,
    technologyAffixIds,
    directAffixIds: uniqueDirect,
    contributions,
    canonicalOperations: canonical.operations,
    validationIssues: canonical.issues,
    isolatedAffixRevisionIds: canonical.isolatedAffixRevisionIds,
    passivePayloads,
    warnings,
    blockingIssues,
  };
}

export function evaluateAffixQuality(
  configuration: ResolvedAffixConfiguration,
  selectedQualityId: QualityProfileId,
): AffixQualityEvaluation {
  const attributeAffixScore = configuration.attributeAffixes.reduce(
    (sum, affix) => sum + affix.valueScore,
    0,
  );
  const passiveAffixScore = configuration.passiveAffixes.reduce(
    (sum, affix) => sum + affix.valueScore,
    0,
  );
  const totalScore = attributeAffixScore + passiveAffixScore;
  const quality = QUALITY_LABELS[selectedQualityId];
  const blockingIssues = [...configuration.blockingIssues];
  if (totalScore < 0) {
    blockingIssues.push("词条总价值分低于 0，普通商品不得发布。");
  }
  return {
    totalScore,
    qualityId: selectedQualityId,
    letter: quality.letter,
    colorName: quality.colorName,
    attributeAffixScore,
    passiveAffixScore,
    technologyAffixIds: structuredClone(configuration.technologyAffixIds),
    directAffixIds: structuredClone(configuration.directAffixIds),
    warnings: structuredClone(configuration.warnings),
    blockingIssues,
  };
}

export interface AggregatedAffixPanel {
  values: Record<string, number | string>;
  contributions: AttributeContribution[];
  passivePayloads: PassiveSkillPayload[];
  quality: AffixQualityEvaluation;
  warnings: string[];
  blockingIssues: string[];
  validationIssues: ValidationIssue[];
  formalStatus: "FORMAL" | "NON_FORMAL";
  traceHash: string;
  runtimeEvidence: AffixRuntimeEvidence;
}

export function aggregateAffixPanel(
  baseValues: Record<string, number | string>,
  configuration: ResolvedAffixConfiguration,
  selectedQualityId: QualityProfileId,
  policy?: ReductionStackingPolicyVersion,
): AggregatedAffixPanel {
  const blockingIssues = [...configuration.blockingIssues];
  const runtime = evaluateBidirectionalRatio({
    baseValues,
    operations: configuration.canonicalOperations,
    policy,
  });
  blockingIssues.push(
    ...runtime.issues
      .filter((entry) => entry.severity === "BLOCKER" || entry.severity === "ERROR")
      .map((entry) => `[${entry.code}] ${entry.message}`),
  );

  const quality = evaluateAffixQuality({ ...configuration, blockingIssues }, selectedQualityId);
  return {
    values: runtime.values,
    contributions: structuredClone(configuration.contributions),
    passivePayloads: structuredClone(configuration.passivePayloads),
    quality,
    warnings: structuredClone(configuration.warnings),
    blockingIssues: structuredClone(quality.blockingIssues),
    validationIssues: [
      ...structuredClone(configuration.validationIssues),
      ...structuredClone(runtime.issues),
    ],
    formalStatus: runtime.formalStatus,
    traceHash: runtime.traceHash,
    runtimeEvidence: {
      reductionStackingPolicyVersion: policy?.version,
      values: structuredClone(runtime.values),
      trace: structuredClone(runtime.trace),
      issues: structuredClone(runtime.issues),
      formalStatus: runtime.formalStatus,
      traceHash: runtime.traceHash,
    },
  };
}

export function eligibleAffixesForNormalPool(affixes: V3Affix[]): V3Affix[] {
  return affixes.filter(
    (affix) =>
      affix.enabled &&
      affix.generationPolicy === "normal",
  );
}
