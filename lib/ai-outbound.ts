import { createHash } from "node:crypto";

export const AI_REQUEST_SCHEMA_VERSION = "ai-request/v1" as const;
export const AI_PROVIDER_POLICY_VERSION = "ai-provider/open006-v1" as const;
export const AI_REQUEST_MAX_BYTES = 131_072;

export type SafeCode = string;
export type RequestAlias = string;
export type Sha256Hex = string;
export type SafeValue =
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "enum"; value: SafeCode }
  | { kind: "null"; value: null };

export interface AIModelRevisionSetV1 {
  modelVersion?: SafeCode;
  deploymentRevision?: SafeCode;
  modelArtifactDigest?: SafeCode;
}

export interface AIModelDescriptorV1 {
  provider: "fancy_hub";
  modelId: SafeCode;
  revisions: AIModelRevisionSetV1;
  revisionIdentityHash: Sha256Hex;
  modelListSnapshotHash: Sha256Hex;
}

export type AliasReferenceKindV1 =
  | "adjustment_patch" | "affinity_axis" | "assessment" | "collection"
  | "configuration_snapshot" | "evidence" | "five_axis" | "five_axis_component"
  | "hard_compatibility" | "model" | "model_candidate" | "revision" | "rule"
  | "rule_source_change_draft" | "rule_source_version" | "ruleset_version"
  | "series" | "series_invariant" | "sku_drawer" | "trace"
  | "upgrade_candidate" | "validation_issue";

export interface LocalAliasReferenceV1 {
  referenceKindCode: AliasReferenceKindV1;
  stableLocalId: string;
  stableRevisionId?: string;
}

export interface AIRequestEnvelopeV1 {
  schemaVersion: typeof AI_REQUEST_SCHEMA_VERSION;
  policyVersion: typeof AI_PROVIDER_POLICY_VERSION;
  promptTemplateVersion: SafeCode;
  promptTemplateHash: Sha256Hex;
  assessmentAlias: RequestAlias;
  analysisIntent: "explain_conflicts" | "prioritize_findings" | "suggest_tradeoffs"
    | "compare_candidates" | "draft_model_patch" | "draft_rule_change";
  model: AIModelDescriptorV1;
  scope: {
    scopeType: "series" | "sku" | "model" | "candidate_set";
    scopeAlias: RequestAlias;
    revisionAlias: RequestAlias;
  };
  panelValues: Array<{
    subjectAlias: RequestAlias; parameterKey: SafeCode; value: SafeValue; unitCode?: SafeCode;
  }>;
  traces: Array<{
    subjectAlias: RequestAlias; parameterKey: SafeCode; sequence: number;
    layerCode: SafeCode; sourceAlias: RequestAlias; sourceVersionAlias: RequestAlias;
    operationCode: SafeCode; before: SafeValue; operand: SafeValue; after: SafeValue;
    effectCode: "benefit" | "cost" | "neutral" | "contextual";
    warningCodes: SafeCode[];
  }>;
  patches: Array<{
    patchAlias: RequestAlias; patchRevisionAlias: RequestAlias;
    chainIndex: number; operationIndex: number;
    scopeType: "series" | "sku" | "model" | "final_review";
    subjectAlias: RequestAlias; parameterKey: SafeCode;
    operation: "set" | "add" | "multiply" | "clear";
    operand: SafeValue; before: SafeValue; after: SafeValue;
  }>;
  compatibility: Array<{
    subjectAlias: RequestAlias; result: "allow" | "deny" | "require";
    ruleCode: SafeCode; parameterKeys: SafeCode[]; conditionCodes: SafeCode[];
  }>;
  affinity: Array<{
    subjectAlias: RequestAlias; axisCode: SafeCode; ruleCode: SafeCode;
    score: number; weight: number; weightedContribution: number;
  }>;
  invariants: Array<{
    subjectAlias: RequestAlias; invariantCode: SafeCode; parameterKey?: SafeCode;
    expectedDirection?: "positive" | "negative" | "neutral" | "contextual";
    expected?: SafeValue; actual?: SafeValue;
  }>;
  fiveAxis: Array<{
    subjectAlias: RequestAlias; axisCode: SafeCode; componentAlias?: RequestAlias;
    source: "direct" | "context_inherited" | "not_applicable" | "missing" | "error";
    rawValue?: number; normalizedRatio?: number; officialDisplayScore?: number;
    comparisonScore?: number;
  }>;
  evidenceRefs: Array<{
    evidenceType: "trace" | "validation_issue" | "hard_compatibility" | "affinity_axis"
      | "series_invariant" | "five_axis" | "rule" | "snapshot";
    evidenceAlias: RequestAlias; contentHash: Sha256Hex;
  }>;
}

export type AIOutboundErrorCode =
  | "AI_ALIAS_IDENTITY_CONFLICT"
  | "AI_ALIAS_REFERENCE_INVALID"
  | "AI_MODEL_REVISION_UNAVAILABLE"
  | "AI_PAYLOAD_DUPLICATE_ELEMENT"
  | "AI_PAYLOAD_LIMIT_EXCEEDED"
  | "AI_PAYLOAD_SCHEMA_REJECTED"
  | "AI_PATCH_ORDER_CONFLICT"
  | "AI_PROMPT_TEMPLATE_VERSION_CONFLICT"
  | "AI_SECRET_DETECTED"
  | "AI_TRACE_SEQUENCE_CONFLICT";

export class AIOutboundError extends Error {
  constructor(public readonly code: AIOutboundErrorCode, message: string) {
    super(message);
    this.name = "AIOutboundError";
  }
}

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,128}$/;
const REQUEST_ALIAS = /^[a-z][0-9]{3,7}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_INTEGER = 1_000_000;

const ARRAY_LIMITS = {
  panelValues: 256,
  traces: 1_000,
  patches: 256,
  compatibility: 256,
  affinity: 64,
  invariants: 256,
  fiveAxis: 128,
  evidenceRefs: 256,
} as const;

function failSchema(message: string): never {
  throw new AIOutboundError("AI_PAYLOAD_SCHEMA_REJECTED", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) failSchema(`${label} 必须是普通对象。`);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) failSchema(`${label}.${key} 缺失。`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failSchema(`${label}.${key} 是未授权字段。`);
  }
  for (const key of optional) {
    if (Object.hasOwn(value, key) && value[key] === undefined) {
      failSchema(`${label}.${key} 不能显式传入 undefined。`);
    }
  }
  if (requiredSet.size !== required.length) failSchema(`${label} Schema 定义无效。`);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") failSchema(`${label} 必须是字符串。`);
  assertValidUnicode(value, label);
}

function assertValidUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) failSchema(`${label} 包含无效 Unicode。`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      failSchema(`${label} 包含无效 Unicode。`);
    }
  }
}

function assertSafeCode(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!SAFE_CODE.test(value)) failSchema(`${label} 不是 SafeCode。`);
}

function assertAlias(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!REQUEST_ALIAS.test(value)) failSchema(`${label} 不是请求级别名。`);
}

function assertHash(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!SHA256_HEX.test(value)) failSchema(`${label} 不是小写 SHA-256。`);
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) failSchema(`${label} 必须是有限数。`);
}

function assertBoundedInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_INTEGER) {
    failSchema(`${label} 必须是 0..${MAX_INTEGER} 的整数。`);
  }
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): asserts value is T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    failSchema(`${label} 枚举值无效。`);
  }
}

function validateSafeValue(value: unknown, label: string): asserts value is SafeValue {
  assertObject(value, label);
  assertExactKeys(value, ["kind", "value"], [], label);
  assertEnum(value.kind, ["number", "boolean", "enum", "null"] as const, `${label}.kind`);
  switch (value.kind) {
    case "number": assertFiniteNumber(value.value, `${label}.value`); break;
    case "boolean": if (typeof value.value !== "boolean") failSchema(`${label}.value 必须是 boolean。`); break;
    case "enum": assertSafeCode(value.value, `${label}.value`); break;
    case "null": if (value.value !== null) failSchema(`${label}.value 必须是 null。`); break;
  }
}

function validateCodeArray(value: unknown, label: string): asserts value is SafeCode[] {
  if (!Array.isArray(value)) failSchema(`${label} 必须是数组。`);
  if (value.length > 32) {
    throw new AIOutboundError("AI_PAYLOAD_LIMIT_EXCEEDED", `${label} 超过 32 项。`);
  }
  value.forEach((entry, index) => assertSafeCode(entry, `${label}[${index}]`));
}

function validateModelDescriptor(value: unknown, label: string): asserts value is AIModelDescriptorV1 {
  assertObject(value, label);
  assertExactKeys(value, ["provider", "modelId", "revisions", "revisionIdentityHash", "modelListSnapshotHash"], [], label);
  if (value.provider !== "fancy_hub") failSchema(`${label}.provider 只能是 fancy_hub。`);
  assertSafeCode(value.modelId, `${label}.modelId`);
  assertObject(value.revisions, `${label}.revisions`);
  assertExactKeys(value.revisions, [], ["modelVersion", "deploymentRevision", "modelArtifactDigest"], `${label}.revisions`);
  const revisionValues = [value.revisions.modelVersion, value.revisions.deploymentRevision, value.revisions.modelArtifactDigest]
    .filter((entry) => entry !== undefined);
  if (!revisionValues.length) {
    throw new AIOutboundError("AI_MODEL_REVISION_UNAVAILABLE", `${label} 缺少不可变模型修订。`);
  }
  revisionValues.forEach((entry, index) => assertSafeCode(entry, `${label}.revisions[${index}]`));
  assertHash(value.revisionIdentityHash, `${label}.revisionIdentityHash`);
  assertHash(value.modelListSnapshotHash, `${label}.modelListSnapshotHash`);
  const actualRevisionHash = sha256Hex(jcsCanonicalize(value.revisions));
  if (actualRevisionHash !== value.revisionIdentityHash) failSchema(`${label}.revisionIdentityHash 与 revisions 不一致。`);
}

function validateArray(value: unknown, label: keyof typeof ARRAY_LIMITS): asserts value is unknown[] {
  if (!Array.isArray(value)) failSchema(`${label} 必须是数组。`);
  if (value.length > ARRAY_LIMITS[label]) {
    throw new AIOutboundError("AI_PAYLOAD_LIMIT_EXCEEDED", `${label} 超过 ${ARRAY_LIMITS[label]} 项。`);
  }
}

export function validateAIRequestEnvelope(value: unknown): asserts value is AIRequestEnvelopeV1 {
  assertObject(value, "envelope");
  assertExactKeys(value, [
    "schemaVersion", "policyVersion", "promptTemplateVersion", "promptTemplateHash",
    "assessmentAlias", "analysisIntent", "model", "scope", "panelValues", "traces",
    "patches", "compatibility", "affinity", "invariants", "fiveAxis", "evidenceRefs",
  ], [], "envelope");
  if (value.schemaVersion !== AI_REQUEST_SCHEMA_VERSION) failSchema("schemaVersion 不受支持。");
  if (value.policyVersion !== AI_PROVIDER_POLICY_VERSION) failSchema("policyVersion 不受支持。");
  assertSafeCode(value.promptTemplateVersion, "promptTemplateVersion");
  assertHash(value.promptTemplateHash, "promptTemplateHash");
  assertAlias(value.assessmentAlias, "assessmentAlias");
  assertEnum(value.analysisIntent, ["explain_conflicts", "prioritize_findings", "suggest_tradeoffs", "compare_candidates", "draft_model_patch", "draft_rule_change"] as const, "analysisIntent");
  validateModelDescriptor(value.model, "model");
  assertObject(value.scope, "scope");
  assertExactKeys(value.scope, ["scopeType", "scopeAlias", "revisionAlias"], [], "scope");
  assertEnum(value.scope.scopeType, ["series", "sku", "model", "candidate_set"] as const, "scope.scopeType");
  assertAlias(value.scope.scopeAlias, "scope.scopeAlias");
  assertAlias(value.scope.revisionAlias, "scope.revisionAlias");

  validateArray(value.panelValues, "panelValues");
  value.panelValues.forEach((raw, index) => {
    const label = `panelValues[${index}]`; assertObject(raw, label);
    assertExactKeys(raw, ["subjectAlias", "parameterKey", "value"], ["unitCode"], label);
    assertAlias(raw.subjectAlias, `${label}.subjectAlias`); assertSafeCode(raw.parameterKey, `${label}.parameterKey`);
    validateSafeValue(raw.value, `${label}.value`); if (raw.unitCode !== undefined) assertSafeCode(raw.unitCode, `${label}.unitCode`);
  });
  validateArray(value.traces, "traces");
  value.traces.forEach((raw, index) => {
    const label = `traces[${index}]`; assertObject(raw, label);
    assertExactKeys(raw, ["subjectAlias", "parameterKey", "sequence", "layerCode", "sourceAlias", "sourceVersionAlias", "operationCode", "before", "operand", "after", "effectCode", "warningCodes"], [], label);
    assertAlias(raw.subjectAlias, `${label}.subjectAlias`); assertSafeCode(raw.parameterKey, `${label}.parameterKey`); assertBoundedInteger(raw.sequence, `${label}.sequence`);
    assertSafeCode(raw.layerCode, `${label}.layerCode`); assertAlias(raw.sourceAlias, `${label}.sourceAlias`); assertAlias(raw.sourceVersionAlias, `${label}.sourceVersionAlias`); assertSafeCode(raw.operationCode, `${label}.operationCode`);
    validateSafeValue(raw.before, `${label}.before`); validateSafeValue(raw.operand, `${label}.operand`); validateSafeValue(raw.after, `${label}.after`);
    assertEnum(raw.effectCode, ["benefit", "cost", "neutral", "contextual"] as const, `${label}.effectCode`); validateCodeArray(raw.warningCodes, `${label}.warningCodes`);
  });
  validateArray(value.patches, "patches");
  value.patches.forEach((raw, index) => {
    const label = `patches[${index}]`; assertObject(raw, label);
    assertExactKeys(raw, ["patchAlias", "patchRevisionAlias", "chainIndex", "operationIndex", "scopeType", "subjectAlias", "parameterKey", "operation", "operand", "before", "after"], [], label);
    assertAlias(raw.patchAlias, `${label}.patchAlias`); assertAlias(raw.patchRevisionAlias, `${label}.patchRevisionAlias`); assertBoundedInteger(raw.chainIndex, `${label}.chainIndex`); assertBoundedInteger(raw.operationIndex, `${label}.operationIndex`);
    assertEnum(raw.scopeType, ["series", "sku", "model", "final_review"] as const, `${label}.scopeType`); assertAlias(raw.subjectAlias, `${label}.subjectAlias`); assertSafeCode(raw.parameterKey, `${label}.parameterKey`);
    assertEnum(raw.operation, ["set", "add", "multiply", "clear"] as const, `${label}.operation`); validateSafeValue(raw.operand, `${label}.operand`); validateSafeValue(raw.before, `${label}.before`); validateSafeValue(raw.after, `${label}.after`);
  });
  validateArray(value.compatibility, "compatibility");
  value.compatibility.forEach((raw, index) => {
    const label = `compatibility[${index}]`; assertObject(raw, label);
    assertExactKeys(raw, ["subjectAlias", "result", "ruleCode", "parameterKeys", "conditionCodes"], [], label);
    assertAlias(raw.subjectAlias, `${label}.subjectAlias`); assertEnum(raw.result, ["allow", "deny", "require"] as const, `${label}.result`); assertSafeCode(raw.ruleCode, `${label}.ruleCode`); validateCodeArray(raw.parameterKeys, `${label}.parameterKeys`); validateCodeArray(raw.conditionCodes, `${label}.conditionCodes`);
  });
  validateArray(value.affinity, "affinity");
  value.affinity.forEach((raw, index) => {
    const label = `affinity[${index}]`; assertObject(raw, label);
    assertExactKeys(raw, ["subjectAlias", "axisCode", "ruleCode", "score", "weight", "weightedContribution"], [], label);
    assertAlias(raw.subjectAlias, `${label}.subjectAlias`); assertSafeCode(raw.axisCode, `${label}.axisCode`); assertSafeCode(raw.ruleCode, `${label}.ruleCode`); assertFiniteNumber(raw.score, `${label}.score`); assertFiniteNumber(raw.weight, `${label}.weight`); assertFiniteNumber(raw.weightedContribution, `${label}.weightedContribution`);
  });
  validateArray(value.invariants, "invariants");
  value.invariants.forEach((raw, index) => {
    const label = `invariants[${index}]`; assertObject(raw, label);
    assertExactKeys(raw, ["subjectAlias", "invariantCode"], ["parameterKey", "expectedDirection", "expected", "actual"], label);
    assertAlias(raw.subjectAlias, `${label}.subjectAlias`); assertSafeCode(raw.invariantCode, `${label}.invariantCode`); if (raw.parameterKey !== undefined) assertSafeCode(raw.parameterKey, `${label}.parameterKey`); if (raw.expectedDirection !== undefined) assertEnum(raw.expectedDirection, ["positive", "negative", "neutral", "contextual"] as const, `${label}.expectedDirection`); if (raw.expected !== undefined) validateSafeValue(raw.expected, `${label}.expected`); if (raw.actual !== undefined) validateSafeValue(raw.actual, `${label}.actual`);
  });
  validateArray(value.fiveAxis, "fiveAxis");
  value.fiveAxis.forEach((raw, index) => {
    const label = `fiveAxis[${index}]`; assertObject(raw, label);
    assertExactKeys(raw, ["subjectAlias", "axisCode", "source"], ["componentAlias", "rawValue", "normalizedRatio", "officialDisplayScore", "comparisonScore"], label);
    assertAlias(raw.subjectAlias, `${label}.subjectAlias`); assertSafeCode(raw.axisCode, `${label}.axisCode`); if (raw.componentAlias !== undefined) assertAlias(raw.componentAlias, `${label}.componentAlias`); assertEnum(raw.source, ["direct", "context_inherited", "not_applicable", "missing", "error"] as const, `${label}.source`); for (const key of ["rawValue", "normalizedRatio", "officialDisplayScore", "comparisonScore"] as const) if (raw[key] !== undefined) assertFiniteNumber(raw[key], `${label}.${key}`);
  });
  validateArray(value.evidenceRefs, "evidenceRefs");
  value.evidenceRefs.forEach((raw, index) => {
    const label = `evidenceRefs[${index}]`; assertObject(raw, label);
    assertExactKeys(raw, ["evidenceType", "evidenceAlias", "contentHash"], [], label);
    assertEnum(raw.evidenceType, ["trace", "validation_issue", "hard_compatibility", "affinity_axis", "series_invariant", "five_axis", "rule", "snapshot"] as const, `${label}.evidenceType`); assertAlias(raw.evidenceAlias, `${label}.evidenceAlias`); assertHash(raw.contentHash, `${label}.contentHash`);
  });
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareOptional(left: string | undefined, right: string | undefined): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return utf8Compare(left, right);
}

function enumRank<T extends string>(value: T, order: readonly T[]): number {
  return order.indexOf(value);
}

function compareTuple(parts: number[]): number {
  return parts.find((part) => part !== 0) ?? 0;
}

function rejectDuplicates(values: unknown[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = jcsCanonicalize(value);
    if (seen.has(identity)) throw new AIOutboundError("AI_PAYLOAD_DUPLICATE_ELEMENT", `${label} 包含完全重复元素。`);
    seen.add(identity);
  }
}

function sortCodes(values: string[], label: string): void {
  values.sort(utf8Compare);
  rejectDuplicates(values, label);
}

export function normalizeAIRequestEnvelope(input: AIRequestEnvelopeV1): AIRequestEnvelopeV1 {
  const value = structuredClone(input);
  validateAIRequestEnvelope(value);
  value.traces.forEach((entry, index) => sortCodes(entry.warningCodes, `traces[${index}].warningCodes`));
  value.compatibility.forEach((entry, index) => {
    sortCodes(entry.parameterKeys, `compatibility[${index}].parameterKeys`);
    sortCodes(entry.conditionCodes, `compatibility[${index}].conditionCodes`);
  });
  const tie = (entry: unknown) => jcsCanonicalize(entry);
  value.panelValues.sort((a, b) => compareTuple([utf8Compare(a.subjectAlias, b.subjectAlias), utf8Compare(a.parameterKey, b.parameterKey), compareOptional(a.unitCode, b.unitCode), utf8Compare(tie(a.value), tie(b.value))]));
  value.traces.sort((a, b) => a.sequence - b.sequence || utf8Compare(tie(a), tie(b)));
  value.patches.sort((a, b) => a.chainIndex - b.chainIndex || a.operationIndex - b.operationIndex || utf8Compare(a.patchAlias, b.patchAlias) || utf8Compare(a.patchRevisionAlias, b.patchRevisionAlias) || utf8Compare(tie(a), tie(b)));
  value.compatibility.sort((a, b) => compareTuple([utf8Compare(a.subjectAlias, b.subjectAlias), enumRank(a.result, ["allow", "deny", "require"]), utf8Compare(a.ruleCode, b.ruleCode), utf8Compare(tie(a), tie(b))]));
  value.affinity.sort((a, b) => compareTuple([utf8Compare(a.subjectAlias, b.subjectAlias), utf8Compare(a.axisCode, b.axisCode), utf8Compare(a.ruleCode, b.ruleCode), utf8Compare(tie(a), tie(b))]));
  value.invariants.sort((a, b) => compareTuple([utf8Compare(a.subjectAlias, b.subjectAlias), utf8Compare(a.invariantCode, b.invariantCode), compareOptional(a.parameterKey, b.parameterKey), utf8Compare(tie(a), tie(b))]));
  value.fiveAxis.sort((a, b) => compareTuple([utf8Compare(a.subjectAlias, b.subjectAlias), utf8Compare(a.axisCode, b.axisCode), compareOptional(a.componentAlias, b.componentAlias), enumRank(a.source, ["direct", "context_inherited", "not_applicable", "missing", "error"]), utf8Compare(tie(a), tie(b))]));
  value.evidenceRefs.sort((a, b) => compareTuple([enumRank(a.evidenceType, ["trace", "validation_issue", "hard_compatibility", "affinity_axis", "series_invariant", "five_axis", "rule", "snapshot"]), utf8Compare(a.evidenceAlias, b.evidenceAlias), utf8Compare(a.contentHash, b.contentHash)]));
  for (const [label, entries] of Object.entries({ panelValues: value.panelValues, traces: value.traces, patches: value.patches, compatibility: value.compatibility, affinity: value.affinity, invariants: value.invariants, fiveAxis: value.fiveAxis, evidenceRefs: value.evidenceRefs })) rejectDuplicates(entries, label);
  validateTraceOrder(value.traces);
  validatePatchOrder(value.patches);
  return value;
}

function validateTraceOrder(traces: AIRequestEnvelopeV1["traces"]): void {
  const seen = new Set<number>();
  for (const trace of traces) {
    if (seen.has(trace.sequence)) throw new AIOutboundError("AI_TRACE_SEQUENCE_CONFLICT", `Trace sequence ${trace.sequence} 重复。`);
    seen.add(trace.sequence);
  }
}

function validatePatchOrder(patches: AIRequestEnvelopeV1["patches"]): void {
  const chainToRevision = new Map<number, string>();
  const revisionToChain = new Map<string, number>();
  const operationIndexes = new Map<string, Set<number>>();
  for (const patch of patches) {
    const revision = `${patch.patchAlias}\u0000${patch.patchRevisionAlias}`;
    const priorRevision = chainToRevision.get(patch.chainIndex);
    if (priorRevision !== undefined && priorRevision !== revision) throw new AIOutboundError("AI_PATCH_ORDER_CONFLICT", `chainIndex ${patch.chainIndex} 映射多个 Patch revision。`);
    const priorChain = revisionToChain.get(revision);
    if (priorChain !== undefined && priorChain !== patch.chainIndex) throw new AIOutboundError("AI_PATCH_ORDER_CONFLICT", "同一 Patch revision 出现在不同 chainIndex。" );
    chainToRevision.set(patch.chainIndex, revision); revisionToChain.set(revision, patch.chainIndex);
    const indexes = operationIndexes.get(revision) ?? new Set<number>();
    if (indexes.has(patch.operationIndex)) throw new AIOutboundError("AI_PATCH_ORDER_CONFLICT", "同一 Patch revision 的 operationIndex 重复。" );
    indexes.add(patch.operationIndex); operationIndexes.set(revision, indexes);
  }
  const chains = [...chainToRevision.keys()].sort((a, b) => a - b);
  chains.forEach((chain, index) => {
    if (chain !== index) throw new AIOutboundError("AI_PATCH_ORDER_CONFLICT", "Patch chainIndex 必须从 0 开始连续。" );
  });
}

export function jcsCanonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) failSchema("JCS 不接受非有限数。" );
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "string") {
    assertValidUnicode(value, "JCS string");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => jcsCanonicalize(entry)).join(",")}]`;
  if (!isPlainObject(value)) failSchema("JCS 只接受 JSON 值。" );
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => {
    assertValidUnicode(key, "JCS key");
    const entry = value[key];
    if (entry === undefined) failSchema(`JCS 字段 ${key} 不能是 undefined。`);
    return `${JSON.stringify(key)}:${jcsCanonicalize(entry)}`;
  }).join(",")}}`;
}

export function sha256Hex(value: string | Uint8Array): Sha256Hex {
  return createHash("sha256").update(value).digest("hex");
}

export function promptTemplateBytes(template: string): Uint8Array {
  const withoutBom = template.charCodeAt(0) === 0xfeff ? template.slice(1) : template;
  const normalized = withoutBom.replace(/\r\n?/g, "\n");
  assertValidUnicode(normalized, "prompt template");
  return Buffer.from(normalized, "utf8");
}

export function promptTemplateHash(template: string): Sha256Hex {
  return sha256Hex(promptTemplateBytes(template));
}

export class PromptTemplateRegistry {
  private readonly hashes = new Map<string, Sha256Hex>();
  register(version: SafeCode, template: string): Sha256Hex {
    assertSafeCode(version, "promptTemplateVersion");
    const hash = promptTemplateHash(template);
    const existing = this.hashes.get(version);
    if (existing && existing !== hash) throw new AIOutboundError("AI_PROMPT_TEMPLATE_VERSION_CONFLICT", "同一 promptTemplateVersion 对应了不同正文 hash。" );
    this.hashes.set(version, hash);
    return hash;
  }
}

function compareReference(left: LocalAliasReferenceV1, right: LocalAliasReferenceV1): number {
  return compareTuple([
    utf8Compare(left.referenceKindCode, right.referenceKindCode),
    utf8Compare(left.stableLocalId, right.stableLocalId),
    utf8Compare(left.stableRevisionId ?? "", right.stableRevisionId ?? ""),
  ]);
}

function referenceIdentity(reference: LocalAliasReferenceV1): string {
  return jcsCanonicalize([reference.referenceKindCode, reference.stableLocalId, reference.stableRevisionId ?? ""]);
}

export function createRequestAliasMap(references: readonly LocalAliasReferenceV1[]): Map<string, RequestAlias> {
  const unique = new Map<string, LocalAliasReferenceV1>();
  for (const reference of references) {
    if (!reference.stableLocalId || typeof reference.stableLocalId !== "string") throw new AIOutboundError("AI_ALIAS_REFERENCE_INVALID", "别名引用缺少 stableLocalId。" );
    assertValidUnicode(reference.stableLocalId, "stableLocalId");
    if (reference.stableRevisionId !== undefined) assertValidUnicode(reference.stableRevisionId, "stableRevisionId");
    const identity = referenceIdentity(reference);
    const existing = unique.get(identity);
    if (existing && (existing.referenceKindCode !== reference.referenceKindCode || existing.stableLocalId !== reference.stableLocalId || (existing.stableRevisionId ?? "") !== (reference.stableRevisionId ?? ""))) {
      throw new AIOutboundError("AI_ALIAS_IDENTITY_CONFLICT", "别名身份键发生冲突。" );
    }
    unique.set(identity, structuredClone(reference));
  }
  const sorted = [...unique.entries()].sort((left, right) => compareReference(left[1], right[1]));
  if (sorted.length > 9_999_999) throw new AIOutboundError("AI_PAYLOAD_LIMIT_EXCEEDED", "请求级别名数量过多。" );
  return new Map(sorted.map(([identity], index) => [identity, `a${String(index + 1).padStart(3, "0")}`]));
}

export function requestAliasFor(map: ReadonlyMap<string, RequestAlias>, reference: LocalAliasReferenceV1): RequestAlias {
  const alias = map.get(referenceIdentity(reference));
  if (!alias) throw new AIOutboundError("AI_ALIAS_REFERENCE_INVALID", "安全投影引用了未登记的本地身份。" );
  return alias;
}

export interface PreparedAIRequestV1 {
  envelope: AIRequestEnvelopeV1;
  canonicalJson: string;
  canonicalBytes: Uint8Array;
  inputHash: Sha256Hex;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s"']+/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\bCookie\s*:\s*[^\r\n]+/i,
  /\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password)\s*[=:]\s*[^\s,;}]+/i,
];

export function assertNoSecrets(value: string, loadedCredentialValues: readonly string[]): void {
  for (const credential of loadedCredentialValues) {
    if (credential && value.includes(credential)) throw new AIOutboundError("AI_SECRET_DETECTED", "AI 请求命中已加载凭据的精确值。" );
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) throw new AIOutboundError("AI_SECRET_DETECTED", "AI 请求命中令牌、私钥、Cookie 或 Authorization 模式。" );
}

export function prepareAIRequest(input: {
  envelope: AIRequestEnvelopeV1;
  loadedCredentialValues?: readonly string[];
}): PreparedAIRequestV1 {
  const envelope = normalizeAIRequestEnvelope(input.envelope);
  const canonicalJson = jcsCanonicalize(envelope);
  const canonicalBytes = Buffer.from(canonicalJson, "utf8");
  if (canonicalBytes.byteLength > AI_REQUEST_MAX_BYTES) throw new AIOutboundError("AI_PAYLOAD_LIMIT_EXCEEDED", `AI 请求超过 ${AI_REQUEST_MAX_BYTES} UTF-8 字节。` );
  assertNoSecrets(canonicalJson, input.loadedCredentialValues ?? []);
  return { envelope, canonicalJson, canonicalBytes, inputHash: sha256Hex(canonicalBytes) };
}

export function normalizeModelRevisions(input: unknown): AIModelRevisionSetV1 {
  assertObject(input, "model.revisions");
  assertExactKeys(input, [], ["modelVersion", "deploymentRevision", "modelArtifactDigest"], "model.revisions");
  const output: AIModelRevisionSetV1 = {};
  for (const key of ["modelVersion", "deploymentRevision", "modelArtifactDigest"] as const) {
    const value = input[key];
    if (value !== undefined) { assertSafeCode(value, `model.revisions.${key}`); output[key] = value; }
  }
  if (!Object.keys(output).length) throw new AIOutboundError("AI_MODEL_REVISION_UNAVAILABLE", "模型缺少不可变修订标识。" );
  return output;
}

export interface FancyHubModelRevisionV1 extends AIModelRevisionSetV1 {
  modelId: SafeCode;
}

export function describeFancyHubModels(input: readonly unknown[]): {
  models: AIModelDescriptorV1[];
  rejected: Array<{ index: number; code: "AI_MODEL_REVISION_UNAVAILABLE" | "AI_PAYLOAD_SCHEMA_REJECTED" }>;
  modelListSnapshotHash: Sha256Hex;
} {
  const accepted: Array<Omit<AIModelDescriptorV1, "modelListSnapshotHash">> = [];
  const rejected: Array<{ index: number; code: "AI_MODEL_REVISION_UNAVAILABLE" | "AI_PAYLOAD_SCHEMA_REJECTED" }> = [];
  input.forEach((raw, index) => {
    try {
      assertObject(raw, `models[${index}]`);
      assertExactKeys(raw, ["modelId"], ["modelVersion", "deploymentRevision", "modelArtifactDigest"], `models[${index}]`);
      assertSafeCode(raw.modelId, `models[${index}].modelId`);
      const revisions = normalizeModelRevisions({
        ...(raw.modelVersion === undefined ? {} : { modelVersion: raw.modelVersion }),
        ...(raw.deploymentRevision === undefined ? {} : { deploymentRevision: raw.deploymentRevision }),
        ...(raw.modelArtifactDigest === undefined ? {} : { modelArtifactDigest: raw.modelArtifactDigest }),
      });
      accepted.push({
        provider: "fancy_hub",
        modelId: raw.modelId,
        revisions,
        revisionIdentityHash: sha256Hex(jcsCanonicalize(revisions)),
      });
    } catch (error) {
      if (error instanceof AIOutboundError && error.code === "AI_MODEL_REVISION_UNAVAILABLE") {
        rejected.push({ index, code: error.code });
        return;
      }
      rejected.push({ index, code: "AI_PAYLOAD_SCHEMA_REJECTED" });
    }
  });
  accepted.sort((left, right) => utf8Compare(left.modelId, right.modelId) || utf8Compare(left.revisionIdentityHash, right.revisionIdentityHash));
  rejectDuplicates(accepted, "Fancy Hub model list");
  const modelListSnapshotHash = sha256Hex(jcsCanonicalize(accepted));
  return {
    models: accepted.map((model) => ({ ...model, modelListSnapshotHash })),
    rejected,
    modelListSnapshotHash,
  };
}

export function sameModelDescriptor(left: AIModelDescriptorV1, right: AIModelDescriptorV1): boolean {
  return jcsCanonicalize(left) === jcsCanonicalize(right);
}
