import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clearMatchingAssessment,
  SeriesAssessmentPanel,
  type AIAssessmentUiState,
} from "../app/SeriesAssessmentPanel";
import type { SeriesDefinition } from "../lib/types";

test("AI 结果区删除入口明确提示永久产物来源并要求显式确认", async () => {
  const source = await readFile(
    new URL("../app/SeriesGanttWorkbenchV3.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /删除这次 AI 评估/);
  assert.match(source, /已采纳产物的来源记录会永久保留，不会随这次评估删除/);
  assert.match(source, /type="checkbox"/);
  assert.match(
    source,
    /disabled=\{!deletePermanentlyRetainedAcknowledged \|\| deleteRunning\}/,
  );
  assert.match(source, /\{ method: "DELETE" \}/);
});

test("删除成功后只清除当前本地评估并给出保留来源提示", async () => {
  const source = await readFile(
    new URL("../app/SeriesGanttWorkbenchV3.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /onAssessmentDeleted\(assessmentId\)/);
  assert.match(
    source,
    /currentAssessment\?\.assessmentId === assessmentId \? undefined : currentAssessment/,
  );
  assert.match(source, /已采纳产物的来源记录仍会永久保留/);
});

test("查看依据会展示本地稳定引用、revision 与完整内容 hash", async () => {
  const source = await readFile(
    new URL("../app/SeriesGanttWorkbenchV3.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /可追溯依据/);
  assert.match(source, /resolvedEvidenceRefs/);
  assert.match(source, /evidence\.refId/);
  assert.match(source, /evidence\.revisionId/);
  assert.match(source, /evidence\.contentHash/);
});

test("Series 成功评估实际渲染只读结果、EvidenceRef 与删除入口", () => {
  const assessment: AIAssessmentUiState = {
    scopeKey: "series:series-alpha",
    status: "success",
    assessmentId: "assessment-series-alpha",
    outputHash: "a".repeat(64),
    freshness: {
      state: "fresh",
      canCreateDraft: false,
      staleReasonCodes: [],
    },
    result: {
      findings: [{
        findingCode: "SERIES_CURVE_WARNING",
        summary: "重量曲线需要复核。",
        evidenceAliases: ["series-invariant"],
      }],
      recommendations: [{
        recommendationCode: "REVIEW_SERIES_CURVE",
        title: "复核重量曲线",
        summary: "对照确定性不变量检查各离散 SKU。",
        suggestedAction: "preview_only",
        evidenceAliases: ["series-invariant"],
      }],
      assumptions: ["仅使用当前 revision。"],
      uncoveredInformation: [],
      resolvedEvidenceRefs: [{
        evidenceType: "series_invariant",
        evidenceAlias: "series-invariant",
        refId: "series-alpha:series-invariant",
        revisionId: "7",
        contentHash: "b".repeat(64),
      }],
    },
  };
  const markup = renderToStaticMarkup(createElement(SeriesAssessmentPanel, {
    series: {
      id: "series-alpha",
      name: "青芦·远投",
      revision: 7,
    } as SeriesDefinition,
    aiAvailability: {
      action: "run_ai_assessment",
      enabled: true,
      requiredCapabilities: ["ai.evaluate"],
    },
    aiAssessment: assessment,
    onRunAssessment: () => undefined,
    onAssessmentDeleted: () => undefined,
    notify: () => undefined,
  }));

  assert.match(markup, /Series 评估结果只读/);
  assert.match(markup, /Series 作用域不支持转换为 Model Patch 草稿/);
  assert.match(markup, /重量曲线需要复核/);
  assert.match(markup, /series-alpha:series-invariant/);
  assert.match(markup, /hash b{64}/);
  assert.match(markup, /删除这次 Series AI 评估/);
});

test("Series 删除后的本地清理同时匹配 scope 与 assessmentId", () => {
  const current: AIAssessmentUiState = {
    scopeKey: "series:series-alpha",
    status: "success",
    assessmentId: "assessment-series-alpha",
  };

  assert.equal(
    clearMatchingAssessment(current, "series:series-alpha", "assessment-series-alpha"),
    undefined,
  );
  assert.equal(
    clearMatchingAssessment(current, "series:series-beta", "assessment-series-alpha"),
    current,
  );
  assert.equal(
    clearMatchingAssessment(current, "series:series-alpha", "assessment-other"),
    current,
  );
});
