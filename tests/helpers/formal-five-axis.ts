import {
  calculateFormalFiveAxisComponentSeries,
  createFormalFiveAxisVertexSet,
  createFormalModelFiveAxisPreview,
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
      const values = DIRECT_VALUES[component.itemPartId];
      if (!values) throw new Error(`测试夹具不支持部位 ${component.itemPartId}。`);
      const directInputs = input.definition.axes.flatMap((axis, index) => {
        const rawValue = values[axis.axisId];
        return rawValue === undefined
          ? []
          : [{
              axisId: axis.axisId,
              parameterKey: axis.sourceParameterKeys[0],
              rawValue,
              unit: "unit",
              inputHash: String(index + 1).repeat(64),
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
        const rawValue = DIRECT_VALUES[component.itemPartId]?.[axis.axisId];
        return rawValue === undefined
          ? []
          : [[axis.sourceParameterKeys[0], Number(rawValue)]];
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
