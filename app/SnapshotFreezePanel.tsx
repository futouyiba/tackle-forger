"use client";

import {
  AlertTriangle,
  ArrowRight,
  LockKeyhole,
  LoaderCircle,
  PackageCheck,
} from "lucide-react";
import {
  type SnapshotFreezeModel,
  snapshotFreezeStateLabel,
} from "@/lib/snapshot-freeze-presentation";

// ─── Props ──────────────────────────────────────────────────────────────────

export interface SnapshotFreezePanelProps {
  model: SnapshotFreezeModel;
  reducedMotion: boolean;
  onApproveUpgrade?: () => void;
}

// ─── sub-components ─────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="sf-empty">
      <AlertTriangle size={28} />
      <strong>尚未发布 ConfigurationSnapshot</strong>
      <small>
        当前 Model 仍是草稿。完成阻断校验并执行 SnapshotBuild 成功后才显示冻结证据。
        已发布配置不会被上游规则静默重算。
      </small>
    </div>
  );
}

function BuildingState() {
  return (
    <div className="sf-building">
      <LoaderCircle className="spin" size={18} />
      <span>正在冻结 ConfigurationSnapshot…</span>
    </div>
  );
}

function BuildFailed({ model }: { model: SnapshotFreezeModel }) {
  return (
    <div className="sf-failed">
      <AlertTriangle size={18} />
      <div>
        <strong>SnapshotBuild 失败</strong>
        <small>冻结未完成，不存在半快照。请检查阻断原因后重试。幂等重试成功后只生成一个完成证据。</small>
      </div>
    </div>
  );
}

function FrozenEvidence({ model }: { model: SnapshotFreezeModel }) {
  const e = model.evidence;
  if (!e) return null;

  return (
    <div className={`sf-frozen${model.isReplay ? " is-replay" : ""}`}>
      <div className="sf-frozen-header">
        <LockKeyhole className="sf-frozen-lock" size={24} />
        <div>
          <h3>ConfigurationSnapshot</h3>
          <small>发布于 {new Date(e.publishedAt).toLocaleString("zh-CN")}</small>
        </div>
        <span className={`sf-frozen-tag${model.isReplay ? " replay" : ""}`}>
          {model.isReplay ? "FROZEN · 重播" : "IMMUTABLE"}
        </span>
      </div>
      <dl className="sf-frozen-evidence">
        <div className="sf-evidence-row">
          <dt>Snapshot ID</dt>
          <dd>{e.snapshotId}</dd>
        </div>
        <div className="sf-evidence-row">
          <dt>Version</dt>
          <dd>v{e.version}</dd>
        </div>
        <div className="sf-evidence-row">
          <dt>Content Hash</dt>
          <dd>{e.contentHash}</dd>
        </div>
        <div className="sf-evidence-row">
          <dt>Patch Set Hash</dt>
          <dd>{e.patchSetHash}</dd>
        </div>
        <div className="sf-evidence-row">
          <dt>RuleSet Version</dt>
          <dd>{e.ruleSetVersion}</dd>
        </div>
        <div className="sf-evidence-row">
          <dt>Projection</dt>
          <dd>{e.projectionId}</dd>
        </div>
        <div className="sf-evidence-row">
          <dt>发布人</dt>
          <dd>{e.publishedBy}</dd>
        </div>
        <div className="sf-evidence-row">
          <dt>面板字段 / Trace</dt>
          <dd>{e.panelFieldCount} 项{e.hasCalculationTrace ? " · 含完整 Trace" : ""}</dd>
        </div>
      </dl>
    </div>
  );
}

function UpgradeComparison({ model, onApproveUpgrade }: { model: SnapshotFreezeModel; onApproveUpgrade?: () => void }) {
  const c = model.upgradeCandidate;
  if (!c) return null;

  return (
    <div className="sf-upgrade">
      <div className="sf-upgrade-header">
        <PackageCheck size={18} />
        <div>
          <strong>检测到上游规则变化</strong>
          <em>RuleSet {c.proposedRuleSetVersion} · {c.patchRebaseSummary}</em>
        </div>
        <span className="sf-frozen-tag">
          {c.isApproved ? "已批准" : "待审批"}
        </span>
      </div>

      <div className="sf-compare">
        <div className="sf-compare-old">
          <h4>◆ 已冻结 Snapshot</h4>
          {model.evidence ? (
            <div style={{ fontSize: 10, color: "var(--muted)" }}>
              {model.evidence.snapshotId} · v{model.evidence.version} · {model.evidence.ruleSetVersion}
            </div>
          ) : null}
          <div className="sf-diff-rows" style={{ marginTop: 6 }}>
            {c.differences.map((diff) => (
              <div className="sf-diff-row" key={diff.path}>
                <span className="path">{diff.path}</span>
                <span className="old">{diff.oldValue}</span>
                <ArrowRight size={12} className="arrow" />
                <span className="new">{diff.newValue}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="sf-compare-new">
          <h4>◆ 升级候选 UpgradeCandidate</h4>
          <div style={{ fontSize: 10, color: "var(--muted)" }}>
            {c.candidateId} · {new Date(c.createdAt).toLocaleString("zh-CN")}
          </div>
          <div className="sf-diff-rows" style={{ marginTop: 6 }}>
            {c.differences.map((diff) => (
              <div className="sf-diff-row" key={diff.path}>
                <span className="path">{diff.path}</span>
                <span style={{ textDecoration: "line-through", color: "var(--muted)", textAlign: "right" }}>{diff.oldValue}</span>
                <ArrowRight size={12} className="arrow" />
                <span style={{ color: "var(--accent-dark)", fontWeight: 700 }}>{diff.newValue}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="sf-upgrade-actions">
        {c.isApproved ? (
          <span className="approved-notice">
            已批准升级候选。旧 Snapshot 保持不变，需显式发布新 Snapshot 后才生效。
          </span>
        ) : onApproveUpgrade ? (
          <button type="button" className="button button-primary button-sm" onClick={onApproveUpgrade}>
            <PackageCheck size={14} /> 批准升级候选
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ─── main component ─────────────────────────────────────────────────────────

export function SnapshotFreezePanel({
  model,
  onApproveUpgrade,
}: SnapshotFreezePanelProps) {
  return (
    <div className="sf-panel" role="region" aria-label={snapshotFreezeStateLabel(model.state)}>
      {model.state === "NO_SNAPSHOT" ? <EmptyState /> : null}
      {model.state === "BUILDING" ? <BuildingState /> : null}
      {model.state === "BUILD_FAILED" ? <BuildFailed model={model} /> : null}
      {(model.state === "FROZEN" || model.state === "UPGRADE_AVAILABLE") ? (
        <>
          <FrozenEvidence model={model} />
          {model.state === "UPGRADE_AVAILABLE" ? (
            <UpgradeComparison model={model} onApproveUpgrade={onApproveUpgrade} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
