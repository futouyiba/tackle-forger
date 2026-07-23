import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptLegacyCalculationTraceToCanonical,
  adaptPatchTraceToCanonical,
  adaptPricingTraceToCanonical,
  adaptRuleTraceToCanonical,
  CalculationTraceReplayError,
  createCalculationTraceArchive,
  createCalculationTraceEntry,
  replayCalculationTrace,
  tryReplayCalculationTrace,
  verifyCalculationTraceArchive,
  type CalculationTraceEntry,
} from "../lib/calculation-trace";
import type { EntityRef } from "../lib/interaction-contracts";
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
  assert.equal(pricingEntries[0].evidence?.adapter, "pricing_trace/v1");

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
