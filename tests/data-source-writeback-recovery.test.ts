import assert from "node:assert/strict";
import test from "node:test";
import {
  executeRecoverableDataSourceWriteback,
  type WorkspaceRevisionStore,
} from "../lib/data-source-writeback-recovery";
import { createSeedState } from "../lib/seed";
import type { DataSourceProfile, DataSourceWritebackPreview, WorkspaceState } from "../lib/types";

const source: DataSourceProfile = {
  id: "source:recoverable",
  name: "恢复测试源",
  provider: "feishu_bitable",
  dataset: "weight_templates",
  appToken: "app",
  tableId: "table",
  viewId: "",
  shareUrl: "https://example.invalid/base/app",
  enabled: true,
  notes: "",
};

const preview: DataSourceWritebackPreview = {
  sourceId: source.id,
  sourceName: source.name,
  dataset: source.dataset,
  sourceFingerprint: "source-fingerprint",
  checksum: "rows-checksum",
  pulledAt: "2026-07-22T01:00:00.000Z",
  recordCount: 1,
  fieldCount: 1,
  issues: [],
  rows: [{ entityId: "template:1", recordId: "record:1", fieldNames: ["拉力"], fields: { 拉力: 9 } }],
};

test("远端成功、本地审计 revision 冲突后自动对账；整次重试不重复远端写入", async () => {
  let state = createSeedState();
  let revision = 1;
  let saveCalls = 0;
  let remoteCalls = 0;
  const originalBindings = structuredClone(state.dataSourceBindings);
  const originalImports = structuredClone(state.dataSourceImports);
  const store: WorkspaceRevisionStore = {
    async load() {
      return { state: structuredClone(state), revision };
    },
    async save(input) {
      saveCalls += 1;
      if (input.baseRevision !== revision) return { revision, conflict: true };
      if (saveCalls === 2) {
        // 模拟远端已成功后，另一命令抢先提交了 workspace revision。
        state = { ...state, notes: `${state.notes}\n并发审计` };
        revision += 1;
        return { revision, conflict: true };
      }
      state = structuredClone(input.state);
      revision += 1;
      return { revision };
    },
  };
  const writeRemote = async () => {
    remoteCalls += 1;
    return { result: "written" as const, evidence: [{ recordId: "record:1", matched: true }] };
  };

  const first = await executeRecoverableDataSourceWriteback({
    source,
    preview,
    author: "tester",
    requestedAt: "2026-07-22T01:00:01.000Z",
    expectedBaseRevision: 1,
    store,
    writeRemote,
  });
  assert.equal(first.intent.state, "COMPLETED");
  assert.equal(first.intent.remoteResult, "written");
  assert.equal(remoteCalls, 1);
  assert.equal(state.dataSourceWritebacks.length, 1);
  assert.equal(state.dataSourceWritebacks[0]?.evidence?.[0]?.matched, true);
  assert.deepEqual(state.dataSourceBindings, originalBindings, "写回不能顺带拉取 binding");
  assert.deepEqual(state.dataSourceImports, originalImports, "写回不能顺带发布规则源");

  const retry = await executeRecoverableDataSourceWriteback({
    source,
    preview,
    author: "tester",
    requestedAt: "2026-07-22T01:00:02.000Z",
    expectedBaseRevision: 1,
    store,
    writeRemote,
  });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.remoteAttempted, false);
  assert.equal(remoteCalls, 1);
  assert.equal(state.dataSourceWritebacks.length, 1);
});

test("远端未确认时保留完整意图和回读证据，之后可用同一意图恢复", async () => {
  let state: WorkspaceState = createSeedState();
  let revision = 1;
  let remoteCalls = 0;
  const store: WorkspaceRevisionStore = {
    async load() { return { state: structuredClone(state), revision }; },
    async save(input) {
      assert.equal(input.baseRevision, revision);
      state = structuredClone(input.state);
      revision += 1;
      return { revision };
    },
  };
  const failed = await executeRecoverableDataSourceWriteback({
    source, preview, author: "tester", requestedAt: "2026-07-22T02:00:00.000Z",
    store,
    writeRemote: async () => {
      remoteCalls += 1;
      return { result: "failed", evidence: [{ recordId: "record:1", matched: false }], error: "timeout" };
    },
  });
  assert.equal(failed.intent.state, "WRITE_FAILED");
  assert.deepEqual(failed.intent.rows, preview.rows);
  assert.equal(state.dataSourceWritebacks.length, 0);

  const recovered = await executeRecoverableDataSourceWriteback({
    source, preview, author: "tester", requestedAt: "2026-07-22T02:01:00.000Z",
    store,
    writeRemote: async () => {
      remoteCalls += 1;
      return { result: "alreadyApplied", evidence: [{ recordId: "record:1", matched: true }] };
    },
  });
  assert.equal(recovered.intent.state, "COMPLETED");
  assert.equal(recovered.intent.remoteResult, "alreadyApplied");
  assert.equal(remoteCalls, 2);
  assert.equal(state.dataSourceWritebacks.length, 1);
});

test("远端成功而本地审计持续保存失败时，显式重试只回读并最终收敛", async () => {
  let state = createSeedState();
  let revision = 1;
  let rejectFinalization = true;
  let remoteRequests = 0;
  let remoteAppends = 0;
  let remoteApplied = false;
  const store: WorkspaceRevisionStore = {
    async load() { return { state: structuredClone(state), revision }; },
    async save(input) {
      assert.equal(input.baseRevision, revision);
      const isIntentOnly = input.state.dataSourceWritebackIntents[0]?.state === "PENDING";
      if (rejectFinalization && !isIntentOnly) {
        state = { ...state, notes: `${state.notes}\n并发-${revision}` };
        revision += 1;
        return { revision, conflict: true };
      }
      state = structuredClone(input.state);
      revision += 1;
      return { revision };
    },
  };
  const writeRemote = async () => {
    remoteRequests += 1;
    if (remoteApplied) {
      return { result: "alreadyApplied" as const, evidence: [{ recordId: "record:1", matched: true }] };
    }
    remoteApplied = true;
    remoteAppends += 1;
    return { result: "written" as const, evidence: [{ recordId: "record:1", matched: true }] };
  };

  await assert.rejects(
    executeRecoverableDataSourceWriteback({
      source, preview, author: "tester", requestedAt: "2026-07-22T03:00:00.000Z",
      expectedBaseRevision: 1, store, writeRemote,
    }),
    /持续发生 revision 冲突/,
  );
  assert.equal(state.dataSourceWritebackIntents[0]?.state, "PENDING");
  assert.equal(remoteAppends, 1);

  rejectFinalization = false;
  const recovered = await executeRecoverableDataSourceWriteback({
    source, preview, author: "tester", requestedAt: "2026-07-22T03:01:00.000Z",
    expectedBaseRevision: 1, store, writeRemote,
  });
  assert.equal(recovered.intent.state, "COMPLETED");
  assert.equal(recovered.intent.remoteResult, "alreadyApplied");
  assert.equal(remoteRequests, 2, "重试允许一次远端回读请求");
  assert.equal(remoteAppends, 1, "重试不得再次追加远端写入");
  assert.equal(state.dataSourceWritebacks.length, 1);
});
