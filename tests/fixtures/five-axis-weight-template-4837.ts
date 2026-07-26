/** Redacted production-shape WQ8w 重量段子表（1cAihB/2KCCHR/3FYijT 各 A1:AE17）from revision 4837.
 *
 * PR2b-2 切流后 W 段策略读三张独立子表；旧 d6e928 合并表 A1:AE54（竿3-18/轮21-36/线39-54 块布局）已废弃。
 * 每子表 17 行：行1 表头，行2-17 各 16 行 machineId（wtpl_{part}_{ordinal pad4}）。
 * 列：机器ID / 同步状态 / 钓具大类 / 重量段序号 / 最小拉力 / 最大拉力 / 鱼重量等级。 */
const MIN = ["0.1", "1.5", "2.5", "3.8", "5.4", "7.5", "10.2", "12.6", "15", "17.8", "21.2", "25.9", "36.9", "55", "82.5", "145"];
const MAX = ["1.5", "2.5", "3.8", "5.4", "7.5", "10.2", "12.6", "15", "17.8", "21.2", "25.9", "36.9", "55", "82.5", "145", "235"];
const GRADE = ["微物", "小鱼", "小鱼", "中鱼", "中鱼", "中鱼", "中鱼", "大鱼", "大鱼", "大鱼", "大鱼", "巨物", "巨物", "巨物", "超级巨物", "超级巨物"];

function weightTemplatePart(part: "rod" | "reel" | "line", label: "竿" | "轮" | "线"): unknown[][] {
  return [
    ["机器ID", "同步状态", "钓具大类", "重量段序号", "最小拉力", "最大拉力", "鱼重量等级"],
    ...Array.from({ length: 16 }, (_, index) => [
      `wtpl_${part}_${String(index + 1).padStart(4, "0")}`,
      "BOUND",
      label,
      String(index + 1),
      MIN[index],
      MAX[index],
      GRADE[index],
    ]),
  ];
}

export function weightTemplate4837Rod(): unknown[][] {
  return weightTemplatePart("rod", "竿");
}
export function weightTemplate4837Reel(): unknown[][] {
  return weightTemplatePart("reel", "轮");
}
export function weightTemplate4837Line(): unknown[][] {
  return weightTemplatePart("line", "线");
}
