import assert from "node:assert/strict";
import test from "node:test";
import { createSeedState } from "../lib/seed";
import {
  assertExplicitPullDidNotPublish,
  createRuleSetDraftFromPull,
  recordFeishuSourceRevision,
  recordQualityValuePolicyDraft,
} from "../lib/workbook-governance";
import { CANONICAL_FEISHU_SHEET_REGISTRY } from "../lib/feishu-workbook";
import type { QualityValuePolicyDraft } from "../lib/quality-value-policy";

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
