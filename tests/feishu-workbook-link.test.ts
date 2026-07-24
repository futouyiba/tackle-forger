import assert from "node:assert/strict";
import test from "node:test";
import { parseCanonicalWorkbookLink } from "../lib/feishu-workbook";

// parseCanonicalWorkbookLink 是权威规则源链接的纯 URL 解析器，不调用网络。
// 当前后续 PR 会把 canonical 从 /wiki/ 挂载形式切到 /sheets/ 直接电子表格形式，
// 这里固定两种形式都正确提取 token 并剥离 query 参数的契约。

test("parseCanonicalWorkbookLink：/wiki/ 形式提取 wikiToken 与 anchorSheetId，保留 from 等参数剥离", () => {
  const parsed = parseCanonicalWorkbookLink(
    "https://pisn3u3ony2.feishu.cn/wiki/YsEKwSUJ5i86HCkZKBVcNMw7nOh?from=from_copylink&sheet=9nE3Rx",
  );
  assert.equal(parsed.wikiToken, "YsEKwSUJ5i86HCkZKBVcNMw7nOh");
  assert.equal(parsed.spreadsheetToken, undefined);
  assert.equal(parsed.anchorSheetId, "9nE3Rx");
  assert.equal(parsed.syncScope, "workbook");
});

test("parseCanonicalWorkbookLink：/wiki/ 形式无 sheet 参数时 anchorSheetId 缺省", () => {
  const parsed = parseCanonicalWorkbookLink(
    "https://pisn3u3ony2.feishu.cn/wiki/YsEKwSUJ5i86HCkZKBVcNMw7nOh",
  );
  assert.equal(parsed.wikiToken, "YsEKwSUJ5i86HCkZKBVcNMw7nOh");
  assert.equal(parsed.anchorSheetId, undefined);
  assert.equal(parsed.spreadsheetToken, undefined);
  assert.equal(parsed.syncScope, "workbook");
});

test("parseCanonicalWorkbookLink：/sheets/ 直接形式提取 spreadsheetToken 且 wikiToken 缺省（不调 wiki 解析）", () => {
  const parsed = parseCanonicalWorkbookLink(
    "https://pisn3u3ony2.feishu.cn/sheets/WQ8wstS4hM0aBcDeFgHi?sheet=d6e928",
  );
  assert.equal(parsed.spreadsheetToken, "WQ8wstS4hM0aBcDeFgHi");
  assert.equal(parsed.wikiToken, undefined);
  assert.equal(parsed.anchorSheetId, "d6e928");
  assert.equal(parsed.syncScope, "workbook");
});

test("parseCanonicalWorkbookLink：/sheets/ 形式剥离 from/foo 等参数不影响 token 提取", () => {
  const parsed = parseCanonicalWorkbookLink(
    "https://pisn3u3ony2.feishu.cn/sheets/WQ8wstS4hM0aBcDeFgHi?from=from_copylink&sheet=9nE3Rx&foo=bar#anchor",
  );
  assert.equal(parsed.spreadsheetToken, "WQ8wstS4hM0aBcDeFgHi");
  assert.equal(parsed.wikiToken, undefined);
  assert.equal(parsed.anchorSheetId, "9nE3Rx");
});

test("parseCanonicalWorkbookLink：/sheets/ 形式无 sheet 参数时 anchorSheetId 缺省", () => {
  const parsed = parseCanonicalWorkbookLink(
    "https://pisn3u3ony2.feishu.cn/sheets/WQ8wstS4hM0aBcDeFgHi",
  );
  assert.equal(parsed.spreadsheetToken, "WQ8wstS4hM0aBcDeFgHi");
  assert.equal(parsed.wikiToken, undefined);
  assert.equal(parsed.anchorSheetId, undefined);
});

test("parseCanonicalWorkbookLink：/sheets/ 路径段只取首段，遇后续路径分隔停止", () => {
  const parsed = parseCanonicalWorkbookLink(
    "https://pisn3u3ony2.feishu.cn/sheets/WQ8wstS4hM0aBcDeFgHi/extra?sheet=9nE3Rx",
  );
  assert.equal(parsed.spreadsheetToken, "WQ8wstS4hM0aBcDeFgHi");
  assert.equal(parsed.anchorSheetId, "9nE3Rx");
});

test("parseCanonicalWorkbookLink：格式非法的 URL 抛格式错误", () => {
  assert.throws(
    () => parseCanonicalWorkbookLink("不是合法 URL"),
    /飞书规则工作簿链接格式不正确/,
  );
});

test("parseCanonicalWorkbookLink：空字符串抛格式错误", () => {
  assert.throws(
    () => parseCanonicalWorkbookLink("   "),
    /飞书规则工作簿链接格式不正确/,
  );
});

test("parseCanonicalWorkbookLink：无法识别的 /base/ 路径抛原错误", () => {
  assert.throws(
    () => parseCanonicalWorkbookLink("https://pisn3u3ony2.feishu.cn/base/someAppToken?table=tbl1"),
    /唯一规则源必须使用飞书知识库工作簿链接/,
  );
});

test("parseCanonicalWorkbookLink：/sheets/ 后无 token 段抛原错误", () => {
  assert.throws(
    () => parseCanonicalWorkbookLink("https://pisn3u3ony2.feishu.cn/sheets/?sheet=9nE3Rx"),
    /唯一规则源必须使用飞书知识库工作簿链接/,
  );
});

test("parseCanonicalWorkbookLink：/wiki/ 后无 token 段抛原错误", () => {
  assert.throws(
    () => parseCanonicalWorkbookLink("https://pisn3u3ony2.feishu.cn/wiki/?sheet=9nE3Rx"),
    /唯一规则源必须使用飞书知识库工作簿链接/,
  );
});
