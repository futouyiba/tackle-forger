import type { MotionPresentationModel, MotionPresentationStep, MotionStatus } from "./motion-presentation";
import type { CalculationTraceEntry } from "./calculation-trace";

export interface TraceSettlementTarget {
  key: string;
  label: string;
  subjectRef: CalculationTraceEntry["subjectRef"];
  parameterKey: string;
}

function subjectKey(subjectRef: CalculationTraceEntry["subjectRef"]) {
  return [subjectRef.workspaceId, subjectRef.entityType, subjectRef.entityId, subjectRef.revisionId].join("|");
}

/** Returns display choices without changing archive order, identity, or sequence. */
export function traceSettlementTargets(entries: readonly CalculationTraceEntry[]): TraceSettlementTarget[] {
  const targets = new Map<string, TraceSettlementTarget>();
  for (const entry of entries) {
    const key = `${subjectKey(entry.subjectRef)}|${entry.parameterKey}`;
    if (!targets.has(key)) targets.set(key, {
      key,
      label: `${entry.subjectRef.entityType}:${entry.subjectRef.entityId} · ${entry.parameterKey}`,
      subjectRef: entry.subjectRef,
      parameterKey: entry.parameterKey,
    });
  }
  return [...targets.values()];
}

/** A read-only scope projection. Global sequence values deliberately retain gaps. */
export function projectTraceSettlementEntries(entries: readonly CalculationTraceEntry[], target: TraceSettlementTarget) {
  return entries.filter((entry) =>
    subjectKey(entry.subjectRef) === subjectKey(target.subjectRef)
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
export function traceSettlementMainValue(model: MotionPresentationModel, status: MotionStatus, stepIndex: number) {
  if (stepIndex < 0) return model.steps[0]?.before;
  if (status === "completed" || status === "locking" || stepIndex >= model.steps.length) return model.finalValue;
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

export function traceSettlementKind(step: Pick<MotionPresentationStep, "layer" | "operation" | "effect">) {
  if (step.operation === "no_effect") return { key: "no-effect", label: "本层无贡献" } as const;
  if (step.layer.includes("patch")) return { key: "patch", label: "Patch" } as const;
  if (step.layer === "boundary") return { key: "boundary", label: "边界 / 舍入" } as const;
  if (step.effect === "benefit") return { key: "benefit", label: "正向影响" } as const;
  if (step.effect === "cost") return { key: "cost", label: "负向影响" } as const;
  return { key: "neutral", label: "中性来源" } as const;
}

export function formatDisplayOnlyDelta(delta: number | undefined, unit?: string) {
  if (delta === undefined) return undefined;
  const formatted = Number.isInteger(delta) ? String(delta) : delta.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${delta > 0 ? "+" : ""}${formatted}${unit ? ` ${unit}` : ""}`;
}
