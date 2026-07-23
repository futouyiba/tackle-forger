import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import {
  defaultAffinityAxisWeights,
  evaluateCanonicalAffinity,
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
import { parseDiscretePulls } from "@/lib/series-create-contract";
import { stableAuditActor } from "@/lib/api-command-boundaries";
import {
  ItemPartNotEnabledError,
  OPEN_003_FAIL_CLOSED_POLICY,
  isProductItemPartEnabled,
} from "@/lib/enabled-item-parts";

export const dynamic = "force-dynamic";

interface SeriesCreateRequest {
  idempotencyKey: string;
  seriesId: string;
  name: string;
  concept: string;
  collectionId?: string;
  itemPartId: string;
  methodId: string;
  typeId: string;
  functionId: string;
  qualityId: SeriesDefinition["qualityId"];
  /** 旧命令恢复专用；新创建禁止使用。 */
  performanceId?: string;
  functionIntensity: 1 | 2 | 3;
  planningMinKgf?: string;
  planningMaxKgf?: string;
  discretePulls?: string;
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
  if (
    body.performanceId !== undefined
    && typeof body.performanceId !== "string"
  ) {
    return NextResponse.json(
      { error: "字段 performanceId 必须是字符串。", field: "performanceId" },
      { status: 400 },
    );
  }
  const requiredStringFields = [
    "idempotencyKey", "seriesId", "name", "concept", "itemPartId", "methodId",
    "typeId", "functionId", "qualityId", "discretePulls",
  ] as const satisfies readonly (keyof SeriesCreateRequest)[];
  const optionalStringFields = [
    "collectionId", "planningMinKgf", "planningMaxKgf",
  ] as const satisfies readonly (keyof SeriesCreateRequest)[];
  const invalidField = requiredStringFields.find((field) => typeof body[field] !== "string")
    ?? optionalStringFields.find(
      (field) => body[field] !== undefined && typeof body[field] !== "string",
    );
  if (invalidField) {
    return NextResponse.json(
      { error: `字段 ${invalidField} 必须是字符串。`, field: invalidField },
      { status: 400 },
    );
  }

  const name = body.name.trim();
  const concept = body.concept.trim();
  const idempotencyKey = body.idempotencyKey.trim();
  if (!idempotencyKey) {
    return NextResponse.json({ error: "缺少创建命令幂等键。" }, { status: 422 });
  }
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
  if (![1, 2, 3].includes(body.functionIntensity)) {
    return NextResponse.json({ error: "功能专精强度必须为 1、2 或 3。" }, { status: 422 });
  }
  const parsedPulls = parseDiscretePulls(body.discretePulls ?? "");
  if (parsedPulls.invalidTokens.length || parsedPulls.duplicateValues.length) {
    return NextResponse.json({
      error: "目标拉力规格包含非法或重复项。",
      invalidTokens: parsedPulls.invalidTokens,
      duplicateValues: parsedPulls.duplicateValues,
    }, { status: 422 });
  }
  const pulls = parsedPulls.values;
  if (!pulls.length) {
    return NextResponse.json({ error: "请至少填写一个正数目标拉力规格；范围本身不能生成 SKU。" }, { status: 422 });
  }

  const current = await loadWorkspaceState();
  const state = current.state;
  if (!isProductItemPartEnabled(body.itemPartId)) {
    const error = new ItemPartNotEnabledError(body.itemPartId, "series");
    return NextResponse.json({
      error: error.message,
      code: error.code,
      itemPartId: error.itemPartId,
      action: "create_series",
      policyMode: OPEN_003_FAIL_CLOSED_POLICY.mode,
    }, { status: 422 });
  }

  const canonicalInput = {
    seriesId: body.seriesId,
    name,
    concept,
    collectionId: body.collectionId || null,
    itemPartId: body.itemPartId,
    methodId: body.methodId,
    typeId: body.typeId,
    functionId: body.functionId,
    qualityId: body.qualityId,
    functionIntensity: body.functionIntensity,
    planningMinKgf: minKgf ?? null,
    planningMaxKgf: maxKgf ?? null,
    pulls,
  };
  const inputHash = createHash("sha256")
    .update(JSON.stringify(canonicalInput))
    .digest("hex");
  const legacyInputHash = createHash("sha256").update(JSON.stringify({
    seriesId: body.seriesId,
    name,
    concept,
    collectionId: body.collectionId || null,
    itemPartId: body.itemPartId,
    methodId: body.methodId,
    typeId: body.typeId,
    functionId: body.functionId,
    qualityId: body.qualityId,
    performanceId: body.performanceId || null,
    functionIntensity: body.functionIntensity,
    planningMinKgf: minKgf ?? null,
    planningMaxKgf: maxKgf ?? null,
    pulls,
  })).digest("hex");
  const priorCommand = state.commandIdempotencyRecords.find((entry) => entry.key === idempotencyKey);
  if (priorCommand) {
    if (![inputHash, legacyInputHash].includes(priorCommand.inputHash)) {
      return NextResponse.json({ error: "同一幂等键不能用于不同的创建输入。" }, { status: 409 });
    }
    const priorSeries = state.seriesDefinitions.find((entry) => entry.id === priorCommand.resultRef);
    if (!priorSeries) {
      return NextResponse.json({ error: "幂等记录存在但原创建结果不可恢复。" }, { status: 409 });
    }
    return NextResponse.json({
      state,
      series: priorSeries,
      createdSkuIds: priorSeries.skuIds,
      revision: current.revision,
      idempotent: true,
      user,
    });
  }
  if (body.performanceId?.trim()) {
    return NextResponse.json({
      error: "Performance 已改为配置完成后的只读派生摘要，不能作为 Series 创建输入。",
      code: "PERFORMANCE_INPUT_NOT_ALLOWED",
      field: "performanceId",
    }, { status: 422 });
  }

  if (!body.seriesId || state.seriesDefinitions.some((entry) => entry.id === body.seriesId)) {
    return NextResponse.json({ error: "Series 稳定 ID 缺失或已存在，请重新发起。" }, { status: 409 });
  }
  if (!state.itemParts.some((entry) => entry.id === body.itemPartId)) {
    return NextResponse.json({ error: "所选部位不存在。" }, { status: 422 });
  }
  if (!state.methodProfiles.some((entry) => entry.id === body.methodId && entry.enabled)) {
    return NextResponse.json({ error: "所选钓法不存在或未启用。" }, { status: 422 });
  }
  if (!state.functionProfiles.some((entry) => entry.id === body.functionId && entry.enabled)) {
    return NextResponse.json({ error: "所选功能定位不存在或未启用。" }, { status: 422 });
  }
  const typeProfile = state.itemTypeProfiles.find((entry) => entry.id === body.typeId && entry.enabled);
  if (!typeProfile) {
    return NextResponse.json({ error: "所选类型不存在或未启用。" }, { status: 422 });
  }
  if (!typeProfile.methodIds.includes(body.methodId) || !typeProfile.itemPartIds.includes(body.itemPartId)) {
    return NextResponse.json({ error: "当前类型与所选部位或钓法不兼容。" }, { status: 422 });
  }
  if (!state.qualityProfiles.some((entry) => entry.id === body.qualityId)) {
    return NextResponse.json({ error: "所选品质不存在。" }, { status: 422 });
  }
  if (body.collectionId && !state.collections.some((entry) => entry.id === body.collectionId)) {
    return NextResponse.json({ error: "所选 Collection 不存在。" }, { status: 422 });
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
    coreAffixIds: [],
    secondaryAffixPoolIds: [],
    forbiddenAffixIds: [],
    ...(minKgf !== undefined && maxKgf !== undefined ? { planningPullRange: { minKgf, maxKgf } } : {}),
    targetPullSpecifications: [],
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
              affinity: evaluateCanonicalAffinity(
                {
                  methodId: body.methodId,
                  typeId: body.typeId,
                  targetPullKg: pull,
                  functionId: body.functionId,
                  functionIntensity: body.functionIntensity,
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
  next.commandIdempotencyRecords = [...next.commandIdempotencyRecords, {
    key: idempotencyKey,
    inputHash,
    resultRef: materialized.series.id,
  }];
  const committed = ensureWorkflowFields(next);

  const result = await saveWorkspaceState({
    state: committed,
    baseRevision: current.revision,
    author: stableAuditActor(user),
    message: `创建 Series ${materialized.series.name}（${materialized.createdSkuIds.length} 个 SKU 抽屉）`,
  });
  if (result.conflict) {
    const latest = await loadWorkspaceState();
    const recoveredCommand = latest.state.commandIdempotencyRecords.find(
      (entry) => entry.key === idempotencyKey,
    );
    const recoveredSeries = recoveredCommand?.inputHash === inputHash
      ? latest.state.seriesDefinitions.find((entry) => entry.id === recoveredCommand.resultRef)
      : undefined;
    if (recoveredSeries) {
      return NextResponse.json({
        state: latest.state,
        series: recoveredSeries,
        createdSkuIds: recoveredSeries.skuIds,
        revision: latest.revision,
        idempotent: true,
        user,
      });
    }
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
