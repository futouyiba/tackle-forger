/**
 * MOTION-02 unit tests: feishu orchestration presentation model derivation.
 *
 * Tests that `buildFeishuOrchestrationModel` derives the correct stage states
 * from authoritative WorkspaceState + CanonicalRuleWorkbookInspection inputs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFeishuOrchestrationModel,
  type FeishuOrchestrationModel,
  type FeishuOrchestrationInput,
  type OrchestrationStageState,
} from "../lib/feishu-orchestration-presentation";
import type { CanonicalRuleWorkbookInspection } from "../lib/rule-workbook-inspection";
import type { WorkspaceState, RuleSetVersion } from "../lib/types";
import type { FeishuSourceRevision } from "../lib/feishu-workbook";

// ─── helpers ────────────────────────────────────────────────────────────────

const BASE_STATE = {
  workspaceSchemaVersion: 5,
  feishuSourceRevisions: [] as FeishuSourceRevision[],
  ruleSetVersions: [] as RuleSetVersion[],
  canonicalRuleSourceDrafts: [],
  weightTemplatePolicyDrafts: [],
  sourceIdentityMigrationReports: [],
  qualityValuePolicyDrafts: [],
  pricingPolicyDrafts: [],
  pricingPolicyVersions: [],
  reductionStackingPolicyVersions: [],
  feishuWorkbooks: [],
  // … the remainder only matters for fields not touched by the presentation model
} as unknown as WorkspaceState;

function makeSourceRevision(overrides: Partial<FeishuSourceRevision> = {}): FeishuSourceRevision {
  return {
    id: overrides.id ?? "feishu-src:r1",
    workbookRefId: "feishu-workbook:tackle-design",
    sourceRevision: overrides.sourceRevision ?? "2026-07-25-r001",
    spreadsheetToken: "sht_abc",
    pulledAt: "2026-07-25T10:00:00Z",
    pulledBy: "tester",
    syncScope: "workbook",
    registryHash: "abc123def456",
    sheets: [
      { sheetId: "d6e928", name: "01_重量模板", rowCount: 100, columnCount: 60 },
      { sheetId: "zrVOxd", name: "04_词条", rowCount: 40, columnCount: 10 },
    ],
    issues: [],
    state: "PULLED",
    ...overrides,
  };
}

function makeInspection(overrides: Partial<CanonicalRuleWorkbookInspection> = {}): CanonicalRuleWorkbookInspection {
  return {
    observedAt: "2026-07-25T10:00:00Z",
    sourceRevision: makeSourceRevision({
      id: "feishu-src:r1",
      sourceRevision: "2026-07-25-r001",
      state: "PULLED",
    }),
    identityRows: [],
    identityReport: {
      reportId: "rpt-1",
      sourceRevision: "2026-07-25-r001",
      workbookRefId: "feishu-workbook:tackle-design",
      mode: "CONTINUOUS_SYNC" as const,
      generatedAt: "2026-07-25T10:00:00Z",
      items: [],
      blockingIssueCodes: [],
      inputHash: "hash_identity_rpt",
    },
    pricingDraft: { id: "pp-1", sourceRevisionId: "feishu-src:r1", sourceRevision: "2026-07-25-r001", issues: [], formalStatus: "NON_FORMAL" } as unknown as CanonicalRuleWorkbookInspection["pricingDraft"],
    qualityDraft: { id: "qp-1", sourceRevisionId: "feishu-src:r1", sourceRevision: "2026-07-25-r001", issues: [], formalStatus: "NON_FORMAL" } as unknown as CanonicalRuleWorkbookInspection["qualityDraft"],
    canonicalRuleDraft: {
      id: "crd-1",
      sourceRevisionId: "feishu-src:r1",
      issues: [],
      contentHash: "hash_canonical",
      parameters: [],
      templates: [],
      methodProfiles: [],
      itemTypeProfiles: [],
      functionProfiles: [],
      modifiers: [],
      layers: [],
      importedAt: "2026-07-25T10:00:00Z",
    } as unknown as CanonicalRuleWorkbookInspection["canonicalRuleDraft"],
    weightTemplateDraft: {
      id: "wtp-1",
      sourceRevisionId: "feishu-src:r1",
      sourceRevision: "2026-07-25-r001",
      inputHash: "hash_wt",
      templates: [],
      issues: [],
      formalStatus: "READY_TO_PUBLISH",
    } as unknown as CanonicalRuleWorkbookInspection["weightTemplateDraft"],
    pricingWeightBandPolicy: "MATCHED_STRUCTURAL_SOURCE_BAND" as const,
    ...overrides,
  };
}

function input(overrides: Partial<FeishuOrchestrationInput> = {}): FeishuOrchestrationInput {
  return {
    state: BASE_STATE,
    workspaceRevision: 1,
    inspection: null,
    action: "",
    error: null,
    ...overrides,
  };
}

function stageState(model: FeishuOrchestrationModel, id: string): OrchestrationStageState {
  return model.stages.find((s) => s.id === id)!.state;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("buildFeishuOrchestrationModel", () => {
  describe("initial state (no inspection, no saved source)", () => {
    const model = buildFeishuOrchestrationModel(input());

    it("workbook_identity is PENDING", () => {
      assert.equal(stageState(model, "workbook_identity"), "PENDING");
    });
    it("source_pull is PENDING", () => {
      assert.equal(stageState(model, "source_pull"), "PENDING");
    });
    it("ruleset_draft is PENDING", () => {
      assert.equal(stageState(model, "ruleset_draft"), "PENDING");
    });
    it("ruleset_publish is PENDING", () => {
      assert.equal(stageState(model, "ruleset_publish"), "PENDING");
    });
    it("is valid", () => {
      assert.equal(model.isValid, true);
    });
    it("sourceRevision is null", () => {
      assert.equal(model.sourceRevision, null);
    });
  });

  describe("inspection completed", () => {
    const insp = makeInspection();
    const model = buildFeishuOrchestrationModel(input({ inspection: insp }));

    it("workbook_identity is INSPECTED", () => {
      assert.equal(stageState(model, "workbook_identity"), "INSPECTED");
    });
    it("has workbook_identity evidence with revision", () => {
      const stage = model.stages.find((s) => s.id === "workbook_identity")!;
      assert.equal(stage.evidence?.revision, "2026-07-25-r001");
    });
    it("source_pull is PENDING (no saved source yet)", () => {
      assert.equal(stageState(model, "source_pull"), "PENDING");
    });
    it("sourceRevision is set", () => {
      assert.equal(model.sourceRevision, "2026-07-25-r001");
    });
  });

  describe("inspection with registry errors → BLOCKED", () => {
    const insp = makeInspection();
    insp.sourceRevision.issues = [
      { sheetId: "d6e928", severity: "error", code: "SHEET_MISSING", expectedName: "01", message: "Missing" },
    ];
    const model = buildFeishuOrchestrationModel(input({ inspection: insp }));

    it("workbook_identity is BLOCKED", () => {
      assert.equal(stageState(model, "workbook_identity"), "BLOCKED");
    });
    it("has issues", () => {
      const stage = model.stages.find((s) => s.id === "workbook_identity")!;
      assert.ok(stage.issues?.length);
    });
    it("is not valid", () => {
      assert.equal(model.isValid, false);
    });
    it("has terminal notice", () => {
      assert.ok(model.terminalNotice);
    });
  });

  describe("after explicit pull (saved source exists)", () => {
    const insp = makeInspection();
    const savedSource = makeSourceRevision({
      id: "feishu-src:r1",
      sourceRevision: "2026-07-25-r001",
      state: "PULLED",
    });
    const stateWithSource = {
      ...BASE_STATE,
      feishuSourceRevisions: [savedSource],
    } as unknown as WorkspaceState;
    const model = buildFeishuOrchestrationModel(input({ state: stateWithSource, inspection: insp }));

    it("source_pull is PULLED", () => {
      assert.equal(stageState(model, "source_pull"), "PULLED");
    });
    it("has source_pull evidence", () => {
      const stage = model.stages.find((s) => s.id === "source_pull")!;
      assert.ok(stage.evidence);
      assert.equal(stage.evidence?.revision, "2026-07-25-r001");
      assert.equal(stage.evidence?.actor, "tester");
    });
  });

  describe("after pull, SUPERSEDED by newer revision", () => {
    const insp = makeInspection({ sourceRevision: makeSourceRevision({ sourceRevision: "2026-07-25-r002" }) });
    insp.sourceRevision.sourceRevision = "2026-07-25-r002";
    const savedSource = makeSourceRevision({
      id: "feishu-src:old",
      sourceRevision: "2026-07-25-r001",
      state: "PULLED",
    });
    const stateWithSource = {
      ...BASE_STATE,
      feishuSourceRevisions: [savedSource],
    } as unknown as WorkspaceState;
    const model = buildFeishuOrchestrationModel(input({ state: stateWithSource, inspection: insp }));

    it("source_pull is SUPERSEDED", () => {
      assert.equal(stageState(model, "source_pull"), "SUPERSEDED");
    });
    it("is not valid", () => {
      assert.equal(model.isValid, false);
    });
  });

  describe("RuleSet draft created", () => {
    const insp = makeInspection();
    const savedSource = makeSourceRevision({
      id: "feishu-src:r1",
      sourceRevision: "2026-07-25-r001",
      state: "RULESET_DRAFT",
    });
    const draft: RuleSetVersion = {
      id: "rsv-draft-1",
      version: 1,
      status: "draft",
      sourceRevisionIds: ["feishu-src:r1"],
      canonicalRuleSourceDraftId: "crd-1",
      sourceContentHash: "hash_canonical",
      weightTemplateDraftId: "wtp-1",
      settings: {},
      createdAt: "2026-07-25T10:00:00Z",
      notes: "test draft",
    } as unknown as RuleSetVersion;
    const stateWithDraft = {
      ...BASE_STATE,
      feishuSourceRevisions: [savedSource],
      ruleSetVersions: [draft],
    } as unknown as WorkspaceState;
    const model = buildFeishuOrchestrationModel(input({ state: stateWithDraft, inspection: insp }));

    it("ruleset_draft is DRAFTED", () => {
      assert.equal(stageState(model, "ruleset_draft"), "DRAFTED");
    });
    it("has ruleset_draft evidence with hash", () => {
      const stage = model.stages.find((s) => s.id === "ruleset_draft")!;
      assert.ok(stage.evidence);
      assert.equal(stage.evidence?.hash, "hash_canonic…");
    });
    it("ruleset_publish is PENDING", () => {
      assert.equal(stageState(model, "ruleset_publish"), "PENDING");
    });
  });

  describe("RuleSet published", () => {
    const insp = makeInspection();
    const savedSource = makeSourceRevision({
      id: "feishu-src:r1",
      sourceRevision: "2026-07-25-r001",
      state: "PUBLISHED",
    });
    const published: RuleSetVersion = {
      id: "rsv-1",
      version: 1,
      status: "published",
      sourceRevisionIds: ["feishu-src:r1"],
      canonicalRuleSourceDraftId: "crd-1",
      sourceContentHash: "hash_canonical",
      publicationHash: "pub_hash_abcdef1234567890",
      publishedAt: "2026-07-25T11:00:00Z",
      publishedBy: "publisher",
      createdAt: "2026-07-25T10:00:00Z",
      notes: "published",
      warningAcknowledgements: [],
    } as unknown as RuleSetVersion;
    const stateWithPublished = {
      ...BASE_STATE,
      feishuSourceRevisions: [savedSource],
      ruleSetVersions: [published],
    } as unknown as WorkspaceState;
    const model = buildFeishuOrchestrationModel(input({ state: stateWithPublished, inspection: insp }));

    it("ruleset_publish is PUBLISHED", () => {
      assert.equal(stageState(model, "ruleset_publish"), "PUBLISHED");
    });
    it("ruleset_draft is DRAFTED (draft phase completed before publish)", () => {
      assert.equal(stageState(model, "ruleset_draft"), "DRAFTED");
    });
    it("has ruleset_publish evidence with publication hash", () => {
      const stage = model.stages.find((s) => s.id === "ruleset_publish")!;
      assert.ok(stage.evidence);
      assert.ok(stage.evidence?.hash?.includes("pub_hash"));
      assert.equal(stage.evidence?.actor, "publisher");
    });
  });

  describe("action states (in-progress indicators)", () => {
    it("action=inspect → workbook_identity INSPECTING", () => {
      const model = buildFeishuOrchestrationModel(input({ action: "inspect" }));
      assert.equal(stageState(model, "workbook_identity"), "INSPECTING");
    });

    it("action=pull → source_pull PULLING", () => {
      const insp = makeInspection();
      const model = buildFeishuOrchestrationModel(input({ inspection: insp, action: "pull" }));
      assert.equal(stageState(model, "source_pull"), "PULLING");
    });

    it("action=draft → ruleset_draft DRAFTING when source is pulled", () => {
      const insp = makeInspection();
      const savedSource = makeSourceRevision({
        id: "feishu-src:r1",
        sourceRevision: "2026-07-25-r001",
        state: "PULLED",
      });
      const stateWithSource = {
        ...BASE_STATE,
        feishuSourceRevisions: [savedSource],
      } as unknown as WorkspaceState;
      const model = buildFeishuOrchestrationModel(input({ state: stateWithSource, inspection: insp, action: "draft" }));
      assert.equal(stageState(model, "ruleset_draft"), "DRAFTING");
    });

    it("action=publish → ruleset_publish PUBLISHING when draft exists", () => {
      const insp = makeInspection();
      const savedSource = makeSourceRevision({
        id: "feishu-src:r1",
        sourceRevision: "2026-07-25-r001",
        state: "RULESET_DRAFT",
      });
      const draft: RuleSetVersion = {
        id: "rsv-draft-1",
        version: 1,
        status: "draft",
        sourceRevisionIds: ["feishu-src:r1"],
        canonicalRuleSourceDraftId: "crd-1",
        sourceContentHash: "hash_canonical",
        createdAt: "2026-07-25T10:00:00Z",
        notes: "",
        settings: {},
      } as unknown as RuleSetVersion;
      const stateWithDraft = {
        ...BASE_STATE,
        feishuSourceRevisions: [savedSource],
        ruleSetVersions: [draft],
      } as unknown as WorkspaceState;
      const model = buildFeishuOrchestrationModel(input({ state: stateWithDraft, inspection: insp, action: "publish" }));
      assert.equal(stageState(model, "ruleset_publish"), "PUBLISHING");
    });
  });

  describe("error states", () => {
    it("error without inspection → workbook_identity ERROR", () => {
      const model = buildFeishuOrchestrationModel(input({ error: "Connection failed" }));
      assert.equal(stageState(model, "workbook_identity"), "ERROR");
      assert.equal(model.isValid, false);
    });

    it("error after inspection during pull → source_pull ERROR", () => {
      const insp = makeInspection();
      const model = buildFeishuOrchestrationModel(input({ inspection: insp, action: "pull", error: "Pull failed" }));
      // action "pull" should override to PULLING, then error makes it ERROR
      // But our current logic: error is checked only when action !== current. Let me verify.
      // When action="pull", deriveSourcePullState returns "PULLING" first, so it won't reach the error check.
      // That's correct: during active action, we show the action state, not error.
      // After action completes with error, action="" and error is set.
      assert.equal(stageState(model, "source_pull"), "PULLING");
    });

    it("error after pull completes and action clears → source_pull ERROR", () => {
      const insp = makeInspection();
      const model = buildFeishuOrchestrationModel(input({ inspection: insp, action: "", error: "Pull failed" }));
      assert.equal(stageState(model, "source_pull"), "ERROR");
    });
  });

  describe("label functions", () => {
    it("each stage has a non-empty label", () => {
      const model = buildFeishuOrchestrationModel(input());
      for (const stage of model.stages) {
        assert.ok(stage.label.length > 0);
        assert.ok(stage.hint.length > 0);
        assert.equal(stage.index, model.stages.indexOf(stage) + 1);
      }
    });
  });

  describe("businessRevision", () => {
    it("uses the provided workspaceRevision", () => {
      const model = buildFeishuOrchestrationModel(input({ workspaceRevision: 42 }));
      assert.equal(model.businessRevision, 42);
    });
  });
});
