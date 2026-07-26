/**
 * MOTION-07 acceptance tests: motion playback does not alter authoritative
 * results, cause extra writes, or break hash consistency.
 *
 * These tests verify the binding contract between the motion presentation
 * layer and the authoritative domain layer (规范 §6.3 P4/P6).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMotionPresentationModel,
  motionPlaybackReducer,
  initialMotionPlaybackState,
  type MotionTraceLike,
} from "../lib/motion-presentation";
import {
  buildSnapshotFreezeModel,
} from "../lib/snapshot-freeze-presentation";
import type { ConfigurationSnapshot } from "../lib/types";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTrace(length: number): MotionTraceLike[] {
  return Array.from({ length }, (_v, i) => ({
    traceEntryId: `trace-${i + 1}`,
    sequence: i,
    layer: i === 0 ? "weight_template" : i % 3 === 0 ? "patch" : "modifier",
    sourceRef: { sourceId: `src-${i}`, sourceType: "rule" },
    sourceVersion: "r1",
    before: i === 0 ? 0 : 10 + i,
    operation: "add",
    operand: 1,
    after: i === 0 ? 10 : 11 + i,
    effect: "benefit" as const,
    warningIssueIds: [],
    inputHash: `in-${i}`,
    outputHash: `out-${i}`,
    unit: "kgf",
  }));
}

// ─── playback skip → no extra writes ────────────────────────────────────────

describe("MOTION-07 playback integrity", () => {
  describe("skip and replay do not alter model or cause extra writes", () => {
    const trace = makeTrace(4);
    const model = buildMotionPresentationModel({
      businessRevision: "r1",
      subjectId: "model-1",
      parameterKey: "pull",
      trace,
    });

    it("normal playback produces completed state with full evidence", () => {
      let state = initialMotionPlaybackState(model, false);
      // Simulate full playback: advance through all steps
      state = motionPlaybackReducer(state, { type: "play" }, model.steps.length);
      for (let i = 0; i < model.steps.length; i++) {
        for (let p = 0; p < 5; p++) {
          state = motionPlaybackReducer(state, { type: "phaseAdvance" }, model.steps.length);
        }
      }
      state = motionPlaybackReducer(state, { type: "finalLockComplete" }, model.steps.length);
      assert.equal(state.status, "completed");
      assert.equal(state.stepIndex, model.steps.length);
    });

    it("skip produces completed state with same stepIndex as full playback", () => {
      let state = initialMotionPlaybackState(model, false);
      state = motionPlaybackReducer(state, { type: "play" }, model.steps.length);
      state = motionPlaybackReducer(state, { type: "advance" }, model.steps.length);
      state = motionPlaybackReducer(state, { type: "skip" }, model.steps.length);
      assert.equal(state.status, "completed");
      assert.equal(state.stepIndex, model.steps.length);
    });

    it("replay after skip resets stepIndex and replays without altering model", () => {
      let state = initialMotionPlaybackState(model, false);
      state = motionPlaybackReducer(state, { type: "play" }, model.steps.length);
      state = motionPlaybackReducer(state, { type: "skip" }, model.steps.length);
      assert.equal(state.status, "completed");

      // Replay
      state = motionPlaybackReducer(state, { type: "replay" }, model.steps.length);
      assert.equal(state.status, "playing");
      assert.equal(state.stepIndex, 0);

      // The model itself is frozen — replay cannot have changed it
      assert.equal(model.businessRevision, "r1");
      assert.equal(model.steps.length, 4);
      assert.equal(model.outputHash, "out-3");
    });

    it("reduced-motion produces completed state immediately", () => {
      const state = initialMotionPlaybackState(model, true);
      assert.equal(state.status, "completed");
      assert.equal(state.stepIndex, model.steps.length);
    });

    it("normal, skip, and reduced-motion all reach same final stepIndex", () => {
      let s1 = initialMotionPlaybackState(model, false);
      s1 = motionPlaybackReducer(s1, { type: "play" }, model.steps.length);
      s1 = motionPlaybackReducer(s1, { type: "skip" }, model.steps.length);

      const s2 = initialMotionPlaybackState(model, true);

      let s3 = initialMotionPlaybackState(model, false);
      s3 = motionPlaybackReducer(s3, { type: "play" }, model.steps.length);
      for (let i = 0; i < model.steps.length; i++) {
        for (let p = 0; p < 5; p++) {
          s3 = motionPlaybackReducer(s3, { type: "phaseAdvance" }, model.steps.length);
        }
      }
      s3 = motionPlaybackReducer(s3, { type: "finalLockComplete" }, model.steps.length);

      assert.equal(s1.stepIndex, s2.stepIndex);
      assert.equal(s1.stepIndex, s3.stepIndex);
      assert.equal(s1.status, "completed");
      assert.equal(s2.status, "completed");
      assert.equal(s3.status, "completed");
    });
  });

  describe("revision change supersedes old playback", () => {
    const trace = makeTrace(2);
    const model = buildMotionPresentationModel({
      businessRevision: "r1",
      subjectId: "model-1",
      parameterKey: "pull",
      trace,
    });

    it("revisionChanged transitions to superseded", () => {
      let state = initialMotionPlaybackState(model, false);
      state = motionPlaybackReducer(state, { type: "play" }, model.steps.length);
      state = motionPlaybackReducer(state, { type: "advance" }, model.steps.length);
      state = motionPlaybackReducer(state, { type: "revisionChanged", revision: "r2" }, model.steps.length);
      assert.equal(state.status, "superseded");
    });

    it("superseded state is terminal — cannot play or replay", () => {
      let state = initialMotionPlaybackState(model, false);
      state = motionPlaybackReducer(state, { type: "revisionChanged", revision: "r2" }, model.steps.length);
      state = motionPlaybackReducer(state, { type: "play" }, model.steps.length);
      assert.equal(state.status, "superseded"); // unchanged
      state = motionPlaybackReducer(state, { type: "replay" }, model.steps.length);
      assert.equal(state.status, "superseded"); // unchanged
    });
  });

  describe("hash consistency across motion paths", () => {
    const trace = makeTrace(3);
    const model = buildMotionPresentationModel({
      businessRevision: "r1",
      subjectId: "hash-test",
      parameterKey: "pull",
      trace,
    });

    it("model hash is deterministic regardless of playback path", () => {
      const model2 = buildMotionPresentationModel({
        businessRevision: "r1",
        subjectId: "hash-test",
        parameterKey: "pull",
        trace,
      });
      assert.equal(model.inputHash, model2.inputHash);
      assert.equal(model.outputHash, model2.outputHash);
      assert.deepStrictEqual(model.finalValue, model2.finalValue);
    });

    it("playback state does not affect model hash", () => {
      let state = initialMotionPlaybackState(model, false);
      state = motionPlaybackReducer(state, { type: "play" }, model.steps.length);
      state = motionPlaybackReducer(state, { type: "skip" }, model.steps.length);
      // Model is frozen — playback cannot change it
      assert.equal(model.outputHash, model.steps[model.steps.length - 1]!.outputHash);
    });
  });

  describe("presentation models are pure (no side effects)", () => {
    const snap = {
      id: "s-1", version: 1, contentHash: "abc", patchSetHash: "def",
      ruleSetVersion: "rsv-1", projectionId: "p-1",
      publishedBy: "test", publishedAt: "now",
      finalPanelValues: { a: 1 },
    } as unknown as ConfigurationSnapshot;

    it("buildSnapshotFreezeModel returns deterministic result for same input", () => {
      const a = buildSnapshotFreezeModel({ snapshot: snap, upgradeCandidate: null, isBuilding: false, buildError: null, isReplay: false });
      const b = buildSnapshotFreezeModel({ snapshot: snap, upgradeCandidate: null, isBuilding: false, buildError: null, isReplay: false });
      assert.equal(a.state, b.state);
      assert.equal(a.evidence?.snapshotId, b.evidence?.snapshotId);
      assert.equal(a.isReplay, b.isReplay);
    });

    it("buildSnapshotFreezeModel with isReplay=true keeps state FROZEN", () => {
      const a = buildSnapshotFreezeModel({ snapshot: snap, upgradeCandidate: null, isBuilding: false, buildError: null, isReplay: true });
      assert.equal(a.state, "FROZEN");
      assert.equal(a.isReplay, true);
    });
  });
});
