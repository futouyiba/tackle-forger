"use client";

import { ChevronDown, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  isRuleWorkbookShareUrl,
  recognizeFeishuRuleWorkbookLink,
} from "@/lib/feishu-workbook";
import type { FeishuShareLinkHistoryEntry } from "@/lib/types";
import { CANONICAL_FEISHU_WORKBOOK } from "@/lib/feishu-workbook";

/**
 * 单条 ActionAvailability 的最小契约。与 `ActionAvailabilityMap[*]` 兼容，
 * 但只取 combobox 关心的 enabled / disabledReasonText，避免耦合具体动作码。
 */
export interface FeishuSourceComboboxAvailability {
  enabled: boolean;
  disabledReasonText?: string;
}

interface FeishuSourceComboboxProps {
  /** 完整的飞书分享链接历史（含可能的 /base/ bitable 老条目）。 */
  history: FeishuShareLinkHistoryEntry[];
  /** 控制输入框与按钮是否可用；未授权时 disabled 但 UI 仍可见。 */
  availability: FeishuSourceComboboxAvailability;
  /** 识别成功后由父组件写入历史（去重 / 上限 / 持久化由父组件负责）。 */
  onRecord: (shareUrl: string, label: string) => void;
  /** 从历史移除单条（按 shareUrl）。 */
  onRemove: (shareUrl: string) => void;
  /** 清空历史（由父组件决定是否仅清规则源类）。 */
  onClearAll: () => void;
  notify: (message: string) => void;
  /**
   * 下拉初始是否展开（非受控，仅在挂载时取值）。默认 false。
   * 生产使用不传；供 SSR 渲染与测试覆盖 popover 内的历史项 / 清除按钮。
   */
  defaultOpen?: boolean;
}

/**
 * 「飞书表来源」二合一 combobox（Issue #157）。
 *
 * 把「飞书分享链接入口 + 用过的地址历史」从「数据交换」迁到「飞书规则园」设置区。
 * 一个控件：输入框（粘贴 /wiki/ 或 /sheets/ 分享链接）+ 右侧 ▾（仅有规则源类
 * 历史时显示）+「识别」按钮。▾ 弹出历史列表，底部「清除历史」。
 *
 * 本期只做 UI + 识别 + 历史：
 * - 识别仅用 `recognizeFeishuRuleWorkbookLink`（包 `parseCanonicalWorkbookLink`）
 *   做客户端校验，不调 API、不改 `CANONICAL_FEISHU_WORKBOOK`、不动读取层。
 * - 历史复用 PR #124 已有的 `feishuShareLinkHistory` 字段（结构不变，无需迁移）；
 *   combobox 按 `/wiki/|/sheets/` 路径过滤显示规则源类条目，老的 `/base/`
 *   bitable 数据导入条目保留在 state 里（不丢）但不在此 combobox 展示。
 * - 切流（真正切换 canonical 工作簿）由 #143 跟踪，本期不接通。
 */
export function FeishuSourceCombobox(props: FeishuSourceComboboxProps) {
  const { history, availability, onRecord, onRemove, onClearAll, notify, defaultOpen = false } = props;
  const [inputValue, setInputValue] = useState("");
  const [open, setOpen] = useState(defaultOpen);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // 只展示规则源类条目（/wiki/ 或 /sheets/）；bitable /base/ 老条目不显示。
  const ruleWorkbookHistory = useMemo(
    () => history.filter((entry) => isRuleWorkbookShareUrl(entry.shareUrl)),
    [history],
  );

  // 点击外部收起下拉。
  useEffect(() => {
    if (!open) return;
    const controller = (event: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", controller);
    return () => document.removeEventListener("mousedown", controller);
  }, [open]);

  const disabled = !availability.enabled;

  const handleRecognize = () => {
    if (disabled) {
      notify(availability.disabledReasonText ?? "当前账号不能识别规则源链接。");
      return;
    }
    const trimmed = inputValue.trim();
    if (!trimmed) {
      notify("请先粘贴飞书分享链接。");
      return;
    }
    let recognized: { shareUrl: string; label: string };
    try {
      recognized = recognizeFeishuRuleWorkbookLink(trimmed);
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法识别为规则源链接。");
      return;
    }
    onRecord(recognized.shareUrl, recognized.label);
    setInputValue("");
    setOpen(false);
    notify(`链接已识别并加入历史。规则源：${CANONICAL_FEISHU_WORKBOOK.spreadsheetToken}（50张分表）。`);
  };

  const handleSelectHistory = (entry: FeishuShareLinkHistoryEntry) => {
    setInputValue(entry.shareUrl);
    setOpen(false);
    notify("已从历史填入链接，可点击「识别」重新校验。");
  };

  const showCaret = ruleWorkbookHistory.length > 0;

  return (
    <div className="feishu-source-combobox" ref={wrapperRef}>
      <div className="feishu-source-combobox-row">
        <input
          type="url"
          className="feishu-source-combobox-input"
          placeholder="粘贴飞书分享链接（/wiki/ 或 /sheets/）"
          value={inputValue}
          disabled={disabled}
          title={availability.disabledReasonText}
          aria-label="飞书规则源工作簿分享链接"
          onChange={(event) => setInputValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleRecognize();
            }
          }}
        />
        {showCaret ? (
          <button
            type="button"
            className="feishu-source-combobox-caret"
            aria-label="查看用过的规则源链接"
            aria-expanded={open}
            disabled={disabled}
            title={availability.disabledReasonText}
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="feishu-source-combobox-recognize"
          disabled={disabled || !inputValue.trim()}
          title={availability.disabledReasonText}
          onClick={() => void handleRecognize()}
        >
          识别
        </button>
      </div>

      {open && ruleWorkbookHistory.length ? (
        <div className="feishu-source-combobox-popover" role="listbox" aria-label="用过的规则源链接">
          <ul className="feishu-source-combobox-list">
            {ruleWorkbookHistory.map((entry) => (
              <li key={entry.id} className="feishu-source-combobox-list-item">
                <button
                  type="button"
                  className="feishu-source-combobox-list-item-main"
                  disabled={disabled}
                  onClick={() => handleSelectHistory(entry)}
                  title={entry.shareUrl}
                >
                  <span className="feishu-source-combobox-list-item-label">{entry.label}</span>
                  <code className="feishu-source-combobox-list-item-url">{entry.shareUrl}</code>
                </button>
                <button
                  type="button"
                  className="feishu-source-combobox-list-item-remove"
                  aria-label={"移除 " + entry.label}
                  title="从历史移除"
                  disabled={disabled}
                  onClick={() => onRemove(entry.shareUrl)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="feishu-source-combobox-popover-footer">
            <button
              type="button"
              className="feishu-source-combobox-clear"
              disabled={disabled}
              title={availability.disabledReasonText}
              onClick={() => {
                onClearAll();
                setOpen(false);
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
              清除历史
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
