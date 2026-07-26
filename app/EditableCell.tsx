"use client";

import { useRef, useState, useCallback, type KeyboardEvent, type FocusEvent } from "react";

export interface EditableCellProps {
  /** 当前值（浏览态显示、编辑态初始值） */
  value: string | number;
  /** 提交时回调，调用方负责包装 mutate */
  onChange: (next: string) => void;
  /** 只读单元格不进入编辑态 */
  readOnly?: boolean;
  /** input type */
  type?: "text" | "number";
  /** 必填校验：为空时拒绝提交 */
  required?: boolean;
  /** 浏览态格式化展示（如数字千分位） */
  format?: (value: string | number) => string;
  /** 编辑态 parse（如去除格式化字符） */
  parse?: (raw: string) => string;
  /** 额外 class */
  className?: string;
  /** 空值占位 */
  placeholder?: string;
}

type CellMode = "browse" | "focused" | "editing";

/**
 * 可编辑单元格 — 三态区分（浏览/聚焦/编辑），键盘可进入、提交、取消。
 *
 * 不依赖完整表格上下文，单个 `<td>` 内独立使用。
 * 调用方通过 `onChange` 连接到自己的 mutate/保存逻辑。
 */
export function EditableCell({
  value,
  onChange,
  readOnly = false,
  type = "text",
  required = false,
  format,
  parse,
  className = "",
  placeholder = "",
}: EditableCellProps) {
  const [mode, setMode] = useState<CellMode>("browse");
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const displayValue = format ? format(value) : String(value ?? "");

  const enterFocused = useCallback(() => {
    if (readOnly) return;
    setMode("focused");
  }, [readOnly]);

  const enterEditing = useCallback(() => {
    if (readOnly) return;
    setDraft(String(value ?? ""));
    setMode("editing");
    // 下一帧 focus input
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [readOnly, value]);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (required && !trimmed) {
      // 必填为空 → 恢复并退出
      setMode("browse");
      return;
    }
    const final = parse ? parse(trimmed) : trimmed;
    if (String(final) !== String(value ?? "")) {
      onChange(final);
    }
    setMode("browse");
  }, [draft, required, parse, value, onChange]);

  const cancel = useCallback(() => {
    setMode("browse");
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTableCellElement | HTMLInputElement>) => {
      if (mode === "browse" || mode === "focused") {
        if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault();
          enterEditing();
        }
        return;
      }
      // editing mode
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Tab") {
        e.preventDefault();
        commit();
        // Tab 焦点交给浏览器默认行为（自然跳到下一个可聚焦元素）
        const cell = inputRef.current?.closest("td");
        if (cell) {
          const allCells = Array.from(
            cell.closest("table")?.querySelectorAll<HTMLTableCellElement>(
              "td[tabindex]"
            ) ?? [],
          );
          const idx = allCells.indexOf(cell);
          const next = allCells[idx + (e.shiftKey ? -1 : 1)];
          if (next) {
            next.focus();
          }
        }
      }
    },
    [mode, enterEditing, commit, cancel],
  );

  const handleBlur = useCallback(
    (_e: FocusEvent<HTMLInputElement>) => {
      if (mode === "editing") {
        commit();
      }
    },
    [mode, commit],
  );

  const modeClass =
    mode === "editing"
      ? "editable-cell--editing"
      : mode === "focused"
        ? "editable-cell--focused"
        : "editable-cell--browse";

  if (readOnly) {
    return (
      <td
        className={`editable-cell editable-cell--readonly ${className}`}
        aria-readonly="true"
      >
        {displayValue || placeholder || "—"}
      </td>
    );
  }

  return (
    <td
      className={`editable-cell ${modeClass} ${className}`}
      tabIndex={0}
      role="gridcell"
      aria-readonly={false}
      onClick={() => {
        if (mode === "browse") enterFocused();
      }}
      onDoubleClick={() => enterEditing()}
      onFocus={() => {
        if (mode === "browse") enterFocused();
      }}
      onKeyDown={handleKeyDown}
    >
      {mode === "editing" ? (
        <input
          ref={inputRef}
          className="editable-cell__input"
          type={type}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          aria-label="编辑中"
        />
      ) : (
        <span className="editable-cell__value">
          {displayValue || placeholder || " "}
        </span>
      )}
    </td>
  );
}
