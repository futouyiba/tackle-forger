import { deterministicHash } from "./rule-kernel";
import type { FeishuSourceRevision } from "./feishu-workbook";
import type { PricingPolicyDraft } from "./pricing-policy";
import type { SourceIdentityMigrationReport } from "./source-id-migration";
import type { RuleSetVersion, WorkspaceState } from "./types";

export function recordFeishuSourceRevision(
  state: WorkspaceState,
  revision: FeishuSourceRevision,
): WorkspaceState {
  if (revision.issues.some((issue) => issue.severity === "error")) {
    throw new Error("工作簿注册表校验存在 error，不能登记本次显式拉取。");
  }
  const next = structuredClone(state);
  const existing = next.feishuSourceRevisions.find((item) => item.id === revision.id);
  if (!existing) next.feishuSourceRevisions.unshift(structuredClone(revision));
  return next;
}

export function recordSourceIdentityMigrationReport(
  state: WorkspaceState,
  report: SourceIdentityMigrationReport,
): WorkspaceState {
  const next = structuredClone(state);
  const index = next.sourceIdentityMigrationReports.findIndex((item) => item.reportId === report.reportId);
  if (index >= 0) next.sourceIdentityMigrationReports[index] = structuredClone(report);
  else next.sourceIdentityMigrationReports.unshift(structuredClone(report));
  return next;
}

export function recordPricingPolicyDraft(
  state: WorkspaceState,
  draft: PricingPolicyDraft,
): WorkspaceState {
  if (!state.feishuSourceRevisions.some((revision) => revision.id === draft.sourceRevisionId)) {
    throw new Error("PricingPolicyDraft 引用的 FeishuSourceRevision 尚未登记。");
  }
  const next = structuredClone(state);
  const index = next.pricingPolicyDrafts.findIndex((item) => item.id === draft.id);
  if (index >= 0) next.pricingPolicyDrafts[index] = structuredClone(draft);
  else next.pricingPolicyDrafts.unshift(structuredClone(draft));
  return next;
}

export function createRuleSetDraftFromPull(input: {
  state: WorkspaceState;
  sourceRevisionId: string;
  createdAt: string;
  createdBy: string;
}): { state: WorkspaceState; ruleSetDraft: RuleSetVersion } {
  const source = input.state.feishuSourceRevisions.find((revision) => revision.id === input.sourceRevisionId);
  if (!source) throw new Error("找不到待转换的 FeishuSourceRevision。");
  if (source.state === "PUBLISHED") throw new Error("该源修订已关联发布规则版本，无需重复创建草稿。");
  const existing = input.state.ruleSetVersions.find((ruleSet) =>
    ruleSet.sourceRevisionIds.includes(source.id) && ruleSet.status === "draft",
  );
  if (existing) return { state: structuredClone(input.state), ruleSetDraft: structuredClone(existing) };
  const ruleSetDraft: RuleSetVersion = {
    id: `ruleset-draft:${deterministicHash({ sourceRevisionId: source.id, createdAt: input.createdAt })}`,
    version: Math.max(0, ...input.state.ruleSetVersions.map((item) => item.version)) + 1,
    status: "draft",
    sourceRevisionIds: [source.id],
    settings: structuredClone(input.state.ruleSettings),
    createdAt: input.createdAt,
    publishedAt: undefined,
    notes: `由显式拉取 ${source.sourceRevision} 创建；尚未发布。创建人：${input.createdBy}`,
  };
  const next = structuredClone(input.state);
  next.ruleSetVersions.unshift(ruleSetDraft);
  const sourceIndex = next.feishuSourceRevisions.findIndex((revision) => revision.id === source.id);
  next.feishuSourceRevisions[sourceIndex] = { ...next.feishuSourceRevisions[sourceIndex], state: "RULESET_DRAFT" };
  return { state: next, ruleSetDraft: structuredClone(ruleSetDraft) };
}

export function assertExplicitPullDidNotPublish(before: WorkspaceState, after: WorkspaceState) {
  const beforePublished = before.ruleSetVersions.filter((item) => item.status === "published").map((item) => item.id).sort();
  const afterPublished = after.ruleSetVersions.filter((item) => item.status === "published").map((item) => item.id).sort();
  if (deterministicHash(beforePublished) !== deterministicHash(afterPublished)) {
    throw new Error("显式拉取不得改变已发布 RuleSetVersion 集合。");
  }
}
