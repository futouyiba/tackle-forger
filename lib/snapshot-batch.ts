import { deterministicHash } from "./rule-kernel";
import {
  assertProductItemPartChainEnabled,
  assertSeriesItemPartChainEnabled,
  ITEM_PART_NOT_ENABLED_CODE,
  ItemPartNotEnabledError,
} from "./enabled-item-parts";
import type {
  ConfigurationSnapshot,
  PurchasableModel,
  SeriesDefinition,
  SkuDrawer,
  ValidationIssue,
} from "./types";

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
  return snapshots
    .filter((snapshot) => snapshot.modelId === model.id)
    .sort((left, right) =>
      right.modelRevision - left.modelRevision ||
      right.version - left.version ||
      right.id.localeCompare(left.id),
    )[0];
}

function issuesForModel(model: PurchasableModel, skus: SkuDrawer[]): ValidationIssue[] {
  const sku = skus.find((entry) => entry.id === model.skuId);
  return structuredClone(sku?.validationSummary ?? []);
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
    try {
      if (!series || !sku) {
        throw new ItemPartNotEnabledError(undefined, "snapshot");
      }
      const seriesItemPartId = assertSeriesItemPartChainEnabled(
        series,
        [sku],
        "snapshot",
        [],
        input.skus,
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
    const blocking = validationIssues.filter((issue) => issue.level === "error");
    if (
      latest &&
      latest.modelRevision === model.revision &&
      latest.contentHash &&
      (!model.configurationSnapshotId || model.configurationSnapshotId === latest.id)
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
  return {
    batchId: `snapshot-batch:${inputHash}`,
    selectedModelIds: selectedIds,
    items,
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
