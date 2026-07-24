import { deterministicHash } from "./rule-kernel";
import type {
  CanonicalValidationIssue,
  LegacyValidationIssue,
  LegacyUnifiedValidationIssue,
  ValidationAcknowledgement,
  ValidationActionLink,
  ValidationEntityRef,
  ValidationEvidenceRef,
  ValidationIssue,
  ValidationIssueGate,
  ValidationIssueSeverity,
  ValidationIssueSource,
  ValidationWaiver,
  ValidationWaiverDecision,
  WaiverPolicyVersion,
} from "./types";

export const VALIDATION_ISSUE_FINGERPRINT_VERSION = "validation-issue-fingerprint/v1" as const;
export const VALIDATION_EVIDENCE_RECORD_HASH_VERSION = "validation-evidence-record/v2" as const;
export const VALIDATION_EVIDENCE_STATE_HASH_VERSION = "validation-evidence-state/v1" as const;
export const ACKNOWLEDGE_VALIDATION_WARNING_CAPABILITY = "validation.warning.acknowledge";
export const APPROVE_VALIDATION_WAIVER_CAPABILITY = "validation.waiver.approve";

export class ValidationIssueContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ValidationIssueContractError";
  }
}

export function isCanonicalValidationIssue(
  issue: ValidationIssue,
): issue is CanonicalValidationIssue {
  const hasEnvironment = Boolean(issue.environmentId?.trim());
  const hasChannel = Boolean(issue.channelKey?.trim());
  return "issueId" in issue
    && "subjectRef" in issue
    && issue.fingerprintVersion === VALIDATION_ISSUE_FINGERPRINT_VERSION
    && normalizeValidationSeverity(issue.severity) === issue.severity
    && normalizeValidationGate(issue.gate) === issue.gate
    && normalizeValidationState(issue.state) === issue.state
    && (issue.gate === "EXPORT"
      ? hasEnvironment && hasChannel
      : !hasEnvironment && !hasChannel);
}

/** 旧格式缺少可验证的治理生命周期，因此保守地视为活动；规范 Issue 仅 OPEN 活动。 */
export function isActiveValidationIssue(issue: ValidationIssue): boolean {
  return !isCanonicalValidationIssue(issue) || issue.state === "OPEN";
}

/** 统一展示状态，避免已冻结的治理证据被 UI 重新渲染成活动阻断。 */
export function validationIssuePresentation(issue: ValidationIssue): {
  tone: "error" | "warning" | "info";
  label: string;
} {
  if (isActiveValidationIssue(issue)) {
    const tone = validationIssueLevel(issue);
    return { tone, label: tone === "error" ? "阻断" : tone === "warning" ? "警告" : "信息" };
  }
  switch (issue.state) {
    case "WAIVED": return { tone: "info", label: "保留意见通过" };
    case "ACKNOWLEDGED": return { tone: "info", label: "已确认" };
    case "RESOLVED": return { tone: "info", label: "已解决" };
    case "STALE": return { tone: "info", label: "历史失效" };
    default: return { tone: "info", label: "历史记录" };
  }
}

export function validationIssueSeverity(issue: ValidationIssue): ValidationIssueSeverity {
  const severity = "severity" in issue ? normalizeValidationSeverity(issue.severity) : undefined;
  if (severity) return severity;
  const level = "level" in issue ? issue.level : undefined;
  return level === "error" ? "ERROR" : level === "warning" ? "WARNING" : "INFO";
}

export function validationIssueGate(issue: ValidationIssue): ValidationIssueGate | undefined {
  return normalizeValidationGate(issue.gate);
}

export function validationIssueLevel(
  issue: ValidationIssue,
): "error" | "warning" | "info" {
  const severity = validationIssueSeverity(issue);
  return severity === "BLOCKER" || severity === "ERROR"
    ? "error"
    : severity === "WARNING"
      ? "warning"
      : "info";
}

function assertExportTarget(input: {
  gate: ValidationIssueGate;
  environmentId?: string;
  channelKey?: string;
}): void {
  const hasEnvironment = Boolean(input.environmentId?.trim());
  const hasChannel = Boolean(input.channelKey?.trim());
  if (input.gate === "EXPORT" && (!hasEnvironment || !hasChannel)) {
    throw new ValidationIssueContractError(
      "VALIDATION_EXPORT_TARGET_REQUIRED",
      "EXPORT Issue/Waiver 必须精确绑定 environmentId 与 channelKey。",
    );
  }
  if (input.gate !== "EXPORT" && (hasEnvironment || hasChannel)) {
    throw new ValidationIssueContractError(
      "VALIDATION_EXPORT_TARGET_NOT_ALLOWED",
      "NONE/REVIEW/PUBLISH Issue/Waiver 不得携带导出目标。",
    );
  }
}

function normalizeRefs(refs: ValidationEntityRef[]): ValidationEntityRef[] {
  return [...refs]
    .map((ref) => structuredClone(ref))
    .sort((left, right) =>
      left.workspaceId.localeCompare(right.workspaceId)
      || left.entityType.localeCompare(right.entityType)
      || left.entityId.localeCompare(right.entityId)
      || left.revisionId.localeCompare(right.revisionId));
}

function normalizeStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeValidationSeverity(value: unknown): ValidationIssueSeverity | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toUpperCase();
  return normalized === "INFO"
    || normalized === "WARNING"
    || normalized === "ERROR"
    || normalized === "BLOCKER"
    ? normalized
    : undefined;
}

function normalizeValidationGate(value: unknown): ValidationIssueGate | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.toUpperCase()) {
    case "NONE":
    case "GENERATE":
      return "NONE";
    case "REVIEW":
    case "SERIES_APPROVE":
    case "MODEL_REVIEW":
      return "REVIEW";
    case "PUBLISH":
      return "PUBLISH";
    case "EXPORT":
      return "EXPORT";
    default:
      return undefined;
  }
}

function normalizeValidationState(value: unknown): CanonicalValidationIssue["state"] | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.toUpperCase()) {
    case "OPEN":
      return "OPEN";
    case "ACKNOWLEDGED":
      return "ACKNOWLEDGED";
    case "RESOLVED":
      return "RESOLVED";
    case "WAIVED":
      return "WAIVED";
    case "STALE":
    case "SUPERSEDED":
      return "STALE";
    default:
      return undefined;
  }
}

export interface CreateValidationIssueInput {
  code: string;
  source: ValidationIssueSource;
  severity: ValidationIssueSeverity;
  gate: ValidationIssueGate;
  subjectRef: ValidationEntityRef;
  affectedRefs?: ValidationEntityRef[];
  parameterKeys?: string[];
  title: string;
  message: string;
  evidenceRefs?: ValidationEvidenceRef[];
  ruleRefs: string[];
  state?: CanonicalValidationIssue["state"];
  waiverRef?: string;
  environmentId?: string;
  channelKey?: string;
  inputHash: string;
  fingerprintInputs?: Record<string, unknown>;
  actions?: ValidationActionLink[];
}

export function createValidationIssue(
  input: CreateValidationIssueInput,
): CanonicalValidationIssue {
  assertExportTarget(input);
  if (!input.code.trim() || !input.title.trim() || !input.message.trim()) {
    throw new ValidationIssueContractError(
      "VALIDATION_ISSUE_FIELDS_REQUIRED",
      "ValidationIssue 必须包含 code、title 与 message。",
    );
  }
  if (!input.inputHash.trim() || !input.ruleRefs.length) {
    throw new ValidationIssueContractError(
      "VALIDATION_ISSUE_VERSION_EVIDENCE_REQUIRED",
      "ValidationIssue 必须绑定 inputHash 与至少一个规则版本引用。",
    );
  }
  const state = input.state ?? "OPEN";
  if (state === "ACKNOWLEDGED" && input.severity !== "WARNING") {
    throw new ValidationIssueContractError(
      "VALIDATION_ACK_STATE_INVALID",
      "ACKNOWLEDGED 只适用于 WARNING。",
    );
  }
  if (input.severity === "BLOCKER" && (state === "WAIVED" || input.waiverRef)) {
    throw new ValidationIssueContractError(
      "VALIDATION_BLOCKER_WAIVER_FORBIDDEN",
      "BLOCKER 永远不可 waive。",
    );
  }
  if (state === "WAIVED" && input.severity !== "ERROR") {
    throw new ValidationIssueContractError(
      "VALIDATION_WAIVER_STATE_INVALID",
      "WAIVED 只适用于经策略允许的 ERROR。",
    );
  }
  if (state === "WAIVED" && !input.waiverRef) {
    throw new ValidationIssueContractError(
      "VALIDATION_WAIVER_REFERENCE_REQUIRED",
      "WAIVED Issue 必须冻结 waiverRef。",
    );
  }
  const affectedRefs = normalizeRefs(input.affectedRefs ?? []);
  const parameterKeys = normalizeStrings(input.parameterKeys ?? []);
  const ruleRefs = normalizeStrings(input.ruleRefs);
  const actions = structuredClone(input.actions ?? []);
  for (const action of actions) {
    const presentationOnly = action.action === "navigate"
      || action.action === "view_evidence"
      || action.action === "open_help";
    if (!action.enabled && action.commandPayloadRef) {
      throw new ValidationIssueContractError(
        "VALIDATION_DISABLED_ACTION_PAYLOAD_FORBIDDEN",
        "禁用动作不得携带 commandPayloadRef。",
      );
    }
    if (action.enabled && !presentationOnly && !action.commandPayloadRef) {
      throw new ValidationIssueContractError(
        "VALIDATION_ACTION_PAYLOAD_REQUIRED",
        "启用的状态写动作必须绑定 #48 统一的不可变 commandPayloadRef。",
      );
    }
    if (action.commandPayloadRef && (
      action.commandPayloadRef.action !== action.action
      || action.commandPayloadRef.inputHash !== input.inputHash
      || deterministicHash(action.commandPayloadRef.subjectRef) !== deterministicHash(input.subjectRef)
      || !action.commandPayloadRef.payloadHash.trim()
      || !action.commandPayloadRef.idempotencyKey.trim()
    )) {
      throw new ValidationIssueContractError(
        "VALIDATION_ACTION_PAYLOAD_MISMATCH",
        "ActionLink 与 commandPayloadRef 的 action/subject/inputHash 不一致。",
      );
    }
  }
  const fingerprint = deterministicHash({
    fingerprintVersion: VALIDATION_ISSUE_FINGERPRINT_VERSION,
    source: input.source,
    code: input.code,
    subjectRef: input.subjectRef,
    affectedRefs,
    parameterKeys,
    ruleRefs,
    gate: input.gate,
    inputHash: input.inputHash,
    fingerprintInputs: input.fingerprintInputs ?? {},
    ...(input.gate === "EXPORT"
      ? { environmentId: input.environmentId, channelKey: input.channelKey }
      : {}),
  });
  const issueId = `validation-issue:${fingerprint}`;
  return {
    issueId,
    issueRevision: deterministicHash({ issueId, state, waiverRef: input.waiverRef }),
    fingerprint,
    fingerprintVersion: VALIDATION_ISSUE_FINGERPRINT_VERSION,
    inputHash: input.inputHash,
    code: input.code,
    source: input.source,
    severity: input.severity,
    gate: input.gate,
    subjectRef: structuredClone(input.subjectRef),
    affectedRefs,
    parameterKeys,
    title: input.title,
    message: input.message,
    evidenceRefs: structuredClone(input.evidenceRefs ?? []),
    ruleRefs,
    state,
    ...(input.waiverRef ? { waiverRef: input.waiverRef } : {}),
    ...(input.gate === "EXPORT"
      ? { environmentId: input.environmentId, channelKey: input.channelKey }
      : {}),
    actions,
  };
}

export interface AdaptLegacyValidationIssueContext {
  subjectRef: ValidationEntityRef;
  inputHash: string;
  ruleRefs: string[];
  gate?: ValidationIssueGate;
  source?: ValidationIssueSource;
  environmentId?: string;
  channelKey?: string;
  /** historical 是默认值：旧记录只读留痕，不能借适配器获得状态写能力。 */
  mode?: "historical" | "active_gate";
}

export function adaptLegacyValidationIssue(
  legacy: LegacyValidationIssue | LegacyUnifiedValidationIssue,
  context: AdaptLegacyValidationIssueContext,
): CanonicalValidationIssue {
  const mode = context.mode ?? "historical";
  const normalizedLegacyGate = normalizeValidationGate(legacy.gate);
  let gate = normalizedLegacyGate ?? context.gate ?? "NONE";
  const severity = "deny" in legacy && legacy.deny
    ? "BLOCKER"
    : normalizeValidationSeverity(legacy.severity)
      ?? ("level" in legacy && legacy.level === "error"
        ? "ERROR"
        : "level" in legacy && legacy.level === "warning"
          ? "WARNING"
          : "INFO");
  const normalizedLegacyState = normalizeValidationState(legacy.state) ?? "OPEN";
  const state = mode === "historical"
    ? "STALE"
    : normalizedLegacyState === "WAIVED"
      ? "OPEN"
      : normalizedLegacyState === "ACKNOWLEDGED" && severity !== "WARNING"
        ? "OPEN"
        : normalizedLegacyState;
  const environmentId = legacy.environmentId ?? context.environmentId;
  const channelKey = legacy.channelKey ?? context.channelKey;
  if (gate === "EXPORT" && (!environmentId?.trim() || !channelKey?.trim())) {
    if (mode === "active_gate") {
      throw new ValidationIssueContractError(
        "VALIDATION_EXPORT_TARGET_REQUIRED",
        "旧 EXPORT Issue 缺少 environmentId/channelKey，不能进入活动 Gate。",
      );
    }
    gate = "NONE";
  }
  const originalPayloadHash = deterministicHash(legacy);
  const canonical = createValidationIssue({
    code: legacy.code,
    source: legacy.source === "affix" ? "data_integrity" : legacy.source ?? context.source ?? "import",
    severity,
    gate,
    subjectRef: "subjectRef" in legacy ? legacy.subjectRef : context.subjectRef,
    affectedRefs: "affectedRefs" in legacy ? legacy.affectedRefs : undefined,
    parameterKeys: "parameterKeys" in legacy
      ? legacy.parameterKeys
      : legacy.parameterKey ? [legacy.parameterKey] : [],
    title: "title" in legacy ? legacy.title : legacy.code,
    message: legacy.message,
    evidenceRefs: [{
      evidenceType: "validation_issue",
      refId: `legacy-validation-issue:${originalPayloadHash}`,
      contentHash: originalPayloadHash,
    }],
    ruleRefs: context.ruleRefs,
    state,
    inputHash: context.inputHash,
    fingerprintInputs: {
      legacyFingerprint: legacy.fingerprint,
      originalPayloadHash,
      evidence: legacy.evidence,
    },
    ...(gate === "EXPORT"
      ? {
        environmentId,
        channelKey,
      }
      : {}),
    // 旧动作缺少可信 typed payload，一律不恢复状态写动作。
    actions: [],
  });
  return canonical;
}

export function canonicalizeValidationIssues(
  issues: ValidationIssue[],
  context: AdaptLegacyValidationIssueContext,
): CanonicalValidationIssue[] {
  return issues.map((issue) => {
    if (isCanonicalValidationIssue(issue)) return structuredClone(issue);
    if (
      (issue as { fingerprintVersion?: unknown }).fingerprintVersion
      === VALIDATION_ISSUE_FINGERPRINT_VERSION
    ) {
      throw new ValidationIssueContractError(
        "VALIDATION_CANONICAL_ISSUE_INVALID",
        `Canonical ValidationIssue ${(issue as ValidationIssue).code} 的枚举或 EXPORT 目标不完整。`,
      );
    }
    return adaptLegacyValidationIssue(issue, context);
  });
}

function assertCapability(capabilities: Iterable<string>, required: string): void {
  if (![...capabilities].includes(required)) {
    throw new ValidationIssueContractError(
      "VALIDATION_ACTION_FORBIDDEN",
      `缺少 ${required} Capability。`,
    );
  }
}

function replaceIssueState(
  issue: CanonicalValidationIssue,
  state: CanonicalValidationIssue["state"],
  waiverRef?: string,
): CanonicalValidationIssue {
  return {
    ...structuredClone(issue),
    state,
    issueRevision: deterministicHash({
      issueId: issue.issueId,
      previousRevision: issue.issueRevision,
      state,
      waiverRef,
    }),
    ...(waiverRef ? { waiverRef } : {}),
  };
}

export function verifyValidationAcknowledgement(
  acknowledgement: ValidationAcknowledgement,
): boolean {
  const {
    acknowledgementId,
    recordHash,
    recordHashVersion,
    state,
    stateHash,
    stateHashVersion,
    ...content
  } = acknowledgement;
  const recordValid = recordHashVersion === VALIDATION_EVIDENCE_RECORD_HASH_VERSION
    ? deterministicHash({ recordHashVersion, ...content }) === recordHash
    : recordHashVersion === undefined
      && deterministicHash({ ...content, state: "FRESH" }) === recordHash;
  const stateValid = stateHashVersion === undefined && stateHash === undefined
    ? recordHashVersion === undefined && state === "FRESH"
    : stateHashVersion === VALIDATION_EVIDENCE_STATE_HASH_VERSION
      && deterministicHash({
      stateHashVersion,
      recordHash,
      state,
      }) === stateHash;
  return acknowledgementId === `validation-ack:${recordHash}`
    && recordValid
    && stateValid;
}

function transitionAcknowledgementToStale(
  acknowledgement: ValidationAcknowledgement,
): ValidationAcknowledgement {
  if (!verifyValidationAcknowledgement(acknowledgement)) {
    throw new ValidationIssueContractError(
      "VALIDATION_EVIDENCE_INVALID",
      "WARNING 确认证据完整性校验失败，不能生成 STALE 迁移证据。",
    );
  }
  const state = "STALE" as const;
  const stateHashVersion = VALIDATION_EVIDENCE_STATE_HASH_VERSION;
  return {
    ...structuredClone(acknowledgement),
    state,
    stateHash: deterministicHash({
      stateHashVersion,
      recordHash: acknowledgement.recordHash,
      state,
    }),
    stateHashVersion,
  };
}

export function acknowledgeValidationWarning(input: {
  issue: CanonicalValidationIssue;
  expectedIssueRevision: string;
  expectedInputHash: string;
  reason: string;
  acknowledgedBy: string;
  acknowledgedAt: string;
  idempotencyKey: string;
  capabilities: Iterable<string>;
  existingAcknowledgements?: ValidationAcknowledgement[];
}): { issue: CanonicalValidationIssue; acknowledgement: ValidationAcknowledgement } {
  assertCapability(input.capabilities, ACKNOWLEDGE_VALIDATION_WARNING_CAPABILITY);
  const payload = {
    action: "acknowledge_validation_warning",
    issueFingerprint: input.issue.fingerprint,
    expectedIssueRevision: input.expectedIssueRevision,
    expectedInputHash: input.expectedInputHash,
    reason: input.reason,
    acknowledgedBy: input.acknowledgedBy,
  };
  const payloadHash = deterministicHash(payload);
  const previous = input.existingAcknowledgements?.find(
    (entry) => entry.idempotencyKey === input.idempotencyKey,
  );
  if (previous) {
    if (!verifyValidationAcknowledgement(previous)) {
      throw new ValidationIssueContractError(
        "VALIDATION_RETRY_EVIDENCE_INVALID",
        "幂等重试引用的原始 WARNING 确认证据完整性校验失败。",
      );
    }
    if (previous.state !== "FRESH") {
      throw new ValidationIssueContractError(
        "VALIDATION_RETRY_EVIDENCE_STALE",
        "幂等重试不能复用已失效的 WARNING 确认证据。",
      );
    }
    if (previous.payloadHash !== payloadHash) {
      throw new ValidationIssueContractError(
        "VALIDATION_IDEMPOTENCY_CONFLICT",
        "相同幂等键不能用于不同 warning 确认 payload。",
      );
    }
    const expectedAcknowledgedRevision = deterministicHash({
      issueId: input.issue.issueId,
      previousRevision: previous.issueRevision,
      state: "ACKNOWLEDGED",
      waiverRef: undefined,
    });
    const retriedIssue = input.issue.state === "ACKNOWLEDGED"
      && input.issue.issueRevision === expectedAcknowledgedRevision
      ? structuredClone(input.issue)
      : input.issue.state === "OPEN"
        && input.issue.issueRevision === previous.issueRevision
        ? replaceIssueState(input.issue, "ACKNOWLEDGED")
        : undefined;
    if (!retriedIssue) {
      throw new ValidationIssueContractError(
        "VALIDATION_RETRY_TARGET_STALE",
        "幂等重试时 WARNING Issue 已进入不兼容状态。",
      );
    }
    return { issue: retriedIssue, acknowledgement: structuredClone(previous) };
  }
  if (!input.reason.trim()) {
    throw new ValidationIssueContractError(
      "VALIDATION_ACK_REASON_REQUIRED",
      "WARNING 确认必须记录人工理由。",
    );
  }
  if (
    input.issue.severity !== "WARNING"
    || input.issue.state !== "OPEN"
    || input.issue.issueRevision !== input.expectedIssueRevision
    || input.issue.inputHash !== input.expectedInputHash
  ) {
    throw new ValidationIssueContractError(
      "VALIDATION_ACK_TARGET_STALE",
      "WARNING 已变化、不是 OPEN，或 expected revision/inputHash 不匹配。",
    );
  }
  const content = {
    recordHashVersion: VALIDATION_EVIDENCE_RECORD_HASH_VERSION,
    issueId: input.issue.issueId,
    issueFingerprint: input.issue.fingerprint,
    issueRevision: input.issue.issueRevision,
    inputHash: input.issue.inputHash,
    gate: input.issue.gate,
    reason: input.reason,
    acknowledgedBy: input.acknowledgedBy,
    acknowledgedAt: input.acknowledgedAt,
    idempotencyKey: input.idempotencyKey,
    payloadHash,
    evidenceRefs: structuredClone(input.issue.evidenceRefs),
  };
  const recordHash = deterministicHash(content);
  const state = "FRESH" as const;
  const stateHashVersion = VALIDATION_EVIDENCE_STATE_HASH_VERSION;
  return {
    issue: replaceIssueState(input.issue, "ACKNOWLEDGED"),
    acknowledgement: {
      acknowledgementId: `validation-ack:${recordHash}`,
      ...content,
      state,
      stateHashVersion,
      stateHash: deterministicHash({ stateHashVersion, recordHash, state }),
      recordHash,
    },
  };
}

export function createWaiverPolicyVersion(
  input: Omit<WaiverPolicyVersion, "policyHash">,
): WaiverPolicyVersion {
  if (!input.rules.length) {
    throw new ValidationIssueContractError(
      "VALIDATION_WAIVER_POLICY_EMPTY",
      "WaiverPolicyVersion 必须显式列出允许的 ERROR；空策略不能发布。",
    );
  }
  const content = structuredClone(input);
  return { ...content, policyHash: deterministicHash(content) };
}

export function verifyWaiverPolicyVersion(policy: WaiverPolicyVersion): boolean {
  const { policyHash, ...content } = policy;
  return deterministicHash(content) === policyHash;
}

export function verifyValidationWaiver(waiver: ValidationWaiver): boolean {
  const {
    recordHash,
    recordHashVersion,
    state,
    stateHash,
    stateHashVersion,
    ...content
  } = waiver;
  const recordValid = recordHashVersion === VALIDATION_EVIDENCE_RECORD_HASH_VERSION
    ? deterministicHash({ recordHashVersion, ...content }) === recordHash
    : recordHashVersion === undefined
      && deterministicHash({ ...content, state: "FRESH" }) === recordHash;
  const stateValid = stateHashVersion === undefined && stateHash === undefined
    ? recordHashVersion === undefined && state === "FRESH"
    : stateHashVersion === VALIDATION_EVIDENCE_STATE_HASH_VERSION
      && deterministicHash({
      stateHashVersion,
      recordHash,
      state,
      }) === stateHash;
  return recordValid && stateValid;
}

function transitionWaiverToStale(waiver: ValidationWaiver): ValidationWaiver {
  if (!verifyValidationWaiver(waiver)) {
    throw new ValidationIssueContractError(
      "VALIDATION_EVIDENCE_INVALID",
      "Waiver 证据完整性校验失败，不能生成 STALE 迁移证据。",
    );
  }
  const state = "STALE" as const;
  const stateHashVersion = VALIDATION_EVIDENCE_STATE_HASH_VERSION;
  return {
    ...structuredClone(waiver),
    state,
    stateHash: deterministicHash({
      stateHashVersion,
      recordHash: waiver.recordHash,
      state,
    }),
    stateHashVersion,
  };
}

export function verifyValidationWaiverDecision(
  decision: ValidationWaiverDecision,
): boolean {
  const content = {
    scopeRef: decision.scopeRef,
    reason: decision.reason,
    requestedWaivers: decision.requestedWaivers,
    approvedBy: decision.approvedBy,
    approvedAt: decision.approvedAt,
    policyVersion: decision.policyVersion,
    policyHash: decision.policyHash,
    idempotencyKey: decision.idempotencyKey,
    payloadHash: decision.payloadHash,
  };
  const waiverDecisionId = `validation-waiver-decision:${deterministicHash(content)}`;
  return decision.waiverDecisionId === waiverDecisionId
    && deterministicHash({ ...content, waiverIds: decision.waiverIds }) === decision.decisionHash;
}

export function assertValidationWaiverDecisionCoverage(input: {
  waivers?: ValidationWaiver[];
  decisions?: ValidationWaiverDecision[];
}): void {
  const decisions = input.decisions ?? [];
  const waivers = input.waivers ?? [];
  if (
    new Set(decisions.map((decision) => decision.waiverDecisionId)).size !== decisions.length
    || decisions.some((decision) => !verifyValidationWaiverDecision(decision))
  ) {
    throw new ValidationIssueContractError(
      "VALIDATION_WAIVER_DECISION_INVALID",
      "ValidationWaiverDecision 完整性校验失败。",
    );
  }
  for (const decision of decisions) {
    const requestedTargetKey = (request: ValidationWaiverDecision["requestedWaivers"][number]) =>
      `${request.issueFingerprint}\u0000${request.gate}\u0000${request.environmentId ?? ""}\u0000${request.channelKey ?? ""}`;
    const requestedTargetKeys = decision.requestedWaivers.map(requestedTargetKey);
    const coveredWaivers = waivers
      .filter((waiver) => waiver.waiverDecisionId === decision.waiverDecisionId);
    const coveredWaiverIds = coveredWaivers.map((waiver) => waiver.waiverId);
    const coveredTargetKeys = coveredWaivers.map((waiver) =>
      `${waiver.issueFingerprint}\u0000${waiver.gate}\u0000${waiver.environmentId ?? ""}\u0000${waiver.channelKey ?? ""}`);
    if (
      new Set(requestedTargetKeys).size !== requestedTargetKeys.length
      || decision.requestedWaivers.length !== decision.waiverIds.length
      || coveredWaiverIds.length !== decision.waiverIds.length
      || new Set(coveredWaiverIds).size !== coveredWaiverIds.length
      || coveredWaiverIds.some((waiverId) => !decision.waiverIds.includes(waiverId))
      || new Set(coveredTargetKeys).size !== coveredTargetKeys.length
      || coveredTargetKeys.some((targetKey) => !requestedTargetKeys.includes(targetKey))
    ) {
      throw new ValidationIssueContractError(
        "VALIDATION_WAIVER_DECISION_COVERAGE_INCOMPLETE",
        `ValidationWaiverDecision ${decision.waiverDecisionId} 声明的原子 Waiver 集合未完整冻结。`,
      );
    }
  }
  for (const waiver of waivers) {
    const matchingDecisions = decisions.filter(
      (decision) => decision.waiverDecisionId === waiver.waiverDecisionId,
    );
    if (
      !verifyValidationWaiver(waiver)
      || matchingDecisions.length !== 1
      || !matchingDecisions[0].waiverIds.includes(waiver.waiverId)
      || matchingDecisions[0].policyVersion !== waiver.policyVersion
      || matchingDecisions[0].policyHash !== waiver.policyHash
      || matchingDecisions[0].requestedWaivers.filter((request) =>
        request.issueFingerprint === waiver.issueFingerprint
        && request.gate === waiver.gate
        && request.environmentId === waiver.environmentId
        && request.channelKey === waiver.channelKey).length !== 1
    ) {
      throw new ValidationIssueContractError(
        "VALIDATION_WAIVER_DECISION_MISSING_OR_INVALID",
        `Waiver ${waiver.waiverId} 缺少完整且匹配的 ValidationWaiverDecision 证据。`,
      );
    }
  }
}

function policyAllows(
  policy: WaiverPolicyVersion,
  issue: CanonicalValidationIssue,
  at: string,
): boolean {
  return policy.rules.some((rule) =>
    rule.source === issue.source
    && rule.code === issue.code
    && rule.gates.includes(issue.gate as Exclude<ValidationIssueGate, "NONE">)
    && (!rule.scopeEntityTypes?.length || rule.scopeEntityTypes.includes(issue.subjectRef.entityType))
    && (!rule.scopeRefs?.length || rule.scopeRefs.some(
      (scopeRef) => deterministicHash(scopeRef) === deterministicHash(issue.subjectRef),
    ))
    && (!rule.validFrom || at >= rule.validFrom)
    && (!rule.validUntil || at <= rule.validUntil));
}

export interface RequestedValidationWaiver {
  issueFingerprint: string;
  expectedIssueRevision: string;
  expectedInputHash: string;
  gate: Exclude<ValidationIssueGate, "NONE">;
  environmentId?: string;
  channelKey?: string;
}

export function approveValidationWaiverDecision(input: {
  issues: CanonicalValidationIssue[];
  requestedWaivers: RequestedValidationWaiver[];
  policy: WaiverPolicyVersion;
  scopeRef: ValidationEntityRef;
  reason: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt?: string;
  idempotencyKey: string;
  capabilities: Iterable<string>;
  existingDecisions?: ValidationWaiverDecision[];
  existingWaivers?: ValidationWaiver[];
}): {
  issues: CanonicalValidationIssue[];
  decision: ValidationWaiverDecision;
  waivers: ValidationWaiver[];
} {
  assertCapability(input.capabilities, APPROVE_VALIDATION_WAIVER_CAPABILITY);
  if (
    input.policy.status !== "PUBLISHED"
    || !verifyWaiverPolicyVersion(input.policy)
  ) {
    throw new ValidationIssueContractError(
      "VALIDATION_WAIVER_POLICY_INVALID",
      "Waiver 只能引用完整性校验通过的已发布策略版本。",
    );
  }
  if (!input.reason.trim() || !input.requestedWaivers.length) {
    throw new ValidationIssueContractError(
      "VALIDATION_WAIVER_REQUEST_INVALID",
      "Waiver 决定必须包含人工理由和至少一个明确目标。",
    );
  }
  const requestedWaivers = [...input.requestedWaivers].sort((left, right) =>
    left.issueFingerprint.localeCompare(right.issueFingerprint)
    || left.gate.localeCompare(right.gate)
    || (left.environmentId ?? "").localeCompare(right.environmentId ?? "")
    || (left.channelKey ?? "").localeCompare(right.channelKey ?? ""));
  const requestedTargetKeys = requestedWaivers.map((request) =>
    `${request.issueFingerprint}\u0000${request.gate}\u0000${request.environmentId ?? ""}\u0000${request.channelKey ?? ""}`);
  if (new Set(requestedTargetKeys).size !== requestedTargetKeys.length) {
    throw new ValidationIssueContractError(
      "VALIDATION_WAIVER_TARGET_DUPLICATE",
      "同一 Issue/Gate/导出目标只能在一个 Waiver 决定中请求一次。",
    );
  }
  const payload = {
    action: "approve_validation_waiver",
    policyVersion: input.policy.version,
    policyHash: input.policy.policyHash,
    scopeRef: input.scopeRef,
    requestedWaivers,
    reason: input.reason,
    approvedBy: input.approvedBy,
  };
  const payloadHash = deterministicHash(payload);
  const previous = input.existingDecisions?.find(
    (entry) => entry.idempotencyKey === input.idempotencyKey,
  );
  if (previous) {
    if (!verifyValidationWaiverDecision(previous)) {
      throw new ValidationIssueContractError(
        "VALIDATION_RETRY_EVIDENCE_INVALID",
        "幂等重试引用的原始 WaiverDecision 完整性校验失败。",
      );
    }
    if (previous.payloadHash !== payloadHash) {
      throw new ValidationIssueContractError(
        "VALIDATION_IDEMPOTENCY_CONFLICT",
        "相同幂等键不能用于不同 Waiver payload。",
      );
    }
    const waiverIds = new Set(previous.waiverIds);
    const waivers = (input.existingWaivers ?? []).filter((entry) => waiverIds.has(entry.waiverId));
    if (waivers.length !== previous.waiverIds.length) {
      throw new ValidationIssueContractError(
        "VALIDATION_RETRY_EVIDENCE_MISSING",
        "幂等重试缺少原始 Waiver 证据，不能重新生成另一组结果。",
      );
    }
    if (waivers.some((entry) => !verifyValidationWaiver(entry))) {
      throw new ValidationIssueContractError(
        "VALIDATION_RETRY_EVIDENCE_INVALID",
        "幂等重试引用的原始 Waiver 证据完整性校验失败。",
      );
    }
    assertValidationWaiverDecisionCoverage({
      waivers,
      decisions: [previous],
    });
    if (waivers.some((entry) => entry.state !== "FRESH")) {
      throw new ValidationIssueContractError(
        "VALIDATION_RETRY_EVIDENCE_STALE",
        "幂等重试不能复用已失效的 Waiver 证据。",
      );
    }
    return {
      issues: input.issues.map((issue) => {
        const waiver = waivers.find((entry) => entry.issueFingerprint === issue.fingerprint);
        if (!waiver) return structuredClone(issue);
        const expectedWaivedRevision = deterministicHash({
          issueId: issue.issueId,
          previousRevision: waiver.issueRevision,
          state: "WAIVED",
          waiverRef: waiver.waiverId,
        });
        if (issue.state === "WAIVED"
          && issue.waiverRef === waiver.waiverId
          && issue.issueRevision === expectedWaivedRevision) {
          return structuredClone(issue);
        }
        if (issue.state === "OPEN" && issue.issueRevision === waiver.issueRevision) {
          return replaceIssueState(issue, "WAIVED", waiver.waiverId);
        }
        throw new ValidationIssueContractError(
          "VALIDATION_RETRY_TARGET_STALE",
          `幂等重试时 Issue ${issue.fingerprint} 已进入不兼容状态。`,
        );
      }),
      decision: structuredClone(previous),
      waivers: structuredClone(waivers),
    };
  }
  const issuesByFingerprint = new Map(input.issues.map((issue) => [issue.fingerprint, issue]));
  const targets = requestedWaivers.map((request) => {
    assertExportTarget(request);
    const issue = issuesByFingerprint.get(request.issueFingerprint);
    if (!issue
      || issue.severity !== "ERROR"
      || issue.state !== "OPEN"
      || issue.gate !== request.gate
      || issue.issueRevision !== request.expectedIssueRevision
      || issue.inputHash !== request.expectedInputHash
      || issue.environmentId !== request.environmentId
      || issue.channelKey !== request.channelKey
    ) {
      throw new ValidationIssueContractError(
        "VALIDATION_WAIVER_TARGET_STALE",
        `Issue ${request.issueFingerprint} 不存在、不可 waive 或版本/目标已变化。`,
      );
    }
    if (!policyAllows(input.policy, issue, input.approvedAt)) {
      throw new ValidationIssueContractError(
        "VALIDATION_WAIVER_NOT_ALLOWED",
        `策略 ${input.policy.version} 未显式允许 ${issue.source}/${issue.code}/${issue.gate}。`,
      );
    }
    return issue;
  });
  const decisionContent = {
    scopeRef: structuredClone(input.scopeRef),
    reason: input.reason,
    requestedWaivers: requestedWaivers.map((entry) => ({
      issueFingerprint: entry.issueFingerprint,
      gate: entry.gate,
      ...(entry.gate === "EXPORT"
        ? { environmentId: entry.environmentId, channelKey: entry.channelKey }
        : {}),
    })),
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
    policyVersion: input.policy.version,
    policyHash: input.policy.policyHash,
    idempotencyKey: input.idempotencyKey,
    payloadHash,
  };
  const waiverDecisionId = `validation-waiver-decision:${deterministicHash(decisionContent)}`;
  const waivers = targets.map((issue, index): ValidationWaiver => {
    const request = requestedWaivers[index];
    const content = {
      waiverId: `${waiverDecisionId}:${index + 1}`,
      recordHashVersion: VALIDATION_EVIDENCE_RECORD_HASH_VERSION,
      waiverDecisionId,
      issueId: issue.issueId,
      issueFingerprint: issue.fingerprint,
      issueRevision: issue.issueRevision,
      inputHash: issue.inputHash,
      policyVersion: input.policy.version,
      policyHash: input.policy.policyHash,
      gate: request.gate,
      ...(request.gate === "EXPORT"
        ? { environmentId: request.environmentId, channelKey: request.channelKey }
        : {}),
      scopeRef: structuredClone(input.scopeRef),
      reason: input.reason,
      approvedBy: input.approvedBy,
      approvedAt: input.approvedAt,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      evidenceRefs: structuredClone(issue.evidenceRefs),
    };
    const recordHash = deterministicHash(content);
    const state = "FRESH" as const;
    const stateHashVersion = VALIDATION_EVIDENCE_STATE_HASH_VERSION;
    return {
      ...content,
      state,
      stateHashVersion,
      stateHash: deterministicHash({ stateHashVersion, recordHash, state }),
      recordHash,
    };
  });
  const decision: ValidationWaiverDecision = {
    waiverDecisionId,
    ...decisionContent,
    waiverIds: waivers.map((entry) => entry.waiverId),
    decisionHash: deterministicHash({
      ...decisionContent,
      waiverIds: waivers.map((entry) => entry.waiverId),
    }),
  };
  return {
    issues: input.issues.map((issue) => {
      const waiver = waivers.find((entry) => entry.issueFingerprint === issue.fingerprint);
      return waiver ? replaceIssueState(issue, "WAIVED", waiver.waiverId) : structuredClone(issue);
    }),
    decision,
    waivers,
  };
}

export function invalidateValidationEvidence(input: {
  issues: CanonicalValidationIssue[];
  acknowledgements?: ValidationAcknowledgement[];
  waivers?: ValidationWaiver[];
  activeFingerprints: Iterable<string>;
  activeWaiverPolicies?: WaiverPolicyVersion[];
  at?: string;
}): {
  issues: CanonicalValidationIssue[];
  acknowledgements: ValidationAcknowledgement[];
  waivers: ValidationWaiver[];
} {
  if (input.activeWaiverPolicies && !input.at) {
    throw new ValidationIssueContractError(
      "VALIDATION_INVALIDATION_TIME_REQUIRED",
      "按当前 WaiverPolicyVersion 失效证据时必须提供确定的 at 时间。",
    );
  }
  const active = new Set(input.activeFingerprints);
  const issuesByFingerprint = new Map(input.issues.map((issue) => [issue.fingerprint, issue]));
  return {
    issues: input.issues.map((issue) =>
      active.has(issue.fingerprint) || issue.state === "STALE"
        ? structuredClone(issue)
        : replaceIssueState(issue, "STALE")),
    acknowledgements: (input.acknowledgements ?? []).map((entry) =>
      active.has(entry.issueFingerprint) || entry.state === "STALE"
        ? structuredClone(entry)
        : transitionAcknowledgementToStale(entry)),
    waivers: (input.waivers ?? []).map((entry) => {
      const issue = issuesByFingerprint.get(entry.issueFingerprint);
      const activePolicy = input.activeWaiverPolicies?.find((policy) =>
        policy.version === entry.policyVersion
        && policy.policyHash === entry.policyHash
        && policy.status === "PUBLISHED"
        && verifyWaiverPolicyVersion(policy));
      const policyStillAllows = !input.activeWaiverPolicies
        || Boolean(issue && activePolicy && policyAllows(activePolicy, issue, input.at!));
      return entry.state === "STALE"
        || active.has(entry.issueFingerprint) && policyStillAllows
        ? structuredClone(entry)
        : transitionWaiverToStale(entry);
    }),
  };
}

function frozenIssueContentHash(issue: CanonicalValidationIssue): string {
  const content: Partial<CanonicalValidationIssue> = structuredClone(issue);
  Reflect.deleteProperty(content, "issueRevision");
  Reflect.deleteProperty(content, "state");
  Reflect.deleteProperty(content, "waiverRef");
  return deterministicHash(content);
}

export function assertFrozenValidationIssuesMatch(input: {
  frozenIssues: CanonicalValidationIssue[];
  currentIssues: CanonicalValidationIssue[];
  acknowledgements?: ValidationAcknowledgement[];
  waivers?: ValidationWaiver[];
  decisions?: ValidationWaiverDecision[];
}): void {
  for (const frozen of input.frozenIssues) {
    const candidates = input.currentIssues.filter((issue) => issue.fingerprint === frozen.fingerprint);
    if (candidates.length !== 1) {
      throw new ValidationIssueContractError(
        "VALIDATION_FROZEN_ISSUE_MISSING_OR_DUPLICATE",
        `导出命令必须精确携带一次 Snapshot 冻结的 Issue ${frozen.fingerprint}。`,
      );
    }
    const current = candidates[0];
    if (frozenIssueContentHash(current) !== frozenIssueContentHash(frozen)) {
      throw new ValidationIssueContractError(
        "VALIDATION_FROZEN_ISSUE_CONTENT_MISMATCH",
        `Issue ${frozen.fingerprint} 的规范内容与 Snapshot 冻结版本不一致。`,
      );
    }
    if (
      current.issueRevision === frozen.issueRevision
      && current.state === frozen.state
      && current.waiverRef === frozen.waiverRef
    ) {
      continue;
    }
    const acknowledgedFromFrozen = frozen.state === "OPEN"
      && frozen.severity === "WARNING"
      && current.state === "ACKNOWLEDGED"
      && (input.acknowledgements ?? []).some((entry) =>
        verifyValidationAcknowledgement(entry)
        && entry.issueId === frozen.issueId
        && entry.issueFingerprint === frozen.fingerprint
        && entry.inputHash === frozen.inputHash
        && entry.issueRevision === frozen.issueRevision);
    const waivedFromFrozen = frozen.state === "OPEN"
      && frozen.severity === "ERROR"
      && current.state === "WAIVED"
      && (input.waivers ?? []).some((entry) =>
        verifyValidationWaiver(entry)
        && entry.waiverId === current.waiverRef
        && entry.issueId === frozen.issueId
        && entry.issueFingerprint === frozen.fingerprint
        && entry.inputHash === frozen.inputHash
        && entry.issueRevision === frozen.issueRevision);
    if (!acknowledgedFromFrozen && !waivedFromFrozen) {
      throw new ValidationIssueContractError(
        "VALIDATION_FROZEN_ISSUE_REVISION_MISMATCH",
        `Issue ${frozen.fingerprint} 未从 Snapshot 冻结 revision 产生可验证的确认或 Waiver。`,
      );
    }
  }
}

export function assertValidationGateCanProceed(input: {
  issues: CanonicalValidationIssue[];
  gate: Exclude<ValidationIssueGate, "NONE">;
  environmentId?: string;
  channelKey?: string;
  acknowledgements?: ValidationAcknowledgement[];
  waivers?: ValidationWaiver[];
  decisions?: ValidationWaiverDecision[];
  activeWaiverPolicies?: WaiverPolicyVersion[];
  at?: string;
}): void {
  assertExportTarget(input);
  assertValidationWaiverDecisionCoverage({
    waivers: input.waivers,
    decisions: input.decisions,
  });
  const relevantGates = input.gate === "PUBLISH"
    ? new Set<ValidationIssueGate>(["REVIEW", "PUBLISH"])
    : new Set<ValidationIssueGate>([input.gate]);
  const relevant = input.issues.filter((issue) =>
    relevantGates.has(issue.gate)
    && issue.environmentId === input.environmentId
    && issue.channelKey === input.channelKey
    && issue.state !== "RESOLVED"
    && issue.state !== "STALE");
  for (const issue of relevant) {
    if (issue.severity === "INFO") continue;
    if (issue.severity === "BLOCKER") {
      throw new ValidationIssueContractError(issue.code, issue.message);
    }
    if (issue.severity === "WARNING") {
      const acknowledgement = (input.acknowledgements ?? []).find((entry) =>
        entry.state === "FRESH"
        && verifyValidationAcknowledgement(entry)
        && entry.issueId === issue.issueId
        && entry.issueFingerprint === issue.fingerprint
        && entry.inputHash === issue.inputHash
        && issue.issueRevision === deterministicHash({
          issueId: issue.issueId,
          previousRevision: entry.issueRevision,
          state: "ACKNOWLEDGED",
          waiverRef: undefined,
        }));
      if (issue.state !== "ACKNOWLEDGED" || !acknowledgement) {
        throw new ValidationIssueContractError(
          "VALIDATION_WARNING_NOT_ACKNOWLEDGED",
          `${issue.code} 尚无有效 WARNING 确认证据。`,
        );
      }
      continue;
    }
    const waiver = (input.waivers ?? []).find((entry) =>
      entry.state === "FRESH"
      && verifyValidationWaiver(entry)
      && entry.waiverId === issue.waiverRef
      && entry.issueId === issue.issueId
      && entry.issueFingerprint === issue.fingerprint
      && entry.inputHash === issue.inputHash
      && issue.issueRevision === deterministicHash({
        issueId: issue.issueId,
        previousRevision: entry.issueRevision,
        state: "WAIVED",
        waiverRef: entry.waiverId,
      })
      && entry.gate === issue.gate
      && entry.environmentId === issue.environmentId
      && entry.channelKey === issue.channelKey
      && (!entry.expiresAt || !input.at || entry.expiresAt >= input.at));
    const activePolicy = waiver && input.at
      ? (input.activeWaiverPolicies ?? []).find((policy) =>
        policy.version === waiver.policyVersion
        && policy.policyHash === waiver.policyHash
        && policy.status === "PUBLISHED"
        && verifyWaiverPolicyVersion(policy)
        && policyAllows(policy, issue, input.at!))
      : undefined;
    if (issue.state !== "WAIVED" || !waiver || !activePolicy) {
      throw new ValidationIssueContractError(
        "VALIDATION_ERROR_NOT_WAIVED",
        `${issue.code} 是未解决或未获当前有效 WaiverPolicyVersion 支持的 ERROR。`,
      );
    }
  }
}
