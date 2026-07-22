export interface DiscretePullParseResult {
  values: number[];
  invalidTokens: string[];
  duplicateValues: number[];
}

export function parseDiscretePulls(value: string): DiscretePullParseResult {
  const tokens = value.split(/[,，;；\s]+/).map((entry) => entry.trim()).filter(Boolean);
  const invalidTokens: string[] = [];
  const duplicateValues: number[] = [];
  const seen = new Set<number>();
  const values: number[] = [];

  for (const token of tokens) {
    const parsed = Number(token);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      invalidTokens.push(token);
      continue;
    }
    if (seen.has(parsed)) {
      duplicateValues.push(parsed);
      continue;
    }
    seen.add(parsed);
    values.push(parsed);
  }
  values.sort((left, right) => left - right);
  return { values, invalidTokens, duplicateValues };
}

