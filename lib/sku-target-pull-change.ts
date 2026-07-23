import { createHash } from "node:crypto";
import {
  defaultAffinityAxisWeights,
  evaluateAffinity,
  evaluateStructuralHardCompatibility,
  structuralCompatibilityContext,
} from "./compatibility";
import {
  matchNearestProjection,
  structuralPullFromProjection,
  type ProjectionMatchCandidate,
} from "./projection-matcher";
import { deterministicHash, stableStringify } from "./rule-kernel";
import type {
  ProjectionMatch,
  SeriesDefinition,
  SkuDrawer,
  WorkspaceState,
} from "./types";

export type SkuTargetPullChangeMode =
  | "SAME_SKU_NEW_REVISION"
  | "REPLACEMENT_SKU";

export type SkuTargetPullChangeErrorCode =
  | "SKU_NOT_FOUND"
  | "SERIES_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_RESULT_MISSING"
  | "TARGET_PULL_INVALID"
  | "TARGET_PULL_UNCHANGED"
  | "TARGET_PULL_DUPLICATE"
  | "SERIES_SPECIFICATION_MISSING"
  | "PROJECTION_MATCH_REQUIRED"
  | "PROJECTION_MATCH_STALE"
  | "PREVIEW_STALE"
  | "REPLACEMENT_SKU_ID_REQUIRED"
  | "REPLACEMENT_SKU_ID_CONFLICT";

export class SkuTargetPullChangeError extends Error {
  constructor(
    readonly code: SkuTargetPullChangeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkuTargetPullChangeError";
  }
}

export interface ChangeSkuTargetPullCommand {
  skuId: string;
  expectedRevision: number;
  targetPullKg: number;
  projectionMatch: ProjectionMatch;
  expectedMode: SkuTargetPullChangeMode;
  publishedDescendantFingerprint: string;
  replacementSkuId?: string;
  deprecateOriginal?: boolean;
  idempotencyKey: string;
  actor: string;
  occurredAt: string;
}

export interface ChangeSkuTargetPullResult {
  state: WorkspaceState;
  sku: SkuDrawer;
  originalSku: SkuDrawer;
  series: SeriesDefinition;
  mode: SkuTargetPullChangeMode;
  publishedSnapshotIds: string[];
  idempotent: boolean;
}

export interface SkuTargetPullChangePreview {
  projectionMatch: ProjectionMatch;
  mode: SkuTargetPullChangeMode;
  publishedSnapshotIds: string[];
  publishedDescendantFingerprint: string;
}

interface PublishedDescendantEvidence {
  snapshotIds: string[];
  fingerprint: string;
}

function sha256Stable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function publishedDescendantEvidence(
  state: WorkspaceState,
  sku: SkuDrawer,
): PublishedDescendantEvidence {
  const modelIds = new Set([
    ...sku.modelIds,
    ...state.purchasableModels
      .filter((model) => model.skuId === sku.id)
      .map((model) => model.id),
  ]);
  const snapshots = state.configurationSnapshots
    .filter((snapshot) => modelIds.has(snapshot.modelId))
    .map((snapshot) => ({
      id: snapshot.id,
      modelId: snapshot.modelId,
      modelRevision: snapshot.modelRevision,
      skuRevision: snapshot.skuRevision,
      contentHash: snapshot.contentHash,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    snapshotIds: snapshots.map((snapshot) => snapshot.id),
    fingerprint: sha256Stable(snapshots),
  };
}

function intensityFor(
  series: SeriesDefinition,
  targetPullKg: number,
): 1 | 2 | 3 {
  return series.functionIntensityPolicy.mode === "fixed"
    ? series.functionIntensityPolicy.intensity
    : series.functionIntensityPolicy.values[String(targetPullKg)] ?? 2;
}

/**
 * 为一次 SKU 拉力变更生成可供用户预览和确认的显式 ProjectionMatch。
 * 只消费当前最新已发布规则版本；不修改工作区，也不复用旧 SKU 的匹配结果。
 */
export function previewSkuTargetPullProjectionMatch(input: {
  state: WorkspaceState;
  skuId: string;
  expectedRevision: number;
  targetPullKg: number;
}): ProjectionMatch {
  const sku = input.state.skuDrawers.find((entry) => entry.id === input.skuId);
  if (!sku) {
    throw new SkuTargetPullChangeError("SKU_NOT_FOUND", "指定 SKU 不存在。");
  }
  if (sku.revision !== input.expectedRevision) {
    throw new SkuTargetPullChangeError(
      "REVISION_CONFLICT",
      `SKU revision 已变化：期望 ${input.expectedRevision}，当前 ${sku.revision}。`,
    );
  }
  if (!Number.isFinite(input.targetPullKg) || input.targetPullKg <= 0) {
    throw new SkuTargetPullChangeError(
      "TARGET_PULL_INVALID",
      "目标拉力必须是大于 0 的有限 kgf 数值。",
    );
  }
  const series = input.state.seriesDefinitions.find(
    (entry) => entry.id === sku.seriesId,
  );
  if (!series) {
    throw new SkuTargetPullChangeError(
      "SERIES_NOT_FOUND",
      "SKU 所属 Series 不存在。",
    );
  }
  const itemPartId = series.itemPartId || sku.projectionMatch.itemPartId;
  const ruleSet = [...input.state.ruleSetVersions]
    .filter((entry) => entry.status === "published")
    .sort(
      (left, right) =>
        right.version - left.version || right.id.localeCompare(left.id),
    )[0];
  if (!ruleSet) {
    throw new SkuTargetPullChangeError(
      "PROJECTION_MATCH_STALE",
      "没有已发布 RuleSetVersion，无法生成新的结构标杆匹配。",
    );
  }
  const context = structuralCompatibilityContext({
    methodId: series.fishingMethodId,
    typeId: series.typeId,
    functionId: series.coreFunctionId,
    itemPartId,
  });
  const candidates: ProjectionMatchCandidate[] = input.state.derivedProjections
    .filter((projection) => projection.ruleSetVersion === ruleSet.id)
    .flatMap((projection) => {
      const weightTemplate = input.state.templates.find(
        (entry) => entry.id === projection.weightTemplateId,
      );
      const derivedPullKg = structuralPullFromProjection(projection, itemPartId);
      if (!weightTemplate || derivedPullKg === undefined) return [];
      return [{
        projection,
        weightTemplate,
        itemPartId,
        derivedPullKg,
        templatePriority: weightTemplate.templatePriority,
        compatibility: evaluateStructuralHardCompatibility(
          context,
          input.state.compatibilityRules,
        ),
        affinity: evaluateAffinity(
          {
            methodId: series.fishingMethodId,
            typeId: series.typeId,
            targetPullKg: input.targetPullKg,
            functionId: series.coreFunctionId,
            functionIntensity: intensityFor(series, input.targetPullKg),
            performanceId: series.performanceProfileId,
            qualityId: series.qualityId,
            itemPartId,
            componentIds: [],
            tags: [],
          },
          input.state.affinityRules,
          input.state.affinityAxisWeights ?? defaultAffinityAxisWeights,
        ),
      }];
    });
  try {
    return matchNearestProjection(
      {
        itemPartId,
        targetPullKg: input.targetPullKg,
        methodId: series.fishingMethodId,
        typeId: series.typeId,
        functionId: series.coreFunctionId,
      },
      candidates,
    );
  } catch (error) {
    throw new SkuTargetPullChangeError(
      "PROJECTION_MATCH_STALE",
      error instanceof Error ? error.message : "无法生成新的结构标杆匹配。",
    );
  }
}

/**
 * 返回需要被用户确认的完整冻结分支证据。写命令必须原样带回 mode 与
 * publishedDescendantFingerprint；期间后代集合变化时 fail closed。
 */
export function previewSkuTargetPullChange(input: {
  state: WorkspaceState;
  skuId: string;
  expectedRevision: number;
  targetPullKg: number;
}): SkuTargetPullChangePreview {
  const sku = input.state.skuDrawers.find((entry) => entry.id === input.skuId);
  if (!sku) {
    throw new SkuTargetPullChangeError("SKU_NOT_FOUND", "指定 SKU 不存在。");
  }
  const evidence = publishedDescendantEvidence(input.state, sku);
  return {
    projectionMatch: previewSkuTargetPullProjectionMatch(input),
    mode: evidence.snapshotIds.length
      ? "REPLACEMENT_SKU"
      : "SAME_SKU_NEW_REVISION",
    publishedSnapshotIds: evidence.snapshotIds,
    publishedDescendantFingerprint: evidence.fingerprint,
  };
}

function commandInputHash(command: ChangeSkuTargetPullCommand): string {
  return sha256Stable({
    skuId: command.skuId,
    expectedRevision: command.expectedRevision,
    targetPullKg: command.targetPullKg,
    projectionMatch: command.projectionMatch,
    expectedMode: command.expectedMode,
    publishedDescendantFingerprint:
      command.publishedDescendantFingerprint,
    replacementSkuId: command.replacementSkuId?.trim() || null,
    deprecateOriginal: Boolean(command.deprecateOriginal),
  });
}

interface FrozenSkuTargetPullChangeResult {
  kind: "sku-target-pull-change-result/v1";
  sku: SkuDrawer;
  originalSku: SkuDrawer;
  series: SeriesDefinition;
  mode: SkuTargetPullChangeMode;
  publishedSnapshotIds: string[];
}

function frozenResultFrom(
  record: WorkspaceState["commandIdempotencyRecords"][number],
): FrozenSkuTargetPullChangeResult | undefined {
  const payload = record.resultPayload;
  if (
    !payload ||
    payload.kind !== "sku-target-pull-change-result/v1" ||
    !record.resultPayloadHash ||
    sha256Stable(payload) !== record.resultPayloadHash ||
    !payload.sku ||
    typeof payload.sku !== "object" ||
    !payload.originalSku ||
    typeof payload.originalSku !== "object" ||
    !payload.series ||
    typeof payload.series !== "object" ||
    (payload.mode !== "SAME_SKU_NEW_REVISION" &&
      payload.mode !== "REPLACEMENT_SKU") ||
    !Array.isArray(payload.publishedSnapshotIds)
  ) {
    return undefined;
  }
  const frozen = payload as unknown as FrozenSkuTargetPullChangeResult;
  if (
    frozen.sku.id !== record.resultRef ||
    frozen.publishedSnapshotIds.some((entry) => typeof entry !== "string")
  ) {
    return undefined;
  }
  return structuredClone(frozen);
}

function recoverIdempotentResult(
  state: WorkspaceState,
  record: WorkspaceState["commandIdempotencyRecords"][number],
): ChangeSkuTargetPullResult {
  const frozen = frozenResultFrom(record);
  if (!frozen) {
    throw new SkuTargetPullChangeError(
      "IDEMPOTENCY_RESULT_MISSING",
      "幂等记录存在，但首次成功响应缺失或已损坏，不能读取当前 revision 代替。",
    );
  }
  return {
    state,
    sku: frozen.sku,
    originalSku: frozen.originalSku,
    series: frozen.series,
    mode: frozen.mode,
    publishedSnapshotIds: frozen.publishedSnapshotIds,
    idempotent: true,
  };
}

function orderSpecifications(
  specifications: SeriesDefinition["targetPullSpecifications"],
) {
  return [...specifications].sort(
    (left, right) =>
      left.targetPullKgf - right.targetPullKgf ||
      left.skuId.localeCompare(right.skuId),
  );
}

/**
 * SKU targetPullKg 的唯一写命令（规范 §24.1）。
 * - 无已发布后代：同 skuId 新 revision。
 * - 有已发布后代：旧 SKU/快照保留，创建调用方提供稳定 ID 的新 SKU。
 * ProjectionMatch 必须先由 preview 显式生成并随命令提交，命令不会静默重绑。
 */
export function changeSkuTargetPull(
  state: WorkspaceState,
  command: ChangeSkuTargetPullCommand,
): ChangeSkuTargetPullResult {
  const idempotencyKey = command.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw new SkuTargetPullChangeError(
      "IDEMPOTENCY_CONFLICT",
      "缺少 SKU 拉力变更命令的幂等键。",
    );
  }
  const inputHash = commandInputHash(command);
  const prior = state.commandIdempotencyRecords.find(
    (entry) => entry.key === idempotencyKey,
  );
  if (prior) {
    if (prior.inputHash !== inputHash) {
      throw new SkuTargetPullChangeError(
        "IDEMPOTENCY_CONFLICT",
        "同一幂等键不能用于不同的 SKU 拉力变更输入。",
      );
    }
    return recoverIdempotentResult(state, prior);
  }

  const original = state.skuDrawers.find(
    (entry) => entry.id === command.skuId,
  );
  if (!original) {
    throw new SkuTargetPullChangeError("SKU_NOT_FOUND", "指定 SKU 不存在。");
  }
  if (original.revision !== command.expectedRevision) {
    throw new SkuTargetPullChangeError(
      "REVISION_CONFLICT",
      `SKU revision 已变化：期望 ${command.expectedRevision}，当前 ${original.revision}。`,
    );
  }
  if (!Number.isFinite(command.targetPullKg) || command.targetPullKg <= 0) {
    throw new SkuTargetPullChangeError(
      "TARGET_PULL_INVALID",
      "目标拉力必须是大于 0 的有限 kgf 数值。",
    );
  }
  if (command.targetPullKg === original.targetPullKg) {
    throw new SkuTargetPullChangeError(
      "TARGET_PULL_UNCHANGED",
      "新目标拉力与当前值相同。",
    );
  }
  const series = state.seriesDefinitions.find(
    (entry) => entry.id === original.seriesId,
  );
  if (!series) {
    throw new SkuTargetPullChangeError(
      "SERIES_NOT_FOUND",
      "SKU 所属 Series 不存在。",
    );
  }
  const currentSpecification = series.targetPullSpecifications.find(
    (entry) => entry.skuId === original.id,
  );
  if (!currentSpecification) {
    throw new SkuTargetPullChangeError(
      "SERIES_SPECIFICATION_MISSING",
      "SKU 未在所属 Series 的当前离散拉力规格中声明。",
    );
  }
  if (
    series.targetPullSpecifications.some(
      (entry) =>
        entry.skuId !== original.id &&
        entry.targetPullKgf === command.targetPullKg,
    )
  ) {
    throw new SkuTargetPullChangeError(
      "TARGET_PULL_DUPLICATE",
      `Series 已存在 ${command.targetPullKg}kgf 的活动 SKU 规格。`,
    );
  }
  if (!command.projectionMatch) {
    throw new SkuTargetPullChangeError(
      "PROJECTION_MATCH_REQUIRED",
      "必须先预览并显式确认新的 ProjectionMatch。",
    );
  }
  const expectedMatch = previewSkuTargetPullProjectionMatch({
    state,
    skuId: original.id,
    expectedRevision: original.revision,
    targetPullKg: command.targetPullKg,
  });
  if (
    command.projectionMatch.targetPullKg !== command.targetPullKg ||
    deterministicHash(command.projectionMatch) !==
      deterministicHash(expectedMatch)
  ) {
    throw new SkuTargetPullChangeError(
      "PROJECTION_MATCH_STALE",
      "提交的 ProjectionMatch 与当前规则下的显式预览不一致，请重新预览。",
    );
  }

  const snapshotsBefore = deterministicHash(state.configurationSnapshots);
  const descendantEvidence = publishedDescendantEvidence(state, original);
  const publishedSnapshotIds = descendantEvidence.snapshotIds;
  const mode: SkuTargetPullChangeMode = publishedSnapshotIds.length
    ? "REPLACEMENT_SKU"
    : "SAME_SKU_NEW_REVISION";
  if (
    command.expectedMode !== mode ||
    command.publishedDescendantFingerprint !==
      descendantEvidence.fingerprint
  ) {
    throw new SkuTargetPullChangeError(
      "PREVIEW_STALE",
      "已发布后代集合在预览后发生变化，不能静默切换冻结分支；请重新预览并确认。",
    );
  }
  const next = structuredClone(state);
  const specifications = orderSpecifications(
    series.targetPullSpecifications.map((entry) =>
      entry.skuId === original.id
        ? {
          targetPullKgf: command.targetPullKg,
          skuId: mode === "REPLACEMENT_SKU"
            ? command.replacementSkuId?.trim() || ""
            : original.id,
        }
        : entry),
  );

  let resultSku: SkuDrawer;
  let resultingOriginal: SkuDrawer;
  if (mode === "SAME_SKU_NEW_REVISION") {
    resultSku = {
      ...structuredClone(original),
      revision: original.revision + 1,
      targetPullKg: command.targetPullKg,
      projectionMatch: structuredClone(command.projectionMatch),
      validationSummary: [
        ...original.validationSummary.filter(
          (issue) => issue.code !== "SKU_TARGET_PULL_CHANGED_REVIEW_REQUIRED",
        ),
        {
          level: "warning",
          code: "SKU_TARGET_PULL_CHANGED_REVIEW_REQUIRED",
          message:
            "目标拉力与结构标杆已显式变更；下游未发布 Model 草稿需要复核。",
        },
      ],
      status: "draft",
      updatedAt: command.occurredAt,
    };
    resultingOriginal = resultSku;
    next.skuDrawers = next.skuDrawers.map((entry) =>
      entry.id === original.id ? resultSku : entry);
  } else {
    const replacementSkuId = command.replacementSkuId?.trim();
    if (!replacementSkuId) {
      throw new SkuTargetPullChangeError(
        "REPLACEMENT_SKU_ID_REQUIRED",
        "存在已发布后代时必须提供新的稳定 replacementSkuId。",
      );
    }
    if (state.skuDrawers.some((entry) => entry.id === replacementSkuId)) {
      throw new SkuTargetPullChangeError(
        "REPLACEMENT_SKU_ID_CONFLICT",
        "replacementSkuId 已存在，不能覆盖历史 SKU。",
      );
    }
    resultSku = {
      id: replacementSkuId,
      revision: 1,
      seriesId: original.seriesId,
      targetPullKg: command.targetPullKg,
      projectionMatch: structuredClone(command.projectionMatch),
      patchIds: [],
      modelIds: [],
      displayOrder: original.displayOrder,
      validationSummary: [],
      status: "draft",
      createdAt: command.occurredAt,
      updatedAt: command.occurredAt,
    };
    resultingOriginal = command.deprecateOriginal
      ? {
        ...structuredClone(original),
        revision: original.revision + 1,
        status: "superseded",
        updatedAt: command.occurredAt,
      }
      : structuredClone(original);
    next.skuDrawers = next.skuDrawers.map((entry) =>
      entry.id === original.id ? resultingOriginal : entry);
    next.skuDrawers.push(resultSku);
  }

  const displayOrderBySku = new Map(
    specifications.map((entry, index) => [entry.skuId, index + 1]),
  );
  next.skuDrawers = next.skuDrawers.map((entry) =>
    displayOrderBySku.has(entry.id)
      ? { ...entry, displayOrder: displayOrderBySku.get(entry.id)! }
      : entry);
  const nextSeries: SeriesDefinition = {
    ...structuredClone(series),
    revision: series.revision + 1,
    targetPullSpecifications: specifications,
    skuIds: specifications.map((entry) => entry.skuId),
    status: "draft",
    updatedAt: command.occurredAt,
  };
  next.seriesDefinitions = next.seriesDefinitions.map((entry) =>
    entry.id === series.id ? nextSeries : entry);

  const matchHash = deterministicHash(command.projectionMatch);
  if (
    !next.projectionMatches.some(
      (entry) => deterministicHash(entry) === matchHash,
    )
  ) {
    next.projectionMatches.push(structuredClone(command.projectionMatch));
  }
  const frozenResultPayload: Record<string, unknown> = {
    kind: "sku-target-pull-change-result/v1",
    sku: structuredClone(resultSku),
    originalSku: structuredClone(resultingOriginal),
    series: structuredClone(nextSeries),
    mode,
    publishedSnapshotIds: [...publishedSnapshotIds],
  };
  next.commandIdempotencyRecords.push({
    key: idempotencyKey,
    inputHash,
    resultRef: resultSku.id,
    resultPayload: frozenResultPayload,
    resultPayloadHash: sha256Stable(frozenResultPayload),
  });
  next.governanceAuditLog.push({
    id: `audit:sku-target-pull:${deterministicHash({
      idempotencyKey,
      inputHash,
    })}`,
    action: "change_sku_target_pull",
    entityType: "sku_drawer",
    entityId: resultSku.id,
    actor: command.actor,
    occurredAt: command.occurredAt,
    details: {
      mode,
      sourceSkuId: original.id,
      sourceSkuRevision: original.revision,
      resultSkuId: resultSku.id,
      resultSkuRevision: resultSku.revision,
      seriesId: series.id,
      seriesRevisionBefore: series.revision,
      seriesRevisionAfter: nextSeries.revision,
      targetPullKgBefore: original.targetPullKg,
      targetPullKgAfter: command.targetPullKg,
      projectionIdBefore: original.projectionMatch.projectionId,
      projectionIdAfter: command.projectionMatch.projectionId,
      ruleSetVersionAfter: command.projectionMatch.ruleSetVersion,
      publishedSnapshotIds,
      originalDeprecated:
        mode === "REPLACEMENT_SKU" && Boolean(command.deprecateOriginal),
      idempotencyKey,
    },
  });

  if (
    snapshotsBefore !== deterministicHash(next.configurationSnapshots)
  ) {
    throw new Error(
      "内部错误：SKU 拉力变更不得改写已发布 ConfigurationSnapshot。",
    );
  }
  return {
    state: next,
    sku: resultSku,
    originalSku: resultingOriginal,
    series: nextSeries,
    mode,
    publishedSnapshotIds,
    idempotent: false,
  };
}
