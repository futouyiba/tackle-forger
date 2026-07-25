"use client";

import {
  AlertTriangle,
  ArrowRight,
  LoaderCircle,
} from "lucide-react";
import type { ActionAvailabilityMap, ActionCode } from "@/lib/interaction-contracts";
import {
  type FeishuOrchestrationModel,
  type OrchestrationStage,
  type OrchestrationStageId,
  type OrchestrationStageState,
  orchestrationStageStateLabel,
  isTerminalStageState,
} from "@/lib/feishu-orchestration-presentation";

// ─── Props ──────────────────────────────────────────────────────────────────

export interface FeishuOrchestrationWorkbenchProps {
  model: FeishuOrchestrationModel;
  actionAvailabilities: ActionAvailabilityMap;
  /** Current executing action for in-progress indicators */
  actionState: "" | "inspect" | "pull" | "draft" | "publish";
  onInspect: () => void;
  onPull: () => void;
  onCreateDraft: () => void;
  onPublish: () => void;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function badgeClass(state: OrchestrationStageState): string {
  if (state === "INSPECTING" || state === "PULLING" || state === "DRAFTING" || state === "PUBLISHING") return "active";
  if (state === "INSPECTED" || state === "PULLED" || state === "DRAFTED" || state === "PUBLISHED") return "completed";
  if (state === "BLOCKED" || state === "FAILED" || state === "ERROR") return "blocked";
  if (state === "SUPERSEDED" || state === "REMOTE_CHANGES_AVAILABLE") return "superseded";
  return "pending";
}

function stageActionCode(stageId: OrchestrationStageId): ActionCode {
  const mapping: Record<OrchestrationStageId, ActionCode> = {
    workbook_identity: "inspect_feishu_workbook",
    source_pull: "pull_feishu_workbook",
    ruleset_draft: "create_ruleset_draft",
    ruleset_publish: "publish_ruleset",
  };
  return mapping[stageId];
}

function isActionable(stageId: OrchestrationStageId, state: OrchestrationStageState): boolean {
  // Terminal states and in-progress actions should not show action buttons
  if (isTerminalStageState(state)) return false;
  if (state === "INSPECTING" || state === "PULLING" || state === "DRAFTING" || state === "PUBLISHING") return false;
  if (state === "PUBLISHED") return false;

  // Each stage's action is available when its precondition is met
  const progressOrder: Record<OrchestrationStageId, OrchestrationStageState[]> = {
    workbook_identity: ["PENDING", "ERROR"],
    source_pull: ["INSPECTED", "ERROR", "PULLED"],
    ruleset_draft: ["PULLED"],
    ruleset_publish: ["DRAFTED"],
  };

  return progressOrder[stageId].includes(state);
}

function actionLabel(stageId: OrchestrationStageId, state: OrchestrationStageState): string {
  if (stageId === "workbook_identity") return state === "INSPECTED" ? "重新检查" : "检查工作簿";
  if (stageId === "source_pull") return state === "PULLED" ? "重新拉取" : "显式拉取";
  if (stageId === "ruleset_draft") return "创建规则草稿";
  return "显式发布";
}

function stageVariant(stageId: OrchestrationStageId, state: OrchestrationStageState): "primary" | "default" {
  // First action available is primary; subsequent ones are default
  if (stageId === "workbook_identity" && (state === "PENDING" || state === "ERROR")) return "primary";
  if (stageId === "source_pull" && state === "PULLED") return "primary";
  if (stageId === "ruleset_publish" && state === "DRAFTED") return "primary";
  return "default";
}

// ─── sub-components ─────────────────────────────────────────────────────────

function StageEvidence({ stage }: { stage: OrchestrationStage }) {
  if (!stage.evidence) return null;
  const { revision, hash, timestamp, actor } = stage.evidence;
  return (
    <div className="fo-stage-evidence" aria-label="阶段证据">
      {revision ? <><dt>revision</dt><dd>{revision}</dd></> : null}
      {hash ? <><dt>hash</dt><dd>{hash}</dd></> : null}
      {timestamp ? <><dt>时间</dt><dd>{new Date(timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</dd></> : null}
      {actor ? <><dt>操作人</dt><dd>{actor}</dd></> : null}
    </div>
  );
}

function StageIssues({ issues }: { issues: string[] }) {
  return (
    <div className="fo-stage-issues">
      {issues.map((code) => (
        <span key={code} className="fo-stage-issue">{code}</span>
      ))}
    </div>
  );
}

function StageCard({
  stage,
  isCurrent,
  actionAvailabilities,
  actionState,
  onAction,
}: {
  stage: OrchestrationStage;
  isCurrent: boolean;
  actionAvailabilities: ActionAvailabilityMap;
  actionState: string;
  onAction: () => void;
}) {
  const actionCode = stageActionCode(stage.id);
  const availability = (actionAvailabilities as Record<string, { enabled: boolean; disabledReasonText?: string }>)[actionCode];
  const showAction = isActionable(stage.id, stage.state);
  const disabled = Boolean(actionState) || !availability?.enabled;
  const variant = stageVariant(stage.id, stage.state);
  const busy = (stage.id === "workbook_identity" && actionState === "inspect")
    || (stage.id === "source_pull" && actionState === "pull")
    || (stage.id === "ruleset_draft" && actionState === "draft")
    || (stage.id === "ruleset_publish" && actionState === "publish");

  const cardClass = [
    "fo-stage-card",
    isCurrent ? "is-current" : stage.state === "PENDING" ? "is-future" : "is-previous",
  ].filter(Boolean).join(" ");

  return (
    <div className={cardClass}>
      <span className="fo-stage-index">
        {String(stage.index).padStart(2, "0")} · {stage.label}
      </span>
      <span className={`fo-stage-badge ${badgeClass(stage.state)}`}>
        {orchestrationStageStateLabel(stage.state)}
      </span>
      <p className="fo-stage-hint">{stage.hint}</p>

      {stage.state === "PUBLISHED" && (
        <span style={{ fontSize: 9, color: "var(--muted)", fontStyle: "italic" }}>
          冻结证据不可被上游静默重算
        </span>
      )}

      {stage.issues?.length ? <StageIssues issues={stage.issues} /> : null}
      <StageEvidence stage={stage} />

      {showAction ? (
        <button
          className={`button button-${variant} button-sm fo-stage-action`}
          type="button"
          disabled={disabled}
          title={availability?.disabledReasonText}
          onClick={onAction}
        >
          {busy ? <LoaderCircle className="spin" size={13} /> : null}
          {actionLabel(stage.id, stage.state)}
        </button>
      ) : null}
    </div>
  );
}

// ─── main component ─────────────────────────────────────────────────────────

export function FeishuOrchestrationWorkbench({
  model,
  actionAvailabilities,
  actionState,
  onInspect,
  onPull,
  onCreateDraft,
  onPublish,
}: FeishuOrchestrationWorkbenchProps) {
  const actionByStage: Record<OrchestrationStageId, () => void> = {
    workbook_identity: onInspect,
    source_pull: onPull,
    ruleset_draft: onCreateDraft,
    ruleset_publish: onPublish,
  };

  // Determine the "current" stage: first stage that is not COMPLETED/PUBLISHED
  const completedStates = new Set<OrchestrationStageState>(["INSPECTED", "PULLED", "DRAFTED", "PUBLISHED"]);
  const firstIncompleteIndex = model.stages.findIndex(
    (s) => !completedStates.has(s.state) && !isTerminalStageState(s.state),
  );
  const currentIndex = firstIncompleteIndex >= 0 ? firstIncompleteIndex : model.stages.length - 1;

  return (
    <div className="fo-pipeline" role="list" aria-label="飞书规则编排流水线">
      {model.stages.map((stage, i) => (
        <div key={stage.id} role="listitem">
          <StageCard
            stage={stage}
            isCurrent={i === currentIndex}
            actionAvailabilities={actionAvailabilities}
            actionState={actionState}
            onAction={actionByStage[stage.id]}
          />
        </div>
      )).reduce((acc, el, i, arr) => {
        // Interleave arrows between stage cards
        if (i === arr.length - 1) return [...acc, el];
        return [...acc, el, <ArrowRight key={`arrow-${i}`} size={18} />];
      }, [] as React.ReactNode[])}

      {/* Terminal notice banner */}
      {!model.isValid && model.terminalNotice ? (
        <div
          className={`fo-terminal-notice${model.stages.some((s) => s.state === "SUPERSEDED") ? " super" : ""}`}
          style={{ gridColumn: "1 / -1" }}
        >
          <AlertTriangle size={18} />
          <span>{model.terminalNotice}</span>
        </div>
      ) : null}
    </div>
  );
}
