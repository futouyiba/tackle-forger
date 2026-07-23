"use client";

import {
  AlertTriangle,
  Bot,
  LockKeyhole,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { ActionAvailabilityMap } from "@/lib/interaction-contracts";
import type { SeriesDefinition } from "@/lib/types";

export interface AIAssessmentUiState {
  scopeKey: string;
  status: "running" | "success" | "error";
  error?: string;
  assessmentId?: string;
  inputHash?: string;
  outputHash?: string;
  freshness?: {
    state: "fresh" | "stale";
    canCreateDraft: boolean;
    staleReasonCodes: string[];
  };
  result?: {
    findings: Array<{ findingCode: string; summary: string; evidenceAliases: string[] }>;
    recommendations: Array<{
      recommendationCode: string;
      title: string;
      summary: string;
      suggestedAction: "preview_only" | "create_model_patch_draft" | "create_rule_source_change_draft";
      evidenceAliases: string[];
      suggestedChanges?: Array<{
        changeId: string;
        parameterKey: string;
        operation: "set" | "add" | "multiply" | "clear";
        operand: unknown;
        expectedBefore: unknown;
      }>;
    }>;
    assumptions: string[];
    uncoveredInformation: string[];
    resolvedEvidenceRefs?: Array<{
      evidenceType: string;
      evidenceAlias: string;
      refId: string;
      revisionId?: string;
      contentHash: string;
    }>;
    feedback?: {
      recommendations?: Array<{
        recommendationId: string;
        state: "dismissed";
      }>;
    };
  };
}

export function clearMatchingAssessment(
  currentAssessment: AIAssessmentUiState | undefined,
  scopeKey: string,
  assessmentId: string,
): AIAssessmentUiState | undefined {
  return currentAssessment?.scopeKey === scopeKey
    && currentAssessment.assessmentId === assessmentId
    ? undefined
    : currentAssessment;
}

export function SeriesAssessmentPanel({
  series,
  aiAvailability,
  aiAssessment,
  onRunAssessment,
  onAssessmentDeleted,
  notify,
}: {
  series: SeriesDefinition;
  aiAvailability: ActionAvailabilityMap["run_ai_assessment"];
  aiAssessment?: AIAssessmentUiState;
  onRunAssessment: () => void;
  onAssessmentDeleted: (assessmentId: string) => void;
  notify: (message: string) => void;
}) {
  const [selectedRecommendationCode, setSelectedRecommendationCode] = useState("");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [deletePermanentlyRetainedAcknowledged, setDeletePermanentlyRetainedAcknowledged] = useState(false);
  const [deleteRunning, setDeleteRunning] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const recommendations = aiAssessment?.result?.recommendations ?? [];
  const selectedRecommendation = recommendations.find((entry) =>
    entry.recommendationCode === selectedRecommendationCode);

  const deleteAssessment = async () => {
    if (!aiAssessment?.assessmentId
      || !deletePermanentlyRetainedAcknowledged
      || deleteRunning) return;
    const assessmentId = aiAssessment.assessmentId;
    setDeleteRunning(true);
    setDeleteError("");
    try {
      const response = await fetch(
        `/api/ai/assessments/${encodeURIComponent(assessmentId)}`,
        { method: "DELETE" },
      );
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "无法删除这次 Series AI 评估。");
      onAssessmentDeleted(assessmentId);
      notify("这次 Series AI 评估已从工作台移除；已采纳产物的来源记录仍会永久保留。");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "无法删除这次 Series AI 评估。";
      setDeleteError(message);
      notify(message);
    } finally {
      setDeleteRunning(false);
    }
  };

  return (
    <section className="gantt-series-ai-panel" aria-label={`${series.name} 的 AI 评估结果`}>
      <header>
        <div>
          <span className="eyebrow">SERIES AI ASSESSMENT</span>
          <h4>AI 评估与建议</h4>
          <small>{series.id} · revision {series.revision}</small>
        </div>
        <div className="gantt-ai-guardrail"><ShieldCheck size={16} /><strong>辅助建议 · 不影响系统校验</strong></div>
      </header>
      <div className="gantt-series-ai-readonly">
        <LockKeyhole size={17} />
        <div>
          <strong>Series 评估结果只读</strong>
          <span>Series 作用域不支持转换为 Model Patch 草稿；如需创建草稿，请进入具体 Model 后重新评估。</span>
        </div>
      </div>
      {aiAssessment?.status === "running" ? (
        <div className="gantt-unavailable"><Bot size={18} /><div><strong>正在评估 Series</strong><span>结果会绑定当前 Series revision，并在返回后保留可追溯依据。</span></div></div>
      ) : null}
      {aiAssessment?.status === "error" ? (
        <div className="gantt-unavailable"><AlertTriangle size={18} /><div><strong>评估未完成</strong><span>{aiAssessment.error}</span></div></div>
      ) : null}
      {aiAssessment?.status === "success" && aiAssessment.freshness?.state === "stale" ? (
        <div className="gantt-unavailable"><AlertTriangle size={18} /><div><strong>历史评估已过期</strong><span>当前 Series 输入已经变化；旧结果仍可查看，重新评估后才会绑定当前 revision。</span></div></div>
      ) : null}
      {aiAssessment?.status === "success" && aiAssessment.result ? (
        <>
          <div className="gantt-ai-result">
            <strong>{aiAssessment.result.findings.length} 条发现 · {aiAssessment.result.recommendations.length} 条建议</strong>
            {aiAssessment.result.findings.map((finding) => (
              <p key={finding.findingCode}>
                <b>{finding.findingCode}</b> · {finding.summary}
                {finding.evidenceAliases.length > 0 ? <small> · 依据 {finding.evidenceAliases.join("、")}</small> : null}
              </p>
            ))}
            <div className="gantt-ai-recommendations" role="listbox" aria-label="Series AI 建议">
              {recommendations.map((recommendation) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={recommendation.recommendationCode === selectedRecommendationCode}
                  className={recommendation.recommendationCode === selectedRecommendationCode ? "selected" : ""}
                  key={recommendation.recommendationCode}
                  onClick={() => {
                    setSelectedRecommendationCode(recommendation.recommendationCode);
                    setEvidenceOpen(false);
                  }}
                >
                  <b>{recommendation.title}</b>
                  <span>{recommendation.summary}</span>
                  <small>Series 只读建议{recommendation.evidenceAliases.length > 0 ? ` · ${recommendation.evidenceAliases.length} 项依据` : ""}</small>
                </button>
              ))}
              {!recommendations.length ? <small>本次评估没有建议。</small> : null}
            </div>
            <div className="gantt-series-ai-evidence-index">
              <strong>评估 EvidenceRef</strong>
              {aiAssessment.result.resolvedEvidenceRefs?.length ? (
                <ul>
                  {aiAssessment.result.resolvedEvidenceRefs.map((evidence) => (
                    <li key={`${evidence.evidenceAlias}:${evidence.refId}`}>
                      <b>{evidence.evidenceType}</b>
                      {" · "}{evidence.refId}
                      {evidence.revisionId ? ` @ ${evidence.revisionId}` : ""}
                      <small> · hash {evidence.contentHash}</small>
                    </li>
                  ))}
                </ul>
              ) : <p>本次评估没有可恢复的本地 EvidenceRef。</p>}
            </div>
            <small>output {aiAssessment.outputHash?.slice(0, 12)}</small>
          </div>
          {evidenceOpen && selectedRecommendation ? (
            <section className="gantt-ai-evidence">
              <header><span className="eyebrow">EVIDENCE & UNCERTAINTY</span><h4>依据、假设与未覆盖信息</h4></header>
              <div>
                <strong>可追溯依据</strong>
                {selectedRecommendation.evidenceAliases.length ? (
                  <ul>
                    {selectedRecommendation.evidenceAliases.map((alias) => {
                      const evidence = aiAssessment.result?.resolvedEvidenceRefs?.find((entry) =>
                        entry.evidenceAlias === alias);
                      return (
                        <li key={alias}>
                          {evidence ? (
                            <>
                              <b>{evidence.evidenceType}</b>
                              {" · "}{evidence.refId}
                              {evidence.revisionId ? ` @ ${evidence.revisionId}` : ""}
                              <small> · hash {evidence.contentHash}</small>
                            </>
                          ) : <><b>{alias}</b> · 本地稳定引用不可用</>}
                        </li>
                      );
                    })}
                  </ul>
                ) : <p>没有依据引用；该建议只作只读参考。</p>}
              </div>
              <div>
                <strong>假设</strong>
                {aiAssessment.result.assumptions.length
                  ? <ul>{aiAssessment.result.assumptions.map((assumption, index) => <li key={`${index}:${assumption}`}>{assumption}</li>)}</ul>
                  : <p>没有声明额外假设。</p>}
              </div>
              <div>
                <strong>未覆盖信息</strong>
                {aiAssessment.result.uncoveredInformation.length
                  ? <ul>{aiAssessment.result.uncoveredInformation.map((entry, index) => <li key={`${index}:${entry}`}>{entry}</li>)}</ul>
                  : <p>没有声明未覆盖信息。</p>}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
      {deleteConfirmationOpen && aiAssessment?.assessmentId ? (
        <section className="gantt-ai-delete-confirmation" aria-label="删除这次 Series AI 评估">
          <header>
            <div>
              <span className="eyebrow">DELETE ASSESSMENT</span>
              <h4>删除这次 Series AI 评估？</h4>
            </div>
            <Trash2 size={18} aria-hidden="true" />
          </header>
          <p>删除后，这次评估会立即从工作台隐藏，并进入主存储和备份的清理流程。</p>
          <strong>已采纳产物的来源记录会永久保留，不会随这次评估删除。</strong>
          <label>
            <input
              type="checkbox"
              checked={deletePermanentlyRetainedAcknowledged}
              disabled={deleteRunning}
              onChange={(event) => setDeletePermanentlyRetainedAcknowledged(event.target.checked)}
            />
            <span>我已了解：已采纳的 Patch 或规则草稿仍会保留这次评估的来源记录。</span>
          </label>
          {deleteError ? <small role="alert">{deleteError}</small> : null}
          <footer>
            <button
              type="button"
              disabled={deleteRunning}
              onClick={() => {
                setDeleteConfirmationOpen(false);
                setDeletePermanentlyRetainedAcknowledged(false);
                setDeleteError("");
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="danger"
              disabled={!deletePermanentlyRetainedAcknowledged || deleteRunning}
              onClick={() => void deleteAssessment()}
            >
              {deleteRunning ? "删除中…" : "确认删除评估"}
            </button>
          </footer>
        </section>
      ) : null}
      <div className="gantt-ai-actions">
        <button
          type="button"
          disabled={!selectedRecommendation}
          title={!selectedRecommendation ? "请先选择一条建议。" : undefined}
          onClick={() => setEvidenceOpen((current) => !current)}
        >
          {evidenceOpen ? "收起依据" : "查看依据"}
        </button>
        <button
          type="button"
          disabled={!aiAvailability.enabled || aiAssessment?.status === "running"}
          title={aiAvailability.disabledReasonText}
          onClick={onRunAssessment}
        >
          {aiAssessment?.status === "running" ? "评估中…" : "重新评估"}
        </button>
        <button
          type="button"
          className="danger"
          disabled={!aiAssessment?.assessmentId || deleteRunning}
          onClick={() => {
            setDeleteConfirmationOpen(true);
            setDeletePermanentlyRetainedAcknowledged(false);
            setDeleteError("");
          }}
        >
          删除这次 Series AI 评估
        </button>
      </div>
    </section>
  );
}
