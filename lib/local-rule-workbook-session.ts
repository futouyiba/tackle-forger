/**
 * local-rule-workbook-session.ts — 本地匿名临时投影引擎
 *
 * 将浏览器端 inspectBrowserCanonicalWorkbook 返回的纯 inspection
 * 投影到内存中的 WorkspaceState 副本，仅替换调试所需的领域字段。
 *
 * 硬约束（无例外）：
 * - 不调用 applyCanonicalRuleSourceDraft()
 * - 不写 feishuSourceRevisions、ruleSetVersions、audit logs、server revision
 * - 不导入 auth / storage / sqlite / Next route / server-only 模块
 * - 不产生"已拉取/已发布"假象
 */

import type { CanonicalRuleWorkbookParsedInspection } from "./canonical-workbook-core";
import type { WorkspaceState } from "./types";

/**
 * 将 inspection 中的领域数据投影到 WorkspaceState 副本。
 *
 * 投影的字段：
 * - parameters → canonicalRuleDraft.parameters
 * - templates → canonicalRuleDraft.templates
 * - methodProfiles → canonicalRuleDraft.methodProfiles
 * - itemTypeProfiles → canonicalRuleDraft.itemTypeProfiles
 * - functionProfiles → canonicalRuleDraft.functionProfiles
 * - modifiers (modifierOptions) → canonicalRuleDraft.modifiers
 * - seriesDefinitions → inspection.seriesDefinitions
 *
 * 保留 seed 原值（不投影）：
 * - layers、affixes、qualityBands、affixScorePolicy
 * - feishuSourceRevisions、ruleSetVersions、sourceIdentityMigrationReports
 * - canonicalRuleSourceDrafts / weightTemplatePolicyDrafts 等治理草稿
 * - revisions、workspaceId、所有审计/发布/导出字段
 *
 * @returns 新的 WorkspaceState（深拷贝），不修改入参
 */
export function projectLocalRuleWorkbookSession(
  inspection: CanonicalRuleWorkbookParsedInspection,
  baseState: WorkspaceState,
): WorkspaceState {
  const draft = structuredClone(baseState);

  const cd = inspection.canonicalRuleDraft;

  // 核心领域数据（直接替换）
  draft.parameters = structuredClone(cd.parameters);
  draft.templates = structuredClone(cd.templates);
  draft.methodProfiles = structuredClone(cd.methodProfiles);
  draft.itemTypeProfiles = structuredClone(cd.itemTypeProfiles);
  draft.functionProfiles = structuredClone(cd.functionProfiles);
  draft.modifiers = structuredClone(cd.modifiers);

  // SeriesDefinition（来自 25UnTC 富字段解析）
  draft.seriesDefinitions = structuredClone(inspection.seriesDefinitions);

  // 治理字段清零——本地临时会话不保留任何飞书治理数据
  draft.feishuSourceRevisions = [];
  draft.ruleSetVersions = [];
  draft.sourceIdentityMigrationReports = [];
  draft.canonicalRuleSourceDrafts = [];
  draft.weightTemplatePolicyDrafts = [];
  draft.qualityValuePolicyDrafts = [];
  draft.pricingPolicyDrafts = [];
  draft.revisions = [];

  return draft;
}
