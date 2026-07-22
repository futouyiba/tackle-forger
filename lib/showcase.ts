import type {
  ModifierOption,
  QualityBand,
  SeriesShowcaseEntry,
  WeightTemplate,
  WorkspaceState,
} from "./types";

export const showcaseQualityKeys = ["C", "B", "A", "S"] as const;
export type ShowcaseQualityKey = (typeof showcaseQualityKeys)[number];

export interface ShowcaseQualitySlot {
  key: ShowcaseQualityKey;
  qualityId: string;
  color: string;
}

export interface ShowcaseSeriesSegment {
  templateId: string;
  tier: string;
  weightMinKg: number;
  weightMaxKg: number;
  tensionMinKgf: number;
  tensionMaxKgf: number;
  targetPullsKgf: number[];
}

export interface ShowcasePlacement {
  entry: SeriesShowcaseEntry;
  trackIndex: number;
  startRow: number;
  rowSpan: number;
  segments: ShowcaseSeriesSegment[];
}

export interface ShowcaseLane {
  id: string;
  qualityKey: ShowcaseQualityKey;
  qualityId: string;
  color: string;
  entries: ShowcasePlacement[];
}

export function showcaseQualitySlots(bands: QualityBand[]): ShowcaseQualitySlot[] {
  const sorted = [...bands].sort((left, right) => left.minScore - right.minScore);
  const used = new Set<string>();

  return showcaseQualityKeys.map((key, index) => {
    const exact = sorted.find(
      (band) => !used.has(band.id) && band.name.trim().toUpperCase() === key,
    );
    const fallback = sorted.find((band) => !used.has(band.id)) ?? sorted[index];
    const band = exact ?? fallback;
    if (band) used.add(band.id);
    return {
      key,
      qualityId: band?.id ?? key,
      color: band?.color ?? "#667085",
    };
  });
}

export function showcaseFeatureLabel(option?: ModifierOption): string {
  if (!option) return "";
  const numericLevel = Number(option.level);
  const level = Number.isFinite(numericLevel)
    ? Math.max(1, Math.min(6, Math.round(numericLevel)))
    : 1;
  return `【${option.name}${"+".repeat(level)}】`;
}

export function templateTensionRange(template?: WeightTemplate): { min: number; max: number } {
  const values = template?.values ?? {};
  const tensions = [
    Number(values["杆最大拉力kgf"]),
    Number(values["轮最大拉力kgf"]),
    Number(values["线最大拉力kgf"]),
  ].filter((value) => Number.isFinite(value) && value > 0);

  if (!tensions.length) return { min: 0, max: 1 };
  return { min: Math.min(...tensions), max: Math.max(...tensions) };
}

export function showcaseTargetPulls(entry: SeriesShowcaseEntry): number[] {
  const explicit = [...new Set(entry.targetPullsKgf ?? [])]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  // 历史记录只有上下限时，只保留两个端点，绝不推导中间规格。
  if (explicit.length) return explicit;
  return [...new Set([entry.tensionMinKgf, entry.tensionMaxKgf])]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
}

export function buildSeriesSegments(
  entry: SeriesShowcaseEntry,
  levels: WeightTemplate[],
): ShowcaseSeriesSegment[] {
  const targetPullsKgf = showcaseTargetPulls(entry);
  return levels.flatMap((level) => {
    const weightMinKg = Math.max(entry.fishMinKg, level.fishMinKg);
    const weightMaxKg = Math.min(entry.fishMaxKg, level.fishMaxKg);
    if (weightMaxKg <= weightMinKg) return [];

    return [{
      templateId: level.id,
      tier: level.tier,
      weightMinKg,
      weightMaxKg,
      tensionMinKgf: targetPullsKgf[0] ?? entry.tensionMinKgf,
      tensionMaxKgf: targetPullsKgf.at(-1) ?? entry.tensionMaxKgf,
      targetPullsKgf,
    }];
  });
}

function placementForEntry(
  entry: SeriesShowcaseEntry,
  levels: WeightTemplate[],
  trackIndex: number,
): ShowcasePlacement {
  const segments = buildSeriesSegments(entry, levels);
  if (segments.length) {
    const hitIndexes = segments.map((segment) =>
      levels.findIndex((level) => level.id === segment.templateId),
    );
    const startRow = Math.min(...hitIndexes);
    const endRow = Math.max(...hitIndexes);
    return { entry, trackIndex, startRow, rowSpan: endRow - startRow + 1, segments };
  }

  const midpoint = (entry.fishMinKg + entry.fishMaxKg) / 2;
  const nearest = levels.reduce(
    (best, level, index) => {
      const levelMidpoint = (level.fishMinKg + level.fishMaxKg) / 2;
      const distance = Math.abs(levelMidpoint - midpoint);
      return distance < best.distance ? { index, distance } : best;
    },
    { index: 0, distance: Number.POSITIVE_INFINITY },
  );
  return { entry, trackIndex, startRow: nearest.index, rowSpan: 1, segments: [] };
}

export function buildSeriesShowcaseLayout(state: WorkspaceState): {
  qualities: ShowcaseQualitySlot[];
  levels: WeightTemplate[];
  lanes: ShowcaseLane[];
} {
  const qualities = showcaseQualitySlots(state.qualityBands);
  const levels = [...state.templates].sort(
    (left, right) => left.fishMinKg - right.fishMinKg || left.fishMaxKg - right.fishMaxKg,
  );
  const entries = Array.isArray(state.seriesShowcases) ? state.seriesShowcases : [];

  const lanes = qualities.map((quality) => {
    const laneEntries = entries
      .filter((entry) => entry.qualityId === quality.qualityId)
      .sort(
        (left, right) =>
          left.fishMinKg - right.fishMinKg ||
          left.tensionMinKgf - right.tensionMinKgf ||
          left.seriesId.localeCompare(right.seriesId, "zh-CN"),
      )
      .map((entry, trackIndex) => placementForEntry(entry, levels, trackIndex));

    return {
      id: quality.key,
      qualityKey: quality.key,
      qualityId: quality.qualityId,
      color: quality.color,
      entries: laneEntries,
    };
  });

  return { qualities, levels, lanes };
}
