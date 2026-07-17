"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { EditableGrid, PageToolbar, ToolbarButton, type GridColumn } from "@/components/EditableGrid";
import { templates, type WeightTemplateRow } from "@/lib/mock-data";
import { usePersistentState } from "@/lib/usePersistentState";

const PARAM_COLUMNS = [
  { key: "rod.length", label: "杆长(cm)" },
  { key: "rod.maxFishWeight", label: "杆最大钓重(g)" },
  { key: "rod.lureWeightMin", label: "饵重下限(g)" },
  { key: "rod.lureWeightMax", label: "饵重上限(g)" },
  { key: "reel.maxPull", label: "轮拉力(g)" },
  { key: "line.maxPull", label: "线拉力(g)" },
  { key: "line.length", label: "线长(cm)" },
];

function valueOf(row: WeightTemplateRow, key: string): number | string {
  return row.values[key] ?? "";
}

export default function TemplatesPage() {
  const [rows, setRows] = usePersistentState<WeightTemplateRow[]>("tf:templates", templates.map((template) => ({
    ...template, values: { ...template.values },
  })));
  const [selected, setSelected] = useState<string[]>([]);

  const toggleSelect = (id: string) => setSelected((current) =>
    current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  const columns: GridColumn<WeightTemplateRow>[] = [
    { key: "_select", label: "", group: "标识", editable: false, width: 40, render: (row) => (
      <input type="checkbox" checked={selected.includes(row.id)} onChange={() => toggleSelect(row.id)} />
    ) },
    { key: "code", label: "模板号", group: "标识", editable: true, width: 80 },
    { key: "name", label: "模板名", group: "标识", editable: true, width: 130 },
    { key: "fishingMethod", label: "钓法", group: "标识", editable: true, width: 110 },
    { key: "weightBand", label: "重量段", group: "标识", editable: true, width: 90 },
    { key: "nominalWeight", label: "标称鱼重(kg)", group: "区间", editable: true, width: 110, align: "right" },
    { key: "coverageMin", label: "覆盖下限", group: "区间", editable: true, width: 90, align: "right" },
    { key: "coverageMax", label: "覆盖上限", group: "区间", editable: true, width: 90, align: "right" },
    ...PARAM_COLUMNS.map((parameter) => ({
      key: parameter.key,
      label: parameter.label,
      group: "基准参数",
      editable: true,
      width: 110,
      align: "right" as const,
      render: (row: WeightTemplateRow) => String(valueOf(row, parameter.key)),
    })),
    { key: "notes", label: "备注", group: "区间", editable: true, width: 160 },
  ];

  const handleCellChange = (rowId: string, columnKey: string, value: string) => {
    setRows((current) => current.map((row) => {
      if (row.id !== rowId) return row;
      if (PARAM_COLUMNS.some((parameter) => parameter.key === columnKey)) {
        const parsed = value === "" ? "" : Number(value);
        return { ...row, values: { ...row.values, [columnKey]: Number.isNaN(parsed as number) ? value : parsed } };
      }
      if (["nominalWeight", "coverageMin", "coverageMax"].includes(columnKey)) {
        const parsed = value === "" ? 0 : Number(value);
        return { ...row, [columnKey]: Number.isNaN(parsed as number) ? 0 : parsed };
      }
      return { ...row, [columnKey]: value };
    }));
  };

  const handleAdd = () => {
    const next = `T${String(rows.length + 1).padStart(2, "0")}`;
    setRows((current) => [...current, {
      id: next, code: next, name: "新模板", fishingMethod: "淡水路亚", weightBand: "自定义",
      nominalWeight: 1, coverageMin: 0.5, coverageMax: 2, values: {}, notes: "",
    }]);
  };

  const handleDelete = (rowId: string) => {
    setRows((current) => current.filter((row) => row.id !== rowId));
    setSelected((current) => current.filter((item) => item !== rowId));
  };

  const selectedRows = useMemo(() => rows.filter((row) => selected.includes(row.id)), [rows, selected]);

  return (
    <AppShell
      title="重量模板"
      subtitle="设计体系 · 钓法 × 大重量段的中性基准"
      actions={<><ToolbarButton variant="secondary">对比选中</ToolbarButton><ToolbarButton variant="primary">保存变更</ToolbarButton></>}
    >
      <PageToolbar>
        <span className="toolbar-hint">中性模板是后续所有道具的起点；选中 2–4 个模板可在下方对比</span>
        <ToolbarButton variant="secondary" onClick={handleAdd}>+ 新增模板</ToolbarButton>
      </PageToolbar>

      <div className="panel">
        <EditableGrid
          columns={columns}
          rows={rows}
          groups={["标识", "区间", "基准参数"]}
          rowLabel={(row) => row.code}
          onCellChange={handleCellChange}
          onAddRow={handleAdd}
          onDeleteRow={handleDelete}
          onCloneRow={(rowId) => {
            setRows((current) => {
              const source = current.find((row) => row.id === rowId);
              if (!source) return current;
              const next = `${source.id}-c${rows.length + 1}`;
              return [...current, { ...source, id: next, code: next, name: `${source.name} 副本`, values: { ...source.values } }];
            });
          }}
          emptyHint="暂无模板"
        />
      </div>

      {selectedRows.length >= 2 && (
        <div className="panel compare-panel">
          <div className="panel-heading"><div><span>横向对比</span><h2>已选 {selectedRows.length} 个模板</h2></div></div>
          <div className="compare-grid">
            <table className="data-grid compact">
              <thead><tr><th>参数</th>{selectedRows.map((row) => <th key={row.id}>{row.name}</th>)}</tr></thead>
              <tbody>
                {PARAM_COLUMNS.map((parameter) => (
                  <tr key={parameter.key}>
                    <td className="cell-static">{parameter.label}</td>
                    {selectedRows.map((row) => {
                      const values = selectedRows.map((item) => Number(valueOf(item, parameter.key)) || 0);
                      const min = Math.min(...values);
                      const max = Math.max(...values);
                      const current = Number(valueOf(row, parameter.key)) || 0;
                      const isExtreme = values.length > 1 && (current === min || current === max);
                      return <td key={row.id} className={`cell-static align-right ${isExtreme ? "extreme" : ""}`}>{valueOf(row, parameter.key) || "—"}</td>;
                    })}
                  </tr>
                ))}
                <tr><td className="cell-static">标称鱼重(kg)</td>{selectedRows.map((row) => <td key={row.id} className="cell-static align-right">{row.nominalWeight}</td>)}</tr>
                <tr><td className="cell-static">覆盖区间</td>{selectedRows.map((row) => <td key={row.id} className="cell-static align-right">{row.coverageMin}–{row.coverageMax}</td>)}</tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </AppShell>
  );
}
