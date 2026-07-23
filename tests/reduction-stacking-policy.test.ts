import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFormalSnapshotHasReplayPolicy,
  assertSnapshotReplayPolicyAvailable,
  applyParameterDefinitions,
  canonicalizeAffixOperations,
  createSnapshotAuditReplayManifest,
  evaluateBidirectionalRatio,
  importReductionStackingPolicyDraft,
  numberToBinary64Hex,
  publishReductionStackingPolicyVersion,
  type ReductionPolicyMachineRule,
} from "../lib/reduction-stacking-policy";
import { createSeedState } from "../lib/seed";
import { createUpgradeCandidate, verifySnapshotIntegrity } from "../lib/publishing";
import type {
  CanonicalAttributeOperation,
  ReductionStackingPolicyVersion,
  V3Affix,
} from "../lib/types";
import type { FeishuSourceRevision } from "../lib/feishu-workbook";

const machineRules: ReductionPolicyMachineRule[] = [{
  ruleId: "OPEN-001:bidirectional-ratio",
  parameterKey: "*",
  strategy: "bidirectional_ratio",
  numericContract: "ieee754-binary64-v1",
  operationOrder: [
    "set",
    "percent_adjust",
    "flat_adjust",
    "clamp_add",
    "final_review_patch",
    "parameter_definition",
  ],
}];

function sourceRevision(
  sourceRevisionValue = "machine-revision-1",
): FeishuSourceRevision {
  return {
    id: `feishu-revision:${sourceRevisionValue}`,
    workbookRefId: "feishu-workbook:tackle-design",
    sourceRevision: sourceRevisionValue,
    spreadsheetToken: "spreadsheet:canonical",
    pulledAt: "2026-07-23T01:00:00.000Z",
    pulledBy: "tester",
    syncScope: "workbook",
    registryHash: "registry",
    sheets: [{ sheetId: "zrVOxd", name: "04_词条" }],
    issues: [],
    reductionPolicyMachineRules: machineRules,
    state: "RULESET_DRAFT",
  };
}

function publishedPolicy(): ReductionStackingPolicyVersion {
  const draft = importReductionStackingPolicyDraft({
    sourceRevision: sourceRevision(),
    machineRules,
    createdAt: "2026-07-23T01:01:00.000Z",
  });
  return publishReductionStackingPolicyVersion({
    draft,
    publishedAt: "2026-07-23T01:02:00.000Z",
    publishedBy: "reviewer",
  });
}

function operation(
  operationId: string,
  operationIndex: number,
  operationType: CanonicalAttributeOperation["operation"],
  fields: Partial<CanonicalAttributeOperation> = {},
): CanonicalAttributeOperation {
  return {
    operationId,
    operationIndex,
    sourceAffixId: fields.sourceAffixId ?? "affix:a",
    sourceAffixRevision: fields.sourceAffixRevision ?? "1",
    parameterKey: fields.parameterKey ?? "force",
    operation: operationType,
    ...(["percent_adjust", "flat_adjust", "clamp_add"].includes(operationType)
      ? {
          publishedMagnitudeRange: fields.publishedMagnitudeRange ?? {
            min: 0,
            max: Number.MAX_VALUE,
            ruleSetVersion: "test:affix-ranges:v1",
          },
        }
      : {}),
    ...fields,
  };
}

test("权威机器规则缺失时给出 REDUCTION_POLICY_SOURCE_MISSING，外部 revision 17173 永不成为运行时源", () => {
  const missing = importReductionStackingPolicyDraft({
    sourceRevision: sourceRevision(),
    createdAt: "2026-07-23T01:01:00.000Z",
  });
  assert.equal(missing.status, "draft");
  assert.ok(missing.issues.some((issue) =>
    issue.code === "REDUCTION_POLICY_SOURCE_MISSING"
    && issue.severity === "BLOCKER"
    && issue.gate === "PUBLISH"
  ));
  assert.throws(
    () => publishReductionStackingPolicyVersion({
      draft: missing,
      publishedAt: "2026-07-23T01:02:00.000Z",
      publishedBy: "reviewer",
    }),
    /REDUCTION_POLICY_SOURCE_MISSING/,
  );

  const external = importReductionStackingPolicyDraft({
    sourceRevision: sourceRevision("17173"),
    machineRules,
    createdAt: "2026-07-23T01:01:00.000Z",
  });
  assert.ok(external.issues.some((issue) => issue.code === "REDUCTION_POLICY_SOURCE_INVALID"));
  assert.throws(
    () => publishReductionStackingPolicyVersion({
      draft: external,
      publishedAt: "2026-07-23T01:02:00.000Z",
      publishedBy: "reviewer",
    }),
    /REDUCTION_POLICY_SOURCE_INVALID/,
  );
});

test("策略发布拒绝与规范内容不一致的 hash、version 和 ID", () => {
  const draft = importReductionStackingPolicyDraft({
    sourceRevision: sourceRevision(),
    machineRules,
    createdAt: "2026-07-23T01:01:00.000Z",
  });
  for (const tampered of [
    { ...draft, inputHash: "tampered" },
    { ...draft, contentHash: "tampered" },
    { ...draft, version: "tampered" },
    { ...draft, id: "reduction-policy:bidirectional-ratio:tampered" },
    { ...draft, source: { ...draft.source!, sourceRevision: "tampered" } },
  ]) {
    assert.throws(
      () => publishReductionStackingPolicyVersion({
        draft: tampered,
        publishedAt: "2026-07-23T01:02:00.000Z",
        publishedBy: "reviewer",
      }),
      /REDUCTION_POLICY_CONTENT_MISMATCH/,
    );
  }
});

test("运行时拒绝被原地篡改的已发布策略形成正式证据", () => {
  const policy = publishedPolicy();
  const result = evaluateBidirectionalRatio({
    baseValues: { force: 100 },
    operations: [],
    policy: {
      ...policy,
      source: { ...policy.source!, sourceRevision: "tampered" },
    },
  });
  assert.equal(result.formalStatus, "NON_FORMAL");
  assert.ok(result.issues.some((entry) =>
    entry.code === "REDUCTION_POLICY_SOURCE_MISSING"
    && entry.severity === "BLOCKER"
  ));
});

test("bidirectional_ratio 是唯一公式，固定顺序与 binary64 Trace/hash 对输入排列不敏感", () => {
  const policy = publishedPolicy();
  const operations = [
    operation("percent:decrease", 3, "percent_adjust", {
      sourceAffixId: "affix:z",
      direction: "decrease",
      magnitude: 0.5,
      rawLexical: "0.5",
    }),
    operation("flat:increase", 1, "flat_adjust", {
      sourceAffixId: "affix:b",
      direction: "increase",
      magnitude: 10,
    }),
    operation("percent:increase", 0, "percent_adjust", {
      sourceAffixId: "affix:a",
      direction: "increase",
      magnitude: 0.2,
      rawLexical: "0.2",
    }),
    operation("flat:decrease", 2, "flat_adjust", {
      sourceAffixId: "affix:c",
      direction: "decrease",
      magnitude: 3,
    }),
    operation("clamp", 4, "clamp_add", {
      sourceAffixId: "affix:zz",
      direction: "increase",
      magnitude: 20,
      clampMin: 0,
      clampMax: 100,
    }),
  ];
  const first = evaluateBidirectionalRatio({
    baseValues: { force: 100 },
    operations,
    policy,
  });
  const second = evaluateBidirectionalRatio({
    baseValues: { force: 100 },
    operations: [...operations].reverse(),
    policy,
  });
  assert.equal(first.formalStatus, "FORMAL");
  assert.equal(first.values.force, 100);
  assert.equal(first.traceHash, second.traceHash);
  assert.deepEqual(first.trace, second.trace);
  assert.equal(
    first.trace.find((entry) => entry.ruleId === "bidirectional_ratio:force")
      ?.numericEvidence?.afterBinary64,
    numberToBinary64Hex(80),
  );
  assert.ok(first.trace.every((entry) =>
    typeof entry.numericEvidence?.afterBinary64 === "string"
    || typeof entry.after !== "number"
  ));
});

test("binary64 固定向量覆盖最大值、正规/次正规数、下溢和稳定左折叠", () => {
  const policy = publishedPolicy();
  const result = (
    base: number,
    operations: CanonicalAttributeOperation[],
  ) => evaluateBidirectionalRatio({
    baseValues: { force: base },
    operations,
    policy,
  });
  assert.equal(
    numberToBinary64Hex(result(Number.MAX_VALUE, [
      operation("zero", 0, "percent_adjust", { direction: "increase", magnitude: 0 }),
    ]).values.force as number),
    "7fefffffffffffff",
  );
  const overflow = result(Number.MAX_VALUE, [
    operation("double", 0, "percent_adjust", { direction: "increase", magnitude: 1 }),
  ]);
  assert.ok(overflow.issues.some((issue) =>
    issue.code === "AFFIX_NUMERIC_OVERFLOW"
    && issue.severity === "BLOCKER"
    && issue.gate === "REVIEW"
  ));
  const minNormal = Number.MIN_VALUE * 2 ** 52;
  assert.equal(
    numberToBinary64Hex(result(minNormal, [
      operation("halve", 0, "percent_adjust", { direction: "decrease", magnitude: 1 }),
    ]).values.force as number),
    "0008000000000000",
  );
  const underflow = result(Number.MIN_VALUE, [
    operation("halve", 0, "percent_adjust", { direction: "decrease", magnitude: 1 }),
  ]);
  assert.ok(underflow.issues.some((issue) =>
    issue.code === "AFFIX_NUMERIC_UNDERFLOW_TO_ZERO"
  ));
  assert.equal(
    numberToBinary64Hex(result(0, [
      operation("min-subnormal", 0, "flat_adjust", {
        direction: "increase",
        magnitude: Number.MIN_VALUE,
      }),
    ]).values.force as number),
    "0000000000000001",
  );
  const leftFold = result(1, [
    operation("large", 0, "percent_adjust", {
      sourceAffixId: "affix:a",
      direction: "increase",
      magnitude: 2 ** 53,
    }),
    operation("one-a", 1, "percent_adjust", {
      sourceAffixId: "affix:a",
      direction: "increase",
      magnitude: 1,
    }),
    operation("one-b", 2, "percent_adjust", {
      sourceAffixId: "affix:a",
      direction: "increase",
      magnitude: 1,
    }),
  ]);
  const poolEnd = leftFold.trace.filter(
    (entry) => entry.numericEvidence?.stage === "percent_increase_pool",
  ).at(-1);
  assert.equal(poolEnd?.numericEvidence?.afterBinary64, "4340000000000000");
  const invalidLexical = result(100, [
    operation("invalid-lexical", 0, "percent_adjust", {
      direction: "increase",
      magnitude: 0.5,
      rawLexical: "not-a-number",
    }),
  ]);
  assert.ok(invalidLexical.issues.some((issue) =>
    issue.code === "AFFIX_NUMERIC_INPUT_INVALID"
    && issue.severity === "BLOCKER"
    && issue.gate === "REVIEW"
  ));
  assert.equal(invalidLexical.formalStatus, "NON_FORMAL");
});

test("canonical direction+magnitude 迁移保留 -0 证据；冲突隔离整个 Affix revision", () => {
  const legacy: V3Affix = {
    id: "affix:legacy-zero",
    version: 4,
    name: "legacy",
    category: "attribute",
    itemPartId: "part:rod",
    generationPolicy: "normal",
    rarity: "common",
    valueScore: 0,
    tags: [],
    attributeEffects: [{
      id: "legacy-zero",
      parameterKey: "force",
      operation: "percent_bonus",
      value: -0,
      unit: "%",
      stackingGroup: "force",
      ruleSetVersion: "legacy",
    }],
    description: "",
    enabled: true,
  };
  const canonical = canonicalizeAffixOperations([legacy]);
  assert.equal(canonical.operations[0].direction, "increase");
  assert.equal(canonical.operations[0].magnitude, 0);
  assert.equal(canonical.operations[0].migrationEvidence?.negativeZero, true);

  const conflict: V3Affix = {
    ...legacy,
    id: "affix:conflict",
    attributeEffects: [{
      id: "conflict",
      operationId: "conflict",
      operationIndex: 0,
      sourceAffixId: "affix:conflict",
      sourceAffixRevision: "4",
      parameterKey: "force",
      operation: "percent_adjust",
      direction: "increase",
      magnitude: 0.1,
      value: -0.1,
      unit: "%",
      stackingGroup: "force",
      ruleSetVersion: "legacy",
    }],
  };
  const isolated = canonicalizeAffixOperations([conflict]);
  assert.equal(isolated.operations.length, 0);
  assert.deepEqual(isolated.isolatedAffixRevisionIds, ["affix:conflict@4"]);
  assert.ok(isolated.issues.some((issue) =>
    issue.code === "AFFIX_DIRECTION_CONFLICT"
    && issue.gate === "REVIEW"
  ));

  const namedNegative = canonicalizeAffixOperations([{
    ...legacy,
    id: "affix:named-negative",
    attributeEffects: [{
      ...legacy.attributeEffects[0],
      id: "named-negative",
      value: -0.1,
    }],
  }]);
  assert.equal(namedNegative.operations.length, 0);
  assert.deepEqual(
    namedNegative.isolatedAffixRevisionIds,
    ["affix:named-negative@4"],
  );
  assert.ok(namedNegative.issues.some((entry) =>
    entry.code === "AFFIX_DIRECTION_CONFLICT"
    && entry.severity === "ERROR"
  ));
});

test("sourceAffixRevision 按 unsigned UTF-8 字节序排序，不按数值大小排序", () => {
  const result = evaluateBidirectionalRatio({
    baseValues: { force: 1 },
    policy: publishedPolicy(),
    operations: [
      operation("revision-2", 0, "percent_adjust", {
        sourceAffixRevision: "2",
        direction: "increase",
        magnitude: 1,
      }),
      operation("revision-10", 0, "percent_adjust", {
        sourceAffixRevision: "10",
        direction: "increase",
        magnitude: 2 ** 53,
      }),
    ],
  });
  assert.deepEqual(
    result.trace
      .filter((entry) => entry.numericEvidence?.stage === "percent_increase_pool")
      .map((entry) => entry.ruleId),
    ["revision-10", "revision-2"],
  );
});

test("magnitude 必须落在已发布词条版本声明范围内，端点包含且越界不可豁免", () => {
  const policy = publishedPolicy();
  const endpoint = evaluateBidirectionalRatio({
    baseValues: { force: 10 },
    policy,
    operations: [operation("endpoint", 0, "percent_adjust", {
      direction: "increase",
      magnitude: 0.5,
      publishedMagnitudeRange: {
        min: 0.1,
        max: 0.5,
        ruleSetVersion: "affix-range:v1",
      },
    })],
  });
  assert.equal(endpoint.formalStatus, "FORMAL");
  const outside = evaluateBidirectionalRatio({
    baseValues: { force: 10 },
    policy,
    operations: [operation("outside", 0, "percent_adjust", {
      direction: "increase",
      magnitude: 0.5000000000000001,
      publishedMagnitudeRange: {
        min: 0.1,
        max: 0.5,
        ruleSetVersion: "affix-range:v1",
      },
    })],
  });
  const issue = outside.issues.find(
    (entry) => entry.code === "AFFIX_MAGNITUDE_OUT_OF_RANGE",
  );
  assert.equal(issue?.severity, "ERROR");
  assert.equal(issue?.gate, "REVIEW");
  assert.equal(issue?.evidence?.waivable, false);
  assert.equal(outside.formalStatus, "NON_FORMAL");
});

test("旧效果的 ruleSetVersion 不能伪造 magnitude 点范围，真实范围缺失时 fail-closed", () => {
  const legacy: V3Affix = {
    id: "affix:legacy-range-missing",
    version: 7,
    name: "缺少真实范围",
    category: "attribute",
    itemPartId: "part:rod",
    generationPolicy: "normal",
    rarity: "common",
    valueScore: 12,
    tags: [],
    attributeEffects: [{
      id: "legacy-range-missing",
      parameterKey: "force",
      operation: "percent_bonus",
      value: 0.25,
      unit: "%",
      stackingGroup: "force",
      ruleSetVersion: "ruleset:legacy",
    }],
    description: "",
    enabled: true,
  };
  const canonical = canonicalizeAffixOperations([legacy]);
  assert.equal(canonical.operations.length, 1);
  assert.equal(canonical.operations[0].publishedMagnitudeRange, undefined);

  const evaluated = evaluateBidirectionalRatio({
    baseValues: { force: 100 },
    operations: canonical.operations,
    policy: publishedPolicy(),
  });
  assert.ok(evaluated.issues.some((entry) =>
    entry.code === "AFFIX_MAGNITUDE_RANGE_MISSING"
    && entry.severity === "BLOCKER"
    && entry.gate === "REVIEW"
  ));
  assert.equal(evaluated.formalStatus, "NON_FORMAL");
  assert.equal(evaluated.values.force, 100);
});

test("历史 Snapshot 保持完整、允许查看/审计归档，但缺策略时禁止正式导出并用 UpgradeCandidate 升级", () => {
  const state = createSeedState();
  const snapshot = state.configurationSnapshots[0];
  assert.equal(verifySnapshotIntegrity(snapshot), true);
  assert.equal(snapshot.reductionStackingPolicyVersion, undefined);
  assert.deepEqual(assertSnapshotReplayPolicyAvailable({
    reductionStackingPolicyVersion: snapshot.reductionStackingPolicyVersion,
    availablePolicies: [],
    operation: "view",
  }), []);
  const archive = createSnapshotAuditReplayManifest({
    snapshot,
    availablePolicies: [],
  });
  assert.equal(archive.replayStatus, "POLICY_MISSING");
  assert.equal(archive.formalExportAllowed, false);
  assert.ok(archive.issues.some((issue) =>
    issue.code === "SNAPSHOT_REPLAY_POLICY_MISSING"
    && issue.gate === "EXPORT"
  ));
  assert.throws(() => assertFormalSnapshotHasReplayPolicy(snapshot, []), /SNAPSHOT_REPLAY_POLICY_MISSING/);

  const policy = publishedPolicy();
  const replayableSnapshot = structuredClone(snapshot);
  replayableSnapshot.reductionStackingPolicyVersion = policy.version;
  assert.doesNotThrow(() =>
    assertFormalSnapshotHasReplayPolicy(replayableSnapshot, [policy])
  );
  assert.doesNotThrow(() =>
    assertFormalSnapshotHasReplayPolicy(replayableSnapshot, [{
      ...policy,
      status: "superseded",
    }])
  );
  assert.throws(() =>
    assertFormalSnapshotHasReplayPolicy(replayableSnapshot, [{
      ...policy,
      version: "different-published-policy",
    }])
  , /SNAPSHOT_REPLAY_POLICY_MISSING/);
  for (const status of ["published", "superseded"] as const) {
    for (const tampered of [
      { ...policy, status, inputHash: "tampered" },
      { ...policy, status, contentHash: "tampered" },
      { ...policy, status, id: "reduction-policy:bidirectional-ratio:tampered" },
      { ...policy, status, source: { ...policy.source!, sourceRevisionId: "tampered" } },
      { ...policy, status, source: { ...policy.source!, sourceRevision: "tampered" } },
      { ...policy, status, source: { ...policy.source!, ruleId: "tampered" } },
      { ...policy, status, source: { ...policy.source!, parameterKey: "tampered" } },
    ]) {
      assert.throws(
        () => assertFormalSnapshotHasReplayPolicy(replayableSnapshot, [tampered]),
        /SNAPSHOT_REPLAY_POLICY_MISSING/,
      );
    }
  }
  const proposedProjection = {
    ...state.derivedProjections.find((entry) => entry.id === snapshot.projectionId)!,
    id: "projection:policy-upgrade",
    reductionStackingPolicyVersion: policy.version,
    formalStatus: "FORMAL" as const,
  };
  const upgrade = createUpgradeCandidate({
    id: "upgrade:policy",
    modelId: snapshot.modelId,
    currentSnapshot: snapshot,
    proposedProjection,
    proposedValues: proposedProjection.values,
    patches: [],
    validationReport: [],
    createdAt: "2026-07-23T02:00:00.000Z",
  });
  assert.equal(upgrade.fromSnapshotId, snapshot.id);
  assert.equal(upgrade.proposedReductionStackingPolicyVersion, policy.version);
  assert.equal(verifySnapshotIntegrity(snapshot), true);
});

test("ParameterDefinition 非法 precision 或 targetRange 保留原值并 fail-closed", () => {
  for (const definition of [
    { precision: -1, targetRange: { min: 0, max: 100 } },
    { precision: 0.5, targetRange: { min: 0, max: 100 } },
    { precision: Number.POSITIVE_INFINITY, targetRange: { min: 0, max: 100 } },
    { precision: 0, targetRange: { min: 100, max: 0 } },
    { precision: 0, targetRange: { min: Number.NEGATIVE_INFINITY, max: 100 } },
    { precision: 0, targetRange: { min: 0, max: Number.POSITIVE_INFINITY } },
  ]) {
    const result = applyParameterDefinitions({
      values: { force: 50 },
      definitions: [{
        key: "force",
        label: "拉力",
        itemKind: "rod",
        itemPartId: "part:rod",
        unit: "kg",
        benefitMode: "higher_better",
        balanceWeight: 1,
        normalizationScale: 1,
        allowedOperations: ["set"],
        notes: "",
        ...definition,
      }],
    });
    assert.equal(result.values.force, 50);
    assert.equal(result.trace.length, 0);
    assert.ok(result.issues.some((entry) =>
      entry.code === "PARAMETER_DEFINITION_INVALID"
      && entry.severity === "ERROR"
      && entry.gate === "REVIEW"
      && entry.evidence?.waivable === false
    ));
  }
});

test("clamp_add 缺少任一有限端点时隔离参数并保持非正式", () => {
  const policy = publishedPolicy();
  for (const fields of [
    { clampMax: 100 },
    { clampMin: 0 },
    { clampMin: Number.NEGATIVE_INFINITY, clampMax: 100 },
    { clampMin: 0, clampMax: Number.POSITIVE_INFINITY },
  ]) {
    const result = evaluateBidirectionalRatio({
      baseValues: { force: 50 },
      operations: [
        operation("clamp:invalid", 0, "clamp_add", {
          direction: "increase",
          magnitude: 10,
          ...fields,
        }),
      ],
      policy,
    });
    assert.equal(result.values.force, 50);
    assert.equal(result.formalStatus, "NON_FORMAL");
    assert.ok(result.issues.some((entry) =>
      entry.code === "AFFIX_MAGNITUDE_INVALID"
      && entry.severity === "ERROR"
      && entry.gate === "REVIEW"
    ));
  }
});
