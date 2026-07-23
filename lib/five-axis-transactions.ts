import {
  createFormalFiveAxisVertexSet,
} from "./five-axis-formal";
import {
  compareUnsignedUtf8,
  hashCandidateEvidence,
  hashCandidateSet,
  hashCanonicalJson,
} from "./five-axis-hash";
import type {
  FiveAxisCandidateDelta,
  FiveAxisCandidateMembership,
  FiveAxisTransactionComponent,
  FiveAxisTransactionPlan,
  FiveAxisVertexCandidateSource,
  FiveAxisVertexGroupKey,
  FiveAxisVertexGroupState,
  FiveAxisVertexSet,
  FiveAxisViewDefinition,
  ConfigurationSnapshot,
  PurchasableModel,
} from "./types";
import { verifySnapshotIntegrity } from "./publishing";

function compareGroupKey(
  left: FiveAxisVertexGroupKey,
  right: FiveAxisVertexGroupKey,
): number {
  return compareUnsignedUtf8(left.weightBandId, right.weightBandId)
    || compareUnsignedUtf8(left.weightBandPolicyVersion, right.weightBandPolicyVersion)
    || compareUnsignedUtf8(left.fiveAxisDefinitionId, right.fiveAxisDefinitionId)
    || compareUnsignedUtf8(left.fiveAxisDefinitionVersion, right.fiveAxisDefinitionVersion)
    || compareUnsignedUtf8(left.fiveAxisRuleVersion, right.fiveAxisRuleVersion);
}

function groupIdentity(groupKey: FiveAxisVertexGroupKey): string {
  return hashCanonicalJson(groupKey as never);
}

function sameGroup(
  left: FiveAxisVertexGroupKey,
  right: FiveAxisVertexGroupKey,
): boolean {
  return compareGroupKey(left, right) === 0;
}

function assertMembership(
  membership: FiveAxisCandidateMembership,
  modelId: string,
): void {
  if (!membership.candidateSources.length) {
    throw new Error("FIVE_AXIS_CANDIDATE_DELTA_INVALID：候选成员不得为空。");
  }
  for (const source of membership.candidateSources) {
    if (source.candidateSemanticKey.modelId !== modelId) {
      throw new Error("FIVE_AXIS_CANDIDATE_DELTA_INVALID：候选来源与 delta.modelId 不一致。");
    }
  }
}

export function buildEligibleFiveAxisCandidateMembership(input: {
  modelId: string;
  lifecycle: "ACTIVE" | "DEPRECATED" | "ARCHIVED";
  configurationSnapshotId: string | null;
  frozenSnapshotId: string;
  groupKey: FiveAxisVertexGroupKey;
  candidateSources: FiveAxisVertexCandidateSource[];
}): FiveAxisCandidateMembership | null {
  if (input.lifecycle !== "ACTIVE") return null;
  if (!input.configurationSnapshotId) {
    throw new Error("FIVE_AXIS_CANDIDATE_INELIGIBLE：ACTIVE Model 缺少 configurationSnapshotId。");
  }
  if (input.configurationSnapshotId !== input.frozenSnapshotId) {
    throw new Error("FIVE_AXIS_CANDIDATE_INELIGIBLE：候选不是 Model 当前明确指向的 Snapshot。");
  }
  const membership = {
    groupKey: structuredClone(input.groupKey),
    candidateSources: structuredClone(input.candidateSources),
  };
  assertMembership(membership, input.modelId);
  if (membership.candidateSources.some((source) =>
    source.snapshotId !== input.configurationSnapshotId)) {
    throw new Error("FIVE_AXIS_CANDIDATE_INELIGIBLE：候选来源 Snapshot 指针不一致。");
  }
  return membership;
}

export function createFiveAxisCandidateDeltas(input: {
  changeId: string;
  modelId: string;
  before: FiveAxisCandidateMembership | null;
  after: FiveAxisCandidateMembership | null;
}): FiveAxisCandidateDelta[] {
  if (!input.before && !input.after) return [];
  if (input.before) assertMembership(input.before, input.modelId);
  if (input.after) assertMembership(input.after, input.modelId);
  if (!input.before && input.after) {
    return [{
      deltaId: `${input.changeId}:add`,
      modelId: input.modelId,
      operation: "ADD",
      groupKey: structuredClone(input.after.groupKey),
      before: null,
      after: structuredClone(input.after),
      migrationId: null,
    }];
  }
  if (input.before && !input.after) {
    return [{
      deltaId: `${input.changeId}:remove`,
      modelId: input.modelId,
      operation: "REMOVE",
      groupKey: structuredClone(input.before.groupKey),
      before: structuredClone(input.before),
      after: null,
      migrationId: null,
    }];
  }
  if (sameGroup(input.before!.groupKey, input.after!.groupKey)) {
    return [{
      deltaId: `${input.changeId}:replace`,
      modelId: input.modelId,
      operation: "REPLACE",
      groupKey: structuredClone(input.after!.groupKey),
      before: structuredClone(input.before),
      after: structuredClone(input.after),
      migrationId: null,
    }];
  }
  return [
    {
      deltaId: `${input.changeId}:remove`,
      modelId: input.modelId,
      operation: "REMOVE",
      groupKey: structuredClone(input.before!.groupKey),
      before: structuredClone(input.before),
      after: null,
      migrationId: input.changeId,
    },
    {
      deltaId: `${input.changeId}:add`,
      modelId: input.modelId,
      operation: "ADD",
      groupKey: structuredClone(input.after!.groupKey),
      before: null,
      after: structuredClone(input.after),
      migrationId: input.changeId,
    },
  ];
}

export function createFiveAxisLifecycleCandidateDeltas(input: {
  changeId: string;
  modelId: string;
  beforeLifecycle: "ACTIVE" | "DEPRECATED" | "ARCHIVED";
  afterLifecycle: "ACTIVE" | "DEPRECATED" | "ARCHIVED";
  frozenMembership: FiveAxisCandidateMembership;
}): FiveAxisCandidateDelta[] {
  const beforeEligible = input.beforeLifecycle === "ACTIVE";
  const afterEligible = input.afterLifecycle === "ACTIVE";
  if (beforeEligible === afterEligible) return [];
  return createFiveAxisCandidateDeltas({
    changeId: input.changeId,
    modelId: input.modelId,
    before: beforeEligible ? input.frozenMembership : null,
    after: afterEligible ? input.frozenMembership : null,
  });
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(value: string): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: string): string {
    const parent = this.parent.get(value);
    if (!parent) throw new Error("依赖图节点不存在。");
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

export function planFiveAxisTransactions(input: {
  deltas: FiveAxisCandidateDelta[];
  snapshotBuildModelIds?: string[];
}): FiveAxisTransactionPlan {
  const groupByIdentity = new Map<string, FiveAxisVertexGroupKey>();
  const unionFind = new UnionFind();
  for (const delta of input.deltas) {
    const identity = groupIdentity(delta.groupKey);
    unionFind.add(identity);
    groupByIdentity.set(identity, structuredClone(delta.groupKey));
  }
  const migrations = new Map<string, string[]>();
  for (const delta of input.deltas) {
    if (!delta.migrationId) continue;
    const identities = migrations.get(delta.migrationId) ?? [];
    identities.push(groupIdentity(delta.groupKey));
    migrations.set(delta.migrationId, identities);
  }
  for (const identities of migrations.values()) {
    const [first, ...rest] = identities;
    for (const identity of rest) unionFind.union(first, identity);
  }
  const identitiesByRoot = new Map<string, string[]>();
  for (const identity of groupByIdentity.keys()) {
    const root = unionFind.find(identity);
    identitiesByRoot.set(root, [...(identitiesByRoot.get(root) ?? []), identity]);
  }
  const buildModels = new Set(input.snapshotBuildModelIds ?? []);
  const components = [...identitiesByRoot.values()].map((identities) => {
    const groupKeys = identities.map((identity) => groupByIdentity.get(identity)!)
      .sort(compareGroupKey);
    const identitySet = new Set(identities);
    const deltas = input.deltas.filter((delta) =>
      identitySet.has(groupIdentity(delta.groupKey)))
      .sort((left, right) => left.deltaId.localeCompare(right.deltaId));
    const snapshotBuildModelIds = [...new Set(deltas
      .filter((delta) => buildModels.has(delta.modelId))
      .map((delta) => delta.modelId))].sort(compareUnsignedUtf8);
    return {
      componentId: `five-axis-component:${groupIdentity(groupKeys[0]).slice(0, 20)}`,
      groupKeys,
      deltas,
      snapshotBuildModelIds,
    };
  }).sort((left, right) => compareGroupKey(left.groupKeys[0], right.groupKeys[0]));
  return {
    components,
    inputHash: hashCanonicalJson({
      components: components.map((component) => ({
        groupKeys: component.groupKeys,
        deltas: component.deltas,
        snapshotBuildModelIds: component.snapshotBuildModelIds,
      })),
    } as never),
  };
}

function candidatesByModel(
  sources: FiveAxisVertexCandidateSource[],
): Map<string, FiveAxisVertexCandidateSource[]> {
  const result = new Map<string, FiveAxisVertexCandidateSource[]>();
  for (const source of sources) {
    const modelId = source.candidateSemanticKey.modelId;
    result.set(modelId, [...(result.get(modelId) ?? []), structuredClone(source)]);
  }
  return result;
}

function candidateSnapshotIds(sources: FiveAxisVertexCandidateSource[]): string[] {
  return [...new Set(sources.map((source) => source.snapshotId))]
    .sort(compareUnsignedUtf8);
}

function membershipEvidenceHash(
  groupKey: FiveAxisVertexGroupKey,
  sources: FiveAxisVertexCandidateSource[],
): string {
  return hashCandidateEvidence({
    vertexGroupKey: groupKey,
    candidates: sources.map((source) => ({
      key: source.candidateSemanticKey,
      snapshotId: source.snapshotId,
      modelRevisionId: source.modelRevisionId,
      semanticInputHash: source.semanticInputHash,
    })),
  });
}

function missingAxisIds(
  definition: FiveAxisViewDefinition,
  sources: FiveAxisVertexCandidateSource[],
): string[] {
  return definition.axes.flatMap((axis) =>
    sources.some((source) => source.directInputs.some((entry) =>
      entry.axisId === axis.axisId && Number(entry.rawValue) > 0))
      ? []
      : [axis.axisId]);
}

function emptyGroupHashes(
  groupKey: FiveAxisVertexGroupKey,
): { candidateSetHash: string; candidateEvidenceHash: string } {
  return {
    candidateSetHash: hashCandidateSet({
      vertexGroupKey: groupKey,
      candidates: [],
    }),
    candidateEvidenceHash: hashCandidateEvidence({
      vertexGroupKey: groupKey,
      candidates: [],
    }),
  };
}

export interface FiveAxisConcurrencyExpectation {
  groupKey: FiveAxisVertexGroupKey;
  expectedVertexSetHash: string | null;
  expectedCandidateEvidenceHash: string | null;
  expectedCandidateSnapshotIds: string[];
}

export function applyFiveAxisTransactionComponent(input: {
  component: FiveAxisTransactionComponent;
  definitions: FiveAxisViewDefinition[];
  currentGroupStates: FiveAxisVertexGroupState[];
  expectations?: FiveAxisConcurrencyExpectation[];
}): {
  groupStates: FiveAxisVertexGroupState[];
  vertexSets: FiveAxisVertexSet[];
  semanticChangedGroupKeys: FiveAxisVertexGroupKey[];
} {
  const currentByIdentity = new Map(input.currentGroupStates.map((state) =>
    [groupIdentity(state.groupKey), structuredClone(state)]));
  const expectations = new Map((input.expectations ?? []).map((expectation) =>
    [groupIdentity(expectation.groupKey), expectation]));
  const nextStates = new Map(currentByIdentity);
  const vertexSets: FiveAxisVertexSet[] = [];
  const semanticChangedGroupKeys: FiveAxisVertexGroupKey[] = [];

  for (const groupKey of input.component.groupKeys) {
    const identity = groupIdentity(groupKey);
    const current = currentByIdentity.get(identity);
    const expectation = expectations.get(identity);
    if (expectation) {
      const currentSnapshots = candidateSnapshotIds(current?.candidateSources ?? []);
      if (
        (current?.currentVertexSetHash ?? null) !== expectation.expectedVertexSetHash
        || (current?.candidateEvidenceHash ?? null)
          !== expectation.expectedCandidateEvidenceHash
        || JSON.stringify(currentSnapshots)
          !== JSON.stringify([...expectation.expectedCandidateSnapshotIds].sort(compareUnsignedUtf8))
      ) {
        throw new Error("FIVE_AXIS_CONCURRENT_VERTEX_CONFLICT：顶点或候选证据已变化。");
      }
    }
    const candidates = candidatesByModel(current?.candidateSources ?? []);
    const deltas = input.component.deltas.filter((delta) =>
      sameGroup(delta.groupKey, groupKey));
    for (const delta of deltas) {
      if (delta.before) {
        const existing = candidates.get(delta.modelId);
        if (
          !existing
          || membershipEvidenceHash(groupKey, existing)
            !== membershipEvidenceHash(groupKey, delta.before.candidateSources)
        ) {
          throw new Error("FIVE_AXIS_CANDIDATE_DELTA_CONFLICT：before 候选证据与当前指针不一致。");
        }
      }
      if (delta.operation === "REMOVE") {
        candidates.delete(delta.modelId);
      } else if (delta.operation === "ADD") {
        if (candidates.has(delta.modelId)) {
          throw new Error("FIVE_AXIS_CANDIDATE_DELTA_CONFLICT：ADD 的 Model 已在目标组。");
        }
        candidates.set(
          delta.modelId,
          structuredClone(delta.after?.candidateSources ?? []),
        );
      } else {
        if (!candidates.has(delta.modelId)) {
          throw new Error("FIVE_AXIS_CANDIDATE_DELTA_CONFLICT：REPLACE 的旧候选不存在。");
        }
        candidates.set(
          delta.modelId,
          structuredClone(delta.after?.candidateSources ?? []),
        );
      }
    }
    const targetSources = [...candidates.values()].flat();
    const definition = input.definitions.find((entry) =>
      entry.definitionId === groupKey.fiveAxisDefinitionId
      && entry.version === groupKey.fiveAxisDefinitionVersion);
    if (!definition) {
      throw new Error("FIVE_AXIS_FORMAL_DEFINITION_UNAVAILABLE：事务组定义不存在。");
    }
    const missing = missingAxisIds(definition, targetSources);
    const hasSnapshotBuild = input.component.snapshotBuildModelIds.some((modelId) =>
      deltas.some((delta) => delta.modelId === modelId));
    if (missing.length) {
      if (hasSnapshotBuild) {
        throw new Error(
          `FIVE_AXIS_VERTEX_BOOTSTRAP_INCOMPLETE：缺少 ${missing.join("、")} 顶点候选。`,
        );
      }
      const hashes = targetSources.length
        ? {
            candidateSetHash: hashCandidateSet({
              vertexGroupKey: groupKey,
              candidates: targetSources.map((source) => ({
                key: source.candidateSemanticKey,
                semanticInputHash: source.semanticInputHash,
              })),
            }),
            candidateEvidenceHash: hashCandidateEvidence({
              vertexGroupKey: groupKey,
              candidates: targetSources.map((source) => ({
                key: source.candidateSemanticKey,
                snapshotId: source.snapshotId,
                modelRevisionId: source.modelRevisionId,
                semanticInputHash: source.semanticInputHash,
              })),
            }),
          }
        : emptyGroupHashes(groupKey);
      nextStates.set(identity, {
        groupKey: structuredClone(groupKey),
        state: "UNAVAILABLE_NO_ELIGIBLE_CANDIDATE",
        candidateSources: structuredClone(targetSources),
        candidateSetHash: hashes.candidateSetHash,
        candidateEvidenceHash: hashes.candidateEvidenceHash,
        currentVertexSetId: null,
        currentVertexSetHash: null,
        missingAxisIds: missing,
        reasonCode: "UNAVAILABLE_NO_ELIGIBLE_CANDIDATE",
      });
      if (current?.currentVertexSetHash !== null) {
        semanticChangedGroupKeys.push(structuredClone(groupKey));
      }
      continue;
    }
    const vertexSet = createFormalFiveAxisVertexSet({
      definition,
      groupKey,
      candidateSources: targetSources,
    });
    nextStates.set(identity, {
      groupKey: structuredClone(groupKey),
      state: "AVAILABLE",
      candidateSources: structuredClone(targetSources),
      candidateSetHash: vertexSet.candidateSetHash,
      candidateEvidenceHash: vertexSet.candidateEvidenceHash,
      currentVertexSetId: vertexSet.vertexSetId,
      currentVertexSetHash: vertexSet.vertexSetHash,
      missingAxisIds: [],
      reasonCode: null,
    });
    vertexSets.push(vertexSet);
    if (current?.currentVertexSetHash !== vertexSet.vertexSetHash) {
      semanticChangedGroupKeys.push(structuredClone(groupKey));
    }
  }
  return {
    groupStates: [...nextStates.values()],
    vertexSets,
    semanticChangedGroupKeys,
  };
}

export function executeFiveAxisTransactionPlan(input: {
  plan: FiveAxisTransactionPlan;
  definitions: FiveAxisViewDefinition[];
  currentGroupStates: FiveAxisVertexGroupState[];
  expectations?: FiveAxisConcurrencyExpectation[];
  failComponentIds?: string[];
}): {
  groupStates: FiveAxisVertexGroupState[];
  vertexSets: FiveAxisVertexSet[];
  componentResults: Array<{
    componentId: string;
    state: "committed" | "rolled_back";
    error: string | null;
  }>;
} {
  let groupStates = structuredClone(input.currentGroupStates);
  const vertexSets: FiveAxisVertexSet[] = [];
  const componentResults: Array<{
    componentId: string;
    state: "committed" | "rolled_back";
    error: string | null;
  }> = [];
  for (const component of input.plan.components) {
    try {
      if (input.failComponentIds?.includes(component.componentId)) {
        throw new Error("INJECTED_COMPONENT_FAILURE");
      }
      const result = applyFiveAxisTransactionComponent({
        component,
        definitions: input.definitions,
        currentGroupStates: groupStates,
        expectations: input.expectations?.filter((expectation) =>
          component.groupKeys.some((groupKey) =>
            sameGroup(groupKey, expectation.groupKey))),
      });
      groupStates = result.groupStates;
      vertexSets.push(...result.vertexSets);
      componentResults.push({
        componentId: component.componentId,
        state: "committed",
        error: null,
      });
    } catch (error) {
      componentResults.push({
        componentId: component.componentId,
        state: "rolled_back",
        error: error instanceof Error ? error.message : "未知五维事务错误。",
      });
    }
  }
  return { groupStates, vertexSets, componentResults };
}

export function executeFiveAxisSnapshotBatchTransactions(input: {
  plan: FiveAxisTransactionPlan;
  definitions: FiveAxisViewDefinition[];
  currentGroupStates: FiveAxisVertexGroupState[];
  currentVertexSets: FiveAxisVertexSet[];
  currentModels: PurchasableModel[];
  currentSnapshots: ConfigurationSnapshot[];
  snapshotCommits: Array<{
    modelId: string;
    snapshot: ConfigurationSnapshot;
  }>;
  expectations?: FiveAxisConcurrencyExpectation[];
  failComponentIds?: string[];
}): {
  groupStates: FiveAxisVertexGroupState[];
  vertexSets: FiveAxisVertexSet[];
  models: PurchasableModel[];
  snapshots: ConfigurationSnapshot[];
  componentResults: Array<{
    componentId: string;
    state: "committed" | "rolled_back";
    error: string | null;
  }>;
} {
  let groupStates = structuredClone(input.currentGroupStates);
  const vertexSets = structuredClone(input.currentVertexSets);
  let models = structuredClone(input.currentModels);
  let snapshots = structuredClone(input.currentSnapshots);
  const componentResults: Array<{
    componentId: string;
    state: "committed" | "rolled_back";
    error: string | null;
  }> = [];
  for (const component of input.plan.components) {
    try {
      if (input.failComponentIds?.includes(component.componentId)) {
        throw new Error("INJECTED_COMPONENT_FAILURE");
      }
      const stagedFiveAxis = applyFiveAxisTransactionComponent({
        component,
        definitions: input.definitions,
        currentGroupStates: groupStates,
        expectations: input.expectations?.filter((expectation) =>
          component.groupKeys.some((groupKey) =>
            sameGroup(groupKey, expectation.groupKey))),
      });
      const componentModels = new Set(component.deltas.map((delta) => delta.modelId));
      const stagedModels = structuredClone(models);
      const stagedSnapshots = structuredClone(snapshots);
      for (const commit of input.snapshotCommits.filter((entry) =>
        componentModels.has(entry.modelId))) {
        if (
          commit.snapshot.modelId !== commit.modelId
          || !verifySnapshotIntegrity(commit.snapshot)
        ) {
          throw new Error("FIVE_AXIS_SNAPSHOT_COMMIT_INVALID：Snapshot 归属或 contentHash 无效。");
        }
        const delta = component.deltas.find((entry) =>
          entry.modelId === commit.modelId && entry.after);
        if (
          !delta?.after
          || delta.after.candidateSources.some((source) =>
            source.snapshotId !== commit.snapshot.id)
        ) {
          throw new Error("FIVE_AXIS_SNAPSHOT_COMMIT_INVALID：Snapshot 与候选差量指针不一致。");
        }
        const modelIndex = stagedModels.findIndex((model) =>
          model.id === commit.modelId);
        if (modelIndex < 0) {
          throw new Error("FIVE_AXIS_SNAPSHOT_COMMIT_INVALID：待更新 Model 不存在。");
        }
        const existing = stagedSnapshots.find((snapshot) =>
          snapshot.id === commit.snapshot.id);
        if (existing && existing.contentHash !== commit.snapshot.contentHash) {
          throw new Error("FIVE_AXIS_SNAPSHOT_COMMIT_INVALID：预分配 snapshotId 内容冲突。");
        }
        if (!existing) stagedSnapshots.push(structuredClone(commit.snapshot));
        stagedModels[modelIndex] = {
          ...stagedModels[modelIndex],
          configurationSnapshotId: commit.snapshot.id,
        };
      }
      groupStates = stagedFiveAxis.groupStates;
      for (const vertexSet of stagedFiveAxis.vertexSets) {
        if (!vertexSets.some((entry) =>
          entry.vertexSetId === vertexSet.vertexSetId
          && entry.candidateEvidenceHash === vertexSet.candidateEvidenceHash)) {
          vertexSets.push(vertexSet);
        }
      }
      models = stagedModels;
      snapshots = stagedSnapshots;
      componentResults.push({
        componentId: component.componentId,
        state: "committed",
        error: null,
      });
    } catch (error) {
      componentResults.push({
        componentId: component.componentId,
        state: "rolled_back",
        error: error instanceof Error ? error.message : "未知五维批次事务错误。",
      });
    }
  }
  return {
    groupStates,
    vertexSets,
    models,
    snapshots,
    componentResults,
  };
}
