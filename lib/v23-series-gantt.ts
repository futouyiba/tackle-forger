import { expandV23TechnologyRefs, validateV23TechnologyDefinition } from "./v23-technology";
import type {
  SeriesPartRevision,
  SkuDrawerRevision,
  V23EnabledPartType,
  V23StableContentRef,
  V23TechnologyDefinition,
  WorkspaceState,
} from "./types";

export function selectCurrentPublishedWeightTemplateDraftId(state: WorkspaceState): string | undefined {
  const published = state.ruleSetVersions.filter((entry) => entry.status === "published");
  const version = Math.max(...published.map((entry) => entry.version));
  if (!Number.isFinite(version)) return undefined;
  const current = published.filter((entry) => entry.version === version);
  return current.length === 1 ? current[0]!.weightTemplateDraftId : undefined;
}

export function resolveV23CatalogOrder(templates: ReadonlyArray<{
  id?: unknown; sourceRow?: unknown; itemPartId?: unknown; sourceSheetId?: unknown;
  source?: { sheetId?: unknown };
}>, itemPartId: `part:${V23EnabledPartType}`): string[] | undefined {
  if (!templates.length) return undefined;
  const scoped = templates.filter((entry) => entry.itemPartId === itemPartId);
  if (!scoped.length) return undefined;
  const valid = scoped.map((entry) => {
    if (typeof entry.id !== "string" || !entry.id || entry.id.trim() !== entry.id || !Number.isSafeInteger(entry.sourceRow) || (entry.sourceRow as number) < 1) return undefined;
    return { id: entry.id, sourceRow: entry.sourceRow as number };
  });
  if (valid.some((entry) => !entry)) return undefined;
  const entries = valid as Array<{ id: string; sourceRow: number }>;
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length
    || new Set(entries.map((entry) => entry.sourceRow)).size !== entries.length) return undefined;
  return entries.sort((left, right) => left.sourceRow - right.sourceRow).map((entry) => entry.id);
}

export type V23CatalogOrders = Readonly<Record<V23EnabledPartType, readonly string[] | undefined>>;

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

export function projectV23SeriesGantt(state: WorkspaceState, seriesId: string, catalogOrders: V23CatalogOrders): V23SeriesProjection {
  const current = resolveCurrentV23Parts(state, seriesId);
  if (current.unresolved) return { seriesId, parts: [], unresolved: true, reason: current.reason };
  if (current.parts.some((part) => {
    const order = catalogOrders[part.partType];
    return !order?.length
      || new Set(order).size !== order.length
      || new Set(part.weightBandIds).size !== part.weightBandIds.length
      || part.weightBandIds.some((id) => !order.includes(id));
  })) return { seriesId, parts: [], unresolved: true, reason: "Part 重量段重复或不在该 Part 当前 01.x 目录" };
  return {
    seriesId,
    unresolved: false,
    parts: current.parts.map((part) => ({
      part,
      bandBlocks: mergeV23WeightBands(part, catalogOrders[part.partType]!),
    })),
  };
}

export function v23PartWeightBandsValid(
  part: Pick<SeriesPartRevision, "partType">,
  weightBandIds: readonly string[],
  catalogOrders: V23CatalogOrders,
): boolean {
  const order = catalogOrders[part.partType];
  return Boolean(
    order?.length
    && weightBandIds.length
    && new Set(weightBandIds).size === weightBandIds.length
    && weightBandIds.every((id) => order.includes(id)),
  );
}

export function validateV23PreviewSkuHeads(expected: readonly SkuDrawerRevision[], received: unknown): received is SkuDrawerRevision[] {
  if (!Array.isArray(received)) return false;
  const key = (sku: SkuDrawerRevision) => `${sku.skuId}:${sku.revision}`;
  const expectedKeys = expected.map(key).sort(); const receivedKeys = received.map((entry) => entry && typeof entry === "object" && typeof (entry as SkuDrawerRevision).skuId === "string" && Number.isInteger((entry as SkuDrawerRevision).revision) ? key(entry as SkuDrawerRevision) : "").sort();
  return receivedKeys.every(Boolean) && new Set(receivedKeys).size === receivedKeys.length && expectedKeys.length === receivedKeys.length && expectedKeys.every((item, index) => item === receivedKeys[index]);
}

export function resolveCurrentV23Technologies(
  state: WorkspaceState,
  itemPartId: V23TechnologyDefinition["itemPartId"],
): { technologies: V23TechnologyDefinition[]; unresolved: boolean; reason?: string } {
  if (new Set(state.v23TechnologyHeads.map((head) => head.technologyId)).size !== state.v23TechnologyHeads.length) {
    return { technologies: [], unresolved: true, reason: "Technology 当前 head 不唯一" };
  }
  try {
    const technologies = state.v23TechnologyHeads.map((head) => {
      const matches = state.v23TechnologyDefinitions.filter((entry) =>
        entry.technologyId === head.technologyId && entry.revision === head.revision);
      if (matches.length !== 1) throw new Error("Technology immutable revision 无法唯一解析");
      validateV23TechnologyDefinition(state, matches[0]!);
      return matches[0]!;
    }).filter((entry) => entry.enabled && entry.itemPartId === itemPartId);
    return { technologies, unresolved: false };
  } catch (error) {
    return {
      technologies: [],
      unresolved: true,
      reason: error instanceof Error ? error.message : "Technology 当前 head 无法闭合验证",
    };
  }
}

export function resolveV23TechnologySurface(
  state: WorkspaceState,
  refs: readonly V23StableContentRef[],
  itemPartId: V23TechnologyDefinition["itemPartId"],
): {
  technologies: V23TechnologyDefinition[];
  members: ReturnType<typeof expandV23TechnologyRefs>;
  unresolved: boolean;
  reason?: string;
} {
  try {
    const technologies = refs.map((ref) => {
      const matches = state.v23TechnologyDefinitions.filter((entry) =>
        entry.technologyId === ref.id
        && entry.revision === ref.revision
        && entry.contentHash === ref.contentHash);
      if (matches.length !== 1) throw new Error(`Technology 引用 ${ref.id}@${ref.revision} 无法唯一解析`);
      validateV23TechnologyDefinition(state, matches[0]!);
      if (!matches[0]!.enabled || matches[0]!.itemPartId !== itemPartId) {
        throw new Error("Technology 已禁用或与 Part 类型不一致");
      }
      return matches[0]!;
    });
    return {
      technologies,
      members: expandV23TechnologyRefs(state, refs, itemPartId),
      unresolved: false,
    };
  } catch (error) {
    return {
      technologies: [],
      members: [],
      unresolved: true,
      reason: error instanceof Error ? error.message : "Technology 引用无法闭合验证",
    };
  }
}

export function resolveV23InheritedAffixRefs(
  state: WorkspaceState,
  part: SeriesPartRevision,
): { refs: V23StableContentRef[]; unresolved: boolean; reason?: string } {
  const technology = resolveV23TechnologySurface(
    state,
    part.technologyRefs,
    `part:${part.partType}`,
  );
  if (technology.unresolved) {
    return { refs: [], unresolved: true, reason: technology.reason };
  }
  const refs = new Map<string, V23StableContentRef>();
  for (const ref of [...part.defaultEntryRefs, ...technology.members.map((entry) => entry.ref)]) {
    const prior = refs.get(ref.id);
    if (
      prior
      && (prior.revision !== ref.revision || prior.contentHash !== ref.contentHash)
    ) {
      return {
        refs: [],
        unresolved: true,
        reason: `继承词条 ${ref.id} 指向冲突的 immutable revision`,
      };
    }
    refs.set(ref.id, ref);
  }
  return {
    refs: [...refs.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    unresolved: false,
  };
}

export function resolveV23SkuOccupiedAffixIds(
  state: WorkspaceState,
  part: SeriesPartRevision,
  sku: SkuDrawerRevision,
): { ids: string[]; unresolved: boolean; reason?: string } {
  const inherited = resolveV23InheritedAffixRefs(state, part);
  if (inherited.unresolved) {
    return { ids: [], unresolved: true, reason: inherited.reason };
  }
  const skuTechnology = resolveV23TechnologySurface(
    state,
    sku.technologyRefs,
    `part:${part.partType}`,
  );
  if (skuTechnology.unresolved) {
    return { ids: [], unresolved: true, reason: skuTechnology.reason };
  }
  const ids = new Set<string>([
    ...inherited.refs.map((ref) => ref.id),
    ...skuTechnology.members.map((entry) => entry.ref.id),
    ...sku.addedEntryRefs.map((entry) => entry.ref.id),
    ...sku.localEntryCopies.map((entry) => entry.sourceRef.id),
    ...sku.removedInheritedEntryIds,
  ]);
  return { ids: [...ids].sort(), unresolved: false };
}
