"use client";

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CloudDownload,
  FileSpreadsheet,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionAvailabilityMap } from "@/lib/interaction-contracts";
import { randomUUID } from "@/lib/browser-utils";
import {
  inspectBrowserCanonicalWorkbook,
  BrowserCanonicalWorkbookError,
} from "@/lib/browser-canonical-workbook";
import type { CanonicalRuleWorkbookParsedInspection } from "@/lib/canonical-workbook-core";
import { issueClientActionCommand } from "@/lib/client-action-command";
import { type FeishuApiErrorInfo } from "@/lib/feishu-api-error";
import { CANONICAL_FEISHU_WORKBOOK } from "@/lib/feishu-workbook";
import { buildFeishuOrchestrationModel } from "@/lib/feishu-orchestration-presentation";
import type { CanonicalRuleWorkbookInspection } from "@/lib/rule-workbook-inspection";
import { AFFIX_SHEET_ID } from "@/lib/rule-workbook-inspection";
import type { WorkspaceState } from "@/lib/types";
import {
  IdentityMigrationPanel,
  PricingPolicyDraftPanel,
  QualityValuePolicyPanel,
} from "./RuleWorkbookGovernancePanels";
import { FeishuOrchestrationWorkbench } from "./FeishuOrchestrationWorkbench";
import { FeishuSourceCombobox } from "./FeishuSourceCombobox";

type WorkbenchSession =
  | { mode: "anonymous" }
  | { mode: "local_excel"; fileName: string; fileSize: number; contentHash: string; loadedAt: string }
  | { mode: "feishu"; authenticated: false }
  | { mode: "feishu"; authenticated: true };

type SourceMode = "excel" | "feishu";

interface RuleWorkbookWorkbenchProps {
  state: WorkspaceState;
  revision: number;
  dirty: boolean;
  actionAvailabilities: ActionAvailabilityMap;
  actorName: string;
  session: WorkbenchSession;
  onWorkspaceApplied: (state: WorkspaceState, revision: number, message: string) => void;
  notify: (message: string) => void;
  /** 识别成功后缓存进 feishuShareLinkHistory（本地草稿，不立即保存到服务端）。 */
  onRecordShareLinkHistory: (shareUrl: string, label: string) => void;
  /** 从 feishuShareLinkHistory 移除单条（shareUrl）或清空全部（null）。 */
  onClearShareLinkHistory: (shareUrl: string | null) => void;
  /** 本地 Excel 加载成功后回调，传入 inspection 与文件元数据。 */
  onLocalExcelLoaded?: (inspection: CanonicalRuleWorkbookParsedInspection, fileName: string, fileSize: number) => void;
}

type ActionState = "" | "inspect" | "pull" | "draft" | "publish";

/** 所有 inspection 子对象的 issue 归一化行，按 sheet 分组供 UI 渲染。 */
interface WorkbookIssueRow {
  sheetId: string;
  sheetName: string;
  row?: number;
  cell?: string;
  level: "error" | "warning";
  code: string;
  message: string;
}

function dateTime(value?: string) {
  if (!value) return "尚未读取";
  return new Date(value).toLocaleString("zh-CN");
}

export function RuleWorkbookWorkbench(props: RuleWorkbookWorkbenchProps) {
  type Inspection = CanonicalRuleWorkbookInspection | CanonicalRuleWorkbookParsedInspection;
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [action, setAction] = useState<ActionState>("");
  const [error, setError] = useState("");
  const [errorDetail, setErrorDetail] = useState<FeishuApiErrorInfo | undefined>(undefined);
  const [warningReason, setWarningReason] = useState("");
  const sourceModeInit: SourceMode = props.session.mode === "local_excel" ? "excel" : "feishu";
  const [sourceMode, setSourceMode] = useState<SourceMode>(sourceModeInit);
  const [localFile, setLocalFile] = useState<{ name: string; size: number } | null>(null);
  const [localParsing, setLocalParsing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleLocalFile = async (file: File) => {
    setLocalParsing(true);
    setError("");
    setErrorDetail(undefined);
    try {
      const buffer = await file.arrayBuffer();
      const result = await inspectBrowserCanonicalWorkbook({
        bytes: buffer,
        fileName: file.name,
        observedAt: new Date().toISOString(),
      });
      setInspection(result.inspection);
      setLocalFile({ name: result.observation.fileName, size: result.observation.fileSize });
      props.onLocalExcelLoaded?.(result.inspection, result.observation.fileName, result.observation.fileSize);
    } catch (caught) {
      if (caught instanceof BrowserCanonicalWorkbookError) {
        setError(`本地工作簿解析失败：${caught.message}（${caught.code}）`);
      } else {
        setError(`读取文件失败：${caught instanceof Error ? caught.message : "未知错误"}`);
      }
      setInspection(null);
      setLocalFile(null);
    } finally {
      setLocalParsing(false);
    }
  };

  const inspect = async () => {
    setAction("inspect");
    setError("");
    setErrorDetail(undefined);
    try {
      const response = await fetch("/api/feishu-workbook", { cache: "no-store" });
      const payload = (await response.json()) as {
        inspection?: CanonicalRuleWorkbookInspection;
        error?: string;
        errorInfo?: FeishuApiErrorInfo;
      };
      if (!response.ok || !payload.inspection) {
        setErrorDetail(payload.errorInfo);
        throw new Error(payload.error || "读取规则工作簿失败");
      }
      setInspection(payload.inspection);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取规则工作簿失败");
    } finally {
      setAction("");
    }
  };

  useEffect(() => {
    if (sourceMode !== "feishu") return;
    if (props.session.mode !== "feishu" || !props.session.authenticated) return;
    const controller = new AbortController();
    fetch("/api/feishu-workbook", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as {
          inspection?: CanonicalRuleWorkbookInspection;
          error?: string;
          errorInfo?: FeishuApiErrorInfo;
        };
        if (!response.ok || !payload.inspection) {
          setErrorDetail(payload.errorInfo);
          throw new Error(payload.error || "读取规则工作簿失败");
        }
        setInspection(payload.inspection);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "读取规则工作簿失败");
      });
    return () => controller.abort();
  }, [sourceMode, props.session]);

  const orchestrationModel = useMemo(
    () => sourceMode === "feishu" ? buildFeishuOrchestrationModel({
      state: props.state,
      workspaceRevision: props.revision,
      inspection: inspection as CanonicalRuleWorkbookInspection | null,
      action,
      error,
    }) : null,
    [props.state, props.revision, inspection, action, error, sourceMode],
  );

  const savedSource = useMemo(() => {
    const sourceRevision = inspection?.sourceRevision.sourceRevision;
    return sourceRevision
      ? props.state.feishuSourceRevisions.find((item) => item.sourceRevision === sourceRevision)
      : undefined;
  }, [inspection, props.state.feishuSourceRevisions]);

  const ruleSetForSource = savedSource
    ? props.state.ruleSetVersions.find((item) => item.sourceRevisionIds.includes(savedSource.id))
    : undefined;
  const ruleSetDraft = ruleSetForSource?.status === "draft" ? ruleSetForSource : undefined;
  const sourceWarnings = savedSource?.issues.filter((issue) => issue.severity === "warning") ?? [];
  const identityItems = inspection?.identityReport.items ?? [];
  const identified = identityItems.filter((item) => item.state === "ALREADY_IDENTIFIED").length;
  const pending = identityItems.filter((item) => item.state === "NEW_SOURCE_ROW" || item.requiresHumanConfirmation);
  const conflicts = identityItems.filter((item) => item.state === "CONFLICT").length;
  const identityReportRegistered = inspection
    ? props.state.sourceIdentityMigrationReports.some((item) => item.reportId === inspection.identityReport.reportId)
    : false;
  const qualityMappingIssue = inspection?.pricingDraft.issues.some((issue) =>
    issue.code.startsWith("QUALITY_PRICING_MAPPING_"));
  const missingPricing = inspection?.pricingDraft.issues.filter((issue) =>
    ["PRICING_INTERPOLATION_MISSING", "PARTS_TO_WHOLE_RATIO_MISSING", "PRICING_MONEY_POLICY_MISSING", "PRICING_EXECUTION_SEMANTICS_MISSING"].includes(issue.code)) ?? [];
  const inspectAvailability = props.actionAvailabilities.inspect_feishu_workbook;
  const identityWriteAvailability = props.actionAvailabilities.write_feishu_identity;

  // sheetId → 人类可读标签页名（来自飞书 grid 元数据）
  const sheetNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const sheet of inspection?.sourceRevision.sheets ?? []) map.set(sheet.sheetId, sheet.name);
    return map;
  }, [inspection]);

  /** 把所有 inspection 子对象的 issue 归一化为统一行，按 sheet 分组供 UI 渲染。 */
  const allWorkbookIssues = useMemo((): WorkbookIssueRow[] => {
    if (!inspection) return [];
    const name = (sheetId?: string) => (sheetId ? (sheetNameMap.get(sheetId) ?? sheetId) : "(未知表)");
    const rows: WorkbookIssueRow[] = [];
    // weightTemplateDraft 的 WEIGHT_TEMPLATE_* 问题继承了 canonicalRuleDraft
    // 的同名错误并附加更丰富的 sourceCell 列坐标。先 push weightTemplateDraft，
    // 再收集 canonicalRuleDraft 时跳过 WEIGHT_TEMPLATE_*，避免同一根因展示两遍。
    // 不做全局去重——其他来源内部的同 code 不同位置问题应全部保留。
    for (const issue of inspection.sourceRevision.issues) {
      rows.push({ sheetId: issue.sheetId, sheetName: name(issue.sheetId), level: issue.severity, code: issue.code, message: issue.message });
    }
    for (const issue of inspection.weightTemplateDraft.issues) {
      const cell = issue.sourceCell?.cell;
      const row = cell ? Number.parseInt(cell.replace(/^[A-Z]+/, ""), 10) || undefined : undefined;
      rows.push({ sheetId: issue.sourceCell?.sheetId ?? "", sheetName: name(issue.sourceCell?.sheetId), row, cell, level: issue.severity === "ERROR" ? "error" : "warning", code: issue.code, message: issue.message });
    }
    for (const issue of inspection.canonicalRuleDraft.issues) {
      if (issue.code.startsWith("WEIGHT_TEMPLATE_")) continue;
      rows.push({ sheetId: issue.sheetId ?? "", sheetName: name(issue.sheetId), row: issue.row, level: issue.level, code: issue.code, message: issue.message });
    }
    for (const issue of inspection.seriesParseIssues) {
      rows.push({ sheetId: issue.sheetId, sheetName: name(issue.sheetId), row: issue.row, level: issue.level, code: issue.code, message: issue.message });
    }
    for (const issue of inspection.qualityDraft.issues) {
      const src = issue.sourceCell;
      rows.push({ sheetId: src?.sheetId ?? "27hboC", sheetName: src ? name(src.sheetId) : "07_品质评分", row: src?.rowKey ? Number.parseInt(src.rowKey, 10) || undefined : undefined, cell: src?.cell, level: issue.severity === "WARNING" ? "warning" : "error", code: issue.code, message: issue.message });
    }
    for (const issue of inspection.pricingDraft.issues) {
      const src = issue.source;
      rows.push({ sheetId: src?.sheetId ?? "", sheetName: src ? name(src.sheetId) : "定价草稿", row: src?.rowKey ? Number.parseInt(src.rowKey, 10) || undefined : undefined, cell: src?.cell, level: issue.severity, code: issue.code, message: issue.message });
    }
    return rows;
  }, [inspection, sheetNameMap]);

  const workbookIssueCount = allWorkbookIssues.length;
  const workbookErrorCount = allWorkbookIssues.filter((i) => i.level === "error").length;

  const pull = async () => {
    if (!inspection) return;
    setAction("pull");
    try {
      const businessPayload = {
        action: "pull",
        baseRevision: props.revision,
        expectedSourceRevision: inspection.sourceRevision.sourceRevision,
      };
      const invocation = await issueClientActionCommand({
        action: "pull_feishu_workbook",
        idempotencyKey:
          `pull-feishu-workbook:${props.revision}:` +
          inspection.sourceRevision.sourceRevision,
        payload: businessPayload,
      });
      const response = await fetch("/api/feishu-workbook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invocation),
      });
      const payload = (await response.json()) as {
        state?: WorkspaceState;
        revision?: number;
        inspection?: CanonicalRuleWorkbookInspection;
        error?: string;
      };
      if (!response.ok || !payload.state || !payload.revision) {
        if (payload.inspection) setInspection(payload.inspection);
        throw new Error(payload.error || "显式拉取失败");
      }
      if (payload.inspection) setInspection(payload.inspection);
      const rules = payload.inspection?.canonicalRuleDraft;
      props.onWorkspaceApplied(
        payload.state,
        payload.revision,
        `已拉取飞书 revision ${payload.inspection?.sourceRevision.sourceRevision ?? ""}：已生成 ${rules?.templates.length ?? 0} 个重量模板草稿、${rules?.itemTypeProfiles.length ?? 0} 个类型、${rules?.functionProfiles.length ?? 0} 个功能；重量模板将在正式发布时激活。`,
      );
    } catch (caught) {
      props.notify(caught instanceof Error ? caught.message : "显式拉取失败");
    } finally {
      setAction("");
    }
  };

  const createDraft = async () => {
    if (!savedSource) return;
    setAction("draft");
    try {
      const businessPayload = {
        action: "create_ruleset_draft",
        baseRevision: props.revision,
        sourceRevisionId: savedSource.id,
      };
      const invocation = await issueClientActionCommand({
        action: "create_ruleset_draft",
        idempotencyKey:
          `create-ruleset-draft:${props.revision}:${savedSource.id}`,
        payload: businessPayload,
      });
      const response = await fetch("/api/feishu-workbook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invocation),
      });
      const payload = (await response.json()) as { state?: WorkspaceState; revision?: number; error?: string };
      if (!response.ok || !payload.state || !payload.revision) throw new Error(payload.error || "创建规则草稿失败");
      props.onWorkspaceApplied(payload.state, payload.revision, "已创建 RuleSet 草稿；尚未发布");
    } catch (caught) {
      props.notify(caught instanceof Error ? caught.message : "创建规则草稿失败");
    } finally {
      setAction("");
    }
  };

  const publishRuleSet = async () => {
    if (!ruleSetDraft) return;
    if (sourceWarnings.length && !warningReason.trim()) {
      props.notify("发布前必须填写工作表 warning 的确认理由。");
      return;
    }
    setAction("publish");
    try {
      const businessPayload = {
        action: "publish_ruleset",
        baseRevision: props.revision,
        ruleSetDraftId: ruleSetDraft.id,
        warningAcknowledgements: sourceWarnings.map((issue) => ({
          issueKey: `${issue.code}:${issue.sheetId}`,
          reason: warningReason.trim(),
        })),
      };
      const invocation = await issueClientActionCommand({
        action: "publish_ruleset",
        idempotencyKey:
          `publish-ruleset:${props.revision}:${ruleSetDraft.id}:` +
          randomUUID(),
        payload: businessPayload,
      });
      const response = await fetch("/api/feishu-workbook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invocation),
      });
      const payload = (await response.json()) as { state?: WorkspaceState; revision?: number; error?: string };
      if (!response.ok || !payload.state || !payload.revision) throw new Error(payload.error || "发布 RuleSetVersion 失败");
      props.onWorkspaceApplied(payload.state, payload.revision, "RuleSetVersion 已显式发布；拉取与草稿创建均未代替本动作");
    } catch (caught) {
      props.notify(caught instanceof Error ? caught.message : "发布 RuleSetVersion 失败");
    } finally {
      setAction("");
    }
  };
  const isLocalMode = sourceMode === "excel";
  const feishuNeedsAuth = sourceMode === "feishu" && (props.session.mode !== "feishu" || !(props.session as { mode: "feishu"; authenticated: boolean }).authenticated);

  return (
    <section className="rule-workbook-stack" aria-label={isLocalMode ? "规则工作簿（本地 Excel）" : "规则工作簿"}>
      {/* ── 来源选择条 ── */}
      <div className="source-mode-bar">
        <button
          type="button"
          className={sourceMode === "excel" ? "active" : ""}
          onClick={() => { setSourceMode("excel"); setInspection(null); setError(""); }}
          aria-pressed={sourceMode === "excel"}
        >
          <FileSpreadsheet size={16} /> 本地 Excel
        </button>
        <button
          type="button"
          className={sourceMode === "feishu" ? "active" : ""}
          onClick={() => setSourceMode("feishu")}
          aria-pressed={sourceMode === "feishu"}
        >
          <CloudDownload size={16} /> 飞书工作簿
        </button>
      </div>

      {/* ── 本地 Excel 文件选择 ── */}
      {isLocalMode ? (
        <div className="card">
          <div className="panel-title">
            <div>
              <span className="eyebrow">本地规则工作簿 · 纯浏览器</span>
              <h3>选择 Excel 文件</h3>
              <p>选择与 WQ8w registry 对齐的本地工作簿（如 钓具工具-权威.xlsx）。纯浏览器解析，不上传、不保存、刷新即失。</p>
            </div>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleLocalFile(file);
              // reset so same file can be re-selected
              if (fileInput.current) fileInput.current.value = "";
            }}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="button button-primary"
              onClick={() => fileInput.current?.click()}
              disabled={localParsing}
            >
              {localParsing ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
              {" "}{localParsing ? "正在解析…" : localFile ? "重新选择文件" : "选择本地 Excel"}
            </button>
            {localFile ? (
              <span style={{ fontSize: "0.875rem", color: "var(--color-muted)" }}>
                已载入：{localFile.name}（{(localFile.size / 1024).toFixed(1)} KB）
              </span>
            ) : null}
            {localFile ? (
              <button type="button" className="button button-default button-sm" onClick={() => {
                setInspection(null);
                setLocalFile(null);
                setError("");
                setAction("");
              }}>
                清除
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ── 飞书未认证时显示 OAuth CTA ── */}
      {feishuNeedsAuth ? (
        <div className="card">
          <AlertTriangle size={18} />
          <div>
            <strong>需要飞书登录</strong>
            <p>需要公司飞书账号才能读取飞书工作簿。匿名模式下仍可使用本地 Excel。</p>
          </div>
          <a className="button button-primary" href="/api/auth/feishu/start?return_to=%2F%3Fpage%3Drulesource">使用飞书登录</a>
        </div>
      ) : null}

      <div className="card rule-workbook-hero">
        <div>
          <span className="eyebrow">{isLocalMode ? "本地规则工作簿 · 临时会话" : "唯一通用规则源 · 整本工作簿"}</span>
          <h2>钓具设计工作簿</h2>
          <p>{isLocalMode ? "本地 Excel 文件解析结果，按稳定 ID 识别工作表。刷新后全部丢失。" : "链接中的工作表只是打开位置。读取范围始终覆盖整本工作簿，工作表按稳定 ID 识别。"}</p>
          {!isLocalMode ? (
            <a href={CANONICAL_FEISHU_WORKBOOK.shareUrl} target="_blank" rel="noreferrer">
              在飞书中查看 <ArrowRight size={14} />
            </a>
          ) : null}
        </div>
        <div className="rule-workbook-live">
          <span>当前观测 revision</span>
          <strong>{inspection?.sourceRevision.sourceRevision ?? "—"}</strong>
          <small>{action === "inspect" ? "正在读取…" : localParsing ? "正在解析…" : dateTime(inspection?.observedAt)}</small>
          {!isLocalMode ? (
            <button className="button button-default button-sm" type="button" onClick={() => void inspect()} disabled={Boolean(action) || !inspectAvailability.enabled} title={inspectAvailability.disabledReasonText}>
              {action === "inspect" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} 重新检查
            </button>
          ) : null}
        </div>
      </div>

      {!isLocalMode ? (
        <div className="card rule-source-combobox-card">
          <div className="panel-title">
            <div>
              <span className="eyebrow">设置 · 规则源地址</span>
              <h3>飞书表来源</h3>
              <p>
              粘贴飞书分享链接（/wiki/ 或 /sheets/）或从用过的地址中选择。规则源工作簿已切至 WQ8w（50张分表）。
            </p>
          </div>
        </div>
        <FeishuSourceCombobox
          history={props.state.feishuShareLinkHistory}
          availability={inspectAvailability}
          onRecord={props.onRecordShareLinkHistory}
          onRemove={(shareUrl) => props.onClearShareLinkHistory(shareUrl)}
          onClearAll={() => props.onClearShareLinkHistory(null)}
          notify={props.notify}
        />
      </div>
      ) : null}

      {error ? (
        <div className="card rule-workbook-error">
          <AlertTriangle size={20} />
          <div>
            <strong>暂时无法读取飞书工作簿</strong>
            <span className="rule-workbook-error-message">{error}</span>
            {errorDetail ? (
              <dl className="rule-workbook-error-detail">
                {errorDetail.httpStatus ? (
                  <><dt>飞书 HTTP</dt><dd>{errorDetail.httpStatus}</dd></>
                ) : null}
                {errorDetail.code !== undefined ? (
                  <><dt>飞书 code</dt><dd>{errorDetail.code}</dd></>
                ) : null}
                {errorDetail.msg ? (
                  <><dt>飞书返回</dt><dd>{errorDetail.msg}</dd></>
                ) : null}
                {errorDetail.endpoint ? (
                  <><dt>调用端点</dt><dd><code>{errorDetail.endpoint}</code></dd></>
                ) : null}
              </dl>
            ) : null}
          </div>
        </div>
      ) : null}

      {orchestrationModel ? (
        <FeishuOrchestrationWorkbench
          model={orchestrationModel}
          actionAvailabilities={props.actionAvailabilities}
          actionState={action}
          dirty={props.dirty}
          publishWarningBlocked={Boolean(sourceWarnings.length && ruleSetDraft && !warningReason.trim())}
          onInspect={() => void inspect()}
          onPull={() => void pull()}
          onCreateDraft={() => void createDraft()}
          onPublish={() => void publishRuleSet()}
        />
      ) : (
        <div className="card local-session-banner">
          <AlertTriangle size={18} />
          <div>
            <strong>本地临时会话</strong>
            <p>当前为本地 Excel 模式，刷新后丢失，不能正式发布。pull / RuleSet draft / publish / identity writeback 不可用。</p>
          </div>
        </div>
      )}

      {sourceWarnings.length && ruleSetDraft ? (
        <div style={{ marginTop: 8 }}>
          <input
            value={warningReason}
            onChange={(event) => setWarningReason(event.target.value)}
            placeholder={`确认 ${sourceWarnings.length} 项 warning 的理由`}
            aria-label="RuleSet warning 确认理由"
            style={{ width: "100%", minHeight: 36, padding: "6px 10px" }}
          />
        </div>
      ) : null}

      <div className="rule-workbook-grid">
        <div className="card rule-status-card">
          <div className="panel-title">
            <div><span className="eyebrow">稳定身份</span><h3>机器 ID 绑定</h3></div>
            <span className={!inspection ? "rule-badge warning" : conflicts ? "rule-badge danger" : "rule-badge success"}>
              {!inspection ? "等待回读" : conflicts ? "存在冲突" : "校验通过"}
            </span>
          </div>
          <div className="rule-metrics">
            <div><span>已绑定</span><strong>{inspection ? identified : "—"}</strong></div>
            <div><span>待确认新行</span><strong>{inspection ? pending.length : "—"}</strong></div>
            <div><span>冲突</span><strong>{inspection ? conflicts : "—"}</strong></div>
          </div>
          <p>已绑定 ID 不会被迁移器替换；未来缺 ID 的新行只进入 NEW_SOURCE_ROW，确认后才会回写。</p>
          {!inspection ? (
            <div className="rule-inline-error"><AlertTriangle size={16} />完成工作簿回读后才显示本次稳定 ID 校验结果。</div>
          ) : pending.length ? (
            <div className="rule-pending-list">
              {pending.slice(0, 8).map((item) => (
                <div key={item.itemId}><strong>{item.displayName}</strong><span>{item.proposedStableId ?? "等待分配 ID"}</span></div>
              ))}
            </div>
          ) : (
            <div className="rule-inline-ok"><CheckCircle2 size={16} /> 本次未发现缺失机器 ID 的新行</div>
          )}
        </div>

        <div className="card rule-status-card">
          <div className="panel-title">
            <div><span className="eyebrow">定价契约</span><h3>PricingPolicy 草稿</h3></div>
            <span className="rule-badge warning">{inspection ? "非正式" : "等待回读"}</span>
          </div>
          {inspection ? <div className="quality-basket-map">
            {[
              ["C / 绿", "跑刀"],
              ["B / 蓝", "稳健"],
              ["A / 紫", "猛攻"],
              ["S / 橙", "猛攻"],
            ].map(([quality, basket]) => <div key={quality}><strong>{quality}</strong><ArrowRight size={13} /><span>{basket}</span></div>)}
          </div> : null}
          <div className={!inspection || qualityMappingIssue ? "rule-inline-error" : "rule-inline-ok"}>
            {!inspection || qualityMappingIssue ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            {!inspection
              ? "尚未回读当前 PricingPolicyDraft，不能宣称源映射校验通过"
              : qualityMappingIssue
                ? "品质定价映射异常"
                : "品质映射已显式定义，不再是阻断原因"}
          </div>
          <div className="rule-missing-pricing">
            <strong>正式 Store 导出仍等待</strong>
            {!inspection
              ? <span>完成回读后列出当前 PricingPolicy 的精确缺参原因。</span>
              : missingPricing.map((issue) => <span key={issue.code}>{issue.message.replace("；正式定价不可发布。", "")}</span>)}
          </div>
          <small className="rule-band-policy">重量段策略：MATCHED_STRUCTURAL_SOURCE_BAND</small>
        </div>
      </div>

      {sourceMode === "feishu" && inspection ? (
        <>
          <IdentityMigrationPanel
            inspection={inspection as CanonicalRuleWorkbookInspection}
            baseRevision={props.revision}
            actorName={props.actorName}
            canWrite={identityWriteAvailability.enabled}
            writeDisabledReason={identityWriteAvailability.disabledReasonText}
            reportRegistered={identityReportRegistered}
            dirty={props.dirty}
            notify={props.notify}
          />
          <QualityValuePolicyPanel
            draft={inspection.qualityDraft}
            affixSheetRowCount={inspection.sourceRevision.sheets.find((sheet) => sheet.sheetId === AFFIX_SHEET_ID)?.rowCount}
          />
          <PricingPolicyDraftPanel draft={inspection.pricingDraft} />
        </>
      ) : null}

      <div className="card rule-boundary-card">
        <ShieldCheck size={20} />
        <div>
          <strong>边界已锁定</strong>
          <span>09_甘特图只作开发排期；11、12、14–17 不反向覆盖领域真相；正式配置仍由冻结 Snapshot 输出到本地 Git 配置仓库。</span>
        </div>
        <span className={!inspection ? "rule-badge warning" : workbookErrorCount ? "rule-badge danger" : workbookIssueCount ? "rule-badge warning" : "rule-badge success"}>
          {!inspection ? "等待 sheet_id 校验" : workbookErrorCount ? `${workbookErrorCount} 个错误 · ${workbookIssueCount - workbookErrorCount} 个告警` : workbookIssueCount ? `${workbookIssueCount} 个告警（无阻断错误）` : "全部校验通过"}
        </span>
      </div>

      {inspection && allWorkbookIssues.length > 0 ? (
        <WorkbookIssuePanel issues={allWorkbookIssues} />
      ) : null}
    </section>
  );
}

/** 按标签页分组展示全部 inspection 校验问题。 */
function WorkbookIssuePanel({ issues }: { issues: WorkbookIssueRow[] }) {
  const [expanded, setExpanded] = useState(false);

  // 按 sheetId 分组
  const grouped = useMemo(() => {
    const map = new Map<string, WorkbookIssueRow[]>();
    for (const issue of issues) {
      const key = issue.sheetName || issue.sheetId;
      const list = map.get(key);
      if (list) list.push(issue);
      else map.set(key, [issue]);
    }
    return [...map.entries()];
  }, [issues]);

  const errorCount = issues.filter((i) => i.level === "error").length;
  const warningCount = issues.length - errorCount;

  return (
    <div className="card">
      <button
        type="button"
        className="wb-issue-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <AlertTriangle size={16} />
        <span>
          {errorCount > 0 ? `${errorCount} 个解析错误` : ""}
          {errorCount > 0 && warningCount > 0 ? " · " : ""}
          {warningCount > 0 ? `${warningCount} 个结构告警` : ""}
        </span>
        <span className="wb-issue-toggle-hint">{expanded ? "收起" : "展开详情"}</span>
      </button>
      {expanded ? (
        <div className="wb-issue-list">
          {grouped.map(([sheetName, sheetIssues]) => (
            <div key={sheetName} className="wb-issue-group">
              <div className="wb-issue-group-header">
                <span className="wb-issue-sheet-name">{sheetName}</span>
                <span className="wb-issue-sheet-count">
                  {sheetIssues.filter((i) => i.level === "error").length || "—"} 错误 ·{" "}
                  {sheetIssues.filter((i) => i.level === "warning").length || "—"} 告警
                </span>
              </div>
              <ul className="wb-issue-rows">
                {sheetIssues.map((issue, index) => (
                  <li key={index} className={`wb-issue-row ${issue.level}`}>
                    <code className="wb-issue-code">{issue.code}</code>
                    <span className="wb-issue-location">
                      {issue.row ? `第 ${issue.row} 行` : null}
                      {issue.row && issue.cell ? " · " : null}
                      {issue.cell ? issue.cell : null}
                    </span>
                    <span className="wb-issue-message">{issue.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
