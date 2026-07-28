import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalSessionLoginPollScope,
} from "../lib/local-session-login-poll-scope";

test("login polling is single-flight and a stalled request reaches timeout", async () => {
  let concurrent = 0;
  let maximumConcurrent = 0;
  let abortCalls = 0;
  const timedOut: string[] = [];
  const scope = new LocalSessionLoginPollScope("login-stalled", {
    intervalMs: 0,
    timeoutMs: 10,
    poll: (signal) => new Promise<null>((_resolve, reject) => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      signal.addEventListener("abort", () => {
        abortCalls += 1;
        concurrent -= 1;
        reject(new Error("aborted"));
      }, { once: true });
    }),
    onAuthenticated: () => assert.fail("stalled login must not authenticate"),
    onTimeout: (operationId) => timedOut.push(operationId),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(timedOut, ["login-stalled"]);
  assert.equal(maximumConcurrent, 1);
  assert.equal(abortCalls, 1);
  assert.deepEqual(scope.snapshot(), {
    operationId: "login-stalled",
    terminal: true,
    aborted: true,
    inFlight: false,
    retryPending: false,
    deadlinePending: false,
  });
  assert.equal(scope.cancel(), false);
});

test("login success is terminal, aborts once and ignores replacement work", async () => {
  let polls = 0;
  let abortCalls = 0;
  const authenticated: string[] = [];
  const scope = new LocalSessionLoginPollScope("login-success", {
    intervalMs: 0,
    timeoutMs: 100,
    poll: async () => {
      polls += 1;
      return polls === 1 ? null : "principal";
    },
    onAuthenticated: (principal) => authenticated.push(principal),
    onTimeout: () => assert.fail("successful login must not time out"),
  });
  scope.signal.addEventListener("abort", () => {
    abortCalls += 1;
  }, { once: true });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(authenticated, ["principal"]);
  assert.equal(polls, 2);
  assert.equal(abortCalls, 1);
  assert.equal(scope.cancel(), false);
});

test("login cancellation aborts exactly once and ignores a late response", async () => {
  let resolvePoll: ((value: string | null) => void) | undefined;
  let abortCalls = 0;
  const authenticated: string[] = [];
  const scope = new LocalSessionLoginPollScope("login-cancel", {
    intervalMs: 0,
    timeoutMs: 100,
    poll: (signal) => new Promise<string | null>((resolve) => {
      resolvePoll = resolve;
      signal.addEventListener("abort", () => {
        abortCalls += 1;
      }, { once: true });
    }),
    onAuthenticated: (principal) => authenticated.push(principal),
    onTimeout: () => assert.fail("cancelled login must not time out"),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(scope.cancel("local_session_cleared"), true);
  assert.equal(scope.cancel("duplicate_cancel"), false);
  resolvePoll?.("late-principal");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(abortCalls, 1);
  assert.deepEqual(authenticated, []);
  assert.equal(scope.signal.reason, "local_session_cleared");
});

test("login polling rejects invalid identity and timing setup", () => {
  const callbacks = {
    poll: async () => null,
    onAuthenticated: () => undefined,
    onTimeout: () => undefined,
  };
  assert.throws(
    () => new LocalSessionLoginPollScope("", callbacks),
    /operationId/,
  );
  assert.throws(
    () => new LocalSessionLoginPollScope("bad-timeout", {
      ...callbacks,
      timeoutMs: 0,
    }),
    /positive safe integer/,
  );
  assert.throws(
    () => new LocalSessionLoginPollScope("bad-interval", {
      ...callbacks,
      intervalMs: -1,
    }),
    /non-negative safe integer/,
  );
});
