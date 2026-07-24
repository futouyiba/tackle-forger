import assert from "node:assert/strict";
import test from "node:test";

import { isComposingChangeEvent } from "../lib/composition-input";
import { migrateWorkspaceState } from "../lib/migrations";
import { createSeedState } from "../lib/seed";
import type { ParameterDefinition, WorkspaceState } from "../lib/types";

/**
 * 回归：参数管理表行用 parameter.key 当 React key，而 renameParameter 每次按键
 * 都改写 key → 行卸载/重挂载 → 内部 input 重建 → 中文 IME 组字上下文脱离、焦点丢失
 * （已确诊的“鱼ggds”症状）。修复让行用稳定 parameter.id，rename 绝不重算 id。
 *
 * node:test 无 DOM，无法端到端驱动 IME；这里锁定两个等价不变量：
 *   1. normalize 为每个 ParameterDefinition 回填稳定 id，rename 前后 id 不变；
 *   2. isComposingChangeEvent 在组字期间判定为 true（TextInput 据此不提交半成品）。
 */
function legacyWithoutParameterIds() {
  const legacy = structuredClone(createSeedState());
  for (const parameter of legacy.parameters) {
    delete parameter.id;
  }
  return legacy;
}

test("normalize 为 ParameterDefinition 回填稳定 id 且幂等", () => {
  const migrated = migrateWorkspaceState(legacyWithoutParameterIds());
  assert.ok(migrated.parameters.length > 0, "种子工作区应包含参数");
  for (const parameter of migrated.parameters) {
    assert.equal(parameter.id, `param:${parameter.key}`);
    assert.ok(typeof parameter.id === "string" && parameter.id.length > 0);
  }
  // 不同参数的稳定 id 互不相同
  const ids = migrated.parameters.map((parameter) => parameter.id);
  assert.equal(new Set(ids).size, ids.length);

  // 幂等：再次 normalize 不应改写已回填的 id
  const remigrated = migrateWorkspaceState(structuredClone(migrated));
  assert.deepEqual(
    remigrated.parameters.map((parameter) => ({ key: parameter.key, id: parameter.id })),
    migrated.parameters.map((parameter) => ({ key: parameter.key, id: parameter.id })),
  );
});

test("rename 改写 label/key 时 ParameterDefinition.id 保持不变（行不重挂载）", () => {
  const migrated = migrateWorkspaceState(legacyWithoutParameterIds());
  const target = migrated.parameters[0];
  const stableId = target.id;
  assert.ok(stableId);
  const othersBefore = migrated.parameters
    .filter((parameter) => parameter.id !== stableId)
    .map((parameter) => parameter.key);

  // 复刻 renameParameter 的核心领域写法：改写 key/label，保留 id（id 一经确定绝不重算）
  const newLabel = "测试参数名";
  const newKey = newLabel.trim();
  target.key = newKey;
  target.label = newLabel;

  const renormalized = migrateWorkspaceState(structuredClone(migrated));
  assert.equal(renormalized.parameters.length, migrated.parameters.length);

  const afterTarget = renormalized.parameters.find((parameter) => parameter.id === stableId);
  assert.ok(afterTarget, "稳定 id 在 rename 后仍能定位同一参数");
  assert.equal(afterTarget.id, stableId, "rename 前后 React key 不变 → 行不重挂载");
  assert.equal(afterTarget.key, newKey);
  assert.equal(afterTarget.label, newLabel);

  // 其余参数 key 未被波及
  const othersAfter = renormalized.parameters
    .filter((parameter) => parameter.id !== stableId)
    .map((parameter) => parameter.key);
  assert.deepEqual(othersAfter, othersBefore);
});

test("中文连续输入：label 经历多个组字中间态时稳定 id 仍指向同一参数", () => {
  const migrated = migrateWorkspaceState(legacyWithoutParameterIds());
  const target = migrated.parameters[0];
  const stableId = target.id;
  assert.ok(stableId);

  // 即便 IME 守卫失效、半成品 label 被写入 state，稳定 id 也保证行不重挂载。
  // 与守卫配合后，半成品根本不会进入 state，此为双重保障。
  for (const partial of ["鱼", "鱼g", "鱼gg", "鱼ggd", "鱼ggds"]) {
    target.label = partial;
    target.key = partial.trim();
    const view = migrateWorkspaceState(
      structuredClone(migrated) as WorkspaceState,
    );
    const seen: ParameterDefinition | undefined = view.parameters.find(
      (parameter) => parameter.id === stableId,
    );
    assert.ok(seen, `中间态「${partial}」仍能按稳定 id 定位同一参数`);
    assert.equal(seen.id, stableId, "组字各中间态前后 React key 不变");
  }
});

test("isComposingChangeEvent：IME 组字期间不提交半成品", () => {
  assert.equal(isComposingChangeEvent(true, undefined), true, "compositionstart 后标志为真 → 拦截");
  assert.equal(isComposingChangeEvent(false, true), true, "input 事件 nativeEvent.isComposing 为真 → 拦截");
  assert.equal(isComposingChangeEvent(true, false), true, "标志为真即拦截");
  assert.equal(isComposingChangeEvent(false, undefined), false, "非组字的正常按键 → 提交");
  assert.equal(isComposingChangeEvent(false, false), false, "compositionEnd 之后的正常提交");
});
