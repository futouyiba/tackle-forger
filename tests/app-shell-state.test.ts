import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_SESSION_APP_SHELL_DEFAULT_ENABLED,
  assertAppShellState,
  createInitialAppShellState,
  transitionAppShell,
  type AppShellEvent,
  type AppShellState,
  type SharedLoadFailureKind,
  type SharedWorkspaceResource,
} from "../lib/app-shell-state";
import { createLocalSessionModel } from "../lib/local-session-contracts";

const PRINCIPAL = { openId: "ou_test", displayName: "Test User" };
const LOCAL_SESSION = createLocalSessionModel(
  { kind: "temporary_workspace" },
  { title: "local", notes: "same-tab only" },
);
const OTHER_LOCAL_SESSION = createLocalSessionModel(
  { kind: "temporary_workspace" },
  { title: "replacement", notes: "" },
);
const SHARED: SharedWorkspaceResource = {
  workspaceId: "workspace-a",
  revision: 7,
  resourceId: "shared-resource-a",
};

function apply(state: AppShellState, event: AppShellEvent): AppShellState {
  const result = transitionAppShell(state, event);
  assert.equal(result.accepted, true, result.rejectionReason);
  assertAppShellState(result.state);
  return result.state;
}

function anonymousState(): AppShellState {
  return apply(createInitialAppShellState("auth-bootstrap"), {
    type: "auth_session_anonymous",
    operationId: "auth-bootstrap",
  });
}

function authenticatedState(): AppShellState {
  return apply(createInitialAppShellState("auth-bootstrap"), {
    type: "auth_session_authenticated",
    operationId: "auth-bootstrap",
    principal: PRINCIPAL,
  });
}

function withReadyLocal(
  base: AppShellState = anonymousState(),
  input: {
    operationId?: string;
    readyId?: string;
    session?: typeof LOCAL_SESSION;
  } = {},
): AppShellState {
  const operationId = input.operationId ?? "local-1";
  let state = apply(base, {
    type: "local_selection_requested",
    operationId,
  });
  state = apply(state, {
    type: "local_parse_started",
    operationId,
    selectionRef: `selection:${operationId}`,
  });
  return apply(state, {
    type: "local_parse_succeeded",
    operationId,
    readyId: input.readyId ?? `ready:${operationId}`,
    session: input.session ?? LOCAL_SESSION,
  });
}

function withShared(
  base: AppShellState = authenticatedState(),
  resource: SharedWorkspaceResource = SHARED,
): AppShellState {
  const state = apply(base, {
    type: "shared_open_requested",
    operationId: "shared-load",
    workspaceId: resource.workspaceId,
  });
  return apply(state, {
    type: "shared_load_succeeded",
    operationId: "shared-load",
    resource,
  });
}

test("P2 app-shell contract remains disabled until P3 integration", () => {
  assert.equal(LOCAL_SESSION_APP_SHELL_DEFAULT_ENABLED, false);
});

test("auth bootstrap exposes loading, anonymous, authenticated and failed states", () => {
  const cases: Array<{
    event: AppShellEvent;
    expected: AppShellState["auth"]["status"];
  }> = [
    {
      event: {
        type: "auth_session_anonymous",
        operationId: "bootstrap",
      },
      expected: "anonymous",
    },
    {
      event: {
        type: "auth_session_authenticated",
        operationId: "bootstrap",
        principal: PRINCIPAL,
      },
      expected: "authenticated",
    },
    {
      event: {
        type: "auth_session_failed",
        operationId: "bootstrap",
        code: "AUTH_SERVICE_UNAVAILABLE",
      },
      expected: "failed",
    },
  ];

  for (const entry of cases) {
    const initial = createInitialAppShellState("bootstrap");
    assert.equal(initial.auth.status, "loading");
    const result = transitionAppShell(initial, entry.event);
    assert.equal(result.accepted, true);
    assert.equal(result.state.auth.status, entry.expected);
    assert.deepEqual(result.state.source, initial.source);
    assert.deepEqual(result.state.authority, initial.authority);
  }
});

test("popup/new-tab login retains opener local state and success changes only auth", () => {
  const local = withReadyLocal();
  const requested = transitionAppShell(local, {
    type: "login_requested",
    operationId: "oauth-1",
  });
  assert.equal(requested.accepted, true);
  assert.deepEqual(requested.effects, [{
    type: "open_auth_window",
    operationId: "oauth-1",
    mode: "popup_or_new_tab",
    retainOpenerLocalSession: true,
  }]);
  assert.equal(requested.state.auth.status, "loading");
  assert.equal(requested.state.source, local.source);
  assert.equal(requested.state.authority, local.authority);

  const succeeded = transitionAppShell(requested.state, {
    type: "login_succeeded",
    operationId: "oauth-1",
    principal: PRINCIPAL,
  });
  assert.equal(succeeded.accepted, true);
  assert.deepEqual(succeeded.state.auth, {
    status: "authenticated",
    principal: PRINCIPAL,
  });
  assert.equal(succeeded.state.source, local.source);
  assert.equal(succeeded.state.authority, local.authority);
  assert.deepEqual(succeeded.effects, []);
});

test("OAuth cancellation is distinct, local-safe, and stale callback responses are no-ops", () => {
  const local = withReadyLocal();
  const requested = apply(local, {
    type: "login_requested",
    operationId: "oauth-cancel",
  });
  const cancelled = transitionAppShell(requested, {
    type: "oauth_cancelled",
    operationId: "oauth-cancel",
  });
  assert.equal(cancelled.accepted, true);
  assert.deepEqual(cancelled.state.auth, {
    status: "anonymous",
    reason: "oauth_cancelled",
  });
  assert.equal(cancelled.state.source, local.source);
  assert.equal(cancelled.state.authority, local.authority);

  const late = transitionAppShell(cancelled.state, {
    type: "login_succeeded",
    operationId: "oauth-cancel",
    principal: PRINCIPAL,
  });
  assert.equal(late.accepted, false);
  assert.equal(late.rejectionReason, "stale_auth_response");
  assert.equal(late.state, cancelled.state);
});

test("local source follows empty, selecting, parsing, ready and failed states", () => {
  let state = anonymousState();
  assert.equal(state.source.status, "empty");

  state = apply(state, {
    type: "local_selection_requested",
    operationId: "local-table",
  });
  assert.equal(state.source.status, "selecting");
  assert.equal(state.authority.status, "none");

  state = apply(state, {
    type: "local_parse_started",
    operationId: "local-table",
    selectionRef: "opaque-selection",
  });
  assert.equal(state.source.status, "parsing");
  assert.equal(state.authority.status, "none");

  state = apply(state, {
    type: "local_parse_failed",
    operationId: "local-table",
  });
  assert.deepEqual(state.source, {
    status: "failed",
    operationId: "local-table",
    code: "parse_failed",
  });
  assert.equal(state.authority.status, "none");

  state = apply(state, {
    type: "local_operation_cancelled",
    operationId: "local-table",
  });
  assert.deepEqual(state.source, { status: "empty" });

  state = withReadyLocal(state, { operationId: "local-ready" });
  assert.equal(state.source.status, "ready");
  assert.equal(state.authority.status, "local_session");
});

test("replacement parsing preserves previous ready state until atomic success", () => {
  const original = withReadyLocal(anonymousState(), {
    operationId: "original",
    readyId: "ready-original",
  });
  const selecting = transitionAppShell(original, {
    type: "local_selection_requested",
    operationId: "replacement",
  });
  assert.equal(selecting.accepted, true);
  assert.equal(selecting.state.source.status, "selecting");
  assert.equal(selecting.state.authority.status, "local_session");
  assert.deepEqual(selecting.effects, []);

  const parsing = apply(selecting.state, {
    type: "local_parse_started",
    operationId: "replacement",
    selectionRef: "replacement-selection",
  });
  assert.equal(parsing.source.status, "parsing");
  assert.equal(parsing.authority.status, "local_session");

  const failed = transitionAppShell(parsing, {
    type: "local_parse_failed",
    operationId: "replacement",
  });
  assert.equal(failed.accepted, true);
  assert.equal(failed.state.source.status, "failed");
  assert.equal(failed.state.authority.status, "local_session");
  if (failed.state.source.status !== "failed") throw new Error("expected failed");
  assert.equal(failed.state.source.previousReady?.readyId, "ready-original");
  assert.deepEqual(failed.effects, []);

  const retry = apply(failed.state, {
    type: "local_selection_requested",
    operationId: "replacement-2",
  });
  const retryParsing = apply(retry, {
    type: "local_parse_started",
    operationId: "replacement-2",
    selectionRef: "replacement-selection-2",
  });
  const succeeded = transitionAppShell(retryParsing, {
    type: "local_parse_succeeded",
    operationId: "replacement-2",
    readyId: "ready-replacement",
    session: OTHER_LOCAL_SESSION,
  });
  assert.equal(succeeded.accepted, true);
  assert.equal(succeeded.state.source.status, "ready");
  assert.equal(succeeded.state.authority.status, "local_session");
  assert.deepEqual(succeeded.effects, [{
    type: "dispose_local_ready",
    readyId: "ready-original",
  }]);
});

test("replace while parsing cancels only the superseded parser and retains previous ready", () => {
  const original = withReadyLocal(anonymousState(), {
    operationId: "original",
    readyId: "ready-original",
  });
  let state = apply(original, {
    type: "local_selection_requested",
    operationId: "replace-a",
  });
  state = apply(state, {
    type: "local_parse_started",
    operationId: "replace-a",
    selectionRef: "selection-a",
  });

  const replaced = transitionAppShell(state, {
    type: "local_selection_requested",
    operationId: "replace-b",
  });
  assert.equal(replaced.accepted, true);
  assert.deepEqual(replaced.effects, [{
    type: "cancel_local_operation",
    operationId: "replace-a",
  }]);
  assert.equal(replaced.state.source.status, "selecting");
  if (replaced.state.source.status !== "selecting") throw new Error("expected selecting");
  assert.equal(replaced.state.source.previousReady?.readyId, "ready-original");
  assert.equal(replaced.state.authority.status, "local_session");

  const late = transitionAppShell(replaced.state, {
    type: "local_parse_succeeded",
    operationId: "replace-a",
    readyId: "late-ready-a",
    session: OTHER_LOCAL_SESSION,
  });
  assert.equal(late.accepted, false);
  assert.equal(late.state, replaced.state);
  assert.deepEqual(late.effects, [{
    type: "dispose_local_ready",
    readyId: "late-ready-a",
  }]);
});

test("cancel and clear during parsing have different non-destructive semantics", () => {
  const original = withReadyLocal(anonymousState(), {
    operationId: "original",
    readyId: "ready-original",
  });
  let parsing = apply(original, {
    type: "local_selection_requested",
    operationId: "replacement",
  });
  parsing = apply(parsing, {
    type: "local_parse_started",
    operationId: "replacement",
    selectionRef: "selection",
  });

  const cancelled = transitionAppShell(parsing, {
    type: "local_operation_cancelled",
    operationId: "replacement",
  });
  assert.equal(cancelled.accepted, true);
  assert.equal(cancelled.state.source.status, "ready");
  assert.equal(cancelled.state.authority.status, "local_session");
  assert.deepEqual(cancelled.effects, [{
    type: "cancel_local_operation",
    operationId: "replacement",
  }]);

  const cleared = transitionAppShell(parsing, {
    type: "local_source_clear_requested",
  });
  assert.equal(cleared.accepted, true);
  assert.deepEqual(cleared.state.source, { status: "empty" });
  assert.deepEqual(cleared.state.authority, { status: "none" });
  assert.deepEqual(cleared.effects, [
    { type: "cancel_local_operation", operationId: "replacement" },
    { type: "dispose_local_ready", readyId: "ready-original" },
  ]);
});

test("login during parsing changes auth only and never exposes mixed authority", () => {
  let state = withReadyLocal();
  state = apply(state, {
    type: "local_selection_requested",
    operationId: "replacement",
  });
  state = apply(state, {
    type: "local_parse_started",
    operationId: "replacement",
    selectionRef: "selection",
  });
  const source = state.source;
  const authority = state.authority;

  state = apply(state, {
    type: "login_requested",
    operationId: "login-during-parse",
  });
  assert.equal(state.source, source);
  assert.equal(state.authority, authority);
  state = apply(state, {
    type: "login_succeeded",
    operationId: "login-during-parse",
    principal: PRINCIPAL,
  });
  assert.equal(state.auth.status, "authenticated");
  assert.equal(state.source, source);
  assert.equal(state.authority, authority);
});

test("invalid parser output fails closed and preserves the previous ready session", () => {
  const original = withReadyLocal(anonymousState(), {
    operationId: "original",
    readyId: "ready-original",
  });
  let state = apply(original, {
    type: "local_selection_requested",
    operationId: "invalid",
  });
  state = apply(state, {
    type: "local_parse_started",
    operationId: "invalid",
    selectionRef: "invalid-selection",
  });
  const result = transitionAppShell(state, {
    type: "local_parse_succeeded",
    operationId: "invalid",
    readyId: "invalid-ready",
    session: { ...OTHER_LOCAL_SESSION, workspaceId: "forbidden" } as never,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.state.source.status, "failed");
  if (result.state.source.status !== "failed") throw new Error("expected failed");
  assert.equal(result.state.source.code, "invalid_local_session");
  assert.equal(result.state.source.previousReady?.readyId, "ready-original");
  assert.equal(result.state.authority.status, "local_session");
  assert.deepEqual(result.effects, [{
    type: "dispose_local_ready",
    readyId: "invalid-ready",
  }]);
});

test("shared opening is authenticated, explicit, load-first, switch-second, dispose-last", () => {
  const local = withReadyLocal(authenticatedState(), {
    readyId: "local-before-shared",
  });
  const requested = transitionAppShell(local, {
    type: "shared_open_requested",
    operationId: "shared-1",
    workspaceId: SHARED.workspaceId,
  });
  assert.equal(requested.accepted, true);
  assert.deepEqual(requested.state.authority, {
    status: "shared_loading",
    operationId: "shared-1",
    workspaceId: SHARED.workspaceId,
    previous: { status: "local_session" },
  });
  assert.equal(requested.state.source, local.source);
  assert.deepEqual(requested.effects, []);

  const succeeded = transitionAppShell(requested.state, {
    type: "shared_load_succeeded",
    operationId: "shared-1",
    resource: SHARED,
  });
  assert.equal(succeeded.accepted, true);
  assert.deepEqual(succeeded.state.authority, {
    status: "shared_workspace",
    resource: SHARED,
  });
  assert.deepEqual(succeeded.state.source, { status: "empty" });
  assert.deepEqual(succeeded.effects, [
    { type: "activate_shared_workspace", resource: SHARED },
    { type: "dispose_local_ready", readyId: "local-before-shared" },
  ]);
});

test("anonymous shared open and shared open during parsing fail closed", () => {
  const anonymous = withReadyLocal();
  const unauthorized = transitionAppShell(anonymous, {
    type: "shared_open_requested",
    operationId: "shared-anon",
    workspaceId: SHARED.workspaceId,
  });
  assert.equal(unauthorized.accepted, false);
  assert.equal(unauthorized.rejectionReason, "authentication_required");
  assert.equal(unauthorized.state, anonymous);

  let parsing = withReadyLocal(authenticatedState());
  parsing = apply(parsing, {
    type: "local_selection_requested",
    operationId: "replace",
  });
  parsing = apply(parsing, {
    type: "local_parse_started",
    operationId: "replace",
    selectionRef: "selection",
  });
  const conflicted = transitionAppShell(parsing, {
    type: "shared_open_requested",
    operationId: "shared-during-parse",
    workspaceId: SHARED.workspaceId,
  });
  assert.equal(conflicted.accepted, false);
  assert.equal(conflicted.rejectionReason, "local_transition_in_progress");
  assert.equal(conflicted.state, parsing);
});

test("401, 403, 409 and 5xx shared failures are distinct and retain local memory", () => {
  const cases: Array<{
    kind: Exclude<SharedLoadFailureKind, "cancelled">;
    expectedAuth: AppShellState["auth"]["status"];
  }> = [
    { kind: "unauthorized_401", expectedAuth: "anonymous" },
    { kind: "forbidden_403", expectedAuth: "authenticated" },
    { kind: "conflict_409", expectedAuth: "authenticated" },
    { kind: "server_5xx", expectedAuth: "authenticated" },
  ];

  for (const entry of cases) {
    const local = withReadyLocal(authenticatedState(), {
      readyId: `ready-${entry.kind}`,
    });
    const loading = apply(local, {
      type: "shared_open_requested",
      operationId: `load-${entry.kind}`,
      workspaceId: SHARED.workspaceId,
    });
    const result = transitionAppShell(loading, {
      type: "shared_load_failed",
      operationId: `load-${entry.kind}`,
      kind: entry.kind,
    });
    assert.equal(result.accepted, true);
    assert.equal(result.state.auth.status, entry.expectedAuth);
    assert.equal(result.state.source, local.source);
    assert.deepEqual(result.state.authority, { status: "local_session" });
    assert.deepEqual(result.state.lastSharedFailure, {
      operationId: `load-${entry.kind}`,
      workspaceId: SHARED.workspaceId,
      kind: entry.kind,
    });
    assert.deepEqual(result.effects, []);
  }
});

test("shared cancellation restores local state without disposing it", () => {
  const local = withReadyLocal(authenticatedState(), {
    readyId: "ready-before-cancel",
  });
  const loading = apply(local, {
    type: "shared_open_requested",
    operationId: "shared-cancel",
    workspaceId: SHARED.workspaceId,
  });
  const cancelled = transitionAppShell(loading, {
    type: "shared_load_cancelled",
    operationId: "shared-cancel",
  });
  assert.equal(cancelled.accepted, true);
  assert.equal(cancelled.state.source, local.source);
  assert.deepEqual(cancelled.state.authority, { status: "local_session" });
  assert.equal(cancelled.state.lastSharedFailure?.kind, "cancelled");
  assert.deepEqual(cancelled.effects, []);
});

test("late shared success is disposed and cannot switch authority", () => {
  const local = withReadyLocal(authenticatedState());
  const loading = apply(local, {
    type: "shared_open_requested",
    operationId: "shared-old",
    workspaceId: SHARED.workspaceId,
  });
  const cancelled = apply(loading, {
    type: "shared_load_cancelled",
    operationId: "shared-old",
  });
  const lateResource = {
    ...SHARED,
    resourceId: "late-shared-resource",
  };
  const late = transitionAppShell(cancelled, {
    type: "shared_load_succeeded",
    operationId: "shared-old",
    resource: lateResource,
  });
  assert.equal(late.accepted, false);
  assert.equal(late.rejectionReason, "stale_shared_response");
  assert.equal(late.state, cancelled);
  assert.deepEqual(late.effects, [{
    type: "dispose_shared_workspace",
    resourceId: "late-shared-resource",
  }]);
});

test("workspace mismatch disposes the loaded target and retains prior authority", () => {
  const local = withReadyLocal(authenticatedState());
  const loading = apply(local, {
    type: "shared_open_requested",
    operationId: "shared-mismatch",
    workspaceId: "workspace-expected",
  });
  const mismatch = transitionAppShell(loading, {
    type: "shared_load_succeeded",
    operationId: "shared-mismatch",
    resource: {
      workspaceId: "workspace-wrong",
      revision: 1,
      resourceId: "wrong-resource",
    },
  });
  assert.equal(mismatch.accepted, false);
  assert.equal(mismatch.rejectionReason, "shared_workspace_mismatch");
  assert.equal(mismatch.state, loading);
  assert.deepEqual(mismatch.effects, [{
    type: "dispose_shared_workspace",
    resourceId: "wrong-resource",
  }]);
});

test("logout and revocation clear shared memory immediately without stale restoration", () => {
  for (const event of [
    { type: "logout_requested" as const },
    { type: "session_revoked" as const },
  ]) {
    const shared = withShared();
    const result = transitionAppShell(shared, event);
    assert.equal(result.accepted, true);
    assert.equal(result.state.auth.status, "anonymous");
    assert.deepEqual(result.state.authority, { status: "none" });
    assert.deepEqual(result.state.source, { status: "empty" });
    assert.deepEqual(result.effects, [{
      type: "dispose_shared_workspace",
      resourceId: SHARED.resourceId,
    }]);
  }
});

test("logout during shared loading cancels target but preserves an existing local session", () => {
  const local = withReadyLocal(authenticatedState(), {
    readyId: "ready-during-logout",
  });
  const loading = apply(local, {
    type: "shared_open_requested",
    operationId: "shared-in-flight",
    workspaceId: SHARED.workspaceId,
  });
  const result = transitionAppShell(loading, {
    type: "logout_requested",
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.state.auth, {
    status: "anonymous",
    reason: "logout",
  });
  assert.deepEqual(result.state.authority, { status: "local_session" });
  assert.equal(result.state.source, local.source);
  assert.deepEqual(result.effects, [{
    type: "cancel_shared_load",
    operationId: "shared-in-flight",
  }]);
});

test("401 while replacing one shared workspace clears the previous shared resource", () => {
  const current = withShared();
  const loading = apply(current, {
    type: "shared_open_requested",
    operationId: "shared-replace",
    workspaceId: "workspace-b",
  });
  const unauthorized = transitionAppShell(loading, {
    type: "shared_load_failed",
    operationId: "shared-replace",
    kind: "unauthorized_401",
  });
  assert.equal(unauthorized.accepted, true);
  assert.equal(unauthorized.state.auth.status, "anonymous");
  assert.deepEqual(unauthorized.state.authority, { status: "none" });
  assert.deepEqual(unauthorized.effects, [{
    type: "dispose_shared_workspace",
    resourceId: SHARED.resourceId,
  }]);
});

test("shared-to-shared success activates the new resource before disposing the old", () => {
  const current = withShared();
  const replacement: SharedWorkspaceResource = {
    workspaceId: "workspace-b",
    revision: 2,
    resourceId: "shared-resource-b",
  };
  const loading = apply(current, {
    type: "shared_open_requested",
    operationId: "shared-replace",
    workspaceId: replacement.workspaceId,
  });
  const result = transitionAppShell(loading, {
    type: "shared_load_succeeded",
    operationId: "shared-replace",
    resource: replacement,
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.state.authority, {
    status: "shared_workspace",
    resource: replacement,
  });
  assert.deepEqual(result.effects, [
    { type: "activate_shared_workspace", resource: replacement },
    {
      type: "dispose_shared_workspace",
      resourceId: SHARED.resourceId,
    },
  ]);
});

test("clear during a transactional shared load cancels the load and destroys local memory", () => {
  const local = withReadyLocal(authenticatedState(), {
    readyId: "ready-to-clear",
  });
  const loading = apply(local, {
    type: "shared_open_requested",
    operationId: "shared-clear",
    workspaceId: SHARED.workspaceId,
  });
  const cleared = transitionAppShell(loading, {
    type: "local_source_clear_requested",
  });
  assert.equal(cleared.accepted, true);
  assert.deepEqual(cleared.state.source, { status: "empty" });
  assert.deepEqual(cleared.state.authority, { status: "none" });
  assert.equal(cleared.state.lastSharedFailure?.kind, "cancelled");
  assert.deepEqual(cleared.effects, [
    { type: "cancel_shared_load", operationId: "shared-clear" },
    { type: "dispose_local_ready", readyId: "ready-to-clear" },
  ]);
});

test("late parse completion after clear is disposed and cannot recreate local authority", () => {
  let state = apply(anonymousState(), {
    type: "local_selection_requested",
    operationId: "parse-before-clear",
  });
  state = apply(state, {
    type: "local_parse_started",
    operationId: "parse-before-clear",
    selectionRef: "selection-before-clear",
  });
  const cleared = apply(state, {
    type: "local_source_clear_requested",
  });
  const late = transitionAppShell(cleared, {
    type: "local_parse_succeeded",
    operationId: "parse-before-clear",
    readyId: "late-after-clear",
    session: LOCAL_SESSION,
  });
  assert.equal(late.accepted, false);
  assert.equal(late.state, cleared);
  assert.deepEqual(late.state.source, { status: "empty" });
  assert.deepEqual(late.state.authority, { status: "none" });
  assert.deepEqual(late.effects, [{
    type: "dispose_local_ready",
    readyId: "late-after-clear",
  }]);
});

test("refresh or a new tab starts from a new page state with no local session", () => {
  const active = withReadyLocal();
  assert.equal(active.authority.status, "local_session");

  const refreshed = createInitialAppShellState("new-page-bootstrap");
  assert.deepEqual(refreshed.source, { status: "empty" });
  assert.deepEqual(refreshed.authority, { status: "none" });
  assert.equal(refreshed.auth.status, "loading");
});

test("state-table rejects stale and conflicting transitions as stable no-ops", () => {
  const empty = anonymousState();
  const cases: Array<{
    name: string;
    state: AppShellState;
    event: AppShellEvent;
    reason: string;
  }> = [
    {
      name: "stale bootstrap",
      state: empty,
      event: {
        type: "auth_session_authenticated",
        operationId: "old-bootstrap",
        principal: PRINCIPAL,
      },
      reason: "stale_auth_response",
    },
    {
      name: "cancel without local operation",
      state: empty,
      event: {
        type: "local_operation_cancelled",
        operationId: "missing",
      },
      reason: "stale_local_response",
    },
    {
      name: "clear empty",
      state: empty,
      event: { type: "local_source_clear_requested" },
      reason: "local_source_already_empty",
    },
    {
      name: "shared open anonymous",
      state: empty,
      event: {
        type: "shared_open_requested",
        operationId: "shared",
        workspaceId: SHARED.workspaceId,
      },
      reason: "authentication_required",
    },
    {
      name: "stale shared failure",
      state: authenticatedState(),
      event: {
        type: "shared_load_failed",
        operationId: "missing",
        kind: "server_5xx",
      },
      reason: "stale_shared_response",
    },
  ];

  for (const entry of cases) {
    const result = transitionAppShell(entry.state, entry.event);
    assert.equal(result.accepted, false, entry.name);
    assert.equal(result.rejectionReason, entry.reason, entry.name);
    assert.equal(result.state, entry.state, entry.name);
    assert.deepEqual(result.effects, [], entry.name);
  }
});

test("state invariant rejects mixed or unauthorized authority combinations", () => {
  assert.throws(
    () => assertAppShellState({
      ...anonymousState(),
      authority: { status: "local_session" },
    }),
    /inconsistent/,
  );
  assert.throws(
    () => assertAppShellState({
      ...anonymousState(),
      authority: {
        status: "shared_workspace",
        resource: SHARED,
      },
    }),
    /requires authenticated/,
  );
  assert.throws(
    () => assertAppShellState({
      ...authenticatedState(),
      source: {
        status: "ready",
        readyId: "mixed",
        session: LOCAL_SESSION,
      },
      authority: {
        status: "shared_workspace",
        resource: SHARED,
      },
    }),
    /inconsistent|cannot retain/,
  );
});
