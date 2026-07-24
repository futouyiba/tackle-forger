"use client";

import { AlertTriangle, BadgeCheck, Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  buildMotionPresentationModel,
  createMotionPlaybackController,
  reducedMotionQuery,
  systemPrefersReducedMotion,
  type MotionTraceLike,
} from "@/lib/motion-presentation";
import { canonicalTraceEvidenceEntries, displayOnlyTraceDelta, formatDisplayOnlyDelta, projectTraceSettlementEntries, traceSettlementKind, traceSettlementMainValue, traceSettlementTargets } from "@/lib/trace-settlement-presentation";
import { verifyCalculationTraceArchive, type CalculationTraceArchive, type CalculationTraceEntry } from "@/lib/calculation-trace";

interface TraceSettlementPanelProps {
  archive: CalculationTraceArchive;
  businessRevision: string;
  passiveAffixCount: number;
}

function formatTraceValue(value: unknown) {
  if (value === undefined || value === null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function traceSourceLabel(sourceRef: CalculationTraceEntry["sourceRef"]) {
  return "entityType" in sourceRef
    ? `${sourceRef.entityType}:${sourceRef.entityId}`
    : `${sourceRef.sourceType}:${sourceRef.sourceId}`;
}

function actionTargetLabel(targetRef: NonNullable<CalculationTraceEntry["actions"][number]["targetRef"]>) {
  return `${targetRef.entityType}:${targetRef.entityId} · revision ${targetRef.revisionId}`;
}

/**
 * ActionLink execution remains server-owned. This is only the existing product
 * deep-link shape, so following it can inspect the target but cannot run a command.
 */
function readOnlyActionTargetRoute(targetRef: NonNullable<CalculationTraceEntry["actions"][number]["targetRef"]>) {
  const params = new URLSearchParams({ page: "candidates" });
  if (targetRef.entityType === "collection") params.append("collectionIds", targetRef.entityId);
  else if (targetRef.entityType === "series") params.set("series", targetRef.entityId);
  else if (targetRef.entityType === "sku_drawer") params.set("sku", targetRef.entityId);
  else if (targetRef.entityType === "model") params.set("model", targetRef.entityId);
  else if (targetRef.entityType === "configuration_snapshot") params.set("snapshot", targetRef.entityId);
  else return undefined;
  return `/?${params.toString()}`;
}

function CanonicalTraceActionLink({ action }: { action: CalculationTraceEntry["actions"][number] }) {
  const targetRoute = action.targetRef ? readOnlyActionTargetRoute(action.targetRef) : undefined;
  return <span className="trace-action-link">
    <strong>{action.label}</strong>
    <span>动作：{action.action} · {action.enabled ? "可用" : "不可用"}</span>
    {action.targetRef ? <span>目标：<code>{actionTargetLabel(action.targetRef)}</code></span> : <span>目标：未提供</span>}
    {action.enabled && targetRoute ? <a href={targetRoute}>查看目标（只读）</a> : null}
    {action.enabled && action.targetRef && !targetRoute ? <span>该目标没有已注册的安全只读路由；已保留完整稳定引用。</span> : null}
  </span>;
}

function CanonicalTraceEvidence({ entries }: { entries: readonly CalculationTraceEntry[] }) {
  return <details className="trace-canonical-evidence" open>
    <summary>完整冻结 Trace 证据（{entries.length} 条，播放状态不筛选）</summary>
    <p>全局 sequence、来源和版本、原始操作及服务端 ActionLink 保持只读；动效只是一种范围投影。</p>
    <div className="trace-canonical-evidence-list">
      {entries.map((entry) => <article key={entry.traceEntryId}>
        <header><strong>#{entry.sequence} · {entry.parameterKey}</strong><span>{entry.layer} · {entry.effect}</span></header>
        <dl>
          <div><dt>来源 / 版本</dt><dd>{traceSourceLabel(entry.sourceRef)} · source {entry.sourceVersion} · rules {entry.ruleSetVersion}</dd></div>
          <div><dt>结算</dt><dd>before {formatTraceValue(entry.before)} · {entry.operation} · operand {formatTraceValue(entry.operand)} · after {formatTraceValue(entry.after)}{entry.unit ? ` ${entry.unit}` : ""}</dd></div>
          <div><dt>Issue</dt><dd>{entry.warningIssueIds.length ? entry.warningIssueIds.join("、") : "无"}</dd></div>
          <div><dt>动作入口</dt><dd>{entry.actions.length ? entry.actions.map((action) => <CanonicalTraceActionLink action={action} key={action.actionId} />) : "无"}</dd></div>
        </dl>
      </article>)}
    </div>
  </details>;
}

/** Consumes a frozen CalculationTraceArchive; it has no command or persistence path. */
export function TraceSettlementPanel({ archive, businessRevision, passiveAffixCount }: TraceSettlementPanelProps) {
  const targets = useMemo(() => traceSettlementTargets(archive.entries), [archive.entries]);
  const [targetKey, setTargetKey] = useState("");
  const selectedTarget = targets.find((target) => target.key === targetKey) ?? targets[0];
  const result = useMemo(() => {
    try {
      if (!verifyCalculationTraceArchive(archive)) throw new Error("冻结 Trace 的 replay 或 hash 证据不一致。");
      if (!selectedTarget) throw new Error("冻结 Trace 缺少可播放的对象和属性范围。");
      const projectedEntries = projectTraceSettlementEntries(archive.entries, selectedTarget);
      if (!projectedEntries.length) throw new Error("所选属性在冻结 Trace 中没有可播放步骤。");
      return { model: buildMotionPresentationModel({
        businessRevision,
        subjectId: selectedTarget.subjectRef.entityId,
        parameterKey: selectedTarget.parameterKey,
        trace: projectedEntries as readonly MotionTraceLike[],
      }) } as const;
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Trace 无法建立展示模型。" } as const;
    }
  }, [archive, businessRevision, selectedTarget]);
  if ("error" in result) return <div className="trace-settlement-blocked" role="alert"><AlertTriangle size={18} /><div><strong>Trace 校验不一致，已停止成功结算</strong><span>{result.error}</span><small>不会重排、补算或以成功状态收束。</small></div></div>;
  return <><label className="trace-target-selector">结算属性<select value={selectedTarget?.key ?? ""} onChange={(event) => setTargetKey(event.target.value)}>{targets.map((target) => <option key={target.key} value={target.key}>{target.label}</option>)}</select></label><TraceSettlementPlayback model={result.model} archive={archive} passiveAffixCount={passiveAffixCount} /></>;
}

function TraceSettlementPlayback({ model, archive, passiveAffixCount }: {
  model: ReturnType<typeof buildMotionPresentationModel>;
  archive: CalculationTraceArchive;
  passiveAffixCount: number;
}) {
  const controller = useMemo(() => createMotionPlaybackController(model, { reducedMotion: systemPrefersReducedMotion() }), [model]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const visibleCount = state.status === "completed" || state.status === "locking" ? model.steps.length : Math.max(0, state.stepIndex + 1);
  const activeStep = state.stepIndex >= 0 ? model.steps[Math.min(state.stepIndex, model.steps.length - 1)] : undefined;
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    const media = window.matchMedia(reducedMotionQuery);
    const listener = (event: { matches: boolean }) => controller.dispatch({ type: "reducedMotionChanged", reducedMotion: event.matches });
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [controller]);
  const visibleSteps = model.steps.slice(0, visibleCount);
  const recentSources = visibleSteps.slice(-2);
  const complete = state.status === "completed";
  const locking = state.status === "locking";
  const displayedValue = traceSettlementMainValue(model, state.status, state.stepIndex);
  const delta = activeStep ? displayOnlyTraceDelta(activeStep.before, activeStep.after, activeStep.operation) : undefined;
  return <section className={`trace-settlement ${complete ? "is-complete" : ""}`} aria-label="属性 Trace 高速结算">
    <header className="trace-settlement-head"><div><span className="eyebrow">FROZEN CALCULATION TRACE</span><h3>属性高速结算</h3><p>来源 → 飞卡 → delta → 主数字 → 解释与证据</p></div><span className="trace-chain-count">{complete ? "结算完成" : locking ? "结果锁定中" : `链路 ${visibleCount}/${model.steps.length}`}</span></header>
    <div className="trace-settlement-controls" aria-label="Trace 结算控制"><button type="button" onClick={() => controller.dispatch({ type: "play" })} disabled={state.status === "playing" || state.status === "paused" || locking}><Play size={14} />播放</button><button type="button" onClick={() => controller.dispatch({ type: "pause" })} disabled={state.status !== "playing"}><Pause size={14} />暂停</button>{state.status === "paused" ? <button type="button" onClick={() => controller.dispatch({ type: "resume" })}><Play size={14} />继续</button> : null}<button type="button" onClick={() => controller.dispatch({ type: "skip" })}><SkipForward size={14} />直接看结果</button><button type="button" onClick={() => controller.dispatch({ type: "replay" })} disabled={locking}><RotateCcw size={14} />重播</button></div>
    <div className="trace-settlement-stage">
      <div className="trace-source-lane" aria-label="当前来源卡">{recentSources.map((step) => { const kind = traceSettlementKind(step); return <article key={step.id} className={`trace-source-card ${kind.key}`}><span>#{step.sequence} · {kind.label}</span><strong>{step.sourceId}</strong><small>{step.layer === "technology_affix" ? "Technology 成员 Affix（不重复结算）" : step.layer}</small></article>; })}{!recentSources.length ? <span className="trace-source-empty">等待播放；Trace 不会被页面补写。</span> : null}</div>
      <div className="trace-main-number" aria-live="polite"><span>主数字</span><strong>{formatTraceValue(displayedValue)}{activeStep?.unit ? <small>{activeStep.unit}</small> : null}</strong><em>{formatDisplayOnlyDelta(delta, activeStep?.unit) ?? `${activeStep ? `${activeStep.operation} ${formatTraceValue(activeStep.operand)}` : "初始值（冻结 Trace）"}`}</em></div>
      <aside className="trace-evidence-panel"><span>解释 / 证据</span>{activeStep ? <><strong>{traceSettlementKind(activeStep).label}</strong><p>before {formatTraceValue(activeStep.before)} · {activeStep.operation} · operand {formatTraceValue(activeStep.operand)} · after {formatTraceValue(activeStep.after)}</p><small>sequence {activeStep.sequence} · source version {activeStep.sourceVersion}</small>{activeStep.warningIssueIds.length ? <b>检查：{activeStep.warningIssueIds.join("、")}</b> : <b>无附加 Issue</b>}</> : <p>完整 Trace 与冻结哈希会在播放时原样展示。</p>}</aside>
    </div>
    <div className="trace-settlement-evidence"><span>冻结 Trace hash</span><code>{archive.traceHash}</code><span>replay hash</span><code>{archive.replayHash}</code><small>仅在 before / after 都是有限数时显示临时 delta；它不写入领域结果、hash、重放或 Snapshot。非数值、set / clear / min / max / no_effect 均呈现原操作语义。</small></div>
    <CanonicalTraceEvidence entries={canonicalTraceEvidenceEntries(archive.entries)} />
    {passiveAffixCount ? <div className="trace-passive-note"><BadgeCheck size={15} />{passiveAffixCount} 个被动词条只保存、计分和展示；不改变主数字。</div> : null}
    {locking ? <div className="trace-final-lock"><BadgeCheck size={16} />最终结果锁定中 · 冻结证据保持只读</div> : null}{complete ? <div className="trace-final-lock"><BadgeCheck size={16} />最终结果已锁定 · 冻结证据保持只读</div> : null}
  </section>;
}
