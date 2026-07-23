import { deterministicHash } from "./rule-kernel";

export type ProductDeliveryStage = "PHASE_ONE" | "PHASE_ONE_POINT_FIVE";

export interface ConfigExportRuntimePolicy {
  stage: ProductDeliveryStage;
  formalExportRuntimeEnabled: boolean;
}

export interface FormalConfigExportAuthorization {
  packageKind: "EXPORT_PACKAGE";
  publicationState: "FORMAL";
  formal: true;
  configIdBundleId: string;
  configIdPolicyVersionId: string;
  configTargetCatalogVersionId: string;
  approvedFreshManifestId: string;
  governanceLeaseId: string;
  fencingToken: string;
  expectedOldOid: string;
  protectedRefCasAvailable: true;
}

export interface FormalConfigExportEvidenceVerifier {
  verify(
    authorization: FormalConfigExportAuthorization,
    context: FormalConfigExportContext,
  ): Promise<
    | {
        verified: true;
        manifestSetHash: string;
        verifiedAt: string;
        contextHash: string;
      }
    | {
        verified: false;
        reason: string;
      }
  >;
}

export interface FormalConfigExportContext {
  packageId: string;
  profileId: string;
  environmentId: string;
  channelKey: string;
  mappingId: string;
  mappingVersion: string;
  snapshots: Array<{
    snapshotId: string;
    snapshotHash: string;
  }>;
  operations: Array<{
    workbook: string;
    targetRef: string;
    expectedOriginalHash: string;
    stagedHash: string;
  }>;
}

export interface VerifiedFormalConfigExportEvidence {
  contextHash: string;
  manifestSetHash: string;
  verifiedAt: string;
  configIdBundleId: string;
  configIdPolicyVersionId: string;
  configTargetCatalogVersionId: string;
  approvedFreshManifestId: string;
  governanceLeaseId: string;
  fencingToken: string;
  expectedOldOid: string;
}

export function formalConfigExportContextHash(
  context: FormalConfigExportContext,
): string {
  return deterministicHash({
    ...context,
    snapshots: [...context.snapshots].sort((left, right) =>
      left.snapshotId.localeCompare(right.snapshotId)),
    operations: [...context.operations].sort((left, right) =>
      left.workbook.localeCompare(right.workbook)
      || left.targetRef.localeCompare(right.targetRef)),
  });
}

export class ConfigExportStageError extends Error {
  constructor(
    readonly code:
      | "CONFIG_EXPORT_PHASE_DISABLED"
      | "CONFIG_EXPORT_RUNTIME_NOT_READY"
      | "CONFIG_EXPORT_NON_FORMAL_PACKAGE"
      | "CONFIG_EXPORT_FORMAL_IDENTITY_MISSING"
      | "CONFIG_EXPORT_GOVERNANCE_EVIDENCE_MISSING"
      | "CONFIG_EXPORT_GOVERNANCE_VERIFIER_UNAVAILABLE"
      | "CONFIG_EXPORT_GOVERNANCE_EVIDENCE_UNVERIFIED"
      | "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "ConfigExportStageError";
  }
}

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function readConfigExportRuntimePolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ConfigExportRuntimePolicy {
  return {
    stage: environment.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE === "PHASE_ONE_POINT_FIVE"
      ? "PHASE_ONE_POINT_FIVE"
      : "PHASE_ONE",
    formalExportRuntimeEnabled: enabled(
      environment.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED,
    ),
  };
}

export function formalConfigExportActionBlock(
  policy = readConfigExportRuntimePolicy(),
): { code: string; text: string } | undefined {
  if (policy.stage !== "PHASE_ONE_POINT_FIVE") {
    return {
      code: "CONFIG_EXPORT_PHASE_DISABLED",
      text: "一期只提供 CONFIG_PREVIEW / NON_FORMAL 预览，正式配置提交未启用。",
    };
  }
  if (!policy.formalExportRuntimeEnabled) {
    return {
      code: "CONFIG_EXPORT_RUNTIME_NOT_READY",
      text: "1.5 期正式导出运行时尚未完成治理准入，只能生成 NON_FORMAL 预览。",
    };
  }
  return undefined;
}

export function assertFormalConfigExportStageEnabled(
  policy = readConfigExportRuntimePolicy(),
): void {
  const actionBlock = formalConfigExportActionBlock(policy);
  if (actionBlock) {
    throw new ConfigExportStageError(
      actionBlock.code as "CONFIG_EXPORT_PHASE_DISABLED" | "CONFIG_EXPORT_RUNTIME_NOT_READY",
      actionBlock.text,
    );
  }
}

function assertFormalConfigExportAuthorization(
  authorization: FormalConfigExportAuthorization | undefined,
): asserts authorization is FormalConfigExportAuthorization {
  if (
    !authorization
    || authorization.packageKind !== "EXPORT_PACKAGE"
    || authorization.publicationState !== "FORMAL"
    || authorization.formal !== true
  ) {
    throw new ConfigExportStageError(
      "CONFIG_EXPORT_NON_FORMAL_PACKAGE",
      "commit_config_export 拒绝 NON_FORMAL 预览、占位包或缺少正式包证明的请求。",
    );
  }
  if (
    !authorization.configIdBundleId.trim()
    || !authorization.configIdPolicyVersionId.trim()
  ) {
    throw new ConfigExportStageError(
      "CONFIG_EXPORT_FORMAL_IDENTITY_MISSING",
      "正式配置提交缺少已预留 ConfigIdBundle 或 ConfigIdPolicyVersion。",
    );
  }
  if (
    !authorization.configTargetCatalogVersionId.trim()
    || !authorization.approvedFreshManifestId.trim()
    || !authorization.governanceLeaseId.trim()
    || !authorization.fencingToken.trim()
    || !authorization.expectedOldOid.trim()
  ) {
    throw new ConfigExportStageError(
      "CONFIG_EXPORT_GOVERNANCE_EVIDENCE_MISSING",
      "正式配置提交缺少目标目录、获批新鲜 Manifest 或治理租约证据。",
    );
  }
  if (authorization.protectedRefCasAvailable !== true) {
    throw new ConfigExportStageError(
      "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
      "受保护 expected-old-OID CAS 不可用，禁止生成或提交正式配置。",
    );
  }
}

function assertFormalConfigExportContext(
  context: FormalConfigExportContext | undefined,
): asserts context is FormalConfigExportContext {
  if (
    !context
    || !context.packageId.trim()
    || !context.profileId.trim()
    || !context.environmentId.trim()
    || !context.channelKey.trim()
    || !context.mappingId.trim()
    || !context.mappingVersion.trim()
    || !context.snapshots.length
    || !context.operations.length
    || context.snapshots.some((entry) =>
      !entry.snapshotId.trim() || !entry.snapshotHash.trim())
    || context.operations.some((entry) =>
      !entry.workbook.trim()
      || !entry.targetRef.trim()
      || !entry.expectedOriginalHash.trim()
      || !entry.stagedHash.trim())
  ) {
    throw new ConfigExportStageError(
      "CONFIG_EXPORT_GOVERNANCE_EVIDENCE_MISSING",
      "正式配置提交缺少包、目标、环境×渠道、Snapshot 或暂存操作上下文。",
    );
  }
}

function authorizationEvidence(
  authorization: FormalConfigExportAuthorization,
) {
  return {
    configIdBundleId: authorization.configIdBundleId,
    configIdPolicyVersionId: authorization.configIdPolicyVersionId,
    configTargetCatalogVersionId: authorization.configTargetCatalogVersionId,
    approvedFreshManifestId: authorization.approvedFreshManifestId,
    governanceLeaseId: authorization.governanceLeaseId,
    fencingToken: authorization.fencingToken,
    expectedOldOid: authorization.expectedOldOid,
  };
}

export function recoverVerifiedFormalConfigExportEvidence(input: {
  authorization: FormalConfigExportAuthorization | undefined;
  context: FormalConfigExportContext | undefined;
  evidence: VerifiedFormalConfigExportEvidence | undefined;
  policy?: ConfigExportRuntimePolicy;
}): VerifiedFormalConfigExportEvidence {
  assertFormalConfigExportStageEnabled(input.policy);
  assertFormalConfigExportAuthorization(input.authorization);
  assertFormalConfigExportContext(input.context);
  const expected = {
    contextHash: formalConfigExportContextHash(input.context),
    ...authorizationEvidence(input.authorization),
  };
  if (
    !input.evidence
    || !input.evidence.manifestSetHash.trim()
    || !input.evidence.verifiedAt.trim()
    || Object.entries(expected).some(
      ([key, value]) =>
        input.evidence?.[key as keyof typeof expected] !== value,
    )
  ) {
    throw new ConfigExportStageError(
      "CONFIG_EXPORT_GOVERNANCE_EVIDENCE_UNVERIFIED",
      "相同幂等键绑定了不同正式导出上下文或授权证据，拒绝恢复旧提交结果。",
    );
  }
  return structuredClone(input.evidence);
}

export async function assertFormalConfigExportAllowed(
  authorization: FormalConfigExportAuthorization | undefined,
  verifier: FormalConfigExportEvidenceVerifier | undefined,
  context: FormalConfigExportContext | undefined,
  policy = readConfigExportRuntimePolicy(),
): Promise<VerifiedFormalConfigExportEvidence> {
  assertFormalConfigExportStageEnabled(policy);
  assertFormalConfigExportAuthorization(authorization);
  if (!verifier) {
    throw new ConfigExportStageError(
      "CONFIG_EXPORT_GOVERNANCE_VERIFIER_UNAVAILABLE",
      "服务端尚未安装 ConfigId、目录 Manifest、治理租约与 protected CAS 验证器，禁止正式配置提交。",
    );
  }
  assertFormalConfigExportContext(context);
  const expectedContextHash = formalConfigExportContextHash(context);
  const verification = await verifier.verify(authorization, context);
  if (
    !verification.verified
    || !verification.manifestSetHash.trim()
    || !verification.verifiedAt.trim()
    || verification.contextHash !== expectedContextHash
  ) {
    throw new ConfigExportStageError(
      "CONFIG_EXPORT_GOVERNANCE_EVIDENCE_UNVERIFIED",
      verification.verified
        ? "服务端治理验证结果缺少 Manifest 集合哈希、验证时间或精确匹配的导出上下文哈希。"
        : `服务端拒绝正式配置治理证据：${verification.reason}`,
    );
  }
  return {
    contextHash: verification.contextHash,
    manifestSetHash: verification.manifestSetHash,
    verifiedAt: verification.verifiedAt,
    ...authorizationEvidence(authorization),
  };
}

export function assertProductionShapeConfigExportEnabled(
  policy = readConfigExportRuntimePolicy(),
): void {
  const actionBlock = formalConfigExportActionBlock(policy);
  if (actionBlock) {
    throw new ConfigExportStageError(
      actionBlock.code as "CONFIG_EXPORT_PHASE_DISABLED" | "CONFIG_EXPORT_RUNTIME_NOT_READY",
      `${actionBlock.text} 一期预览不得读取本地 configs 或生成生产形态文件差异。`,
    );
  }
}
