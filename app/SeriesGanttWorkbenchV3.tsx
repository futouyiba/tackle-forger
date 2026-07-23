"use client";

import {
  AlertTriangle,
  Bot,
  Boxes,
  ChevronRight,
  CircleDot,
  Info,
  ListFilter,
  LockKeyhole,
  PackageSearch,
  Plus,
  Scale,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildProductBreadcrumbs,
  resolveProductDeepLink,
  type ActionAvailabilityMap,
  type BreadcrumbItem,
} from "@/lib/interaction-contracts";
import { buildSamePartComparison, calculateModelFiveAxisPreview, fiveAxisPlotRatio } from "@/lib/five-axis";
import { deterministicHash } from "@/lib/rule-kernel";
import {
  enabledProductItemParts,
  isProductItemPartEnabled,
  seriesItemPartId,
} from "@/lib/enabled-item-parts";
import {
  querySeriesGantt,
  seriesGanttQueryFromSearchParams,
  seriesGanttQueryToSearchParams,
  type SeriesGanttQuery,
} from "@/lib/series-gantt-query";
import type {
  ConfigurationSnapshot,
  FiveAxisComparisonView,
  FiveAxisEntityInput,
  ModelFiveAxisPreview,
  FiveAxisViewDefinition,
  PurchasableModel,
  SeriesDefinition,
  SkuDrawer,
  WorkspaceState,
} from "@/lib/types";
import "./series-gantt-v3.css";
import { CandidateGenerationWorkbench } from "./CandidateGenerationWorkbench";

interface SeriesGanttWorkbenchV3Props {
  state: WorkspaceState;
  workspaceId: string;
  actionAvailabilities: ActionAvailabilityMap;
  notify: (message: string) => void;
  actor: string;
  mutate: (producer: (draft: WorkspaceState) => void, recalculate?: boolean) => void;
  onWorkspaceApplied: (nextState: WorkspaceState, nextRevision: number, message: string) => void;
  onOpenSeries: (seriesId: string) => void;
  onBreadcrumbsChange?: (items: BreadcrumbItem[]) => void;
}

const QUALITY_ORDER = [
  { id: "quality_c_green", letter: "C", color: "#23945f", name: "绿" },
  { id: "quality_b_blue", letter: "B", color: "#3b6fde", name: "蓝" },
  { id: "quality_a_purple", letter: "A", color: "#7658c8", name: "紫" },
  { id: "quality_s_orange", letter: "S", color: "#d77b18", name: "橙" },
] as const;

type DrawerTab = "overview" | "five_axis" | "trace" | "rebase" | "ai";
type FiveAxisMode = "model_series" | "tackle_fit" | "same_part";

interface SeriesCreateDraft {
  seriesId: string;
  name: string;
  concept: string;
  collectionId: string;
  itemPartId: string;
  methodId: string;
  typeId: string;
  functionId: string;
  qualityId: SeriesDefinition["qualityId"];
  performanceId: string;
  functionIntensity: 1 | 2 | 3;
  planningMinKgf: string;
  planningMaxKgf: string;
  discretePulls: string;
}

function parseDiscretePulls(value: string): number[] {
  return [...new Set(value.split(/[,，;；\s]+/)
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0))]
    .sort((left, right) => left - right);
}

function typeName(state: WorkspaceState, typeId: string) {
  return state.itemTypeProfiles.find((item) => item.id === typeId)?.name ?? typeId;
}

function statusText(status: string) {
  const labels: Record<string, string> = {
    draft: "草稿",
    approved: "待发布",
    published: "已发布",
    superseded: "已替代",
    HARD_CONFLICT: "硬冲突",
    REBASE_REQUIRED: "需要 Rebase",
    REVIEW_REQUIRED: "待复核",
    WARNING: "有警告",
    READY_TO_PUBLISH: "待发布",
    HAS_UPGRADE_CANDIDATE: "有升级候选",
    PUBLISHED: "已发布",
    DRAFT: "草稿",
    ACTIVE: "活跃",
    DEPRECATED: "已废弃",
    ARCHIVED: "已归档",
    PENDING_REVIEW: "待复核",
    CHANGES_REQUESTED: "需修改",
    APPROVED: "已批准",
    SUPERSEDED: "已替代",
    NOT_EVALUATED: "未校验",
    EVALUATING: "校验中",
    PASSED: "已通过",
    BLOCKED: "已阻断",
    ERROR: "校验异常",
    UNPUBLISHED: "未发布",
    PUBLISHING: "发布中",
    PUBLISH_FAILED: "发布失败",
    SOURCE_STALE: "规则源过期",
    IMPORT_CONFLICT: "导入冲突",
    EXPORT_RELATION_BROKEN: "导出关系断裂",
  };
  return labels[status] ?? `未知状态：${status}`;
}

function MultiSelectFilter<T extends string | number>({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values?: T[];
  options: Array<{ value: T; label: string }>;
  onChange: (values: T[] | undefined) => void;
}) {
  const selected = values ?? [];
  const toggle = (value: T) => {
    const next = selected.includes(value)
      ? selected.filter((entry) => entry !== value)
      : [...selected, value];
    onChange(next.length ? next : undefined);
  };
  return (
    <details className="gantt-multi-filter">
      <summary>{label}{selected.length ? ` · ${selected.length}` : ""}</summary>
      <div>
        {options.map((option) => (
          <label key={String(option.value)}>
            <input type="checkbox" checked={selected.includes(option.value)} onChange={() => toggle(option.value)} />
            <span>{option.label}</span>
          </label>
        ))}
        {!options.length ? <small>当前没有可选项</small> : null}
      </div>
    </details>
  );
}

function initialQuery(): SeriesGanttQuery {
  if (typeof window === "undefined") return { sort: "quality_type" };
  const query = seriesGanttQueryFromSearchParams(new URL(window.location.href).searchParams);
  return { sort: "quality_type", ...query };
}

function initialSelection(key: "series" | "sku" | "model" | "snapshot") {
  if (typeof window === "undefined") return "";
  return new URL(window.location.href).searchParams.get(key) ?? "";
}

function updateLocation(
  query: SeriesGanttQuery,
  selection: { seriesId?: string; skuId?: string; modelId?: string; snapshotId?: string },
) {
  const url = new URL(window.location.href);
  const next = seriesGanttQueryToSearchParams(query);
  next.set("page", "candidates");
  if (selection.seriesId) next.set("series", selection.seriesId);
  if (selection.skuId) next.set("sku", selection.skuId);
  if (selection.modelId) next.set("model", selection.modelId);
  if (selection.snapshotId) next.set("snapshot", selection.snapshotId);
  url.search = next.toString();
  window.history.replaceState(null, "", url);
}

function FiveAxisRadar({
  preview,
  definition,
}: {
  preview?: ModelFiveAxisPreview;
  definition?: FiveAxisViewDefinition;
}) {
  if (!preview) {
    return (
      <div className="gantt-unavailable">
        <AlertTriangle size={18} />
        <div><strong>五维预览不可用</strong><span>当前冻结快照缺少 FiveAxisViewDefinition 或完整底层参数，不会用 0 代替。</span></div>
      </div>
    );
  }
  const metrics = preview.metrics;
  const center = 110;
  const radius = 82;
  const axisName = (axisId: string) =>
    definition?.axes.find((axis) => axis.axisId === axisId)?.label ?? axisId;
  const points = metrics.map((metric, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / metrics.length;
    const score = fiveAxisPlotRatio(metric.displayScore);
    return {
      axisId: metric.axisId,
      x: score === null ? null : center + Math.cos(angle) * radius * score,
      y: score === null ? null : center + Math.sin(angle) * radius * score,
      labelX: center + Math.cos(angle) * (radius + 24),
      labelY: center + Math.sin(angle) * (radius + 24),
    };
  });
  const completePolygon = points.every((entry) => entry.x !== null && entry.y !== null);
  const outer = metrics.map((_metric, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / metrics.length;
    return `${center + Math.cos(angle) * radius},${center + Math.sin(angle) * radius}`;
  }).join(" ");
  return (
    <div className="gantt-radar-layout">
      <svg className="gantt-radar" viewBox="0 0 220 220" role="img" aria-label="Model 五维正式分">
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
        {completePolygon ? <polygon points={points.map((entry) => `${entry.x},${entry.y}`).join(" ")} className="radar-value" /> : null}
        {points.map((entry) => (
          <g key={entry.axisId}>
            {entry.x !== null && entry.y !== null ? <circle cx={entry.x} cy={entry.y} r="3.5" className="radar-dot" /> : null}
            <text x={entry.labelX} y={entry.labelY} textAnchor="middle" dominantBaseline="middle">
              {axisName(entry.axisId)}
            </text>
          </g>
        ))}
      </svg>
      <div className="gantt-metric-table gantt-metric-table-v3">
        {metrics.map((metric) => {
          const status = metric.displayScore === null
            ? "missing"
            : Object.values(metric.componentRawValues).every((value) => value === null)
              ? "not_applicable"
              : "direct";
          const overflow = metric.unclampedModelRatio === null
            ? null
            : Math.max(0, metric.unclampedModelRatio - 1);
          return (
            <details key={metric.axisId}>
              <summary>
                <span><strong>{axisName(metric.axisId)}</strong><small>{status}</small></span>
                <b>{metric.displayScore ?? "不可用"}</b>
              </summary>
              <dl>
                <div><dt>原始值</dt><dd>{JSON.stringify(metric.componentRawValues)}</dd></div>
                <div><dt>部件比值</dt><dd>{JSON.stringify(metric.componentRatios)}</dd></div>
                <div><dt>未截断比值</dt><dd>{metric.unclampedModelRatio ?? "—"}</dd></div>
                <div><dt>正式分</dt><dd>{metric.displayScore ?? "—"}</dd></div>
                <div><dt>overflow</dt><dd>{overflow ?? "—"}</dd></div>
                <div><dt>状态</dt><dd>{status}</dd></div>
              </dl>
              <div className="gantt-axis-trace">
                {metric.trace.map((entry, index) => <span key={`${entry.step}:${index}`}><b>{entry.step}</b>{entry.message}</span>)}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

const COMPARISON_COLORS = ["#16836f", "#4d6fd1", "#8a5ec4", "#d27a23", "#be4f5f"];

function FiveAxisComparisonPanel({
  view,
  definition,
}: {
  view: FiveAxisComparisonView;
  definition?: FiveAxisViewDefinition;
}) {
  const axes = definition?.axes ?? [];
  const numericScores = view.series.flatMap((entry) => entry.points.flatMap((point) =>
    point.comparisonScore === null ? [] : [point.comparisonScore]));
  const maxScore = view.scaleMode === "comparison_expanded"
    ? Math.max(100, ...numericScores)
    : 100;
  const center = 110;
  const radius = 80;
  const pointFor = (score: number, index: number) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(axes.length, 1);
    const ratio = fiveAxisPlotRatio(score, maxScore) ?? 0;
    return `${center + Math.cos(angle) * radius * ratio},${center + Math.sin(angle) * radius * ratio}`;
  };
  const outer = axes.map((_axis, index) => pointFor(maxScore, index)).join(" ");
  return (
    <div className="same-part-comparison-result">
      <div className="same-part-comparison-chart">
        <svg viewBox="0 0 220 220" role="img" aria-label="同部位五维叠加比较">
          <polygon points={outer} className="radar-grid" />
          {view.series.map((entry, seriesIndex) => {
            const color = COMPARISON_COLORS[seriesIndex % COMPARISON_COLORS.length];
            const points = axes.map((axis, axisIndex) => {
              const point = entry.points.find((candidate) => candidate.axisId === axis.axisId);
              return point?.comparisonScore === null || point?.comparisonScore === undefined
                ? null
                : pointFor(point.comparisonScore, axisIndex);
            });
            const complete = points.every((point): point is string => point !== null);
            return (
              <g key={entry.entityId}>
                {complete ? <polygon points={points.join(" ")} fill={`${color}22`} stroke={color} strokeWidth="2" /> : null}
                {points.map((point, pointIndex) => {
                  if (!point) return null;
                  const [cx, cy] = point.split(",");
                  return <circle key={`${entry.entityId}:${axes[pointIndex]?.axisId}`} cx={cx} cy={cy} r="3" fill={color} />;
                })}
              </g>
            );
          })}
          {axes.map((axis, index) => {
            const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(axes.length, 1);
            return <text key={axis.axisId} x={center + Math.cos(angle) * (radius + 22)} y={center + Math.sin(angle) * (radius + 22)} textAnchor="middle" dominantBaseline="middle">{axis.label}</text>;
          })}
        </svg>
        <div className="same-part-legend">
          {view.series.map((entry, index) => <span key={entry.entityId}><i style={{ background: COMPARISON_COLORS[index % COMPARISON_COLORS.length] }} />{entry.label}</span>)}
        </div>
      </div>
      <div className="same-part-difference-table">
        {axes.map((axis) => {
          const summary = view.axisSummaries.find((entry) => entry.axisId === axis.axisId);
          return (
            <details key={axis.axisId}>
              <summary><strong>{axis.label}</strong><span>跨度 {summary?.spread === null || summary?.spread === undefined ? "—" : (summary.spread * 100).toFixed(1)}</span></summary>
              {view.series.map((entry) => {
                const point = entry.points.find((candidate) => candidate.axisId === axis.axisId);
                return <div key={entry.entityId}><span>{entry.label}</span><b>{point?.source === "not_applicable" ? "不适用" : point?.comparisonScore?.toFixed(1) ?? "不可用"}</b><small>{point?.source}{point?.overflow ? ` · +${point.overflow.toFixed(1)}%` : ""}</small></div>;
              })}
            </details>
          );
        })}
      </div>
    </div>
  );
}

function componentEntityInput(model: PurchasableModel, itemPartId: string, fishWeightGradeId: string): FiveAxisEntityInput | undefined {
  const component = model.componentSelections.find((entry) => entry.itemPartId === itemPartId);
  if (!component) return undefined;
  return {
    entityId: `${model.id}:${component.componentId}`,
    itemPartId,
    label: `${model.name} · ${component.name}`,
    fishWeightGradeId,
    revision: model.revision,
    values: Object.fromEntries(Object.entries(component.values).map(([key, value]) => [key, typeof value === "number" ? value : null])),
  };
}

function ModelDrawer({
  state,
  workspaceId,
  model,
  sku,
  series,
  snapshot,
  comparisonModelIds,
  currentEntityType,
  rebaseEnabled,
  rebaseDisabledReason,
  onOpenRebase,
  onToggleCompare,
  onOpenSnapshot,
  onClose,
}: {
  state: WorkspaceState;
  workspaceId: string;
  model: PurchasableModel;
  sku?: SkuDrawer;
  series?: SeriesDefinition;
  snapshot?: ConfigurationSnapshot;
  comparisonModelIds: string[];
  currentEntityType: "model" | "configuration_snapshot";
  rebaseEnabled: boolean;
  rebaseDisabledReason?: string;
  onOpenRebase: () => void;
  onToggleCompare: (modelId: string) => void;
  onOpenSnapshot: (snapshotId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DrawerTab>("overview");
  const [mode, setMode] = useState<FiveAxisMode>("model_series");
  const [comparisonPartId, setComparisonPartId] = useState("part:rod");
  const [comparisonScaleMode, setComparisonScaleMode] = useState<FiveAxisComparisonView["scaleMode"]>("official_locked");
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const draftFiveAxisPreview = useMemo(() => {
    if (snapshot?.fiveAxisPreview || !model.fishWeightGradeId) return undefined;
    const draftDefinition = state.fiveAxisViewDefinitions[0];
    if (!draftDefinition) return undefined;
    const vertexSet = state.fiveAxisVertexSets.find((entry) =>
      entry.fishWeightGradeId === model.fishWeightGradeId &&
      entry.definitionId === draftDefinition.definitionId &&
      entry.definitionVersion === draftDefinition.version);
    if (!vertexSet) return undefined;
    return calculateModelFiveAxisPreview({
      modelId: model.id,
      modelRevision: model.revision,
      referenceFishWeightGradeId: model.fishWeightGradeId,
      definition: draftDefinition,
      vertexSet,
      components: model.componentSelections.map((component) => ({
        entityId: component.componentId,
        itemPartId: component.itemPartId,
        label: component.name,
        fishWeightGradeId: model.fishWeightGradeId!,
        revision: model.revision,
        values: Object.fromEntries(Object.entries(component.values).map(([key, value]) => [
          key,
          typeof value === "number" ? value : null,
        ])),
      })),
      finalPanelHash: deterministicHash(model.componentSelections),
    });
  }, [model, snapshot, state.fiveAxisVertexSets, state.fiveAxisViewDefinitions]);
  const activeFiveAxisPreview = snapshot?.fiveAxisPreview ?? draftFiveAxisPreview;
  const definition = activeFiveAxisPreview
    ? state.fiveAxisViewDefinitions.find((entry) =>
      entry.definitionId === activeFiveAxisPreview.fiveAxisDefinitionId &&
      entry.version === activeFiveAxisPreview.fiveAxisDefinitionVersion)
    : undefined;
  const breadcrumbs = buildProductBreadcrumbs({
    workspaceId,
    collection: series?.collectionId
      ? state.collections.find((entry) => entry.id === series.collectionId)
      : undefined,
    series,
    sku,
    model,
    snapshot,
    currentEntityType,
  });

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex='-1'])",
      )).filter((entry) => !entry.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  const traceItems = snapshot?.attributeTrace
    .flatMap((step) => step.contributions.map((contribution) => ({
      ...contribution,
      layer: step.layer,
    })))
    .sort((left, right) => left.sequence - right.sequence) ?? [];
  const inComparison = comparisonModelIds.includes(model.id);
  const pendingUpgrade = state.upgradeCandidates.find((entry) => entry.modelId === model.id && entry.status === "pending");
  const comparisonResult = useMemo(() => {
    if (comparisonModelIds.length < 2 || !definition || !activeFiveAxisPreview) return {};
    const vertexSet = state.fiveAxisVertexSets.find((entry) =>
      entry.vertexSetHash === activeFiveAxisPreview.vertexSetHash &&
      entry.definitionId === definition.definitionId &&
      entry.definitionVersion === definition.version);
    if (!vertexSet) return { error: "当前比较缺少与冻结预览一致的顶点集合。" };
    const entities = comparisonModelIds.flatMap((modelId) => {
      const candidate = state.purchasableModels.find((entry) => entry.id === modelId);
      const entity = candidate
        ? componentEntityInput(candidate, comparisonPartId, activeFiveAxisPreview.fishWeightGradeId)
        : undefined;
      return entity ? [entity] : [];
    });
    if (entities.length !== comparisonModelIds.length) return { error: "比较组中有 Model 缺少所选部位；不会以 0 补齐。" };
    const referenceContext = comparisonPartId === "part:rod"
      ? undefined
      : componentEntityInput(model, "part:rod", activeFiveAxisPreview.fishWeightGradeId);
    try {
      return { view: buildSamePartComparison({
        referenceFishWeightGradeId: activeFiveAxisPreview.fishWeightGradeId,
        definition,
        vertexSet,
        entities,
        referenceContext,
        comparisonLimit: 5,
        scaleMode: comparisonScaleMode,
      }) };
    } catch (caught) {
      return { error: caught instanceof Error ? caught.message : "同部位比较失败。" };
    }
  }, [activeFiveAxisPreview, comparisonModelIds, comparisonPartId, comparisonScaleMode, definition, model, state.fiveAxisVertexSets, state.purchasableModels]);
  return (
    <aside
      ref={drawerRef}
      className="gantt-model-drawer gantt-model-drawer-v3"
      aria-label="Model 预览"
      aria-modal="true"
      role="dialog"
    >
      <header>
        <div>
          <span className="eyebrow">MODEL · 实际选择 / 购买对象</span>
          <h2>{model.name}</h2>
          <p>{model.id} · revision {model.revision}{sku ? ` · ${sku.targetWeightKg} kgf SKU 抽屉` : " · 父级不可见"}</p>
        </div>
        <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="关闭 Model 预览"><X size={18} /></button>
      </header>
      <nav className="gantt-entity-breadcrumbs" aria-label="对象父链">
        {breadcrumbs.map((item, index) => (
          <span key={`${item.ref.entityType}:${item.ref.entityId}`} className={item.current ? "current" : item.unavailableReason ? "unavailable" : ""} title={item.unavailableReason ?? `${item.ref.entityId} · revision ${item.ref.revisionId}`}>
            {index ? <ChevronRight size={13} aria-hidden="true" /> : null}
            <button
              type="button"
              disabled={!item.navigable}
              aria-current={item.current ? "page" : undefined}
              onClick={() => {
                if (item.ref.entityType === "configuration_snapshot") {
                  setTab("trace");
                  onOpenSnapshot(item.ref.entityId);
                }
                else if (item.ref.entityType === "series") onOpenRebase();
                else onClose();
              }}
            >
              <small>{item.objectLabel}</small>
              <strong>{item.label}</strong>
            </button>
          </span>
        ))}
      </nav>
      <div className="gantt-drawer-tabs">
        <button type="button" className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><b>1</b> 常用概览</button>
        <button type="button" className={tab === "five_axis" ? "active" : ""} onClick={() => setTab("five_axis")}><b>2</b> 五维与适配</button>
        <button type="button" className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}><b>3</b> 来源与版本</button>
        <button type="button" className={tab === "rebase" ? "active" : ""} onClick={() => setTab("rebase")}>Patch / Rebase{pendingUpgrade ? " · 1" : ""}</button>
        <button type="button" className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")}>AI评估与建议</button>
      </div>

      {tab === "overview" || tab === "five_axis" ? (
        <div className="gantt-drawer-body">
          <div className="gantt-preview-layer-intro">
            <span>{tab === "overview" ? "第 1 层 · 先看对象与发布风险" : "第 2 层 · 再看五维表现与适配依据"}</span>
            <small>{tab === "overview" ? "默认只展示策划最常用的信息；完整计算在第 3 层。" : "图形用于比较，硬兼容结论仍由确定性规则单独裁决。"}</small>
          </div>
          <div className="gantt-identity-grid">
            <div><span>Series</span><strong>{series?.name ?? "不可见对象"}</strong><small>{series ? `${series.id} · rev ${series.revision}` : "名称、状态和数量不披露"}</small></div>
            <div><span>SKU 抽屉</span><strong>{sku ? `${sku.targetWeightKg} kgf` : "不可见对象"}</strong><small>{sku ? `${sku.id} · rev ${sku.revision}` : `${model.skuId} · revision unavailable`}</small></div>
            <div><span>Model</span><strong>{model.id}</strong><small>rev {model.revision}</small></div>
            <div><span>ConfigurationSnapshot</span><strong>{snapshot?.id ?? "尚未发布"}</strong><small>{snapshot ? `v${snapshot.version} · ${snapshot.contentHash.slice(0, 10)}` : "没有冻结内容"}</small></div>
          </div>
          <div className={tab === "overview" ? "gantt-quick-facts" : "gantt-layer-hidden"} aria-label="Model 常用要素">
            <div><span>目标拉力</span><strong>{sku ? `${sku.targetWeightKg} kgf` : "不可见"}</strong><small>离散 SKU 规格</small></div>
            <div><span>调性 / 硬度</span><strong>{model.action} / {model.hardness}</strong><small>Model 专属配置</small></div>
            <div><span>长度</span><strong>{model.lengthM} m</strong><small>实际购买型号</small></div>
            <div><span>当前发布面</span><strong>{snapshot ? "已发布 · 已冻结" : "草稿 · 可调整"}</strong><small>{pendingUpgrade ? "另有升级候选" : "旧快照不会被重算"}</small></div>
          </div>
          <section className={tab === "five_axis" ? "" : "gantt-layer-hidden"}>
            <div className="gantt-section-title">
              <div><span className="eyebrow">FIVE AXIS</span><h3>可配置五维图</h3></div>
              <span className="gantt-readonly">
                <LockKeyhole size={13} />
                {snapshot ? "冻结快照" : "草稿定义 · OPEN-005"}
              </span>
            </div>
            <div className="five-axis-mode-tabs">
              <button type="button" className={mode === "model_series" ? "active" : ""} onClick={() => setMode("model_series")}>Model / Series</button>
              <button type="button" className={mode === "tackle_fit" ? "active" : ""} onClick={() => setMode("tackle_fit")}>竿轮线匹配</button>
              <button type="button" className={mode === "same_part" ? "active" : ""} onClick={() => setMode("same_part")}>同部位比较</button>
            </div>
            {activeFiveAxisPreview ? (
              <div className="five-axis-metadata">
                <span>definition {activeFiveAxisPreview.fiveAxisDefinitionId}@{activeFiveAxisPreview.fiveAxisDefinitionVersion}</span>
                <span>rule {activeFiveAxisPreview.fiveAxisRuleVersion}</span>
                <span>鱼重基准 {activeFiveAxisPreview.fishWeightGradeId}</span>
                <span>vertex {activeFiveAxisPreview.vertexSetHash.slice(0, 10)}</span>
              </div>
            ) : null}
            {mode === "model_series" && activeFiveAxisPreview ? (
              <>
                <FiveAxisRadar preview={activeFiveAxisPreview} definition={definition} />
                <div className="gantt-baseline-note"><Info size={16} /><span><strong>Series 基准策略：{definition?.seriesBaselinePolicy.mode ?? "未发布"}</strong>当前原型未返回可用 baselineRef，因此只绘制 Model，不会静默换用默认 Model。</span></div>
              </>
            ) : null}
            {mode === "model_series" && !activeFiveAxisPreview ? <div className="gantt-unavailable"><Info size={18} /><div><strong>五维预览不可计算</strong><span>需要显式 fishWeightGradeId、已发布定义和匹配顶点；不会按 SKU 拉力猜测或补 0。</span></div></div> : null}
            {mode === "tackle_fit" ? (
              activeFiveAxisPreview?.tackleFitComparison.series.length
                ? <FiveAxisComparisonPanel view={activeFiveAxisPreview.tackleFitComparison} definition={definition} />
                : <div className="gantt-unavailable"><Info size={18} /><div><strong>无匹配比较数据</strong><span>缺失、继承与不适用不会绘制为 0。</span></div></div>
            ) : null}
            {mode === "same_part" ? (
              <div className="same-part-basket">
                <div><strong>同部位比较篮</strong><span>{comparisonModelIds.length} / 5</span></div>
                <p>
                  所有对象使用当前 Model 的共同鱼重等级、定义和 vertex；不同部位不会混入同一比较组。
                  {snapshot ? "冻结快照保持不可变。" : "草稿结果仅供试算，发布后才会冻结。"}
                </p>
                <div className="same-part-controls">
                  <label>比较部位<select value={comparisonPartId} onChange={(event) => setComparisonPartId(event.target.value)}><option value="part:rod">竿</option><option value="part:reel">轮</option><option value="part:line">线</option></select></label>
                  <label>绘图刻度<select value={comparisonScaleMode} onChange={(event) => setComparisonScaleMode(event.target.value as FiveAxisComparisonView["scaleMode"])}><option value="official_locked">正式 0–100</option><option value="comparison_expanded">展开超顶点</option></select></label>
                </div>
                <button type="button" onClick={() => onToggleCompare(model.id)}>{inComparison ? "移出比较" : "加入比较"}</button>
                {comparisonModelIds.length < 2 ? <small>至少加入 2 个同部位 Model 后显示比较曲线。</small> : <small>已选择：{comparisonModelIds.join("、")}</small>}
                {comparisonResult.error ? <div className="gantt-unavailable"><AlertTriangle size={18} /><div><strong>比较不可用</strong><span>{comparisonResult.error}</span></div></div> : null}
                {comparisonResult.view ? <FiveAxisComparisonPanel view={comparisonResult.view} definition={definition} /> : null}
              </div>
            ) : null}
          </section>
          <section className={tab === "overview" ? "" : "gantt-layer-hidden"}>
            <div className="gantt-section-title">
              <div><span className="eyebrow">QUALITY & PRICING</span><h3>品质校验与价格试算</h3></div>
              <span className={snapshot?.qualityValueAssessment?.formal && snapshot?.automaticPricing?.formal ? "gantt-readonly" : "rule-badge warning"}>
                {snapshot?.qualityValueAssessment?.formal && snapshot?.automaticPricing?.formal ? "FORMAL" : "NON_FORMAL"}
              </span>
            </div>
            <div className="gantt-identity-grid">
              <div><span>所选品质</span><strong>{snapshot?.qualityValueAssessment?.selectedQualityId ?? snapshot?.qualityReport.qualityId ?? "待选择"}</strong><small>系统不会按分数自动改品质</small></div>
              <div><span>基础词条分</span><strong>{snapshot?.qualityValueAssessment?.baseAffixScore ?? snapshot?.qualityReport.totalScore ?? "—"}</strong><small>Technology 成员按 affixId 去重</small></div>
              <div><span>组合分</span><strong>{snapshot?.qualityValueAssessment?.combinationScore ?? "未冻结"}</strong><small>仅同部位无序词条对</small></div>
              <div><span>功能 / 性能系数</span><strong>{snapshot?.qualityValueAssessment ? `${snapshot.qualityValueAssessment.functionScoreFactor} / ${snapshot.qualityValueAssessment.performanceScoreFactor ?? "缺失"}` : "未冻结"}</strong><small>缺性能来源不默认为 1</small></div>
              <div><span>最终分 / 品质命中</span><strong>{snapshot?.qualityValueAssessment?.finalValueScore ?? snapshot?.qualityReport.totalScore ?? "—"}</strong><small>{snapshot?.qualityValueAssessment ? (snapshot.qualityValueAssessment.inSelectedQualityRange ? "命中所选区间" : "未命中 · 发布阻断") : "旧快照未绑定版本化区间"}</small></div>
              <div><span>价格试算</span><strong>{snapshot?.automaticPricing?.purchasePrice ?? "不可用"}</strong><small>{snapshot?.automaticPricing?.formal ? snapshot.automaticPricing.moneyUnit : "NON_FORMAL · 不写 Store"}</small></div>
            </div>
            {!snapshot?.qualityValueAssessment?.formal || !snapshot?.automaticPricing?.formal ? (
              <div className="gantt-unavailable"><AlertTriangle size={18} /><div><strong>仅非正式预览</strong><span>请到规则工作簿查看来源单元格 Trace，修复源冲突并显式重新拉取；不提供自动改品质、忽略冲突或手填价格兜底。</span></div></div>
            ) : null}
          </section>
          <section className={tab === "overview" ? "" : "gantt-layer-hidden"}>
            <div className="gantt-section-title"><div><span className="eyebrow">FOUR SEMANTICS</span><h3>独立裁决区块</h3></div></div>
            <div className="gantt-guardrails gantt-four-semantics">
              <div><ShieldCheck size={16} /><span>硬兼容</span><strong>{snapshot?.compatibilityReport.allowed ? "通过" : snapshot ? "有阻断" : "待校验"}</strong></div>
              <div><Scale size={16} /><span>Affinity</span><strong>{snapshot ? snapshot.affinityReport.score.toFixed(1) : "—"}</strong></div>
              <div><CircleDot size={16} /><span>Series 不变量</span><strong>{sku ? (sku.validationSummary.some((issue) => issue.level === "error") ? "有阻断" : "通过") : "不可验证"}</strong></div>
              <div><Bot size={16} /><span>AI 建议</span><strong>未启用</strong></div>
            </div>
          </section>
        </div>
      ) : null}

      {tab === "trace" ? (
        <div className="gantt-drawer-body">
          <div className="gantt-ai-guardrail"><LockKeyhole size={18} /><strong>Snapshot Trace 只读 · 按 sequence 重放</strong></div>
          <div className="model-trace-table">
            <div className="model-trace-head"><span>#</span><span>层</span><span>属性</span><span>来源</span><span>before</span><span>operation</span><span>operand</span><span>after</span></div>
            {traceItems.map((entry) => (
              <div key={`${entry.sequence}:${entry.ruleId}:${entry.parameterKey}`}>
                <span>{entry.sequence}</span><span>{entry.layer}</span><span>{entry.parameterKey}</span><span>{entry.sourceName}<small>{entry.sourceId}</small></span>
                <span>{String(entry.before ?? "—")}</span><span>{entry.operation}</span><span>{String(entry.operand)}</span><span>{String(entry.after ?? "—")}</span>
              </div>
            ))}
            {!traceItems.length ? <div className="gantt-unavailable"><Info size={18} /><div><strong>没有冻结 Trace</strong><span>不会从页面状态伪造来源或 +0 贡献。</span></div></div> : null}
          </div>
        </div>
      ) : null}

      {tab === "rebase" ? (
        <div className="gantt-drawer-body">
          <div className="gantt-ai-guardrail"><Scale size={18} /><strong>Patch 重放与 Snapshot 冻结语义分离</strong></div>
          {pendingUpgrade ? (
            <section className="rebase-review-panel">
              <div className="gantt-section-title">
                <div><span className="eyebrow">THREE-WAY REBASE</span><h3>{pendingUpgrade.patchRebasePreview.requiresReview ? "需要人工复核" : "可重放升级"}</h3></div>
                <span className="gantt-readonly"><LockKeyhole size={13} />旧 Snapshot 不变</span>
              </div>
              <div className="rebase-version-chain">
                <span><small>旧 Projection</small><strong>{pendingUpgrade.patchRebasePreview.oldProjectionId}</strong><em>{pendingUpgrade.patchRebasePreview.oldRuleSetVersion}</em></span>
                <ChevronRight size={18} />
                <span><small>新 Projection</small><strong>{pendingUpgrade.patchRebasePreview.newProjectionId}</strong><em>{pendingUpgrade.patchRebasePreview.newRuleSetVersion}</em></span>
              </div>
              <div className="rebase-difference-table">
                <div className="rebase-difference-head"><span>属性</span><span>旧基础</span><span>新基础</span><span>Patch 旧结果</span><span>预计新结果</span></div>
                {pendingUpgrade.patchRebasePreview.differences.map((difference) => (
                  <div key={difference.path}>
                    <strong>{difference.path}</strong>
                    <del>{String(difference.oldBase ?? "—")}</del>
                    <span>{String(difference.newBase ?? "—")}</span>
                    <span>{String(difference.oldResult ?? "—")}</span>
                    <ins>{String(difference.newResult ?? "—")}</ins>
                  </div>
                ))}
              </div>
              {pendingUpgrade.patchRebasePreview.issues.map((issue, index) => <div className="rebase-issue" key={`${issue.patchId}:${issue.path}:${index}`}><AlertTriangle size={15} /><span><strong>{issue.code}</strong>{issue.message}</span></div>)}
              <button type="button" className="v3-primary-action" disabled={!rebaseEnabled} title={rebaseDisabledReason} onClick={onOpenRebase}>在 V3 制造链处理 Rebase <ChevronRight size={15} /></button>
            </section>
          ) : (
            <div className="gantt-unavailable"><Info size={18} /><div><strong>没有待处理 Rebase</strong><span>上游变化只生成 UpgradeCandidate，不会静默改写已发布 ConfigurationSnapshot。</span></div></div>
          )}
        </div>
      ) : null}

      {tab === "ai" ? (
        <div className="gantt-drawer-body">
          <div className="gantt-ai-guardrail"><ShieldCheck size={18} /><strong>辅助建议 · 不影响系统校验</strong></div>
          <div className="gantt-ai-disabled">
            <Bot size={28} />
            <h3>AI 服务尚未启用</h3>
            <p>OPEN-006 的供应方、模型、字段白名单和数据出网策略尚未确认。当前不展示 mock 建议，也不会创建或应用 Patch。</p>
            <dl>
              <div><dt>服务状态</dt><dd>一期禁用</dd></div>
              <div><dt>允许出网字段</dt><dd>未确认</dd></div>
              <div><dt>草稿能力</dt><dd>契约已就绪，运行连接器未启用</dd></div>
            </dl>
            <div className="gantt-ai-actions">
              <button type="button" disabled title="OPEN-006 尚未确认">查看依据</button>
              <button type="button" disabled title="OPEN-006 尚未确认">预览变化</button>
              <button type="button" disabled title="OPEN-006 尚未确认">创建 Model Patch 草稿</button>
              <button type="button" disabled title="OPEN-006 尚未确认">重新评估</button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

export function SeriesGanttWorkbenchV3({
  state,
  workspaceId,
  actionAvailabilities,
  notify,
  actor,
  mutate,
  onWorkspaceApplied,
  onOpenSeries,
  onBreadcrumbsChange,
}: SeriesGanttWorkbenchV3Props) {
  const [query, setQuery] = useState<SeriesGanttQuery>(initialQuery);
  const [selectedSeriesId, setSelectedSeriesId] = useState(() => initialSelection("series"));
  const [selectedSkuId, setSelectedSkuId] = useState(() => initialSelection("sku"));
  const [drawerModelId, setDrawerModelId] = useState(() => initialSelection("model"));
  const [drawerSnapshotId, setDrawerSnapshotId] = useState(() => initialSelection("snapshot"));
  const [modelCursor, setModelCursor] = useState(12);
  const [comparisonModelIds, setComparisonModelIds] = useState<string[]>([]);
  const [candidateOpen, setCandidateOpen] = useState(false);
  const [seriesCreateDraft, setSeriesCreateDraft] = useState<SeriesCreateDraft | null>(null);
  const enabledItemParts = useMemo(
    () => enabledProductItemParts(state.itemParts),
    [state.itemParts],
  );

  const blocks = useMemo(() => querySeriesGantt({
    query,
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    models: state.purchasableModels,
    itemTypes: state.itemTypeProfiles,
    upgrades: state.upgradeCandidates,
  }), [query, state]);
  const filterCatalog = useMemo(() => querySeriesGantt({
    query: { sort: "quality_type" },
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    models: state.purchasableModels,
    itemTypes: state.itemTypeProfiles,
    upgrades: state.upgradeCandidates,
  }), [state]);
  const visibleSeriesIds = useMemo(() => new Set(blocks.map((block) => block.seriesId)), [blocks]);
  const selectedSeries = state.seriesDefinitions.find((series) =>
    series.id === selectedSeriesId && visibleSeriesIds.has(series.id))
    ?? state.seriesDefinitions.find((series) => series.id === blocks[0]?.seriesId);
  const selectedBlock = blocks.find((block) => block.seriesId === selectedSeries?.id);
  const seriesSkus = selectedSeries
    ? state.skuDrawers.filter((sku) =>
      sku.seriesId === selectedSeries.id
      && isProductItemPartEnabled(sku.projectionMatch.itemPartId)
      && sku.projectionMatch.itemPartId === seriesItemPartId(selectedSeries, state.skuDrawers))
      .sort((left, right) => left.targetWeightKg - right.targetWeightKg || left.id.localeCompare(right.id))
    : [];
  const selectedSku = seriesSkus.find((sku) => sku.id === selectedSkuId) ?? seriesSkus[0];
  const models = selectedSku
    ? state.purchasableModels.filter((model) => selectedSku.modelIds.includes(model.id))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    : [];
  const visibleModels = models.slice(0, modelCursor);
  const deepLink = useMemo(() => resolveProductDeepLink({
    workspaceId,
    requested: {
      seriesId: selectedSeriesId || undefined,
      skuId: selectedSkuId || undefined,
      modelId: drawerModelId || undefined,
      snapshotId: drawerSnapshotId || undefined,
    },
    collections: state.collections,
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
    models: state.purchasableModels,
    snapshots: state.configurationSnapshots,
  }), [drawerModelId, drawerSnapshotId, selectedSeriesId, selectedSkuId, state.collections, state.configurationSnapshots, state.purchasableModels, state.seriesDefinitions, state.skuDrawers, workspaceId]);
  const drawerModel = drawerModelId || drawerSnapshotId ? deepLink.model : undefined;
  const drawerSku = drawerModel ? deepLink.sku : undefined;
  const drawerSeries = drawerModel ? deepLink.series : undefined;
  const drawerSnapshot = deepLink.snapshot?.modelId === drawerModel?.id
    ? deepLink.snapshot
    : drawerModel?.configurationSnapshotId
      ? state.configurationSnapshots.find((snapshot) => snapshot.id === drawerModel.configurationSnapshotId)
      : undefined;
  const typeIds = useMemo(
    () => [...new Set(blocks.map((block) => block.typeId))].sort(),
    [blocks],
  );
  const weights = useMemo(
    () => [...new Set(filterCatalog.flatMap((block) => block.skuNodes.map((node) => node.targetWeightKg)))]
      .sort((left, right) => left - right),
    [filterCatalog],
  );
  const issueCodes = useMemo(
    () => [...new Set(filterCatalog.flatMap((block) => block.aggregate.issueCodes))].sort(),
    [filterCatalog],
  );
  const ruleSetVersions = useMemo(
    () => [...new Set(filterCatalog.flatMap((block) => block.aggregate.ruleSetVersions))].sort(),
    [filterCatalog],
  );
  const generateAvailability = actionAvailabilities.generate_candidates;
  const openSeriesAvailability = actionAvailabilities.open_series;
  const previewModelAvailability = actionAvailabilities.preview_model;
  const rebaseAvailability = actionAvailabilities.open_rebase;
  const createSeriesAvailability = actionAvailabilities.create_series;
  const contextBreadcrumbs = buildProductBreadcrumbs({
    workspaceId,
    collection: drawerSeries?.collectionId
      ? state.collections.find((entry) => entry.id === drawerSeries.collectionId)
      : selectedSeries?.collectionId
        ? state.collections.find((entry) => entry.id === selectedSeries.collectionId)
        : undefined,
    series: drawerSeries ?? selectedSeries,
    sku: drawerModel ? drawerSku : selectedSku,
    model: drawerModel,
    snapshot: drawerSnapshotId ? drawerSnapshot : undefined,
    currentEntityType: drawerSnapshotId
      ? "configuration_snapshot"
      : drawerModel
        ? "model"
        : selectedSku
          ? "sku_drawer"
          : "series",
  });
  const contextBreadcrumbSignature = JSON.stringify(contextBreadcrumbs);
  const emittedBreadcrumbSignature = useRef("");

  useEffect(() => {
    if (emittedBreadcrumbSignature.current === contextBreadcrumbSignature) return;
    emittedBreadcrumbSignature.current = contextBreadcrumbSignature;
    onBreadcrumbsChange?.(contextBreadcrumbs);
  }, [contextBreadcrumbSignature, contextBreadcrumbs, onBreadcrumbsChange]);

  useEffect(() => {
    updateLocation(query, {
      seriesId: selectedSeries?.id,
      skuId: selectedSku?.id,
      modelId: drawerModel?.id,
      snapshotId: drawerSnapshotId || undefined,
    });
  }, [drawerModel?.id, drawerSnapshotId, query, selectedSeries?.id, selectedSku?.id]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (deepLink.unavailableRequestedRef?.entityType === "configuration_snapshot") {
        setDrawerSnapshotId("");
        notify("请求的冻结快照不可见或已不存在，已退回最近可见对象。");
        return;
      }
      if (deepLink.unavailableRequestedRef?.entityType === "model") {
        setDrawerModelId("");
        if (deepLink.series) setSelectedSeriesId(deepLink.series.id);
        if (deepLink.sku) setSelectedSkuId(deepLink.sku.id);
        notify("请求的 Model 不可见或已不存在，已退回最近可见父级。");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [deepLink, notify]);

  useEffect(() => {
    const key = "tackle-forger:series-gantt-scroll";
    const stored = Number(window.sessionStorage.getItem(key) ?? 0);
    const frame = window.requestAnimationFrame(() => window.scrollTo({ top: stored }));
    const remember = () => window.sessionStorage.setItem(key, String(window.scrollY));
    window.addEventListener("scroll", remember, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      remember();
      window.removeEventListener("scroll", remember);
    };
  }, []);

  const selectSeries = (seriesId: string) => {
    setModelCursor(12);
    setSelectedSeriesId(seriesId);
    setSelectedSkuId("");
  };
  const selectSku = (seriesId: string, skuId: string) => {
    setModelCursor(12);
    setSelectedSeriesId(seriesId);
    setSelectedSkuId(skuId);
  };
  const toggleCompare = (modelId: string) => {
    setComparisonModelIds((current) => {
      if (current.includes(modelId)) return current.filter((id) => id !== modelId);
      if (current.length >= 5) {
        notify("同部位比较篮上限为 5 个 Model。");
        return current;
      }
      return [...current, modelId];
    });
  };

  const openCreateSeries = () => {
    const method = state.methodProfiles.find((entry) => entry.enabled);
    const itemPart = enabledItemParts[0];
    const type = state.itemTypeProfiles.find((entry) =>
      entry.enabled && (!method || entry.methodIds.includes(method.id)) &&
      (!itemPart || entry.itemPartIds.includes(itemPart.id)));
    const fn = state.functionProfiles.find((entry) => entry.enabled);
    setSeriesCreateDraft({
      seriesId: `series:${crypto.randomUUID()}`,
      name: "",
      concept: "",
      collectionId: "",
      itemPartId: itemPart?.id ?? "part:rod",
      methodId: method?.id ?? "",
      typeId: type?.id ?? "",
      functionId: fn?.id ?? "",
      qualityId: "quality_c_green",
      performanceId: "",
      functionIntensity: 2,
      planningMinKgf: "",
      planningMaxKgf: "",
      discretePulls: "1.5, 3.8, 8.2",
    });
  };

  const createSeries = async () => {
    const draft = seriesCreateDraft;
    if (!draft || !createSeriesAvailability.enabled) return;
    if (!draft.name.trim() || !draft.concept.trim()) {
      notify("请填写 Series 名称与概念说明。");
      return;
    }
    if (!draft.itemPartId || !draft.methodId || !draft.typeId || !draft.functionId) {
      notify("请选择部位、钓法、类型和功能定位。");
      return;
    }
    if (!parseDiscretePulls(draft.discretePulls).length) {
      notify("请至少填写一个正数目标拉力规格；范围本身不能生成 SKU。");
      return;
    }
    // Series 创建是服务端领域命令：写入由服务端重新鉴权 series.edit（create_series），
    // 结构标杆匹配、拉力规划与 SKU 物化都在服务端完成后按 revision 受保护地提交，
    // 客户端不能绕过 series.edit 直接写整包（规范 §24.1/§24.4/§25.1）。
    try {
      const response = await fetch("/api/series", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `create-series:${draft.seriesId}`,
          seriesId: draft.seriesId,
          name: draft.name,
          concept: draft.concept,
          collectionId: draft.collectionId || undefined,
          itemPartId: draft.itemPartId,
          methodId: draft.methodId,
          typeId: draft.typeId,
          functionId: draft.functionId,
          qualityId: draft.qualityId,
          performanceId: draft.performanceId || undefined,
          functionIntensity: draft.functionIntensity,
          planningMinKgf: draft.planningMinKgf,
          planningMaxKgf: draft.planningMaxKgf,
          discretePulls: draft.discretePulls,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        state?: WorkspaceState;
        series?: { id: string; name: string };
        createdSkuIds?: string[];
        revision?: number;
        error?: string;
      } | null;
      if (!response.ok || !payload?.state || !payload.series) {
        notify(payload?.error ?? "Series 创建失败。");
        return;
      }
      onWorkspaceApplied(
        payload.state,
        payload.revision ?? 0,
        `已创建 ${payload.series.name}，并物化 ${payload.createdSkuIds?.length ?? 0} 个离散 SKU 抽屉。`,
      );
      setSelectedSeriesId(payload.series.id);
      setSelectedSkuId(payload.createdSkuIds?.[0] ?? "");
      setSeriesCreateDraft(null);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Series 创建失败。");
    }
  };

  const columnCount = Math.max(1, QUALITY_ORDER.length * Math.max(1, typeIds.length));
  return (
    <div className="series-gantt-page series-gantt-page-v3">
      <section className="gantt-toolbar">
        <div>
          <span className="eyebrow">SERIES PLANNING · QUERY STATE IN URL</span>
          <h2>钓具系列甘特图</h2>
          <p>纵向重量、横向品质与类型；Series 覆盖范围只连接真实离散 SKU。</p>
        </div>
        <div className="gantt-toolbar-actions">
          <label><PackageSearch size={15} /><input value={query.text ?? ""} onChange={(event) => setQuery((current) => ({ ...current, text: event.target.value || undefined }))} placeholder="搜索有权查看的 Series 名称或 ID" /></label>
          <button type="button" disabled={!createSeriesAvailability.enabled} title={createSeriesAvailability.disabledReasonText} onClick={openCreateSeries}>
            <Plus size={14} />创建 Series
          </button>
          <button type="button" disabled={!generateAvailability.enabled || !selectedSeries} title={generateAvailability.disabledReasonText} onClick={() => setCandidateOpen(true)}>
            <Sparkles size={14} />生成 Model 候选
          </button>
          <button type="button" disabled title="OPEN-006 尚未确认">AI 评估</button>
        </div>
      </section>

      <section className="gantt-filter-bar" aria-label="甘特图筛选">
        <span><ListFilter size={15} />筛选</span>
        <MultiSelectFilter label="Collection" values={query.collectionIds} options={state.collections.map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(values) => setQuery((current) => ({ ...current, collectionIds: values }))} />
        <MultiSelectFilter label="钓法" values={query.methodIds} options={state.methodProfiles.filter((entry) => entry.enabled).map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(values) => setQuery((current) => ({ ...current, methodIds: values }))} />
        <MultiSelectFilter label="类型" values={query.typeIds} options={state.itemTypeProfiles.filter((entry) => entry.enabled).map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(values) => setQuery((current) => ({ ...current, typeIds: values }))} />
        <MultiSelectFilter label="品质" values={query.qualityIds} options={QUALITY_ORDER.map((entry) => ({ value: entry.id, label: `${entry.letter} / ${entry.name}` }))} onChange={(values) => setQuery((current) => ({ ...current, qualityIds: values }))} />
        <MultiSelectFilter label="功能" values={query.functionIds} options={state.functionProfiles.filter((entry) => entry.enabled).map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(values) => setQuery((current) => ({ ...current, functionIds: values }))} />
        <MultiSelectFilter label="部位" values={query.itemPartIds} options={enabledItemParts.map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(values) => setQuery((current) => ({ ...current, itemPartIds: (values ?? []).filter(isProductItemPartEnabled) }))} />
        <MultiSelectFilter label="生命周期" values={query.lifecycleStates} options={[{ value: "ACTIVE" as const, label: "活跃" }, { value: "DEPRECATED" as const, label: "已废弃" }, { value: "ARCHIVED" as const, label: "已归档" }]} onChange={(values) => setQuery((current) => ({ ...current, lifecycleStates: values }))} />
        <MultiSelectFilter label="注意状态" values={query.attentionStates} options={[{ value: "HAS_UPGRADE_CANDIDATE" as const, label: "升级候选" }, { value: "REBASE_REQUIRED" as const, label: "需要 Rebase" }, { value: "SOURCE_STALE" as const, label: "规则源过期" }, { value: "IMPORT_CONFLICT" as const, label: "导入冲突" }, { value: "EXPORT_RELATION_BROKEN" as const, label: "导出关系断裂" }]} onChange={(values) => setQuery((current) => ({ ...current, attentionStates: values }))} />
        <MultiSelectFilter label="Issue 级别" values={query.issueSeverities} options={[{ value: "BLOCKER" as const, label: "阻断" }, { value: "ERROR" as const, label: "错误" }, { value: "WARNING" as const, label: "警告" }, { value: "INFO" as const, label: "信息" }]} onChange={(values) => setQuery((current) => ({ ...current, issueSeverities: values }))} />
        <MultiSelectFilter label="Issue" values={query.issueCodes} options={issueCodes.map((value) => ({ value, label: value }))} onChange={(values) => setQuery((current) => ({ ...current, issueCodes: values }))} />
        <MultiSelectFilter label="精确目标拉力" values={query.exactTargetWeightKg} options={weights.map((value) => ({ value, label: `${value} kgf` }))} onChange={(values) => setQuery((current) => ({ ...current, exactTargetWeightKg: values }))} />
        <MultiSelectFilter label="RuleSet" values={query.ruleSetVersions} options={ruleSetVersions.map((value) => ({ value, label: value }))} onChange={(values) => setQuery((current) => ({ ...current, ruleSetVersions: values }))} />
        <select aria-label="升级候选" value={query.hasUpgradeCandidate === undefined ? "" : query.hasUpgradeCandidate ? "1" : "0"} onChange={(event) => setQuery((current) => ({ ...current, hasUpgradeCandidate: event.target.value === "" ? undefined : event.target.value === "1" }))}>
          <option value="">升级候选：全部</option><option value="1">仅有升级候选</option><option value="0">仅无升级候选</option>
        </select>
        <select value={query.sort ?? "quality_type"} onChange={(event) => setQuery((current) => ({ ...current, sort: event.target.value as SeriesGanttQuery["sort"] }))}>
          <option value="quality_type">品质 / 类型</option><option value="name">名称</option><option value="updated_desc">最近更新</option>
        </select>
        <button type="button" onClick={() => setQuery({ sort: "quality_type" })}>重置</button>
        <em>{blocks.length} 个 Series</em>
      </section>

      <div className="gantt-continuity-note"><Info size={16} /><strong>覆盖范围只表达系列规划跨度，不代表连续插值。</strong></div>

      <section className="gantt-matrix-shell">
        <div className="gantt-quality-header" style={{ gridTemplateColumns: `88px repeat(${columnCount}, minmax(142px, 1fr))` }}>
          <span className="gantt-axis-corner">目标拉力档位</span>
          {QUALITY_ORDER.map((quality) => (
            <div key={quality.id} style={{ gridColumn: `span ${Math.max(1, typeIds.length)}`, borderTopColor: quality.color }}>
              <strong style={{ color: quality.color }}>{quality.letter} / {quality.name}</strong>
            </div>
          ))}
          <span />
          {QUALITY_ORDER.flatMap((quality) => typeIds.map((typeId) => <div className="gantt-type-header" key={quality.id + typeId}>{typeName(state, typeId)}</div>))}
        </div>
        <div className="gantt-matrix" style={{ gridTemplateColumns: `88px repeat(${columnCount}, minmax(142px, 1fr))`, gridTemplateRows: `repeat(${Math.max(weights.length, 1)}, 74px)` }}>
          {weights.map((weight, index) => <div className="gantt-weight-label" key={weight} style={{ gridColumn: 1, gridRow: index + 1 }}><strong>{weight}</strong><span>kgf</span></div>)}
          {weights.flatMap((_weight, row) => Array.from({ length: columnCount }, (_unused, col) => <div className="gantt-grid-cell" key={`${row}:${col}`} style={{ gridColumn: col + 2, gridRow: row + 1 }} />))}
          {blocks.map((block) => {
            const qualityIndex = QUALITY_ORDER.findIndex((quality) => quality.id === block.qualityId);
            const typeIndex = Math.max(0, typeIds.indexOf(block.typeId));
            const column = 2 + Math.max(0, qualityIndex) * Math.max(1, typeIds.length) + typeIndex;
            const rowIndexes = block.skuNodes.map((sku) => weights.indexOf(sku.targetWeightKg)).filter((index) => index >= 0);
            if (!rowIndexes.length) return null;
            const minRow = Math.min(...rowIndexes);
            const maxRow = Math.max(...rowIndexes);
            const color = QUALITY_ORDER[Math.max(0, qualityIndex)]?.color ?? "#586675";
            return (
              <div className={`gantt-series-block ${selectedSeries?.id === block.seriesId ? "selected" : ""}`} key={block.seriesId} style={{ gridColumn: column, gridRow: `${minRow + 1} / ${maxRow + 2}`, "--series-color": color } as React.CSSProperties}>
                <button type="button" className="gantt-series-select" onClick={() => selectSeries(block.seriesId)}>
                  <strong>{block.name}</strong>
                  <small>{block.aggregate.skuCount} SKU · {block.aggregate.modelCountVisible} Model</small>
                  <span className={`gantt-primary-state ${block.aggregate.primary.toLowerCase()}`}>{statusText(block.aggregate.primary)}</span>
                  <span className="gantt-secondary-counts">
                    {block.aggregate.hardBlockingCount ? <em>{block.aggregate.hardBlockingCount} 阻断</em> : null}
                    {block.aggregate.warningCount ? <em>{block.aggregate.warningCount} 警告</em> : null}
                    {block.aggregate.pendingUpgradeCount ? <em>{block.aggregate.pendingUpgradeCount} 升级</em> : null}
                  </span>
                </button>
                {block.skuNodes.map((sku) => {
                  const denominator = Math.max(1, maxRow - minRow);
                  const offset = ((weights.indexOf(sku.targetWeightKg) - minRow) / denominator) * 100;
                  return (
                    <button type="button" className={`gantt-sku-node ${selectedSku?.id === sku.skuId ? "selected" : ""}`} key={sku.skuId} style={{ top: `calc(${offset}% - 8px)` }} title={`${sku.targetWeightKg} kgf · ${sku.modelIds.length} 个可见 Model · ${sku.validationIssues.length} Issue`} onClick={() => selectSku(block.seriesId, sku.skuId)}>
                      <span />{sku.targetWeightKg}<small>{sku.modelIds.length}</small>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>

      {!blocks.length ? <div className="gantt-empty"><PackageSearch size={34} /><h2>没有符合筛选的 Series</h2><p>空白不会创建 SKU。可重置筛选，或创建 Series 并确认明确的离散目标拉力规格。</p><button type="button" onClick={() => setQuery({ sort: "quality_type" })}>重置筛选</button></div> : null}

      {selectedSeries ? (
        <section className="gantt-summary">
          <header>
            <div><span className="eyebrow">SERIES SUMMARY</span><h3>{selectedSeries.name}</h3><small>{selectedSeries.id} · revision {selectedSeries.revision}</small></div>
            <button type="button" disabled={!openSeriesAvailability.enabled || selectedBlock?.aggregate.readOnly} title={selectedBlock?.aggregate.readOnly ? "未知状态已触发只读降级，请先修复数据。" : openSeriesAvailability.disabledReasonText} onClick={() => onOpenSeries(selectedSeries.id)}>打开 Series <ChevronRight size={15} /></button>
          </header>
          <div className="gantt-summary-meta">
            <span><CircleDot size={13} />{statusText(selectedBlock?.aggregate.primary ?? selectedSeries.status)}</span>
            <span>{typeName(state, selectedSeries.typeId)}</span>
            <span>{selectedSeries.targetPullSpecifications.length} 个目标拉力规格</span>
            <span>规划范围：{selectedSeries.planningPullRange ? `${selectedSeries.planningPullRange.minKgf}～${selectedSeries.planningPullRange.maxKgf} kgf` : "未设置"}</span>
            {selectedBlock ? <span>{statusText(selectedBlock.aggregate.lifecycle)} · {statusText(selectedBlock.aggregate.revisionState)} · {statusText(selectedBlock.aggregate.validationState)} · {statusText(selectedBlock.aggregate.publicationState)}</span> : null}
            {selectedBlock?.aggregate.attention.map((stateCode) => <span key={stateCode}>{statusText(stateCode)}</span>)}
          </div>
          <div className="gantt-sku-tabs">
            {seriesSkus.map((sku) => <button type="button" key={sku.id} className={selectedSku?.id === sku.id ? "active" : ""} onClick={() => selectSku(selectedSeries.id, sku.id)}><strong>{sku.targetWeightKg} kgf</strong><span>离散规格 · SKU 抽屉 · {sku.modelIds.length} Model · rev {sku.revision}</span></button>)}
          </div>
          {selectedSku ? (
            <div className="gantt-model-list">
              <div className="gantt-model-list-head"><span>Model · 实际购买对象</span><span>配置</span><span>生命周期</span><span /></div>
              {visibleModels.map((model) => (
                <button type="button" key={model.id} disabled={!previewModelAvailability.enabled} title={previewModelAvailability.disabledReasonText} onClick={() => { setDrawerModelId(model.id); setDrawerSnapshotId(""); }}>
                  <span><Boxes size={15} /><div><strong>{model.name}</strong><small>{model.id} · revision {model.revision}</small></div></span>
                  <span>{model.action} · {model.hardness} · {model.lengthM}m</span>
                  <span>{statusText(model.status)}</span>
                  <ChevronRight size={16} />
                </button>
              ))}
              {models.length > visibleModels.length ? <button type="button" className="gantt-load-more" onClick={() => setModelCursor((value) => value + 12)}>加载更多 Model（{visibleModels.length}/{models.length}）</button> : null}
              {!models.length ? <div className="gantt-no-model">该 SKU 抽屉还没有 Model；不会自动跨层打开或创建对象。</div> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {seriesCreateDraft ? (
        <div className="gantt-create-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setSeriesCreateDraft(null);
        }}>
          <section className="gantt-create-dialog" role="dialog" aria-modal="true" aria-labelledby="gantt-create-title">
            <header>
              <div><span className="eyebrow">SERIES · DISCRETE PULL SPECS</span><h2 id="gantt-create-title">创建 Series 与离散 SKU</h2><p>范围只负责规划；只有下方明确确认的离散拉力才会逐项匹配结构标杆并生成 SKU 抽屉。</p></div>
              <button type="button" aria-label="关闭" onClick={() => setSeriesCreateDraft(null)}><X size={18} /></button>
            </header>
            <div className="gantt-create-grid">
              <label><span>Series 名称</span><input value={seriesCreateDraft.name} onChange={(event) => setSeriesCreateDraft({ ...seriesCreateDraft, name: event.target.value })} placeholder="例如 青芦·远投" /></label>
              <label><span>Collection（可选）</span><select value={seriesCreateDraft.collectionId} onChange={(event) => setSeriesCreateDraft({ ...seriesCreateDraft, collectionId: event.target.value })}><option value="">不归属 Collection</option>{state.collections.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
              <label className="span-2"><span>概念说明</span><textarea value={seriesCreateDraft.concept} onChange={(event) => setSeriesCreateDraft({ ...seriesCreateDraft, concept: event.target.value })} placeholder="说明系列定位、使用场景和设计意图" /></label>
              <label><span>部位</span><select value={seriesCreateDraft.itemPartId} onChange={(event) => {
                const itemPartId = event.target.value;
                const type = state.itemTypeProfiles.find((entry) => entry.enabled && entry.itemPartIds.includes(itemPartId) && entry.methodIds.includes(seriesCreateDraft.methodId));
                setSeriesCreateDraft({ ...seriesCreateDraft, itemPartId, typeId: type?.id ?? "" });
              }}>{enabledItemParts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
              <label><span>钓法</span><select value={seriesCreateDraft.methodId} onChange={(event) => {
                const methodId = event.target.value;
                const type = state.itemTypeProfiles.find((entry) => entry.enabled && entry.methodIds.includes(methodId) && entry.itemPartIds.includes(seriesCreateDraft.itemPartId));
                setSeriesCreateDraft({ ...seriesCreateDraft, methodId, typeId: type?.id ?? "" });
              }}>{state.methodProfiles.filter((entry) => entry.enabled).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
              <label><span>类型</span><select value={seriesCreateDraft.typeId} onChange={(event) => setSeriesCreateDraft({ ...seriesCreateDraft, typeId: event.target.value })}><option value="">请选择类型</option>{state.itemTypeProfiles.filter((entry) => entry.enabled && entry.methodIds.includes(seriesCreateDraft.methodId) && entry.itemPartIds.includes(seriesCreateDraft.itemPartId)).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
              <label><span>功能定位</span><select value={seriesCreateDraft.functionId} onChange={(event) => setSeriesCreateDraft({ ...seriesCreateDraft, functionId: event.target.value })}>{state.functionProfiles.filter((entry) => entry.enabled).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
              <label><span>品质（人工选择）</span><select value={seriesCreateDraft.qualityId} onChange={(event) => setSeriesCreateDraft({ ...seriesCreateDraft, qualityId: event.target.value as SeriesDefinition["qualityId"] })}>{QUALITY_ORDER.map((entry) => <option key={entry.id} value={entry.id}>{entry.letter} / {entry.name}</option>)}</select></label>
              <label><span>功能专精强度</span><select value={seriesCreateDraft.functionIntensity} onChange={(event) => setSeriesCreateDraft({ ...seriesCreateDraft, functionIntensity: Number(event.target.value) as 1 | 2 | 3 })}><option value={1}>1 · 轻度</option><option value={2}>2 · 标准</option><option value={3}>3 · 极致</option></select></label>
              <label><span>性能定位（可选）</span><select value={seriesCreateDraft.performanceId} onChange={(event) => setSeriesCreateDraft({ ...seriesCreateDraft, performanceId: event.target.value })}><option value="">暂不指定</option>{state.performanceProfiles.filter((entry) => entry.enabled).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
              <label className="span-2 gantt-discrete-pulls"><span>目标拉力规格 · 明确离散列表</span><input value={seriesCreateDraft.discretePulls} onChange={(event) => setSeriesCreateDraft({ ...seriesCreateDraft, discretePulls: event.target.value })} placeholder="例如 1.5, 3.8, 5.4, 8.2" /><small>当前将物化：{parseDiscretePulls(seriesCreateDraft.discretePulls).map((pull) => `${pull} kgf`).join("、") || "尚未输入"}。一个数值只生成一个 SKU 抽屉，不补中间值。</small></label>
              <fieldset className="span-2 gantt-planning-range"><legend>规划拉力范围（可选）· 不参与 SKU 生成</legend><label><span>最小 kgf</span><input type="number" min="0.01" step="0.1" value={seriesCreateDraft.planningMinKgf} onChange={(event) => setSeriesCreateDraft({ ...seriesCreateDraft, planningMinKgf: event.target.value })} placeholder="可留空" /></label><label><span>最大 kgf</span><input type="number" min="0.01" step="0.1" value={seriesCreateDraft.planningMaxKgf} onChange={(event) => setSeriesCreateDraft({ ...seriesCreateDraft, planningMaxKgf: event.target.value })} placeholder="可留空" /></label></fieldset>
            </div>
            <footer><span>稳定 ID：{seriesCreateDraft.seriesId}</span><div><button type="button" onClick={() => setSeriesCreateDraft(null)}>取消</button><button type="button" className="primary" onClick={createSeries}><Plus size={14} />确认离散规格并创建</button></div></footer>
          </section>
        </div>
      ) : null}

      {drawerModel ? (
        <>
          <button className="gantt-drawer-backdrop" type="button" aria-label="关闭预览" onClick={() => { setDrawerModelId(""); setDrawerSnapshotId(""); }} />
          <ModelDrawer state={state} workspaceId={workspaceId} model={drawerModel} sku={drawerSku} series={drawerSeries} snapshot={drawerSnapshot} currentEntityType={drawerSnapshotId ? "configuration_snapshot" : "model"} comparisonModelIds={comparisonModelIds} rebaseEnabled={Boolean(drawerSeries) && rebaseAvailability.enabled} rebaseDisabledReason={drawerSeries ? rebaseAvailability.disabledReasonText : "父级 Series 不可见，不能进入 Rebase。"} onToggleCompare={toggleCompare} onOpenSnapshot={setDrawerSnapshotId} onOpenRebase={() => { setDrawerModelId(""); setDrawerSnapshotId(""); if (drawerSeries) onOpenSeries(drawerSeries.id); }} onClose={() => { setDrawerModelId(""); setDrawerSnapshotId(""); }} />
        </>
      ) : null}
      {candidateOpen && selectedSeries ? (
        <CandidateGenerationWorkbench
          state={state}
          series={selectedSeries}
          actionAvailabilities={actionAvailabilities}
          actor={actor}
          mutate={mutate}
          notify={notify}
          onClose={() => setCandidateOpen(false)}
        />
      ) : null}
    </div>
  );
}
