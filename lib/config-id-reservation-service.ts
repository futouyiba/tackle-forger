import {
  ConfigIdGovernanceError,
  reserveConfigIdBundle,
  type ConfigTargetSerializationCheckpoint,
  type ReserveConfigIdBundleCommand,
  type ReserveConfigIdBundleContext,
  type ReserveConfigIdBundleTransition,
} from "./config-id-governance";
import { loadWorkspaceState } from "./storage";
import { stableStringify } from "./rule-kernel";
import type { WorkspaceState } from "./types";

export interface ConfigTargetSerializationCommitVerification {
  checkpoint: ConfigTargetSerializationCheckpoint;
  verifiedAt: string;
}

/**
 * #56 治理协调器的只读提交点端口。实现必须重新读取权威协调状态，
 * 而不是回显调用方提供的 checkpoint。
 */
export interface ConfigTargetSerializationVerifier {
  verifyCommittingAtCommit(
    expected: ConfigTargetSerializationCheckpoint,
  ): Promise<ConfigTargetSerializationCommitVerification>;
}

export interface ConfigIdWorkspaceRepository {
  load(): Promise<{ state: WorkspaceState; revision: number }>;

  /**
   * 实现必须先锁定/校验 baseRevision，再在同一持久化事务的实际提交点调用
   * verifySerializationAtCommit，紧接着调用 prepareState 并原子写入其返回值。
   * 无法把 verifier 放入该边界的存储适配器不得实现降级 save。
   */
  commitReservation(input: {
    baseRevision: number;
    author: string;
    message: string;
    verifySerializationAtCommit(): Promise<ConfigTargetSerializationCommitVerification>;
    prepareState(
      verification: ConfigTargetSerializationCommitVerification,
    ): WorkspaceState;
  }): Promise<{ revision: number; conflict?: boolean }>;
}

const defaultRepository: ConfigIdWorkspaceRepository = {
  load: loadWorkspaceState,
  async commitReservation() {
    throw new ConfigIdGovernanceError(
      "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
      "当前工作区存储尚未接入 #56 协调器的原子提交点重验。",
    );
  },
};

export interface ConfigIdReservationPersistenceOptions {
  repository?: ConfigIdWorkspaceRepository;
  serializationVerifier?: ConfigTargetSerializationVerifier;
  maximumAttempts?: number;
}

function serializationUnavailable(message: string, cause?: unknown): ConfigIdGovernanceError {
  return new ConfigIdGovernanceError(
    "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE",
    message,
    cause instanceof Error ? { cause: cause.message } : undefined,
  );
}

function assertFreshAuthoritativeVerification(
  expected: ConfigTargetSerializationCheckpoint,
  verification: ConfigTargetSerializationCommitVerification,
) {
  if (
    verification.checkpoint.leaseId !== expected.leaseId
    || verification.checkpoint.fencingToken !== expected.fencingToken
    || verification.checkpoint.operationId !== expected.operationId
    || verification.checkpoint.catalogVersionId !== expected.catalogVersionId
    || verification.checkpoint.manifestSetHash !== expected.manifestSetHash
    || stableStringify(verification.checkpoint.physicalRefs) !== stableStringify(expected.physicalRefs)
    || stableStringify(verification.checkpoint.targets) !== stableStringify(expected.targets)
    || !Number.isFinite(Date.parse(verification.verifiedAt))
  ) {
    throw serializationUnavailable(
      "#56 协调器返回的 COMMITTING 证明与本次操作、token、物理 ref 或 Manifest 绑定不一致。",
    );
  }
}

/**
 * 将纯领域转换放入工作区 CAS 重试环。每次尝试都由存储事务在实际提交点
 * 向 #56 协调器重验 COMMITTING/latest fencing token；冲突重试不复用旧验证结果。
 */
export async function reserveConfigIdBundlePersisted(
  command: ReserveConfigIdBundleCommand,
  context: ReserveConfigIdBundleContext,
  options: ConfigIdReservationPersistenceOptions = {},
): Promise<ReserveConfigIdBundleTransition & { workspaceRevision: number }> {
  const repository = options.repository ?? defaultRepository;
  const maximumAttempts = options.maximumAttempts ?? 4;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const current = await repository.load();
    const preview = reserveConfigIdBundle(current.state, command, context);
    if (preview.idempotent || preview.existing) {
      return { ...preview, workspaceRevision: current.revision };
    }

    const expected = context.serializationCheckpoint;
    const verifier = options.serializationVerifier;
    if (!expected || !verifier) {
      throw serializationUnavailable("正式预留缺少 #56 权威提交点 verifier。");
    }

    let prepared: ReserveConfigIdBundleTransition | undefined;
    const saved = await repository.commitReservation({
      baseRevision: current.revision,
      author: context.actor,
      message: `预留 ConfigIdBundle（operation ${command.operationId}）`,
      verifySerializationAtCommit: async () => {
        try {
          const verification = await verifier.verifyCommittingAtCommit(structuredClone(expected));
          assertFreshAuthoritativeVerification(expected, verification);
          return verification;
        } catch (error) {
          if (
            error instanceof ConfigIdGovernanceError
            && error.code === "CONFIG_TARGET_SERIALIZATION_UNAVAILABLE"
          ) {
            throw error;
          }
          throw serializationUnavailable("#56 协调器不可达或未能证明最新 fencing token。", error);
        }
      },
      prepareState: (verification) => {
        prepared = reserveConfigIdBundle(current.state, command, {
          ...context,
          now: verification.verifiedAt,
          serializationCheckpoint: verification.checkpoint,
        });
        return prepared.state;
      },
    });
    if (!saved.conflict) {
      if (!prepared) {
        throw serializationUnavailable("持久化适配器未在提交点执行权威重验。");
      }
      return { ...prepared, workspaceRevision: saved.revision };
    }
  }
  throw new ConfigIdGovernanceError(
    "CONFIG_ID_RESERVATION_CONCURRENT_CONFLICT",
    "工作区在 ConfigIdBundle 事务预留期间持续变化；未确认任何未提交编号。",
  );
}
