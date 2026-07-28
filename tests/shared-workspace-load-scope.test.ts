import assert from "node:assert/strict";
import test from "node:test";

import { SharedWorkspaceLoadScope } from "../lib/shared-workspace-load-scope";

test("shared load completion clears timeout without aborting", () => {
  let timeoutCalls = 0;
  const scope = new SharedWorkspaceLoadScope("shared-complete", 1_000, () => {
    timeoutCalls += 1;
  });
  assert.equal(scope.complete(), true);
  assert.equal(scope.complete(), false);
  assert.deepEqual(scope.snapshot(), {
    operationId: "shared-complete",
    terminal: true,
    aborted: false,
    timeoutPending: false,
  });
  assert.equal(timeoutCalls, 0);
});

test("shared load cancellation aborts exactly once and rejects late completion", () => {
  const scope = new SharedWorkspaceLoadScope("shared-cancel", 1_000, () => {
    assert.fail("cancelled scope must not later time out");
  });
  let abortCalls = 0;
  scope.signal.addEventListener("abort", () => {
    abortCalls += 1;
  });
  assert.equal(scope.cancel(), true);
  assert.equal(scope.cancel(), false);
  assert.equal(scope.complete(), false);
  assert.equal(scope.signal.reason, "shared_load_cancelled");
  assert.equal(abortCalls, 1);
});

test("shared load timeout aborts and becomes the sole terminal disposition", async () => {
  const timedOut: string[] = [];
  const scope = new SharedWorkspaceLoadScope("shared-timeout", 5, (operationId) => {
    timedOut.push(operationId);
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(timedOut, ["shared-timeout"]);
  assert.equal(scope.signal.aborted, true);
  assert.equal(scope.signal.reason, "shared_load_timeout");
  assert.equal(scope.cancel(), false);
  assert.equal(scope.complete(), false);
});

test("shared load scope rejects invalid or reusable operation setup", () => {
  assert.throws(
    () => new SharedWorkspaceLoadScope("", 1, () => undefined),
    /operationId/,
  );
  assert.throws(
    () => new SharedWorkspaceLoadScope("shared-invalid-timeout", 0, () => undefined),
    /positive safe integer/,
  );
});
