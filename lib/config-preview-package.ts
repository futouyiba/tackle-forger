import {
  assertSnapshotItemPartEnabled,
} from "./enabled-item-parts";
import { verifySnapshotIntegrity } from "./publishing";
import { deterministicHash } from "./rule-kernel";
import type { ConfigurationSnapshot } from "./types";

export const CONFIG_PREVIEW_NOTICE = "不可提交、不可人工搬运到configs";

export type ConfigPreviewObjectKind =
  | "tackle"
  | "item"
  | "goods_basic"
  | "store_buy";

export interface ConfigPreviewObject {
  modelId: string;
  snapshotId: string;
  objectKind: ConfigPreviewObjectKind;
  symbolicRef: string;
  numericId: null;
  configNameKey: null;
  references: Record<string, string>;
}

export interface ConfigPreviewPackage {
  packageKind: "CONFIG_PREVIEW";
  publicationState: "NON_FORMAL";
  formal: false;
  packageId: string;
  workspaceId: string;
  notice: typeof CONFIG_PREVIEW_NOTICE;
  sourceSnapshots: Array<{
    snapshotId: string;
    contentHash: string;
    modelId: string;
  }>;
  objects: ConfigPreviewObject[];
  files: Array<{
    fileName: "configuration.preview.report.json";
    kind: "DIFF_REPORT";
    notice: typeof CONFIG_PREVIEW_NOTICE;
  }>;
  createdAt: string;
  manifestHash: string;
}

export function configPreviewSymbol(
  modelId: string,
  objectKind: ConfigPreviewObjectKind,
): string {
  return `NON_FORMAL:${modelId}:${objectKind}`;
}

function previewObjects(snapshot: ConfigurationSnapshot): ConfigPreviewObject[] {
  const tackle = configPreviewSymbol(snapshot.modelId, "tackle");
  const item = configPreviewSymbol(snapshot.modelId, "item");
  const goodsBasic = configPreviewSymbol(snapshot.modelId, "goods_basic");
  const storeBuy = configPreviewSymbol(snapshot.modelId, "store_buy");
  const common = {
    modelId: snapshot.modelId,
    snapshotId: snapshot.id,
    numericId: null,
    configNameKey: null,
  } as const;
  return [
    {
      ...common,
      objectKind: "tackle",
      symbolicRef: tackle,
      references: {},
    },
    {
      ...common,
      objectKind: "item",
      symbolicRef: item,
      references: { tackle },
    },
    {
      ...common,
      objectKind: "goods_basic",
      symbolicRef: goodsBasic,
      references: { item },
    },
    {
      ...common,
      objectKind: "store_buy",
      symbolicRef: storeBuy,
      references: { goodsBasic },
    },
  ];
}

export function createConfigPreviewPackage(input: {
  packageId: string;
  workspaceId: string;
  snapshots: ConfigurationSnapshot[];
  createdAt?: string;
}): ConfigPreviewPackage {
  const packageId = input.packageId.trim();
  const workspaceId = input.workspaceId.trim();
  if (!packageId || !workspaceId) {
    throw new Error("ConfigPreviewPackage 缺少 packageId 或 workspaceId。");
  }
  if (!input.snapshots.length) {
    throw new Error("ConfigPreviewPackage 至少需要一个冻结 ConfigurationSnapshot。");
  }
  const snapshotIds = new Set<string>();
  for (const snapshot of input.snapshots) {
    assertSnapshotItemPartEnabled(snapshot, "config_export");
    if (!verifySnapshotIntegrity(snapshot)) {
      throw new Error(`冻结 ConfigurationSnapshot ${snapshot.id} 的内容哈希校验失败。`);
    }
    if (snapshotIds.has(snapshot.id)) {
      throw new Error(`ConfigPreviewPackage 包含重复 Snapshot：${snapshot.id}。`);
    }
    snapshotIds.add(snapshot.id);
  }
  const payload: Omit<ConfigPreviewPackage, "manifestHash"> = {
    packageKind: "CONFIG_PREVIEW" as const,
    publicationState: "NON_FORMAL" as const,
    formal: false as const,
    packageId,
    workspaceId,
    notice: CONFIG_PREVIEW_NOTICE,
    sourceSnapshots: [...input.snapshots]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((snapshot) => ({
        snapshotId: snapshot.id,
        contentHash: snapshot.contentHash,
        modelId: snapshot.modelId,
      })),
    objects: [...input.snapshots]
      .sort((left, right) => left.modelId.localeCompare(right.modelId))
      .flatMap(previewObjects),
    files: [{
      fileName: "configuration.preview.report.json" as const,
      kind: "DIFF_REPORT" as const,
      notice: CONFIG_PREVIEW_NOTICE,
    }],
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return {
    ...payload,
    manifestHash: deterministicHash(payload),
  };
}
