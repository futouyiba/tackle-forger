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
        pullDistance: 0,
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
        pullDistance: 0.2,
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

test("R4 legacy UnifiedTrace扁平结果遇到多subject同名参数分歧时fail-closed", () => {
  const divergentSubjectEntry = traceEntry(2, 10, "add", 5, 15);
  divergentSubjectEntry.subjectRef = ref("model", "model:2");
  assert.throws(
    () => replayUnifiedTrace({
      initialValues: { drag: 10 },
      entries: [
        traceEntry(1, 10, "add", 2, 12),
        divergentSubjectEntry,
      ],
    }),
    /TRACE_REPLAY_MISMATCH.*无法表示多个 subject 的不同终态/,
  );
});

test("R4 legacy UnifiedTrace 的 32 位 hash 碰撞不能伪装为相同终态", () => {
  const left = "4x47h135er6o";
  const right = "a4f3v0xp2x1k";
  assert.equal(deterministicHash(left), deterministicHash(right));
  const collisionEntry = (
    sequence: number,
    modelId: string,
    after: string,
  ): UnifiedTraceEntry => ({
    traceEntryId: `trace:collision:${sequence}`,
    subjectRef: ref("model", modelId),
    parameterKey: "collision",
    sequence,
    layer: "model_patch",
    sourceVersion: "1",
    ruleSetVersion: "rules:1",
    before: null,
    operation: "set",
    operand: after,
    after,
    inputHash: deterministicHash({ parameterKey: "collision", value: null }),
    outputHash: deterministicHash({ parameterKey: "collision", value: after }),
  });
  assert.throws(
    () => replayUnifiedTrace({
      initialValues: { collision: null },
      entries: [
        collisionEntry(1, "model:1", left),
        collisionEntry(2, "model:2", right),
      ],
    }),
    /TRACE_REPLAY_MISMATCH.*无法表示多个 subject 的不同终态/,
  );
});

test("R9 Severity与Gate分离、BLOCKER不可waive、修复动作由Capability决定", () => {
  const issue = createUnifiedIssue({
    code: "HARD_DENY",
    source: "hard_compatibility",
    severity: "BLOCKER",
    gate: "PUBLISH",
    subjectRef: ref("model", "model:1"),
    affectedRefs: [],
    parameterKeys: ["typeId"],
    title: "硬冲突",
    message: "类型不兼容",
    state: "OPEN",
    inputHash: "input:1",
    ruleRefs: ["compatibility:v1"],
    actionSpecs: [{
      actionId: "action:1",
      action: "create_patch",
      label: "修正Patch",
      heldCapabilities: ["model.read"],
    }],
  });
  assert.equal(issue.severity, "BLOCKER");
  assert.equal(issue.gate, "PUBLISH");
  assert.equal("blocking" in issue, false);
  assert.equal(issue.actions[0].enabled, false);
  const enabledIssue = createUnifiedIssue({
    code: "PATCH_FIX_AVAILABLE",
    source: "patch",
    severity: "ERROR",
    gate: "REVIEW",
    subjectRef: ref("model", "model:1"),
    affectedRefs: [],
    parameterKeys: ["drag"],
    title: "可修复",
    message: "创建 Patch 修复。",
    state: "OPEN",
    inputHash: "input:enabled-action",
    ruleRefs: ["patch:v1"],
    actionSpecs: [{
      actionId: "action:enabled",
      action: "create_patch",
      label: "修正 Patch",
      heldCapabilities: ["model.patch.create"],
      commandPayloadRef: {
        payloadRefId: "payload:patch-fix",
        action: "create_patch",
        subjectRef: ref("model", "model:1"),
        expectedRevisionId: "1",
        inputHash: "input:enabled-action",
        payloadHash: "payload-hash",
        idempotencyKey: "patch-fix:1",
        leaseRef: {
          workspaceId: "workspace:1",
          leaseId: "lease:patch-fix",
          action: "create_patch",
          fencingToken: "fence:1",
        },
      },
    }],
  });
  assert.equal(enabledIssue.actions[0].enabled, true);
  assert.equal(enabledIssue.actions[0].commandPayloadRef?.payloadRefId, "payload:patch-fix");
  const disabledPayloadIssue = createUnifiedIssue({
    code: "PATCH_FIX_FORBIDDEN",
    source: "patch",
    severity: "ERROR",
    gate: "REVIEW",
    subjectRef: ref("model", "model:1"),
    affectedRefs: [],
    parameterKeys: ["drag"],
    title: "无权限修复",
    message: "没有修复权限时仍应能查看 Issue。",
    state: "OPEN",
    inputHash: "input:disabled-action",
    ruleRefs: ["patch:v1"],
    actionSpecs: [{
      actionId: "action:disabled-payload",
      action: "create_patch",
      label: "修正 Patch",
      heldCapabilities: [],
      commandPayloadRef: {
        payloadRefId: "payload:forbidden-patch-fix",
        action: "create_patch",
        subjectRef: ref("model", "model:1"),
        expectedRevisionId: "1",
        inputHash: "input:disabled-action",
        payloadHash: "payload-hash",
        idempotencyKey: "patch-fix:forbidden",
        leaseRef: {
          workspaceId: "workspace:1",
          leaseId: "lease:forbidden-patch-fix",
          action: "create_patch",
          fencingToken: "fence:2",
        },
      },
    }],
  });
  assert.equal(disabledPayloadIssue.actions[0].enabled, false);
  assert.equal(disabledPayloadIssue.actions[0].commandPayloadRef, undefined);
  assert.throws(
    () => createUnifiedIssue({
      code: issue.code,
      source: issue.source,
      severity: issue.severity,
      gate: issue.gate,
      subjectRef: issue.subjectRef,
      affectedRefs: issue.affectedRefs,
      parameterKeys: issue.parameterKeys,
      title: issue.title,
      message: issue.message,
      evidenceRefs: issue.evidenceRefs,
      ruleRefs: issue.ruleRefs,
      inputHash: issue.inputHash,
      state: "WAIVED",
      waiverRef: "waiver:forbidden",
      actionSpecs: [],
    }),
    /BLOCKER 永远不可 waive/,
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
