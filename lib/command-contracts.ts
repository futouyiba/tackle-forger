import { deterministicHash } from "./rule-kernel";
import type {
  AffinityScoreResult,
  CanonicalValidationIssue,
  HardCompatibilityResult,
  ValidationActionLink,
} from "./types";
import type {
  CapabilityCode,
  EntityRef,
} from "./interaction-contracts";
import { actionAvailability } from "./interaction-contracts";
import { createValidationIssue } from "./validation-issues";

export interface CandidateGenerationRequest {
  requestId: string;
  seriesRef: EntityRef;
  skuRefs: EntityRef[];
  recipeRef: EntityRef;
  recipeInput: Record<string, unknown>;
  maxResults: number;
  sortDefinitionVersion: string;
  inputHash: string;
  idempotencyKey: string;
}

export interface CandidateSortDefinition {
  version: string;
  recipeKeys: string[];
}

export interface CandidateEnumerationInput {
  candidateFingerprint: string;
  skuRef: EntityRef;
  projectionMatchRef: string;
  proposedConfiguration: Record<string, unknown>;
  hardCompatibility: HardCompatibilityResult;
  affinity: AffinityScoreResult;
  invariantIssueCount: number;
  warningCount: number;
  pullDistance: number;
  recipeSortValues: Record<string, string | number>;
  rankReasons: string[];
}

export interface ModelCandidateResult extends CandidateEnumerationInput {
  candidateId: string;
  runId: string;
  rank: number;
  state: "generated" | "shortlisted" | "selected" | "discarded" | "expired" | "superseded";
}

export interface CandidateGenerationRun {
  runId: string;
  requestId: string;
  inputHash: string;
  sortDefinitionVersion: string;
  state: "completed" | "superseded";
  candidates: ModelCandidateResult[];
  enumerationCount: number;
  excludedByHardCompatibility: number;
  truncated: boolean;
  outputHash: string;
}

export interface CandidateRunStore {
  findByIdempotencyKey(key: string): Promise<CandidateGenerationRun | undefined>;
  save(key: string, run: CandidateGenerationRun): Promise<void>;
}

function compareValue(left: string | number | undefined, right: string | number | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

export async function generateModelCandidates(input: {
  request: CandidateGenerationRequest;
  currentInputHash: string;
  sortDefinition: CandidateSortDefinition;
  enumerated: CandidateEnumerationInput[];
  store: CandidateRunStore;
}): Promise<CandidateGenerationRun> {
  const previous = await input.store.findByIdempotencyKey(input.request.idempotencyKey);
  if (previous) {
    if (previous.inputHash !== input.request.inputHash) {
      throw new Error("相同幂等键不能用于不同 inputHash。");
    }
    return structuredClone(previous);
  }
  if (input.sortDefinition.version !== input.request.sortDefinitionVersion) {
    throw new Error("候选排序定义版本不一致。");
  }
  const state = input.currentInputHash === input.request.inputHash
    ? "completed" as const
    : "superseded" as const;
  const allowed = input.enumerated.filter((entry) => entry.hardCompatibility.allowed);
  const sorted = [...allowed].sort((left, right) => {
    for (const key of input.sortDefinition.recipeKeys) {
      const compared = compareValue(left.recipeSortValues[key], right.recipeSortValues[key]);
      if (compared) return compared;
    }
    return (
      left.warningCount - right.warningCount ||
      right.affinity.score - left.affinity.score ||
      left.pullDistance - right.pullDistance ||
      left.candidateFingerprint.localeCompare(right.candidateFingerprint)
    );
  });
  const selected = sorted.slice(0, Math.max(0, input.request.maxResults));
  const runContent = {
    runId: "candidate-run-" + deterministicHash({
      requestId: input.request.requestId,
      inputHash: input.request.inputHash,
      sortVersion: input.sortDefinition.version,
    }),
    requestId: input.request.requestId,
    inputHash: input.request.inputHash,
    sortDefinitionVersion: input.sortDefinition.version,
    state,
    candidates: selected.map((entry, index): ModelCandidateResult => ({
      ...structuredClone(entry),
      candidateId: "candidate-" + deterministicHash({
        sku: entry.skuRef.entityId,
        fingerprint: entry.candidateFingerprint,
        inputHash: input.request.inputHash,
      }),
      runId: "",
      rank: index + 1,
      state: state === "superseded" ? "superseded" : "generated",
    })),
    enumerationCount: input.enumerated.length,
    excludedByHardCompatibility: input.enumerated.length - allowed.length,
    truncated: selected.length < sorted.length,
  };
  for (const candidate of runContent.candidates) candidate.runId = runContent.runId;
  const run: CandidateGenerationRun = {
    ...runContent,
    outputHash: deterministicHash(runContent),
  };
  await input.store.save(input.request.idempotencyKey, run);
  return structuredClone(run);
}

export type UnifiedTraceLayer =
  | "weight_template" | "method" | "type" | "function" | "performance"
  | "quality" | "boundary" | "attribute_affix" | "technology_affix"
  | "series_patch" | "sku_patch" | "model_patch" | "final_review_patch"
  | "rule_suppression" | "projection_pin";

export interface UnifiedTraceEntry {
  traceEntryId: string;
  subjectRef: EntityRef;
  parameterKey: string;
  sequence: number;
  layer: UnifiedTraceLayer;
  sourceVersion: string;
  ruleSetVersion: string;
  before: unknown;
  operation: "set" | "add" | "multiply" | "no_effect";
  operand: unknown;
  after: unknown;
  inputHash: string;
  outputHash: string;
}

function traceOperation(before: unknown, operation: UnifiedTraceEntry["operation"], operand: unknown): unknown {
  if (operation === "no_effect") return before;
  if (operation === "set") return operand;
  if (typeof before !== "number" || typeof operand !== "number") {
    throw new Error("add/multiply Trace 只接受数字。");
  }
  return operation === "add" ? before + operand : before * operand;
}

export function replayUnifiedTrace(input: {
  initialValues: Record<string, unknown>;
  entries: UnifiedTraceEntry[];
}): { values: Record<string, unknown>; replayHash: string } {
  const values = structuredClone(input.initialValues);
  const entries = [...input.entries].sort((left, right) => left.sequence - right.sequence);
  entries.forEach((entry, index) => {
    if (entry.sequence !== index + 1) {
      throw new Error("TRACE_REPLAY_MISMATCH：Trace sequence 不连续。");
    }
    const before = values[entry.parameterKey];
    if (
      deterministicHash({ parameterKey: entry.parameterKey, value: before }) !==
      entry.inputHash
    ) {
      throw new Error("TRACE_REPLAY_MISMATCH：输入 hash 不一致。");
    }
    if (before !== entry.before) {
      throw new Error("TRACE_REPLAY_MISMATCH：before 不一致。");
    }
    const after = traceOperation(before, entry.operation, entry.operand);
    if (
      after !== entry.after ||
      deterministicHash({ parameterKey: entry.parameterKey, value: after }) !==
        entry.outputHash
    ) {
      throw new Error("TRACE_REPLAY_MISMATCH：输出 hash 不一致。");
    }
    values[entry.parameterKey] = after;
  });
  return { values, replayHash: deterministicHash({ values, entries }) };
}

/** @deprecated 使用 CanonicalValidationIssue；保留导出名避免旧调用方复制第三套结构。 */
export type UnifiedValidationIssue = CanonicalValidationIssue;
export type IssueAction = ValidationActionLink;

export function createUnifiedIssue(input: Omit<
  Parameters<typeof createValidationIssue>[0],
  "actions"
> & {
  actionSpecs: Array<{
    actionId: string;
    action: ValidationActionLink["action"];
    label: string;
    command: Parameters<typeof actionAvailability>[0];
    capabilities: CapabilityCode[];
    heldCapabilities: CapabilityCode[];
  }>;
}): UnifiedValidationIssue {
  const { actionSpecs, ...issue } = input;
  return createValidationIssue({
    ...issue,
    actions: actionSpecs.map((spec) => {
      const availability = actionAvailability(
        spec.command,
        spec.heldCapabilities,
        spec.capabilities.some((capability) => !spec.heldCapabilities.includes(capability))
          ? { code: "ISSUE_ACTION_FORBIDDEN", text: "无权执行此修复动作。" }
          : undefined,
      );
      return {
      actionId: spec.actionId,
      action: spec.action,
      label: spec.label,
        enabled: availability.enabled,
        requiredCapabilities: availability.requiredCapabilities,
        disabledReasonCode: availability.disabledReasonCode,
        disabledReasonText: availability.disabledReasonText,
      };
    }),
  });
}

export type PatchWorkflowState =
  | "draft" | "pending_review" | "approved" | "base_changed"
  | "rebase_required" | "rebasing" | "withdrawn" | "superseded";

const PATCH_TRANSITIONS: Record<PatchWorkflowState, PatchWorkflowState[]> = {
  draft: ["pending_review", "withdrawn", "superseded"],
  pending_review: ["approved", "withdrawn", "base_changed", "superseded"],
  approved: ["base_changed", "superseded"],
  base_changed: ["rebase_required", "superseded"],
  rebase_required: ["rebasing", "superseded"],
  rebasing: ["pending_review", "superseded"],
  withdrawn: [],
  superseded: [],
};

export function transitionPatchState(
  current: PatchWorkflowState,
  next: PatchWorkflowState,
): PatchWorkflowState {
  if (!PATCH_TRANSITIONS[current].includes(next)) {
    throw new Error(`非法 Patch 状态迁移：${current} → ${next}。`);
  }
  return next;
}

export type UpgradeWorkflowState =
  | "generated" | "analyzing" | "blocked" | "rebase_required"
  | "ready_for_review" | "approved" | "published_as_new_snapshot"
  | "dismissed" | "superseded";

const UPGRADE_TRANSITIONS: Partial<Record<UpgradeWorkflowState, UpgradeWorkflowState[]>> = {
  generated: ["analyzing", "dismissed", "superseded"],
  analyzing: ["blocked", "rebase_required", "ready_for_review", "superseded"],
  blocked: ["superseded"],
  rebase_required: ["analyzing", "superseded"],
  ready_for_review: ["approved", "dismissed", "superseded"],
  approved: ["published_as_new_snapshot"],
};

export function transitionUpgradeState(
  current: UpgradeWorkflowState,
  next: UpgradeWorkflowState,
): UpgradeWorkflowState {
  if (!(UPGRADE_TRANSITIONS[current] ?? []).includes(next)) {
    throw new Error(`非法 UpgradeCandidate 状态迁移：${current} → ${next}。`);
  }
  return next;
}

export interface VersionedPolicy<T> {
  policyId: string;
  version: string;
  status: "draft" | "published" | "superseded";
  value: T;
}

export function requirePublishedPolicy<T>(
  policies: VersionedPolicy<T>[],
  policyId: string,
  version?: string,
): VersionedPolicy<T> {
  const matching = policies.filter((policy) =>
    policy.policyId === policyId &&
    policy.status === "published" &&
    (!version || policy.version === version),
  );
  if (matching.length !== 1) {
    throw new Error("策略配置不完整：必须明确命中一个已发布版本，不能使用页面默认值。");
  }
  return structuredClone(matching[0]);
}

export function assertSnapshotMutationForbidden(action:
  | "edit" | "recompute" | "rebase" | "replace_hash" | "delete_referenced"
): never {
  throw new Error(`ConfigurationSnapshot 已冻结，禁止 ${action}；请创建新修订或 UpgradeCandidate。`);
}
