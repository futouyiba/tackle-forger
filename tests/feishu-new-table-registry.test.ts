import assert from "node:assert/strict";
import test from "node:test";
import {
  NEW_CANONICAL_FEISHU_SHEET_REGISTRY,
  NEW_CANONICAL_FEISHU_WORKBOOK,
  parseCanonicalWorkbookLink,
  validateFeishuWorkbookConfiguration,
  type FeishuSheetRole,
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

test("NEW_CANONICAL_FEISHU_SHEET_REGISTRY：48 张分表，sheetId 全局唯一、非空、名称非空", () => {
  assert.equal(NEW_CANONICAL_FEISHU_SHEET_REGISTRY.length, 48, "对照表登记 48 张分表");
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

test("validateFeishuWorkbookConfiguration：/wiki/ workbook wikiToken 不一致抛错（/wiki/ 通用契约）", () => {
  // /wiki/ 是飞书知识库挂载电子表格的通用形式，wikiToken 必须与登记一致（保留通用能力，不依赖已废弃旧表常量）。
  const wikiWorkbook: FeishuWorkbookRef = {
    id: "feishu-workbook:wiki-test", name: "知识库挂载工作簿（测试）", provider: "feishu_sheets",
    shareUrl: "https://pisn3u3ony2.feishu.cn/wiki/WikiTokenTestXXXX?sheet=main",
    wikiToken: "WikiTokenTestXXXX", anchorSheetId: "main", syncScope: "workbook", enabled: true,
  };
  const mismatched: FeishuWorkbookRef = { ...wikiWorkbook, wikiToken: "WrongWikiTokenXXXXXXXXXXXX" };
  assert.throws(
    () => validateFeishuWorkbookConfiguration(mismatched, NEW_CANONICAL_FEISHU_SHEET_REGISTRY),
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

test("validateFeishuWorkbookConfiguration：/sheets/ workbook 缺失 spreadsheetToken 抛错（冻结稳定身份）", () => {
  // 缺失 token 不得静默通过，否则运行时会回退 wiki 解析失败且工作簿没有冻结稳定身份。
  const missing: FeishuWorkbookRef = { ...NEW_CANONICAL_FEISHU_WORKBOOK, spreadsheetToken: undefined };
  assert.throws(
    () => validateFeishuWorkbookConfiguration(missing, NEW_CANONICAL_FEISHU_SHEET_REGISTRY),
    /缺少 spreadsheetToken/,
  );
});

test("validateFeishuWorkbookConfiguration：/sheets/ workbook 空白 spreadsheetToken 抛错", () => {
  for (const blank of ["", "   ", "\t"]) {
    const blanked: FeishuWorkbookRef = { ...NEW_CANONICAL_FEISHU_WORKBOOK, spreadsheetToken: blank };
    assert.throws(
      () => validateFeishuWorkbookConfiguration(blanked, NEW_CANONICAL_FEISHU_SHEET_REGISTRY),
      /缺少 spreadsheetToken/,
      `空白 token ${JSON.stringify(blank)} 必须抛错`,
    );
  }
});

test("NEW_CANONICAL_FEISHU_SHEET_REGISTRY：逐 sheet 角色断言（派生镜像只读，不得登记为可导入规则源）", () => {
  // 锁定每张分表的角色：StructuralBenchmark/DerivedProjection 派生审核镜像
  // （02.5 钓法模板 / 03.5 类型模板 / 04.5 功能模板）一律 historical_reference 只读，
  // 切 registry 后 UI/AI 消费者不得把它们当作可导入、可提案的规则源。
  const expectedRoles: Record<string, FeishuSheetRole> = {
    "0iGCcx": "historical_reference",
    "1cAihB": "rule_source",
    "2KCCHR": "rule_source",
    "3FYijT": "rule_source",
    "4zXYpP": "rule_source",
    "5oZXTO": "rule_source",
    "6FwSyV": "rule_source",
    "7ygxLI": "historical_reference",
    "8pvTQG": "historical_reference",
    "9gvEsP": "historical_reference",
    "10TyFp": "rule_source",
    "11CfXW": "rule_source",
    "12VetE": "rule_source",
    "13awql": "historical_reference",
    "14rhyG": "historical_reference",
    "15nsqs": "historical_reference",
    "16qYVn": "rule_source",
    "17jqiE": "rule_source",
    "18pjcZ": "rule_source",
    "19XKzU": "rule_source",
    "20OOnC": "historical_reference",
    "21kEvM": "historical_reference",
    "22RAak": "historical_reference",
    "23CsXE": "rule_source",
    "24YDSO": "rule_source",
    "25UnTC": "rule_source",
    "26gpIF": "rule_source",
    "27hboC": "rule_source",
    "28fQhg": "rule_source",
    "31RxeB": "rule_source",
    "32BmZs": "rule_source",
    "33IGHy": "rule_source",
    "36GGVk": "development_plan",
    "37YLZE": "rule_source",
    "38LXDQ": "rule_source",
    "39IhAP": "rule_source",
    "40RwxO": "rule_source",
    "41CgUB": "rule_source",
    "42ACks": "staging_output",
    "43dYFE": "staging_output",
    "44YIZT": "staging_output",
    "45qauz": "historical_reference",
    "46ogtj": "publish_control",
    "47PfUw": "staging_output",
    "48IxFG": "staging_output",
    "49kgpf": "staging_output",
    "50Yure": "staging_output",
    "51FogM": "staging_output",
  };
  assert.equal(
    Object.keys(expectedRoles).length,
    NEW_CANONICAL_FEISHU_SHEET_REGISTRY.length,
    "期望角色表必须覆盖全部 50 张分表",
  );
  for (const entry of NEW_CANONICAL_FEISHU_SHEET_REGISTRY) {
    const expected = expectedRoles[entry.sheetId];
    assert.ok(expected, `缺少 ${entry.sheetId} 的期望角色`);
    assert.equal(
      entry.role,
      expected,
      `${entry.expectedName}/${entry.sheetId} 角色应为 ${expected}，实为 ${entry.role}`,
    );
    if (entry.role !== "rule_source") {
      assert.equal(entry.required, false, `${entry.sheetId} 非规则源不得 required`);
      assert.equal(entry.importsRules, false, `${entry.sheetId} 非规则源不得 importsRules`);
    }
  }
});
