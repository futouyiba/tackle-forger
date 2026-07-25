/**
 * MOTION-05 unit tests: snapshot freeze presentation model.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSnapshotFreezeModel,
  snapshotFreezeStateLabel,
  type SnapshotFreezeModelInput,
} from "../lib/snapshot-freeze-presentation";
import type { ConfigurationSnapshot, UpgradeCandidate } from "../lib/types";

function makeSnapshot(overrides: Partial<ConfigurationSnapshot> = {}): ConfigurationSnapshot {
  return {
    id: "snapshot-model-a-v1",
    version: 1,
    modelId: "model-a",
    modelRevision: 3,
    skuRevision: 2,
    seriesRevision: 1,
    ruleSetVersion: "ruleset-001",
    projectionId: "proj-xyz",
    patchSetHash: "abc123def4567890",
    finalPanelValues: { pull: 1.5, length: 2.1, weight: 120 },
    componentSelections: [],
    technologyIds: [],
    attributeAffixIds: [],
    passiveAffixIds: [],
    attributeTrace: [],
    passiveAffixPayloads: [],
    projectionMatch: { projectionId: "proj-xyz", weightTemplateId: "wt-1", methodId: "m-1", typeId: "t-1", functionId: "f-1", targetPullKg: 1.5, itemPartId: "part-1", matchedStructuralPullKg: 1.5, pullDistance: 0, ruleSetVersion: "rsv-1", affinityScore: 0 } as unknown as ConfigurationSnapshot["projectionMatch"],
    compatibilityReport: { compatible: true, details: [] },
    affinityReport: { score: 0, details: [] },
    qualityReport: { qualityId: "quality_c_green", score: 1, details: [] },
    validationReport: [],
    publishedBy: "tester",
    publishedAt: "2026-07-25T10:00:00Z",
    contentHash: "deadbeef1234567890abcdef",
    ...overrides,
  } as ConfigurationSnapshot;
}

function makeCandidate(overrides: Partial<UpgradeCandidate> = {}): UpgradeCandidate {
  return {
    id: "upgrade-model-a-v2",
    modelId: "model-a",
    fromSnapshotId: "snapshot-model-a-v1",
    proposedProjectionId: "proj-new",
    proposedRuleSetVersion: "ruleset-002",
    proposedValues: { pull: 1.8, length: 2.1, weight: 115 },
    differences: [
      { path: "pull", oldResult: 1.5, newResult: 1.8 },
      { path: "weight", oldResult: 120, newResult: 115 },
    ],
    patchRebasePreview: {
      oldProjectionId: "proj-xyz",
      newProjectionId: "proj-new",
      oldRuleSetVersion: "ruleset-001",
      newRuleSetVersion: "ruleset-002",
      oldResult: {},
      newResult: {},
      differences: [],
      issues: [],
      requiresReview: false,
      rebasedPatches: [],
      conflicts: [],
    } as unknown as UpgradeCandidate["patchRebasePreview"],
    validationReport: [],
    status: "pending",
    createdAt: "2026-07-25T11:00:00Z",
    ...overrides,
  } as UpgradeCandidate;
}

function input(overrides: Partial<SnapshotFreezeModelInput> = {}): SnapshotFreezeModelInput {
  return {
    snapshot: null,
    upgradeCandidate: null,
    isBuilding: false,
    buildError: null,
    isReplay: false,
    ...overrides,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("buildSnapshotFreezeModel", () => {
  describe("NO_SNAPSHOT", () => {
    const model = buildSnapshotFreezeModel(input());

    it("state is NO_SNAPSHOT", () => {
      assert.equal(model.state, "NO_SNAPSHOT");
    });
    it("no evidence", () => {
      assert.equal(model.evidence, undefined);
    });
    it("isReplay is false", () => {
      assert.equal(model.isReplay, false);
    });
  });

  describe("BUILDING", () => {
    const model = buildSnapshotFreezeModel(input({ isBuilding: true }));

    it("state is BUILDING", () => {
      assert.equal(model.state, "BUILDING");
    });
    it("isReplay is false", () => {
      assert.equal(model.isReplay, false);
    });
  });

  describe("BUILD_FAILED", () => {
    const model = buildSnapshotFreezeModel(input({
      buildError: "PATCH_SET_HASH_MISMATCH",
      snapshot: null,
    }));

    it("state is BUILD_FAILED", () => {
      assert.equal(model.state, "BUILD_FAILED");
    });
    it("isReplay is false", () => {
      assert.equal(model.isReplay, false);
    });
  });

  describe("BUILD_FAILED is overridden by existing snapshot", () => {
    // If snapshot exists (idempotent), build error from a re-attempt doesn't
    // downgrade to BUILD_FAILED — the frozen snapshot still exists.
    const snap = makeSnapshot();
    const model = buildSnapshotFreezeModel(input({
      snapshot: snap,
      buildError: "retry failed",
    }));

    it("state is FROZEN (not BUILD_FAILED)", () => {
      assert.equal(model.state, "FROZEN");
    });
  });

  describe("FROZEN with full evidence", () => {
    const snap = makeSnapshot({
      id: "snapshot-rod-v1",
      version: 3,
      contentHash: "abcdef1234567890abcdef1234567890",
      patchSetHash: "patch_hash_abcdef",
      ruleSetVersion: "rsv-published-1",
      projectionId: "proj-main",
      publishedBy: "admin",
      publishedAt: "2026-07-25T10:00:00Z",
      finalPanelValues: { pull: 1.5, length: 2.1, weight: 120, action: "fast" },
      calculationTrace: {} as ConfigurationSnapshot["calculationTrace"],
    });
    const model = buildSnapshotFreezeModel(input({ snapshot: snap }));

    it("state is FROZEN", () => {
      assert.equal(model.state, "FROZEN");
    });
    it("has evidence", () => {
      assert.ok(model.evidence);
    });
    it("evidence.snapshotId", () => {
      assert.equal(model.evidence?.snapshotId, "snapshot-rod-v1");
    });
    it("evidence.version", () => {
      assert.equal(model.evidence?.version, 3);
    });
    it("evidence.contentHash is truncated", () => {
      assert.ok(model.evidence?.contentHash.endsWith("…"));
      assert.equal(model.evidence?.contentHash.length, 13); // 12 + …
    });
    it("evidence.patchSetHash", () => {
      assert.equal(model.evidence?.patchSetHash, "patch_hash_a…");
    });
    it("evidence.ruleSetVersion", () => {
      assert.equal(model.evidence?.ruleSetVersion, "rsv-published-1");
    });
    it("evidence.projectionId", () => {
      assert.equal(model.evidence?.projectionId, "proj-main");
    });
    it("evidence.publishedBy", () => {
      assert.equal(model.evidence?.publishedBy, "admin");
    });
    it("evidence.panelFieldCount", () => {
      assert.equal(model.evidence?.panelFieldCount, 4);
    });
    it("evidence.hasCalculationTrace", () => {
      assert.equal(model.evidence?.hasCalculationTrace, true);
    });
    it("no upgrade candidate", () => {
      assert.equal(model.upgradeCandidate, undefined);
    });
  });

  describe("UPGRADE_AVAILABLE with pending candidate", () => {
    const snap = makeSnapshot();
    const cand = makeCandidate({ status: "pending" });
    const model = buildSnapshotFreezeModel(input({
      snapshot: snap,
      upgradeCandidate: cand,
    }));

    it("state is UPGRADE_AVAILABLE", () => {
      assert.equal(model.state, "UPGRADE_AVAILABLE");
    });
    it("has evidence from old snapshot", () => {
      assert.ok(model.evidence);
    });
    it("has upgrade candidate comparison", () => {
      assert.ok(model.upgradeCandidate);
    });
    it("candidate differences", () => {
      assert.equal(model.upgradeCandidate?.differences.length, 2);
    });
    it("candidate.isApproved is false", () => {
      assert.equal(model.upgradeCandidate?.isApproved, false);
    });
  });

  describe("UPGRADE_AVAILABLE with approved candidate", () => {
    const snap = makeSnapshot();
    const cand = makeCandidate({
      status: "approved",
      reviewedAt: "2026-07-25T12:00:00Z",
    });
    const model = buildSnapshotFreezeModel(input({
      snapshot: snap,
      upgradeCandidate: cand,
    }));

    it("state is UPGRADE_AVAILABLE", () => {
      assert.equal(model.state, "UPGRADE_AVAILABLE");
    });
    it("candidate.isApproved is true", () => {
      assert.equal(model.upgradeCandidate?.isApproved, true);
    });
    it("candidate has reviewedAt", () => {
      assert.ok(model.upgradeCandidate?.reviewedAt);
    });
  });

  describe("rejected candidate → FROZEN", () => {
    const snap = makeSnapshot();
    const cand = makeCandidate({ status: "rejected" });
    const model = buildSnapshotFreezeModel(input({
      snapshot: snap,
      upgradeCandidate: cand,
    }));

    it("rejected candidate doesn't show UPGRADE_AVAILABLE", () => {
      assert.equal(model.state, "FROZEN");
    });
    it("no upgrade comparison", () => {
      assert.equal(model.upgradeCandidate, undefined);
    });
  });

  describe("UPGRADE_AVAILABLE requires snapshot", () => {
    // UpgradeCandidate without a snapshot — shouldn't happen in practice
    const cand = makeCandidate();
    const model = buildSnapshotFreezeModel(input({
      snapshot: null,
      upgradeCandidate: cand,
    }));

    it("falls back to NO_SNAPSHOT", () => {
      assert.equal(model.state, "NO_SNAPSHOT");
    });
  });

  describe("isReplay flag", () => {
    it("isReplay=true when re-viewing frozen snapshot", () => {
      const snap = makeSnapshot();
      const model = buildSnapshotFreezeModel(input({
        snapshot: snap,
        isReplay: true,
      }));
      assert.equal(model.state, "FROZEN");
      assert.equal(model.isReplay, true);
    });

    it("isReplay=true with upgrade candidate", () => {
      const snap = makeSnapshot();
      const cand = makeCandidate();
      const model = buildSnapshotFreezeModel(input({
        snapshot: snap,
        upgradeCandidate: cand,
        isReplay: true,
      }));
      assert.equal(model.state, "UPGRADE_AVAILABLE");
      assert.equal(model.isReplay, true);
    });
  });

  describe("label functions", () => {
    it("each state has a non-empty label", () => {
      for (const state of ["NO_SNAPSHOT", "BUILDING", "BUILD_FAILED", "FROZEN", "UPGRADE_AVAILABLE"] as const) {
        assert.ok(snapshotFreezeStateLabel(state).length > 0);
      }
    });
  });
});
