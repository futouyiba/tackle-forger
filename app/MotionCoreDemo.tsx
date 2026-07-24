"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { buildMotionPresentationModel, browserMotionClock, createMotionPlaybackController, reducedMotionQuery, systemPrefersReducedMotion, type MotionClock, type MotionTraceLike } from "@/lib/motion-presentation";
import { motionKeyboardCommand, motionLiveAnnouncement, motionStepState, resolveReducedMotion, type MotionPreference } from "@/lib/motion-accessibility";

const demoTrace: MotionTraceLike[] = [
  { traceEntryId: "trace-template", sequence: 1, layer: "weight_template", sourceRef: { sourceType: "WeightTemplate", sourceId: "WT-6" }, sourceVersion: "ruleset-18", before: 0, operation: "set", operand: 8, after: 8, effect: "neutral", warningIssueIds: [], inputHash: "input-44", outputHash: "output-01", unit: "kgf" },
  { traceEntryId: "trace-method", sequence: 2, layer: "method", sourceRef: { sourceType: "MethodProfile", sourceId: "lure" }, sourceVersion: "ruleset-18", before: 8, operation: "multiply", operand: 1.1, after: 8.8, effect: "benefit", warningIssueIds: [], inputHash: "input-44", outputHash: "output-02", unit: "kgf" },
  { traceEntryId: "trace-patch", sequence: 3, layer: "model_patch", sourceRef: { sourceType: "Patch", sourceId: "MP-17" }, sourceVersion: "revision-3", before: 8.8, operation: "add", operand: -0.3, after: 8.5, effect: "cost", warningIssueIds: ["PATCH_REVIEWED"], inputHash: "input-44", outputHash: "output-03", unit: "kgf" },
  { traceEntryId: "trace-boundary", sequence: 4, layer: "boundary", sourceRef: { sourceType: "ParameterDefinition", sourceId: "rod-pull" }, sourceVersion: "ruleset-18", before: 8.5, operation: "max", operand: 0, after: 8.5, effect: "neutral", warningIssueIds: [], inputHash: "input-44", outputHash: "output-final", unit: "kgf" },
];

/** Development-only fixture: it is not linked from the product workbench. */
export function MotionCoreDemo({ clock = browserMotionClock }: { clock?: MotionClock }) {
  const model = useMemo(() => buildMotionPresentationModel({ businessRevision: "workspace-r18", subjectId: "model-demo", parameterKey: "rodPull", trace: demoTrace }), []);
  const [systemReducedMotion, setSystemReducedMotion] = useState(() => systemPrefersReducedMotion());
  const [preference, setPreference] = useState<MotionPreference>("system");
  const [selectedEvidenceIndex, setSelectedEvidenceIndex] = useState(0);
  const reducedMotion = resolveReducedMotion(preference, systemReducedMotion);
  const controller = useMemo(() => createMotionPlaybackController(model, { clock, reducedMotion }), [clock, model, reducedMotion]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const traceRef = useRef<HTMLOListElement>(null);
  const issuesRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef<typeof state.status | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    setAnnouncement(motionLiveAnnouncement(previousStatus.current, state.status));
    previousStatus.current = state.status;
  }, [state.status]);
  useEffect(() => {
    const media = window.matchMedia(reducedMotionQuery);
    const onChange = (event: { matches: boolean }) => setSystemReducedMotion(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useEffect(() => () => controller.dispose(), [controller]);
  const visible = state.status === "completed" ? model.steps : model.steps.slice(0, Math.max(0, state.stepIndex + 1));
  const selectEvidence = (direction: -1 | 1) => setSelectedEvidenceIndex((index) => Math.min(model.steps.length - 1, Math.max(0, index + direction)));
  const focusEvidence = (target: "trace" | "issues") => (target === "trace" ? traceRef.current : issuesRef.current)?.focus();
  const togglePlayPause = () => controller.dispatch({ type: state.status === "playing" ? "pause" : state.status === "paused" ? "resume" : "play" });
  return <main className="motion-core-demo"><section className="motion-core-card" aria-labelledby="motion-core-title" onKeyDown={(event) => {
    const editable = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement;
    const command = motionKeyboardCommand(event.key, { editableTarget: editable, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
    if (!command) return;
    event.preventDefault();
    if (command === "playPause") togglePlayPause();
    if (command === "skip") controller.dispatch({ type: "skip" });
    if (command === "replay") controller.dispatch({ type: "replay" });
    if (command === "trace" || command === "issues") focusEvidence(command);
  }}>
    <p className="motion-kicker">Development fixture · MOTION-01</p><h1 id="motion-core-title">无副作用播放内核</h1>
    <p className="motion-subtitle">此页面仅消费冻结的 Trace 投影；控制按钮不会发起请求、写入或创建 revision。</p>
    <div className="motion-preference"><label htmlFor="motion-preference">动态偏好</label><select id="motion-preference" value={preference} onChange={(event) => setPreference(event.target.value as MotionPreference)}><option value="system">跟随系统</option><option value="reduce">减少动态</option><option value="full">允许播放</option></select><span>{reducedMotion ? "当前直接显示最终结果和完整证据；可手动逐项查看。" : "当前可播放，也可随时直接看结果。"}</span></div>
    <div className="motion-controls" aria-label="演出控制"><button type="button" onClick={togglePlayPause} aria-keyshortcuts="P Space">{state.status === "playing" ? "暂停" : state.status === "paused" ? "继续" : "播放"}</button><button type="button" onClick={() => controller.dispatch({ type: "skip" })} aria-keyshortcuts="S">直接看结果</button><button type="button" onClick={() => controller.dispatch({ type: "replay" })} aria-keyshortcuts="R">重播</button><button type="button" onClick={() => controller.dispatch({ type: "cancel", reason: "user" })}>取消</button><button type="button" onClick={() => controller.dispatch({ type: "revisionChanged", revision: `${model.businessRevision}-fixture-update` })}>模拟 revision 变化</button></div>
    <nav className="motion-evidence-links" aria-label="Trace 与 Issue 入口"><button type="button" onClick={() => focusEvidence("trace")} aria-keyshortcuts="T">查看 Trace</button><button type="button" onClick={() => focusEvidence("issues")} aria-keyshortcuts="I">查看 Issue</button></nav>
    <div className="motion-status">状态：<strong>{state.status}</strong> · 链路 {Math.min(visible.length, model.steps.length)}/{model.steps.length} · revision {state.revision}</div><p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
    {reducedMotion ? <div className="motion-manual-evidence"><strong>逐项查看</strong><button type="button" onClick={() => selectEvidence(-1)} disabled={selectedEvidenceIndex === 0}>上一项</button><span>{selectedEvidenceIndex + 1}/{model.steps.length}</span><button type="button" onClick={() => selectEvidence(1)} disabled={selectedEvidenceIndex === model.steps.length - 1}>下一项</button></div> : null}
    <ol className="motion-steps" id="motion-core-trace" ref={traceRef} tabIndex={-1}>{visible.map((step, index) => { const semantic = motionStepState(step); return <li key={step.id} className={`motion-step ${semantic.modifiers.join(" ")} ${selectedEvidenceIndex === index ? "is-selected" : ""}`} aria-current={selectedEvidenceIndex === index ? "step" : undefined}><span className="motion-step-kind">{semantic.label}</span><span>#{step.sequence} · {step.layer}</span><strong>{step.sourceId}</strong><span>{String(step.before)} {step.operation} {String(step.operand)} → {String(step.after)} {step.unit}</span><small>{step.warningIssueIds.length ? `检查：${step.warningIssueIds.join(", ")}` : "已保留 Trace 证据"}</small></li>; })}</ol>
    <div className="motion-issues" id="motion-core-issues" ref={issuesRef} tabIndex={-1}><strong>检查 Issue</strong>{model.evidence.warningIssueIds.length ? <ul>{model.evidence.warningIssueIds.map((issueId) => <li key={issueId}>检查 · {issueId}</li>)}</ul> : <p>无附加 Issue；冻结 Trace 证据完整可见。</p>}</div>
    <footer>最终值：<strong>{String(model.finalValue)} kgf</strong> · output hash：{model.outputHash}</footer>
  </section></main>;
}
