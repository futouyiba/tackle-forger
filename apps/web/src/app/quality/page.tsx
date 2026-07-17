"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { PageToolbar, ToolbarButton } from "@/components/EditableGrid";
import { qualityTiers, type QualityTierRow } from "@/lib/mock-data";

export default function QualityPage() {
  const [tiers, setTiers] = useState<QualityTierRow[]>(() => qualityTiers.map((tier) => ({ ...tier })));
  const [aggregation, setAggregation] = useState<"SUM" | "DIMINISHING_RETURNS">("SUM");
  const [diminishingFactor, setDiminishingFactor] = useState(0.85);

  return (
    <AppShell
      title="品质评分"
      subtitle="设计体系 · 词条分值聚合算法"
      actions={<><ToolbarButton variant="secondary">新建版本</ToolbarButton><ToolbarButton variant="primary">保存评分模型</ToolbarButton></>}
    >
      <PageToolbar>
        <span className="toolbar-hint">品质 = 聚合所携带词条的分值。算法与档位阈值均可配置，变更后受影响 SKU 标记为陈旧并重算</span>
      </PageToolbar>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-heading"><div><span>聚合算法</span><h2>词条分值如何相加</h2></div></div>
        <div style={{ padding: 18, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 200 }}>
            <label>算法</label>
            <select value={aggregation} onChange={(event) => setAggregation(event.target.value as "SUM" | "DIMINISHING_RETURNS")}>
              <option value="SUM">直接相加</option>
              <option value="DIMINISHING_RETURNS">有损益加法（边际递减）</option>
            </select>
          </div>
          {aggregation === "DIMINISHING_RETURNS" && (
            <div className="field" style={{ minWidth: 200 }}>
              <label>递减因子（每多一个词条乘以此值）</label>
              <input type="number" step="0.01" value={diminishingFactor} onChange={(event) => setDiminishingFactor(Number(event.target.value))} />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 280 }}>
            <div className="note-line" style={{ margin: 0 }}>
              <strong>示例：</strong>词条分值 [3, 6, 5]{aggregation === "SUM"
                ? ` 直接相加 = ${3 + 6 + 5} 分`
                : ` 递减(因子${diminishingFactor}) = ${(3 + 6 * diminishingFactor + 5 * diminishingFactor ** 2).toFixed(2)} 分`}
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading"><div><span>品质档位</span><h2>分值区间 → 品质名</h2></div></div>
        <div className="grid-scroll">
          <table className="data-grid">
            <thead><tr><th className="grid-row-label-col">档位</th><th>名称</th><th>下限</th><th>上限</th><th>颜色</th></tr></thead>
            <tbody>
              {tiers.map((tier, index) => (
                <tr key={tier.key}>
                  <td className="grid-row-label">{String(index + 1).padStart(2, "0")}</td>
                  <td className="cell"><input className="cell-input" value={tier.name} onChange={(event) => setTiers((current) => current.map((row) => row.key === tier.key ? { ...row, name: event.target.value } : row))} /></td>
                  <td className="cell"><input className="cell-input" type="number" value={tier.min} onChange={(event) => setTiers((current) => current.map((row) => row.key === tier.key ? { ...row, min: Number(event.target.value) } : row))} /></td>
                  <td className="cell"><input className="cell-input" type="number" value={tier.max === 999 ? "" : tier.max} onChange={(event) => setTiers((current) => current.map((row) => row.key === tier.key ? { ...row, max: event.target.value === "" ? 999 : Number(event.target.value) } : row))} /></td>
                  <td className="cell-static"><span className="quality" style={{ color: tier.color, border: `1px solid ${tier.color}55`, background: `${tier.color}1a` }}>{tier.name}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="note-line">
        <strong>品质判定：</strong>主要由所携带词条的总评分决定。直接属性词条（如 +10 抛投精度）与被动技能词条（如抗冲击）都贡献分值；系列/SKU 在指定时即声明携带哪些词条。
      </div>
    </AppShell>
  );
}
