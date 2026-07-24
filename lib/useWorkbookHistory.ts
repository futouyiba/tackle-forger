import { useCallback, useEffect, useState } from "react";
import type { FeishuWorkbookRef } from "./feishu-workbook";

/**
 * 可配置飞书规则工作簿来源的本地历史。用户在前端粘贴过的非默认工作簿链接会按
 * 稳定 id 去重后保存在 localStorage，便于下次直接从下拉里选用。
 *
 * 与数据导入的 `feishuShareLinkHistory`（飞书多维表格 /base/ 链接）是两套独立历史：
 * 这里只存权威规则源工作簿引用（/wiki/ 或 /sheets/ 电子表格形式）。
 */
export const FEISHU_WORKBOOK_HISTORY_LIMIT = 8;
const STORAGE_KEY = "tf:feishu-workbook-history";

export type WorkbookHistoryEntry = FeishuWorkbookRef & { lastUsedAt: string };

/**
 * 从 localStorage 读取历史并做白名单投影：只保留 ref 的已知非敏感字段，
 * 丢弃任何客户端载荷可能夹带的凭据/PII/未知键。服务端渲染时返回空数组。
 */
function readHistory(): WorkbookHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): WorkbookHistoryEntry[] => {
      if (!entry || typeof entry !== "object") return [];
      const e = entry as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id : "";
      const shareUrl = typeof e.shareUrl === "string" ? e.shareUrl : "";
      if (!id || !shareUrl) return [];
      return [{
        id,
        shareUrl,
        name: typeof e.name === "string" ? e.name : "自定义规则工作簿",
        provider: "feishu_sheets",
        wikiToken: typeof e.wikiToken === "string" ? e.wikiToken : "",
        ...(typeof e.spreadsheetToken === "string" ? { spreadsheetToken: e.spreadsheetToken } : {}),
        ...(typeof e.anchorSheetId === "string" ? { anchorSheetId: e.anchorSheetId } : {}),
        syncScope: "workbook",
        enabled: true,
        lastUsedAt: typeof e.lastUsedAt === "string" ? e.lastUsedAt : new Date(0).toISOString(),
      }];
    });
  } catch {
    return [];
  }
}

function writeHistory(entries: WorkbookHistoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 配额受限或 localStorage 被禁用时静默放弃写入，不阻断 UI。
  }
}

/**
 * 纯函数：把一个工作簿引用并入历史。按 id 去重后置顶并按上限裁剪。
 * 不修改原数组，便于在 React state updater 与单测中复用。
 */
export function recordWorkbookHistory(
  current: WorkbookHistoryEntry[],
  ref: FeishuWorkbookRef,
  now: string = new Date().toISOString(),
): WorkbookHistoryEntry[] {
  const rest = current.filter((entry) => entry.id !== ref.id);
  const entry: WorkbookHistoryEntry = { ...ref, lastUsedAt: now };
  return [entry, ...rest].slice(0, FEISHU_WORKBOOK_HISTORY_LIMIT);
}

/**
 * SSR 安全的 localStorage 历史 hook：首次渲染返回空数组（与服务器一致），
 * 在 `useEffect` 里读取真实历史后再触发一次更新，避免 hydration mismatch。
 *
 * 只暴露当前 UI 实际使用的 `history` 与 `record`；未接通入口的删除/清空能力
 * 暂不暴露，避免引入没有产品效果的 state 更新（issue #152 LOW-4）。
 */
export function useWorkbookHistory(): {
  history: WorkbookHistoryEntry[];
  record: (ref: FeishuWorkbookRef) => void;
} {
  const [history, setHistory] = useState<WorkbookHistoryEntry[]>([]);

  useEffect(() => {
    setHistory(readHistory());
  }, []);

  const record = useCallback((ref: FeishuWorkbookRef) => {
    setHistory((current) => {
      const next = recordWorkbookHistory(current, ref);
      writeHistory(next);
      return next;
    });
  }, []);

  return { history, record };
}
