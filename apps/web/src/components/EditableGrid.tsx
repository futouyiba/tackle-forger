"use client";

import { useState } from "react";

export interface GridColumn<T> {
  key: string;
  label: string;
  group?: string;
  width?: number;
  type?: "text" | "number" | "badge" | "tags" | "static";
  editable?: boolean;
  align?: "left" | "right" | "center";
  render?: (row: T) => React.ReactNode;
  format?: (value: unknown) => string;
}

export interface EditableGridProps<T extends { id: string }> {
  columns: GridColumn<T>[];
  rows: T[];
  groups?: string[];
  rowLabel?: (row: T, index: number) => string;
  onCellChange?: (rowId: string, columnKey: string, value: string) => void;
  onAddRow?: () => void;
  onDeleteRow?: (rowId: string) => void;
  onCloneRow?: (rowId: string) => void;
  onFillDown?: (columnKey: string, value: string) => void;
  emptyHint?: string;
  frozenFirstColumns?: number;
}

function readValue(row: Record<string, unknown>, column: GridColumn<Record<string, unknown>>): unknown {
  if (column.render) return undefined;
  return row[column.key];
}

export function EditableGrid<T extends { id: string }>({
  columns,
  rows,
  groups,
  rowLabel,
  onCellChange,
  onAddRow,
  onDeleteRow,
  onCloneRow,
  onFillDown,
  emptyHint,
}: EditableGridProps<T>) {
  const [activeCell, setActiveCell] = useState<{ rowId: string; columnKey: string } | null>(null);
  const [draft, setDraft] = useState<string>("");

  const grouped = groups?.length
    ? groups.map((group) => ({ group, columns: columns.filter((column) => column.group === group) }))
    : [{ group: "", columns }];

  const startEdit = (rowId: string, columnKey: string, current: unknown) => {
    setActiveCell({ rowId, columnKey });
    setDraft(current === null || current === undefined ? "" : String(current));
  };

  const commit = () => {
    if (activeCell && onCellChange) onCellChange(activeCell.rowId, activeCell.columnKey, draft);
    setActiveCell(null);
  };

  const handlePaste = (rowId: string, columnKey: string, text: string) => {
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length <= 1 && onCellChange) {
      onCellChange(rowId, columnKey, lines[0] ?? "");
      return;
    }
    const rowIndex = rows.findIndex((row) => row.id === rowId);
    const columnOrder = columns.map((column) => column.key);
    const startColIndex = columnOrder.indexOf(columnKey);
    lines.forEach((line, lineOffset) => {
      const targetRow = rows[rowIndex + lineOffset];
      if (!targetRow) return;
      line.split("\t").forEach((cellValue, colOffset) => {
        const targetColumn = columnOrder[startColIndex + colOffset];
        if (targetColumn && onCellChange) onCellChange(targetRow.id, targetColumn, cellValue);
      });
    });
  };

  return (
    <div className="grid-wrap">
      <div className="grid-scroll">
        <table className="data-grid">
          {groups?.length && (
          <thead>
            <tr className="grid-group-row">
              <th className="grid-corner" />
              {grouped.map((section) => (
                section.group ? (
                  <th key={section.group} colSpan={section.columns.length} className="grid-group-header">
                    {section.group}
                  </th>
                ) : <th key="nogroup" colSpan={section.columns.length} />
              ))}
              {onDeleteRow && <th className="grid-action-col" />}
            </tr>
            <tr>
              <th className="grid-row-label-col">行</th>
              {columns.map((column) => (
                <th key={column.key} style={column.width ? { minWidth: column.width } : undefined} className={column.align === "right" ? "align-right" : ""}>
                  {column.label}
                </th>
              ))}
              {onDeleteRow && <th className="grid-action-col">操作</th>}
            </tr>
          </thead>
          )}
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={columns.length + 2} className="grid-empty">{emptyHint ?? "暂无数据，点击右上角新增"}</td></tr>
            )}
            {rows.map((row, index) => (
              <tr key={row.id}>
                <td className="grid-row-label">
                  <span className="grid-row-index">{rowLabel ? rowLabel(row, index) : index + 1}</span>
                </td>
                {columns.map((column) => {
                  const isActive = activeCell?.rowId === row.id && activeCell?.columnKey === column.key;
                  const value = readValue(row as unknown as Record<string, unknown>, column as unknown as GridColumn<Record<string, unknown>>);
                  if (column.render) {
                    return (
                      <td key={column.key} className={`cell-static ${column.align === "right" ? "align-right" : ""}`}>
                        {column.render(row)}
                      </td>
                    );
                  }
                  if (!column.editable) {
                    return (
                      <td key={column.key} className={`cell-static ${column.align === "right" ? "align-right" : ""}`}>
                        {column.format ? column.format(value) : (value === null || value === undefined ? "" : String(value))}
                      </td>
                    );
                  }
                  return (
                    <td
                      key={column.key}
                      className={`cell ${isActive ? "active" : ""} ${column.align === "right" ? "align-right" : ""}`}
                      onClick={() => startEdit(row.id, column.key, value)}
                    >
                      {isActive ? (
                        <input
                          autoFocus
                          className="cell-input"
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={commit}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") commit();
                            if (event.key === "Escape") setActiveCell(null);
                          }}
                          onPaste={(event) => {
                            const text = event.clipboardData.getData("text");
                            if (text.includes("\n") || text.includes("\t")) {
                              event.preventDefault();
                              handlePaste(row.id, column.key, text);
                            }
                          }}
                        />
                      ) : (
                        <span className="cell-value">
                          {column.format ? column.format(value) : (value === null || value === undefined ? "—" : String(value))}
                        </span>
                      )}
                    </td>
                  );
                })}
                {(onDeleteRow || onCloneRow) && (
                  <td className="grid-action-col">
                    <div className="grid-row-actions">
                      {onCloneRow && <button className="icon-action" title="复制行" onClick={() => onCloneRow(row.id)}>⧉</button>}
                      {onDeleteRow && <button className="icon-action danger" title="删除行" onClick={() => onDeleteRow(row.id)}>✕</button>}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {onAddRow && (
        <button className="grid-add-row" onClick={onAddRow}>+ 新增一行</button>
      )}
    </div>
  );
}

export function ToolbarButton({ children, onClick, variant = "secondary" }: { children: React.ReactNode; onClick?: () => void; variant?: "primary" | "secondary" | "ghost" }) {
  return <button className={`button ${variant}`} onClick={onClick}>{children}</button>;
}

export function PageToolbar({ children }: { children: React.ReactNode }) {
  return <div className="page-toolbar">{children}</div>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {hint && <p>{hint}</p>}
    </div>
  );
}
