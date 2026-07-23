import {
  AI_PROVIDER_POLICY_VERSION,
  AI_REQUEST_SCHEMA_VERSION,
  createRequestAliasMap,
  jcsCanonicalize,
  promptTemplateHash,
  requestAliasFor,
  sha256Hex,
  type AIModelDescriptorV1,
  type AIRequestEnvelopeV1,
  type LocalAliasReferenceV1,
  type RequestAlias,
} from "./ai-outbound";
import type { WorkspaceState } from "./types";

export const AI_ASSESSMENT_PROMPT_VERSION = "tackle-forger-assessment-v2";
export const AI_ASSESSMENT_PROMPT = [
  "Explain deterministic validation and trade-offs using only the supplied codes and values.",
  "Do not override validation, approve changes, or claim uncovered information as fact.",
  "Every recommendation must cite at least one supplied evidence alias, and evidence aliases may only refer to supplied evidenceRefs.",
  "When supporting evidence is absent, report the gap in uncoveredInformation instead of making a recommendation.",
].join("\n");

type AssessmentScope = { scopeType: "series" | "model"; scopeId: string };

export interface WorkspaceAssessmentRequestProjection {
  envelope: AIRequestEnvelopeV1;
  prompt: string;
  operationMetadataContext: {
    scopeType: AssessmentScope["scopeType"];
    scopeId: string;
    scopeRevision: string;
    ruleSetVersion: string;
    fiveAxisRuleVersion: string;
  };
  requestAliasMapping: Array<{
    alias: RequestAlias;
    reference: LocalAliasReferenceV1;
  }>;
}

export function workspaceAssessmentScopeExists(state: WorkspaceState, scope: AssessmentScope): boolean {
  return scope.scopeType === "series"
    ? state.seriesDefinitions.some((entry) => entry.id === scope.scopeId)
    : state.purchasableModels.some((entry) => entry.id === scope.scopeId);
}

function reference(referenceKindCode: LocalAliasReferenceV1["referenceKindCode"], stableLocalId: string, stableRevisionId?: string): LocalAliasReferenceV1 {
  return { referenceKindCode, stableLocalId, ...(stableRevisionId === undefined ? {} : { stableRevisionId }) };
}

function requestAliasMapping(
  aliases: ReadonlyMap<string, RequestAlias>,
  references: readonly LocalAliasReferenceV1[],
): WorkspaceAssessmentRequestProjection["requestAliasMapping"] {
  return references
    .map((entry) => ({ alias: requestAliasFor(aliases, entry), reference: structuredClone(entry) }))
    .sort((left, right) => left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0);
}

function currentPublishedRuleSetVersion(state: WorkspaceState): string {
  const current = state.ruleSetVersions
    .filter((entry) => entry.status === "published")
    .sort((left, right) => right.version - left.version
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0];
  if (!current) throw new Error("AI_RULESET_VERSION_NOT_FOUND");
  return current.id;
}

function currentFiveAxisRuleVersion(state: WorkspaceState): string {
  const current = state.fiveAxisViewDefinitions
    .filter((entry) => entry.publicationState === "PUBLISHED")
    .sort((left, right) => right.revision - left.revision
      || (left.definitionId < right.definitionId ? -1 : left.definitionId > right.definitionId ? 1 : 0))[0];
  if (!current) throw new Error("AI_FIVE_AXIS_RULE_VERSION_NOT_FOUND");
  return current.fiveAxisRuleVersion;
}

export function buildWorkspaceAssessmentRequestProjection(input: {
  state: WorkspaceState;
  scope: AssessmentScope;
  assessmentId: string;
  model: AIModelDescriptorV1;
}): WorkspaceAssessmentRequestProjection {
  const ruleSetVersion = currentPublishedRuleSetVersion(input.state);
  const fiveAxisRuleVersion = currentFiveAxisRuleVersion(input.state);
  const assessmentRef = reference("assessment", input.assessmentId);
  if (input.scope.scopeType === "series") {
    const series = input.state.seriesDefinitions.find((entry) => entry.id === input.scope.scopeId);
    if (!series) throw new Error("AI_SCOPE_NOT_FOUND");
    const seriesRef = reference("series", series.id, String(series.revision));
    const revisionRef = reference("revision", `${series.id}:revision`, String(series.revision));
    const evidenceRef = reference("evidence", `${series.id}:assessment-snapshot`, String(series.revision));
    const aliases = createRequestAliasMap([assessmentRef, seriesRef, revisionRef, evidenceRef]);
    const subjectAlias = requestAliasFor(aliases, seriesRef);
    const evidenceHash = sha256Hex(jcsCanonicalize({
      scopeType: "series",
      id: series.id,
      revision: series.revision,
      ruleSetVersion,
      fiveAxisRuleVersion,
      functionIntensityPolicy: series.functionIntensityPolicy,
      targetPullSpecifications: series.targetPullSpecifications,
    }));
    return {
      prompt: AI_ASSESSMENT_PROMPT,
      operationMetadataContext: {
        scopeType: "series",
        scopeId: series.id,
        scopeRevision: String(series.revision),
        ruleSetVersion,
        fiveAxisRuleVersion,
      },
      requestAliasMapping: requestAliasMapping(aliases, [assessmentRef, seriesRef, revisionRef, evidenceRef]),
      envelope: {
      schemaVersion: AI_REQUEST_SCHEMA_VERSION,
      policyVersion: AI_PROVIDER_POLICY_VERSION,
      promptTemplateVersion: AI_ASSESSMENT_PROMPT_VERSION,
      promptTemplateHash: promptTemplateHash(AI_ASSESSMENT_PROMPT),
      assessmentAlias: requestAliasFor(aliases, assessmentRef),
      analysisIntent: "suggest_tradeoffs",
      model: input.model,
      scope: { scopeType: "series", scopeAlias: subjectAlias, revisionAlias: requestAliasFor(aliases, revisionRef) },
      panelValues: [
        ...(series.functionIntensityPolicy.mode === "fixed"
          ? [{ subjectAlias, parameterKey: "function_intensity", value: { kind: "number" as const, value: series.functionIntensityPolicy.intensity } }]
          : []),
        ...series.targetPullSpecifications.map((entry) => ({
          subjectAlias,
          parameterKey: "target_pull_kgf",
          value: { kind: "number" as const, value: entry.targetPullKgf },
          unitCode: "kgf",
        })),
      ],
      traces: [], patches: [], compatibility: [], affinity: [], invariants: [], fiveAxis: [],
      evidenceRefs: [{ evidenceType: "snapshot", evidenceAlias: requestAliasFor(aliases, evidenceRef), contentHash: evidenceHash }],
      },
    };
  }
  const model = input.state.purchasableModels.find((entry) => entry.id === input.scope.scopeId);
  if (!model) throw new Error("AI_SCOPE_NOT_FOUND");
  const sku = input.state.skuDrawers.find((entry) => entry.id === model.skuId);
  const modelRef = reference("model", model.id, String(model.revision));
  const revisionRef = reference("revision", `${model.id}:revision`, String(model.revision));
  const evidenceRef = reference("evidence", `${model.id}:assessment-snapshot`, String(model.revision));
  const aliases = createRequestAliasMap([assessmentRef, modelRef, revisionRef, evidenceRef]);
  const subjectAlias = requestAliasFor(aliases, modelRef);
  const evidenceHash = sha256Hex(jcsCanonicalize({
    scopeType: "model",
    id: model.id,
    revision: model.revision,
    ruleSetVersion,
    fiveAxisRuleVersion,
    skuId: model.skuId,
    lengthM: model.lengthM,
    price: model.price,
    targetWeightKg: sku?.targetWeightKg ?? null,
  }));
  return {
    prompt: AI_ASSESSMENT_PROMPT,
    operationMetadataContext: {
      scopeType: "model",
      scopeId: model.id,
      scopeRevision: String(model.revision),
      ruleSetVersion,
      fiveAxisRuleVersion,
    },
    requestAliasMapping: requestAliasMapping(aliases, [assessmentRef, modelRef, revisionRef, evidenceRef]),
    envelope: {
    schemaVersion: AI_REQUEST_SCHEMA_VERSION,
    policyVersion: AI_PROVIDER_POLICY_VERSION,
    promptTemplateVersion: AI_ASSESSMENT_PROMPT_VERSION,
    promptTemplateHash: promptTemplateHash(AI_ASSESSMENT_PROMPT),
    assessmentAlias: requestAliasFor(aliases, assessmentRef),
    analysisIntent: "suggest_tradeoffs",
    model: input.model,
    scope: { scopeType: "model", scopeAlias: subjectAlias, revisionAlias: requestAliasFor(aliases, revisionRef) },
    panelValues: [
      { subjectAlias, parameterKey: "length_m", value: { kind: "number", value: model.lengthM }, unitCode: "m" },
      { subjectAlias, parameterKey: "price", value: { kind: "number", value: model.price } },
      ...(sku ? [{ subjectAlias, parameterKey: "target_pull_kgf", value: { kind: "number" as const, value: sku.targetWeightKg }, unitCode: "kgf" }] : []),
    ],
    traces: [], patches: [], compatibility: [], affinity: [], invariants: [], fiveAxis: [],
    evidenceRefs: [{ evidenceType: "snapshot", evidenceAlias: requestAliasFor(aliases, evidenceRef), contentHash: evidenceHash }],
    },
  };
}

export function buildWorkspaceAssessmentEnvelope(input: {
  state: WorkspaceState;
  scope: AssessmentScope;
  assessmentId: string;
  model: AIModelDescriptorV1;
}): AIRequestEnvelopeV1 {
  return buildWorkspaceAssessmentRequestProjection(input).envelope;
}
