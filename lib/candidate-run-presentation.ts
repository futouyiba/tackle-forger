/**
 * MOTION-04 candidate generation presentation model.
 *
 * Pure functions that derive a read-only stage breakdown from an authoritative
 * CandidateRun. Zero side effects, zero API calls.
 */

import type { CandidateRun, ModelCandidate } from "./types";

// ─── Stage model ────────────────────────────────────────────────────────────

export type CandidateStageId = "enumeration" | "hard_compatibility" | "affinity" | "materialization";

export interface CandidateStageResult {
  id: CandidateStageId;
  label: string;
  hint: string;
  inputCount: number;
  outputCount: number;
  isBlocking: boolean;
}

export interface CandidateExclusionGroup {
  code: string;
  count: number;
  description: string;
}

export interface CandidateRunPresentation {
  runId: string;
  status: CandidateRun["status"];
  enumerationTotal: number;
  legalCount: number;
  excludedByCode: CandidateExclusionGroup[];
  truncatedCount: number;
  candidates: ModelCandidate[];
  inputHash: string;
  outputHash: string;
  durationMs: number;
  /** Derived stage-by-stage breakdown. */
  stages: CandidateStageResult[];
  hasAutoMaterialized: boolean;
  materializationError?: string;
}

// ─── Label helpers ──────────────────────────────────────────────────────────

const EXCLUSION_LABELS: Record<string, string> = {
  HARD_COMPATIBILITY_DENIED: "硬兼容规则拒绝",
  AFFINITY_BELOW_THRESHOLD: "Affinity 低于阈值",
  SERIES_INVARIANT_VIOLATION: "Series 不变量冲突",
  PART_CHAIN_DISABLED: "部位链未启用",
  SKU_SUPERSEDED: "SKU 已取代",
  FUNCTION_INTENSITY_MISMATCH: "功能强度不匹配",
  QUALITY_OUT_OF_RANGE: "品质范围外",
  PERFORMANCE_UNAVAILABLE: "性能不可用",
  CONSTRAINT_CONFLICT: "约束冲突",
};

function exclusionLabel(code: string): string {
  return EXCLUSION_LABELS[code] ?? code.replace(/_/g, " ").toLowerCase();
}

// ─── Builder ────────────────────────────────────────────────────────────────

export function buildCandidateRunPresentation(
  run: CandidateRun,
  hasAutoMaterialized: boolean,
  materializationError?: string,
): CandidateRunPresentation {
  const hardDenyCount = run.excludedByCode["HARD_COMPATIBILITY_DENIED"] ?? 0;
  const affinityLowCount = (run.enumerationTotal - run.legalCount) - hardDenyCount - run.truncatedCount;

  const stages: CandidateStageResult[] = [
    {
      id: "enumeration",
      label: "枚举",
      hint: "SKU × Variant 笛卡尔积",
      inputCount: run.enumerationTotal,
      outputCount: run.enumerationTotal,
      isBlocking: run.enumerationTotal === 0,
    },
    {
      id: "hard_compatibility",
      label: "硬兼容",
      hint: "deny / require 规则",
      inputCount: run.enumerationTotal,
      outputCount: run.enumerationTotal - hardDenyCount,
      isBlocking: hardDenyCount === run.enumerationTotal && run.enumerationTotal > 0,
    },
    {
      id: "affinity",
      label: "Affinity 排序",
      hint: "软兼容评分 + 截断",
      inputCount: run.enumerationTotal - hardDenyCount,
      outputCount: run.legalCount,
      isBlocking: affinityLowCount > 0 && run.legalCount === 0,
    },
    {
      id: "materialization",
      label: "物化",
      hint: "自动创建/更新 Model",
      inputCount: run.legalCount,
      outputCount: hasAutoMaterialized ? Math.min(run.legalCount, 1) : 0,
      isBlocking: Boolean(materializationError),
    },
  ];

  const excludedByCode: CandidateExclusionGroup[] = Object.entries(run.excludedByCode)
    .filter(([, count]) => count > 0)
    .map(([code, count]) => ({
      code,
      count,
      description: exclusionLabel(code),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    runId: run.runId,
    status: run.status,
    enumerationTotal: run.enumerationTotal,
    legalCount: run.legalCount,
    excludedByCode,
    truncatedCount: run.truncatedCount,
    candidates: run.candidates,
    inputHash: run.inputHash,
    outputHash: run.outputHash,
    durationMs: run.durationMs,
    stages,
    hasAutoMaterialized,
    materializationError,
  };
}

export function candidateRunStatusLabel(status: CandidateRun["status"]): string {
  const labels: Record<CandidateRun["status"], string> = {
    completed: "完成",
    waiting_for_review: "待复核",
    superseded: "已取代",
    failed: "失败",
  };
  return labels[status];
}
