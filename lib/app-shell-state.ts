import {
  parseLocalSessionModel,
  type LocalSessionModel,
} from "./local-session-contracts";

/**
 * P2 only publishes the state-machine contract. P3 must opt in explicitly
 * before the current Workbench consumes it.
 */
export const LOCAL_SESSION_APP_SHELL_DEFAULT_ENABLED = false as const;

export interface AuthenticatedPrincipal {
  openId: string;
  displayName: string;
}

type StableAuthState =
  | { status: "anonymous"; reason: "no_session" | "logout" | "revoked" | "oauth_cancelled" }
  | { status: "authenticated"; principal: AuthenticatedPrincipal }
  | { status: "failed"; code: string };

export type AuthState =
  | {
      status: "loading";
      operationId: string;
      reason: "bootstrap" | "login";
      previous?: StableAuthState;
    }
  | StableAuthState;

export interface LocalReadySource {
  status: "ready";
  readyId: string;
  session: LocalSessionModel;
}

export type SourceState =
  | { status: "empty" }
  | {
      status: "selecting";
      operationId: string;
      previousReady?: LocalReadySource;
    }
  | {
      status: "parsing";
      operationId: string;
      selectionRef: string;
      previousReady?: LocalReadySource;
    }
  | LocalReadySource
  | {
      status: "failed";
      operationId: string;
      code: "selection_failed" | "parse_failed" | "invalid_local_session";
      previousReady?: LocalReadySource;
    };

export interface SharedWorkspaceResource {
  workspaceId: string;
  revision: number;
  resourceId: string;
}

export type StableWorkspaceAuthority =
  | { status: "none" }
  | { status: "local_session" }
  | { status: "shared_workspace"; resource: SharedWorkspaceResource };

export type WorkspaceAuthority =
  | StableWorkspaceAuthority
  | {
      status: "shared_loading";
      operationId: string;
      workspaceId: string;
      previous: StableWorkspaceAuthority;
    };

export type SharedLoadFailureKind =
  | "unauthorized_401"
  | "forbidden_403"
  | "conflict_409"
  | "server_5xx"
  | "workspace_mismatch"
  | "invalid_resource"
  | "cancelled";

export interface SharedLoadFailure {
  operationId: string;
  workspaceId: string;
  kind: SharedLoadFailureKind;
}

export interface AppShellState {
  auth: AuthState;
  source: SourceState;
  authority: WorkspaceAuthority;
  lastSharedFailure: SharedLoadFailure | null;
}

export type AppShellEffect =
  | {
      type: "open_auth_window";
      operationId: string;
      mode: "popup_or_new_tab";
      retainOpenerLocalSession: true;
    }
  | { type: "cancel_local_operation"; operationId: string }
  | { type: "dispose_local_ready"; readyId: string }
  | { type: "cancel_shared_load"; operationId: string }
  | {
      type: "activate_shared_workspace";
      resource: SharedWorkspaceResource;
    }
  | { type: "dispose_shared_workspace"; resourceId: string };

export type AppShellEvent =
  | { type: "auth_session_anonymous"; operationId: string }
  | {
      type: "auth_session_authenticated";
      operationId: string;
      principal: AuthenticatedPrincipal;
    }
  | { type: "auth_session_failed"; operationId: string; code: string }
  | { type: "login_requested"; operationId: string }
  | {
      type: "login_succeeded";
      operationId: string;
      principal: AuthenticatedPrincipal;
    }
  | { type: "login_failed"; operationId: string; code: string }
  | { type: "oauth_cancelled"; operationId: string }
  | { type: "logout_requested" }
  | { type: "session_revoked" }
  | { type: "local_selection_requested"; operationId: string }
  | {
      type: "local_parse_started";
      operationId: string;
      selectionRef: string;
    }
  | {
      type: "local_selection_failed";
      operationId: string;
    }
  | {
      type: "local_parse_succeeded";
      operationId: string;
      readyId: string;
      session: LocalSessionModel;
    }
  | { type: "local_parse_failed"; operationId: string }
  | { type: "local_operation_cancelled"; operationId: string }
  | { type: "local_source_clear_requested" }
  | {
      type: "shared_open_requested";
      operationId: string;
      workspaceId: string;
    }
  | {
      type: "shared_load_succeeded";
      operationId: string;
      resource: SharedWorkspaceResource;
    }
  | {
      type: "shared_load_failed";
      operationId: string;
      kind: Exclude<SharedLoadFailureKind, "cancelled">;
    }
  | { type: "shared_load_cancelled"; operationId: string };

export interface AppShellTransition {
  state: AppShellState;
  effects: readonly AppShellEffect[];
  accepted: boolean;
  rejectionReason?: string;
}

export function createInitialAppShellState(authOperationId: string): AppShellState {
  requireIdentifier(authOperationId, "authOperationId");
  return {
    auth: {
      status: "loading",
      operationId: authOperationId,
      reason: "bootstrap",
    },
    source: { status: "empty" },
    authority: { status: "none" },
    lastSharedFailure: null,
  };
}

function requireIdentifier(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function recoverableReady(source: SourceState): LocalReadySource | undefined {
  if (source.status === "ready") return source;
  if (
    source.status === "selecting"
    || source.status === "parsing"
    || source.status === "failed"
  ) {
    return source.previousReady;
  }
  return undefined;
}

function restorePreviousSource(source: SourceState): SourceState {
  return recoverableReady(source) ?? { status: "empty" };
}

function cancelLocalEffect(source: SourceState): AppShellEffect[] {
  if (source.status === "selecting" || source.status === "parsing") {
    return [{ type: "cancel_local_operation", operationId: source.operationId }];
  }
  return [];
}

function localAuthorityFor(source: SourceState): StableWorkspaceAuthority {
  return recoverableReady(source)
    ? { status: "local_session" }
    : { status: "none" };
}

function accepted(
  state: AppShellState,
  effects: readonly AppShellEffect[] = [],
): AppShellTransition {
  assertAppShellState(state);
  return { state, effects, accepted: true };
}

function rejected(state: AppShellState, rejectionReason: string): AppShellTransition {
  assertAppShellState(state);
  return { state, effects: [], accepted: false, rejectionReason };
}

function authOperationMatches(
  auth: AuthState,
  operationId: string,
  reason?: "bootstrap" | "login",
): boolean {
  return auth.status === "loading"
    && auth.operationId === operationId
    && (reason === undefined || auth.reason === reason);
}

function finishAuthOperation(
  state: AppShellState,
  operationId: string,
  next: StableAuthState,
  expectedReason?: "bootstrap" | "login",
): AppShellTransition {
  if (!authOperationMatches(state.auth, operationId, expectedReason)) {
    return rejected(state, "stale_auth_response");
  }
  return accepted({ ...state, auth: next });
}

function clearSharedForSessionLoss(
  state: AppShellState,
  reason: "logout" | "revoked",
): AppShellTransition {
  const effects: AppShellEffect[] = [];
  let authority: StableWorkspaceAuthority;

  if (state.authority.status === "shared_workspace") {
    effects.push({
      type: "dispose_shared_workspace",
      resourceId: state.authority.resource.resourceId,
    });
    authority = { status: "none" };
  } else if (state.authority.status === "shared_loading") {
    effects.push({
      type: "cancel_shared_load",
      operationId: state.authority.operationId,
    });
    if (state.authority.previous.status === "shared_workspace") {
      effects.push({
        type: "dispose_shared_workspace",
        resourceId: state.authority.previous.resource.resourceId,
      });
      authority = { status: "none" };
    } else {
      authority = state.authority.previous;
    }
  } else {
    authority = state.authority;
  }

  return accepted({
    ...state,
    auth: { status: "anonymous", reason },
    authority,
    lastSharedFailure: null,
  }, effects);
}

function disposeLoadedSharedResponse(
  state: AppShellState,
  resource: SharedWorkspaceResource,
  reason: string,
): AppShellTransition {
  return {
    state,
    effects: [{
      type: "dispose_shared_workspace",
      resourceId: resource.resourceId,
    }],
    accepted: false,
    rejectionReason: reason,
  };
}

function handleLocalSelection(
  state: AppShellState,
  operationId: string,
): AppShellTransition {
  requireIdentifier(operationId, "operationId");
  if (
    state.authority.status === "shared_workspace"
    || state.authority.status === "shared_loading"
  ) {
    return rejected(state, "shared_authority_active");
  }
  const previousReady = recoverableReady(state.source);
  const source: SourceState = {
    status: "selecting",
    operationId,
    ...(previousReady ? { previousReady } : {}),
  };
  return accepted({
    ...state,
    source,
    authority: localAuthorityFor(source),
  }, cancelLocalEffect(state.source));
}

function handleLocalClear(state: AppShellState): AppShellTransition {
  const ready = recoverableReady(state.source);
  const effects: AppShellEffect[] = [...cancelLocalEffect(state.source)];
  let authority: WorkspaceAuthority = state.authority;
  let lastSharedFailure = state.lastSharedFailure;

  if (
    state.authority.status === "shared_loading"
    && state.authority.previous.status === "local_session"
  ) {
    effects.push({
      type: "cancel_shared_load",
      operationId: state.authority.operationId,
    });
    authority = { status: "none" };
    lastSharedFailure = {
      operationId: state.authority.operationId,
      workspaceId: state.authority.workspaceId,
      kind: "cancelled",
    };
  } else if (state.authority.status === "local_session") {
    authority = { status: "none" };
  } else if (state.authority.status === "shared_workspace") {
    return rejected(state, "no_local_source_under_shared_authority");
  } else if (
    state.authority.status === "shared_loading"
    && state.authority.previous.status !== "local_session"
  ) {
    return rejected(state, "no_local_source_under_shared_authority");
  }

  if (ready) {
    effects.push({ type: "dispose_local_ready", readyId: ready.readyId });
  }
  if (state.source.status === "empty" && effects.length === 0) {
    return rejected(state, "local_source_already_empty");
  }
  return accepted({
    ...state,
    source: { status: "empty" },
    authority,
    lastSharedFailure,
  }, effects);
}

function restoreSharedFailure(
  state: AppShellState,
  operationId: string,
  kind: SharedLoadFailureKind,
): AppShellTransition {
  if (
    state.authority.status !== "shared_loading"
    || state.authority.operationId !== operationId
  ) {
    return rejected(state, "stale_shared_response");
  }
  const loading = state.authority;
  const failure: SharedLoadFailure = {
    operationId,
    workspaceId: loading.workspaceId,
    kind,
  };
  const effects: AppShellEffect[] = [];
  let authority: StableWorkspaceAuthority = loading.previous;
  let auth = state.auth;

  if (kind === "unauthorized_401") {
    auth = { status: "anonymous", reason: "revoked" };
    if (loading.previous.status === "shared_workspace") {
      effects.push({
        type: "dispose_shared_workspace",
        resourceId: loading.previous.resource.resourceId,
      });
      authority = { status: "none" };
    }
  }
  return accepted({
    ...state,
    auth,
    authority,
    lastSharedFailure: failure,
  }, effects);
}

export function transitionAppShell(
  state: AppShellState,
  event: AppShellEvent,
): AppShellTransition {
  assertAppShellState(state);

  switch (event.type) {
    case "auth_session_anonymous":
      return finishAuthOperation(
        state,
        event.operationId,
        { status: "anonymous", reason: "no_session" },
        "bootstrap",
      );
    case "auth_session_authenticated":
      return finishAuthOperation(
        state,
        event.operationId,
        { status: "authenticated", principal: event.principal },
        "bootstrap",
      );
    case "auth_session_failed":
      return finishAuthOperation(
        state,
        event.operationId,
        { status: "failed", code: event.code },
        "bootstrap",
      );
    case "login_requested": {
      requireIdentifier(event.operationId, "operationId");
      if (state.auth.status === "authenticated" || state.auth.status === "loading") {
        return rejected(state, "login_not_available");
      }
      const auth: AuthState = {
        status: "loading",
        operationId: event.operationId,
        reason: "login",
        previous: state.auth,
      };
      return accepted({ ...state, auth }, [{
        type: "open_auth_window",
        operationId: event.operationId,
        mode: "popup_or_new_tab",
        retainOpenerLocalSession: true,
      }]);
    }
    case "login_succeeded":
      return finishAuthOperation(
        state,
        event.operationId,
        { status: "authenticated", principal: event.principal },
        "login",
      );
    case "login_failed":
      return finishAuthOperation(
        state,
        event.operationId,
        { status: "failed", code: event.code },
        "login",
      );
    case "oauth_cancelled":
      if (!authOperationMatches(state.auth, event.operationId, "login")) {
        return rejected(state, "stale_auth_response");
      }
      return accepted({
        ...state,
        auth: { status: "anonymous", reason: "oauth_cancelled" },
      });
    case "logout_requested":
      return clearSharedForSessionLoss(state, "logout");
    case "session_revoked":
      return clearSharedForSessionLoss(state, "revoked");
    case "local_selection_requested":
      return handleLocalSelection(state, event.operationId);
    case "local_parse_started": {
      requireIdentifier(event.selectionRef, "selectionRef");
      if (
        state.source.status !== "selecting"
        || state.source.operationId !== event.operationId
      ) {
        return rejected(state, "stale_local_response");
      }
      return accepted({
        ...state,
        source: {
          status: "parsing",
          operationId: event.operationId,
          selectionRef: event.selectionRef,
          ...(state.source.previousReady
            ? { previousReady: state.source.previousReady }
            : {}),
        },
      });
    }
    case "local_selection_failed":
    case "local_parse_failed": {
      const expectedStatus = event.type === "local_selection_failed"
        ? "selecting"
        : "parsing";
      if (
        state.source.status !== expectedStatus
        || state.source.operationId !== event.operationId
      ) {
        return rejected(state, "stale_local_response");
      }
      const previousReady = state.source.previousReady;
      return accepted({
        ...state,
        source: {
          status: "failed",
          operationId: event.operationId,
          code: event.type === "local_selection_failed"
            ? "selection_failed"
            : "parse_failed",
          ...(previousReady ? { previousReady } : {}),
        },
        authority: previousReady
          ? { status: "local_session" }
          : { status: "none" },
      });
    }
    case "local_parse_succeeded": {
      requireIdentifier(event.readyId, "readyId");
      if (
        state.source.status !== "parsing"
        || state.source.operationId !== event.operationId
      ) {
        return {
          state,
          effects: [{ type: "dispose_local_ready", readyId: event.readyId }],
          accepted: false,
          rejectionReason: "stale_local_response",
        };
      }
      let session: LocalSessionModel;
      try {
        session = parseLocalSessionModel(event.session);
      } catch {
        const previousReady = state.source.previousReady;
        return accepted({
          ...state,
          source: {
            status: "failed",
            operationId: event.operationId,
            code: "invalid_local_session",
            ...(previousReady ? { previousReady } : {}),
          },
          authority: previousReady
            ? { status: "local_session" }
            : { status: "none" },
        }, [{ type: "dispose_local_ready", readyId: event.readyId }]);
      }
      const previousReady = state.source.previousReady;
      const effects: AppShellEffect[] = previousReady
        ? [{ type: "dispose_local_ready", readyId: previousReady.readyId }]
        : [];
      return accepted({
        ...state,
        source: { status: "ready", readyId: event.readyId, session },
        authority: { status: "local_session" },
      }, effects);
    }
    case "local_operation_cancelled":
      if (
        !(
          state.source.status === "selecting"
          || state.source.status === "parsing"
          || state.source.status === "failed"
        )
        || state.source.operationId !== event.operationId
      ) {
        return rejected(state, "stale_local_response");
      }
      return accepted({
        ...state,
        source: restorePreviousSource(state.source),
        authority: localAuthorityFor(state.source),
      }, cancelLocalEffect(state.source));
    case "local_source_clear_requested":
      return handleLocalClear(state);
    case "shared_open_requested": {
      requireIdentifier(event.operationId, "operationId");
      requireIdentifier(event.workspaceId, "workspaceId");
      if (state.auth.status !== "authenticated") {
        return rejected(state, "authentication_required");
      }
      if (state.authority.status === "shared_loading") {
        return rejected(state, "shared_load_in_progress");
      }
      if (
        state.source.status === "selecting"
        || state.source.status === "parsing"
      ) {
        return rejected(state, "local_transition_in_progress");
      }
      return accepted({
        ...state,
        authority: {
          status: "shared_loading",
          operationId: event.operationId,
          workspaceId: event.workspaceId,
          previous: state.authority,
        },
        lastSharedFailure: null,
      });
    }
    case "shared_load_succeeded": {
      if (
        state.authority.status !== "shared_loading"
        || state.authority.operationId !== event.operationId
      ) {
        return disposeLoadedSharedResponse(
          state,
          event.resource,
          "stale_shared_response",
        );
      }
      if (state.authority.workspaceId !== event.resource.workspaceId) {
        const loading = state.authority;
        return accepted({
            ...state,
            authority: loading.previous,
            lastSharedFailure: {
              operationId: event.operationId,
              workspaceId: loading.workspaceId,
              kind: "workspace_mismatch",
            },
        }, [{
          type: "dispose_shared_workspace",
          resourceId: event.resource.resourceId,
        }]);
      }
      if (
        !Number.isSafeInteger(event.resource.revision)
        || event.resource.revision < 0
      ) {
        const loading = state.authority;
        return accepted({
          ...state,
          authority: loading.previous,
          lastSharedFailure: {
            operationId: event.operationId,
            workspaceId: loading.workspaceId,
            kind: "invalid_resource",
          },
        }, [{
          type: "dispose_shared_workspace",
          resourceId: event.resource.resourceId,
        }]);
      }
      const previous = state.authority.previous;
      const effects: AppShellEffect[] = [{
        type: "activate_shared_workspace",
        resource: event.resource,
      }];
      let source = state.source;
      if (previous.status === "local_session") {
        const local = recoverableReady(source);
        if (!local) return rejected(state, "local_authority_source_missing");
        source = { status: "empty" };
        effects.push({ type: "dispose_local_ready", readyId: local.readyId });
      } else if (previous.status === "shared_workspace") {
        effects.push({
          type: "dispose_shared_workspace",
          resourceId: previous.resource.resourceId,
        });
      } else if (source.status !== "empty") {
        source = { status: "empty" };
      }
      return accepted({
        ...state,
        source,
        authority: {
          status: "shared_workspace",
          resource: event.resource,
        },
        lastSharedFailure: null,
      }, effects);
    }
    case "shared_load_failed":
      return restoreSharedFailure(
        state,
        event.operationId,
        event.kind,
      );
    case "shared_load_cancelled":
      return restoreSharedFailure(state, event.operationId, "cancelled");
  }
}

export function assertAppShellState(state: AppShellState): void {
  const ready = recoverableReady(state.source);
  const localAuthorityExpected =
    state.authority.status === "local_session"
    || (
      state.authority.status === "shared_loading"
      && state.authority.previous.status === "local_session"
    );

  if (Boolean(ready) !== localAuthorityExpected) {
    throw new Error("Local source readiness and local authority are inconsistent.");
  }
  if (
    state.authority.status === "shared_workspace"
    && state.source.status !== "empty"
  ) {
    throw new Error("Shared workspace authority cannot retain a local source.");
  }
  if (
    state.authority.status === "shared_loading"
    && state.authority.previous.status === "shared_workspace"
    && state.source.status !== "empty"
  ) {
    throw new Error("A shared-to-shared load cannot retain a local source.");
  }
  if (
    (
      state.authority.status === "shared_workspace"
      || state.authority.status === "shared_loading"
    )
    && state.auth.status !== "authenticated"
  ) {
    throw new Error("Shared workspace authority requires authenticated auth state.");
  }
  if (
    state.authority.status === "shared_workspace"
    && (
      !Number.isSafeInteger(state.authority.resource.revision)
      || state.authority.resource.revision < 0
    )
  ) {
    throw new Error("Shared workspace revision must be a non-negative safe integer.");
  }
}
