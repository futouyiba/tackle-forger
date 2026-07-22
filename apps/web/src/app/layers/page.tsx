"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { EditableGrid, PageToolbar, ToolbarButton, type GridColumn } from "@/components/EditableGrid";
import { ruleLayers, dimensionOptions, modifierRules, type RuleLayer, type ModifierRuleCell, type DimensionOption } from "@/lib/mock-data";
import { usePersistentState } from "@/lib/usePersistentState";

export default function LayersPage() {
  const [layers, setLayers] = usePersistentState<RuleLayer[]>("tf:layers", ruleLayers.map((layer) => ({ ...layer })));
  const [rules, setRules] = usePersistentState<ModifierRuleCell[]>("tf:rules", modifierRules.map((rule) => ({ ...rule })));
  const [activeLayerId, setActiveLayerId] = useState<string>(layers[0]?.id ?? "");

  const move = (id: string, direction: -1 | 1) => {
    setLayers((current) => {
      const index = current.findIndex((layer) => layer.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next.map((layer, order) => ({ ...layer, order: order + 1 }));
    });
  };

  const toggleEnabled = (id: string) => setLayers((current) => current.map((layer) => layer.id === id ? { ...layer, enabled: !layer.enabled } : layer));

  const layerRules = rules.filter((rule) => dimensionOptions.some((option: DimensionOption) => option.id === rule.optionId));

  const ruleColumns: GridColumn<ModifierRuleCell & { optionName: string }>[] = [
    { key: "optionName", label: "维度选项", group: "规则", editable: false, width: 150, render: (row) => <strong style={{ color: "#eaf4f1" }}>{row.optionName}</strong> },
    { key: "parameterKey", label: "目标参数", group: "规则", editable: true, width: 180 },
    { key: "operation", label: "运算", group: "规则", editable: true, width: 110, render: (row) => (
      <span className={`op-badge ${row.operation.toLowerCase()}`}>{row.operation === "ADD" ? "+ 加" : row.operation === "MULTIPLY" ? "× 乘" : "= 设"}</span>
    ) },
    { key: "operand", label: "系数 / 值", group: "规则", editable: true, width: 110, align: "right", render: (row) => <strong style={{ color: "#eaf4f1" }}>{row.operand}</strong> },
    { key: "notes", label: "备注", group: "规则", editable: true, width: 200 },
  ];

  const rulesWithNames: Array<ModifierRuleCell & { id: string; optionName: string }> = layerRules.map((rule, index) => {
    const option = dimensionOptions.find((item: DimensionOption) => item.id === rule.optionId);
    return { ...rule, id: `${rule.optionId}-${rule.parameterKey}-${index}`, optionName: option ? `${option.catalog} · ${option.name}` : rule.optionId };
  });

  return (
    <AppShell
      title="规则层"
      subtitle="设计体系 · 可配置的分层生成管线"
      actions={<><ToolbarButton variant="secondary">+ 新增层</ToolbarButton><ToolbarButton variant="primary">保存管线</ToolbarButton></>}
    >
      <PageToolbar>
        <span className="toolbar-hint">拖动顺序调整执行优先级 · 高层在低层数值上浮动或覆盖（SET）· 层内按选项顺序 + 优先级执行</span>
      </PageToolbar>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-heading"><div><span>执行管线</span><h2>计算层顺序（自上而下）</h2></div></div>
        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {layers.map((layer, index) => (
            <div key={layer.id} className={`pipeline-layer ${activeLayerId === layer.id ? "active" : ""} ${layer.enabled ? "" : "disabled"}`} onClick={() => setActiveLayerId(layer.id)}>
              <div className="layer-order">{String(layer.order).padStart(2, "0")}</div>
              <div className="layer-body">
                <div className="layer-title">
                  <strong>{layer.name}</strong>
                  <span className="chip">{layer.key} · v{layer.version}</span>
                </div>
                <small>{layer.notes}</small>
              </div>
              <div className="layer-controls">
                <button className="icon-action" disabled={index === 0} onClick={(event) => { event.stopPropagation(); move(layer.id, -1); }}>↑</button>
                <button className="icon-action" disabled={index === layers.length - 1} onClick={(event) => { event.stopPropagation(); move(layer.id, 1); }}>↓</button>
                <button className={`icon-action ${layer.enabled ? "" : "danger"}`} onClick={(event) => { event.stopPropagation(); toggleEnabled(layer.id); }}>{layer.enabled ? "开" : "关"}</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading"><div><span>规则矩阵</span><h2>维度选项 × 参数（系数编辑）</h2></div>
          <span style={{ color: "#62757c", fontSize: 10 }}>当前层：{layers.find((l) => l.id === activeLayerId)?.name ?? "—"}</span>
        </div>
        <EditableGrid
          columns={ruleColumns}
          rows={rulesWithNames}
          groups={["规则"]}
          rowLabel={(row) => row.optionName}
          onCellChange={(rowId, columnKey, value) => {
            setRules((current) => {
              const match = rulesWithNames.find((row) => row.id === rowId);
              if (!match) return current;
              return current.map((rule) => {
                if (rule.optionId !== match.optionId || rule.parameterKey !== match.parameterKey) return rule;
                if (columnKey === "operand") return { ...rule, operand: Number.isNaN(Number(value)) ? rule.operand : Number(value) };
                return { ...rule, [columnKey]: value };
              });
            });
          }}
          onAddRow={() => setRules((current) => [...current, { optionId: dimensionOptions[0]!.id, parameterKey: "rod.distanceCoeff", operation: "ADD", operand: 1, notes: "新规则" }])}
          onDeleteRow={(rowId) => {
            const match = rulesWithNames.find((row) => row.id === rowId);
            if (!match) return;
            setRules((current) => current.filter((rule) => !(rule.optionId === match.optionId && rule.parameterKey === match.parameterKey)));
          }}
        />
      </div>

      <div className="note-line">
        <strong>运算语义：</strong><span className="op-badge add">+ 加</span> 系数可正可负（负即减）；<span className="op-badge multiply">× 乘</span> 乘法系数；<span className="op-badge set">= 设</span> 强制覆盖该层之前的值。混合运算按顺序执行，每一步都可追溯。
      </div>
    </AppShell>
  );
}
