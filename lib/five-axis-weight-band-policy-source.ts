import { canonicalDecimal } from "./five-axis-hash";
import { hashFiveAxisWeightBandPolicy } from "./five-axis-formal";
import type { FiveAxisWeightBandPolicy } from "./types";

const BLOCKS = [
  { part: "rod", start: 3, end: 18 },
  { part: "reel", start: 21, end: 36 },
  { part: "line", start: 39, end: 54 },
] as const;
const GRADE_NAMES = ["微物", "小鱼", "中鱼", "大鱼", "巨物", "超级巨物"] as const;
const GRADE_COUNTS = [1, 2, 4, 4, 3, 2] as const;

function value(row: unknown[] | undefined, column: number) {
  return String(row?.[column] ?? "").trim();
}
function finiteDecimal(raw: string, label: string) {
  if (!raw || !Number.isFinite(Number(raw)) || Number(raw) <= 0) throw new Error(`FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：${label} 必须为正有限数。`);
  return canonicalDecimal(raw);
}

/**
 * Parses the revision-bound W policy from the authoritative d6e928 machine
 * structure.  Rows are deliberately fixed by the published workbook contract:
 * three 16-level blocks (rod/reel/line), each carrying B:H machine columns.
 */
export function parseFiveAxisWeightBandPolicyFromWeightTemplate(input: {
  sourceRevision: string;
  values: unknown[][];
}): FiveAxisWeightBandPolicy {
  if (!input.sourceRevision.trim()) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：缺少工作簿 revision。");
  const allMachineIds = BLOCKS.flatMap((block) => Array.from({ length: 16 }, (_, index) => value(input.values[block.start + index - 1], 1)));
  if (allMachineIds.some((id) => !id) || new Set(allMachineIds).size !== 48) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：机器 ID 必须全局唯一。");
  const perPart = BLOCKS.map((block) => {
    const header = input.values[block.start - 2];
    const expected = ["机器", "同步", "部位", "重量", "最小", "最大", "鱼"];
    if (expected.some((token, index) => !value(header, index + 1).includes(token))) {
      throw new Error(`FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：${block.part} 机器表头 B:H 不完整。`);
    }
    const grades: Array<{ grade: string; upper: string | null }> = [];
    const gradeCounts = new Map<string, number>();
    const seenMachineIds = new Set<string>();
    let previousGrade = "";
    let previousUpper = 0;
    for (let rowNumber = block.start; rowNumber <= block.end; rowNumber += 1) {
      const row = input.values[rowNumber - 1];
      const machineId = value(row, 1); const sync = value(row, 2); const part = value(row, 3);
      const ordinal = value(row, 4); const min = value(row, 5); const max = value(row, 6); const grade = value(row, 7);
      const partLabel = block.part === "rod" ? "竿" : block.part === "reel" ? "轮" : "线";
      const expectedMachineId = `wtpl_${block.part}_${String(rowNumber - block.start + 1).padStart(4, "0")}`;
      if (!machineId || !sync || !ordinal || !grade || !min || machineId !== expectedMachineId || sync !== "BOUND" || part !== partLabel || ordinal !== String(rowNumber - block.start + 1) || seenMachineIds.has(machineId)) {
        throw new Error(`FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：${block.part} 第 ${rowNumber} 行缺少机器字段或部位不一致。`);
      }
      seenMachineIds.add(machineId);
      const lower = Number(finiteDecimal(min, `${block.part} 第 ${rowNumber} 行 minPull`));
      if (grade !== previousGrade) {
        if (grades.some((entry) => entry.grade === grade)) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：鱼重量等级必须连续，不得回跳。");
        grades.push({ grade, upper: null }); previousGrade = grade;
      }
      const gradeIndex = grades.length - 1;
      gradeCounts.set(grade, (gradeCounts.get(grade) ?? 0) + 1);
      const upper = Number(finiteDecimal(max, `${block.part} 第 ${rowNumber} 行 maxPull`));
      if (upper <= lower || (rowNumber > block.start && lower !== previousUpper)) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：重量段区间必须连续且 max 大于 min。");
      if (gradeIndex < 5) {
        if (upper <= previousUpper) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：重量段上界必须严格递增。");
        previousUpper = upper; grades[gradeIndex]!.upper = canonicalDecimal(max);
      } else {
        // The source keeps the final template ceiling (currently 235kg) for
        // its 16-level design ladder. W6 deliberately remains open-ended in
        // the five-axis policy, so this value validates provenance but never
        // becomes a policy upper bound.
        if (upper <= previousUpper) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：重量段上界必须严格递增。");
        previousUpper = upper;
      }
    }
    if (grades.length !== 6 || grades.some((entry, index) => entry.grade !== GRADE_NAMES[index]) || GRADE_NAMES.some((grade, index) => gradeCounts.get(grade) !== GRADE_COUNTS[index])) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：必须恰好包含连续的六个权威鱼重量等级。");
    return grades;
  });
  const baseline = perPart[0]!;
  if (perPart.slice(1).some((grades) => JSON.stringify(grades) !== JSON.stringify(baseline))) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：竿、轮、线三方重量段策略不一致。");
  const content: Omit<FiveAxisWeightBandPolicy, "contentHash"> = {
    policyId: "weight-band:five-axis-d6e928",
    version: `weight-band:five-axis-d6e928@${input.sourceRevision}`,
    publicationState: "PUBLISHED",
    sourceRevision: input.sourceRevision,
    bands: baseline.map((entry, index) => ({ weightBandId: `W${index + 1}`, upperBoundKg: entry.upper })),
  };
  return { ...content, contentHash: hashFiveAxisWeightBandPolicy(content) };
}
