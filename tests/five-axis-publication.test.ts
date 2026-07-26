import assert from "node:assert/strict";
import test from "node:test";
import { createFormalFiveAxisViewDefinition } from "../lib/five-axis-formal";
import { FiveAxisPublicationError, publishFormalFiveAxisDefinition } from "../lib/five-axis-publication";
import { CANONICAL_FEISHU_SHEET_REGISTRY, CANONICAL_FEISHU_WORKBOOK, pullFeishuWorkbookRevision } from "../lib/feishu-workbook";
import { createSeedState } from "../lib/seed";
import { weightTemplate4837Rod, weightTemplate4837Reel, weightTemplate4837Line } from "./fixtures/five-axis-weight-template-4837";

interface WeightTemplateParts {
  rod: unknown[][];
  reel: unknown[][];
  line: unknown[][];
}

function decidedWeightFixture(): WeightTemplateParts {
  // 首段最小拉力从 0.1 调整为 0（已决策边界起点），三子表同构。
  const apply = (values: unknown[][]) => {
    const next = values.map((row) => [...row]);
    (next[1] as unknown[])[4] = "0";
    return next;
  };
  return { rod: apply(weightTemplate4837Rod()), reel: apply(weightTemplate4837Reel()), line: apply(weightTemplate4837Line()) };
}

async function productionState(parts: WeightTemplateParts = decidedWeightFixture()) {
  const state = createSeedState({ mode: "production" });
  const source = await pullFeishuWorkbookRevision({
    workbook: CANONICAL_FEISHU_WORKBOOK, registry: CANONICAL_FEISHU_SHEET_REGISTRY,
    pulledAt: "2026-07-24T00:00:00.000Z", pulledBy: "tester",
    adapter: {
      resolveWorkbook: async () => ({ spreadsheetToken: "WQ8wstS4ch29E2tAKnVcoh5KnJg", sourceRevision: "4837", sheets: [
        { sheetId: "1cAihB", name: "01.0_重量模板-竿", rowCount: 17, columnCount: 31 },
        { sheetId: "2KCCHR", name: "01.1_重量模板-轮", rowCount: 17, columnCount: 31 },
        { sheetId: "3FYijT", name: "01.2_重量模板-线", rowCount: 17, columnCount: 31 },
      ] }),
      readRanges: async () => [
        { sheetId: "1cAihB", range: "A1:AE17", revision: "4837", values: parts.rod },
        { sheetId: "2KCCHR", range: "A1:AE17", revision: "4837", values: parts.reel },
        { sheetId: "3FYijT", range: "A1:AE17", revision: "4837", values: parts.line },
      ],
    },
  });
  state.feishuSourceRevisions = [{ ...source, state: "PUBLISHED" }];
  return state;
}

test("4837 来源三子表 raw fixture 与新 W 段策略一致，解析成功", async () => {
  await assert.doesNotReject(() => productionState({ rod: weightTemplate4837Rod(), reel: weightTemplate4837Reel(), line: weightTemplate4837Line() }));
});

test("精确六段来源冻结名称/边界，并对篡改 fail-closed", async () => {
  const state = await productionState();
  const policy = state.feishuSourceRevisions[0]!.fiveAxisWeightBandPolicy!;
  assert.deepEqual(policy.bands, [
    { weightBandId: "W1", label: "微物", upperBoundKg: "1.5" }, { weightBandId: "W2", label: "小鱼", upperBoundKg: "3.8" },
    { weightBandId: "W3", label: "中鱼", upperBoundKg: "12.6" }, { weightBandId: "W4", label: "大鱼", upperBoundKg: "25.9" },
    { weightBandId: "W5", label: "巨物", upperBoundKg: "82.5" }, { weightBandId: "W6", label: "超级巨物", upperBoundKg: null },
  ]);
  assert.equal(weightTemplate4837Rod()[16]![5], "235");
  assert.equal(decidedWeightFixture().rod[1]![4], "0");
  assert.equal(policy.bands[5]!.upperBoundKg, null);
  // 三子表同改边界 → 三表一致但小鱼 upper 3.8→3.9，与 DECIDED_UPPER_BOUNDS 不符。
  const changedEverywhere = decidedWeightFixture();
  for (const part of [changedEverywhere.rod, changedEverywhere.reel, changedEverywhere.line]) {
    part[2]![5] = "3.9"; part[3]![4] = "3.9";
  }
  await assert.rejects(() => productionState(changedEverywhere), /FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID/);
  // 仅改竿子表 → 竿内部区间连续性破坏（小鱼 max=3.9 与中鱼 min=3.8 不连续）。
  const malformed = decidedWeightFixture();
  malformed.rod[2]![5] = "3.9";
  await assert.rejects(() => productionState(malformed), /FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID/);
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
  const sourcePayloadTamper = structuredClone(state);
  sourcePayloadTamper.feishuSourceRevisions[0]!.fiveAxisWeightBandPolicy!.bands[0]!.upperBoundKg = "999";
  assert.throws(() => publishFormalFiveAxisDefinition({ ...input, state: sourcePayloadTamper, capabilities: ["rules.five_axis.publish"] }), /SOURCE_EVIDENCE_INVALID/);
  const published = publishFormalFiveAxisDefinition({ ...input, capabilities: ["rules.five_axis.publish"] });
  assert.equal(published.idempotent, false);
  assert.equal(published.state.currentFiveAxisDispositionCatalogRevisionId, published.catalogRevisionId);
  assert.equal(published.state.configurationSnapshots.length, state.configurationSnapshots.length);
  const replay = publishFormalFiveAxisDefinition({ ...input, state: published.state, capabilities: ["rules.five_axis.publish"] });
  assert.equal(replay.idempotent, true);
});
