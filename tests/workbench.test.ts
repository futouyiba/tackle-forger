import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCandidate,
  evaluateFormula,
  generateCandidatesForRecipe,
  publishCandidate,
  scoreAffixes,
} from "../lib/engine";
import {
  applyDataSourcePreview,
  prepareDataSourcePreview,
  prepareDataSourceWriteback,
} from "../lib/data-sources";
import { createSeedState } from "../lib/seed";
import { parseFeishuSourceLink } from "../lib/feishu-links";
import { buildSeriesShowcaseLayout, buildSeriesSegments, showcaseFeatureLabel, showcaseQualitySlots } from "../lib/showcase";
import {
  advanceAutomaticNodes,
  approveReviewSnapshot,
  commitRuleRunToCandidates,
  createRuleGraphRun,
  ensureWorkflowFields,
  executeRuleGraphNode,
  validateRuleGraph,
} from "../lib/workflow";

test("Excel 数据种子完整映射主表", () => {
  const state = createSeedState();
  assert.equal(state.templates.length, 12);
  assert.equal(state.candidates.length, 32);
  assert.equal(state.recipes.length, 12);
  assert.ok(state.parameters.length >= 26);
  assert.ok(state.modifiers.some((item) => item.dimension === "function"));
  assert.ok(state.modifiers.some((item) => item.dimension === "performance"));
  assert.ok(state.affixes.some((item) => item.category === "passive"));
});

test("分层规则计算杆轮线、安全拉力和品质", () => {
  const state = createSeedState();
  const calculated = calculateCandidate(state, state.candidates[0]);
  assert.ok(Number(calculated.calculated.values["杆最大拉力kgf"]) > 0);
  assert.ok(Number(calculated.calculated.values["轮最大拉力kgf"]) > 0);
  assert.ok(Number(calculated.calculated.values["线最大拉力kgf"]) > 0);
  assert.ok(calculated.calculated.safeWorkingForce > 0);
  assert.ok(calculated.calculated.trace.length > 0);
  assert.ok(calculated.calculated.quality.finalScore >= 0);
});

test("词条采用有损相加、协同和冲突规则", () => {
  const state = createSeedState();
  const result = scoreAffixes(state, [
    "affix-distance",
    "affix-light",
    "affix-impact",
  ]);
  assert.equal(result.rawScore, 17);
  assert.ok(result.bonuses.length > 0);
  assert.ok(result.penalties.length > 0);
  assert.ok(result.finalScore > 0);
});

test("高级公式解析器不依赖 eval", () => {
  assert.equal(
    evaluateFormula("max(current*1.1, 杆最大拉力kgf+2)", {
      current: 10,
      杆最大拉力kgf: 8,
    }),
    11,
  );
});

test("受约束配方生成并发布规范 ID", () => {
  const state = createSeedState();
  const recipe = { ...state.recipes[0], maxCandidates: 3 };
  const generated = generateCandidatesForRecipe(state, recipe);
  assert.ok(generated.length > 0);
  assert.ok(generated.length <= 3);
  assert.equal(generated.every((candidate) => candidate.selections.performanceId === undefined), true);
  const sku = publishCandidate(state, generated[0]);
  assert.equal(sku.rodId, sku.comboId + "_R");
  assert.equal(sku.reelId, sku.comboId + "_W");
  assert.equal(sku.lineId, sku.comboId + "_L");

  const legacy = generateCandidatesForRecipe(
    state,
    recipe,
    { executionMode: "legacy_performance_replay" },
  ).find((candidate) => candidate.selections.performanceId);
  assert.ok(legacy);
  assert.throws(
    () => publishCandidate(state, legacy!),
    /只读历史证据/,
  );
});

test("规则图是无环 DAG，条件分支按行路由并在人工关卡暂停", () => {
  const state = createSeedState();
  const graph = structuredClone(state.ruleGraphs[0]);
  assert.deepEqual(validateRuleGraph(graph), []);

  const run = createRuleGraphRun(state, graph, [], "测试策划");
  const conditionState = run.nodeStates.find((item) => item.nodeId === "node-special-condition");
  assert.equal(conditionState?.status, "completed");
  assert.equal(
    (conditionState?.matchedRowIds.length ?? 0) + (conditionState?.unmatchedRowIds.length ?? 0),
    state.candidates.length,
  );
  assert.equal(run.status, "paused");
  assert.equal(
    run.nodeStates.find((item) => item.nodeId === "node-special-adjust")?.status,
    "ready",
  );

  executeRuleGraphNode(state, graph, run, "node-special-adjust");
  advanceAutomaticNodes(state, graph, run);
  assert.equal(run.status, "waiting_review");
  assert.equal(run.snapshots.length, 1);
  assert.equal(run.snapshots[0].rows.length, state.candidates.length);
});

test("审阅中间表可修改，批准后继续执行并只下发触碰字段", () => {
  const state = createSeedState();
  const graph = structuredClone(state.ruleGraphs[0]);
  const run = createRuleGraphRun(state, graph, [], "测试策划");
  executeRuleGraphNode(state, graph, run, "node-special-adjust");
  advanceAutomaticNodes(state, graph, run);

  const snapshot = run.snapshots[0];
  const row = snapshot.rows[0];
  const before = Number(row.values["杆自重g"]);
  row.values["杆自重g"] = before + 7;
  row.touchedKeys.push("杆自重g");

  approveReviewSnapshot(state, graph, run, "node-review", "审核员");
  assert.equal(run.status, "paused");
  assert.equal(run.nodeStates.find((item) => item.nodeId === "node-output")?.status, "ready");

  executeRuleGraphNode(state, graph, run, "node-output");
  advanceAutomaticNodes(state, graph, run);
  assert.equal(run.status, "completed");

  commitRuleRunToCandidates(state, run);
  const candidate = state.candidates.find((item) => item.id === row.candidateId);
  assert.equal(candidate?.overrides["杆自重g"], before + 7);
  assert.ok(run.committedAt);
});

test("规则图拒绝形成循环", () => {
  const state = createSeedState();
  const graph = structuredClone(state.ruleGraphs[0]);
  graph.edges.push({
    id: "cycle-edge",
    from: "node-output",
    to: "node-baseline",
    outcome: "always",
    label: "错误回路",
  });
  assert.ok(validateRuleGraph(graph).some((issue) => issue.includes("循环")));
});
test("系列按品质形成甘特轨道，并自动拆分重量与拉力跨度", () => {
  const state = createSeedState();
  const quality = showcaseQualitySlots(state.qualityBands)[0];
  const structures = state.modifiers.filter(
    (item) => item.dimension === "structure" && (item.name.includes("直柄") || item.name.includes("枪柄")),
  );
  const functionOption = state.modifiers.find(
    (item) => item.dimension === "function" && Number(item.level) === 3,
  );
  const affixes = state.affixes.slice(0, 2);
  assert.ok(structures.length >= 2 && functionOption && affixes.length === 2);

  const now = new Date().toISOString();
  state.seriesShowcases.push(
    {
      id: "showcase-wide",
      seriesId: "SER-WIDE",
      description: "贯穿轻型到超重的精细远投系列",
      templateIds: [],
      structureIds: structures.slice(0, 2).map((item) => item.id),
      fishingMethod: "岸抛路亚",
      functionId: functionOption.id,
      qualityId: quality.qualityId,
      fishMinKg: 0.8,
      fishMaxKg: 20,
      tensionMinKgf: 2,
      tensionMaxKgf: 10,
      targetPullsKgf: [2, 3.8, 10],
      affixIds: affixes.map((item) => item.id),
      notes: "",
      publishedAt: now,
      updatedAt: now,
    },
    {
      id: "showcase-heavy",
      seriesId: "SER-HEAVY",
      description: "重型强攻系列",
      templateIds: [],
      structureIds: [structures[0].id],
      fishingMethod: "船钓路亚",
      functionId: functionOption.id,
      qualityId: quality.qualityId,
      fishMinKg: 4,
      fishMaxKg: 8,
      tensionMinKgf: 8,
      tensionMaxKgf: 14,
      affixIds: [affixes[0].id],
      notes: "",
      publishedAt: now,
      updatedAt: now,
    },
  );

  const layout = buildSeriesShowcaseLayout(state);
  assert.deepEqual(layout.qualities.map((item) => item.key), ["C", "B", "A", "S"]);
  const lane = layout.lanes.find((item) => item.qualityKey === "C");
  assert.ok(lane);
  assert.deepEqual(lane.entries.map((item) => item.entry.seriesId), ["SER-WIDE", "SER-HEAVY"]);
  assert.deepEqual(lane.entries.map((item) => item.trackIndex), [0, 1]);

  const wide = lane.entries[0];
  assert.equal(wide.startRow, 2);
  assert.equal(wide.rowSpan, 6);
  assert.equal(wide.segments.length, 6);
  assert.deepEqual(wide.entry.structureIds, structures.slice(0, 2).map((item) => item.id));
  assert.deepEqual(wide.entry.affixIds, affixes.map((item) => item.id));
  assert.equal(wide.segments[0].weightMinKg, 0.8);
  assert.equal(wide.segments.at(-1)?.weightMaxKg, 20);
  assert.equal(wide.segments[0].tensionMinKgf, 2);
  assert.equal(wide.segments.at(-1)?.tensionMaxKgf, 10);
  assert.deepEqual(wide.segments.map((segment) => segment.targetPullsKgf), Array.from({ length: wide.segments.length }, () => [2, 3.8, 10]));

  const directSegments = buildSeriesSegments(wide.entry, layout.levels);
  assert.deepEqual(directSegments, wide.segments);
  assert.equal(showcaseFeatureLabel(functionOption), "【" + functionOption.name + "+++】");
});


test("旧版单模板系列会迁移为多段系列定义", () => {
  const state = createSeedState();
  const structure = state.modifiers.find((item) => item.name.includes("直柄"));
  const functionOption = state.modifiers.find((item) => item.dimension === "function");
  const quality = showcaseQualitySlots(state.qualityBands)[0];
  assert.ok(structure && functionOption);

  state.seriesShowcases = [{
    id: "legacy-series",
    seriesId: "LEGACY-01",
    description: "旧版系列",
    templateId: "T04",
    structureId: structure.id,
    functionId: functionOption.id,
    performanceId: "",
    qualityId: quality.qualityId,
    fishMinKg: 1,
    fishMaxKg: 7,
    lureMinG: 3,
    lureMaxG: 15,
    notes: "",
    publishedAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  } as (typeof state.seriesShowcases)[number]];

  const migrated = ensureWorkflowFields(state).seriesShowcases[0];
  assert.deepEqual(migrated.templateIds, ["T04", "T05", "T06"]);
  assert.deepEqual(migrated.structureIds, [structure.id]);
  assert.equal(migrated.fishingMethod, "路亚");
  assert.ok(migrated.tensionMaxKgf > migrated.tensionMinKgf);
  assert.deepEqual(migrated.affixIds, []);
});
test("飞书 A/B 数据源先生成暂存差异，再替换目标数据集", () => {
  const state = createSeedState();
  assert.equal(state.dataSources.length, 2);
  const source = {
    ...state.dataSources[0],
    appToken: "bascn-test",
    tableId: "tbl-test",
  };
  const preview = prepareDataSourcePreview(
    source,
    [
      {
        record_id: "rec-1",
        fields: {
          模板ID: "T01",
          名称: "轻量修订",
          鱼重下限kg: 0.5,
          鱼重上限kg: 2,
          标称鱼重kg: 1,
          档位: "轻量",
        },
      },
      {
        record_id: "rec-2",
        fields: {
          模板ID: "T99",
          名称: "测试重量段",
          鱼重下限kg: 20,
          鱼重上限kg: 30,
          标称鱼重kg: 25,
          档位: "测试",
        },
      },
    ],
    state,
    "2026-07-20T00:00:00.000Z",
  );

  assert.equal(preview.recordCount, 2);
  assert.equal(preview.summary.added, 1);
  assert.equal(preview.summary.changed, 1);
  assert.equal(preview.summary.removed, state.templates.length - 1);
  assert.equal(preview.issues.filter((issue) => issue.level === "error").length, 0);

  const published = applyDataSourcePreview(state, preview);
  assert.equal(state.templates.length, 12);
  assert.deepEqual(published.templates.map((item) => item.id), ["T01", "T99"]);
  assert.equal(published.importedAt, "2026-07-20T00:00:00.000Z");
});

test("数据源校验阻止重复 ID、无效重量段和空表覆盖", () => {
  const state = createSeedState();
  const source = { ...state.dataSources[0], appToken: "base", tableId: "table" };
  const invalid = prepareDataSourcePreview(source, [
    {
      record_id: "bad-1",
      fields: {
        模板ID: "DUP",
        鱼重下限kg: 10,
        鱼重上限kg: 5,
        标称鱼重kg: 7,
        档位: "错误",
      },
    },
    {
      record_id: "bad-2",
      fields: {
        模板ID: "DUP",
        鱼重下限kg: 1,
        鱼重上限kg: 2,
        标称鱼重kg: 3,
        档位: "错误",
      },
    },
  ], state);
  assert.ok(invalid.issues.filter((issue) => issue.level === "error").length >= 3);

  const empty = prepareDataSourcePreview(source, [], state);
  assert.ok(empty.issues.some((issue) => issue.message.includes("空表覆盖")));
});

test("已发布的飞书行会建立绑定，并只回写工具中改变的字段", () => {
  const state = createSeedState();
  const source = {
    ...state.dataSources[0],
    appToken: "base",
    tableId: "table",
  };
  const records = [
    {
      record_id: "rec-1",
      fields: {
        模板ID: "T01",
        名称: "轻量",
        鱼重下限kg: 0.5,
        鱼重上限kg: 2,
        标称鱼重kg: 1,
        档位: "轻量",
        备注: "",
      },
    },
  ];
  const imported = applyDataSourcePreview(
    state,
    prepareDataSourcePreview(source, records, state, "2026-07-20T00:00:00.000Z"),
  );
  assert.equal(imported.dataSourceBindings.length, 1);
  assert.equal(imported.dataSourceBindings[0].recordId, "rec-1");
  assert.equal(imported.dataSourceBindings[0].fieldMap.fishMaxKg, "鱼重上限kg");

  imported.templates[0].fishMaxKg = 2.5;
  imported.templates[0].notes = "本地修订";
  const writeback = prepareDataSourceWriteback(
    source,
    records,
    imported,
    "2026-07-20T01:00:00.000Z",
  );
  assert.equal(writeback.recordCount, 1);
  assert.equal(writeback.fieldCount, 2);
  assert.deepEqual(writeback.rows[0].fields, {
    鱼重上限kg: 2.5,
    备注: "本地修订",
  });
  assert.equal(writeback.issues.filter((issue) => issue.level === "error").length, 0);
});

test("本地和飞书同时修改同一来源行时阻止回写", () => {
  const state = createSeedState();
  const source = {
    ...state.dataSources[0],
    appToken: "base",
    tableId: "table",
  };
  const records = [
    {
      record_id: "rec-1",
      fields: {
        模板ID: "T01",
        名称: "轻量",
        鱼重下限kg: 0.5,
        鱼重上限kg: 2,
        标称鱼重kg: 1,
        档位: "轻量",
      },
    },
  ];
  const imported = applyDataSourcePreview(
    state,
    prepareDataSourcePreview(source, records, state),
  );
  imported.templates[0].fishMaxKg = 2.5;
  const remoteChanged = structuredClone(records);
  remoteChanged[0].fields.鱼重上限kg = 2.2;

  const writeback = prepareDataSourceWriteback(source, remoteChanged, imported);
  assert.equal(writeback.recordCount, 0);
  assert.ok(writeback.issues.some((issue) => issue.message.includes("飞书中也发生了变化")));
});
test("飞书分享链接自动识别工作簿、数据表和视图", () => {
  assert.deepEqual(
    parseFeishuSourceLink(
      "https://example.feishu.cn/base/appbcbWCzen6D8dezhoCH2RpMAh?table=tblKz5D60T4JlfcT&view=vewqhz51lk",
    ),
    {
      appToken: "appbcbWCzen6D8dezhoCH2RpMAh",
      tableId: "tblKz5D60T4JlfcT",
      viewId: "vewqhz51lk",
    },
  );
  assert.deepEqual(
    parseFeishuSourceLink("https://example.feishu.cn/base/appbcbWCzen6D8dezhoCH2RpMAh"),
    {
      appToken: "appbcbWCzen6D8dezhoCH2RpMAh",
      tableId: "",
      viewId: "",
    },
  );
  assert.throws(
    () => parseFeishuSourceLink("https://example.feishu.cn/sheets/shtcnExample"),
    /多维表格/,
  );
  assert.throws(
    () => parseFeishuSourceLink("https://example.com/base/appExample"),
    /不是飞书/,
  );
});
