/** Redacted production-shape d6e928!A1:AE54 fixture from revision 4837. */
const MIN = ["0.1", "1.5", "2.5", "3.8", "5.4", "7.5", "10.2", "12.6", "15", "17.8", "21.2", "25.9", "36.9", "55", "82.5", "145"];
const MAX = ["1.5", "2.5", "3.8", "5.4", "7.5", "10.2", "12.6", "15", "17.8", "21.2", "25.9", "36.9", "55", "82.5", "145", "235"];
const GRADE = ["微物", "小鱼", "小鱼", "中鱼", "中鱼", "中鱼", "中鱼", "大鱼", "大鱼", "大鱼", "大鱼", "巨物", "巨物", "巨物", "超级巨物", "超级巨物"];

export function weightTemplate4837A1Ae54(): unknown[][] {
  const rows = Array.from({ length: 54 }, () => [] as unknown[]);
  for (const [part, headerRow, start, idPart] of [["竿", 2, 3, "rod"], ["轮", 20, 21, "reel"], ["线", 38, 39, "line"]] as const) {
    rows[headerRow - 1] = ["", "机器ID", "同步状态", "部位", "重量段序号", "最小拉力", "最大拉力", "鱼重量等级"];
    for (let index = 0; index < 16; index += 1) rows[start + index - 1] = ["", `wtpl_${idPart}_${String(index + 1).padStart(4, "0")}`, "BOUND", part, String(index + 1), MIN[index], MAX[index], GRADE[index]];
  }
  return rows;
}
