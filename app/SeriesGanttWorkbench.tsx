"use client";

import {
  AlertTriangle,
  Bot,
  Boxes,
  ChevronRight,
  CircleDot,
  Info,
  LockKeyhole,
  PackageSearch,
  Scale,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { hydrateV3Seed } from "@/lib/v3-seed";
import type {
  ConfigurationSnapshot,
  PurchasableModel,
  SeriesDefinition,
  SkuDrawer,
  WorkspaceState,
} from "@/lib/types";

interface SeriesGanttWorkbenchProps {
  state: WorkspaceState;
  mutate: (producer: (draft: WorkspaceState) => void, recalculate?: boolean) => void;
  notify: (message: string) => void;
}

const QUALITY_ORDER = [
  { id: "quality_c_green", letter: "C", color: "#23945f", name: "绿" },
  { id: "quality_b_blue", letter: "B", color: "#3b6fde", name: "蓝" },
  { id: "quality_a_purple", letter: "A", color: "#7658c8", name: "紫" },
  { id: "quality_s_orange", letter: "S", color: "#d77b18", name: "橙" },
];

function statusText(status: string) {
  const values: Record<string, string> = {
    draft: "草稿",
    approved: "已批准",
    published: "已发布",
    deprecated: "已废弃",
  };
  return values[status] ?? status;
}

function typeName(state: WorkspaceState, typeId: string) {
  return state.itemTypeProfiles.find((item) => item.id === typeId)?.name ?? typeId;
}

function RadarPreview({ snapshot }: { snapshot: ConfigurationSnapshot }) {
  const preview = snapshot.fiveAxisPreview;
  if (!preview) {
    return (
      <div className="gantt-unavailable">
        <AlertTriangle size={18} />
        <div>
          <strong>五轴预览尚不可计算</strong>
          <span>当前快照没有冻结 FiveAxisViewDefinition、共同顶点或完整底层参数。系统不会用 0 或示例值代替。</span>
        </div>
      </div>
    );
  }
  const metrics = preview.metrics;
  const center = 110;
  const radius = 84;
  const points = metrics.map((metric, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / metrics.length;
    const score = Math.max(0, Math.min(100, metric.displayScore ?? 0)) / 100;
    return {
      axisId: metric.axisId,
      x: center + Math.cos(angle) * radius * score,
      y: center + Math.sin(angle) * radius * score,
      labelX: center + Math.cos(angle) * (radius + 22),
      labelY: center + Math.sin(angle) * (radius + 22),
      score: metric.displayScore,
    };
  });
  const outer = metrics.map((_metric, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / metrics.length;
    return `${center + Math.cos(angle) * radius},${center + Math.sin(angle) * radius}`;
  }).join(" ");
  return (
    <div className="gantt-radar-layout">
      <svg className="gantt-radar" viewBox="0 0 220 220" role="img" aria-label="Model 五轴正式分">
        <polygon points={outer} className="radar-grid" />
        {[0.25, 0.5, 0.75].map((scale) => (
          <polygon
            key={scale}
            points={metrics.map((_metric, index) => {
              const angle = -Math.PI / 2 + (index * Math.PI * 2) / metrics.length;
              return `${center + Math.cos(angle) * radius * scale},${center + Math.sin(angle) * radius * scale}`;
            }).join(" ")}
            className="radar-grid inner"
          />
        ))}
        <polygon points={points.map((entry) => `${entry.x},${entry.y}`).join(" ")} className="radar-value" />
        {points.map((entry) => (
          <g key={entry.axisId}>
            <circle cx={entry.x} cy={entry.y} r="3.5" className="radar-dot" />
            <text x={entry.labelX} y={entry.labelY} textAnchor="middle" dominantBaseline="middle">
              {entry.axisId}
            </text>
          </g>
        ))}
      </svg>
      <div className="gantt-metric-table">
        {metrics.map((metric) => (
          <div key={metric.axisId}>
            <span>{metric.axisId}</span>
            <strong>{metric.displayScore ?? "不可用"}</strong>
            <small>{metric.unclampedModelRatio === null ? "缺少有效输入" : `未截断占比 ${(metric.unclampedModelRatio * 100).toFixed(1)}%`}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelDrawer({
  model,
  sku,
  series,
  snapshot,
  onClose,
}: {
  model: PurchasableModel;
  sku: SkuDrawer;
  series: SeriesDefinition;
  snapshot?: ConfigurationSnapshot;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"preview" | "ai">("preview");
  return (
    <aside className="gantt-model-drawer" aria-label="Model 预览">
      <header>
        <div>
          <span className="eyebrow">MODEL PREVIEW</span>
          <h2>{model.name}</h2>
          <p>{sku.targetPullKg} kgf · {model.action} · {model.hardness} · {model.lengthM} m</p>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭 Model 预览"><X size={18} /></button>
      </header>
      <div className="gantt-drawer-tabs">
        <button type="button" className={tab === "preview" ? "active" : ""} onClick={() => setTab("preview")}>Model 预览</button>
        <button type="button" className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")}>AI 评估与建议</button>
      </div>
      {tab === "preview" ? (
        <div className="gantt-drawer-body">
          <div className="gantt-identity-grid">
            <div><span>Series</span><strong>{series.name}</strong></div>
            <div><span>SKU 抽屉</span><strong>{sku.targetPullKg} kgf</strong></div>
            <div><span>Model</span><strong>{model.id}</strong></div>
            <div><span>冻结快照</span><strong>{snapshot?.id ?? "尚未发布"}</strong></div>
          </div>
          <section>
            <div className="gantt-section-title">
              <div><span className="eyebrow">FIVE AXIS</span><h3>钓组实际属性</h3></div>
              <span className="gantt-readonly"><LockKeyhole size={13} />只读派生</span>
            </div>
            {snapshot ? <RadarPreview snapshot={snapshot} /> : (
              <div className="gantt-unavailable"><Info size={18} /><div><strong>尚无冻结快照</strong><span>五轴正式预览只从最终 Model 参数派生，不会反写面板。</span></div></div>
            )}
          </section>
          <section>
            <div className="gantt-section-title"><div><span className="eyebrow">GUARDRAILS</span><h3>校验分层</h3></div></div>
            <div className="gantt-guardrails">
              <div><ShieldCheck size={16} /><span>硬校验</span><strong>{snapshot?.compatibilityReport.allowed ? "通过" : snapshot ? "有阻断" : "待校验"}</strong></div>
              <div><Scale size={16} /><span>Affinity</span><strong>{snapshot ? snapshot.affinityReport.score.toFixed(1) : "—"}</strong></div>
              <div><Sparkles size={16} /><span>品质</span><strong>{snapshot ? `${snapshot.qualityReport.letter} / ${snapshot.qualityReport.colorName}` : "—"}</strong></div>
            </div>
          </section>
        </div>
      ) : (
        <div className="gantt-drawer-body">
          <div className="gantt-ai-guardrail"><ShieldCheck size={18} /><strong>辅助建议 · 不影响系统校验</strong></div>
          <div className="gantt-ai-disabled">
            <Bot size={28} />
            <h3>AI 服务尚未启用</h3>
            <p>OPEN-006 的供应方、模型、字段白名单和数据出网策略尚未确认。核心派生、校验、Patch、发布和历史复现仍可正常使用。</p>
            <dl>
              <div><dt>服务状态</dt><dd>未配置</dd></div>
              <div><dt>允许出网字段</dt><dd>未确认</dd></div>
              <div><dt>草稿能力</dt><dd>不可用</dd></div>
            </dl>
            <div className="gantt-ai-actions">
              <button type="button" disabled>查看依据</button>
              <button type="button" disabled>预览变化</button>
              <button type="button" disabled>创建草稿</button>
              <button type="button" disabled>重新评估</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

export function SeriesGanttWorkbench({ state, mutate, notify }: SeriesGanttWorkbenchProps) {
  const [selectedSeriesId, setSelectedSeriesId] = useState(state.seriesDefinitions[0]?.id ?? "");
  const [selectedSkuId, setSelectedSkuId] = useState("");
  const [drawerModelId, setDrawerModelId] = useState("");
  const [query, setQuery] = useState("");

  const seriesList = useMemo(
    () => state.seriesDefinitions.filter((series) =>
      !query.trim() || [series.id, series.name].join(" ").toLowerCase().includes(query.trim().toLowerCase()),
    ),
    [state.seriesDefinitions, query],
  );
  const typeIds = useMemo(() => {
    const ids = Array.from(new Set(state.seriesDefinitions.map((series) => series.typeId)));
    return ids.length ? ids : state.itemTypeProfiles.slice(0, 1).map((item) => item.id);
  }, [state.seriesDefinitions, state.itemTypeProfiles]);
  const weights = useMemo(
    () => Array.from(new Set(state.skuDrawers.map((sku) => sku.targetPullKg))).sort((a, b) => a - b),
    [state.skuDrawers],
  );
  const selectedSeries = state.seriesDefinitions.find((series) => series.id === selectedSeriesId) ?? seriesList[0];
  const seriesSkus = selectedSeries
    ? state.skuDrawers.filter((sku) => sku.seriesId === selectedSeries.id).sort((a, b) => a.targetPullKg - b.targetPullKg)
    : [];
  const selectedSku = seriesSkus.find((sku) => sku.id === selectedSkuId) ?? seriesSkus[0];
  const models = selectedSku
    ? state.purchasableModels.filter((model) => selectedSku.modelIds.includes(model.id))
    : [];
  const drawerModel = state.purchasableModels.find((model) => model.id === drawerModelId);
  const drawerSku = drawerModel ? state.skuDrawers.find((sku) => sku.id === drawerModel.skuId) : undefined;
  const drawerSeries = drawerSku ? state.seriesDefinitions.find((series) => series.id === drawerSku.seriesId) : undefined;
  const drawerSnapshot = drawerModel?.configurationSnapshotId
    ? state.configurationSnapshots.find((snapshot) => snapshot.id === drawerModel.configurationSnapshotId)
    : undefined;

  const loadExample = () => {
    const next = hydrateV3Seed(state);
    mutate((draft) => Object.assign(draft, next), false);
    notify("已载入 v3 示例商品链；原有历史数据未被删除。");
  };

  if (!state.seriesDefinitions.length) {
    return (
      <div className="gantt-empty">
        <PackageSearch size={34} />
        <h2>还没有可规划的 Series</h2>
        <p>先载入 v3 示例商品链检查完整交互，或从已迁移规则创建正式 Series。</p>
        <button type="button" onClick={loadExample}><Sparkles size={15} />载入 v3 示例链</button>
      </div>
    );
  }

  const columnCount = Math.max(1, QUALITY_ORDER.length * Math.max(1, typeIds.length));
  return (
    <div className="series-gantt-page">
      <section className="gantt-toolbar">
        <div>
          <span className="eyebrow">SERIES PLANNING</span>
          <h2>钓具系列甘特图</h2>
          <p>按离散重量规划 Series、SKU 抽屉与可购买 Model。</p>
        </div>
        <div className="gantt-toolbar-actions">
          <label><PackageSearch size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Series 名称或 ID" /></label>
          <button type="button" onClick={() => notify("候选搜索配方保留在历史数据中；生成命令将在当前 Series / SKU Revision 上执行。")}>生成 Model 候选</button>
          <button type="button" disabled title="OPEN-006 尚未确认">AI 评估</button>
        </div>
      </section>

      <div className="gantt-continuity-note"><Info size={16} /><strong>覆盖范围只表达系列规划跨度，不代表连续插值。</strong></div>

      <section className="gantt-matrix-shell">
        <div className="gantt-quality-header" style={{ gridTemplateColumns: `88px repeat(${columnCount}, minmax(142px, 1fr))` }}>
          <span className="gantt-axis-corner">重量规格</span>
          {QUALITY_ORDER.map((quality) => (
            <div key={quality.id} style={{ gridColumn: `span ${Math.max(1, typeIds.length)}`, borderTopColor: quality.color }}>
              <strong style={{ color: quality.color }}>{quality.letter} / {quality.name}</strong>
            </div>
          ))}
          <span />
          {QUALITY_ORDER.flatMap((quality) => typeIds.map((typeId) => (
            <div className="gantt-type-header" key={quality.id + typeId}>{typeName(state, typeId)}</div>
          )))}
        </div>
        <div
          className="gantt-matrix"
          style={{
            gridTemplateColumns: `88px repeat(${columnCount}, minmax(142px, 1fr))`,
            gridTemplateRows: `repeat(${Math.max(weights.length, 1)}, 70px)`,
          }}
        >
          {weights.map((weight, index) => (
            <div className="gantt-weight-label" key={weight} style={{ gridColumn: 1, gridRow: index + 1 }}>
              <strong>{weight}</strong><span>kg</span>
            </div>
          ))}
          {weights.flatMap((_weight, row) => Array.from({ length: columnCount }, (_unused, col) => (
            <div className="gantt-grid-cell" key={row + ":" + col} style={{ gridColumn: col + 2, gridRow: row + 1 }} />
          )))}
          {seriesList.map((series) => {
            const qualityIndex = QUALITY_ORDER.findIndex((quality) => quality.id === series.qualityId);
            const typeIndex = Math.max(0, typeIds.indexOf(series.typeId));
            const column = 2 + Math.max(0, qualityIndex) * Math.max(1, typeIds.length) + typeIndex;
            const skus = state.skuDrawers.filter((sku) => sku.seriesId === series.id);
            const rowIndexes = skus.map((sku) => weights.indexOf(sku.targetPullKg)).filter((index) => index >= 0);
            if (!rowIndexes.length) return null;
            const minRow = Math.min(...rowIndexes);
            const maxRow = Math.max(...rowIndexes);
            const color = QUALITY_ORDER[Math.max(0, qualityIndex)]?.color ?? "#586675";
            return (
              <div
                className={`gantt-series-block ${selectedSeries?.id === series.id ? "selected" : ""}`}
                key={series.id}
                style={{ gridColumn: column, gridRow: `${minRow + 1} / ${maxRow + 2}`, "--series-color": color } as React.CSSProperties}
              >
                <button type="button" className="gantt-series-select" onClick={() => { setSelectedSeriesId(series.id); setSelectedSkuId(""); }}>
                  <strong>{series.name}</strong><small>{skus.length} 个真实 SKU</small>
                </button>
                {skus.map((sku) => {
                  const denominator = Math.max(1, maxRow - minRow);
                  const offset = ((weights.indexOf(sku.targetPullKg) - minRow) / denominator) * 100;
                  return (
                    <button
                      type="button"
                      className={`gantt-sku-node ${selectedSku?.id === sku.id ? "selected" : ""}`}
                      key={sku.id}
                      style={{ top: `calc(${offset}% - 8px)` }}
                      title={`${sku.targetPullKg} kgf · ${sku.modelIds.length} 个 Model`}
                      onClick={() => { setSelectedSeriesId(series.id); setSelectedSkuId(sku.id); }}
                    ><span />{sku.targetPullKg}</button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>

      {selectedSeries ? (
        <section className="gantt-summary">
          <header>
            <div><span className="eyebrow">SERIES SUMMARY</span><h3>{selectedSeries.name}</h3></div>
            <button type="button">打开 Series <ChevronRight size={15} /></button>
          </header>
          <div className="gantt-summary-meta">
            <span><CircleDot size={13} />{statusText(selectedSeries.status)}</span>
            <span>{typeName(state, selectedSeries.typeId)}</span>
            <span>{seriesSkus.length} 个离散重量</span>
          </div>
          <div className="gantt-sku-tabs">
            {seriesSkus.map((sku) => (
              <button type="button" key={sku.id} className={selectedSku?.id === sku.id ? "active" : ""} onClick={() => setSelectedSkuId(sku.id)}>
                <strong>{sku.targetPullKg} kgf</strong><span>SKU 抽屉 · {sku.modelIds.length} Model</span>
              </button>
            ))}
          </div>
          {selectedSku ? (
            <div className="gantt-model-list">
              <div className="gantt-model-list-head"><span>Model</span><span>配置</span><span>状态</span><span /></div>
              {models.map((model) => (
                <button type="button" key={model.id} onClick={() => setDrawerModelId(model.id)}>
                  <span><Boxes size={15} /><div><strong>{model.name}</strong><small>{model.id}</small></div></span>
                  <span>{model.action} · {model.hardness} · {model.lengthM}m</span>
                  <span>{statusText(model.status)}</span>
                  <ChevronRight size={16} />
                </button>
              ))}
              {!models.length ? <div className="gantt-no-model">该 SKU 抽屉还没有 Model；不会自动跨层打开或创建对象。</div> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {drawerModel && drawerSku && drawerSeries ? (
        <>
          <button className="gantt-drawer-backdrop" type="button" aria-label="关闭预览" onClick={() => setDrawerModelId("")} />
          <ModelDrawer model={drawerModel} sku={drawerSku} series={drawerSeries} snapshot={drawerSnapshot} onClose={() => setDrawerModelId("")} />
        </>
      ) : null}
    </div>
  );
}
