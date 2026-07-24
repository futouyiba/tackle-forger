import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TraceSettlementPanel } from "../app/TraceSettlementPanel";
import { createCalculationTraceArchive, createCalculationTraceEntry } from "../lib/calculation-trace";

test("冻结 Trace 的 ActionLink 呈现完整 targetRef，并为可导航目标提供只读入口", () => {
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
  assert.match(html, /目标：<code>model:model:target · revision 7<\/code>/);
  assert.match(html, /href="\/\?page=candidates&amp;model=model%3Atarget"/);
  assert.match(html, /查看目标（只读）/);
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
  assert.match(html, /目标：<code>rule_source_change_draft:rule-draft:one · revision 3<\/code>/);
  assert.doesNotMatch(html, /查看目标（只读）/);
});
