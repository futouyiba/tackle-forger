import assert from "node:assert/strict";
import test from "node:test";
import {
  createPerformanceSummaryDefinition,
  derivePerformanceSummary,
  replayPerformanceSummary,
  resolvePerformanceSummaryDefinition,
  unavailablePerformanceSummary,
  verifyPerformanceSummaryDefinition,
} from "../lib/performance-summary";
import type { ProjectionTraceStep } from "../lib/types";

const trace: ProjectionTraceStep[] = [
  {
    layer: "attribute_affix",
    sourceIds: ["affix:light"],
    contributions: [{
      sequence: 7,
      ruleId: "affix:light:weight",
      sourceId: "affix:light",
      sourceName: "轻量",
      parameterKey: "杆自重g",
      operation: "add",
      before: 120,
      operand: -15,
      after: 105,
    }],
  },
];

function definition() {
  return createPerformanceSummaryDefinition({
    definitionId: "performance-summary:rod-v1",
    definitionVersion: "1.0.0",
    publicationState: "PUBLISHED",
    rules: [
      {
        key: "rod_light",
        label: "重量-",
        direction: "positive",
        order: 30,
        matcher: {
          source: "final_panel",
          parameterKey: "杆自重g",
          comparison: "lte",
          threshold: 110,
        },
      },
      {
        key: "cast_plus",
        label: "抛投+",
        direction: "positive",
        order: 10,
        matcher: { source: "technology", technologyId: "tech:cast" },
      },
      {
        key: "sensitive",
        label: "感度+",
        direction: "contextual",
        order: 20,
        matcher: { source: "affix", affixId: "affix:sensitive" },
      },
    ],
  });
}

test("PerformanceSummary 按定义稳定派生 Technology、Affix、最终属性与 Trace 证据", () => {
  const currentDefinition = definition();
  const input = {
    subjectId: "model:1",
    subjectRevisionId: "3",
    definition: currentDefinition,
    technologyIds: ["tech:cast", "tech:cast"],
    affixIds: ["affix:sensitive"],
    finalPanelValues: { "杆最大拉力kgf": 8, "杆自重g": 105 },
    attributeTrace: trace,
  };
  const first = derivePerformanceSummary(input);
  const second = derivePerformanceSummary(structuredClone(input));
  assert.deepEqual(second, first);
  assert.equal(first.status, "AVAILABLE");
  if (first.status !== "AVAILABLE") return;
  assert.deepEqual(first.summary.labels.map((entry) => entry.key), [
    "cast_plus",
    "sensitive",
    "rod_light",
  ]);
  assert.deepEqual(first.summary.labels[0].evidenceRefs, ["technology:tech:cast"]);
  assert.deepEqual(first.summary.labels[1].evidenceRefs, ["affix:affix:sensitive"]);
  assert.deepEqual(first.summary.labels[2].evidenceRefs, [
    "final_panel:杆自重g",
    "trace:attribute_affix:7:affix:light:affix:light:weight",
  ]);
  assert.equal(first.summary.labels[2].magnitude, 5);
  assert.equal(first.summary.definitionHash, currentDefinition.definitionHash);
  assert.equal(first.definitionRef.definitionHash, currentDefinition.definitionHash);
  assert.equal(verifyPerformanceSummaryDefinition(currentDefinition), true);
});

test("同一 definitionId 与 version 的不同内容在不可变注册表中 fail closed", () => {
  const firstDefinition = definition();
  const secondDefinition = createPerformanceSummaryDefinition({
    ...firstDefinition,
    rules: firstDefinition.rules.map((rule) =>
      rule.key === "cast_plus" ? { ...rule, label: "抛投++" } : rule),
  });
  assert.notEqual(firstDefinition.definitionHash, secondDefinition.definitionHash);
  assert.throws(() => resolvePerformanceSummaryDefinition({
    definitions: [firstDefinition, secondDefinition],
    definitionId: firstDefinition.definitionId,
    definitionVersion: firstDefinition.definitionVersion,
  }), /存在内容冲突/);
});

test("Snapshot 冻结完整定义 payload，可不依赖外部注册表独立重放", () => {
  const currentDefinition = definition();
  const input = {
    subjectId: "model:1",
    subjectRevisionId: "3",
    definition: currentDefinition,
    technologyIds: ["tech:cast"],
    affixIds: ["affix:sensitive"],
    finalPanelValues: { "杆自重g": 105 },
    attributeTrace: trace,
  };
  const snapshot = derivePerformanceSummary(input);
  assert.equal(snapshot.status, "AVAILABLE");
  if (snapshot.status !== "AVAILABLE") return;
  assert.deepEqual(snapshot.definitionRef.definition, currentDefinition);
  assert.deepEqual(replayPerformanceSummary({
    snapshot,
    technologyIds: input.technologyIds,
    affixIds: input.affixIds,
    finalPanelValues: input.finalPanelValues,
    attributeTrace: input.attributeTrace,
  }), snapshot);
});

test("PerformanceSummary 输入变化更新 hash 与标签，但不会回写输入", () => {
  const currentDefinition = definition();
  const original = {
    "杆最大拉力kgf": 8,
    "杆自重g": 105,
  };
  const first = derivePerformanceSummary({
    subjectId: "model:1",
    subjectRevisionId: "3",
    definition: currentDefinition,
    technologyIds: [],
    affixIds: [],
    finalPanelValues: original,
    attributeTrace: trace,
  });
  const second = derivePerformanceSummary({
    subjectId: "model:1",
    subjectRevisionId: "4",
    definition: currentDefinition,
    technologyIds: [],
    affixIds: [],
    finalPanelValues: { ...original, "杆自重g": 115 },
    attributeTrace: trace,
  });
  assert.equal(first.status, "AVAILABLE");
  assert.equal(second.status, "AVAILABLE");
  if (first.status !== "AVAILABLE" || second.status !== "AVAILABLE") return;
  assert.notEqual(first.summary.inputHash, second.summary.inputHash);
  assert.equal(first.summary.labels.some((entry) => entry.key === "rod_light"), true);
  assert.equal(second.summary.labels.some((entry) => entry.key === "rod_light"), false);
  assert.deepEqual(original, { "杆最大拉力kgf": 8, "杆自重g": 105 });
});

test("缺少定义冻结精确 UNAVAILABLE 分支，草稿或被篡改定义 fail closed", () => {
  assert.deepEqual(unavailablePerformanceSummary(), {
    status: "UNAVAILABLE",
    reason: "definition_missing",
  });
  assert.deepEqual(derivePerformanceSummary({
    subjectId: "model:1",
    subjectRevisionId: "1",
    technologyIds: [],
    affixIds: [],
    finalPanelValues: {},
    attributeTrace: [],
  }), unavailablePerformanceSummary());

  const draft = createPerformanceSummaryDefinition({
    ...definition(),
    publicationState: "DRAFT",
  });
  assert.throws(() => derivePerformanceSummary({
    subjectId: "model:1",
    subjectRevisionId: "1",
    definition: draft,
    technologyIds: [],
    affixIds: [],
    finalPanelValues: {},
    attributeTrace: [],
  }), /未发布或完整性校验失败/);

  const tampered = { ...definition(), definitionVersion: "changed" };
  assert.equal(verifyPerformanceSummaryDefinition(tampered), false);
});
