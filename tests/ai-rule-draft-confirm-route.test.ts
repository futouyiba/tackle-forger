import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../app/api/ai/rule-source-change-drafts/confirm/route";
import { loadWorkspaceState, saveWorkspaceState } from "../lib/storage";

const headers = {
  "content-type": "application/json",
  "x-feishu-tenant-key": "tenant",
  "x-feishu-open-id": "rule-reviewer",
  "x-feishu-display-name": "Rule Reviewer",
  "x-tf-proxy-secret": "rule-confirm-secret",
};

test("AI 规则草稿通过专用 API 确认、重载并幂等恢复", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tackle-forger-rule-confirm-"));
  const previous = process.env.WORKSPACE_DATABASE_PATH;
  try {
    process.env.WORKSPACE_DATABASE_PATH = path.join(root, "workspace.sqlite");
    process.env.FEISHU_TRUST_PROXY_HEADERS = "true";
    process.env.FEISHU_PROXY_SHARED_SECRET = "rule-confirm-secret";
    process.env.FEISHU_TENANT_KEY = "tenant";
    const initial = await loadWorkspaceState();
    const state = structuredClone(initial.state);
    state.feishuSourceRevisions = [{
      id: "source:1", workbookRefId: "workbook:1", sourceRevision: "rev-1",
      spreadsheetToken: "token-1", pulledAt: "2026-07-23T00:00:00.000Z",
      pulledBy: "planner", syncScope: "workbook", registryHash: "hash",
      sheets: [{ sheetId: "fATowU", name: "rules" }], issues: [], state: "PULLED",
    }];
    state.aiRuleSourceChangeDrafts = [{
      changeDraftId: "ai-rule-source-change:test", originAssessmentId: "assessment:1",
      originRecommendationId: "recommendation:1", sourceObjectRefs: [],
      targetRuleRef: { spreadsheetToken: "token-1", sheetId: "fATowU", stableRuleId: "rule-1", parameterKey: "pull", sourceRevision: "rev-1" },
      proposedChange: { changeId: "change-1", parameterKey: "pull", operation: "add", operand: 1, expectedBefore: 2 },
      evidenceRefs: [], impactPreview: {
        evaluatedRuleSetVersion: "ruleset:1", affectedSeries: 1, affectedSkus: 1,
        affectedModels: 1, newErrors: 0, resolvedErrors: 0, sampleDiffRefs: [],
        publishedSnapshotsChanged: 0, upgradeCandidatesExpected: 0,
        coverage: { evaluatedModels: 1, totalModels: 1, complete: true, unavailableModelIds: [] },
      },
      state: "LOCAL_DRAFT", idempotencyKey: "create:1", commandHash: "draft-command-hash",
      createdBy: "planner", createdAt: "2026-07-23T00:00:00.000Z",
      provenance: {
        assessmentInputHash: "input-hash",
        modelDescriptor: {
          provider: "fancy_hub", modelId: "model",
          revisions: { modelVersion: "1", deploymentRevision: "1", modelArtifactDigest: "sha256:test" },
          revisionIdentityHash: "a".repeat(64), modelListSnapshotHash: "b".repeat(64),
        },
        selectedRecommendation: {}, evidenceContentHashes: [], humanDiff: {},
      },
    }];
    const prepared = await saveWorkspaceState({ state, baseRevision: initial.revision, author: "test", message: "prepare" });
    const body = {
      baseRevision: prepared.revision,
      changeDraftId: "ai-rule-source-change:test",
      expectedCommandHash: "draft-command-hash",
      idempotencyKey: "confirm:1",
    };
    const response = await POST(new NextRequest("http://localhost/api/ai/rule-source-change-drafts/confirm", {
      method: "POST", headers, body: JSON.stringify(body),
    }));
    assert.equal(response.status, 200);
    const result = await response.json() as { revision: number };
    const reloaded = await loadWorkspaceState();
    assert.equal(reloaded.revision, result.revision);
    assert.equal(reloaded.state.aiRuleSourceChangeDrafts[0]?.state, "CONFIRMED");
    assert.equal(reloaded.state.aiRuleSourceChangeDrafts[0]?.humanReview?.confirmedBy, "feishu:tenant:rule-reviewer");

    const retry = await POST(new NextRequest("http://localhost/api/ai/rule-source-change-drafts/confirm", {
      method: "POST", headers, body: JSON.stringify(body),
    }));
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as { idempotent: boolean }).idempotent, true);
    assert.equal((await loadWorkspaceState()).revision, result.revision);
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_DATABASE_PATH;
    else process.env.WORKSPACE_DATABASE_PATH = previous;
  }
});
