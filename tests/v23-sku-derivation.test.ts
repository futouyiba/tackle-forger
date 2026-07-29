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
  for (const parameterKey of ["pull", "targetPullKg", "targetPullKgf"]) assert.throws(() => validateV23ModelPatchForPull("rod", { operation: "set", parameterKey }), /PULL_FORBIDDEN/);
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

test("percent adjustments use the published bidirectional ratio contract", () => {
  const up = structuredClone(payload) as V23ProjectAffixPayload;
  up.operations[0] = { ...up.operations[0]!, operation: "percent_adjust", magnitude: 1, direction: "increase" } as never;
  const down = structuredClone(up); down.operations[0] = { ...down.operations[0]!, operationId: "op2", sourceAffixId: "b", magnitude: 0.2, direction: "decrease" } as never;
  const result = deriveV23SkuPull(10, [{ ref, payload: up }, { ref: { ...ref, id: "b" }, payload: down }]);
  assert.equal(result.status, "VALID");
  if (result.status === "VALID") { assert.equal(result.targetPullKg, 10 * 2 / 1.2); assert.equal(result.trace[0]!.beforeKg, 10); assert.equal(result.trace[0]!.afterKg, result.targetPullKg); assert.equal(result.trace[0]!.ratioOperations?.length, 2); }
});

test("binary64 ratio rejects overflow and underflow-to-zero deterministically", () => {
  const percent = structuredClone(payload) as V23ProjectAffixPayload;
  percent.operations[0] = { ...percent.operations[0]!, operation: "percent_adjust", magnitude: 1, direction: "increase" } as never;
  assert.equal(deriveV23SkuPull(Number.MAX_VALUE, [{ ref, payload: percent }]).status, "INVALID");
  const halve = structuredClone(percent); halve.operations[0] = { ...halve.operations[0]!, direction: "decrease" } as never;
  assert.equal(deriveV23SkuPull(Number.MIN_VALUE, [{ ref, payload: halve }]).status, "INVALID");
});

test("v23 uses UTF-8 canonical order and binary64 left-folded percent pools", () => {
  const make = (id: string, magnitude: number) => ({ ref: { ...ref, id }, payload: { ...payload, operations: [{ ...payload.operations[0]!, operation: "percent_adjust" as const, sourceAffixId: id, operationId: `${id}:op`, magnitude, direction: "increase" as const }] } as V23ProjectAffixPayload });
  const entries = [make("中", 1), make("A", 1), make("!", 2 ** 53)];
  const forward = deriveV23SkuPull(1, entries);
  const reverse = deriveV23SkuPull(1, [...entries].reverse());
  assert.deepEqual(reverse, forward);
  assert.equal(forward.status, "VALID");
  if (forward.status === "VALID") assert.equal(forward.targetPullKg, 1 + (2 ** 53 + 1 + 1));
});

test("local-copy replacement is identity-bound and input ordering is irrelevant", () => {
  const copied = { ref: { ...ref, id: "copy-source" }, localCopyId: "copy:α", copyHash: "c".repeat(64), payload };
  const normal = deriveV23SkuPull(5, [{ ref, payload }, copied]);
  const reverse = deriveV23SkuPull(5, [copied, { ref, payload }]);
  assert.deepEqual(reverse, normal);
});
