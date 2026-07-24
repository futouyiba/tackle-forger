import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canApplyConfirmedWorkspace,
  CHANGED_WORKSPACE_CONFIRMATION_MESSAGE,
  DIRTY_WORKSPACE_CONFIRMATION_MESSAGE,
  runCleanWorkspaceConfirmation,
} from "../lib/clean-workspace-confirmation";

test("未保存工作区不能提交 AI 草稿确认，也不会接收会覆盖本地状态的响应", async () => {
  let requestCount = 0;
  let replaceCount = 0;
  const result = await runCleanWorkspaceConfirmation({
    dirty: true,
    submit: async () => {
      requestCount += 1;
      return { state: "server-workspace" };
    },
  });

  if (result.disposition === "submitted") replaceCount += 1;
  assert.equal(result.disposition, "blocked");
  assert.equal(result.reason, DIRTY_WORKSPACE_CONFIRMATION_MESSAGE);
  assert.equal(requestCount, 0);
  assert.equal(replaceCount, 0);
});

test("保存后以新 revision 的干净工作区可以提交 AI 草稿确认", async () => {
  let requestCount = 0;
  const result = await runCleanWorkspaceConfirmation({
    dirty: false,
    submit: async () => {
      requestCount += 1;
      return { revision: 42 };
    },
  });

  assert.equal(result.disposition, "submitted");
  assert.deepEqual(result.value, { revision: 42 });
  assert.equal(requestCount, 1);
});

test("确认请求在途时出现本地修改，响应不能覆盖工作区", async () => {
  let dirty = false;
  const revision = 41;
  const localWorkspace = { patchIds: ["patch:unsaved"] };
  let displayedWorkspace = localWorkspace;
  let resolveResponse: ((value: { revision: number }) => void) | undefined;
  const response = new Promise<{ revision: number }>((resolve) => { resolveResponse = resolve; });
  const request = runCleanWorkspaceConfirmation({ dirty, submit: () => response });

  dirty = true;
  resolveResponse?.({ revision: 42 });
  const submitted = await request;
  assert.equal(submitted.disposition, "submitted");
  const applyCheck = canApplyConfirmedWorkspace({ dirty, revision, expectedRevision: 41 });
  assert.equal(applyCheck.allowed, false);
  if (!applyCheck.allowed) assert.equal(applyCheck.reason, CHANGED_WORKSPACE_CONFIRMATION_MESSAGE);
  if (applyCheck.allowed) displayedWorkspace = { patchIds: ["server-confirmed"] };
  assert.equal(displayedWorkspace, localWorkspace, "deferred server response must not replace local edits");
  assert.deepEqual(displayedWorkspace.patchIds, ["patch:unsaved"]);
  assert.equal(revision, 41, "local workspace revision must remain untouched");
});

test("Patch 台账把根工作台的权威 dirty 状态接入 AI 草稿确认按钮", async () => {
  const [ledgerSource, workbenchSource] = await Promise.all([
    readFile(new URL("../app/PatchLedgerWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/Workbench.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(ledgerSource, /dirty: boolean/);
  assert.match(ledgerSource, /runCleanWorkspaceConfirmation\(\{/);
  assert.match(ledgerSource, /canApplyConfirmedWorkspace\(\{\.\.\.getWorkspaceFreshness\(\),expectedRevision:revision\}\)/);
  assert.match(ledgerSource, /disabled=\{!canReviewAIRuleDraft\|\|!draft\.impactPreview\.coverage\.complete\|\|Boolean\(aiRuleDraftConfirmationBlockedReason\)\}/);
  assert.match(workbenchSource, /markWorkspaceDirty\(\)/);
  assert.match(workbenchSource, /getWorkspaceFreshness=\{\(\)=>workspaceFreshnessRef\.current\}/);
});

test("甘特图所有服务端工作区替换在提交前阻断脏工作区，并在响应后复验 revision", async () => {
  const [ganttSource, workbenchSource] = await Promise.all([
    readFile(new URL("../app/SeriesGanttWorkbenchV3.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/Workbench.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(ganttSource, /DIRTY_WORKSPACE_CONFIRMATION_MESSAGE/);
  assert.match(ganttSource, /beginWorkspaceReplacement/);
  assert.match(ganttSource, /applyWorkspaceReplacement/);
  assert.match(ganttSource, /canApplyConfirmedWorkspace/);
  assert.match(workbenchSource, /workspaceFreshness=\{\(\) => workspaceFreshnessRef\.current\}/);
});
