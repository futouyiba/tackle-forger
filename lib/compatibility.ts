import type {
  AffinityAxis,
  AffinityAxisContribution,
  AffinityAxisWeights,
  AffinityRule,
  AffinityScoreResult,
  CompatibilityContext,
  CompatibilityRequirement,
  CompatibilityRule,
  CompatibilitySelector,
  HardCompatibilityFailure,
  HardCompatibilityResult,
  MatchedCompatibilityRule,
} from "./types";

const AFFINITY_AXES: AffinityAxis[] = [
  "method_type",
  "type_weight",
  "type_function",
  "function_performance",
  "material_function",
  "quality_specialization",
  "model_component",
  "series_coherence",
];

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function scalarMatches(
  selectorValue: string | number | undefined,
  contextValue: string | number | undefined,
): boolean {
  return selectorValue === undefined || selectorValue === contextValue;
}

export function compatibilitySelectorMatches(
  selector: CompatibilitySelector,
  context: CompatibilityContext,
): boolean {
  if (!scalarMatches(selector.methodId, context.methodId)) return false;
  if (!scalarMatches(selector.typeId, context.typeId)) return false;
  if (!scalarMatches(selector.functionId, context.functionId)) return false;
  if (!scalarMatches(selector.functionIntensity, context.functionIntensity)) return false;
  if (!scalarMatches(selector.performanceId, context.performanceId)) return false;
  if (!scalarMatches(selector.qualityId, context.qualityId)) return false;
  if (!scalarMatches(selector.itemPartId, context.itemPartId)) return false;
  if (!scalarMatches(selector.lineMaterialId, context.lineMaterialId)) return false;
  if (
    selector.minPullKg !== undefined &&
    context.targetPullKg !== undefined &&
    context.targetPullKg < selector.minPullKg
  ) {
    return false;
  }
  if (
    selector.maxPullKg !== undefined &&
    context.targetPullKg !== undefined &&
    context.targetPullKg >= selector.maxPullKg
  ) {
    return false;
  }
  if (
    selector.componentIds?.some(
      (componentId) => !context.componentIds.includes(componentId),
    )
  ) {
    return false;
  }
  if (selector.tags?.some((tag) => !context.tags.includes(tag))) return false;
  return true;
}

/**
 * 结构标杆匹配专用的兼容上下文（规范 §5.1/§5.2/§18.1）。
 * 只保留结构维度（itemPart/method/type/function），刻意省略 performance、quality、
 * material、functionIntensity、重量范围、构件与标签——这些商品层与构件层维度不得
 * 参与结构标杆的最近匹配与排除。拉力范围通过省略 targetPullKg 令范围选择器不生效。
 */
export function structuralCompatibilityContext(input: {
  methodId: string;
  typeId: string;
  functionId?: string;
  itemPartId?: string;
}): CompatibilityContext {
  return {
    methodId: input.methodId,
    typeId: input.typeId,
    functionId: input.functionId,
    itemPartId: input.itemPartId,
    functionIntensity: undefined,
    performanceId: undefined,
    qualityId: undefined,
    lineMaterialId: undefined,
    targetPullKg: undefined,
    componentIds: [],
    tags: [],
  };
}

/**
 * 是否为纯结构维度的兼容选择器（仅 itemPart/method/type/function）。
 * 含 performance、quality、material、functionIntensity、重量范围、构件或标签的选择器，
 * 都不属于结构标杆匹配阶段，必须在最近匹配时整体忽略（规范 §5.1/§5.2/§18.1）。
 */
export function isStructuralCompatibilitySelector(selector: CompatibilitySelector): boolean {
  return (
    selector.functionIntensity === undefined &&
    selector.performanceId === undefined &&
    selector.qualityId === undefined &&
    selector.lineMaterialId === undefined &&
    selector.minPullKg === undefined &&
    selector.maxPullKg === undefined &&
    !(selector.componentIds && selector.componentIds.length > 0) &&
    !(selector.tags && selector.tags.length > 0)
  );
}

/**
 * 结构标杆匹配阶段的硬兼容评估：只保留纯结构维度的规则。
 * 非结构维度的 deny/require（例如“0.5kg 以下不支持”这类重量范围规则、performance/quality
 * 规则）不会在最近匹配时排除结构标杆。
 */
export function evaluateStructuralHardCompatibility(
  context: CompatibilityContext,
  rules: CompatibilityRule[],
): HardCompatibilityResult {
  return evaluateHardCompatibility(
    context,
    rules.filter((rule) => isStructuralCompatibilitySelector(rule.selector)),
  );
}

function withoutLegacyPerformanceRequirements(rule: CompatibilityRule): CompatibilityRule | undefined {
  if (rule.selector.performanceId !== undefined) return undefined;
  const canonical = {
    ...rule,
    requirements: rule.requirements.filter(
      (requirement) => !(requirement.kind === "field" && requirement.key === "performanceId"),
    ),
  };
  if (rule.effect === "require" && rule.requirements.length > 0 && canonical.requirements.length === 0) {
    return undefined;
  }
  return canonical;
}

/**
 * 新运行时的硬兼容入口。旧 Performance selector 与 field requirement 都是历史证据，
 * 不得因为 canonical context 不再携带 performanceId 而排除候选。
 */
export function evaluateCanonicalHardCompatibility(
  context: CompatibilityContext,
  rules: CompatibilityRule[],
): HardCompatibilityResult {
  return evaluateHardCompatibility(
    context,
    rules.flatMap((rule) => {
      const canonical = withoutLegacyPerformanceRequirements(rule);
      return canonical ? [canonical] : [];
    }),
  );
}

export function compatibilitySpecificity(
  selector: CompatibilitySelector,
): number {
  const scalarKeys: Array<keyof CompatibilitySelector> = [
    "methodId",
    "typeId",
    "functionId",
    "functionIntensity",
    "performanceId",
    "qualityId",
    "itemPartId",
    "lineMaterialId",
    "minPullKg",
    "maxPullKg",
  ];
  const scalarCount = scalarKeys.filter(
    (key) => selector[key] !== undefined,
  ).length;
  return (
    scalarCount +
    (selector.componentIds?.length ?? 0) +
    (selector.tags?.length ?? 0)
  );
}

function requirementSatisfied(
  requirement: CompatibilityRequirement,
  context: CompatibilityContext,
): boolean {
  if (requirement.kind === "tag") return context.tags.includes(requirement.key);
  if (requirement.kind === "component") {
    return context.componentIds.includes(requirement.key);
  }
  const value = (context as unknown as Record<string, unknown>)[requirement.key];
  return requirement.value === undefined
    ? value !== undefined && value !== ""
    : value === requirement.value;
}

function effectRank(effect: CompatibilityRule["effect"]): number {
  if (effect === "deny") return 0;
  if (effect === "require") return 1;
  return 2;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function evaluateHardCompatibility(
  context: CompatibilityContext,
  rules: CompatibilityRule[],
): HardCompatibilityResult {
  const matched = rules
    .filter(
      (rule) =>
        rule.enabled && compatibilitySelectorMatches(rule.selector, context),
    )
    .map((rule) => ({
      rule,
      specificity: compatibilitySpecificity(rule.selector),
    }));

  const matchedRules: MatchedCompatibilityRule[] = matched
    .map(({ rule, specificity }) => ({
      ruleId: rule.id,
      axis: rule.axis,
      effect: rule.effect,
      specificity,
      priority: rule.priority,
      reason: rule.reason,
    }))
    .sort(
      (left, right) =>
        compareText(left.axis, right.axis) ||
        right.specificity - left.specificity ||
        right.priority - left.priority ||
        effectRank(left.effect) - effectRank(right.effect) ||
        compareText(left.ruleId, right.ruleId),
    );

  const decisiveRules: CompatibilityRule[] = [];
  for (const axis of Array.from(new Set(matched.map(({ rule }) => rule.axis))).sort(
    compareText,
  )) {
    const axisMatches = matched
      .filter(({ rule }) => rule.axis === axis)
      .sort(
        (left, right) =>
          right.specificity - left.specificity ||
          right.rule.priority - left.rule.priority ||
          effectRank(left.rule.effect) - effectRank(right.rule.effect) ||
          compareText(left.rule.id, right.rule.id),
      );
    const first = axisMatches[0];
    if (!first) continue;
    decisiveRules.push(
      ...axisMatches
        .filter(
          (entry) =>
            entry.specificity === first.specificity &&
            entry.rule.priority === first.rule.priority,
        )
        .map(({ rule }) => rule),
    );
  }

  const failures: HardCompatibilityFailure[] = [];
  for (const rule of decisiveRules) {
    if (rule.effect === "deny") {
      failures.push({
        ruleId: rule.id,
        code: "DENIED",
        message: rule.reason,
        suggestion: rule.suggestion,
      });
      continue;
    }
    if (rule.effect !== "require") continue;
    const missing = rule.requirements.filter(
      (requirement) => !requirementSatisfied(requirement, context),
    );
    if (!rule.requirements.length) {
      failures.push({
        ruleId: rule.id,
        code: "REQUIREMENT_MISSING",
        message: rule.reason + "（规则未配置具体要求）",
        suggestion: rule.suggestion,
      });
    }
    for (const requirement of missing) {
      failures.push({
        ruleId: rule.id,
        code: "REQUIREMENT_MISSING",
        message: requirement.message,
        suggestion: rule.suggestion,
      });
    }
  }

  return {
    allowed: failures.length === 0,
    matchedRules,
    decisiveRuleIds: decisiveRules.map((rule) => rule.id),
    failures,
    suggestions: unique(
      failures.map((failure) => failure.suggestion).filter(Boolean),
    ),
  };
}

export function evaluateAffinity(
  context: CompatibilityContext,
  rules: AffinityRule[],
  axisWeights: AffinityAxisWeights,
): AffinityScoreResult {
  const contributions: AffinityAxisContribution[] = [];
  const warnings: string[] = [];

  for (const axis of AFFINITY_AXES) {
    const weight = axisWeights[axis];
    const safeWeight = Number.isFinite(weight) && weight >= 0 ? weight : 0;
    if (safeWeight !== weight) {
      warnings.push("Affinity 轴 " + axis + " 的权重无效，已按 0 处理。");
    }
    const candidates = rules
      .filter(
        (rule) =>
          rule.enabled &&
          rule.axis === axis &&
          compatibilitySelectorMatches(rule.selector, context),
      )
      .map((rule) => ({
        rule,
        specificity: compatibilitySpecificity(rule.selector),
      }))
      .filter(({ rule }) => {
        if (rule.score >= -3 && rule.score <= 3 && Number.isFinite(rule.score)) {
          return true;
        }
        warnings.push(
          "Affinity 规则 " + rule.id + " 的分值不在 -3..3，已忽略。",
        );
        return false;
      })
      .sort(
        (left, right) =>
          right.specificity - left.specificity ||
          right.rule.priority - left.rule.priority ||
          compareText(left.rule.id, right.rule.id),
      );
    const selected = candidates[0];
    const score = selected?.rule.score ?? 0;
    contributions.push({
      axis,
      score,
      weight: safeWeight,
      weightedScore: score * safeWeight,
      ruleId: selected?.rule.id,
      specificity: selected?.specificity ?? 0,
      reason: selected?.rule.reason ?? "该轴没有命中规则，按中性 0 分。",
    });
  }

  const totalWeight = contributions.reduce(
    (sum, contribution) => sum + contribution.weight,
    0,
  );
  const weightedScore = contributions.reduce(
    (sum, contribution) => sum + contribution.weightedScore,
    0,
  );
  const score =
    totalWeight > 0
      ? Math.round((weightedScore / totalWeight + Number.EPSILON) * 10000) /
        10000
      : 0;
  if (totalWeight === 0) warnings.push("Affinity 所有轴权重均为 0，总分按 0 处理。");

  return {
    score,
    contributions,
    matchedRuleIds: contributions
      .map((contribution) => contribution.ruleId)
      .filter((ruleId): ruleId is string => Boolean(ruleId)),
    warnings,
  };
}

/**
 * 新规范化运行时的 Affinity。旧 function_performance 轴与 performanceId 选择器
 * 只供历史结果重放，不进入新候选、Series 或 Model 的兼容评分。
 */
export function evaluateCanonicalAffinity(
  context: CompatibilityContext,
  rules: AffinityRule[],
  axisWeights: AffinityAxisWeights,
): AffinityScoreResult {
  const canonicalContext = { ...context, performanceId: undefined };
  const result = evaluateAffinity(
    canonicalContext,
    rules.filter(
      (rule) =>
        rule.axis !== "function_performance"
        && rule.selector.performanceId === undefined,
    ),
    { ...axisWeights, function_performance: 0 },
  );
  return {
    ...result,
    warnings: result.warnings.filter(
      (warning) => !warning.includes("function_performance"),
    ),
  };
}

export const defaultAffinityAxisWeights: AffinityAxisWeights = {
  method_type: 1,
  type_weight: 1,
  type_function: 1,
  function_performance: 1,
  material_function: 1,
  quality_specialization: 1,
  model_component: 1,
  series_coherence: 1,
};
