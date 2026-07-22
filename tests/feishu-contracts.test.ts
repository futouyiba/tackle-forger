import assert from "node:assert/strict";
import test from "node:test";
import {
  createAIProposalDraft,
  submitFeishuRuleProposal,
  type FeishuProposalSubmitAdapter,
} from "../lib/feishu-proposal";
import type { EntityRef } from "../lib/interaction-contracts";

const modelRef: EntityRef = {
  workspaceId: "workspace:1", entityType: "model", entityId: "model:1", revisionId: "r1",
};

function proposal() {
  return createAIProposalDraft({
    proposalId: "proposal:1",
    recommendationId: "recommendation:1",
    sourceObjectRefs: [modelRef],
    targetRuleRef: { tableId: "table:rules", rowId: "row:1", ruleKey: "rule:1", sourceRevision: "rev:1" },
    proposedChange: { drag: 12 },
    evidenceRefIds: ["issue:1"],
    impactPreview: {
      evaluatedRuleSetVersion: "rules:1", affectedSeries: 1, affectedSkus: 2, affectedModels: 4,
      newErrors: 0, resolvedErrors: 1, sampleDiffRefs: ["diff:1"], upgradeCandidatesExpected: 4,
    },
    idempotencyKey: "proposal-key:1",
  });
}

test("R8 AI只创建local_draft且不代选审批人，历史Snapshot变化恒0", () => {
  const draft = proposal();
  assert.equal(draft.state, "local_draft");
  assert.deepEqual(draft.reviewerIds, []);
  assert.equal(draft.impactPreview.publishedSnapshotsChanged, 0);
});

test("R8 sourceRevision变化进入needs_rebase，不能静默提交", async () => {
  const adapter: FeishuProposalSubmitAdapter = {
    async getCurrentSourceRevision() { return "rev:2"; },
    async findRemoteByIdempotencyKey() { return undefined; },
    async createRemoteProposal() { throw new Error("不应调用"); },
  };
  const result = await submitFeishuRuleProposal({
    proposal: proposal(), reviewerIds: ["reviewer:1"], heldCapabilities: ["feishu.proposal.submit"], adapter,
  });
  assert.equal(result.state, "needs_rebase");
});

test("R8 提交超时但远端已创建时按幂等键恢复原提案", async () => {
  let lookupCount = 0;
  const adapter: FeishuProposalSubmitAdapter = {
    async getCurrentSourceRevision() { return "rev:1"; },
    async findRemoteByIdempotencyKey() { lookupCount += 1; return lookupCount >= 2 ? "remote:existing" : undefined; },
    async createRemoteProposal() { throw new Error("timeout"); },
  };
  const result = await submitFeishuRuleProposal({
    proposal: proposal(), reviewerIds: ["reviewer:1"], heldCapabilities: ["feishu.proposal.submit"], adapter,
  });
  assert.equal(result.state, "submitted");
  assert.equal(result.remoteProposalId, "remote:existing");
});

test("R8 提交与审批人权限独立，AI不能在空审批人时提交", async () => {
  const adapter: FeishuProposalSubmitAdapter = {
    async getCurrentSourceRevision() { return "rev:1"; },
    async findRemoteByIdempotencyKey() { return undefined; },
    async createRemoteProposal() { return "remote:1"; },
  };
  await assert.rejects(submitFeishuRuleProposal({
    proposal: proposal(), reviewerIds: [], heldCapabilities: ["feishu.proposal.submit"], adapter,
  }), /人工确认/);
  await assert.rejects(submitFeishuRuleProposal({
    proposal: proposal(), reviewerIds: ["reviewer:1"], heldCapabilities: [], adapter,
  }), /缺少能力/);
});
