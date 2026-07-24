/**
 * MOTION-01 presentation-only playback kernel.
 *
 * This module intentionally has no imports from commands, storage, or network
 * code. It consumes an already-authoritative result and can only change local
 * presentation state.
 */

export type MotionStatus = "idle" | "playing" | "paused" | "completed" | "cancelled" | "superseded";

export interface MotionTraceLike {
  traceEntryId: string;
  sequence: number;
  layer: string;
  sourceRef: { sourceId: string; sourceType: string } | { entityId: string; entityType: string };
  sourceVersion: string;
  before: unknown;
  operation: string;
  operand: unknown;
  after: unknown;
  effect: "benefit" | "cost" | "neutral" | "contextual";
  warningIssueIds: string[];
  inputHash: string;
  outputHash: string;
  unit?: string;
}

export interface MotionPresentationStep {
  id: string;
  sequence: number;
  layer: string;
  sourceId: string;
  sourceVersion: string;
  before: unknown;
  operation: string;
  operand: unknown;
  after: unknown;
  effect: MotionTraceLike["effect"];
  warningIssueIds: readonly string[];
  inputHash: string;
  outputHash: string;
  unit?: string;
}

/** A read-only projection. It must be rebuilt when the authoritative revision changes. */
export interface MotionPresentationModel {
  businessRevision: string;
  subjectId: string;
  parameterKey: string;
  inputHash: string;
  outputHash: string;
  steps: readonly MotionPresentationStep[];
  finalValue: unknown;
  evidence: Readonly<{ traceEntryIds: readonly string[]; warningIssueIds: readonly string[] }>;
}

export const motionTokens = {
  duration: { establishMs: 340, normalMs: 240, patchMs: 300, boundaryMs: 390, reducedMs: 0 },
  easing: { enter: "cubic-bezier(0.2, 0.8, 0.2, 1)", emphasis: "cubic-bezier(0.16, 1, 0.3, 1)" },
  displacement: { cardPx: 16, emphasisPx: 4 },
  emphasis: { normal: 1, restrained: 0.35 },
  layer: { base: 0, active: 1, controls: 2 },
  reducedMotion: { autoplay: false, durationMs: 0 },
} as const;

function sourceId(source: MotionTraceLike["sourceRef"]): string {
  return "sourceId" in source ? source.sourceId : source.entityId;
}

function frozenPresentationValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  // Calculation Trace is JSON-safe by its canonical contract. Clone it so a
  // later mutation to an upstream DTO cannot mutate the presentation evidence.
  const copy = structuredClone(value) as Record<string, unknown> | unknown[];
  const freeze = (candidate: unknown): unknown => {
    if (candidate && typeof candidate === "object") {
      Object.values(candidate).forEach(freeze);
      Object.freeze(candidate);
    }
    return candidate;
  };
  return freeze(copy);
}

/** Builds stable display order without recalculating, coalescing, or mutating Trace. */
export function buildMotionPresentationModel(input: {
  businessRevision: string;
  subjectId: string;
  parameterKey: string;
  trace: readonly MotionTraceLike[];
}): MotionPresentationModel {
  // The trace order is authoritative. Presentation must reject, never repair,
  // an out-of-order payload because sorting would hide an upstream defect.
  const ordered = [...input.trace];
  const seen = new Set<number>();
  for (const [index, entry] of ordered.entries()) {
    if (seen.has(entry.sequence)) throw new Error("Motion Trace sequence must be unique.");
    seen.add(entry.sequence);
    if (entry.inputHash !== ordered[0]?.inputHash) throw new Error("Motion Trace input hash mismatch.");
    if (index > 0 && entry.sequence <= ordered[index - 1].sequence) {
      throw new Error("Motion Trace sequence must already be in authoritative order.");
    }
  }
  const last = ordered.at(-1);
  return Object.freeze({
    businessRevision: input.businessRevision,
    subjectId: input.subjectId,
    parameterKey: input.parameterKey,
    inputHash: ordered[0]?.inputHash ?? "",
    outputHash: last?.outputHash ?? "",
    steps: Object.freeze(ordered.map((entry) => Object.freeze({
      id: entry.traceEntryId, sequence: entry.sequence, layer: entry.layer,
      sourceId: sourceId(entry.sourceRef), sourceVersion: entry.sourceVersion,
      before: frozenPresentationValue(entry.before), operation: entry.operation, operand: frozenPresentationValue(entry.operand),
      after: frozenPresentationValue(entry.after), effect: entry.effect, warningIssueIds: Object.freeze([...entry.warningIssueIds]),
      inputHash: entry.inputHash, outputHash: entry.outputHash, unit: entry.unit,
    }))),
    finalValue: frozenPresentationValue(last?.after),
    evidence: Object.freeze({
      traceEntryIds: Object.freeze(ordered.map((entry) => entry.traceEntryId)),
      warningIssueIds: Object.freeze(ordered.flatMap((entry) => entry.warningIssueIds)),
    }),
  });
}

export interface MotionPlaybackState {
  status: MotionStatus;
  revision: string;
  stepIndex: number;
  reducedMotion: boolean;
  cancellationReason?: "unmount" | "route" | "revision" | "user";
}

export type MotionPlaybackAction =
  | { type: "play" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "advance" }
  | { type: "skip" }
  | { type: "replay" }
  | { type: "cancel"; reason: MotionPlaybackState["cancellationReason"] }
  | { type: "revisionChanged"; revision: string }
  | { type: "reducedMotionChanged"; reducedMotion: boolean };

export function initialMotionPlaybackState(model: MotionPresentationModel, reducedMotion = false): MotionPlaybackState {
  return { status: reducedMotion ? "completed" : "idle", revision: model.businessRevision, stepIndex: reducedMotion ? model.steps.length : -1, reducedMotion };
}

/** Pure reducer: it never calls a command, writes persistence, or derives business facts. */
export function motionPlaybackReducer(
  state: MotionPlaybackState,
  action: MotionPlaybackAction,
  stepCount: number,
): MotionPlaybackState {
  // A stale model is terminal. Only constructing state from a new presentation
  // model is allowed to begin playback after a revision/cancellation boundary.
  if (state.status === "cancelled" || state.status === "superseded") return state;
  switch (action.type) {
    case "play": return state.reducedMotion ? { ...state, status: "completed", stepIndex: stepCount } : { ...state, status: "playing", stepIndex: Math.max(0, state.stepIndex) };
    case "pause": return state.status === "playing" ? { ...state, status: "paused" } : state;
    case "resume": return state.status === "paused" ? { ...state, status: "playing" } : state;
    case "advance": {
      if (state.status !== "playing") return state;
      const stepIndex = state.stepIndex + 1;
      return stepIndex >= stepCount ? { ...state, status: "completed", stepIndex: stepCount } : { ...state, stepIndex };
    }
    case "skip": return { ...state, status: "completed", stepIndex: stepCount };
    case "replay": return state.reducedMotion ? { ...state, status: "completed", stepIndex: stepCount } : { ...state, status: "playing", stepIndex: 0, cancellationReason: undefined };
    case "cancel": return { ...state, status: action.reason === "revision" ? "superseded" : "cancelled", cancellationReason: action.reason };
    case "revisionChanged": return action.revision === state.revision ? state : { ...state, revision: action.revision, status: "superseded", cancellationReason: "revision" };
    case "reducedMotionChanged": return action.reducedMotion ? { ...state, reducedMotion: true, status: "completed", stepIndex: stepCount } : { ...state, reducedMotion: false };
  }
}

export interface MotionClock { set(callback: () => void, delayMs: number): unknown; clear(handle: unknown): void; }
export const browserMotionClock: MotionClock = { set: (callback, delayMs) => setTimeout(callback, delayMs), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export interface MotionPlaybackController {
  dispatch(action: MotionPlaybackAction): MotionPlaybackState;
  getState(): MotionPlaybackState;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/**
 * The only scheduler used by the presentation layer. It accepts a clock so
 * tests can advance time without waiting, and has no command/fetch/storage
 * dependency or callback by which it could write business state.
 */
export function createMotionPlaybackController(
  model: MotionPresentationModel,
  options: { clock?: MotionClock; reducedMotion?: boolean } = {},
): MotionPlaybackController {
  const clock = options.clock ?? browserMotionClock;
  const listeners = new Set<() => void>();
  let state = initialMotionPlaybackState(model, options.reducedMotion);
  let handle: unknown;
  let disposed = false;
  let generation = 0;
  const clearTimer = () => {
    generation += 1;
    if (handle !== undefined) clock.clear(handle);
    handle = undefined;
  };
  const notify = () => listeners.forEach((listener) => listener());
  const schedule = () => {
    if (disposed || state.status !== "playing" || state.reducedMotion) return;
    const expectedGeneration = generation;
    handle = clock.set(() => {
      if (disposed || expectedGeneration !== generation) return;
      handle = undefined;
      dispatch({ type: "advance" });
    }, playbackStepDuration(model.steps[state.stepIndex]));
  };
  const dispatch = (action: MotionPlaybackAction): MotionPlaybackState => {
    if (disposed) return state;
    clearTimer();
    state = motionPlaybackReducer(state, action, model.steps.length);
    notify();
    schedule();
    return state;
  };
  return {
    dispatch,
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { if (!disposed) { clearTimer(); disposed = true; listeners.clear(); } },
  };
}

export interface MotionMediaQueryList {
  matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
}
export interface MotionMediaEnvironment { matchMedia(query: string): MotionMediaQueryList; }
export const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
export function isMotionDevelopmentFixtureEnabled(nodeEnvironment: string | undefined): boolean {
  return nodeEnvironment !== "production";
}
export function systemPrefersReducedMotion(environment: MotionMediaEnvironment | undefined = typeof window === "undefined" ? undefined : window): boolean {
  return environment?.matchMedia(reducedMotionQuery).matches ?? false;
}

export function playbackStepDuration(step: MotionPresentationStep | undefined): number {
  if (!step) return motionTokens.duration.normalMs;
  if (step.layer.includes("patch")) return motionTokens.duration.patchMs;
  if (step.layer === "boundary") return motionTokens.duration.boundaryMs;
  return motionTokens.duration.normalMs;
}
