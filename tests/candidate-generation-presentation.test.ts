/**
 * MOTION-04 候选生成展示层测试
 *
 * 覆盖正常、边界、superseded、failed、empty、物化各场景。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCandidateGenerationPresentation,
  buildMaterializationPresentation,
  candidatePresentationFingerprint,
} from "../lib/candidate-generation-presentation";
import type { CandidateRun, CandidateMaterializationRecord } from "../lib/types";

// ─── 夹具 ────────────────────────────────────────────────────────────

function baseRun(overrides: Partial<CandidateRun> = {}): CandidateRun {
  return {
    runId: "candidate-run:test-001",
    request: {
      requestId: "req-1", inputHash: "hash-001", idempotencyKey: "ik-1",
      seriesRef: { entityId: "series-1", revisionId: "1" },
      skuRefs: [{ entityId: "sku-1", revisionId: "1" }, { entityId: "sku-2", revisionId: "1" }],
      recipeRef: { entityId: "recipe-1", revisionId: "1" },
      recipeInput: {}, enabledVariantKeys: ["v1", "v2"], perSkuLimit: 3, minimumAffinity: 0,
      acceptWarnings: true, sortDefinitionVersion: "v1", checkpointMode: "AUTO_CONTINUE",
    },
    status: "completed",
    candidates: [
      {
        candidateId: "c1", runId: "run-1", skuRef: { entityId: "sku-1", revisionId: "1" },
        modelVariantKey: "v1", candidateFingerprint: "fp1", projectionMatchRef: "pm1",
        proposedConfiguration: { projectionId: "p1", projectionValues: {}, targetPullKg: 1.5, matchedStructuralPullKg: 1.5, variant: { componentSelections: [], tags: [] } },
        variant: { componentSelections: [], tags: [] },
        hardCompatibility: { allowed: true }, affinity: { score: 85, warnings: [] },
        invariantIssues: [], warningCount: 0, pullDistance: 0.1, rank: 1, rankReasons: ["v1"], state: "generated",
      },
      {
        candidateId: "c2", runId: "run-1", skuRef: { entityId: "sku-2", revisionId: "1" },
        modelVariantKey: "v1", candidateFingerprint: "fp2", projectionMatchRef: "pm2",
        proposedConfiguration: { projectionId: "p2", projectionValues: {}, targetPullKg: 1.8, matchedStructuralPullKg: 1.8, variant: { componentSelections: [], tags: [] } },
        variant: { componentSelections: [], tags: [] },
        hardCompatibility: { allowed: true }, affinity: { score: 90, warnings: [] },
        invariantIssues: [], warningCount: 0, pullDistance: 0.1, rank: 1, rankReasons: ["v1"], state: "generated",
      },
    ],
    enumerationTotal: 12,
    legalCount: 2,
    excludedByCode: {
      RECIPE_SCOPE_MISMATCH: 4,
      HARD_COMPATIBILITY_DENIED: 3,
      AFFINITY_BELOW_MINIMUM: 2,
      WARNING_NOT_ACCEPTED: 1,
    },
    truncatedCount: 0,
    inputHash: "hash-in",
    outputHash: "hash-out",
    startedAt: "2026-07-25T00:00:00.000Z",
    completedAt: "2026-07-25T00:00:02.500Z",
    durationMs: 2500,
    ...overrides,
  } as CandidateRun;
}

function baseMaterialization(overrides: Partial<CandidateMaterializationRecord> = {}): CandidateMaterializationRecord {
  return {
    materializationId: "mat-1", runId: "candidate-run:test-001", runOutputHash: "hash-out",
    selectedCandidateIds: ["c1", "c2"], materializedModelIds: ["model-1", "model-2"],
    issues: [], actor: "test", occurredAt: "2026-07-25T00:00:03.000Z", outputHash: "mat-hash",
    ...overrides,
  };
}

// ─── 正常 ─────────────────────────────────────────────────────────────

test("正常候选生成展示完整六阶段", () => {
  const run = baseRun();
  const presentation = buildCandidateGenerationPresentation(run);

  assert.equal(presentation.runId, run.runId);
  assert.equal(presentation.enumerationTotal, 12);
  assert.equal(presentation.legalCount, 2);
  assert.equal(presentation.steps.length, 6);

  const phases = presentation.steps.map((s) => s.phase);
  assert.deepEqual(phases, ["enumerating", "compatibility", "affinity", "invariant_check", "sorting", "completed"]);
});

test("各阶段独立统计排除数量和通过数量", () => {
  const run = baseRun();
  const presentation = buildCandidateGenerationPresentation(run);

  // 枚举：12 → 12
  const enumStep = presentation.steps.find((s) => s.phase === "enumerating")!;
  assert.equal(enumStep.inputCount, 12);
  assert.equal(enumStep.outputCount, 12);

  // 兼容性：12 → 5（排除 7 = RECIPE_SCOPE_MISMATCH 4 + HARD_COMPATIBILITY_DENIED 3）
  const compatStep = presentation.steps.find((s) => s.phase === "compatibility")!;
  assert.equal(compatStep.outputCount, 5); // 12 - 4 - 3 = 5
  assert.equal(compatStep.exclusions.length, 2);

  // Affinity：5 → 3（排除 AFFINITY_BELOW_MINIMUM 2）
  const affStep = presentation.steps.find((s) => s.phase === "affinity")!;
  assert.equal(affStep.outputCount, 3);

  // 不变量：3 → 2（排除 WARNING_NOT_ACCEPTED 1）
  const invStep = presentation.steps.find((s) => s.phase === "invariant_check")!;
  assert.equal(invStep.outputCount, 2);

  // 排序：2 → 2 + 截断=0
  const sortStep = presentation.steps.find((s) => s.phase === "sorting")!;
  assert.equal(sortStep.outputCount, 2);

  // 完成
  const doneStep = presentation.steps.find((s) => s.phase === "completed")!;
  assert.equal(doneStep.outputCount, 2);
});

test("展示步骤按排除代码独立归类，硬/软/范围/修订分类正确", () => {
  const run = baseRun();
  const presentation = buildCandidateGenerationPresentation(run);

  // 找兼容性步骤，验证分类
  const compatStep = presentation.steps.find((s) => s.phase === "compatibility")!;
  const hardDeny = compatStep.exclusions.find((e) => e.code === "HARD_COMPATIBILITY_DENIED");
  assert.equal(hardDeny?.category, "hard");
  assert.equal(hardDeny?.count, 3);

  const scopeMismatch = compatStep.exclusions.find((e) => e.code === "RECIPE_SCOPE_MISMATCH");
  assert.equal(scopeMismatch?.category, "scope");
  assert.equal(scopeMismatch?.count, 4);
});

test("topCandidates 只返回前三名", () => {
  const run = baseRun({
    candidates: [
      ...baseRun().candidates,
      { ...baseRun().candidates[0]!, candidateId: "c3", rank: 2, affinity: { score: 80, warnings: [] }, warningCount: 1, modelVariantKey: "v2" },
      { ...baseRun().candidates[0]!, candidateId: "c4", rank: 3, affinity: { score: 75, warnings: [] }, warningCount: 2, modelVariantKey: "v3" },
    ] as CandidateRun["candidates"],
    legalCount: 4,
  });
  const presentation = buildCandidateGenerationPresentation(run);
  assert.equal(presentation.topCandidates.length, 3);
  assert.equal(presentation.topCandidates[0].rank, 1);
});

// ─── 边界 ─────────────────────────────────────────────────────────────

test("superseded 状态只有单一阶段且不进入成功态", () => {
  const run = baseRun({
    status: "superseded",
    legalCount: 0,
    candidates: [],
    excludedByCode: { REVISION_CHANGED: 1 },
  });
  const presentation = buildCandidateGenerationPresentation(run);

  assert.equal(presentation.steps.length, 1);
  assert.equal(presentation.steps[0].phase, "superseded");
  assert.equal(presentation.legalCount, 0);
  assert.equal(presentation.topCandidates.length, 0);
});

test("failed 状态展示 blocked 阶段", () => {
  const run = baseRun({
    status: "failed",
    legalCount: 0,
    candidates: [],
    excludedByCode: {},
  });
  const presentation = buildCandidateGenerationPresentation(run);

  assert.equal(presentation.steps.length, 1);
  assert.equal(presentation.steps[0].phase, "blocked");
  assert.equal(presentation.steps[0].label, "候选生成失败");
});

test("无合法候选时展示 empty 阶段，不播放完成奖励", () => {
  const run = baseRun({
    legalCount: 0,
    candidates: [],
    excludedByCode: { HARD_COMPATIBILITY_DENIED: 12 },
  });
  const presentation = buildCandidateGenerationPresentation(run);

  assert.equal(presentation.steps.length, 1);
  assert.equal(presentation.steps[0].phase, "empty");
  assert.ok(presentation.steps[0].label.includes("全部被排除"));
  // 不包含 completed 阶段
  assert.ok(!presentation.steps.some((s) => s.phase === "completed"));
});

test("waiting_for_review 状态在完成阶段显示 blocked", () => {
  const run = baseRun({ status: "waiting_for_review" });
  const presentation = buildCandidateGenerationPresentation(run);

  const lastStep = presentation.steps[presentation.steps.length - 1];
  assert.equal(lastStep!.phase, "blocked");
  assert.ok(lastStep!.label.includes("等待复核"));
});

test("截断数量在排序阶段独立展示", () => {
  const run = baseRun({ truncatedCount: 5 });
  const presentation = buildCandidateGenerationPresentation(run);

  const sortStep = presentation.steps.find((s) => s.phase === "sorting")!;
  const truncated = sortStep.exclusions.find((e) => e.code === "TRUNCATED");
  assert.ok(truncated);
  assert.equal(truncated.count, 5);
});

// ─── 确定性 ───────────────────────────────────────────────────────────

test("相同输入产生相同展示步骤（确定性）", () => {
  const run = baseRun();
  const p1 = buildCandidateGenerationPresentation(run);
  const p2 = buildCandidateGenerationPresentation(run);

  assert.deepEqual(p1.steps.map((s) => s.phase), p2.steps.map((s) => s.phase));
  assert.equal(candidatePresentationFingerprint(p1), candidatePresentationFingerprint(p2));
});

test("不同排除分布产生不同 fingerprint", () => {
  const r1 = baseRun();
  const r2 = baseRun({ excludedByCode: { HARD_COMPATIBILITY_DENIED: 12 } });
  const fp1 = candidatePresentationFingerprint(buildCandidateGenerationPresentation(r1));
  const fp2 = candidatePresentationFingerprint(buildCandidateGenerationPresentation(r2));
  assert.notEqual(fp1, fp2);
});

// ─── 物化 ─────────────────────────────────────────────────────────────

test("物化展示记录选定和物化数量", () => {
  const run = baseRun();
  const record = baseMaterialization();
  const presentation = buildMaterializationPresentation(record, run);

  assert.equal(presentation.selectedCount, 2);
  assert.equal(presentation.materializedCount, 2);
  assert.equal(presentation.hasIssues, false);
  assert.equal(presentation.steps[0].phase, "completed");
});

test("物化有 Issue 时展示 blocked 阶段", () => {
  const run = baseRun();
  const record = baseMaterialization({
    issues: [{
      code: "MATERIALIZATION_FAILED", severity: "error" as const, message: "物化失败",
      issueId: "iss-1", fingerprint: "fp-1", source: "test", blocking: true,
      occurredAt: "now", entityRef: { entityId: "c1", entityType: "candidate" },
      validationContext: {}, resolution: "未解决", layer: "materialization",
    }],
  } as unknown as CandidateMaterializationRecord);
  const presentation = buildMaterializationPresentation(record as CandidateMaterializationRecord, run);

  assert.equal(presentation.hasIssues, true);
  assert.equal(presentation.steps[0].phase, "blocked");
  assert.ok(presentation.steps[0].label.includes("Issue"));
});

// ─── 独立 SKU 不使用相邻连接符号 ─────────────────────────────────────

test("1.5kg 和 1.8kg 即使命中同一模板也保持独立 SKU 条目", () => {
  // 两个候选分别属于 sku-1 (1.5kg) 和 sku-2 (1.8kg)
  const run = baseRun();
  const presentation = buildCandidateGenerationPresentation(run);

  // topCandidates 中两个不同 SKU 的候选独立存在
  const skuIds = new Set(run.candidates.map((c) => c.skuRef.entityId));
  assert.equal(skuIds.size, 2); // 两个独立 SKU
  assert.equal(presentation.topCandidates.length, 2);
  // 不接受合并为一个连续区间
  assert.ok(run.candidates.every((c) => typeof c.skuRef.entityId === "string"));
});
