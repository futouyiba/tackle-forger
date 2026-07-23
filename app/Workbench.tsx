"use client";

import {
  AlertTriangle,
  Anvil,
  Boxes,
  ChevronRight,
  Check,
  CheckCircle2,
  CloudDownload,
  Database,
  Download,
  FileSpreadsheet,
  GitBranch,
  GitCompareArrows,
  History,
  Layers3,
  ListChecks,
  Link2,
  LockKeyhole,
  LogOut,
  PackageSearch,
  PackageCheck,
  Plus,
  RotateCcw,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  WandSparkles,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { RuleGraphStudio } from "./RuleGraphStudio";
import { V3FlowWorkbench } from "./V3FlowWorkbench";
import { BrowserConfigExportWorkbench as ConfigExportWorkbench } from "./BrowserConfigExportWorkbench";
import { SeriesGanttWorkbenchV3 as SeriesGanttWorkbench } from "./SeriesGanttWorkbenchV3";
import { RuleWorkbookWorkbench } from "./RuleWorkbookWorkbench";
import { PatchLedgerWorkbench } from "./PatchLedgerWorkbench";
import {
  generateCandidatesForRecipe,
  publishCandidate,
  recalculateWorkspace,
  suggestRulesFromOverrides,
} from "@/lib/engine";
import {
  buildSeriesShowcaseLayout,
  showcaseFeatureLabel,
  showcaseQualitySlots,
  showcaseTargetPulls,
  templateTensionRange,
} from "@/lib/showcase";
import { ensureWorkflowFields } from "@/lib/workflow";
import { migrateWorkspaceState } from "@/lib/migrations";
import {
  isProductItemPartEnabled,
  seriesItemPartId,
} from "@/lib/enabled-item-parts";
import {
  buildProductBreadcrumbs,
  type BreadcrumbItem,
} from "@/lib/interaction-contracts";
import {
  parseFeishuSourceLink,
  type ResolvedFeishuSource,
} from "@/lib/feishu-links";
import type {
  AdjustmentRule,
  Affix,
  ApiStatePayload,
  DataSourcePreview,
  DataSourceProfile,
  DataSourceWritebackPreview,
  Candidate,
  DimensionKey,
  ItemKind,
  OfficialSku,
  RevisionInfo,
  SeriesRecipe,
  SeriesShowcaseEntry,
  WorkspaceState,
} from "@/lib/types";

type PageKey =
  | "overview"
  | "v3flow"
  | "templates"
  | "modifiers"
  | "layers"
  | "rulegraph"
  | "affixes"
  | "quality"
  | "recipes"
  | "showcase"
  | "candidates"
  | "skus"
  | "details"
  | "validation"
  | "versions"
  | "rulesource"
  | "patchledger"
  | "exchange";

const dimensionLabels: Record<DimensionKey, string> = {
  structure: "结构类型",
  material: "类型材质",
  function: "功能定位",
  performance: "性能定位",
  technology: "技术",
  series: "特殊系列",
};

const kindLabels: Record<ItemKind, string> = {
  rod: "鱼竿",
  reel: "渔轮",
  line: "鱼线",
};

const pageMeta: Record<PageKey, { title: string; subtitle: string }> = {
  overview: { title: "装备生成总览", subtitle: "基准模板 → 分层修正 → 词条品质 → Model 审核 → 正式 SKU" },
  v3flow: { title: "V3 制造链", subtitle: "最近投影 → 兼容判定 → 严格 Series → SKU 抽屉 → 可购买 Model → 冻结快照" },
  templates: { title: "重量模板", subtitle: "管理钓法 × 大重量段的中性杆轮线基准与动态参数" },
  modifiers: { title: "类型、材质与定位", subtitle: "在纵横矩阵中批量编辑 +、×、覆盖、上下限和公式" },
  layers: { title: "规则层栈", subtitle: "层数越大越特化；后层可以浮动或顶掉前层结果" },
  rulegraph: { title: "规则图与执行中心", subtitle: "DAG 编排、条件分支、手动节点、人工审阅中间表和下游输出" },
  affixes: { title: "词条库", subtitle: "直接属性词条与被动机制词条共同决定装备能力和品质分" },
  quality: { title: "品质评分", subtitle: "有损相加、协同、冲突与品质阈值完全可配置" },
  recipes: { title: "系列 / SKU 配方", subtitle: "系列指定模板、定位约束、必带词条和可选词条池" },
  showcase: { title: "历史系列演示", subtitle: "只读兼容旧 SeriesShowcase 数据；正式 Series 请在钓具系列甘特图创建" },
  candidates: { title: "钓具系列甘特图", subtitle: "按离散重量规划 Series、SKU 抽屉与可购买 Model" },
  skus: { title: "正式 SKU", subtitle: "已发布组合及自动生成的杆、轮、线 ID 和验收结果" },
  details: { title: "杆轮线明细", subtitle: "按正式 SKU 展开具体配置，并可自定义型号、名称与数值" },
  validation: { title: "校验与规则学习", subtitle: "强度闭环、模板覆盖、异常检查和精调规律候选" },
  versions: { title: "版本记录", subtitle: "团队共享配置的保存记录、冲突保护和历史恢复" },
  rulesource: { title: "飞书规则源", subtitle: "检查唯一规则工作簿、显式拉取源修订，并独立创建 RuleSet 草稿" },
  patchledger: { title: "Patch 台账", subtitle: "按稳定对象 ID 审计 Patch revision、操作顺序、Rebase、Snapshot 引用与飞书镜像状态" },
  exchange: { title: "数据交换", subtitle: "治理唯一飞书规则源、完成 Excel 往返，或从冻结快照交付配置表" },
};

const PAGE_KEYS = new Set<PageKey>(Object.keys(pageMeta) as PageKey[]);

const navGroups: Array<{ label: string; items: Array<{ key: PageKey; label: string; icon: typeof Anvil }> }> = [
  {
    label: "建模",
    items: [
      { key: "v3flow", label: "V3 制造链", icon: GitBranch },
      { key: "overview", label: "总览", icon: Anvil },
      { key: "templates", label: "重量模板", icon: Database },
      { key: "modifiers", label: "类型与定位", icon: SlidersHorizontal },
      { key: "layers", label: "规则层栈", icon: Layers3 },
      { key: "rulegraph", label: "规则图执行", icon: GitBranch },
    ],
  },
  {
    label: "品质",
    items: [
      { key: "affixes", label: "词条库", icon: Tag },
      { key: "quality", label: "品质评分", icon: Sparkles },
      { key: "recipes", label: "系列配方", icon: WandSparkles },
      { key: "showcase", label: "历史系列演示", icon: GitCompareArrows },
    ],
  },
  {
    label: "生产",
    items: [
      { key: "candidates", label: "钓具系列甘特图", icon: PackageSearch },
      { key: "skus", label: "正式 SKU", icon: Boxes },
      { key: "details", label: "杆轮线明细", icon: ListChecks },
    ],
  },
  {
    label: "治理",
    items: [
      { key: "validation", label: "校验与学习", icon: ShieldCheck },
      { key: "versions", label: "版本记录", icon: History },
      { key: "patchledger", label: "Patch 台账", icon: GitCompareArrows },
      { key: "exchange", label: "数据交换", icon: FileSpreadsheet },
    ],
  },
];

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function formatNumber(value: number | string | undefined, digits = 2) {
  if (typeof value !== "number") return value ?? "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);
}

function qualityBandDisplayName(band: { id: string; name: string }) {
  return band.id === "gold" || band.name === "金" ? "S / 橙" : band.name;
}

function qualityBandDisplayColor(band: { id: string; name: string; color: string }) {
  return band.id === "gold" || band.name === "金" ? "#f97316" : band.color;
}

function qualityName(state: WorkspaceState, id: string) {
  const band = state.qualityBands.find((item) => item.id === id);
  return band ? qualityBandDisplayName(band) : id;
}

function qualityColor(state: WorkspaceState, id: string) {
  const band = state.qualityBands.find((item) => item.id === id);
  return band ? qualityBandDisplayColor(band) : "#667085";
}

function optionLabel(state: WorkspaceState, id?: string) {
  const option = state.modifiers.find((item) => item.id === id);
  if (!option) return "—";
  return option.name + (String(option.level) === "—" ? "" : " " + option.level);
}

function formatShowcaseRange(min: number, max: number, unit: string) {
  return `${formatNumber(min)}-${formatNumber(max)}${unit}`;
}

function Card({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return <section className={cx("card", className)} style={style}>{children}</section>;
}

function Button({
  children,
  icon: Icon,
  tone = "default",
  size = "md",
  disabled,
  onClick,
  title,
}: {
  children?: React.ReactNode;
  icon?: typeof Plus;
  tone?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md";
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={cx("button", "button-" + tone, "button-" + size)}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {Icon ? <Icon size={size === "sm" ? 14 : 16} strokeWidth={1.8} /> : null}
      {children}
    </button>
  );
}

function TextInput({
  value,
  onChange,
  type = "text",
  className,
  placeholder,
  min,
  step,
}: {
  value: string | number | undefined;
  onChange: (value: string) => void;
  type?: "text" | "number";
  className?: string;
  placeholder?: string;
  min?: number;
  step?: number;
}) {
  return (
    <input
      className={cx("text-input", className)}
      value={value ?? ""}
      type={type}
      min={min}
      step={step}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function SelectInput({
  value,
  onChange,
  children,
  className,
}: {
  value: string | number | undefined;
  onChange: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <select
      className={cx("select-input", className)}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
    >
      {children}
    </select>
  );
}

function Pill({
  children,
  tone = "neutral",
  style,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "blue";
  style?: React.CSSProperties;
}) {
  return (
    <span className={cx("pill", "pill-" + tone)} style={style}>
      {children}
    </span>
  );
}

function EmptyState({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <PackageSearch size={30} strokeWidth={1.4} />
      <strong>{title}</strong>
      <span>{text}</span>
      {action}
    </div>
  );
}

function SheetTable({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("sheet-wrap", className)}>
      <table className="sheet-table">{children}</table>
    </div>
  );
}

function pageKeyForDimension(dimension: DimensionKey) {
  return dimensionLabels[dimension];
}

function ruleCell(rule?: AdjustmentRule) {
  if (!rule) return "";
  const prefixes: Record<string, string> = {
    multiply: "×",
    add: "+",
    set: "=",
    min: "≤",
    max: "≥",
    formula: "ƒ",
  };
  return (prefixes[rule.operation] ?? "") + String(rule.value);
}

function parseRuleCell(
  text: string,
  parameterKey: string,
  existing?: AdjustmentRule,
): AdjustmentRule | null {
  const value = text.trim();
  if (!value) return null;
  const prefix = value[0];
  const operations: Record<string, AdjustmentRule["operation"]> = {
    "×": "multiply",
    "*": "multiply",
    "+": "add",
    "=": "set",
    "≤": "min",
    "≥": "max",
    "ƒ": "formula",
  };
  const operation = operations[prefix] ?? "set";
  const raw = operations[prefix] ? value.slice(1).trim() : value;
  const numeric = Number(raw);
  return {
    id: existing?.id ?? "rule-" + crypto.randomUUID(),
    parameterKey,
    operation,
    value: operation === "formula" || Number.isNaN(numeric) ? raw : numeric,
    notes: existing?.notes ?? "",
  };
}

function copyState<T>(value: T): T {
  return structuredClone(value);
}

export function Workbench({ initialState }: { initialState: WorkspaceState }) {
  const [state, setState] = useState<WorkspaceState>(() => recalculateWorkspace(ensureWorkflowFields(initialState)));
  const [page, setPage] = useState<PageKey>("overview");
  const [pageRouteReady, setPageRouteReady] = useState(false);
  const [routeNonce, setRouteNonce] = useState(0);
  const [contextBreadcrumbs, setContextBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [globalSearch, setGlobalSearch] = useState("");
  const [v3SeriesId, setV3SeriesId] = useState("");
  const [revision, setRevision] = useState(1);
  const [user, setUser] = useState<ApiStatePayload["user"]>({
    email: "", name: "未登录", role: "viewer", authenticated: false, provider: "none",
    capabilities: [] as string[],
    actionAvailability: Object.fromEntries([]) as ApiStatePayload["user"]["actionAvailability"],
  });
  const [authStatus, setAuthStatus] = useState<"checking"|"authenticated"|"unauthenticated"|"error">("checking");
  const [authMessage, setAuthMessage] = useState("");
  const [authErrorCode, setAuthErrorCode] = useState("");
  const [dirty, setDirty] = useState(false);
  const [syncState, setSyncState] = useState<"ready" | "saving" | "saved" | "error">("ready");
  const [toast, setToast] = useState("");
  const [search, setSearch] = useState("");
  const [itemKind, setItemKind] = useState<ItemKind>("rod");
  const [dimension, setDimension] = useState<DimensionKey>("structure");
  const [showParameters, setShowParameters] = useState(false);
  const [selectedLayerId, setSelectedLayerId] = useState("layer-function");
  const [selectedRecipeId, setSelectedRecipeId] = useState("");
  const [showcaseDraft, setShowcaseDraft] = useState<SeriesShowcaseEntry | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [bulkAffixId, setBulkAffixId] = useState("");
  const [candidateStatus, setCandidateStatus] = useState("all");
  const [detailKind, setDetailKind] = useState<ItemKind>("rod");
  const [versions, setVersions] = useState<RevisionInfo[]>(initialState.revisions);
  const fileInput = useRef<HTMLInputElement>(null);
  const [exchangeMode, setExchangeMode] = useState<"excel" | "config">("excel");
  const [sourceCatalogs, setSourceCatalogs] = useState<Record<string, ResolvedFeishuSource>>({});
  const [sourcePreview, setSourcePreview] = useState<DataSourcePreview | null>(null);
  const [writebackPreview, setWritebackPreview] = useState<DataSourceWritebackPreview | null>(null);
  const [sourceAction, setSourceAction] = useState<
    "" | "resolve" | "preview" | "publish" | "writeback-preview" | "writeback"
  >("");

  useEffect(() => {
    const requested = new URL(window.location.href).searchParams.get("page") as PageKey | null;
    const frame = window.requestAnimationFrame(() => {
      if (requested && PAGE_KEYS.has(requested)) setPage(requested);
      setPageRouteReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!pageRouteReady) return;
    const url = new URL(window.location.href);
    url.searchParams.set("page", page);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [page, pageRouteReady]);

  const mutate = (producer: (draft: WorkspaceState) => void, recalculate = true) => {
    if (authStatus !== "authenticated") {
      notify("请先使用公司飞书账号登录；未登录状态不允许编辑。");
      return;
    }
    setState((current) => {
      const draft = copyState(current);
      producer(draft);
      return recalculate ? recalculateWorkspace(draft) : draft;
    });
    setDirty(true);
    setSyncState("ready");
  };

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  const copyServiceDiagnostic = async () => {
    const diagnostic = JSON.stringify({
      errorCode: authErrorCode || "AUTH-UNKNOWN-001",
      location: window.location.href,
      occurredAt: new Date().toISOString(),
    }, null, 2);
    try {
      await navigator.clipboard.writeText(diagnostic);
      notify("诊断信息已复制，可发送给管理员。");
    } catch {
      notify(`请记录错误编号：${authErrorCode || "AUTH-UNKNOWN-001"}`);
    }
  };

  const loadVersions = async () => {
    try {
      const response = await fetch("/api/revisions", { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { revisions: RevisionInfo[] };
        setVersions(payload.revisions);
      }
    } catch {
      // Local preview remains fully usable when the worker is unavailable.
    }
  };

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        const session = (await response.json().catch(() => ({}))) as {
          user?: ApiStatePayload["user"];
          error?: string;
          errorCode?: string;
        };
        if (response.status === 401) { setAuthStatus("unauthenticated"); setAuthMessage(session.error || "请使用公司飞书账号登录。"); setAuthErrorCode(session.errorCode || "AUTH-SESSION-001"); return; }
        if (!response.ok || !session.user) { setAuthStatus("error"); setAuthMessage(session.error || "登录服务暂不可用。"); setAuthErrorCode(session.errorCode || "AUTH-SERVICE-001"); return; }
        setUser(session.user);
        const stateResponse = await fetch("/api/state", { cache: "no-store" });
        if (!stateResponse.ok) throw new Error("state-service");
        const payload = await stateResponse.json() as ApiStatePayload;
        setState(recalculateWorkspace(ensureWorkflowFields(payload.state)));
        setDirty(false);
        setRevision(payload.revision);
        setUser(payload.user);
        setAuthStatus("authenticated"); setAuthMessage(""); setAuthErrorCode("");
        void fetch("/api/revisions", { cache: "no-store" })
          .then(async (revisionResponse) => {
            if (!revisionResponse.ok || !active) return;
            const revisionPayload = (await revisionResponse.json()) as { revisions: RevisionInfo[] };
            setVersions(revisionPayload.revisions);
          })
          .catch(() => undefined);
      })
      .catch(() => {
        if (active) {
          setAuthStatus("error"); setAuthMessage("登录或共享服务暂时不可用，请检查网络后重试。"); setAuthErrorCode("AUTH-SERVICE-001");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const save = async (message = "保存配置修改") => {
    const saveAvailability = user.actionAvailability.save_workspace;
    if (!saveAvailability.enabled) {
      notify(saveAvailability.disabledReasonText ?? "当前账号不能保存工作区。");
      return;
    }
    setSyncState("saving");
    try {
      const response = await fetch("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, baseRevision: revision, message }),
      });
      const payload = (await response.json()) as { revision?: number; error?: string };
      if (!response.ok) throw new Error(payload.error || "保存失败");
      setRevision(payload.revision ?? revision + 1);
      setDirty(false);
      setSyncState("saved");
      notify("已保存为版本 v" + (payload.revision ?? revision + 1));
      void loadVersions();
    } catch (error) {
      setSyncState("error");
      notify(error instanceof Error ? error.message : "保存失败");
    }
  };

  const updateDataSource = (
    index: number,
    key: "name" | "dataset" | "shareUrl" | "appToken" | "tableId" | "viewId" | "enabled" | "notes",
    value: string | boolean,
  ) => {
    mutate((draft) => {
      const source = draft.dataSources[index];
      if (!source) return;
      if (key === "enabled") source.enabled = Boolean(value);
      else if (key === "dataset" && (value === "weight_templates" || value === "modifiers")) {
        source.dataset = value;
      } else if (key === "name") source.name = String(value);
      else if (key === "shareUrl") source.shareUrl = String(value);
      else if (key === "appToken") source.appToken = String(value);
      else if (key === "tableId") source.tableId = String(value);
      else if (key === "viewId") source.viewId = String(value);
      else if (key === "notes") source.notes = String(value);
    }, false);
    setSourcePreview(null);
    setWritebackPreview(null);
    if (key === "shareUrl") {
      setSourceCatalogs((current) => {
        const next = { ...current };
        delete next[state.dataSources[index]?.id ?? ""];
        return next;
      });
    }
  };

  const resolveDataSource = async (
    source: DataSourceProfile,
    index: number,
    selectedTableId = "",
  ) => {
    const availability = user.actionAvailability.resolve_data_source;
    if (!availability.enabled) return notify(availability.disabledReasonText ?? "当前账号不能识别数据源。");
    let parsed;
    try {
      parsed = parseFeishuSourceLink(source.shareUrl);
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法识别飞书链接");
      return;
    }

    mutate((draft) => {
      const target = draft.dataSources[index];
      if (!target) return;
      target.appToken = parsed.appToken;
      target.tableId = selectedTableId || parsed.tableId;
      target.viewId = selectedTableId && selectedTableId !== parsed.tableId ? "" : parsed.viewId;
    }, false);

    setSourceAction("resolve");
    try {
      const response = await fetch("/api/data-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "resolve",
          shareUrl: source.shareUrl,
          selectedTableId,
        }),
      });
      const payload = (await response.json()) as {
        resolved?: ResolvedFeishuSource;
        error?: string;
      };
      if (!response.ok || !payload.resolved) {
        throw new Error(payload.error || "读取飞书数据表失败");
      }
      setSourceCatalogs((current) => ({ ...current, [source.id]: payload.resolved! }));
      mutate((draft) => {
        const target = draft.dataSources[index];
        if (!target) return;
        target.appToken = payload.resolved!.appToken;
        target.tableId = payload.resolved!.tableId;
        target.viewId = payload.resolved!.viewId;
      }, false);
      if (!payload.resolved.tableId) {
        notify("链接已识别，读取到 " + payload.resolved.tables.length + " 张数据表，请选择一张。");
      } else {
        notify("已识别飞书链接和数据表，可以保存后拉取预览。");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "读取飞书数据表失败");
    } finally {
      setSourceAction("");
    }
  };
  const previewDataSource = async (source: DataSourceProfile) => {
    const availability = user.actionAvailability.preview_data_source;
    if (!availability.enabled) return notify(availability.disabledReasonText ?? "当前账号不能预览数据源。");
    if (dirty) {
      notify("请先保存当前配置，再拉取飞书预览。");
      return;
    }
    setSourceAction("preview");
    try {
      const response = await fetch("/api/data-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "preview", source }),
      });
      const payload = (await response.json()) as {
        preview?: DataSourcePreview;
        error?: string;
      };
      if (!response.ok || !payload.preview) {
        throw new Error(payload.error || "拉取预览失败");
      }
      setSourcePreview(payload.preview);
      notify("已拉取 " + payload.preview.recordCount + " 条记录，尚未影响正式版本。");
    } catch (error) {
      notify(error instanceof Error ? error.message : "拉取预览失败");
    } finally {
      setSourceAction("");
    }
  };

  const publishDataSource = async (source: DataSourceProfile) => {
    const availability = user.actionAvailability.publish_data_source;
    if (!availability.enabled) return notify(availability.disabledReasonText ?? "当前账号不能发布数据源。");
    if (!sourcePreview || sourcePreview.sourceId !== source.id) return;
    if (dirty) {
      notify("当前有未保存修改，请保存并重新预览后再发布。");
      return;
    }
    setSourceAction("publish");
    try {
      const response = await fetch("/api/data-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "publish",
          source,
          baseRevision: revision,
          checksum: sourcePreview.checksum,
          sourceFingerprint: sourcePreview.sourceFingerprint,
        }),
      });
      const payload = (await response.json()) as {
        state?: WorkspaceState;
        revision?: number;
        preview?: DataSourcePreview;
        error?: string;
      };
      if (!response.ok || !payload.state || !payload.revision) {
        throw new Error(payload.error || "发布失败");
      }
      setState(recalculateWorkspace(ensureWorkflowFields(payload.state)));
      setRevision(payload.revision);
      setDirty(false);
      setSyncState("saved");
      setSourcePreview(null);
      notify("数据源已发布为正式版本 v" + payload.revision);
      void loadVersions();
    } catch (error) {
      notify(error instanceof Error ? error.message : "发布失败");
    } finally {
      setSourceAction("");
    }
  };

  const previewWriteback = async (source: DataSourceProfile) => {
    const availability = user.actionAvailability.preview_data_source_writeback;
    if (!availability.enabled) return notify(availability.disabledReasonText ?? "当前账号不能检查数据源回写。");
    if (dirty) {
      notify("请先保存当前修改，再检查回写。");
      return;
    }
    setSourceAction("writeback-preview");
    try {
      const response = await fetch("/api/data-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "writeback-preview", source }),
      });
      const payload = (await response.json()) as {
        writebackPreview?: DataSourceWritebackPreview;
        error?: string;
      };
      if (!response.ok || !payload.writebackPreview) {
        throw new Error(payload.error || "检查回写失败");
      }
      setWritebackPreview(payload.writebackPreview);
      setSourcePreview(null);
      const errors = payload.writebackPreview.issues.filter(
        (issue) => issue.level === "error",
      ).length;
      if (errors) notify("发现 " + errors + " 个冲突或字段问题，已阻止回写。");
      else if (!payload.writebackPreview.recordCount) notify("本地数据与飞书一致，无需回写。");
      else {
        notify(
          "发现 " +
            payload.writebackPreview.recordCount +
            " 条本地修订，等待确认回写。",
        );
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "检查回写失败");
    } finally {
      setSourceAction("");
    }
  };

  const publishWriteback = async (source: DataSourceProfile) => {
    const availability = user.actionAvailability.commit_data_source_writeback;
    if (!availability.enabled) return notify(availability.disabledReasonText ?? "当前账号不能回写数据源。");
    if (!writebackPreview || writebackPreview.sourceId !== source.id) return;
    if (dirty) {
      notify("当前有未保存修改，请先保存并重新检查。");
      return;
    }
    setSourceAction("writeback");
    try {
      const response = await fetch("/api/data-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "writeback",
          source,
          baseRevision: revision,
          checksum: writebackPreview.checksum,
          sourceFingerprint: writebackPreview.sourceFingerprint,
        }),
      });
      const payload = (await response.json()) as {
        state?: WorkspaceState;
        revision?: number;
        error?: string;
      };
      if (!response.ok || !payload.state || !payload.revision) {
        throw new Error(payload.error || "回写失败");
      }
      setState(recalculateWorkspace(ensureWorkflowFields(payload.state)));
      setRevision(payload.revision);
      setDirty(false);
      setSyncState("saved");
      setWritebackPreview(null);
      notify("已安全回写飞书，并保存审计版本 v" + payload.revision);
      void loadVersions();
    } catch (error) {
      notify(error instanceof Error ? error.message : "回写失败");
    } finally {
      setSourceAction("");
    }
  };
  const parametersForKind = state.parameters.filter((parameter) => parameter.itemKind === itemKind);
  const filteredCandidates = state.candidates.filter((candidate) => {
    const matchesStatus = candidateStatus === "all" || candidate.status === candidateStatus;
    const haystack = [
      candidate.comboId,
      candidate.seriesName,
      candidate.platformPosition,
      candidate.templateId,
      candidate.useScene,
    ]
      .join(" ")
      .toLowerCase();
    return matchesStatus && haystack.includes(search.toLowerCase());
  });

  const validationRows = useMemo(
    () =>
      state.candidates.flatMap((candidate) =>
        candidate.calculated.issues.map((issue) => ({ candidate, issue })),
      ),
    [state.candidates],
  );

  const qualityStats = useMemo(
    () =>
      state.qualityBands.map((band) => ({
        ...band,
        count: state.candidates.filter(
          (candidate) => candidate.calculated.quality.qualityId === band.id,
        ).length,
      })),
    [state.candidates, state.qualityBands],
  );

  const renameParameter = (oldKey: string, newLabel: string) => {
    const newKey = newLabel.trim();
    if (!newKey || state.parameters.some((item) => item.key === newKey && item.key !== oldKey)) {
      notify("参数名不能为空或重复。");
      return;
    }
    mutate((draft) => {
      const definition = draft.parameters.find((item) => item.key === oldKey);
      if (definition) {
        definition.key = newKey;
        definition.label = newLabel;
      }
      const migrateRecord = (record: Record<string, number | string>) => {
        if (oldKey in record) {
          record[newKey] = record[oldKey];
          delete record[oldKey];
        }
      };
      draft.templates.forEach((template) => migrateRecord(template.values));
      draft.modifiers.forEach((option) =>
        option.rules.forEach((rule) => {
          if (rule.parameterKey === oldKey) rule.parameterKey = newKey;
        }),
      );
      draft.layers.forEach((layer) =>
        layer.rules.forEach((rule) => {
          if (rule.parameterKey === oldKey) rule.parameterKey = newKey;
        }),
      );
      draft.affixes.forEach((affix) =>
        affix.rules.forEach((rule) => {
          if (rule.parameterKey === oldKey) rule.parameterKey = newKey;
        }),
      );
      draft.candidates.forEach((candidate) => migrateRecord(candidate.overrides));
      draft.officialSkus.forEach((sku) => {
        migrateRecord(sku.values);
        migrateRecord(sku.overrides);
      });
      draft.detailOverrides.forEach((detail) => migrateRecord(detail.values));
    });
  };

  const deleteParameter = (key: string) => {
    if (!window.confirm("删除参数“" + key + "”？相关模板值和全部规则也会删除。")) return;
    mutate((draft) => {
      draft.parameters = draft.parameters.filter((item) => item.key !== key);
      draft.templates.forEach((template) => delete template.values[key]);
      draft.modifiers.forEach((option) => {
        option.rules = option.rules.filter((rule) => rule.parameterKey !== key);
      });
      draft.layers.forEach((layer) => {
        layer.rules = layer.rules.filter((rule) => rule.parameterKey !== key);
      });
      draft.affixes.forEach((affix) => {
        affix.rules = affix.rules.filter((rule) => rule.parameterKey !== key);
      });
      draft.candidates.forEach((candidate) => delete candidate.overrides[key]);
    });
  };

  const addParameter = () => {
    const base = kindLabels[itemKind] + "新参数";
    let key = base;
    let index = 2;
    while (state.parameters.some((item) => item.key === key)) {
      key = base + index;
      index += 1;
    }
    mutate((draft) => {
      draft.parameters.push({
        key,
        label: key,
        itemKind,
        unit: "",
        precision: 2,
        notes: "新增参数",
      });
      draft.templates.forEach((template) => {
        template.values[key] = 0;
      });
    });
  };

  const updateModifierRule = (
    optionId: string,
    parameterKey: string,
    text: string,
  ) => {
    mutate((draft) => {
      const option = draft.modifiers.find((item) => item.id === optionId);
      if (!option) return;
      const index = option.rules.findIndex((rule) => rule.parameterKey === parameterKey);
      const parsed = parseRuleCell(text, parameterKey, option.rules[index]);
      if (!parsed && index >= 0) option.rules.splice(index, 1);
      else if (parsed && index >= 0) option.rules[index] = parsed;
      else if (parsed) option.rules.push(parsed);
    });
  };

  const addModifier = () => {
    const id = dimension + ":" + crypto.randomUUID();
    mutate((draft) => {
      draft.modifiers.push({
        id,
        dimension,
        name: "新" + pageKeyForDimension(dimension),
        level: 1,
        itemKinds: ["rod", "reel", "line"],
        rules: [],
        notes: "",
        enabled: true,
      });
    });
  };

  const generateRecipe = (recipe: SeriesRecipe) => {
    mutate((draft) => {
      const current = draft.recipes.find((item) => item.id === recipe.id);
      if (!current) return;
      const generated = generateCandidatesForRecipe(draft, current);
      draft.candidates = draft.candidates.filter(
        (candidate) => candidate.recipeId !== recipe.id || candidate.status === "published",
      );
      draft.candidates.push(...generated);
    });
    setPage("candidates");
    setCandidateStatus("all");
    notify("已按约束生成“" + recipe.name + "”候选。");
  };

  const applyCandidateStatus = (status: Candidate["status"]) => {
    if (!selectedCandidates.size) return;
    mutate((draft) => {
      draft.candidates.forEach((candidate) => {
        if (selectedCandidates.has(candidate.id)) candidate.status = status;
      });
    });
    notify("已批量更新 " + selectedCandidates.size + " 条候选。");
  };

  const applyBulkAffix = () => {
    if (!bulkAffixId || !selectedCandidates.size) return;
    mutate((draft) => {
      draft.candidates.forEach((candidate) => {
        if (selectedCandidates.has(candidate.id) && !candidate.affixIds.includes(bulkAffixId)) {
          candidate.affixIds.push(bulkAffixId);
        }
      });
    });
    notify("已批量追加词条并重算品质。");
  };

  const publishSelected = () => {
    if (!selectedCandidates.size) return;
    mutate((draft) => {
      for (const candidate of draft.candidates) {
        if (!selectedCandidates.has(candidate.id)) continue;
        const sku = publishCandidate(draft, candidate);
        const existing = draft.officialSkus.findIndex((item) => item.comboId === sku.comboId);
        if (existing >= 0) draft.officialSkus[existing] = sku;
        else draft.officialSkus.push(sku);
        candidate.status = "published";
      }
    });
    notify("已发布 " + selectedCandidates.size + " 套正式 SKU。");
    setPage("skus");
  };

  const updateDetail = (
    sku: OfficialSku,
    kind: ItemKind,
    field: "model" | "name" | "notes" | string,
    value: string | number,
  ) => {
    mutate((draft) => {
      let detail = draft.detailOverrides.find(
        (item) => item.skuId === sku.id && item.itemKind === kind,
      );
      if (!detail) {
        detail = {
          skuId: sku.id,
          itemKind: kind,
          model: "",
          name: "",
          values: {},
          notes: "",
        };
        draft.detailOverrides.push(detail);
      }
      if (field === "model" || field === "name" || field === "notes") {
        detail[field] = String(value);
      } else {
        detail.values[field] = value;
      }
    });
  };

  const exportExcel = async () => {
    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    const append = (name: string, rows: Array<Array<string | number | null>>) => {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
    };

    append("01重量模板", [
      ["01｜重量模板（网页导出）"],
      ["模板参数可增删；下表是当前团队共享版本。"],
      ["模板ID", "鱼重下限kg", "鱼重上限kg", "标称鱼重kg", "档位", ...state.parameters.map((item) => item.label), "备注"],
      ...state.templates.map((template) => [
        template.id,
        template.fishMinKg,
        template.fishMaxKg,
        template.nominalFishKg,
        template.tier,
        ...state.parameters.map((parameter) => template.values[parameter.key] ?? null),
        template.notes,
      ]),
    ]);

    for (const currentDimension of ["structure", "material", "function", "performance", "technology", "series"] as DimensionKey[]) {
      const name = {
        structure: "02结构类型",
        material: "02类型材质",
        function: "03功能定位",
        performance: "04性能定位",
        technology: "04技术规则",
        series: "04系列规则",
      }[currentDimension];
      append(name, [
        [dimensionLabels[currentDimension] + "规则矩阵"],
        ["单元格语法：×1.05、+0.02、=固定值、≤上限、≥下限、ƒ公式"],
        ["ID", "名称", "级别", "启用", ...state.parameters.map((item) => item.label), "备注"],
        ...state.modifiers
          .filter((item) => item.dimension === currentDimension)
          .map((option) => [
            option.id,
            option.name,
            String(option.level),
            option.enabled ? "是" : "否",
            ...state.parameters.map((parameter) =>
              ruleCell(option.rules.find((rule) => rule.parameterKey === parameter.key)),
            ),
            option.notes,
          ]),
      ]);
    }

    append("05词条与品质", [
      ["词条ID", "词条名", "类型", "分值", "稀有度", "适用道具", "标签", "冲突", "协同", "效果规则", "说明"],
      ...state.affixes.map((affix) => [
        affix.id,
        affix.name,
        affix.category,
        affix.score,
        affix.rarity,
        affix.itemKinds.join(","),
        affix.tags.join(","),
        affix.conflicts.join(","),
        affix.synergies.join(","),
        affix.rules.map((rule) => rule.parameterKey + ruleCell(rule)).join("; "),
        affix.description,
      ]),
      [],
      ["品质ID", "品质名", "最低分", "最高分", "价格指数", "备注"],
      ...state.qualityBands.map((band) => [
        band.id,
        band.name,
        band.minScore,
        band.maxScore,
        band.priceIndex,
        band.notes,
      ]),
    ]);

    append("06组合SKU", [
      ["组合ID", "平台ID", "平台定位", "模板ID", "鱼重下限kg", "鱼重上限kg", "品质", "系列", "结构类型", "功能定位", "功能级", "性能定位", "性能级", "词条", "调性覆盖", "硬度", "长度m", "使用场景", "杆ID", "轮ID", "线ID", "价格指数", "杆最大拉力", "轮最大拉力", "线最大拉力", "安全工作拉力"],
      ...state.officialSkus.map((sku) => [
        sku.comboId,
        sku.platformId,
        sku.platformPosition,
        sku.templateId,
        sku.fishMinKg,
        sku.fishMaxKg,
        qualityName(state, sku.qualityId),
        sku.seriesName,
        sku.structureName,
        sku.functionName,
        sku.functionLevel,
        sku.performanceName,
        sku.performanceLevel,
        sku.affixIds.map((id) => state.affixes.find((item) => item.id === id)?.name ?? id).join(","),
        sku.tone,
        sku.hardness,
        sku.lengthM,
        sku.useScene,
        sku.rodId,
        sku.reelId,
        sku.lineId,
        sku.priceIndex,
        sku.rodForce,
        sku.reelForce,
        sku.lineForce,
        sku.safeWorkingForce,
      ]),
    ]);

    for (const kind of ["rod", "reel", "line"] as ItemKind[]) {
      const kindParameters = state.parameters.filter((parameter) => parameter.itemKind === kind);
      append(kind === "rod" ? "07杆明细" : kind === "reel" ? "08轮明细" : "09线明细", [
        ["道具ID", "组合ID", "型号", "名字", ...kindParameters.map((item) => item.label), "备注"],
        ...state.officialSkus.map((sku) => {
          const detail = state.detailOverrides.find(
            (item) => item.skuId === sku.id && item.itemKind === kind,
          );
          const itemId = kind === "rod" ? sku.rodId : kind === "reel" ? sku.reelId : sku.lineId;
          return [
            itemId,
            sku.comboId,
            detail?.model ?? "",
            detail?.name ?? "",
            ...kindParameters.map((parameter) => detail?.values[parameter.key] ?? sku.values[parameter.key] ?? null),
            detail?.notes ?? "",
          ];
        }),
      ]);
    }

    append("10系列配方", [
      ["配方ID", "系列名", "平台ID", "平台定位", "模板", "结构", "功能", "性能", "技术", "必带词条", "可选词条池", "槽位", "目标品质", "鱼重下限", "鱼重上限", "场景"],
      ...state.recipes.map((recipe) => [
        recipe.id,
        recipe.name,
        recipe.platformId,
        recipe.platformPosition,
        recipe.templateIds.join(","),
        recipe.structureIds.join(","),
        recipe.functionIds.join(","),
        recipe.performanceIds.join(","),
        recipe.technologyIds.join(","),
        recipe.requiredAffixIds.join(","),
        recipe.optionalAffixPoolIds.join(","),
        recipe.optionalSlots,
        recipe.qualityTarget,
        recipe.fishMinKg,
        recipe.fishMaxKg,
        recipe.useScene,
      ]),
    ]);

    append("11系列演示表", [
      ["系列ID", "系列特点描述", "唯一钓法", "覆盖模板ID", "定义品质", "系列结构", "功能定位", "功能等级", "重量下限kg", "重量上限kg", "拉力下限kgf", "拉力上限kgf", "贯通词条", "发布时间"],
      ...state.seriesShowcases.map((entry) => {
        const structures = entry.structureIds
          .map((id) => state.modifiers.find((item) => item.id === id)?.name ?? id)
          .join(",");
        const functionOption = state.modifiers.find((item) => item.id === entry.functionId);
        const quality = showcaseQualitySlots(state.qualityBands).find((item) => item.qualityId === entry.qualityId);
        const affixes = entry.affixIds
          .map((id) => state.affixes.find((item) => item.id === id)?.name ?? id)
          .join(",");
        return [
          entry.seriesId,
          entry.description,
          entry.fishingMethod,
          entry.templateIds.join(","),
          quality?.key ?? entry.qualityId,
          structures,
          functionOption?.name ?? entry.functionId,
          String(functionOption?.level ?? ""),
          entry.fishMinKg,
          entry.fishMaxKg,
          entry.tensionMinKgf,
          entry.tensionMaxKgf,
          affixes,
          entry.publishedAt,
        ];
      }),
    ]);

    const serialized = JSON.stringify(state);
    const chunks: Array<Array<string | number>> = [["TackleForgerState", state.schemaVersion]];
    for (let index = 0; index < serialized.length; index += 30000) {
      chunks.push([chunks.length, serialized.slice(index, index + 30000)]);
    }
    append("_TackleForgerState", chunks);
    const internal = workbook.SheetNames.indexOf("_TackleForgerState");
    workbook.Workbook = workbook.Workbook ?? {};
    workbook.Workbook.Sheets = workbook.SheetNames.map((name, index) => ({
      name,
      Hidden: index === internal ? 2 : 0,
    }));

    XLSX.writeFile(
      workbook,
      "钓具配置工坊_" + new Date().toISOString().slice(0, 10) + ".xlsx",
      { compression: true },
    );
    notify("已导出完整 Excel 工作簿。");
  };

  const importExcel = async (file: File) => {
    try {
      const availability = user.actionAvailability.import_excel;
      if (!availability.enabled) throw new Error(availability.disabledReasonText ?? "当前账号不能导入 Excel。");
      const form = new FormData();
      form.append("file", file);
      const upload = await fetch("/api/import-file", { method: "POST", body: form });
      const uploadPayload = (await upload.json()) as { error?: string };
      if (!upload.ok) throw new Error(uploadPayload.error ?? "Excel 文件登记失败。");
      const XLSX = await import("xlsx");
      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const internal = workbook.Sheets["_TackleForgerState"];
      if (internal) {
        const rows = XLSX.utils.sheet_to_json<Array<string | number>>(internal, {
          header: 1,
          raw: true,
        });
        const serialized = rows.slice(1).map((row) => String(row[1] ?? "")).join("");
        const imported = migrateWorkspaceState(JSON.parse(serialized));
        setState(recalculateWorkspace(ensureWorkflowFields(imported)));
      } else {
        const sheet = workbook.Sheets["01重量模板"];
        if (!sheet) throw new Error("找不到 01重量模板 或内部状态页。");
        const rows = XLSX.utils.sheet_to_json<Array<string | number | null>>(sheet, {
          header: 1,
          raw: true,
        });
        const headerIndex = rows.findIndex((row) => row[0] === "模板ID");
        if (headerIndex < 0) throw new Error("01重量模板 缺少模板ID表头。");
        const headers = rows[headerIndex].map(String);
        mutate((draft) => {
          const parameterHeaders = headers.slice(5).filter((name) => name && name !== "备注");
          for (const label of parameterHeaders) {
            if (!draft.parameters.some((item) => item.key === label)) {
              const kind: ItemKind = label.startsWith("轮") ? "reel" : label.startsWith("线") || label.startsWith("PE线") ? "line" : "rod";
              draft.parameters.push({ key: label, label, itemKind: kind, unit: "", precision: 2, notes: "Excel 导入" });
            }
          }
          draft.templates = rows.slice(headerIndex + 1).filter((row) => row[0]).map((row) => {
            const values: Record<string, number | string> = {};
            parameterHeaders.forEach((parameter) => {
              const index = headers.indexOf(parameter);
              const value = row[index];
              if (value !== null && value !== undefined && value !== "") values[parameter] = value as number | string;
            });
            return {
              id: String(row[0]),
              name: String(row[4] ?? row[0]),
              fishMinKg: Number(row[1] ?? 0),
              fishMaxKg: Number(row[2] ?? 0),
              nominalFishKg: Number(row[3] ?? 0),
              tier: String(row[4] ?? ""),
              values,
              notes: String(row[headers.indexOf("备注")] ?? "旧版 Excel 导入"),
            };
          });
        });
      }

      setDirty(true);
      notify("Excel 已导入并重算；保存后形成团队版本。");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Excel 导入失败");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const renderOverview = () => {
    const errorCount = validationRows.filter((row) => row.issue.level === "error").length;
    const warningCount = validationRows.filter((row) => row.issue.level === "warning").length;
    return (
      <div className="page-stack">
        <div className="metric-grid">
          {[
            { label: "重量模板", value: state.templates.length, hint: state.parameters.length + " 个动态参数", color: "teal" },
            { label: "规则选项", value: state.modifiers.length, hint: state.layers.length + " 层规则栈", color: "blue" },
            { label: "Model 候选", value: state.candidates.length, hint: state.recipes.length + " 个系列配方", color: "purple" },
            { label: "正式 SKU", value: state.officialSkus.length, hint: errorCount + " 错误 / " + warningCount + " 警告", color: "amber" },
          ].map((metric) => (
            <Card key={metric.label} className={"metric-card metric-" + metric.color}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <small>{metric.hint}</small>
            </Card>
          ))}
        </div>

        <Card className="pipeline-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">生成闭环</span>
              <h2>从标准装备到可发布 SKU</h2>
            </div>
            <Button tone="primary" icon={WandSparkles} onClick={() => setPage("recipes")}>
              开始生成
            </Button>
          </div>
          <div className="pipeline">
            {[
              ["01", "标准模板", "钓法 × 重量段", state.templates.length + " 项"],
              ["02", "分层修正", "类型、定位、技术", state.layers.length + " 层"],
              ["03", "词条品质", "属性 + 被动机制", state.affixes.length + " 条"],
              ["04", "Model 候选", "筛选、比较、精调", state.candidates.length + " 个"],
              ["05", "正式发布", "杆轮线明细", state.officialSkus.length + " 套"],
            ].map(([index, title, subtitle, count], position) => (
              <div className="pipeline-step" key={index}>
                <div className="step-number">{index}</div>
                <strong>{title}</strong>
                <span>{subtitle}</span>
                <Pill tone="blue">{count}</Pill>
                {position < 4 ? <div className="step-line" /> : null}
              </div>
            ))}
          </div>
        </Card>

        <div className="two-column">
          <Card>
            <div className="card-heading">
              <div>
                <span className="eyebrow">品质分布</span>
                <h3>词条评分结果</h3>
              </div>
              <Button size="sm" tone="ghost" onClick={() => setPage("quality")}>查看规则</Button>
            </div>
            <div className="quality-bars">
              {qualityStats.map((band) => {
                const max = Math.max(1, ...qualityStats.map((item) => item.count));
                const displayName = qualityBandDisplayName(band);
                const displayColor = qualityBandDisplayColor(band);
                return (
                  <div className="quality-row" key={band.id}>
                    <span className="quality-dot" style={{ background: displayColor }} />
                    <strong>{displayName}</strong>
                    <div className="bar-track">
                      <span style={{ width: Math.max(4, (band.count / max) * 100) + "%", background: displayColor }} />
                    </div>
                    <span>{band.count}</span>
                  </div>
                );
              })}
            </div>
          </Card>
          <Card>
            <div className="card-heading">
              <div>
                <span className="eyebrow">近期校验</span>
                <h3>需要处理的问题</h3>
              </div>
              <Button size="sm" tone="ghost" onClick={() => setPage("validation")}>全部校验</Button>
            </div>
            <div className="issue-list">
              {validationRows.filter((row) => row.issue.level !== "info").slice(0, 5).map(({ candidate, issue }, index) => (
                <button
                  type="button"
                  key={candidate.id + issue.code + index}
                  onClick={() => {
                    setSelectedCandidateId(candidate.id);
                    setPage("candidates");
                  }}
                >
                  {issue.level === "error" ? <XCircle size={16} /> : <AlertTriangle size={16} />}
                  <span><strong>{candidate.comboId}</strong>{issue.message}</span>
                </button>
              ))}
              {!validationRows.some((row) => row.issue.level !== "info") ? (
                <div className="all-clear"><CheckCircle2 size={22} />当前候选全部通过关键校验</div>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    );
  };

  const renderParameters = () => (
    <div className="parameter-panel">
      <div className="panel-title">
        <div>
          <h3>参数管理</h3>
          <p>参数名会同步迁移模板值、规则、精调和正式 SKU。</p>
        </div>
        <Button icon={Plus} size="sm" onClick={addParameter}>新增{kindLabels[itemKind]}参数</Button>
      </div>
      <SheetTable>
        <thead><tr><th>参数名</th><th>道具</th><th>单位</th><th>精度</th><th>备注</th><th /></tr></thead>
        <tbody>
          {parametersForKind.map((parameter) => (
            <tr key={parameter.key}>
              <td><TextInput value={parameter.label} onChange={(value) => renameParameter(parameter.key, value)} /></td>
              <td>
                <SelectInput
                  value={parameter.itemKind}
                  onChange={(value) => mutate((draft) => {
                    const target = draft.parameters.find((item) => item.key === parameter.key);
                    if (target) target.itemKind = value as ItemKind;
                  })}
                >
                  {Object.entries(kindLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </SelectInput>
              </td>
              <td><TextInput value={parameter.unit} onChange={(value) => mutate((draft) => {
                const target = draft.parameters.find((item) => item.key === parameter.key);
                if (target) target.unit = value;
              }, false)} /></td>
              <td><TextInput type="number" value={parameter.precision} onChange={(value) => mutate((draft) => {
                const target = draft.parameters.find((item) => item.key === parameter.key);
                if (target) target.precision = Number(value);
              }, false)} /></td>
              <td><TextInput value={parameter.notes} onChange={(value) => mutate((draft) => {
                const target = draft.parameters.find((item) => item.key === parameter.key);
                if (target) target.notes = value;
              }, false)} /></td>
              <td><Button icon={Trash2} size="sm" tone="ghost" title="删除参数" onClick={() => deleteParameter(parameter.key)} /></td>
            </tr>
          ))}
        </tbody>
      </SheetTable>
    </div>
  );

  const renderTemplates = () => (
    <div className="page-stack">
      <div className="toolbar">
        <div className="segmented">
          {(["rod", "reel", "line"] as ItemKind[]).map((kind) => (
            <button key={kind} className={itemKind === kind ? "active" : ""} onClick={() => setItemKind(kind)}>
              {kindLabels[kind]}
            </button>
          ))}
        </div>
        <div className="toolbar-spacer" />
        <Button icon={SlidersHorizontal} onClick={() => setShowParameters((value) => !value)}>
          {showParameters ? "收起参数" : "参数管理"}
        </Button>
        <Button icon={Plus} tone="primary" onClick={() => mutate((draft) => {
          const next = draft.templates.length + 1;
          const values: Record<string, number | string> = {};
          draft.parameters.forEach((parameter) => { values[parameter.key] = 0; });
          draft.templates.push({
            id: "T" + String(next).padStart(2, "0"),
            name: "新重量段",
            fishMinKg: 0,
            fishMaxKg: 0,
            nominalFishKg: 0,
            tier: "新档位",
            values,
            notes: "",
          });
        })}>新增模板</Button>
      </div>
      {showParameters ? renderParameters() : null}
      <Card className="flush-card">
        <SheetTable>
          <thead>
            <tr>
              <th className="sticky-col">模板ID</th>
              <th>档位</th>
              <th>鱼重下限kg</th>
              <th>鱼重上限kg</th>
              <th>标称鱼重kg</th>
              {parametersForKind.map((parameter) => <th key={parameter.key}>{parameter.label}<small>{parameter.unit}</small></th>)}
              <th className="wide-col">备注</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.templates.map((template, index) => (
              <tr key={template.id}>
                <td className="sticky-col"><TextInput value={template.id} onChange={(value) => mutate((draft) => { draft.templates[index].id = value; })} /></td>
                <td><TextInput value={template.tier} onChange={(value) => mutate((draft) => { draft.templates[index].tier = value; draft.templates[index].name = value; })} /></td>
                {(["fishMinKg", "fishMaxKg", "nominalFishKg"] as const).map((key) => (
                  <td key={key}><TextInput type="number" value={template[key]} step={0.01} onChange={(value) => mutate((draft) => { draft.templates[index][key] = Number(value); })} /></td>
                ))}
                {parametersForKind.map((parameter) => (
                  <td key={parameter.key}>
                    <TextInput
                      type={typeof template.values[parameter.key] === "number" ? "number" : "text"}
                      step={10 ** -parameter.precision}
                      value={template.values[parameter.key]}
                      onChange={(value) => mutate((draft) => {
                        const current = draft.templates[index].values[parameter.key];
                        draft.templates[index].values[parameter.key] =
                          typeof current === "number" ? Number(value) : value;
                      })}
                    />
                  </td>
                ))}
                <td><TextInput value={template.notes} onChange={(value) => mutate((draft) => { draft.templates[index].notes = value; }, false)} /></td>
                <td><Button icon={Trash2} size="sm" tone="ghost" onClick={() => mutate((draft) => { draft.templates.splice(index, 1); })} /></td>
              </tr>
            ))}
          </tbody>
        </SheetTable>
      </Card>
      <div className="legend-line">
        <Pill tone="blue">批量编辑</Pill>
        表格可横向滚动；所有数字修改会即时重算 Model 候选，便于比较影响。
      </div>
    </div>
  );

  const renderModifiers = () => {
    const options = state.modifiers.filter((option) => option.dimension === dimension);
    return (
      <div className="page-stack">
        <div className="toolbar">
          <div className="segmented scroll-segment">
            {(Object.keys(dimensionLabels) as DimensionKey[]).map((key) => (
              <button key={key} className={dimension === key ? "active" : ""} onClick={() => setDimension(key)}>
                {dimensionLabels[key]}
              </button>
            ))}
          </div>
          <div className="toolbar-spacer" />
          <div className="segmented">
            {(["rod", "reel", "line"] as ItemKind[]).map((kind) => (
              <button key={kind} className={itemKind === kind ? "active" : ""} onClick={() => setItemKind(kind)}>
                {kindLabels[kind]}
              </button>
            ))}
          </div>
          <Button tone="primary" icon={Plus} onClick={addModifier}>新增选项</Button>
        </div>
        <Card className="syntax-card">
          <strong>规则单元格语法</strong>
          <span><kbd>×1.05</kbd> 乘系数</span>
          <span><kbd>+0.02</kbd> 加系数</span>
          <span><kbd>=120</kbd> 覆盖</span>
          <span><kbd>≤150</kbd> 上限</span>
          <span><kbd>≥20</kbd> 下限</span>
          <span><kbd>ƒcurrent*1.05</kbd> 公式</span>
        </Card>
        <Card className="flush-card">
          <SheetTable>
            <thead>
              <tr>
                <th className="sticky-col">启用 / 名称</th>
                <th>级别</th>
                {parametersForKind.map((parameter) => <th key={parameter.key}>{parameter.label}</th>)}
                <th className="wide-col">备注</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {options.map((option) => (
                <tr key={option.id} className={!option.enabled ? "disabled-row" : ""}>
                  <td className="sticky-col option-name-cell">
                    <input type="checkbox" checked={option.enabled} onChange={(event) => mutate((draft) => {
                      const target = draft.modifiers.find((item) => item.id === option.id);
                      if (target) target.enabled = event.target.checked;
                    })} />
                    <TextInput value={option.name} onChange={(value) => mutate((draft) => {
                      const target = draft.modifiers.find((item) => item.id === option.id);
                      if (target) target.name = value;
                    })} />
                  </td>
                  <td><TextInput value={String(option.level)} onChange={(value) => mutate((draft) => {
                    const target = draft.modifiers.find((item) => item.id === option.id);
                    if (target) target.level = Number.isNaN(Number(value)) ? value : Number(value);
                  })} /></td>
                  {parametersForKind.map((parameter) => {
                    const rule = option.rules.find((item) => item.parameterKey === parameter.key);
                    return (
                      <td key={parameter.key} className={rule ? "rule-active" : ""}>
                        <TextInput
                          value={ruleCell(rule)}
                          placeholder="—"
                          onChange={(value) => updateModifierRule(option.id, parameter.key, value)}
                        />
                      </td>
                    );
                  })}
                  <td><TextInput value={option.notes} onChange={(value) => mutate((draft) => {
                    const target = draft.modifiers.find((item) => item.id === option.id);
                    if (target) target.notes = value;
                  }, false)} /></td>
                  <td><Button icon={Trash2} size="sm" tone="ghost" onClick={() => mutate((draft) => {
                    draft.modifiers = draft.modifiers.filter((item) => item.id !== option.id);
                  })} /></td>
                </tr>
              ))}
            </tbody>
          </SheetTable>
        </Card>
      </div>
    );
  };

  const renderLayers = () => {
    const selectedLayer = state.layers.find((layer) => layer.id === selectedLayerId) ?? state.layers[0];
    return (
      <div className="page-stack">
        <div className="toolbar">
          <div className="toolbar-note">拖动顺序用数字精确控制；后层对前层结果继续计算或直接覆盖。</div>
          <div className="toolbar-spacer" />
          <Button icon={Plus} tone="primary" onClick={() => {
            const id = "layer-" + crypto.randomUUID();
            mutate((draft) => draft.layers.push({
              id,
              name: "新规则层",
              order: Math.max(0, ...draft.layers.map((item) => item.order)) + 10,
              enabled: true,
              mode: "global",
              optionIds: [],
              rules: [],
              notes: "",
            }));
            setSelectedLayerId(id);
          }}>新增规则层</Button>
        </div>
        <div className="layer-layout">
          <Card className="flush-card">
            <SheetTable>
              <thead><tr><th>顺序</th><th>启用</th><th>规则层</th><th>模式</th><th>维度</th><th>规则</th><th /></tr></thead>
              <tbody>
                {[...state.layers].sort((a, b) => a.order - b.order).map((layer) => (
                  <tr key={layer.id} className={selectedLayer?.id === layer.id ? "selected-row" : ""} onClick={() => setSelectedLayerId(layer.id)}>
                    <td><TextInput type="number" value={layer.order} onChange={(value) => mutate((draft) => {
                      const target = draft.layers.find((item) => item.id === layer.id);
                      if (target) target.order = Number(value);
                    })} /></td>
                    <td><input type="checkbox" checked={layer.enabled} onChange={(event) => mutate((draft) => {
                      const target = draft.layers.find((item) => item.id === layer.id);
                      if (target) target.enabled = event.target.checked;
                    })} /></td>
                    <td><TextInput value={layer.name} onChange={(value) => mutate((draft) => {
                      const target = draft.layers.find((item) => item.id === layer.id);
                      if (target) target.name = value;
                    }, false)} /></td>
                    <td><Pill tone={layer.mode === "selection" ? "blue" : "neutral"}>{layer.mode === "selection" ? "选项层" : "全局层"}</Pill></td>
                    <td>{layer.dimension ? dimensionLabels[layer.dimension] : "—"}</td>
                    <td>{layer.rules.length}</td>
                    <td><Button icon={Trash2} size="sm" tone="ghost" onClick={() => mutate((draft) => {
                      draft.layers = draft.layers.filter((item) => item.id !== layer.id);
                    })} /></td>
                  </tr>
                ))}
              </tbody>
            </SheetTable>
          </Card>
          {selectedLayer ? (
            <Card className="inspector">
              <div className="panel-title">
                <div><span className="eyebrow">层级 {selectedLayer.order}</span><h3>{selectedLayer.name}</h3></div>
                <Button size="sm" icon={Plus} onClick={() => mutate((draft) => {
                  const target = draft.layers.find((item) => item.id === selectedLayer.id);
                  if (target) target.rules.push({
                    id: "layer-rule-" + crypto.randomUUID(),
                    parameterKey: draft.parameters[0]?.key ?? "",
                    operation: "add",
                    value: 0,
                  });
                })}>添加规则</Button>
              </div>
              <label className="field-label">说明
                <textarea value={selectedLayer.notes} onChange={(event) => mutate((draft) => {
                  const target = draft.layers.find((item) => item.id === selectedLayer.id);
                  if (target) target.notes = event.target.value;
                }, false)} />
              </label>
              <div className="rule-list">
                {selectedLayer.rules.map((rule) => (
                  <div className="structured-rule" key={rule.id}>
                    <SelectInput value={rule.parameterKey} onChange={(value) => mutate((draft) => {
                      const target = draft.layers.find((item) => item.id === selectedLayer.id);
                      const current = target?.rules.find((item) => item.id === rule.id);
                      if (current) current.parameterKey = value;
                    })}>
                      {state.parameters.map((parameter) => <option key={parameter.key} value={parameter.key}>{parameter.label}</option>)}
                    </SelectInput>
                    <SelectInput value={rule.operation} onChange={(value) => mutate((draft) => {
                      const target = draft.layers.find((item) => item.id === selectedLayer.id);
                      const current = target?.rules.find((item) => item.id === rule.id);
                      if (current) current.operation = value as AdjustmentRule["operation"];
                    })}>
                      <option value="add">加</option><option value="multiply">乘</option><option value="set">覆盖</option>
                      <option value="min">上限</option><option value="max">下限</option><option value="formula">公式</option>
                    </SelectInput>
                    <TextInput value={String(rule.value)} onChange={(value) => mutate((draft) => {
                      const target = draft.layers.find((item) => item.id === selectedLayer.id);
                      const current = target?.rules.find((item) => item.id === rule.id);
                      if (current) current.value = current.operation === "formula" || Number.isNaN(Number(value)) ? value : Number(value);
                    })} />
                    <Button icon={Trash2} size="sm" tone="ghost" onClick={() => mutate((draft) => {
                      const target = draft.layers.find((item) => item.id === selectedLayer.id);
                      if (target) target.rules = target.rules.filter((item) => item.id !== rule.id);
                    })} />
                  </div>
                ))}
                {!selectedLayer.rules.length ? <p className="muted">该层目前只应用所选维度选项，没有全局规则。</p> : null}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    );
  };

  const renderAffixes = () => (
    <div className="page-stack">
      <div className="toolbar">
        <div className="toolbar-note">词条规则使用同一套操作符；分值用于品质，属性效果用于装备计算。</div>
        <div className="toolbar-spacer" />
        <div className="segmented">
          {(["rod", "reel", "line"] as ItemKind[]).map((kind) => (
            <button key={kind} className={itemKind === kind ? "active" : ""} onClick={() => setItemKind(kind)}>{kindLabels[kind]}</button>
          ))}
        </div>
        <Button tone="primary" icon={Plus} onClick={() => mutate((draft) => draft.affixes.push({
          id: "affix-" + crypto.randomUUID(),
          name: "新词条",
          category: "stat",
          itemKinds: [itemKind],
          score: 3,
          rarity: "common",
          tags: [],
          conflicts: [],
          synergies: [],
          rules: [],
          description: "",
          notes: "",
          enabled: true,
        }))}>新增词条</Button>
      </div>
      <Card className="flush-card">
        <SheetTable>
          <thead>
            <tr>
              <th className="sticky-col">启用 / 词条</th><th>类型</th><th>分值</th><th>稀有度</th><th>标签</th>
              {parametersForKind.map((parameter) => <th key={parameter.key}>{parameter.label}</th>)}
              <th className="wide-col">机制说明</th><th />
            </tr>
          </thead>
          <tbody>
            {state.affixes.filter((affix) => affix.itemKinds.includes(itemKind)).map((affix) => (
              <tr key={affix.id} className={!affix.enabled ? "disabled-row" : ""}>
                <td className="sticky-col option-name-cell">
                  <input type="checkbox" checked={affix.enabled} onChange={(event) => mutate((draft) => {
                    const target = draft.affixes.find((item) => item.id === affix.id);
                    if (target) target.enabled = event.target.checked;
                  })} />
                  <TextInput value={affix.name} onChange={(value) => mutate((draft) => {
                    const target = draft.affixes.find((item) => item.id === affix.id);
                    if (target) target.name = value;
                  }, false)} />
                </td>
                <td><SelectInput value={affix.category} onChange={(value) => mutate((draft) => {
                  const target = draft.affixes.find((item) => item.id === affix.id);
                  if (target) target.category = value as Affix["category"];
                })}><option value="stat">直接属性</option><option value="passive">被动机制</option></SelectInput></td>
                <td><TextInput type="number" value={affix.score} onChange={(value) => mutate((draft) => {
                  const target = draft.affixes.find((item) => item.id === affix.id);
                  if (target) target.score = Number(value);
                })} /></td>
                <td><SelectInput value={affix.rarity} onChange={(value) => mutate((draft) => {
                  const target = draft.affixes.find((item) => item.id === affix.id);
                  if (target) target.rarity = value as Affix["rarity"];
                })}><option value="common">普通</option><option value="rare">稀有</option><option value="epic">史诗</option></SelectInput></td>
                <td><TextInput value={affix.tags.join(",")} onChange={(value) => mutate((draft) => {
                  const target = draft.affixes.find((item) => item.id === affix.id);
                  if (target) target.tags = value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
                })} /></td>
                {parametersForKind.map((parameter) => {
                  const rule = affix.rules.find((item) => item.parameterKey === parameter.key);
                  return (
                    <td key={parameter.key} className={rule ? "rule-active" : ""}>
                      <TextInput value={ruleCell(rule)} placeholder="—" onChange={(value) => mutate((draft) => {
                        const target = draft.affixes.find((item) => item.id === affix.id);
                        if (!target) return;
                        const index = target.rules.findIndex((item) => item.parameterKey === parameter.key);
                        const parsed = parseRuleCell(value, parameter.key, target.rules[index]);
                        if (!parsed && index >= 0) target.rules.splice(index, 1);
                        else if (parsed && index >= 0) target.rules[index] = parsed;
                        else if (parsed) target.rules.push(parsed);
                      })} />
                    </td>
                  );
                })}
                <td><TextInput value={affix.description} onChange={(value) => mutate((draft) => {
                  const target = draft.affixes.find((item) => item.id === affix.id);
                  if (target) target.description = value;
                }, false)} /></td>
                <td><Button icon={Trash2} size="sm" tone="ghost" onClick={() => mutate((draft) => {
                  draft.affixes = draft.affixes.filter((item) => item.id !== affix.id);
                })} /></td>
              </tr>
            ))}
          </tbody>
        </SheetTable>
      </Card>
      <div className="legend-line"><Pill tone="warning">提示</Pill>同一词条可跨杆、轮、线；切换道具页编辑对应参数效果。</div>
    </div>
  );

  const renderQuality = () => (
    <div className="page-stack">
      <div className="quality-summary-grid">
        {qualityStats.map((band) => (
          <Card key={band.id} className="quality-band-card" style={{ borderTopColor: qualityBandDisplayColor(band) } as React.CSSProperties}>
            <div className="quality-band-name"><span style={{ background: qualityBandDisplayColor(band) }} />{qualityBandDisplayName(band)}</div>
            <strong>{band.count}</strong>
            <span>{band.minScore} – {band.maxScore ?? "∞"} 分</span>
            <small>价格指数 ×{band.priceIndex}</small>
          </Card>
        ))}
      </div>
      <div className="two-column quality-config">
        <Card className="flush-card">
          <div className="panel-title padded"><div><h3>品质阈值</h3><p>按词条最终得分自动划定品质。</p></div><Button icon={Plus} size="sm" onClick={() => mutate((draft) => draft.qualityBands.push({
            id: "quality-" + crypto.randomUUID(),
            name: "新品质",
            color: "#667085",
            minScore: 0,
            maxScore: null,
            priceIndex: 1,
            notes: "",
          }))}>新增档位</Button></div>
          <SheetTable>
            <thead><tr><th>颜色</th><th>品质</th><th>最低分</th><th>最高分</th><th>价格指数</th><th>备注</th><th /></tr></thead>
            <tbody>
              {state.qualityBands.map((band) => (
                <tr key={band.id}>
                  <td><input type="color" value={band.color} onChange={(event) => mutate((draft) => {
                    const target = draft.qualityBands.find((item) => item.id === band.id);
                    if (target) target.color = event.target.value;
                  })} /></td>
                  <td><TextInput value={band.name} onChange={(value) => mutate((draft) => {
                    const target = draft.qualityBands.find((item) => item.id === band.id);
                    if (target) target.name = value;
                  })} /></td>
                  <td><TextInput type="number" value={band.minScore} onChange={(value) => mutate((draft) => {
                    const target = draft.qualityBands.find((item) => item.id === band.id);
                    if (target) target.minScore = Number(value);
                  })} /></td>
                  <td><TextInput type="number" value={band.maxScore ?? ""} placeholder="∞" onChange={(value) => mutate((draft) => {
                    const target = draft.qualityBands.find((item) => item.id === band.id);
                    if (target) target.maxScore = value === "" ? null : Number(value);
                  })} /></td>
                  <td><TextInput type="number" value={band.priceIndex} onChange={(value) => mutate((draft) => {
                    const target = draft.qualityBands.find((item) => item.id === band.id);
                    if (target) target.priceIndex = Number(value);
                  })} /></td>
                  <td><TextInput value={band.notes} onChange={(value) => mutate((draft) => {
                    const target = draft.qualityBands.find((item) => item.id === band.id);
                    if (target) target.notes = value;
                  }, false)} /></td>
                  <td><Button icon={Trash2} size="sm" tone="ghost" onClick={() => mutate((draft) => {
                    draft.qualityBands = draft.qualityBands.filter((item) => item.id !== band.id);
                  })} /></td>
                </tr>
              ))}
            </tbody>
          </SheetTable>
        </Card>
        <Card className="score-policy">
          <div className="panel-title"><div><h3>有损加法</h3><p>相同主标签的词条按顺序递减计分。</p></div></div>
          <label className="field-label">同轴递减系数
            <TextInput value={state.affixScorePolicy.sameAxisFactors.join(", ")} onChange={(value) => mutate((draft) => {
              draft.affixScorePolicy.sameAxisFactors = value.split(/[,，]/).map(Number).filter((item) => Number.isFinite(item) && item >= 0);
            })} />
          </label>
          <div className="form-grid">
            <label className="field-label">协同加分<TextInput type="number" value={state.affixScorePolicy.synergyBonus} onChange={(value) => mutate((draft) => { draft.affixScorePolicy.synergyBonus = Number(value); })} /></label>
            <label className="field-label">冲突扣分<TextInput type="number" value={state.affixScorePolicy.conflictPenalty} onChange={(value) => mutate((draft) => { draft.affixScorePolicy.conflictPenalty = Number(value); })} /></label>
            <label className="field-label">直接属性权重<TextInput type="number" value={state.affixScorePolicy.directWeight} onChange={(value) => mutate((draft) => { draft.affixScorePolicy.directWeight = Number(value); })} /></label>
            <label className="field-label">被动机制权重<TextInput type="number" value={state.affixScorePolicy.passiveWeight} onChange={(value) => mutate((draft) => { draft.affixScorePolicy.passiveWeight = Number(value); })} /></label>
          </div>
          <div className="formula-example">
            <strong>示例</strong>
            <span>6 分强度 + 5 分强度 + 3 分操控</span>
            <code>6×1.00 + 5×0.80 + 3×1.00 = 13 分</code>
          </div>
        </Card>
      </div>
      <Card className="flush-card">
        <div className="panel-title padded"><div><h3>词条关系</h3><p>冲突会扣分，协同会加分；属性效果仍会照常应用。</p></div></div>
        <SheetTable>
          <thead><tr><th>词条</th><th>分类</th><th>基础分</th><th>主标签</th><th>协同</th><th>冲突</th></tr></thead>
          <tbody>{state.affixes.map((affix) => (
            <tr key={affix.id}>
              <td><strong>{affix.name}</strong></td><td>{affix.category === "stat" ? "直接属性" : "被动机制"}</td><td>{affix.score}</td>
              <td>{affix.tags[0] ?? "—"}</td>
              <td>{affix.synergies.map((id) => state.affixes.find((item) => item.id === id)?.name ?? id).join("、") || "—"}</td>
              <td>{affix.conflicts.map((id) => state.affixes.find((item) => item.id === id)?.name ?? id).join("、") || "—"}</td>
            </tr>
          ))}</tbody>
        </SheetTable>
      </Card>
    </div>
  );

  const toggleShowcaseSelection = (
    field: "structureIds" | "affixIds",
    value: string,
  ) => {
    setShowcaseDraft((current) => {
      if (!current) return current;
      const values = current[field];
      return {
        ...current,
        [field]: values.includes(value)
          ? values.filter((item) => item !== value)
          : [...values, value],
      };
    });
  };

  const publishSeriesShowcase = () => {
    if (!showcaseDraft) return;
    const seriesId = showcaseDraft.seriesId.trim();
    const description = showcaseDraft.description.trim();
    const fishingMethod = showcaseDraft.fishingMethod.trim();
    if (!seriesId || !description || !fishingMethod) {
      notify("请填写系列 ID、系列特点和唯一钓法。");
      return;
    }
    if (!showcaseDraft.structureIds.length || !showcaseDraft.functionId || !showcaseDraft.qualityId) {
      notify("请选择至少一种结构、功能定位和品质。");
      return;
    }
    if (showcaseDraft.fishMinKg < 0 || showcaseDraft.fishMaxKg <= showcaseDraft.fishMinKg) {
      notify("重量上限必须大于下限。");
      return;
    }
    const targetPullsKgf = [...new Set(showcaseDraft.targetPullsKgf ?? [])]
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);
    if (!targetPullsKgf.length) {
      notify("请至少填写一个正数目标拉力规格。");
      return;
    }
    const duplicated = state.seriesShowcases.some(
      (item) => item.id !== showcaseDraft.id && item.seriesId.trim().toLowerCase() === seriesId.toLowerCase(),
    );
    if (duplicated) {
      notify("系列 ID 已存在。");
      return;
    }
    const now = new Date().toISOString();
    const templateIds = state.templates
      .filter(
        (template) =>
          showcaseDraft.fishMaxKg > template.fishMinKg &&
          showcaseDraft.fishMinKg < template.fishMaxKg,
      )
      .map((template) => template.id);
    mutate((draft) => {
      const next = {
        ...showcaseDraft,
        seriesId,
        description,
        fishingMethod,
        templateIds,
        updatedAt: now,
      };
      const index = draft.seriesShowcases.findIndex((item) => item.id === next.id);
      if (index >= 0) draft.seriesShowcases[index] = next;
      else draft.seriesShowcases.push(next);
    }, false);
    setShowcaseDraft(null);
    notify("系列“" + seriesId + "”已发布，并自动拆分为 " + templateIds.length + " 个重量段。");
  };

  const deleteSeriesShowcase = () => {
    if (!showcaseDraft) return;
    const exists = state.seriesShowcases.some((item) => item.id === showcaseDraft.id);
    if (!exists) {
      setShowcaseDraft(null);
      return;
    }
    if (!window.confirm("从跨度图移除系列“" + showcaseDraft.seriesId + "”？")) return;
    mutate((draft) => {
      draft.seriesShowcases = draft.seriesShowcases.filter((item) => item.id !== showcaseDraft.id);
    }, false);
    setShowcaseDraft(null);
    notify("系列已从跨度图移除。");
  };

  const toggleRecipeList = (
    recipeId: string,
    field: "templateIds" | "structureIds" | "functionIds" | "performanceIds" | "technologyIds" | "requiredAffixIds" | "optionalAffixPoolIds",
    value: string,
  ) => {
    mutate((draft) => {
      const recipe = draft.recipes.find((item) => item.id === recipeId);
      if (!recipe) return;
      const list = recipe[field];
      recipe[field] = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
    });
  };

  const renderRecipes = () => {
    const selected = state.recipes.find((recipe) => recipe.id === selectedRecipeId) ?? state.recipes[0];
    return (
      <div className="page-stack">
        <div className="toolbar">
          <div className="toolbar-note">配方只定义允许范围；生成器对范围做受约束组合，不做无界笛卡尔积。</div>
          <div className="toolbar-spacer" />
          <Button tone="primary" icon={Plus} onClick={() => {
            const id = "recipe-" + crypto.randomUUID();
            mutate((draft) => draft.recipes.push({
              id,
              name: "新系列",
              platformId: "P" + String(draft.recipes.length + 1).padStart(2, "0"),
              platformPosition: "",
              templateIds: [],
              structureIds: [],
              functionIds: [],
              performanceIds: [],
              technologyIds: [],
              requiredAffixIds: [],
              optionalAffixPoolIds: [],
              optionalSlots: 0,
              qualityTarget: "蓝",
              fishMinKg: 0,
              fishMaxKg: 1,
              useScene: "",
              maxCandidates: 50,
              notes: "",
              enabled: true,
            }));
            setSelectedRecipeId(id);
          }}>新增配方</Button>
        </div>
        <div className="recipe-layout">
          <Card className="flush-card">
            <SheetTable>
              <thead><tr><th>系列</th><th>平台ID</th><th>平台定位</th><th>目标品质</th><th>模板</th><th>必带词条</th><th>候选上限</th><th /></tr></thead>
              <tbody>{state.recipes.map((recipe) => (
                <tr key={recipe.id} className={selected?.id === recipe.id ? "selected-row" : ""} onClick={() => setSelectedRecipeId(recipe.id)}>
                  <td><strong>{recipe.name}</strong></td><td>{recipe.platformId}</td><td>{recipe.platformPosition}</td>
                  <td><Pill tone="blue">{recipe.qualityTarget}</Pill></td><td>{recipe.templateIds.length || "全部"}</td><td>{recipe.requiredAffixIds.length}</td><td>{recipe.maxCandidates}</td>
                  <td><Button icon={WandSparkles} size="sm" tone="primary" title="生成候选" onClick={() => generateRecipe(recipe)} /></td>
                </tr>
              ))}</tbody>
            </SheetTable>
          </Card>
          {selected ? (
            <Card className="recipe-inspector">
              <div className="panel-title">
                <div><span className="eyebrow">系列生成配方</span><h3>{selected.name}</h3></div>
                <Button icon={WandSparkles} tone="primary" size="sm" onClick={() => generateRecipe(selected)}>生成候选</Button>
              </div>
              <div className="form-grid">
                <label className="field-label">系列名<TextInput value={selected.name} onChange={(value) => mutate((draft) => { const target = draft.recipes.find((item) => item.id === selected.id); if (target) target.name = value; })} /></label>
                <label className="field-label">平台ID<TextInput value={selected.platformId} onChange={(value) => mutate((draft) => { const target = draft.recipes.find((item) => item.id === selected.id); if (target) target.platformId = value; })} /></label>
                <label className="field-label span-2">平台定位<TextInput value={selected.platformPosition} onChange={(value) => mutate((draft) => { const target = draft.recipes.find((item) => item.id === selected.id); if (target) target.platformPosition = value; })} /></label>
                <label className="field-label">鱼重下限kg<TextInput type="number" value={selected.fishMinKg} onChange={(value) => mutate((draft) => { const target = draft.recipes.find((item) => item.id === selected.id); if (target) target.fishMinKg = Number(value); })} /></label>
                <label className="field-label">鱼重上限kg<TextInput type="number" value={selected.fishMaxKg} onChange={(value) => mutate((draft) => { const target = draft.recipes.find((item) => item.id === selected.id); if (target) target.fishMaxKg = Number(value); })} /></label>
                <label className="field-label">可选词条槽<TextInput type="number" value={selected.optionalSlots} onChange={(value) => mutate((draft) => { const target = draft.recipes.find((item) => item.id === selected.id); if (target) target.optionalSlots = Number(value); })} /></label>
                <label className="field-label">候选上限<TextInput type="number" value={selected.maxCandidates} onChange={(value) => mutate((draft) => { const target = draft.recipes.find((item) => item.id === selected.id); if (target) target.maxCandidates = Number(value); })} /></label>
              </div>
              <div className="recipe-section"><strong>重量模板</strong><div className="check-grid">{state.templates.map((template) => (
                <label key={template.id}><input type="checkbox" checked={selected.templateIds.includes(template.id)} onChange={() => toggleRecipeList(selected.id, "templateIds", template.id)} />{template.id} · {template.tier}</label>
              ))}</div></div>
              {(["structure", "function", "performance", "technology"] as DimensionKey[]).map((key) => {
                const field = key === "structure" ? "structureIds" : key === "function" ? "functionIds" : key === "performance" ? "performanceIds" : "technologyIds";
                return (
                  <div className="recipe-section" key={key}><strong>{dimensionLabels[key]}</strong><div className="check-grid">
                    {state.modifiers.filter((item) => item.dimension === key).map((option) => (
                      <label key={option.id}><input type="checkbox" checked={selected[field].includes(option.id)} onChange={() => toggleRecipeList(selected.id, field, option.id)} />{option.name} {String(option.level) === "—" ? "" : option.level}</label>
                    ))}
                  </div></div>
                );
              })}
              <div className="recipe-section"><strong>必带词条</strong><div className="check-grid">{state.affixes.map((affix) => (
                <label key={affix.id}><input type="checkbox" checked={selected.requiredAffixIds.includes(affix.id)} onChange={() => toggleRecipeList(selected.id, "requiredAffixIds", affix.id)} />{affix.name} · {affix.score}分</label>
              ))}</div></div>
              <div className="recipe-section"><strong>可选词条池</strong><div className="check-grid">{state.affixes.map((affix) => (
                <label key={affix.id}><input type="checkbox" checked={selected.optionalAffixPoolIds.includes(affix.id)} onChange={() => toggleRecipeList(selected.id, "optionalAffixPoolIds", affix.id)} />{affix.name}</label>
              ))}</div></div>
            </Card>
          ) : null}
        </div>
      </div>
    );
  };

  const renderSeriesShowcase = () => {
    const layout = buildSeriesShowcaseLayout(state);
    let nextColumn = 2;
    const laneColumns = layout.lanes.map((lane) => {
      const columnCount = Math.max(1, lane.entries.length);
      const positioned = { lane, startColumn: nextColumn, columnCount };
      nextColumn += columnCount;
      return positioned;
    });
    const trackColumns = laneColumns.flatMap(({ columnCount }) =>
      Array.from({ length: columnCount }, () => "minmax(176px, 1fr)"),
    );
    const gridTemplateColumns = ["148px", ...trackColumns].join(" ");
    const gridTemplateRows = `42px 58px repeat(${layout.levels.length}, 104px)`;

    return (
      <div className="page-stack">
        <div className="toolbar showcase-toolbar">
          <div className="toolbar-note">
            历史演示记录 {state.seriesShowcases.length} 条 · 这里只兼容旧范围数据，不创建运行时 Series、SKU 或 Snapshot。
          </div>
          <div className="toolbar-spacer" />
          <Button tone="primary" icon={Plus} onClick={() => setPage("candidates")}>
            去创建正式 Series
          </Button>
        </div>
        <Card className="showcase-card">
          <div className="showcase-board-scroll">
            <div
              className="showcase-board showcase-gantt-board"
              style={{ gridTemplateColumns, gridTemplateRows }}
            >
              <div className="showcase-axis-head is-quality" style={{ gridColumn: 1, gridRow: 1 }}>
                品质
              </div>
              <div className="showcase-axis-head is-structure" style={{ gridColumn: 1, gridRow: 2 }}>
                <strong>重量段</strong>
                <span>基准拉力</span>
              </div>
              {laneColumns.map(({ lane, startColumn, columnCount }) => (
                <div
                  className="showcase-quality-head"
                  key={lane.id}
                  style={{
                    gridColumn: `${startColumn} / span ${columnCount}`,
                    gridRow: 1,
                    "--series-color": lane.color,
                  } as React.CSSProperties}
                >
                  <strong>{lane.qualityKey} 品质</strong>
                  <span>{lane.entries.length} 个系列</span>
                </div>
              ))}
              {laneColumns.flatMap(({ lane, startColumn }) =>
                lane.entries.length
                  ? lane.entries.map((placement) => {
                      const structures = placement.entry.structureIds
                        .map((id) => state.modifiers.find((item) => item.id === id)?.name)
                        .filter(Boolean);
                      return (
                        <div
                          className="showcase-series-head"
                          key={"head-" + placement.entry.id}
                          style={{
                            gridColumn: startColumn + placement.trackIndex,
                            gridRow: 2,
                            "--series-color": lane.color,
                          } as React.CSSProperties}
                        >
                          <strong>{placement.entry.seriesId}</strong>
                          <span>{placement.entry.fishingMethod} · {structures.join(" / ") || "未设结构"}</span>
                        </div>
                      );
                    })
                  : [
                      <div
                        className="showcase-series-head is-empty"
                        key={"head-empty-" + lane.id}
                        style={{ gridColumn: startColumn, gridRow: 2 }}
                      >
                        <span>待添加系列</span>
                      </div>,
                    ],
              )}
              {layout.levels.map((level, levelIndex) => {
                const gridRow = levelIndex + 3;
                const tension = templateTensionRange(level);
                return (
                  <div className="showcase-level-label" key={level.id} style={{ gridColumn: 1, gridRow }}>
                    <strong>{level.tier}</strong>
                    <span>{formatShowcaseRange(level.fishMinKg, level.fishMaxKg, "kg")}</span>
                    <small>基准 {formatShowcaseRange(tension.min, tension.max, "kgf")}</small>
                  </div>
                );
              })}
              {layout.levels.flatMap((level, levelIndex) =>
                laneColumns.map(({ lane, startColumn, columnCount }) => (
                  <div
                    className="showcase-lane-cell"
                    key={level.id + "-" + lane.id}
                    style={{
                      gridColumn: `${startColumn} / span ${columnCount}`,
                      gridRow: levelIndex + 3,
                    }}
                  />
                )),
              )}
              {laneColumns.flatMap(({ lane, startColumn }) =>
                lane.entries.map((placement) => {
                  const functionOption = state.modifiers.find(
                    (item) => item.id === placement.entry.functionId,
                  );
                  const structureLabels = placement.entry.structureIds
                    .map((id) => state.modifiers.find((item) => item.id === id)?.name)
                    .filter(Boolean);
                  const affixLabels = placement.entry.affixIds
                    .map((id) => state.affixes.find((item) => item.id === id))
                    .filter((affix): affix is Affix => Boolean(affix))
                    .map((affix) => {
                      const level = affix.rarity === "epic" ? 3 : affix.rarity === "rare" ? 2 : 1;
                      return "【" + affix.name + "+".repeat(level) + "】";
                    });
                  const featureLabels = [
                    showcaseFeatureLabel(functionOption),
                    ...affixLabels,
                  ].filter(Boolean);

                  return (
                    <button
                      type="button"
                      className="series-showcase-block series-gantt-block"
                      key={placement.entry.id}
                      style={{
                        gridColumn: startColumn + placement.trackIndex,
                        gridRow: `${placement.startRow + 3} / span ${placement.rowSpan}`,
                        "--series-color": lane.color,
                      } as React.CSSProperties}
                      aria-label={"查看历史系列 " + placement.entry.seriesId}
                    >
                      <div className="series-gantt-main">
                        <span className="series-showcase-id">{placement.entry.seriesId}</span>
                        <p>{placement.entry.description}</p>
                        <div className="series-gantt-meta">
                          <span>{placement.entry.fishingMethod}</span>
                          <span>{structureLabels.join(" / ") || "未设结构"}</span>
                        </div>
                        <div className="series-gantt-span">
                          <strong>重量 {formatShowcaseRange(placement.entry.fishMinKg, placement.entry.fishMaxKg, "kg")}</strong>
                          <strong>目标拉力 {showcaseTargetPulls(placement.entry).join(" / ")} kgf</strong>
                        </div>
                        <div className="series-showcase-features">
                          {featureLabels.map((label) => <em key={label}>{label}</em>)}
                        </div>
                      </div>
                      <div className="series-gantt-segments" aria-label={"自动拆分 " + placement.segments.length + " 个重量段"}>
                        {placement.segments.map((segment) => (
                          <span
                            key={segment.templateId}
                            title={
                              segment.tier + " · " +
                              formatShowcaseRange(segment.weightMinKg, segment.weightMaxKg, "kg") + " · " +
                              segment.targetPullsKgf.join(" / ") + " kgf"
                            }
                          >
                            {segment.tier} · {segment.targetPullsKgf.join(" / ") + " kgf"}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                }),
              )}
            </div>
          </div>
          {!state.seriesShowcases.length ? (
            <div className="showcase-empty">
              <strong>没有历史演示记录</strong>
              <span>这里不创建运行时 Series。正式 Series 必须确认离散目标拉力规格后，逐项生成 SKU 抽屉。</span>
              <Button tone="primary" icon={Plus} onClick={() => setPage("candidates")}>
                去创建正式 Series
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
    );
  };

  const renderCandidateInspector = (candidate: Candidate) => {
    const template = state.templates.find((item) => item.id === candidate.templateId);
    return (
      <aside className="candidate-inspector">
        <div className="inspector-head">
          <div><span className="eyebrow">候选精调</span><h3>{candidate.comboId}</h3><p>{candidate.seriesName} · {template?.tier}</p></div>
          <button type="button" onClick={() => setSelectedCandidateId("")}><X size={18} /></button>
        </div>
        <div className="inspector-scroll">
          <div className="quality-score-block" style={{ borderColor: qualityColor(state, candidate.calculated.quality.qualityId) }}>
            <span>词条品质</span>
            <strong>{qualityName(state, candidate.calculated.quality.qualityId)}</strong>
            <b>{candidate.calculated.quality.finalScore} 分</b>
            <small>原始 {candidate.calculated.quality.rawScore} 分</small>
          </div>
          <div className="score-breakdown">
            {candidate.calculated.quality.contributions.map((contribution) => (
              <div key={contribution.affixId}>
                <span>{state.affixes.find((item) => item.id === contribution.affixId)?.name}</span>
                <em>{contribution.base} × {formatNumber(contribution.factor)} = {contribution.score}</em>
              </div>
            ))}
            {candidate.calculated.quality.bonuses.map((text) => <div className="bonus" key={text}><span>{text}</span></div>)}
            {candidate.calculated.quality.penalties.map((text) => <div className="penalty" key={text}><span>{text}</span></div>)}
          </div>
          <div className="form-grid">
            <label className="field-label span-2">系列名<TextInput value={candidate.seriesName} onChange={(value) => mutate((draft) => { const target = draft.candidates.find((item) => item.id === candidate.id); if (target) target.seriesName = value; })} /></label>
            <label className="field-label">目标下限kg<TextInput type="number" value={candidate.fishMinKg} onChange={(value) => mutate((draft) => { const target = draft.candidates.find((item) => item.id === candidate.id); if (target) target.fishMinKg = Number(value); })} /></label>
            <label className="field-label">目标上限kg<TextInput type="number" value={candidate.fishMaxKg} onChange={(value) => mutate((draft) => { const target = draft.candidates.find((item) => item.id === candidate.id); if (target) target.fishMaxKg = Number(value); })} /></label>
            <label className="field-label">调性覆盖<TextInput value={candidate.toneOverride ?? ""} onChange={(value) => mutate((draft) => { const target = draft.candidates.find((item) => item.id === candidate.id); if (target) target.toneOverride = value; })} /></label>
            <label className="field-label">硬度覆盖<TextInput value={candidate.hardnessOverride ?? ""} onChange={(value) => mutate((draft) => { const target = draft.candidates.find((item) => item.id === candidate.id); if (target) target.hardnessOverride = value; })} /></label>
            <label className="field-label span-2">长度覆盖m<TextInput type="number" value={candidate.lengthOverride ?? ""} placeholder="自动" onChange={(value) => mutate((draft) => { const target = draft.candidates.find((item) => item.id === candidate.id); if (target) target.lengthOverride = value === "" ? undefined : Number(value); })} /></label>
            <label className="field-label span-2">使用场景<textarea value={candidate.useScene} onChange={(event) => mutate((draft) => { const target = draft.candidates.find((item) => item.id === candidate.id); if (target) target.useScene = event.target.value; }, false)} /></label>
          </div>
          <div className="inspector-section">
            <div className="section-title"><strong>词条</strong><span>{candidate.affixIds.length} 条</span></div>
            <div className="affix-checks">{state.affixes.map((affix) => (
              <label key={affix.id} className={candidate.affixIds.includes(affix.id) ? "checked" : ""}>
                <input type="checkbox" checked={candidate.affixIds.includes(affix.id)} onChange={() => mutate((draft) => {
                  const target = draft.candidates.find((item) => item.id === candidate.id);
                  if (!target) return;
                  target.affixIds = target.affixIds.includes(affix.id) ? target.affixIds.filter((id) => id !== affix.id) : [...target.affixIds, affix.id];
                })} />
                <span>{affix.name}<small>{affix.score}分 · {affix.category === "stat" ? "属性" : "被动"}</small></span>
              </label>
            ))}</div>
          </div>
          <div className="inspector-section">
            <div className="section-title"><strong>手工参数覆盖</strong><Button icon={Plus} size="sm" tone="ghost" onClick={() => mutate((draft) => {
              const target = draft.candidates.find((item) => item.id === candidate.id);
              const parameter = draft.parameters.find((item) => !(item.key in (target?.overrides ?? {})));
              if (target && parameter) target.overrides[parameter.key] = Number(target.calculated.values[parameter.key] ?? 0);
            })}>添加</Button></div>
            {Object.entries(candidate.overrides).map(([key, value]) => (
              <div className="override-row" key={key}>
                <SelectInput value={key} onChange={(next) => mutate((draft) => {
                  const target = draft.candidates.find((item) => item.id === candidate.id);
                  if (!target) return;
                  const current = target.overrides[key];
                  delete target.overrides[key];
                  target.overrides[next] = current;
                })}>{state.parameters.map((parameter) => <option key={parameter.key} value={parameter.key}>{parameter.label}</option>)}</SelectInput>
                <TextInput value={value} type={typeof value === "number" ? "number" : "text"} onChange={(next) => mutate((draft) => {
                  const target = draft.candidates.find((item) => item.id === candidate.id);
                  if (target) target.overrides[key] = typeof value === "number" ? Number(next) : next;
                })} />
                <Button icon={Trash2} size="sm" tone="ghost" onClick={() => mutate((draft) => {
                  const target = draft.candidates.find((item) => item.id === candidate.id);
                  if (target) delete target.overrides[key];
                })} />
              </div>
            ))}
          </div>
          <div className="inspector-section">
            <div className="section-title"><strong>计算轨迹</strong><span>{candidate.calculated.trace.length} 步</span></div>
            <div className="trace-list">
              {candidate.calculated.trace.slice(-20).reverse().map((trace, index) => (
                <div key={trace.layer + trace.parameterKey + index}>
                  <span>{trace.layer}<small>{trace.source}</small></span>
                  <code>{trace.parameterKey}: {String(trace.before ?? "—")} {trace.operation} {String(trace.operand)} → {String(trace.after ?? "—")}</code>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>
    );
  };

  const renderCandidates = () => {
    const selectedCandidate = state.candidates.find((candidate) => candidate.id === selectedCandidateId);
    const allVisibleSelected = filteredCandidates.length > 0 && filteredCandidates.every((candidate) => selectedCandidates.has(candidate.id));
    return (
      <div className="candidate-page">
        <div className="page-stack">
          <div className="toolbar wrap-toolbar">
            <div className="search-box"><Search size={15} /><input value={search} placeholder="搜索组合ID、系列、平台定位…" onChange={(event) => setSearch(event.target.value)} /></div>
            <SelectInput value={candidateStatus} onChange={setCandidateStatus}>
              <option value="all">全部状态</option><option value="candidate">候选</option><option value="shortlisted">入围</option><option value="rejected">淘汰</option><option value="published">已发布</option>
            </SelectInput>
            <div className="toolbar-spacer" />
            <span className="selection-count">已选 {selectedCandidates.size}</span>
            <Button size="sm" onClick={() => applyCandidateStatus("shortlisted")}>入围</Button>
            <Button size="sm" tone="ghost" onClick={() => applyCandidateStatus("rejected")}>淘汰</Button>
            <SelectInput value={bulkAffixId} onChange={setBulkAffixId} className="bulk-select">
              <option value="">批量词条…</option>{state.affixes.map((affix) => <option key={affix.id} value={affix.id}>{affix.name}</option>)}
            </SelectInput>
            <Button size="sm" onClick={applyBulkAffix} disabled={!bulkAffixId}>应用</Button>
            <Button size="sm" icon={GitCompareArrows} onClick={() => setCompareOpen(true)} disabled={!compareIds.length}>比较 {compareIds.length}</Button>
            <Button size="sm" icon={Check} tone="primary" onClick={publishSelected} disabled={!selectedCandidates.size}>发布 SKU</Button>
          </div>
          <Card className="flush-card">
            <SheetTable>
              <thead><tr>
                <th><input type="checkbox" checked={allVisibleSelected} onChange={() => {
                  const next = new Set(selectedCandidates);
                  filteredCandidates.forEach((candidate) => allVisibleSelected ? next.delete(candidate.id) : next.add(candidate.id));
                  setSelectedCandidates(next);
                }} /></th>
                <th>比较</th><th className="sticky-col">组合ID</th><th>状态</th><th>系列 / 平台</th><th>模板</th><th>目标kg</th><th>结构</th><th>功能</th><th>性能</th><th>词条</th><th>品质</th><th>分数</th><th>杆/轮/线拉力</th><th>安全拉力</th><th>价格</th><th>校验</th>
              </tr></thead>
              <tbody>{filteredCandidates.map((candidate) => {
                const errors = candidate.calculated.issues.filter((issue) => issue.level === "error").length;
                const warnings = candidate.calculated.issues.filter((issue) => issue.level === "warning").length;
                return (
                  <tr key={candidate.id} className={selectedCandidateId === candidate.id ? "selected-row" : ""} onDoubleClick={() => setSelectedCandidateId(candidate.id)}>
                    <td><input type="checkbox" checked={selectedCandidates.has(candidate.id)} onChange={() => {
                      const next = new Set(selectedCandidates);
                      if (next.has(candidate.id)) next.delete(candidate.id);
                      else next.add(candidate.id);
                      setSelectedCandidates(next);
                    }} /></td>
                    <td><input type="checkbox" checked={compareIds.includes(candidate.id)} disabled={!compareIds.includes(candidate.id) && compareIds.length >= 4} onChange={() => setCompareIds((current) => current.includes(candidate.id) ? current.filter((id) => id !== candidate.id) : [...current, candidate.id])} /></td>
                    <td className="sticky-col"><button className="link-button" onClick={() => setSelectedCandidateId(candidate.id)}>{candidate.comboId}</button></td>
                    <td><Pill tone={candidate.status === "published" ? "success" : candidate.status === "rejected" ? "danger" : candidate.status === "shortlisted" ? "blue" : "neutral"}>{candidate.status === "candidate" ? "候选" : candidate.status === "shortlisted" ? "入围" : candidate.status === "rejected" ? "淘汰" : "已发布"}</Pill></td>
                    <td><strong>{candidate.seriesName}</strong><small>{candidate.platformPosition}</small></td>
                    <td>{candidate.templateId}</td><td>{candidate.fishMinKg}–{candidate.fishMaxKg}</td>
                    <td>{optionLabel(state, candidate.selections.structureId)}</td><td>{optionLabel(state, candidate.selections.functionId)}</td><td>{optionLabel(state, candidate.selections.performanceId)}</td>
                    <td><div className="mini-tags">{candidate.affixIds.slice(0, 2).map((id) => <span key={id}>{state.affixes.find((item) => item.id === id)?.name}</span>)}{candidate.affixIds.length > 2 ? <b>+{candidate.affixIds.length - 2}</b> : null}</div></td>
                    <td><Pill style={{ color: qualityColor(state, candidate.calculated.quality.qualityId), borderColor: qualityColor(state, candidate.calculated.quality.qualityId) }}>{qualityName(state, candidate.calculated.quality.qualityId)}</Pill></td>
                    <td><strong>{candidate.calculated.quality.finalScore}</strong></td>
                    <td>{formatNumber(candidate.calculated.values["杆最大拉力kgf"])} / {formatNumber(candidate.calculated.values["轮最大拉力kgf"])} / {formatNumber(candidate.calculated.values["线最大拉力kgf"])}</td>
                    <td>{formatNumber(candidate.calculated.safeWorkingForce, 3)}</td><td>×{candidate.calculated.priceIndex}</td>
                    <td>{errors ? <Pill tone="danger">{errors} 错误</Pill> : warnings ? <Pill tone="warning">{warnings} 警告</Pill> : <Pill tone="success">通过</Pill>}</td>
                  </tr>
                );
              })}</tbody>
            </SheetTable>
          </Card>
          {!filteredCandidates.length ? <EmptyState title="没有符合条件的候选" text="从系列配方生成，或调整筛选条件。" action={<Button tone="primary" onClick={() => setPage("recipes")}>前往系列配方</Button>} /> : null}
        </div>
        {selectedCandidate ? renderCandidateInspector(selectedCandidate) : null}
      </div>
    );
  };

  const renderSkus = () => (
    <div className="page-stack">
      <div className="toolbar"><div className="toolbar-note">正式 SKU 来自候选发布；再次发布同组合ID会更新原记录。</div><div className="toolbar-spacer" /><Button icon={Download} onClick={() => void exportExcel()}>导出 Excel</Button></div>
      {state.officialSkus.length ? (
        <Card className="flush-card"><SheetTable><thead><tr>
          <th className="sticky-col">组合ID</th><th>平台ID</th><th>平台定位</th><th>模板</th><th>品质</th><th>系列</th><th>结构</th><th>功能</th><th>性能</th><th>调性覆盖</th><th>硬度</th><th>长度m</th><th>使用场景</th><th>杆ID</th><th>轮ID</th><th>线ID</th><th>价格指数</th><th>杆拉力</th><th>轮拉力</th><th>线拉力</th><th>安全拉力</th><th />
        </tr></thead><tbody>{state.officialSkus.map((sku, index) => (
          <tr key={sku.id}>
            <td className="sticky-col"><strong>{sku.comboId}</strong></td><td>{sku.platformId}</td><td>{sku.platformPosition}</td><td>{sku.templateId}</td>
            <td><Pill style={{ color: qualityColor(state, sku.qualityId), borderColor: qualityColor(state, sku.qualityId) }}>{qualityName(state, sku.qualityId)}</Pill></td>
            <td><TextInput value={sku.seriesName} onChange={(value) => mutate((draft) => { draft.officialSkus[index].seriesName = value; }, false)} /></td>
            <td>{sku.structureName}</td><td>{sku.functionName} {sku.functionLevel}</td><td>{sku.performanceName} {sku.performanceLevel}</td>
            <td><TextInput value={sku.tone} onChange={(value) => mutate((draft) => { draft.officialSkus[index].tone = value; }, false)} /></td>
            <td><TextInput value={sku.hardness} onChange={(value) => mutate((draft) => { draft.officialSkus[index].hardness = value; }, false)} /></td>
            <td><TextInput type="number" value={sku.lengthM} onChange={(value) => mutate((draft) => { draft.officialSkus[index].lengthM = Number(value); }, false)} /></td>
            <td><TextInput value={sku.useScene} onChange={(value) => mutate((draft) => { draft.officialSkus[index].useScene = value; }, false)} /></td>
            <td><code>{sku.rodId}</code></td><td><code>{sku.reelId}</code></td><td><code>{sku.lineId}</code></td>
            <td>×{sku.priceIndex}</td><td>{formatNumber(sku.rodForce)}</td><td>{formatNumber(sku.reelForce)}</td><td>{formatNumber(sku.lineForce)}</td><td>{formatNumber(sku.safeWorkingForce, 3)}</td>
            <td><Button icon={Trash2} size="sm" tone="ghost" onClick={() => mutate((draft) => { draft.officialSkus.splice(index, 1); }, false)} /></td>
          </tr>
        ))}</tbody></SheetTable></Card>
      ) : <EmptyState title="还没有正式 SKU" text="在 Model 候选中入围、比较并批量发布。" action={<Button tone="primary" onClick={() => setPage("candidates")}>前往 Model 候选</Button>} />}
    </div>
  );

  const renderDetails = () => {
    const kindParameters = state.parameters.filter((parameter) => parameter.itemKind === detailKind);
    return (
      <div className="page-stack">
        <div className="toolbar"><div className="segmented">{(["rod", "reel", "line"] as ItemKind[]).map((kind) => <button key={kind} className={detailKind === kind ? "active" : ""} onClick={() => setDetailKind(kind)}>{kindLabels[kind]}明细</button>)}</div><div className="toolbar-spacer" /><span className="toolbar-note">型号、名字和数值覆盖只作用于明细，不反写生成规则。</span></div>
        {state.officialSkus.length ? (
          <Card className="flush-card"><SheetTable><thead><tr><th className="sticky-col">道具ID</th><th>组合ID</th><th>型号</th><th>名字</th>{kindParameters.map((parameter) => <th key={parameter.key}>{parameter.label}</th>)}<th className="wide-col">备注</th></tr></thead>
          <tbody>{state.officialSkus.map((sku) => {
            const detail = state.detailOverrides.find((item) => item.skuId === sku.id && item.itemKind === detailKind);
            const itemId = detailKind === "rod" ? sku.rodId : detailKind === "reel" ? sku.reelId : sku.lineId;
            return (
              <tr key={sku.id}>
                <td className="sticky-col"><code>{itemId}</code></td><td>{sku.comboId}</td>
                <td><TextInput value={detail?.model ?? ""} placeholder="自定义型号" onChange={(value) => updateDetail(sku, detailKind, "model", value)} /></td>
                <td><TextInput value={detail?.name ?? ""} placeholder="自定义名字" onChange={(value) => updateDetail(sku, detailKind, "name", value)} /></td>
                {kindParameters.map((parameter) => {
                  const value = detail?.values[parameter.key] ?? sku.values[parameter.key];
                  return <td key={parameter.key}><TextInput value={value} type={typeof value === "number" ? "number" : "text"} onChange={(next) => updateDetail(sku, detailKind, parameter.key, typeof value === "number" ? Number(next) : next)} /></td>;
                })}
                <td><TextInput value={detail?.notes ?? ""} onChange={(value) => updateDetail(sku, detailKind, "notes", value)} /></td>
              </tr>
            );
          })}</tbody></SheetTable></Card>
        ) : <EmptyState title="明细将在发布后生成" text="杆ID、轮ID、线ID分别自动使用 组合ID_R / _W / _L。" />}
      </div>
    );
  };

  const renderValidation = () => {
    const suggestions = suggestRulesFromOverrides(state);
    return (
      <div className="page-stack">
        <div className="metric-grid compact-metrics">
          <Card className="metric-card metric-red"><span>错误</span><strong>{validationRows.filter((row) => row.issue.level === "error").length}</strong><small>阻止直接通过</small></Card>
          <Card className="metric-card metric-amber"><span>警告</span><strong>{validationRows.filter((row) => row.issue.level === "warning").length}</strong><small>建议人工复核</small></Card>
          <Card className="metric-card metric-teal"><span>通过</span><strong>{state.candidates.filter((candidate) => candidate.calculated.issues.every((issue) => issue.level === "info")).length}</strong><small>结构与覆盖正常</small></Card>
          <Card className="metric-card metric-blue"><span>规则建议</span><strong>{suggestions.length}</strong><small>来自重复精调</small></Card>
        </div>
        <div className="two-column validation-layout">
          <Card className="flush-card">
            <div className="panel-title padded"><div><h3>验算问题</h3><p>安全工作拉力 = MIN(杆×0.9, 轮, 线×0.35)</p></div></div>
            <SheetTable><thead><tr><th>级别</th><th>组合ID</th><th>规则</th><th>说明</th></tr></thead><tbody>
              {validationRows.filter((row) => row.issue.level !== "info").map(({ candidate, issue }, index) => (
                <tr key={candidate.id + issue.code + index} onClick={() => { setSelectedCandidateId(candidate.id); setPage("candidates"); }}>
                  <td>{issue.level === "error" ? <Pill tone="danger">错误</Pill> : <Pill tone="warning">警告</Pill>}</td><td><strong>{candidate.comboId}</strong></td><td><code>{issue.code}</code></td><td>{issue.message}</td>
                </tr>
              ))}
            </tbody></SheetTable>
          </Card>
          <Card>
            <div className="panel-title"><div><h3>从精调中学习</h3><p>只生成候选规则，由策划确认发布到新层。</p></div></div>
            <div className="suggestion-list">
              {suggestions.map((suggestion) => (
                <div key={suggestion.parameterKey}>
                  <div><strong>{suggestion.parameterKey}</strong><span>{suggestion.summary}</span></div>
                  <Button size="sm" onClick={() => mutate((draft) => {
                    let layer = draft.layers.find((item) => item.id === "layer-learned");
                    if (!layer) {
                      layer = { id: "layer-learned", name: "精调沉淀规则", order: 75, enabled: true, mode: "global", optionIds: [], rules: [], notes: "经人工确认后从候选精调固化。" };
                      draft.layers.push(layer);
                    }
                    layer.rules.push({ id: "learned-" + crypto.randomUUID(), parameterKey: suggestion.parameterKey, operation: "add", value: suggestion.averageDelta, notes: suggestion.summary });
                  })}>发布规则</Button>
                </div>
              ))}
              {!suggestions.length ? <EmptyState title="暂无重复精调模式" text="同一参数出现至少 2 次手工覆盖后，这里会给出候选规则。" /> : null}
            </div>
          </Card>
        </div>
      </div>
    );
  };

  const renderSources = () => {
    const previewSource = sourcePreview
      ? state.dataSources.find((item) => item.id === sourcePreview.sourceId)
      : undefined;
    const previewHasErrors = sourcePreview?.issues.some((issue) => issue.level === "error") ?? false;
    const writebackSource = writebackPreview
      ? state.dataSources.find((item) => item.id === writebackPreview.sourceId)
      : undefined;
    const writebackHasErrors =
      writebackPreview?.issues.some((issue) => issue.level === "error") ?? false;
    return (
      <div className="page-stack">
        <Card className="source-hero">
          <div>
            <span className="eyebrow">后台正式库 + 飞书协作表</span>
            <h2>粘贴链接，再选择数据范围</h2>
            <p>
              复制飞书多维表格分享链接即可连接；链接包含数据表时直接使用，只有工作簿时再
              读取列表并选择。发布与回写仍然经过预览、冲突检查和人工确认。
            </p>
          </div>
          <div className="source-hero-actions">
            <Pill tone="blue">当前正式版本 v{revision}</Pill>
            {dirty ? (
              <Button icon={Save} tone="primary" disabled={!user.actionAvailability.save_workspace.enabled} title={user.actionAvailability.save_workspace.disabledReasonText} onClick={() => void save("保存数据源配置")}>先保存配置</Button>
            ) : null}
          </div>
        </Card>

        <div className="data-source-grid">
          {state.dataSources.map((source, index) => (
            <Card className="data-source-card" key={source.id}>
              <div className="panel-title">
                <div>
                  <span className="eyebrow">{source.id}</span>
                  <h3>{source.name}</h3>
                </div>
                <Pill tone={source.enabled ? "success" : "neutral"}>
                  {source.enabled ? "已启用" : "已停用"}
                </Pill>
              </div>
              <div className="source-form-grid">
                <label>
                  <span>数据源名称</span>
                  <TextInput
                    value={source.name}
                    onChange={(value) => updateDataSource(index, "name", value)}
                  />
                </label>
                <label>
                  <span>发布数据类型</span>
                  <SelectInput
                    value={source.dataset}
                    onChange={(value) => updateDataSource(index, "dataset", value)}
                  >
                    <option value="weight_templates">重量段模板</option>
                    <option value="modifiers">流派 / 定位系数</option>
                  </SelectInput>
                </label>
                <label className="source-link-field">
                  <span>飞书多维表格分享链接</span>
                  <div className="source-link-row">
                    <TextInput
                      value={source.shareUrl}
                      placeholder="粘贴 https://你的团队.feishu.cn/base/..."
                      onChange={(value) => updateDataSource(index, "shareUrl", value)}
                    />
                    <Button
                      icon={Link2}
                      tone="primary"
                      disabled={Boolean(sourceAction) || !source.shareUrl.trim() || !user.actionAvailability.resolve_data_source.enabled}
                      title={user.actionAvailability.resolve_data_source.disabledReasonText}
                      onClick={() => void resolveDataSource(source, index)}
                    >
                      {sourceAction === "resolve" ? "读取中…" : "识别链接"}
                    </Button>
                  </div>
                  <small>
                    链接包含数据表时会直接选中；只包含工作簿时，识别后从下拉列表选择。
                  </small>
                </label>
                <label>
                  <span>使用哪张数据表</span>
                  <SelectInput
                    value={source.tableId}
                    onChange={(value) =>
                      void resolveDataSource(
                        { ...source, tableId: value, viewId: "" },
                        index,
                        value,
                      )
                    }
                  >
                    <option value="">
                      {sourceCatalogs[source.id] ? "请选择数据表" : "先识别分享链接"}
                    </option>
                    {(sourceCatalogs[source.id]?.tables ?? []).map((table) => (
                      <option value={table.id} key={table.id}>{table.name}</option>
                    ))}
                    {source.tableId &&
                    !(sourceCatalogs[source.id]?.tables ?? []).some(
                      (table) => table.id === source.tableId,
                    ) ? (
                      <option value={source.tableId}>链接中的数据表</option>
                    ) : null}
                  </SelectInput>
                </label>
                <label>
                  <span>使用哪个视图（可选）</span>
                  <SelectInput
                    value={source.viewId}
                    onChange={(value) => updateDataSource(index, "viewId", value)}
                  >
                    <option value="">整张数据表</option>
                    {(sourceCatalogs[source.id]?.views ?? []).map((view) => (
                      <option value={view.id} key={view.id}>{view.name}</option>
                    ))}
                    {source.viewId &&
                    !(sourceCatalogs[source.id]?.views ?? []).some(
                      (view) => view.id === source.viewId,
                    ) ? (
                      <option value={source.viewId}>链接中的视图</option>
                    ) : null}
                  </SelectInput>
                </label>
                <details className="source-technical">
                  <summary>系统识别信息</summary>
                  <div>
                    <span>app_token <code>{source.appToken || "待识别"}</code></span>
                    <span>table_id <code>{source.tableId || "待选择"}</code></span>
                    <span>view_id <code>{source.viewId || "全部"}</code></span>
                  </div>
                </details>                <label>
                  <span>备注</span>
                  <TextInput
                    value={source.notes}
                    onChange={(value) => updateDataSource(index, "notes", value)}
                  />
                </label>
              </div>
              <div className="source-card-actions">
                <label className="source-enabled">
                  <input
                    type="checkbox"
                    checked={source.enabled}
                    onChange={(event) => updateDataSource(index, "enabled", event.target.checked)}
                  />
                  允许拉取
                </label>
                <Button
                  icon={RefreshCw}
                  tone="primary"
                  disabled={
                    Boolean(sourceAction) ||
                    dirty ||
                    !user.actionAvailability.preview_data_source.enabled ||
                    !source.enabled ||
                    !source.appToken.trim() ||
                    !source.tableId.trim()
                  }
                  title={user.actionAvailability.preview_data_source.disabledReasonText}
                  onClick={() => void previewDataSource(source)}
                >
                  {sourceAction === "preview" && sourcePreview?.sourceId === source.id
                    ? "拉取中…"
                    : "拉取并预览"}
                </Button>
                <Button
                  icon={Upload}
                  disabled={
                    Boolean(sourceAction) ||
                    dirty ||
                    !user.actionAvailability.preview_data_source_writeback.enabled ||
                    !source.enabled ||
                    !source.appToken.trim() ||
                    !source.tableId.trim()
                  }
                  title={user.actionAvailability.preview_data_source_writeback.disabledReasonText}
                  onClick={() => void previewWriteback(source)}
                >
                  {sourceAction === "writeback-preview" ? "检查中…" : "检查本地修订"}
                </Button>
              </div>
            </Card>
          ))}
        </div>

        <Card className="source-security-note">
          <ShieldCheck size={22} />
          <div>
            <strong>飞书应用密钥不会进入浏览器</strong>
            <span>
              部署环境需要配置 FEISHU_APP_ID 与 FEISHU_APP_SECRET；浏览器只保存分享链接和
              自动识别的数据范围，不接触应用密钥。
            </span>
          </div>
        </Card>

        {sourcePreview ? (
          <Card className="source-preview-card">
            <div className="panel-title">
              <div>
                <span className="eyebrow">暂存预览 · {sourcePreview.sourceName}</span>
                <h3>{sourcePreview.recordCount} 条记录等待发布</h3>
              </div>
              <Pill tone={previewHasErrors ? "danger" : "success"}>
                {previewHasErrors ? "校验未通过" : "可以发布"}
              </Pill>
            </div>
            <div className="source-diff-grid">
              {[
                ["新增", sourcePreview.summary.added, "source-added"],
                ["修改", sourcePreview.summary.changed, "source-changed"],
                ["删除", sourcePreview.summary.removed, "source-removed"],
                ["无变化", sourcePreview.summary.unchanged, "source-unchanged"],
              ].map(([label, value, className]) => (
                <div className={String(className)} key={String(label)}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            {sourcePreview.issues.length ? (
              <div className="source-issue-list">
                {sourcePreview.issues.map((issue, index) => (
                  <div className={"source-issue source-issue-" + issue.level} key={index}>
                    {issue.level === "error" ? <XCircle size={16} /> : <AlertTriangle size={16} />}
                    <span>
                      {issue.rowId ? <strong>{issue.rowId} · </strong> : null}
                      {issue.message}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="source-clean">
                <CheckCircle2 size={18} />
                字段、ID 和数值范围校验全部通过。
              </div>
            )}
            <div className="source-publish-bar">
              <span>
                拉取于 {new Date(sourcePreview.pulledAt).toLocaleString("zh-CN")} · 校验摘要{" "}
                {sourcePreview.checksum}
              </span>
              <Button
                icon={CloudDownload}
                tone="primary"
                disabled={!previewSource || previewHasErrors || dirty || Boolean(sourceAction) || !user.actionAvailability.publish_data_source.enabled}
                title={user.actionAvailability.publish_data_source.disabledReasonText}
                onClick={() => previewSource && void publishDataSource(previewSource)}
              >
                {sourceAction === "publish" ? "发布中…" : "发布为新正式版本"}
              </Button>
            </div>
          </Card>
        ) : (
          <EmptyState
            title="尚无暂存数据"
            text="从 A 表或 B 表选择“拉取并预览”，正式版本不会被立即修改。"
          />
        )}

        {writebackPreview ? (
          <Card className="source-preview-card">
            <div className="panel-title">
              <div>
                <span className="eyebrow">回写检查 · {writebackPreview.sourceName}</span>
                <h3>
                  {writebackPreview.recordCount
                    ? writebackPreview.recordCount + " 条本地修订等待确认"
                    : "本地数据与飞书一致"}
                </h3>
              </div>
              <Pill
                tone={
                  writebackHasErrors
                    ? "danger"
                    : writebackPreview.recordCount
                      ? "success"
                      : "neutral"
                }
              >
                {writebackHasErrors
                  ? "已阻止回写"
                  : writebackPreview.recordCount
                    ? "可以回写"
                    : "无需回写"}
              </Pill>
            </div>
            <div className="source-diff-grid">
              <div className="source-changed">
                <span>修改记录</span>
                <strong>{writebackPreview.recordCount}</strong>
              </div>
              <div className="source-added">
                <span>修改字段</span>
                <strong>{writebackPreview.fieldCount}</strong>
              </div>
            </div>
            {writebackPreview.issues.length ? (
              <div className="source-issue-list">
                {writebackPreview.issues.map((issue, index) => (
                  <div className={"source-issue source-issue-" + issue.level} key={index}>
                    {issue.level === "error" ? <XCircle size={16} /> : <AlertTriangle size={16} />}
                    <span>
                      {issue.rowId ? <strong>{issue.rowId} · </strong> : null}
                      {issue.message}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {writebackPreview.rows.length ? (
              <SheetTable>
                <thead>
                  <tr>
                    <th>本地记录</th>
                    <th>飞书字段</th>
                  </tr>
                </thead>
                <tbody>
                  {writebackPreview.rows.map((row) => (
                    <tr key={row.recordId}>
                      <td><strong>{row.entityId}</strong></td>
                      <td>{row.fieldNames.join("、")}</td>
                    </tr>
                  ))}
                </tbody>
              </SheetTable>
            ) : (
              <div className="source-clean">
                <CheckCircle2 size={18} />
                没有检测到需要回写的已绑定记录。
              </div>
            )}
            <div className="source-publish-bar">
              <span>
                检查于 {new Date(writebackPreview.pulledAt).toLocaleString("zh-CN")} ·
                回写前会再次校验版本与飞书内容
              </span>
              <Button
                icon={Upload}
                tone="primary"
                disabled={
                  !writebackSource ||
                  writebackHasErrors ||
                  !writebackPreview.recordCount ||
                  dirty ||
                  Boolean(sourceAction) ||
                  !user.actionAvailability.commit_data_source_writeback.enabled
                }
                title={user.actionAvailability.commit_data_source_writeback.disabledReasonText}
                onClick={() => writebackSource && void publishWriteback(writebackSource)}
              >
                {sourceAction === "writeback" ? "回写中…" : "确认回写飞书"}
              </Button>
            </div>
          </Card>
        ) : null}
        <Card className="flush-card">
          <div className="panel-title">
            <div>
              <span className="eyebrow">发布审计</span>
              <h3>最近的数据源发布记录</h3>
            </div>
          </div>
          {state.dataSourceImports.length ? (
            <SheetTable>
              <thead>
                <tr>
                  <th>版本</th>
                  <th>来源</th>
                  <th>数据类型</th>
                  <th>记录数</th>
                  <th>发布人</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {state.dataSourceImports.map((entry) => (
                  <tr key={entry.id}>
                    <td><strong>v{entry.publishedRevision}</strong></td>
                    <td>{entry.sourceName}</td>
                    <td>{entry.dataset === "weight_templates" ? "重量段模板" : "流派 / 定位系数"}</td>
                    <td>{entry.recordCount}</td>
                    <td>{entry.publishedBy}</td>
                    <td>{new Date(entry.publishedAt).toLocaleString("zh-CN")}</td>
                  </tr>
                ))}
              </tbody>
            </SheetTable>
          ) : (
            <EmptyState title="暂无发布记录" text="第一次从飞书发布后，来源和版本会记录在这里。" />
          )}
        </Card>
        <Card className="flush-card">
          <div className="panel-title">
            <div>
              <span className="eyebrow">回写审计</span>
              <h3>最近的飞书回写记录</h3>
            </div>
          </div>
          {state.dataSourceWritebacks.length ? (
            <SheetTable>
              <thead>
                <tr>
                  <th>版本</th>
                  <th>目标</th>
                  <th>记录 / 字段</th>
                  <th>操作人</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {state.dataSourceWritebacks.map((entry) => (
                  <tr key={entry.id}>
                    <td><strong>v{entry.publishedRevision}</strong></td>
                    <td>{entry.sourceName}</td>
                    <td>{entry.recordCount} 条 / {entry.fieldCount} 个</td>
                    <td>{entry.publishedBy}</td>
                    <td>{new Date(entry.publishedAt).toLocaleString("zh-CN")}</td>
                  </tr>
                ))}
              </tbody>
            </SheetTable>
          ) : (
            <EmptyState
              title="暂无回写记录"
              text="工具中的修订经检查并人工确认回写后，会记录在这里。"
            />
          )}
        </Card>
      </div>
    );
  };

  const renderRuleSource = () => (
    <RuleWorkbookWorkbench
      state={state}
      revision={revision}
      dirty={dirty}
      actionAvailabilities={user.actionAvailability}
      actorName={user.name}
      notify={notify}
      onWorkspaceApplied={(nextState, nextRevision, message) => {
        setState(recalculateWorkspace(ensureWorkflowFields(nextState)));
        setRevision(nextRevision);
        setDirty(false);
        setSyncState("saved");
        notify(message);
        void loadVersions();
      }}
    />
  );

  const renderVersions = () => (
    <div className="page-stack">
      <Card className="version-hero">
        <div><span className="eyebrow">团队共享</span><h2>当前版本 v{revision}</h2><p>每次保存都会保存完整配置快照；基于旧版本保存时会触发冲突保护。</p></div>
        <Button icon={Save} tone="primary" disabled={!user.actionAvailability.save_workspace.enabled} title={user.actionAvailability.save_workspace.disabledReasonText} onClick={() => void save("手工创建版本快照")}>保存新版本</Button>
      </Card>
      <Card className="flush-card">
        <SheetTable><thead><tr><th>版本</th><th>时间</th><th>作者</th><th>说明</th><th>操作</th></tr></thead>
        <tbody>{versions.map((version) => (
          <tr key={version.revision}>
            <td><Pill tone={version.revision === revision ? "success" : "neutral"}>v{version.revision}</Pill></td>
            <td>{new Date(version.createdAt).toLocaleString("zh-CN")}</td><td>{version.author}</td><td>{version.message}</td>
            <td><Button size="sm" icon={RotateCcw} disabled={version.revision === revision || !user.actionAvailability.view_revisions.enabled} title={user.actionAvailability.view_revisions.disabledReasonText} onClick={async () => {
              const response = await fetch("/api/revisions?revision=" + version.revision);
              if (!response.ok) return notify("读取历史版本失败。");
              const payload = (await response.json()) as { state: WorkspaceState };
              setState(recalculateWorkspace(payload.state));
              setDirty(true);
              notify("已载入 v" + version.revision + "，保存后会成为新版本。");
            }}>载入副本</Button></td>
          </tr>
        ))}</tbody></SheetTable>
      </Card>
    </div>
  );

  const renderExcel = () => (
    <div className="page-stack">
      <div className="exchange-grid">
        <Card className="exchange-card">
          <div className="exchange-icon"><Upload size={24} /></div><h3>导入 Excel</h3>
          <p>支持本网页导出的完整工作簿；也兼容只含“01重量模板”的旧表。原始文件会存入团队文件仓。</p>
          <Button tone="primary" icon={Upload} disabled={!user.actionAvailability.import_excel.enabled} title={user.actionAvailability.import_excel.disabledReasonText} onClick={() => fileInput.current?.click()}>选择 Excel</Button>
        </Card>
        <Card className="exchange-card">
          <div className="exchange-icon"><Download size={24} /></div><h3>导出 Excel</h3>
          <p>生成 01–10 可读工作表，并附带隐藏状态页，保证参数、规则、词条、候选与版本可完整往返。</p>
          <Button tone="primary" icon={Download} onClick={() => void exportExcel()}>导出当前版本</Button>
        </Card>
      </div>
      <Card>
        <div className="panel-title"><div><span className="eyebrow">数据来源</span><h3>首版工作簿映射</h3></div><Pill tone="success">19 个工作表已提取</Pill></div>
        <div className="source-list">
          <div><FileSpreadsheet size={22} /><span><strong>淡水路亚杆轮线装备设计.xlsx</strong><small>权威主表 · 01–12 全部相关工作表已纳入数据种子</small></span><Pill tone="success">主源</Pill></div>
          <div><FileSpreadsheet size={22} /><span><strong>钓具装备母表与道具生成逻辑_v1.0.xlsx</strong><small>旧版参考 · 参数、模板、价格与验算逻辑已保留为迁移依据</small></span><Pill>参考</Pill></div>
        </div>
      </Card>
      <Card className="mapping-card">
        <h3>网页与 Excel 对应关系</h3>
        <div className="mapping-grid">
          {[
            ["01重量模板", "重量模板 + 参数管理"],
            ["02类型材质", "结构、材质规则矩阵"],
            ["03功能定位", "功能定位规则矩阵"],
            ["04性能定位", "性能与技术规则矩阵"],
            ["05品质规则", "已升级为词条库 + 品质评分"],
            ["06组合SKU", "系列配方 → Model 候选 → 正式 SKU"],
            ["07–09明细", "杆轮线明细"],
            ["11覆盖验算", "校验与规则学习"],
            ["11系列演示表", "系列覆盖自动排布"],
          ].map(([sheet, module]) => <div key={sheet}><code>{sheet}</code><span>→</span><strong>{module}</strong></div>)}
        </div>
      </Card>
    </div>
  );

  void renderSources;

  const renderExchange = () => (
    <div className="page-stack">
      <div className="exchange-mode-tabs" role="tablist" aria-label="数据交换方式">

        <button
          type="button"
          role="tab"
          aria-selected={exchangeMode === "excel"}
          className={exchangeMode === "excel" ? "active" : ""}
          onClick={() => setExchangeMode("excel")}
        >
          <FileSpreadsheet size={18} />
          <span><strong>Excel 文件</strong><small>离线导入与完整导出</small></span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={exchangeMode === "config"}
          className={exchangeMode === "config" ? "active" : ""}
          onClick={() => setExchangeMode("config")}
        >
          <PackageCheck size={18} />
          <span><strong>配置关系预览</strong><small>一期仅 CONFIG_PREVIEW / NON_FORMAL</small></span>
        </button>
      </div>
      {exchangeMode === "excel" ? renderExcel() : (
        <ConfigExportWorkbench
          state={state}
          actionAvailabilities={user.actionAvailability}
          identity={{
            workspaceId: user.tenantKey ?? "",
            userId: user.openId ?? "",
          }}
          notify={notify}
        />
      )}
    </div>
  );
  const renderPage = () => {
    if (page === "v3flow") return <V3FlowWorkbench state={state} mutate={mutate} notify={notify} initialSeriesId={v3SeriesId} />;
    if (page === "overview") return renderOverview();
    if (page === "templates") return renderTemplates();
    if (page === "modifiers") return renderModifiers();
    if (page === "layers") return renderLayers();
    if (page === "rulegraph") return <RuleGraphStudio state={state} mutate={mutate} notify={notify} userName={user.name} selectedCandidateIds={Array.from(selectedCandidates)} />;
    if (page === "affixes") return renderAffixes();
    if (page === "quality") return renderQuality();
    if (page === "recipes") return renderRecipes();
    if (page === "showcase") return renderSeriesShowcase();
    if (page === "candidates") return (
      <>
        <SeriesGanttWorkbench
          key={`series-gantt:${routeNonce}`}
          state={state}
          workspaceId={user.tenantKey || "workspace"}
          actionAvailabilities={user.actionAvailability}
          actor={user.name}
          mutate={mutate}
          notify={notify}
          onWorkspaceApplied={(nextState, nextRevision, message) => {
            setState(recalculateWorkspace(ensureWorkflowFields(nextState)));
            setRevision(nextRevision);
            setDirty(false);
            setSyncState("saved");
            notify(message);
            void loadVersions();
          }}
          onBreadcrumbsChange={setContextBreadcrumbs}
          onOpenSeries={(seriesId) => {
            setV3SeriesId(seriesId);
            setPage("v3flow");
          }}
        />
        <details className="legacy-candidate-results">
          <summary>历史 Model 候选结果（兼容旧候选池）</summary>
          {renderCandidates()}
        </details>
      </>
    );
    if (page === "skus") return renderSkus();
    if (page === "details") return renderDetails();
    if (page === "validation") return renderValidation();
    if (page === "versions") return renderVersions();
    if (page === "rulesource") return renderRuleSource();
    if (page === "patchledger") return <PatchLedgerWorkbench state={state} capabilities={user.capabilities} actorName={user.name} mutate={mutate} notify={notify} />;
    return renderExchange();
  };

  const compareCandidates = compareIds
    .map((id) => state.candidates.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Candidate => Boolean(candidate));
  const requestedV3Series = state.seriesDefinitions.find((entry) => entry.id === v3SeriesId);
  const v3Series = requestedV3Series && isProductItemPartEnabled(
    seriesItemPartId(requestedV3Series, state.skuDrawers),
  ) ? requestedV3Series : undefined;
  const topBreadcrumbs = page === "v3flow" && v3Series
    ? buildProductBreadcrumbs({
      workspaceId: user.tenantKey || "workspace",
      collection: v3Series.collectionId
        ? state.collections.find((entry) => entry.id === v3Series.collectionId)
        : undefined,
      series: v3Series,
      currentEntityType: "series",
    })
    : page === "candidates"
      ? contextBreadcrumbs
      : [];
  const openEntityBreadcrumb = (item: BreadcrumbItem) => {
    if (!item.navigable || item.unavailableReason) return;
    const url = new URL(window.location.href);
    url.searchParams.set("page", "candidates");
    if (item.ref.entityType === "collection") {
      url.searchParams.delete("series");
      url.searchParams.delete("sku");
      url.searchParams.delete("model");
      url.searchParams.delete("snapshot");
      url.searchParams.delete("collectionIds");
      url.searchParams.append("collectionIds", item.ref.entityId);
    } else if (item.ref.entityType === "series") {
      url.searchParams.set("series", item.ref.entityId);
      url.searchParams.delete("sku");
      url.searchParams.delete("model");
      url.searchParams.delete("snapshot");
    } else if (item.ref.entityType === "sku_drawer") {
      url.searchParams.set("sku", item.ref.entityId);
      url.searchParams.delete("model");
      url.searchParams.delete("snapshot");
    } else if (item.ref.entityType === "model") {
      url.searchParams.set("model", item.ref.entityId);
      url.searchParams.delete("snapshot");
    } else if (item.ref.entityType === "configuration_snapshot") {
      url.searchParams.set("snapshot", item.ref.entityId);
    }
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setPage("candidates");
    setRouteNonce((value) => value + 1);
  };
  const submitGlobalSearch = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("page", "candidates");
    if (globalSearch.trim()) url.searchParams.set("q", globalSearch.trim());
    else url.searchParams.delete("q");
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setPage("candidates");
    setRouteNonce((value) => value + 1);
  };

  if (authStatus !== "authenticated") {
    return (
      <div className="workbench">
        <main className="main">
          <div className="content">
            <section className="card service-required-card">
              <LockKeyhole size={30} />
              <span className="eyebrow">FEISHU AUTHENTICATION</span>
              <h2>{authStatus === "checking" ? "正在检查登录状态" : "请使用公司飞书账号登录"}</h2>
              <p>{authStatus === "checking" ? "正在读取安全会话，完成前不会启用编辑。" : authMessage}</p>
              {authStatus !== "checking" && authErrorCode ? (
                <code className="service-error-code">错误编号：{authErrorCode}</code>
              ) : null}
              {authStatus !== "checking" ? (
                <div className="service-required-actions">
                  <a className="button button-primary button-md" href="/api/auth/feishu/start?return_to=%2F">使用飞书登录</a>
                  <button type="button" className="button button-default button-md" onClick={() => window.location.reload()}>重新检查</button>
                  <button type="button" className="button button-default button-md" onClick={() => void copyServiceDiagnostic()}>复制诊断信息</button>
                </div>
              ) : null}
              <small>内网部署仍保留飞书登录，也支持受信任内网代理传递飞书身份。</small>
            </section>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="workbench">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Anvil size={20} /></div>
          <div><strong>钓具配置工坊</strong><span>TACKLE FORGER</span></div>
        </div>
        <button
          type="button"
          className={cx("rule-source-shortcut", page === "rulesource" && "active")}
          onClick={() => setPage("rulesource")}
        >
          <CloudDownload size={18} strokeWidth={1.8} />
          <span><strong>飞书规则源</strong><small>显式拉取工作簿</small></span>
        </button>
        <nav>
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span>{group.label}</span>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button type="button" key={item.key} className={page === item.key ? "active" : ""} onClick={() => setPage(item.key)}>
                    <Icon size={17} strokeWidth={1.8} /><b>{item.label}</b>
                    {item.key === "candidates" ? <em>{state.candidates.length}</em> : item.key === "skus" ? <em>{state.officialSkus.length}</em> : item.key === "showcase" ? <em>{state.seriesShowcases.length}</em> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sync-indicator">
            <span className={cx("sync-dot", dirty ? "dirty" : "clean")} />
            <div><strong>{dirty ? "有未保存修改" : "已同步"}</strong><span>团队版本 v{revision}</span></div>
          </div>
          <div className="user-chip"><span>{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><small>编辑者</small></div><button type="button" title="退出登录" onClick={() => void fetch("/api/auth/logout",{method:"POST"}).finally(()=>window.location.reload())}><LogOut size={15}/></button></div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-context">
            <nav className="topbar-breadcrumbs" aria-label="当前位置">
              <span><small>工作台</small><strong>{pageMeta[page].title}</strong></span>
              {topBreadcrumbs.map((item) => (
                <span key={`${item.ref.entityType}:${item.ref.entityId}`} className={item.unavailableReason ? "unavailable" : item.current ? "current" : ""}>
                  <ChevronRight size={13} aria-hidden="true" />
                  <button type="button" disabled={!item.navigable || Boolean(item.unavailableReason)} title={item.unavailableReason ?? `${item.ref.entityId} · revision ${item.ref.revisionId}`} onClick={() => openEntityBreadcrumb(item)}>
                    <small>{item.objectLabel}</small><strong>{item.label}</strong>
                  </button>
                </span>
              ))}
            </nav>
            <h1>{pageMeta[page].title}</h1><p>{pageMeta[page].subtitle}</p>
          </div>
          <div className="top-actions">
            <input ref={fileInput} hidden type="file" accept=".xlsx,.xls" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importExcel(file); }} />
            <form className="topbar-global-search" role="search" onSubmit={(event) => { event.preventDefault(); submitGlobalSearch(); }}>
              <Search size={15} aria-hidden="true" />
              <input aria-label="全局搜索可见 Series" value={globalSearch} onChange={(event) => setGlobalSearch(event.target.value)} placeholder="搜索可见 Series…" />
            </form>
            <Button icon={Save} tone="primary" disabled={!dirty || syncState === "saving" || !user.actionAvailability.save_workspace.enabled} title={user.actionAvailability.save_workspace.disabledReasonText} onClick={() => void save()}>
              {syncState === "saving" ? "保存中…" : "保存版本"}
            </Button>
          </div>
        </header>
        <div className="content">
          {renderPage()}
        </div>
      </main>

      {compareOpen ? (
        <div className="compare-drawer">
          <div className="compare-head"><div><span className="eyebrow">横向对比</span><h3>{compareCandidates.length} 套候选</h3></div><button onClick={() => setCompareOpen(false)}><X size={20} /></button></div>
          <div className="compare-scroll">
            <table><thead><tr><th>参数</th>{compareCandidates.map((candidate) => <th key={candidate.id}>{candidate.comboId}<small>{candidate.seriesName}</small></th>)}</tr></thead>
            <tbody>
              <tr><td>品质 / 分数</td>{compareCandidates.map((candidate) => <td key={candidate.id}><Pill style={{ color: qualityColor(state, candidate.calculated.quality.qualityId) }}>{qualityName(state, candidate.calculated.quality.qualityId)}</Pill> {candidate.calculated.quality.finalScore}</td>)}</tr>
              <tr><td>结构</td>{compareCandidates.map((candidate) => <td key={candidate.id}>{optionLabel(state, candidate.selections.structureId)}</td>)}</tr>
              <tr><td>功能</td>{compareCandidates.map((candidate) => <td key={candidate.id}>{optionLabel(state, candidate.selections.functionId)}</td>)}</tr>
              <tr><td>性能</td>{compareCandidates.map((candidate) => <td key={candidate.id}>{optionLabel(state, candidate.selections.performanceId)}</td>)}</tr>
              {state.parameters.map((parameter) => (
                <tr key={parameter.key}><td>{parameter.label}<small>{parameter.unit}</small></td>{compareCandidates.map((candidate) => <td key={candidate.id}>{formatNumber(candidate.calculated.values[parameter.key], parameter.precision)}</td>)}</tr>
              ))}
            </tbody></table>
          </div>
        </div>
      ) : null}

      {showcaseDraft ? (
        <div
          className="showcase-modal-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setShowcaseDraft(null);
          }}
        >
          <section className="showcase-modal" role="dialog" aria-modal="true" aria-labelledby="showcase-editor-title">
            <div className="showcase-modal-head">
              <div>
                <span className="eyebrow">LEGACY SERIES SHOWCASE</span>
                <h2 id="showcase-editor-title">
                  {state.seriesShowcases.some((item) => item.id === showcaseDraft.id) ? "编辑历史演示记录" : "添加历史演示记录"}
                </h2>
                <p>此记录只供历史跨度图展示，不会创建 SeriesDefinition 或 SKU。正式创建请使用钓具系列甘特图。</p>
              </div>
              <button type="button" aria-label="关闭" onClick={() => setShowcaseDraft(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="showcase-modal-body">
              <div className="form-grid showcase-editor-grid">
                <label className="field-label">
                  系列 ID
                  <TextInput
                    value={showcaseDraft.seriesId}
                    onChange={(value) => setShowcaseDraft((current) => current ? { ...current, seriesId: value } : current)}
                    placeholder="例如 SER-SA1"
                  />
                </label>
                <label className="field-label">
                  定义品质
                  <SelectInput
                    value={showcaseDraft.qualityId}
                    onChange={(value) => setShowcaseDraft((current) => current ? { ...current, qualityId: value } : current)}
                  >
                    {showcaseQualitySlots(state.qualityBands).map((quality) => (
                      <option key={quality.key} value={quality.qualityId}>{quality.key} 品质</option>
                    ))}
                  </SelectInput>
                </label>
                <label className="field-label span-2">
                  系列特点描述
                  <textarea
                    value={showcaseDraft.description}
                    placeholder="例如：精细操控、轻饵远投或强力搏斗"
                    onChange={(event) => setShowcaseDraft((current) => current ? { ...current, description: event.target.value } : current)}
                  />
                </label>
                <label className="field-label">
                  唯一钓法
                  <TextInput
                    value={showcaseDraft.fishingMethod}
                    onChange={(value) => setShowcaseDraft((current) => current ? { ...current, fishingMethod: value } : current)}
                    placeholder="例如：岸抛路亚"
                  />
                  <small>一个系列只对应一种钓法。</small>
                </label>
                <label className="field-label">
                  功能定位
                  <SelectInput
                    value={showcaseDraft.functionId}
                    onChange={(value) => setShowcaseDraft((current) => current ? { ...current, functionId: value } : current)}
                  >
                    <option value="">请选择定位</option>
                    {state.modifiers.filter((item) => item.dimension === "function" && item.enabled).map((option) => (
                      <option key={option.id} value={option.id}>{option.name} · {option.level}级</option>
                    ))}
                  </SelectInput>
                </label>
              </div>

              <div className="showcase-definition-section">
                <div>
                  <strong>系列包含的结构</strong>
                  <span>直柄、枪柄等结构属于系列内部，不再占用固定全局栏位。</span>
                </div>
                <div className="check-grid showcase-check-grid">
                  {state.modifiers
                    .filter((item) => item.dimension === "structure" && item.enabled && (item.name.includes("直柄") || item.name.includes("枪柄")))
                    .map((option) => (
                      <label key={option.id}>
                        <input
                          type="checkbox"
                          checked={showcaseDraft.structureIds.includes(option.id)}
                          onChange={() => toggleShowcaseSelection("structureIds", option.id)}
                        />
                        {option.name}
                      </label>
                    ))}
                </div>
              </div>

              <div className="showcase-range-editor">
                <div>
                  <strong>重量跨度</strong>
                  <span>决定甘特块覆盖哪些重量段</span>
                </div>
                <label className="field-label">最小 kg<TextInput type="number" min={0} step={0.1} value={showcaseDraft.fishMinKg} onChange={(value) => setShowcaseDraft((current) => current ? { ...current, fishMinKg: Number(value) } : current)} /></label>
                <span className="range-divider">—</span>
                <label className="field-label">最大 kg<TextInput type="number" min={0} step={0.1} value={showcaseDraft.fishMaxKg} onChange={(value) => setShowcaseDraft((current) => current ? { ...current, fishMaxKg: Number(value) } : current)} /></label>
              </div>

              <div className="showcase-range-editor is-tension">
                <div>
                  <strong>目标拉力规格</strong>
                  <span>填写离散 SKU 拉力，使用逗号分隔；不会插值，也不会自动补齐中间规格。</span>
                </div>
                <label className="field-label span-2">目标 kgf
                  <TextInput value={showcaseTargetPulls(showcaseDraft).join(", ")} placeholder="例如：1.5, 1.8, 3.8" onChange={(value) => setShowcaseDraft((current) => current ? { ...current, targetPullsKgf: value.split(/[,，\s]+/).map(Number).filter((item) => Number.isFinite(item) && item > 0) } : current)} />
                </label>
              </div>

              <div className="showcase-definition-section">
                <div>
                  <strong>贯通词条</strong>
                  <span>所选词条属于系列本体，低档与高档拆分段都会完整继承。</span>
                </div>
                <div className="check-grid showcase-affix-grid">
                  {state.affixes.filter((affix) => affix.enabled).map((affix) => (
                    <label key={affix.id}>
                      <input
                        type="checkbox"
                        checked={showcaseDraft.affixIds.includes(affix.id)}
                        onChange={() => toggleShowcaseSelection("affixIds", affix.id)}
                      />
                      <span>{affix.name}</span>
                      <small>{affix.score} 分</small>
                    </label>
                  ))}
                </div>
              </div>

              <div className="showcase-feature-preview">
                <span>
                  系列贯通预览 · 自动覆盖 {
                    state.templates.filter(
                      (template) =>
                        showcaseDraft.fishMaxKg > template.fishMinKg &&
                        showcaseDraft.fishMinKg < template.fishMaxKg,
                    ).length
                  } 个重量段
                </span>
                <div>
                  {[
                    showcaseFeatureLabel(state.modifiers.find((item) => item.id === showcaseDraft.functionId)),
                    ...showcaseDraft.affixIds
                      .map((id) => state.affixes.find((item) => item.id === id))
                      .filter((affix): affix is Affix => Boolean(affix))
                      .map((affix) => {
                        const level = affix.rarity === "epic" ? 3 : affix.rarity === "rare" ? 2 : 1;
                        return "【" + affix.name + "+".repeat(level) + "】";
                      }),
                  ].filter(Boolean).map((label) => <em key={label}>{label}</em>)}
                </div>
                <small>词条等级来自词条库稀有度；发布后所有重量段保持一致。</small>
              </div>
            </div>
            <div className="showcase-modal-foot">
              {state.seriesShowcases.some((item) => item.id === showcaseDraft.id) ? (
                <Button tone="danger" icon={Trash2} onClick={deleteSeriesShowcase}>移除系列</Button>
              ) : <span />}
              <div>
                <Button onClick={() => setShowcaseDraft(null)}>取消</Button>
                <Button tone="primary" icon={Check} onClick={publishSeriesShowcase}>
                  {state.seriesShowcases.some((item) => item.id === showcaseDraft.id) ? "更新演示记录" : "保存演示记录"}
                </Button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {toast ? <div className="toast"><CheckCircle2 size={17} />{toast}</div> : null}
    </div>
  );
}
