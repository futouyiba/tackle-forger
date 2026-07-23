import { deterministicHash } from "./rule-kernel";
import type { FeishuSourceRevision } from "./feishu-workbook";
import type { PricingPolicyDraft } from "./pricing-policy";
import type { QualityValuePolicyDraft } from "./quality-value-policy";
import type { SourceIdentityMigrationReport } from "./source-id-migration";
import type { RuleSetVersion, WorkspaceState } from "./types";
import {
  importReductionStackingPolicyDraft,
  publishReductionStackingPolicyVersion,
} from "./reduction-stacking-policy";
import type { ReductionStackingPolicyVersion } from "./types";

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

export function recordQualityValuePolicyDraft(
  state: WorkspaceState,
  draft: QualityValuePolicyDraft,
): WorkspaceState {
  if (!state.feishuSourceRevisions.some((revision) => revision.id === draft.sourceRevisionId)) {
    throw new Error("QualityValuePolicyDraft 引用的 FeishuSourceRevision 尚未登记。");
  }
  const next = structuredClone(state);
  const index = next.qualityValuePolicyDrafts.findIndex((item) => item.id === draft.id);
  if (index >= 0) next.qualityValuePolicyDrafts[index] = structuredClone(draft);
  else next.qualityValuePolicyDrafts.unshift(structuredClone(draft));
  return next;
}

export function recordReductionStackingPolicyDraft(
  state: WorkspaceState,
  draft: ReductionStackingPolicyVersion,
): WorkspaceState {
  if (
    draft.source
    && !state.feishuSourceRevisions.some((revision) => revision.id === draft.source?.sourceRevisionId)
  ) {
    throw new Error("ReductionStackingPolicyVersion 引用的 FeishuSourceRevision 尚未登记。");
  }
  const next = structuredClone(state);
  const index = next.reductionStackingPolicyVersions.findIndex((item) => item.id === draft.id);
  if (index >= 0) next.reductionStackingPolicyVersions[index] = structuredClone(draft);
  else next.reductionStackingPolicyVersions.unshift(structuredClone(draft));
  return next;
}

export function publishReductionStackingPolicyFromPull(input: {
  state: WorkspaceState;
  policyDraftId: string;
  publishedAt: string;
  publishedBy: string;
}): { state: WorkspaceState; policy: ReductionStackingPolicyVersion } {
  const draft = input.state.reductionStackingPolicyVersions.find(
    (entry) => entry.id === input.policyDraftId,
  );
  if (!draft) throw new Error("找不到待发布的 ReductionStackingPolicyVersion 草稿。");
  const published = publishReductionStackingPolicyVersion({
    draft,
    publishedAt: input.publishedAt,
    publishedBy: input.publishedBy,
  });
  if (published.status === "published" && draft.status === "published") {
    return { state: structuredClone(input.state), policy: structuredClone(published) };
  }
  const next = structuredClone(input.state);
  next.reductionStackingPolicyVersions = next.reductionStackingPolicyVersions.map((entry) => {
    if (entry.id === published.id) return published;
    return entry.status === "published" ? { ...entry, status: "superseded" as const } : entry;
  });
  return { state: next, policy: structuredClone(published) };
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
  const reductionDraft = importReductionStackingPolicyDraft({
    sourceRevision: source,
    machineRules: source.reductionPolicyMachineRules,
    createdAt: input.createdAt,
  });
  const existingPolicyIndex = next.reductionStackingPolicyVersions.findIndex(
    (entry) => entry.id === reductionDraft.id,
  );
  if (existingPolicyIndex >= 0) {
    const existingPolicy = next.reductionStackingPolicyVersions[existingPolicyIndex];
    // 同一权威源的重新拉取只能更新草稿；已发布/已替代版本是冻结
    // Snapshot 的重放依赖，不能被确定性 draft identity 降级覆盖。
    if (existingPolicy.status === "draft") {
      next.reductionStackingPolicyVersions[existingPolicyIndex] = reductionDraft;
    }
  } else {
    next.reductionStackingPolicyVersions.unshift(reductionDraft);
  }
  const sourceIndex = next.feishuSourceRevisions.findIndex((revision) => revision.id === source.id);
  next.feishuSourceRevisions[sourceIndex] = { ...next.feishuSourceRevisions[sourceIndex], state: "RULESET_DRAFT" };
  return { state: next, ruleSetDraft: structuredClone(ruleSetDraft) };
}

export function ruleSetWarningIssueKey(issue: { code: string; sheetId: string }) {
  return `${issue.code}:${issue.sheetId}`;
}

export function publishRuleSetVersion(input: {
  state: WorkspaceState;
  ruleSetDraftId: string;
  publishedAt: string;
  publishedBy: string;
  warningAcknowledgements?: Array<{ issueKey: string; reason: string }>;
}): { state: WorkspaceState; ruleSetVersion: RuleSetVersion } {
  const existing = input.state.ruleSetVersions.find((item) => item.id === input.ruleSetDraftId);
  if (!existing) throw new Error("找不到待发布的 RuleSet 草稿。");
  if (existing.status === "published") {
    return { state: structuredClone(input.state), ruleSetVersion: structuredClone(existing) };
  }
  if (existing.status !== "draft") throw new Error("只有草稿状态的 RuleSetVersion 可以发布。");
  if (!existing.sourceRevisionIds.length) throw new Error("RuleSet 草稿没有引用 FeishuSourceRevision，不能发布。");

  const sources = existing.sourceRevisionIds.map((sourceRevisionId) => {
    const source = input.state.feishuSourceRevisions.find((item) => item.id === sourceRevisionId);
    if (!source) throw new Error(`RuleSet 草稿引用的源修订不存在：${sourceRevisionId}`);
    if (source.state !== "RULESET_DRAFT") {
      throw new Error(`源修订 ${source.sourceRevision} 未处于待发布状态。`);
    }
    return source;
  });
  const latestSourceByWorkbook = new Map<string, (typeof input.state.feishuSourceRevisions)[number]>();
  for (const source of input.state.feishuSourceRevisions) {
    const latest = latestSourceByWorkbook.get(source.workbookRefId);
    if (!latest || source.pulledAt > latest.pulledAt) latestSourceByWorkbook.set(source.workbookRefId, source);
  }
  const staleSources = sources.filter((source) => latestSourceByWorkbook.get(source.workbookRefId)?.id !== source.id);
  if (staleSources.length) {
    throw new Error(`RuleSet 草稿引用的源修订已过期，请基于最新显式拉取重新创建草稿：${staleSources.map((source) => source.sourceRevision).join("、")}`);
  }
  const errors = sources.flatMap((source) => source.issues.filter((issue) => issue.severity === "error"));
  if (errors.length) throw new Error(`源修订仍有阻断错误：${errors.map((issue) => issue.code).join("、")}`);
  const reductionPolicy = input.state.reductionStackingPolicyVersions.find((policy) =>
    policy.status === "published"
    && policy.source
    && existing.sourceRevisionIds.includes(policy.source.sourceRevisionId)
  );
  if (!reductionPolicy) {
    throw new Error(
      "RuleSet 发布被阻止：[REDUCTION_POLICY_SOURCE_MISSING] 权威主工作簿机器规则尚未形成已发布 ReductionStackingPolicyVersion。",
    );
  }

  const acknowledgements = input.warningAcknowledgements ?? [];
  const acknowledgementByKey = new Map(acknowledgements.map((item) => [item.issueKey, item.reason.trim()]));
  const warnings = sources.flatMap((source) => source.issues.filter((issue) => issue.severity === "warning"));
  const missingAcknowledgements = warnings
    .map(ruleSetWarningIssueKey)
    .filter((issueKey) => !acknowledgementByKey.get(issueKey));
  if (missingAcknowledgements.length) {
    throw new Error(`发布前必须逐项确认 warning 并填写理由：${missingAcknowledgements.join("、")}`);
  }
  const normalizedAcknowledgements = [...new Set(warnings.map(ruleSetWarningIssueKey))]
    .sort()
    .map((issueKey) => ({ issueKey, reason: acknowledgementByKey.get(issueKey)! }));
  const publicationHash = deterministicHash({
    ruleSetId: existing.id,
    version: existing.version,
    sourceRevisionIds: [...existing.sourceRevisionIds].sort(),
    settings: {
      ...existing.settings,
      reductionStackingPolicyVersion: reductionPolicy.version,
    },
    warningAcknowledgements: normalizedAcknowledgements,
    publishedAt: input.publishedAt,
    publishedBy: input.publishedBy,
  });

  const next = structuredClone(input.state);
  next.ruleSetVersions = next.ruleSetVersions.map((item) => {
    if (item.id === existing.id) {
      return {
        ...item,
        status: "published" as const,
        publishedAt: input.publishedAt,
        publishedBy: input.publishedBy,
        settings: {
          ...item.settings,
          reductionStackingPolicyVersion: reductionPolicy.version,
        },
        warningAcknowledgements: normalizedAcknowledgements,
        publicationHash,
        notes: `${item.notes}\n已由 ${input.publishedBy} 显式发布。`,
      };
    }
    return item.status === "published" ? { ...item, status: "superseded" as const } : item;
  });
  next.feishuSourceRevisions = next.feishuSourceRevisions.map((source) =>
    existing.sourceRevisionIds.includes(source.id) ? { ...source, state: "PUBLISHED" as const } : source,
  );
  const published = next.ruleSetVersions.find((item) => item.id === existing.id)!;
  return { state: next, ruleSetVersion: structuredClone(published) };
}
export function assertExplicitPullDidNotPublish(before: WorkspaceState, after: WorkspaceState) {
  const beforePublished = before.ruleSetVersions.filter((item) => item.status === "published").map((item) => item.id).sort();
  const afterPublished = after.ruleSetVersions.filter((item) => item.status === "published").map((item) => item.id).sort();
  if (deterministicHash(beforePublished) !== deterministicHash(afterPublished)) {
    throw new Error("显式拉取不得改变已发布 RuleSetVersion 集合。");
  }
}
