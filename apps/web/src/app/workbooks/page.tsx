"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { PageToolbar, ToolbarButton } from "@/components/EditableGrid";
import { workbookSheetNames } from "@tackle-forger/excel";

const sourceSheets = workbookSheetNames.map((name) => ({ name, status: "已识别" as const }));

interface ParsedSheetInfo { name: string; columns: number; rows: number; headers: string[]; }
interface ParseResult { fileName: string; sheetCount: number; totals: { rows: number; columns: number }; sheets: ParsedSheetInfo[]; hasMetadata: boolean; }

export default function WorkbooksPage() {
  const [stage, setStage] = useState<"idle" | "loading" | "preview" | "applied" | "error">("idle");
  const [fileName, setFileName] = useState<string>("");
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string>("");

  const parseFile = async (file: File) => {
    setFileName(file.name);
    setStage("loading");
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/import", { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "解析失败");
      setResult(data as ParseResult);
      setStage("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
      setStage("error");
    }
  };

  return (
    <AppShell
      title="工作簿导入导出"
      subtitle="运营 · 与 Excel 双向迁移"
      actions={<><ToolbarButton variant="secondary" onClick={() => { window.location.href = "/api/export"; }}>导出兼容工作簿</ToolbarButton><ToolbarButton variant="primary">下载模板</ToolbarButton></>}
    >
      <PageToolbar>
        <span className="toolbar-hint">Web 计算为权威来源 · 导入采用真实解析预演，绝不执行任意 Excel 公式 · 导出含隐藏元数据表保证往返一致</span>
      </PageToolbar>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-heading"><div><span>导入</span><h2>上传设计工作簿（真实解析）</h2></div></div>
        <div style={{ padding: 20 }}>
          <label
            className="drop-zone"
            style={{ display: "block", cursor: stage === "loading" ? "wait" : "pointer" }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) parseFile(file); }}
          >
            <input type="file" accept=".xlsx" style={{ display: "none" }} onChange={(event) => { const file = event.target.files?.[0]; if (file) parseFile(file); }} />
            <strong>{stage === "loading" ? `正在解析 ${fileName}…` : (fileName || "拖拽 .xlsx 到此处，或点击选择文件")}</strong>
            <p>支持 淡水路亚杆轮线装备设计.xlsx 与 钓具装备母表与道具生成逻辑_v1.0.xlsx</p>
          </label>

          {stage === "error" && <div className="login-error" style={{ marginTop: 14 }}>✕ {error}</div>}

          {stage === "preview" && result && (
            <>
              <div className="import-summary">
                <div className="stat-card"><span>解析表数</span><strong>{result.sheetCount}</strong></div>
                <div className="stat-card"><span>总数据行</span><strong>{result.totals.rows}</strong></div>
                <div className="stat-card"><span>最大列数</span><strong>{result.totals.columns}</strong></div>
                <div className="stat-card"><span>元数据表</span><strong style={{ color: result.hasMetadata ? "var(--accent)" : "#819198" }}>{result.hasMetadata ? "已识别" : "无"}</strong></div>
              </div>
              <div style={{ marginTop: 16 }}>
                <strong style={{ display: "block", marginBottom: 8, color: "#93a4aa", fontSize: 11 }}>逐表解析结果</strong>
                <div className="grid-scroll">
                  <table className="data-grid compact">
                    <thead><tr><th className="grid-row-label-col">#</th><th>表名</th><th>列数</th><th>行数</th><th>表头（前 8 列）</th></tr></thead>
                    <tbody>
                      {result.sheets.map((sheet, index) => (
                        <tr key={sheet.name}>
                          <td className="grid-row-label">{String(index + 1).padStart(2, "0")}</td>
                          <td className="cell-static"><strong style={{ color: "#eaf4f1" }}>{sheet.name}</strong></td>
                          <td className="cell-static align-right">{sheet.columns}</td>
                          <td className="cell-static align-right">{sheet.rows}</td>
                          <td className="cell-static" style={{ color: "#6e8087", fontFamily: "monospace", fontSize: 9 }}>{sheet.headers.join(" · ") || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button className="button primary" onClick={() => setStage("applied")}>确认并应用</button>
                <button className="button ghost" onClick={() => { setStage("idle"); setFileName(""); setResult(null); }}>取消</button>
              </div>
            </>
          )}
          {stage === "applied" && <div className="note-line" style={{ marginTop: 14 }}><strong>已应用：</strong>解析的 {result?.sheetCount ?? 0} 张表已导入预演区，所有计算将用引擎重新生成并通过对照。</div>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading"><div><span>表结构</span><h2>兼容工作簿的编号表</h2></div></div>
        <div className="grid-scroll">
          <table className="data-grid">
            <thead><tr><th className="grid-row-label-col">序号</th><th>表名</th><th>状态</th></tr></thead>
            <tbody>
              {sourceSheets.map((sheet, index) => (
                <tr key={sheet.name}>
                  <td className="grid-row-label">{String(index).padStart(2, "0")}</td>
                  <td className="cell-static"><strong style={{ color: "#eaf4f1" }}>{sheet.name}</strong></td>
                  <td className="cell-static"><span className="status-chip 已发布">{sheet.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
