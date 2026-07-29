import type { ReductionStackingPolicyVersion, V23ProjectAffixPayload, V23StableContentRef } from "./types";
import { jcsSha256Hex } from "./canonical-json";
import { compareUtf8, hasCanonicalReductionPolicyIdentity, numberToBinary64Hex } from "./reduction-stacking-policy";

export interface V23ResolvedAffix { ref: V23StableContentRef; payload: V23ProjectAffixPayload; localCopyId?: string; copyHash?: string; }
export interface V23PullTraceStep { affixId: string; operationId: string; operationIndex: number; operation: "percent_adjust" | "flat_adjust" | "clamp_add"; direction: "increase" | "decrease"; magnitude: number; clampMin: number | null; clampMax: number | null; ratioOperations: Array<{ affixId: string; operationId: string; operationIndex: number; direction: "increase" | "decrease"; magnitude: number }> | null; beforeKg: number; afterKg: number; numericEvidence: { beforeBinary64: string; afterBinary64: string; exactNumerator: string; exactDenominator: string; anomaly: "none" | "overflow" | "underflow_to_zero" }; }
export type V23SkuPullDerivation =
  | { status: "VALID"; baselinePullKg: number; targetPullKg: number; effectiveEntryIds: string[]; trace: V23PullTraceStep[]; inputHash: string }
  | { status: "INVALID"; code: string; inputHash: string };

export type V23CanonicalModelPatchOperation = "set" | "add" | "multiply" | "clear";
export interface V23ModelPatchInput { operation: V23CanonicalModelPatchOperation; parameterKey: string; }
export interface V23DerivationOptions { formal?: boolean; publishedReductionPolicy?: Pick<ReductionStackingPolicyVersion, "id" | "version" | "contentHash" | "status" | "strategy" | "numericContract"> | null; }

const V23_STRUCTURAL_PULL_KEYS: Record<"rod" | "reel" | "line", string> = {
  rod: "rodPullKg", reel: "reelPullKg", line: "linePullKg",
};
type Rational = { numerator: bigint; denominator: bigint };
const z = BigInt(0); const one = BigInt(1); const maxFinite = exact(Number.MAX_VALUE);
function exact(value: number): Rational { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value, false); const bits = view.getBigUint64(0, false); const sign = bits >> BigInt(63) ? -one : one; const exponentBits = Number((bits >> BigInt(52)) & BigInt("0x7ff")); const fraction = bits & BigInt("0x000fffffffffffff"); if (exponentBits === 0x7ff) return { numerator: z, denominator: z }; if (exponentBits === 0 && fraction === z) return { numerator: z, denominator: one }; const significand = exponentBits === 0 ? fraction : (one << BigInt(52)) | fraction; const exponent = exponentBits === 0 ? -1074 : exponentBits - 1075; return exponent >= 0 ? { numerator: sign * significand * (one << BigInt(exponent)), denominator: one } : { numerator: sign * significand, denominator: one << BigInt(-exponent) }; }
function add(left: Rational, right: Rational): Rational { return { numerator: left.numerator * right.denominator + right.numerator * left.denominator, denominator: left.denominator * right.denominator }; }
function mul(left: Rational, right: Rational): Rational { return { numerator: left.numerator * right.numerator, denominator: left.denominator * right.denominator }; }
function div(left: Rational, right: Rational): Rational { return { numerator: left.numerator * right.denominator, denominator: left.denominator * right.numerator }; }
function anomaly(value: Rational, result: number): "overflow" | "underflow_to_zero" | null { const n = value.numerator < z ? -value.numerator : value.numerator; const d = value.denominator < z ? -value.denominator : value.denominator; if (!Number.isFinite(result) || d === z || n * maxFinite.denominator > maxFinite.numerator * d) return "overflow"; return value.numerator !== z && result === 0 ? "underflow_to_zero" : null; }
function evidence(before: number, after: number, exactValue: Rational): V23PullTraceStep["numericEvidence"] { return { beforeBinary64: numberToBinary64Hex(before), afterBinary64: numberToBinary64Hex(after), exactNumerator: exactValue.numerator.toString(), exactDenominator: exactValue.denominator.toString(), anomaly: anomaly(exactValue, after) ?? "none" }; }

/** Model patches may never turn a derived v23 structural pull into input.
 * Unknown shapes are rejected rather than assumed harmless at this boundary. */
export function validateV23ModelPatchForPull(partType: "rod" | "reel" | "line", value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("V23_MODEL_PATCH_SCHEMA_INVALID");
  const patch = value as Record<string, unknown>;
  if (typeof patch.operation !== "string" || !["set", "add", "multiply", "clear"].includes(patch.operation) || typeof patch.parameterKey !== "string" || patch.parameterKey.length === 0) throw new Error("V23_MODEL_PATCH_SCHEMA_INVALID");
  if (["pull", "targetPullKg", "targetPullKgf", ...Object.values(V23_STRUCTURAL_PULL_KEYS)].includes(patch.parameterKey)) throw new Error("V23_MODEL_PATCH_PULL_FORBIDDEN");
}

/** Stable ID is settled before semantic contribution; a local copy replaces
 * its source, and an exact duplicate is idempotent. */
export function v23EffectiveEntries(inherited: readonly V23ResolvedAffix[], removedInheritedEntryIds: readonly string[], added: readonly V23ResolvedAffix[], localCopies: readonly V23ResolvedAffix[]): V23ResolvedAffix[] {
  const removed = new Set(removedInheritedEntryIds);
  if (removed.size !== removedInheritedEntryIds.length) throw new Error("V23_REMOVED_ENTRY_ID_DUPLICATE");
  const entries = new Map<string, V23ResolvedAffix>();
  const put = (entry: V23ResolvedAffix, replacement = false) => {
    const prior = entries.get(entry.ref.id);
    if (!prior || replacement) { entries.set(entry.ref.id, entry); return; }
    if (prior.ref.revision !== entry.ref.revision || prior.ref.contentHash !== entry.ref.contentHash) throw new Error("V23_EFFECTIVE_ENTRY_ID_CONFLICT");
  };
  inherited.forEach((entry) => { if (!removed.has(entry.ref.id)) put(entry); });
  added.forEach((entry) => put(entry));
  localCopies.forEach((entry) => put(entry, true));
  const semantic = new Map<string, V23ResolvedAffix>();
  for (const entry of entries.values()) {
    const previous = semantic.get(entry.payload.semanticContributionKey);
    if (previous && (previous.payload.stackingPolicy === "dedupe" || entry.payload.stackingPolicy === "dedupe")) throw new Error("V23_SEMANTIC_CONTRIBUTION_CONFLICT");
    semantic.set(entry.payload.semanticContributionKey, entry);
  }
  return [...entries.values()].sort((a, b) => compareUtf8(a.ref.id, b.ref.id));
}

export function deriveV23SkuPull(baselinePullKg: number, entries: readonly V23ResolvedAffix[], options: V23DerivationOptions = {}): V23SkuPullDerivation {
  const canonicalEntries = [...entries].sort((left, right) => compareUtf8(left.ref.id, right.ref.id) || left.ref.revision - right.ref.revision || compareUtf8(left.localCopyId ?? "", right.localCopyId ?? ""));
  const inputHash = jcsSha256Hex({ baselinePullKg, policy: options.publishedReductionPolicy ?? null, entries: canonicalEntries.map((e) => ({ ref: e.ref, localCopyId: e.localCopyId ?? null, copyHash: e.copyHash ?? null, payload: e.payload })) });
  if (!Number.isFinite(baselinePullKg) || baselinePullKg <= 0) return { status: "INVALID", code: "V23_TEMPLATE_PULL_INVALID", inputHash };
  if (options.formal && (!options.publishedReductionPolicy || options.publishedReductionPolicy.status !== "published" || options.publishedReductionPolicy.strategy !== "bidirectional_ratio" || options.publishedReductionPolicy.numericContract !== "ieee754-binary64-v1" || !hasCanonicalReductionPolicyIdentity(options.publishedReductionPolicy as ReductionStackingPolicyVersion))) return { status: "INVALID", code: "V23_OPEN_001_POLICY_VERSION_REQUIRED", inputHash };
  let value = baselinePullKg;
  const trace: V23PullTraceStep[] = [];
  const ordered = canonicalEntries.flatMap((entry) => entry.payload.enabled && entry.payload.category === "attribute" ? entry.payload.operations.map((operation) => ({ entry, operation })) : []).sort((left, right) => compareUtf8(left.entry.ref.id, right.entry.ref.id) || left.entry.ref.revision - right.entry.ref.revision || left.operation.operationIndex - right.operation.operationIndex || compareUtf8(left.operation.operationId, right.operation.operationId));
  const operationIdentity = new Set<string>();
  for (const { entry, operation } of ordered) { const identity = `${entry.ref.id}\u0000${entry.ref.revision}\u0000${operation.operationIndex}\u0000${operation.operationId}`; if (operationIdentity.has(identity)) return { status: "INVALID", code: "V23_OPERATION_IDENTITY_DUPLICATE", inputHash }; operationIdentity.add(identity); }
  const setOperations = ordered.filter(({ operation }) => (operation.parameterKey === "pull" || operation.parameterKey === "targetPullKg") && operation.operation === "set");
  if (setOperations.length > 1) return { status: "INVALID", code: "V23_AFFIX_SET_CONFLICT", inputHash };
  if (setOperations.length === 1) { const set = setOperations[0]!.operation as { value: unknown }; if (typeof set.value !== "number" || !Number.isFinite(set.value) || set.value <= 0) return { status: "INVALID", code: "V23_AFFIX_SET_INVALID", inputHash }; value = set.value; }
  let bonus = 0; let reduction = 0; let bonusExact = exact(0); let reductionExact = exact(0); const later: typeof ordered = [];
  for (const { entry, operation: op } of ordered) {
      if (op.parameterKey !== "pull" && op.parameterKey !== "targetPullKg") continue;
      if (op.operation === "set") continue;
      if (op.operation === "enum_add") return { status: "INVALID", code: "V23_DIRECT_PULL_PATCH_FORBIDDEN", inputHash };
      if (op.operation === "percent_adjust") { if (op.direction === "increase") { bonusExact = add(bonusExact, exact(op.magnitude)); bonus = Number(bonus + op.magnitude); if (anomaly(bonusExact, bonus)) return { status: "INVALID", code: "V23_BINARY64_OVERFLOW", inputHash }; } else { reductionExact = add(reductionExact, exact(op.magnitude)); reduction = Number(reduction + op.magnitude); if (anomaly(reductionExact, reduction)) return { status: "INVALID", code: "V23_BINARY64_OVERFLOW", inputHash }; } continue; }
      later.push({ entry, operation: op });
  }
  const ratioExact = div(mul(exact(value), add(exact(1), bonusExact)), add(exact(1), reductionExact));
  value = Number(Number(value * (1 + bonus)) / (1 + reduction));
  const ratioAnomaly = anomaly(ratioExact, value); if (ratioAnomaly) return { status: "INVALID", code: ratioAnomaly === "overflow" ? "V23_BINARY64_OVERFLOW" : "V23_BINARY64_UNDERFLOW_TO_ZERO", inputHash };
  if (value <= 0) return { status: "INVALID", code: "V23_PULL_DERIVATION_NON_FINITE", inputHash };
  let currentExact = ratioExact;
  const ratioOperations = ordered.filter(({ operation }) => operation.parameterKey === "pull" || operation.parameterKey === "targetPullKg").filter(({ operation }) => operation.operation === "percent_adjust").map(({ entry, operation }) => { const percent = operation as { operationId: string; operationIndex: number; direction: "increase" | "decrease"; magnitude: number }; return { affixId: entry.ref.id, operationId: percent.operationId, operationIndex: percent.operationIndex, direction: percent.direction, magnitude: percent.magnitude }; });
  if (ratioOperations.length) {
    const first = ratioOperations[0]!;
    trace.push({ affixId: first.affixId, operationId: first.operationId, operationIndex: first.operationIndex, operation: "percent_adjust", direction: first.direction, magnitude: first.magnitude, clampMin: null, clampMax: null, ratioOperations, beforeKg: baselinePullKg, afterKg: value, numericEvidence: evidence(baselinePullKg, value, ratioExact) });
  }
  const flat = later.filter(({ operation }) => operation.operation === "flat_adjust");
  let flatValue = 0; let flatExact = exact(0);
  for (const { operation } of flat) { const numeric = operation as Extract<typeof operation, { direction: "increase" | "decrease" }>; const signed = numeric.direction === "increase" ? numeric.magnitude : -numeric.magnitude; flatExact = add(flatExact, exact(signed)); flatValue = Number(flatValue + signed); const flatAnomaly = anomaly(flatExact, flatValue); if (flatAnomaly) return { status: "INVALID", code: flatAnomaly === "overflow" ? "V23_BINARY64_OVERFLOW" : "V23_BINARY64_UNDERFLOW_TO_ZERO", inputHash }; }
  if (flat.length) { const beforeKg = value; const nextExact = add(currentExact, flatExact); value = Number(value + flatValue); const flatAnomaly = anomaly(nextExact, value); if (flatAnomaly) return { status: "INVALID", code: flatAnomaly === "overflow" ? "V23_BINARY64_OVERFLOW" : "V23_BINARY64_UNDERFLOW_TO_ZERO", inputHash }; currentExact = nextExact; const last = flat.at(-1)!; const numeric = last.operation as Extract<typeof last.operation, { direction: "increase" | "decrease" }>; trace.push({ affixId: last.entry.ref.id, operationId: numeric.operationId, operationIndex: numeric.operationIndex, operation: "flat_adjust", direction: numeric.direction, magnitude: flatValue, clampMin: null, clampMax: null, ratioOperations: null, beforeKg, afterKg: value, numericEvidence: evidence(beforeKg, value, currentExact) }); }
  for (const { entry, operation: op } of later.filter(({ operation }) => operation.operation === "clamp_add")) {
      const numeric = op as { operationId: string; operationIndex: number; operation: "clamp_add"; direction: "increase" | "decrease"; magnitude: number; clampMin: number; clampMax: number };
      const beforeKg = value;
      const signed = numeric.direction === "increase" ? numeric.magnitude : -numeric.magnitude;
      const nextExact = add(currentExact, exact(signed)); const next = Number(value + signed); const nextAnomaly = anomaly(nextExact, next); if (nextAnomaly) return { status: "INVALID", code: nextAnomaly === "overflow" ? "V23_BINARY64_OVERFLOW" : "V23_BINARY64_UNDERFLOW_TO_ZERO", inputHash }; value = Math.min(numeric.clampMax, Math.max(numeric.clampMin, next)); currentExact = value === next ? nextExact : exact(value);
      if (!Number.isFinite(value) || value <= 0) return { status: "INVALID", code: "V23_PULL_DERIVATION_NON_FINITE", inputHash };
      trace.push({ affixId: entry.ref.id, operationId: numeric.operationId, operationIndex: numeric.operationIndex, operation: numeric.operation, direction: numeric.direction, magnitude: numeric.magnitude, clampMin: numeric.operation === "clamp_add" ? numeric.clampMin : null, clampMax: numeric.operation === "clamp_add" ? numeric.clampMax : null, ratioOperations: null, beforeKg, afterKg: value, numericEvidence: evidence(beforeKg, value, currentExact) });
  }
  return { status: "VALID", baselinePullKg, targetPullKg: value, effectiveEntryIds: canonicalEntries.map((e) => e.ref.id), trace, inputHash: jcsSha256Hex({ inputHash, targetPullKg: value, trace }) };
}
