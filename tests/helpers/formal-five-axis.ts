import {
  calculateFormalFiveAxisComponentSeries,
  createFormalFiveAxisVertexSet,
  createFormalModelFiveAxisPreview,
  hashFormalComponentValues,
  hashFormalFinalPanelValues,
} from "../../lib/five-axis-formal";
import { hashCandidateSemanticInput } from "../../lib/five-axis-hash";
import type {
  FiveAxisEntityInput,
  FiveAxisVertexCandidateSource,
  FiveAxisVertexGroupKey,
  FiveAxisViewDefinition,
  ModelComponentSelection,
  ModelFiveAxisPreview,
} from "../../lib/types";

const DIRECT_VALUES: Record<string, Record<string, string>> = {
  "part:rod": {
    pull: "10",
    durability: "80",
    cast: "100",
    sensitivity: "2",
    control: "0.8",
  },
  "part:reel": {
    pull: "12",
    durability: "90",
    sensitivity: "1.5",
    control: "0.6",
  },
  "part:line": {
    pull: "8",
    durability: "70",
    sensitivity: "2.5",
    control: "1",
  },
};

export function buildFormalComponentSelectionsFixture(
  componentSelections: ModelComponentSelection[],
): ModelComponentSelection[] {
  const parameterKeysByAxisId: Record<string, string> = {
    pull: "drag",
    durability: "durability",
    cast: "max_cast_distance",
    sensitivity: "sensitivity",
    control: "energy_cost_factor",
  };
  return componentSelections.map((component) => ({
    ...structuredClone(component),
    values: {
      ...structuredClone(component.values),
      ...Object.fromEntries(
        Object.entries(DIRECT_VALUES[component.itemPartId] ?? {}).map(
          ([axisId, rawValue]) => [
            parameterKeysByAxisId[axisId],
            Number(rawValue),
          ],
        ),
      ),
    },
  }));
}

export function buildFormalPreviewFixture(input: {
  definition: FiveAxisViewDefinition;
  snapshotId: string;
  modelId: string;
  modelRevision: number;
  seriesId: string;
  skuId: string;
  skuRevision: number;
  modelFinalPullKg: number;
  finalPanelValues: Record<string, number | string>;
  componentSelections: ModelComponentSelection[];
  weightBandId?: string;
}): ModelFiveAxisPreview {
  const weightBandId = input.weightBandId ?? "W2";
  const finalPanelHash = hashFormalFinalPanelValues(input.finalPanelValues);
  const candidateSources: FiveAxisVertexCandidateSource[] =
    input.componentSelections.map((component) => {
      const componentInputHash = hashFormalComponentValues(component);
      const directInputs = input.definition.axes.flatMap((axis) => {
        if (!axis.applicablePartIds.includes(component.itemPartId)) return [];
        const parameterKey = axis.sourceParameterKeys[0];
        const rawValue = component.values[parameterKey];
        return typeof rawValue !== "number" && typeof rawValue !== "string"
          ? []
          : [{
              axisId: axis.axisId,
              parameterKey,
              rawValue: String(rawValue),
              unit: "unit",
              inputHash: componentInputHash,
              axisOrder: axis.order,
            }];
      });
      const semantic = hashCandidateSemanticInput({
        finalPanelHash,
        modelFinalPullKg: String(input.modelFinalPullKg),
        directInputs,
      });
      return {
        candidateSemanticKey: {
          modelId: input.modelId,
          componentEntityId: component.componentId,
          itemPartId: component.itemPartId,
        },
        snapshotId: input.snapshotId,
        modelRevisionId: `${input.modelId}@${input.modelRevision}`,
        finalPanelHash,
        modelFinalPullKg: String(input.modelFinalPullKg),
        directInputs: directInputs.map((entry) => ({
          axisId: entry.axisId,
          parameterKey: entry.parameterKey,
          rawValue: entry.rawValue,
          unit: entry.unit,
          inputHash: entry.inputHash,
        })),
        semanticInputHash: semantic.hash,
      };
    });
  const groupKey: FiveAxisVertexGroupKey = {
    weightBandId,
    weightBandPolicyVersion: input.definition.weightBandPolicyVersion,
    fiveAxisDefinitionId: input.definition.definitionId,
    fiveAxisDefinitionVersion: input.definition.version,
    fiveAxisRuleVersion: input.definition.fiveAxisRuleVersion,
  };
  const vertexSet = createFormalFiveAxisVertexSet({
    definition: input.definition,
    groupKey,
    candidateSources,
  });
  const entities: FiveAxisEntityInput[] = input.componentSelections.map((component) => ({
    entityId: component.componentId,
    itemPartId: component.itemPartId,
    label: component.name,
    fishWeightGradeId: weightBandId,
    values: Object.fromEntries(
      input.definition.axes.flatMap((axis) => {
        const parameterKey = axis.sourceParameterKeys[0];
        const rawValue = component.values[parameterKey];
        return typeof rawValue !== "number"
          ? []
          : [[parameterKey, rawValue]];
      }),
    ),
  }));
  const rod = calculateFormalFiveAxisComponentSeries({
    definition: input.definition,
    vertexSet,
    entity: entities[0],
  });
  const componentSeries = [
    rod,
    ...entities.slice(1).map((entity) =>
      calculateFormalFiveAxisComponentSeries({
        definition: input.definition,
        vertexSet,
        entity,
        referenceRodSeries: rod,
      })),
  ];
  return createFormalModelFiveAxisPreview({
    definition: input.definition,
    vertexSet,
    modelId: input.modelId,
    modelRevisionId: `${input.modelId}@${input.modelRevision}`,
    modelFinalPullKg: input.modelFinalPullKg,
    finalPanelHash,
    componentSelections: input.componentSelections,
    componentSeries,
    projectionReferenceAnchor: {
      baselineSnapshotId: input.snapshotId,
      seriesId: input.seriesId,
      skuId: input.skuId,
      skuRevisionId: `${input.skuId}@${input.skuRevision}`,
      selectorVersion: "projection-reference/current-sku-frozen-match/v1",
    },
    projectionReferences: ["part:rod", "part:reel", "part:line"].map(
      (itemPartId, index) => ({
        itemPartId,
        state: "available" as const,
        projectionMatchId: `projection-match:${index + 1}`,
        projectionMatchRevisionId: `projection-match:${index + 1}@1`,
        projectionId: `projection:${index + 1}`,
        projectionRevisionId: `projection:${index + 1}@1`,
      }),
    ),
  });
}
