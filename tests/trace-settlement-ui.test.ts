import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TraceSettlementPanel, formatTraceValue } from "../app/TraceSettlementPanel";
import { createCalculationTraceArchive, createCalculationTraceEntry } from "../lib/calculation-trace";

test("冻结 Trace 的可用 ActionLink 呈现完整 targetRef，但不生成丢失精确版本语义的深链接", () => {
  const targetRef = {
    workspaceId: "workspace:one",
    entityType: "model" as const,
    entityId: "model:target",
    revisionId: "7",
  };
  const archive = createCalculationTraceArchive([createCalculationTraceEntry({
    traceEntryId: "trace:one",
    subjectRef: targetRef,
    parameterKey: "pull",
    sequence: 1,
    layer: "method",
    sourceRef: { sourceType: "Method", sourceId: "method:one" },
    sourceVersion: "source:1",
    ruleSetVersion: "rules:1",
    before: 8,
    operation: "add",
    operand: 1,
    after: 9,
    effect: "benefit",
    warningIssueIds: [],
    actions: [{
      actionId: "action:view-target",
      action: "view_snapshot",
      label: "查看冻结对象",
      enabled: true,
      targetRef,
    }],
  })]);

  const html = renderToStaticMarkup(createElement(TraceSettlementPanel, {
    archive,
    businessRevision: "snapshot:one",
    passiveAffixCount: 0,
  }));

  assert.match(html, /查看冻结对象/);
  assert.match(html, /动作：view_snapshot · 可用/);
  assert.match(html, /目标：<code>workspaceId=workspace:one · entityType=model · entityId=model:target · revisionId=7<\/code>/);
  assert.match(html, /精确版本只读路由尚不可用/);
  assert.doesNotMatch(html, /href=|<a\b|查看目标（只读）/);
  assert.doesNotMatch(html, /commandPayloadRef|执行命令/);
});

test("不可用的 ActionLink 仍暴露完整 targetRef，但不制造可执行或可导航入口", () => {
  const targetRef = {
    workspaceId: "workspace:one",
    entityType: "rule_source_change_draft" as const,
    entityId: "rule-draft:one",
    revisionId: "3",
  };
  const archive = createCalculationTraceArchive([createCalculationTraceEntry({
    traceEntryId: "trace:disabled",
    subjectRef: { ...targetRef, entityType: "model", entityId: "model:one" },
    parameterKey: "pull",
    sequence: 1,
    layer: "method",
    sourceRef: { sourceType: "Method", sourceId: "method:one" },
    sourceVersion: "source:1",
    ruleSetVersion: "rules:1",
    before: 8,
    operation: "no_effect",
    operand: null,
    after: 8,
    effect: "neutral",
    warningIssueIds: [],
    actions: [{
      actionId: "action:disabled-target",
      action: "review_source",
      label: "查看规则来源",
      enabled: false,
      targetRef,
    }],
  })]);

  const html = renderToStaticMarkup(createElement(TraceSettlementPanel, {
    archive,
    businessRevision: "snapshot:one",
    passiveAffixCount: 0,
  }));

  assert.match(html, /动作：review_source · 不可用/);
  assert.match(html, /目标：<code>workspaceId=workspace:one · entityType=rule_source_change_draft · entityId=rule-draft:one · revisionId=3<\/code>/);
  assert.doesNotMatch(html, /查看目标（只读）/);
  assert.doesNotMatch(html, /href=|<a\b|精确版本只读路由尚不可用/);
});

test("冻结证据逐项呈现完整身份、哈希与原始 evidence，且空值不与 undefined 混同", () => {
  const subjectRef = { workspaceId: "workspace:full", entityType: "model" as const, entityId: "model:full", revisionId: "revision:full" };
  const archive = createCalculationTraceArchive([createCalculationTraceEntry({
    traceEntryId: "trace:full", subjectRef, parameterKey: "pull", sequence: 1,
    layer: "boundary", sourceRef: { sourceType: "pricing_cell", sourceId: "sheet:A1" }, sourceVersion: "source:full", ruleSetVersion: "rules:full",
    before: null, operation: "set", operand: 8, after: 8, effect: "contextual", warningIssueIds: [], actions: [],
    evidence: { adapter: "pricing_trace/v2", operation: "round", nested: { preserved: true } },
  })]);
  const html = renderToStaticMarkup(createElement(TraceSettlementPanel, { archive, businessRevision: "snapshot:full", passiveAffixCount: 0 }));
  for (const expected of ["traceEntryId", "trace:full", "inputHash", "outputHash", "workspaceId=workspace:full", "entityId=model:full", "revisionId=revision:full", "原始 evidence", "pricing_trace/v2", "operation", "round", "before null"]) assert.match(html, new RegExp(expected));
  assert.equal(formatTraceValue(null), "null");
  assert.equal(formatTraceValue(undefined), "undefined");
  assert.notEqual(formatTraceValue(null), formatTraceValue(undefined));
});

test("source flight and impact flash are phase-gated DOM/CSS effects driven by shared tokens", () => {
  const panelSource = readFileSync(fileURLToPath(new URL("../app/TraceSettlementPanel.tsx", import.meta.url)), "utf8");
  const css = readFileSync(fileURLToPath(new URL("../app/series-gantt-v3.css", import.meta.url)), "utf8");
  assert.match(panelSource, /data-motion-phase=\{state\.phase\}/);
  assert.match(panelSource, /trace-source-card .*is-flying/);
  assert.match(panelSource, /motionTokens\.duration\.sourceFlyMs/);
  assert.match(panelSource, /playbackPhaseDuration\(activeStep, state\.stepIndex, "impact"\)/);
  assert.match(css, /\.trace-source-card\.is-flying/);
  assert.match(css, /trace-source-flight var\(--trace-source-fly-ms\)/);
  assert.match(css, /\.trace-settlement\.phase-impact \.trace-main-number em/);
  assert.match(css, /trace-impact-flash var\(--trace-impact-ms\)/);
  assert.doesNotMatch(css, /460ms|100ms|300ms/);
});

test("evidence settle is a phase-gated CSS animation that consumes the shared evidence-settle token", () => {
  // 规范 §6.3 "证据落位 140–180ms": the panel exposes --trace-evidence-settle-ms
  // and the CSS must actually consume it via a phase-gated animation on the
  // evidence panel — not just leave an unused CSS variable. This is the
  // regression that fails when the token is declared but no animation uses it.
  const panelSource = readFileSync(fileURLToPath(new URL("../app/TraceSettlementPanel.tsx", import.meta.url)), "utf8");
  const css = readFileSync(fileURLToPath(new URL("../app/series-gantt-v3.css", import.meta.url)), "utf8");
  // Panel wires the shared token into the inline style so CSS can consume it.
  assert.match(panelSource, /--trace-evidence-settle-ms/);
  assert.match(panelSource, /motionTokens\.duration\.evidenceSettleMs/);
  // CSS consumes the token on a phase-gated evidence panel rule.
  assert.match(css, /\.trace-settlement\.phase-impact \.trace-evidence-panel/);
  assert.match(css, /trace-evidence-settle var\(--trace-evidence-settle-ms\)/);
  assert.match(css, /@keyframes trace-evidence-settle/);
  // Paused and reduced-motion states must also cover the evidence animation.
  assert.match(css, /\.trace-settlement\.is-paused\.phase-impact \.trace-evidence-panel/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
