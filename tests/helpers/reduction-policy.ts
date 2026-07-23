import type {
  AffixRuntimeEvidence,
  DerivedProjection,
  ReductionStackingPolicyVersion,
} from "../../lib/types";
import { hashAffixRuntimeEvidence } from "../../lib/reduction-stacking-policy";

export function testReductionPolicy(): ReductionStackingPolicyVersion {
  return {
    id: "test:reduction-policy",
    version: "test:reduction-policy:published",
    status: "published",
    strategy: "bidirectional_ratio",
    numericContract: "ieee754-binary64-v1",
    operationOrder: [
      "set",
      "percent_adjust",
      "flat_adjust",
      "clamp_add",
      "final_review_patch",
      "parameter_definition",
    ],
    source: {
      workbookRefId: "feishu-workbook:tackle-design",
      sheetId: "zrVOxd",
      sourceRevisionId: "test:feishu-revision",
      sourceRevision: "test:machine-revision",
      ruleId: "OPEN-001:bidirectional-ratio",
      parameterKey: "*",
    },
    issues: [],
    inputHash: "test:reduction-policy:published",
    createdAt: "2026-07-23T00:00:00.000Z",
    publishedAt: "2026-07-23T00:01:00.000Z",
    publishedBy: "test",
  };
}

export function formalProjection(
  projection: DerivedProjection,
  policy = testReductionPolicy(),
): DerivedProjection {
  return {
    ...structuredClone(projection),
    reductionStackingPolicyVersion: policy.version,
    formalStatus: "FORMAL",
  };
}

export function formalAffixRuntimeEvidence(
  projection: DerivedProjection,
  policy = testReductionPolicy(),
  finalValues: Record<string, number | string> = projection.values,
): AffixRuntimeEvidence {
  const evidence = {
    reductionStackingPolicyVersion: policy.version,
    values: structuredClone(finalValues),
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
