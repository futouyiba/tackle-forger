import type { V23ProjectAffixPayload, V23StableContentRef } from "./types";
import { jcsSha256Hex } from "./canonical-json";

export interface V23ResolvedAffix { ref: V23StableContentRef; payload: V23ProjectAffixPayload; }
export interface V23PullTraceStep { affixId: string; operationId: string; beforeKg: number; afterKg: number; }
export type V23SkuPullDerivation =
  | { status: "VALID"; baselinePullKg: number; targetPullKg: number; effectiveEntryIds: string[]; trace: V23PullTraceStep[]; inputHash: string }
  | { status: "INVALID"; code: string; inputHash: string };

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
  return [...entries.values()].sort((a, b) => a.ref.id.localeCompare(b.ref.id));
}

export function deriveV23SkuPull(baselinePullKg: number, entries: readonly V23ResolvedAffix[]): V23SkuPullDerivation {
  const inputHash = jcsSha256Hex({ baselinePullKg, entries: entries.map((e) => e.ref) });
  if (!Number.isFinite(baselinePullKg) || baselinePullKg <= 0) return { status: "INVALID", code: "V23_TEMPLATE_PULL_INVALID", inputHash };
  let value = baselinePullKg;
  const trace: V23PullTraceStep[] = [];
  for (const entry of entries) {
    if (!entry.payload.enabled || entry.payload.category !== "attribute") continue;
    for (const op of entry.payload.operations) {
      if (op.parameterKey !== "pull" && op.parameterKey !== "targetPullKg") continue;
      const beforeKg = value;
      if (op.operation === "set" || op.operation === "enum_add") return { status: "INVALID", code: "V23_DIRECT_PULL_PATCH_FORBIDDEN", inputHash };
      const signed = op.direction === "increase" ? op.magnitude : -op.magnitude;
      if (op.operation === "percent_adjust") value *= 1 + signed / 100;
      else if (op.operation === "flat_adjust") value += signed;
      else if (op.operation === "clamp_add") value = Math.min(op.clampMax, Math.max(op.clampMin, value + signed));
      else return { status: "INVALID", code: "V23_DIRECT_PULL_PATCH_FORBIDDEN", inputHash };
      if (!Number.isFinite(value) || value <= 0) return { status: "INVALID", code: "V23_PULL_DERIVATION_NON_FINITE", inputHash };
      trace.push({ affixId: entry.ref.id, operationId: op.operationId, beforeKg, afterKg: value });
    }
  }
  return { status: "VALID", baselinePullKg, targetPullKg: value, effectiveEntryIds: entries.map((e) => e.ref.id), trace, inputHash: jcsSha256Hex({ inputHash, targetPullKg: value, trace }) };
}
