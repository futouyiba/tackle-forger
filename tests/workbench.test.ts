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
