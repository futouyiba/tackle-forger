import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_FEISHU_SHEET_REGISTRY,
  CANONICAL_FEISHU_WORKBOOK,
  NEW_CANONICAL_FEISHU_SHEET_REGISTRY,
  NEW_CANONICAL_FEISHU_WORKBOOK,
  parseCanonicalWorkbookLink,
  validateFeishuWorkbookConfiguration,
  type FeishuWorkbookRef,
} from "../lib/feishu-workbook";

// PR2a（#143）新表 registry 地基：仅登记 WQ8w 新表身份与 50 张分表，
// 与既有 YsEKw /wiki/ canonical 并存，不切 canonical、不动读取层。

test("NEW_CANONICAL_FEISHU_WORKBOOK：/sheets/ 直接形式，wikiToken 缺省、spreadsheetToken 登记", () => {
  assert.equal(NEW_CANONICAL_FEISHU_WORKBOOK.id, "feishu-workbook:tackle-design-new");
  assert.equal(NEW_CANONICAL_FEISHU_WORKBOOK.provider, "feishu_sheets");
  assert.equal(NEW_CANONICAL_FEISHU_WORKBOOK.syncScope, "workbook");
  assert.equal(NEW_CANONICAL_FEISHU_WORKBOOK.enabled, true);
  assert.equal(NEW_CANONICAL_FEISHU_WORKBOOK.wikiToken, undefined);
  assert.equal(NEW_CANONICAL_FEISHU_WORKBOOK.spreadsheetToken, "WQ8wstS4ch29E2tAKnVcoh5KnJg");
  assert.equal(NEW_CANONICAL_FEISHU_WORKBOOK.anchorSheetId, "0iGCcx");
  assert.ok(
    NEW_CANONICAL_FEISHU_WORKBOOK.shareUrl.startsWith(
      "https://pisn3u3ony2.feishu.cn/sheets/WQ8wstS4ch29E2tAKnVcoh5KnJg",
    ),
    "新表 shareUrl 必须是 /sheets/ 直接电子表格形式",
  );
});

test("parseCanonicalWorkbookLink：新表 URL 返回 spreadsheetToken 且 wikiToken 缺省", () => {
  const parsed = parseCanonicalWorkbookLink(NEW_CANONICAL_FEISHU_WORKBOOK.shareUrl);
  assert.equal(parsed.spreadsheetToken, "WQ8wstS4ch29E2tAKnVcoh5KnJg");
  assert.equal(parsed.wikiToken, undefined);
  assert.equal(parsed.anchorSheetId, "0iGCcx");
  assert.equal(parsed.syncScope, "workbook");
});

test("NEW_CANONICAL_FEISHU_SHEET_REGISTRY：50 张分表，sheetId 全局唯一、非空、名称非空", () => {
  assert.equal(NEW_CANONICAL_FEISHU_SHEET_REGISTRY.length, 50, "对照表登记 50 张分表");
  const seen = new Set<string>();
  for (const entry of NEW_CANONICAL_FEISHU_SHEET_REGISTRY) {
    assert.ok(entry.sheetId.trim(), `sheet_id 不得为空：${entry.expectedName}`);
    assert.ok(entry.expectedName.trim(), `expectedName 不得为空：${entry.sheetId}`);
    assert.ok(!seen.has(entry.sheetId), `sheet_id 重复：${entry.sheetId}`);
    seen.add(entry.sheetId);
  }
});

test("NEW_CANONICAL_FEISHU_SHEET_REGISTRY：全部 canOverwriteDomainTruth=false，且仅 rule_source 载入规则", () => {
  for (const entry of NEW_CANONICAL_FEISHU_SHEET_REGISTRY) {
    assert.equal(entry.canOverwriteDomainTruth, false, `${entry.sheetId} 不得覆盖领域真相`);
    if (entry.role === "rule_source") {
      assert.equal(entry.required, true, `rule_source ${entry.sheetId} 必须 required`);
      assert.equal(entry.importsRules, true, `rule_source ${entry.sheetId} 必须 importsRules`);
    } else {
      assert.equal(entry.required, false, `非 rule_source ${entry.sheetId} 不得 required`);
      assert.equal(entry.importsRules, false, `非 rule_source ${entry.sheetId} 不得 importsRules`);
    }
  }
});

test("validateFeishuWorkbookConfiguration：新表（/sheets/）登记自洽通过", () => {
  assert.doesNotThrow(() =>
    validateFeishuWorkbookConfiguration(NEW_CANONICAL_FEISHU_WORKBOOK, NEW_CANONICAL_FEISHU_SHEET_REGISTRY),
  );
});

test("validateFeishuWorkbookConfiguration：旧表（/wiki/）登记不回归", () => {
  assert.doesNotThrow(() =>
    validateFeishuWorkbookConfiguration(CANONICAL_FEISHU_WORKBOOK, CANONICAL_FEISHU_SHEET_REGISTRY),
  );
});

test("validateFeishuWorkbookConfiguration：/sheets/ workbook spreadsheetToken 不一致抛错", () => {
  const mismatched: FeishuWorkbookRef = {
    ...NEW_CANONICAL_FEISHU_WORKBOOK,
    spreadsheetToken: "MismatchedTokenXXXXXXXXXXXX",
  };
  assert.throws(
    () => validateFeishuWorkbookConfiguration(mismatched, NEW_CANONICAL_FEISHU_SHEET_REGISTRY),
    /工作簿链接与已登记 spreadsheetToken 不一致/,
  );
});

test("validateFeishuWorkbookConfiguration：/wiki/ workbook wikiToken 不一致仍按旧契约抛错（旧行为不变）", () => {
  const mismatched: FeishuWorkbookRef = {
    ...CANONICAL_FEISHU_WORKBOOK,
    wikiToken: "WrongWikiTokenXXXXXXXXXXXX",
  };
  assert.throws(
    () => validateFeishuWorkbookConfiguration(mismatched, CANONICAL_FEISHU_SHEET_REGISTRY),
    /工作簿链接与已登记 wikiToken 不一致/,
  );
});

test("validateFeishuWorkbookConfiguration：注册表存在重复 sheet_id 抛错", () => {
  const [first, ...rest] = NEW_CANONICAL_FEISHU_SHEET_REGISTRY;
  const duplicated = [first, { ...first }, ...rest];
  assert.throws(
    () => validateFeishuWorkbookConfiguration(NEW_CANONICAL_FEISHU_WORKBOOK, duplicated),
    /飞书工作表注册表存在重复 sheet_id/,
  );
});

test("validateFeishuWorkbookConfiguration：/sheets/ workbook 不强求 wikiToken（留空通过）", () => {
  // /sheets/ 直接形式即使显式置 wikiToken=undefined 也不与链接比对，校验仍通过。
  const withoutWiki: FeishuWorkbookRef = { ...NEW_CANONICAL_FEISHU_WORKBOOK, wikiToken: undefined };
  assert.doesNotThrow(() =>
    validateFeishuWorkbookConfiguration(withoutWiki, NEW_CANONICAL_FEISHU_SHEET_REGISTRY),
  );
});
