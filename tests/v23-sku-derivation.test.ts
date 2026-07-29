import assert from "node:assert/strict";
import test from "node:test";
import { deriveV23SkuPull, validateV23ModelPatchForPull, v23EffectiveEntries } from "../lib/v23-sku-derivation";
import type { V23ProjectAffixPayload } from "../lib/types";
import { importReductionStackingPolicyDraft, publishReductionStackingPolicyVersion } from "../lib/reduction-stacking-policy";
import { numberToBinary64Hex } from "../lib/reduction-stacking-policy";
const policy = () => publishReductionStackingPolicyVersion({ draft: importReductionStackingPolicyDraft({ sourceRevision: { id: "source:1", workbookRefId: "feishu-workbook:tackle-design", sourceRevision: "99", sheets: [{ sheetId: "23CsXE" }] } as never, machineRules: [{ ruleId: "pull", parameterKey: "pull", strategy: "bidirectional_ratio", numericContract: "ieee754-binary64-v1", operationOrder: ["set", "percent_adjust", "flat_adjust", "clamp_add", "final_review_patch", "parameter_definition"] }], createdAt: "2026-01-01T00:00:00.000Z" }), publishedAt: "2026-01-01T00:00:00.000Z", publishedBy: "test" });
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
  assert.equal(deriveV23SkuPull(5, entries, { formal: true, publishedReductionPolicy: policy() }).status, "VALID");
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

test("ratio failure evidence binds each rounded binary64 boundary", () => {
  const ratio = structuredClone(payload) as V23ProjectAffixPayload;
  ratio.operations[0] = { ...ratio.operations[0]!, operation: "percent_adjust", magnitude: Number.MAX_VALUE, direction: "increase" } as never;
  const factor = deriveV23SkuPull(1, [{ ref, payload: ratio }]);
  assert.equal(factor.status, "VALID");
  if (factor.status === "VALID") { assert.equal(factor.targetPullKg, Number.MAX_VALUE); assert.equal(factor.trace[0]!.numericEvidence.afterBinary64, numberToBinary64Hex(Number.MAX_VALUE)); }
  ratio.operations[0] = { ...(ratio.operations[0] as Record<string, unknown>), magnitude: 1, direction: "increase" } as never;
  const multiply = deriveV23SkuPull(Number.MAX_VALUE, [{ ref, payload: ratio }]);
  assert.equal(multiply.status, "INVALID");
  if (multiply.status === "INVALID") assert.equal(multiply.failureEvidence.stage, "ratio_multiply");
  ratio.operations[0] = { ...(ratio.operations[0] as Record<string, unknown>), magnitude: Number.MAX_VALUE, direction: "decrease" } as never;
  const divide = deriveV23SkuPull(Number.MIN_VALUE, [{ ref, payload: ratio }]);
  assert.equal(divide.status, "INVALID");
  if (divide.status === "INVALID") { assert.equal(divide.failureEvidence.stage, "ratio_divide"); assert.equal(divide.failureEvidence.numericEvidence.afterBinary64, numberToBinary64Hex(0)); assert.equal(divide.failureEvidence.numericEvidence.anomaly, "underflow_to_zero"); }
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

test("flat pools settle before clamps", () => {
  const chained = structuredClone(payload) as V23ProjectAffixPayload;
  chained.operations = [
    { ...payload.operations[0]!, operationId: "flat", operation: "flat_adjust", magnitude: 10, direction: "increase" },
    { ...payload.operations[0]!, operationId: "clamp", operationIndex: 1, operation: "clamp_add", magnitude: 0, direction: "increase", clampMin: 0, clampMax: 15 },
  ] as never;
  const result = deriveV23SkuPull(10, [{ ref, payload: chained }]);
  assert.equal(result.status, "VALID");
  if (result.status === "VALID") assert.equal(result.targetPullKg, 15);
});

test("flat pools are directional binary64 folds with replayable operation traces", () => {
  const directional = structuredClone(payload) as V23ProjectAffixPayload;
  directional.operations = [
    { ...payload.operations[0]!, operationId: "up-big", operationIndex: 0, operation: "flat_adjust", direction: "increase", magnitude: 2 ** 53 },
    { ...payload.operations[0]!, operationId: "down-big", operationIndex: 1, operation: "flat_adjust", direction: "decrease", magnitude: 2 ** 53 },
    { ...payload.operations[0]!, operationId: "up-one", operationIndex: 2, operation: "flat_adjust", direction: "increase", magnitude: 1 },
  ] as never;
  const result = deriveV23SkuPull(10, [{ ref, payload: directional }]);
  assert.equal(result.status, "VALID");
  if (result.status === "VALID") { assert.equal(result.targetPullKg, 10); assert.deepEqual(result.trace.map((step) => step.operationId), ["up-big", "down-big", "up-one", "v23:flat-pool-settlement"]); assert.equal(result.trace.at(-1)!.affixId, null); }
});

test("set is a terminally connected trace step", () => {
  const set = structuredClone(payload) as V23ProjectAffixPayload;
  set.operations = [{ operationId: "set-pull", operationIndex: 0, sourceAffixId: "a", sourceAffixRevision: 1, parameterKey: "pull", operation: "set", value: 7, publishedMagnitudeRange: { min: 0, max: 7, ruleSetVersion: "r" } }] as never;
  const result = deriveV23SkuPull(5, [{ ref, payload: set }]);
  assert.equal(result.status, "VALID");
  if (result.status === "VALID") { assert.equal(result.targetPullKg, 7); assert.equal(result.trace.length, 1); assert.deepEqual(result.trace[0]!.beforeKg, 5); assert.deepEqual(result.trace[0]!.afterKg, 7); assert.equal(result.trace[0]!.operation, "set"); }
});
