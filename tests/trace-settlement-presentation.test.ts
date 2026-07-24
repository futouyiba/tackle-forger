import assert from "node:assert/strict";
import test from "node:test";
import { createCalculationTraceArchive, createCalculationTraceEntry, verifyCalculationTraceArchive } from "../lib/calculation-trace";
import { buildMotionPresentationModel, initialMotionPlaybackState, motionPlaybackReducer, type MotionPresentationStep } from "../lib/motion-presentation";
import { canonicalTraceEvidenceEntries, displayOnlyTraceDelta, formatDisplayOnlyDelta, projectTraceSettlementEntries, traceSettlementKind, traceSettlementMainValue, traceSettlementTargets } from "../lib/trace-settlement-presentation";

const baseStep: Pick<MotionPresentationStep, "layer" | "operation" | "effect"> = {
  layer: "method", operation: "add", effect: "benefit",
};

test("display-only delta is available only for finite numeric before and after", () => {
  assert.equal(displayOnlyTraceDelta(8, 8.5, "add"), 0.5);
  assert.equal(displayOnlyTraceDelta(8.5, 8, "add"), -0.5);
  assert.equal(displayOnlyTraceDelta(2, 2, "multiply"), 0);
  assert.equal(displayOnlyTraceDelta("8", 9, "add"), undefined);
  assert.equal(displayOnlyTraceDelta(8, Number.POSITIVE_INFINITY, "add"), undefined);
  assert.equal(displayOnlyTraceDelta(Number.MAX_VALUE, -Number.MAX_VALUE, "add"), undefined);
  assert.equal(displayOnlyTraceDelta(-Number.MAX_VALUE, Number.MAX_VALUE, "add"), undefined);
  assert.equal(formatDisplayOnlyDelta(0.5, "kgf"), "+0.5 kgf");
});

test("semantic Trace operations retain their operation presentation instead of a fabricated delta", () => {
  assert.deepEqual(traceSettlementKind({ ...baseStep, operation: "no_effect" }), { key: "no-effect", label: "本层无贡献" });
  assert.deepEqual(traceSettlementKind({ ...baseStep, layer: "model_patch", effect: "cost" }), { key: "patch", label: "Patch" });
  assert.deepEqual(traceSettlementKind({ ...baseStep, layer: "boundary", operation: "max" }), { key: "boundary", label: "边界 / 舍入" });
  for (const operation of ["set", "clear", "min", "max", "no_effect"] as const) {
    assert.equal(displayOnlyTraceDelta(8, 9, operation), undefined);
  }
});

test("canonical archive verification rejects a tampered frozen Trace before presentation", () => {
  const subjectRef = { workspaceId: "workspace", entityType: "model" as const, entityId: "model", revisionId: "1" };
  const entry = createCalculationTraceEntry({
    traceEntryId: "entry", subjectRef, parameterKey: "pull", sequence: 1,
    layer: "method", sourceRef: { sourceType: "Method", sourceId: "lure" }, sourceVersion: "1", ruleSetVersion: "rules:1",
    before: 8, operation: "add", operand: 1, after: 9, effect: "benefit", warningIssueIds: [], actions: [],
  });
  const archive = createCalculationTraceArchive([entry]);
  assert.equal(verifyCalculationTraceArchive(archive), true);
  const tampered = structuredClone(archive);
  tampered.traceHash = "tampered";
  assert.equal(verifyCalculationTraceArchive(tampered), false);
});

test("multi-subject archive projection preserves global sequence gaps without reordering", () => {
  const subjectA = { workspaceId: "workspace", entityType: "model" as const, entityId: "model-a", revisionId: "1" };
  const subjectB = { workspaceId: "workspace", entityType: "model" as const, entityId: "model-b", revisionId: "1" };
  const common = { layer: "method" as const, sourceRef: { sourceType: "Method", sourceId: "lure" }, sourceVersion: "1", ruleSetVersion: "rules:1", effect: "benefit" as const, warningIssueIds: [], actions: [] };
  const archive = createCalculationTraceArchive([
    createCalculationTraceEntry({ ...common, traceEntryId: "a-1", subjectRef: subjectA, parameterKey: "pull", sequence: 1, before: 8, operation: "add", operand: 1, after: 9 }),
    createCalculationTraceEntry({ ...common, traceEntryId: "b-2", subjectRef: subjectB, parameterKey: "pull", sequence: 2, before: 4, operation: "add", operand: 1, after: 5 }),
    createCalculationTraceEntry({ ...common, traceEntryId: "a-3", subjectRef: subjectA, parameterKey: "pull", sequence: 3, before: 9, operation: "add", operand: 1, after: 10 }),
  ]);
  const target = traceSettlementTargets(archive.entries).find((entry) => entry.subjectRef.entityId === "model-a");
  assert.ok(target);
  const projected = projectTraceSettlementEntries(archive.entries, target);
  assert.deepEqual(projected.map((entry) => entry.sequence), [1, 3]);
  const model = buildMotionPresentationModel({ businessRevision: "snapshot:1", subjectId: subjectA.entityId, parameterKey: "pull", trace: projected });
  assert.deepEqual(model.steps.map((entry) => entry.sequence), [1, 3]);
  assert.equal(model.steps[0].before, 8);
});

test("idle settlement presents the first frozen before value, not the final result", () => {
  const trace = [
    { traceEntryId: "one", sequence: 1, layer: "method", sourceRef: { sourceType: "Method", sourceId: "lure" }, sourceVersion: "1", before: 8, operation: "add", operand: 1, after: 9, effect: "benefit" as const, warningIssueIds: [], inputHash: "a", outputHash: "b" },
    { traceEntryId: "two", sequence: 2, layer: "method", sourceRef: { sourceType: "Method", sourceId: "lure" }, sourceVersion: "1", before: 9, operation: "add", operand: 1, after: 10, effect: "benefit" as const, warningIssueIds: [], inputHash: "b", outputHash: "c" },
  ];
  const model = buildMotionPresentationModel({ businessRevision: "snapshot", subjectId: "model", parameterKey: "pull", trace });
  assert.equal(traceSettlementMainValue(model, "idle", -1), 8);
  assert.equal(traceSettlementMainValue(model, "playing", 0), 9);
  assert.equal(traceSettlementMainValue(model, "completed", 2), 10);
});

test("skip and completion retain every canonical frozen Trace evidence entry", () => {
  const subjectRef = { workspaceId: "workspace", entityType: "model" as const, entityId: "model", revisionId: "1" };
  const common = { subjectRef, parameterKey: "pull", layer: "method" as const, sourceRef: { sourceType: "Method", sourceId: "lure" }, sourceVersion: "source:7", ruleSetVersion: "rules:9", effect: "benefit" as const };
  const archive = createCalculationTraceArchive([
    createCalculationTraceEntry({ ...common, traceEntryId: "one", sequence: 1, before: 8, operation: "add", operand: 1, after: 9, warningIssueIds: ["warn-1"], actions: [{ actionId: "review", action: "review_source", label: "查看来源", enabled: true }] }),
    createCalculationTraceEntry({ ...common, traceEntryId: "two", sequence: 2, before: 9, operation: "no_effect", operand: null, after: 9, warningIssueIds: [], actions: [{ actionId: "retry", action: "retry", label: "重试", enabled: false }] }),
  ]);
  const model = buildMotionPresentationModel({ businessRevision: "snapshot:1", subjectId: "model", parameterKey: "pull", trace: archive.entries });
  const skipped = motionPlaybackReducer(initialMotionPlaybackState(model), { type: "skip" }, model.steps.length);
  let completed = motionPlaybackReducer(initialMotionPlaybackState(model), { type: "play" }, model.steps.length);
  completed = motionPlaybackReducer(completed, { type: "advance" }, model.steps.length);
  completed = motionPlaybackReducer(completed, { type: "advance" }, model.steps.length);
  completed = motionPlaybackReducer(completed, { type: "finalLockComplete" }, model.steps.length);
  assert.equal(skipped.status, "completed");
  assert.equal(completed.status, "completed");
  for (const playback of [skipped, completed]) {
    assert.equal(playback.status, "completed");
    assert.deepEqual(canonicalTraceEvidenceEntries(archive.entries), archive.entries);
  }
  assert.deepEqual(canonicalTraceEvidenceEntries(archive.entries).map((entry) => ({
    sequence: entry.sequence, sourceRef: entry.sourceRef, sourceVersion: entry.sourceVersion, ruleSetVersion: entry.ruleSetVersion,
    before: entry.before, operation: entry.operation, operand: entry.operand, after: entry.after,
    warningIssueIds: entry.warningIssueIds, actions: entry.actions,
  })), archive.entries.map((entry) => ({
    sequence: entry.sequence, sourceRef: entry.sourceRef, sourceVersion: entry.sourceVersion, ruleSetVersion: entry.ruleSetVersion,
    before: entry.before, operation: entry.operation, operand: entry.operand, after: entry.after,
    warningIssueIds: entry.warningIssueIds, actions: entry.actions,
  })));
});
