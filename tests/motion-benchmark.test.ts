/**
 * MOTION-07 性能基准测试
 *
 * 使用 FakeClock 模拟多种 Trace 规模的动效调度，验证所有场景
 * 都在规范 §6.3 的 2.5 秒硬上限内，并输出结构化性能报告。
 *
 * 这些测试不测量真实墙钟时间；它们验证的是：只要调度本身
 * 不引入额外延迟（FakeClock 零延迟触发），则结算预算必然
 * 让全部场景的总计时长落在硬上限内。真实设备性能记录属于
 * 人工验收范围（见 docs/qa/motion-07-visual-regression-report-v1.md）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMotionPresentationModel,
  computeMotionTimingBudget,
  createMotionPlaybackController,
  MOTION_PRESENTATION_HARD_TOTAL_MS,
  motionTokens,
  playbackStepTotalMs,
  playbackTimingProfile,
  type MotionTraceLike,
  type MotionClock,
} from "../lib/motion-presentation";

// ─── 工具 ────────────────────────────────────────────────────────────

class FakeClock implements MotionClock {
  callbacks = new Map<number, () => void>();
  nextHandle = 1;
  cleared: number[] = [];
  delays: number[] = [];
  set(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    this.delays.push(delayMs);
    return handle;
  }
  clear(handle: unknown): void {
    this.cleared.push(handle as number);
    this.callbacks.delete(handle as number);
  }
  fire(handle: number): void {
    this.callbacks.get(handle)?.();
  }
}

function makeTraceEntries(
  specs: ReadonlyArray<{ layer: string; effect?: MotionTraceLike["effect"]; evidence?: Record<string, unknown> }>,
): MotionTraceLike[] {
  return specs.map(
    (spec, index): MotionTraceLike => ({
      traceEntryId: `entry-${index + 1}`,
      sequence: index + 1,
      layer: spec.layer,
      sourceRef: { sourceType: "Rule", sourceId: `rule-${index + 1}` },
      sourceVersion: "1",
      before: index,
      operation: "add",
      operand: 1,
      after: index + 1,
      effect: spec.effect ?? "benefit",
      warningIssueIds: [],
      inputHash: `in-${index}`,
      outputHash: `out-${index}`,
      ...(spec.evidence ? { evidence: spec.evidence } : {}),
    }),
  );
}

interface BenchmarkRow {
  sourceCount: number;
  feasible: boolean;
  handoffScale: number;
  focusScale: number;
  representativeScale: number | undefined;
  serialTotalMs: number;
  actualTotalMs: number;
  finalLockMs: number;
  evidenceRetained: number;
  underCap: boolean;
}

const BENCHMARK_SOURCE_COUNTS = [4, 6, 8, 10, 12, 16, 24, 32];

// ─── 基准 ────────────────────────────────────────────────────────────

test("性能基准：所有规模在 FakeClock 零延迟调度下均满足 2.5s 硬上限", () => {
  const rows: BenchmarkRow[] = [];

  for (const sourceCount of BENCHMARK_SOURCE_COUNTS) {
    const specs = Array.from({ length: sourceCount }, (_, index) => ({
      layer: index === 0 ? "weight_template" : "method",
      effect: (index % 3 === 0 ? "cost" : "benefit") as MotionTraceLike["effect"],
    }));
    const trace = makeTraceEntries(specs);
    const model = buildMotionPresentationModel({
      businessRevision: `bench-${sourceCount}`,
      subjectId: "model",
      parameterKey: "pull",
      trace,
    });
    const budget = computeMotionTimingBudget(model.steps);

    // 序列化预算总和（用于对照）
    let serialTotalMs = 0;
    for (const [index, step] of model.steps.entries()) {
      serialTotalMs += playbackStepTotalMs(playbackTimingProfile(step, index));
    }

    // FakeClock 零延迟推进
    const clock = new FakeClock();
    const controller = createMotionPlaybackController(model, { clock });
    controller.dispatch({ type: "play" });
    for (let handle = 1; handle <= sourceCount * 5; handle += 1) clock.fire(handle);
    assert.equal(controller.getState().status, "locking");
    clock.fire(sourceCount * 5 + 1);
    assert.equal(controller.getState().status, "completed");

    const actualTotalMs = clock.delays.reduce((sum, d) => sum + d, 0);
    const underCap = actualTotalMs <= MOTION_PRESENTATION_HARD_TOTAL_MS;

    rows.push({
      sourceCount,
      feasible: budget.feasible,
      handoffScale: budget.handoffScale,
      focusScale: budget.focusScale,
      representativeScale: budget.representativeScale,
      serialTotalMs,
      actualTotalMs,
      finalLockMs: clock.delays.at(-1) ?? 0,
      evidenceRetained: model.evidence.traceEntryIds.length,
      underCap,
    });

    // 硬断言
    assert.ok(underCap, `${sourceCount} 来源: ${actualTotalMs}ms ≤ ${MOTION_PRESENTATION_HARD_TOTAL_MS}ms`);
    assert.equal(model.evidence.traceEntryIds.length, sourceCount, `${sourceCount} 来源: 完整证据保留`);
  }

  // 输出结构化报告（供 QA 文档引用）
  const report = [
    "# MOTION-07 性能基准报告",
    "",
    `| 来源数 | 可行 | handoffScale | focusScale | repScale | 序列化总计 | 实际总计 | finalLock | 证据保留 | 在预算内 |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...rows.map(
      (r) =>
        `| ${r.sourceCount} | ${r.feasible ? "✅" : "⚠️"} | ${r.handoffScale.toFixed(3)} | ${r.focusScale.toFixed(3)} | ${r.representativeScale?.toFixed(4) ?? "-"} | ${r.serialTotalMs}ms | ${r.actualTotalMs}ms | ${r.finalLockMs}ms | ${r.evidenceRetained} | ${r.underCap ? "✅" : "❌"} |`,
    ),
    "",
    `硬上限: ${MOTION_PRESENTATION_HARD_TOTAL_MS}ms`,
    `finalLock 独立窗口: ${motionTokens.duration.finalLockMs}ms`,
    "",
    "⚠️ feasible=false: 来源过多时进入规范 §6.3 代表性高速播放路径，所有 phase 统一缩放，",
    "完整 Trace 证据仍然保留。",
  ].join("\n");

  // 输出到 stdout 供手动记录
  console.log(report);
});

test("代表性高速播放路径（≥13 来源）预算缩放因子在合法范围内", () => {
  for (const sourceCount of [13, 16, 20, 32]) {
    const specs = Array.from({ length: sourceCount }, (_, index) => ({
      layer: index === 0 ? "weight_template" : "method",
      effect: (index % 3 === 0 ? "cost" : "benefit") as MotionTraceLike["effect"],
    }));
    const model = buildMotionPresentationModel({
      businessRevision: `rep-${sourceCount}`,
      subjectId: "model",
      parameterKey: "pull",
      trace: makeTraceEntries(specs),
    });
    const budget = computeMotionTimingBudget(model.steps);
    assert.equal(budget.feasible, false, `${sourceCount} 来源: 超过可行边界`);
    assert.ok(
      typeof budget.representativeScale === "number" && budget.representativeScale > 0 && budget.representativeScale < 1,
      `${sourceCount} 来源: representativeScale=${budget.representativeScale} 在 (0,1) 内`,
    );

    // 推进并确认完成
    const clock = new FakeClock();
    const controller = createMotionPlaybackController(model, { clock });
    controller.dispatch({ type: "play" });
    for (let handle = 1; handle <= sourceCount * 5; handle += 1) clock.fire(handle);
    clock.fire(sourceCount * 5 + 1);
    assert.equal(controller.getState().status, "completed");
    assert.equal(model.evidence.traceEntryIds.length, sourceCount);
  }
});

test("混合场景（Patch、boundary、cost、benefit）性能预算正确", () => {
  const mixedSpecs: Array<{ layer: string; effect?: MotionTraceLike["effect"]; evidence?: Record<string, unknown> }> = [
    { layer: "weight_template" },
    { layer: "method", effect: "benefit" },
    { layer: "model_patch", effect: "cost" },
    { layer: "method", effect: "cost" },
    { layer: "boundary", effect: "neutral", evidence: { adapter: "pricing_trace/v2", operation: "round" } },
    { layer: "method", effect: "benefit" },
    { layer: "method", effect: "cost" },
    { layer: "method", effect: "benefit" },
    { layer: "method", effect: "cost" },
    { layer: "method", effect: "benefit" },
  ];
  const model = buildMotionPresentationModel({
    businessRevision: "mixed",
    subjectId: "model",
    parameterKey: "pull",
    trace: makeTraceEntries(mixedSpecs),
  });

  const clock = new FakeClock();
  const controller = createMotionPlaybackController(model, { clock });
  controller.dispatch({ type: "play" });
  for (let handle = 1; handle <= 10 * 5; handle += 1) clock.fire(handle);
  clock.fire(10 * 5 + 1);
  assert.equal(controller.getState().status, "completed");

  const total = clock.delays.reduce((sum, d) => sum + d, 0);
  assert.ok(total <= MOTION_PRESENTATION_HARD_TOTAL_MS, `混合场景 ${total}ms ≤ ${MOTION_PRESENTATION_HARD_TOTAL_MS}ms`);
  assert.equal(model.evidence.traceEntryIds.length, 10);

  // 验证 timing profile 分类正确
  assert.equal(playbackTimingProfile(model.steps[0], 0), "establish");
  assert.equal(playbackTimingProfile(model.steps[2], 2), "patch");
  assert.equal(playbackTimingProfile(model.steps[4], 4), "boundary");
});
