"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileWarning,
  LockKeyhole,
  PackageCheck,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  CONFIG_PREVIEW_NOTICE,
  type ConfigPreviewPackage,
} from "@/lib/config-preview-package";
import type { ActionAvailabilityMap } from "@/lib/interaction-contracts";
import {
  assertSnapshotBatchCanConfirm,
  planSnapshotBatch,
  snapshotBatchEligibleModels,
  type SnapshotBatchPlan,
} from "@/lib/snapshot-batch";
import type { WorkspaceState } from "@/lib/types";
import "./browser-config-export.css";

interface BrowserConfigExportWorkbenchProps {
  state: WorkspaceState;
  actionAvailabilities: ActionAvailabilityMap;
  identity: {
    workspaceId: string;
    userId: string;
  };
  notify: (message: string) => void;
}

function decisionLabel(decision: "reuse" | "create" | "skip") {
  if (decision === "reuse") return "复用冻结快照";
  if (decision === "create") return "待创建新快照";
  return "跳过";
}

function downloadPreview(previewPackage: ConfigPreviewPackage) {
  const url = URL.createObjectURL(new Blob(
    [JSON.stringify(previewPackage, null, 2)],
    { type: "application/json" },
  ));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${previewPackage.packageId.replace(/[^a-z0-9._-]/gi, "_")}.preview.report.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function BrowserConfigExportWorkbench({
  state,
  actionAvailabilities,
  notify,
}: BrowserConfigExportWorkbenchProps) {
  const currentExportModels = snapshotBatchEligibleModels({
    models: state.purchasableModels,
    series: state.seriesDefinitions,
    skus: state.skuDrawers,
  });
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(() =>
    currentExportModels
      .filter((model) => model.configurationSnapshotId)
      .map((model) => model.id),
  );
  const [batch, setBatch] = useState<SnapshotBatchPlan>();
  const [batchConfirmed, setBatchConfirmed] = useState(false);
  const [previewPackage, setPreviewPackage] = useState<ConfigPreviewPackage>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const previewAvailability = actionAvailabilities.preview_config_export;
  const commitAvailability = actionAvailabilities.commit_config_export;
  const enabledProductModels = useMemo(
    () => snapshotBatchEligibleModels({
      models: state.purchasableModels,
      series: state.seriesDefinitions,
      skus: state.skuDrawers,
    }),
    [
      state.purchasableModels,
      state.seriesDefinitions,
      state.skuDrawers,
    ],
  );
  const selectedSnapshotIds = useMemo(
    () => (batch?.items ?? [])
      .filter((item) => item.decision === "reuse" && item.snapshotId)
      .map((item) => item.snapshotId!),
    [batch],
  );
  const blockers = useMemo(() => {
    const values: string[] = [];
    if (!previewAvailability.enabled) {
      values.push(previewAvailability.disabledReasonText ?? "当前账号不能生成配置预览");
    }
    if (!batchConfirmed || !batch) values.push("请先确认 SnapshotBatch");
    if (!selectedSnapshotIds.length) values.push("没有可复用的冻结 Snapshot");
    if (batch?.items.some((item) => item.decision === "create")) {
      values.push("批次包含待创建 Snapshot；必须先由发布服务完成一次确认");
    }
    return [...new Set(values)];
  }, [batch, batchConfirmed, previewAvailability, selectedSnapshotIds.length]);

  const createBatch = () => {
    setBatch(planSnapshotBatch({
      models: state.purchasableModels,
      series: state.seriesDefinitions,
      skus: state.skuDrawers,
      snapshots: state.configurationSnapshots,
      selectedModelIds,
    }));
    setBatchConfirmed(false);
    setPreviewPackage(undefined);
    setError("");
  };

  const confirmBatch = () => {
    if (!batch) return;
    try {
      assertSnapshotBatchCanConfirm(batch);
      setBatchConfirmed(true);
      setPreviewPackage(undefined);
      notify("SnapshotBatch 已确认；一期只会生成不可提交的 NON_FORMAL 预览。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "SnapshotBatch 无法确认");
    }
  };

  const generatePreview = async () => {
    if (!batch || blockers.length) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/config-export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "preview",
          packageId: `config-preview-${batch.batchId}`,
          snapshotIds: selectedSnapshotIds,
        }),
      });
      const payload = await response.json() as {
        previewPackage?: ConfigPreviewPackage;
        error?: string;
      };
      if (!response.ok || !payload.previewPackage) {
        throw new Error(payload.error ?? "生成 NON_FORMAL 预览失败");
      }
      setPreviewPackage(payload.previewPackage);
      notify("已生成 CONFIG_PREVIEW / NON_FORMAL 报告；未绑定或写入任何本地目录。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "生成 NON_FORMAL 预览失败");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setBatch(undefined);
    setBatchConfirmed(false);
    setPreviewPackage(undefined);
    setError("");
  };

  return (
    <div className="config-export-page browser-config-export">
      <section className="config-export-hero">
        <div>
          <span className="eyebrow">PHASE 1 · CONFIG_PREVIEW · NON_FORMAL</span>
          <h2>配置关系预览</h2>
          <p>一期只生成符号引用关系报告；不提供正式 ID、生产文件、目录绑定、人工搬运包或配置提交。</p>
        </div>
        <div className="config-export-capabilities">
          <span className={previewAvailability.enabled ? "ok" : "blocked"}>
            {previewAvailability.enabled ? <CheckCircle2 size={14} /> : <LockKeyhole size={14} />}
            NON_FORMAL 预览
          </span>
          <span className="blocked" title={commitAvailability.disabledReasonText}>
            <LockKeyhole size={14} />正式提交禁用
          </span>
        </div>
      </section>

      <div className="config-export-warning">
        <ShieldCheck size={16} />
        {CONFIG_PREVIEW_NOTICE}。预览中的数字 ID 与正式 configNameKey 均为空，只使用 NON_FORMAL 符号引用。
      </div>

      <section className="config-export-panel">
        <header>
          <div><span className="eyebrow">SOURCE</span><h3>选择冻结 Snapshot</h3></div>
          <PackageCheck size={18} />
        </header>
        <div className="browser-model-grid">
          {enabledProductModels.map((model) => (
            <label key={model.id} className={selectedModelIds.includes(model.id) ? "selected" : ""}>
              <input
                type="checkbox"
                checked={selectedModelIds.includes(model.id)}
                onChange={() => setSelectedModelIds((current) =>
                  current.includes(model.id)
                    ? current.filter((id) => id !== model.id)
                    : [...current, model.id],
                )}
              />
              <span><strong>{model.name}</strong><small>{model.id} · revision {model.revision}</small></span>
              <em>{model.status}</em>
            </label>
          ))}
        </div>
        <button
          className="button button-default button-md"
          type="button"
          disabled={!selectedModelIds.length}
          onClick={createBatch}
        >
          生成批量预检
        </button>
        {batch ? (
          <div className="snapshot-batch-result">
            <div className="snapshot-batch-summary">
              {(["reuse", "create", "skip"] as const).map((decision) => (
                <div key={decision}>
                  <span>{decisionLabel(decision)}</span>
                  <strong>{batch.items.filter((item) => item.decision === decision).length}</strong>
                </div>
              ))}
            </div>
            {batch.items.map((item) => (
              <div className={`snapshot-batch-row ${item.decision}`} key={item.modelId}>
                <span><strong>{item.modelId}</strong><small>revision {item.modelRevision} · {item.reasons.join("、")}</small></span>
                <em>{decisionLabel(item.decision)}</em>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {previewPackage ? (
        <section className="config-export-panel">
          <header>
            <div><span className="eyebrow">NON_FORMAL MANIFEST</span><h3>符号关系检查报告</h3></div>
            <FileWarning size={18} />
          </header>
          <div className="snapshot-batch-summary">
            <div><span>packageKind</span><strong>{previewPackage.packageKind}</strong></div>
            <div><span>publicationState</span><strong>{previewPackage.publicationState}</strong></div>
            <div><span>formal</span><strong>{String(previewPackage.formal)}</strong></div>
            <div><span>符号对象</span><strong>{previewPackage.objects.length}</strong></div>
          </div>
          <div className="config-export-warning">
            <AlertTriangle size={16} />{previewPackage.notice}
          </div>
        </section>
      ) : null}

      {blockers.map((blocker) => (
        <div className="config-export-warning" key={blocker}><AlertTriangle size={16} />{blocker}</div>
      ))}
      {error ? <div className="config-export-error"><AlertTriangle size={16} />{error}</div> : null}

      <footer className="config-export-footer">
        <div>
          <span><LockKeyhole size={12} />{commitAvailability.disabledReasonText ?? "正式提交保持禁用"}</span>
        </div>
        {batch ? (
          <button type="button" className="button button-default button-md" onClick={reset}>
            <RotateCcw size={15} />重新开始
          </button>
        ) : null}
        {batch && !batchConfirmed ? (
          <button type="button" className="button button-primary button-md" onClick={confirmBatch}>
            一次确认 SnapshotBatch
          </button>
        ) : null}
        {batchConfirmed && !previewPackage ? (
          <button
            type="button"
            className="button button-primary button-md"
            disabled={Boolean(blockers.length) || busy}
            onClick={() => void generatePreview()}
          >
            {busy ? "生成中…" : "生成 NON_FORMAL 预览"}
          </button>
        ) : null}
        {previewPackage ? (
          <button
            type="button"
            className="button button-primary button-md"
            onClick={() => downloadPreview(previewPackage)}
          >
            <Download size={15} />下载预览关系报告
          </button>
        ) : null}
      </footer>
    </div>
  );
}
