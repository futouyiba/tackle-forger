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

export type LocalEditableItemPart = "rod" | "reel" | "line";
export type LocalEditableRuleOperation =
  | "add"
  | "multiply"
  | "set"
  | "min"
  | "max"
  | "formula";

export interface LocalEditableParameter {
  id: string;
  key: string;
  label: string;
  itemPart: LocalEditableItemPart;
  unit: string;
  precision: number;
  notes: string;
}

export interface LocalEditableTemplate {
  id: string;
  name: string;
  itemPart: LocalEditableItemPart;
  targetPullMinKgf: number;
  targetPullMaxKgf: number;
  nominalTargetPullKgf: number;
  values: Record<string, number | string>;
  notes: string;
}

export interface LocalEditableRule {
  id: string;
  sourceKind: "method" | "item_type" | "function" | "modifier" | "layer";
  sourceId: string;
  sourceName: string;
  sequence: number;
  parameterKey: string;
  operation: LocalEditableRuleOperation;
  value: number | string;
  condition: string;
  notes: string;
  enabled: boolean;
}

export interface LocalSessionDocument {
  title: string;
  notes: string;
  parameters: LocalEditableParameter[];
  templates: LocalEditableTemplate[];
  rules: LocalEditableRule[];
}

export type LocalSessionDocumentInput =
  | LocalSessionDocument
  | { title: string; notes: string };

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
  | { type: "commit_local_edit"; document: LocalSessionDocumentInput }
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

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LocalSessionSchemaError(`${path} must be a finite number.`);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new LocalSessionSchemaError(`${path} must be a boolean.`);
  }
  return value;
}

function itemPart(value: unknown, path: string): LocalEditableItemPart {
  if (value !== "rod" && value !== "reel" && value !== "line") {
    throw new LocalSessionSchemaError(`${path} must be rod, reel or line.`);
  }
  return value;
}

function ruleOperation(value: unknown, path: string): LocalEditableRuleOperation {
  if (
    value !== "add"
    && value !== "multiply"
    && value !== "set"
    && value !== "min"
    && value !== "max"
    && value !== "formula"
  ) {
    throw new LocalSessionSchemaError(`${path} is unsupported.`);
  }
  return value;
}

function stringOrFiniteNumber(value: unknown, path: string): string | number {
  return typeof value === "string" ? value : finiteNumber(value, path);
}

function parseParameter(value: unknown, path: string): LocalEditableParameter {
  const object = exactObject(
    value,
    ["id", "key", "label", "itemPart", "unit", "precision", "notes"],
    path,
  );
  return {
    id: stringValue(object.id, `${path}.id`),
    key: stringValue(object.key, `${path}.key`),
    label: stringValue(object.label, `${path}.label`),
    itemPart: itemPart(object.itemPart, `${path}.itemPart`),
    unit: stringValue(object.unit, `${path}.unit`),
    precision: nonNegativeSafeInteger(object.precision, `${path}.precision`),
    notes: stringValue(object.notes, `${path}.notes`),
  };
}

function parseTemplate(value: unknown, path: string): LocalEditableTemplate {
  const object = exactObject(
    value,
    [
      "id",
      "name",
      "itemPart",
      "targetPullMinKgf",
      "targetPullMaxKgf",
      "nominalTargetPullKgf",
      "values",
      "notes",
    ],
    path,
  );
  const rawValues = object.values;
  if (!rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) {
    throw new LocalSessionSchemaError(`${path}.values must be an object.`);
  }
  const values = Object.fromEntries(
    Object.entries(rawValues).map(([key, entry]) => [
      key,
      stringOrFiniteNumber(entry, `${path}.values.${key}`),
    ]),
  );
  return {
    id: stringValue(object.id, `${path}.id`),
    name: stringValue(object.name, `${path}.name`),
    itemPart: itemPart(object.itemPart, `${path}.itemPart`),
    targetPullMinKgf: finiteNumber(object.targetPullMinKgf, `${path}.targetPullMinKgf`),
    targetPullMaxKgf: finiteNumber(object.targetPullMaxKgf, `${path}.targetPullMaxKgf`),
    nominalTargetPullKgf: finiteNumber(
      object.nominalTargetPullKgf,
      `${path}.nominalTargetPullKgf`,
    ),
    values,
    notes: stringValue(object.notes, `${path}.notes`),
  };
}

function parseRule(value: unknown, path: string): LocalEditableRule {
  const object = exactObject(
    value,
    [
      "id",
      "sourceKind",
      "sourceId",
      "sourceName",
      "sequence",
      "parameterKey",
      "operation",
      "value",
      "condition",
      "notes",
      "enabled",
    ],
    path,
  );
  const sourceKind = object.sourceKind;
  if (
    sourceKind !== "method"
    && sourceKind !== "item_type"
    && sourceKind !== "function"
    && sourceKind !== "modifier"
    && sourceKind !== "layer"
  ) {
    throw new LocalSessionSchemaError(`${path}.sourceKind is unsupported.`);
  }
  return {
    id: stringValue(object.id, `${path}.id`),
    sourceKind,
    sourceId: stringValue(object.sourceId, `${path}.sourceId`),
    sourceName: stringValue(object.sourceName, `${path}.sourceName`),
    sequence: nonNegativeSafeInteger(object.sequence, `${path}.sequence`),
    parameterKey: stringValue(object.parameterKey, `${path}.parameterKey`),
    operation: ruleOperation(object.operation, `${path}.operation`),
    value: stringOrFiniteNumber(object.value, `${path}.value`),
    condition: stringValue(object.condition, `${path}.condition`),
    notes: stringValue(object.notes, `${path}.notes`),
    enabled: booleanValue(object.enabled, `${path}.enabled`),
  };
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
  const object = exactObject(
    value,
    ["title", "notes", "parameters", "templates", "rules"],
    path,
  );
  if (
    !Array.isArray(object.parameters)
    || !Array.isArray(object.templates)
    || !Array.isArray(object.rules)
  ) {
    throw new LocalSessionSchemaError(`${path} allowlist collections must be arrays.`);
  }
  return {
    title: stringValue(object.title, `${path}.title`),
    notes: stringValue(object.notes, `${path}.notes`),
    parameters: object.parameters.map((entry, index) =>
      parseParameter(entry, `${path}.parameters[${index}]`)),
    templates: object.templates.map((entry, index) =>
      parseTemplate(entry, `${path}.templates[${index}]`)),
    rules: object.rules.map((entry, index) =>
      parseRule(entry, `${path}.rules[${index}]`)),
  };
}

function normalizeDocumentInput(
  value: LocalSessionDocumentInput,
  path: string,
): LocalSessionDocument {
  if (
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => key === "title" || key === "notes")
  ) {
    return parseDocument(
      { ...value, parameters: [], templates: [], rules: [] },
      path,
    );
  }
  return parseDocument(value, path);
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
  document: LocalSessionDocumentInput = {
    title: "",
    notes: "",
    parameters: [],
    templates: [],
    rules: [],
  },
): LocalSessionModel {
  return parseLocalSessionModel({
    contractVersion: LOCAL_SESSION_CONTRACT_VERSION,
    authority: "local",
    source,
    document: normalizeDocumentInput(document, "LocalSessionModel.document"),
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
  return JSON.stringify(left) === JSON.stringify(right);
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
    const document = normalizeDocumentInput(
      action.document,
      "LocalSessionReducerAction.document",
    );
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
