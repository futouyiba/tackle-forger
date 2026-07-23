import assert from "node:assert/strict";
import test from "node:test";
import {
  approveConfigTargetScanManifest,
  assertFrozenConfigIdentityTransition,
  CANONICAL_CONFIG_ID_RANGES,
  configIdCapacityStatus,
  ConfigIdGovernanceError,
  emptyConfigIdGovernanceState,
  migrateConfigIdGovernanceState,
  normalizeStableModelKey,
  publishConfigIdPolicyVersion,
  publishConfigTargetCatalogVersion,
  reserveConfigIdBundle,
  resolveConfigTargetPhysicalRefGroups,
  transitionConfigIdBundleState,
  type ConfigIdGovernanceState,
  type ConfigTargetObservedState,
  type ConfigTargetSerializationCheckpoint,
  type ReserveConfigIdBundleCommand,
  type ReserveConfigIdBundleContext,
} from "../lib/config-id-governance";
import {
  reserveConfigIdBundlePersisted,
  type ConfigIdWorkspaceRepository,
} from "../lib/config-id-reservation-service";
import { PHASE_ONE_CAPABILITIES } from "../lib/feishu-identity";
import { sha256Hex } from "../lib/deterministic-sha256";
import { migrateWorkspaceState } from "../lib/migrations";
import { createSeedState } from "../lib/seed";
import type { WorkspaceState } from "../lib/types";

const NOW = "2026-07-23T01:02:03.000Z";

function errorCode(error: unknown) {
  return error instanceof ConfigIdGovernanceError ? error.code : undefined;
}

function buildGovernanceFixture() {
  const state = createSeedState();
  const first = state.purchasableModels[0]!;
  first.stableModelKey = " Alpha ";

  let governance = publishConfigTargetCatalogVersion(emptyConfigIdGovernanceState(), {
    catalogVersionId: "catalog:v1",
    entries: [
      {
        targetEntryId: "target:dev",
        environmentId: "dev",
        channelKey: "default",
        repositoryId: "repo:game-config",
        authoritativeRef: "refs/heads/config",
        logicalDirectory: "dev",
        configTomlPath: "dev/config.toml",
        requiredForFormal: true,
      },
      {
        targetEntryId: "target:test",
        environmentId: "test",
        channelKey: "default",
        repositoryId: "repo:game-config",
        authoritativeRef: "refs/heads/config",
        logicalDirectory: "test",
        configTomlPath: "test/config.toml",
        requiredForFormal: true,
      },
    ],
    approvedBy: "reviewer",
    approvedAt: NOW,
  });

  for (const [targetEntryId, logicalDirectory] of [
    ["target:dev", "dev"],
    ["target:test", "test"],
  ] as const) {
    governance = approveConfigTargetScanManifest(governance, {
      manifestId: `manifest:${logicalDirectory}:v1`,
      catalogVersionId: "catalog:v1",
      targetEntryId,
      environmentId: logicalDirectory,
      channelKey: "default",
      repositoryId: "repo:game-config",
      authoritativeRef: "refs/heads/config",
      resolvedCommitOid: "a".repeat(40),
      logicalDirectory,
      configTomlHash: `config-${logicalDirectory}-hash`,
      workbooks: [{
        logicalName: "tackle",
        workbookPath: `${logicalDirectory}/tackle.xlsx`,
        sheetNames: ["TackleItem", "GoodsBasic", "StoreBuy"],
        workbookHash: `workbook-${logicalDirectory}-hash`,
      }],
      scannerVersion: "scanner:v1",
      ruleVersion: "open-008:v1",
      verifiedRangeIds: CANONICAL_CONFIG_ID_RANGES.map((range) => range.rangeId),
      issueCodes: [],
      scannedBy: "scanner",
      scannedAt: NOW,
      approvedBy: "reviewer",
      approvedAt: NOW,
    });
  }

  const observations = observationsFor(governance);
  governance = publishConfigIdPolicyVersion(governance, {
    policyVersionId: "policy:v1",
    catalogVersionId: "catalog:v1",
    manifestIds: ["manifest:dev:v1", "manifest:test:v1"],
    ranges: CANONICAL_CONFIG_ID_RANGES.map((range) => ({ ...range })),
    publishedBy: "reviewer",
    publishedAt: NOW,
    observedTargets: observations,
  });
  state.configIdGovernance = governance;
  const policy = governance.policies[0]!;
  const catalog = governance.catalogs[0]!;
  const manifests = policy.manifestIds.map((id) =>
    governance.scanManifests.find((entry) => entry.manifestId === id)!);
  const checkpoint: ConfigTargetSerializationCheckpoint = {
    state: "COMMITTING",
    leaseId: "lease:1",
    fencingToken: "1",
    operationId: "operation:1",
    catalogVersionId: policy.catalogVersionId,
    manifestSetHash: policy.manifestSetHash,
    physicalRefs: resolveConfigTargetPhysicalRefGroups(catalog, manifests),
    targets: manifests.map((manifest) => ({
      targetEntryId: manifest.targetEntryId,
      repositoryId: manifest.repositoryId,
      authoritativeRef: manifest.authoritativeRef,
      expectedCommitOid: manifest.resolvedCommitOid,
      configTomlHash: manifest.configTomlHash,
      workbookSetHash: manifest.workbookSetHash,
    })).sort((left, right) => left.targetEntryId.localeCompare(right.targetEntryId)),
    expiresAt: "2026-07-24T01:02:03.000Z",
    protectedRefCasAvailable: true,
    latestFencingTokenVerified: true,
  };
  return { state, governance, observations, checkpoint };
}

function observationsFor(governance: ConfigIdGovernanceState): ConfigTargetObservedState[] {
  return governance.scanManifests.map((manifest) => ({
    targetEntryId: manifest.targetEntryId,
    repositoryId: manifest.repositoryId,
    authoritativeRef: manifest.authoritativeRef,
    resolvedCommitOid: manifest.resolvedCommitOid,
    logicalDirectory: manifest.logicalDirectory,
    configTomlHash: manifest.configTomlHash,
    workbookSetHash: manifest.workbookSetHash,
  }));
}

function reservationInput(
  state: WorkspaceState,
  modelIndex = 0,
  key = "alpha",
  idempotencyKey = "idem:1",
) {
  const policy = state.configIdGovernance.policies.at(-1)!;
  const model = state.purchasableModels[modelIndex]!;
  model.stableModelKey ??= key;
  const command: ReserveConfigIdBundleCommand = {
    modelId: model.id,
    expectedModelRevisionId: String(model.revision),
    part: "rod",
    expectedNormalizedStableModelKey: key,
    policyVersionId: policy.policyVersionId,
    expectedManifestSetHash: policy.manifestSetHash,
    idempotencyKey,
  };
  return command;
}

function contextFor(
  observations: ConfigTargetObservedState[],
  checkpoint?: ConfigTargetSerializationCheckpoint,
): ReserveConfigIdBundleContext {
  return {
    observedTargets: observations,
    serializationCheckpoint: checkpoint,
    actor: "tester",
    now: NOW,
  };
}

test("stableModelKey 只裁 ASCII 空白并执行 ASCII 小写规则", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(normalizeStableModelKey("\t Alpha_01 \r\n"), "alpha_01");
  assert.throws(() => normalizeStableModelKey("\u00A0Alpha\u00A0"), (error) =>
    errorCode(error) === "STABLE_MODEL_KEY_INVALID");
  assert.throws(() => normalizeStableModelKey("1alpha"), (error) =>
    errorCode(error) === "STABLE_MODEL_KEY_INVALID");
});

test("策略发布验证获批新鲜 Manifest，并把同一物理 ref 别名折叠为一组", () => {
  const { governance, checkpoint } = buildGovernanceFixture();
  assert.equal(governance.policies.length, 1);
  assert.equal(checkpoint.physicalRefs.length, 1);
  assert.deepEqual(checkpoint.physicalRefs[0]!.targetEntryIds, ["target:dev", "target:test"]);
});

test("同一物理 Git ref 别名的 expected OID 不一致时 fail closed", () => {
  const { governance } = buildGovernanceFixture();
  const manifests = structuredClone(governance.scanManifests);
  manifests[1]!.resolvedCommitOid = "b".repeat(40);
  assert.throws(
    () => resolveConfigTargetPhysicalRefGroups(governance.catalogs[0]!, manifests),
    (error) => errorCode(error) === "CONFIG_TARGET_REF_ALIAS_CONFLICT",
  );
});

test("Manifest 必须无问题且逐项验证策略声明的 rangeId", () => {
  const fixture = buildGovernanceFixture();
  assert.throws(
    () => publishConfigIdPolicyVersion(fixture.governance, {
      policyVersionId: "policy:partial-ranges",
      catalogVersionId: "catalog:v1",
      manifestIds: ["manifest:dev:v1", "manifest:test:v1"],
      ranges: [{ ...CANONICAL_CONFIG_ID_RANGES[0]! }],
      publishedBy: "reviewer",
      publishedAt: NOW,
      observedTargets: fixture.observations,
    }),
    (error) => errorCode(error) === "CONFIG_TARGET_SCAN_MANIFEST_RANGE_MISMATCH",
  );
});

test("陈旧 Manifest、缺失串行化证明与 Model head 冲突均不消耗游标", () => {
  const { state, observations, checkpoint } = buildGovernanceFixture();
  const command = reservationInput(state);
  const before = structuredClone(state.configIdGovernance);
  const stale = structuredClone(observations);
  stale[0]!.resolvedCommitOid = "c".repeat(40);
  assert.throws(
    () => reserveConfigIdBundle(state, command, contextFor(stale, checkpoint)),
    (error) => errorCode(error) === "CONFIG_TARGET_SCAN_MANIFEST_STALE",
  );
  assert.throws(
    () => reserveConfigIdBundle(state, command, contextFor(observations)),
    (error) => errorCode(error) === "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
  );
  assert.throws(
    () => reserveConfigIdBundle(state, command, contextFor(observations, {
      ...checkpoint,
      expiresAt: NOW,
    })),
    (error) => errorCode(error) === "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
  );
  const moved = structuredClone(state);
  moved.purchasableModels[0]!.revision += 1;
  assert.throws(
    () => reserveConfigIdBundle(moved, command, contextFor(observations, checkpoint)),
    (error) => errorCode(error) === "MODEL_REVISION_CONFLICT",
  );
  assert.deepEqual(state.configIdGovernance, before);
});

test("Bundle 预留原子提交三类 ID、三类名称、Model successor、ledger 与 cursor", () => {
  const { state, observations, checkpoint } = buildGovernanceFixture();
  const snapshots = structuredClone(state.configurationSnapshots);
  const original = structuredClone(state.purchasableModels[0]!);
  const transition = reserveConfigIdBundle(
    state,
    reservationInput(state),
    contextFor(observations, checkpoint),
  );
  assert.equal(transition.result.bundle.tackleItem.configNumericId, "301800001");
  assert.equal(transition.result.bundle.goodsBasic.configNumericId, "10301800001");
  assert.equal(transition.result.bundle.storeBuy.configNumericId, "30301800001");
  assert.equal(transition.result.bundle.tackleItem.configNameKey, "tf_rod_alpha");
  assert.equal(transition.result.bundle.goodsBasic.configNameKey, "store_tf_rod_alpha");
  assert.equal(transition.result.bundle.storeBuy.configNameKey, "buy_tf_rod_alpha");
  assert.equal(transition.state.purchasableModels[0]!.revision, original.revision + 1);
  assert.equal(
    transition.state.purchasableModels[0]!.configIdBundleRef,
    transition.result.bundle.bundleId,
  );
  assert.deepEqual(transition.state.configurationSnapshots, snapshots);
  assert.deepEqual(transition.state.configIdGovernance.modelRevisionArchive, [original]);
  assert.equal(transition.state.configIdGovernance.reservationLedger.length, 1);
  assert.equal(transition.state.configIdGovernance.rangeCursors[0]!.lastAllocatedBaseId, "301800001");
});

test("同一幂等命令重试返回原结果，即使实时上下文随后不可用", () => {
  const { state, observations, checkpoint } = buildGovernanceFixture();
  const command = reservationInput(state);
  const first = reserveConfigIdBundle(state, command, contextFor(observations, checkpoint));
  const retry = reserveConfigIdBundle(first.state, command, contextFor([]));
  assert.equal(retry.idempotent, true);
  assert.deepEqual(retry.result, first.result);
  assert.equal(retry.state.configIdGovernance.reservationLedger.length, 1);
  assert.equal(retry.state.configIdGovernance.rangeCursors.length, 1);
});

test("游标跨策略版本继承、跳过 000，废弃编号永不复用", () => {
  const fixture = buildGovernanceFixture();
  fixture.state.configIdGovernance.rangeCursors = [{
    rangeId: CANONICAL_CONFIG_ID_RANGES[0]!.rangeId,
    lastAllocatedBaseId: "301800999",
    updatedAt: NOW,
  }];
  const first = reserveConfigIdBundle(
    fixture.state,
    reservationInput(fixture.state),
    contextFor(fixture.observations, fixture.checkpoint),
  );
  assert.equal(first.result.bundle.tackleItem.configNumericId, "301801001");
  const abandoned = transitionConfigIdBundleState(first.state, {
    bundleId: first.result.bundle.bundleId,
    nextStatus: "ABANDONED",
    actor: "tester",
    occurredAt: NOW,
    reason: "产品取消",
  });
  const governanceV2 = publishConfigIdPolicyVersion(abandoned.configIdGovernance, {
    policyVersionId: "policy:v2",
    catalogVersionId: "catalog:v1",
    manifestIds: ["manifest:dev:v1", "manifest:test:v1"],
    ranges: CANONICAL_CONFIG_ID_RANGES.map((range) => ({ ...range })),
    publishedBy: "reviewer",
    publishedAt: NOW,
    observedTargets: fixture.observations,
  });
  abandoned.configIdGovernance = governanceV2;
  const secondCommand = reservationInput(abandoned, 1, "beta", "idem:2");
  secondCommand.policyVersionId = "policy:v2";
  secondCommand.expectedManifestSetHash = governanceV2.policies.at(-1)!.manifestSetHash;
  const second = reserveConfigIdBundle(
    abandoned,
    secondCommand,
    contextFor(fixture.observations, {
      ...fixture.checkpoint,
      operationId: "operation:2",
      leaseId: "lease:2",
      fencingToken: "2",
    }),
  );
  assert.equal(second.result.bundle.tackleItem.configNumericId, "301801002");
  assert.equal(second.state.configIdGovernance.reservationLedger[0]!.status, "ABANDONED");
});

test("容量阈值在 80%、95% 与耗尽点稳定告警", () => {
  const range = {
    ...CANONICAL_CONFIG_ID_RANGES[0]!,
    rangeId: "test_1_20",
    minimumBaseId: "1",
    maximumBaseId: "20",
  };
  assert.equal(configIdCapacityStatus(range, 15).level, "NORMAL");
  assert.equal(configIdCapacityStatus(range, 16).level, "WARNING_80");
  assert.equal(configIdCapacityStatus(range, 19).level, "CRITICAL_95");
  assert.equal(configIdCapacityStatus(range, 20).level, "EXHAUSTED");
});

test("稳定 rangeId 不得改语义，历史与新策略区间不得重叠", () => {
  const fixture = buildGovernanceFixture();
  const baseInput = {
    policyVersionId: "policy:v2",
    catalogVersionId: "catalog:v1",
    manifestIds: ["manifest:dev:v1", "manifest:test:v1"],
    publishedBy: "reviewer",
    publishedAt: NOW,
    observedTargets: fixture.observations,
  };
  assert.throws(
    () => publishConfigIdPolicyVersion(fixture.governance, {
      ...baseInput,
      ranges: [{
        ...CANONICAL_CONFIG_ID_RANGES[0]!,
        maximumBaseId: "301899998",
      }],
    }),
    (error) => errorCode(error) === "CONFIG_ID_RANGE_SEMANTICS_CHANGED",
  );
  assert.throws(
    () => publishConfigIdPolicyVersion(fixture.governance, {
      ...baseInput,
      ranges: [{
        ...CANONICAL_CONFIG_ID_RANGES[0]!,
        rangeId: "rod_overlap",
      }],
    }),
    (error) => errorCode(error) === "CONFIG_ID_RANGE_OVERLAP",
  );
});

test("扩容追加新 rangeId，不重置或回收旧 rangeId 游标", () => {
  const fixture = buildGovernanceFixture();
  const expansion = {
    ...CANONICAL_CONFIG_ID_RANGES[0]!,
    rangeId: "rod_401800001_401800010",
    minimumBaseId: "401800001",
    maximumBaseId: "401800010",
  };
  let governance = fixture.governance;
  const manifestIds: string[] = [];
  for (const prior of governance.scanManifests) {
    const manifestId = `${prior.manifestId}:expanded`;
    manifestIds.push(manifestId);
    governance = approveConfigTargetScanManifest(governance, {
      manifestId,
      catalogVersionId: prior.catalogVersionId,
      targetEntryId: prior.targetEntryId,
      environmentId: prior.environmentId,
      channelKey: prior.channelKey,
      repositoryId: prior.repositoryId,
      authoritativeRef: prior.authoritativeRef,
      resolvedCommitOid: prior.resolvedCommitOid,
      logicalDirectory: prior.logicalDirectory,
      configTomlHash: prior.configTomlHash,
      workbooks: structuredClone(prior.workbooks),
      scannerVersion: prior.scannerVersion,
      ruleVersion: prior.ruleVersion,
      verifiedRangeIds: [
        ...CANONICAL_CONFIG_ID_RANGES.map((range) => range.rangeId),
        expansion.rangeId,
      ],
      issueCodes: [],
      scannedBy: prior.scannedBy,
      scannedAt: NOW,
      approvedBy: prior.approvedBy,
      approvedAt: NOW,
    });
  }
  const expandedManifests = manifestIds.map((id) =>
    governance.scanManifests.find((manifest) => manifest.manifestId === id)!);
  const observations = expandedManifests.map((manifest) => ({
    targetEntryId: manifest.targetEntryId,
    repositoryId: manifest.repositoryId,
    authoritativeRef: manifest.authoritativeRef,
    resolvedCommitOid: manifest.resolvedCommitOid,
    logicalDirectory: manifest.logicalDirectory,
    configTomlHash: manifest.configTomlHash,
    workbookSetHash: manifest.workbookSetHash,
  }));
  governance = publishConfigIdPolicyVersion(governance, {
    policyVersionId: "policy:expanded",
    catalogVersionId: "catalog:v1",
    manifestIds,
    ranges: [
      ...CANONICAL_CONFIG_ID_RANGES.map((range) => ({ ...range })),
      expansion,
    ],
    publishedBy: "reviewer",
    publishedAt: NOW,
    observedTargets: observations,
  });
  const state = structuredClone(fixture.state);
  state.configIdGovernance = governance;
  state.configIdGovernance.rangeCursors = [{
    rangeId: CANONICAL_CONFIG_ID_RANGES[0]!.rangeId,
    lastAllocatedBaseId: CANONICAL_CONFIG_ID_RANGES[0]!.maximumBaseId,
    updatedAt: NOW,
  }];
  const policy = governance.policies.at(-1)!;
  const catalog = governance.catalogs[0]!;
  const checkpoint: ConfigTargetSerializationCheckpoint = {
    ...fixture.checkpoint,
    leaseId: "lease:expanded",
    fencingToken: "3",
    operationId: "operation:expanded",
    manifestSetHash: policy.manifestSetHash,
    physicalRefs: resolveConfigTargetPhysicalRefGroups(catalog, expandedManifests),
    targets: expandedManifests.map((manifest) => ({
      targetEntryId: manifest.targetEntryId,
      repositoryId: manifest.repositoryId,
      authoritativeRef: manifest.authoritativeRef,
      expectedCommitOid: manifest.resolvedCommitOid,
      configTomlHash: manifest.configTomlHash,
      workbookSetHash: manifest.workbookSetHash,
    })).sort((left, right) => left.targetEntryId.localeCompare(right.targetEntryId)),
  };
  const command = reservationInput(state);
  command.policyVersionId = policy.policyVersionId;
  command.expectedManifestSetHash = policy.manifestSetHash;
  const reserved = reserveConfigIdBundle(
    state,
    command,
    contextFor(observations, checkpoint),
  );
  assert.equal(reserved.result.bundle.tackleItem.configNumericId, expansion.minimumBaseId);
  assert.equal(
    reserved.state.configIdGovernance.rangeCursors.find((cursor) =>
      cursor.rangeId === CANONICAL_CONFIG_ID_RANGES[0]!.rangeId)?.lastAllocatedBaseId,
    CANONICAL_CONFIG_ID_RANGES[0]!.maximumBaseId,
  );
  assert.equal(
    reserved.state.configIdGovernance.rangeCursors.find((cursor) =>
      cursor.rangeId === expansion.rangeId)?.lastAllocatedBaseId,
    expansion.minimumBaseId,
  );
});

test("工作区迁移补齐独立治理子 schema，并保留未知字段与历史 Snapshot", () => {
  const legacy = structuredClone(createSeedState()) as unknown as Record<string, unknown>;
  const snapshots = structuredClone(legacy.configurationSnapshots);
  delete legacy.configIdGovernance;
  const migrated = migrateWorkspaceState(legacy);
  assert.equal(migrated.configIdGovernance.schemaVersion, 1);
  assert.deepEqual(migrated.configurationSnapshots, snapshots);
  const withUnknown = migrateConfigIdGovernanceState({
    ...emptyConfigIdGovernanceState(),
    futureField: { retained: true },
  });
  assert.deepEqual(withUnknown.preservedUnknown?.futureField, { retained: true });
});

test("冻结 Model 身份、ledger 身份和已发布 Snapshot 不允许被改写", () => {
  const fixture = buildGovernanceFixture();
  const reserved = reserveConfigIdBundle(
    fixture.state,
    reservationInput(fixture.state),
    contextFor(fixture.observations, fixture.checkpoint),
  ).state;
  const changedModel = structuredClone(reserved);
  changedModel.purchasableModels[0]!.stableModelKey = "renamed";
  assert.throws(
    () => assertFrozenConfigIdentityTransition(reserved, changedModel),
    (error) => errorCode(error) === "MODEL_CONFIG_IDENTITY_FROZEN",
  );
  const changedLedger = structuredClone(reserved);
  changedLedger.configIdGovernance.reservationLedger[0]!.bundle.tackleItem.configNumericId = "301800999";
  assert.throws(
    () => assertFrozenConfigIdentityTransition(reserved, changedLedger),
    (error) => errorCode(error) === "CONFIG_ID_LEDGER_IMMUTABLE_IDENTITY",
  );
  const changedSnapshot = structuredClone(reserved);
  changedSnapshot.configurationSnapshots[0]!.contentHash = "changed";
  assert.throws(
    () => assertFrozenConfigIdentityTransition(reserved, changedSnapshot),
    (error) => errorCode(error) === "PUBLISHED_CONFIGURATION_SNAPSHOT_FROZEN",
  );
});

function inMemoryRepository(initial: WorkspaceState): ConfigIdWorkspaceRepository & {
  current(): { state: WorkspaceState; revision: number };
} {
  let state = structuredClone(initial);
  let revision = 1;
  return {
    async load() {
      return { state: structuredClone(state), revision };
    },
    async save(input) {
      if (input.baseRevision !== revision) return { revision, conflict: true };
      state = structuredClone(input.state);
      revision += 1;
      return { revision };
    },
    current() {
      return { state: structuredClone(state), revision };
    },
  };
}

test("同一游标并发预留经工作区 CAS 重试后得到两个不同 Bundle", async () => {
  const fixture = buildGovernanceFixture();
  fixture.state.purchasableModels[1]!.stableModelKey = "beta";
  const repository = inMemoryRepository(fixture.state);
  const [first, second] = await Promise.all([
    reserveConfigIdBundlePersisted(
      reservationInput(fixture.state, 0, "alpha", "idem:a"),
      contextFor(fixture.observations, fixture.checkpoint),
      repository,
    ),
    reserveConfigIdBundlePersisted(
      reservationInput(fixture.state, 1, "beta", "idem:b"),
      contextFor(fixture.observations, {
        ...fixture.checkpoint,
        leaseId: "lease:2",
        fencingToken: "2",
        operationId: "operation:2",
      }),
      repository,
    ),
  ]);
  assert.notEqual(
    first.result.bundle.tackleItem.configNumericId,
    second.result.bundle.tackleItem.configNumericId,
  );
  assert.equal(repository.current().state.configIdGovernance.reservationLedger.length, 2);
});

test("同一 part + stableModelKey 并发预留只能有一个永久占用成功", async () => {
  const fixture = buildGovernanceFixture();
  fixture.state.purchasableModels[1]!.stableModelKey = "alpha";
  const repository = inMemoryRepository(fixture.state);
  const settled = await Promise.allSettled([
    reserveConfigIdBundlePersisted(
      reservationInput(fixture.state, 0, "alpha", "idem:a"),
      contextFor(fixture.observations, fixture.checkpoint),
      repository,
    ),
    reserveConfigIdBundlePersisted(
      reservationInput(fixture.state, 1, "alpha", "idem:b"),
      contextFor(fixture.observations, {
        ...fixture.checkpoint,
        leaseId: "lease:2",
        fencingToken: "2",
        operationId: "operation:2",
      }),
      repository,
    ),
  ]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  const rejected = settled.find((entry) => entry.status === "rejected");
  assert.equal(rejected?.status, "rejected");
  if (rejected?.status === "rejected") {
    assert.equal(errorCode(rejected.reason), "CONFIG_NAME_KEY_CONFLICT");
  }
  assert.equal(repository.current().state.configIdGovernance.reservationLedger.length, 1);
});

test("一期默认能力不启用正式 ConfigId 治理动作", () => {
  const capabilities = new Set<string>(PHASE_ONE_CAPABILITIES);
  assert.equal(capabilities.has("config.id.reserve"), false);
  assert.equal(capabilities.has("config.id.policy.publish"), false);
  assert.equal(capabilities.has("config.id.legacy_import"), false);
  assert.equal(capabilities.has("config.id.ledger.correct"), false);
  assert.equal(capabilities.has("config.target.scan"), false);
  assert.equal(capabilities.has("config.target.scan.approve"), false);
  assert.equal(capabilities.has("config.target.catalog.publish"), false);
});
