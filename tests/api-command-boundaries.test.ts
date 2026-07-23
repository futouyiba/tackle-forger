import assert from "node:assert/strict";
import test from "node:test";
import { createSeedState } from "../lib/seed";
import {
  changesOnlyReadOnlyLegacyHistory,
  findGovernedStateChanges,
  findReadOnlyLegacyProductChanges,
  governedStateFieldDetails,
  preserveServerManagedWorkspaceMetadata,
  stableAuditActor,
} from "../lib/api-command-boundaries";
import { parseDiscretePulls } from "../lib/series-create-contract";

test("旧产品集合全部是整包保存的只读历史", () => {
  const current = createSeedState();
  const proposed = structuredClone(current);
  proposed.recipes[0] = { ...proposed.recipes[0]!, name: "禁止修改的旧配方" };
  proposed.candidates[0] = {
    ...proposed.candidates[0]!,
    notes: "禁止修改的旧 Candidate",
  };
  proposed.officialSkus.push({ id: "legacy:injected" } as never);
  proposed.detailOverrides.push({ skuId: "legacy:injected" } as never);

  assert.deepEqual(findGovernedStateChanges(current, proposed), [
    "recipes", "candidates", "officialSkus", "detailOverrides",
  ]);
  assert.deepEqual(findReadOnlyLegacyProductChanges(current, proposed), [
    "recipes", "candidates", "officialSkus", "detailOverrides",
  ]);
  assert.equal(changesOnlyReadOnlyLegacyHistory(["recipes", "candidates"]), true);
  assert.equal(changesOnlyReadOnlyLegacyHistory(["recipes", "seriesDefinitions"]), false);
  assert.equal(changesOnlyReadOnlyLegacyHistory([]), false);
});

test("整包保存默认放行常规工作台字段，只拦已发布/旧历史/领域命令字段", () => {
  const current = createSeedState();

  // 常规工作台字段一律放行（否则配置工作台连加一个重量段都存不进去）
  const notesOnly = structuredClone(current);
  notesOnly.notes = "ordinary workspace note";
  assert.deepEqual(findGovernedStateChanges(current, notesOnly), []);

  const templates = structuredClone(current);
  templates.templates = [...templates.templates, { ...templates.templates[0]!, id: "T:put-allowed" }];
  assert.deepEqual(findGovernedStateChanges(current, templates), []);

  const ruleData = structuredClone(current);
  ruleData.compatibilityRules = [];
  assert.deepEqual(findGovernedStateChanges(current, ruleData), []);

  const settings = structuredClone(current);
  settings.ruleSettings = { ...settings.ruleSettings, reductionStackingMode: "linear_subtraction" };
  assert.deepEqual(findGovernedStateChanges(current, settings), []);

  const injected = { ...structuredClone(current), unexpectedDomainState: { enabled: true } };
  assert.deepEqual(findGovernedStateChanges(current, injected as typeof current), []);

  // 受治理字段：已发布不可变 / 只读旧历史 / 有专属领域命令
  const bypass = structuredClone(current);
  bypass.seriesDefinitions.push({ ...bypass.seriesDefinitions[0]!, id: "series:bypass" });
  assert.deepEqual(findGovernedStateChanges(current, bypass), ["seriesDefinitions"]);

  const snapshots = structuredClone(current);
  snapshots.configurationSnapshots = [...snapshots.configurationSnapshots, { id: "snapshot:bypass" } as never];
  assert.deepEqual(findGovernedStateChanges(current, snapshots), ["configurationSnapshots"]);

  const ruleSets = structuredClone(current);
  ruleSets.ruleSetVersions = [...ruleSets.ruleSetVersions, { id: "ruleset:bypass" } as never];
  assert.deepEqual(findGovernedStateChanges(current, ruleSets), ["ruleSetVersions"]);

  const legacyDomainCollection = structuredClone(current);
  legacyDomainCollection.recipes = [];
  assert.deepEqual(findGovernedStateChanges(current, legacyDomainCollection), ["recipes"]);
});

test("受治理边界覆盖命令、发布历史、审计与永久身份，且嵌套改动也不可绕过", () => {
  const current = createSeedState();
  const cases: Array<{ field: string; action: string }> = [
    { field: "patchLedger", action: "Patch ActionCode（create/review/rebase/mirror）" },
    { field: "projectionPatches", action: "只读：遗留 ProjectionPatch 仅供迁移与审计" },
    { field: "configIdGovernance", action: "config.id.* ActionCode" },
    { field: "derivedProjections", action: "规则发布后重新演绎" },
    { field: "projectionMatches", action: "SKU/Model 领域命令" },
    { field: "partConstraintSets", action: "只读：当前没有修改既有约束 revision 的领域命令" },
    { field: "candidateSearchRecipes", action: "只读：当前没有修改既有候选 Recipe revision 的领域命令" },
    { field: "purchasableModels", action: "Model ActionCode（edit/review/publish）" },
    { field: "performanceSummaryDefinitions", action: "只读：当前没有发布或修改 PerformanceSummaryDefinition 的领域命令" },
    { field: "candidateRuns", action: "generate_candidates" },
    { field: "candidateMaterializations", action: "materialize_candidates" },
    { field: "feishuSourceRevisions", action: "pull_feishu_workbook / pull_feishu_source" },
    { field: "pricingPolicyVersions", action: "定价策略发布" },
    { field: "fiveAxisViewDefinitions", action: "publish_five_axis_definition" },
    { field: "fiveAxisVertexSets", action: "五维定义发布/重算" },
    { field: "workspacePolicies", action: "manage_workspace_policy" },
    { field: "patchReviewBatches", action: "review_patch" },
    { field: "patchValidationWaivers", action: "request/approve_validation_waiver" },
    { field: "patchValidationWaiverDecisions", action: "approve_validation_waiver" },
    { field: "identityAuditLog", action: "服务器身份/审计动作" },
    { field: "commandIdempotencyRecords", action: "服务器领域命令" },
    { field: "governanceAuditLog", action: "服务器领域命令" },
    { field: "upgradeCandidates", action: "规则发布或重新计算" },
    { field: "ruleChangeProposals", action: "create_rule_source_change_draft" },
    { field: "aiAssessments", action: "run_ai_assessment" },
    { field: "dataSourceBindings", action: "publish_data_source / commit_data_source_writeback" },
    { field: "migrationReviewItems", action: "只读：当前没有修改迁移复核证据的领域命令" },
  ];
  for (const entry of cases) {
    const proposed = structuredClone(current) as unknown as Record<string, unknown>;
    const value = proposed[entry.field];
    proposed[entry.field] = Array.isArray(value)
      ? [...value, { nested: { changed: true } }]
      : { ...(value as Record<string, unknown>), nested: { changed: true } };
    assert.deepEqual(findGovernedStateChanges(current, proposed as unknown as typeof current), [entry.field], entry.field);
    assert.equal(governedStateFieldDetails([entry.field])[0]?.action, entry.action, entry.field);
  }
});

test("未来普通字段仍默认允许，且稳定比较不会把对象键顺序当成变更", () => {
  const current = createSeedState();
  const proposed = {
    ...structuredClone(current),
    futureWorkspaceField: { enabled: true, nested: { note: "keep me" } },
  } as typeof current;
  assert.deepEqual(findGovernedStateChanges(current, proposed), []);
  const reordered = structuredClone(current);
  reordered.notes = "普通备注";
  assert.deepEqual(findGovernedStateChanges(current, reordered), []);
});

test("服务端维护的 workspace revision 摘要始终以当前权威值投影，不能阻断或伪造保存", () => {
  const current = createSeedState();
  current.revisions = [{ revision: 7, author: "server", message: "latest", createdAt: "2026-01-01T00:00:00.000Z" }];
  current.importedAt = "2026-01-02T00:00:00.000Z";
  const stale = structuredClone(current);
  stale.revisions = [{ revision: 1, author: "client", message: "forged", createdAt: "2020-01-01T00:00:00.000Z" }];
  stale.schemaVersion = 1;
  stale.importedAt = "2020-01-01T00:00:00.000Z";
  stale.notes = "ordinary local edit";
  const projected = preserveServerManagedWorkspaceMetadata(current, stale);
  assert.deepEqual(projected.revisions, current.revisions);
  assert.equal(projected.schemaVersion, current.schemaVersion);
  assert.equal(projected.importedAt, current.importedAt);
  assert.equal(projected.notes, "ordinary local edit");
  assert.deepEqual(findGovernedStateChanges(current, projected), []);
});

test("飞书审计身份优先使用稳定 tenant/openId，且永不为空", () => {
  assert.equal(stableAuditActor({
    authenticated: true, provider: "feishu", tenantKey: "tenant", openId: "open",
    email: "", name: "策划", role: "editor", capabilities: [],
  }), "feishu:tenant:open");
  assert.equal(stableAuditActor({
    authenticated: true, provider: "feishu", email: "", name: "策划",
    role: "editor", capabilities: [],
  }), "策划");
});

test("离散拉力解析完整报告非法 token 和重复项", () => {
  assert.deepEqual(parseDiscretePulls("1.5, abc, -3, 8.2, 1.5"), {
    values: [1.5, 8.2],
    invalidTokens: ["abc", "-3"],
    duplicateValues: [1.5],
  });
  assert.deepEqual(parseDiscretePulls("1.5；3.8 8.2"), {
    values: [1.5, 3.8, 8.2], invalidTokens: [], duplicateValues: [],
  });
});
