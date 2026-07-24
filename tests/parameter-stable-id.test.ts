import assert from "node:assert/strict";
import test from "node:test";

import { isComposingChangeEvent } from "../lib/composition-input";
import { createParameterId, migrateWorkspaceState } from "../lib/migrations";
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

/**
 * 回归：PR #122 review 发现。原修复让行用稳定 id，但 addParameter 与 Excel 导入仍用
 * `param:${key}` 当 id。复现：新增「竿新参数」（id=param:竿新参数）→ 改名为「测试」
 * （id 保留、key 释放）→ 再新增「竿新参数」→ 又得到 param:竿新参数 → 两行 React key
 * 撞车（节点复用/状态串扰/重挂载）。修复后新增路径改用 createParameterId()（不可复用 UUID）。
 */
test("createParameterId：两次新建生成不同的不可复用 id（修复 review 发现）", () => {
  const idA = createParameterId();
  const idB = createParameterId();
  assert.notEqual(idA, idB, "两次新建的 id 必须不同 → React key 不撞车");
  for (const id of [idA, idB]) {
    assert.ok(id.startsWith("param:"), "保留 param: 前缀，与既有实体命名空间一致");
    assert.ok(
      id.length > "param:".length + 8,
      "id 后缀带有足够熵（UUID），不退化为基于 key 的可复用形式",
    );
  }
});

test("改名释放 key 后再新建同名参数：两行 id 不同（review 复现场景）", () => {
  // 复刻 addParameter 的 id 生成（createParameterId）与 renameParameter 不动 id 的领域写法。
  const base = migrateWorkspaceState(legacyWithoutParameterIds());
  assert.ok(
    !base.parameters.some((p) => p.key === "竿新参数"),
    "起点不应已存在 key=竿新参数",
  );

  // 1. 新增「竿新参数」
  const created1: ParameterDefinition = {
    id: createParameterId(),
    key: "竿新参数",
    label: "竿新参数",
    itemKind: "rod",
    unit: "",
    precision: 2,
    notes: "新增参数",
  };
  let state: WorkspaceState = migrateWorkspaceState({
    ...structuredClone(base),
    parameters: [...base.parameters, created1],
  } as WorkspaceState);
  const row1 = state.parameters.find((p) => p.key === "竿新参数");
  assert.ok(row1, "新增后能按 key 定位");
  assert.equal(row1?.id, created1.id, "normalize 保留新建 id，未回填为 param:${key}");

  // 2. 改名「竿新参数」→「测试」：renameParameter 只改 key/label，id 不动
  row1.key = "测试";
  row1.label = "测试";
  state = migrateWorkspaceState(structuredClone(state) as WorkspaceState);
  const renamed = state.parameters.find((p) => p.id === created1.id);
  assert.ok(renamed, "改名后仍能按原 id 定位同一参数");
  assert.equal(renamed?.id, created1.id, "rename 绝不重算 id");
  assert.equal(renamed?.key, "测试");
  assert.ok(!state.parameters.some((p) => p.key === "竿新参数"), "旧 key 已被释放");

  // 3. 再新增「竿新参数」（旧 key 已释放，addParameter 的去重循环允许复用该 key）
  const created2: ParameterDefinition = {
    id: createParameterId(),
    key: "竿新参数",
    label: "竿新参数",
    itemKind: "rod",
    unit: "",
    precision: 2,
    notes: "新增参数",
  };
  state = migrateWorkspaceState({
    ...structuredClone(state),
    parameters: [...state.parameters, created2],
  } as WorkspaceState);
  const row2 = state.parameters.find((p) => p.key === "竿新参数");
  assert.ok(row2, "再次新增后能按 key 定位");
  assert.equal(row2?.id, created2.id, "第二个新建参数的 id 也被 normalize 保留");

  // 4. 关键断言：两行 id 必须不同（修复前会都是 param:竿新参数 → 撞 key）
  assert.notEqual(
    created1.id,
    created2.id,
    "释放旧 key 后再新建同名参数，id 必须不同 → React key 不撞车、行不复用",
  );
  // 全局唯一性兜底：整个参数表无重复 id
  const ids = state.parameters.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "参数表内 id 全局唯一");
});
