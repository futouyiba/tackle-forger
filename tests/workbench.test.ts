import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCandidate,
  evaluateFormula,
  generateCandidatesForRecipe,
  publishCandidate,
  scoreAffixes,
} from "../lib/engine";
import { createSeedState } from "../lib/seed";
import {
  advanceAutomaticNodes,
  approveReviewSnapshot,
  commitRuleRunToCandidates,
  createRuleGraphRun,
  executeRuleGraphNode,
  validateRuleGraph,
} from "../lib/workflow";

test("Excel 数据种子完整映射主表", () => {
  const state = createSeedState();
  assert.equal(state.templates.length, 12);
  assert.equal(state.candidates.length, 32);
  assert.equal(state.recipes.length, 12);
  assert.ok(state.parameters.length >= 26);
  assert.ok(state.modifiers.some((item) => item.dimension === "function"));
  assert.ok(state.modifiers.some((item) => item.dimension === "performance"));
  assert.ok(state.affixes.some((item) => item.category === "passive"));
});

test("分层规则计算杆轮线、安全拉力和品质", () => {
  const state = createSeedState();
  const calculated = calculateCandidate(state, state.candidates[0]);
  assert.ok(Number(calculated.calculated.values["杆最大拉力kgf"]) > 0);
  assert.ok(Number(calculated.calculated.values["轮最大拉力kgf"]) > 0);
  assert.ok(Number(calculated.calculated.values["线最大拉力kgf"]) > 0);
  assert.ok(calculated.calculated.safeWorkingForce > 0);
  assert.ok(calculated.calculated.trace.length > 0);
  assert.ok(calculated.calculated.quality.finalScore >= 0);
});

test("词条采用有损相加、协同和冲突规则", () => {
  const state = createSeedState();
  const result = scoreAffixes(state, [
    "affix-distance",
    "affix-light",
    "affix-impact",
  ]);
  assert.equal(result.rawScore, 17);
  assert.ok(result.bonuses.length > 0);
  assert.ok(result.penalties.length > 0);
  assert.ok(result.finalScore > 0);
});

test("高级公式解析器不依赖 eval", () => {
  assert.equal(
    evaluateFormula("max(current*1.1, 杆最大拉力kgf+2)", {
      current: 10,
      杆最大拉力kgf: 8,
    }),
    11,
  );
});

test("受约束配方生成并发布规范 ID", () => {
  const state = createSeedState();
  const recipe = { ...state.recipes[0], maxCandidates: 3 };
  const generated = generateCandidatesForRecipe(state, recipe);
  assert.ok(generated.length > 0);
  assert.ok(generated.length <= 3);
  const sku = publishCandidate(state, generated[0]);
  assert.equal(sku.rodId, sku.comboId + "_R");
  assert.equal(sku.reelId, sku.comboId + "_W");
  assert.equal(sku.lineId, sku.comboId + "_L");
});

test("规则图是无环 DAG，条件分支按行路由并在人工关卡暂停", () => {
  const state = createSeedState();
  const graph = structuredClone(state.ruleGraphs[0]);
  assert.deepEqual(validateRuleGraph(graph), []);

  const run = createRuleGraphRun(state, graph, [], "测试策划");
  const conditionState = run.nodeStates.find((item) => item.nodeId === "node-special-condition");
  assert.equal(conditionState?.status, "completed");
  assert.equal(
    (conditionState?.matchedRowIds.length ?? 0) + (conditionState?.unmatchedRowIds.length ?? 0),
    state.candidates.length,
  );
  assert.equal(run.status, "paused");
  assert.equal(
    run.nodeStates.find((item) => item.nodeId === "node-special-adjust")?.status,
    "ready",
  );

  executeRuleGraphNode(state, graph, run, "node-special-adjust");
  advanceAutomaticNodes(state, graph, run);
  assert.equal(run.status, "waiting_review");
  assert.equal(run.snapshots.length, 1);
  assert.equal(run.snapshots[0].rows.length, state.candidates.length);
});

test("审阅中间表可修改，批准后继续执行并只下发触碰字段", () => {
  const state = createSeedState();
  const graph = structuredClone(state.ruleGraphs[0]);
  const run = createRuleGraphRun(state, graph, [], "测试策划");
  executeRuleGraphNode(state, graph, run, "node-special-adjust");
  advanceAutomaticNodes(state, graph, run);

  const snapshot = run.snapshots[0];
  const row = snapshot.rows[0];
  const before = Number(row.values["杆自重g"]);
  row.values["杆自重g"] = before + 7;
  row.touchedKeys.push("杆自重g");

  approveReviewSnapshot(state, graph, run, "node-review", "审核员");
  assert.equal(run.status, "paused");
  assert.equal(run.nodeStates.find((item) => item.nodeId === "node-output")?.status, "ready");

  executeRuleGraphNode(state, graph, run, "node-output");
  advanceAutomaticNodes(state, graph, run);
  assert.equal(run.status, "completed");

  commitRuleRunToCandidates(state, run);
  const candidate = state.candidates.find((item) => item.id === row.candidateId);
  assert.equal(candidate?.overrides["杆自重g"], before + 7);
  assert.ok(run.committedAt);
});

test("规则图拒绝形成循环", () => {
  const state = createSeedState();
  const graph = structuredClone(state.ruleGraphs[0]);
  graph.edges.push({
    id: "cycle-edge",
    from: "node-output",
    to: "node-baseline",
    outcome: "always",
    label: "错误回路",
  });
  assert.ok(validateRuleGraph(graph).some((issue) => issue.includes("循环")));
});
