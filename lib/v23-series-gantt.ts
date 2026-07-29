import type { SeriesPartRevision, SkuDrawerRevision, WorkspaceState } from "./types";

export function selectCurrentPublishedWeightTemplateDraftId(state: WorkspaceState): string | undefined {
  const published = state.ruleSetVersions.filter((entry) => entry.status === "published");
  const version = Math.max(...published.map((entry) => entry.version));
  if (!Number.isFinite(version)) return undefined;
  const current = published.filter((entry) => entry.version === version);
  return current.length === 1 ? current[0]!.weightTemplateDraftId : undefined;
}

export function resolveV23CatalogOrder(templates: readonly Array<{ id?: unknown; sourceRow?: unknown }>): string[] | undefined {
  if (!templates.length) return undefined;
  const valid = templates.map((entry) => {
    if (typeof entry.id !== "string" || !entry.id || entry.id.trim() !== entry.id || !Number.isSafeInteger(entry.sourceRow) || (entry.sourceRow as number) < 1) return undefined;
    return { id: entry.id, sourceRow: entry.sourceRow as number };
  });
  if (valid.some((entry) => !entry) || new Set(valid.map((entry) => entry!.id)).size !== valid.length || new Set(valid.map((entry) => entry!.sourceRow)).size !== valid.length) return undefined;
  return (valid as Array<{ id: string; sourceRow: number }>).sort((left, right) => left.sourceRow - right.sourceRow).map((entry) => entry.id);
}

export interface V23BandBlock {
  part: SeriesPartRevision;
  weightBandIds: string[];
}

export interface V23SeriesProjection {
  seriesId: string;
  parts: Array<{ part: SeriesPartRevision; bandBlocks: V23BandBlock[] }>;
  unresolved: boolean;
  reason?: string;
}

/** Read only immutable current heads.  Any duplicate/missing head is deliberately
 * excluded from the interactive surface instead of guessing a latest revision. */
export function resolveCurrentV23Parts(state: WorkspaceState, seriesId: string): {
  parts: SeriesPartRevision[];
  unresolved: boolean;
  reason?: string;
} {
  const heads = state.v23SeriesPartHeads.filter((head) => head.seriesId === seriesId);
  if (!heads.length || new Set(heads.map((head) => head.partId)).size !== heads.length) {
    return { parts: [], unresolved: true, reason: "Part 当前 head 缺失或不唯一" };
  }
  const parts = heads.map((head) => state.v23SeriesPartRevisions.filter(
    (entry) => entry.partId === head.partId && entry.seriesId === seriesId && entry.revision === head.revision,
  ));
  if (parts.some((matches) => matches.length !== 1)) {
    return { parts: [], unresolved: true, reason: "Part immutable revision 无法唯一解析" };
  }
  const resolved = parts.map(([part]) => part!);
  if (resolved.length > 3 || new Set(resolved.map((part) => part.partType)).size !== resolved.length
    || resolved.some((part) => !["rod", "reel", "line"].includes(part.partType))) {
    return { parts: [], unresolved: true, reason: "Series Part 类型不符合 v23 竿/轮/线唯一性" };
  }
  return { parts: resolved.sort((left, right) => left.partType.localeCompare(right.partType)), unresolved: false };
}

export function resolveCurrentV23Skus(state: WorkspaceState, partId: string, weightBandId?: string): {
  skus: SkuDrawerRevision[]; unresolved: boolean;
} {
  const allHeads = state.v23SkuDrawerHeads;
  if (new Set(allHeads.map((head) => head.skuId)).size !== allHeads.length) return { skus: [], unresolved: true };
  const allCurrent = allHeads.map((head) => state.v23SkuDrawerRevisions.filter((entry) => entry.skuId === head.skuId && entry.revision === head.revision));
  if (allCurrent.some((matches) => matches.length !== 1)) return { skus: [], unresolved: true };
  const skus = allCurrent.map(([sku]) => sku!).filter((sku) => sku.partId === partId && (!weightBandId || sku.weightBandId === weightBandId));
  return { skus, unresolved: false };
}

/** 01.x order is supplied by the immutable catalog.  Adjacent selected bands
 * become one visual block; a missing catalog id or a gap always splits it. */
export function mergeV23WeightBands(part: SeriesPartRevision, orderedWeightBandIds: readonly string[]): V23BandBlock[] {
  const order = new Map(orderedWeightBandIds.map((id, index) => [id, index]));
  const selected = [...new Set(part.weightBandIds)]
    .filter((id) => order.has(id))
    .sort((left, right) => order.get(left)! - order.get(right)!);
  const blocks: string[][] = [];
  for (const id of selected) {
    const previous = blocks.at(-1)?.at(-1);
    if (previous && order.get(id) === order.get(previous)! + 1) blocks.at(-1)!.push(id);
    else blocks.push([id]);
  }
  return blocks.map((weightBandIds) => ({ part, weightBandIds }));
}

export function projectV23SeriesGantt(state: WorkspaceState, seriesId: string, orderedWeightBandIds: readonly string[]): V23SeriesProjection {
  if (!orderedWeightBandIds.length || new Set(orderedWeightBandIds).size !== orderedWeightBandIds.length) return { seriesId, parts: [], unresolved: true, reason: "01.x 重量段目录为空或存在重复 ID" };
  const current = resolveCurrentV23Parts(state, seriesId);
  if (current.unresolved) return { seriesId, parts: [], unresolved: true, reason: current.reason };
  if (current.parts.some((part) => new Set(part.weightBandIds).size !== part.weightBandIds.length || part.weightBandIds.some((id) => !orderedWeightBandIds.includes(id)))) return { seriesId, parts: [], unresolved: true, reason: "Part 重量段重复或不在当前 01.x 目录" };
  return { seriesId, unresolved: false, parts: current.parts.map((part) => ({ part, bandBlocks: mergeV23WeightBands(part, orderedWeightBandIds) })) };
}

export function validateV23PreviewSkuHeads(expected: readonly SkuDrawerRevision[], received: unknown): received is SkuDrawerRevision[] {
  if (!Array.isArray(received)) return false;
  const key = (sku: SkuDrawerRevision) => `${sku.skuId}:${sku.revision}`;
  const expectedKeys = expected.map(key).sort(); const receivedKeys = received.map((entry) => entry && typeof entry === "object" && typeof (entry as SkuDrawerRevision).skuId === "string" && Number.isInteger((entry as SkuDrawerRevision).revision) ? key(entry as SkuDrawerRevision) : "").sort();
  return receivedKeys.every(Boolean) && new Set(receivedKeys).size === receivedKeys.length && expectedKeys.length === receivedKeys.length && expectedKeys.every((item, index) => item === receivedKeys[index]);
}
