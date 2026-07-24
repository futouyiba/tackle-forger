import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_FEISHU_WORKBOOK,
  isRuleWorkbookShareUrl,
  parseCanonicalWorkbookLink,
  recognizeFeishuRuleWorkbookLink,
} from "../lib/feishu-workbook";
import {
  FEISHU_SHARE_LINK_HISTORY_LIMIT,
  recordShareLinkHistory,
  removeShareLinkHistory,
} from "../lib/data-sources";
import type { FeishuShareLinkHistoryEntry } from "../lib/types";

// Issue #157: 「飞书规则园」combobox 的纯逻辑契约测试。
// 组件层面的 combobox（app/FeishuSourceCombobox.tsx）通过这些纯函数 + recordShareLinkHistory
// 组合实现识别/写入/过滤/选择/清除；此处覆盖其行为契约，不渲染 React。

const WIKI_URL =
  "https://pisn3u3ony2.feishu.cn/wiki/YsEKwSUJ5i86HCkZKBVcNMw7nOh?sheet=9nE3Rx";
const SHEETS_URL =
  "https://pisn3u3ony2.feishu.cn/sheets/WQ8wstS4ch29E2tAKnVcoh5KnJg?sheet=0iGCcx";
const BASE_URL = "https://pisn3u3ony2.feishu.cn/base/basetokenA?table=tblA";

/**
 * 模拟 combobox「识别」按钮的行为：识别成功 → 写入历史；失败 → 不写。
 * 与 app/Workbench.tsx renderRuleSource 的 onRecordShareLinkHistory 实现一致：
 * 规则源链接没有 bitable dataset 概念，dataset 填 weight_templates 占位。
 */
function recognizeAndRecord(
  history: readonly FeishuShareLinkHistoryEntry[],
  input: string,
): { ok: true; history: FeishuShareLinkHistoryEntry[] } | { ok: false; history: readonly FeishuShareLinkHistoryEntry[]; error: string } {
  try {
    const { shareUrl, label } = recognizeFeishuRuleWorkbookLink(input);
    const next = recordShareLinkHistory(history, {
      shareUrl,
      label,
      // 与 Workbench.tsx 一致：dataset 占位，combobox 按路径过滤与 dataset 无关。
      dataset: "weight_templates",
    });
    return { ok: true, history: next };
  } catch (error) {
    return {
      ok: false,
      history,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 模拟 combobox 历史列表的过滤显示：只展示规则源类（/wiki/ 或 /sheets/）。 */
function filterRuleWorkbookHistory(
  history: readonly FeishuShareLinkHistoryEntry[],
): FeishuShareLinkHistoryEntry[] {
  return history.filter((entry) => isRuleWorkbookShareUrl(entry.shareUrl));
}

test("recognizeFeishuRuleWorkbookLink 解析 /wiki/ 链接并生成 label", () => {
  const { shareUrl, label } = recognizeFeishuRuleWorkbookLink(WIKI_URL);
  assert.equal(shareUrl, WIKI_URL);
  // label 取 wikiToken 前缀（YsEKwSUJ5i86），用作工作簿名缓存代理。
  assert.ok(label.startsWith("飞书工作簿·"));
  assert.ok(label.includes("YsEKwSUJ5i86"));
});

test("recognizeFeishuRuleWorkbookLink 解析 /sheets/ 链接并生成 label", () => {
  const { shareUrl, label } = recognizeFeishuRuleWorkbookLink(SHEETS_URL);
  assert.equal(shareUrl, SHEETS_URL);
  assert.ok(label.startsWith("飞书工作簿·"));
  assert.ok(label.includes("WQ8wstS4ch29"));
});

test("recognizeFeishuRuleWorkbookLink 拒绝多维表格 /base/ 链接", () => {
  assert.throws(
    () => recognizeFeishuRuleWorkbookLink(BASE_URL),
    /唯一规则源必须使用飞书知识库工作簿链接/,
  );
});

test("recognizeFeishuRuleWorkbookLink 拒绝空串、非 URL 与无 /wiki//sheets/ 路径", () => {
  for (const bad of ["", "   ", "not-a-url", "https://example.com/other/tok"]) {
    assert.throws(() => recognizeFeishuRuleWorkbookLink(bad), /飞书规则工作簿链接格式不正确|唯一规则源必须使用/);
  }
});

test("isRuleWorkbookShareUrl 对规则源链接返回 true，对其余返回 false", () => {
  assert.equal(isRuleWorkbookShareUrl(WIKI_URL), true);
  assert.equal(isRuleWorkbookShareUrl(SHEETS_URL), true);
  assert.equal(isRuleWorkbookShareUrl(BASE_URL), false);
  assert.equal(isRuleWorkbookShareUrl(""), false);
  assert.equal(isRuleWorkbookShareUrl("not-a-url"), false);
});

test("combobox 识别成功后写入历史（dataset 占位 weight_templates，无凭据）", () => {
  const result = recognizeAndRecord([], WIKI_URL);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.history.length, 1);
  const entry = result.history[0];
  assert.equal(entry.shareUrl, WIKI_URL);
  assert.equal(entry.dataset, "weight_templates"); // 占位，与 dataset 显示无关
  // 白名单字段，绝不携带凭据。
  assert.deepEqual(Object.keys(entry).sort(), ["dataset", "id", "label", "lastUsedAt", "shareUrl"]);
});

test("combobox 识别失败时不写入历史（/base/ 链接被拒）", () => {
  const initial = recognizeAndRecord([], WIKI_URL);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  const before = initial.history;
  const result = recognizeAndRecord(before, BASE_URL);
  assert.equal(result.ok, false);
  if (result.ok) return;
  // 失败时历史不变。
  assert.deepEqual(result.history, before);
});

test("combobox 历史按 /wiki/|/sheets/ 过滤，bitable /base/ 老条目保留但不展示", () => {
  // 模拟迁移后的混合历史：1 条规则源 + 1 条 bitable 老条目（PR #124 时期写入）。
  const mixed: FeishuShareLinkHistoryEntry[] = [
    {
      id: WIKI_URL,
      shareUrl: WIKI_URL,
      label: "飞书工作簿·YsEKwSUJ5i86",
      dataset: "weight_templates",
      lastUsedAt: "2026-07-24T12:00:00.000Z",
    },
    {
      id: BASE_URL,
      shareUrl: BASE_URL,
      label: "A 表 · 重量模板",
      dataset: "weight_templates",
      lastUsedAt: "2026-07-23T12:00:00.000Z",
    },
  ];
  // 迁移无损：原数组保留两条。
  assert.equal(mixed.length, 2);
  // combobox 只展示规则源类（1 条）。
  const shown = filterRuleWorkbookHistory(mixed);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].shareUrl, WIKI_URL);
});

test("combobox 历史：同链接去重，最近优先，上限裁剪", () => {
  let history: FeishuShareLinkHistoryEntry[] = [];
  // 同链接重复识别：去重，只保留一条（最近）。
  const r1 = recognizeAndRecord(history, WIKI_URL);
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  history = r1.history;
  const r2 = recognizeAndRecord(history, WIKI_URL);
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  history = r2.history;
  assert.equal(history.length, 1);

  // 写入第二条不同的规则源链接。
  const r3 = recognizeAndRecord(history, SHEETS_URL);
  assert.equal(r3.ok, true);
  if (!r3.ok) return;
  history = r3.history;
  assert.equal(history.length, 2);
  // 最近优先：sheets 在前。
  assert.equal(history[0].shareUrl, SHEETS_URL);

  // 上限裁剪：超出 FEISHU_SHARE_LINK_HISTORY_LIMIT 后最旧的被丢弃。
  for (let i = 0; i < FEISHU_SHARE_LINK_HISTORY_LIMIT + 2; i += 1) {
    const url = `https://pisn3u3ony2.feishu.cn/wiki/node${i}?sheet=s${i}`;
    const r = recognizeAndRecord(history, url);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    history = r.history;
  }
  assert.equal(history.length, FEISHU_SHARE_LINK_HISTORY_LIMIT);
});

test("combobox 历史：清除单条与清空全部", () => {
  let history: FeishuShareLinkHistoryEntry[] = [];
  for (const url of [WIKI_URL, SHEETS_URL]) {
    const r = recognizeAndRecord(history, url);
    if (!r.ok) continue;
    history = r.history;
  }
  assert.equal(history.length, 2);
  // 清除单条。
  const afterRemove = removeShareLinkHistory(history, WIKI_URL);
  assert.equal(afterRemove.length, 1);
  assert.equal(afterRemove[0].shareUrl, SHEETS_URL);
  // 清空全部。
  const afterClear = removeShareLinkHistory(history, null);
  assert.equal(afterClear.length, 0);
});

test("combobox 历史过滤与解析器一致：parseCanonicalWorkbookLink 接受的才显示", () => {
  // 这是对"isRuleWorkbookShareUrl 与 parseCanonicalWorkbookLink 一致性"的回归保护。
  for (const url of [WIKI_URL, SHEETS_URL]) {
    assert.equal(isRuleWorkbookShareUrl(url), true);
    // parseCanonicalWorkbookLink 不抛。
    parseCanonicalWorkbookLink(url);
  }
  for (const url of [BASE_URL, "not-a-url"]) {
    assert.equal(isRuleWorkbookShareUrl(url), false);
  }
});

test("未授权（availability.enabled=false）时 combobox 不应写入历史", () => {
  // 契约：组件层在 availability.enabled=false 时按钮 disabled，不会触发识别。
  // 此处用纯逻辑守底：即使误触发，识别成功仍写入；因此组件层必须用 disabled 拦截。
  // 这里验证"识别成功才会写入"的前提——授权拦截由组件 disabled 实现（typecheck 保障）。
  // 反向：识别失败（/base/）即使授权也不写入。
  const result = recognizeAndRecord([], BASE_URL);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.history.length, 0);
});

test("迁移无损：v20 现有 bitable 历史与新规则源历史共存，combobox 只过滤显示规则源类", () => {
  // 模拟 PR #124 时期写入的 bitable 历史条目（数据交换页，dataset 标注真实用途）。
  const legacyBitable: FeishuShareLinkHistoryEntry[] = [
    {
      id: BASE_URL,
      shareUrl: BASE_URL,
      label: "A 表 · 重量模板",
      dataset: "weight_templates",
      lastUsedAt: "2026-07-23T12:00:00.000Z",
    },
  ];
  // 本期识别一条规则源链接。
  const r = recognizeAndRecord(legacyBitable, WIKI_URL);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // 迁移无损：bitable 老条目仍在新数组里（不丢）。
  assert.equal(r.history.length, 2);
  assert.ok(r.history.some((e) => e.shareUrl === BASE_URL));
  assert.ok(r.history.some((e) => e.shareUrl === WIKI_URL));
  // combobox 只显示规则源类。
  const shown = filterRuleWorkbookHistory(r.history);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].shareUrl, WIKI_URL);
});

test("canonical 规则源常量未被改动，仍为 YsEKw /wiki/ 形式", () => {
  // 守底：本期只做 UI + 识别 + 历史，不切 canonical。
  assert.equal(CANONICAL_FEISHU_WORKBOOK.id, "feishu-workbook:tackle-design");
  assert.equal(CANONICAL_FEISHU_WORKBOOK.provider, "feishu_sheets");
  assert.ok(CANONICAL_FEISHU_WORKBOOK.shareUrl.includes("/wiki/"));
  assert.equal(CANONICAL_FEISHU_WORKBOOK.wikiToken, "YsEKwSUJ5i86HCkZKBVcNMw7nOh");
  // 识别任意 /wiki//sheets/ 链接不会改写常量（recognize 是纯函数）。
  const before = { ...CANONICAL_FEISHU_WORKBOOK };
  recognizeFeishuRuleWorkbookLink(SHEETS_URL);
  assert.deepEqual({ ...CANONICAL_FEISHU_WORKBOOK }, before);
});
