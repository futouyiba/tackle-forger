import assert from "node:assert/strict";
import test from "node:test";
import { recoverSeriesCreateAfterSaveConflict } from "../lib/series-create-idempotency";
import { createSeedState } from "../lib/seed";

test("Series 保存冲突后回读接受 legacy hash 并恢复原结果", async () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0]!;
  const canonicalHash = "canonical:create-series";
  const legacyHash = "legacy:create-series:with-performance-null";
  const idempotencyKey = "create-series:rolling-deploy";
  state.commandIdempotencyRecords.push({
    key: idempotencyKey,
    inputHash: legacyHash,
    resultRef: series.id,
  });
  let readbackCount = 0;

  const recovered = await recoverSeriesCreateAfterSaveConflict({
    saveResult: { revision: 42, conflict: true },
    loadLatest: async () => {
      readbackCount += 1;
      return { state, revision: 43 };
    },
    idempotencyKey,
    acceptedInputHashes: new Set([canonicalHash, legacyHash]),
  });

  assert.equal(readbackCount, 1);
  assert.equal(recovered?.latest.revision, 43);
  assert.equal(recovered?.series.id, series.id);
});

test("Series 保存冲突回读拒绝同键不同输入且非冲突不回读", async () => {
  const state = createSeedState();
  const series = state.seriesDefinitions[0]!;
  state.commandIdempotencyRecords.push({
    key: "create-series:conflicting-input",
    inputHash: "different-input",
    resultRef: series.id,
  });
  let readbackCount = 0;
  const loadLatest = async () => {
    readbackCount += 1;
    return { state, revision: 8 };
  };

  assert.equal(await recoverSeriesCreateAfterSaveConflict({
    saveResult: { revision: 7 },
    loadLatest,
    idempotencyKey: "create-series:conflicting-input",
    acceptedInputHashes: new Set(["canonical", "legacy"]),
  }), undefined);
  assert.equal(readbackCount, 0);

  assert.equal(await recoverSeriesCreateAfterSaveConflict({
    saveResult: { revision: 8, conflict: true },
    loadLatest,
    idempotencyKey: "create-series:conflicting-input",
    acceptedInputHashes: new Set(["canonical", "legacy"]),
  }), undefined);
  assert.equal(readbackCount, 1);
});
