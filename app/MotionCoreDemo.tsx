"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { buildMotionPresentationModel, browserMotionClock, createMotionPlaybackController, reducedMotionQuery, systemPrefersReducedMotion, type MotionClock, type MotionTraceLike } from "@/lib/motion-presentation";

const demoTrace: MotionTraceLike[] = [
  { traceEntryId: "trace-template", sequence: 1, layer: "weight_template", sourceRef: { sourceType: "WeightTemplate", sourceId: "WT-6" }, sourceVersion: "ruleset-18", before: 0, operation: "set", operand: 8, after: 8, effect: "neutral", warningIssueIds: [], inputHash: "input-44", outputHash: "output-01", unit: "kgf" },
  { traceEntryId: "trace-method", sequence: 2, layer: "method", sourceRef: { sourceType: "MethodProfile", sourceId: "lure" }, sourceVersion: "ruleset-18", before: 8, operation: "multiply", operand: 1.1, after: 8.8, effect: "benefit", warningIssueIds: [], inputHash: "input-44", outputHash: "output-02", unit: "kgf" },
  { traceEntryId: "trace-patch", sequence: 3, layer: "model_patch", sourceRef: { sourceType: "Patch", sourceId: "MP-17" }, sourceVersion: "revision-3", before: 8.8, operation: "add", operand: -0.3, after: 8.5, effect: "cost", warningIssueIds: ["PATCH_REVIEWED"], inputHash: "input-44", outputHash: "output-03", unit: "kgf" },
  { traceEntryId: "trace-boundary", sequence: 4, layer: "boundary", sourceRef: { sourceType: "ParameterDefinition", sourceId: "rod-pull" }, sourceVersion: "ruleset-18", before: 8.5, operation: "max", operand: 0, after: 8.5, effect: "neutral", warningIssueIds: [], inputHash: "input-44", outputHash: "output-final", unit: "kgf" },
];

/** Development-only fixture: it is not linked from the product workbench. */
export function MotionCoreDemo({ clock = browserMotionClock }: { clock?: MotionClock }) {
  const model = useMemo(() => buildMotionPresentationModel({ businessRevision: "workspace-r18", subjectId: "model-demo", parameterKey: "rodPull", trace: demoTrace }), []);
  const [reducedMotion, setReducedMotion] = useState(() => systemPrefersReducedMotion());
  const controller = useMemo(() => createMotionPlaybackController(model, { clock, reducedMotion }), [clock, model, reducedMotion]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useEffect(() => {
    const media = window.matchMedia(reducedMotionQuery);
    const onChange = (event: { matches: boolean }) => setReducedMotion(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useEffect(() => () => controller.dispose(), [controller]);
  const visible = state.status === "completed" ? model.steps : model.steps.slice(0, Math.max(0, state.stepIndex + 1));
  return <main className="motion-core-demo"><section className="motion-core-card" aria-labelledby="motion-core-title">
    <p className="motion-kicker">Development fixture · MOTION-01</p><h1 id="motion-core-title">无副作用播放内核</h1>
    <p className="motion-subtitle">此页面仅消费冻结的 Trace 投影；控制按钮不会发起请求、写入或创建 revision。</p>
    <div className="motion-controls" aria-label="演出控制"><button onClick={() => controller.dispatch({ type: "play" })}>播放</button><button onClick={() => controller.dispatch({ type: "pause" })} disabled={state.status !== "playing"}>暂停</button><button onClick={() => controller.dispatch({ type: "resume" })} disabled={state.status !== "paused"}>继续</button><button onClick={() => controller.dispatch({ type: "skip" })}>直接看结果</button><button onClick={() => controller.dispatch({ type: "replay" })}>重播</button><button onClick={() => controller.dispatch({ type: "cancel", reason: "user" })}>取消</button><label><input type="checkbox" checked={state.reducedMotion} onChange={(event) => controller.dispatch({ type: "reducedMotionChanged", reducedMotion: event.target.checked })}/> 减少动态</label></div>
    <div className="motion-status" role="status">状态：<strong>{state.status}</strong> · 链路 {Math.min(visible.length, model.steps.length)}/{model.steps.length} · revision {state.revision}</div>
    <ol className="motion-steps">{visible.map((step) => <li key={step.id} className={`motion-step ${step.effect}`}><span>#{step.sequence} · {step.layer}</span><strong>{step.sourceId}</strong><span>{String(step.before)} {step.operation} {String(step.operand)} → {String(step.after)} {step.unit}</span><small>{step.warningIssueIds.length ? `检查：${step.warningIssueIds.join(", ")}` : "已保留 Trace 证据"}</small></li>)}</ol>
    <footer>最终值：<strong>{String(model.finalValue)} kgf</strong> · output hash：{model.outputHash}</footer>
  </section></main>;
}
