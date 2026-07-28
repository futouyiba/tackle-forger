import type {
  CanonicalRuleWorkbookParsedInspection,
} from "./canonical-workbook-core";
import {
  createLocalSessionModel,
  parseLocalSessionModel,
  type LocalEditableItemPart,
  type LocalEditableRule,
  type LocalSessionDocument,
  type LocalSessionModel,
} from "./local-session-contracts";
import type { BrowserCanonicalWorkbookWarning } from "./browser-canonical-workbook";

export const LOCAL_SESSION_WORKBOOK_CONTRACT_VERSION =
  "local-session-canonical-workbook/open009-v2" as const;
export const LOCAL_SESSION_PARSER_REQUEST = "parse_local_canonical_workbook" as const;

export interface LocalSessionRulesTemplateProjection {
  contractVersion: typeof LOCAL_SESSION_WORKBOOK_CONTRACT_VERSION;
  semanticRevision: string;
  warnings: BrowserCanonicalWorkbookWarning[];
  identityRows: CanonicalRuleWorkbookParsedInspection["identityRows"];
  identityReport: CanonicalRuleWorkbookParsedInspection["identityReport"];
  editableDocument: LocalSessionDocument;
}

export interface LocalSessionParsedWorkbook {
  session: LocalSessionModel;
  workbook: LocalSessionRulesTemplateProjection;
}

export interface LocalSessionParserRequest {
  type: typeof LOCAL_SESSION_PARSER_REQUEST;
  generation: number;
  operationId: string;
  resourceHandle: string;
  fileName: string;
  byteLength: number;
  contentSha256: string;
  observedAt: string;
  bytes: ArrayBuffer;
}

export type LocalSessionParserWorkerResponse =
  | {
      type: "parsed_local_canonical_workbook";
      generation: number;
      operationId: string;
      resourceHandle: string;
      result: LocalSessionParsedWorkbook;
    }
  | {
      type: "local_canonical_workbook_failed";
      generation: number;
      operationId: string;
      resourceHandle: string;
      error: {
        code: string;
        message: string;
      };
    };

export function projectLocalRulesTemplateWorkbook(input: {
  inspection: CanonicalRuleWorkbookParsedInspection;
  warnings: BrowserCanonicalWorkbookWarning[];
}): LocalSessionRulesTemplateProjection {
  const { inspection } = input;
  const editableDocument = editableDocumentFromInspection(inspection, input.warnings);
  return {
    contractVersion: LOCAL_SESSION_WORKBOOK_CONTRACT_VERSION,
    semanticRevision: inspection.sourceRevision.sourceRevision,
    warnings: input.warnings,
    identityRows: inspection.identityRows,
    identityReport: inspection.identityReport,
    editableDocument,
  };
}

function localItemPart(value: string | undefined): LocalEditableItemPart {
  if (value === "part:reel" || value === "reel") return "reel";
  if (value === "part:line" || value === "line") return "line";
  if (value === "part:rod" || value === "rod") return "rod";
  throw new TypeError("Canonical local projection is missing an explicit rod/reel/line part.");
}

function editableDocumentFromInspection(
  inspection: CanonicalRuleWorkbookParsedInspection,
  warnings: BrowserCanonicalWorkbookWarning[],
): LocalSessionDocument {
  const draft = inspection.canonicalRuleDraft;
  let sequence = 0;
  const rules: LocalEditableRule[] = [];
  const appendRules = (
    sourceKind: LocalEditableRule["sourceKind"],
    sourceId: string,
    sourceName: string,
    entries: typeof draft.methodProfiles[number]["rules"],
    enabled: boolean,
  ) => {
    for (const entry of entries) {
      rules.push({
        id: `${sourceKind}:${sourceId}:${entry.id}`,
        sourceKind,
        sourceId,
        sourceName,
        sequence,
        parameterKey: entry.parameterKey,
        operation: entry.operation,
        value: entry.value,
        condition: entry.condition ?? "",
        notes: enabled
          ? entry.notes ?? ""
          : `${entry.notes ?? ""}${entry.notes ? "；" : ""}导入时未绑定选择上下文，默认停用。`,
        enabled,
      });
      sequence += 1;
    }
  };
  for (const profile of draft.methodProfiles) {
    appendRules("method", profile.id, profile.name, profile.rules, false);
  }
  for (const profile of draft.itemTypeProfiles) {
    appendRules("item_type", profile.id, profile.name, profile.rules, false);
  }
  for (const profile of draft.functionProfiles) {
    appendRules("function", profile.id, profile.name, profile.rules, false);
    for (const intensity of profile.intensityRules) {
      appendRules(
        "function",
        `${profile.id}:intensity:${intensity.intensity}:${intensity.itemPartId ?? "legacy"}`,
        `${profile.name} · 强度 ${intensity.intensity}`,
        intensity.rules,
        false,
      );
    }
  }
  for (const modifier of draft.modifiers) {
    appendRules("modifier", modifier.id, modifier.name, modifier.rules, false);
  }
  for (const layer of draft.layers) {
    appendRules("layer", layer.id, layer.name, layer.rules, layer.enabled);
  }
  const sourceIssues = [
    ...draft.issues.map((issue) => ({
      severity: issue.level,
      code: issue.code,
      path: issue.sheetId
        ? `canonical.${issue.sheetId}${issue.row ? `.row.${issue.row}` : ""}`
        : "canonical.workbook",
      message: issue.message,
    })),
    ...warnings.map((warning) => ({
      severity: "warning" as const,
      code: warning.code,
      path: `canonical.unregistered-sheet.${warning.sheetName}`,
      message: warning.message,
    })),
  ];
  const uniqueSourceIssues = [...new Map(
    sourceIssues.map((issue) => [
      `${issue.severity}\u0000${issue.code}\u0000${issue.path}\u0000${issue.message}`,
      issue,
    ]),
  ).values()];
  return {
    title: "WQ8w 本地规则与模板",
    notes: `仅内存编辑；源语义修订 ${inspection.sourceRevision.sourceRevision}`,
    sourceIssues: uniqueSourceIssues,
    parameters: draft.parameters.map((parameter, index) => ({
      id: parameter.id ?? `parameter:${index}:${parameter.key}`,
      key: parameter.key,
      label: parameter.label,
      itemPart: localItemPart(parameter.itemPartId ?? parameter.itemKind),
      unit: parameter.unit,
      precision: parameter.precision,
      notes: parameter.notes,
    })),
    templates: draft.templates.map((template) => ({
      id: template.id,
      name: template.name,
      itemPart: localItemPart(template.itemPartId),
      targetPullMinKgf: template.targetPullMinKgf ?? template.fishMinKg,
      targetPullMaxKgf: template.targetPullMaxKgf ?? template.fishMaxKg,
      nominalTargetPullKgf: template.nominalTargetPullKgf ?? template.nominalFishKg,
      values: { ...template.values },
      notes: template.notes,
    })),
    rules,
  };
}

export function createLocalSessionParsedWorkbook(input: {
  fileName: string;
  byteLength: number;
  contentSha256: string;
  inspection: CanonicalRuleWorkbookParsedInspection;
  warnings: BrowserCanonicalWorkbookWarning[];
}): LocalSessionParsedWorkbook {
  return {
    workbook: projectLocalRulesTemplateWorkbook(input),
    session: createLocalSessionModel(
      {
        kind: "local_excel",
        fileName: input.fileName,
        byteLength: input.byteLength,
        contentSha256: input.contentSha256,
      },
      editableDocumentFromInspection(input.inspection, input.warnings),
    ),
  };
}

function exactObject(
  value: unknown,
  allowedKeys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new TypeError(`${path} contains unknown field "${key}".`);
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(object, key)) throw new TypeError(`${path} is missing field "${key}".`);
  }
  return object;
}

function parseProjection(value: unknown): LocalSessionRulesTemplateProjection {
  const object = exactObject(
    value,
    [
      "contractVersion",
      "semanticRevision",
      "warnings",
      "identityRows",
      "identityReport",
      "editableDocument",
    ],
    "LocalSessionRulesTemplateProjection",
  );
  if (object.contractVersion !== LOCAL_SESSION_WORKBOOK_CONTRACT_VERSION) {
    throw new TypeError("LocalSessionRulesTemplateProjection.contractVersion is unsupported.");
  }
  if (
    typeof object.semanticRevision !== "string"
    || !/^[a-f0-9]{8}$/.test(object.semanticRevision)
  ) {
    throw new TypeError(
      "LocalSessionRulesTemplateProjection.semanticRevision must be lowercase deterministic hex.",
    );
  }
  if (!Array.isArray(object.warnings) || !Array.isArray(object.identityRows)) {
    throw new TypeError("Local-session workbook arrays are invalid.");
  }
  for (const field of ["identityReport"] as const) {
    if (!object[field] || typeof object[field] !== "object" || Array.isArray(object[field])) {
      throw new TypeError(`LocalSessionRulesTemplateProjection.${field} must be an object.`);
    }
  }
  return {
    ...object,
    editableDocument: parseLocalSessionModel({
      contractVersion: "local-session/open009-v2",
      authority: "local",
      source: { kind: "temporary_workspace" },
      document: object.editableDocument,
      history: {
        current: { authority: "local_ephemeral", sequence: 0 },
        undo: [],
        redo: [],
      },
    }).document,
  } as LocalSessionRulesTemplateProjection;
}

export function parseLocalSessionParsedWorkbook(value: unknown): LocalSessionParsedWorkbook {
  const object = exactObject(value, ["session", "workbook"], "LocalSessionParsedWorkbook");
  const session = parseLocalSessionModel(object.session);
  const workbook = parseProjection(object.workbook);
  if (JSON.stringify(session.document) !== JSON.stringify(workbook.editableDocument)) {
    throw new TypeError(
      "LocalSessionParsedWorkbook session and workbook documents must match.",
    );
  }
  return { session, workbook };
}

export function parseLocalSessionParserWorkerResponse(
  value: unknown,
): LocalSessionParserWorkerResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Worker response must be an object.");
  }
  const type = (value as Record<string, unknown>).type;
  if (type === "parsed_local_canonical_workbook") {
    const object = exactObject(
      value,
      ["type", "generation", "operationId", "resourceHandle", "result"],
      "Worker response",
    );
    if (!Number.isSafeInteger(object.generation) || (object.generation as number) < 1) {
      throw new TypeError("Worker response generation is invalid.");
    }
    return {
      type,
      generation: object.generation as number,
      operationId: nonEmptyString(object.operationId, "Worker response.operationId"),
      resourceHandle: nonEmptyString(
        object.resourceHandle,
        "Worker response.resourceHandle",
      ),
      result: parseLocalSessionParsedWorkbook(object.result),
    };
  }
  if (type === "local_canonical_workbook_failed") {
    const object = exactObject(
      value,
      ["type", "generation", "operationId", "resourceHandle", "error"],
      "Worker response",
    );
    const error = exactObject(object.error, ["code", "message"], "Worker response error");
    if (
      !Number.isSafeInteger(object.generation)
      || (object.generation as number) < 1
      || typeof error.code !== "string"
      || error.code.length === 0
      || typeof error.message !== "string"
      || error.message.length === 0
    ) {
      throw new TypeError("Worker response error payload is invalid.");
    }
    return {
      type,
      generation: object.generation as number,
      operationId: nonEmptyString(object.operationId, "Worker response.operationId"),
      resourceHandle: nonEmptyString(
        object.resourceHandle,
        "Worker response.resourceHandle",
      ),
      error: { code: error.code, message: error.message },
    };
  }
  throw new TypeError("Worker response type is unsupported.");
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}
