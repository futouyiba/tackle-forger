import type {
  AffinityScoreResult,
  DerivedProjection,
  HardCompatibilityResult,
  ParameterDefinition,
  ProjectionMatch,
  ProjectionMatchTraceItem,
  WeightTemplate,
} from "./types";
import { assertProductItemPartEnabled } from "./enabled-item-parts";

export interface ProjectionMatchCandidate {
  projection: DerivedProjection;
  weightTemplate: WeightTemplate;
  itemPartId: string;
  derivedPullKg: number;
  templatePriority?: number;
  compatibility: HardCompatibilityResult;
  affinity: AffinityScoreResult;
}

export interface ProjectionMatchQuery {
  itemPartId: string;
  targetPullKg: number;
  methodId: string;
  typeId: string;
  functionId: string;
  /** @deprecated 商品层字段，不参与结构标杆匹配。 */
  functionIntensity?: 1 | 2 | 3;
  /** @deprecated 商品层字段，不参与结构标杆匹配。 */
  performanceId?: string;
  /** @deprecated 商品层字段，不参与结构标杆匹配。 */
  qualityId?: string;
  pinnedProjectionId?: string;
  targetValues?: Record<string, number>;
}

const STRUCTURAL_PULL_PARAMETER_BY_PART: Record<string, string> = {
  "part:rod": "杆最大拉力kgf",
  rod: "杆最大拉力kgf",
  "part:reel": "轮最大拉力kgf",
  reel: "轮最大拉力kgf",
  "part:line": "线最大拉力kgf",
  line: "线最大拉力kgf",
};

export function structuralPullParameterKey(itemPartId: string): string | undefined {
  return STRUCTURAL_PULL_PARAMETER_BY_PART[itemPartId];
}

export function structuralPullFromValues(
  values: Record<string, number | string>,
  itemPartId: string,
): number | undefined {
  const key = structuralPullParameterKey(itemPartId);
  const value = key ? values[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function structuralPullFromProjection(
  projection: DerivedProjection,
  itemPartId: string,
): number | undefined {
  return projection.structuralValues
    ? structuralPullFromValues(projection.structuralValues, itemPartId)
    : undefined;
}

type RankedCandidate = ProjectionMatchCandidate & {
  pullDistance: number;
};

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function identityMatches(
  query: ProjectionMatchQuery,
  projection: DerivedProjection,
): boolean {
  return (
    projection.methodId === query.methodId &&
    projection.typeId === query.typeId &&
    projection.functionId === query.functionId &&
    query.itemPartId.length > 0
  );
}

export function projectionPullDistance(
  targetPullKg: number,
  derivedPullKg: number,
): number {
  if (
    !Number.isFinite(targetPullKg) ||
    !Number.isFinite(derivedPullKg) ||
    targetPullKg <= 0 ||
    derivedPullKg <= 0
  ) {
    throw new Error("目标拉力与结构派生拉力必须是大于 0 的有限数字。");
  }
  return Math.abs(Math.log(targetPullKg / derivedPullKg));
}

function compareRanked(left: RankedCandidate, right: RankedCandidate): number {
  return (
    left.pullDistance - right.pullDistance ||
    right.derivedPullKg - left.derivedPullKg ||
    (right.templatePriority ?? right.weightTemplate.templatePriority ?? 0) -
      (left.templatePriority ?? left.weightTemplate.templatePriority ?? 0) ||
    compareText(left.weightTemplate.id, right.weightTemplate.id) ||
    compareText(left.projection.id, right.projection.id)
  );
}

function buildTrace(
  query: ProjectionMatchQuery,
  ranked: RankedCandidate[],
  winner: RankedCandidate,
  pinned: boolean,
): ProjectionMatchTraceItem[] {
  const trace: ProjectionMatchTraceItem[] = [
    {
      stage: "identity",
      detail:
        "仅保留部位、钓法、类型与功能定位完全一致的结构标杆；强度、性能、品质、材料、词条、Affinity 与 Patch 不参与。",
    },
    {
      stage: "hard_compatibility",
      detail: "硬兼容失败的结构标杆已排除；Affinity 不参与结构标杆排序。",
    },
  ];
  if (pinned) {
    trace.push({
      stage: "pin",
      candidateId: winner.projection.id,
      detail: "用户固定到投影 " + winner.projection.id + "，未执行自动重选。",
    });
    return trace;
  }
  trace.push(
    {
      stage: "weight_distance",
      candidateId: winner.projection.id,
      detail:
        "拉力比例距离 abs(ln(" + query.targetPullKg + "/" +
        winner.derivedPullKg + ")) = " +
        winner.pullDistance + "。",
    },
    {
      stage: "derived_pull_tiebreak",
      candidateId: winner.projection.id,
      detail: "距离并列时优先 derivedPullKg 较高者：" + winner.derivedPullKg + "kgf。",
    },
    {
      stage: "template_priority",
      candidateId: winner.projection.id,
      detail: "再按版本化 templatePriority " + (winner.templatePriority ?? winner.weightTemplate.templatePriority ?? 0) + " 决胜。",
    },
    {
      stage: "stable_id",
      candidateId: winner.projection.id,
      detail: "全部指标并列时按稳定 projectionId 唯一决胜。",
    },
  );
  for (const candidate of ranked) {
    trace.push({
      stage: "weight_distance",
      candidateId: candidate.projection.id,
      detail:
        "候选 " + candidate.projection.id + "：距离 " +
        candidate.pullDistance + "，derivedPullKg " + candidate.derivedPullKg +
        "，templatePriority " + (candidate.templatePriority ?? candidate.weightTemplate.templatePriority ?? 0) + "。",
    });
  }
  return trace;
}

export function matchNearestProjection(
  query: ProjectionMatchQuery,
  candidates: ProjectionMatchCandidate[],
  parameters: ParameterDefinition[] = [],
): ProjectionMatch {
  assertProductItemPartEnabled(query.itemPartId, "projection_match");
  // 历史调用方仍传参数定义；结构匹配不得再用最终属性距离消费它。
  void parameters;
  if (!Number.isFinite(query.targetPullKg) || query.targetPullKg <= 0) {
    throw new Error("目标拉力必须是大于 0 的有限数字。");
  }
  const identityCandidates = candidates.filter((candidate) =>
    candidate.itemPartId === query.itemPartId && identityMatches(query, candidate.projection),
  );
  if (!identityCandidates.length) {
    throw new Error("没有身份维度严格匹配的派生投影。");
  }
  const compatible = identityCandidates.filter(
    (candidate) => candidate.compatibility.allowed,
  );
  if (!compatible.length) {
    const reasons = identityCandidates.flatMap((candidate) =>
      candidate.compatibility.failures.map((failure) => failure.message),
    );
    throw new Error(
      "所有身份匹配投影均被硬兼容规则阻止：" +
        Array.from(new Set(reasons)).join("；"),
    );
  }

  const ranked = compatible
    .map(
      (candidate): RankedCandidate => ({
        ...candidate,
        pullDistance: projectionPullDistance(
          query.targetPullKg,
          candidate.derivedPullKg,
        ),
      }),
    )
    .sort(compareRanked);

  const pinned = query.pinnedProjectionId
    ? ranked.find(
        (candidate) => candidate.projection.id === query.pinnedProjectionId,
      )
    : undefined;
  if (query.pinnedProjectionId && !pinned) {
    throw new Error(
      "固定投影不存在、结构身份不匹配或硬兼容失败：" + query.pinnedProjectionId,
    );
  }
  const winner = pinned ?? ranked[0];
  const alternatives = ranked
    .filter((candidate) => candidate.projection.id !== winner.projection.id)
    .map((candidate) => candidate.projection.id);
  const reasons = [
    pinned
      ? "用户已固定该模板；系统保留选择且不自动切换。"
      : "选择拉力比例距离最近的离散结构标杆，未使用范围包含或连续插值。",
    "拉力比例距离：" + winner.pullDistance,
    "命中结构拉力：" + winner.derivedPullKg + "kgf",
    "Affinity 与最终属性距离未参与选择。",
  ];

  return {
    targetPullKg: query.targetPullKg,
    matchedStructuralPullKg: winner.derivedPullKg,
    pullDistance: winner.pullDistance,
    itemPartId: winner.itemPartId,
    projectionId: winner.projection.id,
    weightTemplateId: winner.weightTemplate.id,
    ruleSetVersion: winner.projection.ruleSetVersion,
    affinityScore: winner.affinity.score,
    normalizedAttributeDistance: 0,
    reasons,
    alternatives,
    pinnedByUser: Boolean(pinned),
    trace: buildTrace(query, ranked, winner, Boolean(pinned)),
  };
}
