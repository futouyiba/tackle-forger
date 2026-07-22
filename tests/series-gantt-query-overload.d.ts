declare module "../lib/series-gantt-query" {
  export function seriesGanttQueryToSearchParams(query: {
    text?: string;
    qualityIds?: readonly string[];
    exactTargetWeightKg?: readonly number[];
    attention?: readonly ("WARNING" | "UPGRADE_AVAILABLE")[];
    hasUpgradeCandidate?: boolean;
    sort?: "quality_type" | "name" | "updated_desc";
  }): URLSearchParams;
}
