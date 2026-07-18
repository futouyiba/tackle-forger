import type {
  ModifierOption,
  QualityBand,
  SeriesShowcaseEntry,
  WeightTemplate,
  WorkspaceState,
} from "./types";

export const showcaseQualityKeys = ["C", "B", "A", "S"] as const;
export type ShowcaseQualityKey = (typeof showcaseQualityKeys)[number];
export type ShowcaseStructureKey = "spinning" | "casting";

export interface ShowcaseQualitySlot {
  key: ShowcaseQualityKey;
  qualityId: string;
  color: string;
}

export interface ShowcasePlacement {
  entry: SeriesShowcaseEntry;
  trackIndex: number;
  startRow: number;
  rowSpan: number;
}

export interface ShowcaseLane {
  id: string;
  qualityKey: ShowcaseQualityKey;
  qualityId: string;
  structureKey: ShowcaseStructureKey;
  structureLabel: string;
  entries: ShowcasePlacement[];
}

const structureSlots: Array<{ key: ShowcaseStructureKey; label: string }> = [
  { key: "spinning", label: "直柄S" },
  { key: "casting", label: "枪柄C" },
];

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

export function showcaseStructureKey(name: string): ShowcaseStructureKey | null {
  if (name.includes("直柄")) return "spinning";
  if (name.includes("枪柄")) return "casting";
  return null;
}

export function showcaseFeatureLabel(option?: ModifierOption): string {
  if (!option) return "";
  const numericLevel = Number(option.level);
  const level = Number.isFinite(numericLevel)
    ? Math.max(1, Math.min(6, Math.round(numericLevel)))
    : 1;
  return `【${option.name}${"+".repeat(level)}】`;
}

function intersectingRows(
  entry: SeriesShowcaseEntry,
  levels: WeightTemplate[],
): { startRow: number; rowSpan: number } {
  const hits = levels
    .map((level, index) => ({ level, index }))
    .filter(
      ({ level }) =>
        entry.fishMaxKg > level.fishMinKg && entry.fishMinKg < level.fishMaxKg,
    )
    .map(({ index }) => index);

  if (hits.length) {
    const startRow = hits[0];
    return { startRow, rowSpan: hits[hits.length - 1] - startRow + 1 };
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
  return { startRow: nearest.index, rowSpan: 1 };
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

  const lanes = qualities.flatMap((quality) =>
    structureSlots.map((structure) => {
      const laneEntries = entries
        .filter((entry) => {
          if (entry.qualityId !== quality.qualityId) return false;
          const option = state.modifiers.find((item) => item.id === entry.structureId);
          return showcaseStructureKey(option?.name ?? "") === structure.key;
        })
        .sort(
          (left, right) =>
            left.lureMinG - right.lureMinG ||
            left.fishMinKg - right.fishMinKg ||
            left.seriesId.localeCompare(right.seriesId, "zh-CN"),
        )
        .map((entry, trackIndex) => ({
          entry,
          trackIndex,
          ...intersectingRows(entry, levels),
        }));

      return {
        id: `${quality.key}-${structure.key}`,
        qualityKey: quality.key,
        qualityId: quality.qualityId,
        structureKey: structure.key,
        structureLabel: structure.label,
        entries: laneEntries,
      };
    }),
  );

  return { qualities, levels, lanes };
}

export function templateLureRange(template?: WeightTemplate): { min: number; max: number } {
  const values = template?.values ?? {};
  const min = Number(values["饵重下限g"] ?? values["饵重下限"] ?? 0);
  const max = Number(values["饵重上限g"] ?? values["饵重上限"] ?? 0);
  return {
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
  };
}
