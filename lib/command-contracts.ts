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
import {
  adaptLegacyUnifiedTraceToCanonical,
  calculationTraceValuesEqual,
  CalculationTraceReplayError,
  replayCalculationTrace,
  type CalculationTraceStateValue,
} from "./calculation-trace";

export {
  CALCULATION_TRACE_ABSENT_VALUE,
  CALCULATION_TRACE_HASH_CONTRACT_VERSION,
  CALCULATION_TRACE_REPLAY_CONTRACT_VERSION,
  CALCULATION_TRACE_SCHEMA_VERSION,
  adaptFiveAxisTraceToCanonical,
  adaptLegacyCalculationTraceToCanonical,
  adaptLegacyUnifiedTraceToCanonical,
  adaptPatchTraceToCanonical,
  adaptPricingTraceToCanonical,
  adaptProjectionTraceToCanonical,
  adaptRuleTraceToCanonical,
  assertCalculationTraceJsonSafe,
  assertCalculationTraceMatchesFinalPanel,
  calculationTraceValuesEqual,
  createCalculationTraceArchive,
  createCalculationTraceEntry,
  isCalculationTraceAbsentValue,
  replayCalculationTrace,
  tryReplayCalculationTrace,
  verifyCalculationTraceArchive,
} from "./calculation-trace";
export type {
  CalculationTraceActionLink,
  CalculationTraceArchive,
  CalculationTraceEffect,
  CalculationTraceEntry,
  CalculationTraceEntryRef,
  CalculationTraceLayer,
  CalculationTraceOperation,
  CalculationTraceReplayIssue,
  CalculationTraceStateValue,
} from "./calculation-trace";

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

export function replayUnifiedTrace(input: {
  initialValues: Record<string, unknown>;
  entries: UnifiedTraceEntry[];
}): { values: Record<string, unknown>; replayHash: string } {
  for (const entry of input.entries) {
    if (
      deterministicHash({ parameterKey: entry.parameterKey, value: entry.before })
        !== entry.inputHash
      || deterministicHash({ parameterKey: entry.parameterKey, value: entry.after })
        !== entry.outputHash
    ) {
      throw new CalculationTraceReplayError(
        `旧 UnifiedTraceEntry hash 不一致：${entry.parameterKey}。`,
      );
    }
  }
  const entries = adaptLegacyUnifiedTraceToCanonical(input.entries);
  const firstSubject = entries[0]?.subjectRef;
  const fallbackSubject: EntityRef = firstSubject ?? {
    workspaceId: "legacy",
    entityType: "model",
    entityId: "legacy",
    revisionId: "legacy",
  };
  const subjectsByParameter = new Map<string, Map<string, EntityRef>>();
  for (const entry of entries) {
    const subjectKey = JSON.stringify([
      entry.subjectRef.workspaceId,
      entry.subjectRef.entityType,
      entry.subjectRef.entityId,
      entry.subjectRef.revisionId,
    ]);
    const subjects = subjectsByParameter.get(entry.parameterKey) ?? new Map<string, EntityRef>();
    subjects.set(subjectKey, entry.subjectRef);
    subjectsByParameter.set(entry.parameterKey, subjects);
  }
  const initialState: CalculationTraceStateValue[] = Object.entries(input.initialValues).flatMap(
    ([parameterKey, value]) => {
      const subjects = [...(subjectsByParameter.get(parameterKey)?.values() ?? [])];
      return (subjects.length > 0 ? subjects : [fallbackSubject]).map((subjectRef) => ({
        subjectRef,
        parameterKey,
        value,
      }));
    },
  );
  const replay = replayCalculationTrace({ entries, initialState });
  const values: Record<string, unknown> = {};
  for (const entry of replay.finalState) {
    if (
      Object.prototype.hasOwnProperty.call(values, entry.parameterKey)
      && !calculationTraceValuesEqual(values[entry.parameterKey], entry.value)
    ) {
      throw new CalculationTraceReplayError(
        `旧 UnifiedTraceEntry 无法表示多个 subject 的不同终态：${entry.parameterKey}。`,
      );
    }
    values[entry.parameterKey] = structuredClone(entry.value);
  }
  return { values, replayHash: replay.replayHash };
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
    commandPayloadRef?: NonNullable<ValidationActionLink["commandPayloadRef"]>;
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
        ...(availability.enabled && spec.commandPayloadRef
          ? { commandPayloadRef: structuredClone(spec.commandPayloadRef) }
          : {}),
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
