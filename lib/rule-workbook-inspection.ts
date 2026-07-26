/**
 * 飞书规则工作簿 facade：只负责飞书网络读取（pull + range read），
 * 解析交给纯核心 `canonical-workbook-core`。本模块单向依赖核心，
 * 核心与浏览器适配器都不依赖本模块或 `feishu-sheets`。
 */
export * from "./canonical-workbook-core";
import { canonicalRuleWorkbookRangeRequests, inspectCanonicalRuleWorkbookValues, type CanonicalRuleWorkbookParsedInspection } from "./canonical-workbook-core";
import {
  CANONICAL_FEISHU_SHEET_REGISTRY,
  CANONICAL_FEISHU_WORKBOOK,
  pullFeishuWorkbookRevision,
  type FeishuSourceRevision,
} from "./feishu-workbook";
import { createFeishuWorkbookPullAdapter, readFeishuSheetRanges } from "./feishu-sheets";

export interface CanonicalRuleWorkbookInspection extends CanonicalRuleWorkbookParsedInspection {
  sourceRevision: FeishuSourceRevision;
}

let testInspectionOverride: ((input: { observedAt: string; observedBy: string }) => Promise<CanonicalRuleWorkbookInspection>) | undefined;
/** Test-only connector boundary: routes still execute their production command,
 * persistence, draft and publish paths against the returned observation. */
export function setCanonicalRuleWorkbookInspectionForTests(override?: typeof testInspectionOverride) {
  testInspectionOverride = override;
}

export async function inspectCanonicalRuleWorkbook(input: {
  observedAt: string;
  observedBy: string;
}): Promise<CanonicalRuleWorkbookInspection> {
  if (testInspectionOverride) return testInspectionOverride(input);
  const sourceRevision = await pullFeishuWorkbookRevision({
    workbook: CANONICAL_FEISHU_WORKBOOK,
    registry: CANONICAL_FEISHU_SHEET_REGISTRY,
    adapter: createFeishuWorkbookPullAdapter(),
    pulledAt: input.observedAt,
    pulledBy: input.observedBy,
  });
  const ranges = await readFeishuSheetRanges({
    spreadsheetToken: sourceRevision.spreadsheetToken,
    requests: canonicalRuleWorkbookRangeRequests(sourceRevision),
  });
  const parsed = await inspectCanonicalRuleWorkbookValues({
    observedAt: input.observedAt,
    sourceRevision,
    ranges,
  });
  return { ...parsed, sourceRevision };
}
