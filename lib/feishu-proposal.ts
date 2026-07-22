import type { CapabilityCode, EntityRef } from "./interaction-contracts";
import { actionAvailability } from "./interaction-contracts";

export interface FeishuRuleProposalDraft {
  proposalId: string;
  originRecommendationId?: string;
  sourceObjectRefs: EntityRef[];
  targetRuleRef: {
    tableId: string;
    rowId?: string;
    ruleKey: string;
    sourceRevision: string;
  };
  proposedChange: Record<string, unknown>;
  evidenceRefIds: string[];
  impactPreview: {
    evaluatedRuleSetVersion: string;
    affectedSeries: number;
    affectedSkus: number;
    affectedModels: number;
    newErrors: number;
    resolvedErrors: number;
    sampleDiffRefs: string[];
    publishedSnapshotsChanged: 0;
    upgradeCandidatesExpected: number;
  };
  reviewerIds: string[];
  state:
    | "local_draft" | "ready_to_submit" | "submitting" | "submitted"
    | "submit_failed" | "needs_rebase" | "rejected" | "approved" | "applied";
  idempotencyKey: string;
  remoteProposalId?: string;
}

export function createAIProposalDraft(input: {
  proposalId: string;
  recommendationId: string;
  sourceObjectRefs: EntityRef[];
  targetRuleRef: FeishuRuleProposalDraft["targetRuleRef"];
  proposedChange: Record<string, unknown>;
  evidenceRefIds: string[];
  impactPreview: Omit<FeishuRuleProposalDraft["impactPreview"], "publishedSnapshotsChanged">;
  idempotencyKey: string;
}): FeishuRuleProposalDraft {
  if (!input.evidenceRefIds.length) {
    throw new Error("AI 飞书提案草稿必须包含证据引用。");
  }
  return {
    proposalId: input.proposalId,
    originRecommendationId: input.recommendationId,
    sourceObjectRefs: structuredClone(input.sourceObjectRefs),
    targetRuleRef: structuredClone(input.targetRuleRef),
    proposedChange: structuredClone(input.proposedChange),
    evidenceRefIds: structuredClone(input.evidenceRefIds),
    impactPreview: {
      ...structuredClone(input.impactPreview),
      publishedSnapshotsChanged: 0,
    },
    reviewerIds: [],
    state: "local_draft",
    idempotencyKey: input.idempotencyKey,
  };
}

export interface FeishuProposalSubmitAdapter {
  getCurrentSourceRevision(target: FeishuRuleProposalDraft["targetRuleRef"]): Promise<string>;
  findRemoteByIdempotencyKey(key: string): Promise<string | undefined>;
  createRemoteProposal(proposal: FeishuRuleProposalDraft): Promise<string>;
}

export async function submitFeishuRuleProposal(input: {
  proposal: FeishuRuleProposalDraft;
  reviewerIds: string[];
  heldCapabilities: CapabilityCode[];
  adapter: FeishuProposalSubmitAdapter;
}): Promise<FeishuRuleProposalDraft> {
  const permission = actionAvailability(
    "submit_feishu_proposal",
    input.heldCapabilities,
  );
  if (!permission.enabled) throw new Error(permission.disabledReasonText);
  if (!["local_draft", "ready_to_submit", "submit_failed"].includes(input.proposal.state)) {
    throw new Error("当前飞书提案状态不能提交。");
  }
  if (!input.reviewerIds.length) {
    throw new Error("审批人必须由人工确认，AI不能代选。");
  }
  const currentRevision = await input.adapter.getCurrentSourceRevision(
    input.proposal.targetRuleRef,
  );
  if (currentRevision !== input.proposal.targetRuleRef.sourceRevision) {
    return {
      ...structuredClone(input.proposal),
      reviewerIds: structuredClone(input.reviewerIds),
      state: "needs_rebase",
    };
  }
  const existing = await input.adapter.findRemoteByIdempotencyKey(
    input.proposal.idempotencyKey,
  );
  if (existing) {
    return {
      ...structuredClone(input.proposal),
      reviewerIds: structuredClone(input.reviewerIds),
      state: "submitted",
      remoteProposalId: existing,
    };
  }
  try {
    const remoteProposalId = await input.adapter.createRemoteProposal({
      ...structuredClone(input.proposal),
      reviewerIds: structuredClone(input.reviewerIds),
      state: "submitting",
    });
    return {
      ...structuredClone(input.proposal),
      reviewerIds: structuredClone(input.reviewerIds),
      state: "submitted",
      remoteProposalId,
    };
  } catch {
    const recovered = await input.adapter.findRemoteByIdempotencyKey(
      input.proposal.idempotencyKey,
    );
    if (recovered) {
      return {
        ...structuredClone(input.proposal),
        reviewerIds: structuredClone(input.reviewerIds),
        state: "submitted",
        remoteProposalId: recovered,
      };
    }
    return {
      ...structuredClone(input.proposal),
      reviewerIds: structuredClone(input.reviewerIds),
      state: "submit_failed",
    };
  }
}

