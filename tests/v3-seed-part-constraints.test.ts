import assert from "node:assert/strict";
import test from "node:test";
import { resolvePartConstraintSourceRevision } from "../lib/part-constraints";
import { createSeedState } from "../lib/seed";
import { hydrateV3Seed } from "../lib/v3-seed";

test("v3 seed 为 Series 与 CandidateRecipe 冻结各自精确的 PartConstraintSet 来源", () => {
  const state = hydrateV3Seed(createSeedState());
  const series = state.seriesDefinitions.find((entry) => entry.id === "series:qinglu-obstacle")!;
  const recipe = state.candidateSearchRecipes.find((entry) => entry.id === "candidate-recipe:qinglu-obstacle")!;
  assert.ok(series.partConstraintSetRef);
  assert.ok(recipe.partConstraintSetRef);
  assert.notDeepEqual(series.partConstraintSetRef, recipe.partConstraintSetRef);

  const seriesSet = state.partConstraintSets.find((entry) =>
    entry.constraintSetId === series.partConstraintSetRef!.constraintSetId,
  )!;
  const recipeSet = state.partConstraintSets.find((entry) =>
    entry.constraintSetId === recipe.partConstraintSetRef!.constraintSetId,
  )!;
  assert.equal(seriesSet.sourceRef.sourceType, "series_definition");
  assert.equal(recipeSet.sourceRef.sourceType, "candidate_search_recipe");
  assert.equal(resolvePartConstraintSourceRevision(state.seriesDefinitions, seriesSet.sourceRef), series);
  assert.equal(resolvePartConstraintSourceRevision(state.candidateSearchRecipes, recipeSet.sourceRef), recipe);
  assert.equal(recipe.performanceIds.includes(series.performanceProfileId!), true);
});
