import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFormalEquipmentComparison,
  createFormalFiveAxisVertexSet,
  createFormalFiveAxisViewDefinition,
} from "../lib/five-axis-formal";
import { hashCandidateSemanticInput } from "../lib/five-axis-hash";
import {
  applyFiveAxisTransactionComponent,
  buildEligibleFiveAxisCandidateMembership,
  createFiveAxisCandidateDeltas,
  createFiveAxisLifecycleCandidateDeltas,
  executeFiveAxisTransactionPlan,
  executeFiveAxisSnapshotBatchTransactions,
  planFiveAxisTransactions,
} from "../lib/five-axis-transactions";
import {
  assertSnapshotBatchCanConfirm,
  planSnapshotBatch,
  planSnapshotBatchFiveAxisTransactions,
} from "../lib/snapshot-batch";
import { createSeedState } from "../lib/seed";
import { deterministicHash } from "../lib/rule-kernel";
import type {
  FiveAxisCandidateMembership,
  FiveAxisEntityInput,
  FiveAxisVertexCandidateSource,
  FiveAxisVertexGroupKey,
  FiveAxisViewDefinition,
} from "../lib/types";

const ZERO_HASH = "0".repeat(64);

function groupKey(
  definition: FiveAxisViewDefinition,
  weightBandId: string,
): FiveAxisVertexGroupKey {
  return {
    weightBandId,
    weightBandPolicyVersion: definition.weightBandPolicyVersion,
    fiveAxisDefinitionId: definition.definitionId,
    fiveAxisDefinitionVersion: definition.version,
    fiveAxisRuleVersion: definition.fiveAxisRuleVersion,
  };
}

function source(input: {
  definition: FiveAxisViewDefinition;
  modelId: string;
  snapshotId: string;
  itemPartId?: string;
  componentEntityId?: string;
  values?: Partial<Record<string, string>>;
}): FiveAxisVertexCandidateSource {
  const values: Record<string, string | undefined> = {
    pull: "10",
    durability: "80",
    cast: "100",
    sensitivity: "2",
    control: "0.8",
    ...input.values,
  };
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
    finalPanelHash: ZERO_HASH,
    modelFinalPullKg: "1.5",
    directInputs,
  });
  return {
    candidateSemanticKey: {
      modelId: input.modelId,
      componentEntityId: input.componentEntityId ?? `${input.modelId}:component`,
      itemPartId: input.itemPartId ?? "part:rod",
    },
    snapshotId: input.snapshotId,
    modelRevisionId: `${input.modelId}@1`,
    finalPanelHash: ZERO_HASH,
    modelFinalPullKg: "1.5",
    directInputs: directInputs.map((entry) => ({
      axisId: entry.axisId,
      parameterKey: entry.parameterKey,
      rawValue: entry.rawValue,
      unit: entry.unit,
      inputHash: entry.inputHash,
    })),
    semanticInputHash: semantic.hash,
  };
}

function membership(
  definition: FiveAxisViewDefinition,
  weightBandId: string,
  modelId: string,
  snapshotId = `snapshot:${modelId}`,
): FiveAxisCandidateMembership {
  return {
    groupKey: groupKey(definition, weightBandId),
    candidateSources: [source({ definition, modelId, snapshotId })],
  };
}

test("候选资格统一生成 ADD/REPLACE/REMOVE，跨 W 段替换展开为成对迁移", () => {
  const definition = createFormalFiveAxisViewDefinition();
  const added = createFiveAxisCandidateDeltas({
    changeId: "change:add",
    modelId: "model:a",
    before: null,
    after: membership(definition, "W1", "model:a"),
  });
  assert.deepEqual(added.map((delta) => delta.operation), ["ADD"]);
  const replaced = createFiveAxisCandidateDeltas({
    changeId: "change:replace",
    modelId: "model:a",
    before: membership(definition, "W1", "model:a", "snapshot:a:1"),
    after: membership(definition, "W1", "model:a", "snapshot:a:2"),
  });
  assert.deepEqual(replaced.map((delta) => delta.operation), ["REPLACE"]);
  const migrated = createFiveAxisCandidateDeltas({
    changeId: "change:migrate",
    modelId: "model:a",
    before: membership(definition, "W1", "model:a"),
    after: membership(definition, "W2", "model:a"),
  });
  assert.deepEqual(migrated.map((delta) => delta.operation), ["REMOVE", "ADD"]);
  assert.equal(migrated[0].migrationId, migrated[1].migrationId);
  const removed = createFiveAxisCandidateDeltas({
    changeId: "change:remove",
    modelId: "model:a",
    before: membership(definition, "W2", "model:a"),
    after: null,
  });
  assert.deepEqual(removed.map((delta) => delta.operation), ["REMOVE"]);
  assert.deepEqual(createFiveAxisLifecycleCandidateDeltas({
    changeId: "lifecycle:archive",
    modelId: "model:a",
    beforeLifecycle: "ACTIVE",
    afterLifecycle: "ARCHIVED",
    frozenMembership: membership(definition, "W2", "model:a"),
  }).map((delta) => delta.operation), ["REMOVE"]);
  assert.deepEqual(createFiveAxisLifecycleCandidateDeltas({
    changeId: "lifecycle:deprecated-to-archived",
    modelId: "model:a",
    beforeLifecycle: "DEPRECATED",
    afterLifecycle: "ARCHIVED",
    frozenMembership: membership(definition, "W2", "model:a"),
  }), []);
});

test("候选池只接受 ACTIVE Model 明确指向的当前冻结 Snapshot", () => {
  const definition = createFormalFiveAxisViewDefinition();
  const candidate = source({
    definition,
    modelId: "model:a",
    snapshotId: "snapshot:current",
  });
  assert.ok(buildEligibleFiveAxisCandidateMembership({
    modelId: "model:a",
    lifecycle: "ACTIVE",
    configurationSnapshotId: "snapshot:current",
    frozenSnapshotId: "snapshot:current",
    groupKey: groupKey(definition, "W1"),
    candidateSources: [candidate],
  }));
  assert.equal(buildEligibleFiveAxisCandidateMembership({
    modelId: "model:a",
    lifecycle: "DEPRECATED",
    configurationSnapshotId: "snapshot:current",
    frozenSnapshotId: "snapshot:current",
    groupKey: groupKey(definition, "W1"),
    candidateSources: [candidate],
  }), null);
  assert.throws(() => buildEligibleFiveAxisCandidateMembership({
    modelId: "model:a",
    lifecycle: "ACTIVE",
    configurationSnapshotId: "snapshot:current",
    frozenSnapshotId: "snapshot:historical",
    groupKey: groupKey(definition, "W1"),
    candidateSources: [candidate],
  }), /当前明确指向/);
});

test("跨组迁移按依赖图形成连通分量，无路径 W5 保持独立事务", () => {
  const definition = createFormalFiveAxisViewDefinition();
  const deltas = [
    ...createFiveAxisCandidateDeltas({
      changeId: "move:a",
      modelId: "model:a",
      before: membership(definition, "W1", "model:a"),
      after: membership(definition, "W2", "model:a"),
    }),
    ...createFiveAxisCandidateDeltas({
      changeId: "move:b",
      modelId: "model:b",
      before: membership(definition, "W2", "model:b"),
      after: membership(definition, "W3", "model:b"),
    }),
    ...createFiveAxisCandidateDeltas({
      changeId: "add:c",
      modelId: "model:c",
      before: null,
      after: membership(definition, "W5", "model:c"),
    }),
  ];
  const plan = planFiveAxisTransactions({ deltas });
  assert.equal(plan.components.length, 2);
  assert.deepEqual(
    plan.components.map((component) =>
      component.groupKeys.map((key) => key.weightBandId)),
    [["W1", "W2", "W3"], ["W5"]],
  );
});

test("一个连通分量原子回滚，不回滚已提交的独立分量", () => {
  const definition = createFormalFiveAxisViewDefinition();
  const deltas = [
    ...createFiveAxisCandidateDeltas({
      changeId: "add:w1",
      modelId: "model:w1",
      before: null,
      after: membership(definition, "W1", "model:w1"),
    }),
    ...createFiveAxisCandidateDeltas({
      changeId: "add:w5",
      modelId: "model:w5",
      before: null,
      after: membership(definition, "W5", "model:w5"),
    }),
  ];
  const plan = planFiveAxisTransactions({ deltas });
  const result = executeFiveAxisTransactionPlan({
    plan,
    definitions: [definition],
    currentGroupStates: [],
    failComponentIds: [plan.components[1].componentId],
  });
  assert.deepEqual(result.componentResults.map((entry) => entry.state), [
    "committed", "rolled_back",
  ]);
  assert.deepEqual(result.groupStates.map((state) =>
    state.groupKey.weightBandId), ["W1"]);
  assert.equal(result.vertexSets.length, 1);
});

test("Snapshot、Model 指针与顶点在分量内共同提交或共同回滚", () => {
  const state = createSeedState();
  const definition = createFormalFiveAxisViewDefinition();
  const sourceModel = state.purchasableModels.find((model) =>
    model.configurationSnapshotId)!;
  const sourceSnapshot = state.configurationSnapshots.find((snapshot) =>
    snapshot.id === sourceModel.configurationSnapshotId)!;
  const models = ["model:w1-commit", "model:w5-rollback"].map((modelId) => ({
    ...structuredClone(sourceModel),
    id: modelId,
    configurationSnapshotId: undefined,
  }));
  const memberships = [
    membership(definition, "W1", models[0].id, "snapshot:w1-commit"),
    membership(definition, "W5", models[1].id, "snapshot:w5-rollback"),
  ];
  const deltas = memberships.flatMap((after, index) =>
    createFiveAxisCandidateDeltas({
      changeId: `commit:${index}`,
      modelId: models[index].id,
      before: null,
      after,
    }));
  const plan = planFiveAxisTransactions({
    deltas,
    snapshotBuildModelIds: models.map((model) => model.id),
  });
  const snapshots = models.map((model, index) => {
    const content = {
      ...structuredClone(sourceSnapshot),
      id: memberships[index].candidateSources[0].snapshotId,
      modelId: model.id,
    };
    const withoutHash = { ...content };
    delete (withoutHash as Partial<typeof content>).contentHash;
    return {
      ...withoutHash,
      contentHash: deterministicHash(withoutHash),
    };
  });
  const result = executeFiveAxisSnapshotBatchTransactions({
    plan,
    definitions: [definition],
    currentGroupStates: [],
    currentVertexSets: [],
    currentModels: models,
    currentSnapshots: [],
    snapshotCommits: snapshots.map((snapshot) => ({
      modelId: snapshot.modelId,
      snapshot,
    })),
    failComponentIds: [plan.components[1].componentId],
  });
  assert.deepEqual(result.componentResults.map((entry) => entry.state), [
    "committed", "rolled_back",
  ]);
  assert.equal(
    result.models.find((model) => model.id === models[0].id)?.configurationSnapshotId,
    snapshots[0].id,
  );
  assert.equal(
    result.models.find((model) => model.id === models[1].id)?.configurationSnapshotId,
    undefined,
  );
  assert.deepEqual(result.snapshots.map((snapshot) => snapshot.id), [
    snapshots[0].id,
  ]);
  assert.deepEqual(result.groupStates.map((group) =>
    group.groupKey.weightBandId), ["W1"]);
});

test("SnapshotBuild 缺必需顶点时整分量回滚；纯 Lifecycle 移除则原子进入不可用", () => {
  const definition = createFormalFiveAxisViewDefinition();
  const incomplete = membership(definition, "W1", "model:incomplete");
  incomplete.candidateSources = [source({
    definition,
    modelId: "model:incomplete",
    snapshotId: "snapshot:incomplete",
    values: { cast: undefined },
  })];
  const addDeltas = createFiveAxisCandidateDeltas({
    changeId: "add:incomplete",
    modelId: "model:incomplete",
    before: null,
    after: incomplete,
  });
  const buildPlan = planFiveAxisTransactions({
    deltas: addDeltas,
    snapshotBuildModelIds: ["model:incomplete"],
  });
  const failed = executeFiveAxisTransactionPlan({
    plan: buildPlan,
    definitions: [definition],
    currentGroupStates: [],
  });
  assert.equal(failed.componentResults[0].state, "rolled_back");
  assert.match(failed.componentResults[0].error!, /FIVE_AXIS_VERTEX_BOOTSTRAP_INCOMPLETE/);
  assert.deepEqual(failed.groupStates, []);

  const completeMembership = membership(definition, "W1", "model:active");
  const seededPlan = planFiveAxisTransactions({
    deltas: createFiveAxisCandidateDeltas({
      changeId: "add:active",
      modelId: "model:active",
      before: null,
      after: completeMembership,
    }),
  });
  const seeded = executeFiveAxisTransactionPlan({
    plan: seededPlan,
    definitions: [definition],
    currentGroupStates: [],
  });
  const removePlan = planFiveAxisTransactions({
    deltas: createFiveAxisCandidateDeltas({
      changeId: "lifecycle:archive",
      modelId: "model:active",
      before: completeMembership,
      after: null,
    }),
  });
  const removed = executeFiveAxisTransactionPlan({
    plan: removePlan,
    definitions: [definition],
    currentGroupStates: seeded.groupStates,
  });
  assert.equal(removed.componentResults[0].state, "committed");
  assert.equal(removed.groupStates[0].state, "UNAVAILABLE_NO_ELIGIBLE_CANDIDATE");
  assert.equal(removed.groupStates[0].currentVertexSetHash, null);
});

test("并发期望同时校验 vertex、evidence 与 Snapshot 指针集合", () => {
  const definition = createFormalFiveAxisViewDefinition();
  const firstMembership = membership(definition, "W1", "model:a");
  const seedPlan = planFiveAxisTransactions({
    deltas: createFiveAxisCandidateDeltas({
      changeId: "seed:a",
      modelId: "model:a",
      before: null,
      after: firstMembership,
    }),
  });
  const seeded = executeFiveAxisTransactionPlan({
    plan: seedPlan,
    definitions: [definition],
    currentGroupStates: [],
  });
  const state = seeded.groupStates[0];
  const replacement = membership(definition, "W1", "model:a", "snapshot:a:2");
  const replaceComponent = planFiveAxisTransactions({
    deltas: createFiveAxisCandidateDeltas({
      changeId: "replace:a",
      modelId: "model:a",
      before: firstMembership,
      after: replacement,
    }),
  }).components[0];
  assert.throws(() => applyFiveAxisTransactionComponent({
    component: replaceComponent,
    definitions: [definition],
    currentGroupStates: seeded.groupStates,
    expectations: [{
      groupKey: state.groupKey,
      expectedVertexSetHash: state.currentVertexSetHash,
      expectedCandidateEvidenceHash: "f".repeat(64),
      expectedCandidateSnapshotIds: ["snapshot:model:a"],
    }],
  }), /FIVE_AXIS_CONCURRENT_VERTEX_CONFLICT/);
});

test("SnapshotBatch 为 create 项稳定预分配 snapshotId 并绑定五维事务", () => {
  const state = createSeedState();
  const published = state.purchasableModels.find((model) =>
    model.configurationSnapshotId)!;
  const candidate = {
    ...structuredClone(published),
    id: "model:batch-five-axis",
    revision: published.revision + 1,
    configurationSnapshotId: undefined,
    status: "approved" as const,
  };
  const left = planSnapshotBatch({
    models: [...state.purchasableModels, candidate],
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    snapshots: state.configurationSnapshots,
    selectedModelIds: [candidate.id],
    now: "2026-07-23T00:00:00.000Z",
  });
  const right = planSnapshotBatch({
    models: [...state.purchasableModels, candidate],
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    snapshots: state.configurationSnapshots,
    selectedModelIds: [candidate.id],
    now: "2099-01-01T00:00:00.000Z",
  });
  assertSnapshotBatchCanConfirm(left);
  assert.equal(left.items[0].snapshotId, right.items[0].snapshotId);

  const definition = createFormalFiveAxisViewDefinition();
  const membershipAfter = membership(
    definition,
    "W1",
    candidate.id,
    left.items[0].snapshotId,
  );
  const transactionPlan = planSnapshotBatchFiveAxisTransactions({
    batchPlan: left,
    deltas: createFiveAxisCandidateDeltas({
      changeId: "batch:add",
      modelId: candidate.id,
      before: null,
      after: membershipAfter,
    }),
  });
  assert.deepEqual(transactionPlan.components[0].snapshotBuildModelIds, [
    candidate.id,
  ]);
});

function entity(
  id: string,
  itemPartId: string,
  values: Record<string, number>,
): FiveAxisEntityInput {
  return {
    entityId: id,
    itemPartId,
    label: id,
    fishWeightGradeId: "W2",
    values,
  };
}

test("混合部位 2–5 件比较使用共同 W 段，第一根竿提供继承抛投", () => {
  const definition = createFormalFiveAxisViewDefinition();
  const key = groupKey(definition, "W2");
  const vertexSet = createFormalFiveAxisVertexSet({
    definition,
    groupKey: key,
    candidateSources: [
      source({ definition, modelId: "model:rod", snapshotId: "snapshot:rod" }),
      source({
        definition,
        modelId: "model:reel",
        snapshotId: "snapshot:reel",
        itemPartId: "part:reel",
        values: { cast: undefined },
      }),
    ],
  });
  const comparison = buildFormalEquipmentComparison({
    definition,
    vertexSet,
    entities: [
      {
        comparisonOrder: 0,
        modelFinalPullKg: 1.4,
        weightBandId: "W2",
        entity: entity("reel:1", "part:reel", {
          drag: 11, durability: 70, sensitivity: 2.4, energy_cost_factor: 0.9,
        }),
      },
      {
        comparisonOrder: 1,
        modelFinalPullKg: 1.8,
        weightBandId: "W2",
        entity: entity("rod:1", "part:rod", {
          drag: 12, durability: 90, max_cast_distance: 120,
          sensitivity: 1.8, energy_cost_factor: 0.7,
        }),
      },
    ],
  });
  assert.equal(comparison.mode, "equipment_compare");
  assert.equal(comparison.referenceRodEntityId, "rod:1");
  assert.equal(
    comparison.series[0].points.find((point) =>
      point.axisId === "cast")?.source,
    "context_inherited",
  );
  assert.ok(comparison.series[1].points.some((point) =>
    (point.comparisonScore ?? 0) > 100 && point.officialDisplayScore === 100));
  assert.throws(() => buildFormalEquipmentComparison({
    definition,
    vertexSet,
    entities: [comparison.series[0]].map((series, comparisonOrder) => ({
      comparisonOrder,
      modelFinalPullKg: series.modelFinalPullKg!,
      weightBandId: "W2",
      entity: entity(series.entityId, series.itemPartId, {}),
    })),
  }), /FIVE_AXIS_COMPARISON_SIZE_INVALID/);
});

test("无竿混合比较不伪造参考竿，轮线抛投均为 not_applicable", () => {
  const definition = createFormalFiveAxisViewDefinition();
  const key = groupKey(definition, "W2");
  const vertexSet = createFormalFiveAxisVertexSet({
    definition,
    groupKey: key,
    candidateSources: [
      source({ definition, modelId: "model:rod", snapshotId: "snapshot:rod" }),
    ],
  });
  const comparison = buildFormalEquipmentComparison({
    definition,
    vertexSet,
    entities: ["part:reel", "part:line"].map((itemPartId, comparisonOrder) => ({
      comparisonOrder,
      modelFinalPullKg: 1.5,
      weightBandId: "W2",
      entity: entity(`${itemPartId}:1`, itemPartId, {
        drag: 9,
        durability: 70,
        sensitivity: 2.5,
        energy_cost_factor: 0.9,
      }),
    })),
  });
  assert.equal(comparison.referenceRodEntityId, null);
  assert.ok(comparison.series.every((series) =>
    series.points.find((point) => point.axisId === "cast")?.source
      === "not_applicable"));
});

test("移除第一根参考竿后按剩余比较顺序重选，且第 6 件由定义上限拒绝", () => {
  const definition = createFormalFiveAxisViewDefinition();
  const key = groupKey(definition, "W2");
  const vertexSet = createFormalFiveAxisVertexSet({
    definition,
    groupKey: key,
    candidateSources: [
      source({ definition, modelId: "model:seed", snapshotId: "snapshot:seed" }),
    ],
  });
  const makeRod = (id: string, comparisonOrder: number) => ({
    comparisonOrder,
    modelFinalPullKg: 1.5,
    weightBandId: "W2",
    entity: entity(id, "part:rod", {
      drag: 10,
      durability: 80,
      max_cast_distance: 100 + comparisonOrder,
      sensitivity: 2,
      energy_cost_factor: 0.8,
    }),
  });
  const reel = {
    comparisonOrder: 1,
    modelFinalPullKg: 1.5,
    weightBandId: "W2",
    entity: entity("reel:between", "part:reel", {
      drag: 9,
      durability: 70,
      sensitivity: 2.5,
      energy_cost_factor: 0.9,
    }),
  };
  const initial = buildFormalEquipmentComparison({
    definition,
    vertexSet,
    entities: [makeRod("rod:first", 0), reel, makeRod("rod:second", 2)],
  });
  assert.equal(initial.referenceRodEntityId, "rod:first");
  const afterRemoval = buildFormalEquipmentComparison({
    definition,
    vertexSet,
    entities: [reel, makeRod("rod:second", 2)],
  });
  assert.equal(afterRemoval.referenceRodEntityId, "rod:second");
  assert.throws(() => buildFormalEquipmentComparison({
    definition,
    vertexSet,
    entities: Array.from({ length: 6 }, (_, comparisonOrder) =>
      makeRod(`rod:${comparisonOrder}`, comparisonOrder)),
  }), /FIVE_AXIS_COMPARISON_SIZE_INVALID/);
});
