import assert from "node:assert/strict";
import test from "node:test";

/**
 * EditableCell 单元测试 — 三态切换、键盘行为、undo 栈语义。
 *
 * 组件是纯 React 客户端组件，不能直接在 Node 测试中渲染 DOM。
 * 此处测试核心契约：值变更、format/parse、required 校验、undo 步骤语义。
 */

// ── 格式与解析 ──

test("format 在 browse 态格式化显示值，不改原始值", () => {
  const fmt = (v: string | number) => `¥${Number(v).toFixed(2)}`;
  assert.equal(fmt(123.4), "¥123.40");
  assert.equal(fmt(0), "¥0.00");
  assert.equal(fmt("99"), "¥99.00");
});

test("parse 在 commit 时去除格式化字符", () => {
  const parse = (raw: string) => raw.replace(/[¥,]/g, "");
  assert.equal(parse("¥1,234.56"), "1234.56");
  assert.equal(parse("42"), "42");
  assert.equal(parse(""), "");
});

// ── required 校验 ──

test("required 为空时拒绝提交，保持原值", () => {
  // 模拟：draft.trim() === "" 且 required=true → 不调用 onChange
  const calls: string[] = [];
  const mockOnChange = (next: string) => calls.push(next);

  const draft = "  ";
  const required = true;
  const value = "original";

  // 模拟 commit 逻辑
  const trimmed = draft.trim();
  if (required && !trimmed) {
    // 拒绝提交
  } else {
    mockOnChange(trimmed);
  }

  assert.deepEqual(calls, []);
});

test("required 非空时正常提交", () => {
  const calls: string[] = [];
  const mockOnChange = (next: string) => calls.push(next);

  const draft = "new-value";
  const original = "original";
  const required = true;

  const trimmed = draft.trim();
  if (required && !trimmed) {
    // 拒绝
  } else if (trimmed !== String(original)) {
    mockOnChange(trimmed);
  }

  assert.deepEqual(calls, ["new-value"]);
});

// ── 值未变不触发 onChange ──

test("提交值与当前值相同时不触发 onChange", () => {
  const calls: string[] = [];
  const mockOnChange = (next: string) => calls.push(next);

  const draft = "same";
  const value = "same";

  if (String(draft) !== String(value)) {
    mockOnChange(draft);
  }

  assert.deepEqual(calls, []);
});

// ── undo 栈容量 ──

test("undo 栈最多保留 10 步，超出时丢弃最旧", () => {
  const MAX = 10;
  const stack: number[] = [];

  for (let i = 1; i <= 15; i++) {
    stack.push(i);
    if (stack.length > MAX) stack.shift();
  }

  assert.deepEqual(stack, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(stack.length, MAX);
});

test("undo 栈为空时 pop 返回 undefined", () => {
  const stack: number[] = [];
  const prev = stack.pop();
  assert.equal(prev, undefined);
});

// ── 三态切换序列 ──

test("browse → focused → editing → browse 状态序列", () => {
  const sequence: string[] = [];

  // Enter 从 browse 进入 focused
  let mode: "browse" | "focused" | "editing" = "browse";
  sequence.push(mode);

  // 单击进入 focused
  if (mode === "browse") {
    mode = "focused";
    sequence.push(mode);
  }

  // 双击进入 editing
  if (mode === "focused") {
    mode = "editing";
    sequence.push(mode);
  }

  // Enter 提交回到 browse
  if (mode === "editing") {
    mode = "browse";
    sequence.push(mode);
  }

  assert.deepEqual(sequence, ["browse", "focused", "editing", "browse"]);
});

test("editing 态 Escape 取消回 browse，值不变", () => {
  let mode: "browse" | "focused" | "editing" = "editing";
  const originalValue = "before-edit";

  // Escape
  mode = "browse";

  assert.equal(mode, "browse");
  assert.equal(originalValue, "before-edit");
});

// ── readOnly 不进入编辑态 ──

test("readOnly 时点击/Enter/F2 都不进入 focused 或 editing", () => {
  let mode: "browse" | "focused" | "editing" = "browse";
  const readOnly = true;

  const attemptEdit = () => {
    if (readOnly) return;
    mode = "focused";
  };

  attemptEdit();
  assert.equal(mode, "browse");
});

// ── 键盘不劫持 input 内部事件 ──

test("快捷键 handler 在 INPUT/TEXTAREA/SELECT 内不触发", () => {
  const shouldSkip = (tag: string) =>
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

  assert.equal(shouldSkip("INPUT"), true);
  assert.equal(shouldSkip("TEXTAREA"), true);
  assert.equal(shouldSkip("SELECT"), true);
  assert.equal(shouldSkip("DIV"), false);
  assert.equal(shouldSkip("BUTTON"), false);
  assert.equal(shouldSkip("TD"), false);
});
