export const LOCAL_SESSION_CONTRACT_VERSION = "local-session/open009-v2" as const;
export const LOCAL_ACTION_CONTRACT_VERSION = "anonymous-local-actions/open009-v2" as const;

export const LOCAL_ACTION_CODES = [
  "open_local_excel",
  "create_local_temporary_workspace",
  "edit_local_session",
  "clear_local_session",
] as const;

export type LocalActionCode = (typeof LOCAL_ACTION_CODES)[number];

export interface LocalActionAvailability {
  contractVersion: typeof LOCAL_ACTION_CONTRACT_VERSION;
  action: LocalActionCode;
  enabled: boolean;
  disabledReasonCode?: string;
  disabledReasonText?: string;
}

export type LocalActionAvailabilityMap = Record<LocalActionCode, LocalActionAvailability>;

export type LocalSessionSource =
  | {
      kind: "local_excel";
      fileName: string;
      byteLength: number;
      contentSha256: string;
    }
  | {
      kind: "temporary_workspace";
    };

export interface LocalSessionDocument {
  title: string;
  notes: string;
}

/**
 * A deliberately non-numeric revision token. It cannot be passed where a
 * server workspace revision number is expected.
 */
export interface LocalEphemeralRevision {
  authority: "local_ephemeral";
  sequence: number;
}

export interface LocalSessionHistoryEntry {
  revision: LocalEphemeralRevision;
  document: LocalSessionDocument;
}

export interface LocalSessionHistory {
  current: LocalEphemeralRevision;
  undo: readonly LocalSessionHistoryEntry[];
  redo: readonly LocalSessionHistoryEntry[];
}

/**
 * Explicit anonymous-session allowlist. Keep this declaration independent of
 * WorkspaceState: Partial, Pick and Omit would silently import shared authority.
 */
export interface LocalSessionModel {
  contractVersion: typeof LOCAL_SESSION_CONTRACT_VERSION;
  authority: "local";
  source: LocalSessionSource;
  document: LocalSessionDocument;
  history: LocalSessionHistory;
}

export type LocalSessionReducerState =
  | { status: "empty" }
  | { status: "active"; session: LocalSessionModel };

export type LocalSessionReducerAction =
  | { type: "activate_local_session"; session: LocalSessionModel }
  | { type: "commit_local_edit"; document: LocalSessionDocument }
  | { type: "undo_local_edit" }
  | { type: "redo_local_edit" }
  | { type: "clear_local_session" };

export class LocalSessionSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalSessionSchemaError";
  }
}

function exactObject(
  value: unknown,
  allowedKeys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalSessionSchemaError(`${path} must be an object.`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new LocalSessionSchemaError(`${path} contains unknown field "${key}".`);
    }
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(object, key)) {
      throw new LocalSessionSchemaError(`${path} is missing field "${key}".`);
    }
  }
  return object;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new LocalSessionSchemaError(`${path} must be a string.`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LocalSessionSchemaError(`${path} must be a non-negative safe integer.`);
  }
  return value as number;
}

function parseRevision(value: unknown, path: string): LocalEphemeralRevision {
  const object = exactObject(value, ["authority", "sequence"], path);
  if (object.authority !== "local_ephemeral") {
    throw new LocalSessionSchemaError(`${path}.authority must be "local_ephemeral".`);
  }
  return {
    authority: "local_ephemeral",
    sequence: nonNegativeSafeInteger(object.sequence, `${path}.sequence`),
  };
}

function parseDocument(value: unknown, path: string): LocalSessionDocument {
  const object = exactObject(value, ["title", "notes"], path);
  return {
    title: stringValue(object.title, `${path}.title`),
    notes: stringValue(object.notes, `${path}.notes`),
  };
}

function parseSource(value: unknown): LocalSessionSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalSessionSchemaError("LocalSessionModel.source must be an object.");
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "temporary_workspace") {
    exactObject(value, ["kind"], "LocalSessionModel.source");
    return { kind };
  }
  if (kind === "local_excel") {
    const object = exactObject(
      value,
      ["kind", "fileName", "byteLength", "contentSha256"],
      "LocalSessionModel.source",
    );
    const contentSha256 = stringValue(
      object.contentSha256,
      "LocalSessionModel.source.contentSha256",
    );
    if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
      throw new LocalSessionSchemaError(
        "LocalSessionModel.source.contentSha256 must be lowercase SHA-256 hex.",
      );
    }
    return {
      kind,
      fileName: stringValue(object.fileName, "LocalSessionModel.source.fileName"),
      byteLength: nonNegativeSafeInteger(
        object.byteLength,
        "LocalSessionModel.source.byteLength",
      ),
      contentSha256,
    };
  }
  throw new LocalSessionSchemaError("LocalSessionModel.source.kind is unsupported.");
}

function parseHistoryEntry(value: unknown, path: string): LocalSessionHistoryEntry {
  const object = exactObject(value, ["revision", "document"], path);
  return {
    revision: parseRevision(object.revision, `${path}.revision`),
    document: parseDocument(object.document, `${path}.document`),
  };
}

function parseHistoryEntries(value: unknown, path: string): LocalSessionHistoryEntry[] {
  if (!Array.isArray(value)) {
    throw new LocalSessionSchemaError(`${path} must be an array.`);
  }
  return value.map((entry, index) => parseHistoryEntry(entry, `${path}[${index}]`));
}

export function parseLocalSessionModel(value: unknown): LocalSessionModel {
  const object = exactObject(
    value,
    ["contractVersion", "authority", "source", "document", "history"],
    "LocalSessionModel",
  );
  if (object.contractVersion !== LOCAL_SESSION_CONTRACT_VERSION) {
    throw new LocalSessionSchemaError("LocalSessionModel.contractVersion is unsupported.");
  }
  if (object.authority !== "local") {
    throw new LocalSessionSchemaError('LocalSessionModel.authority must be "local".');
  }
  const historyObject = exactObject(
    object.history,
    ["current", "undo", "redo"],
    "LocalSessionModel.history",
  );
  const history: LocalSessionHistory = {
    current: parseRevision(historyObject.current, "LocalSessionModel.history.current"),
    undo: parseHistoryEntries(historyObject.undo, "LocalSessionModel.history.undo"),
    redo: parseHistoryEntries(historyObject.redo, "LocalSessionModel.history.redo"),
  };
  const revisions = [
    history.current.sequence,
    ...history.undo.map((entry) => entry.revision.sequence),
    ...history.redo.map((entry) => entry.revision.sequence),
  ];
  if (new Set(revisions).size !== revisions.length) {
    throw new LocalSessionSchemaError("LocalSessionModel.history revisions must be unique.");
  }
  for (let index = 0; index < history.undo.length; index += 1) {
    const sequence = history.undo[index].revision.sequence;
    const previousSequence = history.undo[index - 1]?.revision.sequence;
    if (sequence >= history.current.sequence) {
      throw new LocalSessionSchemaError(
        "LocalSessionModel.history undo revisions must precede current.",
      );
    }
    if (previousSequence !== undefined && sequence <= previousSequence) {
      throw new LocalSessionSchemaError(
        "LocalSessionModel.history undo revisions must be strictly increasing.",
      );
    }
  }
  for (let index = 0; index < history.redo.length; index += 1) {
    const sequence = history.redo[index].revision.sequence;
    const previousSequence = history.redo[index - 1]?.revision.sequence;
    if (sequence <= history.current.sequence) {
      throw new LocalSessionSchemaError(
        "LocalSessionModel.history redo revisions must follow current.",
      );
    }
    if (previousSequence !== undefined && sequence >= previousSequence) {
      throw new LocalSessionSchemaError(
        "LocalSessionModel.history redo revisions must be strictly decreasing.",
      );
    }
  }
  return {
    contractVersion: LOCAL_SESSION_CONTRACT_VERSION,
    authority: "local",
    source: parseSource(object.source),
    document: parseDocument(object.document, "LocalSessionModel.document"),
    history,
  };
}

export function createLocalSessionModel(
  source: LocalSessionSource,
  document: LocalSessionDocument = { title: "", notes: "" },
): LocalSessionModel {
  return parseLocalSessionModel({
    contractVersion: LOCAL_SESSION_CONTRACT_VERSION,
    authority: "local",
    source,
    document,
    history: {
      current: { authority: "local_ephemeral", sequence: 0 },
      undo: [],
      redo: [],
    },
  });
}

function historyEntry(session: LocalSessionModel): LocalSessionHistoryEntry {
  return {
    revision: session.history.current,
    document: session.document,
  };
}

function sameDocument(left: LocalSessionDocument, right: LocalSessionDocument): boolean {
  return left.title === right.title && left.notes === right.notes;
}

export function reduceLocalSession(
  state: LocalSessionReducerState,
  action: LocalSessionReducerAction,
): LocalSessionReducerState {
  if (action.type === "activate_local_session") {
    return { status: "active", session: parseLocalSessionModel(action.session) };
  }
  if (action.type === "clear_local_session") {
    return { status: "empty" };
  }
  if (state.status === "empty") {
    return state;
  }
  const { session } = state;
  if (action.type === "commit_local_edit") {
    const document = parseDocument(action.document, "LocalSessionReducerAction.document");
    if (sameDocument(session.document, document)) {
      return state;
    }
    if (session.history.current.sequence === Number.MAX_SAFE_INTEGER) {
      throw new LocalSessionSchemaError("Local ephemeral revision sequence is exhausted.");
    }
    return {
      status: "active",
      session: {
        ...session,
        document,
        history: {
          current: {
            authority: "local_ephemeral",
            sequence: session.history.current.sequence + 1,
          },
          undo: [...session.history.undo, historyEntry(session)],
          redo: [],
        },
      },
    };
  }
  if (action.type === "undo_local_edit") {
    const target = session.history.undo.at(-1);
    if (!target) return state;
    return {
      status: "active",
      session: {
        ...session,
        document: target.document,
        history: {
          current: target.revision,
          undo: session.history.undo.slice(0, -1),
          redo: [...session.history.redo, historyEntry(session)],
        },
      },
    };
  }
  const target = session.history.redo.at(-1);
  if (!target) return state;
  return {
    status: "active",
    session: {
      ...session,
      document: target.document,
      history: {
        current: target.revision,
        undo: [...session.history.undo, historyEntry(session)],
        redo: session.history.redo.slice(0, -1),
      },
    },
  };
}

export function buildLocalActionAvailabilityMap(
  state: LocalSessionReducerState,
): LocalActionAvailabilityMap {
  const active = state.status === "active";
  return Object.fromEntries(
    LOCAL_ACTION_CODES.map((action) => {
      const needsActiveSession = action === "edit_local_session" || action === "clear_local_session";
      const enabled = !needsActiveSession || active;
      return [
        action,
        {
          contractVersion: LOCAL_ACTION_CONTRACT_VERSION,
          action,
          enabled,
          ...(!enabled
            ? {
                disabledReasonCode: "LOCAL_SESSION_NOT_ACTIVE",
                disabledReasonText: "当前标签页没有可编辑的本地会话。",
              }
            : {}),
        },
      ];
    }),
  ) as LocalActionAvailabilityMap;
}
