import assert from "node:assert/strict";
import test from "node:test";
import {
  SKU_NOT_CURRENT_SERIES_SPECIFICATION_CODE,
} from "../lib/enabled-item-parts";
import {
  planSnapshotBatch,
  assertSnapshotBatchCanConfirm,
  snapshotBatchEligibleModels,
} from "../lib/snapshot-batch";
import { createSeedState } from "../lib/seed";
import { hydrateV3Seed } from "../lib/v3-seed";

test("SnapshotBatch 复用未变化快照、创建合格新 revision 并跳过阻断项", () => {
  const state = hydrateV3Seed(createSeedState());
  const published = state.purchasableModels.find((model) => model.configurationSnapshotId);
  assert.ok(published);
  const createCandidate = structuredClone(published);
  createCandidate.id = "model:batch-create";
  createCandidate.name = "批量新修订";
  createCandidate.revision += 1;
  createCandidate.configurationSnapshotId = undefined;
  createCandidate.status = "approved";
  const blockedCandidate = structuredClone(createCandidate);
  blockedCandidate.id = "model:batch-blocked";
  blockedCandidate.skuId = "sku:batch-blocked";
  const sourceSku = state.skuDrawers.find((sku) => sku.id === published.skuId);
  assert.ok(sourceSku);
  const blockedSku = {
    ...structuredClone(sourceSku),
    id: blockedCandidate.skuId,
    validationSummary: [{
      level: "error" as const,
      code: "BATCH_BLOCKER",
      message: "批量发布阻断。",
    }],
  };

  const plan = planSnapshotBatch({
    models: [...state.purchasableModels, createCandidate, blockedCandidate],
    series: state.seriesDefinitions,
    skus: [...state.skuDrawers, blockedSku],
    snapshots: state.configurationSnapshots,
    selectedModelIds: [blockedCandidate.id, createCandidate.id, published.id],
    now: "2026-07-21T00:00:00.000Z",
  });

  assert.equal(plan.items.find((item) => item.modelId === published.id)?.decision, "reuse");
  assert.equal(plan.items.find((item) => item.modelId === createCandidate.id)?.decision, "create");
  assert.equal(plan.items.find((item) => item.modelId === blockedCandidate.id)?.decision, "skip");
  assert.doesNotThrow(() => assertSnapshotBatchCanConfirm(plan));
});

test("SnapshotBatch 输入排序稳定且全跳过时拒绝确认", () => {
  const state = hydrateV3Seed(createSeedState());
  const draft = structuredClone(state.purchasableModels[0]);
  draft.id = "model:draft-only";
  draft.status = "draft";
  draft.configurationSnapshotId = undefined;
  const left = planSnapshotBatch({
    models: [draft],
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    snapshots: state.configurationSnapshots,
    selectedModelIds: [draft.id],
    now: "2026-07-21T00:00:00.000Z",
  });
  const right = planSnapshotBatch({
    models: [draft],
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    snapshots: state.configurationSnapshots,
    selectedModelIds: [draft.id, draft.id],
    now: "2026-07-21T00:00:00.000Z",
  });
  assert.equal(left.inputHash, right.inputHash);
  assert.throws(() => assertSnapshotBatchCanConfirm(left), /没有可复用或可创建/);
});

test("SnapshotBatch 与导出候选拒绝 DEPRECATED 或非当前规格 SKU 的历史 Model", () => {
  const state = hydrateV3Seed(createSeedState());
  const published = state.purchasableModels.find(
    (model) => model.configurationSnapshotId,
  );
  assert.ok(published);
  const sku = state.skuDrawers.find((entry) => entry.id === published.skuId);
  assert.ok(sku);
  const series = state.seriesDefinitions.find(
    (entry) => entry.id === sku.seriesId,
  );
  assert.ok(series);

  const supersededSku = {
    ...structuredClone(sku),
    status: "superseded" as const,
  };
  const supersededPlan = planSnapshotBatch({
    models: state.purchasableModels,
    series: state.seriesDefinitions,
    skus: state.skuDrawers.map((entry) =>
      entry.id === supersededSku.id ? supersededSku : entry),
    snapshots: state.configurationSnapshots,
    selectedModelIds: [published.id],
    now: "2026-07-21T00:00:00.000Z",
  });
  assert.equal(supersededPlan.items[0]?.decision, "skip");
  assert.deepEqual(supersededPlan.items[0]?.reasons, [
    SKU_NOT_CURRENT_SERIES_SPECIFICATION_CODE,
  ]);

  const seriesWithoutSku = {
    ...structuredClone(series),
    targetPullSpecifications: series.targetPullSpecifications.filter(
      (entry) => entry.skuId !== sku.id,
    ),
  };
  const nonCurrentPlan = planSnapshotBatch({
    models: state.purchasableModels,
    series: state.seriesDefinitions.map((entry) =>
      entry.id === series.id ? seriesWithoutSku : entry),
    skus: state.skuDrawers,
    snapshots: state.configurationSnapshots,
    selectedModelIds: [published.id],
    now: "2026-07-21T00:00:00.000Z",
  });
  assert.equal(nonCurrentPlan.items[0]?.decision, "skip");
  assert.deepEqual(nonCurrentPlan.items[0]?.reasons, [
    SKU_NOT_CURRENT_SERIES_SPECIFICATION_CODE,
  ]);
  assert.equal(
    snapshotBatchEligibleModels({
      models: state.purchasableModels,
      series: state.seriesDefinitions,
      skus: state.skuDrawers.map((entry) =>
        entry.id === supersededSku.id ? supersededSku : entry),
    }).some((model) => model.id === published.id),
    false,
  );
  assert.equal(
    snapshotBatchEligibleModels({
      models: state.purchasableModels,
      series: state.seriesDefinitions.map((entry) =>
        entry.id === series.id ? seriesWithoutSku : entry),
      skus: state.skuDrawers,
    }).some((model) => model.id === published.id),
    false,
  );
});

test("SnapshotBatch 只读取 Model 明确指向的当前 Snapshot，不按历史 revision 猜测", () => {
  const state = hydrateV3Seed(createSeedState());
  const model = state.purchasableModels.find((entry) =>
    entry.configurationSnapshotId)!;
  const current = state.configurationSnapshots.find((entry) =>
    entry.id === model.configurationSnapshotId)!;
  const unrelatedHistory = {
    ...structuredClone(current),
    id: "snapshot:history-with-higher-revision",
    version: current.version + 100,
    modelRevision: current.modelRevision + 100,
  };
  const plan = planSnapshotBatch({
    models: [model],
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    snapshots: [unrelatedHistory, current],
    selectedModelIds: [model.id],
    now: "2026-07-23T00:00:00.000Z",
  });
  assert.equal(plan.items[0].decision, "reuse");
  assert.equal(plan.items[0].snapshotId, current.id);

  const broken = planSnapshotBatch({
    models: [{ ...model, configurationSnapshotId: "snapshot:missing" }],
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    snapshots: [current],
    selectedModelIds: [model.id],
    now: "2026-07-23T00:00:00.000Z",
  });
  assert.equal(broken.items[0].decision, "skip");
  assert.deepEqual(broken.items[0].reasons, ["CURRENT_SNAPSHOT_POINTER_BROKEN"]);
});
