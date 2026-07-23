import type {
  AffixRuntimeEvidence,
  DerivedProjection,
  ReductionStackingPolicyVersion,
} from "../../lib/types";
import { hashAffixRuntimeEvidence } from "../../lib/reduction-stacking-policy";
import { reductionPolicyContentHash } from "../../lib/reduction-stacking-policy";

export function testReductionPolicy(): ReductionStackingPolicyVersion {
  const content = {
    strategy: "bidirectional_ratio" as const,
    numericContract: "ieee754-binary64-v1" as const,
    operationOrder: [
      "set",
      "percent_adjust",
      "flat_adjust",
      "clamp_add",
      "final_review_patch",
      "parameter_definition",
    ] as ReductionStackingPolicyVersion["operationOrder"],
    source: {
      workbookRefId: "feishu-workbook:tackle-design" as const,
      sheetId: "zrVOxd" as const,
      sourceRevisionId: "test:feishu-revision",
      sourceRevision: "test:machine-revision",
      ruleId: "OPEN-001:bidirectional-ratio",
      parameterKey: "*",
    },
  };
  const contentHash = reductionPolicyContentHash(content);
  return {
    id: `reduction-policy:bidirectional-ratio:${contentHash.slice(0, 16)}`,
    version: contentHash,
    status: "published",
    ...content,
    issues: [],
    contentHash,
    inputHash: contentHash,
    createdAt: "2026-07-23T00:00:00.000Z",
    publishedAt: "2026-07-23T00:01:00.000Z",
    publishedBy: "test",
  };
}

export function formalProjection(
  projection: DerivedProjection,
  policy = testReductionPolicy(),
  finalValues: Record<string, number | string> = projection.values,
): DerivedProjection {
  const cloned = structuredClone(projection);
  delete cloned.affixRuntimeEvidence;
  const evidence = formalAffixRuntimeEvidence(cloned, policy, finalValues);
  return {
    ...cloned,
    reductionStackingPolicyVersion: policy.version,
    formalStatus: "FORMAL",
    affixRuntimeEvidence: evidence,
  };
}

export function formalAffixRuntimeEvidence(
  projection: DerivedProjection,
  policy = testReductionPolicy(),
  finalValues: Record<string, number | string> = projection.values,
): AffixRuntimeEvidence {
  if (
    projection.affixRuntimeEvidence
    && projection.affixRuntimeEvidence.reductionStackingPolicyVersion === policy.version
  ) {
    return structuredClone(projection.affixRuntimeEvidence);
  }
  const evidence = {
    reductionStackingPolicyVersion: policy.version,
    values: structuredClone(finalValues),
    postReviewValues: structuredClone(finalValues),
    finalValues: structuredClone(finalValues),
    trace: structuredClone(
      projection.trace.find((step) => step.layer === "attribute_affix")?.contributions ?? [],
    ),
    issues: [],
  };
  return {
    ...evidence,
    formalStatus: "FORMAL",
    traceHash: hashAffixRuntimeEvidence(evidence),
  };
}
