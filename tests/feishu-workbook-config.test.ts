import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  buildCanonicalSheetIdMap,
  buildWorkbookRefFromShareUrl,
  CANONICAL_FEISHU_SHEET_REGISTRY,
  CANONICAL_FEISHU_WORKBOOK,
  pullFeishuWorkbookRevision,
  resolveCanonicalSheetId,
  validateSheetRegistry,
  type FeishuSourceRevision,
  type FeishuWorkbookRef,
  type RemoteFeishuSheet,
} from "../lib/feishu-workbook";
import {
  canonicalAffixSheetRanges,
  canonicalQualitySheetRange,
  canonicalRuleWorkbookRangeRequests,
} from "../lib/rule-workbook-inspection";
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

// ── 自定义工作簿：sheet_id 全部不同但名称/结构相同（issue #152 HIGH-1）─────────

// 克隆工作簿：每张表的 sheet_id 都与 canonical 不同，但工作表名称与表头结构一致。
// 飞书复制工作簿会给每张表分配全新 sheet_id，这是自定义来源最常见的形式。
const CUSTOM_SHEETS: RemoteFeishuSheet[] = CANONICAL_FEISHU_SHEET_REGISTRY.map((entry) => ({
  sheetId: `clone_${entry.sheetId}`,
  name: entry.expectedName,
}));

// 给需要 grid 元数据的表补齐 rowCount/columnCount（与 canonical fixture 一致）。
function customSheetsWithGrid(): RemoteFeishuSheet[] {
  return CUSTOM_SHEETS.map((sheet) => {
    if (sheet.name === "04_词条") return { ...sheet, rowCount: 86, columnCount: 6 };
    if (sheet.name === "01_重量模板") return { ...sheet, rowCount: 66, columnCount: 60 };
    if (sheet.name === "07_品质评分") return { ...sheet, rowCount: 60, columnCount: 19 };
    return sheet;
  });
}

test("buildCanonicalSheetIdMap：克隆工作簿按名称把 canonical 概念解析到全新 sheet_id", () => {
  const map = buildCanonicalSheetIdMap(CUSTOM_SHEETS);
  // 每个规范概念都映射到对应的 clone_ sheet_id（与 canonical 不同）。
  for (const entry of CANONICAL_FEISHU_SHEET_REGISTRY) {
    assert.equal(map[entry.sheetId], `clone_${entry.sheetId}`);
    assert.notEqual(map[entry.sheetId], entry.sheetId);
  }
  // 权威工作簿（sheet_id 命中）为恒等映射。
  const canonicalSheets = CANONICAL_FEISHU_SHEET_REGISTRY.map((entry) => ({
    sheetId: entry.sheetId,
    name: entry.expectedName,
  }));
  const identityMap = buildCanonicalSheetIdMap(canonicalSheets);
  for (const entry of CANONICAL_FEISHU_SHEET_REGISTRY) {
    assert.equal(identityMap[entry.sheetId], entry.sheetId);
  }
});

test("validateSheetRegistry：sheet_id 全不同但名称匹配时不报 SHEET_MISSING/UNREGISTERED", () => {
  const issues = validateSheetRegistry(CANONICAL_FEISHU_SHEET_REGISTRY, CUSTOM_SHEETS);
  // 所有必需表都按名称存在，不得有 error 级 SHEET_MISSING。
  const errors = issues.filter((entry) => entry.severity === "error");
  assert.equal(errors.length, 0, `不应有 error 级问题，实际：${JSON.stringify(errors)}`);
  // 克隆表的名称都命中规范表名，不应被当成未注册。
  const unregistered = issues.filter((entry) => entry.code === "UNREGISTERED_SHEET");
  assert.equal(unregistered.length, 0, `不应有未注册告警，实际：${JSON.stringify(unregistered)}`);
});

test("validateSheetRegistry：同名新表已被原表按 sheet_id 认领时仍判未注册（不冒充）", () => {
  // canonical 工作簿里把 06_系列改名，再塞进一张同名 “06_系列” 新表。
  const sheets = CANONICAL_FEISHU_SHEET_REGISTRY.map((entry) => ({
    sheetId: entry.sheetId,
    name: entry.sheetId === "9nE3Rx" ? "06_系列原型" : entry.expectedName,
  }));
  sheets.push({ sheetId: "new-series-sheet", name: "06_系列" });
  const issues = validateSheetRegistry(CANONICAL_FEISHU_SHEET_REGISTRY, sheets);
  assert.ok(issues.some((entry) => entry.code === "SHEET_RENAMED" && entry.sheetId === "9nE3Rx"));
  assert.ok(issues.some((entry) => entry.code === "UNREGISTERED_SHEET" && entry.sheetId === "new-series-sheet"));
});

test("克隆工作簿的 range request 与 grid 解析全部走实际 sheet_id，不引用 canonical", () => {
  const map = buildCanonicalSheetIdMap(customSheetsWithGrid());
  const revision = {
    id: "feishu-revision:clone",
    workbookRefId: "feishu-workbook:clone-token",
    sourceRevision: "clone-rev-1",
    spreadsheetToken: "spreadsheet:clone",
    pulledAt: "2026-07-24T00:00:00.000Z",
    pulledBy: "tester",
    syncScope: "workbook" as const,
    registryHash: "hash",
    canonicalSheetIdMap: map,
    sheets: customSheetsWithGrid(),
    issues: [],
    state: "PULLED" as const,
  } satisfies FeishuSourceRevision;

  // 概念解析：canonical id → 克隆实际 id。
  assert.equal(resolveCanonicalSheetId(revision, "zrVOxd"), "clone_zrVOxd");
  assert.equal(resolveCanonicalSheetId(revision, "d6e928"), "clone_d6e928");
  assert.equal(resolveCanonicalSheetId(revision, "FqD4j7"), "clone_FqD4j7");

  // grid 上界按克隆表的 rowCount 计算，不沿用固定末行。
  assert.deepEqual(canonicalAffixSheetRanges(revision), { identityRange: "B1:C86", aliasRange: "B2:F86" });
  assert.equal(canonicalQualitySheetRange(revision), "A1:S60");

  // range request 全部带克隆实际 sheet_id，且不出现 canonical sheet_id。
  const requests = canonicalRuleWorkbookRangeRequests(revision);
  const requestSheetIds = new Set(requests.map((entry) => entry.sheetId));
  for (const entry of CANONICAL_FEISHU_SHEET_REGISTRY) {
    assert.ok(!requestSheetIds.has(entry.sheetId), `请求不得直接引用 canonical sheet_id ${entry.sheetId}`);
  }
  assert.ok(requests.some((entry) => entry.sheetId === "clone_zrVOxd" && entry.range === "B1:C86"));
  assert.ok(requests.some((entry) => entry.sheetId === "clone_zrVOxd" && entry.range === "B2:F86"));
  assert.ok(requests.some((entry) => entry.sheetId === "clone_FqD4j7" && entry.range === "A1:S60"));
  assert.ok(requests.some((entry) => entry.sheetId === "clone_d6e928" && entry.range === "A1:BH66"));
});

test("pullFeishuWorkbookRevision：克隆工作簿经适配器拉取后写入概念映射且不报缺失", async () => {
  const workbook = buildWorkbookRefFromShareUrl(SHEETS_URL, "克隆规则工作簿");
  const adapter = {
    async resolveWorkbook() {
      return { spreadsheetToken: "spreadsheet:clone", sourceRevision: "clone-rev-2", sheets: customSheetsWithGrid() };
    },
  };
  const revision = await pullFeishuWorkbookRevision({
    workbook,
    adapter,
    pulledAt: "2026-07-24T00:00:00.000Z",
    pulledBy: "tester",
  });
  // 概念映射已写入，且把 canonical 解析到克隆实际 sheet_id。
  assert.equal(revision.canonicalSheetIdMap?.["d6e928"], "clone_d6e928");
  assert.equal(revision.canonicalSheetIdMap?.["zrVOxd"], "clone_zrVOxd");
  // 克隆工作簿结构齐全，不得有 error 级注册表问题。
  const errors = revision.issues.filter((entry) => entry.severity === "error");
  assert.equal(errors.length, 0, `克隆工作簿不应有 error 级问题，实际：${JSON.stringify(errors)}`);
  assert.equal(revision.workbookRefId, workbook.id);
});
