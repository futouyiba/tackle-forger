"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { PageToolbar, ToolbarButton } from "@/components/EditableGrid";
import { skus, templates, dimensionOptions, affixes, templateById, type SkuRow } from "@/lib/mock-data";
import { computeSku } from "@/lib/calc";
import { usePersistentState } from "@/lib/usePersistentState";

const qualityColor: Record<string, string> = { 绿: "#49c779", 蓝: "#57a9e8", 紫: "#9a70e8", 金: "#e0ad4e" };

export default function SkusPage() {
  const [rows, setRows] = usePersistentState<SkuRow[]>("tf:skus", skus.map((sku) => ({ ...sku, selectedOptions: [...sku.selectedOptions], affixes: [...sku.affixes] })));
  const [selectedId, setSelectedId] = useState<string>(rows[0]?.id ?? "");
  const [traceKey, setTraceKey] = useState<string>("rod.maxPull");

  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;

  const computation = useMemo(() => {
    if (!selected) return null;
    return computeSku({
      comboCode: selected.comboCode, templateId: selected.templateId,
      targetWeightMin: selected.targetWeightMin, targetWeightMax: selected.targetWeightMax,
      selectedOptions: selected.selectedOptions, selectedAffixes: selected.affixes,
    });
  }, [selected]);

  const patchSelected = (patch: Partial<SkuRow>) => {
    setRows((current) => current.map((row) => (row.id === selectedId ? { ...row, ...patch } : row)));
  };

  const toggleOption = (optionId: string) => {
    if (!selected) return;
    const has = selected.selectedOptions.includes(optionId);
    patchSelected({ selectedOptions: has ? selected.selectedOptions.filter((id) => id !== optionId) : [...selected.selectedOptions, optionId] });
  };

  const toggleAffix = (affixId: string) => {
    if (!selected) return;
    const has = selected.affixes.includes(affixId);
    patchSelected({ affixes: has ? selected.affixes.filter((id) => id !== affixId) : [...selected.affixes, affixId] });
  };

  const liveQuality = computation?.quality.tier ?? selected?.quality ?? "蓝";
  const liveScore = computation?.quality.score ?? selected?.score ?? 0;
  const liveSafe = computation?.safePull ?? 0;

  return (
    <AppShell
      title="组合 SKU"
      subtitle="生产配置 · 实时计算（编辑即重算）"
      actions={<><ToolbarButton variant="secondary">批量生成候选</ToolbarButton><ToolbarButton variant="primary">保存</ToolbarButton></>}
    >
      <PageToolbar>
        <span className="toolbar-hint">勾选维度选项 / 词条，品质评分、拉力、安全拉力由 domain 引擎实时重算 · 钓性/硬度/长度自动生成可覆盖</span>
      </PageToolbar>

      <div className="detail-layout" style={{ gridTemplateColumns: "1fr 380px" }}>
        <div className="panel">
          <div className="grid-scroll" style={{ maxHeight: "78vh" }}>
            <table className="data-grid">
              <thead>
                <tr>
                  <th className="grid-row-label-col">SKU</th><th>系列</th><th>模板</th><th>目标区间(kg)</th><th>品质</th><th>评分</th><th>杆/轮/线拉力</th><th>安全拉力</th><th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const template = templateById(row.templateId);
                  const isActive = row.id === selectedId;
                  return (
                    <tr key={row.id} onClick={() => setSelectedId(row.id)} style={{ cursor: "pointer" }} className={isActive ? "active-row" : ""}>
                      <td className="grid-row-label"><strong style={{ color: "#eaf4f1" }}>{row.comboCode}</strong></td>
                      <td className="cell-static">{row.seriesName}</td>
                      <td className="cell-static">{template ? `${template.code} · ${template.weightBand}` : row.templateId}</td>
                      <td className="cell-static align-right">{row.targetWeightMin}–{row.targetWeightMax}</td>
                      <td className="cell-static"><span className="quality" style={{ color: qualityColor[row.quality], border: `1px solid ${qualityColor[row.quality]}55`, background: `${qualityColor[row.quality]}1a` }}>{row.quality}</span></td>
                      <td className="cell-static align-right">{row.score}</td>
                      <td className="cell-static align-right" style={{ fontSize: 9 }}>{row.rodPull}/{row.reelPull}/{row.linePull}</td>
                      <td className="cell-static align-right">{Math.min(row.rodPull * 0.9, row.reelPull, row.linePull * 0.35).toFixed(0)}</td>
                      <td className="cell-static"><span className={`status-chip ${row.status}`}>{row.status}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {selected && computation && (
          <aside className="inspector">
            <h3>精调 · {selected.comboCode}</h3>

            <div className="field"><label>组合 ID / 平台定位</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input value={selected.comboCode} onChange={(event) => patchSelected({ comboCode: event.target.value })} />
                <input value={selected.platformPositioning} onChange={(event) => patchSelected({ platformPositioning: event.target.value })} />
              </div>
            </div>
            <div className="field"><label>模板（基准）</label>
              <select value={selected.templateId} onChange={(event) => patchSelected({ templateId: event.target.value })}>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.code} · {template.name}</option>)}
              </select>
            </div>
            <div className="field"><label>目标重量区间 (kg)</label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="number" value={selected.targetWeightMin} onChange={(event) => patchSelected({ targetWeightMin: Number(event.target.value) })} />
                <span style={{ color: "#53666d" }}>—</span>
                <input type="number" value={selected.targetWeightMax} onChange={(event) => patchSelected({ targetWeightMax: Number(event.target.value) })} />
              </div>
            </div>

            {/* 实时计算结果 */}
            <div style={{ margin: "14px 0 10px", padding: 12, border: "1px solid #1d2d34", background: "#0b151a", borderRadius: 3 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ color: "#62757c", fontSize: 9, letterSpacing: ".1em" }}>实时计算</span>
                <span className="quality" style={{ color: qualityColor[liveQuality], border: `1px solid ${qualityColor[liveQuality]}55`, background: `${qualityColor[liveQuality]}1a` }}>{liveQuality}</span>
              </div>
              <div className="kv-grid">
                <div className="kv-cell"><span>词条评分</span><strong style={{ color: qualityColor[liveQuality] }}>{liveScore}</strong></div>
                <div className="kv-cell"><span>安全拉力</span><strong>{liveSafe.toFixed(0)} g</strong></div>
                <div className="kv-cell"><span>杆拉力</span><strong>{computation.pulls.rod}</strong></div>
                <div className="kv-cell"><span>轮拉力</span><strong>{computation.pulls.reel}</strong></div>
                <div className="kv-cell"><span>线拉力</span><strong>{computation.pulls.line}</strong></div>
                <div className="kv-cell"><span>组件 ID</span><strong style={{ fontSize: 11 }}>{computation.componentIds.rod.replace("_R", "")}_R/W/L</strong></div>
              </div>
            </div>

            {/* 维度选项（可勾选） */}
            <label style={{ display: "block", marginBottom: 6, color: "#62757c", fontSize: 9, letterSpacing: ".1em" }}>维度选项（影响参数）</label>
            <div className="kv-grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 12 }}>
              {dimensionOptions.map((option) => {
                const active = selected.selectedOptions.includes(option.id);
                return (
                  <button key={option.id} className={`filter-tab ${active ? "active" : ""}`} style={{ height: "auto", minHeight: 32, padding: "5px 8px", textAlign: "left", alignItems: "flex-start" }} onClick={() => toggleOption(option.id)}>
                    <span><strong style={{ fontSize: 10, display: "block" }}>{option.name}</strong><small style={{ color: "#6e8087", fontSize: 8 }}>{option.catalog}</small></span>
                  </button>
                );
              })}
            </div>

            {/* 词条（可勾选，决定品质） */}
            <label style={{ display: "block", marginBottom: 6, color: "#62757c", fontSize: 9, letterSpacing: ".1em" }}>携带词条（决定品质分值）</label>
            <div className="kv-grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 12 }}>
              {affixes.map((affix) => {
                const active = selected.affixes.includes(affix.id);
                return (
                  <button key={affix.id} className={`filter-tab ${active ? "active" : ""}`} style={{ height: "auto", minHeight: 32, padding: "5px 8px", textAlign: "left", alignItems: "flex-start" }} onClick={() => toggleAffix(affix.id)}>
                    <span><strong style={{ fontSize: 10, display: "block" }}>{affix.name}</strong><small style={{ color: active ? "#8fd9bd" : "#6e8087", fontSize: 8 }}>{affix.kind === "ATTRIBUTE" ? "+属性" : "◆被动"} · {affix.score}分</small></span>
                  </button>
                );
              })}
            </div>

            {/* 品质分解 */}
            {computation.quality.contributions.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: "block", marginBottom: 6, color: "#62757c", fontSize: 9, letterSpacing: ".1em" }}>品质分值分解</label>
                {computation.quality.contributions.map((item) => (
                  <div key={item.name} className="meta-line"><span>{item.name}</span><strong>+{item.score}</strong></div>
                ))}
                <div className="meta-line"><span>合计</span><strong style={{ color: qualityColor[liveQuality] }}>{liveScore} → {liveQuality}</strong></div>
              </div>
            )}

            {/* 计算追溯 */}
            <div>
              <label style={{ display: "block", marginBottom: 6, color: "#62757c", fontSize: 9, letterSpacing: ".1em" }}>计算追溯</label>
              <select value={traceKey} onChange={(event) => setTraceKey(event.target.value)} style={{ width: "100%", height: 28, marginBottom: 8, background: "#0b151a", border: "1px solid var(--line)", color: "var(--text)", fontSize: 11 }}>
                {computation.parameters.map((parameter) => <option key={parameter.key} value={parameter.key}>{parameter.label}</option>)}
              </select>
              <TraceView trace={computation.parameters.find((parameter) => parameter.key === traceKey)?.trace ?? []} />
            </div>
          </aside>
        )}
      </div>
    </AppShell>
  );
}

function TraceView({ trace }: { trace: Array<{ layerId: string; operation: string; operand: number; before: number; after: number }> }) {
  if (trace.length === 0) return <div className="note-line" style={{ margin: 0 }}>该参数未受任何规则修正，保持模板基准值。</div>;
  const opSymbol: Record<string, string> = { ADD: "+", MULTIPLY: "×", SET: "=" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {trace.map((step, index) => (
        <div key={index} style={{ display: "grid", gridTemplateColumns: "32px 1fr auto", gap: 6, alignItems: "center", padding: "4px 6px", background: "#0b151a", border: "1px solid #15212a", fontSize: 9 }}>
          <span className={`op-badge ${step.operation.toLowerCase()}`}>{opSymbol[step.operation]}</span>
          <span style={{ color: "#819198" }}>{step.before} → <strong style={{ color: "#eaf4f1" }}>{step.after}</strong></span>
          <span style={{ color: "#53666d", fontFamily: "monospace" }}>{step.operand}</span>
        </div>
      ))}
    </div>
  );
}
