import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  buildWorkbookRefFromShareUrl,
  CANONICAL_FEISHU_WORKBOOK,
  type FeishuWorkbookRef,
} from "../lib/feishu-workbook";
import {
  FEISHU_WORKBOOK_HISTORY_LIMIT,
  recordWorkbookHistory,
} from "../lib/useWorkbookHistory";
import { resolveWorkbookRef } from "../app/api/feishu-workbook/route";
import { migrateWorkspaceState } from "../lib/migrations";
import { createSeedState } from "../lib/seed";
import type { WorkspaceState } from "../lib/types";

// 飞书规则工作簿来源可配置（issue #152）：buildWorkbookRefFromShareUrl 把分享链接
// 解析成稳定 ref；resolveWorkbookRef 在路由层把 query/body 选择器收敛成最终要操作的 ref；
// useWorkbookHistory 的纯函数 recordWorkbookHistory 维护本地来源历史。这里固定这三段的契约。

const WIKI_URL = "https://pisn3u3ony2.feishu.cn/wiki/NodeTokenABC12345?from=from_copylink&sheet=9nE3Rx";
const SHEETS_URL = "https://pisn3u3ony2.feishu.cn/sheets/SheetTokenXYZ98765?sheet=d6e928";

function baseState(): WorkspaceState {
  return migrateWorkspaceState(createSeedState());
}

function request(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/feishu-workbook${query}`);
}

// ── buildWorkbookRefFromShareUrl ──────────────────────────────────────────────

test("buildWorkbookRefFromShareUrl：/wiki/ 形式提取 wikiToken，缺省 spreadsheetToken，id 稳定派生", () => {
  const ref = buildWorkbookRefFromShareUrl(WIKI_URL);
  assert.equal(ref.wikiToken, "NodeTokenABC12345");
  assert.equal(ref.spreadsheetToken, undefined);
  assert.equal(ref.provider, "feishu_sheets");
  assert.equal(ref.syncScope, "workbook");
  assert.ok(ref.enabled);
  assert.equal(ref.anchorSheetId, "9nE3Rx");
  assert.equal(ref.id, "feishu-workbook:NodeTokenABC12345");
  assert.equal(ref.shareUrl, WIKI_URL);
});

test("buildWorkbookRefFromShareUrl：/sheets/ 形式填 spreadsheetToken 且 wikiToken 留空字符串", () => {
  const ref = buildWorkbookRefFromShareUrl(SHEETS_URL);
  assert.equal(ref.spreadsheetToken, "SheetTokenXYZ98765");
  assert.equal(ref.wikiToken, "");
  assert.equal(ref.id, "feishu-workbook:SheetTokenXYZ98765");
  assert.equal(ref.anchorSheetId, "d6e928");
});

test("buildWorkbookRefFromShareUrl：name 缺省给中立默认，传入则覆盖", () => {
  assert.equal(buildWorkbookRefFromShareUrl(WIKI_URL).name, "自定义规则工作簿");
  assert.equal(buildWorkbookRefFromShareUrl(WIKI_URL, "  测试分支工作簿  ").name, "测试分支工作簿");
});

test("buildWorkbookRefFromShareUrl：同一链接反复解析得到同一 id（历史去重稳定）", () => {
  assert.equal(
    buildWorkbookRefFromShareUrl(WIKI_URL).id,
    buildWorkbookRefFromShareUrl(WIKI_URL).id,
  );
});

test("buildWorkbookRefFromShareUrl：格式非法或不可识别的路径抛错", () => {
  assert.throws(() => buildWorkbookRefFromShareUrl("不是合法 URL"), /飞书规则工作簿链接格式不正确/);
  assert.throws(
    () => buildWorkbookRefFromShareUrl("https://pisn3u3ony2.feishu.cn/base/someAppToken?table=tbl1"),
    /唯一规则源必须使用飞书知识库工作簿链接/,
  );
});

// ── recordWorkbookHistory（纯函数）──────────────────────────────────────────

function ref(id: string, shareUrl = `https://pisn3u3ony2.feishu.cn/wiki/${id}?sheet=9nE3Rx`): FeishuWorkbookRef {
  return buildWorkbookRefFromShareUrl(shareUrl, `工作簿 ${id}`);
}

test("recordWorkbookHistory：按 id 去重并把最新条目置顶", () => {
  const a = ref("TokenA");
  const initial = recordWorkbookHistory([], a, "2026-07-20T00:00:00.000Z");
  assert.equal(initial.length, 1);
  // 同 id 再记录刷新 lastUsedAt 并置顶（仍是唯一一条）
  const next = recordWorkbookHistory(initial, a, "2026-07-24T00:00:00.000Z");
  assert.equal(next.length, 1);
  assert.equal(next[0].lastUsedAt, "2026-07-24T00:00:00.000Z");
  // 不同 id 置顶，旧的保留在后
  const b = ref("TokenB");
  const two = recordWorkbookHistory(next, b, "2026-07-25T00:00:00.000Z");
  assert.equal(two.length, 2);
  assert.equal(two[0].id, "feishu-workbook:TokenB");
  assert.equal(two[1].id, "feishu-workbook:TokenA");
  // 不修改原数组
  assert.equal(initial[0].lastUsedAt, "2026-07-20T00:00:00.000Z");
});

test("recordWorkbookHistory：超出上限时丢弃最旧条目", () => {
  let history: ReturnType<typeof recordWorkbookHistory> = [];
  for (let i = 0; i < FEISHU_WORKBOOK_HISTORY_LIMIT + 2; i += 1) {
    history = recordWorkbookHistory(history, ref(`Token${i}`));
  }
  assert.equal(history.length, FEISHU_WORKBOOK_HISTORY_LIMIT);
  // 最新（最后写入的）在前面
  assert.equal(history[0].id, `feishu-workbook:Token${FEISHU_WORKBOOK_HISTORY_LIMIT + 1}`);
});

test("recordWorkbookHistory：历史条目只含 ref 字段加 lastUsedAt，不夹带凭据/PII", () => {
  const entry = recordWorkbookHistory([], ref("TokenA"))[0] as unknown as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  assert.deepEqual(
    keys,
    ["anchorSheetId", "enabled", "id", "lastUsedAt", "name", "provider", "shareUrl", "syncScope", "wikiToken"],
  );
  assert.ok(!("appToken" in entry));
  assert.ok(!("secret" in entry));
});

// ── resolveWorkbookRef（路由层）──────────────────────────────────────────────

test("resolveWorkbookRef：无任何选择器时回退 canonical", () => {
  assert.equal(resolveWorkbookRef(request(""), baseState()), CANONICAL_FEISHU_WORKBOOK);
});

test("resolveWorkbookRef：canonical id 直接返回同一常量", () => {
  assert.equal(
    resolveWorkbookRef(request(`?workbookId=${CANONICAL_FEISHU_WORKBOOK.id}`), baseState()),
    CANONICAL_FEISHU_WORKBOOK,
  );
});

test("resolveWorkbookRef：canonical shareUrl 直接返回同一常量", () => {
  const q = `?shareUrl=${encodeURIComponent(CANONICAL_FEISHU_WORKBOOK.shareUrl)}`;
  assert.equal(resolveWorkbookRef(request(q), baseState()), CANONICAL_FEISHU_WORKBOOK);
});

test("resolveWorkbookRef：自定义 shareUrl 构造可配置 ref（/wiki/ 与 /sheets/ 两种）", () => {
  const wikiQ = `?shareUrl=${encodeURIComponent(WIKI_URL)}`;
  const wikiRef = resolveWorkbookRef(request(wikiQ), baseState());
  assert.equal(wikiRef.id, "feishu-workbook:NodeTokenABC12345");
  assert.equal(wikiRef.wikiToken, "NodeTokenABC12345");

  const sheetsQ = `?shareUrl=${encodeURIComponent(SHEETS_URL)}`;
  const sheetsRef = resolveWorkbookRef(request(sheetsQ), baseState());
  assert.equal(sheetsRef.id, "feishu-workbook:SheetTokenXYZ98765");
  assert.equal(sheetsRef.spreadsheetToken, "SheetTokenXYZ98765");
  assert.equal(sheetsRef.wikiToken, "");
});

test("resolveWorkbookRef：wikiToken query 用 canonical host 拼成 wiki 链接构造", () => {
  const r = resolveWorkbookRef(request("?wikiToken=NodeTokenABC12345"), baseState());
  assert.equal(r.id, "feishu-workbook:NodeTokenABC12345");
  assert.equal(r.wikiToken, "NodeTokenABC12345");
  assert.ok(r.shareUrl.startsWith("https://pisn3u3ony2.feishu.cn/wiki/NodeTokenABC12345"));
});

test("resolveWorkbookRef：canonical wikiToken 直返常量，不重新构造", () => {
  assert.equal(
    resolveWorkbookRef(request(`?wikiToken=${CANONICAL_FEISHU_WORKBOOK.wikiToken}`), baseState()),
    CANONICAL_FEISHU_WORKBOOK,
  );
});

test("resolveWorkbookRef：body.workbookRef 优先于 query，POST 自定义来源生效", () => {
  const req = request(""); // 无 query
  const fromBody = resolveWorkbookRef(req, baseState(), { workbookRef: SHEETS_URL });
  assert.equal(fromBody.id, "feishu-workbook:SheetTokenXYZ98765");
});

test("resolveWorkbookRef：state.feishuWorkbooks 已登记 id 命中已登记项", () => {
  const registered: FeishuWorkbookRef = buildWorkbookRefFromShareUrl(WIKI_URL, "已登记分支");
  const state = baseState();
  state.feishuWorkbooks = [registered];
  const resolved = resolveWorkbookRef(request(`?workbookId=${registered.id}`), state);
  assert.equal(resolved, registered);
});

test("resolveWorkbookRef：非法 shareUrl 不抛，静默回退 canonical", () => {
  const q = `?shareUrl=${encodeURIComponent("https://pisn3u3ony2.feishu.cn/base/illegal")}`;
  assert.equal(resolveWorkbookRef(request(q), baseState()), CANONICAL_FEISHU_WORKBOOK);
});
