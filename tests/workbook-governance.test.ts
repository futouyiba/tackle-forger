import assert from "node:assert/strict";
import test from "node:test";
import { createSeedState } from "../lib/seed";
import {
  assertExplicitPullDidNotPublish,
  createRuleSetDraftFromPull,
  publishReductionStackingPolicyFromPull,
  publishRuleSetVersion,
  recordFeishuSourceRevision,
  recordQualityValuePolicyDraft,
} from "../lib/workbook-governance";
import { CANONICAL_FEISHU_SHEET_REGISTRY } from "../lib/feishu-workbook";
import type { QualityValuePolicyDraft } from "../lib/quality-value-policy";

const reductionPolicyMachineRules = [{
  ruleId: "OPEN-001:bidirectional-ratio",
  parameterKey: "*",
  strategy: "bidirectional_ratio" as const,
  numericContract: "ieee754-binary64-v1" as const,
  operationOrder: [
    "set",
    "percent_adjust",
    "flat_adjust",
    "clamp_add",
    "final_review_patch",
    "parameter_definition",
  ],
}];

function publishReductionPolicy(
  state: ReturnType<typeof createSeedState>,
  sourceRevisionId: string,
) {
  const draft = state.reductionStackingPolicyVersions.find(
    (policy) => policy.status === "draft"
      && (
        policy.source?.sourceRevisionId === sourceRevisionId
        || policy.issues.some((issue) =>
          issue.evidence?.sourceRevision === sourceRevisionId
        )
      ),
  ) ?? state.reductionStackingPolicyVersions.find((policy) => policy.status === "draft");
  assert.ok(draft);
  return publishReductionStackingPolicyFromPull({
    state,
    policyDraftId: draft.id,
    publishedAt: "2026-07-22T02:01:30.000Z",
    publishedBy: "policy-reviewer",
  }).state;
}

test("显式拉取只登记 FeishuSourceRevision，创建草稿也不会发布 RuleSetVersion", () => {
  const initial = createSeedState();
  const revision = {
    id: "feishu-revision:test-2352",
    workbookRefId: "feishu-workbook:tackle-design",
    sourceRevision: "2352",
    spreadsheetToken: "spreadsheet:1",
    pulledAt: "2026-07-21T10:00:00.000Z",
    pulledBy: "tester",
    anchorSheetId: "9nE3Rx",
    syncScope: "workbook" as const,
    registryHash: "registry:1",
    sheets: CANONICAL_FEISHU_SHEET_REGISTRY.map((entry) => ({ sheetId: entry.sheetId, name: entry.expectedName })),
    issues: [],
    state: "PULLED" as const,
  };
  const pulled = recordFeishuSourceRevision(initial, revision);
  const qualityDraft: QualityValuePolicyDraft = {
    id: "quality-policy-draft:test-2352",
    sourceRevisionId: revision.id,
    sourceRevision: revision.sourceRevision,
    qualitySheetId: "FqD4j7",
    affixSheetId: "zrVOxd",
    ranges: [],
    combinationRules: [],
    issues: [],
    formalStatus: "NON_FORMAL",
    inputHash: "quality-hash:test-2352",
    importedAt: revision.pulledAt,
  };
  const withQuality = recordQualityValuePolicyDraft(pulled, qualityDraft);
  const withQualityAgain = recordQualityValuePolicyDraft(withQuality, qualityDraft);
  assertExplicitPullDidNotPublish(initial, pulled);
  assert.equal(pulled.feishuSourceRevisions[0].sourceRevision, "2352");
  assert.equal(withQualityAgain.qualityValuePolicyDrafts.length, 1);
  assert.equal(withQualityAgain.qualityValuePolicyDrafts[0].sourceRevisionId, revision.id);
  assertExplicitPullDidNotPublish(initial, withQualityAgain);

  const drafted = createRuleSetDraftFromPull({
    state: withQualityAgain,
    sourceRevisionId: revision.id,
    createdAt: "2026-07-21T10:01:00.000Z",
    createdBy: "tester",
  });
  assert.equal(drafted.ruleSetDraft.status, "draft");
  assert.deepEqual(drafted.ruleSetDraft.sourceRevisionIds, [revision.id]);
  assertExplicitPullDidNotPublish(initial, drafted.state);
  assert.equal(drafted.state.feishuSourceRevisions[0].state, "RULESET_DRAFT");
});

test("品质策略草稿不能引用未登记的飞书修订", () => {
  const initial = createSeedState();
  assert.throws(() => recordQualityValuePolicyDraft(initial, {
    id: "quality-policy-draft:orphan",
    sourceRevisionId: "feishu-revision:missing",
    sourceRevision: "missing",
    qualitySheetId: "FqD4j7",
    affixSheetId: "zrVOxd",
    ranges: [],
    combinationRules: [],
    issues: [],
    formalStatus: "NON_FORMAL",
    inputHash: "orphan",
    importedAt: "2026-07-22T00:00:00.000Z",
  }), /尚未登记/);
});

test("相同源修订重复创建 RuleSet 草稿保持幂等", () => {
  const initial = createSeedState();
  const revision = {
    id: "feishu-revision:idempotent",
    workbookRefId: "feishu-workbook:tackle-design",
    sourceRevision: "2352",
    spreadsheetToken: "spreadsheet:1",
    pulledAt: "2026-07-21T10:00:00.000Z",
    pulledBy: "tester",
    syncScope: "workbook" as const,
    registryHash: "registry:1",
    sheets: [],
    issues: [],
    state: "PULLED" as const,
  };
  const pulled = recordFeishuSourceRevision(initial, revision);
  const first = createRuleSetDraftFromPull({ state: pulled, sourceRevisionId: revision.id, createdAt: "2026-07-21T10:01:00.000Z", createdBy: "tester" });
  const second = createRuleSetDraftFromPull({ state: first.state, sourceRevisionId: revision.id, createdAt: "2026-07-21T10:02:00.000Z", createdBy: "tester" });
  assert.equal(second.ruleSetDraft.id, first.ruleSetDraft.id);
  assert.equal(second.state.ruleSetVersions.filter((item) => item.id === first.ruleSetDraft.id).length, 1);
});

test("RuleSetVersion 只能经独立发布动作生效，重复发布幂等且 Snapshot 冻结", () => {
  const initial = createSeedState();
  const frozenSnapshots = structuredClone(initial.configurationSnapshots);
  const revision = {
    id: "feishu-revision:publish",
    workbookRefId: "feishu-workbook:tackle-design",
    sourceRevision: "2869",
    spreadsheetToken: "spreadsheet:publish",
    pulledAt: "2026-07-22T02:00:00.000Z",
    pulledBy: "tester",
    syncScope: "workbook" as const,
    registryHash: "registry:publish",
    sheets: [{ sheetId: "zrVOxd", name: "04_词条" }],
    reductionPolicyMachineRules,
    issues: [],
    state: "PULLED" as const,
  };
  const pulled = recordFeishuSourceRevision(initial, revision);
  const drafted = createRuleSetDraftFromPull({ state: pulled, sourceRevisionId: revision.id, createdAt: "2026-07-22T02:01:00.000Z", createdBy: "author" });
  assert.equal(drafted.ruleSetDraft.status, "draft");
  const withPolicy = publishReductionPolicy(drafted.state, revision.id);
  const published = publishRuleSetVersion({
    state: withPolicy,
    ruleSetDraftId: drafted.ruleSetDraft.id,
    publishedAt: "2026-07-22T02:02:00.000Z",
    publishedBy: "reviewer",
  });
  assert.equal(published.ruleSetVersion.status, "published");
  assert.equal(published.ruleSetVersion.publishedBy, "reviewer");
  assert.ok(published.ruleSetVersion.publicationHash);
  assert.equal(published.state.feishuSourceRevisions.find((item) => item.id === revision.id)?.state, "PUBLISHED");
  assert.deepEqual(published.state.configurationSnapshots, frozenSnapshots);

  const retried = publishRuleSetVersion({
    state: published.state,
    ruleSetDraftId: drafted.ruleSetDraft.id,
    publishedAt: "2026-07-22T03:00:00.000Z",
    publishedBy: "reviewer",
  });
  assert.equal(retried.ruleSetVersion.publicationHash, published.ruleSetVersion.publicationHash);
  assert.deepEqual(retried.state, published.state);
});

test("RuleSet 发布阻断源 error，并要求逐项确认 warning", () => {
  const initial = createSeedState();
  const makeDraft = (severity: "warning" | "error") => {
    const revision = {
      id: `feishu-revision:${severity}`,
      workbookRefId: "feishu-workbook:tackle-design",
      sourceRevision: severity,
      spreadsheetToken: "spreadsheet:issue",
      pulledAt: "2026-07-22T02:00:00.000Z",
      pulledBy: "tester",
      syncScope: "workbook" as const,
      registryHash: `registry:${severity}`,
      sheets: [{ sheetId: "zrVOxd", name: "04_词条" }],
      reductionPolicyMachineRules,
      issues: [{ code: "SHEET_RENAMED" as const, severity, sheetId: "d6e928", message: "工作表改名" }],
      state: "PULLED" as const,
    };
    const pulled = severity === "error"
      ? { ...initial, feishuSourceRevisions: [revision] }
      : recordFeishuSourceRevision(initial, revision);
    return createRuleSetDraftFromPull({ state: pulled, sourceRevisionId: revision.id, createdAt: "2026-07-22T02:01:00.000Z", createdBy: "author" });
  };

  const warned = makeDraft("warning");
  const warnedWithPolicy = publishReductionPolicy(
    warned.state,
    warned.ruleSetDraft.sourceRevisionIds[0],
  );
  assert.throws(() => publishRuleSetVersion({
    state: warnedWithPolicy,
    ruleSetDraftId: warned.ruleSetDraft.id,
    publishedAt: "2026-07-22T02:02:00.000Z",
    publishedBy: "reviewer",
  }), /逐项确认 warning/);
  const acknowledged = publishRuleSetVersion({
    state: warnedWithPolicy,
    ruleSetDraftId: warned.ruleSetDraft.id,
    publishedAt: "2026-07-22T02:02:00.000Z",
    publishedBy: "reviewer",
    warningAcknowledgements: [{ issueKey: "SHEET_RENAMED:d6e928", reason: "已确认名称变化，sheet_id 未变化" }],
  });
  assert.equal(acknowledged.ruleSetVersion.warningAcknowledgements?.length, 1);

  const blocked = makeDraft("error");
  assert.throws(() => publishRuleSetVersion({
    state: blocked.state,
    ruleSetDraftId: blocked.ruleSetDraft.id,
    publishedAt: "2026-07-22T02:02:00.000Z",
    publishedBy: "reviewer",
  }), /阻断错误/);
});
test("新显式拉取出现后，旧 RuleSet 草稿必须重建而不能发布", () => {
  const initial = createSeedState();
  const source = (id: string, pulledAt: string) => ({
    id,
    workbookRefId: "feishu-workbook:tackle-design",
    sourceRevision: id,
    spreadsheetToken: "spreadsheet:stale",
    pulledAt,
    pulledBy: "tester",
    syncScope: "workbook" as const,
    registryHash: id,
    sheets: [],
    issues: [],
    state: "PULLED" as const,
  });
  const oldSource = source("revision:old", "2026-07-22T01:00:00.000Z");
  const drafted = createRuleSetDraftFromPull({
    state: recordFeishuSourceRevision(initial, oldSource),
    sourceRevisionId: oldSource.id,
    createdAt: "2026-07-22T01:01:00.000Z",
    createdBy: "author",
  });
  const newerSource = source("revision:new", "2026-07-22T02:00:00.000Z");
  const withNewPull = recordFeishuSourceRevision(drafted.state, newerSource);
  assert.throws(() => publishRuleSetVersion({
    state: withNewPull,
    ruleSetDraftId: drafted.ruleSetDraft.id,
    publishedAt: "2026-07-22T02:01:00.000Z",
    publishedBy: "reviewer",
  }), /源修订已过期/);
});
