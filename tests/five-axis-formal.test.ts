import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateFormalFiveAxisComponentSeries,
  createFiveAxisDispositionCatalogRevision,
  createFormalFiveAxisVertexSet,
  createFormalFiveAxisViewDefinition,
  createFormalFiveAxisWeightBandPolicy,
  hashFiveAxisDispositionCatalog,
  resolveFormalFiveAxisWeightBand,
  resolveFormalFiveAxisDefinition,
  validateFiveAxisDispositionCatalog,
} from "../lib/five-axis-formal";
import {
  canonicalDecimal,
  hashCandidateSemanticInput,
  hashCandidateSet,
} from "../lib/five-axis-hash";
import { deterministicHash } from "../lib/rule-kernel";
import type {
  FiveAxisEntityInput,
  FiveAxisVertexCandidateSource,
  FiveAxisVertexGroupKey,
  LegacyFiveAxisViewDefinition,
} from "../lib/types";

const ZERO_HASH = "0".repeat(64);

test("five-axis-hash-input/v1 通过 JCS/SHA-256 固定向量与拼接碰撞回归", () => {
  const semantic = hashCandidateSemanticInput({
    finalPanelHash: ZERO_HASH,
    modelFinalPullKg: "1",
    directInputs: [{
      axisId: "pull",
      parameterKey: "drag",
      rawValue: "2",
      unit: "kg",
      inputHash: "1".repeat(64),
      axisOrder: 1,
    }],
  });
  assert.equal(
    new TextDecoder().decode(semantic.canonicalBytes),
    '{"directInputs":[{"axisId":"pull","inputHash":"1111111111111111111111111111111111111111111111111111111111111111","parameterKey":"drag","rawValue":"2","unit":"kg"}],"finalPanelHash":"0000000000000000000000000000000000000000000000000000000000000000","kind":"candidate_semantic_input","modelFinalPullKg":"1","schemaVersion":"five-axis-hash-input/v1"}',
  );
  assert.equal(
    semantic.hash,
    "29bbd7f7543449ff80ad8e664cac415da4f406e56f78c29620ceda43a5715e7c",
  );

  const groupKey: FiveAxisVertexGroupKey = {
    weightBandId: "W1",
    weightBandPolicyVersion: "wb-v1",
    fiveAxisDefinitionId: "five-axis:open005-v1",
    fiveAxisDefinitionVersion: "1",
    fiveAxisRuleVersion: "rule-v1",
  };
  assert.equal(hashCandidateSet({
    vertexGroupKey: groupKey,
    candidates: [{
      key: { modelId: "ab", componentEntityId: "c", itemPartId: "d" },
      semanticInputHash: ZERO_HASH,
    }],
  }), "82a2ffb028b9077a0b89057efcc1df94bad57f5aa9d063a188d30c2cd3666784");
  assert.equal(hashCandidateSet({
    vertexGroupKey: groupKey,
    candidates: [{
      key: { modelId: "a", componentEntityId: "bc", itemPartId: "d" },
      semanticInputHash: ZERO_HASH,
    }],
  }), "de1ceea2a24c4cf4d7f80c85152340a9cbf60a89090f6705cb3a42c2151bb7cc");
});

test("CanonicalDecimal 无浮点舍入地归一化并拒绝非法值", () => {
  assert.equal(canonicalDecimal("1"), "1");
  assert.equal(canonicalDecimal("1.0"), "1");
  assert.equal(canonicalDecimal("1e0"), "1");
  assert.equal(canonicalDecimal("-0"), "0");
  assert.equal(canonicalDecimal("0.00100"), "0.001");
  assert.equal(canonicalDecimal("123e-5"), "0.00123");
  assert.equal(canonicalDecimal("0.0000000000000000001"), "0.0000000000000000001");
  assert.throws(() => canonicalDecimal("NaN"), /非法 CanonicalDecimal/);
  assert.throws(() => canonicalDecimal("Infinity"), /非法 CanonicalDecimal/);
});

test("正式 W 段只从不可变已发布策略 payload 解析，篡改或同名异 hash 均拒绝", () => {
  const policy = createFormalFiveAxisWeightBandPolicy();
  assert.equal(resolveFormalFiveAxisWeightBand({ policy, modelFinalPullKg: 2 }), "W1");
  assert.equal(resolveFormalFiveAxisWeightBand({ policy, modelFinalPullKg: 2.01 }), "W2");
  const tampered = structuredClone(policy);
  tampered.bands[0].upperBoundKg = "3";
  assert.throws(() => resolveFormalFiveAxisWeightBand({
    policy: tampered, modelFinalPullKg: 2.5,
  }), /FIVE_AXIS_WEIGHT_BAND_POLICY_UNAVAILABLE/);
  assert.throws(() => resolveFormalFiveAxisWeightBand({
    policy: { ...policy, version: policy.version, contentHash: "0".repeat(64) },
    modelFinalPullKg: 2,
  }), /FIVE_AXIS_WEIGHT_BAND_POLICY_UNAVAILABLE/);
});

function legacyDefinition(): LegacyFiveAxisViewDefinition {
  const content: Omit<LegacyFiveAxisViewDefinition, "definitionHash"> = {
    definitionId: "five-axis:legacy",
    version: "1",
    revision: 1,
    publicationState: "PUBLISHED",
    fiveAxisRuleVersion: "legacy-rule",
    sourceRevision: "legacy-source",
    axes: Array.from({ length: 5 }, (_, index) => ({
      axisId: `legacy-${index}`,
      label: `旧轴 ${index}`,
      order: index + 1,
      sourceParameterKeys: [`legacy_${index}`],
      applicablePartIds: ["part:rod"],
      direction: "higher_better" as const,
      transformId: "identity",
      vertexSelectorId: "max",
      componentAggregationId: "component_min_ratio",
      missingPolicy: "error" as const,
    })) as LegacyFiveAxisViewDefinition["axes"],
    seriesBaselinePolicy: { mode: "explicit_model", required: true },
  };
  return { ...content, definitionHash: deterministicHash(content) };
}

test("处置目录迁移保留 legacy payload/hash，重复运行幂等且只含旧定义时 fail-closed", () => {
  const legacy = legacyDefinition();
  const before = JSON.stringify(legacy);
  const first = createFiveAxisDispositionCatalogRevision({
    definitions: [legacy],
    existingRevisions: [],
    currentRevisionId: null,
    decidedAt: "2026-07-23T00:00:00.000Z",
  });
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(first.revision.entries[0].effectiveUse, "LEGACY_SNAPSHOT_ONLY");
  const second = createFiveAxisDispositionCatalogRevision({
    definitions: [legacy],
    existingRevisions: first.revisions,
    currentRevisionId: first.currentRevisionId,
    decidedAt: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(second.changed, false);
  assert.equal(second.revisions.length, 1);
  assert.throws(() => resolveFormalFiveAxisDefinition({
    definitions: [legacy],
    revisions: second.revisions,
    currentRevisionId: second.currentRevisionId,
  }), /FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE/);
});

test("正式定义恰好五轴且只有唯一 FORMAL_CURRENT 可供新发布解析", () => {
  const legacy = legacyDefinition();
  const formal = createFormalFiveAxisViewDefinition();
  assert.deepEqual(formal.axes.map((axis) => axis.axisId), [
    "pull", "durability", "cast", "sensitivity", "control",
  ]);
  assert.ok(formal.axes.every((axis) =>
    axis.componentAggregationId === "per_component_no_aggregate"));
  assert.equal(formal.comparisonPolicy.maximumItems, 5);

  const catalog = createFiveAxisDispositionCatalogRevision({
    definitions: [legacy, formal],
    existingRevisions: [],
    currentRevisionId: null,
    formalCurrent: {
      definitionId: formal.definitionId,
      definitionVersion: formal.version,
    },
    decidedAt: "2026-07-23T00:00:00.000Z",
  });
  const resolved = resolveFormalFiveAxisDefinition({
    definitions: [legacy, formal],
    revisions: catalog.revisions,
    currentRevisionId: catalog.currentRevisionId,
  });
  assert.equal(resolved.definition.definitionHash, formal.definitionHash);
  assert.equal(
    resolved.catalogRevision.entries.find((entry) =>
      entry.definitionId === legacy.definitionId)?.effectiveUse,
    "LEGACY_SNAPSHOT_ONLY",
  );
  assert.equal(
    hashFiveAxisDispositionCatalog({
      previousCatalogHash: null,
      entries: resolved.catalogRevision.entries,
    }),
    resolved.catalogRevision.catalogHash,
  );
  const changedMetadata = {
    ...resolved.catalogRevision,
    catalogRevisionId: "other-id",
    decidedAt: "2099-01-01T00:00:00.000Z",
  };
  assert.equal(hashFiveAxisDispositionCatalog({
    previousCatalogHash: changedMetadata.previousCatalogHash,
    entries: changedMetadata.entries,
  }), resolved.catalogRevision.catalogHash);
});

test("当前处置目录头必须完整分类全部已知定义", () => {
  const legacy = legacyDefinition();
  const formal = createFormalFiveAxisViewDefinition();
  const catalog = createFiveAxisDispositionCatalogRevision({
    definitions: [legacy, formal],
    existingRevisions: [],
    currentRevisionId: null,
    formalCurrent: {
      definitionId: formal.definitionId,
      definitionVersion: formal.version,
    },
    decidedAt: "2026-07-23T00:00:00.000Z",
  });
  const truncated = structuredClone(catalog.revision);
  truncated.entries = truncated.entries.filter((entry) =>
    entry.definitionId !== legacy.definitionId);
  truncated.catalogHash = hashFiveAxisDispositionCatalog({
    previousCatalogHash: truncated.previousCatalogHash,
    entries: truncated.entries,
  });
  truncated.catalogRevisionId = `five-axis-disposition:${truncated.catalogHash.slice(0, 20)}`;
  assert.throws(() => validateFiveAxisDispositionCatalog({
    definitions: [legacy, formal],
    revisions: [truncated],
    currentRevisionId: truncated.catalogRevisionId,
  }), /未完整分类全部已知定义/);
});

test("切换正式定义时旧正式项进入 SUPERSEDED 并保留不可变前驱", () => {
  const legacy = legacyDefinition();
  const firstFormal = createFormalFiveAxisViewDefinition({
    definitionId: "five-axis:formal-a",
    version: "1",
  });
  const secondFormal = createFormalFiveAxisViewDefinition({
    definitionId: "five-axis:formal-b",
    version: "2",
    revision: 2,
  });
  const first = createFiveAxisDispositionCatalogRevision({
    definitions: [legacy, firstFormal],
    existingRevisions: [],
    currentRevisionId: null,
    formalCurrent: {
      definitionId: firstFormal.definitionId,
      definitionVersion: firstFormal.version,
    },
    decidedAt: "2026-07-23T00:00:00.000Z",
  });
  const frozenFirst = JSON.stringify(first.revision);
  const second = createFiveAxisDispositionCatalogRevision({
    definitions: [legacy, firstFormal, secondFormal],
    existingRevisions: first.revisions,
    currentRevisionId: first.currentRevisionId,
    formalCurrent: {
      definitionId: secondFormal.definitionId,
      definitionVersion: secondFormal.version,
    },
    decidedAt: "2026-07-23T01:00:00.000Z",
  });
  assert.equal(JSON.stringify(second.revisions[0]), frozenFirst);
  assert.equal(second.revision.previousCatalogRevisionId, first.currentRevisionId);
  assert.deepEqual(
    second.revision.entries.find((entry) =>
      entry.definitionId === firstFormal.definitionId),
    {
      definitionId: firstFormal.definitionId,
      definitionVersion: firstFormal.version,
      definitionHash: firstFormal.definitionHash,
      effectiveUse: "SUPERSEDED",
      semanticContractVersion: "five-axis/open005-2026-07-23/v1",
      supersededByDefinitionId: secondFormal.definitionId,
      supersededByDefinitionVersion: secondFormal.version,
      reasonCode: "OPEN005_FORMAL_SUPERSEDED",
    },
  );
  assert.equal(
    second.revision.entries.find((entry) =>
      entry.definitionId === secondFormal.definitionId)?.effectiveUse,
    "FORMAL_CURRENT",
  );
  assert.equal(
    second.revision.entries.find((entry) =>
      entry.definitionId === legacy.definitionId)?.effectiveUse,
    "LEGACY_SNAPSHOT_ONLY",
  );
  const repeated = createFiveAxisDispositionCatalogRevision({
    definitions: [legacy, firstFormal, secondFormal],
    existingRevisions: second.revisions,
    currentRevisionId: second.currentRevisionId,
    decidedAt: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.revisions.length, 2);
});

function candidateSource(input: {
  modelId: string;
  componentEntityId: string;
  itemPartId: string;
  values: Record<string, string>;
}): FiveAxisVertexCandidateSource {
  const axes = Object.entries(input.values).map(([axisId, rawValue], index) => ({
    axisId,
    parameterKey: {
      pull: "drag",
      durability: "durability",
      cast: "max_cast_distance",
      sensitivity: "sensitivity",
      control: "energy_cost_factor",
    }[axisId]!,
    rawValue,
    unit: "unit",
    inputHash: String(index + 1).repeat(64),
    axisOrder: index + 1,
  }));
  const semantic = hashCandidateSemanticInput({
    finalPanelHash: ZERO_HASH,
    modelFinalPullKg: "1.5",
    directInputs: axes,
  });
  return {
    candidateSemanticKey: {
      modelId: input.modelId,
      componentEntityId: input.componentEntityId,
      itemPartId: input.itemPartId,
    },
    snapshotId: `snapshot:${input.modelId}`,
    modelRevisionId: `${input.modelId}@1`,
    finalPanelHash: ZERO_HASH,
    modelFinalPullKg: "1.5",
    directInputs: axes.map((entry) => ({
      axisId: entry.axisId,
      parameterKey: entry.parameterKey,
      rawValue: entry.rawValue,
      unit: entry.unit,
      inputHash: entry.inputHash,
    })),
    semanticInputHash: semantic.hash,
  };
}

test("缺少任一适用 direct 轴的候选不得参与任何顶点选择", () => {
  const definition = createFormalFiveAxisViewDefinition();
  const groupKey: FiveAxisVertexGroupKey = {
    weightBandId: "W2",
    weightBandPolicyVersion: definition.weightBandPolicyVersion,
    fiveAxisDefinitionId: definition.definitionId,
    fiveAxisDefinitionVersion: definition.version,
    fiveAxisRuleVersion: definition.fiveAxisRuleVersion,
  };
  const complete = candidateSource({
    modelId: "model:complete",
    componentEntityId: "rod:complete",
    itemPartId: "part:rod",
    values: {
      pull: "10",
      durability: "80",
      cast: "100",
      sensitivity: "2",
      control: "0.8",
    },
  });
  const incomplete = candidateSource({
    modelId: "model:incomplete",
    componentEntityId: "rod:incomplete",
    itemPartId: "part:rod",
    values: {
      pull: "999",
      durability: "90",
      cast: "120",
      control: "0.6",
    },
  });
  assert.throws(
    () => createFormalFiveAxisVertexSet({
      definition,
      groupKey,
      candidateSources: [complete, incomplete],
    }),
    /FIVE_AXIS_CANDIDATE_INCOMPLETE.*sensitivity/,
  );
});

test("正式内核按部件绘制、低值轴反向、官方分封顶且比较分允许溢出", () => {
  const definition = createFormalFiveAxisViewDefinition();
  const groupKey: FiveAxisVertexGroupKey = {
    weightBandId: "W2",
    weightBandPolicyVersion: definition.weightBandPolicyVersion,
    fiveAxisDefinitionId: definition.definitionId,
    fiveAxisDefinitionVersion: definition.version,
    fiveAxisRuleVersion: definition.fiveAxisRuleVersion,
  };
  const vertexSet = createFormalFiveAxisVertexSet({
    definition,
    groupKey,
    candidateSources: [
      candidateSource({
        modelId: "model:rod",
        componentEntityId: "rod:1",
        itemPartId: "part:rod",
        values: {
          pull: "10",
          durability: "80",
          cast: "100",
          sensitivity: "2",
          control: "0.8",
        },
      }),
      candidateSource({
        modelId: "model:reel",
        componentEntityId: "reel:1",
        itemPartId: "part:reel",
        values: {
          pull: "12",
          durability: "90",
          cast: "999",
          sensitivity: "1.5",
          control: "0.6",
        },
      }),
    ],
  });
  assert.equal(
    vertexSet.vertices.find((vertex) => vertex.axisId === "cast")?.vertexRawValue,
    "100",
  );
  const rodInput: FiveAxisEntityInput = {
    entityId: "rod:compare",
    itemPartId: "part:rod",
    label: "测试竿",
    fishWeightGradeId: "W2",
    values: {
      drag: 15,
      durability: 70,
      max_cast_distance: 120,
      sensitivity: 3,
      energy_cost_factor: 0.5,
    },
  };
  const rod = calculateFormalFiveAxisComponentSeries({
    definition,
    vertexSet,
    entity: rodInput,
  });
  const pull = rod.points.find((point) => point.axisId === "pull")!;
  assert.equal(pull.comparisonScore, 125);
  assert.equal(pull.officialDisplayScore, 100);
  assert.equal(pull.overflow, 25);
  const control = rod.points.find((point) => point.axisId === "control")!;
  assert.ok(Math.abs(control.comparisonScore! - 120) < 1e-9);
  const rounded = calculateFormalFiveAxisComponentSeries({
    definition,
    vertexSet,
    entity: {
      ...rodInput,
      entityId: "rod:rounded-score",
      values: { ...rodInput.values, drag: 8.808 },
    },
  });
  const roundedPull = rounded.points.find((point) => point.axisId === "pull")!;
  assert.ok(Math.abs(roundedPull.comparisonScore! - 73.4) < 1e-9);
  assert.equal(roundedPull.officialDisplayScore, 73);

  const reel = calculateFormalFiveAxisComponentSeries({
    definition,
    vertexSet,
    referenceRodSeries: rod,
    entity: {
      ...rodInput,
      entityId: "reel:compare",
      itemPartId: "part:reel",
      label: "测试轮",
      values: { drag: 10, durability: 85, sensitivity: 2, energy_cost_factor: 0.7 },
    },
  });
  const inheritedCast = reel.points.find((point) => point.axisId === "cast")!;
  assert.equal(inheritedCast.source, "context_inherited");
  assert.equal(inheritedCast.participatesInRanking, false);
});
