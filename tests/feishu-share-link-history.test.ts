import assert from "node:assert/strict";
import test from "node:test";
import {
  CURRENT_WORKSPACE_SCHEMA_VERSION,
  migrateWorkspaceState,
} from "../lib/migrations";
import {
  FEISHU_SHARE_LINK_HISTORY_LIMIT,
  defaultDataSourceProfiles,
  recordShareLinkHistory,
  removeShareLinkHistory,
} from "../lib/data-sources";
import { createSeedState } from "../lib/seed";
import { CANONICAL_FEISHU_WORKBOOK } from "../lib/feishu-workbook";
import type { FeishuShareLinkHistoryEntry } from "../lib/types";

const SAMPLE_URL_A = "https://example.feishu.cn/base/basetokenA?table=tblA";
const SAMPLE_URL_B = "https://example.feishu.cn/base/basetokenB?table=tblB";

function entry(
  shareUrl: string,
  label: string,
  dataset: "weight_templates" | "modifiers" = "weight_templates",
  lastUsedAt = "2026-07-01T00:00:00.000Z",
): FeishuShareLinkHistoryEntry {
  return { id: shareUrl, shareUrl, label, dataset, lastUsedAt };
}

// 构造一条合法条目并夹带凭据/个人身份/未知键，验证白名单投影是否剥离。
function maliciousEntry(shareUrl: string): Record<string, unknown> {
  return {
    id: shareUrl,
    shareUrl,
    label: "A 表 · 重量模板",
    dataset: "weight_templates",
    lastUsedAt: "2026-07-01T00:00:00.000Z",
    appToken: "secret-app-token",
    secret: "super-secret",
    password: "hunter2",
    credential: "cred",
    nonce: "n-123",
    session: "sess-abc",
    apikey: "key-xyz",
    userOpenId: "ou_pii",
    email: "a@b.cn",
    unknownExtra: "drop-me",
  };
}

const ALLOWED_KEYS = ["dataset", "id", "label", "lastUsedAt", "shareUrl"];

test("schema v19 升级到 v20 时补齐飞书分享链接历史且不改写冻结 Snapshot", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 19;
  delete legacy.feishuShareLinkHistory;
  const snapshotsBefore = structuredClone(legacy.configurationSnapshots);
  const migrated = migrateWorkspaceState(legacy);
  assert.equal(migrated.schemaVersion, 20);
  assert.deepEqual(migrated.feishuShareLinkHistory, []);
  assert.deepEqual(migrated.configurationSnapshots, snapshotsBefore);
  // 重复迁移幂等
  assert.deepEqual(migrateWorkspaceState(migrated), migrated);
});

test("schema v20 保留已有的飞书分享链接历史并过滤非法条目", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 19;
  const valid = entry(SAMPLE_URL_A, "A 表 · 重量模板", "weight_templates");
  const dup = entry(SAMPLE_URL_A, "重复 A 表", "weight_templates", "2026-07-02T00:00:00.000Z");
  const badDataset = { id: "x", shareUrl: SAMPLE_URL_B, label: "坏", dataset: "unknown", lastUsedAt: "2026-07-01T00:00:00.000Z" };
  const noUrl = { id: "y", shareUrl: "", label: "空", dataset: "modifiers", lastUsedAt: "2026-07-01T00:00:00.000Z" };
  legacy.feishuShareLinkHistory = [valid, dup, badDataset, noUrl];
  const snapshotsBefore = structuredClone(legacy.configurationSnapshots);
  const migrated = migrateWorkspaceState(legacy);
  assert.equal(migrated.schemaVersion, 20);
  // 去重保留首个合法条目；非法 dataset 与空 URL 被丢弃
  assert.equal(migrated.feishuShareLinkHistory.length, 1);
  assert.equal(migrated.feishuShareLinkHistory[0].shareUrl, SAMPLE_URL_A);
  assert.equal(migrated.feishuShareLinkHistory[0].label, "A 表 · 重量模板");
  assert.deepEqual(migrated.configurationSnapshots, snapshotsBefore);
});

test("createSeedState 产出的种子状态含空分享链接历史且为最新 schema", () => {
  const seeded = migrateWorkspaceState(createSeedState());
  assert.equal(seeded.schemaVersion, CURRENT_WORKSPACE_SCHEMA_VERSION);
  assert.ok(Array.isArray(seeded.feishuShareLinkHistory));
  assert.equal(seeded.feishuShareLinkHistory.length, 0);
});

test("recordShareLinkHistory 按 shareUrl 去重并刷新最近使用时间", () => {
  const initial = [entry(SAMPLE_URL_A, "A 表", "weight_templates")];
  const fixedTime = "2026-07-24T12:00:00.000Z";
  const next = recordShareLinkHistory(initial, {
    shareUrl: SAMPLE_URL_A,
    label: "A 表 · 重命名",
    dataset: "weight_templates",
    lastUsedAt: fixedTime,
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].shareUrl, SAMPLE_URL_A);
  assert.equal(next[0].label, "A 表 · 重命名");
  assert.equal(next[0].lastUsedAt, fixedTime);
  // 不修改原数组
  assert.equal(initial[0].label, "A 表");
});

test("recordShareLinkHistory 新地址置顶并按上限裁剪", () => {
  let history: FeishuShareLinkHistoryEntry[] = [];
  for (let i = 0; i < FEISHU_SHARE_LINK_HISTORY_LIMIT + 3; i += 1) {
    history = recordShareLinkHistory(history, {
      shareUrl: `https://example.feishu.cn/base/token${i}?table=tbl${i}`,
      label: `表 ${i}`,
      dataset: i % 2 === 0 ? "weight_templates" : "modifiers",
    });
  }
  assert.equal(history.length, FEISHU_SHARE_LINK_HISTORY_LIMIT);
  // 最新的在前面，超限的最旧条目被丢弃
  assert.equal(history[0].shareUrl, `https://example.feishu.cn/base/token${FEISHU_SHARE_LINK_HISTORY_LIMIT + 2}?table=tbl${FEISHU_SHARE_LINK_HISTORY_LIMIT + 2}`);
});

test("recordShareLinkHistory 忽略空 shareUrl", () => {
  const initial = [entry(SAMPLE_URL_A, "A 表", "weight_templates")];
  const next = recordShareLinkHistory(initial, { shareUrl: "   ", label: "空", dataset: "modifiers" });
  assert.deepEqual(next, initial);
});

test("removeShareLinkHistory 按 shareUrl 移除单条，null 清空全部", () => {
  const history = [
    entry(SAMPLE_URL_A, "A 表", "weight_templates"),
    entry(SAMPLE_URL_B, "B 表", "modifiers"),
  ];
  const trimmed = removeShareLinkHistory(history, SAMPLE_URL_A);
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0].shareUrl, SAMPLE_URL_B);
  // 不修改原数组
  assert.equal(history.length, 2);
  const cleared = removeShareLinkHistory(history, null);
  assert.equal(cleared.length, 0);
});

test("历史条目结构只含非敏感字段，绝不携带 appToken 或凭据", () => {
  const next = recordShareLinkHistory([], {
    shareUrl: SAMPLE_URL_A,
    label: "A 表",
    dataset: "weight_templates",
  });
  const keys = Object.keys(next[0]).sort();
  assert.deepEqual(keys, ["dataset", "id", "label", "lastUsedAt", "shareUrl"]);
  assert.ok(!("appToken" in next[0]));
  assert.ok(!("token" in next[0]));
  assert.ok(!("secret" in next[0]));
});

test("schema v19 迁移剥离历史条目上的 appToken/secret/PII 等额外字段", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 19;
  legacy.feishuShareLinkHistory = [maliciousEntry(SAMPLE_URL_A)];
  const migrated = migrateWorkspaceState(legacy);
  assert.equal(migrated.schemaVersion, 20);
  assert.equal(migrated.feishuShareLinkHistory.length, 1);
  const projected = migrated.feishuShareLinkHistory[0] as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(projected).sort(), ALLOWED_KEYS);
  assert.equal(projected.appToken, undefined);
  assert.equal(projected.secret, undefined);
  assert.equal(projected.userOpenId, undefined);
  assert.equal(projected.email, undefined);
  assert.equal(projected.unknownExtra, undefined);
});

test("schema v20 直接保存载荷在归一时剥离历史条目上的凭据/PII 额外字段", () => {
  // 当前 schema (v20) 输入会跳过顺序迁移，只走 migrateWorkspaceState 的归一段；
  // 这是保存边界，必须同样剥离客户端载荷可能夹带的敏感字段。
  const seeded = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  seeded.schemaVersion = 20;
  seeded.feishuShareLinkHistory = [maliciousEntry(SAMPLE_URL_A)];
  const normalized = migrateWorkspaceState(seeded);
  assert.equal(normalized.schemaVersion, 20);
  assert.equal(normalized.feishuShareLinkHistory.length, 1);
  const projected = normalized.feishuShareLinkHistory[0] as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(projected).sort(), ALLOWED_KEYS);
  assert.equal(projected.appToken, undefined);
  assert.equal(projected.credential, undefined);
  assert.equal(projected.session, undefined);
});

test("凭据剥离在重复迁移与归一后保持幂等", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  legacy.schemaVersion = 19;
  legacy.feishuShareLinkHistory = [maliciousEntry(SAMPLE_URL_A)];
  const once = migrateWorkspaceState(legacy);
  const twice = migrateWorkspaceState(once);
  assert.deepEqual(twice.feishuShareLinkHistory, once.feishuShareLinkHistory);
  const projected = twice.feishuShareLinkHistory[0] as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(projected).sort(), ALLOWED_KEYS);
});

test("recordShareLinkHistory 清洗入参数组中已存在的凭据/PII 字段", () => {
  const tainted = [maliciousEntry(SAMPLE_URL_A)] as unknown as FeishuShareLinkHistoryEntry[];
  const next = recordShareLinkHistory(tainted, {
    shareUrl: SAMPLE_URL_B,
    label: "B 表",
    dataset: "modifiers",
  });
  // 既有条目（shareUrl 不同）被保留，但额外字段被剥离。
  const preserved = next.find((item) => item.shareUrl === SAMPLE_URL_A) as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(preserved).sort(), ALLOWED_KEYS);
  assert.equal(preserved.appToken, undefined);
  assert.equal(preserved.secret, undefined);
  // 新置顶条目同样只含白名单字段。
  const fresh = next.find((item) => item.shareUrl === SAMPLE_URL_B) as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(fresh).sort(), ALLOWED_KEYS);
});

test("数据导入的飞书分享链接入口与 canonical 规则源常量互不冲突", () => {
  // 数据导入连接器读取的是飞书多维表格（/base/）分享链接，
  // 而 canonical 规则源是固定的飞书电子表格工作簿（wiki 链接）。
  // 用户在数据交换页填写的分享链接历史绝不改写规则源常量。
  assert.equal(CANONICAL_FEISHU_WORKBOOK.provider, "feishu_sheets");
  assert.ok(CANONICAL_FEISHU_WORKBOOK.shareUrl.includes("/wiki/"));
  assert.equal(CANONICAL_FEISHU_WORKBOOK.id, "feishu-workbook:tackle-design");
  // 数据源默认使用 feishu_bitable provider，与规则源 provider 不同
  const profiles = defaultDataSourceProfiles();
  assert.ok(profiles.every((profile) => profile.provider === "feishu_bitable"));
  assert.ok(profiles.every((profile) => !profile.shareUrl.includes("/wiki/")));
});
