import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateFormalFiveAxisComponentSeries,
  createFiveAxisDispositionCatalogRevision,
  createFormalFiveAxisVertexSet,
  createFormalFiveAxisViewDefinition,
  createFormalFiveAxisWeightBandPolicy,
  canAddFormalEquipmentComparisonSelection,
  hasMatchingFormalSnapshotEvidence,
  hashFiveAxisDispositionCatalog,
  resolveFormalEquipmentComparisonDefinition,
  resolveFormalEquipmentComparisonReadiness,
  resolveFormalEquipmentComparisonWeightBand,
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
import { createSeedState } from "../lib/seed";
import {
  buildFormalComponentSelectionsFixture,
  buildFormalPreviewFixture,
} from "./helpers/formal-five-axis";
import type {
  FiveAxisEntityInput,
  FiveAxisVertexCandidateSource,
  FiveAxisVertexGroupKey,
  LegacyFiveAxisViewDefinition,
} from "../lib/types";

const ZERO_HASH = "0".repeat(64);

test("混合比较在缺少正式依赖时明确阻断而保留恢复路径", () => {
  assert.deepEqual(resolveFormalEquipmentComparisonReadiness({
    selectionCount: 1,
    activeEvidence: "missing",
    hasFormalCurrentDefinition: false,
    selectedEvidence: [],
  }), { state: "waiting_for_selection" });
  assert.deepEqual(resolveFormalEquipmentComparisonReadiness({
    selectionCount: 2,
    activeEvidence: "compatible",
    hasFormalCurrentDefinition: false,
    selectedEvidence: ["compatible", "compatible"],
  }), {
    state: "unavailable",
    message: "当前工作区没有唯一的 FORMAL_CURRENT 五维定义。请由具备五维规则发布权限的人员发布或恢复该定义；比较篮会保留，可在恢复后重试。",
  });
  assert.deepEqual(resolveFormalEquipmentComparisonReadiness({
    selectionCount: 2,
    activeEvidence: "missing",
    hasFormalCurrentDefinition: true,
    selectedEvidence: ["compatible", "compatible"],
  }), {
    state: "unavailable",
    message: "当前 Model 缺少冻结五维预览，无法确定共同 W 段。请打开带完整五维预览的冻结 Snapshot 后重试；比较篮会保留。",
  });
  assert.deepEqual(resolveFormalEquipmentComparisonReadiness({
    selectionCount: 2,
    activeEvidence: "compatible",
    hasFormalCurrentDefinition: true,
    selectedEvidence: ["compatible", "compatible"],
  }), { state: "ready" });
  assert.equal(resolveFormalEquipmentComparisonReadiness({
    selectionCount: 2,
    activeEvidence: "incompatible",
    hasFormalCurrentDefinition: true,
    selectedEvidence: ["compatible", "compatible"],
  }).state, "unavailable");
  assert.equal(resolveFormalEquipmentComparisonReadiness({
    selectionCount: 2,
    activeEvidence: "compatible",
    hasFormalCurrentDefinition: true,
    selectedEvidence: ["compatible", "incompatible"],
  }).state, "unavailable");
});

test("比较 UI 只能使用经完整目录链验证的唯一正式定义", () => {
  const legacy = legacyDefinition();
  const formal = createFormalFiveAxisViewDefinition();
  const catalog = createFiveAxisDispositionCatalogRevision({
    definitions: [legacy, formal],
    existingRevisions: [],
    currentRevisionId: null,
    formalCurrent: { definitionId: formal.definitionId, definitionVersion: formal.version },
    decidedAt: "2026-07-24T00:00:00.000Z",
  });
  const available = resolveFormalEquipmentComparisonDefinition({
    definitions: [legacy, formal],
    revisions: catalog.revisions,
    currentRevisionId: catalog.currentRevisionId,
  });
  assert.equal(available.state, "available");
  if (available.state === "available") assert.equal(available.definition.definitionHash, formal.definitionHash);

  const malformed = structuredClone(catalog.revision);
  malformed.catalogHash = ZERO_HASH;
  const unavailable = resolveFormalEquipmentComparisonDefinition({
    definitions: [legacy, formal],
    revisions: [malformed],
    currentRevisionId: malformed.catalogRevisionId,
  });
  assert.deepEqual(unavailable, {
    state: "unavailable",
    message: "当前五维正式定义目录无效或没有唯一 FORMAL_CURRENT。请恢复完整目录链并发布唯一正式定义；比较篮会保留。",
  });

  const secondFormal = createFormalFiveAxisViewDefinition({
    definitionId: "five-axis:other-formal",
    version: "2",
    revision: 2,
  });
  const twoFormalCatalog = createFiveAxisDispositionCatalogRevision({
    definitions: [legacy, formal, secondFormal],
    existingRevisions: [],
    currentRevisionId: null,
    formalCurrent: { definitionId: formal.definitionId, definitionVersion: formal.version },
    decidedAt: "2026-07-24T00:00:00.000Z",
  });
  const duplicateFormal = structuredClone(twoFormalCatalog.revision);
  duplicateFormal.entries.find((entry) => entry.definitionId === secondFormal.definitionId)!.effectiveUse = "FORMAL_CURRENT";
  duplicateFormal.catalogHash = hashFiveAxisDispositionCatalog({
    previousCatalogHash: duplicateFormal.previousCatalogHash,
    entries: duplicateFormal.entries,
  });
  duplicateFormal.catalogRevisionId = `five-axis-disposition:${duplicateFormal.catalogHash.slice(0, 20)}`;
  assert.equal(resolveFormalEquipmentComparisonDefinition({
    definitions: [legacy, formal, secondFormal],
    revisions: [duplicateFormal],
    currentRevisionId: duplicateFormal.catalogRevisionId,
  }).state, "unavailable");
});

test("比较篮上限和共同 W 段均从已解析正式定义读取", () => {
  const definition = createFormalFiveAxisViewDefinition({ maximumItems: 3 });
  assert.deepEqual(canAddFormalEquipmentComparisonSelection({
    selectionCount: 2,
    definition,
  }), { allowed: true });
  assert.deepEqual(canAddFormalEquipmentComparisonSelection({
    selectionCount: 3,
    definition,
  }), {
    allowed: false,
    message: "混合部位比较篮上限为 3 件。",
  });
  assert.equal(canAddFormalEquipmentComparisonSelection({
    selectionCount: 0,
    definition: undefined,
  }).allowed, false);

  assert.equal(resolveFormalEquipmentComparisonWeightBand({
    definition,
    selectedWeightBandId: "",
    fallbackWeightBandId: "W1",
  }), "W1");
  assert.equal(resolveFormalEquipmentComparisonWeightBand({
    definition,
    selectedWeightBandId: "W2",
    fallbackWeightBandId: "W1",
  }), "W2");
  assert.equal(resolveFormalEquipmentComparisonWeightBand({
    definition,
    selectedWeightBandId: "not-a-formal-band",
    fallbackWeightBandId: "W1",
  }), undefined);
});

test("正式比较 Snapshot 证据必须完整匹配 FORMAL_CURRENT 定义与 W 策略", () => {
  const state = createSeedState();
  const definition = createFormalFiveAxisViewDefinition();
  const model = state.purchasableModels.find((entry) =>
    entry.configurationSnapshotId)!;
  const sourceSnapshot = state.configurationSnapshots.find((entry) =>
    entry.id === model.configurationSnapshotId)!;
  const componentSelections = buildFormalComponentSelectionsFixture(
    sourceSnapshot.componentSelections,
  );
  const snapshotId = "snapshot:formal-comparison-evidence";
  const modelFinalPullKg = 1;
  const preview = buildFormalPreviewFixture({
    definition,
    snapshotId,
    modelId: model.id,
    modelRevision: model.revision,
    seriesId: "series:formal-comparison",
    skuId: model.skuId,
    skuRevision: sourceSnapshot.skuRevision,
    modelFinalPullKg,
    finalPanelValues: sourceSnapshot.finalPanelValues,
    componentSelections,
    weightBandId: "W1",
  });
  const formalSnapshot = {
    ...structuredClone(sourceSnapshot),
    id: snapshotId,
    modelId: model.id,
    modelRevision: model.revision,
    modelFinalPullKg,
    componentSelections,
    fiveAxisPreview: preview,
  };
  assert.equal(hasMatchingFormalSnapshotEvidence({
    definition,
    snapshot: formalSnapshot,
  }), true);
  assert.equal(hasMatchingFormalSnapshotEvidence({
    definition,
    snapshot: { ...formalSnapshot, fiveAxisPreview: undefined },
  }), false);
  assert.equal(hasMatchingFormalSnapshotEvidence({
    definition,
    snapshot: {
      ...formalSnapshot,
      fiveAxisPreview: { ...preview, fiveAxisDefinitionId: "legacy:def" },
    },
  }), false);
  assert.equal(hasMatchingFormalSnapshotEvidence({
    definition,
    snapshot: {
      ...formalSnapshot,
      fiveAxisPreview: {
        ...preview,
        weightBandPolicyVersion: "weight-band:legacy",
      },
    },
  }), false);
});

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
  assert.equal(resolveFormalFiveAxisWeightBand({ policy, modelFinalPullKg: 0 }), "W1");
  assert.equal(resolveFormalFiveAxisWeightBand({ policy, modelFinalPullKg: 1.4999 }), "W1");
  assert.equal(resolveFormalFiveAxisWeightBand({ policy, modelFinalPullKg: 1.5 }), "W2");
  assert.equal(resolveFormalFiveAxisWeightBand({ policy, modelFinalPullKg: 4 }), "W3");
  assert.equal(resolveFormalFiveAxisWeightBand({ policy, modelFinalPullKg: 10 }), "W4");
  assert.equal(resolveFormalFiveAxisWeightBand({ policy, modelFinalPullKg: 20 }), "W5");
  assert.equal(resolveFormalFiveAxisWeightBand({ policy, modelFinalPullKg: 80 }), "W6");
  const tampered = structuredClone(policy);
  tampered.bands[0].upperBoundKg = "3";
  assert.throws(() => resolveFormalFiveAxisWeightBand({
    policy: tampered, modelFinalPullKg: 2.5,
  }), /FIVE_AXIS_WEIGHT_BAND_POLICY_UNAVAILABLE/);
  assert.throws(() => resolveFormalFiveAxisWeightBand({
    policy: { ...policy, version: policy.version, contentHash: "0".repeat(64) },
    modelFinalPullKg: 1.5,
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
  assert.equal(pull.comparisonScore, 150);
  assert.equal(pull.officialDisplayScore, 100);
  assert.equal(pull.overflow, 50);
  const control = rod.points.find((point) => point.axisId === "control")!;
  assert.ok(Math.abs(control.comparisonScore! - 160) < 1e-9);
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
  assert.ok(Math.abs(roundedPull.comparisonScore! - 88.08) < 1e-9);
  assert.equal(roundedPull.officialDisplayScore, 88);

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
