import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { GET } from "../app/api/export-workspace-xlsx/route";
import { loadWorkspaceState } from "../lib/storage";
import type { WorkspaceState } from "../lib/types";
import {
  buildWorkspaceExportWorkbook,
  redactSensitive,
  serializeWorkspaceExport,
  stableStringify,
  workspaceExportFilename,
  type WorkspaceExportInput,
} from "../lib/workspace-xlsx-export";

const authHeaders = {
  "x-feishu-tenant-key": "tenant",
  "x-feishu-open-id": "export-tester",
  "x-feishu-display-name": "export-tester",
  "x-tf-proxy-secret": "route-test-secret",
};

function withTrustedProxy() {
  process.env.FEISHU_TRUST_PROXY_HEADERS = "true";
  process.env.FEISHU_PROXY_SHARED_SECRET = "route-test-secret";
  process.env.FEISHU_TENANT_KEY = "tenant";
}

function disableTrustedProxy() {
  delete process.env.FEISHU_TRUST_PROXY_HEADERS;
  delete process.env.FEISHU_PROXY_SHARED_SECRET;
  delete process.env.FEISHU_TENANT_KEY;
}

/** 把工作簿所有 sheet 展平为单元格字符串集合，用于扫描泄露。 */
function collectCellStrings(workbook: XLSX.WorkBook): string[] {
  const cells: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false });
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        if (cell !== null && cell !== undefined) cells.push(String(cell));
      }
    }
  }
  return cells;
}

test("工作区 xlsx 导出要求认证，未登录返回 401", async () => {
  disableTrustedProxy();
  const response = await GET(new NextRequest("http://localhost/api/export-workspace-xlsx"));
  assert.equal(response.status, 401);
  const payload = await response.json() as { action?: string };
  assert.equal(payload.action, "feishu_login");
});

test("工作区 xlsx 导出响应含正确 mime 与下载头，且可解析为多 sheet", { concurrency: false }, async () => {
  withTrustedProxy();
  const response = await GET(new NextRequest("http://localhost/api/export-workspace-xlsx", { headers: authHeaders }));
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Content-Type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  const disposition = response.headers.get("Content-Disposition") ?? "";
  assert.match(disposition, /attachment;/);
  assert.match(disposition, /filename\*=UTF-8''/);
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.ok(buffer.length > 0);
  const workbook = XLSX.read(buffer, { type: "array" });
  assert.ok(workbook.SheetNames.length > 10);
});

test("导出含主要集合的多 sheet，并有导出说明", async () => {
  const { state, revision } = await loadWorkspaceState();
  const workbook = buildWorkspaceExportWorkbook({ state, revision });
  const names = new Set(workbook.SheetNames);
  for (const expected of [
    "导出说明", "工作区元数据", "飞书源修订", "飞书工作簿",
    "参数定义", "重量模板", "部位定义", "钓法档案", "类型档案",
    "功能档案", "性能档案", "品质档案", "兼容规则", "亲和规则",
    "词条_V3", "技术", "合集", "系列", "SKU抽屉", "可购买Model",
    "配置快照", "派生投影摘要", "Patch台账摘要",
    "定价策略草稿", "定价策略版本", "品质价值策略草稿",
    "五轴视图定义", "修订历史", "治理审计",
  ]) {
    assert.ok(names.has(expected), `缺少 sheet：${expected}`);
  }
  // 导出说明列出每个数据 sheet 及其记录数。
  const manifest = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets["导出说明"]!);
  const manifestNames = new Set(manifest.map((row) => String(row["sheet名"])));
  assert.ok(manifestNames.has("系列"));
  assert.ok(manifestNames.has("配置快照"));
});

test("导出对 token/secret 类敏感字段脱敏，不泄露凭据", async () => {
  const { state, revision } = await loadWorkspaceState();
  // 注入已知敏感标记，验证它们不会出现在任何单元格。
  const poisoned: WorkspaceState = {
    ...state,
    feishuWorkbooks: state.feishuWorkbooks.map((entry, index) =>
      index === 0
        ? { ...entry, wikiToken: "SECRET_WIKI_TOKEN_MARKER", spreadsheetToken: "SECRET_SHEET_TOKEN_MARKER" }
        : entry,
    ),
    feishuSourceRevisions: state.feishuSourceRevisions.map((entry, index) =>
      index === 0
        ? { ...entry, spreadsheetToken: "SECRET_REVISION_TOKEN_MARKER" }
        : entry,
    ),
  };
  const buffer = serializeWorkspaceExport({ state: poisoned, revision });
  const workbook = XLSX.read(buffer, { type: "array" });
  const cells = collectCellStrings(workbook);
  for (const marker of [
    "SECRET_WIKI_TOKEN_MARKER",
    "SECRET_SHEET_TOKEN_MARKER",
    "SECRET_REVISION_TOKEN_MARKER",
  ]) {
    assert.ok(!cells.includes(marker), `敏感标记泄露到导出：${marker}`);
  }
  assert.ok(cells.includes("<redacted>"), "应出现 <redacted> 脱敏标记");
});

test("redactSensitive 递归脱敏嵌套结构与数组", () => {
  const input = {
    name: "keep",
    sessionToken: "sensitive-session",
    profile: { apiKey: "sensitive-key", label: "keep-label" },
    items: [{ id: "a", password: "sensitive-pw" }, { id: "b", keep: 1 }],
  };
  const result = redactSensitive(input);
  assert.equal(result.name, "keep");
  assert.equal(result.sessionToken, "<redacted>");
  assert.equal(result.profile.apiKey, "<redacted>");
  assert.equal(result.profile.label, "keep-label");
  assert.equal(result.items[0]!.password, "<redacted>");
  assert.equal(result.items[0]!.id, "a");
  assert.equal(result.items[1]!.keep, 1);
  // 入参不被修改。
  assert.equal(input.sessionToken, "sensitive-session");
  assert.equal(input.profile.apiKey, "sensitive-key");
});

test("stableStringify 按键序稳定序列化", () => {
  const a = stableStringify({ b: 1, a: 2 });
  const b = stableStringify({ a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1}');
});

test("导出是只读的，不产生新 revision", { concurrency: false }, async () => {
  withTrustedProxy();
  const before = await loadWorkspaceState();
  const response = await GET(new NextRequest("http://localhost/api/export-workspace-xlsx", { headers: authHeaders }));
  assert.equal(response.status, 200);
  const after = await loadWorkspaceState();
  assert.equal(after.revision, before.revision, "导出不得改变工作区 revision");
});

test("导出确定性：相同输入产生相同输出（二进制一致）", async () => {
  const { state, revision } = await loadWorkspaceState();
  const input: WorkspaceExportInput = { state, revision };
  const first = Buffer.from(serializeWorkspaceExport(input));
  const second = Buffer.from(serializeWorkspaceExport(input));
  assert.equal(first.length, second.length);
  assert.deepEqual(first, second);
});

test("文件名仅依赖 revision，不含时间戳", () => {
  const name = workspaceExportFilename({ state: {} as WorkspaceState, revision: 7 });
  assert.equal(name, "工作区数据导出_r7.xlsx");
  assert.doesNotMatch(name, /\d{4}-\d{2}-\d{2}/);
});
