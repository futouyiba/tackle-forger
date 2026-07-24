import assert from "node:assert/strict";
import test from "node:test";
import { createFormalFiveAxisViewDefinition } from "../lib/five-axis-formal";
import { FiveAxisPublicationError, publishFormalFiveAxisDefinition } from "../lib/five-axis-publication";
import { CANONICAL_FEISHU_WORKBOOK, pullFeishuWorkbookRevision } from "../lib/feishu-workbook";
import { createSeedState } from "../lib/seed";

function weightFixture() {
  const rows = Array.from({ length: 54 }, () => [] as unknown[]);
  const bounds = ["1.5", "3.8", "12.6", "25.9", "82.5", ""];
  for (const [part, headerRow, start] of [["竿", 2, 3], ["轮", 20, 21], ["线", 38, 39]] as const) {
    rows[headerRow - 1] = ["", "机器ID", "同步状态", "部位", "重量段序号", "最小拉力", "最大拉力", "鱼重量等级"];
    for (let index = 0; index < 16; index += 1) {
      const gradeIndex = Math.min(index, 5);
      rows[start + index - 1] = ["", `wtpl_${part}_${index + 1}`, "BOUND", part, String(index + 1), String(index + 1), bounds[gradeIndex], ["微物", "小鱼", "中鱼", "大鱼", "巨物", "超级巨物"][gradeIndex]];
    }
  }
  return rows;
}

async function productionState() {
  const state = createSeedState({ mode: "production" });
  const source = await pullFeishuWorkbookRevision({ workbook: CANONICAL_FEISHU_WORKBOOK, pulledAt: "2026-07-24T00:00:00.000Z", pulledBy: "tester", adapter: {
    resolveWorkbook: async () => ({ spreadsheetToken: "redacted", sourceRevision: "4837", sheets: [{ sheetId: "d6e928", name: "01_重量模板", rowCount: 54, columnCount: 31 }] }),
    readRanges: async () => [{ sheetId: "d6e928", range: "A1:AE54", revision: "4837", values: weightFixture() }],
  } });
  state.feishuSourceRevisions = [{ ...source, state: "PUBLISHED" }];
  return state;
}

test("真实拉取夹具从 d6e928 冻结 W policy，并对三方 grade 篡改 fail-closed", async () => {
  const state = await productionState();
  const policy = state.feishuSourceRevisions[0]!.fiveAxisWeightBandPolicy!;
  assert.deepEqual(policy.bands, [
    { weightBandId: "W1", upperBoundKg: "1.5" }, { weightBandId: "W2", upperBoundKg: "3.8" },
    { weightBandId: "W3", upperBoundKg: "12.6" }, { weightBandId: "W4", upperBoundKg: "25.9" },
    { weightBandId: "W5", upperBoundKg: "82.5" }, { weightBandId: "W6", upperBoundKg: null },
  ]);
  const malformed = weightFixture();
  malformed[20]![7] = "巨物";
  await assert.rejects(() => pullFeishuWorkbookRevision({ workbook: CANONICAL_FEISHU_WORKBOOK, pulledAt: "2026-07-24T00:00:00.000Z", pulledBy: "tester", adapter: {
    resolveWorkbook: async () => ({ spreadsheetToken: "redacted", sourceRevision: "4837", sheets: [{ sheetId: "d6e928", name: "01_重量模板", rowCount: 54, columnCount: 31 }] }),
    readRanges: async () => [{ sheetId: "d6e928", range: "A1:AE54", revision: "4837", values: malformed }],
  } }), /FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID/);
});

test("生产 seed 不自动创建 FORMAL_CURRENT，正式发布要求来源、权限、CAS 且幂等", async () => {
  const state = await productionState();
  assert.equal(state.fiveAxisViewDefinitions.some((entry) => "semanticContractVersion" in entry), false);
  assert.equal(state.fiveAxisDispositionCatalogRevisions.some((revision) =>
    revision.entries.some((entry) => entry.effectiveUse === "FORMAL_CURRENT")), false);
  const definition = createFormalFiveAxisViewDefinition({ sourceRevision: "4837", weightBandPolicy: state.feishuSourceRevisions[0]!.fiveAxisWeightBandPolicy });
  const input = {
    state, definition,
    sourceEvidence: {
      sourceRevisionId: state.feishuSourceRevisions[0]!.id, sourceRevision: "4837",
      registryHash: state.feishuSourceRevisions[0]!.registryHash, weightBandPolicyContentHash: definition.weightBandPolicy.contentHash,
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
