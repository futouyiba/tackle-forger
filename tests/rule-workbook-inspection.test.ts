import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_FEISHU_SHEET_REGISTRY,
  CANONICAL_FEISHU_WORKBOOK,
  type FeishuSourceRevision,
} from "../lib/feishu-workbook";
import {
  canonicalRuleWorkbookRangeRequests,
  inspectCanonicalRuleWorkbookValues,
  type CanonicalWorkbookRange,
} from "../lib/rule-workbook-inspection";

function sourceRevision(): FeishuSourceRevision {
  return {
    id: "feishu-revision:characterization",
    workbookRefId: CANONICAL_FEISHU_WORKBOOK.id,
    sourceRevision: "9001",
    spreadsheetToken: CANONICAL_FEISHU_WORKBOOK.spreadsheetToken!,
    pulledAt: "2026-07-26T00:00:00.000Z",
    pulledBy: "test",
    anchorSheetId: CANONICAL_FEISHU_WORKBOOK.anchorSheetId,
    syncScope: "workbook",
    registryHash: "registry-hash",
    sheets: CANONICAL_FEISHU_SHEET_REGISTRY.map((entry) => ({
      sheetId: entry.sheetId,
      name: entry.expectedName,
      rowCount: entry.sheetId === "27hboC" ? 5 : entry.sheetId === "28fQhg" ? 2 : entry.sheetId === "23CsXE" ? 3 : 2,
      columnCount: entry.sheetId === "27hboC" ? 6 : entry.sheetId === "28fQhg" ? 3 : entry.sheetId === "23CsXE" ? 6 : entry.sheetId === "19XKzU" ? 19 : entry.sheetId === "25UnTC" ? 23 : 30,
    })),
    issues: [],
    state: "PULLED",
  };
}

function emptyRanges(revision: FeishuSourceRevision): CanonicalWorkbookRange[] {
  return canonicalRuleWorkbookRangeRequests(revision).map(({ sheetId, range }) => ({
    sheetId,
    range,
    valueRange: { revision: revision.sourceRevision, range: `${sheetId}!${range}`, values: [] },
  }));
}

test("source-neutral inspection core 保留飞书来源身份并确定性返回全部解析层", async () => {
  const revision = sourceRevision();
  const input = { observedAt: "2026-07-26T00:00:00.000Z", sourceRevision: revision, ranges: emptyRanges(revision) };
  const first = await inspectCanonicalRuleWorkbookValues(input);
  const second = await inspectCanonicalRuleWorkbookValues(input);

  assert.equal(first.sourceRevision, revision);
  assert.equal(first.identityReport.workbookRefId, CANONICAL_FEISHU_WORKBOOK.id);
  assert.equal(first.canonicalRuleDraft.sourceRevisionId, revision.id);
  assert.equal(first.qualityDraft.sourceRevisionId, revision.id);
  assert.equal(first.pricingDraft.sourceRevisionId, revision.id);
  assert.equal(first.weightTemplateDraft.sourceRevisionId, revision.id);
  assert.deepEqual(first, second);
});

test("canonical range 请求继续由同一 source revision grid 元数据决定", () => {
  const revision = sourceRevision();
  const requests = canonicalRuleWorkbookRangeRequests(revision);
  assert.ok(requests.some((request) => request.sheetId === "23CsXE" && request.range === "B1:C3"));
  assert.ok(requests.some((request) => request.sheetId === "23CsXE" && request.range === "B2:F3"));
  assert.ok(requests.some((request) => request.sheetId === "27hboC" && request.range === "A1:F5"));
  assert.ok(requests.some((request) => request.sheetId === "25UnTC" && request.range === "A1:W2"));
  assert.equal(new Set(requests.map((request) => `${request.sheetId}:${request.range}`)).size, requests.length);
});
