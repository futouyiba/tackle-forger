import { createHash, randomUUID } from "node:crypto";
import {
  actionAvailability,
  buildActionLink,
  isStateChangingActionCode,
  type ActionCode,
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

/**
 * 这些动作必须绑定工作区或配置目标治理租约签发的单调 fencing token。
 * 策略发布只复验 Manifest，不在这里错误地扩大到治理租约范围。
 */
export const FENCED_ACTION_CODES = [
  "publish",
  "write_patch_mirror",
  "pull_patch_mirror",
  "repair_patch_mirror",
  "rebuild_patch_mirror_from_local",
  "fix_patch_mirror_schema",
  "migrate_patch_subject",
  "confirm_feishu_write",
  "pull_feishu_source",
  "pull_feishu_workbook",
  "publish_ruleset",
  "write_feishu_identity",
  "publish_data_source",
  "commit_data_source_writeback",
  "reserve_config_id_bundle",
  "import_legacy_config_id",
  "commit_config_export",
  "publish_five_axis_definition",
] as const satisfies readonly ActionCode[];

export const MANIFEST_BOUND_ACTION_CODES = [
  "reserve_config_id_bundle",
  "publish_config_id_policy",
  "import_legacy_config_id",
  "commit_config_export",
] as const satisfies readonly ActionCode[];

const FENCED_ACTION_SET = new Set<ActionCode>(FENCED_ACTION_CODES);
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
  fencingToken?: string;
  idempotencyKey: string;
  payload: JsonObject;
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
   * idempotencyKey 与 payloadRefId 的原子性。内存实现仅供单进程测试。
   */
  findByPayloadRefId(payloadRefId: string): Promise<ActionCommandPayloadRecord | undefined>;
  findIssuedByIdempotencyKey(input: {
    actorId: string;
    action: ActionCode;
    idempotencyKey: string;
  }): Promise<ActionCommandPayloadRecord | undefined>;
  saveIssued(record: ActionCommandPayloadRecord): Promise<void>;
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
      if (!existing || existing.payloadHash !== record.payloadHash) {
        throw new ActionCommandPayloadError(
          "IDEMPOTENCY_KEY_REUSED",
          "同一幂等键不能签发不同的命令载荷。",
        );
      }
      return;
    }
    this.records.set(record.payloadRefId, structuredClone(record));
    this.issuedKeys.set(key, record.payloadRefId);
  }

  async executeOnce<T>(input: {
    record: ActionCommandPayloadRecord;
    execute: () => Promise<T>;
  }): Promise<ActionCommandExecution<T>> {
    const key = input.record.payloadRefId;
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
    const execution = input.execute();
    this.pendingExecutions.set(key, execution);
    try {
      const result = await execution;
      this.executionResults.set(key, structuredClone(result));
      return { result: structuredClone(result), replayed: false };
    } finally {
      this.pendingExecutions.delete(key);
    }
  }
}

function payloadHashInput(input: {
  actionId: string;
  action: ActionCode;
  subjectRef: EntityRef;
  expectedRevisionId: string;
  inputHash: string;
  manifestHash?: string;
  fencingToken?: string;
  idempotencyKey: string;
  payload: JsonObject;
  issuedForActorId: string;
  expiresAt?: string;
}) {
  return {
    schemaVersion: ACTION_COMMAND_PAYLOAD_SCHEMA_VERSION,
    actionId: input.actionId,
    action: input.action,
    subjectRef: input.subjectRef,
    expectedRevisionId: input.expectedRevisionId,
    inputHash: input.inputHash,
    manifestHash: input.manifestHash ?? null,
    fencingToken: input.fencingToken ?? null,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    issuedForActorId: input.issuedForActorId,
    expiresAt: input.expiresAt ?? null,
  };
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
    ...(record.fencingToken ? { fencingToken: record.fencingToken } : {}),
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
  fencingToken?: string;
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
  assertFencingToken(input.fencingToken, FENCED_ACTION_SET.has(input.action));
  const now = input.now ?? new Date();
  if (input.expiresAt && Date.parse(input.expiresAt) <= now.getTime()) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_INVALID",
      "不能签发已经过期的命令载荷。",
    );
  }
  const payload = normalizeJson(input.payload) as JsonObject;
  const hashInput = payloadHashInput({
    actionId: input.actionId,
    action: input.action,
    subjectRef: input.subjectRef,
    expectedRevisionId: input.expectedRevisionId,
    inputHash: input.inputHash,
    manifestHash: input.manifestHash,
    fencingToken: input.fencingToken,
    idempotencyKey: input.idempotencyKey,
    payload,
    issuedForActorId: input.actorId,
    expiresAt: input.expiresAt,
  });
  const payloadHash = actionCommandHash(hashInput);
  const prior = await input.store.findIssuedByIdempotencyKey({
    actorId: input.actorId,
    action: input.action,
    idempotencyKey: input.idempotencyKey,
  });
  if (prior) {
    if (prior.payloadHash !== payloadHash) {
      throw new ActionCommandPayloadError(
        "IDEMPOTENCY_KEY_REUSED",
        "同一幂等键不能签发不同的命令载荷。",
      );
    }
    return toPayloadRef(prior);
  }
  const record: ActionCommandPayloadRecord = {
    schemaVersion: ACTION_COMMAND_PAYLOAD_SCHEMA_VERSION,
    payloadRefId: randomUUID(),
    actionId: input.actionId,
    action: input.action,
    subjectRef: structuredClone(input.subjectRef),
    expectedRevisionId: input.expectedRevisionId,
    inputHash: input.inputHash,
    idempotencyKey: input.idempotencyKey,
    payload,
    payloadHash,
    issuedForActorId: input.actorId,
    issuedAt: now.toISOString(),
    ...(input.manifestHash ? { manifestHash: input.manifestHash } : {}),
    ...(input.fencingToken ? { fencingToken: input.fencingToken } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
  await input.store.saveIssued(record);
  return toPayloadRef(record);
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
  currentFencingToken?: string;
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
  const expectedHash = actionCommandHash(payloadHashInput({
    actionId: record.actionId,
    action: record.action,
    subjectRef: record.subjectRef,
    expectedRevisionId: record.expectedRevisionId,
    inputHash: record.inputHash,
    manifestHash: record.manifestHash,
    fencingToken: record.fencingToken,
    idempotencyKey: record.idempotencyKey,
    payload: record.payload,
    issuedForActorId: record.issuedForActorId,
    expiresAt: record.expiresAt,
  }));
  if (record.payloadHash !== expectedHash) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_PAYLOAD_TAMPERED",
      "服务端命令载荷 hash 校验失败。",
    );
  }
  if (record.issuedForActorId !== input.actorId) {
    throw new ActionCommandPayloadError(
      "ACTION_COMMAND_ACTOR_MISMATCH",
      "命令载荷不属于当前操作者。",
    );
  }
  return input.store.executeOnce({
    record,
    execute: async () => {
      if (record.expiresAt && Date.parse(record.expiresAt) <= (input.now ?? new Date()).getTime()) {
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
      if (
        FENCED_ACTION_SET.has(record.action)
        && (!record.fencingToken || record.fencingToken !== input.currentFencingToken)
      ) {
        throw new ActionCommandPayloadError(
          "STALE_FENCING_TOKEN",
          "fencing token 已过期或不再是当前值。",
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
  fencingToken?: string;
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

function hasTypedLegacyPayload(action: ActionCode, payload: JsonObject): boolean {
  if (action === "acknowledge_validation_warning") {
    return nonEmptyString(payload.issueFingerprint)
      && nonEmptyString(payload.expectedIssueRevisionId)
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
    return (
      nonEmptyString(payload.targetRuleRef)
      || (payload.targetRuleRef !== null
        && typeof payload.targetRuleRef === "object"
        && !Array.isArray(payload.targetRuleRef))
    )
      && nonEmptyString(payload.sourceRevision)
      && nonEmptyString(payload.evidenceHash)
      && SHA256_HEX.test(payload.evidenceHash);
  }
  if (action === "rebase_patch") {
    return nonEmptyString(payload.patchId)
      && nonEmptyString(payload.sourcePatchRevision)
      && nonEmptyString(payload.expectedHeadPatchRevision)
      && nonEmptyString(payload.baseObjectRevision);
  }
  return true;
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
    assertFencingToken(evidence.fencingToken, FENCED_ACTION_SET.has(targetAction));
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
      fencingToken: evidence.fencingToken,
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
