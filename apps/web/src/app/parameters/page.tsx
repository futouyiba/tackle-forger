"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { EditableGrid, PageToolbar, ToolbarButton, type GridColumn } from "@/components/EditableGrid";
import { parameters, type ParameterDefinition } from "@/lib/mock-data";
import { usePersistentState } from "@/lib/usePersistentState";

type Row = ParameterDefinition;

const scopeLabel: Record<Row["scope"], string> = { ROD: "杆", REEL: "轮", LINE: "线", SHARED: "通用" };
const typeLabel: Record<Row["valueType"], string> = {
  DECIMAL: "小数", INTEGER: "整数", TEXT: "文本", BOOLEAN: "布尔", ENUM: "枚举",
};

export default function ParametersPage() {
  const [rows, setRows] = usePersistentState<Row[]>("tf:parameters", parameters.map((parameter) => ({ ...parameter })));
  const [scopeFilter, setScopeFilter] = useState<"ALL" | Row["scope"]>("ALL");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (scopeFilter !== "ALL" && row.scope !== scopeFilter) return false;
      if (search && !row.displayName.includes(search) && !row.key.includes(search)) return false;
      return true;
    });
  }, [rows, scopeFilter, search]);

  const columns: GridColumn<Row>[] = [
    { key: "scope", label: "道具", group: "基础", editable: false, width: 70, render: (row) => <span className="chip scope">{scopeLabel[row.scope]}</span> },
    { key: "displayName", label: "参数名（可改）", group: "基础", editable: true, width: 150 },
    { key: "key", label: "稳定 Key", group: "基础", editable: false, width: 180, format: (value) => String(value ?? "") },
    { key: "category", label: "分类", group: "基础", editable: true, width: 110 },
    { key: "valueType", label: "类型", group: "基础", editable: false, width: 90, render: (row) => <span className="chip">{typeLabel[row.valueType]}</span> },
    { key: "unit", label: "单位", group: "基础", editable: true, width: 90 },
    { key: "minimum", label: "下限", group: "约束", editable: true, width: 80, align: "right" },
    { key: "maximum", label: "上限", group: "约束", editable: true, width: 80, align: "right" },
    { key: "precision", label: "精度", group: "约束", editable: true, width: 70, align: "right" },
    { key: "sortOrder", label: "排序", group: "约束", editable: true, width: 70, align: "right" },
  ];

  const handleCellChange = (rowId: string, columnKey: string, value: string) => {
    setRows((current) => current.map((row) => {
      if (row.id !== rowId) return row;
      if (columnKey === "minimum" || columnKey === "maximum" || columnKey === "precision" || columnKey === "sortOrder") {
        const parsed = value === "" ? undefined : Number(value);
        return { ...row, [columnKey]: Number.isNaN(parsed as number) ? undefined : parsed };
      }
      return { ...row, [columnKey]: value === "" ? undefined : value };
    }));
  };

  const handleAdd = () => {
    const next = `custom-${Date.now() % 100000}`;
    setRows((current) => [...current, {
      id: next, key: next, displayName: "新参数", scope: scopeFilter === "ALL" ? "ROD" : scopeFilter,
      valueType: "DECIMAL", category: "自定义", unit: undefined, precision: undefined, minimum: undefined, maximum: undefined,
      enumOptions: undefined, sortOrder: current.length, isActive: true,
    }]);
  };

  const handleDelete = (rowId: string) => setRows((current) => current.filter((row) => row.id !== rowId));
  const handleClone = (rowId: string) => {
    setRows((current) => {
      const source = current.find((row) => row.id === rowId);
      if (!source) return current;
      const next = `${source.key}-copy-${Date.now() % 100000}`;
      return [...current, { ...source, id: next, key: next, displayName: `${source.displayName} 副本` }];
    });
  };

  const counts = {
    ALL: rows.length,
    ROD: rows.filter((row) => row.scope === "ROD").length,
    REEL: rows.filter((row) => row.scope === "REEL").length,
    LINE: rows.filter((row) => row.scope === "LINE").length,
    SHARED: rows.filter((row) => row.scope === "SHARED").length,
  };

  return (
    <AppShell
      title="参数定义"
      subtitle="设计体系 · 钓具属性目录"
      actions={
        <>
          <ToolbarButton variant="secondary">从工作簿导入</ToolbarButton>
          <ToolbarButton variant="primary">保存变更</ToolbarButton>
        </>
      }
    >
      <PageToolbar>
        <div className="filter-tabs">
          {(["ALL", "ROD", "REEL", "LINE", "SHARED"] as const).map((scope) => (
            <button key={scope} className={`filter-tab ${scopeFilter === scope ? "active" : ""}`} onClick={() => setScopeFilter(scope)}>
              {scope === "ALL" ? "全部" : scopeLabel[scope]}<em>{counts[scope]}</em>
            </button>
          ))}
        </div>
        <input className="search-input" placeholder="搜索参数名 / Key…" value={search} onChange={(event) => setSearch(event.target.value)} />
        <span className="toolbar-hint">点击单元格编辑 · 支持 Excel 多行多列粘贴 · 回车确认</span>
      </PageToolbar>

      <div className="panel">
        <EditableGrid
          columns={columns}
          rows={filtered}
          groups={["基础", "约束"]}
          rowLabel={(_row, index) => String(index + 1)}
          onCellChange={handleCellChange}
          onAddRow={handleAdd}
          onDeleteRow={handleDelete}
          onCloneRow={handleClone}
          emptyHint="当前筛选下暂无参数"
        />
      </div>
    </AppShell>
  );
}
