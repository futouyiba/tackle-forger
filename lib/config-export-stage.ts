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
  ): Promise<
    | {
        verified: true;
        manifestSetHash: string;
        verifiedAt: string;
      }
    | {
        verified: false;
        reason: string;
      }
  >;
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

export async function assertFormalConfigExportAllowed(
  authorization: FormalConfigExportAuthorization | undefined,
  verifier: FormalConfigExportEvidenceVerifier | undefined,
  policy = readConfigExportRuntimePolicy(),
): Promise<void> {
  const actionBlock = formalConfigExportActionBlock(policy);
  if (actionBlock) {
    throw new ConfigExportStageError(
      actionBlock.code as "CONFIG_EXPORT_PHASE_DISABLED" | "CONFIG_EXPORT_RUNTIME_NOT_READY",
      actionBlock.text,
    );
  }
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
  if (!verifier) {
    throw new ConfigExportStageError(
      "CONFIG_EXPORT_GOVERNANCE_VERIFIER_UNAVAILABLE",
      "服务端尚未安装 ConfigId、目录 Manifest、治理租约与 protected CAS 验证器，禁止正式配置提交。",
    );
  }
  const verification = await verifier.verify(authorization);
  if (
    !verification.verified
    || !verification.manifestSetHash.trim()
    || !verification.verifiedAt.trim()
  ) {
    throw new ConfigExportStageError(
      "CONFIG_EXPORT_GOVERNANCE_EVIDENCE_UNVERIFIED",
      verification.verified
        ? "服务端治理验证结果缺少 Manifest 集合哈希或验证时间。"
        : `服务端拒绝正式配置治理证据：${verification.reason}`,
    );
  }
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
