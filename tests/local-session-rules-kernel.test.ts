import assert from "node:assert/strict";
import test from "node:test";

import type { LocalSessionDocument } from "../lib/local-session-contracts";
import {
  deriveLocalSessionTemplate,
  validateLocalSessionDocument,
} from "../lib/local-session-rules-kernel";

function fixture(): LocalSessionDocument {
  return {
    title: "fixture",
    notes: "",
    parameters: [{
      id: "p-pull",
      key: "pull",
      label: "拉力",
      itemPart: "rod",
      unit: "kgf",
      precision: 2,
      notes: "",
    }],
    templates: [{
      id: "t-medium",
      name: "中型",
      itemPart: "rod",
      targetPullMinKgf: 2,
      nominalTargetPullKgf: 3,
      targetPullMaxKgf: 4,
      values: { pull: 3 },
      notes: "",
    }],
    rules: [
      {
        id: "later",
        sourceKind: "layer",
        sourceId: "layer:final",
        sourceName: "收尾",
        sequence: 2,
        parameterKey: "pull",
        operation: "multiply",
        value: 2,
        condition: "",
        notes: "",
        enabled: true,
      },
      {
        id: "first",
        sourceKind: "method",
        sourceId: "method:lure",
        sourceName: "路亚",
        sequence: 1,
        parameterKey: "pull",
        operation: "add",
        value: 1,
        condition: "",
        notes: "",
        enabled: true,
      },
    ],
  };
}

test("derivation is deterministic, ordered and source-traceable", () => {
  const first = deriveLocalSessionTemplate(fixture(), "t-medium");
  const second = deriveLocalSessionTemplate(fixture(), "t-medium");
  assert.deepEqual(first, second);
  assert.equal(first.values.pull, 8);
  assert.deepEqual(first.trace.map((entry) => entry.ruleId), ["first", "later"]);
  assert.deepEqual(first.trace.map((entry) => entry.traceId), [
    "000001:first",
    "000002:later",
  ]);
  assert.equal(first.issues.length, 0);
});

test("boundary/conflict validation fails closed without interpolating templates", () => {
  const document = fixture();
  document.templates[0] = {
    ...document.templates[0]!,
    targetPullMinKgf: 5,
    nominalTargetPullKgf: 3,
  };
  document.rules.push({
    ...document.rules[0]!,
    id: "missing-param",
    sequence: 3,
    parameterKey: "unknown",
    condition: "fishWeight > 5",
  });
  const issues = validateLocalSessionDocument(document);
  assert.ok(issues.some((issue) => issue.code === "INVALID_TEMPLATE_PULL_RANGE"));
  assert.ok(issues.some((issue) => issue.code === "RULE_PARAMETER_NOT_DECLARED"));
  const derived = deriveLocalSessionTemplate(document, "missing");
  assert.deepEqual(derived.values, {});
  assert.ok(derived.issues.some((issue) => issue.code === "TEMPLATE_NOT_FOUND"));
});

test("condition semantics are preserved but not guessed by the local kernel", () => {
  const document = fixture();
  document.rules[0] = {
    ...document.rules[0]!,
    condition: "method == lure",
  };
  const derived = deriveLocalSessionTemplate(document, "t-medium");
  assert.equal(derived.values.pull, 4);
  assert.equal(derived.trace[1]?.status, "skipped");
  assert.match(derived.trace[1]?.message ?? "", /不推断条件语义/);
});
