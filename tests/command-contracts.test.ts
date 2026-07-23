import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSnapshotMutationForbidden,
  createUnifiedIssue,
  generateModelCandidates,
  replayUnifiedTrace,
  requirePublishedPolicy,
  transitionPatchState,
  transitionUpgradeState,
  type CandidateGenerationRun,
  type CandidateRunStore,
  type UnifiedTraceEntry,
} from "../lib/command-contracts";
import { deterministicHash } from "../lib/rule-kernel";
import type { EntityRef } from "../lib/interaction-contracts";

function ref(entityType: EntityRef["entityType"], entityId: string, revisionId = "r1"): EntityRef {
  return { workspaceId: "workspace:1", entityType, entityId, revisionId };
}

function runStore(): CandidateRunStore {
  const values = new Map<string, CandidateGenerationRun>();
  return {
    async findByIdempotencyKey(key) { return values.get(key); },
    async save(key, run) { values.set(key, structuredClone(run)); },
  };
}

function hard(allowed: boolean) {
  return {
    allowed,
    matchedRules: [],
    decisiveRuleIds: allowed ? [] : ["deny:1"],
    failures: [],
    suggestions: [],
  };
}

function affinity(score: number) {
  return { score, contributions: [], matchedRuleIds: [], warnings: [] };
}

function request() {
  return {
    requestId: "request:1",
    seriesRef: ref("series", "series:1"),
    skuRefs: [ref("sku_drawer", "sku:1")],
    recipeRef: ref("model_candidate", "recipe:1"),
    recipeInput: {},
    maxResults: 3,
    sortDefinitionVersion: "sort-v1",
    inputHash: "input-1",
    idempotencyKey: "idempotency-1",
  };
}

test("R3 高Affinity命中deny只进排除统计，合法低分候选仍展示", async () => {
  const store = runStore();
  const run = await generateModelCandidates({
    request: request(),
    currentInputHash: "input-1",
    sortDefinition: { version: "sort-v1", recipeKeys: ["recipeOrder"] },
    store,
    enumerated: [
      {
        candidateFingerprint: "deny-high",
        skuRef: ref("sku_drawer", "sku:1"),
        projectionMatchRef: "projection:1",
        proposedConfiguration: {},
        hardCompatibility: hard(false),
        affinity: affinity(100),
        invariantIssueCount: 0,
        warningCount: 0,
        weightDistance: 0,
        recipeSortValues: { recipeOrder: 0 },
        rankReasons: [],
      },
      {
        candidateFingerprint: "legal-low",
        skuRef: ref("sku_drawer", "sku:1"),
        projectionMatchRef: "projection:1",
        proposedConfiguration: {},
        hardCompatibility: hard(true),
        affinity: affinity(-2),
        invariantIssueCount: 0,
        warningCount: 1,
        weightDistance: 0.2,
        recipeSortValues: { recipeOrder: 1 },
        rankReasons: [],
      },
    ],
  });
  assert.equal(run.excludedByHardCompatibility, 1);
  assert.deepEqual(run.candidates.map((entry) => entry.candidateFingerprint), ["legal-low"]);
});

test("R3 相同幂等键和inputHash恢复原run，revision变化标记superseded", async () => {
  const store = runStore();
  const first = await generateModelCandidates({
    request: request(),
    currentInputHash: "input-1",
    sortDefinition: { version: "sort-v1", recipeKeys: [] },
    enumerated: [],
    store,
  });
  const second = await generateModelCandidates({
    request: request(),
    currentInputHash: "different-later",
    sortDefinition: { version: "sort-v1", recipeKeys: [] },
    enumerated: [],
    store,
  });
  assert.deepEqual(second, first);

  const staleStore = runStore();
  const staleRequest = { ...request(), idempotencyKey: "stale-key" };
  const stale = await generateModelCandidates({
    request: staleRequest,
    currentInputHash: "new-input",
    sortDefinition: { version: "sort-v1", recipeKeys: [] },
    enumerated: [],
    store: staleStore,
  });
  assert.equal(stale.state, "superseded");
});

function traceEntry(
  sequence: number,
  before: number,
  operation: UnifiedTraceEntry["operation"],
  operand: number,
  after: number,
): UnifiedTraceEntry {
  return {
    traceEntryId: "trace:" + sequence,
    subjectRef: ref("model", "model:1"),
    parameterKey: "drag",
    sequence,
    layer: sequence === 1 ? "weight_template" : "model_patch",
    sourceVersion: "1",
    ruleSetVersion: "rules:1",
    before,
    operation,
    operand,
    after,
    inputHash: deterministicHash({ parameterKey: "drag", value: before }),
    outputHash: deterministicHash({ parameterKey: "drag", value: after }),
  };
}

test("R4 Trace按sequence重放并验证before/inputHash/outputHash", () => {
  const result = replayUnifiedTrace({
    initialValues: { drag: 10 },
    entries: [
      traceEntry(1, 10, "add", 2, 12),
      traceEntry(2, 12, "multiply", 1.5, 18),
    ],
  });
  assert.equal(result.values.drag, 18);
  const broken = traceEntry(1, 10, "add", 2, 12);
  broken.outputHash = "tampered";
  assert.throws(
    () => replayUnifiedTrace({ initialValues: { drag: 10 }, entries: [broken] }),
    /TRACE_REPLAY_MISMATCH/,
  );
});

test("R4 legacy UnifiedTrace跨subject共享全局sequence时按实际subject播种初始状态", () => {
  const secondSubjectEntry = traceEntry(2, 10, "add", 2, 12);
  secondSubjectEntry.subjectRef = ref("model", "model:2");
  const result = replayUnifiedTrace({
    initialValues: { drag: 10 },
    entries: [
      traceEntry(1, 10, "add", 2, 12),
      secondSubjectEntry,
    ],
  });
  assert.equal(result.values.drag, 12);
});

test("R9 error必阻断、deny不可waive、修复动作由Capability决定", () => {
  const issue = createUnifiedIssue({
    code: "HARD_DENY",
    source: "hard_compatibility",
    severity: "error",
    gate: "publish",
    subjectRef: ref("model", "model:1"),
    affectedRefs: [],
    parameterKeys: ["typeId"],
    title: "硬冲突",
    message: "类型不兼容",
    state: "open",
    deny: true,
    actionSpecs: [{
      actionId: "action:1",
      action: "edit_patch",
      label: "修正Patch",
      command: "create_patch",
      capabilities: ["model.patch.create"],
      heldCapabilities: ["model.read"],
    }],
  });
  assert.equal(issue.blocking, true);
  assert.equal(issue.actions[0].availability.enabled, false);
  assert.throws(
    () => createUnifiedIssue({
      ...issue,
      state: "waived",
      actionSpecs: [],
    }),
    /不允许 waive/,
  );
});

test("R10 Patch与UpgradeCandidate只允许权威状态迁移", () => {
  assert.equal(transitionPatchState("base_changed", "rebase_required"), "rebase_required");
  assert.equal(transitionPatchState("rebasing", "pending_review"), "pending_review");
  assert.throws(() => transitionPatchState("approved", "draft"), /非法/);
  assert.equal(transitionUpgradeState("ready_for_review", "approved"), "approved");
  assert.equal(
    transitionUpgradeState("approved", "published_as_new_snapshot"),
    "published_as_new_snapshot",
  );
  assert.throws(() => transitionUpgradeState("approved", "generated"), /非法/);
});

test("R10 Snapshot冻结语义不允许编辑、重算或换hash", () => {
  assert.throws(() => assertSnapshotMutationForbidden("recompute"), /已冻结/);
  assert.throws(() => assertSnapshotMutationForbidden("replace_hash"), /已冻结/);
});

test("R12 开放策略必须明确命中已发布版本，不用页面默认", () => {
  const policies = [
    { policyId: "patch-offset", version: "draft", status: "draft" as const, value: { warning: 0.1 } },
    { policyId: "patch-offset", version: "v1", status: "published" as const, value: { warning: 0.2 } },
  ];
  assert.equal(requirePublishedPolicy(policies, "patch-offset", "v1").value.warning, 0.2);
  assert.throws(
    () => requirePublishedPolicy(policies, "missing"),
    /配置不完整/,
  );
});
