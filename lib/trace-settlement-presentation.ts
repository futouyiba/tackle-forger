import type { MotionPlaybackPhase, MotionPresentationModel, MotionPresentationStep, MotionStatus } from "./motion-presentation";
import type { CalculationTraceEntry } from "./calculation-trace";

export interface TraceSettlementTarget {
  key: string;
  label: string;
  subjectRef: CalculationTraceEntry["subjectRef"];
  parameterKey: string;
}

/**
 * A UI selection value, not a domain identity. JSON preserves tuple boundaries
 * when user-controlled IDs or parameter keys themselves contain delimiters.
 */
function targetKey(subjectRef: CalculationTraceEntry["subjectRef"], parameterKey: string) {
  return JSON.stringify([
    subjectRef.workspaceId,
    subjectRef.entityType,
    subjectRef.entityId,
    subjectRef.revisionId,
    parameterKey,
  ]);
}

function sameSubjectRef(
  left: CalculationTraceEntry["subjectRef"],
  right: CalculationTraceEntry["subjectRef"],
) {
  return left.workspaceId === right.workspaceId
    && left.entityType === right.entityType
    && left.entityId === right.entityId
    && left.revisionId === right.revisionId;
}

/** Returns display choices without changing archive order, identity, or sequence. */
export function traceSettlementTargets(entries: readonly CalculationTraceEntry[]): TraceSettlementTarget[] {
  const targets = new Map<string, TraceSettlementTarget>();
  for (const entry of entries) {
    const key = targetKey(entry.subjectRef, entry.parameterKey);
    if (!targets.has(key)) targets.set(key, {
      key,
      label: `${entry.subjectRef.workspaceId} · ${entry.subjectRef.entityType}:${entry.subjectRef.entityId}@${entry.subjectRef.revisionId} · ${entry.parameterKey}`,
      subjectRef: entry.subjectRef,
      parameterKey: entry.parameterKey,
    });
  }
  return [...targets.values()];
}

/** A read-only scope projection. Global sequence values deliberately retain gaps. */
export function projectTraceSettlementEntries(entries: readonly CalculationTraceEntry[], target: TraceSettlementTarget) {
  return entries.filter((entry) =>
    sameSubjectRef(entry.subjectRef, target.subjectRef)
    && entry.parameterKey === target.parameterKey,
  );
}

/**
 * The settlement animation is only a scoped presentation. Its playback state
 * must never hide, filter, or replace the canonical frozen archive evidence.
 */
export function canonicalTraceEvidenceEntries(entries: readonly CalculationTraceEntry[]) {
  return entries;
}

/** Idle always presents the first frozen before value; final values appear only after settlement advances. */
export function traceSettlementMainValue(model: MotionPresentationModel, status: MotionStatus, stepIndex: number, phase?: MotionPlaybackPhase) {
  if (stepIndex < 0) return model.steps[0]?.before;
  if (status === "completed" || status === "locking" || stepIndex >= model.steps.length) return model.finalValue;
  if (phase === "source" || phase === "impact") return model.steps[stepIndex]?.before;
  return model.steps[stepIndex]?.after;
}

/**
 * #103's deliberately narrow view-only exception to the Trace consumer rule.
 * It is never persisted, hashed, replayed, or used to decide a domain result.
 */
export function displayOnlyTraceDelta(
  before: unknown,
  after: unknown,
  operation: MotionPresentationStep["operation"],
): number | undefined {
  if (["set", "clear", "min", "max", "no_effect"].includes(operation)) return undefined;
  if (typeof before !== "number" || typeof after !== "number") return undefined;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return undefined;
  const delta = after - before;
  if (!Number.isFinite(delta)) return undefined;
  return Object.is(delta, -0) ? 0 : delta;
}

export function traceSettlementKind(step: Pick<MotionPresentationStep, "layer" | "operation" | "effect" | "evidence">) {
  if (step.operation === "no_effect") return { key: "no-effect", label: "本层无贡献" } as const;
  if (step.layer.includes("patch")) return { key: "patch", label: "Patch" } as const;
  if (step.layer === "boundary") {
    const evidence = step.evidence ?? {};
    // Canonical Trace normalizes legacy pricing operations to executable
    // operations. Only the versioned pricing adapter's preserved raw operation
    // authoritatively distinguishes rounding from a generic boundary entry.
    const rounding = (evidence.adapter === "pricing_trace/v1" || evidence.adapter === "pricing_trace/v2")
      && evidence.operation === "round";
    return rounding ? { key: "rounding", label: "舍入" } as const : { key: "boundary", label: "边界校验" } as const;
  }
  if (step.effect === "benefit") return { key: "benefit", label: "正向影响" } as const;
  if (step.effect === "cost") return { key: "cost", label: "负向影响" } as const;
  return { key: "neutral", label: "中性来源" } as const;
}

export function formatDisplayOnlyDelta(delta: number | undefined, unit?: string) {
  if (delta === undefined) return undefined;
  const formatted = Number.isInteger(delta) ? String(delta) : delta.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${delta > 0 ? "+" : ""}${formatted}${unit ? ` ${unit}` : ""}`;
}
