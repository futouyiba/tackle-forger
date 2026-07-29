import type { ReductionStackingPolicyVersion, V23ProjectAffixPayload, V23StableContentRef } from "./types";
import { jcsSha256Hex } from "./canonical-json";

export interface V23ResolvedAffix { ref: V23StableContentRef; payload: V23ProjectAffixPayload; localCopyId?: string; copyHash?: string; }
export interface V23PullTraceStep { affixId: string; operationId: string; operationIndex: number; operation: "percent_adjust" | "flat_adjust" | "clamp_add"; direction: "increase" | "decrease"; magnitude: number; clampMin: number | null; clampMax: number | null; beforeKg: number; afterKg: number; }
export type V23SkuPullDerivation =
  | { status: "VALID"; baselinePullKg: number; targetPullKg: number; effectiveEntryIds: string[]; trace: V23PullTraceStep[]; inputHash: string }
  | { status: "INVALID"; code: string; inputHash: string };

export type V23CanonicalModelPatchOperation = "set" | "add" | "multiply" | "clear";
export interface V23ModelPatchInput { operation: V23CanonicalModelPatchOperation; parameterKey: string; }
export interface V23DerivationOptions { formal?: boolean; publishedReductionPolicy?: Pick<ReductionStackingPolicyVersion, "id" | "version" | "contentHash" | "status" | "strategy" | "numericContract"> | null; }

const V23_STRUCTURAL_PULL_KEYS: Record<"rod" | "reel" | "line", string> = {
  rod: "rodPullKg", reel: "reelPullKg", line: "linePullKg",
};

/** Model patches may never turn a derived v23 structural pull into input.
 * Unknown shapes are rejected rather than assumed harmless at this boundary. */
export function validateV23ModelPatchForPull(partType: "rod" | "reel" | "line", value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("V23_MODEL_PATCH_SCHEMA_INVALID");
  const patch = value as Record<string, unknown>;
  if (typeof patch.operation !== "string" || !["set", "add", "multiply", "clear"].includes(patch.operation) || typeof patch.parameterKey !== "string" || patch.parameterKey.length === 0) throw new Error("V23_MODEL_PATCH_SCHEMA_INVALID");
  if (patch.parameterKey === V23_STRUCTURAL_PULL_KEYS[partType]) throw new Error("V23_MODEL_PATCH_PULL_FORBIDDEN");
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
  return [...entries.values()].sort((a, b) => a.ref.id.localeCompare(b.ref.id));
}

export function deriveV23SkuPull(baselinePullKg: number, entries: readonly V23ResolvedAffix[], options: V23DerivationOptions = {}): V23SkuPullDerivation {
  const inputHash = jcsSha256Hex({ baselinePullKg, policy: options.publishedReductionPolicy ?? null, entries: entries.map((e) => ({ ref: e.ref, localCopyId: e.localCopyId ?? null, copyHash: e.copyHash ?? null, payload: e.payload })) });
  if (!Number.isFinite(baselinePullKg) || baselinePullKg <= 0) return { status: "INVALID", code: "V23_TEMPLATE_PULL_INVALID", inputHash };
  if (options.formal && (!options.publishedReductionPolicy || options.publishedReductionPolicy.status !== "published" || options.publishedReductionPolicy.strategy !== "bidirectional_ratio" || options.publishedReductionPolicy.numericContract !== "ieee754-binary64-v1")) return { status: "INVALID", code: "V23_OPEN_001_POLICY_VERSION_REQUIRED", inputHash };
  let value = baselinePullKg;
  const trace: V23PullTraceStep[] = [];
  const ordered = entries.flatMap((entry) => entry.payload.enabled && entry.payload.category === "attribute" ? entry.payload.operations.map((operation) => ({ entry, operation })) : []).sort((left, right) => left.entry.ref.id.localeCompare(right.entry.ref.id) || left.entry.ref.revision - right.entry.ref.revision || left.operation.operationIndex - right.operation.operationIndex || left.operation.operationId.localeCompare(right.operation.operationId));
  let bonus = 0; let reduction = 0; const later: typeof ordered = [];
  for (const { entry, operation: op } of ordered) {
      if (op.parameterKey !== "pull" && op.parameterKey !== "targetPullKg") continue;
      if (op.operation === "set" || op.operation === "enum_add") return { status: "INVALID", code: "V23_DIRECT_PULL_PATCH_FORBIDDEN", inputHash };
      if (op.operation === "percent_adjust") { if (op.direction === "increase") bonus += op.magnitude; else reduction += op.magnitude; continue; }
      later.push({ entry, operation: op });
  }
  value = baselinePullKg * (1 + bonus) / (1 + reduction);
  if (!Number.isFinite(value) || value <= 0) return { status: "INVALID", code: "V23_PULL_DERIVATION_NON_FINITE", inputHash };
  for (const { entry, operation: op } of later) {
      const numeric = op as Extract<typeof op, { direction: "increase" | "decrease" }>;
      const beforeKg = value;
      const signed = numeric.direction === "increase" ? numeric.magnitude : -numeric.magnitude;
      if (op.operation === "percent_adjust") value *= 1 + signed / 100;
      else if (op.operation === "flat_adjust") value += signed;
      else if (op.operation === "clamp_add") value = Math.min(op.clampMax, Math.max(op.clampMin, value + signed));
      else return { status: "INVALID", code: "V23_DIRECT_PULL_PATCH_FORBIDDEN", inputHash };
      if (!Number.isFinite(value) || value <= 0) return { status: "INVALID", code: "V23_PULL_DERIVATION_NON_FINITE", inputHash };
      trace.push({ affixId: entry.ref.id, operationId: numeric.operationId, operationIndex: numeric.operationIndex, operation: numeric.operation, direction: numeric.direction, magnitude: numeric.magnitude, clampMin: numeric.operation === "clamp_add" ? numeric.clampMin : null, clampMax: numeric.operation === "clamp_add" ? numeric.clampMax : null, beforeKg, afterKg: value });
  }
  return { status: "VALID", baselinePullKg, targetPullKg: value, effectiveEntryIds: entries.map((e) => e.ref.id), trace, inputHash: jcsSha256Hex({ inputHash, targetPullKg: value, trace }) };
}
