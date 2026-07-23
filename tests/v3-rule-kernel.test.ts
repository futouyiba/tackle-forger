import assert from "node:assert/strict";
import test from "node:test";
import workspaceV1 from "./fixtures/workspace-v1.json";
import {
  CURRENT_WORKSPACE_SCHEMA_VERSION,
  migrateWorkspaceState,
} from "../lib/migrations";
import { createSeedState } from "../lib/seed";
import {
  applyReduction,
  deriveProjection,
  type DeriveProjectionInput,
} from "../lib/rule-kernel";
import type {
  FunctionProfile,
  ItemTypeProfile,
  MethodProfile,
  RuleSetVersion,
  WeightTemplate,
} from "../lib/types";

function baseInput(): DeriveProjectionInput {
  const publishedMagnitudeRange = {
    min: 0,
    max: 10,
    ruleSetVersion: "test:affix-ranges:v1",
  };
  const weightTemplate: WeightTemplate = {
    id: "T-TEST",
    name: "测试模板",
    fishMinKg: 1,
    fishMaxKg: 3,
    nominalFishKg: 2,
    tier: "test",
    values: {
      force: 10,
      weight: 100,
      friction: 100,
    },
    notes: "",
  };
  const methodProfile: MethodProfile = {
    id: "method:lure",
    name: "路亚",
    rules: [
      {
        id: "method-force",
        parameterKey: "force",
        operation: "add",
        value: 1,
      },
    ],
    enabled: true,
    notes: "",
  };
  const itemTypeProfile: ItemTypeProfile = {
    id: "type:spinning",
    name: "纺车直柄",
    methodIds: ["method:lure"],
    itemPartIds: ["part:rod"],
    rules: [
      {
        id: "type-force",
        parameterKey: "force",
        operation: "multiply",
        value: 2,
      },
    ],
    enabled: true,
    notes: "",
  };
  const functionProfile: FunctionProfile = {
    id: "function:obstacle",
    name: "障碍强攻",
    rules: [],
    intensityRules: [
      {
        intensity: 2,
        rules: [
          {
            id: "function-force",
            parameterKey: "force",
            operation: "add",
            value: 3,
          },
        ],
      },
    ],
    enabled: true,
    notes: "",
  };
  const ruleSet: RuleSetVersion = {
    id: "ruleset-test-1",
    version: 1,
    status: "published",
    settings: {
      reductionStackingMode: "diminishing_division",
      patchOffsetLimits: {},
    },
    sourceRevisionIds: ["source-1"],
    createdAt: "2026-07-20T00:00:00.000Z",
    publishedAt: "2026-07-20T00:00:00.000Z",
    notes: "",
  };
  return {
    weightTemplate,
    methodProfile,
    itemTypeProfile,
    functionProfile,
    functionIntensity: 2,
    performanceProfile: {
      id: "performance:strong",
      name: "高强",
      rules: [
        {
          id: "performance-force",
          parameterKey: "force",
          operation: "multiply",
          value: 1.1,
        },
      ],
      enabled: true,
      notes: "",
    },
    qualityProfile: {
      id: "quality_b_blue",
      letter: "B",
      colorName: "蓝",
      rank: 2,
      rules: [],
      enabled: true,
      notes: "",
    },
    ruleSet,
    attributeContributions: [
      {
        id: "affix-percent-1",
        sourceId: "affix:bundle",
        sourceName: "组合词条",
        parameterKey: "force",
        operation: "percent_bonus",
        value: 0.1,
        publishedMagnitudeRange,
      },
      {
        id: "affix-percent-2",
        sourceId: "affix:bundle",
        sourceName: "组合词条",
        parameterKey: "force",
        operation: "percent_bonus",
        value: 0.2,
        publishedMagnitudeRange,
      },
      {
        id: "affix-flat",
        sourceId: "affix:flat",
        sourceName: "固定词条",
        parameterKey: "force",
        operation: "flat_bonus",
        value: 2,
        publishedMagnitudeRange,
      },
      {
        id: "affix-reduction-1",
        sourceId: "affix:reduction",
        sourceName: "降低词条",
        parameterKey: "friction",
        operation: "reduction",
        value: 0.2,
        publishedMagnitudeRange,
      },
      {
        id: "affix-reduction-2",
        sourceId: "affix:reduction",
        sourceName: "降低词条",
        parameterKey: "friction",
        operation: "reduction",
        value: 0.3,
        publishedMagnitudeRange,
      },
    ],
    patches: [
      {
        id: "patch-series",
        scope: "series",
        scopeId: "series-1",
        reason: "系列修正",
        author: "test",
        baseProjectionId: "projection-base",
        baseRuleSetVersion: "ruleset-test-1",
        status: "approved",
        order: 1,
        rules: [
          {
            id: "series-force",
            parameterKey: "force",
            operation: "add",
            value: 1,
          },
        ],
      },
      {
        id: "patch-sku",
        scope: "sku",
        scopeId: "sku-1",
        reason: "SKU 修正",
        author: "test",
        baseProjectionId: "projection-base",
        baseRuleSetVersion: "ruleset-test-1",
        status: "approved",
        order: 1,
        rules: [
          {
            id: "sku-force",
            parameterKey: "force",
            operation: "multiply",
            value: 2,
          },
        ],
      },
      {
        id: "patch-model-draft",
        scope: "model",
        scopeId: "model-1",
        reason: "未批准修正",
        author: "test",
        baseProjectionId: "projection-base",
        baseRuleSetVersion: "ruleset-test-1",
        status: "draft",
        order: 1,
        rules: [
          {
            id: "draft-force",
            parameterKey: "force",
            operation: "set",
            value: 999,
          },
        ],
      },
    ],
  };
}

test("schema v1 顺序迁移到 v2，保留旧字段且重复迁移幂等", () => {
  const seed = createSeedState();
  assert.equal(seed.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.equal(seed.ruleSetVersions[0].settings.reductionStackingMode, "diminishing_division");

  const migrated = migrateWorkspaceState(workspaceV1);
  assert.equal(migrated.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.equal(migrated.templates[0].id, "T-FIXTURE");
  assert.deepEqual(migrated.candidates[0].overrides, {
    "杆最大拉力kgf": 12,
  });
  assert.equal(
    (migrated as unknown as { legacyOnly: { keep: boolean } }).legacyOnly.keep,
    true,
  );
  assert.equal(migrated.ruleSettings.reductionStackingMode, "diminishing_division");
  assert.deepEqual(migrated.ruleSettings.patchOffsetLimits, {});
  assert.ok(migrated.methodProfiles.some((profile) => profile.id === "method:lure"));
  assert.ok(migrated.itemTypeProfiles.some((profile) => profile.name === "直柄结构"));
  assert.ok(
    migrated.functionProfiles.some(
      (profile) =>
        profile.name === "障碍强攻" &&
        profile.intensityRules.some((entry) => entry.intensity === 2),
    ),
  );
  assert.ok(
    migrated.itemParts.some(
      (part) => part.id === "part:hook" && !part.activeInGeneration,
    ),
  );
  assert.ok(
    migrated.qualityProfiles.some(
      (quality) => quality.letter === "S" && quality.colorName === "橙",
    ),
  );
  assert.equal(migrated.qualityBands[0].name, "金");
  assert.equal(migrated.projectionPatches.length, 1);
  assert.equal(migrated.projectionPatches[0].rules[0].operation, "set");
  assert.ok(
    migrated.migrationReviewItems.some(
      (item) => item.sourceType === "candidate_override",
    ),
  );

  const migratedAgain = migrateWorkspaceState(migrated);
  assert.deepEqual(migratedAgain, migrated);
});

test("v3 内核按固定层序计算，百分比先加算、Patch 分层且可确定重放", () => {
  const input = baseInput();
  const original = structuredClone(input);
  const first = deriveProjection(input);
  const second = deriveProjection(input);

  assert.equal(first.structuralValues?.force, 22);
  assert.equal(first.values.force, 76.10000000000001);
  assert.equal(first.values.friction, applyReduction(100, 0.5));
  assert.deepEqual(
    first.trace.map((step) => step.layer),
    [
      "base_weight_template",
      "method",
      "item_type",
      "function",
      "performance",
      "quality",
      "series_patch",
      "sku_patch",
      "model_patch",
      "attribute_affix",
      "final_review_patch",
      "parameter_definition",
      "validation",
    ],
  );
  assert.deepEqual(first, second);
  assert.deepEqual(input, original);
  assert.equal(first.ruleSetVersion, "ruleset-test-1");
  assert.equal(first.reductionStackingMode, "diminishing_division");
  assert.equal(first.id, "projection-" + first.sourceHash);
  assert.equal(
    first.trace.find((step) => step.layer === "method")?.sourceIds[0],
    "method:lure",
  );
  assert.equal(
    first.trace.find((step) => step.layer === "item_type")?.sourceIds[0],
    "type:spinning",
  );
  assert.ok(!Object.values(first.values).includes(999));
});

test("降低公式全局唯一，旧模式字段不再改变结果", () => {
  assert.equal(applyReduction(100, 0), 100);
  assert.equal(applyReduction(100, 0.2), 83.33333333333334);
  assert.equal(applyReduction(100, 0.5), 66.66666666666667);
  assert.equal(applyReduction(100, 1.2), 45.45454545454545);
  assert.throws(
    () => applyReduction(Number.NaN, 0.2),
    /有限数字/,
  );
  assert.throws(
    () => applyReduction(100, -1),
    /非负/,
  );

  const diminishing = deriveProjection(baseInput());
  const linearInput = baseInput();
  linearInput.ruleSet.settings.reductionStackingMode = "linear_subtraction";
  const linear = deriveProjection(linearInput);
  assert.equal(diminishing.values.friction, applyReduction(100, 0.5));
  assert.equal(linear.values.friction, diminishing.values.friction);
  assert.equal(diminishing.sourceHash, linear.sourceHash);
});

test("规则边界与同层 set 冲突会进入可追踪校验结果", () => {
  const input = baseInput();
  input.weightTemplate.fishMinKg = 4;
  input.weightTemplate.fishMaxKg = 3;
  input.patches = [
    {
      id: "patch-a",
      scope: "model",
      scopeId: "model-1",
      reason: "first set",
      author: "test",
      baseProjectionId: "base",
      baseRuleSetVersion: input.ruleSet.id,
      status: "approved",
      order: 1,
      rules: [
        {
          id: "set-a",
          parameterKey: "weight",
          operation: "set",
          value: 90,
        },
        {
          id: "bound-min",
          parameterKey: "force",
          operation: "min",
          value: 30,
        },
      ],
    },
    {
      id: "patch-b",
      scope: "model",
      scopeId: "model-1",
      reason: "second set",
      author: "test",
      baseProjectionId: "base",
      baseRuleSetVersion: input.ruleSet.id,
      status: "approved",
      order: 2,
      rules: [
        {
          id: "set-b",
          parameterKey: "weight",
          operation: "set",
          value: 80,
        },
        {
          id: "bound-max",
          parameterKey: "force",
          operation: "max",
          value: 25,
        },
      ],
    },
  ];

  const projection = deriveProjection(input);
  assert.equal(projection.values.weight, 80);
  assert.equal(projection.values.force, 37.75000000000001);
  assert.ok(
    projection.warnings.some((warning) => warning.code === "SET_RULE_CONFLICT"),
  );
  assert.ok(
    projection.warnings.some(
      (warning) => warning.code === "WEIGHT_TEMPLATE_RANGE_INVALID",
    ),
  );
});

test("FinalReviewPatch 在 Affix 结算之后应用，可覆盖词条结果（规范 §8/§21.1）", () => {
  const input = baseInput();
  input.patches = [
    {
      id: "patch-final",
      scope: "final_review",
      scopeId: "model-1",
      reason: "最终复核",
      author: "test",
      baseProjectionId: "base",
      baseRuleSetVersion: input.ruleSet.id,
      status: "approved",
      order: 1,
      rules: [
        {
          id: "final-force",
          parameterKey: "force",
          operation: "set",
          value: 42,
        },
      ],
    },
  ];
  const projection = deriveProjection(input);

  // 词条结算后 force 为 27.5 × 1.3 + 2 = 37.75；FinalReviewPatch 的 set 在其后覆盖为 42。
  assert.equal(projection.values.force, 42);

  const layers = projection.trace.map((step) => step.layer);
  assert.ok(layers.indexOf("series_patch") < layers.indexOf("attribute_affix"));
  assert.ok(layers.indexOf("model_patch") < layers.indexOf("attribute_affix"));
  assert.ok(layers.indexOf("attribute_affix") < layers.indexOf("final_review_patch"));
  assert.ok(layers.indexOf("final_review_patch") < layers.indexOf("validation"));
});

test("contribution 规范化隔离问题进入 Projection warning，并强制 NON_FORMAL", () => {
  const input = baseInput();
  input.attributeContributions![0].value = -0.1;
  const projection = deriveProjection(input);
  const conflict = projection.warnings.find(
    (warning) => warning.code === "AFFIX_DIRECTION_CONFLICT",
  );
  assert.equal(conflict?.severity, "ERROR");
  assert.equal(conflict?.gate, "REVIEW");
  assert.equal(projection.formalStatus, "NON_FORMAL");
  assert.equal(
    projection.trace.find((step) => step.layer === "attribute_affix")
      ?.contributions.some((entry) => entry.sourceId === "affix:bundle"),
    false,
  );
});
