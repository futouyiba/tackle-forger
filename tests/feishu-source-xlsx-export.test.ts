import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { NextRequest } from "next/server";
import { GET } from "../app/api/export-feishu-source-xlsx/route";
import { loadWorkspaceState } from "../lib/storage";
import {
  CANONICAL_FEISHU_SHEET_REGISTRY,
  CANONICAL_FEISHU_WORKBOOK,
  type FeishuSourceRevision,
} from "../lib/feishu-workbook";
import {
  buildFeishuSourceExportRequests,
  buildFeishuSourceExportWorkbook,
  columnLetter,
  feishuSourceExportFilename,
  feishuSourceSheetRange,
  missingSourceSheets,
  serializeFeishuSourceExport,
  type FeishuSourceRangeRead,
} from "../lib/feishu-source-xlsx-export";

const authHeaders = {
  "x-feishu-tenant-key": "tenant",
  "x-feishu-open-id": "source-export-tester",
  "x-feishu-display-name": "source-export-tester",
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

function makeSourceRevision(): FeishuSourceRevision {
  return {
    id: "feishu-revision:test-42",
    workbookRefId: CANONICAL_FEISHU_WORKBOOK.id,
    sourceRevision: "42",
    spreadsheetToken: "SECRET_SHEET_TOKEN_MARKER",
    pulledAt: "2026-01-01T00:00:00Z",
    pulledBy: "tester",
    anchorSheetId: "9nE3Rx",
    syncScope: "workbook",
    registryHash: "hash-test",
    sheets: [
      { sheetId: "d6e928", name: "01_重量模板", rowCount: 54, columnCount: 60 },
      { sheetId: "rgFPUu", name: "02_钓法类型", rowCount: 12, columnCount: 28 },
      { sheetId: "9nE3Rx", name: "06_系列", rowCount: 10, columnCount: 12 },
    ],
    issues: [],
    state: "PULLED",
  };
}

function makeReads(): FeishuSourceRangeRead[] {
  return [
    {
      sheetId: "d6e928",
      range: "A1:BH54",
      valueRange: { revision: "42", range: "d6e928!A1:BH54", values: [["参数", "值"], ["竿拉力", "10"], ["轮拉力", "8"]] },
      expectedName: "01_重量模板",
      observedName: "01_重量模板",
    },
    {
      sheetId: "rgFPUu",
      range: "A1:AB12",
      valueRange: { revision: "42", range: "rgFPUu!A1:AB12", values: [["钓法", "类型"], ["路亚", "竿"]] },
      expectedName: "02_钓法类型",
      observedName: "02_钓法类型",
    },
    {
      sheetId: "9nE3Rx",
      range: "A1:L10",
      valueRange: { revision: "42", range: "9nE3Rx!A1:L10", values: [["系列", "型号"], ["series_rod_01", "M1"]] },
      expectedName: "06_系列",
      observedName: "06_系列",
    },
  ];
}

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

test("columnLetter 正确转换列号（A/Z/AA/AZ）", () => {
  assert.equal(columnLetter(1), "A");
  assert.equal(columnLetter(26), "Z");
  assert.equal(columnLetter(27), "AA");
  assert.equal(columnLetter(52), "AZ");
  assert.equal(columnLetter(702), "ZZ");
  assert.throws(() => columnLetter(0));
  assert.throws(() => columnLetter(-1));
});

test("feishuSourceSheetRange 用 grid 构造整表范围，缺 grid 回退默认上限", () => {
  assert.equal(feishuSourceSheetRange({ sheetId: "x", name: "x", rowCount: 54, columnCount: 60 }), "A1:BH54");
  assert.equal(feishuSourceSheetRange({ sheetId: "x", name: "x", rowCount: 12, columnCount: 28 }), "A1:AB12");
  // 缺 grid：回退到默认 500 行 × 60 列。
  assert.equal(feishuSourceSheetRange({ sheetId: "x", name: "x" }), "A1:BH500");
  // 非安全整数回退。
  assert.equal(feishuSourceSheetRange({ sheetId: "x", name: "x", rowCount: -1, columnCount: 0 }), "A1:BH500");
});

test("buildFeishuSourceExportRequests 仅包含存在 grid 的 rule_source sheet，顺序遵循 registry", () => {
  const rev = makeSourceRevision();
  const requests = buildFeishuSourceExportRequests(rev, CANONICAL_FEISHU_SHEET_REGISTRY);
  const ids = requests.map((r) => r.sheetId);
  // registry 中 rule_source 且在 rev.sheets 里存在的：d6e928, rgFPUu, 9nE3Rx
  assert.deepEqual(ids, ["d6e928", "rgFPUu", "9nE3Rx"]);
  // 缺席 sheet 不应出现。
  assert.ok(!ids.includes("fATowU"));
});

test("missingSourceSheets 列出缺席的 rule_source sheet", () => {
  const rev = makeSourceRevision();
  const missing = missingSourceSheets(rev, CANONICAL_FEISHU_SHEET_REGISTRY);
  const missingIds = missing.map((m) => m.sheetId);
  // 大量 rule_source sheet 在 rev 中缺席。
  assert.ok(missingIds.includes("fATowU"));
  assert.ok(missingIds.includes("zrVOxd"));
  assert.ok(missingIds.includes("u87sRh"));
  assert.ok(!missingIds.includes("d6e928"));
});

test("导出含元信息 sheet 与每个 range 的数据 sheet（多 sheet）", () => {
  const input = {
    sourceRevision: makeSourceRevision(),
    registry: CANONICAL_FEISHU_SHEET_REGISTRY,
    reads: makeReads(),
  };
  const workbook = buildFeishuSourceExportWorkbook(input);
  const names = new Set(workbook.SheetNames);
  assert.ok(names.has("源数据说明"));
  assert.ok(names.has("01_重量模板"));
  assert.ok(names.has("02_钓法类型"));
  assert.ok(names.has("06_系列"));
  // 数据 sheet 内容为飞书原始 values（含表头）。
  const weight = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets["01_重量模板"]!, { header: 1 });
  assert.deepEqual(weight[0], ["参数", "值"]);
  assert.deepEqual(weight[1], ["竿拉力", "10"]);
});

test("导出对 spreadsheetToken 脱敏，不泄露凭据", () => {
  const input = {
    sourceRevision: makeSourceRevision(),
    registry: CANONICAL_FEISHU_SHEET_REGISTRY,
    reads: makeReads(),
  };
  const buffer = serializeFeishuSourceExport(input);
  const workbook = XLSX.read(buffer, { type: "array" });
  const cells = collectCellStrings(workbook);
  assert.ok(!cells.includes("SECRET_SHEET_TOKEN_MARKER"), "spreadsheetToken 泄露到导出");
  assert.ok(cells.includes("<redacted>"), "应出现 <redacted> 脱敏标记");
});

test("导出确定性：相同输入产生二进制一致的输出", () => {
  const input = {
    sourceRevision: makeSourceRevision(),
    registry: CANONICAL_FEISHU_SHEET_REGISTRY,
    reads: makeReads(),
  };
  const first = Buffer.from(serializeFeishuSourceExport(input));
  const second = Buffer.from(serializeFeishuSourceExport(input));
  assert.equal(first.length, second.length);
  assert.deepEqual(first, second);
});

test("文件名仅依赖源 revision，不含时间戳", () => {
  const name = feishuSourceExportFilename({
    sourceRevision: makeSourceRevision(),
    registry: CANONICAL_FEISHU_SHEET_REGISTRY,
    reads: [],
  });
  assert.equal(name, "飞书源数据_r42.xlsx");
  assert.doesNotMatch(name, /\d{4}-\d{2}-\d{2}/);
});

test("部分 sheet 读取失败时仍导出成功的 sheet，并在元信息透明化失败", () => {
  const reads = makeReads().slice(0, 2);
  const input = {
    sourceRevision: makeSourceRevision(),
    registry: CANONICAL_FEISHU_SHEET_REGISTRY,
    reads,
    failures: [
      {
        sheetId: "9nE3Rx",
        range: "A1:L10",
        expectedName: "06_系列",
        observedName: "06_系列",
        error: "HTTP 403 无权限",
      },
    ],
  };
  const workbook = buildFeishuSourceExportWorkbook(input);
  const names = new Set(workbook.SheetNames);
  assert.ok(names.has("01_重量模板"));
  assert.ok(names.has("02_钓法类型"));
  assert.ok(!names.has("06_系列"), "失败的 sheet 不应作为数据 sheet 出现");
  const meta = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets["源数据说明"]!, { header: 1, raw: false });
  const flat = meta.flat().map(String);
  assert.ok(flat.includes("读取失败（仍导出其余成功 sheet）"));
  assert.ok(flat.includes("HTTP 403 无权限"));
});

test("路由未登录返回 401", async () => {
  disableTrustedProxy();
  const response = await GET(new NextRequest("http://localhost/api/export-feishu-source-xlsx"));
  assert.equal(response.status, 401);
  const payload = (await response.json()) as { action?: string };
  assert.equal(payload.action, "feishu_login");
});

test("路由在工作区未记录源修订时返回 409，且不产生新 revision（只读）", { concurrency: false }, async () => {
  withTrustedProxy();
  const before = await loadWorkspaceState();
  const response = await GET(new NextRequest("http://localhost/api/export-feishu-source-xlsx", { headers: authHeaders }));
  // 默认 seed 工作区未记录任何飞书源修订。
  assert.equal(response.status, 409);
  const after = await loadWorkspaceState();
  assert.equal(after.revision, before.revision, "导出不得改变工作区 revision");
  // 复核：即便返回 409，也不应修改 feishuSourceRevisions 数量。
  assert.equal(after.state.feishuSourceRevisions.length, before.state.feishuSourceRevisions.length);
});

test("路由不触碰 canonical 规则源常量", async () => {
  const workbookBefore = JSON.stringify(CANONICAL_FEISHU_WORKBOOK);
  const registryBefore = JSON.stringify(CANONICAL_FEISHU_SHEET_REGISTRY);
  withTrustedProxy();
  await GET(new NextRequest("http://localhost/api/export-feishu-source-xlsx", { headers: authHeaders })).catch(() => {});
  assert.equal(JSON.stringify(CANONICAL_FEISHU_WORKBOOK), workbookBefore, "CANONICAL_FEISHU_WORKBOOK 被修改");
  assert.equal(JSON.stringify(CANONICAL_FEISHU_SHEET_REGISTRY), registryBefore, "CANONICAL_FEISHU_SHEET_REGISTRY 被修改");
});
