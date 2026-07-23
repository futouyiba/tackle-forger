import { deterministicHash } from "./rule-kernel";
import { PATCH_SET_HASH_CONTRACT_VERSION, patchSetHashForReferences } from "./patch-contract";
import { createValidationIssue } from "./validation-issues";
import { isCurrentSeriesSkuSpecification } from "./enabled-item-parts";
import type {
  PatchOffsetPolicyVersion,
  PatchRangeResultEvidence,
  PatchReviewBatch,
  PatchReviewObjectEvidence,
  PatchReviewSubjectRef,
  PatchRevisionRecord,
  PatchSnapshotReference,
  PatchValidationWaiver,
  PatchValidationWaiverDecision,
  SeriesDefinition,
  SkuDrawer,
  ValidationIssue,
  WorkspacePolicyRecord,
} from "./types";

export const CANONICAL_PATCH_OFFSET_POLICY_ID = "patch-offset-policy:open004-v1";
export const CANONICAL_PATCH_OFFSET_POLICY_VERSION = "patch-offset/open004-v1";

const POLICY_VALUE: PatchOffsetPolicyVersion["value"] = {
  mode: "FINAL_RANGE_WITH_MANDATORY_REVIEW",
  offsetThresholds: "NONE",
  rangeEndpoints: "INCLUSIVE",
  applicableScopes: ["series", "sku", "model", "final_review"],
};

function policyContent(policy: Omit<PatchOffsetPolicyVersion, "contentHash">): unknown {
  return policy;
}

export function createCanonicalPatchOffsetPolicyVersion(input: {
  createdAt: string;
  publishedAt: string;
  publishedBy: string;
}): PatchOffsetPolicyVersion {
  const content: Omit<PatchOffsetPolicyVersion, "contentHash"> = {
    policyId: CANONICAL_PATCH_OFFSET_POLICY_ID,
    policyType: "patchOffsetPolicy",
    version: CANONICAL_PATCH_OFFSET_POLICY_VERSION,
    status: "published",
    value: structuredClone(POLICY_VALUE),
    createdAt: input.createdAt,
    publishedAt: input.publishedAt,
    publishedBy: input.publishedBy,
  };
  return { ...content, contentHash: deterministicHash(policyContent(content)) };
}

export class PatchOffsetPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PatchOffsetPolicyError";
  }
}

export function isPatchOffsetPolicyVersion(
  policy: WorkspacePolicyRecord | PatchOffsetPolicyVersion,
): policy is PatchOffsetPolicyVersion {
  if (
    policy.policyType !== "patchOffsetPolicy"
    || typeof (policy as Partial<PatchOffsetPolicyVersion>).contentHash !== "string"
    || typeof (policy as Partial<PatchOffsetPolicyVersion>).publishedBy !== "string"
  ) return false;
  const value = policy.value as Partial<PatchOffsetPolicyVersion["value"]>;
  return value.mode === "FINAL_RANGE_WITH_MANDATORY_REVIEW"
    && value.offsetThresholds === "NONE"
    && value.rangeEndpoints === "INCLUSIVE"
    && Array.isArray(value.applicableScopes)
    && deterministicHash(Object.keys(value).sort()) === deterministicHash([
      "applicableScopes",
      "mode",
      "offsetThresholds",
      "rangeEndpoints",
    ]);
}

export function assertPublishedPatchOffsetPolicy(
  policy: WorkspacePolicyRecord | PatchOffsetPolicyVersion | undefined,
): asserts policy is PatchOffsetPolicyVersion {
  if (!policy) {
    throw new PatchOffsetPolicyError(
      "PATCH_OFFSET_POLICY_MISSING",
      "缺少已发布 PatchOffsetPolicyVersion，批准与发布保持阻断。",
    );
  }
  if (!isPatchOffsetPolicyVersion(policy)) {
    throw new PatchOffsetPolicyError(
      "PATCH_OFFSET_POLICY_INVALID",
      "PatchOffsetPolicyVersion 不是 OPEN-004 允许的固定策略。",
    );
  }
  if (policy.status !== "published" || !policy.publishedAt || !policy.publishedBy) {
    throw new PatchOffsetPolicyError(
      "PATCH_OFFSET_POLICY_NOT_PUBLISHED",
      "PatchOffsetPolicyVersion 尚未发布。",
    );
  }
  const { contentHash, ...content } = policy;
  if (deterministicHash(policyContent(content)) !== contentHash) {
    throw new PatchOffsetPolicyError(
      "PATCH_OFFSET_POLICY_HASH_MISMATCH",
      "PatchOffsetPolicyVersion 完整性校验失败。",
    );
  }
  if (
    policy.value.mode !== POLICY_VALUE.mode
    || policy.value.offsetThresholds !== POLICY_VALUE.offsetThresholds
    || policy.value.rangeEndpoints !== POLICY_VALUE.rangeEndpoints
    || deterministicHash([...policy.value.applicableScopes].sort())
      !== deterministicHash([...POLICY_VALUE.applicableScopes].sort())
  ) {
    throw new PatchOffsetPolicyError(
      "PATCH_OFFSET_POLICY_UNSUPPORTED",
      "策略不得重新引入独立偏移阈值或排除规范作用域。",
    );
  }
}

export function findPublishedPatchOffsetPolicy(
  policies: WorkspacePolicyRecord[],
): PatchOffsetPolicyVersion | undefined {
  const candidates = policies
    .filter((policy) => policy.policyType === "patchOffsetPolicy" && policy.status === "published")
    .sort((left, right) => right.version.localeCompare(left.version));
  const candidate = candidates[0];
  if (!candidate) return undefined;
  assertPublishedPatchOffsetPolicy(candidate);
  return candidate;
}

export interface UnitConversion {
  unit: string;
  standardUnit: string;
  factor: number;
  offset?: number;
}

export const DEFAULT_PATCH_UNIT_CONVERSIONS: UnitConversion[] = [
  { unit: "kg", standardUnit: "kg", factor: 1 },
  { unit: "g", standardUnit: "kg", factor: 0.001 },
  { unit: "kgf", standardUnit: "kgf", factor: 1 },
  { unit: "m", standardUnit: "m", factor: 1 },
  { unit: "cm", standardUnit: "m", factor: 0.01 },
  { unit: "mm", standardUnit: "m", factor: 0.001 },
  { unit: "ratio", standardUnit: "ratio", factor: 1 },
  { unit: "%", standardUnit: "%", factor: 1 },
];

export interface PatchFinalRangeContext {
  contextId: string;
  scopeType: "series" | "sku" | "model" | "final_review";
  itemPartId: string;
  parameterKey: string;
  standardUnit: string;
  subjectRef: PatchReviewSubjectRef;
  objectInputHash: string;
  skuRef?: string;
  targetPullKg?: number;
  projectionId: string;
  weightBandId: string;
  constraintRuleRef: string;
  constraintRuleVersion: string;
  finalValue: number;
  finalValueUnit: string;
  validRange: { min: number; max: number; unit: string };
  patchReferences: PatchSnapshotReference[];
  patchSetHash: string;
  operationTrace: Array<{
    operationId: string;
    parameterKey: string;
    operation: "set" | "add" | "multiply" | "clear";
    before: unknown;
    operand: unknown;
    after: unknown;
  }>;
  traceHash: string;
}

export interface PatchRangeEvaluation {
  policyVersion?: string;
  gate: "REVIEW" | "PUBLISH" | "EXPORT";
  environmentId?: string;
  channelKey?: string;
  contexts: PatchFinalRangeContext[];
  results: PatchRangeResultEvidence[];
  issues: ValidationIssue[];
  inputHash: string;
}

function subjectKey(ref: PatchReviewSubjectRef): string {
  return `${ref.scopeType}:${ref.entityId}@${ref.revision}`;
}

function normalizedPatchReferences(references: PatchSnapshotReference[]): PatchSnapshotReference[] {
  return references.map((reference) => ({
    ...(reference.workspaceId!==undefined?{workspaceId:reference.workspaceId}:{}),
    patchId: reference.patchId,
    patchRevision: reference.patchRevision,
    orderedOperationIds: [...reference.orderedOperationIds],
  }));
}

function frozenPatchSetHash(references:PatchSnapshotReference[]):string{
  return patchSetHashForReferences(
    normalizedPatchReferences(references),
    references.some((reference)=>reference.workspaceId!==undefined)
      ? PATCH_SET_HASH_CONTRACT_VERSION
      : undefined,
  );
}

function normalizeValue(
  value: number,
  unit: string,
  expectedStandardUnit: string,
  conversions: UnitConversion[],
): number {
  if (!Number.isFinite(value)) {
    throw new PatchOffsetPolicyError("PATCH_NON_FINITE_VALUE", "范围校验只接受有限数值。");
  }
  if (unit === expectedStandardUnit) return value;
  const conversion = conversions.find(
    (entry) => entry.unit === unit && entry.standardUnit === expectedStandardUnit,
  );
  if (!conversion || !Number.isFinite(conversion.factor) || conversion.factor === 0) {
    throw new PatchOffsetPolicyError(
      "PATCH_UNIT_INCOMPATIBLE",
      `单位 ${unit} 无法确定性归一到 ${expectedStandardUnit}。`,
    );
  }
  const normalized = value * conversion.factor + (conversion.offset ?? 0);
  if (!Number.isFinite(normalized)) {
    throw new PatchOffsetPolicyError("PATCH_NON_FINITE_VALUE", "单位归一后的数值不是有限数。");
  }
  return normalized;
}

function numericallyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8;
}

function validateOperationTrace(context: PatchFinalRangeContext): void {
  const expectedOperationIds = context.patchReferences.flatMap((reference) => reference.orderedOperationIds);
  if (deterministicHash(expectedOperationIds) !== deterministicHash(context.operationTrace.map((entry) => entry.operationId))) {
    throw new PatchOffsetPolicyError(
      "PATCH_TRACE_OPERATION_ORDER_MISMATCH",
      `上下文 ${context.contextId} 的 Trace 未按冻结 Patch/operation 顺序完整展开。`,
    );
  }
  if (deterministicHash(context.operationTrace) !== context.traceHash) {
    throw new PatchOffsetPolicyError(
      "PATCH_TRACE_HASH_MISMATCH",
      `上下文 ${context.contextId} 的 Trace hash 不一致。`,
    );
  }
  const previousAfter = new Map<string, unknown>();
  for (const entry of context.operationTrace) {
    if (previousAfter.has(entry.parameterKey)) {
      const previous = previousAfter.get(entry.parameterKey);
      const continuous = typeof previous === "number" && typeof entry.before === "number"
        ? numericallyEqual(previous, entry.before)
        : deterministicHash(previous) === deterministicHash(entry.before);
      if (!continuous) {
        throw new PatchOffsetPolicyError(
          "PATCH_TRACE_CHAIN_BROKEN",
          `操作 ${entry.operationId} 的 before 与同参数上一操作 after 不一致。`,
        );
      }
    }
    let replayed: unknown;
    if (entry.operation === "set") {
      replayed = entry.operand;
    } else if (entry.operation === "clear") {
      if (entry.operand !== null) {
        throw new PatchOffsetPolicyError("PATCH_CLEAR_OPERAND_INVALID", "clear 的 operand 必须为 null。");
      }
      if (entry.after === undefined) {
        throw new PatchOffsetPolicyError(
          "PATCH_CLEAR_RESULT_MISSING",
          `操作 ${entry.operationId} 缺少清除本层覆盖后的继承结果。`,
        );
      }
      replayed = entry.after;
    } else {
      if (
        typeof entry.before !== "number"
        || typeof entry.operand !== "number"
        || !Number.isFinite(entry.before)
        || !Number.isFinite(entry.operand)
      ) {
        throw new PatchOffsetPolicyError(
          "PATCH_NUMERIC_OPERATION_INVALID",
          `操作 ${entry.operationId} 的数值类型或单位结果不可信。`,
        );
      }
      replayed = entry.operation === "add"
        ? entry.before + entry.operand
        : entry.before * entry.operand;
    }
    const matches = typeof replayed === "number" && typeof entry.after === "number"
      ? Number.isFinite(entry.after) && numericallyEqual(replayed, entry.after)
      : deterministicHash(replayed) === deterministicHash(entry.after);
    if (!matches) {
      throw new PatchOffsetPolicyError(
        "PATCH_TRACE_REPLAY_MISMATCH",
        `操作 ${entry.operationId} 的 before/operation/operand 无法重放得到 after。`,
      );
    }
    previousAfter.set(entry.parameterKey, entry.after);
  }
}

export function assertPatchRevisionDeterministicallyReplayable(revision: PatchRevisionRecord): void {
  const trace = [...revision.operations]
    .sort((left, right) => left.operationIndex - right.operationIndex || left.operationId.localeCompare(right.operationId))
    .map((operation) => ({
      operationId: operation.operationId,
      parameterKey: operation.parameterKey,
      operation: operation.operation,
      before: operation.before,
      operand: operation.operand,
      after: operation.after,
    }));
  validateOperationTrace({
    contextId: `${revision.patchId}@${revision.patchRevision}`,
    scopeType: revision.scopeType === "derivation" ? "model" : revision.scopeType,
    itemPartId: "ledger",
    parameterKey: "ledger",
    standardUnit: "ledger",
    subjectRef: {
      scopeType: revision.scopeType === "derivation" ? "model" : revision.scopeType,
      entityId: revision.subjectEntityId,
      revision: revision.baseObjectRevision,
    },
    objectInputHash: revision.revisionHash,
    projectionId: revision.baseRuleSetVersion,
    weightBandId: "ledger",
    constraintRuleRef: "ledger",
    constraintRuleVersion: revision.baseRuleSetVersion,
    finalValue: 0,
    finalValueUnit: "ledger",
    validRange: { min: 0, max: 0, unit: "ledger" },
    patchReferences: [{
      patchId: revision.patchId,
      patchRevision: revision.patchRevision,
      orderedOperationIds: trace.map((entry) => entry.operationId),
    }],
    patchSetHash: deterministicHash([{
      patchId: revision.patchId,
      patchRevision: revision.patchRevision,
      orderedOperationIds: trace.map((entry) => entry.operationId),
    }]),
    operationTrace: trace,
    traceHash: deterministicHash(trace),
  });
}

function policyIssue(input: {
  code: string;
  message: string;
  gate: PatchRangeEvaluation["gate"];
  severity: "ERROR" | "BLOCKER";
  context?: PatchFinalRangeContext;
  policyVersion?: string;
  environmentId?: string;
  channelKey?: string;
  evidence?: Record<string, unknown>;
}): ValidationIssue {
  const legacyEvidence = {
    ...(input.context ? {
      contextId: input.context.contextId,
      subjectRef: input.context.subjectRef,
      objectInputHash: input.context.objectInputHash,
      patchSetHash: input.context.patchSetHash,
      traceHash: input.context.traceHash,
    } : {}),
    ...input.evidence,
  };
  const issue = createValidationIssue({
    code: input.code,
    source: input.severity === "BLOCKER" ? "data_integrity" : "patch",
    severity: input.severity,
    gate: input.gate,
    subjectRef: {
      workspaceId: "workspace:patch-authority",
      entityType: input.context?.subjectRef.scopeType ?? "patch_policy",
      entityId: input.context?.subjectRef.entityId ?? input.policyVersion ?? "missing",
      revisionId: String(input.context?.subjectRef.revision ?? input.policyVersion ?? "missing"),
    },
    affectedRefs: [],
    parameterKeys: input.context?.parameterKey ? [input.context.parameterKey] : [],
    title: input.code,
    message: input.message,
    evidenceRefs: [{
      evidenceType: "trace",
      refId: input.context?.contextId ?? `patch-policy:${input.policyVersion ?? "missing"}`,
      revisionId: input.context?.constraintRuleVersion,
      contentHash: deterministicHash(legacyEvidence),
    }],
    ruleRefs: [
      input.policyVersion ?? "patch-offset-policy:missing",
      ...(input.context?.constraintRuleVersion ? [input.context.constraintRuleVersion] : []),
    ],
    inputHash: input.context?.objectInputHash ?? deterministicHash(legacyEvidence),
    fingerprintInputs: {
      contextId: input.context?.contextId,
      patchSetHash: input.context?.patchSetHash,
      constraintRuleVersion: input.context?.constraintRuleVersion,
    },
    ...(input.gate === "EXPORT"
      ? { environmentId: input.environmentId, channelKey: input.channelKey }
      : {}),
  });
  // 旧 PatchOffsetPolicy 读取路径在迁移完成前仍从内联 evidence 取上下文。
  return { ...issue, evidence: legacyEvidence };
}

/**
 * R9 之前的 PatchValidationWaiver 只保存了旧版 patch 专用 fingerprint。
 * 不能改写已发布记录，因此仅用冻结的现有 Issue 上下文重建旧 fingerprint
 * 作兼容比对；Gate、目标及输入/PatchSetHash 仍由 waiverCoversIssue 校验。
 */
function legacyPatchIssueFingerprint(issue: ValidationIssue): string | undefined {
  if (issue.code !== "PATCH_FINAL_VALUE_OUT_OF_RANGE" || issue.source !== "patch") return undefined;
  if (!("ruleRefs" in issue) || !("parameterKeys" in issue)) return undefined;
  const evidence = issue.evidence;
  const contextId = typeof evidence?.contextId === "string" ? evidence.contextId : undefined;
  const subjectRef = evidence?.subjectRef;
  const objectInputHash = typeof evidence?.objectInputHash === "string"
    ? evidence.objectInputHash
    : undefined;
  const patchSetHash = typeof evidence?.patchSetHash === "string" ? evidence.patchSetHash : undefined;
  if (!contextId || !subjectRef || !objectInputHash || !patchSetHash) return undefined;
  return deterministicHash({
    source: "patch",
    code: issue.code,
    gate: issue.gate,
    policyVersion: issue.ruleRefs[0],
    subjectRef,
    objectInputHash,
    contextId,
    parameterKey: issue.parameterKeys[0],
    constraintRuleVersion: issue.ruleRefs[1],
    patchSetHash,
    ...(issue.gate === "EXPORT"
      ? { environmentId: issue.environmentId, channelKey: issue.channelKey }
      : {}),
  });
}

function validateExportTarget(input: {
  gate: PatchRangeEvaluation["gate"];
  environmentId?: string;
  channelKey?: string;
}): void {
  const hasTarget = Boolean(input.environmentId?.trim() && input.channelKey?.trim());
  if (input.gate === "EXPORT" && !hasTarget) {
    throw new PatchOffsetPolicyError(
      "PATCH_EXPORT_TARGET_REQUIRED",
      "EXPORT 范围校验必须精确指定 environmentId 与 channelKey。",
    );
  }
  if (input.gate !== "EXPORT" && (input.environmentId || input.channelKey)) {
    throw new PatchOffsetPolicyError(
      "PATCH_EXPORT_TARGET_NOT_ALLOWED",
      "REVIEW/PUBLISH 校验不得携带导出目标。",
    );
  }
}

export function evaluatePatchFinalRanges(input: {
  policy?: WorkspacePolicyRecord | PatchOffsetPolicyVersion;
  gate: PatchRangeEvaluation["gate"];
  environmentId?: string;
  channelKey?: string;
  contexts: PatchFinalRangeContext[];
  unitConversions?: UnitConversion[];
}): PatchRangeEvaluation {
  validateExportTarget(input);
  const contexts = [...input.contexts].sort((left, right) =>
    subjectKey(left.subjectRef).localeCompare(subjectKey(right.subjectRef))
    || left.contextId.localeCompare(right.contextId)
    || left.parameterKey.localeCompare(right.parameterKey));
  const issues: ValidationIssue[] = [];
  const results: PatchRangeResultEvidence[] = [];
  let policy: PatchOffsetPolicyVersion | undefined;
  try {
    assertPublishedPatchOffsetPolicy(input.policy);
    policy = input.policy;
  } catch (error) {
    const code = error instanceof PatchOffsetPolicyError
      ? error.code
      : "PATCH_OFFSET_POLICY_INVALID";
    issues.push(policyIssue({
      code,
      message: error instanceof Error ? error.message : String(error),
      gate: input.gate,
      severity: "BLOCKER",
      environmentId: input.environmentId,
      channelKey: input.channelKey,
    }));
  }

  const contextKeys = new Set<string>();
  const conversions = input.unitConversions ?? DEFAULT_PATCH_UNIT_CONVERSIONS;
  for (const context of contexts) {
    const key = `${subjectKey(context.subjectRef)}:${context.contextId}:${context.parameterKey}`;
    if (contextKeys.has(key)) {
      issues.push(policyIssue({
        code: "PATCH_RANGE_CONTEXT_DUPLICATE",
        message: `离散范围上下文 ${context.contextId}/${context.parameterKey} 重复。`,
        gate: input.gate,
        severity: "BLOCKER",
        context,
        policyVersion: policy?.version,
        environmentId: input.environmentId,
        channelKey: input.channelKey,
      }));
      continue;
    }
    contextKeys.add(key);
    if (!context.objectInputHash || !context.traceHash || !context.constraintRuleVersion) {
      issues.push(policyIssue({
        code: "PATCH_RANGE_EVIDENCE_INCOMPLETE",
        message: `上下文 ${context.contextId} 缺少输入、Trace 或范围规则版本。`,
        gate: input.gate,
        severity: "BLOCKER",
        context,
        policyVersion: policy?.version,
        environmentId: input.environmentId,
        channelKey: input.channelKey,
      }));
      continue;
    }
    let patchSetHashMatches=false;
    try{patchSetHashMatches=frozenPatchSetHash(context.patchReferences)===context.patchSetHash;}catch{patchSetHashMatches=false;}
    if (!patchSetHashMatches) {
      issues.push(policyIssue({
        code: "PATCH_SET_HASH_MISMATCH",
        message: `上下文 ${context.contextId} 的 PatchSetHash 与有序 Patch 引用不一致。`,
        gate: input.gate,
        severity: "BLOCKER",
        context,
        policyVersion: policy?.version,
        environmentId: input.environmentId,
        channelKey: input.channelKey,
      }));
      continue;
    }
    try {
      validateOperationTrace(context);
      const finalValue = normalizeValue(
        context.finalValue,
        context.finalValueUnit,
        context.standardUnit,
        conversions,
      );
      const min = normalizeValue(
        context.validRange.min,
        context.validRange.unit,
        context.standardUnit,
        conversions,
      );
      const max = normalizeValue(
        context.validRange.max,
        context.validRange.unit,
        context.standardUnit,
        conversions,
      );
      if (min > max) {
        throw new PatchOffsetPolicyError(
          "PATCH_RANGE_RULE_INVALID",
          `参数 ${context.parameterKey} 的最终合法范围上下限颠倒。`,
        );
      }
      const valid = min <= finalValue && finalValue <= max;
      const result: PatchRangeResultEvidence = {
        contextId: context.contextId,
        parameterKey: context.parameterKey,
        standardUnit: context.standardUnit,
        finalValue,
        min,
        max,
        valid,
        ...(context.skuRef ? { skuRef: context.skuRef } : {}),
        ...(context.targetPullKg !== undefined ? { targetPullKg: context.targetPullKg } : {}),
        projectionId: context.projectionId,
        weightBandId: context.weightBandId,
        constraintRuleRef: context.constraintRuleRef,
        constraintRuleVersion: context.constraintRuleVersion,
      };
      if (!valid) {
        const rangeIssue = policyIssue({
          code: "PATCH_FINAL_VALUE_OUT_OF_RANGE",
          message: `${context.parameterKey} 的当前关口累计最终值 ${finalValue}${context.standardUnit} 超出包含端点的合法范围 [${min}, ${max}]${context.standardUnit}。`,
          gate: input.gate,
          severity: "ERROR",
          context,
          policyVersion: policy?.version,
          environmentId: input.environmentId,
          channelKey: input.channelKey,
          evidence: { finalValue, min, max, standardUnit: context.standardUnit },
        });
        result.issueFingerprint = rangeIssue.fingerprint;
        issues.push(rangeIssue);
      }
      results.push(result);
    } catch (error) {
      issues.push(policyIssue({
        code: error instanceof PatchOffsetPolicyError
          ? error.code
          : "PATCH_RANGE_EVALUATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        gate: input.gate,
        severity: "BLOCKER",
        context,
        policyVersion: policy?.version,
        environmentId: input.environmentId,
        channelKey: input.channelKey,
      }));
    }
  }

  const content = {
    policyVersion: policy?.version,
    gate: input.gate,
    environmentId: input.environmentId,
    channelKey: input.channelKey,
    contexts,
    results,
    issues,
  };
  return { ...content, inputHash: deterministicHash(content) };
}

function rangeEvaluationHashContent(
  evaluation: PatchRangeEvaluation,
): Omit<PatchRangeEvaluation, "inputHash"> {
  return {
    policyVersion: evaluation.policyVersion,
    gate: evaluation.gate,
    environmentId: evaluation.environmentId,
    channelKey: evaluation.channelKey,
    contexts: evaluation.contexts,
    results: evaluation.results,
    issues: evaluation.issues,
  };
}

export function assertPatchRangeEvaluationIntegrity(input: {
  evaluation: PatchRangeEvaluation;
  policy: WorkspacePolicyRecord | PatchOffsetPolicyVersion;
  expectedSubjectRef: PatchReviewSubjectRef;
  expectedPatchSetHash: string;
  expectedPatchReferences: PatchSnapshotReference[];
  expectedObjectInputHash?: string;
}): void {
  assertPublishedPatchOffsetPolicy(input.policy);
  const recomputed = evaluatePatchFinalRanges({
    policy: input.policy,
    gate: input.evaluation.gate,
    environmentId: input.evaluation.environmentId,
    channelKey: input.evaluation.channelKey,
    contexts: input.evaluation.contexts,
  });
  if (
    deterministicHash(rangeEvaluationHashContent(input.evaluation)) !== input.evaluation.inputHash
    || recomputed.inputHash !== input.evaluation.inputHash
    || deterministicHash(recomputed) !== deterministicHash(input.evaluation)
  ) {
    throw new PatchOffsetPolicyError(
      "PATCH_RANGE_EVALUATION_HASH_MISMATCH",
      "Patch 范围评估已被修改或无法按冻结输入重算。",
    );
  }
  const matchingContexts = input.evaluation.contexts.filter((context) =>
    subjectKey(context.subjectRef) === subjectKey(input.expectedSubjectRef));
  if (!matchingContexts.length) {
    throw new PatchOffsetPolicyError(
      "PATCH_RANGE_EVALUATION_SUBJECT_MISSING",
      "Patch 范围评估未覆盖当前对象及 revision。",
    );
  }
  const expectedReferencesHash = deterministicHash(
    normalizedPatchReferences(input.expectedPatchReferences),
  );
  for (const context of matchingContexts) {
    if (
      context.patchSetHash !== input.expectedPatchSetHash
      || deterministicHash(normalizedPatchReferences(context.patchReferences)) !== expectedReferencesHash
    ) {
      throw new PatchOffsetPolicyError(
        "PATCH_RANGE_EVALUATION_PATCH_SET_MISMATCH",
        `上下文 ${context.contextId} 未冻结当前对象的完整有序 Patch 集合。`,
      );
    }
    if (
      input.expectedObjectInputHash !== undefined
      && context.objectInputHash !== input.expectedObjectInputHash
    ) {
      throw new PatchOffsetPolicyError(
        "PATCH_RANGE_EVALUATION_INPUT_STALE",
        `上下文 ${context.contextId} 的对象输入已经变化。`,
      );
    }
    const hasResult = input.evaluation.results.some((result) =>
      result.contextId === context.contextId && result.parameterKey === context.parameterKey);
    const hasIssue = input.evaluation.issues.some((issue) =>
      issue.evidence?.contextId === context.contextId);
    if (!hasResult && !hasIssue) {
      throw new PatchOffsetPolicyError(
        "PATCH_RANGE_EVALUATION_RESULT_MISSING",
        `上下文 ${context.contextId}/${context.parameterKey} 没有范围结果或完整性 Issue。`,
      );
    }
  }
}

export function assertRangeEvaluationMatchesPatchRevisions(input: {
  evaluation: PatchRangeEvaluation;
  revisions: PatchRevisionRecord[];
}): void {
  const revisions = new Map(input.revisions.map((revision) => [
    `${revision.patchId}@${revision.patchRevision}`,
    revision,
  ]));
  for (const context of input.evaluation.contexts) {
    const traceById = new Map(context.operationTrace.map((entry) => [entry.operationId, entry]));
    for (const reference of context.patchReferences) {
      const revision = revisions.get(`${reference.patchId}@${reference.patchRevision}`);
      if (!revision || revision.revisionHash === "") {
        throw new PatchOffsetPolicyError(
          "PATCH_REVISION_EVIDENCE_MISSING",
          `范围校验引用的 ${reference.patchId}@${reference.patchRevision} 不在待发布 Patch 集合中。`,
        );
      }
      const operationById = new Map(revision.operations.map((operation) => [operation.operationId, operation]));
      for (const operationId of reference.orderedOperationIds) {
        const operation = operationById.get(operationId);
        const trace = traceById.get(operationId);
        if (!operation || !trace || deterministicHash({
          parameterKey: operation.parameterKey,
          operation: operation.operation,
          operand: operation.operand,
          before: operation.before,
          after: operation.after,
        }) !== deterministicHash({
          parameterKey: trace.parameterKey,
          operation: trace.operation,
          operand: trace.operand,
          before: trace.before,
          after: trace.after,
        })) {
          throw new PatchOffsetPolicyError(
            "PATCH_TRACE_LEDGER_MISMATCH",
            `范围校验 Trace 与权威账本操作 ${operationId} 不一致。`,
          );
        }
      }
    }
  }
}

export function expectedSeriesDiscreteRangeContexts(input: {
  series: SeriesDefinition;
  skus: SkuDrawer[];
}): Array<{ skuRef?: string; targetPullKg: number }> {
  const realSkus = input.skus
    .filter((sku) => isCurrentSeriesSkuSpecification(input.series, sku))
    .sort((left, right) => left.targetPullKg - right.targetPullKg || left.id.localeCompare(right.id));
  if (realSkus.length) {
    return realSkus.map((sku) => ({ skuRef: sku.id, targetPullKg: sku.targetPullKg }));
  }
  return [...input.series.targetPullSpecifications]
    .sort((left, right) => left.targetPullKgf - right.targetPullKgf || left.skuId.localeCompare(right.skuId))
    .map((specification) => ({ targetPullKg: specification.targetPullKgf }));
}

export function assertSeriesDiscreteRangeCoverage(input: {
  expected: Array<{ skuRef?: string; targetPullKg: number }>;
  contexts: PatchFinalRangeContext[];
}): void {
  const actual = new Set(input.contexts.map((context) =>
    context.skuRef ? `sku:${context.skuRef}` : `pull:${context.targetPullKg}`));
  const missing = input.expected.filter((entry) =>
    !actual.has(entry.skuRef ? `sku:${entry.skuRef}` : `pull:${entry.targetPullKg}`));
  if (missing.length) {
    throw new PatchOffsetPolicyError(
      "PATCH_SERIES_DISCRETE_CONTEXT_MISSING",
      `Series 范围校验缺少离散上下文：${missing.map((entry) => entry.skuRef ?? `${entry.targetPullKg}kg`).join("、")}。`,
    );
  }
}

export function createPatchReviewBatch(input: {
  evaluation: PatchRangeEvaluation;
  reviewedBy: string;
  reviewedAt: string;
}): PatchReviewBatch {
  if (!input.evaluation.policyVersion) {
    throw new PatchOffsetPolicyError(
      "PATCH_OFFSET_POLICY_MISSING",
      "没有有效策略版本时不能形成整体复核证据。",
    );
  }
  if (input.evaluation.gate === "EXPORT") {
    throw new PatchOffsetPolicyError(
      "PATCH_REVIEW_GATE_INVALID",
      "整体 Patch 复核批次只能用于 REVIEW 或 PUBLISH。",
    );
  }
  if (input.evaluation.issues.some((issue) => issue.severity === "BLOCKER" && issue.state === "OPEN")) {
    throw new PatchOffsetPolicyError(
      "PATCH_REVIEW_INTEGRITY_BLOCKED",
      "完整性 BLOCKER 未解决，不能形成人工复核证据。",
    );
  }
  const contextsBySubject = new Map<string, PatchFinalRangeContext[]>();
  for (const context of input.evaluation.contexts) {
    const key = subjectKey(context.subjectRef);
    contextsBySubject.set(key, [...(contextsBySubject.get(key) ?? []), context]);
  }
  const objectEvidence: PatchReviewObjectEvidence[] = [...contextsBySubject.values()]
    .map((contexts) => {
      const first = contexts[0];
      if (contexts.some((context) =>
        context.objectInputHash !== first.objectInputHash
        || context.patchSetHash !== first.patchSetHash
        || deterministicHash(context.patchReferences) !== deterministicHash(first.patchReferences))) {
        throw new PatchOffsetPolicyError(
          "PATCH_REVIEW_OBJECT_EVIDENCE_CONFLICT",
          `对象 ${first.subjectRef.entityId} 的复核输入或 Patch 集合不一致。`,
        );
      }
      const contextIds = new Set(contexts.map((context) => context.contextId));
      const rangeResults = input.evaluation.results.filter((result) => contextIds.has(result.contextId));
      const issueFingerprints = input.evaluation.issues
        .filter((issue) => contextIds.has(String(issue.evidence?.contextId)) && issue.fingerprint)
        .map((issue) => issue.fingerprint as string)
        .sort();
      return {
        subjectRef: structuredClone(first.subjectRef),
        objectInputHash: first.objectInputHash,
        patchReferences: structuredClone(first.patchReferences),
        patchSetHash: first.patchSetHash,
        finalValues: Object.fromEntries(rangeResults.map((result) => [
          `${result.contextId}:${result.parameterKey}`,
          result.finalValue,
        ])),
        rangeResults: structuredClone(rangeResults),
        issueFingerprints,
        state: "FRESH" as const,
      };
    })
    .sort((left, right) => subjectKey(left.subjectRef).localeCompare(subjectKey(right.subjectRef)));
  if (!objectEvidence.length) {
    throw new PatchOffsetPolicyError("PATCH_REVIEW_BATCH_EMPTY", "复核批次至少需要一个对象。");
  }
  const content = reviewBatchHashContent({
    policyVersion: input.evaluation.policyVersion,
    gate: input.evaluation.gate,
    objectEvidence,
    reviewedBy: input.reviewedBy,
    reviewedAt: input.reviewedAt,
  });
  const inputHash = deterministicHash(content);
  return {
    batchId: `patch-review:${inputHash}`,
    policyVersion: input.evaluation.policyVersion,
    gate: input.evaluation.gate,
    objectEvidence,
    reviewedBy: input.reviewedBy,
    reviewedAt: input.reviewedAt,
    status: "FRESH",
    inputHash,
  };
}

function reviewBatchHashContent(input: {
  policyVersion: string;
  gate: PatchReviewBatch["gate"];
  objectEvidence: PatchReviewObjectEvidence[];
  reviewedBy: string;
  reviewedAt: string;
}): {
  policyVersion: string;
  gate: PatchReviewBatch["gate"];
  objectEvidence: Array<Partial<PatchReviewObjectEvidence>>;
  reviewedBy: string;
  reviewedAt: string;
} {
  return {
    policyVersion: input.policyVersion,
    gate: input.gate,
    objectEvidence: input.objectEvidence.map((evidence) => {
      const frozen = { ...evidence } as Partial<PatchReviewObjectEvidence>;
      delete frozen.state;
      return frozen;
    }),
    reviewedBy: input.reviewedBy,
    reviewedAt: input.reviewedAt,
  };
}

export function verifyPatchReviewBatchIntegrity(batch: PatchReviewBatch): boolean {
  return deterministicHash(reviewBatchHashContent(batch)) === batch.inputHash
    && batch.batchId === `patch-review:${batch.inputHash}`;
}

export function invalidatePatchReviewBatch(input: {
  batch: PatchReviewBatch;
  currentObjectInputHashes: Record<string, string>;
}): PatchReviewBatch {
  const objectEvidence = input.batch.objectEvidence.map((evidence) => ({
    ...evidence,
    state: input.currentObjectInputHashes[subjectKey(evidence.subjectRef)] === evidence.objectInputHash
      ? "FRESH" as const
      : "STALE" as const,
  }));
  const staleCount = objectEvidence.filter((evidence) => evidence.state === "STALE").length;
  return {
    ...input.batch,
    objectEvidence,
    status: staleCount === 0
      ? "FRESH"
      : staleCount === objectEvidence.length ? "STALE" : "PARTIALLY_STALE",
  };
}

export function findPatchReviewEvidence(input: {
  batch: PatchReviewBatch;
  subjectRef: PatchReviewSubjectRef;
  objectInputHash: string;
  patchSetHash: string;
  patchReference?: PatchSnapshotReference;
}): PatchReviewObjectEvidence | undefined {
  return input.batch.objectEvidence.find((evidence) =>
    evidence.state === "FRESH"
    && subjectKey(evidence.subjectRef) === subjectKey(input.subjectRef)
    && evidence.objectInputHash === input.objectInputHash
    && evidence.patchSetHash === input.patchSetHash
    && (!input.patchReference || evidence.patchReferences.some((reference) =>
      reference.patchId === input.patchReference?.patchId
      && reference.patchRevision === input.patchReference.patchRevision
      && deterministicHash(reference.orderedOperationIds)
        === deterministicHash(input.patchReference.orderedOperationIds))));
}

export function assertPatchReviewCoverage(input: {
  batch?: PatchReviewBatch;
  policyVersion: string;
  subjectRef: PatchReviewSubjectRef;
  objectInputHash: string;
  patchSetHash: string;
  patchReference?: PatchSnapshotReference;
}): PatchReviewObjectEvidence {
  if (input.batch && !verifyPatchReviewBatchIntegrity(input.batch)) {
    throw new PatchOffsetPolicyError(
      "PATCH_REVIEW_EVIDENCE_HASH_MISMATCH",
      "整体人工复核证据完整性校验失败。",
    );
  }
  if (!input.batch || input.batch.policyVersion !== input.policyVersion) {
    throw new PatchOffsetPolicyError(
      "PATCH_REVIEW_EVIDENCE_MISSING",
      "当前策略和对象输入缺少匹配的整体人工复核证据。",
    );
  }
  const evidence = findPatchReviewEvidence({ ...input, batch: input.batch });
  if (!evidence) {
    throw new PatchOffsetPolicyError(
      "PATCH_REVIEW_EVIDENCE_STALE",
      "Patch、对象 revision 或计算输入变化后，旧整体复核证据不可沿用。",
    );
  }
  return evidence;
}

export function createPatchValidationWaiverDecision(input: {
  issues: ValidationIssue[];
  requested: Array<{
    issueFingerprint: string;
    gate: "REVIEW" | "PUBLISH" | "EXPORT";
    environmentId?: string;
    channelKey?: string;
  }>;
  policyVersion: string;
  scopeRef: PatchReviewSubjectRef;
  objectInputHash: string;
  patchSetHash: string;
  reason: string;
  approvedBy: string;
  approvedAt: string;
}): { decision: PatchValidationWaiverDecision; waivers: PatchValidationWaiver[] } {
  if (!input.requested.length || !input.reason.trim()) {
    throw new PatchOffsetPolicyError(
      "PATCH_WAIVER_REQUEST_INVALID",
      "Waiver 决定必须包含目标和人工理由。",
    );
  }
  const requestTargets = input.requested.map((request) => JSON.stringify([
    request.issueFingerprint,
    request.gate,
    request.environmentId ?? null,
    request.channelKey ?? null,
  ]));
  if (new Set(requestTargets).size !== requestTargets.length) {
    throw new PatchOffsetPolicyError(
      "PATCH_WAIVER_TARGET_DUPLICATE",
      "同一个 Issue/Gate/导出目标只能在一次 WaiverDecision 中出现一次。",
    );
  }
  const issueByFingerprint = new Map(input.issues.map((issue) => [issue.fingerprint, issue]));
  for (const request of input.requested) {
    validateExportTarget(request);
    const issue = issueByFingerprint.get(request.issueFingerprint);
    if (
      !issue
      || issue.code !== "PATCH_FINAL_VALUE_OUT_OF_RANGE"
      || issue.severity !== "ERROR"
      || issue.state !== "OPEN"
      || issue.gate !== request.gate
      || issue.environmentId !== request.environmentId
      || issue.channelKey !== request.channelKey
    ) {
      throw new PatchOffsetPolicyError(
        "PATCH_WAIVER_TARGET_INVALID",
        `Issue ${request.issueFingerprint} 不允许由当前 Gate/目标的 Waiver 放行。`,
      );
    }
    if (
      issue.evidence?.objectInputHash !== input.objectInputHash
      || issue.evidence?.patchSetHash !== input.patchSetHash
    ) {
      throw new PatchOffsetPolicyError(
        "PATCH_WAIVER_INPUT_STALE",
        `Issue ${request.issueFingerprint} 的输入或 PatchSetHash 已变化。`,
      );
    }
  }
  const decisionContent = {
    scopeRef: input.scopeRef,
    requested: [...input.requested].sort((left, right) =>
      left.issueFingerprint.localeCompare(right.issueFingerprint)
      || left.gate.localeCompare(right.gate)
      || (left.environmentId ?? "").localeCompare(right.environmentId ?? "")
      || (left.channelKey ?? "").localeCompare(right.channelKey ?? "")),
    policyVersion: input.policyVersion,
    objectInputHash: input.objectInputHash,
    patchSetHash: input.patchSetHash,
    reason: input.reason,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
  };
  const decisionHash = deterministicHash(decisionContent);
  const waiverDecisionId = `patch-waiver-decision:${decisionHash}`;
  const waivers = decisionContent.requested.map((request, index): PatchValidationWaiver => ({
    waiverId: `${waiverDecisionId}:${index + 1}`,
    waiverDecisionId,
    issueFingerprint: request.issueFingerprint,
    policyVersion: input.policyVersion,
    gate: request.gate,
    ...(request.gate === "EXPORT"
      ? { environmentId: request.environmentId, channelKey: request.channelKey }
      : {}),
    scopeRef: structuredClone(input.scopeRef),
    objectInputHash: input.objectInputHash,
    patchSetHash: input.patchSetHash,
    reason: input.reason,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
  }));
  const decision: PatchValidationWaiverDecision = {
    waiverDecisionId,
    scopeRef: structuredClone(input.scopeRef),
    reason: input.reason,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
    waiverIds: waivers.map((waiver) => waiver.waiverId),
    decisionHash,
  };
  return { decision, waivers };
}

export function assertPatchValidationWaiverDecisionCoverage(input: {
  waivers?: PatchValidationWaiver[];
  decisions?: PatchValidationWaiverDecision[];
}): void {
  const waivers = input.waivers ?? [];
  const decisions = input.decisions ?? [];
  if (!waivers.length && !decisions.length) return;
  if (!decisions.length) {
    throw new PatchOffsetPolicyError(
      "PATCH_WAIVER_DECISION_EVIDENCE_MISSING",
      "Patch Waiver 必须由完整的 ValidationWaiverDecision 冻结并验证。",
    );
  }
  if (
    new Set(waivers.map((waiver) => waiver.waiverId)).size !== waivers.length
    || new Set(decisions.map((decision) => decision.waiverDecisionId)).size !== decisions.length
  ) {
    throw new PatchOffsetPolicyError(
      "PATCH_WAIVER_DECISION_EVIDENCE_INVALID",
      "Patch Waiver 与 WaiverDecision 的稳定 ID 必须唯一。",
    );
  }
  const waiversById = new Map(waivers.map((waiver) => [waiver.waiverId, waiver]));
  const referencedIds = new Set<string>();
  for (const decision of decisions) {
    if (!decision.waiverIds.length || new Set(decision.waiverIds).size !== decision.waiverIds.length) {
      throw new PatchOffsetPolicyError(
        "PATCH_WAIVER_DECISION_EVIDENCE_INVALID",
        "Patch WaiverDecision 必须一次且仅一次引用每个 Waiver。",
      );
    }
    const decisionWaivers = decision.waiverIds.map((waiverId) => {
      if (referencedIds.has(waiverId)) {
        throw new PatchOffsetPolicyError(
          "PATCH_WAIVER_DECISION_EVIDENCE_INVALID",
          "同一个 Patch Waiver 不能被多个 WaiverDecision 重复引用。",
        );
      }
      referencedIds.add(waiverId);
      const waiver = waiversById.get(waiverId);
      if (!waiver || waiver.waiverDecisionId !== decision.waiverDecisionId) {
        throw new PatchOffsetPolicyError(
          "PATCH_WAIVER_DECISION_EVIDENCE_INVALID",
          "Patch WaiverDecision 与 Waiver 的引用关系不完整或不匹配。",
        );
      }
      return waiver;
    });
    const first = decisionWaivers[0]!;
    if (decisionWaivers.some((waiver) =>
      deterministicHash(waiver.scopeRef) !== deterministicHash(decision.scopeRef)
      || waiver.reason !== decision.reason
      || waiver.approvedBy !== decision.approvedBy
      || waiver.approvedAt !== decision.approvedAt
      || waiver.policyVersion !== first.policyVersion
      || waiver.objectInputHash !== first.objectInputHash
      || waiver.patchSetHash !== first.patchSetHash)) {
      throw new PatchOffsetPolicyError(
        "PATCH_WAIVER_DECISION_EVIDENCE_INVALID",
        "Patch WaiverDecision 的审批上下文必须与全部原子 Waiver 完全一致。",
      );
    }
    const requested = decisionWaivers.map((waiver) => ({
      issueFingerprint: waiver.issueFingerprint,
      gate: waiver.gate,
      ...(waiver.gate === "EXPORT"
        ? { environmentId: waiver.environmentId, channelKey: waiver.channelKey }
        : {}),
    })).sort((left, right) =>
      left.issueFingerprint.localeCompare(right.issueFingerprint)
      || left.gate.localeCompare(right.gate)
      || (left.environmentId ?? "").localeCompare(right.environmentId ?? "")
      || (left.channelKey ?? "").localeCompare(right.channelKey ?? ""));
    const atomicTargets = requested.map((request) => JSON.stringify([
      request.issueFingerprint,
      request.gate,
      request.environmentId ?? null,
      request.channelKey ?? null,
    ]));
    if (new Set(atomicTargets).size !== atomicTargets.length) {
      throw new PatchOffsetPolicyError(
        "PATCH_WAIVER_DECISION_EVIDENCE_INVALID",
        "Patch WaiverDecision 不能冻结重复的原子 Waiver 目标。",
      );
    }
    const decisionContent = {
      scopeRef: decision.scopeRef,
      requested,
      policyVersion: first.policyVersion,
      objectInputHash: first.objectInputHash,
      patchSetHash: first.patchSetHash,
      reason: decision.reason,
      approvedBy: decision.approvedBy,
      approvedAt: decision.approvedAt,
    };
    const decisionHash = deterministicHash(decisionContent);
    if (
      decision.decisionHash !== decisionHash
      || decision.waiverDecisionId !== `patch-waiver-decision:${decisionHash}`
    ) {
      throw new PatchOffsetPolicyError(
        "PATCH_WAIVER_DECISION_EVIDENCE_INVALID",
        "Patch WaiverDecision 的冻结哈希校验失败。",
      );
    }
  }
  if (referencedIds.size !== waivers.length) {
    throw new PatchOffsetPolicyError(
      "PATCH_WAIVER_DECISION_EVIDENCE_INVALID",
      "Patch Waiver 不能脱离 WaiverDecision 单独用于正式关口。",
    );
  }
}

export function waiverCoversIssue(
  waiver: PatchValidationWaiver,
  issue: ValidationIssue,
): boolean {
  return issue.code === "PATCH_FINAL_VALUE_OUT_OF_RANGE"
    && issue.severity === "ERROR"
    && (issue.fingerprint === waiver.issueFingerprint
      || legacyPatchIssueFingerprint(issue) === waiver.issueFingerprint)
    && issue.gate === waiver.gate
    && issue.environmentId === waiver.environmentId
    && issue.channelKey === waiver.channelKey
    && issue.evidence?.objectInputHash === waiver.objectInputHash
    && issue.evidence?.patchSetHash === waiver.patchSetHash;
}

export function assertPatchGateCanProceed(input: {
  evaluation: PatchRangeEvaluation;
  waivers?: PatchValidationWaiver[];
}): void {
  const openIssues = input.evaluation.issues.filter((issue) => issue.state === "OPEN");
  const blocker = openIssues.find((issue) => issue.severity === "BLOCKER");
  if (blocker) {
    throw new PatchOffsetPolicyError(blocker.code, blocker.message);
  }
  const uncovered = openIssues.filter((issue) =>
    issue.severity === "ERROR"
    && !(input.waivers ?? []).some((waiver) =>
      waiver.policyVersion === input.evaluation.policyVersion
      && waiverCoversIssue(waiver, issue)));
  if (uncovered.length) {
    throw new PatchOffsetPolicyError(
      uncovered[0].code,
      `当前 ${input.evaluation.gate} 关口仍有未获匹配 Waiver 的 Patch ERROR。`,
    );
  }
}

export function nextPatchStateAfterBaseChange(input: {
  revision: PatchRevisionRecord;
  parameterTypeAndUnitCompatible: boolean;
  clearStillMeansInheritedOverride: boolean;
}): "PENDING_REVIEW" | "REBASE_REQUIRED" {
  if (input.revision.scopeType === "final_review") return "PENDING_REVIEW";
  if (!input.parameterTypeAndUnitCompatible) return "REBASE_REQUIRED";
  if (input.revision.operations.some((operation) => operation.operation === "set")) {
    return "REBASE_REQUIRED";
  }
  if (
    input.revision.operations.some((operation) => operation.operation === "clear")
    && !input.clearStillMeansInheritedOverride
  ) return "REBASE_REQUIRED";
  return "PENDING_REVIEW";
}
