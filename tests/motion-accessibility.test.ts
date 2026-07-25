import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { motionFrozenEvidenceNotice, motionKeyboardCommand, motionLiveAnnouncement, motionStepState, resolveReducedMotion, visibleMotionEvidence } from "../lib/motion-accessibility";

test("系统或产品减少动态偏好都会失败闭合到减少动态路径", () => {
  assert.equal(resolveReducedMotion("system", true), true);
  assert.equal(resolveReducedMotion("system", false), false);
  assert.equal(resolveReducedMotion("reduce", false), true);
  assert.equal(resolveReducedMotion("reduce", true), true);
  assert.equal(resolveReducedMotion("full", true), true);
  assert.equal(resolveReducedMotion("full", false), false);
});

test("键盘约定覆盖播放、跳过、重播和 Trace/Issue 入口，输入时不劫持", () => {
  assert.equal(motionKeyboardCommand("p"), "playPause");
  assert.equal(motionKeyboardCommand(" "), "playPause");
  assert.equal(motionKeyboardCommand("s"), "skip");
  assert.equal(motionKeyboardCommand("r"), "replay");
  assert.equal(motionKeyboardCommand("t"), "trace");
  assert.equal(motionKeyboardCommand("i"), "issues");
  assert.equal(motionKeyboardCommand("p", { editableTarget: true }), undefined);
  assert.equal(motionKeyboardCommand(" ", { interactiveTarget: true }), undefined);
  assert.equal(motionKeyboardCommand("p", { interactiveTarget: true }), undefined);
  assert.equal(motionKeyboardCommand("p", { ctrlKey: true }), undefined);
  assert.equal(motionKeyboardCommand("p", { metaKey: true }), undefined);
  assert.equal(motionKeyboardCommand("p", { altKey: true }), undefined);
});

test("live region 只汇报阶段或最终结果，绝不携带逐项数值", () => {
  assert.equal(motionLiveAnnouncement(undefined, "completed"), "");
  assert.equal(motionLiveAnnouncement("idle", "playing"), "已开始播放 Trace。");
  assert.equal(motionLiveAnnouncement("playing", "completed"), "Trace 已完成；最终结果和完整证据已显示。");
  assert.equal(motionLiveAnnouncement("playing", "playing"), "");
});

test("取消或 revision 失效后仍保留完整冻结证据", () => {
  const evidence = ["trace-1", "trace-2", "trace-3"];
  assert.deepEqual(visibleMotionEvidence("playing", evidence, 0), ["trace-1"]);
  assert.deepEqual(visibleMotionEvidence("completed", evidence, 3), evidence);
  assert.deepEqual(visibleMotionEvidence("cancelled", evidence, 0), evidence);
  assert.deepEqual(visibleMotionEvidence("superseded", evidence, -1), evidence);
});

test("失效或取消的证据明确标明冻结来源，绝不冒充检测到的新 revision", () => {
  assert.equal(
    motionFrozenEvidenceNotice("superseded", "workspace-r18", "workspace-r19", "output-01"),
    "已阻断：检测到 revision workspace-r19。以下为来源 revision workspace-r18 的冻结 Trace 证据（output hash：output-01），不是新 revision 的结果。",
  );
  assert.match(motionFrozenEvidenceNotice("cancelled", "workspace-r18", "workspace-r18", "output-01") ?? "", /未继续结算或改写结果/);
  assert.equal(motionFrozenEvidenceNotice("completed", "workspace-r18", "workspace-r18", "output-01"), undefined);
});

test("步骤状态在灰阶下仍有文本与形状语义", () => {
  assert.deepEqual(motionStepState({ effect: "benefit", layer: "method", warningIssueIds: [] }), { label: "正向", tone: "benefit", modifiers: ["benefit"] });
  assert.deepEqual(motionStepState({ effect: "cost", layer: "model_patch", warningIssueIds: [] }), { label: "Patch · 代价", tone: "patch", modifiers: ["patch", "cost"] });
  assert.deepEqual(motionStepState({ effect: "neutral", layer: "boundary", warningIssueIds: ["issue-1"] }), { label: "检查 · 中性", tone: "check", modifiers: ["check", "neutral"] });
});

test("参考消费方保留稳定 Trace/Issue 焦点目标、节制 live region 与缩放重排", async () => {
  const root = new URL("../", import.meta.url);
  const [component, styles] = await Promise.all([
    readFile(fileURLToPath(new URL("app/MotionCoreDemo.tsx", root)), "utf8"),
    readFile(fileURLToPath(new URL("app/motion-core.css", root)), "utf8"),
  ]);
  assert.match(component, /aria-live="polite" aria-atomic="true"/);
  assert.match(component, /closest\("button, a\[href\], input, select, textarea, \[contenteditable='true'\]"\)/);
  assert.match(component, /标准动态（系统减少动态优先）/);
  assert.match(component, /data-reduced-motion=\{reducedMotion \|\| undefined\}/);
  assert.match(component, /id="motion-core-trace"[\s\S]*tabIndex=\{-1\}/);
  assert.match(component, /id="motion-core-issues"[\s\S]*tabIndex=\{-1\}/);
  assert.match(component, /直接显示最终结果和完整证据；可手动逐项查看/);
  assert.match(component, /motionFrozenEvidenceNotice\(state.status, model.businessRevision, state.revision, model.outputHash\)/);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /\.motion-core-card\[data-reduced-motion="true"\] \.motion-step \{ animation: none; \}/);
  assert.match(styles, /motion-step\.patch .motion-step-kind::before/);
  assert.match(styles, /motion-step\.check .motion-step-kind::before/);
});

// ─── MOTION-07 验收测试 ───────────────────────────────────────────────

test("全状态 evidence 保留：七种 MotionStatus 下 visibleMotionEvidence 行为正确", () => {
  const evidence = ["trace-1", "trace-2", "trace-3", "trace-4"];
  // 规范 §8.1: "跳过只结束演出，不减少 Trace、Issue、版本、来源或最终证据"
  // 规范 §8.2: reduced-motion 直接显示最终结果和完整证据

  // idle: 尚未开始，不显示 evidence
  assert.deepEqual(visibleMotionEvidence("idle", evidence, -1), []);
  assert.deepEqual(visibleMotionEvidence("idle", evidence, 0), ["trace-1"]);

  // playing: 只显示到当前步骤
  assert.deepEqual(visibleMotionEvidence("playing", evidence, 0), ["trace-1"]);
  assert.deepEqual(visibleMotionEvidence("playing", evidence, 1), ["trace-1", "trace-2"]);
  assert.deepEqual(visibleMotionEvidence("playing", evidence, 2), ["trace-1", "trace-2", "trace-3"]);

  // paused: 与 playing 相同，保留当前位置
  assert.deepEqual(visibleMotionEvidence("paused", evidence, 1), ["trace-1", "trace-2"]);

  // locking: 最后一步锁定中，显示全部
  assert.deepEqual(visibleMotionEvidence("locking", evidence, 4), evidence);

  // completed: 显示全部 evidence
  assert.deepEqual(visibleMotionEvidence("completed", evidence, 4), evidence);

  // cancelled: 保留全部冻结证据（§8.1 规范）
  assert.deepEqual(visibleMotionEvidence("cancelled", evidence, 0), evidence);

  // superseded: 保留全部冻结证据
  assert.deepEqual(visibleMotionEvidence("superseded", evidence, -1), evidence);
});

test("live region 覆盖全部六种状态转换且 idle/idle 不重复播报", () => {
  // 规范 §8.3: "屏幕阅读器不朗读每一帧数字变化；使用节制的 live region 汇报阶段或最终结果"
  const transitions: Array<{ from: string; to: string; expectContains: string }> = [
    { from: "idle", to: "playing", expectContains: "已开始播放 Trace。" },
    { from: "playing", to: "paused", expectContains: "Trace 已暂停。" },
    { from: "paused", to: "playing", expectContains: "已开始播放 Trace。" },
    { from: "playing", to: "completed", expectContains: "Trace 已完成" },
    { from: "playing", to: "cancelled", expectContains: "Trace 播放已停止" },
    { from: "playing", to: "superseded", expectContains: "Trace 播放已停止" },
  ];
  for (const { from, to, expectContains } of transitions) {
    const announcement = motionLiveAnnouncement(from as Parameters<typeof motionLiveAnnouncement>[0], to as Parameters<typeof motionLiveAnnouncement>[1]);
    assert.ok(announcement.includes(expectContains), `${from}→${to}: 播报包含 "${expectContains}"，实际: "${announcement}"`);
  }
  // undefined → completed 无前一状态，不播报
  assert.equal(motionLiveAnnouncement(undefined, "completed"), "");
  // 同状态不重复播报
  assert.equal(motionLiveAnnouncement("completed", "completed"), "");
  assert.equal(motionLiveAnnouncement("cancelled", "cancelled"), "");
});

test("frozenEvidenceNotice 仅对 cancelled 和 superseded 产生阻断提示", () => {
  // 规范 §5.4: Revision 变化 → SUPERSEDED + 原因
  // 规范 §8.1: 取消后保留冻结证据
  assert.equal(motionFrozenEvidenceNotice("idle", "r1", "r1", "hash-01"), undefined);
  assert.equal(motionFrozenEvidenceNotice("playing", "r1", "r1", "hash-01"), undefined);
  assert.equal(motionFrozenEvidenceNotice("paused", "r1", "r1", "hash-01"), undefined);
  assert.equal(motionFrozenEvidenceNotice("locking", "r1", "r1", "hash-01"), undefined);
  assert.equal(motionFrozenEvidenceNotice("completed", "r1", "r1", "hash-01"), undefined);

  const superseded = motionFrozenEvidenceNotice("superseded", "r18", "r19", "out-01");
  assert.ok(superseded?.includes("已阻断"), "superseded 包含已阻断");
  assert.ok(superseded?.includes("r18"), "superseded 标注来源 revision");
  assert.ok(superseded?.includes("r19"), "superseded 标注检测到的新 revision");
  assert.ok(superseded?.includes("out-01"), "superseded 包含 output hash");
  assert.ok(superseded?.includes("不是新 revision 的结果"), "superseded 明确不是新结果");

  const cancelled = motionFrozenEvidenceNotice("cancelled", "r18", "r18", "out-01");
  assert.ok(cancelled?.includes("播放已停止"), "cancelled 包含已停止");
  assert.ok(cancelled?.includes("冻结 Trace 证据"), "cancelled 保留冻结证据");
  assert.ok(cancelled?.includes("未继续结算或改写结果"), "cancelled 声明未改写");
});

test("resolveReducedMotion 的 OS 优先策略：full 不覆盖 OS reduce", () => {
  // 规范 §8.2: OS prefers-reduced-motion 或产品偏好均可触发减少动态
  // "full" 表示产品侧不请求减少，但 OS 优先级更高
  assert.equal(resolveReducedMotion("full", true), true, "OS reduce 时 full 也减少");
  assert.equal(resolveReducedMotion("full", false), false, "OS 不减少且产品 full 时不减少");
  assert.equal(resolveReducedMotion("system", true), true);
  assert.equal(resolveReducedMotion("reduce", false), true, "产品 reduce 覆盖 OS 不减少");
});
