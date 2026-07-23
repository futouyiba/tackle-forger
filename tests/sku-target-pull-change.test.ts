import assert from "node:assert/strict";
import test from "node:test";
import { validateSeriesInvariants } from "../lib/product-model";
import { deterministicHash } from "../lib/rule-kernel";
import { createSeedState } from "../lib/seed";
import {
  changeSkuTargetPull,
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
  return {
    skuId: sku.id,
    expectedRevision: sku.revision,
    targetPullKg: input.targetPullKg,
    projectionMatch: previewSkuTargetPullProjectionMatch({
      state: input.state,
      skuId: sku.id,
      expectedRevision: sku.revision,
      targetPullKg: input.targetPullKg,
    }),
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
});

test("幂等重试恢复同一结果，复用幂等键的不同输入被拒绝", () => {
  const state = createSeedState();
  const command = commandFor({
    state,
    skuId: "sku:qinglu-obstacle-1.8",
    targetPullKg: 2.2,
    idempotencyKey: "change:idempotent",
  });
  const first = changeSkuTargetPull(state, command);
  const auditCount = first.state.governanceAuditLog.length;
  const retried = changeSkuTargetPull(first.state, {
    ...command,
    occurredAt: "2026-07-23T05:00:00.000Z",
  });

  assert.equal(retried.idempotent, true);
  assert.equal(retried.sku.id, first.sku.id);
  assert.equal(retried.sku.revision, first.sku.revision);
  assert.equal(retried.state.governanceAuditLog.length, auditCount);
  assert.throws(
    () => changeSkuTargetPull(first.state, {
      ...command,
      targetPullKg: 2.3,
    }),
    (error) =>
      error instanceof SkuTargetPullChangeError &&
      error.code === "IDEMPOTENCY_CONFLICT",
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
