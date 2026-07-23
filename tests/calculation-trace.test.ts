import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptLegacyCalculationTraceToCanonical,
  adaptPatchTraceToCanonical,
  adaptPricingTraceToCanonical,
  adaptRuleTraceToCanonical,
  CALCULATION_TRACE_ABSENT_VALUE,
  CalculationTraceReplayError,
  assertCalculationTraceMatchesFinalPanel,
  assertCalculationTraceMatchesPricing,
  createCalculationTraceArchive,
  createCalculationTraceEntry,
  replayCalculationTrace,
  tryReplayCalculationTrace,
  verifyCalculationTraceArchive,
  type CreateCalculationTraceEntryInput,
  type CalculationTraceEntry,
} from "../lib/calculation-trace";
import type { EntityRef } from "../lib/interaction-contracts";
import { deterministicHash } from "../lib/rule-kernel";
import type { DerivedProjection, ParameterDefinition } from "../lib/types";

const subjectRef: EntityRef = {
  workspaceId: "workspace:test",
  entityType: "model",
  entityId: "model:trace",
  revisionId: "7",
};

const parameterDefinitions: ParameterDefinition[] = [{
  key: "drag",
  label: "泄力",
  itemKind: "reel",
  unit: "kgf",
  precision: 1,
  benefitMode: "higher_better",
  notes: "",
}];

const projection: DerivedProjection = {
  id: "projection:trace",
  weightTemplateId: "weight:1",
  methodId: "method:1",
  typeId: "type:1",
  functionId: "function:1",
  functionIntensity: 2,
  ruleSetVersion: "rules:7",
  reductionStackingMode: "linear_subtraction",
  values: { drag: 12 },
  trace: [
    {
      layer: "method",
      sourceIds: ["method:1"],
      contributions: [],
    },
    {
      layer: "base_weight_template",
      sourceIds: ["weight:1"],
      contributions: [{
        sequence: 7,
        ruleId: "weight:drag",
        sourceId: "weight:1",
        sourceName: "基础模板",
        parameterKey: "drag",
        operation: "base",
        before: null,
        operand: 10,
        after: 10,
      }],
    },
    {
      layer: "model_patch",
      sourceIds: ["patch:1"],
      contributions: [{
        sequence: 22,
        ruleId: "patch:drag",
        sourceId: "patch:1",
        sourceName: "Model Patch",
        parameterKey: "drag",
        operation: "add",
        before: 10,
        operand: 2,
        after: 12,
      }],
    },
  ],
  warnings: [{
    level: "warning",
    code: "METHOD_NO_EFFECT",
    message: "当前钓法没有数值贡献。",
    layer: "method",
  }],
  sourceHash: "projection-source-hash",
  createdAt: "2026-07-23T00:00:00.000Z",
};

test("canonical Trace 适配后全局连续，no_effect、版本、单位、effect 与 warning 可消费", () => {
  const entries = adaptRuleTraceToCanonical({
    projection,
    subjectRef,
    parameterDefinitions,
  });
  assert.deepEqual(entries.map((entry) => entry.sequence), [1, 2, 3]);
  assert.equal(entries[0].operation, "no_effect");
  assert.equal(entries[0].effect, "neutral");
  assert.equal(entries[0].warningIssueIds.length, 1);
  assert.equal(entries[1].sourceVersion, "rules:7");
  assert.equal(entries[1].ruleSetVersion, "rules:7");
  assert.equal(entries[1].unit, "kgf");
  assert.equal(entries[2].effect, "benefit");
  assert.ok(entries.every((entry) => Array.isArray(entry.actions)));
});

test("相同输入和版本生成相同 canonical Trace、hash 与 replay", () => {
  const left = createCalculationTraceArchive(adaptRuleTraceToCanonical({
    projection,
    subjectRef,
    parameterDefinitions,
  }));
  const right = createCalculationTraceArchive(adaptRuleTraceToCanonical({
    projection: structuredClone(projection),
    subjectRef: structuredClone(subjectRef),
    parameterDefinitions: structuredClone(parameterDefinitions),
  }).reverse());
  assert.deepEqual(left, right);
  assert.equal(verifyCalculationTraceArchive(left), true);
  assert.equal(left.finalState.find((entry) => entry.parameterKey === "drag")?.value, 12);
});

function entry(input: {
  sequence: number;
  before: number;
  after: number;
  operation?: "add" | "set";
  operand: number;
}): CalculationTraceEntry {
  return createCalculationTraceEntry({
    subjectRef,
    parameterKey: "drag",
    sequence: input.sequence,
    layer: "model_patch",
    sourceRef: { sourceType: "rule", sourceId: `rule:${input.sequence}` },
    sourceVersion: "source:1",
    ruleSetVersion: "rules:1",
    before: input.before,
    operation: input.operation ?? "add",
    operand: input.operand,
    after: input.after,
    unit: "kgf",
    effect: "benefit",
    warningIssueIds: [],
    actions: [],
  });
}

test("sequence 缺口、before 冲突和 outputHash 篡改均 fail-closed", () => {
  const first = entry({ sequence: 1, before: 10, operand: 2, after: 12 });
  const gap = entry({ sequence: 3, before: 12, operand: 1, after: 13 });
  assert.throws(
    () => createCalculationTraceArchive([first, gap]),
    (error) => error instanceof CalculationTraceReplayError
      && error.issue.code === "TRACE_REPLAY_MISMATCH"
      && error.issue.blocking,
  );

  const conflict = entry({ sequence: 2, before: 99, operand: 1, after: 100 });
  const conflictResult = tryReplayCalculationTrace({
    entries: [first, conflict],
    initialState: [{
      subjectRef,
      parameterKey: "drag",
      value: 10,
    }],
  });
  assert.equal(conflictResult.ok, false);
  if (!conflictResult.ok) {
    assert.equal(conflictResult.issue.gate, "publish");
    assert.equal(conflictResult.issue.actions[0].action, "recompute");
  }

  const tampered = structuredClone(first);
  tampered.outputHash = "tampered";
  assert.throws(
    () => replayCalculationTrace({
      entries: [tampered],
      initialState: [{ subjectRef, parameterKey: "drag", value: 10 }],
    }),
    /TRACE_REPLAY_MISMATCH/,
  );
});

test("非有限值和非 JSON 安全值在建档前 fail-closed，合法归档可无损往返", () => {
  for (const unsafe of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]) {
    assert.throws(
      () => createCalculationTraceEntry({
        subjectRef,
        parameterKey: "unsafe",
        sequence: 1,
        layer: "boundary",
        sourceRef: { sourceType: "test", sourceId: "unsafe" },
        sourceVersion: "source:1",
        ruleSetVersion: "rules:1",
        before: unsafe,
        operation: "no_effect",
        operand: null,
        after: unsafe,
        effect: "neutral",
        warningIssueIds: [],
        actions: [],
      }),
      /TRACE_REPLAY_MISMATCH/,
    );
  }
  assert.throws(
    () => createCalculationTraceEntry({
      subjectRef,
      parameterKey: "unsafe-evidence",
      sequence: 1,
      layer: "boundary",
      sourceRef: { sourceType: "test", sourceId: "unsafe-evidence" },
      sourceVersion: "source:1",
      ruleSetVersion: "rules:1",
      before: null,
      operation: "no_effect",
      operand: null,
      after: null,
      effect: "neutral",
      warningIssueIds: [],
      actions: [],
      evidence: { nested: { value: Number.NaN } },
    }),
    /TRACE_REPLAY_MISMATCH/,
  );

  const archive = createCalculationTraceArchive([
    entry({ sequence: 1, before: 10, operand: 2, after: 12 }),
  ]);
  const persisted = JSON.parse(JSON.stringify(archive));
  assert.deepEqual(persisted, archive);
  assert.equal(verifyCalculationTraceArchive(persisted), true);
});

test("值等价使用结构比较，32 位 hash 碰撞不能绕过冲突", () => {
  const left = "4x47h135er6o";
  const right = "a4f3v0xp2x1k";
  assert.notEqual(left, right);
  assert.equal(deterministicHash(left), deterministicHash(right));
  assert.throws(
    () => createCalculationTraceEntry({
      subjectRef,
      parameterKey: "collision",
      sequence: 1,
      layer: "boundary",
      sourceRef: { sourceType: "test", sourceId: "hash-collision" },
      sourceVersion: "source:1",
      ruleSetVersion: "rules:1",
      before: null,
      operation: "set",
      operand: left,
      after: right,
      effect: "neutral",
      warningIssueIds: [],
      actions: [],
    }),
    /TRACE_REPLAY_MISMATCH/,
  );
});

test("canonical Trace 终态必须完整重放 finalPanelValues", () => {
  const archive = createCalculationTraceArchive(adaptRuleTraceToCanonical({
    projection,
    subjectRef,
    parameterDefinitions,
  }));
  assert.doesNotThrow(() => assertCalculationTraceMatchesFinalPanel({
    archive,
    subjectRef,
    finalPanelValues: { drag: 12 },
  }));
  assert.throws(
    () => assertCalculationTraceMatchesFinalPanel({
      archive,
      subjectRef,
      finalPanelValues: { drag: 99 },
    }),
    /TRACE_REPLAY_MISMATCH/,
  );
  assert.throws(
    () => assertCalculationTraceMatchesFinalPanel({
      archive,
      subjectRef,
      finalPanelValues: {},
    }),
    /finalPanelValues 缺少 Trace 面板参数/,
  );
  const ghostEntry = createCalculationTraceEntry({
    subjectRef,
    parameterKey: "ghost_panel_key",
    sequence: archive.entries.length + 1,
    layer: "final_review_patch",
    sourceRef: { sourceType: "final_review_patch", sourceId: "review:ghost" },
    sourceVersion: "review:1",
    ruleSetVersion: projection.ruleSetVersion,
    before: null,
    operation: "set",
    operand: 99,
    after: 99,
    effect: "contextual",
    warningIssueIds: [],
    actions: [],
  });
  assert.throws(
    () => assertCalculationTraceMatchesFinalPanel({
      archive: createCalculationTraceArchive([...archive.entries, ghostEntry]),
      subjectRef,
      finalPanelValues: { drag: 12 },
    }),
    /finalPanelValues 缺少 Trace 面板参数：ghost_panel_key/,
  );
  const removeEntry = createCalculationTraceEntry({
    subjectRef,
    parameterKey: "drag",
    sequence: archive.entries.length + 1,
    layer: "final_review_patch",
    sourceRef: { sourceType: "final_review_patch", sourceId: "review:remove" },
    sourceVersion: "review:2",
    ruleSetVersion: projection.ruleSetVersion,
    before: 12,
    operation: "clear",
    operand: null,
    after: CALCULATION_TRACE_ABSENT_VALUE,
    effect: "contextual",
    warningIssueIds: [],
    actions: [],
  });
  assert.doesNotThrow(() => assertCalculationTraceMatchesFinalPanel({
    archive: createCalculationTraceArchive([...archive.entries, removeEntry]),
    subjectRef,
    finalPanelValues: {},
  }));
});

test("pricing、patch 与 legacy 只读适配器幂等并保留原始 evidence", () => {
  const pricing = {
    formal: true,
    pricingPolicyRef: "pricing:1",
    pricingWeightBandId: "band:1",
    pricingBasketId: "basket:1",
    repairPriceUnrounded: 10,
    purchasePriceUnrounded: 12.34,
    purchasePrice: 12,
    moneyUnit: "金币",
    trace: [{
      sequence: 9,
      formulaStep: "purchase_round",
      sourceRevision: "sheet:r4",
      source: { sheetId: "sheet:1", cell: "A1" },
      before: 12.34,
      operation: "round" as const,
      operand: 0,
      after: 12,
      inputStatus: "CONFIRMED" as const,
    }],
    issues: [],
    warnings: [],
    inputHash: "pricing-input",
  };
  const pricingEntries = adaptPricingTraceToCanonical({
    pricing,
    subjectRef,
    ruleSetVersion: "rules:1",
  });
  assert.equal(pricingEntries[0].operation, "set");
  assert.equal(pricingEntries[0].unit, "金币");
  assert.equal(pricingEntries[0].parameterKey, "pricing:purchase_price");
  assert.equal(pricingEntries[0].evidence?.adapter, "pricing_trace/v2");

  const patchInput = {
    trace: [{
      patchId: "patch:1",
      scope: "model" as const,
      scopeId: "model:trace",
      path: "values.drag",
      operation: "add" as const,
      before: 10,
      operand: 2,
      after: 12,
    }],
    subjectRef,
    sourceVersion: "patch:1@2",
    ruleSetVersion: "rules:1",
    parameterDefinitions,
  };
  assert.deepEqual(
    adaptPatchTraceToCanonical(patchInput),
    adaptPatchTraceToCanonical(structuredClone(patchInput)),
  );
  const removeEntries = adaptPatchTraceToCanonical({
    ...patchInput,
    trace: [{
      ...patchInput.trace[0],
      operation: "remove" as const,
      before: 12,
      operand: undefined,
      after: undefined,
    }],
  });
  assert.equal(removeEntries[0].operation, "clear");
  assert.equal(removeEntries[0].operand, null);
  assert.deepEqual(removeEntries[0].after, CALCULATION_TRACE_ABSENT_VALUE);
  assert.deepEqual(
    removeEntries[0].evidence?.legacyUndefinedFields,
    ["operand", "after"],
  );
  const removeArchive = createCalculationTraceArchive(removeEntries);
  assert.equal(
    removeArchive.finalState.some((state) => state.parameterKey === "drag"),
    false,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(removeArchive)), removeArchive);
  assert.equal(verifyCalculationTraceArchive(removeArchive), true);
  const removeThenSetEntries = adaptPatchTraceToCanonical({
    ...patchInput,
    trace: [
      {
        ...patchInput.trace[0],
        operation: "remove" as const,
        before: 12,
        operand: undefined,
        after: undefined,
      },
      {
        ...patchInput.trace[0],
        patchId: "patch:2",
        operation: "set" as const,
        before: undefined,
        operand: 15,
        after: 15,
      },
    ],
  });
  assert.deepEqual(removeThenSetEntries[1].before, CALCULATION_TRACE_ABSENT_VALUE);
  assert.equal(
    verifyCalculationTraceArchive(createCalculationTraceArchive(removeThenSetEntries)),
    true,
  );

  const legacyInput = {
    trace: [{
      layer: "performance",
      source: "legacy:row",
      parameterKey: "drag",
      operation: "formula" as const,
      before: 10,
      operand: "drag + 2",
      after: 12,
    }],
    subjectRef,
    sourceVersion: "legacy:v1",
    ruleSetVersion: "rules:legacy",
    parameterDefinitions,
  };
  const legacyEntries = adaptLegacyCalculationTraceToCanonical(legacyInput);
  assert.equal(legacyEntries[0].layer, "boundary");
  assert.equal(legacyEntries[0].operation, "set");
  assert.equal(legacyEntries[0].evidence?.adapter, "legacy_calculation_trace/v1");
  assert.equal(verifyCalculationTraceArchive(createCalculationTraceArchive(legacyEntries)), true);
});

test("pricing Trace 必须逐步连续且最终值等于 purchasePrice", () => {
  const pricing = {
    formal: true,
    pricingPolicyRef: "pricing:1",
    pricingWeightBandId: "band:1",
    pricingBasketId: "basket:1",
    repairPriceUnrounded: 10,
    purchasePriceUnrounded: 12,
    purchasePrice: 12,
    moneyUnit: "金币",
    trace: [
      {
        sequence: 1,
        formulaStep: "repair",
        sourceRevision: "sheet:r4",
        source: { sheetId: "sheet:1", cell: "A1" },
        before: 1,
        operation: "multiply" as const,
        operand: 10,
        after: 10,
        inputStatus: "CONFIRMED" as const,
      },
      {
        sequence: 2,
        formulaStep: "purchase",
        sourceRevision: "sheet:r4",
        source: { sheetId: "sheet:1", cell: "A2" },
        before: 10,
        operation: "multiply" as const,
        operand: 1.2,
        after: 12,
        inputStatus: "CONFIRMED" as const,
      },
    ],
    issues: [],
    warnings: [],
    inputHash: "pricing-input",
  };
  const entries = adaptPricingTraceToCanonical({
    pricing,
    subjectRef,
    ruleSetVersion: "rules:1",
  });
  assert.deepEqual(entries.map((item) => item.parameterKey), [
    "pricing:purchase_price",
    "pricing:purchase_price",
  ]);
  assert.equal(verifyCalculationTraceArchive(createCalculationTraceArchive(entries)), true);
  const historicalV1Entries = entries.map((item, index) => {
    const generatedKeys = new Set(["schemaVersion", "traceEntryId", "inputHash", "outputHash"]);
    const entryInput = Object.fromEntries(
      Object.entries(item).filter(([key]) => !generatedKeys.has(key)),
    ) as unknown as CreateCalculationTraceEntryInput;
    const sourceEntry = pricing.trace[index];
    return createCalculationTraceEntry({
      ...entryInput,
      parameterKey: `pricing:${sourceEntry.formulaStep}:${sourceEntry.sequence}`,
      evidence: { ...item.evidence, adapter: "pricing_trace/v1" },
    });
  });
  assert.doesNotThrow(() => assertCalculationTraceMatchesPricing({
    archive: createCalculationTraceArchive(historicalV1Entries),
    subjectRef,
    pricing,
    ruleSetVersion: "rules:1",
  }));
  const versionDowngrade = structuredClone(entries);
  for (const item of versionDowngrade) {
    item.evidence!.adapter = "pricing_trace/v1";
  }
  assert.throws(
    () => assertCalculationTraceMatchesPricing({
      archive: createCalculationTraceArchive(versionDowngrade),
      subjectRef,
      pricing,
      ruleSetVersion: "rules:1",
    }),
    /canonical pricing Trace 与冻结的 automaticPricing 不一致/,
  );
  assert.throws(
    () => adaptPricingTraceToCanonical({
      pricing: {
        ...pricing,
        trace: [
          pricing.trace[0],
          { ...pricing.trace[1], before: 11 },
        ],
      },
      subjectRef,
      ruleSetVersion: "rules:1",
    }),
    /pricing Trace 步骤不连续/,
  );
  assert.throws(
    () => adaptPricingTraceToCanonical({
      pricing: { ...pricing, purchasePrice: 13 },
      subjectRef,
      ruleSetVersion: "rules:1",
    }),
    /最终值与 purchasePrice 不一致/,
  );
});

test("rule formula 降级为 set 时无损保留公式身份、版本和原始 operand", () => {
  const formulaProjection = structuredClone(projection);
  formulaProjection.trace = [{
    layer: "function",
    sourceIds: ["formula-source"],
    contributions: [{
      sequence: 1,
      ruleId: "formula:drag-plus-two",
      sourceId: "formula-source",
      sourceName: "公式规则",
      parameterKey: "drag",
      operation: "formula",
      before: 10,
      operand: "drag + 2",
      after: 12,
    }],
  }];
  const [formulaEntry] = adaptRuleTraceToCanonical({
    projection: formulaProjection,
    subjectRef,
    parameterDefinitions,
  });
  assert.equal(formulaEntry.operation, "set");
  assert.equal(formulaEntry.operand, 12);
  assert.equal(formulaEntry.evidence?.legacyOperand, "drag + 2");
  assert.deepEqual(formulaEntry.evidence?.formula, {
    formulaId: "formula:drag-plus-two",
    formulaVersion: "rules:7",
    operand: "drag + 2",
  });
});
