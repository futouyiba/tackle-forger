import assert from "node:assert/strict";
import test from "node:test";
import { deriveV23SkuPull, validateV23ModelPatchForPull, v23EffectiveEntries } from "../lib/v23-sku-derivation";
import type { V23ProjectAffixPayload } from "../lib/types";
const ref = { id: "a", revision: 1, contentHash: "a".repeat(64) };
const payload = { name: "p", category: "attribute" as const, itemPartId: "part:rod", semanticContributionKey: "pull", stackingPolicy: "dedupe" as const, generationPolicy: "normal" as const, rarity: "common" as const, valueScore: 0, tags: [], description: "", enabled: true, operations: [{ operationId: "op", operationIndex: 0, sourceAffixId: "a", sourceAffixRevision: 1, parameterKey: "pull", operation: "flat_adjust" as const, direction: "increase" as const, magnitude: 2, publishedMagnitudeRange: { min: 0, max: 2, ruleSetVersion: "r" } }], passivePayload: null };
test("v23 pull derives deterministically after stable-ID settlement", () => {
  const entries = v23EffectiveEntries([{ ref, payload }], [], [], []);
  const result = deriveV23SkuPull(5, entries);
  assert.equal(result.status, "VALID");
  if (result.status === "VALID") assert.equal(result.targetPullKg, 7);
  assert.throws(() => v23EffectiveEntries([{ ref, payload }], [], [{ ref: { ...ref, revision: 2 }, payload }], []), /CONFLICT/);
});

test("v23 rejects every canonical ModelPatch operation only for the owning structural pull", () => {
  for (const [partType, parameterKey] of [["rod", "rodPullKg"], ["reel", "reelPullKg"], ["line", "linePullKg"]] as const) {
    for (const operation of ["set", "add", "multiply", "clear"] as const) assert.throws(() => validateV23ModelPatchForPull(partType, { operation, parameterKey }), /PULL_FORBIDDEN/);
    assert.doesNotThrow(() => validateV23ModelPatchForPull(partType, { operation: "set", parameterKey: "displayName" }));
  }
  assert.throws(() => validateV23ModelPatchForPull("rod", { operation: "unknown", parameterKey: "rodPullKg" }), /SCHEMA_INVALID/);
  assert.throws(() => validateV23ModelPatchForPull("rod", null), /SCHEMA_INVALID/);
});

test("formal decrease requires the published OPEN-001 policy version", () => {
  const decrease = structuredClone(payload) as V23ProjectAffixPayload;
  (decrease.operations[0]! as Extract<typeof decrease.operations[number], { direction: "increase" | "decrease" }>).direction = "decrease";
  const entries = [{ ref, payload: decrease }];
  assert.deepEqual(deriveV23SkuPull(5, entries, { formal: true }).status, "INVALID");
  assert.equal(deriveV23SkuPull(5, entries, { formal: true, publishedReductionPolicy: { id: "policy:1", version: "v1", contentHash: "b".repeat(64), status: "published", strategy: "bidirectional_ratio", numericContract: "ieee754-binary64-v1" } }).status, "VALID");
});
