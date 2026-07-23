import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ActionCommandPayloadError,
  executeActionCommandPayload,
  issueActionCommandPayload,
  type JsonObject,
} from "../lib/action-command-payloads";
import type {
  ActionCode,
  CapabilityCode,
} from "../lib/interaction-contracts";
import {
  workspaceCommandInputHash,
  workspaceCommandSubject,
} from "../lib/production-action-commands";
import { SqliteActionCommandPayloadStore } from "../lib/sqlite-action-command-payload-store";
import {
  closeSqliteStorage,
  loadSqliteWorkspace,
  saveSqliteWorkspace,
} from "../lib/sqlite-storage";

const actorId = "feishu:tenant:sqlite-command-test";

async function withDatabase(
  run: (databasePath: string) => Promise<void>,
) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tackle-forger-command-store-"),
  );
  const databasePath = path.join(directory, "workspace.sqlite");
  try {
    await run(databasePath);
  } finally {
    await closeSqliteStorage(databasePath);
    await rm(directory, { recursive: true, force: true });
  }
}

async function issue(input: {
  store: SqliteActionCommandPayloadStore;
  action: ActionCode;
  capability: CapabilityCode;
  revision: number;
  idempotencyKey: string;
  payload?: JsonObject;
}) {
  const subjectRef = workspaceCommandSubject(input.revision);
  return input.store.issueWithWorkspaceLease(
    (leaseRef, prior) => issueActionCommandPayload({
      store: input.store,
      actionId: prior?.actionId ?? `action:${input.action}:${input.idempotencyKey}`,
      action: input.action,
      subjectRef: prior?.subjectRef ?? subjectRef,
      expectedRevisionId: prior?.expectedRevisionId ?? subjectRef.revisionId,
      inputHash: prior?.inputHash ?? workspaceCommandInputHash(input.revision),
      leaseRef,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? { test: input.idempotencyKey },
      actorId,
      capabilities: [input.capability],
    }),
    {
      workspaceId: subjectRef.workspaceId,
      action: input.action,
      actorId,
      idempotencyKey: input.idempotencyKey,
    },
  );
}

test("SQLite 命令记录和执行结果跨 store 实例持久化，首次业务写与结果原子提交", async () => {
  await withDatabase(async (databasePath) => {
    const firstStore = new SqliteActionCommandPayloadStore(databasePath);
    const initial = await loadSqliteWorkspace(databasePath);
    const payloadRef = await issue({
      store: firstStore,
      action: "save_workspace",
      capability: "workspace.save",
      revision: initial.revision,
      idempotencyKey: "sqlite:persist-and-replay",
    });
    await closeSqliteStorage(databasePath);

    const restartedStore = new SqliteActionCommandPayloadStore(databasePath);
    const persisted = await restartedStore.findByPayloadRefId(payloadRef.payloadRefId);
    assert.ok(persisted);
    const firstExecution = await executeActionCommandPayload({
      store: restartedStore,
      invocation: {
        actionId: persisted.actionId,
        payloadRefId: payloadRef.payloadRefId,
      },
      actorId,
      capabilities: ["workspace.save"],
      currentSubjectRef: workspaceCommandSubject(initial.revision),
      currentInputHash: workspaceCommandInputHash(initial.revision),
      execute: async () => {
        const current = await loadSqliteWorkspace(databasePath);
        const state = structuredClone(current.state);
        state.notes = "committed-with-command-result";
        const saved = await saveSqliteWorkspace(databasePath, {
          state,
          baseRevision: current.revision,
          author: actorId,
          message: "原子命令写入",
        });
        assert.equal(saved.conflict, undefined);
        return { revision: saved.revision };
      },
    });
    assert.equal(firstExecution.replayed, false);
    assert.equal(
      (await loadSqliteWorkspace(databasePath)).state.notes,
      "committed-with-command-result",
    );

    await closeSqliteStorage(databasePath);
    const replayStore = new SqliteActionCommandPayloadStore(databasePath);
    const replay = await executeActionCommandPayload({
      store: replayStore,
      invocation: {
        actionId: persisted.actionId,
        payloadRefId: payloadRef.payloadRefId,
      },
      actorId,
      capabilities: [],
      currentSubjectRef: workspaceCommandSubject(initial.revision + 99),
      currentInputHash: workspaceCommandInputHash(initial.revision + 99),
      execute: async () => {
        throw new Error("持久化成功结果不得再次执行。");
      },
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, firstExecution.result);
  });
});

test("SQLite 当前租约只按 workspace 分槽，跨动作签发会废止旧命令", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SqliteActionCommandPayloadStore(databasePath);
    const current = await loadSqliteWorkspace(databasePath);
    const createRef = await issue({
      store,
      action: "create_series",
      capability: "series.edit",
      revision: current.revision,
      idempotencyKey: "sqlite:cross-action:create",
    });
    const saveRef = await issue({
      store,
      action: "save_workspace",
      capability: "workspace.save",
      revision: current.revision,
      idempotencyKey: "sqlite:cross-action:save",
    });
    const createRecord = await store.findByPayloadRefId(createRef.payloadRefId);
    const saveRecord = await store.findByPayloadRefId(saveRef.payloadRefId);
    assert.ok(createRecord && saveRecord);
    assert.ok(
      BigInt(saveRecord.leaseRef.fencingToken)
        > BigInt(createRecord.leaseRef.fencingToken),
    );
    let writes = 0;
    await assert.rejects(
      executeActionCommandPayload({
        store,
        invocation: {
          actionId: createRecord.actionId,
          payloadRefId: createRecord.payloadRefId,
        },
        actorId,
        capabilities: ["series.edit"],
        currentSubjectRef: workspaceCommandSubject(current.revision),
        currentInputHash: workspaceCommandInputHash(current.revision),
        execute: async () => {
          writes += 1;
          return {};
        },
      }),
      (error) =>
        error instanceof ActionCommandPayloadError
        && error.code === "STALE_FENCING_TOKEN",
    );
    assert.equal(writes, 0);
  });
});

test("独立租约请求会等待正在执行的命令事务，不能借用其实例状态", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SqliteActionCommandPayloadStore(databasePath);
    const current = await loadSqliteWorkspace(databasePath);
    const payloadRef = await issue({
      store,
      action: "create_series",
      capability: "series.edit",
      revision: current.revision,
      idempotencyKey: "sqlite:lease-request-isolation",
    });
    const record = await store.findByPayloadRefId(payloadRef.payloadRefId);
    assert.ok(record);
    let markStarted!: () => void;
    let releaseCommand!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const command = executeActionCommandPayload({
      store,
      invocation: {
        actionId: record.actionId,
        payloadRefId: record.payloadRefId,
      },
      actorId,
      capabilities: ["series.edit"],
      currentSubjectRef: workspaceCommandSubject(current.revision),
      currentInputHash: workspaceCommandInputHash(current.revision),
      execute: async () => {
        markStarted();
        await released;
        return { ok: true };
      },
    });
    await started;
    let leaseSettled = false;
    const nextLease = store.acquireWorkspaceLease({
      workspaceId: record.leaseRef.workspaceId,
      action: "save_workspace",
      holderId: actorId,
    }).finally(() => {
      leaseSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(leaseSettled, false);
    releaseCommand();
    assert.equal((await command).replayed, false);
    const acquired = await nextLease;
    assert.equal(acquired.action, "save_workspace");
    assert.ok(
      BigInt(acquired.fencingToken) > BigInt(record.leaseRef.fencingToken),
    );
  });
});

test("SQLite 命令回调失败会同时回滚业务 revision 和执行结果", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SqliteActionCommandPayloadStore(databasePath);
    const initial = await loadSqliteWorkspace(databasePath);
    const payloadRef = await issue({
      store,
      action: "save_workspace",
      capability: "workspace.save",
      revision: initial.revision,
      idempotencyKey: "sqlite:rollback",
    });
    const record = await store.findByPayloadRefId(payloadRef.payloadRefId);
    assert.ok(record);
    const execute = (fail: boolean) => executeActionCommandPayload({
      store,
      invocation: {
        actionId: record.actionId,
        payloadRefId: record.payloadRefId,
      },
      actorId,
      capabilities: ["workspace.save" as const],
      currentSubjectRef: workspaceCommandSubject(initial.revision),
      currentInputHash: workspaceCommandInputHash(initial.revision),
      execute: async () => {
        const state = structuredClone(initial.state);
        state.notes = fail ? "must-rollback" : "retry-committed";
        await saveSqliteWorkspace(databasePath, {
          state,
          baseRevision: initial.revision,
          author: actorId,
          message: "事务回滚测试",
        });
        if (fail) throw new Error("simulated callback failure");
        return { ok: true };
      },
    });
    await assert.rejects(execute(true), /simulated callback failure/);
    assert.equal((await loadSqliteWorkspace(databasePath)).revision, initial.revision);
    const retry = await execute(false);
    assert.equal(retry.replayed, false);
    assert.equal(
      (await loadSqliteWorkspace(databasePath)).state.notes,
      "retry-committed",
    );
  });
});

test("命令事务期间的外部保存会排队，不能借用正在执行的租约事务", async () => {
  await withDatabase(async (databasePath) => {
    const store = new SqliteActionCommandPayloadStore(databasePath);
    const initial = await loadSqliteWorkspace(databasePath);
    const payloadRef = await issue({
      store,
      action: "save_workspace",
      capability: "workspace.save",
      revision: initial.revision,
      idempotencyKey: "sqlite:transaction-context-isolation",
    });
    const record = await store.findByPayloadRefId(payloadRef.payloadRefId);
    assert.ok(record);
    let markStarted!: () => void;
    let releaseCommand!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const command = executeActionCommandPayload({
      store,
      invocation: {
        actionId: record.actionId,
        payloadRefId: record.payloadRefId,
      },
      actorId,
      capabilities: ["workspace.save"],
      currentSubjectRef: workspaceCommandSubject(initial.revision),
      currentInputHash: workspaceCommandInputHash(initial.revision),
      execute: async () => {
        markStarted();
        await released;
        const state = structuredClone(initial.state);
        state.notes = "command-won";
        const saved = await saveSqliteWorkspace(databasePath, {
          state,
          baseRevision: initial.revision,
          author: actorId,
          message: "命令事务",
        });
        return { revision: saved.revision };
      },
    });
    await started;
    let externalSettled = false;
    const externalState = structuredClone(initial.state);
    externalState.notes = "must-not-join-command";
    const externalSave = saveSqliteWorkspace(databasePath, {
      state: externalState,
      baseRevision: initial.revision,
      author: "external-writer",
      message: "外部保存",
    }).finally(() => {
      externalSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(externalSettled, false);
    releaseCommand();
    assert.equal((await command).replayed, false);
    assert.equal((await externalSave).conflict, true);
    const final = await loadSqliteWorkspace(databasePath);
    assert.equal(final.state.notes, "command-won");
    assert.equal(final.revision, initial.revision + 1);
  });
});
