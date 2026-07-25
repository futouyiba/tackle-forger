/**
 * MOTION-02 feishu orchestration presentation model.
 *
 * Pure functions that derive a read-only stage model from authoritative
 * WorkspaceState + CanonicalRuleWorkbookInspection. Zero side effects, zero API
 * calls — presentation only. The model is immutable and must be rebuilt when
 * the authoritative inputs change.
 */

import type { CanonicalRuleWorkbookInspection } from "./rule-workbook-inspection";
import type { RuleSetVersion, WorkspaceState } from "./types";

// ─── Stage identity ────────────────────────────────────────────────────────

export type OrchestrationStageId =
  | "workbook_identity"
  | "source_pull"
  | "ruleset_draft"
  | "ruleset_publish";

export const ORCHESTRATION_STAGE_IDS: readonly OrchestrationStageId[] = [
  "workbook_identity",
  "source_pull",
  "ruleset_draft",
  "ruleset_publish",
];

export function orchestrationStageLabel(id: OrchestrationStageId): string {
  const labels: Record<OrchestrationStageId, string> = {
    workbook_identity: "工作簿身份",
    source_pull: "显式拉取",
    ruleset_draft: "RuleSet 草稿",
    ruleset_publish: "显式发布",
  };
  return labels[id];
}

export function orchestrationStageHint(id: OrchestrationStageId): string {
  const hints: Record<OrchestrationStageId, string> = {
    workbook_identity: "回读唯一权威工作簿，校验 revision 与 sheet 注册表",
    source_pull: "生成 FeishuSourceRevision、规则草稿与重量模板草稿",
    ruleset_draft: "冻结内容哈希与重量模板证据；仍需显式发布才生效",
    ruleset_publish: "独立校验后发布；不自动发布 PricingPolicy 或改写历史快照",
  };
  return hints[id];
}

// ─── Stage state ────────────────────────────────────────────────────────────

export type OrchestrationStageState =
  | "PENDING"
  | "INSPECTING"
  | "INSPECTED"
  | "PULLING"
  | "PULLED"
  | "DRAFTING"
  | "DRAFTED"
  | "PUBLISHING"
  | "PUBLISHED"
  | "SUPERSEDED"
  | "BLOCKED"
  | "FAILED"
  | "REMOTE_CHANGES_AVAILABLE"
  | "ERROR";

export function orchestrationStageStateLabel(state: OrchestrationStageState): string {
  const labels: Record<OrchestrationStageState, string> = {
    PENDING: "待开始",
    INSPECTING: "检查中…",
    INSPECTED: "已检查",
    PULLING: "拉取中…",
    PULLED: "已拉取",
    DRAFTING: "创建草稿…",
    DRAFTED: "草稿已就绪",
    PUBLISHING: "发布中…",
    PUBLISHED: "已发布",
    SUPERSEDED: "已过时",
    BLOCKED: "已阻断",
    FAILED: "失败",
    REMOTE_CHANGES_AVAILABLE: "远程有变更",
    ERROR: "错误",
  };
  return labels[state];
}

/**
 * Terminal states that require explicit user recovery — they must never be
 * presented as success (规范 §5.3 / P5).
 */
const TERMINAL_STATES = new Set<OrchestrationStageState>([
  "SUPERSEDED",
  "BLOCKED",
  "FAILED",
  "REMOTE_CHANGES_AVAILABLE",
  "ERROR",
]);

export function isTerminalStageState(state: OrchestrationStageState): boolean {
  return TERMINAL_STATES.has(state);
}

// ─── Stage evidence ─────────────────────────────────────────────────────────

export interface OrchestrationStageEvidence {
  revision?: string;
  hash?: string;
  timestamp?: string;
  actor?: string;
}

// ─── Stage model ────────────────────────────────────────────────────────────

export interface OrchestrationStage {
  id: OrchestrationStageId;
  index: number;
  label: string;
  hint: string;
  state: OrchestrationStageState;
  evidence?: OrchestrationStageEvidence;
  /** Human-readable issue summaries (warning/error codes). */
  issues?: string[];
}

export interface FeishuOrchestrationModel {
  /** Workspace revision at the time the model was built. */
  businessRevision: number;
  workbookName: string;
  workbookUrl: string;
  /** The source revision observed by the most recent inspection, if any. */
  sourceRevision: string | null;
  stages: OrchestrationStage[];
  /** false when any stage is in a terminal state that must be resolved. */
  isValid: boolean;
  /** When !isValid, explains what needs to happen. */
  terminalNotice?: string;
}

// ─── Builder input ──────────────────────────────────────────────────────────

export type OrchestrationActionState = "" | "inspect" | "pull" | "draft" | "publish";

export interface FeishuOrchestrationInput {
  state: WorkspaceState;
  workspaceRevision: number;
  inspection: CanonicalRuleWorkbookInspection | null;
  action: OrchestrationActionState;
  error: string | null;
}

// ─── Builder ────────────────────────────────────────────────────────────────

function shortHash(hash: string | undefined): string | undefined {
  if (!hash) return undefined;
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

function findSourceForInspection(
  state: WorkspaceState,
  inspection: CanonicalRuleWorkbookInspection,
) {
  const revision = inspection.sourceRevision.sourceRevision;
  return state.feishuSourceRevisions.find((item) => item.sourceRevision === revision);
}

function findRuleSetForSource(
  state: WorkspaceState,
  sourceId: string | undefined,
): RuleSetVersion | undefined {
  if (!sourceId) return undefined;
  return state.ruleSetVersions.find((item) => item.sourceRevisionIds.includes(sourceId));
}

/**
 * Builds a read-only FeishuOrchestrationModel from authoritative inputs.
 *
 * The model is a projection — it never mutates, stores, or derives business
 * facts beyond what the inputs already declare. When inputs change (after an
 * API response updates state or inspection), rebuild the model.
 */
export function buildFeishuOrchestrationModel(
  input: FeishuOrchestrationInput,
): FeishuOrchestrationModel {
  const { state, inspection, action, error } = input;

  const savedSource = inspection
    ? findSourceForInspection(state, inspection)
    : undefined;

  /** True when a previously-pulled source exists but the inspection shows a different revision. */
  const hasPulledSource = state.feishuSourceRevisions.length > 0;
  const inspectionShowsNewerRevision = Boolean(
    inspection &&
    hasPulledSource &&
    !savedSource,
  );

  const ruleSetForSource = findRuleSetForSource(state, savedSource?.id);
  const ruleSetDraft =
    ruleSetForSource?.status === "draft" ? ruleSetForSource : undefined;
  const publishedRuleSet =
    ruleSetForSource?.status === "published" ? ruleSetForSource : undefined;

  const registryErrors =
    inspection?.sourceRevision.issues.filter(
      (issue) => issue.severity === "error",
    ) ?? [];
  const canonicalRuleErrors =
    inspection?.canonicalRuleDraft.issues.filter(
      (issue) => issue.level === "error",
    ) ?? [];

  // ── workbook_identity ──────────────────────────────────────────────────

  const identityState = deriveWorkbookIdentityState({
    inspection,
    action,
    error,
    registryErrors,
    canonicalRuleErrors,
  });

  const identityIssues = [
    ...registryErrors.map((issue) => issue.code),
    ...canonicalRuleErrors.map((issue) => issue.code),
  ];

  const identityEvidence: OrchestrationStageEvidence | undefined =
    inspection
      ? {
          revision: inspection.sourceRevision.sourceRevision,
          hash: shortHash(inspection.sourceRevision.registryHash),
          timestamp: inspection.observedAt,
        }
      : undefined;

  // ── source_pull ────────────────────────────────────────────────────────

  const pullState = deriveSourcePullState({
    savedSource,
    inspection,
    action,
    error,
    inspectionShowsNewerRevision,
    hasIdentityError: registryErrors.length > 0 || canonicalRuleErrors.length > 0,
  });

  const pullEvidence: OrchestrationStageEvidence | undefined = savedSource
    ? {
        revision: savedSource.sourceRevision,
        hash: shortHash(savedSource.registryHash),
        timestamp: savedSource.pulledAt,
        actor: savedSource.pulledBy,
      }
    : undefined;

  // ── ruleset_draft ──────────────────────────────────────────────────────

  const draftState = deriveRulesetDraftState({
    savedSource,
    ruleSetDraft,
    publishedRuleSet,
    action,
    error,
    inspectionShowsNewerRevision,
  });

  const draftEvidence: OrchestrationStageEvidence | undefined = ruleSetDraft
    ? {
        revision: ruleSetDraft.sourceRevisionIds[0],
        hash: shortHash(ruleSetDraft.sourceContentHash),
        timestamp: ruleSetDraft.createdAt,
      }
    : publishedRuleSet
      ? {
          revision: publishedRuleSet.sourceRevisionIds[0],
          hash: shortHash(publishedRuleSet.sourceContentHash),
          timestamp: publishedRuleSet.createdAt,
        }
      : undefined;

  // ── ruleset_publish ────────────────────────────────────────────────────

  const publishState = deriveRulesetPublishState({
    ruleSetDraft,
    publishedRuleSet,
    savedSource,
    action,
    error,
    inspectionShowsNewerRevision,
    hasDraft: Boolean(ruleSetDraft),
  });

  const publishEvidence: OrchestrationStageEvidence | undefined =
    publishedRuleSet
      ? {
          revision: publishedRuleSet.sourceRevisionIds[0],
          hash: shortHash(publishedRuleSet.publicationHash),
          timestamp: publishedRuleSet.publishedAt,
          actor: publishedRuleSet.publishedBy,
        }
      : undefined;

  // ── assemble ───────────────────────────────────────────────────────────

  const stages: OrchestrationStage[] = [
    {
      id: "workbook_identity",
      index: 1,
      label: orchestrationStageLabel("workbook_identity"),
      hint: orchestrationStageHint("workbook_identity"),
      state: identityState,
      evidence: identityEvidence,
      issues: identityIssues.length ? identityIssues : undefined,
    },
    {
      id: "source_pull",
      index: 2,
      label: orchestrationStageLabel("source_pull"),
      hint: orchestrationStageHint("source_pull"),
      state: pullState,
      evidence: pullEvidence,
    },
    {
      id: "ruleset_draft",
      index: 3,
      label: orchestrationStageLabel("ruleset_draft"),
      hint: orchestrationStageHint("ruleset_draft"),
      state: draftState,
      evidence: draftEvidence,
    },
    {
      id: "ruleset_publish",
      index: 4,
      label: orchestrationStageLabel("ruleset_publish"),
      hint: orchestrationStageHint("ruleset_publish"),
      state: publishState,
      evidence: publishEvidence,
    },
  ];

  const terminalStage = stages.find((stage) =>
    isTerminalStageState(stage.state),
  );

  const terminalNotice = terminalStage
    ? buildTerminalNotice(terminalStage)
    : undefined;

  return {
    businessRevision: input.workspaceRevision,
    workbookName: "钓具设计工作簿",
    workbookUrl:
      "https://pisn3u3ony2.feishu.cn/wiki/YsEKwSUJ5i86HCkZKBVcNMw7nOh?from=from_copylink&sheet=9nE3Rx",
    sourceRevision: inspection?.sourceRevision.sourceRevision ?? null,
    stages,
    isValid: !terminalStage,
    terminalNotice,
  };
}

// ─── Stage derivation helpers ───────────────────────────────────────────────

interface DeriveIdentityInput {
  inspection: CanonicalRuleWorkbookInspection | null;
  action: OrchestrationActionState;
  error: string | null;
  registryErrors: unknown[];
  canonicalRuleErrors: unknown[];
}

function deriveWorkbookIdentityState(
  input: DeriveIdentityInput,
): OrchestrationStageState {
  if (input.action === "inspect") return "INSPECTING";
  if (input.inspection) {
    if (input.registryErrors.length || input.canonicalRuleErrors.length) {
      return "BLOCKED";
    }
    return input.error ? "ERROR" : "INSPECTED";
  }
  if (input.error) return "ERROR";
  return "PENDING";
}

interface DerivePullInput {
  savedSource: ReturnType<typeof findSourceForInspection>;
  inspection: CanonicalRuleWorkbookInspection | null;
  action: OrchestrationActionState;
  error: string | null;
  inspectionShowsNewerRevision: boolean;
  hasIdentityError: boolean;
}

function deriveSourcePullState(
  input: DerivePullInput,
): OrchestrationStageState {
  if (!input.inspection) return "PENDING";
  if (input.hasIdentityError) return "PENDING";
  if (input.action === "pull") return "PULLING";
  if (input.inspectionShowsNewerRevision) return "SUPERSEDED";
  if (input.savedSource) {
    if (input.savedSource.state === "PUBLISHED" || input.savedSource.state === "RULESET_DRAFT") {
      return "PULLED";
    }
    return "PULLED";
  }
  if (input.error && input.action !== "inspect") return "ERROR";
  return "PENDING";
}

interface DeriveDraftInput {
  savedSource: ReturnType<typeof findSourceForInspection>;
  ruleSetDraft: RuleSetVersion | undefined;
  publishedRuleSet: RuleSetVersion | undefined;
  action: OrchestrationActionState;
  error: string | null;
  inspectionShowsNewerRevision: boolean;
}

function deriveRulesetDraftState(
  input: DeriveDraftInput,
): OrchestrationStageState {
  if (!input.savedSource) return "PENDING";
  if (input.inspectionShowsNewerRevision) return "PENDING";
  if (input.action === "draft") return "DRAFTING";
  if (input.publishedRuleSet) return "PUBLISHED"; // draft already published
  if (input.ruleSetDraft) return "DRAFTED";
  if (
    input.savedSource.state === "RULESET_DRAFT" ||
    input.savedSource.state === "PUBLISHED"
  ) {
    // RULESET_DRAFT source state means draft was created but the RuleSet might
    // be published already; if we still have no ruleSetForSource it's unexpected.
    return "PENDING";
  }
  // Source is PULLED but no draft created yet — this is the normal "ready to draft" state.
  return "PENDING";
}

interface DerivePublishInput {
  ruleSetDraft: RuleSetVersion | undefined;
  publishedRuleSet: RuleSetVersion | undefined;
  savedSource: ReturnType<typeof findSourceForInspection>;
  action: OrchestrationActionState;
  error: string | null;
  inspectionShowsNewerRevision: boolean;
  hasDraft: boolean;
}

function deriveRulesetPublishState(
  input: DerivePublishInput,
): OrchestrationStageState {
  if (!input.savedSource) return "PENDING";
  if (input.inspectionShowsNewerRevision) return "PENDING";
  if (input.action === "publish") return "PUBLISHING";
  if (input.publishedRuleSet) return "PUBLISHED";
  if (input.ruleSetDraft) return "PENDING"; // draft exists, waiting for publish
  return "PENDING";
}

function buildTerminalNotice(
  stage: OrchestrationStage,
): string | undefined {
  if (stage.id === "workbook_identity" && stage.state === "BLOCKED") {
    const codes = stage.issues?.join("、") ?? "未知错误";
    return `工作簿校验发现阻断错误：${codes}。无法继续拉取或发布，请检查飞书源数据。`;
  }
  if (stage.id === "source_pull" && stage.state === "SUPERSEDED") {
    return `检测到飞书 revision 已变化。当前展示的证据来自旧 revision，已被取代。请重新显式拉取以获取最新规则。`;
  }
  if (stage.state === "FAILED") {
    return `操作失败。已保留当前可用规则和 Trace 证据，不会进入成功态。请检查错误信息后重试。`;
  }
  if (stage.state === "ERROR") {
    return `操作异常。已保留当前可用证据，不会伪装为成功。`;
  }
  if (stage.state === "REMOTE_CHANGES_AVAILABLE") {
    return `飞书远程已有新变更。当前展示为写回完成后的状态，但需要再次显式拉取才能使用最新规则。`;
  }
  return undefined;
}
