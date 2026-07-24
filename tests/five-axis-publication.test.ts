import assert from "node:assert/strict";
import test from "node:test";
import { createFormalFiveAxisViewDefinition } from "../lib/five-axis-formal";
import { FiveAxisPublicationError, publishFormalFiveAxisDefinition } from "../lib/five-axis-publication";
import { createSeedState } from "../lib/seed";

function productionState() {
  const state = createSeedState({ mode: "production" });
  state.feishuSourceRevisions = [{
    id: "source:five-axis", workbookRefId: "feishu-workbook:tackle-design",
    sourceRevision: "feishu-revision-3563", spreadsheetToken: "redacted",
    pulledAt: "2026-07-24T00:00:00.000Z", pulledBy: "tester", syncScope: "workbook",
    registryHash: "a".repeat(64), sheets: [], issues: [], state: "PUBLISHED",
    fiveAxisWeightBandPolicyContentHash: createFormalFiveAxisViewDefinition().weightBandPolicy.contentHash,
  }];
  return state;
}

test("生产 seed 不自动创建 FORMAL_CURRENT，正式发布要求来源、权限、CAS 且幂等", () => {
  const state = productionState();
  assert.equal(state.fiveAxisViewDefinitions.some((entry) => "semanticContractVersion" in entry), false);
  assert.equal(state.fiveAxisDispositionCatalogRevisions.some((revision) =>
    revision.entries.some((entry) => entry.effectiveUse === "FORMAL_CURRENT")), false);
  const definition = createFormalFiveAxisViewDefinition();
  const input = {
    state, definition,
    sourceEvidence: {
      sourceRevisionId: "source:five-axis", sourceRevision: "feishu-revision-3563",
      registryHash: "a".repeat(64), weightBandPolicyContentHash: definition.weightBandPolicy.contentHash,
    },
    expectedCatalogRevisionId: state.currentFiveAxisDispositionCatalogRevisionId,
    idempotencyKey: "five-axis:publish:1", actor: "tester", publishedAt: "2026-07-24T00:00:00.000Z",
  };
  assert.throws(() => publishFormalFiveAxisDefinition({ ...input, capabilities: [] }), FiveAxisPublicationError);
  assert.throws(() => publishFormalFiveAxisDefinition({
    ...input,
    definition: {
      ...definition,
      weightBandPolicy: {
        ...definition.weightBandPolicy,
        sourceRevision: "forged-source-revision",
      },
    },
    capabilities: ["rules.five_axis.publish"],
  }), /(?:SOURCE_EVIDENCE_INVALID|FIVE_AXIS_WEIGHT_BAND_POLICY_UNAVAILABLE)/);
  const selfConsistentForgery = structuredClone(definition);
  selfConsistentForgery.weightBandPolicy.bands[0].upperBoundKg = "3";
  selfConsistentForgery.weightBandPolicy.contentHash = input.sourceEvidence.weightBandPolicyContentHash;
  assert.throws(() => publishFormalFiveAxisDefinition({
    ...input, definition: selfConsistentForgery, capabilities: ["rules.five_axis.publish"],
  }), /FIVE_AXIS_WEIGHT_BAND_POLICY_UNAVAILABLE/);
  assert.throws(() => publishFormalFiveAxisDefinition({
    ...input,
    sourceEvidence: { ...input.sourceEvidence, weightBandPolicyContentHash: "b".repeat(64) },
    capabilities: ["rules.five_axis.publish"],
  }), /SOURCE_EVIDENCE_INVALID/);
  assert.throws(() => publishFormalFiveAxisDefinition({ ...input, expectedCatalogRevisionId: "stale", capabilities: ["rules.five_axis.publish"] }), /CATALOG_HEAD_CONFLICT/);
  const published = publishFormalFiveAxisDefinition({ ...input, capabilities: ["rules.five_axis.publish"] });
  assert.equal(published.idempotent, false);
  assert.equal(published.state.currentFiveAxisDispositionCatalogRevisionId, published.catalogRevisionId);
  assert.equal(published.state.configurationSnapshots.length, state.configurationSnapshots.length);
  const replay = publishFormalFiveAxisDefinition({ ...input, state: published.state, capabilities: ["rules.five_axis.publish"] });
  assert.equal(replay.idempotent, true);
});
