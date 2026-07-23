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

test("状态写 ActionLink 必须携带匹配的服务端命令载荷；禁用动作与导航不得携带载荷", async () => {
  const store = new InMemoryActionCommandPayloadStore();
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
  const store = new InMemoryActionCommandPayloadStore();
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
  const store = new InMemoryActionCommandPayloadStore();
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
  const store = new InMemoryActionCommandPayloadStore();
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

test("服务端存储载荷遭改写时 payloadHash 校验 fail-closed", async () => {
  const baseStore = new InMemoryActionCommandPayloadStore();
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

test("Manifest 与必要 fencing token 在签发和执行时都被绑定、重验", async () => {
  const store = new InMemoryActionCommandPayloadStore();
  await assert.rejects(
    issueActionCommandPayload({
      store,
      actionId: "action:reserve",
      action: "reserve_config_id_bundle",
      subjectRef: { ...subjectRef, entityType: "model" },
      expectedRevisionId: subjectRef.revisionId,
      inputHash,
      manifestHash,
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
    fencingToken: "41",
    idempotencyKey: "reserve:1",
    payload: { modelId: "model:1", policyVersionId: "policy:v1" },
    actorId: "feishu:tenant:user-1",
    capabilities: ["config.id.reserve"],
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
      currentFencingToken: "42",
      execute: async () => ({ impossible: true }),
    }),
    errorCode("STALE_FENCING_TOKEN"),
  );
  await assert.rejects(
    executeActionCommandPayload({
      store,
      invocation: { actionId: "action:reserve", payloadRefId: payloadRef.payloadRefId },
      actorId: "feishu:tenant:user-1",
      capabilities: ["config.id.reserve"],
      currentSubjectRef: reserveSubject,
      currentInputHash: inputHash,
      currentManifestHash: actionCommandHash({ stale: true }),
      currentFencingToken: "41",
      execute: async () => ({ impossible: true }),
    }),
    errorCode("ACTION_COMMAND_MANIFEST_HASH_MISMATCH"),
  );
});

test("过期载荷与幂等键复用不同输入均被拒绝", async () => {
  const store = new InMemoryActionCommandPayloadStore();
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

test("旧状态写别名只有可信历史可完整重建时迁移，否则统一禁用", async () => {
  const store = new InMemoryActionCommandPayloadStore();
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
});

test("旧动作迁移不会把持久化故障伪装成历史不可解析", async () => {
  const store = new InMemoryActionCommandPayloadStore();
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
  const store = new InMemoryActionCommandPayloadStore();
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
  const store = new InMemoryActionCommandPayloadStore();
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
