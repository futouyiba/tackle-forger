import { deterministicHash } from "./rule-kernel";
import type {
  CanonicalValidationIssue,
  LegacyValidationIssue,
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
  return "issueId" in issue && "subjectRef" in issue && "fingerprintVersion" in issue;
}

export function validationIssueSeverity(issue: ValidationIssue): ValidationIssueSeverity {
  if ("severity" in issue && issue.severity) return issue.severity;
  return issue.level === "error" ? "ERROR" : issue.level === "warning" ? "WARNING" : "INFO";
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
  legacy: LegacyValidationIssue,
  context: AdaptLegacyValidationIssueContext,
): CanonicalValidationIssue {
  const mode = context.mode ?? "historical";
  const gate = context.gate ?? "NONE";
  const originalPayloadHash = deterministicHash(legacy);
  const canonical = createValidationIssue({
    code: legacy.code,
    source: legacy.source ?? context.source ?? "import",
    severity: legacy.severity
      ?? (legacy.level === "error" ? "ERROR" : legacy.level === "warning" ? "WARNING" : "INFO"),
    gate,
    subjectRef: context.subjectRef,
    parameterKeys: legacy.parameterKey ? [legacy.parameterKey] : [],
    title: legacy.code,
    message: legacy.message,
    evidenceRefs: [{
      evidenceType: "validation_issue",
      refId: `legacy-validation-issue:${originalPayloadHash}`,
      contentHash: originalPayloadHash,
    }],
    ruleRefs: context.ruleRefs,
    state: mode === "historical" ? "STALE" : legacy.state ?? "OPEN",
    inputHash: context.inputHash,
    fingerprintInputs: {
      legacyFingerprint: legacy.fingerprint,
      originalPayloadHash,
      evidence: legacy.evidence,
    },
    ...(gate === "EXPORT"
      ? {
        environmentId: context.environmentId ?? legacy.environmentId,
        channelKey: context.channelKey ?? legacy.channelKey,
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
  return issues.map((issue) =>
    isCanonicalValidationIssue(issue)
      ? structuredClone(issue)
      : adaptLegacyValidationIssue(issue, context));
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
  const { acknowledgementId, recordHash, ...content } = acknowledgement;
  return acknowledgementId === `validation-ack:${recordHash}`
    && deterministicHash(content) === recordHash;
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
    state: "FRESH" as const,
    evidenceRefs: structuredClone(input.issue.evidenceRefs),
  };
  const recordHash = deterministicHash(content);
  return {
    issue: replaceIssueState(input.issue, "ACKNOWLEDGED"),
    acknowledgement: {
      acknowledgementId: `validation-ack:${recordHash}`,
      ...content,
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
  const { recordHash, ...content } = waiver;
  return deterministicHash(content) === recordHash;
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
  return decision.waiverDecisionId === `validation-waiver-decision:${decision.decisionHash}`
    && deterministicHash(content) === decision.decisionHash;
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
  const decisionHash = deterministicHash(decisionContent);
  const waiverDecisionId = `validation-waiver-decision:${decisionHash}`;
  const waivers = targets.map((issue, index): ValidationWaiver => {
    const request = requestedWaivers[index];
    const content = {
      waiverId: `${waiverDecisionId}:${index + 1}`,
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
      state: "FRESH" as const,
      evidenceRefs: structuredClone(issue.evidenceRefs),
    };
    return { ...content, recordHash: deterministicHash(content) };
  });
  const decision: ValidationWaiverDecision = {
    waiverDecisionId,
    ...decisionContent,
    waiverIds: waivers.map((entry) => entry.waiverId),
    decisionHash,
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
}): {
  issues: CanonicalValidationIssue[];
  acknowledgements: ValidationAcknowledgement[];
  waivers: ValidationWaiver[];
} {
  const active = new Set(input.activeFingerprints);
  return {
    issues: input.issues.map((issue) =>
      active.has(issue.fingerprint) ? structuredClone(issue) : replaceIssueState(issue, "STALE")),
    acknowledgements: (input.acknowledgements ?? []).map((entry) =>
      active.has(entry.issueFingerprint)
        ? structuredClone(entry)
        : { ...structuredClone(entry), state: "STALE" }),
    waivers: (input.waivers ?? []).map((entry) =>
      active.has(entry.issueFingerprint)
        ? structuredClone(entry)
        : { ...structuredClone(entry), state: "STALE" }),
  };
}

export function assertValidationGateCanProceed(input: {
  issues: CanonicalValidationIssue[];
  gate: Exclude<ValidationIssueGate, "NONE">;
  environmentId?: string;
  channelKey?: string;
  acknowledgements?: ValidationAcknowledgement[];
  waivers?: ValidationWaiver[];
  at?: string;
}): void {
  assertExportTarget(input);
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
    if (issue.state !== "WAIVED" || !waiver) {
      throw new ValidationIssueContractError(
        "VALIDATION_ERROR_NOT_WAIVED",
        `${issue.code} 是未解决且未获有效策略 Waiver 的 ERROR。`,
      );
    }
  }
}
