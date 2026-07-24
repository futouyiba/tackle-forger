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
