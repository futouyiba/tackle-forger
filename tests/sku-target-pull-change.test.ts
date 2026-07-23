import assert from "node:assert/strict";
import test from "node:test";
import { buildSeriesGanttProjection } from "../lib/interaction-contracts";
import {
  candidateGenerationEligibleSkus,
  SKU_NOT_CURRENT_SERIES_SPECIFICATION_CODE,
} from "../lib/enabled-item-parts";
import { validateSeriesInvariants } from "../lib/product-model";
import { deterministicHash } from "../lib/rule-kernel";
import { createSeedState } from "../lib/seed";
import { planSnapshotBatch } from "../lib/snapshot-batch";
import {
  changeSkuTargetPull,
  previewSkuTargetPullChange,
  previewSkuTargetPullProjectionMatch,
  SkuTargetPullChangeError,
} from "../lib/sku-target-pull-change";

const occurredAt = "2026-07-23T04:00:00.000Z";

function commandFor(input: {
  state: ReturnType<typeof createSeedState>;
  skuId: string;
  targetPullKg: number;
  idempotencyKey: string;
  replacementSkuId?: string;
  deprecateOriginal?: boolean;
}) {
  const sku = input.state.skuDrawers.find((entry) => entry.id === input.skuId)!;
  const preview = previewSkuTargetPullChange({
    state: input.state,
    skuId: sku.id,
    expectedRevision: sku.revision,
    targetPullKg: input.targetPullKg,
  });
  return {
    skuId: sku.id,
    expectedRevision: sku.revision,
    targetPullKg: input.targetPullKg,
    projectionMatch: preview.projectionMatch,
    expectedMode: preview.mode,
    publishedDescendantFingerprint:
      preview.publishedDescendantFingerprint,
    replacementSkuId: input.replacementSkuId,
    deprecateOriginal: input.deprecateOriginal,
    idempotencyKey: input.idempotencyKey,
    actor: "test:editor",
    occurredAt,
  };
}

test("无已发布后代时保留 skuId、创建新 revision 并显式更新 ProjectionMatch", () => {
  const state = createSeedState();
  const sku = state.skuDrawers.find(
    (entry) => entry.id === "sku:qinglu-obstacle-1.8",
  )!;
  const snapshotsBefore = structuredClone(state.configurationSnapshots);
  const oldMatch = structuredClone(sku.projectionMatch);
  const command = commandFor({
    state,
    skuId: sku.id,
    targetPullKg: 2.1,
    idempotencyKey: "change:sku18:2.1",
  });

  const result = changeSkuTargetPull(state, command);

  assert.equal(result.mode, "SAME_SKU_NEW_REVISION");
  assert.equal(result.sku.id, sku.id);
  assert.equal(result.sku.revision, sku.revision + 1);
  assert.equal(result.sku.targetPullKg, 2.1);
  assert.deepEqual(result.sku.projectionMatch, command.projectionMatch);
  assert.deepEqual(state.skuDrawers.find((entry) => entry.id === sku.id)!.projectionMatch, oldMatch);
  assert.deepEqual(result.state.configurationSnapshots, snapshotsBefore);
  assert.deepEqual(
    result.series.targetPullSpecifications.find((entry) => entry.skuId === sku.id),
    { targetPullKgf: 2.1, skuId: sku.id },
  );
  assert.ok(
    result.sku.validationSummary.some(
      (issue) => issue.code === "SKU_TARGET_PULL_CHANGED_REVIEW_REQUIRED",
    ),
  );
  assert.equal(
    result.state.governanceAuditLog.at(-1)?.action,
    "change_sku_target_pull",
  );
});

test("存在已发布后代时创建新 SKU、可 DEPRECATED 旧 SKU 且冻结旧 Snapshot", () => {
  const state = createSeedState();
  const sku = state.skuDrawers.find(
    (entry) => entry.id === "sku:qinglu-obstacle-1.5",
  )!;
  const snapshotBytes = JSON.stringify(state.configurationSnapshots);
  const snapshotHash = deterministicHash(state.configurationSnapshots);
  const originalMatch = structuredClone(sku.projectionMatch);
  const command = commandFor({
    state,
    skuId: sku.id,
    targetPullKg: 1.6,
    idempotencyKey: "change:sku15:1.6",
    replacementSkuId: "sku:qinglu-obstacle-1.6",
    deprecateOriginal: true,
  });

  const result = changeSkuTargetPull(state, command);

  assert.equal(result.mode, "REPLACEMENT_SKU");
  assert.equal(result.sku.id, "sku:qinglu-obstacle-1.6");
  assert.equal(result.sku.revision, 1);
  assert.equal(result.sku.targetPullKg, 1.6);
  assert.equal(result.originalSku.id, sku.id);
  assert.equal(result.originalSku.revision, sku.revision + 1);
  assert.equal(result.originalSku.status, "superseded");
  assert.equal(result.originalSku.seriesId, sku.seriesId);
  assert.deepEqual(result.originalSku.projectionMatch, originalMatch);
  assert.equal(JSON.stringify(result.state.configurationSnapshots), snapshotBytes);
  assert.equal(deterministicHash(result.state.configurationSnapshots), snapshotHash);
  assert.ok(result.publishedSnapshotIds.length > 0);
  assert.equal(
    result.state.purchasableModels.some(
      (model) => model.skuId === sku.id,
    ),
    true,
  );
  assert.deepEqual(
    result.series.targetPullSpecifications.find(
      (entry) => entry.skuId === result.sku.id,
    ),
    { targetPullKgf: 1.6, skuId: result.sku.id },
  );
  assert.equal(
    result.series.targetPullSpecifications.some(
      (entry) => entry.skuId === sku.id,
    ),
    false,
  );
  const eligibleSkuIds = candidateGenerationEligibleSkus(
    result.series,
    result.state.skuDrawers,
  ).map((entry) => entry.id);
  assert.equal(eligibleSkuIds.includes(sku.id), false);
  assert.equal(eligibleSkuIds.includes(result.sku.id), true);
  const issues = validateSeriesInvariants({
    series: result.series,
    skus: result.state.skuDrawers,
    models: result.state.purchasableModels,
    projections: result.state.derivedProjections,
  });
  assert.equal(
    issues.some(
      (issue) =>
        issue.code === "SERIES_WEIGHT_UNDECLARED" &&
        issue.message.includes(sku.id),
    ),
    false,
  );
  const gantt = buildSeriesGanttProjection({
    series: result.state.seriesDefinitions,
    skus: result.state.skuDrawers,
    models: result.state.purchasableModels,
  }).find((entry) => entry.seriesId === sku.seriesId)!;
  assert.equal(
    gantt.skuNodes.some((entry) => entry.skuId === sku.id),
    false,
  );
  assert.equal(
    gantt.skuNodes.some((entry) => entry.skuId === result.sku.id),
    true,
  );
  const historicalModel = result.state.purchasableModels.find(
    (model) =>
      model.skuId === sku.id &&
      Boolean(model.configurationSnapshotId),
  );
  assert.ok(historicalModel);
  const exportPlan = planSnapshotBatch({
    models: result.state.purchasableModels,
    series: result.state.seriesDefinitions,
    skus: result.state.skuDrawers,
    snapshots: result.state.configurationSnapshots,
    selectedModelIds: [historicalModel.id],
  });
  assert.equal(exportPlan.items[0]?.decision, "skip");
  assert.deepEqual(exportPlan.items[0]?.reasons, [
    SKU_NOT_CURRENT_SERIES_SPECIFICATION_CODE,
  ]);
});

test("已发布后代分支可保留旧 SKU 生命周期状态，但仍不会重绑历史对象", () => {
  const state = createSeedState();
  const sku = state.skuDrawers.find(
    (entry) => entry.id === "sku:qinglu-obstacle-1.5",
  )!;
  const command = commandFor({
    state,
    skuId: sku.id,
    targetPullKg: 1.65,
    idempotencyKey: "change:sku15:1.65",
    replacementSkuId: "sku:qinglu-obstacle-1.65",
    deprecateOriginal: false,
  });

  const result = changeSkuTargetPull(state, command);

  assert.equal(result.originalSku.status, sku.status);
  assert.equal(result.originalSku.revision, sku.revision);
  assert.deepEqual(result.originalSku, sku);
  assert.deepEqual(
    result.series.targetPullSpecifications.find(
      (entry) => entry.skuId === sku.id,
    ),
    { targetPullKgf: sku.targetPullKg, skuId: sku.id },
  );
  assert.deepEqual(
    result.series.targetPullSpecifications.find(
      (entry) => entry.skuId === result.sku.id,
    ),
    { targetPullKgf: 1.65, skuId: result.sku.id },
  );
  const issues = validateSeriesInvariants({
    series: result.series,
    skus: result.state.skuDrawers,
    models: result.state.purchasableModels,
    projections: result.state.derivedProjections,
  });
  assert.equal(
    issues.some(
      (issue) =>
        issue.code === "SERIES_WEIGHT_UNDECLARED" &&
        issue.message.includes(sku.id),
    ),
    false,
  );
});

test("幂等重试恢复同一结果，复用幂等键的不同输入被拒绝", () => {
  const state = createSeedState();
  const command = commandFor({
    state,
    skuId: "sku:qinglu-obstacle-1.8",
    targetPullKg: 2.1,
    idempotencyKey: "change:idempotent",
  });
  const first = changeSkuTargetPull(state, command);
  const laterCommand = commandFor({
    state: first.state,
    skuId: first.sku.id,
    targetPullKg: 2.2,
    idempotencyKey: "change:later",
  });
  const later = changeSkuTargetPull(first.state, laterCommand);
  const auditCount = later.state.governanceAuditLog.length;
  const retried = changeSkuTargetPull(later.state, {
    ...command,
    occurredAt: "2026-07-23T05:00:00.000Z",
  });

  assert.equal(retried.idempotent, true);
  assert.equal(retried.sku.id, first.sku.id);
  assert.equal(retried.sku.revision, first.sku.revision);
  assert.equal(retried.sku.targetPullKg, first.sku.targetPullKg);
  assert.equal(retried.series.revision, first.series.revision);
  assert.deepEqual(retried.sku, first.sku);
  assert.deepEqual(retried.series, first.series);
  assert.equal(retried.state.governanceAuditLog.length, auditCount);
  assert.throws(
    () => changeSkuTargetPull(later.state, {
      ...command,
      targetPullKg: 2.3,
    }),
    (error) =>
      error instanceof SkuTargetPullChangeError &&
      error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("预览后已发布后代集合变化时拒绝静默切换冻结分支", () => {
  const state = createSeedState();
  const sku = state.skuDrawers.find(
    (entry) => entry.id === "sku:qinglu-obstacle-1.8",
  )!;
  const command = commandFor({
    state,
    skuId: sku.id,
    targetPullKg: 2.3,
    idempotencyKey: "change:preview-drift",
    replacementSkuId: "sku:qinglu-obstacle-2.3",
    deprecateOriginal: true,
  });
  assert.equal(command.expectedMode, "SAME_SKU_NEW_REVISION");

  const drifted = structuredClone(state);
  drifted.configurationSnapshots.push({
    ...structuredClone(state.configurationSnapshots[0]),
    id: "snapshot:concurrent-sku18",
    modelId: sku.modelIds[0],
    skuRevision: sku.revision,
    contentHash: "concurrent-snapshot-content",
  });

  assert.throws(
    () => changeSkuTargetPull(drifted, command),
    (error) =>
      error instanceof SkuTargetPullChangeError &&
      error.code === "PREVIEW_STALE",
  );
  assert.equal(
    drifted.skuDrawers.find((entry) => entry.id === sku.id)?.status,
    sku.status,
  );
  assert.equal(
    drifted.skuDrawers.some(
      (entry) => entry.id === "sku:qinglu-obstacle-2.3",
    ),
    false,
  );
});

test("Series 校验忽略明确 DEPRECATED 历史 SKU，但报告活动未声明 SKU", () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0];
  const source = state.skuDrawers[0];
  const activeUndeclared = {
    ...structuredClone(source),
    id: "sku:active-undeclared",
    targetPullKg: 9.9,
    modelIds: [],
    defaultModelId: undefined,
    status: "draft" as const,
  };
  const deprecatedHistory = {
    ...structuredClone(source),
    id: "sku:deprecated-history",
    targetPullKg: 10.1,
    modelIds: [],
    defaultModelId: undefined,
    status: "superseded" as const,
  };
  const issues = validateSeriesInvariants({
    series,
    skus: [...state.skuDrawers, activeUndeclared, deprecatedHistory],
    models: state.purchasableModels,
    projections: state.derivedProjections,
  });

  assert.equal(
    issues.some(
      (issue) =>
        issue.code === "SERIES_WEIGHT_UNDECLARED" &&
        issue.message.includes(activeUndeclared.id),
    ),
    true,
  );
  assert.equal(
    issues.some((issue) => issue.message.includes(deprecatedHistory.id)),
    false,
  );
});

test("revision 冲突、重复规格与过期 ProjectionMatch 均被阻断", () => {
  const state = createSeedState();
  const sku = state.skuDrawers.find(
    (entry) => entry.id === "sku:qinglu-obstacle-1.8",
  )!;
  const valid = commandFor({
    state,
    skuId: sku.id,
    targetPullKg: 2.4,
    idempotencyKey: "change:guards",
  });

  assert.throws(
    () => changeSkuTargetPull(state, {
      ...valid,
      expectedRevision: sku.revision + 1,
    }),
    (error) =>
      error instanceof SkuTargetPullChangeError &&
      error.code === "REVISION_CONFLICT",
  );
  assert.throws(
    () => changeSkuTargetPull(state, {
      ...valid,
      targetPullKg: 1.5,
      projectionMatch: previewSkuTargetPullProjectionMatch({
        state,
        skuId: sku.id,
        expectedRevision: sku.revision,
        targetPullKg: 1.5,
      }),
      idempotencyKey: "change:duplicate",
    }),
    (error) =>
      error instanceof SkuTargetPullChangeError &&
      error.code === "TARGET_PULL_DUPLICATE",
  );
  assert.throws(
    () => changeSkuTargetPull(state, {
      ...valid,
      projectionMatch: {
        ...valid.projectionMatch,
        projectionId: "projection:client-silent-rebind",
      },
      idempotencyKey: "change:stale-match",
    }),
    (error) =>
      error instanceof SkuTargetPullChangeError &&
      error.code === "PROJECTION_MATCH_STALE",
  );
});

test("有已发布后代时拒绝缺失或冲突的 replacementSkuId", () => {
  const state = createSeedState();
  const base = commandFor({
    state,
    skuId: "sku:qinglu-obstacle-1.5",
    targetPullKg: 1.7,
    idempotencyKey: "change:replacement-required",
  });
  assert.throws(
    () => changeSkuTargetPull(state, base),
    (error) =>
      error instanceof SkuTargetPullChangeError &&
      error.code === "REPLACEMENT_SKU_ID_REQUIRED",
  );
  assert.throws(
    () => changeSkuTargetPull(state, {
      ...base,
      replacementSkuId: "sku:qinglu-obstacle-1.8",
      idempotencyKey: "change:replacement-conflict",
    }),
    (error) =>
      error instanceof SkuTargetPullChangeError &&
      error.code === "REPLACEMENT_SKU_ID_CONFLICT",
  );
});
