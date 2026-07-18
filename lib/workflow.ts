import { evaluateFormula } from "./engine";
import type {
  AdjustmentRule,
  Candidate,
  DimensionKey,
  GraphBatchRow,
  IntermediateSnapshot,
  ModifierOption,
  RuleGraph,
  RuleGraphCondition,
  RuleGraphNode,
  RuleGraphRun,
  RuleGraphNodeRunState,
  WorkspaceState,
} from "./types";

const now = () => new Date().toISOString();
const uid = (prefix: string) => prefix + "-" + crypto.randomUUID();

export const defaultRuleGraphs: RuleGraph[] = [
  {
    id: "graph-standard-generation",
    name: "首版装备生成 DAG",
    description:
      "中性模板经过一阶系数、边界限制和条件特化，进入人工审阅中间表，确认后再验算并输出。",
    mode: "hybrid",
    entryNodeId: "node-baseline",
    version: 1,
    enabled: true,
    nodes: [
      {
        id: "node-baseline",
        name: "装载中性模板",
        kind: "baseline",
        description: "按 SKU 的模板ID装载钓法 × 大重量段的杆轮线基准。",
        x: 30,
        y: 145,
        manualStart: false,
        dimensions: [],
        rules: [],
        conditions: [],
        conditionMode: "all",
      },
      {
        id: "node-coefficient",
        name: "一阶系数叠加",
        kind: "modifier",
        description: "应用结构、材质、功能、性能维度中的乘法和加法系数。",
        x: 270,
        y: 145,
        manualStart: false,
        dimensions: ["structure", "material", "function", "performance", "technology", "series"],
        rules: [],
        conditions: [],
        conditionMode: "all",
      },
      {
        id: "node-affix",
        name: "词条效果与品质",
        kind: "affix",
        description: "应用 SKU/系列指定的属性词条和被动词条；品质分沿用词条评分结果。",
        x: 510,
        y: 145,
        manualStart: false,
        dimensions: [],
        rules: [],
        conditions: [],
        conditionMode: "all",
      },
      {
        id: "node-bounds",
        name: "上下限约束",
        kind: "constraint",
        description: "把抛投指数和保护指数限制在设计边界内，并记录被截断的字段。",
        x: 750,
        y: 145,
        manualStart: false,
        dimensions: [],
        rules: [
          { id: "bound-rod-low", parameterKey: "杆抛投基础", operation: "max", value: -0.25 },
          { id: "bound-rod-high", parameterKey: "杆抛投基础", operation: "min", value: 0.35 },
          { id: "bound-reel-low", parameterKey: "轮抛投基础", operation: "max", value: -0.25 },
          { id: "bound-reel-high", parameterKey: "轮抛投基础", operation: "min", value: 0.35 },
          { id: "bound-line-low", parameterKey: "线抛投基础", operation: "max", value: -0.25 },
          { id: "bound-line-high", parameterKey: "线抛投基础", operation: "min", value: 0.35 },
          { id: "bound-heat-low", parameterKey: "过热保护指数", operation: "max", value: 40 },
        ],
        conditions: [],
        conditionMode: "all",
      },
      {
        id: "node-special-condition",
        name: "特殊组合判定",
        kind: "condition",
        description: "障碍强攻或巨物平台走特化支路，其余数据直接进入汇合。",
        x: 990,
        y: 145,
        manualStart: false,
        dimensions: [],
        rules: [],
        conditions: [
          { id: "cond-obstacle", field: "功能定位", operator: "contains", value: "障碍" },
          { id: "cond-giant", field: "平台定位", operator: "contains", value: "巨物" },
          { id: "cond-series", field: "系列", operator: "contains", value: "巨" },
        ],
        conditionMode: "any",
      },
      {
        id: "node-special-adjust",
        name: "强攻组合上/下调",
        kind: "rule",
        description: "强度和耐力向上调整，同时增加重量并轻微降低抛投，形成真实取舍。",
        x: 1230,
        y: 35,
        manualStart: true,
        dimensions: [],
        rules: [
          { id: "special-rod-force", parameterKey: "杆最大拉力kgf", operation: "multiply", value: 1.05 },
          { id: "special-reel-force", parameterKey: "轮最大拉力kgf", operation: "multiply", value: 1.05 },
          { id: "special-rod-dur", parameterKey: "杆最大耐力", operation: "multiply", value: 1.08 },
          { id: "special-rod-weight", parameterKey: "杆自重g", operation: "multiply", value: 1.03 },
          { id: "special-rod-cast", parameterKey: "杆抛投基础", operation: "add", value: -0.01 },
        ],
        conditions: [],
        conditionMode: "all",
      },
      {
        id: "node-merge",
        name: "支路汇合",
        kind: "merge",
        description: "等待特化与普通支路都结束，再合并为一张完整批次表。",
        x: 1470,
        y: 145,
        manualStart: false,
        dimensions: [],
        rules: [],
        conditions: [],
        conditionMode: "all",
      },
      {
        id: "node-review",
        name: "人工审阅中间表",
        kind: "review",
        description: "暂停执行并冻结可编辑快照；人工确认后才允许下游继续。",
        x: 1710,
        y: 145,
        manualStart: false,
        dimensions: [],
        rules: [],
        conditions: [],
        conditionMode: "all",
      },
      {
        id: "node-validate",
        name: "强度与覆盖验算",
        kind: "validate",
        description: "检查杆轮线拉力比例、安全工作拉力和模板覆盖。",
        x: 1950,
        y: 145,
        manualStart: false,
        dimensions: [],
        rules: [],
        conditions: [],
        conditionMode: "all",
      },
      {
        id: "node-output",
        name: "下发候选池",
        kind: "output",
        description: "手动启动最终下发；只把规则和人工审阅真正改动的字段写回候选。",
        x: 2190,
        y: 145,
        manualStart: true,
        dimensions: [],
        rules: [],
        conditions: [],
        conditionMode: "all",
      },
    ],
    edges: [
      { id: "edge-1", from: "node-baseline", to: "node-coefficient", outcome: "always", label: "基准表" },
      { id: "edge-2", from: "node-coefficient", to: "node-affix", outcome: "always", label: "系数结果" },
      { id: "edge-2b", from: "node-affix", to: "node-bounds", outcome: "always", label: "词条结果" },
      { id: "edge-3", from: "node-bounds", to: "node-special-condition", outcome: "always", label: "边界内" },
      { id: "edge-4", from: "node-special-condition", to: "node-special-adjust", outcome: "matched", label: "特殊组合" },
      { id: "edge-5", from: "node-special-condition", to: "node-merge", outcome: "unmatched", label: "普通组合" },
      { id: "edge-6", from: "node-special-adjust", to: "node-merge", outcome: "always", label: "特化完成" },
      { id: "edge-7", from: "node-merge", to: "node-review", outcome: "always", label: "中间表" },
      { id: "edge-8", from: "node-review", to: "node-validate", outcome: "approved", label: "人工通过" },
      { id: "edge-9", from: "node-validate", to: "node-output", outcome: "always", label: "验算结果" },
    ],
  },
];

export function ensureWorkflowFields(state: WorkspaceState): WorkspaceState {
  const seriesShowcases = (Array.isArray(state.seriesShowcases) ? state.seriesShowcases : []).map((entry) => {
    const coveredTemplates = state.templates.filter(
      (template) =>
        entry.fishMaxKg > template.fishMinKg && entry.fishMinKg < template.fishMaxKg,
    );
    const templateIds = Array.isArray(entry.templateIds) && entry.templateIds.length
      ? entry.templateIds
      : coveredTemplates.map((template) => template.id);
    const structureIds = Array.isArray(entry.structureIds) && entry.structureIds.length
      ? entry.structureIds
      : entry.structureId
        ? [entry.structureId]
        : [];
    const tensionValues = coveredTemplates.flatMap((template) =>
      ["杆最大拉力kgf", "轮最大拉力kgf", "线最大拉力kgf"]
        .map((key) => Number(template.values[key]))
        .filter((value) => Number.isFinite(value) && value > 0),
    );
    const fallbackTensionMin = tensionValues.length ? Math.min(...tensionValues) : 1;
    const fallbackTensionMax = tensionValues.length ? Math.max(...tensionValues) : Math.max(2, fallbackTensionMin);
    const tensionMinKgf = Number.isFinite(entry.tensionMinKgf) ? entry.tensionMinKgf : fallbackTensionMin;
    const tensionMaxKgf =
      Number.isFinite(entry.tensionMaxKgf) && entry.tensionMaxKgf > tensionMinKgf
        ? entry.tensionMaxKgf
        : Math.max(fallbackTensionMax, tensionMinKgf + 1);

    return {
      ...entry,
      templateIds,
      structureIds,
      fishingMethod: entry.fishingMethod?.trim() || "路亚",
      tensionMinKgf,
      tensionMaxKgf,
      affixIds: Array.isArray(entry.affixIds) ? entry.affixIds : [],
    };
  });

  return {
    ...state,
    seriesShowcases,
    ruleGraphs:
      Array.isArray(state.ruleGraphs) && state.ruleGraphs.length
        ? state.ruleGraphs
        : structuredClone(defaultRuleGraphs),
    ruleRuns: Array.isArray(state.ruleRuns) ? state.ruleRuns : [],
  };
}

function candidateForRow(state: WorkspaceState, row: GraphBatchRow): Candidate | undefined {
  return state.candidates.find((candidate) => candidate.id === row.candidateId);
}

function selectedOptionIds(candidate: Candidate, dimension: DimensionKey): string[] {
  if (dimension === "structure") return candidate.selections.structureId ? [candidate.selections.structureId] : [];
  if (dimension === "material") return candidate.selections.materialId ? [candidate.selections.materialId] : [];
  if (dimension === "function") return candidate.selections.functionId ? [candidate.selections.functionId] : [];
  if (dimension === "performance") return candidate.selections.performanceId ? [candidate.selections.performanceId] : [];
  if (dimension === "technology") return candidate.selections.technologyIds;
  return candidate.selections.seriesId ? [candidate.selections.seriesId] : [];
}

function applyRule(row: GraphBatchRow, rule: AdjustmentRule, markTouched: boolean) {
  const before = row.values[rule.parameterKey];
  const current = typeof before === "number" ? before : 0;
  let after: number | string = before ?? 0;
  if (rule.operation === "set") after = rule.value;
  else if (rule.operation === "add") after = current + Number(rule.value);
  else if (rule.operation === "multiply") after = current * Number(rule.value);
  else if (rule.operation === "min") after = Math.min(current, Number(rule.value));
  else if (rule.operation === "max") after = Math.max(current, Number(rule.value));
  else {
    const variables: Record<string, number> = { current };
    Object.entries(row.values).forEach(([key, value]) => {
      if (typeof value === "number") variables[key] = value;
    });
    after = evaluateFormula(String(rule.value), variables);
  }
  if (typeof after === "number") after = Math.round((after + Number.EPSILON) * 10000) / 10000;
  row.values[rule.parameterKey] = after;
  if (markTouched && before !== after && !row.touchedKeys.includes(rule.parameterKey)) {
    row.touchedKeys.push(rule.parameterKey);
  }
  return before !== after;
}

function optionMap(state: WorkspaceState) {
  return new Map<string, ModifierOption>(state.modifiers.map((option) => [option.id, option]));
}

function fieldValue(state: WorkspaceState, row: GraphBatchRow, field: string): number | string {
  const candidate = candidateForRow(state, row);
  if (!candidate) return row.values[field] ?? "";
  const metadata: Record<string, number | string> = {
    "组合ID": candidate.comboId,
    "平台ID": candidate.platformId,
    "平台定位": candidate.platformPosition,
    "系列": candidate.seriesName,
    "模板ID": candidate.templateId,
    "鱼重下限kg": candidate.fishMinKg,
    "鱼重上限kg": candidate.fishMaxKg,
    "结构类型": state.modifiers.find((item) => item.id === candidate.selections.structureId)?.name ?? "",
    "功能定位": state.modifiers.find((item) => item.id === candidate.selections.functionId)?.name ?? "",
    "性能定位": state.modifiers.find((item) => item.id === candidate.selections.performanceId)?.name ?? "",
    "品质": candidate.calculated.quality.qualityId,
  };
  return metadata[field] ?? row.values[field] ?? "";
}

export function matchesConditions(
  state: WorkspaceState,
  row: GraphBatchRow,
  conditions: RuleGraphCondition[],
  mode: "all" | "any",
): boolean {
  if (!conditions.length) return true;
  const test = (condition: RuleGraphCondition) => {
    const actual = fieldValue(state, row, condition.field);
    const expected = condition.value;
    if (condition.operator === "contains") return String(actual).includes(String(expected));
    if (condition.operator === "eq") return String(actual) === String(expected);
    if (condition.operator === "neq") return String(actual) !== String(expected);
    const left = Number(actual);
    const right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (condition.operator === "gt") return left > right;
    if (condition.operator === "gte") return left >= right;
    if (condition.operator === "lt") return left < right;
    return left <= right;
  };
  return mode === "all" ? conditions.every(test) : conditions.some(test);
}

function terminal(status: RuleGraphNodeRunState["status"]) {
  return status === "completed" || status === "skipped" || status === "failed";
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function propagate(
  graph: RuleGraph,
  run: RuleGraphRun,
  node: RuleGraphNode,
  output: { all: string[]; matched: string[]; unmatched: string[]; approved?: string[] },
) {
  for (const edge of graph.edges.filter((item) => item.from === node.id)) {
    const ids =
      edge.outcome === "matched"
        ? output.matched
        : edge.outcome === "unmatched"
          ? output.unmatched
          : edge.outcome === "approved"
            ? output.approved ?? output.all
            : output.all;
    const target = run.nodeStates.find((item) => item.nodeId === edge.to);
    if (target) target.inputRowIds = unique([...target.inputRowIds, ...ids]);
  }
}

function refreshReadiness(graph: RuleGraph, run: RuleGraphRun) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const nodeState of run.nodeStates.filter((item) => item.status === "pending")) {
      const incoming = graph.edges.filter((edge) => edge.to === nodeState.nodeId);
      if (!incoming.length && nodeState.nodeId !== graph.entryNodeId) continue;
      const predecessorsDone =
        nodeState.nodeId === graph.entryNodeId ||
        incoming.every((edge) => {
          const predecessor = run.nodeStates.find((item) => item.nodeId === edge.from);
          return predecessor ? terminal(predecessor.status) : true;
        });
      if (!predecessorsDone) continue;
      if (nodeState.inputRowIds.length) nodeState.status = "ready";
      else nodeState.status = "skipped";
      changed = true;
    }
  }

  if (run.nodeStates.some((item) => item.status === "waiting_review")) run.status = "waiting_review";
  else if (run.nodeStates.every((item) => terminal(item.status))) run.status = "completed";
  else if (run.nodeStates.some((item) => item.status === "running")) run.status = "running";
  else if (run.nodeStates.some((item) => item.status === "ready")) run.status = "paused";
  else run.status = "ready";
  run.updatedAt = now();
}

function validateRow(state: WorkspaceState, row: GraphBatchRow) {
  const candidate = candidateForRow(state, row);
  const template = state.templates.find((item) => item.id === row.templateId);
  const rod = Number(row.values["杆最大拉力kgf"] ?? 0);
  const reel = Number(row.values["轮最大拉力kgf"] ?? 0);
  const line = Number(row.values["线最大拉力kgf"] ?? 0);
  const issues: string[] = [];
  if (rod <= 0 || reel <= 0 || line <= 0) issues.push("杆、轮、线拉力必须大于0");
  const reelRod = rod > 0 ? reel / rod : 0;
  if (reelRod < 0.55 || reelRod > 1.2) issues.push("轮/杆拉力比超出0.55–1.20");
  const lineReel = reel > 0 ? line / reel : 0;
  if (lineReel < 1.4 || lineReel > 4) issues.push("线/轮拉力比超出1.40–4.00");
  if (
    candidate &&
    template &&
    (candidate.fishMinKg > template.nominalFishKg || candidate.fishMaxKg < template.nominalFishKg)
  ) issues.push("目标重量段未覆盖模板标称鱼重");
  if (!issues.length) {
    const safe = Math.min(rod * 0.9, reel, line * 0.35);
    issues.push("通过；安全工作拉力 " + Math.round(safe * 1000) / 1000 + "kgf");
  }
  row.issues = issues;
}

export function createRuleGraphRun(
  state: WorkspaceState,
  graph: RuleGraph,
  candidateIds: string[],
  actor: string,
): RuleGraphRun {
  const selected = state.candidates.filter(
    (candidate) =>
      candidate.status !== "rejected" &&
      (!candidateIds.length || candidateIds.includes(candidate.id)),
  );
  const rows: GraphBatchRow[] = selected.map((candidate) => ({
    id: uid("graph-row"),
    candidateId: candidate.id,
    comboId: candidate.comboId,
    templateId: candidate.templateId,
    values: {},
    qualityId: candidate.calculated.quality.qualityId,
    qualityScore: candidate.calculated.quality.finalScore,
    issues: [],
    touchedKeys: [],
  }));
  const nodeStates: RuleGraphNodeRunState[] = graph.nodes.map((node) => ({
    nodeId: node.id,
    status: node.id === graph.entryNodeId ? "ready" : "pending",
    inputRowIds: node.id === graph.entryNodeId ? rows.map((row) => row.id) : [],
    outputRowIds: [],
    matchedRowIds: [],
    unmatchedRowIds: [],
  }));
  const timestamp = now();
  const run: RuleGraphRun = {
    id: uid("graph-run"),
    graphId: graph.id,
    name: graph.name + " · " + new Date().toLocaleString("zh-CN"),
    status: "ready",
    nodeStates,
    workingRows: rows,
    snapshots: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    startedBy: actor,
  };
  advanceAutomaticNodes(state, graph, run);
  return run;
}

export function markRuleNodeRunning(run: RuleGraphRun, nodeId: string) {
  const state = run.nodeStates.find((item) => item.nodeId === nodeId);
  if (!state || state.status !== "ready") return;
  state.status = "running";
  state.startedAt = now();
  run.status = "running";
  run.updatedAt = now();
}

export function executeRuleGraphNode(
  state: WorkspaceState,
  graph: RuleGraph,
  run: RuleGraphRun,
  nodeId: string,
) {
  const node = graph.nodes.find((item) => item.id === nodeId);
  const nodeState = run.nodeStates.find((item) => item.nodeId === nodeId);
  if (!node || !nodeState || (nodeState.status !== "ready" && nodeState.status !== "running")) return;
  nodeState.status = "running";
  nodeState.startedAt = nodeState.startedAt ?? now();
  run.status = "running";
  const rowMap = new Map(run.workingRows.map((row) => [row.id, row]));
  const inputRows = nodeState.inputRowIds.map((id) => rowMap.get(id)).filter((row): row is GraphBatchRow => Boolean(row));

  try {
    if (node.kind === "review") {
      const snapshot: IntermediateSnapshot = {
        id: uid("snapshot"),
        nodeId: node.id,
        nodeName: node.name,
        status: "waiting",
        rows: structuredClone(inputRows),
        createdAt: now(),
        notes: "",
      };
      run.snapshots = run.snapshots.filter((item) => item.nodeId !== node.id || item.status !== "waiting");
      run.snapshots.push(snapshot);
      nodeState.status = "waiting_review";
      run.status = "waiting_review";
      run.updatedAt = now();
      return;
    }

    if (node.kind === "baseline") {
      for (const row of inputRows) {
        const template = state.templates.find((item) => item.id === row.templateId);
        row.values = template ? structuredClone(template.values) : {};
        if (!template) row.issues.push("找不到模板 " + row.templateId);
      }
    } else if (node.kind === "modifier") {
      const options = optionMap(state);
      for (const row of inputRows) {
        const candidate = candidateForRow(state, row);
        if (!candidate) continue;
        for (const dimension of node.dimensions) {
          for (const optionId of selectedOptionIds(candidate, dimension)) {
            const option = options.get(optionId);
            option?.rules.forEach((rule) => applyRule(row, rule, false));
          }
        }
      }
    } else if (node.kind === "affix") {
      for (const row of inputRows) {
        const candidate = candidateForRow(state, row);
        if (!candidate) continue;
        for (const affixId of candidate.affixIds) {
          const affix = state.affixes.find((item) => item.id === affixId && item.enabled);
          affix?.rules.forEach((rule) => applyRule(row, rule, false));
        }
      }
    } else if (node.kind === "rule" || node.kind === "constraint") {
      for (const row of inputRows) {
        if (!matchesConditions(state, row, node.conditions, node.conditionMode)) continue;
        let changed = 0;
        node.rules.forEach((rule) => {
          if (applyRule(row, rule, true)) changed += 1;
        });
        if (node.kind === "constraint" && changed) {
          row.issues.push(node.name + "：已截断 " + changed + " 个越界值");
        }
      }
    } else if (node.kind === "validate") {
      inputRows.forEach((row) => validateRow(state, row));
    }

    const matched =
      node.kind === "condition"
        ? inputRows.filter((row) => matchesConditions(state, row, node.conditions, node.conditionMode))
        : inputRows;
    const unmatched =
      node.kind === "condition"
        ? inputRows.filter((row) => !matchesConditions(state, row, node.conditions, node.conditionMode))
        : [];

    nodeState.outputRowIds = inputRows.map((row) => row.id);
    nodeState.matchedRowIds = matched.map((row) => row.id);
    nodeState.unmatchedRowIds = unmatched.map((row) => row.id);
    nodeState.status = "completed";
    nodeState.finishedAt = now();
    propagate(graph, run, node, {
      all: nodeState.outputRowIds,
      matched: nodeState.matchedRowIds,
      unmatched: nodeState.unmatchedRowIds,
    });
    refreshReadiness(graph, run);
  } catch (error) {
    nodeState.status = "failed";
    nodeState.error = error instanceof Error ? error.message : "规则执行失败";
    nodeState.finishedAt = now();
    run.status = "failed";
    run.updatedAt = now();
  }
}

function shouldAutoRun(graph: RuleGraph, node: RuleGraphNode) {
  if (graph.mode === "automatic") return true;
  if (graph.mode === "manual") return false;
  return !node.manualStart;
}

export function advanceAutomaticNodes(
  state: WorkspaceState,
  graph: RuleGraph,
  run: RuleGraphRun,
) {
  let guard = graph.nodes.length * 3;
  while (guard > 0 && run.status !== "waiting_review" && run.status !== "failed") {
    guard -= 1;
    const ready = run.nodeStates.find((nodeState) => {
      const node = graph.nodes.find((item) => item.id === nodeState.nodeId);
      return nodeState.status === "ready" && node && shouldAutoRun(graph, node);
    });
    if (!ready) break;
    executeRuleGraphNode(state, graph, run, ready.nodeId);
  }
  refreshReadiness(graph, run);
}

export function approveReviewSnapshot(
  state: WorkspaceState,
  graph: RuleGraph,
  run: RuleGraphRun,
  nodeId: string,
  reviewer: string,
) {
  const node = graph.nodes.find((item) => item.id === nodeId);
  const nodeState = run.nodeStates.find((item) => item.nodeId === nodeId);
  const snapshot = [...run.snapshots].reverse().find((item) => item.nodeId === nodeId && item.status === "waiting");
  if (!node || !nodeState || !snapshot) return;
  const byId = new Map(run.workingRows.map((row) => [row.id, row]));
  snapshot.rows.forEach((row) => byId.set(row.id, structuredClone(row)));
  run.workingRows = Array.from(byId.values());
  snapshot.status = "approved";
  snapshot.reviewer = reviewer;
  snapshot.reviewedAt = now();
  nodeState.status = "completed";
  nodeState.outputRowIds = snapshot.rows.map((row) => row.id);
  nodeState.finishedAt = now();
  propagate(graph, run, node, {
    all: nodeState.outputRowIds,
    matched: nodeState.outputRowIds,
    unmatched: [],
    approved: nodeState.outputRowIds,
  });
  refreshReadiness(graph, run);
  advanceAutomaticNodes(state, graph, run);
}

export function commitRuleRunToCandidates(state: WorkspaceState, run: RuleGraphRun) {
  for (const row of run.workingRows) {
    const candidate = state.candidates.find((item) => item.id === row.candidateId);
    if (!candidate) continue;
    for (const key of row.touchedKeys) {
      const value = row.values[key];
      if (value !== undefined) candidate.overrides[key] = value;
    }
    candidate.notes = [candidate.notes, "规则图批次 " + run.name + " 已下发"].filter(Boolean).join("；");
    candidate.updatedAt = now();
  }
  run.committedAt = now();
  run.updatedAt = now();
}

export function canConnectRuleNodes(graph: RuleGraph, from: string, to: string) {
  if (!from || !to || from === to) return false;
  if (graph.edges.some((edge) => edge.from === from && edge.to === to)) return false;
  const adjacency = new Map<string, string[]>();
  graph.edges.forEach((edge) => adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]));
  const stack = [to];
  const visited = new Set<string>();
  while (stack.length) {
    const current = stack.pop();
    if (!current || visited.has(current)) continue;
    if (current === from) return false;
    visited.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return true;
}

export function validateRuleGraph(graph: RuleGraph): string[] {
  const issues: string[] = [];
  if (!graph.nodes.some((node) => node.id === graph.entryNodeId)) issues.push("入口节点不存在");
  graph.edges.forEach((edge) => {
    if (!graph.nodes.some((node) => node.id === edge.from)) issues.push("连线起点不存在：" + edge.id);
    if (!graph.nodes.some((node) => node.id === edge.to)) issues.push("连线终点不存在：" + edge.id);
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const edge of graph.edges.filter((item) => item.from === nodeId)) {
      if (visit(edge.to)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  if (graph.nodes.some((node) => visit(node.id))) issues.push("规则图存在循环，执行图必须是 DAG");
  return unique(issues);
}
