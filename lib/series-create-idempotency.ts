import type { SeriesDefinition } from "./types";

interface SeriesCreateIdempotencyState {
  commandIdempotencyRecords: Array<{
    key: string;
    inputHash: string;
    resultRef: string;
  }>;
  seriesDefinitions: SeriesDefinition[];
}

export async function recoverSeriesCreateAfterSaveConflict<
  TState extends SeriesCreateIdempotencyState,
>(input: {
  saveResult: { revision: number; conflict?: boolean };
  loadLatest: () => Promise<{ state: TState; revision: number }>;
  idempotencyKey: string;
  acceptedInputHashes: ReadonlySet<string>;
}): Promise<
  | {
      latest: { state: TState; revision: number };
      series: SeriesDefinition;
    }
  | undefined
> {
  if (!input.saveResult.conflict) return undefined;
  const latest = await input.loadLatest();
  const recoveredCommand = latest.state.commandIdempotencyRecords.find(
    (entry) => entry.key === input.idempotencyKey,
  );
  if (
    !recoveredCommand
    || !input.acceptedInputHashes.has(recoveredCommand.inputHash)
  ) {
    return undefined;
  }
  const series = latest.state.seriesDefinitions.find(
    (entry) => entry.id === recoveredCommand.resultRef,
  );
  return series ? { latest, series } : undefined;
}
