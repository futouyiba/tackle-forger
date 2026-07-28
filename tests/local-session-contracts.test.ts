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
  type LocalSessionModel,
  type LocalSessionReducerState,
} from "../lib/local-session-contracts";
import type { WorkspaceState } from "../lib/types";
import type { WorkspaceSurface } from "../lib/workspace-surface";

const SHA256 = "a".repeat(64);

function assertActiveSessionIsParsable(state: LocalSessionReducerState): LocalSessionModel {
  assert.equal(state.status, "active");
  if (state.status !== "active") {
    throw new Error("Expected an active local session.");
  }
  assert.deepEqual(parseLocalSessionModel(state.session), state.session);
  return state.session;
}

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
  let session = assertActiveSessionIsParsable(state);
  assert.deepEqual(session.history.current, {
    authority: "local_ephemeral",
    sequence: 1,
  });
  assert.equal(session.history.undo.length, 1);
  assert.equal(session.history.redo.length, 0);

  state = reduceLocalSession(state, { type: "undo_local_edit" });
  session = assertActiveSessionIsParsable(state);
  assert.equal(session.document.notes, "");
  assert.equal(session.history.current.sequence, 0);
  assert.equal(session.history.redo.length, 1);

  state = reduceLocalSession(state, { type: "redo_local_edit" });
  session = assertActiveSessionIsParsable(state);
  assert.equal(session.document.notes, "local only");
  assert.equal(session.history.current.sequence, 1);

  state = reduceLocalSession(state, { type: "clear_local_session" });
  assert.deepEqual(state, { status: "empty" });
});

test("closed parser rejects duplicate and incoherently ordered history revisions", () => {
  const session = createLocalSessionModel({ kind: "temporary_workspace" });
  const entry = (sequence: number) => ({
    revision: { authority: "local_ephemeral" as const, sequence },
    document: session.document,
  });
  const withHistory = (
    current: number,
    undo: readonly ReturnType<typeof entry>[],
    redo: readonly ReturnType<typeof entry>[],
  ) => ({
    ...session,
    history: {
      current: { authority: "local_ephemeral" as const, sequence: current },
      undo,
      redo,
    },
  });

  assert.throws(
    () => parseLocalSessionModel(withHistory(1, [entry(1)], [])),
    /revisions must be unique/,
  );
  assert.throws(
    () => parseLocalSessionModel(withHistory(1, [entry(2)], [])),
    /undo revisions must precede current/,
  );
  assert.throws(
    () => parseLocalSessionModel(withHistory(3, [entry(2), entry(1)], [])),
    /undo revisions must be strictly increasing/,
  );
  assert.throws(
    () => parseLocalSessionModel(withHistory(2, [], [entry(1)])),
    /redo revisions must follow current/,
  );
  assert.throws(
    () => parseLocalSessionModel(withHistory(1, [], [entry(2), entry(3)])),
    /redo revisions must be strictly decreasing/,
  );
});

test("commit, undo and redo combinations always return parser-accepted history", () => {
  let state: LocalSessionReducerState = {
    status: "active",
    session: createLocalSessionModel({ kind: "temporary_workspace" }),
  };
  const actions = [
    { type: "commit_local_edit", document: { title: "one", notes: "" } },
    { type: "commit_local_edit", document: { title: "two", notes: "" } },
    { type: "undo_local_edit" },
    { type: "undo_local_edit" },
    { type: "redo_local_edit" },
    { type: "commit_local_edit", document: { title: "branch", notes: "" } },
    { type: "undo_local_edit" },
    { type: "redo_local_edit" },
  ] as const;

  for (const action of actions) {
    state = reduceLocalSession(state, action);
    assertActiveSessionIsParsable(state);
  }
});

test("revision allocation remains parser-safe at the safe-integer boundary", () => {
  const session = createLocalSessionModel({ kind: "temporary_workspace" });
  const nearExhaustion = parseLocalSessionModel({
    ...session,
    history: {
      current: {
        authority: "local_ephemeral",
        sequence: Number.MAX_SAFE_INTEGER - 1,
      },
      undo: [],
      redo: [],
    },
  });
  const committed = reduceLocalSession(
    { status: "active", session: nearExhaustion },
    {
      type: "commit_local_edit",
      document: { title: "last revision", notes: "" },
    },
  );
  const exhausted = assertActiveSessionIsParsable(committed);
  assert.equal(exhausted.history.current.sequence, Number.MAX_SAFE_INTEGER);
  assert.throws(
    () =>
      reduceLocalSession(
        { status: "active", session: exhausted },
        {
          type: "commit_local_edit",
          document: { title: "overflow", notes: "" },
        },
      ),
    /revision sequence is exhausted/,
  );
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

test("nested rules/templates allowlist rejects formal objects and unknown fields", () => {
  const session = createLocalSessionModel(
    { kind: "temporary_workspace" },
    {
      title: "local",
      notes: "",
      sourceIssues: [],
      parameters: [{
        id: "p-1",
        key: "pull",
        label: "拉力",
        itemPart: "rod",
        unit: "kgf",
        precision: 2,
        notes: "",
      }],
      templates: [{
        id: "t-1",
        name: "模板",
        itemPart: "rod",
        targetPullMinKgf: 1,
        targetPullMaxKgf: 3,
        nominalTargetPullKgf: 2,
        values: { pull: 2 },
        notes: "",
      }],
      rules: [{
        id: "r-1",
        sourceKind: "method",
        sourceId: "method:lure",
        sourceName: "路亚",
        sequence: 0,
        parameterKey: "pull",
        operation: "add",
        value: 1,
        condition: "",
        notes: "",
        enabled: true,
      }],
    },
  );
  assert.deepEqual(parseLocalSessionModel(session), session);
  assert.throws(
    () => parseLocalSessionModel({
      ...session,
      document: {
        ...session.document,
        templates: [{
          ...session.document.templates[0],
          seriesId: "series:forbidden",
        }],
      },
    }),
    /unknown field "seriesId"/,
  );
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
