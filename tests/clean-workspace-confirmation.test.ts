import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
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

test("Patch 台账把根工作台的权威 dirty 状态接入 AI 草稿确认按钮", async () => {
  const [ledgerSource, workbenchSource] = await Promise.all([
    readFile(new URL("../app/PatchLedgerWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/Workbench.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(ledgerSource, /dirty: boolean/);
  assert.match(ledgerSource, /runCleanWorkspaceConfirmation\(\{/);
  assert.match(ledgerSource, /disabled=\{!canReviewAIRuleDraft\|\|!draft\.impactPreview\.coverage\.complete\|\|Boolean\(aiRuleDraftConfirmationBlockedReason\)\}/);
  assert.match(workbenchSource, /<PatchLedgerWorkbench state=\{state\} revision=\{revision\} dirty=\{dirty\}/);
});
