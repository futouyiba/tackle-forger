import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildMotionPresentationModel, computeMotionTimingBudget, createMotionPlaybackController, effectivePlaybackPhaseDuration, initialMotionPlaybackState, isMotionDevelopmentFixtureEnabled, MOTION_PRESENTATION_HARD_TOTAL_MS, motionPlaybackReducer, motionTokens, playbackPhaseDuration, playbackStepTotalMs, playbackTimingProfile, systemPrefersReducedMotion, type MotionClock, type MotionPlaybackPhase, type MotionTimingBudget, type MotionTimingProfile, type MotionTraceLike } from "../lib/motion-presentation";

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

test("every timing profile keeps its focus gates inside the §6.3 windows", () => {
  const profiles: readonly MotionTimingProfile[] = ["establish", "normal", "patch", "boundary", "cost"];
  for (const profile of profiles) {
    const timing = motionTokens.phaseDelay[profile];
    assert.ok(timing.impactToMainMs >= 90 && timing.impactToMainMs <= 120, `${profile} impactToMainMs ${timing.impactToMainMs} outside 90–120`);
    assert.ok(timing.mainToExplanationMs >= 100 && timing.mainToExplanationMs <= 140, `${profile} mainToExplanationMs ${timing.mainToExplanationMs} outside 100–140`);
  }
  // impact→evidence (140–180) is a visual-layer window overlapped with the focus gates,
  // not a serial phase sum — see motionTokens.duration.evidenceSettleMs.
  assert.ok(motionTokens.duration.evidenceSettleMs >= 140 && motionTokens.duration.evidenceSettleMs <= 180, "evidenceSettleMs outside 140–180");
  assert.ok(motionTokens.duration.finalLockMs >= 220 && motionTokens.duration.finalLockMs <= 280, "finalLockMs outside 220–280");
  assert.equal(playbackStepTotalMs("establish"), motionTokens.duration.establishMs);
  assert.equal(playbackStepTotalMs("normal"), motionTokens.duration.normalMs);
  assert.equal(playbackStepTotalMs("patch"), motionTokens.duration.costMs);
  assert.equal(playbackStepTotalMs("cost"), motionTokens.duration.costMs);
  assert.ok(playbackStepTotalMs("boundary") >= 360 && playbackStepTotalMs("boundary") <= 420, "boundary step total outside 360–420");
});

const makeTraceEntries = (specs: ReadonlyArray<{ layer: string; effect?: MotionTraceLike["effect"]; evidence?: Record<string, unknown> }>): MotionTraceLike[] =>
  specs.map((spec, index): MotionTraceLike => ({
    traceEntryId: `entry-${index + 1}`, sequence: index + 1, layer: spec.layer,
    sourceRef: { sourceType: "Rule", sourceId: `rule-${index + 1}` }, sourceVersion: "1",
    before: index, operation: "add", operand: 1, after: index + 1,
    effect: spec.effect ?? "benefit", warningIssueIds: [], inputHash: `in-${index}`, outputHash: `out-${index}`,
    ...(spec.evidence ? { evidence: spec.evidence } : {}),
  }));

test("eight trailing cost/Patch sources finish at the 2.5s cap with focus gates untouched and evidence complete", () => {
  const trace8 = makeTraceEntries([
    { layer: "weight_template" },
    ...Array.from({ length: 7 }, (_, index) => ({ layer: index % 2 ? "model_patch" : "method", effect: "cost" as const })),
  ]);
  const model8 = buildMotionPresentationModel({ businessRevision: "r8c", subjectId: "model", parameterKey: "pull", trace: trace8 });
  // 320 + 7*280 == 2280 exactly fills the step budget; no compression, so the focus gates stay at their in-window tokens.
  assert.deepEqual(computeMotionTimingBudget(model8.steps), { handoffScale: 1, focusScale: 1, feasible: true }, "eight cost/Patch sources exactly fill the budget, no compression");
  const clock = new FakeClock(); const controller = createMotionPlaybackController(model8, { clock });
  controller.dispatch({ type: "play" });
  for (let handle = 1; handle <= 40; handle += 1) clock.fire(handle);
  assert.equal(controller.getState().status, "locking");
  clock.fire(41); assert.equal(controller.getState().status, "completed");
  const total = clock.delays.reduce((sum, delay) => sum + delay, 0);
  assert.equal(clock.delays.at(-1), motionTokens.duration.finalLockMs);
  assert.ok(total <= MOTION_PRESENTATION_HARD_TOTAL_MS, `eight cost/Patch total ${total}ms exceeded the hard cap`);
  assert.equal(model8.evidence.traceEntryIds.length, 8, "complete Trace evidence is retained");
});

test("mixed boundary/rounding and normal sources stay under the cap with rounding on the boundary profile", () => {
  const traceMix = makeTraceEntries([
    { layer: "weight_template" },
    { layer: "method" },
    { layer: "method" },
    { layer: "method", effect: "cost" },
    { layer: "model_patch", effect: "cost" },
    { layer: "method" },
    { layer: "boundary", effect: "cost", evidence: { adapter: "pricing_trace/v2", operation: "round" } },
    { layer: "method" },
  ]);
  const modelMix = buildMotionPresentationModel({ businessRevision: "rmix", subjectId: "model", parameterKey: "pull", trace: traceMix });
  assert.equal(playbackTimingProfile(modelMix.steps[6]!, 6), "boundary", "canonical pricing rounding uses the boundary profile");
  const clock = new FakeClock(); const controller = createMotionPlaybackController(modelMix, { clock });
  controller.dispatch({ type: "play" });
  for (let handle = 1; handle <= 40; handle += 1) clock.fire(handle);
  clock.fire(41); assert.equal(controller.getState().status, "completed");
  const total = clock.delays.reduce((sum, delay) => sum + delay, 0);
  assert.ok(total <= MOTION_PRESENTATION_HARD_TOTAL_MS, `mixed total ${total}ms exceeded the hard cap`);
  assert.equal(modelMix.evidence.traceEntryIds.length, 8);
});

test("compressed source counts keep every focus gate inside the §6.3 windows and stay under the hard cap", () => {
  // Each scenario triggers compression (uncompressed total > step budget). The
  // focus gates (impact 90–120, main 100–140) must still hold AFTER compression
  // while the serial total stays ≤ the 2.5s cap — the simultaneous §6.3
  // guarantee a uniform `* timingScale` would silently break.
  const scenarios: ReadonlyArray<{
    name: string;
    specs: ReadonlyArray<{ layer: string; effect?: MotionTraceLike["effect"]; evidence?: Record<string, unknown> }>;
  }> = [
    { name: "nine-mixed", specs: Array.from({ length: 9 }, (_, index) => ({ layer: index === 0 ? "weight_template" : "method", effect: (index % 3 === 0 ? "cost" : "benefit") as MotionTraceLike["effect"] })) },
    { name: "twelve-mixed", specs: Array.from({ length: 12 }, (_, index) => ({ layer: index === 0 ? "weight_template" : "method", effect: (index % 3 === 0 ? "cost" : "benefit") as MotionTraceLike["effect"] })) },
    { name: "nine-all-negative", specs: [{ layer: "weight_template", effect: "cost" as const }, ...Array.from({ length: 8 }, () => ({ layer: "method", effect: "cost" as const }))] },
    { name: "ten-mixed-boundary-patch", specs: [
      { layer: "weight_template" },
      { layer: "model_patch", effect: "cost" as const },
      { layer: "boundary", effect: "cost" as const, evidence: { adapter: "pricing_trace/v2", operation: "round" } },
      { layer: "method", effect: "cost" as const },
      { layer: "method" },
      { layer: "method" },
      { layer: "method", effect: "cost" as const },
      { layer: "model_patch", effect: "cost" as const },
      { layer: "method" },
      { layer: "method" },
    ] },
  ];
  for (const { name, specs } of scenarios) {
    const modelN = buildMotionPresentationModel({ businessRevision: name, subjectId: "model", parameterKey: "pull", trace: makeTraceEntries(specs) });
    const budget = computeMotionTimingBudget(modelN.steps);
    assert.equal(budget.feasible, true, `${name}: focus floors must fit the step budget`);
    const clock = new FakeClock(); const controller = createMotionPlaybackController(modelN, { clock });
    controller.dispatch({ type: "play" });
    for (let handle = 1; handle <= modelN.steps.length * 5; handle += 1) clock.fire(handle);
    clock.fire(modelN.steps.length * 5 + 1);
    assert.equal(controller.getState().status, "completed", `${name}: should reach completed`);
    assert.equal(modelN.evidence.traceEntryIds.length, modelN.steps.length, `${name}: evidence must stay complete`);
    // Behavioral focus-window check on the ACTUAL scheduled delays (clock.delays
    // are in step order source/impact/main/explanation/evidence): impact and
    // main must remain inside [90,120] / [100,140] even under compression.
    for (let step = 0; step < modelN.steps.length; step += 1) {
      const impact = clock.delays[step * 5 + 1]!;
      const main = clock.delays[step * 5 + 2]!;
      assert.ok(impact >= 90 && impact <= 120, `${name} step ${step} impact ${impact} outside 90–120`);
      assert.ok(main >= 100 && main <= 140, `${name} step ${step} main ${main} outside 100–140`);
    }
    const total = clock.delays.reduce((sum, delay) => sum + delay, 0);
    assert.ok(total <= MOTION_PRESENTATION_HARD_TOTAL_MS, `${name} total ${total}ms exceeded the hard cap`);
  }
});

test("beyond the serial-feasible bound the compressor clamps focus gates to their floor and never below", () => {
  // 16 sources: the focus floors alone (16 * 190 = 3040ms) exceed the 2280ms
  // step budget, so serial playback cannot meet the 2.5s cap. §6.3 routes this
  // to grouped settlement (threshold configured separately); until then the
  // compressor degrades gracefully — focus gates stay at the §6.3 floor, never
  // below it — and the complete evidence is retained.
  const trace16 = makeTraceEntries(Array.from({ length: 16 }, (_, index) => ({
    layer: index === 0 ? "weight_template" : "method",
    effect: (index % 3 === 0 ? "cost" : "benefit") as MotionTraceLike["effect"],
  })));
  const model16 = buildMotionPresentationModel({ businessRevision: "r16", subjectId: "model", parameterKey: "pull", trace: trace16 });
  const budget = computeMotionTimingBudget(model16.steps);
  assert.equal(budget.feasible, false, "16 sources exceed the serial-feasible bound");
  assert.equal(budget.focusScale, 0);
  assert.equal(budget.handoffScale, 0);
  const clock = new FakeClock(); const controller = createMotionPlaybackController(model16, { clock });
  controller.dispatch({ type: "play" });
  for (let handle = 1; handle <= 16 * 5; handle += 1) clock.fire(handle);
  clock.fire(16 * 5 + 1);
  assert.equal(controller.getState().status, "completed");
  for (let step = 0; step < 16; step += 1) {
    const impact = clock.delays[step * 5 + 1]!;
    const main = clock.delays[step * 5 + 2]!;
    assert.ok(impact >= 90 && impact <= 120, `step ${step} impact ${impact} outside 90–120`);
    assert.ok(main >= 100 && main <= 140, `step ${step} main ${main} outside 100–140`);
  }
  assert.equal(model16.evidence.traceEntryIds.length, 16, "evidence must stay complete even past the feasible bound");
});

test("effectivePlaybackPhaseDuration scales focus headroom and handoff phases independently", () => {
  const floor = motionTokens.phaseFloor;
  const establish = model.steps[0]!;
  const patchStep = model.steps[1]!;
  // No compression: effective equals the token.
  const idle: MotionTimingBudget = { handoffScale: 1, focusScale: 1, feasible: true };
  assert.equal(effectivePlaybackPhaseDuration(patchStep, 1, "impact", idle), motionTokens.phaseDelay.patch.impactToMainMs);
  assert.equal(effectivePlaybackPhaseDuration(patchStep, 1, "source", idle), motionTokens.phaseDelay.patch.sourceToImpactMs);
  // Heavy compression: focus gates collapse to the floor (never below); handoff to 0.
  const crushed: MotionTimingBudget = { handoffScale: 0, focusScale: 0, feasible: true };
  assert.equal(effectivePlaybackPhaseDuration(establish, 0, "impact", crushed), floor.impactToMainMs, "impact never drops below the floor");
  assert.equal(effectivePlaybackPhaseDuration(establish, 0, "main_number", crushed), floor.mainToExplanationMs, "main never drops below the floor");
  assert.equal(effectivePlaybackPhaseDuration(patchStep, 1, "source", crushed), 0, "handoff is clamped to 0");
  // Half headroom on the establish profile: impact 90 + (100-90)*0.5 = 95; main 100 + (120-100)*0.5 = 110.
  const half: MotionTimingBudget = { handoffScale: 0.5, focusScale: 0.5, feasible: true };
  assert.equal(effectivePlaybackPhaseDuration(establish, 0, "impact", half), 95);
  assert.equal(effectivePlaybackPhaseDuration(establish, 0, "main_number", half), 110);
  assert.equal(effectivePlaybackPhaseDuration(patchStep, 1, "source", half), motionTokens.phaseDelay.patch.sourceToImpactMs * 0.5);
});
