"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { PageToolbar, ToolbarButton } from "@/components/EditableGrid";
import { reviews, proposals, type ReviewRow, type ProposalRow } from "@/lib/mock-data";

export default function ReviewsPage() {
  const [items, setItems] = useState<ReviewRow[]>(() => reviews.map((review) => ({ ...review })));
  const [tab, setTab] = useState<"reviews" | "proposals">("reviews");
  const [proposalRows, setProposalRows] = useState<ProposalRow[]>(() => proposals.map((proposal) => ({ ...proposal })));

  return (
    <AppShell
      title="手工筛选与规则学习"
      subtitle="运营 · 精调反馈闭环"
      actions={<><ToolbarButton variant="secondary">导出报告</ToolbarButton><ToolbarButton variant="primary">提交精调</ToolbarButton></>}
    >
      <PageToolbar>
        <div className="filter-tabs">
          <button className={`filter-tab ${tab === "reviews" ? "active" : ""}`} onClick={() => setTab("reviews")}>精调记录<em>{items.length}</em></button>
          <button className={`filter-tab ${tab === "proposals" ? "active" : ""}`} onClick={() => setTab("proposals")}>规则提案<em>{proposalRows.filter((row) => row.status === "待审批").length}</em></button>
        </div>
        <span className="toolbar-hint">手工筛选的反复精调会被聚合成提案，经管理员审批固化为新规则版本</span>
      </PageToolbar>

      {tab === "reviews" ? (
        <div className="grid-scroll">
          <table className="data-grid">
            <thead>
              <tr><th className="grid-row-label-col">记录</th><th>SKU</th><th>问题</th><th>级别</th><th>字段</th><th>原值</th><th>调后</th><th>原因</th><th>评审人</th><th>日期</th></tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td className="grid-row-label">{row.id}</td>
                  <td className="cell-static"><strong style={{ color: "#eaf4f1" }}>{row.skuId}</strong></td>
                  <td className="cell-static">{row.issue}</td>
                  <td className="cell-static"><span className={`severity ${row.severity}`}>{row.severity}</span></td>
                  <td className="cell-static" style={{ fontFamily: "monospace", fontSize: 10 }}>{row.field}</td>
                  <td className="cell-static align-right">{row.before}</td>
                  <td className="cell-static align-right"><strong style={{ color: "var(--amber)" }}>{row.after}</strong></td>
                  <td className="cell-static">{row.reason}</td>
                  <td className="cell-static">{row.reviewer}</td>
                  <td className="cell-static">{row.createdAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="kv-grid" style={{ gridTemplateColumns: "1fr" }}>
          {proposalRows.map((row) => (
            <div key={row.id} style={{ padding: 16, border: "1px solid #1c2c33", background: "#0e1a20" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                    <strong style={{ fontSize: 13 }}>{row.summary}</strong>
                    <span className={`status-chip ${row.status}`}>{row.status}</span>
                  </div>
                  <div style={{ color: "#6e8087", fontSize: 10 }}>{row.scope}</div>
                  <div style={{ display: "flex", gap: 18, marginTop: 10 }}>
                    <span style={{ color: "#819198", fontSize: 10 }}>影响候选：<strong style={{ color: "#eaf4f1" }}>{row.affected}</strong></span>
                    <span style={{ color: "#819198", fontSize: 10 }}>置信度：<strong style={{ color: row.confidence > 0.8 ? "var(--accent)" : "var(--amber)" }}>{Math.round(row.confidence * 100)}%</strong></span>
                  </div>
                </div>
                {row.status === "待审批" && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="button secondary" onClick={() => setProposalRows((current) => current.map((item) => item.id === row.id ? { ...item, status: "已采纳" } : item))}>模拟影响</button>
                    <button className="button primary" onClick={() => setProposalRows((current) => current.map((item) => item.id === row.id ? { ...item, status: "已采纳" } : item))}>采纳</button>
                    <button className="button ghost" onClick={() => setProposalRows((current) => current.map((item) => item.id === row.id ? { ...item, status: "已驳回" } : item))}>驳回</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
