import { deterministicHash } from "./rule-kernel";
import {
  assertFormalFiveAxisViewDefinition,
  createFiveAxisDispositionCatalogRevision,
  hashFiveAxisWeightBandPolicy,
} from "./five-axis-formal";
import type { CapabilityCode } from "./interaction-contracts";
import type { FiveAxisViewDefinition, WorkspaceState } from "./types";

export class FiveAxisPublicationError extends Error {}

export function publishFormalFiveAxisDefinition(input: {
  state: WorkspaceState;
  definition: FiveAxisViewDefinition;
  sourceEvidence: {
    sourceRevisionId: string;
    sourceRevision: string;
    registryHash: string;
    weightBandPolicyContentHash: string;
  };
  expectedCatalogRevisionId: string | null;
  idempotencyKey: string;
  actor: string;
  publishedAt: string;
  capabilities: Iterable<CapabilityCode>;
}): { state: WorkspaceState; catalogRevisionId: string; idempotent: boolean } {
  if (!new Set(input.capabilities).has("rules.five_axis.publish")) {
    throw new FiveAxisPublicationError("FIVE_AXIS_PUBLICATION_CAPABILITY_MISSING");
  }
  if (!input.idempotencyKey.trim()) {
    throw new FiveAxisPublicationError("FIVE_AXIS_PUBLICATION_IDEMPOTENCY_KEY_REQUIRED");
  }
  assertFormalFiveAxisViewDefinition(input.definition);
  const source = input.state.feishuSourceRevisions.find((entry) =>
    entry.id === input.sourceEvidence.sourceRevisionId
    && entry.sourceRevision === input.sourceEvidence.sourceRevision
    && entry.registryHash === input.sourceEvidence.registryHash,
  );
  if (
    !source
    || source.state !== "PUBLISHED"
    || input.definition.sourceRevision !== source.sourceRevision
    || input.definition.weightBandPolicy.sourceRevision !== source.sourceRevision
    || input.definition.weightBandPolicy.contentHash
      !== input.sourceEvidence.weightBandPolicyContentHash
    || source.fiveAxisWeightBandPolicyContentHash
      !== input.sourceEvidence.weightBandPolicyContentHash
    || !source.fiveAxisWeightBandPolicy
    || source.fiveAxisWeightBandPolicy.contentHash
      !== input.sourceEvidence.weightBandPolicyContentHash
    || hashFiveAxisWeightBandPolicy(source.fiveAxisWeightBandPolicy)
      !== input.sourceEvidence.weightBandPolicyContentHash
    || input.definition.weightBandPolicy.contentHash
      !== source.fiveAxisWeightBandPolicy.contentHash
    || source.fiveAxisWeightBandPolicy.sourceRevision
      !== input.sourceEvidence.sourceRevision
  ) {
    throw new FiveAxisPublicationError("FIVE_AXIS_PUBLICATION_SOURCE_EVIDENCE_INVALID");
  }
  const commandHash = deterministicHash({
    definitionHash: input.definition.definitionHash,
    sourceEvidence: input.sourceEvidence,
    expectedCatalogRevisionId: input.expectedCatalogRevisionId,
  });
  const prior = input.state.commandIdempotencyRecords.find((entry) => entry.key === input.idempotencyKey);
  if (prior) {
    if (prior.inputHash !== commandHash) throw new FiveAxisPublicationError("FIVE_AXIS_PUBLICATION_IDEMPOTENCY_CONFLICT");
    return { state: input.state, catalogRevisionId: prior.resultRef, idempotent: true };
  }
  if (input.state.currentFiveAxisDispositionCatalogRevisionId !== input.expectedCatalogRevisionId) {
    throw new FiveAxisPublicationError("FIVE_AXIS_PUBLICATION_CATALOG_HEAD_CONFLICT");
  }
  const definitions = input.state.fiveAxisViewDefinitions.some((entry) =>
    entry.definitionId === input.definition.definitionId && entry.version === input.definition.version,
  ) ? input.state.fiveAxisViewDefinitions : [...input.state.fiveAxisViewDefinitions, input.definition];
  const catalog = createFiveAxisDispositionCatalogRevision({
    definitions,
    existingRevisions: input.state.fiveAxisDispositionCatalogRevisions,
    currentRevisionId: input.expectedCatalogRevisionId,
    formalCurrent: { definitionId: input.definition.definitionId, definitionVersion: input.definition.version },
    decidedAt: input.publishedAt,
  });
  const next = structuredClone(input.state);
  next.fiveAxisViewDefinitions = definitions;
  next.fiveAxisDispositionCatalogRevisions = catalog.revisions;
  next.currentFiveAxisDispositionCatalogRevisionId = catalog.currentRevisionId;
  next.commandIdempotencyRecords.push({
    key: input.idempotencyKey,
    inputHash: commandHash,
    resultRef: catalog.currentRevisionId!,
    resultPayload: { catalogRevisionId: catalog.currentRevisionId!, definitionHash: input.definition.definitionHash },
    resultPayloadHash: deterministicHash({ catalogRevisionId: catalog.currentRevisionId!, definitionHash: input.definition.definitionHash }),
  });
  return { state: next, catalogRevisionId: catalog.currentRevisionId!, idempotent: false };
}
