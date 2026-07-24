import { deterministicHash } from "./rule-kernel";
import { isCanonicalValidationIssue, validationIssueLevel } from "./validation-issues";
import {
  assertCurrentSeriesSkuSpecifications,
  assertProductItemPartChainEnabled,
  assertSeriesItemPartChainEnabled,
  isCurrentSeriesSkuSpecification,
  isProductItemPartEnabled,
  ITEM_PART_NOT_ENABLED_CODE,
  ItemPartNotEnabledError,
} from "./enabled-item-parts";
import type {
  ConfigurationSnapshot,
  FiveAxisCandidateDelta,
  FiveAxisTransactionPlan,
  PurchasableModel,
  SeriesDefinition,
  SkuDrawer,
  ValidationIssue,
} from "./types";
import { planFiveAxisTransactions } from "./five-axis-transactions";

export type SnapshotBatchDecision = "reuse" | "create" | "skip";

export interface SnapshotBatchItem {
  modelId: string;
  modelRevision: number;
  decision: SnapshotBatchDecision;
  snapshotId?: string;
  reasons: string[];
  validationIssues: ValidationIssue[];
}

export interface SnapshotBatchPlan {
  batchId: string;
  selectedModelIds: string[];
  items: SnapshotBatchItem[];
  createdAt: string;
  inputHash: string;
}

function latestSnapshot(
  model: PurchasableModel,
  snapshots: ConfigurationSnapshot[],
): ConfigurationSnapshot | undefined {
  if (!model.configurationSnapshotId) return undefined;
  return snapshots.find((snapshot) =>
    snapshot.id === model.configurationSnapshotId && snapshot.modelId === model.id);
}

function issuesForModel(model: PurchasableModel, skus: SkuDrawer[]): ValidationIssue[] {
  const sku = skus.find((entry) => entry.id === model.skuId);
  return structuredClone(sku?.validationSummary ?? []);
}

export function snapshotBatchEligibleModels(input: {
  models: PurchasableModel[];
  series: SeriesDefinition[];
  skus: SkuDrawer[];
}): PurchasableModel[] {
  const skuById = new Map(input.skus.map((sku) => [sku.id, sku]));
  const seriesById = new Map(
    input.series.map((series) => [series.id, series]),
  );
  return input.models.filter((model) => {
    const sku = skuById.get(model.skuId);
    const series = sku ? seriesById.get(sku.seriesId) : undefined;
    return Boolean(
      sku &&
      series &&
      isCurrentSeriesSkuSpecification(series, sku) &&
      isProductItemPartEnabled(sku.projectionMatch.itemPartId),
    );
  });
}

export function planSnapshotBatch(input: {
  models: PurchasableModel[];
  series: SeriesDefinition[];
  skus: SkuDrawer[];
  snapshots: ConfigurationSnapshot[];
  selectedModelIds: string[];
  now?: string;
}): SnapshotBatchPlan {
  const selectedIds = [...new Set(input.selectedModelIds)].sort();
  const modelById = new Map(input.models.map((model) => [model.id, model]));
  const items = selectedIds.map((modelId): SnapshotBatchItem => {
    const model = modelById.get(modelId);
    if (!model) {
      return {
        modelId,
        modelRevision: 0,
        decision: "skip",
        reasons: ["MODEL_NOT_FOUND"],
        validationIssues: [{
          level: "error",
          code: "SNAPSHOT_BATCH_MODEL_NOT_FOUND",
          message: `Model ${modelId} 不存在或当前用户不可见。`,
        }],
      };
    }
    const validationIssues = issuesForModel(model, input.skus);
    const sku = input.skus.find((entry) => entry.id === model.skuId);
    const series = sku
      ? input.series.find((entry) => entry.id === sku.seriesId)
      : undefined;
    const latest = latestSnapshot(model, input.snapshots);
    if (model.configurationSnapshotId && !latest) {
      return {
        modelId,
        modelRevision: model.revision,
        decision: "skip",
        reasons: ["CURRENT_SNAPSHOT_POINTER_BROKEN"],
        validationIssues: [{ level: "error", code: "CURRENT_SNAPSHOT_POINTER_BROKEN", message: `Model ${model.id} 指向的当前 Snapshot 不存在或不属于该 Model。` }],
      };
    }
    try {
      if (!series || !sku) {
        throw new ItemPartNotEnabledError(undefined, "snapshot");
      }
      assertCurrentSeriesSkuSpecifications(series, [sku], "snapshot");
      const seriesItemPartId = assertSeriesItemPartChainEnabled(
        series,
        [sku],
        "snapshot",
        [],
        input.skus.filter((entry) => entry.status !== "superseded"),
      );
      if (latest) {
        assertProductItemPartChainEnabled([
          seriesItemPartId,
          sku.projectionMatch.itemPartId,
          latest.projectionMatch.itemPartId,
        ], "snapshot");
      }
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error
        ? String(error.code)
        : ITEM_PART_NOT_ENABLED_CODE;
      return {
        modelId,
        modelRevision: model.revision,
        decision: "skip",
        reasons: [code],
        validationIssues: [{
          level: "error",
          code,
          message: error instanceof Error
            ? error.message
            : `部位未启用：${sku?.projectionMatch.itemPartId ?? "unknown"} 当前不能进入 ConfigurationSnapshot 流程。`,
        }],
      };
    }
    // 旧格式 error 没有可验证的治理状态，继续 fail-closed；规范 Issue 则只让
    // 仍处于 OPEN 的记录阻断，不能把已 WAIVED/RESOLVED/STALE 的历史证据重新激活。
    const blocking = validationIssues.filter((issue) =>
      validationIssueLevel(issue) === "error"
      && (!isCanonicalValidationIssue(issue) || issue.state === "OPEN"));
    if (
      latest &&
      latest.modelRevision === model.revision &&
      latest.contentHash &&
      model.configurationSnapshotId === latest.id
    ) {
      return {
        modelId,
        modelRevision: model.revision,
        decision: "reuse",
        snapshotId: latest.id,
        reasons: ["UNCHANGED_MODEL_REVISION"],
        validationIssues,
      };
    }
    if (blocking.length) {
      return {
        modelId,
        modelRevision: model.revision,
        decision: "skip",
        reasons: ["BLOCKING_VALIDATION_ISSUES"],
        validationIssues,
      };
    }
    if (model.status !== "approved" && model.status !== "published") {
      return {
        modelId,
        modelRevision: model.revision,
        decision: "skip",
        reasons: ["MODEL_NOT_APPROVED"],
        validationIssues,
      };
    }
    return {
      modelId,
      modelRevision: model.revision,
      decision: "create",
      reasons: ["NEW_APPROVED_REVISION"],
      validationIssues,
    };
  });
  const createdAt = input.now ?? new Date().toISOString();
  const content = { selectedModelIds: selectedIds, items };
  const inputHash = deterministicHash(content);
  const stableItems = items.map((item) => item.decision === "create"
    ? { ...item, snapshotId: `snapshot:${item.modelId}:batch:${inputHash}` }
    : item);
  return {
    batchId: `snapshot-batch:${inputHash}`,
    selectedModelIds: selectedIds,
    items: stableItems,
    createdAt,
    inputHash,
  };
}

export function assertSnapshotBatchCanConfirm(plan: SnapshotBatchPlan): void {
  if (!plan.items.length) throw new Error("SnapshotBatch 不能为空。");
  if (plan.items.every((item) => item.decision === "skip")) {
    throw new Error("SnapshotBatch 没有可复用或可创建的 Snapshot。");
  }
  for (const item of plan.items) {
    if (item.decision === "reuse" && !item.snapshotId) {
      throw new Error(`Model ${item.modelId} 的复用项缺少 snapshotId。`);
    }
  }
}

/** A batch may only carry deltas for its own create items; accepting unrelated
 * mutations would silently widen the user's confirmation boundary. */
export function planSnapshotBatchFiveAxisTransactions(input: {
  batchPlan: SnapshotBatchPlan;
  deltas: FiveAxisCandidateDelta[];
}): FiveAxisTransactionPlan {
  assertSnapshotBatchCanConfirm(input.batchPlan);
  const createItems = new Map(input.batchPlan.items
    .filter((item) => item.decision === "create")
    .map((item) => [item.modelId, item]));
  for (const delta of input.deltas) {
    if (!createItems.has(delta.modelId)) {
      throw new Error(`FIVE_AXIS_SNAPSHOT_DELTA_UNRELATED：Model ${delta.modelId} 不属于本次 Snapshot create 项。`);
    }
  }
  for (const [modelId, createItem] of createItems) {
    const createDeltas = input.deltas.filter((delta) =>
      delta.modelId === modelId && (delta.operation === "ADD" || delta.operation === "REPLACE") && delta.after);
    if (createDeltas.length !== 1) {
      throw new Error(`FIVE_AXIS_SNAPSHOT_DELTA_MISSING：Model ${modelId} 的 create 项必须恰好对应一个 ADD/REPLACE delta。`);
    }
    if (createDeltas[0].after!.candidateSources.some((source) => source.snapshotId !== createItem.snapshotId)) {
      throw new Error(`FIVE_AXIS_SNAPSHOT_ID_CONFLICT：Model ${modelId} 候选未使用批次预分配 snapshotId。`);
    }
  }
  return planFiveAxisTransactions({ deltas: input.deltas, snapshotBuildModelIds: [...createItems.keys()] });
}
