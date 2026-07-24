import assert from "node:assert/strict";
import test from "node:test";
import {
  canPresentCandidateRunCompletion,
  runCandidateGenerationWorkbenchAction,
} from "../lib/candidate-generation-workbench";

test("候选工作台将生成领域门禁异常转换为可操作 UI 错误", () => {
  const result = runCandidateGenerationWorkbenchAction("生成候选", () => {
    throw new Error("PART_CONSTRAINT_SET_NEEDS_REVIEW：约束尚待人工确认。");
  });
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /^生成候选已被安全阻止：/);
  assert.match(result.message ?? "", /PART_CONSTRAINT_SET_NEEDS_REVIEW/);
});

test("候选工作台将物化领域门禁异常转换为可操作 UI 错误", () => {
  const result = runCandidateGenerationWorkbenchAction("物化候选", () => {
    throw new Error("PART_CONSTRAINT_SET_REF_UNSUPPORTED_FOR_CANDIDATE_GENERATION");
  });
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /^物化候选已被安全阻止：/);
  assert.match(result.message ?? "", /REF_UNSUPPORTED/);
});

test("候选工作台仅在领域操作成功时返回结果", () => {
  assert.deepEqual(
    runCandidateGenerationWorkbenchAction("生成候选", () => ({ runId: "run:ok" })),
    { ok: true, value: { runId: "run:ok" } },
  );
});

test("自动物化失败时，候选工作台不呈现矛盾的运行完成通知", () => {
  assert.equal(canPresentCandidateRunCompletion(true, false), false);
  assert.equal(canPresentCandidateRunCompletion(true, true), true);
  assert.equal(canPresentCandidateRunCompletion(false, false), true);
});
