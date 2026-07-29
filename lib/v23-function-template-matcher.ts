import type { V23FunctionTemplateRef, V23MatchedTemplateKey, V23SkuMatch } from "./types";
import { jcsSha256Hex } from "./canonical-json";

/** The only Phase-B input accepted from 04.5.  No range or display-name fields
 * are intentionally present: adding one must not silently change matching. */
export interface V23FunctionTemplateCandidate {
  ref: V23FunctionTemplateRef;
  key: V23MatchedTemplateKey;
  /** 04.5 benchmark pull, before SKU effective-affix settlement. */
  baselinePullKg: number;
}

export function v23MatchedTemplateKey(part: Pick<V23MatchedTemplateKey, "partType" | "weightBandId" | "fishingMethodId" | "materialTypeId" | "functionProfileId" | "functionIntensity">): V23MatchedTemplateKey {
  return { partType: part.partType, weightBandId: part.weightBandId, fishingMethodId: part.fishingMethodId, materialTypeId: part.materialTypeId, functionProfileId: part.functionProfileId, functionIntensity: part.functionIntensity };
}

export function matchV23FunctionTemplate(key: V23MatchedTemplateKey, candidates: readonly V23FunctionTemplateCandidate[]): V23SkuMatch {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || !candidate.ref || !candidate.key || !/^[a-f0-9]{64}$/.test(candidate.ref.contentHash) || !Number.isFinite(candidate.baselinePullKg) || candidate.baselinePullKg <= 0) throw new Error("V23_FUNCTION_TEMPLATE_CANDIDATE_INVALID");
  }
  const inputFingerprint = jcsSha256Hex(key);
  const same = candidates.filter((candidate) =>
    candidate.key.partType === key.partType && candidate.key.weightBandId === key.weightBandId &&
    candidate.key.fishingMethodId === key.fishingMethodId && candidate.key.materialTypeId === key.materialTypeId &&
    candidate.key.functionProfileId === key.functionProfileId && candidate.key.functionIntensity === key.functionIntensity,
  );
  if (same.length === 0) return { status: "INVALID_NO_MATCH", attemptedKey: key, inputFingerprint };
  if (same.length !== 1) return { status: "INVALID_AMBIGUOUS", attemptedKey: key, inputFingerprint };
  const candidate = same[0]!;
  if (!Number.isFinite(candidate.baselinePullKg) || candidate.baselinePullKg <= 0) {
    return { status: "INVALID_NO_MATCH", attemptedKey: key, inputFingerprint };
  }
  return { status: "VALID", functionTemplateRef: candidate.ref, matchedKey: key, inputFingerprint };
}
