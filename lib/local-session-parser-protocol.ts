import type {
  CanonicalRuleWorkbookParsedInspection,
} from "./canonical-workbook-core";
import {
  createLocalSessionModel,
  parseLocalSessionModel,
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
  canonicalRuleDraft: CanonicalRuleWorkbookParsedInspection["canonicalRuleDraft"];
  weightTemplateDraft: CanonicalRuleWorkbookParsedInspection["weightTemplateDraft"];
  qualityDraft: CanonicalRuleWorkbookParsedInspection["qualityDraft"];
  pricingDraft: CanonicalRuleWorkbookParsedInspection["pricingDraft"];
  pricingWeightBandPolicy: CanonicalRuleWorkbookParsedInspection["pricingWeightBandPolicy"];
}

export interface LocalSessionParsedWorkbook {
  session: LocalSessionModel;
  workbook: LocalSessionRulesTemplateProjection;
}

export interface LocalSessionParserRequest {
  type: typeof LOCAL_SESSION_PARSER_REQUEST;
  generation: number;
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
      result: LocalSessionParsedWorkbook;
    }
  | {
      type: "local_canonical_workbook_failed";
      generation: number;
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
  return {
    contractVersion: LOCAL_SESSION_WORKBOOK_CONTRACT_VERSION,
    semanticRevision: inspection.sourceRevision.sourceRevision,
    warnings: input.warnings,
    identityRows: inspection.identityRows,
    identityReport: inspection.identityReport,
    canonicalRuleDraft: inspection.canonicalRuleDraft,
    weightTemplateDraft: inspection.weightTemplateDraft,
    qualityDraft: inspection.qualityDraft,
    pricingDraft: inspection.pricingDraft,
    pricingWeightBandPolicy: inspection.pricingWeightBandPolicy,
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
    session: createLocalSessionModel({
      kind: "local_excel",
      fileName: input.fileName,
      byteLength: input.byteLength,
      contentSha256: input.contentSha256,
    }),
    workbook: projectLocalRulesTemplateWorkbook(input),
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
      "canonicalRuleDraft",
      "weightTemplateDraft",
      "qualityDraft",
      "pricingDraft",
      "pricingWeightBandPolicy",
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
  if (object.pricingWeightBandPolicy !== "MATCHED_STRUCTURAL_SOURCE_BAND") {
    throw new TypeError("Local-session pricing weight-band policy is unsupported.");
  }
  for (const field of [
    "identityReport",
    "canonicalRuleDraft",
    "weightTemplateDraft",
    "qualityDraft",
    "pricingDraft",
  ] as const) {
    if (!object[field] || typeof object[field] !== "object" || Array.isArray(object[field])) {
      throw new TypeError(`LocalSessionRulesTemplateProjection.${field} must be an object.`);
    }
  }
  return object as unknown as LocalSessionRulesTemplateProjection;
}

export function parseLocalSessionParsedWorkbook(value: unknown): LocalSessionParsedWorkbook {
  const object = exactObject(value, ["session", "workbook"], "LocalSessionParsedWorkbook");
  return {
    session: parseLocalSessionModel(object.session),
    workbook: parseProjection(object.workbook),
  };
}

export function parseLocalSessionParserWorkerResponse(
  value: unknown,
): LocalSessionParserWorkerResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Worker response must be an object.");
  }
  const type = (value as Record<string, unknown>).type;
  if (type === "parsed_local_canonical_workbook") {
    const object = exactObject(value, ["type", "generation", "result"], "Worker response");
    if (!Number.isSafeInteger(object.generation) || (object.generation as number) < 1) {
      throw new TypeError("Worker response generation is invalid.");
    }
    return {
      type,
      generation: object.generation as number,
      result: parseLocalSessionParsedWorkbook(object.result),
    };
  }
  if (type === "local_canonical_workbook_failed") {
    const object = exactObject(value, ["type", "generation", "error"], "Worker response");
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
      error: { code: error.code, message: error.message },
    };
  }
  throw new TypeError("Worker response type is unsupported.");
}
