"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { PageToolbar, ToolbarButton } from "@/components/EditableGrid";
import { proposals, type ProposalRow } from "@/lib/mock-data";

export default function ProposalsPage() {
  const [rows, setRows] = useState<ProposalRow[]>(() => proposals.map((proposal) => ({ ...proposal })));
  const pending = rows.filter((row) => row.status === "待审批");

  const setStatus = (id: string, status: ProposalRow["status"]) => setRows((current) => current.map((row) => row.id === id ? { ...row, status } : row));

  return (
    <AppShell
      title="规则提案"
      subtitle="运营 · 把反复精调固化为可复用规则"
      actions={<ToolbarButton variant="primary">重新分析精调</ToolbarButton>}
    >
      <PageToolbar>
        <div className="stat-row" style={{ marginBottom: 0 }}>
          <div className="stat-card"><span>待审批</span><strong>{pending.length}</strong></div>
          <div className="stat-card"><span>提案总数</span><strong>{rows.length}</strong></div>
          <div className="stat-card"><span>平均置信度</span><strong>{Math.round((rows.reduce((sum, row) => sum + row.confidence, 0) / rows.length) * 100)}%</strong></div>
          <div className="stat-card"><span>影响候选合计</span><strong>{rows.reduce((sum, row) => sum + row.affected, 0)}</strong></div>
        </div>
      </PageToolbar>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {rows.map((row) => (
          <div key={row.id} className="panel" style={{ borderLeft: `3px solid ${row.status === "待审批" ? "var(--violet)" : row.status === "已采纳" ? "var(--accent)" : "#3a4750"}` }}>
            <div style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
                    <strong style={{ fontSize: 14 }}>{row.summary}</strong>
                    <span className={`status-chip ${row.status}`}>{row.status}</span>
                  </div>
                  <div style={{ color: "#6e8087", fontSize: 11, marginBottom: 12 }}>{row.scope}</div>
                  <div style={{ display: "flex", gap: 20 }}>
                    <div><span style={{ color: "#62757c", fontSize: 9 }}>影响候选</span><div style={{ fontSize: 16, color: "#eaf4f1" }}>{row.affected}</div></div>
                    <div><span style={{ color: "#62757c", fontSize: 9 }}>置信度</span><div style={{ fontSize: 16, color: row.confidence > 0.8 ? "var(--accent)" : "var(--amber)" }}>{Math.round(row.confidence * 100)}%</div></div>
                  </div>
                  <div className="note-line" style={{ marginTop: 12 }}>
                    <strong>来源：</strong>来自 {row.affected} 条手工精调记录的模式聚类。采纳后将创建新规则版本并重算依赖候选，可在审批前模拟影响。
                  </div>
                </div>
                {row.status === "待审批" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 110 }}>
                    <button className="button secondary" onClick={() => setStatus(row.id, "已采纳")}>模拟影响</button>
                    <button className="button primary" onClick={() => setStatus(row.id, "已采纳")}>采纳为规则</button>
                    <button className="button ghost" onClick={() => setStatus(row.id, "已驳回")}>驳回</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </AppShell>
  );
}
