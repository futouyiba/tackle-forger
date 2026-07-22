"use client";

import { AppShell } from "@/components/AppShell";
import { EditableGrid, PageToolbar, ToolbarButton, type GridColumn } from "@/components/EditableGrid";
import { affixes, qualityTiers, type AffixRow } from "@/lib/mock-data";
import { usePersistentState } from "@/lib/usePersistentState";

export default function AffixesPage() {
  const [rows, setRows] = usePersistentState<AffixRow[]>("tf:affixes", affixes.map((affix) => ({ ...affix, tags: [...affix.tags] })));

  const columns: GridColumn<AffixRow>[] = [
    { key: "kind", label: "类型", group: "词条", editable: false, width: 110, render: (row) => (
      <span className={`op-badge ${row.kind === "ATTRIBUTE" ? "multiply" : "set"}`}>{row.kind === "ATTRIBUTE" ? "+ 属性" : "◆ 被动"}</span>
    ) },
    { key: "name", label: "词条名", group: "词条", editable: true, width: 160 },
    { key: "scope", label: "道具", group: "词条", editable: true, width: 70, align: "center" },
    { key: "score", label: "价值分", group: "评分", editable: true, width: 90, align: "right", render: (row) => <strong style={{ color: "#eaf4f1" }}>{row.score}</strong> },
    { key: "description", label: "效果说明", group: "词条", editable: true, width: 220 },
    { key: "tags", label: "标签", group: "词条", editable: false, width: 140, render: (row) => <span className="badge-row">{row.tags.map((tag) => <span className="chip" key={tag}>{tag}</span>)}</span> },
  ];

  const handleCellChange = (rowId: string, columnKey: string, value: string) => {
    setRows((current) => current.map((row) => {
      if (row.id !== rowId) return row;
      if (columnKey === "score") return { ...row, score: Number.isNaN(Number(value)) ? row.score : Number(value) };
      return { ...row, [columnKey]: value };
    }));
  };

  const handleAdd = () => setRows((current) => [...current, {
    id: `A${current.length + 1}-${Date.now() % 1000}`, key: `affix-${current.length + 1}`, name: "新词条",
    kind: "ATTRIBUTE", score: 3, scope: "杆", description: "", tags: [],
  }]);

  const totalScore = rows.reduce((sum, row) => sum + row.score, 0);

  return (
    <AppShell
      title="词条库"
      subtitle="设计体系 · 决定品质的被动技能目录"
      actions={<><ToolbarButton variant="secondary">导入词条</ToolbarButton><ToolbarButton variant="primary">保存变更</ToolbarButton></>}
    >
      <PageToolbar>
        <div className="stat-row" style={{ marginBottom: 0, flex: 1 }}>
          <div className="stat-card"><span>词条总数</span><strong>{rows.length}</strong></div>
          <div className="stat-card"><span>属性词条</span><strong>{rows.filter((row) => row.kind === "ATTRIBUTE").length}</strong></div>
          <div className="stat-card"><span>被动词条</span><strong>{rows.filter((row) => row.kind === "PASSIVE").length}</strong></div>
          <div className="stat-card"><span>分值总和（参考）</span><strong>{totalScore}</strong></div>
        </div>
      </PageToolbar>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-heading"><div><span>品质映射</span><h2>评分分值 → 品质档位</h2></div></div>
        <div style={{ padding: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
          {qualityTiers.map((tier) => (
            <div key={tier.key} style={{ flex: 1, minWidth: 140, padding: "12px 14px", border: `1px solid ${tier.color}44`, background: `${tier.color}12` }}>
              <span style={{ color: tier.color, fontSize: 22, fontWeight: 700 }}>{tier.name}</span>
              <div style={{ color: "#819198", fontSize: 10, marginTop: 4 }}>{tier.min} – {tier.max === 999 ? "∞" : tier.max} 分</div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <EditableGrid
          columns={columns}
          rows={rows}
          groups={["词条", "评分"]}
          rowLabel={(row) => row.id}
          onCellChange={handleCellChange}
          onAddRow={handleAdd}
          onDeleteRow={(rowId) => setRows((current) => current.filter((row) => row.id !== rowId))}
          onCloneRow={(rowId) => {
            setRows((current) => {
              const source = current.find((row) => row.id === rowId);
              return source ? [...current, { ...source, id: `${source.id}-c`, name: `${source.name} 副本`, tags: [...source.tags] }] : current;
            });
          }}
        />
      </div>

      <div className="note-line">
        <strong>品质规则：</strong>每个 SKU / 系列在指定时即声明携带哪些词条；品质 = 聚合所携带词条的分值（默认相加，可配置为有损益加法）。属性词条直接加数值参数，被动词条提供如『抗冲击』的机制效果。
      </div>
    </AppShell>
  );
}
