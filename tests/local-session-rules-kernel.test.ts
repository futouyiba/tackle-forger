import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocalSessionModel,
  reduceLocalSession,
  type LocalSessionDocument,
  type LocalSessionReducerState,
} from "../lib/local-session-contracts";
import {
  deriveLocalSessionTemplate,
  parseLocalTemplateValuesJson,
  renameLocalSessionParameterKey,
  validateLocalSessionDocument,
} from "../lib/local-session-rules-kernel";

function fixture(): LocalSessionDocument {
  return {
    title: "fixture",
    notes: "",
    sourceIssues: [],
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

test("template pull range requires positive width while allowing nominal boundaries", () => {
  const zeroWidth = fixture();
  zeroWidth.templates[0] = {
    ...zeroWidth.templates[0]!,
    targetPullMinKgf: 3,
    nominalTargetPullKgf: 3,
    targetPullMaxKgf: 3,
  };
  const invalid = deriveLocalSessionTemplate(zeroWidth, "t-medium");
  assert.ok(invalid.issues.some((issue) => issue.code === "INVALID_TEMPLATE_PULL_RANGE"));
  assert.deepEqual(invalid.trace, []);

  for (const nominalTargetPullKgf of [2, 4]) {
    const boundary = fixture();
    boundary.templates[0] = {
      ...boundary.templates[0]!,
      nominalTargetPullKgf,
    };
    assert.equal(
      validateLocalSessionDocument(boundary).some(
        (issue) => issue.code === "INVALID_TEMPLATE_PULL_RANGE",
      ),
      false,
    );
  }
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

test("template JSON draft parser accepts only the closed string/finite-number map", () => {
  assert.deepEqual(
    parseLocalTemplateValuesJson('{"pull":3,"action":"fast"}'),
    { pull: 3, action: "fast" },
  );
  assert.throws(() => parseLocalTemplateValuesJson("{"), SyntaxError);
  assert.throws(() => parseLocalTemplateValuesJson("[]"), /JSON 对象/);
  assert.throws(
    () => parseLocalTemplateValuesJson('{"x":true}'),
    /只能是字符串或有限数值/,
  );
});

test("duplicate Trace sequences fail closed before applying any rule", () => {
  const document = fixture();
  document.rules[1] = {
    ...document.rules[1]!,
    sequence: document.rules[0]!.sequence,
  };
  const derived = deriveLocalSessionTemplate(document, "t-medium");
  assert.equal(derived.values.pull, 3);
  assert.deepEqual(derived.trace, []);
  assert.ok(
    derived.issues.some((issue) => issue.code === "DUPLICATE_RULE_SEQUENCE"),
  );
});

test("numeric set remains numeric and composes with a later add", () => {
  const document = fixture();
  document.rules = [
    {
      ...document.rules[0]!,
      id: "set-number",
      sequence: 0,
      operation: "set",
      value: 4,
    },
    {
      ...document.rules[1]!,
      id: "add-number",
      sequence: 1,
      operation: "add",
      value: 2,
    },
  ];
  const derived = deriveLocalSessionTemplate(document, "t-medium");
  assert.equal(derived.values.pull, 6);
  assert.equal(typeof derived.values.pull, "number");
  assert.deepEqual(derived.trace.map((entry) => entry.status), ["applied", "applied"]);
});

test("formula receives the current numeric value", () => {
  const document = fixture();
  document.rules = [{
    ...document.rules[0]!,
    id: "formula-current",
    sequence: 0,
    operation: "formula",
    value: "current * 1.5",
  }];
  const derived = deriveLocalSessionTemplate(document, "t-medium");
  assert.equal(derived.values.pull, 4.5);
  assert.equal(derived.trace[0]?.status, "applied");
});

test("formula validation and derivation share the strict parser", () => {
  const document = fixture();
  document.rules = [{
    ...document.rules[0]!,
    id: "invalid-formula-character",
    sequence: 0,
    operation: "formula",
    value: "1;",
  }];
  const issues = validateLocalSessionDocument(document);
  assert.ok(
    issues.some((issue) =>
      issue.code === "RULE_FORMULA_INVALID"
      && issue.message.includes("位置 2")
    ),
  );
  const derived = deriveLocalSessionTemplate(document, "t-medium");
  assert.deepEqual(derived.trace, []);
  assert.equal(derived.values.pull, 3);
});

test("derivation exposes runtime evaluation failures as validation issues", () => {
  const document = fixture();
  document.templates[0] = {
    ...document.templates[0]!,
    values: { pull: "non-numeric" },
  };
  const derived = deriveLocalSessionTemplate(document, "t-medium");
  assert.equal(derived.trace[0]?.status, "error");
  assert.ok(
    derived.issues.some((issue) => issue.code === "RULE_EVALUATION_FAILED"),
  );
});

test("non-finite arithmetic results fail closed without polluting later rules", () => {
  for (const [operation, value] of [
    ["add", Number.MAX_VALUE],
    ["multiply", 2],
  ] as const) {
    const document = fixture();
    document.templates[0] = {
      ...document.templates[0]!,
      values: { pull: Number.MAX_VALUE },
    };
    document.rules = [
      {
        ...document.rules[0]!,
        id: `overflow-${operation}`,
        sequence: 0,
        operation,
        value,
      },
      {
        ...document.rules[1]!,
        id: "after-overflow",
        sequence: 1,
        operation: "min",
        value: 10,
      },
    ];
    const derived = deriveLocalSessionTemplate(document, "t-medium");
    assert.equal(derived.trace[0]?.status, "error");
    assert.equal(derived.trace[0]?.after, Number.MAX_VALUE);
    assert.equal(derived.values.pull, 10);
    assert.ok(Number.isFinite(derived.values.pull as number));
    assert.ok(
      derived.issues.some((issue) => issue.code === "RULE_EVALUATION_FAILED"),
    );
  }
});

test("canonical import errors block partial documents and remain visible", () => {
  const document = fixture();
  document.sourceIssues = [{
    severity: "error",
    code: "METHOD_ID_MISSING",
    path: "canonical.sheet-methods.row.2",
    message: "钓法类型缺少机器 ID。",
  }];
  const derived = deriveLocalSessionTemplate(document, "t-medium");
  assert.equal(derived.values.pull, 3);
  assert.deepEqual(derived.trace, []);
  assert.ok(derived.issues.some((issue) => issue.code === "METHOD_ID_MISSING"));
});

test("derivation skips enabled rules belonging to another item part", () => {
  const document = fixture();
  document.parameters.push({
    id: "p-drag",
    key: "drag",
    label: "泄力",
    itemPart: "reel",
    unit: "kgf",
    precision: 2,
    notes: "",
  });
  document.rules.unshift({
    ...document.rules[0]!,
    id: "reel-rule",
    sequence: 0,
    parameterKey: "drag",
    operation: "set",
    value: 99,
  });
  document.rules = document.rules.map((rule, index) => ({
    ...rule,
    sequence: index,
  }));
  const derived = deriveLocalSessionTemplate(document, "t-medium");
  assert.equal("drag" in derived.values, false);
  assert.equal(derived.trace[0]?.status, "skipped");
  assert.match(derived.trace[0]?.message ?? "", /部位 reel 与模板部位 rod 不匹配/);
  assert.equal(derived.issues.length, 0);
});

test("template values from another item part fail closed before preview or formulas", () => {
  const document = fixture();
  document.parameters.push({
    id: "p-drag",
    key: "drag",
    label: "泄力",
    itemPart: "reel",
    unit: "kgf",
    precision: 2,
    notes: "",
  });
  document.templates[0] = {
    ...document.templates[0]!,
    values: {
      ...document.templates[0]!.values,
      drag: 99,
    },
  };
  document.rules.push({
    ...document.rules[0]!,
    id: "formula-from-cross-part",
    sequence: 2,
    operation: "formula",
    value: "drag * 2",
  });

  const issues = validateLocalSessionDocument(document);
  assert.ok(
    issues.some((issue) =>
      issue.code === "TEMPLATE_PARAMETER_ITEM_PART_MISMATCH"
      && issue.path === "templates[0].values.drag"
    ),
  );
  const derived = deriveLocalSessionTemplate(document, "t-medium");
  assert.equal("drag" in derived.values, false);
  assert.deepEqual(derived.trace, []);
  assert.ok(
    derived.issues.some((issue) =>
      issue.code === "TEMPLATE_PARAMETER_ITEM_PART_MISMATCH"
    ),
  );
});

test("undeclared template values are blocking and excluded from preview/formulas", () => {
  for (const rogue of [99, "rogue"]) {
    const document = fixture();
    document.templates[0] = {
      ...document.templates[0]!,
      values: { ...document.templates[0]!.values, rogue },
    };
    document.rules = [{
      ...document.rules[0]!,
      id: "rogue-formula",
      sequence: 0,
      operation: "formula",
      value: "rogue + current",
    }];
    const derived = deriveLocalSessionTemplate(document, "t-medium");
    assert.ok(
      derived.issues.some((issue) =>
        issue.code === "TEMPLATE_PARAMETER_NOT_DECLARED"
        && issue.severity === "error"
      ),
    );
    assert.equal("rogue" in derived.values, false);
    assert.deepEqual(derived.trace, []);
  }
});

test("parameter rename atomically migrates templates, rules and formula tokens", () => {
  const document = fixture();
  document.parameters.push({
    ...document.parameters[0]!,
    id: "p-pull-extra",
    key: "pull_extra",
  });
  document.templates[0] = {
    ...document.templates[0]!,
    values: { pull: 3, pull_extra: 7 },
  };
  document.rules = [{
    ...document.rules[0]!,
    id: "formula-rename",
    parameterKey: "pull",
    operation: "formula",
    value: "pull + pull_extra + current",
  }];

  const renamed = renameLocalSessionParameterKey(document, "p-pull", "force");
  assert.equal(document.parameters[0]?.key, "pull", "input document must stay frozen");
  assert.equal(renamed.parameters[0]?.key, "force");
  assert.deepEqual(renamed.templates[0]?.values, { force: 3, pull_extra: 7 });
  assert.equal(renamed.rules[0]?.parameterKey, "force");
  assert.equal(renamed.rules[0]?.value, "force + pull_extra + current");

  let state: LocalSessionReducerState = {
    status: "active",
    session: createLocalSessionModel({ kind: "temporary_workspace" }, document),
  };
  state = reduceLocalSession(state, {
    type: "commit_local_edit",
    document: renamed,
  });
  assert.equal(state.status, "active");
  if (state.status !== "active") assert.fail("renamed session must remain active");
  assert.equal(state.session.history.undo.length, 1);
  state = reduceLocalSession(state, { type: "undo_local_edit" });
  assert.equal(state.status, "active");
  if (state.status !== "active") assert.fail("undo must remain active");
  assert.equal(state.session.document.parameters[0]?.key, "pull");
  assert.equal(state.session.document.rules[0]?.value, "pull + pull_extra + current");
  state = reduceLocalSession(state, { type: "redo_local_edit" });
  assert.equal(state.status, "active");
  if (state.status !== "active") assert.fail("redo must remain active");
  assert.equal(state.session.document.parameters[0]?.key, "force");
  assert.equal(state.session.document.rules[0]?.value, "force + pull_extra + current");
});

test("parameter rename rejects collisions, invalid/reserved keys and invalid formulas", () => {
  const document = fixture();
  document.parameters.push({
    ...document.parameters[0]!,
    id: "p-other",
    key: "other",
  });
  assert.throws(
    () => renameLocalSessionParameterKey(document, "p-pull", "other"),
    /已存在/,
  );
  assert.throws(
    () => renameLocalSessionParameterKey(document, "p-pull", ""),
    /必须以/,
  );
  assert.throws(
    () => renameLocalSessionParameterKey(document, "p-pull", "1pull"),
    /必须以/,
  );
  assert.throws(
    () => renameLocalSessionParameterKey(document, "p-pull", "current"),
    /保留/,
  );
  document.rules = [{
    ...document.rules[0]!,
    operation: "formula",
    value: "pull;",
  }];
  assert.throws(
    () => renameLocalSessionParameterKey(document, "p-pull", "force"),
    /位置 5/,
  );
  assert.equal(document.parameters[0]?.key, "pull");
});

test("parameter rename rejects template target-key collisions without data or history loss", () => {
  for (const existing of [7, "existing"]) {
    const document = fixture();
    document.templates[0] = {
      ...document.templates[0]!,
      values: { pull: 3, force: existing },
    };
    const frozen = structuredClone(document);
    const session = createLocalSessionModel(
      { kind: "temporary_workspace" },
      document,
    );
    assert.throws(
      () => renameLocalSessionParameterKey(document, "p-pull", "force"),
      /已同时包含参数键/,
    );
    assert.deepEqual(document, frozen);
    assert.deepEqual(session.document, frozen);
    assert.equal(session.history.current.sequence, 0);
    assert.deepEqual(session.history.undo, []);
    assert.deepEqual(session.history.redo, []);
  }
});
