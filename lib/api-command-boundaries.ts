import type { RequestIdentity } from "./auth";
import type { WorkspaceState } from "./types";
import {
  READ_ONLY_LEGACY_PRODUCT_FIELDS,
  isReadOnlyLegacyProductField,
} from "./legacy-history";
import { stableStringify } from "./rule-kernel";

export { findReadOnlyLegacyProductChanges } from "./legacy-history";

/**
 * PUT /api/state is default-allow for normal editable workspace fields.
 *
 * This is the narrow, auditable exception list. Every entry is either
 * immutable/published history, server-owned audit/reservation evidence, or an
 * aggregate with an existing domain command. Do not add ordinary form fields
 * here: new ordinary fields must not fail later with an accidental 422.
 */
export interface GovernedStateField {
  field: string;
  reason: "domain_command" | "published_history" | "audit_or_reserved_identity" | "legacy_history";
  action: string;
  actionLabel: string;
  /** Present only when the named action has a real HTTP entrypoint. */
  route?: string;
}

const GOVERNED_STATE_FIELDS: readonly GovernedStateField[] = [
  ...READ_ONLY_LEGACY_PRODUCT_FIELDS.map((field) => ({
    field, reason: "legacy_history" as const,
    action: "历史查看、导出或迁移流程", actionLabel: "通过历史迁移流程处理",
  })),
  { field: "seriesDefinitions", reason: "domain_command", action: "POST /api/series（create_series）", actionLabel: "使用创建 Series" },
  { field: "skuDrawers", reason: "domain_command", action: "POST /api/skus/target-pull（change_sku_target_pull）", actionLabel: "使用修改 SKU 目标拉力" },
  { field: "patchLedger", reason: "domain_command", action: "Patch ActionCode（create/review/rebase/mirror）", actionLabel: "使用 Patch 创建、审核或 Rebase" },
  { field: "projectionPatches", reason: "legacy_history", action: "只读：遗留 ProjectionPatch 仅供迁移与审计", actionLabel: "保留原记录；通过迁移流程处理" },
  { field: "purchasableModels", reason: "domain_command", action: "Model ActionCode（edit/review/publish）", actionLabel: "使用 Model 编辑、审核或发布动作" },
  { field: "derivedProjections", reason: "domain_command", action: "规则发布后重新演绎", actionLabel: "发布规则后重新生成结构标杆" },
  { field: "projectionMatches", reason: "domain_command", action: "SKU/Model 领域命令", actionLabel: "使用 SKU 或 Model 领域动作重算匹配" },
  // v3 §6.5 freezes both objects by stable revision/hash. The current product
  // exposes no mutation command for an existing revision, so do not invent one.
  { field: "partConstraintSets", reason: "published_history", action: "只读：当前没有修改既有约束 revision 的领域命令", actionLabel: "保留现有约束；创建新 Series 时由 POST /api/series 物化新 revision" },
  { field: "candidateSearchRecipes", reason: "published_history", action: "只读：当前没有修改既有候选 Recipe revision 的领域命令", actionLabel: "保留现有 Recipe；等待专用版本化命令" },
  { field: "candidateRuns", reason: "published_history", action: "generate_candidates", actionLabel: "重新生成候选运行" },
  { field: "candidateMaterializations", reason: "published_history", action: "materialize_candidates", actionLabel: "使用候选物化动作" },
  { field: "configurationSnapshots", reason: "published_history", action: "publish / view_snapshot", actionLabel: "使用 Model 发布或查看冻结 Snapshot" },
  { field: "ruleSetVersions", reason: "published_history", action: "publish_ruleset", actionLabel: "使用 RuleSet 草稿与发布" },
  { field: "reductionStackingPolicyVersions", reason: "published_history", action: "POST /api/feishu-workbook（pull_feishu_workbook / publish_ruleset）", actionLabel: "通过工作簿草稿与 RuleSet 发布流程发布策略", route: "/api/feishu-workbook" },
  { field: "performanceSummaryDefinitions", reason: "published_history", action: "只读：当前没有发布或修改 PerformanceSummaryDefinition 的领域命令", actionLabel: "保留已发布定义；等待专用版本化发布命令" },
  { field: "pricingPolicyVersions", reason: "published_history", action: "定价策略发布", actionLabel: "使用定价策略发布流程" },
  { field: "qualityValuePolicyDrafts", reason: "domain_command", action: "规则源草稿/发布动作", actionLabel: "使用品质策略草稿或发布动作" },
  { field: "pricingPolicyDrafts", reason: "domain_command", action: "规则源草稿/发布动作", actionLabel: "使用定价策略草稿或发布动作" },
  { field: "fiveAxisViewDefinitions", reason: "published_history", action: "publish_five_axis_definition", actionLabel: "使用五维定义发布动作" },
  { field: "fiveAxisVertexSets", reason: "published_history", action: "五维定义发布/重算", actionLabel: "使用五维定义发布或重算动作" },
  { field: "workspacePolicies", reason: "published_history", action: "manage_workspace_policy", actionLabel: "使用工作区策略治理动作" },
  { field: "configIdGovernance", reason: "audit_or_reserved_identity", action: "config.id.* ActionCode", actionLabel: "使用配置身份预留、导入或策略发布动作", route: "/api/action-commands" },
  { field: "feishuSourceRevisions", reason: "audit_or_reserved_identity", action: "pull_feishu_workbook / pull_feishu_source", actionLabel: "显式拉取飞书规则源" },
  { field: "feishuWorkbooks", reason: "audit_or_reserved_identity", action: "inspect_feishu_workbook", actionLabel: "使用飞书工作簿检查动作" },
  { field: "sourceIdentityMigrationReports", reason: "audit_or_reserved_identity", action: "迁移流程", actionLabel: "使用迁移流程重新生成报告" },
  { field: "patchReviewBatches", reason: "audit_or_reserved_identity", action: "review_patch", actionLabel: "使用 Patch 审核动作" },
  { field: "patchValidationWaivers", reason: "audit_or_reserved_identity", action: "request/approve_validation_waiver", actionLabel: "使用校验豁免动作" },
  { field: "patchValidationWaiverDecisions", reason: "audit_or_reserved_identity", action: "approve_validation_waiver", actionLabel: "使用校验豁免审批动作" },
  { field: "upgradeCandidates", reason: "audit_or_reserved_identity", action: "规则发布或重新计算", actionLabel: "通过上游发布或重算产生升级候选" },
  { field: "ruleChangeProposals", reason: "audit_or_reserved_identity", action: "create_rule_source_change_draft", actionLabel: "使用规则变更草稿动作" },
  { field: "aiAssessments", reason: "audit_or_reserved_identity", action: "run_ai_assessment", actionLabel: "使用 AI 评估动作" },
  { field: "dataSourceImports", reason: "audit_or_reserved_identity", action: "publish_data_source", actionLabel: "使用数据源发布动作" },
  { field: "dataSourceBindings", reason: "audit_or_reserved_identity", action: "publish_data_source / commit_data_source_writeback", actionLabel: "通过数据源发布或回写回读重建绑定" },
  { field: "dataSourceWritebacks", reason: "audit_or_reserved_identity", action: "commit_data_source_writeback", actionLabel: "使用数据源回写动作" },
  { field: "importedAt", reason: "audit_or_reserved_identity", action: "publish_data_source", actionLabel: "通过数据源发布回读更新时间" },
  { field: "identityAuditLog", reason: "audit_or_reserved_identity", action: "服务器身份/审计动作", actionLabel: "重新执行对应身份动作" },
  { field: "commandIdempotencyRecords", reason: "audit_or_reserved_identity", action: "服务器领域命令", actionLabel: "重试原领域动作" },
  { field: "governanceAuditLog", reason: "audit_or_reserved_identity", action: "服务器领域命令", actionLabel: "重新执行对应领域动作" },
  // Migration review items preserve lossless migration evidence. They are not a
  // workbench form and no command currently exists to rewrite them.
  { field: "migrationReviewItems", reason: "audit_or_reserved_identity", action: "只读：当前没有修改迁移复核证据的领域命令", actionLabel: "保留证据并通过新的迁移流程处理" },
  { field: "revisions", reason: "audit_or_reserved_identity", action: "服务器工作区保存", actionLabel: "保存普通字段以创建新 revision" },
];

const GOVERNED_STATE_FIELD_BY_NAME = new Map(GOVERNED_STATE_FIELDS.map((entry) => [entry.field, entry]));

export function isGovernedStateField(field: string): boolean {
  return GOVERNED_STATE_FIELD_BY_NAME.has(field);
}

export function governedStateFieldDetails(fields: readonly string[]): GovernedStateField[] {
  return fields.flatMap((field) => {
    const detail = GOVERNED_STATE_FIELD_BY_NAME.get(field);
    return detail ? [detail] : [];
  });
}

/**
 * These fields are response/source metadata maintained by server transactions,
 * not editable WorkspaceState aggregates. A tab may legitimately carry older
 * projections after another save. Always replace them with current authority
 * before validation or persistence.
 */
export function preserveServerManagedWorkspaceMetadata(
  current: WorkspaceState,
  proposed: WorkspaceState,
): WorkspaceState {
  return {
    ...proposed,
    schemaVersion: current.schemaVersion,
    revisions: current.revisions,
    importedAt: current.importedAt,
  };
}

export function findGovernedStateChanges(current: WorkspaceState, proposed: WorkspaceState): string[] {
  const currentRecord = current as unknown as Record<string, unknown>;
  const proposedRecord = proposed as unknown as Record<string, unknown>;
  return GOVERNED_STATE_FIELDS
    .map((entry) => entry.field)
    .filter((field) => stableStringify(currentRecord[field]) !== stableStringify(proposedRecord[field]));
}

export function changesOnlyReadOnlyLegacyHistory(changes: string[]): boolean {
  return changes.length > 0 && changes.every(isReadOnlyLegacyProductField);
}

export function stableAuditActor(identity: RequestIdentity): string {
  if (identity.tenantKey && identity.openId) return `feishu:${identity.tenantKey}:${identity.openId}`;
  return identity.name.trim() || identity.email.trim() || "unknown-actor";
}
