import assert from "node:assert/strict";
import test from "node:test";

import type { ActionCommandPayloadRecord } from "../lib/action-command-payloads";
import type { ActionAvailability } from "../lib/interaction-contracts";
import {
  LOCAL_ACTION_CODES,
  buildLocalActionAvailabilityMap,
  createLocalSessionModel,
  parseLocalSessionModel,
  reduceLocalSession,
  type LocalActionCode,
  type LocalSessionReducerState,
} from "../lib/local-session-contracts";
import type { WorkspaceState } from "../lib/types";
import type { WorkspaceSurface } from "../lib/workspace-surface";

const SHA256 = "a".repeat(64);

test("local actions are a closed four-action contract without server capabilities", () => {
  assert.deepEqual(LOCAL_ACTION_CODES, [
    "open_local_excel",
    "create_local_temporary_workspace",
    "edit_local_session",
    "clear_local_session",
  ]);

  const availability = buildLocalActionAvailabilityMap({ status: "empty" });
  assert.equal(availability.open_local_excel.enabled, true);
  assert.equal(availability.create_local_temporary_workspace.enabled, true);
  assert.equal(availability.edit_local_session.enabled, false);
  assert.equal(availability.clear_local_session.enabled, false);
  assert.equal("requiredCapabilities" in availability.open_local_excel, false);
  assert.equal("commandPayloadRef" in availability.open_local_excel, false);
});

test("local reducer keeps edit, undo and redo in an ephemeral history", () => {
  const initial = createLocalSessionModel(
    {
      kind: "local_excel",
      fileName: "fixture.xlsx",
      byteLength: 128,
      contentSha256: SHA256,
    },
    { title: "Fixture", notes: "" },
  );
  let state: LocalSessionReducerState = {
    status: "active",
    session: initial,
  };

  state = reduceLocalSession(state, {
    type: "commit_local_edit",
    document: { title: "Fixture", notes: "local only" },
  });
  assert.equal(state.status, "active");
  if (state.status !== "active") return;
  assert.deepEqual(state.session.history.current, {
    authority: "local_ephemeral",
    sequence: 1,
  });
  assert.equal(state.session.history.undo.length, 1);
  assert.equal(state.session.history.redo.length, 0);

  state = reduceLocalSession(state, { type: "undo_local_edit" });
  assert.equal(state.status, "active");
  if (state.status !== "active") return;
  assert.equal(state.session.document.notes, "");
  assert.equal(state.session.history.current.sequence, 0);
  assert.equal(state.session.history.redo.length, 1);

  state = reduceLocalSession(state, { type: "redo_local_edit" });
  assert.equal(state.status, "active");
  if (state.status !== "active") return;
  assert.equal(state.session.document.notes, "local only");
  assert.equal(state.session.history.current.sequence, 1);

  state = reduceLocalSession(state, { type: "clear_local_session" });
  assert.deepEqual(state, { status: "empty" });
});

test("local reducer boundary actions are stable no-ops", () => {
  const empty: LocalSessionReducerState = { status: "empty" };
  assert.equal(reduceLocalSession(empty, { type: "undo_local_edit" }), empty);
  assert.equal(reduceLocalSession(empty, { type: "redo_local_edit" }), empty);

  const session = createLocalSessionModel({ kind: "temporary_workspace" });
  const active: LocalSessionReducerState = { status: "active", session };
  assert.equal(
    reduceLocalSession(active, {
      type: "commit_local_edit",
      document: session.document,
    }),
    active,
  );
  assert.equal(reduceLocalSession(active, { type: "undo_local_edit" }), active);
  assert.equal(reduceLocalSession(active, { type: "redo_local_edit" }), active);

  assert.throws(
    () => reduceLocalSession(active, {
      type: "commit_local_edit",
      document: { title: "Changed", notes: "", sharedState: true } as never,
    }),
    /unknown field "sharedState"/,
  );
});

test("closed runtime schema accepts the allowlist and rejects unknown nested fields", () => {
  const session = createLocalSessionModel({ kind: "temporary_workspace" });
  assert.deepEqual(parseLocalSessionModel(session), session);

  assert.throws(
    () => parseLocalSessionModel({ ...session, unexpected: true }),
    /unknown field "unexpected"/,
  );
  assert.throws(
    () => parseLocalSessionModel({
      ...session,
      source: { kind: "temporary_workspace", path: "C:\\secret" },
    }),
    /unknown field "path"/,
  );
  assert.throws(
    () => parseLocalSessionModel({
      ...session,
      history: {
        ...session.history,
        current: { authority: "local_ephemeral", sequence: -1 },
      },
    }),
    /non-negative safe integer/,
  );
});

test("closed runtime schema rejects shared-only authority fields", () => {
  const session = createLocalSessionModel({ kind: "temporary_workspace" });
  for (const field of [
    "workspaceId",
    "configurationSnapshots",
    "ruleSetVersions",
    "capabilities",
    "actionAvailability",
    "commandPayloadRef",
    "identityAuditLog",
    "leaseId",
    "fencingToken",
    "outbox",
    "configIdGovernance",
  ]) {
    assert.throws(
      () => parseLocalSessionModel({ ...session, [field]: "forbidden" }),
      new RegExp(`unknown field "${field}"`),
    );
  }
});

test("WorkspaceSurface narrows none, local and shared authority without promotion", () => {
  const surface: WorkspaceSurface = {
    kind: "local",
    session: createLocalSessionModel({ kind: "temporary_workspace" }),
  };
  assert.equal(surface.kind, "local");
  assert.equal(surface.session.authority, "local");
});

test("compile-time negative contracts keep local state and actions out of server authority", () => {
  const localAction = "edit_local_session" satisfies LocalActionCode;
  // @ts-expect-error LocalActionCode is not accepted by the server command dispatcher.
  const serverAction: ActionCommandPayloadRecord["action"] = localAction;
  assert.equal(serverAction, "edit_local_session");

  const localSession = createLocalSessionModel({ kind: "temporary_workspace" });
  const localAvailability = buildLocalActionAvailabilityMap({
    status: "active",
    session: localSession,
  }).edit_local_session;
  // @ts-expect-error Local availability cannot be promoted to server availability.
  const serverAvailability: ActionAvailability = localAvailability;
  assert.equal(serverAvailability.action, "edit_local_session");

  // @ts-expect-error LocalSessionModel cannot be assigned to shared WorkspaceState.
  const sharedState: WorkspaceState = localSession;
  assert.equal(sharedState, localSession);

  const mixedSurface: WorkspaceSurface = {
    kind: "local",
    session: localSession,
    // @ts-expect-error A local surface cannot carry a shared workspace revision.
    workspaceRevision: 1,
  };
  assert.equal(mixedSurface.kind, "local");

  // @ts-expect-error Local ephemeral revision is not a server workspace revision number.
  const workspaceRevision: number = localSession.history.current;
  assert.equal(typeof workspaceRevision, "object");
});
