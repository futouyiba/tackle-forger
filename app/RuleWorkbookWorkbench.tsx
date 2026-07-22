"use client";

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ActionAvailabilityMap } from "@/lib/interaction-contracts";
import type { CanonicalRuleWorkbookInspection } from "@/lib/rule-workbook-inspection";
import type { WorkspaceState } from "@/lib/types";
import {
  IdentityMigrationPanel,
  PricingPolicyDraftPanel,
  QualityValuePolicyPanel,
} from "./RuleWorkbookGovernancePanels";

interface RuleWorkbookWorkbenchProps {
  state: WorkspaceState;
  revision: number;
  dirty: boolean;
  actionAvailabilities: ActionAvailabilityMap;
  actorName: string;
  onWorkspaceApplied: (state: WorkspaceState, revision: number, message: string) => void;
  notify: (message: string) => void;
}

type ActionState = "" | "inspect" | "pull" | "draft";

function dateTime(value?: string) {
  if (!value) return "尚未读取";
  return new Date(value).toLocaleString("zh-CN");
}

export function RuleWorkbookWorkbench(props: RuleWorkbookWorkbenchProps) {
  const [inspection, setInspection] = useState<CanonicalRuleWorkbookInspection | null>(null);
  const [action, setAction] = useState<ActionState>("");
  const [error, setError] = useState("");

  const inspect = async () => {
    setAction("inspect");
    setError("");
    try {
      const response = await fetch("/api/feishu-workbook", { cache: "no-store" });
      const payload = (await response.json()) as {
        inspection?: CanonicalRuleWorkbookInspection;
        error?: string;
      };
      if (!response.ok || !payload.inspection) throw new Error(payload.error || "读取规则工作簿失败");
      setInspection(payload.inspection);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取规则工作簿失败");
    } finally {
      setAction("");
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/feishu-workbook", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as {
          inspection?: CanonicalRuleWorkbookInspection;
          error?: string;
        };
        if (!response.ok || !payload.inspection) throw new Error(payload.error || "读取规则工作簿失败");
        setInspection(payload.inspection);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "读取规则工作簿失败");
      });
    return () => controller.abort();
  }, []);

  const savedSource = useMemo(() => {
    const sourceRevision = inspection?.sourceRevision.sourceRevision;
    return sourceRevision
      ? props.state.feishuSourceRevisions.find((item) => item.sourceRevision === sourceRevision)
      : undefined;
  }, [inspection, props.state.feishuSourceRevisions]);

  const ruleSetDraft = savedSource
    ? props.state.ruleSetVersions.find((item) =>
      item.status === "draft" && item.sourceRevisionIds.includes(savedSource.id))
    : undefined;
  const identityItems = inspection?.identityReport.items ?? [];
  const identified = identityItems.filter((item) => item.state === "ALREADY_IDENTIFIED").length;
  const pending = identityItems.filter((item) => item.state === "NEW_SOURCE_ROW" || item.requiresHumanConfirmation);
  const conflicts = identityItems.filter((item) => item.state === "CONFLICT").length;
  const identityReportRegistered = inspection
    ? props.state.sourceIdentityMigrationReports.some((item) => item.reportId === inspection.identityReport.reportId)
    : false;
  const registryErrors = inspection?.sourceRevision.issues.filter((issue) => issue.severity === "error") ?? [];
  const registryWarnings = inspection?.sourceRevision.issues.filter((issue) => issue.severity === "warning") ?? [];
  const qualityMappingIssue = inspection?.pricingDraft.issues.some((issue) =>
    issue.code.startsWith("QUALITY_PRICING_MAPPING_"));
  const missingPricing = inspection?.pricingDraft.issues.filter((issue) =>
    ["PRICING_INTERPOLATION_MISSING", "PARTS_TO_WHOLE_RATIO_MISSING", "PRICING_MONEY_POLICY_MISSING", "PRICING_EXECUTION_SEMANTICS_MISSING"].includes(issue.code)) ?? [];
  const inspectAvailability = props.actionAvailabilities.inspect_feishu_workbook;
  const pullAvailability = props.actionAvailabilities.pull_feishu_workbook;
  const draftAvailability = props.actionAvailabilities.create_ruleset_draft;
  const identityWriteAvailability = props.actionAvailabilities.write_feishu_identity;

  const pull = async () => {
    if (!inspection) return;
    setAction("pull");
    try {
      const response = await fetch("/api/feishu-workbook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "pull",
          baseRevision: props.revision,
          expectedSourceRevision: inspection.sourceRevision.sourceRevision,
        }),
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
      props.onWorkspaceApplied(payload.state, payload.revision, `已登记飞书 revision ${payload.inspection?.sourceRevision.sourceRevision ?? ""}`);
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
      const response = await fetch("/api/feishu-workbook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create_ruleset_draft",
          baseRevision: props.revision,
          sourceRevisionId: savedSource.id,
        }),
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

  return (
    <section className="rule-workbook-stack" aria-label="飞书唯一规则工作簿">
      <div className="card rule-workbook-hero">
        <div>
          <span className="eyebrow">唯一通用规则源 · 整本工作簿</span>
          <h2>钓具设计工作簿</h2>
          <p>链接中的“06_系列”只是打开位置。读取范围始终覆盖整本工作簿，工作表按稳定 ID 识别。</p>
          <a href="https://pisn3u3ony2.feishu.cn/wiki/YsEKwSUJ5i86HCkZKBVcNMw7nOh?from=from_copylink&sheet=9nE3Rx" target="_blank" rel="noreferrer">
            在飞书中查看 <ArrowRight size={14} />
          </a>
        </div>
        <div className="rule-workbook-live">
          <span>当前观测 revision</span>
          <strong>{inspection?.sourceRevision.sourceRevision ?? "—"}</strong>
          <small>{action === "inspect" ? "正在读取…" : dateTime(inspection?.observedAt)}</small>
          <button className="button button-default button-sm" type="button" onClick={() => void inspect()} disabled={Boolean(action) || !inspectAvailability.enabled} title={inspectAvailability.disabledReasonText}>
            {action === "inspect" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} 重新检查
          </button>
        </div>
      </div>

      {error ? (
        <div className="card rule-workbook-error">
          <AlertTriangle size={20} />
          <div><strong>暂时无法读取飞书工作簿</strong><span>{error}</span></div>
        </div>
      ) : null}

      <div className="rule-workbook-flow">
        <div className="card">
          <span className="rule-step">01 · 检查</span>
          <strong>回读工作簿</strong>
          <small>只读取结构、revision、机器 ID 与定价契约，不修改任何规则。</small>
          <em className={inspection ? "is-ok" : ""}>{inspection ? "本次观测完成" : "等待连接"}</em>
        </div>
        <ArrowRight size={18} />
        <div className="card">
          <span className="rule-step">02 · 显式动作</span>
          <strong>登记源修订</strong>
          <small>生成 FeishuSourceRevision、ID 报告与 PricingPolicyDraft；不发布规则。</small>
          <button
            className="button button-primary button-sm"
            type="button"
            disabled={Boolean(action) || props.dirty || !inspection || Boolean(registryErrors.length) || !pullAvailability.enabled}
            title={pullAvailability.disabledReasonText}
            onClick={() => void pull()}
          >
            {action === "pull" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
            {savedSource ? "重新显式拉取" : "显式拉取"}
          </button>
        </div>
        <ArrowRight size={18} />
        <div className="card">
          <span className="rule-step">03 · 独立动作</span>
          <strong>创建 RuleSet 草稿</strong>
          <small>草稿仍不生效。正式发布必须在规则审查流程中单独完成。</small>
          <button
            className="button button-default button-sm"
            type="button"
            disabled={Boolean(action) || props.dirty || !savedSource || Boolean(ruleSetDraft) || !draftAvailability.enabled}
            title={draftAvailability.disabledReasonText}
            onClick={() => void createDraft()}
          >
            {action === "draft" ? <LoaderCircle className="spin" size={14} /> : <FileSpreadsheet size={14} />}
            {ruleSetDraft ? "草稿已创建" : "创建规则草稿"}
          </button>
        </div>
      </div>

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
                ? "品质到 PricingBasket 映射异常"
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

      {inspection ? (
        <>
          <IdentityMigrationPanel
            inspection={inspection}
            baseRevision={props.revision}
            actorName={props.actorName}
            canWrite={identityWriteAvailability.enabled}
            writeDisabledReason={identityWriteAvailability.disabledReasonText}
            reportRegistered={identityReportRegistered}
            dirty={props.dirty}
            notify={props.notify}
          />
          <QualityValuePolicyPanel draft={inspection.qualityDraft} />
          <PricingPolicyDraftPanel draft={inspection.pricingDraft} />
        </>
      ) : null}

      <div className="card rule-boundary-card">
        <ShieldCheck size={20} />
        <div>
          <strong>边界已锁定</strong>
          <span>09_甘特图只作开发排期；11、12、14–17 不反向覆盖领域真相；正式配置仍由冻结 Snapshot 输出到本地 Git 配置仓库。</span>
        </div>
        <span className={!inspection || registryErrors.length || registryWarnings.length ? "rule-badge warning" : "rule-badge success"}>
          {!inspection ? "等待 sheet_id 校验" : registryErrors.length ? `${registryErrors.length} 个注册表错误` : registryWarnings.length ? `${registryWarnings.length} 个名称告警` : "18 张表已按 ID 校验"}
        </span>
      </div>
    </section>
  );
}
