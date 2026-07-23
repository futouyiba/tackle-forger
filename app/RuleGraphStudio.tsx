"use client";

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  CirclePlay,
  Clock3,
  Copy,
  GitBranch,
  Pause,
  Play,
  Plus,
  Save,
  Settings2,
  TableProperties,
  Trash2,
  Workflow,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  AdjustmentRule,
  DimensionKey,
  GraphBatchRow,
  ItemKind,
  RuleGraph,
  RuleGraphEdge,
  RuleGraphNode,
  RuleGraphNodeKind,
  RuleGraphRun,
  RuleNodeExecutionStatus,
  WorkspaceState,
} from "@/lib/types";
import {
  advanceAutomaticNodes,
  approveReviewSnapshot,
  canConnectRuleNodes,
  createRuleGraphRun,
  executeRuleGraphNode,
  markRuleNodeRunning,
  validateRuleGraph,
} from "@/lib/workflow";

const kindLabels: Record<RuleGraphNodeKind, string> = {
  baseline: "基准装载",
  modifier: "维度系数",
  affix: "词条效果",
  rule: "调整规则",
  constraint: "上下限",
  condition: "条件分支",
  merge: "支路汇合",
  review: "人工审阅",
  validate: "验算",
  output: "下游输出",
};

const dimensionLabels: Record<DimensionKey, string> = {
  structure: "结构类型",
  material: "类型材质",
  function: "功能定位",
  performance: "性能定位",
  technology: "技术",
  series: "特殊系列",
};

const statusLabels: Record<RuleNodeExecutionStatus, string> = {
  pending: "未开始",
  ready: "等待启动",
  running: "执行中",
  waiting_review: "等待审阅",
  completed: "已完成",
  failed: "失败",
  skipped: "无数据跳过",
};

const itemLabels: Record<ItemKind, string> = {
  rod: "鱼竿",
  reel: "渔轮",
  line: "鱼线",
};

const conditionFields = [
  "组合ID",
  "平台ID",
  "平台定位",
  "系列",
  "模板ID",
  "鱼重下限kg",
  "鱼重上限kg",
  "结构类型",
  "功能定位",
  "性能定位",
  "品质",
];

function uid(prefix: string) {
  return prefix + "-" + crypto.randomUUID();
}

function GraphButton({
  children,
  icon: Icon,
  tone = "default",
  disabled,
  onClick,
  title,
}: {
  children?: React.ReactNode;
  icon?: typeof Plus;
  tone?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={"graph-button graph-button-" + tone}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {Icon ? <Icon size={14} /> : null}
      {children}
    </button>
  );
}

function GraphInput({
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  value: string | number | undefined;
  onChange: (value: string) => void;
  type?: "text" | "number";
  placeholder?: string;
}) {
  return (
    <input
      className="graph-input"
      value={value ?? ""}
      type={type}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function GraphSelect({
  value,
  onChange,
  children,
}: {
  value: string | number | undefined;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select className="graph-select" value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
      {children}
    </select>
  );
}

function GraphCanvas({
  graph,
  run,
  selectedNodeId,
  onSelect,
}: {
  graph: RuleGraph;
  run?: RuleGraphRun;
  selectedNodeId: string;
  onSelect: (nodeId: string) => void;
}) {
  const width = Math.max(1040, ...graph.nodes.map((node) => node.x + 240));
  const height = Math.max(430, ...graph.nodes.map((node) => node.y + 160));
  const nodeState = (nodeId: string) => run?.nodeStates.find((item) => item.nodeId === nodeId);

  return (
    <div className="graph-canvas-scroll">
      <div className="graph-canvas" style={{ width, height }}>
        <div className="graph-grid-lines" />
        {graph.edges.map((edge) => {
          const from = graph.nodes.find((node) => node.id === edge.from);
          const to = graph.nodes.find((node) => node.id === edge.to);
          if (!from || !to) return null;
          const startX = from.x + 190;
          const startY = from.y + 54;
          const endX = to.x;
          const endY = to.y + 54;
          const deltaX = endX - startX;
          const deltaY = endY - startY;
          const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
          const angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);
          return (
            <div
              className={"graph-edge graph-edge-" + edge.outcome}
              key={edge.id}
              style={{
                left: startX,
                top: startY,
                width: length,
                transform: "rotate(" + angle + "deg)",
              }}
            >
              <span style={{ transform: "translateX(-50%) rotate(" + -angle + "deg)" }}>{edge.label || edge.outcome}</span>
            </div>
          );
        })}
        {graph.nodes.map((node) => {
          const execution = nodeState(node.id);
          const status = execution?.status ?? "pending";
          const outgoing = graph.edges.filter((edge) => edge.from === node.id);
          return (
            <button
              type="button"
              key={node.id}
              className={
                "graph-node graph-node-" +
                node.kind +
                " graph-status-" +
                status +
                (selectedNodeId === node.id ? " selected" : "")
              }
              style={{ left: node.x, top: node.y }}
              onClick={() => onSelect(node.id)}
            >
              <span className="graph-node-top">
                <em>{kindLabels[node.kind]}</em>
                {node.manualStart ? <b><CirclePlay size={11} />手动</b> : null}
              </span>
              <strong>{node.name}</strong>
              <small>{execution ? statusLabels[status] : node.description}</small>
              <span className="graph-node-foot">
                <i>{execution ? execution.inputRowIds.length + " 行" : node.rules.length + " 条规则"}</i>
                <i>{outgoing.length} 个下游</i>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function statusIcon(status: RuleNodeExecutionStatus) {
  if (status === "completed") return <CheckCircle2 size={15} />;
  if (status === "running") return <Play size={15} />;
  if (status === "waiting_review") return <TableProperties size={15} />;
  if (status === "ready") return <CirclePlay size={15} />;
  if (status === "failed") return <XCircle size={15} />;
  if (status === "skipped") return <CircleDashed size={15} />;
  return <Clock3 size={15} />;
}

export function RuleGraphStudio({
  state,
  mutate,
  notify,
  userName,
  selectedCandidateIds,
}: {
  state: WorkspaceState;
  mutate: (producer: (draft: WorkspaceState) => void, recalculate?: boolean) => void;
  notify: (message: string) => void;
  userName: string;
  selectedCandidateIds: string[];
}) {
  const [view, setView] = useState<"design" | "run">("design");
  const [graphId, setGraphId] = useState(state.ruleGraphs[0]?.id ?? "");
  const [selectedNodeId, setSelectedNodeId] = useState(state.ruleGraphs[0]?.entryNodeId ?? "");
  const [runId, setRunId] = useState(state.ruleRuns[0]?.id ?? "");
  const [targetNodeId, setTargetNodeId] = useState("");
  const [edgeOutcome, setEdgeOutcome] = useState<RuleGraphEdge["outcome"]>("always");
  const [edgeLabel, setEdgeLabel] = useState("");
  const [scope, setScope] = useState<"all" | "shortlisted" | "selected">("all");
  const [reviewKind, setReviewKind] = useState<ItemKind>("rod");

  const graph = state.ruleGraphs.find((item) => item.id === graphId) ?? state.ruleGraphs[0];
  const run = state.ruleRuns.find((item) => item.id === runId) ?? state.ruleRuns[0];
  const runGraph = state.ruleGraphs.find((item) => item.id === run?.graphId) ?? graph;
  const selectedNode = graph?.nodes.find((item) => item.id === selectedNodeId) ?? graph?.nodes[0];
  const graphIssues = graph ? validateRuleGraph(graph) : [];
  const activeSnapshot = run
    ? [...run.snapshots].reverse().find((snapshot) => snapshot.status === "waiting")
    : undefined;

  const readyNodes = useMemo(() => {
    if (!run || !runGraph) return [];
    return run.nodeStates
      .filter((item) => item.status === "ready")
      .map((item) => runGraph.nodes.find((node) => node.id === item.nodeId))
      .filter((node): node is RuleGraphNode => Boolean(node));
  }, [run, runGraph]);

  if (!graph) {
    return <div className="graph-empty">没有可用规则图。</div>;
  }

  const updateGraph = (producer: (draftGraph: RuleGraph) => void) => {
    mutate((draft) => {
      const target = draft.ruleGraphs.find((item) => item.id === graph.id);
      if (!target) return;
      producer(target);
      target.version += 1;
    }, false);
  };

  const updateNode = (producer: (draftNode: RuleGraphNode) => void) => {
    updateGraph((draftGraph) => {
      const node = draftGraph.nodes.find((item) => item.id === selectedNode?.id);
      if (node) producer(node);
    });
  };

  const addNode = () => {
    const id = uid("graph-node");
    const maxX = Math.max(0, ...graph.nodes.map((node) => node.x));
    updateGraph((draftGraph) => {
      draftGraph.nodes.push({
        id,
        name: "新调整规则",
        kind: "rule",
        description: "配置条件与参数调整后连接到下游。",
        x: maxX + 240,
        y: 145,
        manualStart: true,
        dimensions: [],
        rules: [],
        conditions: [],
        conditionMode: "all",
      });
    });
    setSelectedNodeId(id);
  };

  const duplicateGraph = () => {
    const copy = structuredClone(graph);
    copy.id = uid("graph");
    copy.name = graph.name + " 副本";
    copy.version = 1;
    mutate((draft) => draft.ruleGraphs.push(copy), false);
    setGraphId(copy.id);
    setSelectedNodeId(copy.entryNodeId);
    notify("已创建规则图副本。");
  };

  const addEdge = () => {
    if (!selectedNode || !canConnectRuleNodes(graph, selectedNode.id, targetNodeId)) {
      notify("这条连接会重复或形成循环，不能添加。");
      return;
    }
    updateGraph((draftGraph) => {
      draftGraph.edges.push({
        id: uid("graph-edge"),
        from: selectedNode.id,
        to: targetNodeId,
        outcome: edgeOutcome,
        label: edgeLabel.trim() || (edgeOutcome === "matched" ? "条件命中" : edgeOutcome === "unmatched" ? "条件未命中" : edgeOutcome === "approved" ? "人工通过" : "继续"),
      });
    });
    setTargetNodeId("");
    setEdgeLabel("");
  };

  const startRun = () => {
    let ids: string[] = [];
    if (scope === "shortlisted") ids = state.candidates.filter((candidate) => candidate.status === "shortlisted").map((candidate) => candidate.id);
    if (scope === "selected") ids = selectedCandidateIds;
    if (scope !== "all" && !ids.length) {
      notify(scope === "selected" ? "候选池中还没有勾选数据。" : "当前没有入围候选。");
      return;
    }
    const next = createRuleGraphRun(state, graph, ids, userName);
    mutate((draft) => {
      draft.ruleRuns.unshift(next);
      draft.ruleRuns = draft.ruleRuns.slice(0, 30);
    }, false);
    setRunId(next.id);
    setView("run");
    notify("规则批次已启动；自动节点会运行到手动节点或审阅关卡。");
  };

  const executeNode = (nodeId: string) => {
    if (!run || !runGraph) return;
    mutate((draft) => {
      const targetRun = draft.ruleRuns.find((item) => item.id === run.id);
      if (targetRun) markRuleNodeRunning(targetRun, nodeId);
    }, false);
    window.setTimeout(() => {
      mutate((draft) => {
        const targetRun = draft.ruleRuns.find((item) => item.id === run.id);
        const targetGraph = draft.ruleGraphs.find((item) => item.id === run.graphId);
        if (!targetRun || !targetGraph) return;
        executeRuleGraphNode(draft, targetGraph, targetRun, nodeId);
        advanceAutomaticNodes(draft, targetGraph, targetRun);
      }, false);
    }, 360);
  };

  const updateSnapshotValue = (row: GraphBatchRow, parameterKey: string, value: string) => {
    if (!run || !activeSnapshot) return;
    mutate((draft) => {
      const targetRun = draft.ruleRuns.find((item) => item.id === run.id);
      const snapshot = targetRun?.snapshots.find((item) => item.id === activeSnapshot.id);
      const targetRow = snapshot?.rows.find((item) => item.id === row.id);
      if (!targetRow) return;
      const before = targetRow.values[parameterKey];
      targetRow.values[parameterKey] = typeof before === "number" ? Number(value) : value;
      if (!targetRow.touchedKeys.includes(parameterKey)) targetRow.touchedKeys.push(parameterKey);
    }, false);
  };

  const approveSnapshot = () => {
    if (!run || !runGraph || !activeSnapshot) return;
    mutate((draft) => {
      const targetRun = draft.ruleRuns.find((item) => item.id === run.id);
      const targetGraph = draft.ruleGraphs.find((item) => item.id === run.graphId);
      if (targetRun && targetGraph) approveReviewSnapshot(draft, targetGraph, targetRun, activeSnapshot.nodeId, userName);
    }, false);
    notify("中间表已通过审阅，数据继续流向下游。");
  };

  const designView = (
    <div className="graph-studio-layout">
      <section className="graph-main-panel">
        <div className="graph-toolbar">
          <div className="graph-selector">
            <Workflow size={16} />
            <GraphSelect value={graph.id} onChange={(value) => {
              setGraphId(value);
              const target = state.ruleGraphs.find((item) => item.id === value);
              setSelectedNodeId(target?.entryNodeId ?? "");
            }}>
              {state.ruleGraphs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </GraphSelect>
          </div>
          <label>执行模式
            <GraphSelect value={graph.mode} onChange={(value) => updateGraph((draft) => { draft.mode = value as RuleGraph["mode"]; })}>
              <option value="automatic">全自动</option>
              <option value="manual">全部手动启动</option>
              <option value="hybrid">自动 + 手动关卡</option>
            </GraphSelect>
          </label>
          <div className="graph-toolbar-spacer" />
          <GraphButton icon={Copy} onClick={duplicateGraph}>复制图</GraphButton>
          <GraphButton icon={Plus} onClick={addNode}>新增节点</GraphButton>
          <GraphSelect value={scope} onChange={(value) => setScope(value as typeof scope)}>
            <option value="all">全部非淘汰候选</option>
            <option value="shortlisted">仅入围候选</option>
            <option value="selected">候选池已勾选项</option>
          </GraphSelect>
          <GraphButton icon={Play} tone="primary" disabled={Boolean(graphIssues.length)} onClick={startRun}>启动批次</GraphButton>
        </div>
        <div className="graph-context-bar">
          <div>
            <strong>{graph.name}</strong>
            <span>{graph.description}</span>
          </div>
          <span className="graph-version">v{graph.version}</span>
          {graphIssues.length ? <span className="graph-invalid"><AlertTriangle size={13} />{graphIssues.join("；")}</span> : <span className="graph-valid"><CheckCircle2 size={13} />DAG 校验通过</span>}
        </div>
        <GraphCanvas graph={graph} selectedNodeId={selectedNode?.id ?? ""} onSelect={setSelectedNodeId} />
        <div className="graph-legend">
          <span><i className="legend-auto" />自动节点</span>
          <span><i className="legend-manual" />手动启动</span>
          <span><i className="legend-condition" />条件分支</span>
          <span><i className="legend-review" />审阅关卡</span>
          <span>箭头表示数据表流向；图必须无环</span>
        </div>
      </section>

      {selectedNode ? (
        <aside className="graph-inspector">
          <div className="graph-inspector-head">
            <div><span>节点配置</span><h3>{selectedNode.name}</h3></div>
            <span className={"node-kind-chip node-kind-" + selectedNode.kind}>{kindLabels[selectedNode.kind]}</span>
          </div>
          <div className="graph-inspector-scroll">
            <label className="graph-field">节点名<GraphInput value={selectedNode.name} onChange={(value) => updateNode((node) => { node.name = value; })} /></label>
            <label className="graph-field">节点类型
              <GraphSelect value={selectedNode.kind} onChange={(value) => updateNode((node) => { node.kind = value as RuleGraphNodeKind; })}>
                {Object.entries(kindLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </GraphSelect>
            </label>
            <label className="graph-field">说明<textarea value={selectedNode.description} onChange={(event) => updateNode((node) => { node.description = event.target.value; })} /></label>
            <div className="graph-inline-fields">
              <label className="graph-field">X<GraphInput type="number" value={selectedNode.x} onChange={(value) => updateNode((node) => { node.x = Number(value); })} /></label>
              <label className="graph-field">Y<GraphInput type="number" value={selectedNode.y} onChange={(value) => updateNode((node) => { node.y = Number(value); })} /></label>
            </div>
            <label className="graph-check"><input type="checkbox" checked={selectedNode.manualStart} onChange={(event) => updateNode((node) => { node.manualStart = event.target.checked; })} /><span><strong>需要手动启动</strong><small>混合模式执行到这里会暂停，等待操作员点击。</small></span></label>

            {selectedNode.kind === "modifier" ? (
              <div className="graph-inspector-section">
                <div className="graph-section-title"><strong>应用维度</strong></div>
                <div className="graph-check-grid">
                  {(Object.keys(dimensionLabels) as DimensionKey[]).map((key) => (
                    <label key={key}><input type="checkbox" checked={selectedNode.dimensions.includes(key)} onChange={() => updateNode((node) => {
                      node.dimensions = node.dimensions.includes(key) ? node.dimensions.filter((item) => item !== key) : [...node.dimensions, key];
                    })} />{dimensionLabels[key]}</label>
                  ))}
                </div>
              </div>
            ) : null}

            {selectedNode.kind === "condition" || selectedNode.kind === "rule" ? (
              <div className="graph-inspector-section">
                <div className="graph-section-title">
                  <strong>适用条件</strong>
                  <div className="mini-toggle">
                    <button className={selectedNode.conditionMode === "all" ? "active" : ""} onClick={() => updateNode((node) => { node.conditionMode = "all"; })}>全部满足</button>
                    <button className={selectedNode.conditionMode === "any" ? "active" : ""} onClick={() => updateNode((node) => { node.conditionMode = "any"; })}>任一满足</button>
                  </div>
                </div>
                <div className="graph-condition-list">
                  {selectedNode.conditions.map((condition) => (
                    <div key={condition.id}>
                      <GraphSelect value={condition.field} onChange={(value) => updateNode((node) => { const target = node.conditions.find((item) => item.id === condition.id); if (target) target.field = value; })}>
                        {[...conditionFields, ...state.parameters.map((parameter) => parameter.key)].map((field) => <option key={field} value={field}>{field}</option>)}
                      </GraphSelect>
                      <GraphSelect value={condition.operator} onChange={(value) => updateNode((node) => { const target = node.conditions.find((item) => item.id === condition.id); if (target) target.operator = value as typeof condition.operator; })}>
                        <option value="eq">等于</option><option value="neq">不等于</option><option value="contains">包含</option><option value="gt">大于</option><option value="gte">大于等于</option><option value="lt">小于</option><option value="lte">小于等于</option>
                      </GraphSelect>
                      <GraphInput value={condition.value} onChange={(value) => updateNode((node) => { const target = node.conditions.find((item) => item.id === condition.id); if (target) target.value = Number.isNaN(Number(value)) || value === "" ? value : Number(value); })} />
                      <GraphButton icon={Trash2} tone="ghost" onClick={() => updateNode((node) => { node.conditions = node.conditions.filter((item) => item.id !== condition.id); })} />
                    </div>
                  ))}
                  <GraphButton icon={Plus} onClick={() => updateNode((node) => node.conditions.push({ id: uid("condition"), field: "平台定位", operator: "contains", value: "" }))}>添加条件</GraphButton>
                </div>
              </div>
            ) : null}

            {selectedNode.kind === "rule" || selectedNode.kind === "constraint" ? (
              <div className="graph-inspector-section">
                <div className="graph-section-title"><strong>参数规则</strong><span>{selectedNode.rules.length} 条</span></div>
                <div className="graph-rule-list">
                  {selectedNode.rules.map((rule) => (
                    <div key={rule.id}>
                      <GraphSelect value={rule.parameterKey} onChange={(value) => updateNode((node) => { const target = node.rules.find((item) => item.id === rule.id); if (target) target.parameterKey = value; })}>
                        {state.parameters.map((parameter) => <option key={parameter.key} value={parameter.key}>{parameter.label}</option>)}
                      </GraphSelect>
                      <GraphSelect value={rule.operation} onChange={(value) => updateNode((node) => { const target = node.rules.find((item) => item.id === rule.id); if (target) target.operation = value as AdjustmentRule["operation"]; })}>
                        <option value="multiply">乘系数</option><option value="add">加数值</option><option value="set">覆盖</option><option value="min">不高于</option><option value="max">不低于</option><option value="formula">公式</option>
                      </GraphSelect>
                      <GraphInput value={rule.value} onChange={(value) => updateNode((node) => { const target = node.rules.find((item) => item.id === rule.id); if (target) target.value = target.operation === "formula" || Number.isNaN(Number(value)) ? value : Number(value); })} />
                      <GraphButton icon={Trash2} tone="ghost" onClick={() => updateNode((node) => { node.rules = node.rules.filter((item) => item.id !== rule.id); })} />
                    </div>
                  ))}
                  <GraphButton icon={Plus} onClick={() => updateNode((node) => node.rules.push({ id: uid("node-rule"), parameterKey: state.parameters[0]?.key ?? "", operation: node.kind === "constraint" ? "min" : "multiply", value: 1 }))}>添加规则</GraphButton>
                </div>
              </div>
            ) : null}

            <div className="graph-inspector-section">
              <div className="graph-section-title"><strong>连接到下游</strong><span>{graph.edges.filter((edge) => edge.from === selectedNode.id).length} 条</span></div>
              <div className="graph-edge-list">
                {graph.edges.filter((edge) => edge.from === selectedNode.id).map((edge) => (
                  <div key={edge.id}>
                    <span><ArrowRight size={13} />{graph.nodes.find((node) => node.id === edge.to)?.name}<small>{edge.label} · {edge.outcome}</small></span>
                    <GraphButton icon={Trash2} tone="ghost" onClick={() => updateGraph((draft) => { draft.edges = draft.edges.filter((item) => item.id !== edge.id); })} />
                  </div>
                ))}
              </div>
              <div className="graph-new-edge">
                <GraphSelect value={targetNodeId} onChange={setTargetNodeId}>
                  <option value="">选择下游节点…</option>
                  {graph.nodes.filter((node) => node.id !== selectedNode.id).map((node) => <option key={node.id} value={node.id} disabled={!canConnectRuleNodes(graph, selectedNode.id, node.id)}>{node.name}</option>)}
                </GraphSelect>
                <GraphSelect value={edgeOutcome} onChange={(value) => setEdgeOutcome(value as RuleGraphEdge["outcome"])}>
                  <option value="always">始终</option><option value="matched">条件命中</option><option value="unmatched">条件未命中</option><option value="approved">人工通过</option>
                </GraphSelect>
                <GraphInput value={edgeLabel} placeholder="连线名称" onChange={setEdgeLabel} />
                <GraphButton icon={GitBranch} onClick={addEdge} disabled={!targetNodeId}>连接</GraphButton>
              </div>
            </div>

            <div className="graph-danger-zone">
              <GraphButton icon={Trash2} tone="danger" disabled={graph.nodes.length <= 1} onClick={() => {
                updateGraph((draft) => {
                  draft.nodes = draft.nodes.filter((node) => node.id !== selectedNode.id);
                  draft.edges = draft.edges.filter((edge) => edge.from !== selectedNode.id && edge.to !== selectedNode.id);
                  if (draft.entryNodeId === selectedNode.id) draft.entryNodeId = draft.nodes[0]?.id ?? "";
                });
                setSelectedNodeId(graph.nodes.find((node) => node.id !== selectedNode.id)?.id ?? "");
              }}>删除节点</GraphButton>
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  );

  const reviewParameters = state.parameters.filter((parameter) => parameter.itemKind === reviewKind);
  const completedCount = run?.nodeStates.filter((item) => item.status === "completed").length ?? 0;

  const runView = (
    <div className="graph-run-page">
      <div className="graph-toolbar run-toolbar">
        <div className="graph-selector"><CirclePlay size={16} /><GraphSelect value={run?.id ?? ""} onChange={(value) => {
          setRunId(value);
          const next = state.ruleRuns.find((item) => item.id === value);
          if (next) setGraphId(next.graphId);
        }}>
          {!state.ruleRuns.length ? <option value="">暂无运行批次</option> : null}
          {state.ruleRuns.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </GraphSelect></div>
        {run ? <span className={"run-status run-status-" + run.status}>{run.status === "waiting_review" ? "等待人工审阅" : run.status === "paused" ? "等待手动节点" : run.status === "completed" ? "执行完成" : run.status === "failed" ? "执行失败" : "执行中"}</span> : null}
        <div className="graph-toolbar-spacer" />
        {readyNodes.map((node) => <GraphButton key={node.id} icon={Play} tone="primary" onClick={() => executeNode(node.id)}>启动：{node.name}</GraphButton>)}
        {run?.status === "completed" ? <GraphButton icon={Save} tone="primary" disabled title="旧 Candidate 已转为只读历史；规则图结果只能用于迁移诊断。">{run.committedAt ? "历史记录：已下发" : "历史候选只读"}</GraphButton> : null}
      </div>

      {!run || !runGraph ? (
        <div className="graph-run-empty"><Workflow size={34} /><strong>还没有执行批次</strong><span>回到规则图，选择数据范围并启动。</span><GraphButton icon={Play} tone="primary" onClick={() => setView("design")}>返回规则图</GraphButton></div>
      ) : (
        <>
          <div className="run-summary">
            <div><span>批次状态</span><strong>{run.status === "waiting_review" ? "审阅中" : run.status === "paused" ? "已暂停" : run.status === "completed" ? "已完成" : "运行中"}</strong></div>
            <div><span>数据行</span><strong>{run.workingRows.length}</strong></div>
            <div><span>规则进度</span><strong>{completedCount} / {run.nodeStates.length}</strong></div>
            <div><span>人工改动</span><strong>{run.workingRows.reduce((sum, row) => sum + row.touchedKeys.length, 0)}</strong></div>
            <div><span>开始人</span><strong>{run.startedBy}</strong></div>
          </div>

          <section className="run-board-card">
            <div className="run-board-head">
              <div><span>实时执行图</span><h3>{runGraph.name}</h3></div>
              <div className="run-status-legend">
                {(["running", "waiting_review", "ready", "completed", "pending"] as RuleNodeExecutionStatus[]).map((status) => <span key={status} className={"status-" + status}>{statusIcon(status)}{statusLabels[status]}</span>)}
              </div>
            </div>
            <GraphCanvas graph={runGraph} run={run} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} />
          </section>

          <div className="run-node-strip">
            {runGraph.nodes.map((node) => {
              const execution = run.nodeStates.find((item) => item.nodeId === node.id);
              if (!execution) return null;
              const nextNames = runGraph.edges.filter((edge) => edge.from === node.id).map((edge) => runGraph.nodes.find((item) => item.id === edge.to)?.name).filter(Boolean);
              return (
                <div key={node.id} className={"run-node-row status-" + execution.status}>
                  <span className="run-node-icon">{statusIcon(execution.status)}</span>
                  <div><strong>{node.name}</strong><small>{statusLabels[execution.status]} · 输入 {execution.inputRowIds.length} 行{nextNames.length ? " · 接下来：" + nextNames.join(" / ") : ""}</small></div>
                  {execution.status === "ready" ? <GraphButton icon={Play} onClick={() => executeNode(node.id)}>启动</GraphButton> : null}
                </div>
              );
            })}
          </div>

          {activeSnapshot ? (
            <section className="review-workspace">
              <div className="review-head">
                <div><span className="review-kicker"><Pause size={13} />执行已暂停</span><h3>{activeSnapshot.nodeName}</h3><p>这是冻结的中间表。修改只进入本次批次；点击“通过并继续”后才会流向验算和输出节点。</p></div>
                <div className="review-actions">
                  <div className="review-kind-switch">{(["rod", "reel", "line"] as ItemKind[]).map((kind) => <button key={kind} className={reviewKind === kind ? "active" : ""} onClick={() => setReviewKind(kind)}>{itemLabels[kind]}</button>)}</div>
                  <GraphButton icon={CheckCircle2} tone="primary" onClick={approveSnapshot}>通过并继续</GraphButton>
                </div>
              </div>
              <div className="review-note"><label>审阅备注<textarea value={activeSnapshot.notes} placeholder="记录为什么调整、需要下游关注什么…" onChange={(event) => mutate((draft) => {
                const targetRun = draft.ruleRuns.find((item) => item.id === run.id);
                const snapshot = targetRun?.snapshots.find((item) => item.id === activeSnapshot.id);
                if (snapshot) snapshot.notes = event.target.value;
              }, false)} /></label></div>
              <div className="review-table-wrap">
                <table className="review-table">
                  <thead><tr><th className="review-sticky">组合ID</th><th>模板</th><th>品质分</th>{reviewParameters.map((parameter) => <th key={parameter.key}>{parameter.label}<small>{parameter.unit}</small></th>)}<th>执行备注</th></tr></thead>
                  <tbody>{activeSnapshot.rows.map((row) => (
                    <tr key={row.id}>
                      <td className="review-sticky"><strong>{row.comboId}</strong><small>{row.touchedKeys.length} 项已改</small></td>
                      <td>{row.templateId}</td><td>{row.qualityScore}</td>
                      {reviewParameters.map((parameter) => {
                        const value = row.values[parameter.key];
                        return <td key={parameter.key} className={row.touchedKeys.includes(parameter.key) ? "review-edited" : ""}><GraphInput type={typeof value === "number" ? "number" : "text"} value={value} onChange={(next) => updateSnapshotValue(row, parameter.key, next)} /></td>;
                      })}
                      <td>{row.issues.join("；") || "—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </section>
          ) : null}

          {run.status === "completed" ? (
            <section className="run-output-card">
              <div><CheckCircle2 size={26} /><span><strong>本批次已执行完成</strong><small>{run.workingRows.length} 行数据到达输出节点；结果保留作迁移诊断，不改写历史 Candidate。</small></span></div>
              <GraphButton icon={Save} tone="primary" disabled title="旧 Candidate 已转为只读历史；规则图结果只能用于迁移诊断。">{run.committedAt ? "历史记录：已下发" : "历史候选只读"}</GraphButton>
            </section>
          ) : null}
        </>
      )}
    </div>
  );

  return (
    <div className="rule-graph-studio">
      <div className="graph-view-tabs">
        <button className={view === "design" ? "active" : ""} onClick={() => setView("design")}><Settings2 size={15} />规则图编排</button>
        <button className={view === "run" ? "active" : ""} onClick={() => setView("run")}><CirclePlay size={15} />执行监控{run?.status === "waiting_review" ? <em>待审阅</em> : null}</button>
      </div>
      {view === "design" ? designView : runView}
    </div>
  );
}
