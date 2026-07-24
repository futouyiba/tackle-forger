import type { MotionPresentationStep, MotionStatus } from "./motion-presentation";

/** A user-facing presentation preference; it never changes authoritative results. */
export type MotionPreference = "system" | "reduce" | "full";

export function resolveReducedMotion(preference: MotionPreference, systemReducedMotion: boolean): boolean {
  if (preference === "reduce") return true;
  if (preference === "full") return false;
  return systemReducedMotion;
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

/** Keyboard shortcuts are ignored while typing in a native editable control. */
export function motionKeyboardCommand(
  key: string,
  options: { editableTarget?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
): MotionKeyboardCommand | undefined {
  if (options.editableTarget || options.altKey || options.ctrlKey || options.metaKey) return undefined;
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
