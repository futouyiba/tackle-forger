import { canonicalDecimal } from "./five-axis-hash";
import { hashFiveAxisWeightBandPolicy } from "./five-axis-formal";
import type { FiveAxisWeightBandPolicy } from "./types";

/**
 * W 段六个鱼重量等级（WQ8w 分表实测，2026-07-25 凭据读取 1cAihB/2KCCHR/3FYijT）。
 *
 * 旧 d6e928 合并表用「小型/中型/大型/超巨物」；WQ8w 分表用「小鱼/中鱼/大鱼/超级巨物」，
 * 语义等价但文案不同。每个 grade 的条目数（GRADE_COUNTS）不变：1/2/4/4/3/2 = 16。
 */
const GRADE_NAMES = ["微物", "小鱼", "中鱼", "大鱼", "巨物", "超级巨物"] as const;
const GRADE_COUNTS = [1, 2, 4, 4, 3, 2] as const;
/** W1-W5 各等级最后一行的上界（W6 超级巨物永远 open，不设上限）。 */
const DECIDED_UPPER_BOUNDS = ["1.5", "3.8", "12.6", "25.9", "82.5", null] as const;

function value(row: unknown[] | undefined, column: number) {
  return String(row?.[column] ?? "").trim();
}
function finiteDecimal(raw: string, label: string) {
  if (!raw || !Number.isFinite(Number(raw)) || Number(raw) < 0) throw new Error(`FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：${label} 必须为非负有限数。`);
  return canonicalDecimal(raw);
}

/**
 * PR2b-2（2026-07-25）：W 段策略已从旧合并表 d6e928（一张含竿3-18/轮21-36/线39-54块布局，
 * A1:AE54）切到 WQ8w 三张独立子表（竿 1cAihB / 轮 2KCCHR / 线 3FYijT，A1:AE17）。
 *
 * 每张子表结构与旧合并表一致：行1 表头（B="同步状态",C="钓具大类",D="重量段",E="最小拉力",
 * F="最大拉力",G="鱼重等级"），行2-17 各 16 行 machineId（wtpl_{part}_{ordinal pad4}）。
 *
 * 三表必须一致（grade/bound 完全相同），fail-closed：任一行缺字段/格式错/三表不一致阻断。
 */
export function parseFiveAxisWeightBandPolicyFromWeightTemplate(input: {
  sourceRevision: string;
  rodValues: unknown[][];
  reelValues: unknown[][];
  lineValues: unknown[][];
}): FiveAxisWeightBandPolicy {
  if (!input.sourceRevision.trim()) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：缺少工作簿 revision。");

  const sources = [
    { part: "rod" as const, label: "竿", values: input.rodValues },
    { part: "reel" as const, label: "轮", values: input.reelValues },
    { part: "line" as const, label: "线", values: input.lineValues },
  ] as const;

  // 全局 48 machineId 必须唯一
  const allMachineIds = sources.flatMap((src) =>
    Array.from({ length: 16 }, (_, i) => value(src.values[i + 1], 0)),
  );
  if (allMachineIds.some((id) => !id) || new Set(allMachineIds).size !== 48) {
    throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：机器 ID 必须全局唯一。");
  }

  const perPart = sources.map((src) => {
    // 行1（index 0）= 表头；校验（宽松：各列有值即可，LEGACY d6e928 与 WQ8w 表头文案不同但列语义相同）
    const header = src.values[0];
    for (let c = 0; c < 7; c += 1) {
      if (!value(header, c)) throw new Error(`FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：${src.part} 机器表头第 ${c + 1} 列为空。`);
    }

    const grades: Array<{ grade: string; upper: string | null }> = [];
    const gradeCounts = new Map<string, number>();
    const seenMachineIds = new Set<string>();
    let previousGrade = "";
    let previousUpper = 0;

    for (let index = 0; index < 16; index += 1) {
      const rowNumber = index + 2; // 行2-17（1-indexed）
      const row = src.values[index + 1]; // 0-indexed
      const machineId = value(row, 0);
      const sync = value(row, 1);
      const partLabel = value(row, 2); // 钓具大类
      const ordinal = value(row, 3); // 重量段
      const minVal = value(row, 4); // 最小拉力
      const maxVal = value(row, 5); // 最大拉力
      const grade = value(row, 6); // 鱼重等级

      const expectedMachineId = `wtpl_${src.part}_${String(rowNumber - 1).padStart(4, "0")}`;
      if (!machineId || !sync || !ordinal || !grade || !minVal
        || machineId !== expectedMachineId
        || sync !== "BOUND"
        || partLabel !== src.label
        || ordinal !== String(rowNumber - 1)
        || seenMachineIds.has(machineId)) {
        throw new Error(`FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：${src.part} 第 ${rowNumber} 行缺少机器字段或部位不一致。`);
      }
      seenMachineIds.add(machineId);

      const lower = Number(finiteDecimal(minVal, `${src.part} 第 ${rowNumber} 行 minPull`));
      if (grade !== previousGrade) {
        if (grades.some((entry) => entry.grade === grade)) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：鱼重量等级必须连续，不得回跳。");
        grades.push({ grade, upper: null });
        previousGrade = grade;
      }
      const gradeIndex = grades.length - 1;
      gradeCounts.set(grade, (gradeCounts.get(grade) ?? 0) + 1);
      const upper = Number(finiteDecimal(maxVal, `${src.part} 第 ${rowNumber} 行 maxPull`));
      if (upper <= lower || (index > 0 && lower !== previousUpper)) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：重量段区间必须连续且 max 大于 min。");
      if (gradeIndex < 5) {
        if (upper <= previousUpper) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：重量段上界必须严格递增。");
        previousUpper = upper;
        grades[gradeIndex]!.upper = canonicalDecimal(maxVal);
      } else {
        // W6 超级巨物 open-ended：保留 source 值作 provenance 但不设 policy upper。
        if (upper <= previousUpper) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：重量段上界必须严格递增。");
        previousUpper = upper;
      }
    }

    if (grades.length !== 6 || grades.some((entry, index) => entry.grade !== GRADE_NAMES[index]) || GRADE_NAMES.some((grade, index) => gradeCounts.get(grade) !== GRADE_COUNTS[index])) {
      throw new Error(`FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：${src.part} 必须恰好包含连续的六个权威鱼重量等级。`);
    }
    return grades;
  });

  const baseline = perPart[0]!;
  if (perPart.slice(1).some((grades) => JSON.stringify(grades) !== JSON.stringify(baseline))) {
    throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：竿、轮、线三方重量段策略不一致。");
  }
  if (baseline.some((entry, index) => entry.upper !== DECIDED_UPPER_BOUNDS[index])) {
    throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：来源重量段与已发布 W1–W6 名称或边界不一致；原始范围仅可保留供人工复核，不得发布正式策略。");
  }

  const content: Omit<FiveAxisWeightBandPolicy, "contentHash"> = {
    policyId: "weight-band:five-axis-wq8w",
    version: `weight-band:five-axis-wq8w@${input.sourceRevision}`,
    publicationState: "PUBLISHED",
    sourceRevision: input.sourceRevision,
    bands: baseline.map((entry, index) => ({
      weightBandId: `W${index + 1}`,
      label: ["微物", "小鱼", "中鱼", "大鱼", "巨物", "超级巨物"][index]!,
      upperBoundKg: entry.upper,
    })),
  };
  return { ...content, contentHash: hashFiveAxisWeightBandPolicy(content) };
}
