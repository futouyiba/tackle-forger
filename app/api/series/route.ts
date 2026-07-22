import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import {
  defaultAffinityAxisWeights,
  evaluateAffinity,
  evaluateStructuralHardCompatibility,
  structuralCompatibilityContext,
} from "@/lib/compatibility";
import {
  matchNearestProjection,
  structuralPullFromProjection,
  type ProjectionMatchCandidate,
} from "@/lib/projection-matcher";
import {
  createSeriesPullPlanningProposal,
  materializeConfirmedPullSpecifications,
} from "@/lib/series-pull-planning";
import { loadWorkspaceState, saveWorkspaceState } from "@/lib/storage";
import type { SeriesDefinition } from "@/lib/types";
import { ensureWorkflowFields } from "@/lib/workflow";

export const dynamic = "force-dynamic";

interface SeriesCreateRequest {
  seriesId: string;
  name: string;
  concept: string;
  collectionId?: string;
  itemPartId: string;
  methodId: string;
  typeId: string;
  functionId: string;
  qualityId: SeriesDefinition["qualityId"];
  performanceId?: string;
  functionIntensity: 1 | 2 | 3;
  planningMinKgf?: string;
  planningMaxKgf?: string;
  discretePulls?: string;
}

function parseDiscretePulls(value: string): number[] {
  return [
    ...new Set(
      value
        .split(/[,，;；\s]+/)
        .map((entry) => Number(entry.trim()))
        .filter((entry) => Number.isFinite(entry) && entry > 0),
    ),
  ].sort((left, right) => left - right);
}

/**
 * Series 创建的服务端领域命令（规范 §24.1 / §24.4 / §25.1）。
 * 写入由服务端重新鉴权（create_series → series.edit），并在服务端完成结构标杆匹配、
 * 拉力规划与 SKU 物化后按 revision 受保护地提交，避免客户端绕过 series.edit 直接写整包。
 */
export async function POST(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json(
      { error: "请使用公司飞书账号登录。", action: "feishu_login" },
      { status: 401 },
    );
  }
  const availability = user.actionAvailability.create_series;
  if (!availability?.enabled) {
    return NextResponse.json(
      {
        error: availability?.disabledReasonText ?? "当前账号没有创建 Series 的权限。",
        actionAvailability: availability,
      },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => null)) as SeriesCreateRequest | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "请求体无效。" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  const concept = (body.concept ?? "").trim();
  if (!name || !concept) {
    return NextResponse.json({ error: "请填写 Series 名称与概念说明。" }, { status: 422 });
  }
  if (!body.itemPartId || !body.methodId || !body.typeId || !body.functionId || !body.qualityId) {
    return NextResponse.json({ error: "请选择部位、钓法、类型、功能定位与品质。" }, { status: 422 });
  }
  const hasMin = (body.planningMinKgf ?? "").trim() !== "";
  const hasMax = (body.planningMaxKgf ?? "").trim() !== "";
  if (hasMin !== hasMax) {
    return NextResponse.json({ error: "规划拉力范围需同时填写最小与最大值。" }, { status: 422 });
  }
  const minKgf = hasMin ? Number(body.planningMinKgf) : undefined;
  const maxKgf = hasMax ? Number(body.planningMaxKgf) : undefined;
  if (
    hasMin &&
    (!Number.isFinite(minKgf) || !Number.isFinite(maxKgf) || minKgf! <= 0 || maxKgf! < minKgf!)
  ) {
    return NextResponse.json({ error: "规划拉力范围必须是有效的正数闭区间。" }, { status: 422 });
  }
  const pulls = parseDiscretePulls(body.discretePulls ?? "");
  if (!pulls.length) {
    return NextResponse.json({ error: "请至少填写一个正数目标拉力规格；范围本身不能生成 SKU。" }, { status: 422 });
  }

  const current = await loadWorkspaceState();
  const state = current.state;

  if (!body.seriesId || state.seriesDefinitions.some((entry) => entry.id === body.seriesId)) {
    return NextResponse.json({ error: "Series 稳定 ID 缺失或已存在，请重新发起。" }, { status: 409 });
  }
  const typeProfile = state.itemTypeProfiles.find((entry) => entry.id === body.typeId);
  if (!typeProfile?.methodIds.includes(body.methodId) || !typeProfile.itemPartIds.includes(body.itemPartId)) {
    return NextResponse.json({ error: "当前类型与所选部位或钓法不兼容。" }, { status: 422 });
  }
  const ruleSet = [...state.ruleSetVersions]
    .filter((entry) => entry.status === "published")
    .sort((left, right) => right.version - left.version || right.id.localeCompare(left.id))[0];
  if (!ruleSet) {
    return NextResponse.json({ error: "没有已发布 RuleSetVersion，不能生成结构标杆匹配。" }, { status: 422 });
  }

  const now = new Date().toISOString();
  const series: SeriesDefinition = {
    id: body.seriesId,
    ...(body.collectionId ? { collectionId: body.collectionId } : {}),
    revision: 1,
    name,
    concept,
    fishingMethodId: body.methodId,
    typeId: body.typeId,
    itemPartId: body.itemPartId,
    qualityId: body.qualityId,
    coreFunctionId: body.functionId,
    functionIntensityPolicy: { mode: "fixed", intensity: body.functionIntensity },
    ...(body.performanceId ? { performanceProfileId: body.performanceId } : {}),
    coreAffixIds: [],
    secondaryAffixPoolIds: [],
    forbiddenAffixIds: [],
    ...(minKgf !== undefined && maxKgf !== undefined ? { planningPullRange: { minKgf, maxKgf } } : {}),
    targetPullSpecifications: [],
    targetWeightsKg: [],
    signature: [],
    patchIds: [],
    skuIds: [],
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };

  let materialized: { series: SeriesDefinition; skus: typeof state.skuDrawers; createdSkuIds: string[] };
  try {
    const proposal = createSeriesPullPlanningProposal({
      series,
      planningPullRange: minKgf !== undefined && maxKgf !== undefined ? { minKgf, maxKgf } : undefined,
      candidatePullsKgf: pulls,
      source: "explicit_user_input",
      createdAt: now,
    });
    const skuIdByPull = Object.fromEntries(
      pulls.map((pull) => [String(pull), `sku:${randomUUID()}`]),
    );
    const candidatesFor = (pull: number): ProjectionMatchCandidate[] =>
      state.derivedProjections
        .filter((projection) => projection.ruleSetVersion === ruleSet.id)
        .flatMap((projection) => {
          const template = state.templates.find((entry) => entry.id === projection.weightTemplateId);
          const derivedPullKg = structuralPullFromProjection(projection, body.itemPartId);
          if (!template || derivedPullKg === undefined) return [];
          return [
            {
              projection,
              weightTemplate: template,
              itemPartId: body.itemPartId,
              derivedPullKg,
              templatePriority: template.templatePriority,
              compatibility: evaluateStructuralHardCompatibility(
                structuralCompatibilityContext({
                  methodId: body.methodId,
                  typeId: body.typeId,
                  functionId: body.functionId,
                  itemPartId: body.itemPartId,
                }),
                state.compatibilityRules,
              ),
              affinity: evaluateAffinity(
                {
                  methodId: body.methodId,
                  typeId: body.typeId,
                  targetWeightKg: pull,
                  functionId: body.functionId,
                  functionIntensity: body.functionIntensity,
                  performanceId: body.performanceId || undefined,
                  qualityId: body.qualityId,
                  itemPartId: body.itemPartId,
                  componentIds: [],
                  tags: [],
                },
                state.affinityRules,
                state.affinityAxisWeights ?? defaultAffinityAxisWeights,
              ),
            },
          ];
        });
    const projectionMatchByPull = Object.fromEntries(
      pulls.map((pull) => [
        String(pull),
        matchNearestProjection(
          {
            itemPartId: body.itemPartId,
            targetPullKg: pull,
            targetWeightKg: pull,
            methodId: body.methodId,
            typeId: body.typeId,
            functionId: body.functionId,
          },
          candidatesFor(pull),
        ),
      ]),
    );
    materialized = materializeConfirmedPullSpecifications({
      series,
      existingSkus: state.skuDrawers,
      proposal,
      confirmedPullsKgf: pulls,
      skuIdByPull,
      projectionMatchByPull,
      createdAt: now,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Series 创建失败。" },
      { status: 422 },
    );
  }

  const next = structuredClone(state);
  next.seriesDefinitions = [...next.seriesDefinitions, materialized.series];
  next.skuDrawers = materialized.skus;
  const committed = ensureWorkflowFields(next);

  const result = await saveWorkspaceState({
    state: committed,
    baseRevision: current.revision,
    author: user.name || user.email,
    message: `创建 Series ${materialized.series.name}（${materialized.createdSkuIds.length} 个 SKU 抽屉）`,
  });
  if (result.conflict) {
    return NextResponse.json(
      { error: "其他成员已保存新版本，请刷新后重试创建。", revision: result.revision },
      { status: 409 },
    );
  }
  return NextResponse.json({
    state: committed,
    series: materialized.series,
    createdSkuIds: materialized.createdSkuIds,
    revision: result.revision,
    user,
  });
}
