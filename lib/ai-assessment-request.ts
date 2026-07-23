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
import {
  assertSeriesItemPartChainEnabled,
  isProductSkuChainEnabled,
  type ItemPartChainInconsistentError,
  type ItemPartNotEnabledError,
} from "./enabled-item-parts";
import { currentPatchPanelValuesFromWorkspace } from "./patch-authority";
import type { WorkspaceState } from "./types";

export const AI_ASSESSMENT_PROMPT_VERSION = "tackle-forger-assessment-v3";
export const AI_ASSESSMENT_PROMPT = [
  "Explain deterministic validation and trade-offs using only the supplied codes and values.",
  "Do not override validation, approve changes, or claim uncovered information as fact.",
  "Every recommendation must cite at least one supplied evidence alias, and evidence aliases may only refer to supplied evidenceRefs.",
  "For a draft recommendation, return typed suggestedChanges with the exact supplied parameter code, expected before SafeValue, canonical operation, and SafeValue operand; never infer an operation from prose.",
  "For preview_only, suggestedChanges must be empty.",
  "When supporting evidence is absent, report the gap in uncoveredInformation instead of making a recommendation.",
].join("\n");

type AssessmentScope = { scopeType: "series" | "model"; scopeId: string };
export type WorkspaceAssessmentScopeError =
  | ItemPartNotEnabledError
  | ItemPartChainInconsistentError;

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
  parameterKeyMapping: Array<{
    alias: string;
    parameterKey: string;
  }>;
}

export function workspaceAssessmentScopeExists(state: WorkspaceState, scope: AssessmentScope): boolean {
  try {
    assertWorkspaceAssessmentScopeEligible(state, scope);
    return true;
  } catch {
    return false;
  }
}

export function assertWorkspaceAssessmentScopeEligible(
  state: WorkspaceState,
  scope: AssessmentScope,
): void {
  if (scope.scopeType === "series") {
    const series = state.seriesDefinitions.find((entry) => entry.id === scope.scopeId);
    if (!series) throw new Error("AI_SCOPE_NOT_FOUND");
    // Validate the declared part against enabled descendants. Delayed historical
    // siblings remain retained but are excluded from the safe projection below.
    assertSeriesItemPartChainEnabled(
      series,
      [],
      "ai_assessment",
      [],
      state.skuDrawers,
    );
    return;
  }
  const model = state.purchasableModels.find((entry) => entry.id === scope.scopeId);
  if (!model) throw new Error("AI_SCOPE_NOT_FOUND");
  const sku = state.skuDrawers.find((entry) => entry.id === model.skuId);
  const series = sku
    ? state.seriesDefinitions.find((entry) => entry.id === sku.seriesId)
    : undefined;
  if (!sku || !series || !sku.modelIds.includes(model.id)) {
    throw new Error("AI_SCOPE_NOT_FOUND");
  }
  const snapshot = model.configurationSnapshotId
    ? state.configurationSnapshots.find((entry) => entry.id === model.configurationSnapshotId)
    : undefined;
  if (model.configurationSnapshotId && !snapshot) {
    throw new Error("AI_SCOPE_NOT_FOUND");
  }
  if (snapshot && (snapshot.modelId !== model.id || snapshot.modelRevision !== model.revision)) {
    throw new Error("AI_SCOPE_NOT_FOUND");
  }
  assertSeriesItemPartChainEnabled(
    series,
    [sku],
    "ai_assessment",
    snapshot ? [snapshot.projectionMatch.itemPartId] : [],
    state.skuDrawers,
  );
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
  assertWorkspaceAssessmentScopeEligible(input.state, input.scope);
  const ruleSetVersion = currentPublishedRuleSetVersion(input.state);
  const fiveAxisRuleVersion = currentFiveAxisRuleVersion(input.state);
  const assessmentRef = reference("assessment", input.assessmentId);
  if (input.scope.scopeType === "series") {
    const series = input.state.seriesDefinitions.find((entry) => entry.id === input.scope.scopeId);
    if (!series) throw new Error("AI_SCOPE_NOT_FOUND");
    const eligibleSkuIds = new Set(
      input.state.skuDrawers
        .filter((sku) => isProductSkuChainEnabled(series, sku, input.state.skuDrawers))
        .map((sku) => sku.id),
    );
    const targetPullSpecifications = series.targetPullSpecifications.filter((entry) =>
      eligibleSkuIds.has(entry.skuId));
    const seriesRef = reference("series", series.id, String(series.revision));
    const revisionRef = reference("revision", `${series.id}:revision`, String(series.revision));
    const evidenceRef = reference("evidence", `${series.id}:series-invariant`, String(series.revision));
    const aliases = createRequestAliasMap([assessmentRef, seriesRef, revisionRef, evidenceRef]);
    const subjectAlias = requestAliasFor(aliases, seriesRef);
    const evidenceHash = sha256Hex(jcsCanonicalize({
      scopeType: "series",
      id: series.id,
      revision: series.revision,
      ruleSetVersion,
      fiveAxisRuleVersion,
      functionIntensityPolicy: series.functionIntensityPolicy,
      targetPullSpecifications,
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
      parameterKeyMapping: [],
      envelope: {
      schemaVersion: AI_REQUEST_SCHEMA_VERSION,
      policyVersion: AI_PROVIDER_POLICY_VERSION,
      promptTemplateVersion: AI_ASSESSMENT_PROMPT_VERSION,
      promptTemplateHash: promptTemplateHash(AI_ASSESSMENT_PROMPT),
      assessmentAlias: requestAliasFor(aliases, assessmentRef),
      analysisIntent: "draft_rule_change",
      model: input.model,
      scope: { scopeType: "series", scopeAlias: subjectAlias, revisionAlias: requestAliasFor(aliases, revisionRef) },
      panelValues: [
        ...(series.functionIntensityPolicy.mode === "fixed"
          ? [{ subjectAlias, parameterKey: "function_intensity", value: { kind: "number" as const, value: series.functionIntensityPolicy.intensity } }]
          : []),
        ...targetPullSpecifications.map((entry) => ({
          subjectAlias,
          parameterKey: "target_pull_kgf",
          value: { kind: "number" as const, value: entry.targetPullKgf },
          unitCode: "kgf",
        })),
      ],
      traces: [], patches: [], compatibility: [], affinity: [], invariants: [], fiveAxis: [],
      evidenceRefs: [{
        evidenceType: "series_invariant",
        evidenceAlias: requestAliasFor(aliases, evidenceRef),
        contentHash: evidenceHash,
      }],
      },
    };
  }
  const model = input.state.purchasableModels.find((entry) => entry.id === input.scope.scopeId);
  if (!model) throw new Error("AI_SCOPE_NOT_FOUND");
  const sku = input.state.skuDrawers.find((entry) => entry.id === model.skuId);
  const snapshot = model.configurationSnapshotId
    ? input.state.configurationSnapshots.find((entry) =>
      entry.id === model.configurationSnapshotId
      && entry.modelId === model.id
      && entry.modelRevision === model.revision)
    : undefined;
  if (model.configurationSnapshotId && !snapshot) throw new Error("AI_SCOPE_NOT_FOUND");
  const modelRef = reference("model", model.id, String(model.revision));
  const revisionRef = reference("revision", `${model.id}:revision`, String(model.revision));
  const evidenceRef = snapshot
    ? reference("evidence", snapshot.id, String(snapshot.version))
    : reference("evidence", `${model.id}:projection-trace`, String(model.revision));
  const aliases = createRequestAliasMap([assessmentRef, modelRef, revisionRef, evidenceRef]);
  const subjectAlias = requestAliasFor(aliases, modelRef);
  const evidenceHash = sha256Hex(jcsCanonicalize(snapshot
    ? {
        evidenceType: "configuration_snapshot",
        snapshotId: snapshot.id,
        snapshotVersion: snapshot.version,
        snapshotContentHash: snapshot.contentHash,
        modelId: snapshot.modelId,
        modelRevision: snapshot.modelRevision,
      }
    : {
        traceType: "workspace_model_projection",
        modelId: model.id,
        modelRevision: model.revision,
        ruleSetVersion,
        fiveAxisRuleVersion,
        skuId: model.skuId,
        lengthM: model.lengthM,
        price: model.price,
        targetPullKg: sku?.targetPullKg ?? null,
      }));
  const finalPanelValues = currentPatchPanelValuesFromWorkspace({
    state: input.state,
    scopeType: "model",
    subjectEntityId: model.id,
  });
  const parameterKeys = Object.keys(finalPanelValues)
    .filter((key) => {
      if (typeof finalPanelValues[key] !== "number" || !Number.isFinite(finalPanelValues[key])) return false;
      const definition = input.state.parameters.find((entry) => entry.key === key);
      const range = definition?.targetRange;
      return Boolean(
        definition
        && range
        && Number.isFinite(range.min)
        && Number.isFinite(range.max)
        && range.min <= range.max
        && definition.allowedOperations?.some((operation) =>
          operation === "set" || operation === "add" || operation === "multiply"),
      );
    })
    .sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  if (parameterKeys.length > 256) throw new Error("AI_PAYLOAD_LIMIT_EXCEEDED");
  const parameterKeyMapping = parameterKeys.map((parameterKey, index) => ({
    alias: `p${String(index + 1).padStart(3, "0")}`,
    parameterKey,
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
    parameterKeyMapping,
    envelope: {
    schemaVersion: AI_REQUEST_SCHEMA_VERSION,
    policyVersion: AI_PROVIDER_POLICY_VERSION,
    promptTemplateVersion: AI_ASSESSMENT_PROMPT_VERSION,
    promptTemplateHash: promptTemplateHash(AI_ASSESSMENT_PROMPT),
    assessmentAlias: requestAliasFor(aliases, assessmentRef),
    analysisIntent: "draft_model_patch",
    model: input.model,
    scope: { scopeType: "model", scopeAlias: subjectAlias, revisionAlias: requestAliasFor(aliases, revisionRef) },
    panelValues: parameterKeyMapping.map((entry) => ({
      subjectAlias,
      parameterKey: entry.alias,
      value: { kind: "number" as const, value: finalPanelValues[entry.parameterKey] as number },
    })),
    traces: [], patches: [], compatibility: [], affinity: [], invariants: [], fiveAxis: [],
    evidenceRefs: [{
      evidenceType: snapshot ? "snapshot" : "trace",
      evidenceAlias: requestAliasFor(aliases, evidenceRef),
      contentHash: evidenceHash,
    }],
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
