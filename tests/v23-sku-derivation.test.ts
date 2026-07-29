import assert from "node:assert/strict";
import test from "node:test";
import { deriveV23SkuPull, v23EffectiveEntries } from "../lib/v23-sku-derivation";
const ref = { id: "a", revision: 1, contentHash: "a".repeat(64) };
const payload = { name: "p", category: "attribute" as const, itemPartId: "part:rod", semanticContributionKey: "pull", stackingPolicy: "dedupe" as const, generationPolicy: "normal" as const, rarity: "common" as const, valueScore: 0, tags: [], description: "", enabled: true, operations: [{ operationId: "op", operationIndex: 0, sourceAffixId: "a", sourceAffixRevision: 1, parameterKey: "pull", operation: "flat_adjust" as const, direction: "increase" as const, magnitude: 2, publishedMagnitudeRange: { min: 0, max: 2, ruleSetVersion: "r" } }], passivePayload: null };
test("v23 pull derives deterministically after stable-ID settlement", () => {
  const entries = v23EffectiveEntries([{ ref, payload }], [], [], []);
  const result = deriveV23SkuPull(5, entries);
  assert.equal(result.status, "VALID");
  if (result.status === "VALID") assert.equal(result.targetPullKg, 7);
  assert.throws(() => v23EffectiveEntries([{ ref, payload }], [], [{ ref: { ...ref, revision: 2 }, payload }], []), /CONFLICT/);
});
