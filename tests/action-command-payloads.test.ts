import assert from "node:assert/strict";
import test from "node:test";
import {
  ActionCommandPayloadError,
  actionCommandHash,
  executeActionCommandPayload,
  InMemoryActionCommandPayloadStore,
  issueActionCommandPayload,
  LEGACY_ACTION_ALIAS_UNRESOLVABLE,
  migrateLegacyActionRecord,
  parseActionCommandInvocation,
  type ActionCommandPayloadRecord,
  type ActionCommandPayloadStore,
} from "../lib/action-command-payloads";
import {
  ACTION_CODES,
  actionAvailability,
  buildActionLink,
  buildActionAvailabilityMap,
  isStateChangingActionCode,
  requiredCapabilitiesForAction,
  type ActionCommandLeaseRef,
  type EntityRef,
} from "../lib/interaction-contracts";
import { createSeedState } from "../lib/seed";

const subjectRef: EntityRef = {
  workspaceId: "workspace:command-test",
  entityType: "adjustment_patch",
  entityId: "patch:1",
  revisionId: "7",
};
const inputHash = actionCommandHash({ patchId: "patch:1", revision: 7 });
const manifestHash = actionCommandHash({ catalog: "catalog:v1", revision: 3 });

function leaseFor(
  action: ActionCommandLeaseRef["action"],
  fencingToken = "41",
  workspaceId = subjectRef.workspaceId,
  leaseId = `lease:${action}:1`,
): ActionCommandLeaseRef {
  return { workspaceId, leaseId, action, fencingToken };
}

const createPatchLease = leaseFor("create_patch");

function createStore(
  currentLeases: Iterable<ActionCommandLeaseRef> = [createPatchLease],
) {
  return new InMemoryActionCommandPayloadStore(currentLeases);
}

function errorCode(code: ActionCommandPayloadError["code"]) {
  return (error: unknown) => error instanceof ActionCommandPayloadError && error.code === code;
}

async function issueCreatePatch(
  store: ActionCommandPayloadStore,
  overrides: Partial<Parameters<typeof issueActionCommandPayload>[0]> = {},
) {
  return issueActionCommandPayload({
    store,
    actionId: "issue-action:create-patch",
    action: "create_patch",
    subjectRef,
    expectedRevisionId: subjectRef.revisionId,
    inputHash,
    leaseRef: createPatchLease,
    idempotencyKey: "create-patch:1",
    payload: {
      patchId: "patch:1",
      operation: "add",
      parameterKey: "drag",
      operand: 1,
    },
    actorId: "feishu:tenant:user-1",
    capabilities: ["model.patch.create"],
    ...overrides,
  });
}

test("统一 ActionCode 注册表移除 open_rebase，并把现行 Rebase 写命令固定为 rebase_patch", () => {
  assert.equal((ACTION_CODES as readonly string[]).includes("open_rebase"), false);
  assert.equal(ACTION_CODES.includes("rebase_patch"), true);
  assert.equal(isStateChangingActionCode("rebase_patch"), true);
  assert.equal(isStateChangingActionCode("view_snapshot"), false);
  assert.deepEqual(
    buildActionAvailabilityMap(["patch.rebase"]).rebase_patch.requiredCapabilities,
    ["patch.rebase"],
  );
});

test("所有状态写都必须绑定完整租约身份，并在实际写入点从权威状态重验", async () => {
  for (const action of ACTION_CODES.filter(isStateChangingActionCode)) {
    await assert.rejects(
      issueActionCommandPayload({
        store: createStore(),
        actionId: `action:fencing-required:${action}`,
        action,
        subjectRef,
        expectedRevisionId: subjectRef.revisionId,
        inputHash,
        manifestHash,
        idempotencyKey: `fencing-required:${action}`,
        payload: {},
        actorId: "feishu:tenant:user-1",
        capabilities: requiredCapabilitiesForAction(action),
      }),
      errorCode("ACTION_COMMAND_LEASE_REQUIRED"),
      `${action} 不得绕过工作区租约`,
    );
  }
  await assert.rejects(
    issueCreatePatch(createStore(), {
      leaseRef: {
        ...createPatchLease,
        fencingToken: undefined as unknown as string,
      },
    }),
    errorCode("ACTION_COMMAND_FENCING_TOKEN_REQUIRED"),
  );
  await assert.rejects(
    issueCreatePatch(createStore(), {
      idempotencyKey: "create-patch:wrong-workspace-lease",
      leaseRef: {
        ...createPatchLease,
        workspaceId: "workspace:other",
      },
    }),
    errorCode("ACTION_COMMAND_PAYLOAD_INVALID"),
  );

  const store = createStore();
  const payloadRef = await issueCreatePatch(store);
  let writes = 0;
  store.setCurrentLease({
    ...createPatchLease,
    leaseId: "lease:create_patch:other",
  });
  await assert.rejects(
    executeActionCommandPayload({
      store,
      invocation: {
        actionId: "issue-action:create-patch",
        payloadRefId: payloadRef.payloadRefId,
      },
      actorId: "feishu:tenant:user-1",
      capabilities: ["model.patch.create"],
      currentSubjectRef: subjectRef,
      currentInputHash: inputHash,
      execute: async () => {
        writes += 1;
        return { resultingPatchRevision: 8 };
      },
    }),
    errorCode("STALE_FENCING_TOKEN"),
  );
  assert.equal(writes, 0);

  store.clearCurrentLease(createPatchLease);
  store.setCurrentLease({
    ...createPatchLease,
    workspaceId: "workspace:other",
  });
  await assert.rejects(
    executeActionCommandPayload({
      store,
      invocation: {
        actionId: "issue-action:create-patch",
        payloadRefId: payloadRef.payloadRefId,
      },
      actorId: "feishu:tenant:user-1",
      capabilities: ["model.patch.create"],
      currentSubjectRef: subjectRef,
      currentInputHash: inputHash,
      execute: async () => {
        writes += 1;
        return { resultingPatchRevision: 8 };
      },
    }),
    errorCode("STALE_FENCING_TOKEN"),
  );
  assert.equal(writes, 0);

  store.setCurrentLease(createPatchLease);
  assert.deepEqual(
    await executeActionCommandPayload({
      store,
      invocation: {
        actionId: "issue-action:create-patch",
        payloadRefId: payloadRef.payloadRefId,
      },
      actorId: "feishu:tenant:user-1",
      capabilities: ["model.patch.create"],
      currentSubjectRef: subjectRef,
      currentInputHash: inputHash,
      execute: async () => {
        writes += 1;
        return { resultingPatchRevision: 8 };
      },
    }),
    {
      result: { resultingPatchRevision: 8 },
      replayed: false,
    },
  );
  assert.equal(writes, 1);
});

test("租约变更不能插入权威校验与实际状态写之间", async () => {
  const store = createStore();
  const payloadRef = await issueCreatePatch(store, {
    idempotencyKey: "create-patch:atomic-lease-check",
  });
  let markStarted!: () => void;
  let releaseWrite!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let writes = 0;
  const execution = executeActionCommandPayload({
    store,
    invocation: {
      actionId: "issue-action:create-patch",
      payloadRefId: payloadRef.payloadRefId,
    },
    actorId: "feishu:tenant:user-1",
    capabilities: ["model.patch.create"],
    currentSubjectRef: subjectRef,
    currentInputHash: inputHash,
    execute: async () => {
      markStarted();
      await released;
      writes += 1;
      return { resultingPatchRevision: 8 };
    },
  });
  await started;
  assert.throws(
    () => store.setCurrentLease({
      ...createPatchLease,
      leaseId: "lease:create_patch:rotated",
    }),
    /状态写事务锁定/,
  );
  releaseWrite();
  assert.equal((await execution).replayed, false);
  assert.equal(writes, 1);
  assert.doesNotThrow(() => store.setCurrentLease({
    ...createPatchLease,
    leaseId: "lease:create_patch:rotated",
  }));
});

test("同一工作区切换动作会废止旧动作租约，且不同动作不能并发进入写窗口", async () => {
  const store = createStore();
  const createPatchRef = await issueCreatePatch(store, {
    idempotencyKey: "create-patch:cross-action-lease",
  });
  const saveWorkspaceLease = leaseFor(
    "save_workspace",
    "42",
    subjectRef.workspaceId,
    "lease:save_workspace:new",
  );

  store.setCurrentLease(saveWorkspaceLease);
  await assert.rejects(
    executeActionCommandPayload({
      store,
      invocation: {
        actionId: "issue-action:create-patch",
        payloadRefId: createPatchRef.payloadRefId,
      },
      actorId: "feishu:tenant:user-1",
      capabilities: ["model.patch.create"],
      currentSubjectRef: subjectRef,
      currentInputHash: inputHash,
      execute: async () => ({ impossible: true }),
    }),
    errorCode("STALE_FENCING_TOKEN"),
  );

  store.setCurrentLease(createPatchLease);
  let releaseWrite!: () => void;
  let markStarted!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const execution = executeActionCommandPayload({
    store,
    invocation: {
      actionId: "issue-action:create-patch",
      payloadRefId: createPatchRef.payloadRefId,
    },
    actorId: "feishu:tenant:user-1",
    capabilities: ["model.patch.create"],
    currentSubjectRef: subjectRef,
    currentInputHash: inputHash,
    execute: async () => {
      markStarted();
      await released;
      return { resultingPatchRevision: 8 };
    },
  });
  await started;
  assert.throws(
    () => store.setCurrentLease(saveWorkspaceLease),
    /状态写事务锁定/,
  );
  releaseWrite();
  assert.equal((await execution).replayed, false);
  assert.doesNotThrow(() => store.setCurrentLease(saveWorkspaceLease));
});

test("状态写 ActionLink 必须携带匹配的服务端命令载荷；禁用动作与导航不得携带载荷", async () => {
  const store = createStore();
  const payloadRef = await issueCreatePatch(store);
  assert.throws(
    () => buildActionLink({
      actionId: "action:missing-payload",
      action: "create_patch",
      label: "创建 Patch",
      targetRef: subjectRef,
      availability: actionAvailability("create_patch", ["model.patch.create"]),
    }),
    /ACTION_COMMAND_PAYLOAD_REQUIRED/,
  );
  const enabled = buildActionLink({
    actionId: "issue-action:create-patch",
    action: "create_patch",
    label: "创建 Patch",
    targetRef: subjectRef,
    availability: actionAvailability("create_patch", ["model.patch.create"]),
    commandPayloadRef: payloadRef,
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.commandPayloadRef?.payloadRefId, payloadRef.payloadRefId);
  assert.deepEqual(enabled.commandPayloadRef?.leaseRef, createPatchLease);

  assert.throws(
    () => buildActionLink({
      actionId: "action:disabled",
      action: "create_patch",
      label: "创建 Patch",
      targetRef: subjectRef,
      availability: actionAvailability("create_patch", []),
      commandPayloadRef: payloadRef,
    }),
    /禁用动作不得携带命令载荷/,
  );
  assert.throws(
    () => buildActionLink({
      actionId: "action:navigate",
      action: "navigate",
      label: "打开",
      targetRoute: "/patches/1",
      commandPayloadRef: payloadRef,
    }),
    /只读展示动作不得携带命令载荷/,
  );
});

test("客户端只能提交 actionId + payloadRefId，不能补传或替换 subject/revision/hash/payload", () => {
  assert.deepEqual(
    parseActionCommandInvocation({ actionId: "action:1", payloadRefId: "payload:1" }),
    { actionId: "action:1", payloadRefId: "payload:1" },
  );
  assert.throws(
    () => parseActionCommandInvocation({
      actionId: "action:1",
      payloadRefId: "payload:1",
      action: "publish",
    }),
    errorCode("ACTION_COMMAND_PAYLOAD_REQUIRED"),
  );
  assert.throws(
    () => parseActionCommandInvocation({ actionId: "action:1" }),
    errorCode("ACTION_COMMAND_PAYLOAD_REQUIRED"),
  );
});

test("执行入口自身拒绝夹带载荷，不能依赖调用方预先解析", async () => {
  const store = createStore();
  const payloadRef = await issueCreatePatch(store);
  await assert.rejects(
    executeActionCommandPayload({
      store,
      invocation: {
        actionId: "issue-action:create-patch",
        payloadRefId: payloadRef.payloadRefId,
        payload: { operand: 999 },
      },
      actorId: "feishu:tenant:user-1",
      capabilities: ["model.patch.create"],
      currentSubjectRef: subjectRef,
      currentInputHash: inputHash,
      execute: async () => ({ impossible: true }),
    }),
    errorCode("ACTION_COMMAND_PAYLOAD_REQUIRED"),
  );
});

test("执行时重新鉴权并重验 subject、revision 与 input hash", async () => {
  const store = createStore();
  const payloadRef = await issueCreatePatch(store);
  const invocation = {
    actionId: "issue-action:create-patch",
    payloadRefId: payloadRef.payloadRefId,
  };
  const execute = () => executeActionCommandPayload({
    store,
    invocation,
    actorId: "feishu:tenant:user-1",
    capabilities: ["model.patch.create"] as const,
    currentSubjectRef: subjectRef,
    currentInputHash: inputHash,
    execute: async (record) => ({
      patchId: record.subjectRef.entityId,
      appliedInputHash: record.inputHash,
    }),
  });
  await assert.rejects(
    executeActionCommandPayload({
      store,
      invocation,
      actorId: "feishu:tenant:user-1",
      capabilities: [],
      currentSubjectRef: subjectRef,
      currentInputHash: inputHash,
      execute: async () => ({ impossible: true }),
    }),
    errorCode("ACTION_COMMAND_CAPABILITY_CHANGED"),
  );
  await assert.rejects(
    executeActionCommandPayload({
      store,
      invocation,
      actorId: "feishu:tenant:user-1",
      capabilities: ["model.patch.create"],
      currentSubjectRef: { ...subjectRef, revisionId: "8" },
      currentInputHash: inputHash,
      execute: async () => ({ impossible: true }),
    }),
    errorCode("ACTION_COMMAND_REVISION_CONFLICT"),
  );
  await assert.rejects(
    executeActionCommandPayload({
      store,
      invocation,
      actorId: "feishu:tenant:user-1",
      capabilities: ["model.patch.create"],
      currentSubjectRef: subjectRef,
      currentInputHash: actionCommandHash({ changed: true }),
      execute: async () => ({ impossible: true }),
    }),
    errorCode("ACTION_COMMAND_INPUT_HASH_MISMATCH"),
  );
  await assert.rejects(
    executeActionCommandPayload({
      store,
      invocation,
      actorId: "feishu:tenant:user-2",
      capabilities: ["model.patch.create"],
      currentSubjectRef: subjectRef,
      currentInputHash: inputHash,
      execute: async () => ({ impossible: true }),
    }),
    errorCode("ACTION_COMMAND_ACTOR_MISMATCH"),
  );
  assert.deepEqual(await execute(), {
    result: { patchId: "patch:1", appliedInputHash: inputHash },
    replayed: false,
  });
});

test("响应丢失后使用同一引用重试只恢复原结果，不重复执行状态写", async () => {
  const store = createStore();
  const payloadRef = await issueCreatePatch(store);
  let executions = 0;
  const execute = () => executeActionCommandPayload({
    store,
    invocation: {
      actionId: "issue-action:create-patch",
      payloadRefId: payloadRef.payloadRefId,
    },
    actorId: "feishu:tenant:user-1",
    capabilities: ["model.patch.create"],
    currentSubjectRef: subjectRef,
    currentInputHash: inputHash,
    execute: async () => {
      executions += 1;
      return { resultingPatchRevision: 8 };
    },
  });
  const [first, concurrentRetry] = await Promise.all([execute(), execute()]);
  assert.equal(executions, 1);
  assert.equal(first.result.resultingPatchRevision, 8);
  assert.equal(concurrentRetry.result.resultingPatchRevision, 8);
  assert.equal([first.replayed, concurrentRetry.replayed].filter(Boolean).length, 1);
  assert.deepEqual(await executeActionCommandPayload({
    store,
    invocation: {
      actionId: "issue-action:create-patch",
      payloadRefId: payloadRef.payloadRefId,
    },
    actorId: "feishu:tenant:user-1",
    capabilities: [],
    currentSubjectRef: { ...subjectRef, revisionId: "8" },
    currentInputHash: actionCommandHash({ changedAfterCommit: true }),
    execute: async () => {
      executions += 1;
      return { resultingPatchRevision: 999 };
    },
  }), {
    result: { resultingPatchRevision: 8 },
    replayed: true,
  });
  assert.equal(executions, 1);
});

test("并发相同幂等键签发只返回已落库的规范 payloadRef", async () => {
  const store = createStore();
  const [first, second] = await Promise.all([
    issueCreatePatch(store),
    issueCreatePatch(store),
  ]);
  assert.equal(first.payloadRefId, second.payloadRefId);
  assert.deepEqual(
    await store.findByPayloadRefId(first.payloadRefId),
    await store.findByPayloadRefId(second.payloadRefId),
  );
});

test("服务端存储载荷遭改写时 payloadHash 校验 fail-closed", async () => {
  const baseStore = createStore();
  const payloadRef = await issueCreatePatch(baseStore);
  const record = await baseStore.findByPayloadRefId(payloadRef.payloadRefId);
  assert.ok(record);
  const tamperedRecord: ActionCommandPayloadRecord = {
    ...record,
    payload: { ...record.payload, operand: 999 },
  };
  const tamperedStore: ActionCommandPayloadStore = {
    findByPayloadRefId: async () => structuredClone(tamperedRecord),
    findIssuedByIdempotencyKey: (input) => baseStore.findIssuedByIdempotencyKey(input),
    saveIssued: (value) => baseStore.saveIssued(value),
    executeOnce: (input) => baseStore.executeOnce(input),
  };
  await assert.rejects(
    executeActionCommandPayload({
      store: tamperedStore,
      invocation: {
        actionId: "issue-action:create-patch",
        payloadRefId: payloadRef.payloadRefId,
      },
      actorId: "feishu:tenant:user-1",
      capabilities: ["model.patch.create"],
      currentSubjectRef: subjectRef,
      currentInputHash: inputHash,
      execute: async () => ({ impossible: true }),
    }),
    errorCode("ACTION_COMMAND_PAYLOAD_TAMPERED"),
  );
});

test("租约身份纳入 commandHash，改写 leaseId 不能执行状态写", async () => {
  const baseStore = createStore();
  const payloadRef = await issueCreatePatch(baseStore, {
    idempotencyKey: "create-patch:tampered-lease",
  });
  const record = await baseStore.findByPayloadRefId(payloadRef.payloadRefId);
  assert.ok(record);
  const tamperedRecord: ActionCommandPayloadRecord = {
    ...record,
    leaseRef: {
      ...record.leaseRef,
      leaseId: "lease:create_patch:tampered",
    },
  };
  const tamperedStore: ActionCommandPayloadStore = {
    findByPayloadRefId: async () => structuredClone(tamperedRecord),
    findIssuedByIdempotencyKey: (input) => baseStore.findIssuedByIdempotencyKey(input),
    saveIssued: (value) => baseStore.saveIssued(value),
    executeOnce: (input) => baseStore.executeOnce(input),
  };
  let writes = 0;
  await assert.rejects(
    executeActionCommandPayload({
      store: tamperedStore,
      invocation: {
        actionId: tamperedRecord.actionId,
        payloadRefId: tamperedRecord.payloadRefId,
      },
      actorId: tamperedRecord.issuedForActorId,
      capabilities: ["model.patch.create"],
      currentSubjectRef: subjectRef,
      currentInputHash: inputHash,
      execute: async () => {
        writes += 1;
        return { impossible: true };
      },
    }),
    errorCode("ACTION_COMMAND_PAYLOAD_TAMPERED"),
  );
  assert.equal(writes, 0);
});

test("payloadHash 绑定 payloadRefId 与 schemaVersion，复制记录不能获得第二次执行身份", async () => {
  const baseStore = createStore();
  const payloadRef = await issueCreatePatch(baseStore);
  let executions = 0;
  const execute = (store: ActionCommandPayloadStore, payloadRefId: string) =>
    executeActionCommandPayload({
      store,
      invocation: {
        actionId: "issue-action:create-patch",
        payloadRefId,
      },
      actorId: "feishu:tenant:user-1",
      capabilities: ["model.patch.create"],
      currentSubjectRef: subjectRef,
      currentInputHash: inputHash,
      execute: async () => {
        executions += 1;
        return { resultingPatchRevision: 8 };
      },
    });
  assert.equal((await execute(baseStore, payloadRef.payloadRefId)).replayed, false);

  const record = await baseStore.findByPayloadRefId(payloadRef.payloadRefId);
  assert.ok(record);
  const copiedRefId = "copied-but-never-issued";
  const copiedRecord = { ...record, payloadRefId: copiedRefId };
  const copiedStore: ActionCommandPayloadStore = {
    findByPayloadRefId: async (payloadRefId) =>
      payloadRefId === copiedRefId ? structuredClone(copiedRecord) : undefined,
    findIssuedByIdempotencyKey: (input) => baseStore.findIssuedByIdempotencyKey(input),
    saveIssued: (value) => baseStore.saveIssued(value),
    executeOnce: (input) => baseStore.executeOnce(input),
  };
  await assert.rejects(
    execute(copiedStore, copiedRefId),
    errorCode("ACTION_COMMAND_PAYLOAD_TAMPERED"),
  );
  assert.equal(executions, 1);

  const copiedWithRecomputedHash: ActionCommandPayloadRecord = {
    ...copiedRecord,
    payloadHash: actionCommandHash({
      schemaVersion: copiedRecord.schemaVersion,
      payloadRefId: copiedRefId,
      commandHash: copiedRecord.commandHash,
      issuedAt: copiedRecord.issuedAt,
    }),
  };
  const duplicateIdentityStore: ActionCommandPayloadStore = {
    ...copiedStore,
    findByPayloadRefId: async () => structuredClone(copiedWithRecomputedHash),
  };
  assert.deepEqual(await execute(duplicateIdentityStore, copiedRefId), {
    result: { resultingPatchRevision: 8 },
    replayed: true,
  });
  assert.equal(executions, 1);

  const wrongSchemaRecord = {
    ...record,
    schemaVersion: "action-command-payload/unknown",
  } as unknown as ActionCommandPayloadRecord;
  const wrongSchemaStore: ActionCommandPayloadStore = {
    ...copiedStore,
    findByPayloadRefId: async () => structuredClone(wrongSchemaRecord),
  };
  await assert.rejects(
    execute(wrongSchemaStore, payloadRef.payloadRefId),
    errorCode("ACTION_COMMAND_PAYLOAD_TAMPERED"),
  );
  assert.equal(executions, 1);
});

test("Manifest 与完整工作区租约在签发和执行时都被绑定、重验", async () => {
  const reserveLease = leaseFor("reserve_config_id_bundle");
  const store = createStore([reserveLease]);
  await assert.rejects(
    issueActionCommandPayload({
      store,
      actionId: "action:reserve",
      action: "reserve_config_id_bundle",
      subjectRef: { ...subjectRef, entityType: "model" },
      expectedRevisionId: subjectRef.revisionId,
      inputHash,
      manifestHash,
      leaseRef: {
        ...reserveLease,
        fencingToken: undefined as unknown as string,
      },
      idempotencyKey: "reserve:missing-token",
      payload: { modelId: "model:1" },
      actorId: "feishu:tenant:user-1",
      capabilities: ["config.id.reserve"],
    }),
    errorCode("ACTION_COMMAND_FENCING_TOKEN_REQUIRED"),
  );
  const reserveSubject = { ...subjectRef, entityType: "model" as const };
  const payloadRef = await issueActionCommandPayload({
    store,
    actionId: "action:reserve",
    action: "reserve_config_id_bundle",
    subjectRef: reserveSubject,
    expectedRevisionId: reserveSubject.revisionId,
    inputHash,
    manifestHash,
    leaseRef: reserveLease,
    idempotencyKey: "reserve:1",
    payload: { modelId: "model:1", policyVersionId: "policy:v1" },
    actorId: "feishu:tenant:user-1",
    capabilities: ["config.id.reserve"],
  });
  store.setCurrentLease({
    ...reserveLease,
    leaseId: "lease:reserve_config_id_bundle:other",
  });
  await assert.rejects(
    executeActionCommandPayload({
      store,
      invocation: { actionId: "action:reserve", payloadRefId: payloadRef.payloadRefId },
      actorId: "feishu:tenant:user-1",
      capabilities: ["config.id.reserve"],
      currentSubjectRef: reserveSubject,
      currentInputHash: inputHash,
      currentManifestHash: manifestHash,
      execute: async () => ({ impossible: true }),
    }),
    errorCode("STALE_FENCING_TOKEN"),
  );
  store.setCurrentLease(reserveLease);
  await assert.rejects(
    executeActionCommandPayload({
      store,
      invocation: { actionId: "action:reserve", payloadRefId: payloadRef.payloadRefId },
      actorId: "feishu:tenant:user-1",
      capabilities: ["config.id.reserve"],
      currentSubjectRef: reserveSubject,
      currentInputHash: inputHash,
      currentManifestHash: actionCommandHash({ stale: true }),
      execute: async () => ({ impossible: true }),
    }),
    errorCode("ACTION_COMMAND_MANIFEST_HASH_MISMATCH"),
  );
});

test("过期载荷与幂等键复用不同输入均被拒绝", async () => {
  const store = createStore();
  const now = new Date("2026-07-23T00:00:00Z");
  const payloadRef = await issueCreatePatch(store, {
    now,
    expiresAt: "2026-07-23T00:01:00Z",
  });
  await assert.rejects(
    executeActionCommandPayload({
      store,
      invocation: {
        actionId: "issue-action:create-patch",
        payloadRefId: payloadRef.payloadRefId,
      },
      actorId: "feishu:tenant:user-1",
      capabilities: ["model.patch.create"],
      currentSubjectRef: subjectRef,
      currentInputHash: inputHash,
      now: new Date("2026-07-23T00:01:00Z"),
      execute: async () => ({ impossible: true }),
    }),
    errorCode("ACTION_COMMAND_PAYLOAD_EXPIRED"),
  );
  await assert.rejects(
    issueCreatePatch(store, {
      now,
      payload: { changed: true },
    }),
    errorCode("IDEMPOTENCY_KEY_REUSED"),
  );
});

test("非法 expiresAt 在签发和执行边界都 fail-closed", async () => {
  const store = createStore();
  await assert.rejects(
    issueCreatePatch(store, {
      expiresAt: "not-a-date",
    }),
    errorCode("ACTION_COMMAND_PAYLOAD_INVALID"),
  );

  const validRef = await issueCreatePatch(store, {
    idempotencyKey: "create-patch:invalid-stored-expiry",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  const validRecord = await store.findByPayloadRefId(validRef.payloadRefId);
  assert.ok(validRecord);
  const expiresAt = "still-not-a-date";
  const commandHash = actionCommandHash({
    schemaVersion: validRecord.schemaVersion,
    actionId: validRecord.actionId,
    action: validRecord.action,
    subjectRef: validRecord.subjectRef,
    expectedRevisionId: validRecord.expectedRevisionId,
    inputHash: validRecord.inputHash,
    manifestHash: validRecord.manifestHash ?? null,
    leaseRef: validRecord.leaseRef,
    idempotencyKey: validRecord.idempotencyKey,
    payload: validRecord.payload,
    issuedForActorId: validRecord.issuedForActorId,
    expiresAt,
  });
  const invalidStoredRecord: ActionCommandPayloadRecord = {
    ...validRecord,
    expiresAt,
    commandHash,
    payloadHash: actionCommandHash({
      schemaVersion: validRecord.schemaVersion,
      payloadRefId: validRecord.payloadRefId,
      commandHash,
      issuedAt: validRecord.issuedAt,
    }),
  };
  let executeOnceCalls = 0;
  const invalidStoredRecordStore: ActionCommandPayloadStore = {
    findByPayloadRefId: async () => structuredClone(invalidStoredRecord),
    findIssuedByIdempotencyKey: (input) => store.findIssuedByIdempotencyKey(input),
    saveIssued: (record) => store.saveIssued(record),
    executeOnce: (input) => {
      executeOnceCalls += 1;
      return store.executeOnce(input);
    },
  };
  let writes = 0;
  await assert.rejects(
    executeActionCommandPayload({
      store: invalidStoredRecordStore,
      invocation: {
        actionId: invalidStoredRecord.actionId,
        payloadRefId: invalidStoredRecord.payloadRefId,
      },
      actorId: invalidStoredRecord.issuedForActorId,
      capabilities: ["model.patch.create"],
      currentSubjectRef: subjectRef,
      currentInputHash: inputHash,
      now: new Date("2029-01-01T00:00:00.000Z"),
      execute: async () => {
        writes += 1;
        return { impossible: true };
      },
    }),
    errorCode("ACTION_COMMAND_PAYLOAD_INVALID"),
  );
  assert.equal(executeOnceCalls, 0);
  assert.equal(writes, 0);
});

test("旧状态写别名只有可信历史可完整重建时迁移，否则统一禁用", async () => {
  const store = createStore();
  const complete = await migrateLegacyActionRecord({
    record: {
      actionId: "legacy:approve-waiver",
      action: "approve_waiver",
      label: "批准保留意见",
      evidence: {
        source: "server_command_record",
        executionKind: "state_write",
        subjectRef,
        expectedRevisionId: subjectRef.revisionId,
        inputHash,
        leaseRef: leaseFor("approve_validation_waiver"),
        idempotencyKey: "legacy-waiver:1",
        payload: {
          issueFingerprint: "fingerprint:1",
          expectedIssueRevisionId: "7",
          reason: "已核对边界",
          gate: "PUBLISH",
        },
      },
    },
    store,
    actorId: "feishu:tenant:user-1",
    capabilities: ["validation.waiver.approve"],
  });
  assert.equal(complete.status, "MIGRATED");
  if (complete.status === "MIGRATED") {
    assert.equal(complete.targetAction, "approve_validation_waiver");
    assert.equal(complete.actionLink.commandPayloadRef?.action, "approve_validation_waiver");
  }

  const missingLeaseIdentity = await migrateLegacyActionRecord({
    record: {
      actionId: "legacy:approve-waiver-missing-lease",
      action: "approve_waiver",
      label: "批准保留意见",
      evidence: {
        source: "server_command_record",
        executionKind: "state_write",
        subjectRef,
        expectedRevisionId: subjectRef.revisionId,
        inputHash,
        idempotencyKey: "legacy-waiver:missing-lease",
        payload: {
          issueFingerprint: "fingerprint:missing-lease",
          expectedIssueRevisionId: "7",
          reason: "旧记录缺少完整租约身份",
          gate: "PUBLISH",
        },
      },
    },
    store,
    actorId: "feishu:tenant:user-1",
    capabilities: ["validation.waiver.approve"],
  });
  assert.deepEqual(missingLeaseIdentity, {
    status: "UNRESOLVABLE",
    code: LEGACY_ACTION_ALIAS_UNRESOLVABLE,
    actionId: "legacy:approve-waiver-missing-lease",
    legacyAction: "approve_waiver",
    enabled: false,
  });

  const permissionChanged = await migrateLegacyActionRecord({
    record: {
      actionId: "legacy:approve-waiver-disabled",
      action: "approve_waiver",
      label: "批准保留意见",
      evidence: {
        source: "server_command_record",
        executionKind: "state_write",
        subjectRef,
        expectedRevisionId: subjectRef.revisionId,
        inputHash,
        leaseRef: leaseFor("approve_validation_waiver"),
        idempotencyKey: "legacy-waiver:disabled",
        payload: {
          issueFingerprint: "fingerprint:2",
          expectedIssueRevisionId: "7",
          reason: "历史载荷完整，但当前权限已变化",
          gate: "PUBLISH",
        },
      },
    },
    store,
    actorId: "feishu:tenant:user-1",
    capabilities: [],
  });
  assert.equal(permissionChanged.status, "MIGRATED");
  if (permissionChanged.status === "MIGRATED") {
    assert.equal(permissionChanged.actionLink.enabled, false);
    assert.equal(permissionChanged.actionLink.disabledReasonCode, "CAPABILITY_MISSING");
    assert.equal(permissionChanged.actionLink.commandPayloadRef, undefined);
  }

  const missingReason = await migrateLegacyActionRecord({
    record: {
      actionId: "legacy:incomplete",
      action: "approve_waiver",
      label: "批准保留意见",
      evidence: {
        source: "server_domain_event",
        executionKind: "state_write",
        subjectRef,
        expectedRevisionId: subjectRef.revisionId,
        inputHash,
        idempotencyKey: "legacy-waiver:2",
        payload: {
          issueFingerprint: "fingerprint:1",
          expectedIssueRevisionId: "7",
          gate: "PUBLISH",
        },
      },
    },
    store,
    actorId: "feishu:tenant:user-1",
    capabilities: ["validation.waiver.approve"],
  });
  assert.deepEqual(missingReason, {
    status: "UNRESOLVABLE",
    code: LEGACY_ACTION_ALIAS_UNRESOLVABLE,
    actionId: "legacy:incomplete",
    legacyAction: "approve_waiver",
    enabled: false,
  });

  const conflictingPublishScope = await migrateLegacyActionRecord({
    record: {
      actionId: "legacy:conflicting-scope",
      action: "request_waiver",
      label: "申请保留意见",
      evidence: {
        source: "server_domain_event",
        executionKind: "state_write",
        subjectRef,
        expectedRevisionId: subjectRef.revisionId,
        inputHash,
        idempotencyKey: "legacy-waiver:conflicting-scope",
        payload: {
          issueFingerprint: "fingerprint:3",
          expectedIssueRevisionId: "7",
          reason: "PUBLISH 不得夹带导出目标",
          gate: "PUBLISH",
          environmentId: "production",
          channelKey: "game",
        },
      },
    },
    store,
    actorId: "feishu:tenant:user-1",
    capabilities: ["validation.waiver.request"],
  });
  assert.equal(conflictingPublishScope.status, "UNRESOLVABLE");
  assert.equal(conflictingPublishScope.code, LEGACY_ACTION_ALIAS_UNRESOLVABLE);

  const unknown = await migrateLegacyActionRecord({
    record: {
      actionId: "legacy:unknown",
      action: "possibly_writes_state",
      label: "未知旧动作",
    },
    store,
    actorId: "feishu:tenant:user-1",
    capabilities: [],
  });
  assert.equal(unknown.status, "UNRESOLVABLE");
  assert.equal(unknown.code, LEGACY_ACTION_ALIAS_UNRESOLVABLE);

  const untypedRetry = await migrateLegacyActionRecord({
    record: {
      actionId: "legacy:retry-config-export",
      action: "retry",
      label: "重试正式导出",
      evidence: {
        source: "server_command_record",
        executionKind: "state_write",
        originalAction: "commit_config_export",
        subjectRef,
        expectedRevisionId: subjectRef.revisionId,
        inputHash,
        manifestHash,
        leaseRef: leaseFor("commit_config_export", "42"),
        idempotencyKey: "legacy:retry-config-export",
        payload: {},
      },
    },
    store,
    actorId: "feishu:tenant:user-1",
    capabilities: ["config.export.commit"],
  });
  assert.deepEqual(untypedRetry, {
    status: "UNRESOLVABLE",
    code: LEGACY_ACTION_ALIAS_UNRESOLVABLE,
    actionId: "legacy:retry-config-export",
    legacyAction: "retry",
    enabled: false,
  });

  const incompleteRuleTarget = await migrateLegacyActionRecord({
    record: {
      actionId: "legacy:rule-source-empty-target",
      action: "create_rule_source_change",
      label: "创建规则源变更草稿",
      evidence: {
        source: "server_command_record",
        executionKind: "state_write",
        subjectRef,
        expectedRevisionId: subjectRef.revisionId,
        inputHash,
        leaseRef: leaseFor("create_rule_source_change_draft", "42"),
        idempotencyKey: "legacy:rule-source-empty-target",
        payload: {
          targetRuleRef: {},
          sourceRevision: "revision:3259",
          evidenceHash: actionCommandHash({ source: "legacy:rule-source-empty-target" }),
        },
      },
    },
    store,
    actorId: "feishu:tenant:user-1",
    capabilities: ["rules.source_change_draft.create"],
  });
  assert.deepEqual(incompleteRuleTarget, {
    status: "UNRESOLVABLE",
    code: LEGACY_ACTION_ALIAS_UNRESOLVABLE,
    actionId: "legacy:rule-source-empty-target",
    legacyAction: "create_rule_source_change",
    enabled: false,
  });

  const completeRuleTarget = await migrateLegacyActionRecord({
    record: {
      actionId: "legacy:rule-source-complete-target",
      action: "create_rule_source_change",
      label: "创建规则源变更草稿",
      evidence: {
        source: "server_command_record",
        executionKind: "state_write",
        subjectRef,
        expectedRevisionId: subjectRef.revisionId,
        inputHash,
        leaseRef: leaseFor("create_rule_source_change_draft", "42"),
        idempotencyKey: "legacy:rule-source-complete-target",
        payload: {
          targetRuleRef: {
            spreadsheetToken: "spreadsheet:rules",
            sheetId: "sheet:rules",
            stableRuleId: "rule:drag",
            parameterKey: "drag",
            sourceRevision: "revision:3259",
          },
          sourceRevision: "revision:3259",
          evidenceHash: actionCommandHash({ source: "legacy:rule-source-complete-target" }),
        },
      },
    },
    store,
    actorId: "feishu:tenant:user-1",
    capabilities: ["rules.source_change_draft.create"],
  });
  assert.equal(completeRuleTarget.status, "MIGRATED");
  if (completeRuleTarget.status === "MIGRATED") {
    assert.equal(completeRuleTarget.targetAction, "create_rule_source_change_draft");
    assert.deepEqual(
      completeRuleTarget.actionLink.commandPayloadRef?.leaseRef,
      leaseFor("create_rule_source_change_draft", "42"),
    );
  }
});

test("旧动作迁移不会把持久化故障伪装成历史不可解析", async () => {
  const store = createStore();
  const unavailableStore: ActionCommandPayloadStore = {
    findByPayloadRefId: (payloadRefId) => store.findByPayloadRefId(payloadRefId),
    findIssuedByIdempotencyKey: (input) => store.findIssuedByIdempotencyKey(input),
    saveIssued: async () => {
      throw new Error("database unavailable");
    },
    executeOnce: (input) => store.executeOnce(input),
  };
  await assert.rejects(
    migrateLegacyActionRecord({
      record: {
        actionId: "legacy:persistence-failure",
        action: "acknowledge_warning",
        label: "确认告警",
        evidence: {
          source: "server_domain_event",
          executionKind: "state_write",
          subjectRef,
          expectedRevisionId: subjectRef.revisionId,
          inputHash,
          leaseRef: leaseFor("acknowledge_validation_warning"),
          idempotencyKey: "legacy:persistence-failure",
          payload: {
            issueFingerprint: "fingerprint:persistence-failure",
            expectedIssueRevisionId: "7",
            reason: "完整可信记录",
          },
        },
      },
      store: unavailableStore,
      actorId: "feishu:tenant:user-1",
      capabilities: ["validation.warning.acknowledge"],
    }),
    /database unavailable/,
  );
});

test("open_rebase 只有可信纯路由证据时迁移为 navigate，永不转换成 rebase_patch", async () => {
  const store = createStore();
  const navigation = await migrateLegacyActionRecord({
    record: {
      actionId: "legacy:open-rebase",
      action: "open_rebase",
      label: "打开 Rebase",
      evidence: {
        source: "versioned_entity",
        executionKind: "presentation_only",
        targetRoute: "/patches/patch:1/rebase",
      },
    },
    store,
    actorId: "feishu:tenant:user-1",
    capabilities: ["patch.rebase"],
  });
  assert.equal(navigation.status, "MIGRATED");
  if (navigation.status === "MIGRATED") {
    assert.equal(navigation.targetAction, "navigate");
    assert.equal(navigation.actionLink.action, "navigate");
    assert.equal(navigation.actionLink.commandPayloadRef, undefined);
  }

  const ambiguous = await migrateLegacyActionRecord({
    record: {
      actionId: "legacy:ambiguous-rebase",
      action: "open_rebase",
      label: "Rebase",
      evidence: {
        source: "server_command_record",
        executionKind: "state_write",
        targetRoute: "/patches/patch:1/rebase",
      },
    },
    store,
    actorId: "feishu:tenant:user-1",
    capabilities: ["patch.rebase"],
  });
  assert.equal(ambiguous.status, "UNRESOLVABLE");
  assert.equal(ambiguous.code, LEGACY_ACTION_ALIAS_UNRESOLVABLE);
});

test("动作签发、迁移和失败恢复不改写历史 ConfigurationSnapshot", async () => {
  const state = createSeedState();
  const frozenBefore = structuredClone(state.configurationSnapshots);
  const store = createStore();
  await issueCreatePatch(store);
  await migrateLegacyActionRecord({
    record: {
      actionId: "legacy:open-rebase",
      action: "open_rebase",
      label: "打开 Rebase",
      evidence: {
        source: "versioned_entity",
        executionKind: "presentation_only",
        targetRoute: "/patches/patch:1/rebase",
      },
    },
    store,
    actorId: "feishu:tenant:user-1",
    capabilities: [],
  });
  assert.deepEqual(state.configurationSnapshots, frozenBefore);
});
