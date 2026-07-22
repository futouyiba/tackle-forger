import assert from "node:assert/strict";
import test from "node:test";
import { planSnapshotBatch, assertSnapshotBatchCanConfirm } from "../lib/snapshot-batch";
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
    skus: state.skuDrawers,
    snapshots: state.configurationSnapshots,
    selectedModelIds: [draft.id],
    now: "2026-07-21T00:00:00.000Z",
  });
  const right = planSnapshotBatch({
    models: [draft],
    skus: state.skuDrawers,
    snapshots: state.configurationSnapshots,
    selectedModelIds: [draft.id, draft.id],
    now: "2026-07-21T00:00:00.000Z",
  });
  assert.equal(left.inputHash, right.inputHash);
  assert.throws(() => assertSnapshotBatchCanConfirm(left), /没有可复用或可创建/);
});
