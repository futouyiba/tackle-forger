"use client";

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  calculatePricingTrial,
  type PricingPolicyDraft,
  type PricingTrialResult,
} from "@/lib/pricing-policy";
import type { CanonicalRuleWorkbookInspection } from "@/lib/rule-workbook-inspection";
import type { QualityValuePolicyDraft } from "@/lib/quality-value-policy";
import type {
  SourceIdentityConfirmation,
  StableIdWriteResult,
} from "@/lib/source-id-migration";
import { issueClientActionCommand } from "@/lib/client-action-command";
import "./rule-workbook-governance.css";

interface IdentityMigrationPanelProps {
  inspection: CanonicalRuleWorkbookInspection;
  baseRevision: number;
  actorName: string;
  canWrite: boolean;
  writeDisabledReason?: string;
  reportRegistered: boolean;
  dirty: boolean;
  notify: (message: string) => void;
}

interface ConfirmationDraft {
  decision: SourceIdentityConfirmation["decision"];
  stableId: string;
}

export function IdentityMigrationPanel({
  inspection,
  baseRevision,
  actorName,
  canWrite,
  writeDisabledReason,
  reportRegistered,
  dirty,
  notify,
}: IdentityMigrationPanelProps) {
  const report = inspection.identityReport;
  const pending = report.items.filter((item) => item.requiresHumanConfirmation);
  const [drafts, setDrafts] = useState<Record<string, ConfirmationDraft>>(() =>
    Object.fromEntries(pending.map((item) => [
      item.itemId,
      {
        decision: item.candidateEntityIds.length === 1 ? "MATCH_EXISTING" : "ASSIGN_NEW",
        stableId: item.proposedStableId ?? item.candidateEntityIds[0] ?? "",
      },
    ])),
  );
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<StableIdWriteResult>();
  const [error, setError] = useState("");
  const confirmations = useMemo(() => pending
    .filter((item) => confirmed[item.itemId])
    .map((item): SourceIdentityConfirmation => ({
      itemId: item.itemId,
      confirmedStableId: drafts[item.itemId]?.stableId.trim() ?? "",
      decision: drafts[item.itemId]?.decision ?? "ASSIGN_NEW",
      confirmedBy: actorName,
    })), [actorName, confirmed, drafts, pending]);
  const ready = pending.length > 0 &&
    confirmations.length === pending.length &&
    confirmations.every((item) => item.confirmedStableId) &&
    !report.blockingIssueCodes.length &&
    !dirty &&
    reportRegistered &&
    canWrite;

  const write = async () => {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const businessPayload = {
        action: "identity_write",
        baseRevision,
        reportId: report.reportId,
        confirmations,
      };
      const invocation = await issueClientActionCommand({
        action: "write_feishu_identity",
        idempotencyKey:
          `write-feishu-identity:${baseRevision}:${report.reportId}:` +
          crypto.randomUUID(),
        payload: businessPayload,
      });
      const response = await fetch("/api/feishu-workbook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invocation),
      });
      const payload = (await response.json()) as {
        result?: StableIdWriteResult;
        requiresExplicitPull?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.result) throw new Error(payload.error || "稳定 ID 回写失败");
      setResult(payload.result);
      notify(payload.result.state === "WRITE_VERIFIED"
        ? "稳定 ID 已写回并回读验证；远端变化待显式拉取。"
        : "稳定 ID 回写未完成，请按结果恢复。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "稳定 ID 回写失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card identity-migration-panel">
      <div className="panel-title">
        <div><span className="eyebrow">ONE-TIME ID MIGRATION</span><h3>人工确认与回写</h3></div>
        <span className={report.blockingIssueCodes.length ? "rule-badge danger" : "rule-badge success"}>
          {report.mode} · revision {report.sourceRevision}
        </span>
      </div>
      <p>名称只用于首次候选。确认后写入稳定 ID 并技术回读；写回成功不会自动拉取或发布 RuleSetVersion。</p>
      {pending.map((item) => {
        const draft = drafts[item.itemId] ?? { decision: "ASSIGN_NEW", stableId: item.proposedStableId ?? "" };
        return (
          <article className="identity-confirmation-row" key={item.itemId}>
            <header>
              <label>
                <input type="checkbox" checked={Boolean(confirmed[item.itemId])} onChange={(event) => setConfirmed((current) => ({ ...current, [item.itemId]: event.target.checked }))} />
                <span><strong>{item.displayName}</strong><small>{item.sheetId} / row {item.rowKey} · {item.sourceEntityType}</small></span>
              </label>
              <em>{item.state}</em>
            </header>
            <div className="identity-match-evidence">
              <span>旧显示键：{item.legacyDisplayKey}</span>
              <span>候选：{item.candidateEntityIds.join("、") || "无旧对象候选"}</span>
              <span>原因：{item.reasons.join("；")}</span>
            </div>
            <div className="identity-decision">
              <select value={draft.decision} onChange={(event) => setDrafts((current) => ({ ...current, [item.itemId]: { ...draft, decision: event.target.value as SourceIdentityConfirmation["decision"] } }))}>
                <option value="MATCH_EXISTING" disabled={!item.candidateEntityIds.length}>匹配已有稳定对象</option>
                <option value="ASSIGN_NEW">分配新稳定 ID</option>
              </select>
              {draft.decision === "MATCH_EXISTING" && item.candidateEntityIds.length ? (
                <select value={draft.stableId} onChange={(event) => setDrafts((current) => ({ ...current, [item.itemId]: { ...draft, stableId: event.target.value } }))}>
                  {item.candidateEntityIds.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              ) : (
                <input value={draft.stableId} onChange={(event) => setDrafts((current) => ({ ...current, [item.itemId]: { ...draft, stableId: event.target.value } }))} placeholder={item.proposedStableId ?? "稳定 ID"} />
              )}
            </div>
          </article>
        );
      })}
      {!pending.length ? <div className="rule-inline-ok"><CheckCircle2 size={16} />当前没有需要人工确认的缺 ID 行。</div> : null}
      {report.blockingIssueCodes.map((code) => <div className="rule-inline-error" key={code}><AlertTriangle size={16} />{code}</div>)}
      {result ? (
        <div className={result.state === "WRITE_VERIFIED" ? "identity-write-result success" : "identity-write-result danger"}>
          <strong>{result.state}</strong>
          <span>{result.commands.length} 个写入命令 · {result.recoveredAfterWriteError ? "写入错误后通过回读恢复" : "正常回读"}</span>
          {result.verificationErrors.map((message) => <small key={message}>{message}</small>)}
          {result.state === "WRITE_VERIFIED" ? <em>REMOTE_CHANGES_AVAILABLE · 请重新检查后显式拉取</em> : null}
        </div>
      ) : null}
      {error ? <div className="rule-inline-error"><AlertTriangle size={16} />{error}</div> : null}
      <footer>
        <div>{dirty
          ? "工作区有未保存修改，禁止回写。"
          : !canWrite
            ? writeDisabledReason ?? "当前用户不能回写稳定 ID。"
            : !reportRegistered
              ? "请先显式拉取并登记本次迁移报告，再执行回写。"
              : `已确认 ${confirmations.length}/${pending.length}`}</div>
        <button className="button button-primary button-sm" type="button" disabled={!ready || busy} onClick={() => void write()}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}人工确认并回写 ID
        </button>
      </footer>
    </section>
  );
}

function sourceLabel(source: { sheetId: string; cell: string; label?: string }) {
  return `${source.sheetId}!${source.cell}${source.label ? ` · ${source.label}` : ""}`;
}

export function QualityValuePolicyPanel({ draft }: { draft: QualityValuePolicyDraft }) {
  return (
    <section className="card pricing-trial-panel">
      <div className="panel-title">
        <div><span className="eyebrow">QUALITY VALUE POLICY</span><h3>品质评分策略与组合 Trace</h3></div>
        <span className={draft.formalStatus === "READY_TO_PUBLISH" ? "rule-badge success" : "rule-badge warning"}>
          {draft.formalStatus}
        </span>
      </div>
      <p>品质由设计人员选择；这里仅校验最终评分是否命中所选区间，不会自动改变品质。Technology 只展开成员并按稳定 affixId 去重。</p>
      <div className="quality-basket-map pricing-map">
        {draft.ranges.map((range) => (
          <div key={range.qualityId}>
            <strong>{range.qualityId}</strong>
            <span>[{range.minScore}, {range.maxScore}{range.maxInclusive ? "]" : ")"}</span>
            <small>{sourceLabel(range.source)} · revision {draft.sourceRevision}</small>
          </div>
        ))}
      </div>
      <div className="pricing-blockers">
        <strong>{draft.combinationRules.length} 个稳定 ID 无序词条组合 · 单元格级 Trace</strong>
        {draft.issues.map((issue) => (
          <span key={`${issue.code}:${issue.sourceCell?.cell ?? ""}`}>
            <AlertTriangle size={13} />
            {issue.code} · {issue.message}
            {issue.sourceCell ? ` · ${sourceLabel(issue.sourceCell)}` : ""}
            {issue.actions.map((action) => <a key={action.label} href={action.targetRoute}>{action.label}</a>)}
          </span>
        ))}
      </div>
    </section>
  );
}

function sourceRows(draft: PricingPolicyDraft) {
  return [
    ...draft.maintenanceConsumptionRates.map((entry) => ({ step: "maintenanceConsumptionRate", key: `${entry.pricingWeightBandId} × ${entry.pricingBasketId}`, value: entry.value })),
    ...draft.partAllocationRatios.map((entry) => ({ step: "partAllocationRatio", key: `${entry.partId} × ${entry.pricingWeightBandId}`, value: entry.value })),
    ...draft.repairCoefficients.map((entry) => ({ step: "repairCoefficient", key: `${entry.partId} × ${entry.typeId}`, value: entry.value })),
    ...draft.totalLossTimes.map((entry) => ({ step: "totalLossTime", key: `${entry.partId} × ${entry.pricingWeightBandId} × ${entry.pricingBasketId}`, value: entry.value })),
    ...draft.purchaseCoefficients.map((entry) => ({ step: "purchaseCoefficient", key: `${entry.partId} × ${entry.typeId}`, value: entry.value })),
    ...draft.partsToWholeRatios.map((entry) => ({ step: "partsToWholeRatio", key: entry.partId, value: entry.value })),
  ];
}

export function PricingPolicyDraftPanel({
  draft,
}: {
  draft: PricingPolicyDraft;
}) {
  const parts = [...new Set([
    ...draft.partAllocationRatios.map((entry) => entry.partId),
    ...draft.repairCoefficients.map((entry) => entry.partId),
  ])];
  const types = [...new Set(draft.repairCoefficients.map((entry) => entry.typeId))];
  const bands = [...new Set(draft.maintenanceConsumptionRates.map((entry) => entry.pricingWeightBandId))];
  const [partId, setPartId] = useState(parts[0] ?? "");
  const [typeId, setTypeId] = useState(types[0] ?? "");
  const [bandId, setBandId] = useState(bands[0] ?? "");
  const [qualityId, setQualityId] = useState<"quality_c_green" | "quality_b_blue" | "quality_a_purple" | "quality_s_orange">("quality_c_green");
  const [valueScore, setValueScore] = useState(50);
  const [trial, setTrial] = useState<PricingTrialResult>();
  const [error, setError] = useState("");

  const calculate = () => {
    setError("");
    try {
      setTrial(calculatePricingTrial({
        policy: draft,
        partId,
        typeId,
        pricingWeightBandId: bandId,
        valueScore,
        qualityId,
      }));
    } catch (caught) {
      setTrial(undefined);
      setError(caught instanceof Error ? caught.message : "价格试算失败");
    }
  };

  return (
    <section className="card pricing-trial-panel">
      <div className="panel-title">
        <div><span className="eyebrow">PRICING POLICY DRAFT</span><h3>非正式价格试算与来源 Trace</h3></div>
        <span className="rule-badge warning">{draft.formalStatus}</span>
      </div>
      <p>重量段固定使用最近结构标杆携带的源重量段 ID，不会按最终拉力二次分段。未发布参数不提供手填兜底。</p>
      <div className="pricing-trial-form">
        <label><span>部位</span><select value={partId} onChange={(event) => setPartId(event.target.value)}>{parts.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>类型</span><select value={typeId} onChange={(event) => setTypeId(event.target.value)}>{types.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>结构标杆源重量段</span><select value={bandId} onChange={(event) => setBandId(event.target.value)}>{bands.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>品质</span><select value={qualityId} onChange={(event) => setQualityId(event.target.value as typeof qualityId)}><option value="quality_c_green">C / 绿</option><option value="quality_b_blue">B / 蓝</option><option value="quality_a_purple">A / 紫</option><option value="quality_s_orange">S / 橙</option></select></label>
        <label><span>valueScore</span><input type="number" value={valueScore} onChange={(event) => setValueScore(Number(event.target.value))} /></label>
        <button className="button button-default button-sm" type="button" onClick={calculate}>试算</button>
      </div>
      <div className="quality-basket-map pricing-map">
        {draft.qualityMappings.map((mapping) => <div key={mapping.qualityId}><strong>{mapping.qualityId}</strong><ArrowRight size={13} /><span>{mapping.pricingBasketId}</span><small>{sourceLabel(mapping.source)}</small></div>)}
      </div>
      {error ? <div className="rule-inline-error"><AlertTriangle size={16} />{error}</div> : null}
      {trial ? (
        <div className="pricing-trial-result">
          <div><span>repairPrice</span><strong>{trial.repairPriceUnrounded}</strong></div>
          <div><span>purchasePrice（未舍入）</span><strong>{trial.purchasePriceUnrounded}</strong></div>
          <div><span>正式价格</span><strong>{trial.purchasePrice ?? "不可用"}</strong><small>{trial.moneyUnit ?? "金额单位未发布"}</small></div>
          <span className="rule-badge warning">非正式 · 不得用于 Store</span>
          <div className="pricing-trace-table">
            {trial.trace.map((entry) => <div key={entry.sequence}><span>{entry.sequence}</span><strong>{entry.formulaStep}</strong><span>{entry.before}</span><span>{entry.operation}</span><span>{entry.operand}</span><span>{entry.after}</span><small>{sourceLabel(entry.source)} · {entry.inputStatus}</small></div>)}
          </div>
        </div>
      ) : (
        <div className="pricing-source-table">
          <header><span>公式步骤</span><span>匹配键</span><span>值</span><span>状态</span><span>来源单元格</span></header>
          {sourceRows(draft).slice(0, 80).map((entry, index) => <div key={`${entry.step}:${entry.key}:${index}`}><span>{entry.step}</span><span>{entry.key}</span><strong>{entry.value.value}</strong><span>{entry.value.status}</span><span>{sourceLabel(entry.value.source)}</span></div>)}
        </div>
      )}
      <div className="pricing-blockers">
        <strong>正式 Store 阻断</strong>
        {draft.issues.map((issue) => <span key={issue.code}><AlertTriangle size={13} />{issue.code} · {issue.message}{issue.source ? ` · ${sourceLabel(issue.source)}` : ""}</span>)}
      </div>
    </section>
  );
}
