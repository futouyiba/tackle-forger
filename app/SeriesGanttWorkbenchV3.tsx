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
  Trash2,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  resolveProductDeepLink,
  type ActionAvailabilityMap,
  type BreadcrumbItem,
} from "@/lib/interaction-contracts";
import {
  enabledProductItemParts,
  isProductSkuChainEnabled,
} from "@/lib/enabled-item-parts";
import { CANONICAL_FEISHU_SHEET_REGISTRY } from "@/lib/feishu-workbook";
import { issueClientActionCommand } from "@/lib/client-action-command";
import { buildSamePartComparison, calculateModelFiveAxisPreview, fiveAxisPlotRatio } from "@/lib/five-axis";
import { deterministicHash } from "@/lib/rule-kernel";
import { isActiveValidationIssue, validationIssueLevel } from "@/lib/validation-issues";
import {
  querySeriesGantt,
  seriesGanttQueryFromSearchParams,
  seriesGanttQueryToSearchParams,
  type SeriesGanttQuery,
} from "@/lib/series-gantt-query";
import {
  canApplyConfirmedWorkspace,
  DIRTY_WORKSPACE_CONFIRMATION_MESSAGE,
} from "@/lib/clean-workspace-confirmation";
import type {
  ConfigurationSnapshot,
  FiveAxisComparisonView,
  FiveAxisEntityInput,
  ModelFiveAxisPreview,
  FiveAxisViewDefinition,
  ProjectionMatch,
  LegacyFiveAxisVertexSet,
  LegacyFiveAxisViewDefinition,
  PurchasableModel,
  SeriesDefinition,
  SkuDrawer,
  StoredFiveAxisViewDefinition,
  WorkspaceState,
} from "@/lib/types";
import "./series-gantt-v3.css";
import { CandidateGenerationWorkbench } from "./CandidateGenerationWorkbench";
import {
  buildProductBreadcrumbView,
  ProductDeepLinkUnavailableNotice,
} from "./product-deep-link-ui";
import {
  clearMatchingAssessment,
  SeriesAssessmentPanel,
  type AIAssessmentUiState,
} from "./SeriesAssessmentPanel";

function isLegacyFiveAxisDefinition(
  definition: WorkspaceState["fiveAxisViewDefinitions"][number],
): definition is LegacyFiveAxisViewDefinition {
  return !("semanticContractVersion" in definition);
}

function isLegacyFiveAxisVertexSet(
  vertexSet: WorkspaceState["fiveAxisVertexSets"][number],
): vertexSet is LegacyFiveAxisVertexSet {
  return "fishWeightGradeId" in vertexSet;
}

interface SeriesGanttWorkbenchV3Props {
  state: WorkspaceState;
  workspaceId: string;
  actionAvailabilities: ActionAvailabilityMap;
  notify: (message: string) => void;
  actor: string;
  mutate: (producer: (draft: WorkspaceState) => void, recalculate?: boolean) => void;
  workspaceFreshness: () => { dirty: boolean; revision: number };
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
  functionIntensity: 1 | 2 | 3;
  planningMinKgf: string;
  planningMaxKgf: string;
  discretePulls: string;
}

interface AIDraftPreviewChange {
  changeId?: string;
  parameterKey: string;
  before: unknown;
  operation: string;
  operand: unknown;
  after: unknown;
}

interface AIDraftPreviewPayload {
  previewId?: string;
  previewHash?: string;
  scope?: unknown;
  targetRef?: unknown;
  changes?: AIDraftPreviewChange[];
  selectedChanges?: AIDraftPreviewChange[];
  diffs?: {
    validation?: {
      beforeIssueCodes?: string[];
      afterIssueCodes?: string[];
      newBlockingIssueCodes?: string[];
    };
    fiveAxis?: { status?: string; affectedAxisIds?: string[] };
    affinity?: { status?: string };
    invariants?: {
      beforeIssueCodes?: string[];
      afterIssueCodes?: string[];
      newBlockingIssueCodes?: string[];
    };
  };
  evidenceRefs?: Array<{
    evidenceType: string;
    refId: string;
    revisionId?: string;
    contentHash: string;
  }>;
  canCreateDraft?: boolean;
  blockingReasonCodes?: string[];
}

interface AIDraftPreviewUiState {
  status: "idle" | "running" | "success" | "error" | "creating";
  requestFingerprint?: string;
  payload?: AIDraftPreviewPayload;
  error?: string;
}

interface AIRuleTargetForm {
  sourceRevisionId: string;
  sheetId: string;
  parameterKey: string;
  stableRuleId: string;
}

function normalizedAssessmentPayload(
  payload: (Partial<AIAssessmentUiState> & {
    metadata?: { assessmentId?: string; inputHash?: string; outputHash?: string };
    semanticContent?: AIAssessmentUiState["result"];
  }) | null,
  scopeKey: string,
): AIAssessmentUiState | undefined {
  const result = payload?.result ?? payload?.semanticContent;
  const assessmentId = payload?.assessmentId ?? payload?.metadata?.assessmentId;
  if (!payload || !assessmentId) return undefined;
  return {
    scopeKey,
    status: result ? "success" : "error",
    assessmentId,
    inputHash: payload.inputHash ?? payload.metadata?.inputHash,
    outputHash: payload.outputHash ?? payload.metadata?.outputHash,
    freshness: payload.freshness,
    result,
    error: result ? undefined : payload.error ?? "最近一次 AI 评估未成功生成可用建议。",
  };
}

function renderAIValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "object") {
    const safeValue = value as { kind?: unknown; value?: unknown };
    if (typeof safeValue.kind === "string" && Object.hasOwn(safeValue, "value")) {
      return renderAIValue(safeValue.value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "无法显示";
    }
  }
  return String(value);
}

function previewFromResponse(payload: unknown): AIDraftPreviewPayload | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const preview = record.preview && typeof record.preview === "object" && !Array.isArray(record.preview)
    ? record.preview as Record<string, unknown>
    : record;
  const rawChanges = Array.isArray(preview.changes)
    ? preview.changes
    : Array.isArray(preview.selectedChanges)
      ? preview.selectedChanges
      : undefined;
  const changes = rawChanges?.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const change = entry as Record<string, unknown>;
    if (typeof change.parameterKey !== "string" || typeof change.operation !== "string") return [];
    return [{
      changeId: typeof change.changeId === "string" ? change.changeId : undefined,
      parameterKey: change.parameterKey,
      before: change.before,
      operation: change.operation,
      operand: change.operand,
      after: change.after,
    }];
  });
  return {
    previewId: typeof preview.previewId === "string" ? preview.previewId : undefined,
    previewHash: typeof preview.previewHash === "string" ? preview.previewHash : undefined,
    scope: preview.scope,
    targetRef: preview.targetRef,
    changes,
    diffs: preview.diffs && typeof preview.diffs === "object" && !Array.isArray(preview.diffs)
      ? preview.diffs as AIDraftPreviewPayload["diffs"]
      : undefined,
    evidenceRefs: Array.isArray(preview.evidenceRefs)
      ? preview.evidenceRefs.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const evidence = entry as Record<string, unknown>;
        if (typeof evidence.evidenceType !== "string"
          || typeof evidence.refId !== "string"
          || typeof evidence.contentHash !== "string") return [];
        return [{
          evidenceType: evidence.evidenceType,
          refId: evidence.refId,
          revisionId: typeof evidence.revisionId === "string" ? evidence.revisionId : undefined,
          contentHash: evidence.contentHash,
        }];
      })
      : undefined,
    canCreateDraft: typeof preview.canCreate === "boolean"
      ? preview.canCreate
      : typeof preview.canCreateDraft === "boolean"
        ? preview.canCreateDraft
        : undefined,
    blockingReasonCodes: Array.isArray(preview.blockingReasonCodes)
      ? preview.blockingReasonCodes.filter((entry): entry is string => typeof entry === "string")
      : undefined,
  };
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
  definition?: StoredFiveAxisViewDefinition;
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
  definition?: StoredFiveAxisViewDefinition;
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
  aiAvailability,
  aiPatchDraftAvailability,
  aiRuleDraftAvailability,
  aiAssessment,
  onRunAssessment,
  onAssessmentDeleted,
  onWorkspaceApplied,
  workspaceFreshness,
  notify,
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
  aiAvailability: ActionAvailabilityMap["run_ai_assessment"];
  aiPatchDraftAvailability: ActionAvailabilityMap["create_ai_patch_draft"];
  aiRuleDraftAvailability: ActionAvailabilityMap["create_ai_rule_source_change_draft"];
  aiAssessment?: AIAssessmentUiState;
  onRunAssessment: () => void;
  onAssessmentDeleted: (assessmentId: string) => void;
  onWorkspaceApplied: SeriesGanttWorkbenchV3Props["onWorkspaceApplied"];
  workspaceFreshness: SeriesGanttWorkbenchV3Props["workspaceFreshness"];
  notify: SeriesGanttWorkbenchV3Props["notify"];
  onOpenRebase: () => void;
  onToggleCompare: (modelId: string) => void;
  onOpenSnapshot: (snapshotId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DrawerTab>("overview");
  const [mode, setMode] = useState<FiveAxisMode>("model_series");
  const [comparisonPartId, setComparisonPartId] = useState("part:rod");
  const [comparisonScaleMode, setComparisonScaleMode] = useState<FiveAxisComparisonView["scaleMode"]>("official_locked");
  const [selectedRecommendationCode, setSelectedRecommendationCode] = useState("");
  const [selectedChangeIds, setSelectedChangeIds] = useState<string[]>([]);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [userReason, setUserReason] = useState("");
  const [previewState, setPreviewState] = useState<AIDraftPreviewUiState>({ status: "idle" });
  const [draftIdempotencyKey, setDraftIdempotencyKey] = useState("");
  const [dismissedRecommendationCodes, setDismissedRecommendationCodes] = useState<string[]>([]);
  const [dismissRunning, setDismissRunning] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [deletePermanentlyRetainedAcknowledged, setDeletePermanentlyRetainedAcknowledged] = useState(false);
  const [deleteRunning, setDeleteRunning] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [ruleTargetForm, setRuleTargetForm] = useState<AIRuleTargetForm>({
    sourceRevisionId: "",
    sheetId: "",
    parameterKey: "",
    stableRuleId: "",
  });
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const draftFiveAxisPreview = useMemo(() => {
    if (snapshot?.fiveAxisPreview || !model.fishWeightGradeId) return undefined;
    const draftDefinition = state.fiveAxisViewDefinitions.find(
      isLegacyFiveAxisDefinition,
    );
    if (!draftDefinition) return undefined;
    const vertexSet = state.fiveAxisVertexSets.filter(
      isLegacyFiveAxisVertexSet,
    ).find((entry) =>
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
  const breadcrumbView = buildProductBreadcrumbView({
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
  const breadcrumbs = breadcrumbView.breadcrumbs;

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

  const traceItems = snapshot?.calculationTrace
    ? snapshot.calculationTrace.entries.map((entry) => ({
        sequence: entry.sequence,
        layer: entry.layer,
        parameterKey: entry.parameterKey,
        sourceName: "entityType" in entry.sourceRef
          ? entry.sourceRef.entityType
          : entry.sourceRef.sourceType,
        sourceId: "entityType" in entry.sourceRef
          ? entry.sourceRef.entityId
          : entry.sourceRef.sourceId,
        before: entry.before,
        operation: entry.operation,
        operand: entry.operand,
        after: entry.after,
      }))
    : snapshot?.attributeTrace
      .flatMap((step) => step.contributions.map((contribution) => ({
        ...contribution,
        layer: step.layer,
      })))
      .sort((left, right) => left.sequence - right.sequence) ?? [];
  const inComparison = comparisonModelIds.includes(model.id);
  const pendingUpgrade = state.upgradeCandidates.find((entry) => entry.modelId === model.id && entry.status === "pending");
  const comparisonResult = useMemo(() => {
    if (
      comparisonModelIds.length < 2
      || !definition
      || !isLegacyFiveAxisDefinition(definition)
      || !activeFiveAxisPreview
    ) return {};
    const vertexSet = state.fiveAxisVertexSets.filter(isLegacyFiveAxisVertexSet).find((entry) =>
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
  const recommendations = aiAssessment?.result?.recommendations ?? [];
  const persistedDismissedRecommendationCodes = aiAssessment?.result?.feedback?.recommendations
    ?.filter((entry) => entry.state === "dismissed")
    .map((entry) => entry.recommendationId) ?? [];
  const visibleRecommendations = recommendations.filter((entry) =>
    !dismissedRecommendationCodes.includes(entry.recommendationCode)
    && !persistedDismissedRecommendationCodes.includes(entry.recommendationCode));
  const selectedRecommendation = recommendations.find((entry) =>
    entry.recommendationCode === selectedRecommendationCode);
  const selectedSuggestedChanges = selectedRecommendation?.suggestedChanges ?? [];
  const effectiveSelectedChangeIds = selectedChangeIds.filter((changeId) =>
    selectedSuggestedChanges.some((entry) => entry.changeId === changeId));
  const targetModelFrozen = Boolean(snapshot || model.configurationSnapshotId);
  const isRuleSourceDraft = selectedRecommendation?.suggestedAction === "create_rule_source_change_draft";
  const selectedDraftAvailability = isRuleSourceDraft ? aiRuleDraftAvailability : aiPatchDraftAvailability;
  const latestFeishuSourceRevisions = [...state.feishuSourceRevisions]
    .sort((left, right) => right.pulledAt.localeCompare(left.pulledAt) || right.id.localeCompare(left.id))
    .filter((entry, index, entries) =>
      entries.findIndex((candidate) => candidate.spreadsheetToken === entry.spreadsheetToken) === index);
  const selectedFeishuSourceRevision = latestFeishuSourceRevisions.find((entry) =>
    entry.id === ruleTargetForm.sourceRevisionId);
  const allowedRuleSourceSheets = selectedFeishuSourceRevision?.sheets.flatMap((sheet) => {
    const registered = CANONICAL_FEISHU_SHEET_REGISTRY.find((entry) =>
      entry.sheetId === sheet.sheetId && entry.role === "rule_source" && entry.importsRules);
    return registered ? [{ sheetId: sheet.sheetId, name: sheet.name || registered.expectedName }] : [];
  }) ?? [];
  const stableRulesForParameter = [
    ...state.methodProfiles.flatMap((profile) => profile.rules.map((rule) => ({ rule, sheetId: "fATowU" }))),
    ...state.itemTypeProfiles.flatMap((profile) => profile.rules.map((rule) => ({ rule, sheetId: "fATowU" }))),
    ...state.functionProfiles.flatMap((profile) => [
      ...profile.rules.map((rule) => ({ rule, sheetId: "vviXo0" })),
      ...profile.intensityRules.flatMap((entry) =>
        entry.rules.map((rule) => ({ rule, sheetId: "vviXo0" }))),
    ]),
    ...state.qualityProfiles.flatMap((profile) => profile.rules.map((rule) => ({ rule, sheetId: "FqD4j7" }))),
  ].filter((entry, index, rules) =>
    entry.sheetId === ruleTargetForm.sheetId
    && entry.rule.parameterKey === ruleTargetForm.parameterKey
    && rules.findIndex((candidate) => candidate.rule.id === entry.rule.id) === index);
  const selectedRuleTarget = isRuleSourceDraft && selectedFeishuSourceRevision
    ? {
      spreadsheetToken: selectedFeishuSourceRevision.spreadsheetToken,
      sheetId: ruleTargetForm.sheetId,
      stableRuleId: ruleTargetForm.stableRuleId.trim(),
      parameterKey: ruleTargetForm.parameterKey,
      sourceRevision: selectedFeishuSourceRevision.sourceRevision,
    }
    : undefined;
  const hasSafeRuleTarget = !isRuleSourceDraft || Boolean(
    selectedRuleTarget?.spreadsheetToken
    && selectedRuleTarget.sheetId
    && allowedRuleSourceSheets.some((entry) => entry.sheetId === selectedRuleTarget.sheetId)
    && selectedRuleTarget.stableRuleId
    && selectedRuleTarget.parameterKey
    && state.parameters.some((entry) => entry.key === selectedRuleTarget.parameterKey)
    && selectedRuleTarget.sourceRevision,
  );
  const previewRequestFingerprint = selectedRecommendation && aiAssessment?.assessmentId && aiAssessment.inputHash
    ? JSON.stringify({
      assessmentId: aiAssessment.assessmentId,
      assessmentInputHash: aiAssessment.inputHash,
      recommendationId: selectedRecommendation.recommendationCode,
      selectedChangeIds: [...effectiveSelectedChangeIds].sort(),
      targetModelRef: { entityId: model.id, revisionId: String(model.revision) },
      ...(selectedRuleTarget ? { targetRuleRef: selectedRuleTarget } : {}),
    })
    : "";
  const selectedRecommendationDraftable = selectedRecommendation?.suggestedAction !== "preview_only"
    && selectedSuggestedChanges.length > 0
    && effectiveSelectedChangeIds.length > 0
    && (!isRuleSourceDraft || effectiveSelectedChangeIds.length === 1);
  const freshnessAllowsDraft = aiAssessment?.freshness?.state === "fresh"
    && aiAssessment.freshness.canCreateDraft;
  const successfulMatchingPreview = previewState.status === "success"
    && previewState.requestFingerprint === previewRequestFingerprint
    && previewState.payload?.canCreateDraft !== false
    && !(previewState.payload?.blockingReasonCodes?.length);
  const frozenTargetBlocksDraft = targetModelFrozen && !isRuleSourceDraft;
  const createDisabledReason = frozenTargetBlocksDraft
    ? "当前 Model 已有冻结 Snapshot；AI 不能在冻结 revision 上创建草稿。"
    : !selectedRecommendation
      ? "请先选择一条建议。"
      : selectedRecommendation.suggestedAction === "preview_only"
        ? "该建议仅供查看，不包含可转换的结构化变更。"
        : !selectedSuggestedChanges.length
          ? "该建议没有结构化 suggestedChanges；不会从自然语言推断 Patch。"
          : isRuleSourceDraft && effectiveSelectedChangeIds.length !== 1
            ? "规则源变更草稿每次只能选择一个 typed 参数变化。"
          : !hasSafeRuleTarget
            ? "规则源建议缺少可验证的 targetRuleRef；不会猜测工作表、规则或 sourceRevision。"
            : !freshnessAllowsDraft
              ? "评估已过期或服务端未确认可创建草稿，请重新评估。"
              : !selectedDraftAvailability.enabled
                ? selectedDraftAvailability.disabledReasonText
                : !evidenceOpen
                  ? "请先查看依据、假设与未覆盖信息。"
                  : !successfulMatchingPreview
                    ? "请先对当前选择执行一次成功的确定性差异预览。"
                    : !userReason.trim()
                      ? "请填写创建草稿的人工理由。"
                      : undefined;

  const selectRecommendation = (recommendationCode: string) => {
    const recommendation = recommendations.find((entry) => entry.recommendationCode === recommendationCode);
    setSelectedRecommendationCode(recommendationCode);
    setSelectedChangeIds(recommendation?.suggestedChanges?.map((entry) => entry.changeId) ?? []);
    setEvidenceOpen(false);
    setUserReason("");
    setPreviewState({ status: "idle" });
    setDraftIdempotencyKey(crypto.randomUUID());
    setRuleTargetForm({
      sourceRevisionId: latestFeishuSourceRevisions[0]?.id ?? "",
      sheetId: "",
      parameterKey: "",
      stableRuleId: "",
    });
  };

  const toggleSuggestedChange = (changeId: string) => {
    setSelectedChangeIds((current) => current.includes(changeId)
      ? current.filter((entry) => entry !== changeId)
      : [...current, changeId]);
    setPreviewState({ status: "idle" });
    setDraftIdempotencyKey(`ai-draft:${crypto.randomUUID()}`);
  };

  const updateRuleTarget = (next: AIRuleTargetForm) => {
    setRuleTargetForm(next);
    setPreviewState({ status: "idle" });
    setDraftIdempotencyKey(`ai-draft:${crypto.randomUUID()}`);
  };

  const updateUserReason = (next: string) => {
    setUserReason(next);
    setDraftIdempotencyKey(`ai-draft:${crypto.randomUUID()}`);
  };

  const requestDraftAction = async (mode: "preview" | "create") => {
    if (!selectedRecommendation || !aiAssessment?.assessmentId || !aiAssessment.inputHash) return;
    const requestFingerprint = previewRequestFingerprint;
    if (!requestFingerprint || !effectiveSelectedChangeIds.length) return;
    if (mode === "create" && createDisabledReason) {
      notify(createDisabledReason);
      return;
    }
    const expectedWorkspaceRevision = workspaceFreshness().revision;
    if (mode === "create" && workspaceFreshness().dirty) {
      notify(DIRTY_WORKSPACE_CONFIRMATION_MESSAGE);
      return;
    }
    setPreviewState((current) => ({
      ...current,
      status: mode === "preview" ? "running" : "creating",
      error: undefined,
    }));
    try {
      const response = await fetch(
        `/api/ai/assessments/${encodeURIComponent(aiAssessment.assessmentId)}/drafts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode,
            recommendationId: selectedRecommendation.recommendationCode,
            assessmentInputHash: aiAssessment.inputHash,
            selectedChangeIds: effectiveSelectedChangeIds,
            userReason: userReason.trim(),
            idempotencyKey: mode === "preview"
              ? `ai-preview:${crypto.randomUUID()}`
              : draftIdempotencyKey || `ai-draft:${crypto.randomUUID()}`,
            targetModelRef: {
              entityId: model.id,
              revisionId: String(model.revision),
            },
            ...(isRuleSourceDraft && selectedRuleTarget
              ? { targetRuleRef: selectedRuleTarget }
              : {}),
          }),
        },
      );
      const payload = await response.json().catch(() => null) as ({
        state?: WorkspaceState;
        revision?: number;
        workspaceRevision?: number;
        message?: string;
        error?: string;
        code?: string;
        artifactRef?: {
          artifactType?: "model_patch" | "rule_source_change_draft";
          artifactId?: string;
          state?: "DRAFT" | "LOCAL_DRAFT";
        };
      } & Record<string, unknown>) | null;
      if (!response.ok || !payload) {
        if (response.status === 503 && payload?.code === "AI_ARTIFACT_PROVENANCE_SYNC_PENDING") {
          throw new Error("草稿已写入，但来源留存仍在同步；请使用相同请求安全重试，系统不会重复创建草稿。");
        }
        throw new Error(payload?.error ?? "AI 建议转换请求未完成。");
      }
      if (mode === "preview") {
        const preview = previewFromResponse(payload);
        if (!preview?.changes?.length) {
          throw new Error("服务端未返回结构化确定性差异；不会把自然语言当作 Patch 预览。");
        }
        setPreviewState({
          status: "success",
          requestFingerprint,
          payload: preview,
        });
        if (!draftIdempotencyKey) setDraftIdempotencyKey(`ai-draft:${crypto.randomUUID()}`);
        notify("确定性差异预览已生成；请核对作用域、数值与校验变化。");
        return;
      }
      let nextState = payload.state;
      let nextRevision = payload.revision ?? payload.workspaceRevision;
      if (!nextState) {
        const currentResponse = await fetch("/api/state", { method: "GET" });
        const currentPayload = await currentResponse.json().catch(() => null) as {
          state?: WorkspaceState;
          revision?: number;
          error?: string;
        } | null;
        if (!currentResponse.ok || !currentPayload?.state || !Number.isInteger(currentPayload.revision)) {
          throw new Error(currentPayload?.error ?? "草稿已创建，但无法刷新最新工作区；请重新载入页面。");
        }
        nextState = currentPayload.state;
        nextRevision = currentPayload.revision;
      }
      if (!Number.isInteger(nextRevision)) {
        throw new Error("草稿已创建，但响应缺少可验证的工作区 revision；请重新载入页面。");
      }
      const applyCheck = canApplyConfirmedWorkspace({
        ...workspaceFreshness(), expectedRevision: expectedWorkspaceRevision,
      });
      if (!applyCheck.allowed) {
        notify(applyCheck.reason);
        return;
      }
      onWorkspaceApplied(
        nextState,
        nextRevision!,
        payload.message ?? `${payload.artifactRef?.artifactId ?? "AI 草稿"} 已创建。`,
      );
      notify(payload.message ?? `${payload.artifactRef?.artifactId ?? "AI 草稿"} 已创建。`);
      setPreviewState({ status: "idle" });
      setDraftIdempotencyKey("");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "AI 建议转换请求未完成。";
      setPreviewState((current) => ({
        ...current,
        status: mode === "create" && current.payload ? "success" : "error",
        error: message,
      }));
      notify(message);
    }
  };

  const dismissRecommendation = async () => {
    if (!selectedRecommendation || !aiAssessment?.assessmentId || dismissRunning) return;
    setDismissRunning(true);
    try {
      const response = await fetch(
        `/api/ai/assessments/${encodeURIComponent(aiAssessment.assessmentId)}/feedback`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recommendationId: selectedRecommendation.recommendationCode }),
        },
      );
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "无法保存忽略反馈。");
      setDismissedRecommendationCodes((current) => [
        ...new Set([...current, selectedRecommendation.recommendationCode]),
      ]);
      setSelectedRecommendationCode("");
      setSelectedChangeIds([]);
      setEvidenceOpen(false);
      setPreviewState({ status: "idle" });
      notify("已忽略该建议并保存反馈；不会影响校验或发布资格。");
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "无法保存忽略反馈。");
    } finally {
      setDismissRunning(false);
    }
  };

  const closeDeleteConfirmation = () => {
    if (deleteRunning) return;
    setDeleteConfirmationOpen(false);
    setDeletePermanentlyRetainedAcknowledged(false);
    setDeleteError("");
  };

  const deleteAssessment = async () => {
    if (
      !aiAssessment?.assessmentId
      || !deletePermanentlyRetainedAcknowledged
      || deleteRunning
    ) return;
    const assessmentId = aiAssessment.assessmentId;
    setDeleteRunning(true);
    setDeleteError("");
    try {
      const response = await fetch(
        `/api/ai/assessments/${encodeURIComponent(assessmentId)}`,
        { method: "DELETE" },
      );
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "无法删除这次 AI 评估。");
      onAssessmentDeleted(assessmentId);
      notify("这次 AI 评估已从工作台移除；已采纳产物的来源记录仍会永久保留。");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "无法删除这次 AI 评估。";
      setDeleteError(message);
      notify(message);
    } finally {
      setDeleteRunning(false);
    }
  };

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
          <p>{model.id} · revision {model.revision}{sku ? ` · ${sku.targetPullKg} kgf SKU 抽屉` : " · 父级不可见"}</p>
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
      <ProductDeepLinkUnavailableNotice unavailable={breadcrumbView.unavailable} />
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
            <div><span>SKU 抽屉</span><strong>{sku ? `${sku.targetPullKg} kgf` : "不可见对象"}</strong><small>{sku ? `${sku.id} · rev ${sku.revision}` : `${model.skuId} · revision unavailable`}</small></div>
            <div><span>Model</span><strong>{model.id}</strong><small>rev {model.revision}</small></div>
            <div><span>ConfigurationSnapshot</span><strong>{snapshot?.id ?? "尚未发布"}</strong><small>{snapshot ? `v${snapshot.version} · ${snapshot.contentHash.slice(0, 10)}` : "没有冻结内容"}</small></div>
          </div>
          <div className={tab === "overview" ? "gantt-quick-facts" : "gantt-layer-hidden"} aria-label="Model 常用要素">
            <div><span>目标拉力</span><strong>{sku ? `${sku.targetPullKg} kgf` : "不可见"}</strong><small>离散 SKU 规格</small></div>
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
                {activeFiveAxisPreview.componentSeries?.length
                  ? (
                      <FiveAxisComparisonPanel
                        view={activeFiveAxisPreview.tackleFitComparison}
                        definition={definition}
                      />
                    )
                  : (
                      <FiveAxisRadar
                        preview={activeFiveAxisPreview}
                        definition={definition}
                      />
                    )}
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
              <div><span>功能评分系数</span><strong>{snapshot?.qualityValueAssessment?.functionScoreFactor ?? "未冻结"}</strong><small>Performance 不参与计分或定价</small></div>
              <div><span>派生性能摘要</span><strong>{snapshot?.performanceSummary?.status === "AVAILABLE" ? snapshot.performanceSummary.summary.labels.map((entry) => entry.label).join("、") || "无命中标签" : "不可用"}</strong><small>{snapshot?.performanceSummary?.status === "UNAVAILABLE" ? "definition_missing · 发布不阻断" : snapshot?.performanceSummary ? "只读派生，不反向修改配置" : "历史 Snapshot 未冻结该字段"}</small></div>
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
              <div><CircleDot size={16} /><span>Series 不变量</span><strong>{sku ? (sku.validationSummary.some((issue) => isActiveValidationIssue(issue) && validationIssueLevel(issue) === "error") ? "有阻断" : "通过") : "不可验证"}</strong></div>
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
              <div key={`${entry.sequence}:${entry.sourceId}:${entry.parameterKey}`}>
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
            <h3>{aiAvailability.enabled ? "Fancy Hub 已通过启用准入" : "AI 服务尚未启用"}</h3>
            <p>{aiAvailability.enabled ? "评估请求由服务端按严格白名单构造；AI 只能提供建议或创建草稿，确定性校验、审核与发布保持独立。" : aiAvailability.disabledReasonText}</p>
            <dl>
              <div><dt>服务状态</dt><dd>{aiAssessment?.status === "running" ? "评估中" : aiAvailability.enabled ? "可用" : "关闭"}</dd></div>
              <div><dt>允许出网字段</dt><dd>ai-request/v1 严格安全投影</dd></div>
              <div><dt>草稿能力</dt><dd>{aiPatchDraftAvailability.enabled ? "Model Patch 草稿可用" : aiPatchDraftAvailability.disabledReasonText}</dd></div>
            </dl>
            {aiAssessment?.status === "error" ? <div className="gantt-unavailable"><AlertTriangle size={18} /><div><strong>评估未完成</strong><span>{aiAssessment.error}</span></div></div> : null}
            {aiAssessment?.status === "success" && aiAssessment.freshness?.state === "stale" ? (
              <div className="gantt-unavailable"><AlertTriangle size={18} /><div><strong>历史评估已过期</strong><span>当前输入已经变化；旧结果只读，必须重新评估后才能转草稿。</span></div></div>
            ) : null}
            {aiAssessment?.status === "success" && aiAssessment.result ? (
              <div className="gantt-ai-result">
                <strong>{aiAssessment.result.findings.length} 条发现 · {aiAssessment.result.recommendations.length} 条建议</strong>
                {aiAssessment.result.findings.map((finding) => <p key={finding.findingCode}><b>{finding.findingCode}</b> · {finding.summary}{finding.evidenceAliases.length > 0 ? <small> · 依据 {finding.evidenceAliases.join("、")}</small> : null}</p>)}
                <div className="gantt-ai-recommendations" role="listbox" aria-label="AI 建议">
                  {visibleRecommendations.map((recommendation) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={recommendation.recommendationCode === selectedRecommendationCode}
                      className={recommendation.recommendationCode === selectedRecommendationCode ? "selected" : ""}
                      key={recommendation.recommendationCode}
                      onClick={() => selectRecommendation(recommendation.recommendationCode)}
                    >
                      <b>{recommendation.title}</b>
                      <span>{recommendation.summary}</span>
                      <small>
                        {recommendation.suggestedAction === "create_model_patch_draft"
                          ? "Model Patch 草稿"
                          : recommendation.suggestedAction === "create_rule_source_change_draft"
                            ? "规则源变更草稿"
                            : "仅预览"}
                        {recommendation.evidenceAliases.length > 0 ? ` · ${recommendation.evidenceAliases.length} 项依据` : ""}
                      </small>
                    </button>
                  ))}
                  {!visibleRecommendations.length ? <small>没有未忽略的建议。</small> : null}
                </div>
                <small>output {aiAssessment.outputHash?.slice(0, 12)}</small>
              </div>
            ) : null}
            {selectedRecommendation ? (
              <section className="gantt-ai-selection">
                <header>
                  <div><span className="eyebrow">SELECTED RECOMMENDATION</span><h4>{selectedRecommendation.title}</h4></div>
                  <small>{selectedRecommendation.recommendationCode}</small>
                </header>
                {selectedSuggestedChanges.length ? (
                  <fieldset>
                    <legend>选择需要预览的结构化变更</legend>
                    {selectedSuggestedChanges.map((change) => (
                      <label key={change.changeId}>
                        <input
                          type="checkbox"
                          checked={effectiveSelectedChangeIds.includes(change.changeId)}
                          onChange={() => toggleSuggestedChange(change.changeId)}
                        />
                        <span><b>{change.parameterKey}</b><small>{change.operation} {renderAIValue(change.operand)} · 评估时 before {renderAIValue(change.expectedBefore)}</small></span>
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <div className="gantt-unavailable"><Info size={18} /><div><strong>没有结构化变更</strong><span>该建议不会从 summary 文本推断 parameter、operation 或 operand。</span></div></div>
                )}
                {isRuleSourceDraft ? (
                  <div className="gantt-ai-rule-target">
                    <strong>选择精确规则源目标</strong>
                    <small>目标来自当前工作区已拉取的规则源和稳定规则 ID，不读取 AI 文本推断。</small>
                    <div>
                      <label>
                        <span>最新源 Revision</span>
                        <select
                          value={ruleTargetForm.sourceRevisionId}
                          onChange={(event) => updateRuleTarget({
                            ...ruleTargetForm,
                            sourceRevisionId: event.target.value,
                            sheetId: "",
                          })}
                        >
                          <option value="">请选择规则源</option>
                          {latestFeishuSourceRevisions.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {entry.sourceRevision} · {entry.spreadsheetToken}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>规则工作表</span>
                        <select
                          value={ruleTargetForm.sheetId}
                          disabled={!selectedFeishuSourceRevision}
                          onChange={(event) => updateRuleTarget({ ...ruleTargetForm, sheetId: event.target.value })}
                        >
                          <option value="">请选择 rule_source 工作表</option>
                          {allowedRuleSourceSheets.map((entry) => <option key={entry.sheetId} value={entry.sheetId}>{entry.name} · {entry.sheetId}</option>)}
                        </select>
                      </label>
                      <label>
                        <span>真实 Parameter</span>
                        <select
                          value={ruleTargetForm.parameterKey}
                          onChange={(event) => updateRuleTarget({
                            ...ruleTargetForm,
                            parameterKey: event.target.value,
                            stableRuleId: "",
                          })}
                        >
                          <option value="">请选择参数</option>
                          {state.parameters.map((parameter) => <option key={parameter.key} value={parameter.key}>{parameter.label} · {parameter.key}</option>)}
                        </select>
                      </label>
                      <label>
                        <span>稳定 Rule ID</span>
                        <input
                          list="gantt-ai-stable-rule-ids"
                          value={ruleTargetForm.stableRuleId}
                          onChange={(event) => updateRuleTarget({ ...ruleTargetForm, stableRuleId: event.target.value })}
                          placeholder="选择现有规则或输入已确认的稳定 ID"
                        />
                        <datalist id="gantt-ai-stable-rule-ids">
                          {stableRulesForParameter.map(({ rule }) => <option key={rule.id} value={rule.id}>{rule.operation}</option>)}
                        </datalist>
                      </label>
                    </div>
                    {selectedFeishuSourceRevision ? <small>sourceRevision {selectedFeishuSourceRevision.sourceRevision} · 仅显示 registry 中 importsRules 的工作表。</small> : null}
                  </div>
                ) : null}
                {isRuleSourceDraft && !hasSafeRuleTarget ? (
                  <div className="gantt-unavailable"><AlertTriangle size={18} /><div><strong>规则源目标缺失</strong><span>缺少 spreadsheetToken、sheetId、stableRuleId、parameterKey 或 sourceRevision；当前只能查看，不能猜测后创建草稿。</span></div></div>
                ) : null}
                <label className="gantt-ai-reason">
                  <span>创建草稿理由</span>
                  <textarea value={userReason} onChange={(event) => updateUserReason(event.target.value)} placeholder="说明为什么采纳这些变化；创建草稿前不能为空。" />
                </label>
              </section>
            ) : null}
            {evidenceOpen && selectedRecommendation && aiAssessment?.result ? (
              <section className="gantt-ai-evidence">
                <header><span className="eyebrow">EVIDENCE & UNCERTAINTY</span><h4>依据、假设与未覆盖信息</h4></header>
                <div>
                  <strong>可追溯依据</strong>
                  {selectedRecommendation.evidenceAliases.length
                    ? (
                      <ul>
                        {selectedRecommendation.evidenceAliases.map((alias) => {
                          const evidence = aiAssessment.result?.resolvedEvidenceRefs?.find((entry) =>
                            entry.evidenceAlias === alias);
                          return (
                            <li key={alias}>
                              {evidence
                                ? (
                                  <>
                                    <b>{evidence.evidenceType}</b>
                                    {" · "}{evidence.refId}
                                    {evidence.revisionId ? ` @ ${evidence.revisionId}` : ""}
                                    <small> · hash {evidence.contentHash}</small>
                                  </>
                                )
                                : <><b>{alias}</b> · 本地稳定引用不可用</>}
                            </li>
                          );
                        })}
                      </ul>
                    )
                    : <p>没有依据引用；该建议不能转换为草稿。</p>}
                </div>
                <div>
                  <strong>假设</strong>
                  {aiAssessment.result.assumptions.length
                    ? <ul>{aiAssessment.result.assumptions.map((assumption, index) => <li key={`${index}:${assumption}`}>{assumption}</li>)}</ul>
                    : <p>没有声明额外假设。</p>}
                </div>
                <div>
                  <strong>未覆盖信息</strong>
                  {aiAssessment.result.uncoveredInformation.length
                    ? <ul>{aiAssessment.result.uncoveredInformation.map((entry, index) => <li key={`${index}:${entry}`}>{entry}</li>)}</ul>
                    : <p>没有声明未覆盖信息。</p>}
                </div>
              </section>
            ) : null}
            {previewState.error ? (
              <div className="gantt-unavailable"><AlertTriangle size={18} /><div><strong>转换未完成</strong><span>{previewState.error}</span></div></div>
            ) : null}
            {previewState.status === "success" && previewState.payload ? (
              <section className="gantt-ai-preview">
                <header>
                  <div><span className="eyebrow">DETERMINISTIC PREVIEW</span><h4>确定性差异预览</h4></div>
                  <small>{previewState.payload.previewHash?.slice(0, 12)}</small>
                </header>
                <div className="gantt-ai-preview-scope"><b>作用域</b><span>{renderAIValue(previewState.payload.targetRef ?? previewState.payload.scope ?? { entityId: model.id, revisionId: String(model.revision) })}</span></div>
                <div className="gantt-ai-change-table">
                  <div><b>属性</b><b>before</b><b>operation</b><b>operand</b><b>after</b></div>
                  {previewState.payload.changes?.map((change, index) => (
                    <div key={change.changeId ?? `${change.parameterKey}:${index}`}>
                      <strong>{change.parameterKey}</strong>
                      <span>{renderAIValue(change.before)}</span>
                      <span>{change.operation}</span>
                      <span>{renderAIValue(change.operand)}</span>
                      <span>{renderAIValue(change.after)}</span>
                    </div>
                  ))}
                </div>
                <div className="gantt-ai-diff-grid">
                  <article><span>Validation / Issue</span><strong>{previewState.payload.diffs?.validation?.newBlockingIssueCodes?.length ? "新增阻断" : "无新增阻断"}</strong><small>before {(previewState.payload.diffs?.validation?.beforeIssueCodes ?? []).join("、") || "无"}<br />after {(previewState.payload.diffs?.validation?.afterIssueCodes ?? []).join("、") || "无"}</small></article>
                  <article><span>五维</span><strong>{previewState.payload.diffs?.fiveAxis?.status ?? "未返回"}</strong><small>{previewState.payload.diffs?.fiveAxis?.affectedAxisIds?.join("、") || "无受影响轴"}</small></article>
                  <article><span>Affinity</span><strong>{previewState.payload.diffs?.affinity?.status ?? "未返回"}</strong><small>AI 不覆盖规则化软评分</small></article>
                  <article><span>Series 不变量</span><strong>{previewState.payload.diffs?.invariants?.newBlockingIssueCodes?.length ? "新增阻断" : "无新增阻断"}</strong><small>after {(previewState.payload.diffs?.invariants?.afterIssueCodes ?? []).join("、") || "无"}</small></article>
                </div>
              </section>
            ) : null}
            {deleteConfirmationOpen && aiAssessment?.assessmentId ? (
              <section className="gantt-ai-delete-confirmation" aria-label="删除这次 AI 评估">
                <header>
                  <div>
                    <span className="eyebrow">DELETE ASSESSMENT</span>
                    <h4>删除这次 AI 评估？</h4>
                  </div>
                  <Trash2 size={18} aria-hidden="true" />
                </header>
                <p>删除后，这次评估会立即从工作台隐藏，并进入主存储和备份的清理流程。</p>
                <strong>已采纳产物的来源记录会永久保留，不会随这次评估删除。</strong>
                <label>
                  <input
                    type="checkbox"
                    checked={deletePermanentlyRetainedAcknowledged}
                    disabled={deleteRunning}
                    onChange={(event) => setDeletePermanentlyRetainedAcknowledged(event.target.checked)}
                  />
                  <span>我已了解：已采纳的 Patch 或规则草稿仍会保留这次评估的来源记录。</span>
                </label>
                {deleteError ? <small role="alert">{deleteError}</small> : null}
                <footer>
                  <button type="button" disabled={deleteRunning} onClick={closeDeleteConfirmation}>取消</button>
                  <button
                    type="button"
                    className="danger"
                    disabled={!deletePermanentlyRetainedAcknowledged || deleteRunning}
                    onClick={() => void deleteAssessment()}
                  >
                    {deleteRunning ? "删除中…" : "确认删除评估"}
                  </button>
                </footer>
              </section>
            ) : null}
            <div className="gantt-ai-actions">
              <button type="button" disabled={!selectedRecommendation} title={!selectedRecommendation ? "请先选择一条建议。" : undefined} onClick={() => setEvidenceOpen((current) => !current)}>{evidenceOpen ? "收起依据" : "查看依据"}</button>
              <button
                type="button"
                disabled={!selectedRecommendationDraftable || !freshnessAllowsDraft || frozenTargetBlocksDraft || !hasSafeRuleTarget || !selectedDraftAvailability.enabled || !evidenceOpen || previewState.status === "running" || previewState.status === "creating"}
                title={frozenTargetBlocksDraft
                  ? "冻结 Model 只能查看建议。"
                  : !hasSafeRuleTarget
                    ? "请先选择可验证的规则源目标。"
                    : !selectedDraftAvailability.enabled
                      ? selectedDraftAvailability.disabledReasonText
                      : !evidenceOpen
                        ? "请先查看依据、假设与未覆盖信息。"
                        : undefined}
                onClick={() => void requestDraftAction("preview")}
              >
                {previewState.status === "running" ? "预览中…" : "预览变化"}
              </button>
              <button
                type="button"
                className="v3-primary-action"
                disabled={Boolean(createDisabledReason) || previewState.status === "creating" || previewState.status === "running"}
                title={createDisabledReason}
                onClick={() => void requestDraftAction("create")}
              >
                {previewState.status === "creating"
                  ? "创建中…"
                  : isRuleSourceDraft
                    ? "创建规则源变更草稿"
                    : "创建 Model Patch 草稿"}
              </button>
              <button type="button" disabled={!selectedRecommendation || dismissRunning} onClick={() => void dismissRecommendation()}>{dismissRunning ? "保存中…" : "忽略"}</button>
              <button type="button" disabled={!aiAvailability.enabled || aiAssessment?.status === "running"} title={aiAvailability.disabledReasonText} onClick={onRunAssessment}>{aiAssessment?.status === "running" ? "评估中…" : "重新评估"}</button>
              <button
                type="button"
                className="danger"
                disabled={!aiAssessment?.assessmentId || deleteRunning}
                onClick={() => {
                  setDeleteConfirmationOpen(true);
                  setDeletePermanentlyRetainedAcknowledged(false);
                  setDeleteError("");
                }}
              >
                删除这次评估
              </button>
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
  workspaceFreshness,
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
  const [aiAssessment, setAiAssessment] = useState<AIAssessmentUiState>();
  const beginWorkspaceReplacement = (): number | undefined => {
    const freshness = workspaceFreshness();
    if (freshness.dirty) {
      notify(DIRTY_WORKSPACE_CONFIRMATION_MESSAGE);
      return undefined;
    }
    return freshness.revision;
  };
  const applyWorkspaceReplacement = (expectedRevision: number, nextState: WorkspaceState, nextRevision: number, message: string): boolean => {
    const applyCheck = canApplyConfirmedWorkspace({ ...workspaceFreshness(), expectedRevision });
    if (!applyCheck.allowed) {
      notify(applyCheck.reason);
      return false;
    }
    onWorkspaceApplied(nextState, nextRevision, message);
    return true;
  };
  const enabledItemParts = useMemo(
    () => enabledProductItemParts(state.itemParts),
    [state.itemParts],
  );
  const [skuPullChangePending, setSkuPullChangePending] = useState(false);

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
    ? state.skuDrawers.filter(
      (sku) =>
        sku.seriesId === selectedSeries.id
        && sku.status !== "superseded"
        && isProductSkuChainEnabled(selectedSeries, sku, state.skuDrawers),
    )
      .sort((left, right) => left.targetPullKg - right.targetPullKg || left.id.localeCompare(right.id))
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
    () => [...new Set(filterCatalog.flatMap((block) => block.skuNodes.map((node) => node.targetPullKg)))]
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
  // 此按钮只导航到 Series/Patch 上下文，不执行 Rebase 写命令。
  // 真正的状态写只能使用 rebase_patch + 服务端命令载荷引用。
  const rebaseRouteAvailability = openSeriesAvailability;
  const createSeriesAvailability = actionAvailabilities.create_series;
  const aiAvailability = actionAvailabilities.run_ai_assessment;
  const aiPatchDraftAvailability = actionAvailabilities.create_ai_patch_draft;
  const aiRuleDraftAvailability = actionAvailabilities.create_ai_rule_source_change_draft;
  const runAiAssessment = async (scopeType: "series" | "model", scopeId: string) => {
    const scopeKey = `${scopeType}:${scopeId}`;
    setAiAssessment({ scopeKey, status: "running" });
    try {
      const response = await fetch("/api/ai/assessments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopeType, scopeId }),
      });
      const payload = await response.json().catch(() => null) as (AIAssessmentUiState & { error?: string }) | null;
      if (!response.ok || !payload?.result) throw new Error(payload?.error ?? "AI 评估未完成。");
      const retainedResponse = payload.assessmentId
        ? await fetch(`/api/ai/assessments/${encodeURIComponent(payload.assessmentId)}`, { method: "GET" })
        : undefined;
      const retainedPayload = retainedResponse?.ok
        ? await retainedResponse.json().catch(() => null) as Parameters<typeof normalizedAssessmentPayload>[0]
        : null;
      const retainedAssessment = normalizedAssessmentPayload(retainedPayload, scopeKey);
      setAiAssessment(retainedAssessment ?? { ...payload, scopeKey, status: "success" });
      notify(`AI 评估完成：${payload.result.findings.length} 条发现，${payload.result.recommendations.length} 条建议。`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "AI 评估未完成。";
      setAiAssessment({ scopeKey, status: "error", error: message });
      notify(message);
    }
  };
  const assessmentRestoreScopeType = drawerModel ? "model" as const : "series" as const;
  const assessmentRestoreScopeId = drawerModel?.id ?? selectedSeries?.id ?? "";
  useEffect(() => {
    if (!assessmentRestoreScopeId) return;
    const scopeKey = `${assessmentRestoreScopeType}:${assessmentRestoreScopeId}`;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/ai/assessments?scopeType=${assessmentRestoreScopeType}&scopeId=${encodeURIComponent(assessmentRestoreScopeId)}`,
          { method: "GET", signal: controller.signal },
        );
        if (response.status === 404) {
          setAiAssessment((currentAssessment) =>
            currentAssessment?.scopeKey === scopeKey && currentAssessment.status === "running"
              ? currentAssessment
              : undefined);
          return;
        }
        const payload = await response.json().catch(() => null) as Parameters<typeof normalizedAssessmentPayload>[0];
        const normalized = normalizedAssessmentPayload(payload, scopeKey);
        if (!response.ok || !normalized) {
          throw new Error(payload?.error ?? "无法恢复最近一次 AI 评估。");
        }
        setAiAssessment((currentAssessment) =>
          currentAssessment?.scopeKey === scopeKey && currentAssessment.status === "running"
            ? currentAssessment
            : normalized);
      } catch (caught) {
        if (controller.signal.aborted) return;
        const message = caught instanceof Error ? caught.message : "无法恢复最近一次 AI 评估。";
        setAiAssessment((currentAssessment) =>
          currentAssessment?.scopeKey === scopeKey && currentAssessment.status === "running"
            ? currentAssessment
            : { scopeKey, status: "error", error: message });
      }
    })();
    return () => controller.abort();
  }, [
    assessmentRestoreScopeId,
    assessmentRestoreScopeType,
  ]);
  const changeSkuTargetPullAvailability =
    actionAvailabilities.change_sku_target_pull;
  const contextBreadcrumbView = buildProductBreadcrumbView({
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
  const contextBreadcrumbs = contextBreadcrumbView.breadcrumbs;
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
      if (deepLink.unavailable && !deepLink.snapshot && drawerSnapshotId) {
        setDrawerSnapshotId("");
        notify("请求的冻结快照不可见或已不存在，已退回最近可见对象。");
        return;
      }
      if (deepLink.unavailable && !deepLink.model && drawerModelId) {
        setDrawerModelId("");
        if (deepLink.series) setSelectedSeriesId(deepLink.series.id);
        if (deepLink.sku) setSelectedSkuId(deepLink.sku.id);
        notify("请求的 Model 不可见或已不存在，已退回最近可见父级。");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [deepLink, drawerModelId, drawerSnapshotId, notify]);

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
    const expectedWorkspaceRevision = beginWorkspaceReplacement();
    if (expectedWorkspaceRevision === undefined) return;
    // Series 创建是服务端领域命令：写入由服务端重新鉴权 series.edit（create_series），
    // 结构标杆匹配、拉力规划与 SKU 物化都在服务端完成后按 revision 受保护地提交，
    // 客户端不能绕过 series.edit 直接写整包（规范 §24.1/§24.4/§25.1）。
    try {
      const idempotencyKey = `create-series:${draft.seriesId}`;
      const businessPayload = {
        idempotencyKey,
        seriesId: draft.seriesId,
        name: draft.name,
        concept: draft.concept,
        collectionId: draft.collectionId || undefined,
        itemPartId: draft.itemPartId,
        methodId: draft.methodId,
        typeId: draft.typeId,
        functionId: draft.functionId,
        qualityId: draft.qualityId,
        functionIntensity: draft.functionIntensity,
        planningMinKgf: draft.planningMinKgf,
        planningMaxKgf: draft.planningMaxKgf,
        discretePulls: draft.discretePulls,
      };
      const invocation = await issueClientActionCommand({
        action: "create_series",
        idempotencyKey,
        payload: businessPayload,
      });
      const response = await fetch("/api/series", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invocation),
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
      if (!applyWorkspaceReplacement(expectedWorkspaceRevision,
        payload.state,
        payload.revision ?? 0,
        `已创建 ${payload.series.name}，并物化 ${payload.createdSkuIds?.length ?? 0} 个离散 SKU 抽屉。`,
      )) return;
      setSelectedSeriesId(payload.series.id);
      setSelectedSkuId(payload.createdSkuIds?.[0] ?? "");
      setSeriesCreateDraft(null);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Series 创建失败。");
    }
  };

  const changeSelectedSkuTargetPull = async () => {
    if (
      !selectedSku ||
      !changeSkuTargetPullAvailability.enabled ||
      skuPullChangePending
    ) {
      return;
    }
    const rawTarget = window.prompt(
      `输入新的目标拉力（kgf）。当前为 ${selectedSku.targetPullKg} kgf；提交前会先展示新的结构标杆匹配。`,
      String(selectedSku.targetPullKg),
    );
    if (rawTarget === null) return;
    const targetPullKg = Number(rawTarget.trim());
    if (!Number.isFinite(targetPullKg) || targetPullKg <= 0) {
      notify("目标拉力必须是大于 0 的有限 kgf 数值。");
      return;
    }
    if (targetPullKg === selectedSku.targetPullKg) {
      notify("新目标拉力与当前值相同。");
      return;
    }
    const expectedWorkspaceRevision = beginWorkspaceReplacement();
    if (expectedWorkspaceRevision === undefined) return;
    setSkuPullChangePending(true);
    try {
      const previewResponse = await fetch(
        "/api/skus/target-pull/preview",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            skuId: selectedSku.id,
            expectedRevision: selectedSku.revision,
            targetPullKg,
          }),
        },
      );
      const previewPayload = (await previewResponse.json().catch(() => null)) as
        | {
          projectionMatch?: ProjectionMatch;
          mode?: "SAME_SKU_NEW_REVISION" | "REPLACEMENT_SKU";
          publishedDescendantFingerprint?: string;
          error?: string;
        }
        | null;
      if (
        !previewResponse.ok ||
        !previewPayload?.projectionMatch ||
        !previewPayload.mode ||
        !previewPayload.publishedDescendantFingerprint
      ) {
        notify(previewPayload?.error ?? "无法预览新的结构标杆匹配。");
        return;
      }
      const match = previewPayload.projectionMatch;
      const confirmed = window.confirm(
        [
          `确认把 ${selectedSku.id} 从 ${selectedSku.targetPullKg} kgf 改为 ${targetPullKg} kgf？`,
          `显式匹配：${match.projectionId}（结构拉力 ${match.matchedStructuralPullKg} kgf，规则 ${match.ruleSetVersion}）。`,
          previewPayload.mode === "REPLACEMENT_SKU"
            ? "检测到已发布后代：系统会创建新 SKU，并将旧 SKU 标记为 DEPRECATED；旧快照不会改写。"
            : "未检测到已发布后代：系统会保留 skuId 并创建新 revision。",
        ].join("\n\n"),
      );
      if (!confirmed) return;

      const replacementSkuId = `sku:${crypto.randomUUID()}`;
      const idempotencyKey =
        `change-sku-target-pull:${selectedSku.id}:` +
        `${selectedSku.revision}:${crypto.randomUUID()}`;
      const businessPayload = {
        skuId: selectedSku.id,
        expectedRevision: selectedSku.revision,
        targetPullKg,
        projectionMatch: match,
        expectedMode: previewPayload.mode,
        publishedDescendantFingerprint:
          previewPayload.publishedDescendantFingerprint,
        replacementSkuId,
        deprecateOriginal: true,
        idempotencyKey,
      };
      const invocation = await issueClientActionCommand({
        action: "change_sku_target_pull",
        idempotencyKey,
        payload: businessPayload,
      });
      const response = await fetch("/api/skus/target-pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invocation),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
          state?: WorkspaceState;
          sku?: SkuDrawer;
          mode?: "SAME_SKU_NEW_REVISION" | "REPLACEMENT_SKU";
          revision?: number;
          error?: string;
        }
        | null;
      if (!response.ok || !payload?.state || !payload.sku) {
        notify(payload?.error ?? "SKU 目标拉力变更失败。");
        return;
      }
      if (!applyWorkspaceReplacement(expectedWorkspaceRevision,
        payload.state,
        payload.revision ?? 0,
        payload.mode === "REPLACEMENT_SKU"
          ? `已创建新 SKU ${payload.sku.id}；旧 SKU 与已发布快照保持冻结。`
          : `已将 ${payload.sku.id} 更新到 revision ${payload.sku.revision}。`,
      )) return;
      setSelectedSkuId(payload.sku.id);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "SKU 目标拉力变更失败。");
    } finally {
      setSkuPullChangePending(false);
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
          <button type="button" disabled={!aiAvailability.enabled || !selectedSeries || aiAssessment?.status === "running"} title={aiAvailability.disabledReasonText} onClick={() => selectedSeries && void runAiAssessment("series", selectedSeries.id)}>{aiAssessment?.status === "running" && aiAssessment.scopeKey.startsWith("series:") ? "AI 评估中…" : "AI 评估"}</button>
        </div>
      </section>
      <ProductDeepLinkUnavailableNotice unavailable={contextBreadcrumbView.unavailable} />

      <section className="gantt-filter-bar" aria-label="甘特图筛选">
        <span><ListFilter size={15} />筛选</span>
        <MultiSelectFilter label="Collection" values={query.collectionIds} options={state.collections.map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(values) => setQuery((current) => ({ ...current, collectionIds: values }))} />
        <MultiSelectFilter label="钓法" values={query.methodIds} options={state.methodProfiles.filter((entry) => entry.enabled).map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(values) => setQuery((current) => ({ ...current, methodIds: values }))} />
        <MultiSelectFilter label="类型" values={query.typeIds} options={state.itemTypeProfiles.filter((entry) => entry.enabled).map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(values) => setQuery((current) => ({ ...current, typeIds: values }))} />
        <MultiSelectFilter label="品质" values={query.qualityIds} options={QUALITY_ORDER.map((entry) => ({ value: entry.id, label: `${entry.letter} / ${entry.name}` }))} onChange={(values) => setQuery((current) => ({ ...current, qualityIds: values }))} />
        <MultiSelectFilter label="功能" values={query.functionIds} options={state.functionProfiles.filter((entry) => entry.enabled).map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(values) => setQuery((current) => ({ ...current, functionIds: values }))} />
        <MultiSelectFilter label="部位" values={query.itemPartIds} options={enabledItemParts.map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(values) => setQuery((current) => ({ ...current, itemPartIds: values }))} />
        <MultiSelectFilter label="生命周期" values={query.lifecycleStates} options={[{ value: "ACTIVE" as const, label: "活跃" }, { value: "DEPRECATED" as const, label: "已废弃" }, { value: "ARCHIVED" as const, label: "已归档" }]} onChange={(values) => setQuery((current) => ({ ...current, lifecycleStates: values }))} />
        <MultiSelectFilter label="注意状态" values={query.attentionStates} options={[{ value: "HAS_UPGRADE_CANDIDATE" as const, label: "升级候选" }, { value: "REBASE_REQUIRED" as const, label: "需要 Rebase" }, { value: "SOURCE_STALE" as const, label: "规则源过期" }, { value: "IMPORT_CONFLICT" as const, label: "导入冲突" }, { value: "EXPORT_RELATION_BROKEN" as const, label: "导出关系断裂" }]} onChange={(values) => setQuery((current) => ({ ...current, attentionStates: values }))} />
        <MultiSelectFilter label="Issue 级别" values={query.issueSeverities} options={[{ value: "BLOCKER" as const, label: "阻断" }, { value: "ERROR" as const, label: "错误" }, { value: "WARNING" as const, label: "警告" }, { value: "INFO" as const, label: "信息" }]} onChange={(values) => setQuery((current) => ({ ...current, issueSeverities: values }))} />
        <MultiSelectFilter label="Issue" values={query.issueCodes} options={issueCodes.map((value) => ({ value, label: value }))} onChange={(values) => setQuery((current) => ({ ...current, issueCodes: values }))} />
        <MultiSelectFilter label="精确目标拉力" values={query.exactTargetPullKg} options={weights.map((value) => ({ value, label: `${value} kgf` }))} onChange={(values) => setQuery((current) => ({ ...current, exactTargetPullKg: values }))} />
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
            const rowIndexes = block.skuNodes.map((sku) => weights.indexOf(sku.targetPullKg)).filter((index) => index >= 0);
            if (!rowIndexes.length) return null;
            const minRow = Math.min(...rowIndexes);
            const maxRow = Math.max(...rowIndexes);
            const color = QUALITY_ORDER[Math.max(0, qualityIndex)]?.color ?? "#586675";
            return (
              <div className={`gantt-series-block ${selectedSeries?.id === block.seriesId ? "selected" : ""}`} key={block.seriesId} style={{ gridColumn: column, gridRow: `${minRow + 1} / ${maxRow + 2}`, "--series-color": color } as React.CSSProperties}>
                <button type="button" className="gantt-series-select" onClick={() => selectSeries(block.seriesId)}>
                  <strong>{block.name}</strong>
                  <small>{block.aggregate.skuCount} SKU · {block.aggregate.modelCountMatched} Model</small>
                  <span className={`gantt-primary-state ${block.aggregate.primary.toLowerCase()}`}>{statusText(block.aggregate.primary)}</span>
                  <span className="gantt-secondary-counts">
                    {block.aggregate.hardBlockingCount ? <em>{block.aggregate.hardBlockingCount} 阻断</em> : null}
                    {block.aggregate.warningCount ? <em>{block.aggregate.warningCount} 警告</em> : null}
                    {block.aggregate.pendingUpgradeCount ? <em>{block.aggregate.pendingUpgradeCount} 升级</em> : null}
                  </span>
                </button>
                {block.skuNodes.map((sku) => {
                  const denominator = Math.max(1, maxRow - minRow);
                  const offset = ((weights.indexOf(sku.targetPullKg) - minRow) / denominator) * 100;
                  return (
                    <button type="button" className={`gantt-sku-node ${selectedSku?.id === sku.skuId ? "selected" : ""}`} key={sku.skuId} style={{ top: `calc(${offset}% - 8px)` }} title={`${sku.targetPullKg} kgf · ${sku.modelIds.length} 个可见 Model · ${sku.validationIssues.length} Issue`} onClick={() => selectSku(block.seriesId, sku.skuId)}>
                      <span />{sku.targetPullKg}<small>{sku.modelIds.length}</small>
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
            {seriesSkus.map((sku) => <button type="button" key={sku.id} className={selectedSku?.id === sku.id ? "active" : ""} onClick={() => selectSku(selectedSeries.id, sku.id)}><strong>{sku.targetPullKg} kgf</strong><span>离散规格 · SKU 抽屉 · {sku.modelIds.length} Model · rev {sku.revision}</span></button>)}
          </div>
          {selectedSku ? (
            <div className="gantt-model-list">
              <div className="gantt-model-list-head">
                <span>Model · 实际购买对象</span>
                <span>配置</span>
                <span>生命周期</span>
                <button
                  type="button"
                  disabled={
                    skuPullChangePending ||
                    !changeSkuTargetPullAvailability.enabled ||
                    selectedSku.status === "superseded"
                  }
                  title={
                    selectedSku.status === "superseded"
                      ? "DEPRECATED SKU 只保留历史追溯，不能再次修改目标拉力。"
                      : changeSkuTargetPullAvailability.disabledReasonText
                  }
                  onClick={() => void changeSelectedSkuTargetPull()}
                >
                  <Scale size={14} />
                  {skuPullChangePending ? "处理中…" : "修改目标拉力"}
                </button>
              </div>
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
          <SeriesAssessmentPanel
            key={`${selectedSeries.id}:${aiAssessment?.assessmentId ?? "none"}`}
            series={selectedSeries}
            aiAvailability={aiAvailability}
            aiAssessment={aiAssessment?.scopeKey === `series:${selectedSeries.id}` ? aiAssessment : undefined}
            onRunAssessment={() => void runAiAssessment("series", selectedSeries.id)}
            onAssessmentDeleted={(assessmentId) => setAiAssessment((currentAssessment) =>
              clearMatchingAssessment(currentAssessment, `series:${selectedSeries.id}`, assessmentId))}
            notify={notify}
          />
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
          <ModelDrawer key={`${drawerModel.id}:${drawerModel.revision}:${aiAssessment?.assessmentId ?? "none"}`} state={state} workspaceId={workspaceId} model={drawerModel} sku={drawerSku} series={drawerSeries} snapshot={drawerSnapshot} currentEntityType={drawerSnapshotId ? "configuration_snapshot" : "model"} comparisonModelIds={comparisonModelIds} rebaseEnabled={Boolean(drawerSeries) && rebaseRouteAvailability.enabled} rebaseDisabledReason={drawerSeries ? rebaseRouteAvailability.disabledReasonText : "父级 Series 不可见，不能进入 Rebase。"} aiAvailability={aiAvailability} aiPatchDraftAvailability={aiPatchDraftAvailability} aiRuleDraftAvailability={aiRuleDraftAvailability} aiAssessment={aiAssessment?.scopeKey === `model:${drawerModel.id}` ? aiAssessment : undefined} onRunAssessment={() => void runAiAssessment("model", drawerModel.id)} onAssessmentDeleted={(assessmentId) => setAiAssessment((currentAssessment) => currentAssessment?.assessmentId === assessmentId ? undefined : currentAssessment)} onWorkspaceApplied={onWorkspaceApplied} workspaceFreshness={workspaceFreshness} notify={notify} onToggleCompare={toggleCompare} onOpenSnapshot={setDrawerSnapshotId} onOpenRebase={() => { setDrawerModelId(""); setDrawerSnapshotId(""); if (drawerSeries) onOpenSeries(drawerSeries.id); }} onClose={() => { setDrawerModelId(""); setDrawerSnapshotId(""); }} />
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
