import { deterministicHash } from "../../lib/rule-kernel";
import {
  fiveAxisDispositionCatalogHash,
  formalFiveAxisPreviewInputHash,
  formalProjectionReferenceSetHash,
  calculateModelFiveAxisPreview,
  createFiveAxisVertexSet,
} from "../../lib/five-axis";
import type { FiveAxisViewDefinition, ModelFiveAxisPreview } from "../../lib/types";

const PARTS = ["part:rod", "part:reel", "part:line"];
const SELECTOR = "projection-reference/current-sku-frozen-match/v1" as const;

/** Minimal OPEN-005 evidence for tests that exercise unrelated formal publish gates. */
export function formalFiveAxisPublishEvidence(input: {
  preview: ModelFiveAxisPreview;
  modelId: string;
  modelRevision: number;
  seriesId: string;
  skuId: string;
  skuRevision: number;
  snapshotId: string;
  finalPanelValues: Record<string, number | string>;
}) {
  const axis = (axisId: string, parameterKey: string, order: number, applicablePartIds: string[], direction: "higher_better" | "lower_better", vertexSelectorId: "max" | "min", missingPolicy: "error" | "ignore_not_applicable", inherited = false) => ({
    axisId, label: axisId, order, sourceParameterKeys: [parameterKey], applicablePartIds, direction,
    transformId: "identity", vertexSelectorId, componentAggregationId: "per_component_no_aggregate" as const,
    ...(inherited ? { contextInheritanceId: "single_applicable_source" as const } : {}), missingPolicy,
  });
  const definitionContent = {
    definitionId: "five-axis:formal-test", version: "1", revision: 1, publicationState: "PUBLISHED" as const,
    semanticContractVersion: "five-axis/open005-2026-07-23/v1" as const, hashInputSchemaVersion: "five-axis-hash-input/v1" as const,
    projectionReferenceSelectorVersion: SELECTOR, fiveAxisRuleVersion: "rule:formal-test", sourceRevision: "source:formal-test",
    weightBandPolicyVersion: "wb:formal-test", displayBandConfigId: "display:formal-test",
    axes: [axis("pull", "drag", 1, PARTS, "higher_better", "max", "error"), axis("durability", "durability", 2, PARTS, "higher_better", "max", "error"), axis("cast", "max_cast_distance", 3, ["part:rod"], "higher_better", "max", "ignore_not_applicable", true), axis("sensitivity", "sensitivity", 4, PARTS, "lower_better", "min", "error"), axis("control", "energy_cost_factor", 5, PARTS, "lower_better", "min", "error")],
    seriesBaselinePolicy: { mode: "projection_reference" as const, selectorVersion: SELECTOR },
    comparisonPolicy: { minimumItems: 2, maximumItems: 5, mixedItemPartsAllowed: true, referenceRodMode: "first_rod_by_comparison_order" as const, outerRingScore: 100, visualOverflowCap: null },
  };
  const definition = { ...definitionContent, definitionHash: deterministicHash(definitionContent) } as FiveAxisViewDefinition;
  const disposition = { definitionId: definition.definitionId, definitionVersion: definition.version, definitionHash: definition.definitionHash, effectiveUse: "FORMAL_CURRENT" as const, semanticContractVersion: "five-axis/open005-2026-07-23/v1" as const, supersededByDefinitionId: null, supersededByDefinitionVersion: null, reasonCode: "TEST" };
  const catalog = { catalogRevisionId: "catalog:formal-test", previousCatalogRevisionId: null, previousCatalogHash: null, schemaVersion: "five-axis-definition-disposition-catalog/v1" as const, entries: [disposition], decidedAt: "2026-07-24T00:00:00.000Z", catalogHash: "" };
  catalog.catalogHash = fiveAxisDispositionCatalogHash(catalog);
  const anchor = { baselineSnapshotId: input.snapshotId, seriesId: input.seriesId, skuId: input.skuId, skuRevisionId: String(input.skuRevision), selectorVersion: SELECTOR };
  const references = PARTS.map((itemPartId) => ({ itemPartId: itemPartId as "part:rod" | "part:reel" | "part:line", state: "missing" as const, projectionMatchId: null, projectionMatchRevisionId: null, projectionId: null, projectionRevisionId: null }));
  const componentInputs = PARTS.map((itemPartId, index) => ({ entityId: `${input.modelId}:${itemPartId}`, itemPartId, label: itemPartId, fishWeightGradeId: input.preview.fishWeightGradeId, values: { drag: 100 + index, durability: 100 + index, max_cast_distance: 100 + index, sensitivity: 1 + index / 10, energy_cost_factor: 1 + index / 10 } }));
  const vertexSet = createFiveAxisVertexSet({ definition, fishWeightGradeId: input.preview.fishWeightGradeId, referenceComponents: componentInputs });
  const calculated = calculateModelFiveAxisPreview({ modelId: input.modelId, modelRevision: input.modelRevision, referenceFishWeightGradeId: input.preview.fishWeightGradeId, definition, vertexSet, components: componentInputs, finalPanelHash: deterministicHash(input.finalPanelValues) });
  const preview = { ...calculated, formalVertexSet: vertexSet, projectionReferenceAnchor: anchor, projectionReferences: references, projectionReferenceSetHash: formalProjectionReferenceSetHash({ anchor, references }), inputHash: "" } as ModelFiveAxisPreview;
  preview.inputHash = formalFiveAxisPreviewInputHash(preview);
  return { fiveAxisPreview: preview, fiveAxisDefinition: definition, formalFiveAxisVertexSet: vertexSet, fiveAxisDefinitions: [definition], fiveAxisDispositionCatalogRevisions: [catalog], currentFiveAxisDispositionCatalogRevisionId: catalog.catalogRevisionId };
}
