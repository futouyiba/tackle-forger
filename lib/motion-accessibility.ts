import type { MotionPresentationStep, MotionStatus } from "./motion-presentation";

/** A user-facing presentation preference; it never changes authoritative results. */
export type MotionPreference = "system" | "reduce" | "full";

export function resolveReducedMotion(preference: MotionPreference, systemReducedMotion: boolean): boolean {
  // The product preference can request less motion, never more than the OS allows.
  // Keep "full" as a backwards-compatible stored value meaning that the product
  // itself does not request reduction; an OS reduce preference still wins.
  return systemReducedMotion || preference === "reduce";
}

/** Only stage changes are announced. Per-step values intentionally never enter a live region. */
export function motionLiveAnnouncement(previous: MotionStatus | undefined, next: MotionStatus): string {
  if (previous === undefined) return "";
  if (previous === next) return "";
  if (next === "playing") return "已开始播放 Trace。";
  if (next === "paused") return "Trace 已暂停。";
  if (next === "completed") return "Trace 已完成；最终结果和完整证据已显示。";
  if (next === "cancelled" || next === "superseded") return "Trace 播放已停止；冻结证据保持可见。";
  return "";
}

export type MotionKeyboardCommand = "playPause" | "skip" | "replay" | "trace" | "issues";
type MotionStateTone = "benefit" | "cost" | "patch" | "check" | "neutral";

/**
 * A stopped or invalidated presentation must not make already-authoritative
 * evidence disappear. This remains a display decision: it never resumes or
 * recalculates a stale sequence.
 */
export function visibleMotionEvidence<T>(
  status: MotionStatus,
  steps: readonly T[],
  stepIndex: number,
): readonly T[] {
  if (status === "completed" || status === "cancelled" || status === "superseded") return steps;
  return steps.slice(0, Math.max(0, stepIndex + 1));
}

/** Labels retained evidence without implying that it belongs to a newer revision. */
export function motionFrozenEvidenceNotice(
  status: MotionStatus,
  sourceRevision: string,
  detectedRevision: string,
  outputHash: string,
): string | undefined {
  if (status === "superseded") {
    return `已阻断：检测到 revision ${detectedRevision}。以下为来源 revision ${sourceRevision} 的冻结 Trace 证据（output hash：${outputHash}），不是新 revision 的结果。`;
  }
  if (status === "cancelled") {
    return `播放已停止：以下为来源 revision ${sourceRevision} 的冻结 Trace 证据（output hash：${outputHash}）；未继续结算或改写结果。`;
  }
  return undefined;
}

/** Keyboard shortcuts are ignored while typing in a native editable control. */
export function motionKeyboardCommand(
  key: string,
  options: { editableTarget?: boolean; interactiveTarget?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
): MotionKeyboardCommand | undefined {
  if (options.editableTarget || options.interactiveTarget || options.altKey || options.ctrlKey || options.metaKey) return undefined;
  if (key === " " || key.toLowerCase() === "p") return "playPause";
  if (key.toLowerCase() === "s") return "skip";
  if (key.toLowerCase() === "r") return "replay";
  if (key.toLowerCase() === "t") return "trace";
  if (key.toLowerCase() === "i") return "issues";
  return undefined;
}

export function motionStepState(step: Pick<MotionPresentationStep, "effect" | "layer" | "warningIssueIds">): {
  label: string;
  tone: MotionStateTone;
  modifiers: readonly MotionStateTone[];
} {
  const effect: MotionStateTone = step.effect === "benefit" ? "benefit" : step.effect === "cost" ? "cost" : "neutral";
  const modifiers: MotionStateTone[] = [
    ...(step.warningIssueIds.length ? ["check" as const] : []),
    ...(step.layer.includes("patch") ? ["patch" as const] : []),
    effect,
  ];
  const labels = [
    ...(step.warningIssueIds.length ? ["检查"] : []),
    ...(step.layer.includes("patch") ? ["Patch"] : []),
    effect === "benefit" ? "正向" : effect === "cost" ? "代价" : "中性",
  ];
  return {
    label: labels.join(" · "),
    tone: modifiers[0] ?? "neutral",
    modifiers,
  };
}
