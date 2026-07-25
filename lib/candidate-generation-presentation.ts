/**
 * MOTION-04 候选生成展示层
 *
 * 从 CandidateRun / CandidateMaterializationRecord 的现有字段构建
 * 阶段化的展示步骤。不补算领域规则、不推导权限、不把失败演成成功。
 *
 * 规范 §7.1 参考: 展示枚举总数、合法数、排除原因、截断、input hash、耗时；
 * 硬兼容/Affinity/Series 不变量独立视觉区块；高 Affinity 但硬 deny 明确进入排除；
 * 自动物化只对权威最高合法候选触发。
 */

import type { CandidateMaterializationRecord, CandidateRun } from "./types";

// ─── 阶段 ────────────────────────────────────────────────────────────

export type CandidateGenerationPhase =
  | "enumerating"
  | "compatibility"
  | "affinity"
  | "invariant_check"
  | "sorting"
  | "completed"
  | "superseded"
  | "blocked"
  | "empty";

export const EXCLUDED_LABELS: Record<string, { label: string; category: "hard" | "soft" | "scope" | "revision" }> = {
  RECIPE_SCOPE_MISMATCH: { label: "超出 Recipe 范围", category: "scope" },
  HARD_COMPATIBILITY_DENIED: { label: "硬兼容否决", category: "hard" },
  AFFINITY_BELOW_MINIMUM: { label: "Affinity 低于最低阈值", category: "soft" },
  WARNING_NOT_ACCEPTED: { label: "未接受 WARNING", category: "soft" },
  REVISION_CHANGED: { label: "Revision 已变化", category: "revision" },
};

export interface CandidateExclusionGroup {
  code: string;
  label: string;
  count: number;
  category: "hard" | "soft" | "scope" | "revision";
}

export interface CandidateGenerationPresentationStep {
  sequence: number;
  phase: CandidateGenerationPhase;
  label: string;
  inputCount: number;
  outputCount: number;
  exclusions: CandidateExclusionGroup[];
  evidence?: {
    inputHash?: string;
    outputHash?: string;
    durationMs?: number;
  };
}

export interface CandidateGenerationPresentation {
  runId: string;
  status: CandidateRun["status"];
  steps: readonly CandidateGenerationPresentationStep[];
  enumerationTotal: number;
  legalCount: number;
  truncatedCount: number;
  inputHash: string;
  outputHash: string;
  durationMs: number;
  topCandidates: readonly { candidateId: string; modelVariantKey: string; affinity: { score: number }; warningCount: number; rank: number }[];
}

// ─── 构建 ────────────────────────────────────────────────────────────

function groupExclusions(excludedByCode: Record<string, number>): CandidateExclusionGroup[] {
  return Object.entries(excludedByCode)
    .filter(([, count]) => count > 0)
    .map(([code, count]) => {
      const info = EXCLUDED_LABELS[code] ?? { label: code, category: "scope" as const };
      return { code, label: info.label, count, category: info.category };
    })
    .sort((a, b) => b.count - a.count);
}

/** 各阶段排除原因分类：只在对应阶段产生排除的代码 */
const PHASE_EXCLUSIONS: Record<string, string[]> = {
  compatibility: ["RECIPE_SCOPE_MISMATCH", "HARD_COMPATIBILITY_DENIED", "REVISION_CHANGED"],
  affinity: ["AFFINITY_BELOW_MINIMUM"],
  invariant_check: ["WARNING_NOT_ACCEPTED"],
};

function phaseExclusions(excludedByCode: Record<string, number>, phaseCodes: string[]): CandidateExclusionGroup[] {
  const filtered: Record<string, number> = {};
  for (const code of phaseCodes) {
    if (excludedByCode[code]) filtered[code] = excludedByCode[code];
  }
  return groupExclusions(filtered);
}

/**
 * 从已完成候选运行构建展示步骤。
 * 只消费 run 的现有字段，不重跑兼容/Affinity/不变量计算。
 */
export function buildCandidateGenerationPresentation(run: CandidateRun): CandidateGenerationPresentation {
  const allExclusions = groupExclusions(run.excludedByCode);
  const steps: CandidateGenerationPresentationStep[] = [];

  // 终态分支
  if (run.status === "superseded") {
    return {
      runId: run.runId, status: "superseded",
      steps: [{
        sequence: 1, phase: "superseded", label: "Revision 已变化 · 运行被取代",
        inputCount: run.enumerationTotal, outputCount: 0,
        exclusions: phaseExclusions(run.excludedByCode, ["REVISION_CHANGED"]),
        evidence: { inputHash: run.inputHash, outputHash: run.outputHash, durationMs: run.durationMs },
      }],
      enumerationTotal: run.enumerationTotal, legalCount: 0, truncatedCount: 0,
      inputHash: run.inputHash, outputHash: run.outputHash, durationMs: run.durationMs, topCandidates: [],
    };
  }

  if (run.status === "failed") {
    return {
      runId: run.runId, status: "failed",
      steps: [{
        sequence: 1, phase: "blocked", label: "候选生成失败",
        inputCount: 0, outputCount: 0, exclusions: [],
        evidence: { inputHash: run.inputHash, outputHash: run.outputHash, durationMs: run.durationMs },
      }],
      enumerationTotal: run.enumerationTotal, legalCount: 0, truncatedCount: 0,
      inputHash: run.inputHash, outputHash: run.outputHash, durationMs: run.durationMs, topCandidates: [],
    };
  }

  // 无合法候选（status 已过滤 superseded/failed，此处只有 completed/waiting_for_review）
  if (run.legalCount === 0) {
    return {
      runId: run.runId, status: run.status,
      steps: [{
        sequence: 1, phase: "empty", label: "无合法候选 · 全部被排除",
        inputCount: run.enumerationTotal, outputCount: 0, exclusions: allExclusions,
        evidence: { inputHash: run.inputHash, outputHash: run.outputHash, durationMs: run.durationMs },
      }],
      enumerationTotal: run.enumerationTotal, legalCount: 0, truncatedCount: run.truncatedCount,
      inputHash: run.inputHash, outputHash: run.outputHash, durationMs: run.durationMs, topCandidates: [],
    };
  }

  // 正常流程：按阶段展示
  let seq = 0;
  let runningCount = run.enumerationTotal;

  // 1. 枚举
  seq += 1;
  steps.push({
    sequence: seq, phase: "enumerating", label: "枚举候选组合",
    inputCount: runningCount, outputCount: runningCount, exclusions: [],
  });

  // 2. 兼容性检查
  seq += 1;
  const compatExclusions = phaseExclusions(run.excludedByCode, PHASE_EXCLUSIONS.compatibility);
  const compatDropped = compatExclusions.reduce((sum, e) => sum + e.count, 0);
  runningCount -= compatDropped;
  steps.push({
    sequence: seq, phase: "compatibility", label: "硬兼容性校验",
    inputCount: runningCount + compatDropped, outputCount: runningCount, exclusions: compatExclusions,
  });

  // 3. Affinity 评分
  seq += 1;
  const affinityExclusions = phaseExclusions(run.excludedByCode, PHASE_EXCLUSIONS.affinity);
  const affinityDropped = affinityExclusions.reduce((sum, e) => sum + e.count, 0);
  runningCount -= affinityDropped;
  steps.push({
    sequence: seq, phase: "affinity", label: "Affinity 评分",
    inputCount: runningCount + affinityDropped, outputCount: runningCount, exclusions: affinityExclusions,
  });

  // 4. 不变量检查
  seq += 1;
  const invariantExclusions = phaseExclusions(run.excludedByCode, PHASE_EXCLUSIONS.invariant_check);
  const invariantDropped = invariantExclusions.reduce((sum, e) => sum + e.count, 0);
  runningCount -= invariantDropped;
  steps.push({
    sequence: seq, phase: "invariant_check", label: "Series 不变量校验",
    inputCount: runningCount + invariantDropped, outputCount: runningCount, exclusions: invariantExclusions,
  });

  // 5. 排序
  seq += 1;
  const truncatedExclusion = run.truncatedCount > 0
    ? [{ code: "TRUNCATED", label: `超出每 SKU ${run.request?.perSkuLimit ?? "?"} 个上限被截断`, count: run.truncatedCount, category: "scope" as const }]
    : [];
  steps.push({
    sequence: seq, phase: "sorting", label: "排序与截断",
    inputCount: runningCount, outputCount: run.candidates.length, exclusions: truncatedExclusion,
  });

  // 6. 完成
  seq += 1;
  const topCandidates = run.candidates.slice(0, 3).map((c) => ({
    candidateId: c.candidateId, modelVariantKey: c.modelVariantKey,
    affinity: { score: c.affinity.score }, warningCount: c.warningCount, rank: c.rank,
  }));
  steps.push({
    sequence: seq, phase: run.status === "waiting_for_review" ? "blocked" : "completed",
    label: run.status === "waiting_for_review" ? "等待复核" : "候选生成完成",
    inputCount: run.candidates.length, outputCount: run.candidates.length, exclusions: [],
    evidence: { inputHash: run.inputHash, outputHash: run.outputHash, durationMs: run.durationMs },
  });

  return {
    runId: run.runId, status: run.status,
    steps: Object.freeze(steps),
    enumerationTotal: run.enumerationTotal, legalCount: run.legalCount, truncatedCount: run.truncatedCount,
    inputHash: run.inputHash, outputHash: run.outputHash, durationMs: run.durationMs,
    topCandidates: Object.freeze(topCandidates),
  };
}

// ─── 物化展示 ────────────────────────────────────────────────────────

export interface MaterializationPresentation {
  materializationId: string;
  steps: readonly CandidateGenerationPresentationStep[];
  selectedCount: number;
  materializedCount: number;
  hasIssues: boolean;
}

/**
 * 从物化记录构建展示。只展示最高合法候选的物化结果。
 */
export function buildMaterializationPresentation(
  record: CandidateMaterializationRecord,
  _run: CandidateRun,
): MaterializationPresentation {
  const phase: CandidateGenerationPhase = record.issues.length > 0 ? "blocked" : "completed";
  const label = record.issues.length > 0
    ? `物化完成 · ${record.issues.length} 个 Issue`
    : `物化完成 · ${record.materializedModelIds.length} 个 Model`;

  return {
    materializationId: record.materializationId,
    steps: [{
      sequence: 1, phase, label,
      inputCount: record.selectedCandidateIds.length,
      outputCount: record.materializedModelIds.length,
      exclusions: record.issues.length > 0
        ? [{ code: "MATERIALIZATION_ISSUES", label: "物化异常", count: record.issues.length, category: "hard" as const }]
        : [],
      evidence: {
        inputHash: record.runOutputHash,
        outputHash: record.outputHash,
      },
    }],
    selectedCount: record.selectedCandidateIds.length,
    materializedCount: record.materializedModelIds.length,
    hasIssues: record.issues.length > 0,
  };
}

// ─── 确定性验证 ──────────────────────────────────────────────────────

import { deterministicHash } from "./rule-kernel";

/** 展示步骤的确定性标识，用于跨环境比较 */
export function candidatePresentationFingerprint(presentation: CandidateGenerationPresentation): string {
  return deterministicHash({
    runId: presentation.runId,
    status: presentation.status,
    stepPhases: presentation.steps.map((s) => s.phase),
    enumerationTotal: presentation.enumerationTotal,
    legalCount: presentation.legalCount,
    truncatedCount: presentation.truncatedCount,
    exclusionCodes: presentation.steps.flatMap((s) => s.exclusions.map((e) => `${e.code}:${e.count}`)),
  });
}
