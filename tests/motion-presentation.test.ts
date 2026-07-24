import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildMotionPresentationModel, createMotionPlaybackController, initialMotionPlaybackState, isMotionDevelopmentFixtureEnabled, motionPlaybackReducer, motionTokens, playbackPhaseDuration, playbackTimingProfile, systemPrefersReducedMotion, type MotionClock, type MotionPlaybackPhase, type MotionTraceLike } from "../lib/motion-presentation";

const trace: MotionTraceLike[] = [
  { traceEntryId: "one", sequence: 1, layer: "method", sourceRef: { sourceType: "Method", sourceId: "lure" }, sourceVersion: "2", before: 8, operation: "add", operand: 2, after: 10, effect: "benefit", warningIssueIds: [], inputHash: "input", outputHash: "out-1" },
  { traceEntryId: "two", sequence: 2, layer: "model_patch", sourceRef: { sourceType: "Patch", sourceId: "patch-1" }, sourceVersion: "2", before: 10, operation: "add", operand: -1, after: 9, effect: "cost", warningIssueIds: ["warn"], inputHash: "input", outputHash: "out-2" },
];
const model = buildMotionPresentationModel({ businessRevision: "r1", subjectId: "model-1", parameterKey: "pull", trace });
const reduce = (state: ReturnType<typeof initialMotionPlaybackState>, action: Parameters<typeof motionPlaybackReducer>[1]) => motionPlaybackReducer(state, action, model.steps.length);

test("MotionPresentationModel retains authoritative order and evidence without recalculation", () => {
  assert.throws(() => buildMotionPresentationModel({ businessRevision: "r1", subjectId: "m", parameterKey: "p", trace: [...trace].reverse() }), /authoritative order/);
  const ordered = buildMotionPresentationModel({ businessRevision: "r1", subjectId: "model-1", parameterKey: "pull", trace });
  assert.deepEqual(ordered.steps.map((step) => step.id), ["one", "two"]);
  assert.equal(model.finalValue, 9); assert.deepEqual(model.evidence.warningIssueIds, ["warn"]);
  assert.throws(() => buildMotionPresentationModel({ businessRevision: "r1", subjectId: "m", parameterKey: "p", trace: [...trace, { ...trace[0], traceEntryId: "duplicate", sequence: 2 }] }), /unique/);
});

test("normal playback pauses and resumes at the same presentation position", () => {
  let state = initialMotionPlaybackState(model); state = reduce(state, { type: "play" }); state = reduce(state, { type: "advance" }); state = reduce(state, { type: "pause" });
  assert.deepEqual([state.status, state.stepIndex], ["paused", 1]); state = reduce(state, { type: "resume" }); state = reduce(state, { type: "advance" });
  assert.deepEqual([state.status, state.stepIndex], ["locking", 2]);
  state = reduce(state, { type: "finalLockComplete" });
  assert.deepEqual([state.status, state.stepIndex], ["completed", 2]);
});

test("skip and reduced motion restore the same complete evidence view", () => {
  const skipped = reduce(initialMotionPlaybackState(model), { type: "skip" });
  const reduced = initialMotionPlaybackState(model, true);
  assert.deepEqual([skipped.status, skipped.stepIndex], [reduced.status, reduced.stepIndex]);
  assert.equal(motionTokens.reducedMotion.autoplay, false);
});

test("cancel and revision conflict cannot progress a stale sequence", () => {
  let state = reduce(initialMotionPlaybackState(model), { type: "play" }); state = reduce(state, { type: "revisionChanged", revision: "r2" });
  assert.deepEqual([state.status, state.cancellationReason], ["superseded", "revision"]); assert.deepEqual(reduce(state, { type: "advance" }), state);
  state = reduce(initialMotionPlaybackState(model), { type: "cancel", reason: "route" }); assert.equal(state.status, "cancelled");
});

test("superseded and cancelled models are terminal until a new model is initialized", () => {
  let state = reduce(initialMotionPlaybackState(model), { type: "revisionChanged", revision: "r2" });
  for (const action of [{ type: "play" }, { type: "replay" }, { type: "skip" }, { type: "advance" }] as const) assert.deepEqual(reduce(state, action), state);
  state = reduce(initialMotionPlaybackState(model), { type: "cancel", reason: "route" });
  assert.deepEqual(reduce(state, { type: "replay" }), state);
});

class FakeClock implements MotionClock {
  callbacks = new Map<number, () => void>(); nextHandle = 1; cleared: number[] = []; delays: number[] = [];
  set(callback: () => void, delayMs: number): number { const handle = this.nextHandle++; this.callbacks.set(handle, callback); this.delays.push(delayMs); return handle; }
  clear(handle: unknown): void { this.cleared.push(handle as number); this.callbacks.delete(handle as number); }
  fire(handle: number): void { this.callbacks.get(handle)?.(); }
}

test("injected clock drives every authoritative step through the fixed presentation phases", () => {
  const clock = new FakeClock(); const controller = createMotionPlaybackController(model, { clock });
  controller.dispatch({ type: "play" });
  assert.deepEqual([controller.getState().status, controller.getState().stepIndex, controller.getState().phase], ["playing", 0, "source"]);
  for (const [handle, phase] of [[1, "impact"], [2, "main_number"], [3, "explanation"], [4, "evidence"], [5, "source"]] as const) {
    clock.fire(handle);
    assert.equal(controller.getState().phase, phase);
  }
  assert.equal(controller.getState().stepIndex, 1);
  for (let handle = 6; handle <= 10; handle += 1) clock.fire(handle);
  assert.deepEqual([controller.getState().status, controller.getState().stepIndex], ["locking", 2]);
  clock.fire(11); assert.deepEqual([controller.getState().status, controller.getState().stepIndex], ["completed", 2]);
});

test("shared phase tokens keep negative non-Patch impacts between 280 and 320ms", () => {
  const negativeModel = buildMotionPresentationModel({
    businessRevision: "cost", subjectId: "model-1", parameterKey: "pull",
    trace: [trace[0]!, { ...trace[1]!, layer: "method" }],
  });
  const clock = new FakeClock(); const controller = createMotionPlaybackController(negativeModel, { clock });
  controller.dispatch({ type: "play" });
  clock.fire(1); // source -> impact for the positive first step
  assert.equal(clock.delays[1], motionTokens.phaseDelay.establish.impactToMainMs);
  for (let handle = 2; handle <= 5; handle += 1) clock.fire(handle); // finish first step
  for (let handle = 6; handle <= 10; handle += 1) clock.fire(handle); // whole negative non-Patch step
  const costStepDuration = clock.delays.slice(5, 10).reduce((sum, delay) => sum + delay, 0);
  assert.ok(costStepDuration >= 280 && costStepDuration <= 320);
  assert.equal(costStepDuration, motionTokens.duration.costMs);
});

test("timing profiles give non-first Patch, boundary and rounding their required windows in documented precedence", () => {
  const phases: MotionPlaybackPhase[] = ["source", "impact", "main_number", "explanation", "evidence"];
  const duration = (step: typeof model.steps[number], index: number) => phases.reduce((sum, phase) => sum + playbackPhaseDuration(step, index, phase), 0);
  const patch = { ...model.steps[1]!, layer: "model_patch" };
  const boundary = { ...model.steps[1]!, layer: "boundary", effect: "cost" as const };
  const rounding = { ...boundary, evidence: { adapter: "pricing_trace/v2", operation: "round" } };
  const cost = { ...model.steps[1]!, layer: "method", effect: "cost" as const };

  assert.equal(playbackTimingProfile(patch, 0), "establish", "the first step takes establish precedence");
  assert.equal(playbackTimingProfile({ ...patch, effect: "cost" }, 1), "patch", "Patch wins over cost");
  assert.equal(playbackTimingProfile(boundary, 1), "boundary", "boundary wins over cost");
  assert.equal(playbackTimingProfile(rounding, 1), "boundary", "canonical pricing rounding uses the boundary timing profile");
  assert.equal(playbackTimingProfile(cost, 1), "cost");
  for (const step of [patch, boundary, rounding]) {
    const value = duration(step, 1);
    const [minimum, maximum] = step.layer.includes("patch") ? [280, 320] : [360, 420];
    assert.ok(value >= minimum && value <= maximum, `${step.layer} expected ${minimum}–${maximum}ms, received ${value}ms`);
  }
  assert.equal(duration(patch, 1), motionTokens.duration.costMs);
  assert.equal(duration(boundary, 1), 390);
  assert.equal(duration(rounding, 1), 390);
});

test("injected clock pause/resume clears stale work and advances only after resume", () => {
  const clock = new FakeClock(); const controller = createMotionPlaybackController(model, { clock });
  controller.dispatch({ type: "play" }); controller.dispatch({ type: "pause" }); clock.fire(1); assert.deepEqual([controller.getState().status, controller.getState().stepIndex], ["paused", 0]);
  controller.dispatch({ type: "resume" }); clock.fire(2); assert.deepEqual([controller.getState().status, controller.getState().stepIndex, controller.getState().phase], ["playing", 0, "impact"]);
  assert.deepEqual(clock.cleared, [1]);
});

test("cancel, revision, skip and unmount clear pending callbacks without advancement", () => {
  for (const action of [
    { type: "cancel", reason: "user" } as const,
    { type: "revisionChanged", revision: "r2" } as const,
    { type: "skip" } as const,
  ]) {
    const clock = new FakeClock(); const controller = createMotionPlaybackController(model, { clock });
    controller.dispatch({ type: "play" }); controller.dispatch(action); clock.fire(1);
    assert.notEqual(controller.getState().stepIndex, 1);
    assert.deepEqual(clock.cleared, [1]);
  }
  const clock = new FakeClock(); const controller = createMotionPlaybackController(model, { clock });
  controller.dispatch({ type: "play" }); controller.dispose(); clock.fire(1); assert.equal(controller.getState().stepIndex, 0); assert.deepEqual(clock.cleared, [1]);
});

test("system reduced-motion defaults to the complete evidence state without waiting", () => {
  const media = { matches: true, addEventListener() {}, removeEventListener() {} };
  assert.equal(systemPrefersReducedMotion({ matchMedia: () => media }), true);
  const controller = createMotionPlaybackController(model, { clock: new FakeClock(), reducedMotion: systemPrefersReducedMotion({ matchMedia: () => media }) });
  assert.deepEqual([controller.getState().status, controller.getState().stepIndex], ["completed", model.steps.length]);
});

test("eight standard Trace entries use the fixed five-stage total plus a separate final lock", () => {
  const eight = Array.from({ length: 8 }, (_, index): MotionTraceLike => ({
    traceEntryId: `entry-${index + 1}`, sequence: index + 1, layer: index === 0 ? "weight_template" : "method",
    sourceRef: { sourceType: "Rule", sourceId: `rule-${index + 1}` }, sourceVersion: "1",
    before: index, operation: "add", operand: 1, after: index + 1, effect: "benefit", warningIssueIds: [], inputHash: `input-${index}`, outputHash: `output-${index}`,
  }));
  const eightModel = buildMotionPresentationModel({ businessRevision: "r8", subjectId: "model", parameterKey: "pull", trace: eight });
  const clock = new FakeClock(); const controller = createMotionPlaybackController(eightModel, { clock });
  controller.dispatch({ type: "play" });
  for (let handle = 1; handle <= 40; handle += 1) clock.fire(handle);
  assert.equal(controller.getState().status, "locking");
  clock.fire(41); assert.equal(controller.getState().status, "completed");
  const total = clock.delays.reduce((sum, delay) => sum + delay, 0);
  assert.equal(clock.delays.at(-1), motionTokens.duration.finalLockMs);
  assert.equal(total, motionTokens.duration.establishMs + motionTokens.duration.normalMs * 7 + motionTokens.duration.finalLockMs);
  assert.ok(total >= 2250 && total <= 2450, `expected 2.25–2.45s, received ${total}ms`);
  assert.ok(total <= 2500);
});

test("playback core has a strict no-command/network/persistence import boundary", () => {
  const source = readFileSync(fileURLToPath(new URL("../lib/motion-presentation.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|localStorage|sessionStorage|indexedDB|writeFile|issueClientActionCommand)\s*(\.|\()/);
  const controller = createMotionPlaybackController(model, { clock: new FakeClock() });
  controller.dispatch({ type: "skip" }); controller.dispatch({ type: "replay" }); controller.dispatch({ type: "skip" });
  assert.equal(controller.getState().status, "completed");
});

test("development fixture is excluded from production", () => {
  assert.equal(isMotionDevelopmentFixtureEnabled("production"), false);
  assert.equal(isMotionDevelopmentFixtureEnabled("development"), true);
});
