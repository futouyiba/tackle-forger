import { jcsSha256Hex } from "./canonical-json";
import { deterministicHash } from "./rule-kernel";
import type { PatchSnapshotReference } from "./types";

export const PATCH_SET_HASH_CONTRACT_VERSION = "patch-set-workspace-jcs-sha256-v1" as const;

export function patchSetHashForReferences(
  references: PatchSnapshotReference[],
  contractVersion?: string,
): string {
  if (contractVersion === PATCH_SET_HASH_CONTRACT_VERSION || references.some((reference)=>reference.workspaceId !== undefined)) {
    if (contractVersion !== PATCH_SET_HASH_CONTRACT_VERSION) {
      throw new Error("新 Patch 引用缺少受支持的 PatchSetHash 契约版本。");
    }
    const workspaceIds = new Set(references.map((reference)=>reference.workspaceId));
    if (references.length && (workspaceIds.size !== 1 || !references.every((reference)=>typeof reference.workspaceId === "string" && reference.workspaceId.trim()))) {
      throw new Error("新 Patch 引用必须属于同一个非空 workspaceId。");
    }
    return jcsSha256Hex({
      patchSetHashContractVersion: PATCH_SET_HASH_CONTRACT_VERSION,
      patchRefs: references.map((reference)=>({
        workspaceId: reference.workspaceId!,
        patchId: reference.patchId,
        patchRevision: reference.patchRevision,
        orderedOperationIds: reference.orderedOperationIds,
      })),
    });
  }
  return deterministicHash(references);
}

export function patchMirrorDetailKey(input:{
  workspaceId:string;
  patchId:string;
  patchRevision:number;
  operationId:string;
}):string{
  if(!input.workspaceId.trim()) throw new Error("Patch 镜像 workspaceId 不能为空。");
  return jcsSha256Hex({keyType:"patch-mirror-detail/v1",...input});
}

export function patchMirrorGroupKey(input:{
  workspaceId:string;
  patchId:string;
  patchRevision:number;
}):string{
  if(!input.workspaceId.trim()) throw new Error("Patch 镜像 workspaceId 不能为空。");
  return jcsSha256Hex({keyType:"patch-mirror-group/v1",...input});
}
