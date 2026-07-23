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
  type ConfigTargetSerializationVerifier,
} from "../lib/config-id-reservation-service";
import { PHASE_ONE_CAPABILITIES } from "../lib/feishu-identity";
import { sha256Hex } from "../lib/deterministic-sha256";
import { migrateWorkspaceState } from "../lib/migrations";
import { createSeedState } from "../lib/seed";
import type { WorkspaceState } from "../lib/types";

const NOW = "2026-07-23T01:02:03.000Z";

function hash(value: string) {
  return sha256Hex(value);
}

function managedWorkbooks(logicalDirectory: string) {
  return [
    {
      logicalName: "item",
      workbookPath: `${logicalDirectory}/item.xlsx`,
      sheetNames: ["Item"],
    },
    {
      logicalName: "store",
      workbookPath: `${logicalDirectory}/store.xlsx`,
      sheetNames: ["GoodsBasic", "StoreBuy"],
    },
    {
      logicalName: "tackle",
      workbookPath: `${logicalDirectory}/tackle.xlsx`,
      sheetNames: ["TackleItem"],
    },
  ];
}

function scannedWorkbooks(logicalDirectory: string) {
  return managedWorkbooks(logicalDirectory).map((workbook) => ({
    logicalName: workbook.logicalName,
    workbookPath: workbook.workbookPath,
    sheets: workbook.sheetNames.map((sheetName) => ({
      sheetName,
      sheetHash: hash(`${logicalDirectory}:${workbook.logicalName}:${sheetName}`),
    })),
    workbookHash: hash(`${logicalDirectory}:${workbook.logicalName}`),
  }));
}

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
        managedWorkbooks: managedWorkbooks("dev"),
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
        managedWorkbooks: managedWorkbooks("test"),
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
      configTomlHash: hash(`${logicalDirectory}:config.toml`),
      workbooks: scannedWorkbooks(logicalDirectory),
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
    workbooks: structuredClone(manifest.workbooks),
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
    operationId: idempotencyKey.replace(/^idem:/, "operation:"),
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
  fixture.governance.scanManifests[0]!.verifiedRangeIds = [
    CANONICAL_CONFIG_ID_RANGES[0]!.rangeId,
  ];
  assert.throws(
    () => publishConfigIdPolicyVersion(fixture.governance, {
      policyVersionId: "policy:partial-ranges",
      catalogVersionId: "catalog:v1",
      manifestIds: ["manifest:dev:v1", "manifest:test:v1"],
      ranges: CANONICAL_CONFIG_ID_RANGES.map((range) => ({ ...range })),
      publishedBy: "reviewer",
      publishedAt: NOW,
      observedTargets: fixture.observations,
    }),
    (error) => errorCode(error) === "CONFIG_TARGET_SCAN_MANIFEST_RANGE_MISMATCH",
  );
});

test("正式策略拒绝空 Manifest 集与零必需目标，optional-only 目录只可用于 NON_FORMAL", () => {
  const requiredFixture = buildGovernanceFixture();
  assert.throws(
    () => publishConfigIdPolicyVersion(requiredFixture.governance, {
      policyVersionId: "policy:empty-manifests",
      catalogVersionId: "catalog:v1",
      manifestIds: [],
      ranges: CANONICAL_CONFIG_ID_RANGES.map((range) => ({ ...range })),
      publishedBy: "reviewer",
      publishedAt: NOW,
      observedTargets: [],
    }),
    (error) => errorCode(error) === "CONFIG_TARGET_SCAN_MANIFEST_SET_EMPTY",
  );

  let optionalGovernance = publishConfigTargetCatalogVersion(emptyConfigIdGovernanceState(), {
    catalogVersionId: "catalog:optional-only",
    entries: [{
      targetEntryId: "target:preview",
      environmentId: "preview",
      channelKey: "default",
      repositoryId: "repo:game-config",
      authoritativeRef: "refs/heads/config",
      logicalDirectory: "preview",
      configTomlPath: "preview/config.toml",
      managedWorkbooks: managedWorkbooks("preview"),
      requiredForFormal: false,
    }],
    approvedBy: "reviewer",
    approvedAt: NOW,
  });
  optionalGovernance = approveConfigTargetScanManifest(optionalGovernance, {
    manifestId: "manifest:preview:v1",
    catalogVersionId: "catalog:optional-only",
    targetEntryId: "target:preview",
    environmentId: "preview",
    channelKey: "default",
    repositoryId: "repo:game-config",
    authoritativeRef: "refs/heads/config",
    resolvedCommitOid: "a".repeat(40),
    logicalDirectory: "preview",
    configTomlHash: hash("preview:config.toml"),
    workbooks: scannedWorkbooks("preview"),
    scannerVersion: "scanner:v1",
    ruleVersion: "open-008:v1",
    verifiedRangeIds: CANONICAL_CONFIG_ID_RANGES.map((range) => range.rangeId),
    issueCodes: [],
    scannedBy: "scanner",
    scannedAt: NOW,
    approvedBy: "reviewer",
    approvedAt: NOW,
  });
  assert.throws(
    () => publishConfigIdPolicyVersion(optionalGovernance, {
      policyVersionId: "policy:optional-only",
      catalogVersionId: "catalog:optional-only",
      manifestIds: ["manifest:preview:v1"],
      ranges: CANONICAL_CONFIG_ID_RANGES.map((range) => ({ ...range })),
      publishedBy: "reviewer",
      publishedAt: NOW,
      observedTargets: observationsFor(optionalGovernance),
    }),
    (error) => errorCode(error) === "CONFIG_TARGET_CATALOG_FORMAL_TARGETS_EMPTY",
  );

  const emptyCatalog = publishConfigTargetCatalogVersion(emptyConfigIdGovernanceState(), {
    catalogVersionId: "catalog:empty",
    entries: [],
    approvedBy: "reviewer",
    approvedAt: NOW,
  });
  assert.throws(
    () => publishConfigIdPolicyVersion(emptyCatalog, {
      policyVersionId: "policy:empty-catalog",
      catalogVersionId: "catalog:empty",
      manifestIds: [],
      ranges: CANONICAL_CONFIG_ID_RANGES.map((range) => ({ ...range })),
      publishedBy: "reviewer",
      publishedAt: NOW,
      observedTargets: [],
    }),
    (error) => errorCode(error) === "CONFIG_TARGET_SCAN_MANIFEST_SET_EMPTY",
  );
});

test("Manifest 必须逐 workbook/sheet/hash 恰好覆盖目录声明的闭集", () => {
  const fixture = buildGovernanceFixture();
  const prior = fixture.governance.scanManifests[0]!;
  const catalogEntry = fixture.governance.catalogs[0]!.entries[0]!;
  assert.throws(
    () => publishConfigTargetCatalogVersion(fixture.governance, {
      catalogVersionId: "catalog:empty-workbooks",
      entries: [{
        ...structuredClone(catalogEntry),
        targetEntryId: "target:empty-workbooks",
        environmentId: "empty-workbooks",
        managedWorkbooks: [],
      }],
      approvedBy: "reviewer",
      approvedAt: NOW,
    }),
    (error) => errorCode(error) === "CONFIG_TARGET_CATALOG_WORKBOOKS_EMPTY",
  );
  const baseInput = {
    manifestId: prior.manifestId,
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
    verifiedRangeIds: [...prior.verifiedRangeIds],
    issueCodes: [...prior.issueCodes],
    scannedBy: prior.scannedBy,
    scannedAt: prior.scannedAt,
    approvedBy: prior.approvedBy,
    approvedAt: prior.approvedAt,
  };
  assert.throws(
    () => approveConfigTargetScanManifest(fixture.governance, {
      ...baseInput,
      manifestId: "manifest:empty",
      workbooks: [],
    }),
    (error) => errorCode(error) === "CONFIG_TARGET_SCAN_WORKBOOKS_EMPTY",
  );
  assert.throws(
    () => approveConfigTargetScanManifest(fixture.governance, {
      ...baseInput,
      manifestId: "manifest:missing-workbook",
      workbooks: prior.workbooks.slice(1),
    }),
    (error) => errorCode(error) === "CONFIG_TARGET_SCAN_MANIFEST_COVERAGE_INCOMPLETE",
  );
  const missingSheet = structuredClone(prior.workbooks);
  missingSheet.find((workbook) => workbook.logicalName === "store")!.sheets.pop();
  assert.throws(
    () => approveConfigTargetScanManifest(fixture.governance, {
      ...baseInput,
      manifestId: "manifest:missing-sheet",
      workbooks: missingSheet,
    }),
    (error) => errorCode(error) === "CONFIG_TARGET_SCAN_MANIFEST_COVERAGE_INCOMPLETE",
  );
  const emptySheets = structuredClone(prior.workbooks);
  emptySheets[0]!.sheets = [];
  assert.throws(
    () => approveConfigTargetScanManifest(fixture.governance, {
      ...baseInput,
      manifestId: "manifest:empty-sheets",
      workbooks: emptySheets,
    }),
    (error) => errorCode(error) === "CONFIG_TARGET_SCAN_SHEETS_EMPTY",
  );
  const duplicateSheet = structuredClone(prior.workbooks);
  duplicateSheet[0]!.sheets.push(structuredClone(duplicateSheet[0]!.sheets[0]!));
  assert.throws(
    () => approveConfigTargetScanManifest(fixture.governance, {
      ...baseInput,
      manifestId: "manifest:duplicate-sheet",
      workbooks: duplicateSheet,
    }),
    (error) => errorCode(error) === "CONFIG_TARGET_SCAN_SHEET_DUPLICATE",
  );
  const invalidHash = structuredClone(prior.workbooks);
  invalidHash[0]!.sheets[0]!.sheetHash = "not-a-sha256";
  assert.throws(
    () => approveConfigTargetScanManifest(fixture.governance, {
      ...baseInput,
      manifestId: "manifest:invalid-sheet-hash",
      workbooks: invalidHash,
    }),
    (error) => errorCode(error) === "CONFIG_TARGET_SCAN_HASH_INVALID",
  );
});

test("Manifest freshness 逐 sheet 复验，聚合值不能由调用方伪造", () => {
  const fixture = buildGovernanceFixture();
  const stale = structuredClone(fixture.observations);
  stale[0]!.workbooks[0]!.sheets[0]!.sheetHash = hash("changed-sheet");
  assert.throws(
    () => publishConfigIdPolicyVersion(fixture.governance, {
      policyVersionId: "policy:stale-sheet",
      catalogVersionId: "catalog:v1",
      manifestIds: ["manifest:dev:v1", "manifest:test:v1"],
      ranges: CANONICAL_CONFIG_ID_RANGES.map((range) => ({ ...range })),
      publishedBy: "reviewer",
      publishedAt: NOW,
      observedTargets: stale,
    }),
    (error) => errorCode(error) === "CONFIG_TARGET_SCAN_MANIFEST_STALE",
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
      ranges: CANONICAL_CONFIG_ID_RANGES.map((range, index) => index === 0
        ? { ...range, maximumBaseId: "301899998" }
        : { ...range }),
    }),
    (error) => errorCode(error) === "CONFIG_ID_RANGE_SEMANTICS_CHANGED",
  );
  assert.throws(
    () => publishConfigIdPolicyVersion(fixture.governance, {
      ...baseInput,
      ranges: [
        ...CANONICAL_CONFIG_ID_RANGES.map((range) => ({ ...range })),
        { ...CANONICAL_CONFIG_ID_RANGES[0]!, rangeId: "rod_overlap" },
      ],
    }),
    (error) => errorCode(error) === "CONFIG_ID_RANGE_OVERLAP",
  );
});

test("替代正式策略必须携带当前已发布策略的所有稳定 rangeId", () => {
  const fixture = buildGovernanceFixture();
  assert.throws(
    () => publishConfigIdPolicyVersion(fixture.governance, {
      policyVersionId: "policy:missing-existing-range",
      catalogVersionId: "catalog:v1",
      manifestIds: ["manifest:dev:v1", "manifest:test:v1"],
      ranges: CANONICAL_CONFIG_ID_RANGES.slice(0, -1).map((range) => ({ ...range })),
      publishedBy: "reviewer",
      publishedAt: NOW,
      observedTargets: fixture.observations,
    }),
    (error) => errorCode(error) === "CONFIG_ID_RANGE_CARRY_FORWARD_REQUIRED",
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
    workbooks: structuredClone(manifest.workbooks),
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
  command.operationId = checkpoint.operationId;
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

function inMemoryRepository(
  initial: WorkspaceState,
  options: {
    forcedConflicts?: number;
    afterForcedConflict?(): void;
  } = {},
): ConfigIdWorkspaceRepository & {
  current(): { state: WorkspaceState; revision: number };
} {
  let state = structuredClone(initial);
  let revision = 1;
  let forcedConflicts = options.forcedConflicts ?? 0;
  let criticalSection = Promise.resolve();
  return {
    async load() {
      return { state: structuredClone(state), revision };
    },
    async commitReservation(input) {
      let release!: () => void;
      const previous = criticalSection;
      criticalSection = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        if (input.baseRevision !== revision) return { revision, conflict: true };
        const verification = await input.verifySerializationAtCommit();
        const nextState = input.prepareState(verification);
        if (forcedConflicts > 0) {
          forcedConflicts -= 1;
          revision += 1;
          options.afterForcedConflict?.();
          return { revision, conflict: true };
        }
        state = structuredClone(nextState);
        revision += 1;
        return { revision };
      } finally {
        release();
      }
    },
    current() {
      return { state: structuredClone(state), revision };
    },
  };
}

function authoritativeVerifier(
  current: () => ConfigTargetSerializationCheckpoint | undefined,
  calls: { count: number },
): ConfigTargetSerializationVerifier {
  return {
    async verifyCommittingAtCommit(expected) {
      calls.count += 1;
      const checkpoint = current();
      if (
        !checkpoint
        || checkpoint.state !== "COMMITTING"
        || checkpoint.leaseId !== expected.leaseId
        || checkpoint.fencingToken !== expected.fencingToken
        || checkpoint.operationId !== expected.operationId
      ) {
        throw new ConfigIdGovernanceError(
          "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
          "lease 已过期、被更高 token 取代或不处于 COMMITTING。",
        );
      }
      return { checkpoint: structuredClone(checkpoint), verifiedAt: NOW };
    },
  };
}

test("CAS 冲突后的每次实际提交尝试都重新读取权威 fencing token", async () => {
  const fixture = buildGovernanceFixture();
  const calls = { count: 0 };
  const repository = inMemoryRepository(fixture.state, { forcedConflicts: 1 });
  const reserved = await reserveConfigIdBundlePersisted(
    reservationInput(fixture.state),
    contextFor(fixture.observations, fixture.checkpoint),
    {
      repository,
      serializationVerifier: authoritativeVerifier(() => fixture.checkpoint, calls),
    },
  );
  assert.equal(calls.count, 2);
  assert.equal(reserved.workspaceRevision, 3);
  assert.equal(repository.current().state.configIdGovernance.reservationLedger.length, 1);
});

test("CAS 重试期间更高 token 取代旧证明时 fail closed 且不写 ledger", async () => {
  const fixture = buildGovernanceFixture();
  const calls = { count: 0 };
  let authoritative = structuredClone(fixture.checkpoint);
  const repository = inMemoryRepository(fixture.state, {
    forcedConflicts: 1,
    afterForcedConflict() {
      authoritative = {
        ...authoritative,
        leaseId: "lease:2",
        fencingToken: "2",
        operationId: "operation:2",
      };
    },
  });
  await assert.rejects(
    reserveConfigIdBundlePersisted(
      reservationInput(fixture.state),
      contextFor(fixture.observations, fixture.checkpoint),
      {
        repository,
        serializationVerifier: authoritativeVerifier(() => authoritative, calls),
      },
    ),
    (error) => errorCode(error) === "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
  );
  assert.equal(calls.count, 2);
  assert.equal(repository.current().state.configIdGovernance.reservationLedger.length, 0);
});

test("伪造 checkpoint 或缺少 #56 verifier 时持久化预留 fail closed", async () => {
  const fixture = buildGovernanceFixture();
  const repository = inMemoryRepository(fixture.state);
  const forged = {
    ...fixture.checkpoint,
    leaseId: "lease:forged",
    fencingToken: "999",
  };
  await assert.rejects(
    reserveConfigIdBundlePersisted(
      reservationInput(fixture.state),
      contextFor(fixture.observations, forged),
      {
        repository,
        serializationVerifier: authoritativeVerifier(() => fixture.checkpoint, { count: 0 }),
      },
    ),
    (error) => errorCode(error) === "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
  );
  await assert.rejects(
    reserveConfigIdBundlePersisted(
      reservationInput(fixture.state),
      contextFor(fixture.observations, fixture.checkpoint),
      { repository },
    ),
    (error) => errorCode(error) === "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
  );
  assert.equal(repository.current().state.configIdGovernance.reservationLedger.length, 0);
});

test("同一 part + stableModelKey 仍由 ledger 永久唯一约束阻断", () => {
  const fixture = buildGovernanceFixture();
  fixture.state.purchasableModels[1]!.stableModelKey = "alpha";
  const first = reserveConfigIdBundle(
    fixture.state,
    reservationInput(fixture.state),
    contextFor(fixture.observations, fixture.checkpoint),
  );
  assert.throws(
    () => reserveConfigIdBundle(
      first.state,
      reservationInput(fixture.state, 1, "alpha", "idem:2"),
      contextFor(fixture.observations, {
        ...fixture.checkpoint,
        leaseId: "lease:2",
        fencingToken: "2",
        operationId: "operation:2",
      }),
    ),
    (error) => errorCode(error) === "CONFIG_NAME_KEY_CONFLICT",
  );
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
