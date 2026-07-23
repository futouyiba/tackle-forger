import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
