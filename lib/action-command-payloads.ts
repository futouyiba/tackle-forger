import { createHash, randomUUID } from "node:crypto";
import {
  actionAvailability,
  buildActionLink,
  isStateChangingActionCode,
  type ActionCode,
  type ActionCommandLeaseRef,
  type ActionCommandPayloadRef,
  type ActionLink,
  type CapabilityCode,
  type EntityRef,
} from "./interaction-contracts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const ACTION_COMMAND_PAYLOAD_SCHEMA_VERSION = "action-command-payload/v1";
export const LEGACY_ACTION_ALIAS_UNRESOLVABLE = "LEGACY_ACTION_ALIAS_UNRESOLVABLE";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const FENCING_TOKEN = /^[1-9][0-9]*$/;
const MAX_FENCING_TOKEN = BigInt("9223372036854775807");

export const MANIFEST_BOUND_ACTION_CODES = [
  "reserve_config_id_bundle",
  "publish_config_id_policy",
  "import_legacy_config_id",
  "commit_config_export",
] as const satisfies readonly ActionCode[];

const MANIFEST_BOUND_ACTION_SET = new Set<ActionCode>(MANIFEST_BOUND_ACTION_CODES);

export class ActionCommandPayloadError extends Error {
  constructor(
    readonly code:
      | "ACTION_COMMAND_PAYLOAD_REQUIRED"
      | "ACTION_COMMAND_PAYLOAD_INVALID"
      | "ACTION_COMMAND_PAYLOAD_NOT_FOUND"
      | "ACTION_COMMAND_PAYLOAD_TAMPERED"
      | "ACTION_COMMAND_PAYLOAD_EXPIRED"
      | "ACTION_COMMAND_ACTION_MISMATCH"
      | "ACTION_COMMAND_SUBJECT_MISMATCH"
      | "ACTION_COMMAND_REVISION_CONFLICT"
      | "ACTION_COMMAND_INPUT_HASH_MISMATCH"
      | "ACTION_COMMAND_MANIFEST_HASH_MISMATCH"
      | "ACTION_COMMAND_ACTOR_MISMATCH"
      | "ACTION_COMMAND_CAPABILITY_CHANGED"
      | "ACTION_COMMAND_LEASE_REQUIRED"
      | "ACTION_COMMAND_FENCING_TOKEN_REQUIRED"
      | "STALE_FENCING_TOKEN"
      | "IDEMPOTENCY_KEY_REUSED",
    message: string,
  ) {
    super(message);
    this.name = "ActionCommandPayloadError";
  }
}

function normalizeJson(value: unknown, path = "$"): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ActionCommandPayloadError(
        "ACTION_COMMAND_PAYLOAD_INVALID",
        `${path} 不能包含 NaN 或无穷值。`,
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeJson(entry, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const normalized: JsonObject = {};
    for (const key of Object.keys(object).sort()) {
      const entry = object[key];
      if (entry === undefined) {
        throw new ActionCommandPayloadError(
          "ACTION_COMMAND_PAYLOAD_INVALID",
          `${path}.${key} 不得为 undefined。`,
        );
      }
      normalized[key] = normalizeJson(entry, `${path}.${key}`);
    }
    return normalized;
  }
  throw new ActionCommandPayloadError(
    "ACTION_COMMAND_PAYLOAD_INVALID",
    `${path} 包含不能进入命令载荷的值。`,
  );
}

export function actionCommandHash(value: unknown): string {
  const canonical = JSON.stringify(normalizeJson(value));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function assertSha256(value: string, field: string) {
  if (!SHA256_HEX.test(value)) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_INVALID",
      `${field} 必须是 SHA-256 小写十六进制。`,
    );
  }
}

function assertFencingToken(value: string | undefined, required: boolean) {
  if (!value) {
    if (required) {
      throw new ActionCommandPayloadError(
        "ACTION_COMMAND_FENCING_TOKEN_REQUIRED",
        "该状态写动作必须绑定 fencing token。",
      );
    }
    return;
  }
  if (!FENCING_TOKEN.test(value) || BigInt(value) > MAX_FENCING_TOKEN) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_INVALID",
      "fencing token 必须是无前导零的正数 BIGINT 十进制字符串。",
    );
  }
}

function assertLeaseRef(
  value: ActionCommandLeaseRef | undefined,
  expected: { workspaceId: string; action: ActionCode },
): asserts value is ActionCommandLeaseRef {
  if (!value) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_LEASE_REQUIRED",
      "该状态写动作必须绑定工作区租约。",
    );
  }
  if (
    typeof value.workspaceId !== "string"
    || !value.workspaceId.trim()
    || value.workspaceId !== value.workspaceId.trim()
    || typeof value.leaseId !== "string"
    || !value.leaseId.trim()
    || value.leaseId !== value.leaseId.trim()
    || value.workspaceId !== expected.workspaceId
    || value.action !== expected.action
  ) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_INVALID",
      "工作区租约必须绑定同一 workspace、action 和稳定 leaseId。",
    );
  }
  assertFencingToken(value.fencingToken, true);
}

function sameLeaseRef(
  left: ActionCommandLeaseRef,
  right: ActionCommandLeaseRef,
): boolean {
  return left.workspaceId === right.workspaceId
    && left.leaseId === right.leaseId
    && left.action === right.action
    && left.fencingToken === right.fencingToken;
}

function parseExpiresAt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_INVALID",
      "expiresAt 必须是可解析的有限时间值。",
    );
  }
  return timestamp;
}

function sameRef(left: EntityRef, right: EntityRef): boolean {
  return left.workspaceId === right.workspaceId
    && left.entityType === right.entityType
    && left.entityId === right.entityId
    && left.revisionId === right.revisionId;
}

export interface ActionCommandPayloadRecord {
  schemaVersion: typeof ACTION_COMMAND_PAYLOAD_SCHEMA_VERSION;
  payloadRefId: string;
  actionId: string;
  action: ActionCode;
  subjectRef: EntityRef;
  expectedRevisionId: string;
  inputHash: string;
  manifestHash?: string;
  leaseRef: ActionCommandLeaseRef;
  idempotencyKey: string;
  payload: JsonObject;
  commandHash: string;
  payloadHash: string;
  issuedForActorId: string;
  issuedAt: string;
  expiresAt?: string;
}

export interface ActionCommandExecution<T> {
  result: T;
  replayed: boolean;
}

export interface ActionCommandPayloadStore {
  /**
   * 生产实现必须把签发记录与执行结果持久化，并以唯一约束或事务保证
   * idempotencyKey 与 payloadRefId 的原子性，并返回唯一约束选出的规范记录；
   * 首次执行还必须在同一事务的实际业务写入点，从权威 WorkspaceActionLease
   * 原子读取并匹配 record.leaseRef 的 workspaceId + action + leaseId +
   * fencingToken。调用方不得把“当前 token”作为可信输入直接传进来。
   * 已落库的成功结果可以直接重放，因为重放不产生新的状态写。
   * 内存实现仅供单进程契约测试。
   */
  findByPayloadRefId(payloadRefId: string): Promise<ActionCommandPayloadRecord | undefined>;
  findIssuedByIdempotencyKey(input: {
    actorId: string;
    action: ActionCode;
    idempotencyKey: string;
  }): Promise<ActionCommandPayloadRecord | undefined>;
  saveIssued(record: ActionCommandPayloadRecord): Promise<ActionCommandPayloadRecord>;
  executeOnce<T>(input: {
    record: ActionCommandPayloadRecord;
    execute: () => Promise<T>;
  }): Promise<ActionCommandExecution<T>>;
}

export class InMemoryActionCommandPayloadStore implements ActionCommandPayloadStore {
  private readonly records = new Map<string, ActionCommandPayloadRecord>();
  private readonly issuedKeys = new Map<string, string>();
  private readonly executionResults = new Map<string, unknown>();
  private readonly pendingExecutions = new Map<string, Promise<unknown>>();
  private readonly currentLeases = new Map<string, ActionCommandLeaseRef>();
  private readonly activeLeaseWrites = new Map<string, number>();

  constructor(currentLeases: Iterable<ActionCommandLeaseRef> = []) {
    for (const leaseRef of currentLeases) this.setCurrentLease(leaseRef);
  }

  private leaseKey(input: Pick<ActionCommandLeaseRef, "workspaceId">) {
    return actionCommandHash({ workspaceId: input.workspaceId });
  }

  setCurrentLease(leaseRef: ActionCommandLeaseRef): void {
    assertLeaseRef(leaseRef, leaseRef);
    const key = this.leaseKey(leaseRef);
    this.assertLeaseMutable(key);
    this.currentLeases.set(key, structuredClone(leaseRef));
  }

  clearCurrentLease(input: Pick<ActionCommandLeaseRef, "workspaceId">): void {
    const key = this.leaseKey(input);
    this.assertLeaseMutable(key);
    this.currentLeases.delete(key);
  }

  private assertLeaseMutable(key: string): void {
    if ((this.activeLeaseWrites.get(key) ?? 0) > 0) {
      throw new Error("权威租约正被状态写事务锁定，请在事务完成后重试租约变更。");
    }
  }

  private beginLeaseWrite(key: string): void {
    this.activeLeaseWrites.set(key, (this.activeLeaseWrites.get(key) ?? 0) + 1);
  }

  private endLeaseWrite(key: string): void {
    const remaining = (this.activeLeaseWrites.get(key) ?? 1) - 1;
    if (remaining > 0) this.activeLeaseWrites.set(key, remaining);
    else this.activeLeaseWrites.delete(key);
  }

  private issuedKey(input: { actorId: string; action: ActionCode; idempotencyKey: string }) {
    return actionCommandHash({
      actorId: input.actorId,
      action: input.action,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async findByPayloadRefId(payloadRefId: string) {
    const record = this.records.get(payloadRefId);
    return record ? structuredClone(record) : undefined;
  }

  async findIssuedByIdempotencyKey(input: {
    actorId: string;
    action: ActionCode;
    idempotencyKey: string;
  }) {
    const payloadRefId = this.issuedKeys.get(this.issuedKey(input));
    return payloadRefId ? this.findByPayloadRefId(payloadRefId) : undefined;
  }

  async saveIssued(record: ActionCommandPayloadRecord) {
    const key = this.issuedKey({
      actorId: record.issuedForActorId,
      action: record.action,
      idempotencyKey: record.idempotencyKey,
    });
    const existingRef = this.issuedKeys.get(key);
    if (existingRef) {
      const existing = this.records.get(existingRef);
      if (!existing || existing.commandHash !== record.commandHash) {
        throw new ActionCommandPayloadError(
          "IDEMPOTENCY_KEY_REUSED",
          "同一幂等键不能签发不同的命令载荷。",
        );
      }
      return structuredClone(existing);
    }
    this.records.set(record.payloadRefId, structuredClone(record));
    this.issuedKeys.set(key, record.payloadRefId);
    return structuredClone(record);
  }

  async executeOnce<T>(input: {
    record: ActionCommandPayloadRecord;
    execute: () => Promise<T>;
  }): Promise<ActionCommandExecution<T>> {
    const key = input.record.commandHash;
    if (this.executionResults.has(key)) {
      return {
        result: structuredClone(this.executionResults.get(key)) as T,
        replayed: true,
      };
    }
    const pending = this.pendingExecutions.get(key);
    if (pending) {
      return {
        result: structuredClone(await pending) as T,
        replayed: true,
      };
    }
    const leaseKey = this.leaseKey(input.record.leaseRef);
    const currentLease = this.currentLeases.get(leaseKey);
    if (!currentLease || !sameLeaseRef(input.record.leaseRef, currentLease)) {
      throw new ActionCommandPayloadError(
        "STALE_FENCING_TOKEN",
        "工作区租约或 fencing token 已过期，不能执行新的状态写。",
      );
    }
    this.beginLeaseWrite(leaseKey);
    const execution = (async () => input.execute())();
    this.pendingExecutions.set(key, execution);
    try {
      const result = await execution;
      this.executionResults.set(key, structuredClone(result));
      return { result: structuredClone(result), replayed: false };
    } finally {
      this.pendingExecutions.delete(key);
      this.endLeaseWrite(leaseKey);
    }
  }
}

function commandHashInput(input: {
  schemaVersion: string;
  actionId: string;
  action: ActionCode;
  subjectRef: EntityRef;
  expectedRevisionId: string;
  inputHash: string;
  manifestHash?: string;
  leaseRef: ActionCommandLeaseRef;
  idempotencyKey: string;
  payload: JsonObject;
  issuedForActorId: string;
  expiresAt?: string;
}) {
  return {
    schemaVersion: input.schemaVersion,
    actionId: input.actionId,
    action: input.action,
    subjectRef: input.subjectRef,
    expectedRevisionId: input.expectedRevisionId,
    inputHash: input.inputHash,
    manifestHash: input.manifestHash ?? null,
    leaseRef: input.leaseRef,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    issuedForActorId: input.issuedForActorId,
    expiresAt: input.expiresAt ?? null,
  };
}

function payloadHashInput(input: {
  schemaVersion: string;
  payloadRefId: string;
  commandHash: string;
  issuedAt: string;
}) {
  return {
    schemaVersion: input.schemaVersion,
    payloadRefId: input.payloadRefId,
    commandHash: input.commandHash,
    issuedAt: input.issuedAt,
  };
}

function assertRecordIntegrity(record: ActionCommandPayloadRecord) {
  if (record.schemaVersion !== ACTION_COMMAND_PAYLOAD_SCHEMA_VERSION) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_TAMPERED",
      "命令载荷 schemaVersion 未知或已被改写。",
    );
  }
  try {
    assertLeaseRef(record.leaseRef, {
      workspaceId: record.subjectRef.workspaceId,
      action: record.action,
    });
  } catch {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_TAMPERED",
      "命令载荷的工作区租约身份缺失或已被改写。",
    );
  }
  const expectedCommandHash = actionCommandHash(commandHashInput({
    schemaVersion: record.schemaVersion,
    actionId: record.actionId,
    action: record.action,
    subjectRef: record.subjectRef,
    expectedRevisionId: record.expectedRevisionId,
    inputHash: record.inputHash,
    manifestHash: record.manifestHash,
    leaseRef: record.leaseRef,
    idempotencyKey: record.idempotencyKey,
    payload: record.payload,
    issuedForActorId: record.issuedForActorId,
    expiresAt: record.expiresAt,
  }));
  const expectedPayloadHash = actionCommandHash(payloadHashInput({
    schemaVersion: record.schemaVersion,
    payloadRefId: record.payloadRefId,
    commandHash: record.commandHash,
    issuedAt: record.issuedAt,
  }));
  if (
    record.commandHash !== expectedCommandHash
    || record.payloadHash !== expectedPayloadHash
  ) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_TAMPERED",
      "服务端命令载荷身份或 hash 校验失败。",
    );
  }
}

function toPayloadRef(record: ActionCommandPayloadRecord): ActionCommandPayloadRef {
  return {
    payloadRefId: record.payloadRefId,
    action: record.action,
    subjectRef: structuredClone(record.subjectRef),
    expectedRevisionId: record.expectedRevisionId,
    inputHash: record.inputHash,
    payloadHash: record.payloadHash,
    idempotencyKey: record.idempotencyKey,
    ...(record.manifestHash ? { manifestHash: record.manifestHash } : {}),
    leaseRef: structuredClone(record.leaseRef),
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
  };
}

export async function issueActionCommandPayload(input: {
  store: ActionCommandPayloadStore;
  actionId: string;
  action: ActionCode;
  subjectRef: EntityRef;
  expectedRevisionId: string;
  inputHash: string;
  manifestHash?: string;
  leaseRef?: ActionCommandLeaseRef;
  idempotencyKey: string;
  payload: JsonObject;
  actorId: string;
  capabilities: Iterable<CapabilityCode>;
  now?: Date;
  expiresAt?: string;
}): Promise<ActionCommandPayloadRef> {
  if (!isStateChangingActionCode(input.action)) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_INVALID",
      "只读动作不得签发状态写命令载荷。",
    );
  }
  // 所有状态写先验证完整租约身份；功能开关或能力禁用不能形成一个
  // 可绕过工作区单写锁的无租约签发分支。
  assertLeaseRef(input.leaseRef, {
    workspaceId: input.subjectRef.workspaceId,
    action: input.action,
  });
  const availability = actionAvailability(input.action, input.capabilities);
  if (!availability.enabled) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_CAPABILITY_CHANGED",
      availability.disabledReasonText ?? "当前操作者不能签发该命令。",
    );
  }
  if (
    !input.actionId.trim()
    || !input.actorId.trim()
    || !input.idempotencyKey.trim()
    || !input.expectedRevisionId.trim()
    || input.expectedRevisionId !== input.subjectRef.revisionId
  ) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_INVALID",
      "命令必须绑定 actionId、操作者、幂等键和 subject 当前 revision。",
    );
  }
  assertSha256(input.inputHash, "inputHash");
  if (MANIFEST_BOUND_ACTION_SET.has(input.action)) {
    if (!input.manifestHash) {
      throw new ActionCommandPayloadError(
        "ACTION_COMMAND_PAYLOAD_INVALID",
        "该动作必须绑定 Manifest hash。",
      );
    }
  }
  if (input.manifestHash) assertSha256(input.manifestHash, "manifestHash");
  // v3 §20.2.7 要求所有服务端共享状态写绑定完整租约身份；实际写入点
  // 由 store 从权威 WorkspaceActionLease 原子重验，不能信任调用方自报当前值。
  const now = input.now ?? new Date();
  const expiresAt = parseExpiresAt(input.expiresAt);
  if (expiresAt !== undefined && expiresAt <= now.getTime()) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_INVALID",
      "不能签发已经过期的命令载荷。",
    );
  }
  const payload = normalizeJson(input.payload) as JsonObject;
  const commandHash = actionCommandHash(commandHashInput({
    schemaVersion: ACTION_COMMAND_PAYLOAD_SCHEMA_VERSION,
    actionId: input.actionId,
    action: input.action,
    subjectRef: input.subjectRef,
    expectedRevisionId: input.expectedRevisionId,
    inputHash: input.inputHash,
    manifestHash: input.manifestHash,
    leaseRef: input.leaseRef,
    idempotencyKey: input.idempotencyKey,
    payload,
    issuedForActorId: input.actorId,
    expiresAt: input.expiresAt,
  }));
  const prior = await input.store.findIssuedByIdempotencyKey({
    actorId: input.actorId,
    action: input.action,
    idempotencyKey: input.idempotencyKey,
  });
  if (prior) {
    assertRecordIntegrity(prior);
    if (prior.commandHash !== commandHash) {
      throw new ActionCommandPayloadError(
        "IDEMPOTENCY_KEY_REUSED",
        "同一幂等键不能签发不同的命令载荷。",
      );
    }
    return toPayloadRef(prior);
  }
  const payloadRefId = randomUUID();
  const issuedAt = now.toISOString();
  const payloadHash = actionCommandHash(payloadHashInput({
    schemaVersion: ACTION_COMMAND_PAYLOAD_SCHEMA_VERSION,
    payloadRefId,
    commandHash,
    issuedAt,
  }));
  const record: ActionCommandPayloadRecord = {
    schemaVersion: ACTION_COMMAND_PAYLOAD_SCHEMA_VERSION,
    payloadRefId,
    actionId: input.actionId,
    action: input.action,
    subjectRef: structuredClone(input.subjectRef),
    expectedRevisionId: input.expectedRevisionId,
    inputHash: input.inputHash,
    idempotencyKey: input.idempotencyKey,
    payload,
    commandHash,
    payloadHash,
    issuedForActorId: input.actorId,
    issuedAt,
    ...(input.manifestHash ? { manifestHash: input.manifestHash } : {}),
    leaseRef: structuredClone(input.leaseRef),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
  const saved = await input.store.saveIssued(record);
  assertRecordIntegrity(saved);
  if (saved.commandHash !== commandHash) {
    throw new ActionCommandPayloadError(
      "IDEMPOTENCY_KEY_REUSED",
      "同一幂等键不能签发不同的命令载荷。",
    );
  }
  return toPayloadRef(saved);
}

export function parseActionCommandInvocation(value: unknown): {
  actionId: string;
  payloadRefId: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_REQUIRED",
      "状态写请求必须只提交 actionId 与 payloadRefId。",
    );
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (
    keys.length !== 2
    || keys[0] !== "actionId"
    || keys[1] !== "payloadRefId"
    || typeof object.actionId !== "string"
    || !object.actionId
    || typeof object.payloadRefId !== "string"
    || !object.payloadRefId
  ) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_REQUIRED",
      "客户端不得替换 action、subject、revision、hash、payload 或 fencing token。",
    );
  }
  return { actionId: object.actionId, payloadRefId: object.payloadRefId };
}

export async function executeActionCommandPayload<T>(input: {
  store: ActionCommandPayloadStore;
  invocation: unknown;
  actorId: string;
  capabilities: Iterable<CapabilityCode>;
  currentSubjectRef: EntityRef;
  currentInputHash: string;
  currentManifestHash?: string;
  now?: Date;
  execute: (record: Readonly<ActionCommandPayloadRecord>) => Promise<T>;
}): Promise<ActionCommandExecution<T>> {
  const invocation = parseActionCommandInvocation(input.invocation);
  const record = await input.store.findByPayloadRefId(invocation.payloadRefId);
  if (!record) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_NOT_FOUND",
      "命令载荷不存在或已经失效。",
    );
  }
  if (record.actionId !== invocation.actionId) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_ACTION_MISMATCH",
      "actionId 与服务端保存的命令不一致。",
    );
  }
  assertRecordIntegrity(record);
  if (record.issuedForActorId !== input.actorId) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_ACTOR_MISMATCH",
      "命令载荷不属于当前操作者。",
    );
  }
  // 结构非法的时间值必须在进入 executeOnce 前拒绝；已成功命令的正常过期
  // 仍由 executeOnce 内部判断，以保留响应丢失后的幂等结果恢复。
  const expiresAt = parseExpiresAt(record.expiresAt);
  return input.store.executeOnce({
    record,
    execute: async () => {
      if (expiresAt !== undefined && expiresAt <= (input.now ?? new Date()).getTime()) {
        throw new ActionCommandPayloadError(
          "ACTION_COMMAND_PAYLOAD_EXPIRED",
          "命令载荷已经过期，请重新获取动作。",
        );
      }
      const availability = actionAvailability(record.action, input.capabilities);
      if (!availability.enabled) {
        throw new ActionCommandPayloadError(
          "ACTION_COMMAND_CAPABILITY_CHANGED",
          availability.disabledReasonText ?? "执行前重新鉴权失败。",
        );
      }
      if (
        !sameRef(record.subjectRef, input.currentSubjectRef)
        && (
          record.subjectRef.workspaceId !== input.currentSubjectRef.workspaceId
          || record.subjectRef.entityType !== input.currentSubjectRef.entityType
          || record.subjectRef.entityId !== input.currentSubjectRef.entityId
        )
      ) {
        throw new ActionCommandPayloadError(
          "ACTION_COMMAND_SUBJECT_MISMATCH",
          "命令 subject 与当前对象不一致。",
        );
      }
      if (
        record.expectedRevisionId !== input.currentSubjectRef.revisionId
        || record.subjectRef.revisionId !== input.currentSubjectRef.revisionId
      ) {
        throw new ActionCommandPayloadError(
          "ACTION_COMMAND_REVISION_CONFLICT",
          "对象 revision 已变化，请重新获取动作。",
        );
      }
      assertSha256(input.currentInputHash, "currentInputHash");
      if (record.inputHash !== input.currentInputHash) {
        throw new ActionCommandPayloadError(
          "ACTION_COMMAND_INPUT_HASH_MISMATCH",
          "动作输入已经变化，请重新获取动作。",
        );
      }
      if (record.manifestHash !== input.currentManifestHash) {
        throw new ActionCommandPayloadError(
          "ACTION_COMMAND_MANIFEST_HASH_MISMATCH",
          "Manifest 已变化，请重新获取动作。",
        );
      }
      return input.execute(Object.freeze(structuredClone(record)));
    },
  });
}

const LEGACY_WRITE_ALIASES: Record<string, ActionCode> = {
  acknowledge_warning: "acknowledge_validation_warning",
  request_waiver: "request_validation_waiver",
  approve_waiver: "approve_validation_waiver",
  recompute: "recompute_validation",
  create_rule_source_change: "create_rule_source_change_draft",
  create_proposal: "create_rule_source_change_draft",
};

const PRESENTATION_ONLY_LEGACY_ACTIONS = new Set([
  "edit_rule",
  "edit_patch",
  "satisfy_requirement",
  "request_permission",
  "open_rebase",
]);

const TRUSTED_HISTORY_SOURCES = new Set([
  "server_command_record",
  "server_domain_event",
  "versioned_entity",
]);

export interface TrustedLegacyActionEvidence {
  source: "server_command_record" | "server_domain_event" | "versioned_entity";
  executionKind: "presentation_only" | "state_write";
  targetRoute?: string;
  originalAction?: ActionCode;
  subjectRef?: EntityRef;
  expectedRevisionId?: string;
  inputHash?: string;
  manifestHash?: string;
  leaseRef?: ActionCommandLeaseRef;
  idempotencyKey?: string;
  payload?: JsonObject;
}

export interface LegacyActionRecord {
  actionId: string;
  action: string;
  label: string;
  evidence?: TrustedLegacyActionEvidence;
}

export type LegacyActionMigrationResult =
  | {
      status: "MIGRATED";
      actionLink: ActionLink;
      targetAction: ActionCode | "navigate";
    }
  | {
      status: "UNRESOLVABLE";
      code: typeof LEGACY_ACTION_ALIAS_UNRESOLVABLE;
      actionId: string;
      legacyAction: string;
      enabled: false;
      commandPayloadRef?: never;
    };

function unresolvable(record: LegacyActionRecord): LegacyActionMigrationResult {
  return {
    status: "UNRESOLVABLE",
    code: LEGACY_ACTION_ALIAS_UNRESOLVABLE,
    actionId: record.actionId,
    legacyAction: record.action,
    enabled: false,
  };
}

function nonEmptyString(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasCompleteRuleTargetRef(
  value: JsonValue | undefined,
  sourceRevision: JsonValue | undefined,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as JsonObject;
  return nonEmptyString(target.spreadsheetToken)
    && nonEmptyString(target.sheetId)
    && nonEmptyString(target.stableRuleId)
    && nonEmptyString(target.parameterKey)
    && nonEmptyString(target.sourceRevision)
    && nonEmptyString(sourceRevision)
    && target.sourceRevision === sourceRevision;
}

function hasTypedLegacyPayload(action: ActionCode, payload: JsonObject): boolean {
  if (action === "acknowledge_validation_warning") {
    return nonEmptyString(payload.issueFingerprint)
      && nonEmptyString(payload.expectedIssueRevisionId)
      && nonEmptyString(payload.reason);
  }
  if (action === "acknowledge_price_warning") {
    return nonEmptyString(payload.issueFingerprint)
      && nonEmptyString(payload.expectedModelRevisionId)
      && nonEmptyString(payload.expectedPricingPolicyVersion)
      && nonEmptyString(payload.expectedInputHash)
      && typeof payload.purchasePriceRaw === "number"
      && typeof payload.purchasePriceRounded === "number"
      && typeof payload.purchasePrice === "number"
      && typeof payload.threshold === "number"
      && nonEmptyString(payload.reason);
  }
  if (action === "request_validation_waiver" || action === "approve_validation_waiver") {
    if (
      !nonEmptyString(payload.issueFingerprint)
      || !nonEmptyString(payload.expectedIssueRevisionId)
      || !nonEmptyString(payload.reason)
      || (payload.gate !== "REVIEW" && payload.gate !== "PUBLISH" && payload.gate !== "EXPORT")
    ) {
      return false;
    }
    if (payload.gate === "EXPORT") {
      return nonEmptyString(payload.environmentId) && nonEmptyString(payload.channelKey);
    }
    return payload.environmentId === undefined && payload.channelKey === undefined;
  }
  if (action === "recompute_validation") {
    return nonEmptyString(payload.ruleVersionId);
  }
  if (action === "create_rule_source_change_draft") {
    return hasCompleteRuleTargetRef(payload.targetRuleRef, payload.sourceRevision)
      && nonEmptyString(payload.evidenceHash)
      && SHA256_HEX.test(payload.evidenceHash);
  }
  if (action === "rebase_patch") {
    return nonEmptyString(payload.patchId)
      && nonEmptyString(payload.sourcePatchRevision)
      && nonEmptyString(payload.expectedHeadPatchRevision)
      && nonEmptyString(payload.baseObjectRevision);
  }
  return false;
}

export async function migrateLegacyActionRecord(input: {
  record: LegacyActionRecord;
  store: ActionCommandPayloadStore;
  actorId: string;
  capabilities: Iterable<CapabilityCode>;
  now?: Date;
  expiresAt?: string;
}): Promise<LegacyActionMigrationResult> {
  const { record } = input;
  const evidence = record.evidence;
  if (!evidence || !TRUSTED_HISTORY_SOURCES.has(evidence.source)) {
    return unresolvable(record);
  }
  if (PRESENTATION_ONLY_LEGACY_ACTIONS.has(record.action)) {
    if (
      evidence.executionKind !== "presentation_only"
      || !evidence.targetRoute
    ) {
      return unresolvable(record);
    }
    return {
      status: "MIGRATED",
      targetAction: "navigate",
      actionLink: buildActionLink({
        actionId: record.actionId,
        action: "navigate",
        label: record.label,
        targetRoute: evidence.targetRoute,
      }),
    };
  }

  let targetAction: ActionCode | undefined = LEGACY_WRITE_ALIASES[record.action];
  if (record.action === "retry") targetAction = evidence.originalAction;
  if (!targetAction || !isStateChangingActionCode(targetAction)) {
    return unresolvable(record);
  }
  if (
    evidence.executionKind !== "state_write"
    || !evidence.subjectRef
    || !evidence.expectedRevisionId
    || !evidence.inputHash
    || !evidence.idempotencyKey
    || !evidence.payload
    || !hasTypedLegacyPayload(targetAction, evidence.payload)
  ) {
    return unresolvable(record);
  }
  try {
    if (evidence.expectedRevisionId !== evidence.subjectRef.revisionId) {
      return unresolvable(record);
    }
    assertSha256(evidence.inputHash, "inputHash");
    if (MANIFEST_BOUND_ACTION_SET.has(targetAction) && !evidence.manifestHash) {
      return unresolvable(record);
    }
    if (evidence.manifestHash) assertSha256(evidence.manifestHash, "manifestHash");
    assertLeaseRef(evidence.leaseRef, {
      workspaceId: evidence.subjectRef.workspaceId,
      action: targetAction,
    });
    normalizeJson(evidence.payload);

    const availability = actionAvailability(targetAction, input.capabilities);
    if (!availability.enabled) {
      return {
        status: "MIGRATED",
        targetAction,
        actionLink: buildActionLink({
          actionId: record.actionId,
          action: targetAction,
          label: record.label,
          targetRef: evidence.subjectRef,
          availability,
        }),
      };
    }
    const commandPayloadRef = await issueActionCommandPayload({
      store: input.store,
      actionId: record.actionId,
      action: targetAction,
      subjectRef: evidence.subjectRef,
      expectedRevisionId: evidence.expectedRevisionId,
      inputHash: evidence.inputHash,
      manifestHash: evidence.manifestHash,
      leaseRef: evidence.leaseRef,
      idempotencyKey: evidence.idempotencyKey,
      payload: evidence.payload,
      actorId: input.actorId,
      capabilities: input.capabilities,
      now: input.now,
      expiresAt: input.expiresAt,
    });
    return {
      status: "MIGRATED",
      targetAction,
      actionLink: buildActionLink({
        actionId: record.actionId,
        action: targetAction,
        label: record.label,
        targetRef: evidence.subjectRef,
        availability,
        commandPayloadRef,
      }),
    };
  } catch (error) {
    if (error instanceof ActionCommandPayloadError) {
      return unresolvable(record);
    }
    throw error;
  }
}
