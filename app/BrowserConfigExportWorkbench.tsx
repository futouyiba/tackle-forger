"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderCheck,
  FolderCog,
  KeyRound,
  LockKeyhole,
  PackageCheck,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  browserDirectoryPickerAvailable,
  chooseAndSaveDirectory,
  commitBrowserExport,
  inspectDirectoryBinding,
  previewBrowserExport,
  requestDirectoryWritePermission,
  type BrowserExportPreview,
  type BrowserRecoveryManifest,
  type BrowserDirectoryBindingStatus,
  type LocalExportTargetBinding,
} from "@/lib/browser-config-export";
import type { ActionAvailabilityMap } from "@/lib/interaction-contracts";
import {
  assertSnapshotBatchCanConfirm,
  planSnapshotBatch,
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

type ExportStage = "batch" | "targets" | "preview" | "confirm";

function logicalBindingStorageKey(identity: BrowserConfigExportWorkbenchProps["identity"]) {
  return `tackle-forger:local-export-bindings:${identity.workspaceId}:${identity.userId}`;
}

function readLogicalBindings(identity: BrowserConfigExportWorkbenchProps["identity"]): LocalExportTargetBinding[] {
  if (typeof window === "undefined" || !identity.workspaceId || !identity.userId) return [];
  try {
    const raw = window.localStorage.getItem(logicalBindingStorageKey(identity));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.map((entry) => ({
          ...entry,
          mappingId: typeof entry.mappingId === "string" ? entry.mappingId : "",
          mappingVersion: typeof entry.mappingVersion === "string" ? entry.mappingVersion : "",
        }))
      : [];
  } catch {
    return [];
  }
}

function saveLogicalBindings(
  identity: BrowserConfigExportWorkbenchProps["identity"],
  bindings: LocalExportTargetBinding[],
) {
  if (typeof window === "undefined" || !identity.workspaceId || !identity.userId) return;
  window.localStorage.setItem(logicalBindingStorageKey(identity), JSON.stringify(bindings));
}

function decisionLabel(decision: "reuse" | "create" | "skip") {
  if (decision === "reuse") return "复用冻结快照";
  if (decision === "create") return "创建新快照";
  return "跳过";
}

function permissionLabel(status?: BrowserDirectoryBindingStatus) {
  if (!status || status.permissionState === "unbound") return "未绑定";
  if (status.permissionState === "bound_granted") return "已绑定并授权";
  if (status.permissionState === "bound_needs_permission") return "需要重新授权";
  return "目录失效";
}

function downloadJson(fileName: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function BrowserConfigExportWorkbench({
  state,
  actionAvailabilities,
  identity,
  notify,
}: BrowserConfigExportWorkbenchProps) {
  const [stage, setStage] = useState<ExportStage>("batch");
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(() =>
    state.purchasableModels
      .filter((model) => model.configurationSnapshotId)
      .map((model) => model.id),
  );
  const [batch, setBatch] = useState<SnapshotBatchPlan>();
  const [batchConfirmed, setBatchConfirmed] = useState(false);
  const [bindings, setBindings] = useState<LocalExportTargetBinding[]>(() =>
    readLogicalBindings(identity),
  );
  const [bindingStatuses, setBindingStatuses] = useState<Record<string, BrowserDirectoryBindingStatus>>({});
  const [environmentId, setEnvironmentId] = useState("dev");
  const [channelKey, setChannelKey] = useState("1001");
  const [userLabel, setUserLabel] = useState("开发环境 / 1001");
  const [error, setError] = useState("");
  const [previews, setPreviews] = useState<Record<string, BrowserExportPreview>>({});
  const [commitResults, setCommitResults] = useState<Record<string, BrowserRecoveryManifest | { error: string }>>({});
  const [busy, setBusy] = useState(false);

  const previewAvailability = actionAvailabilities.preview_config_export;
  const commitAvailability = actionAvailabilities.commit_config_export;
  const pickerAvailable = typeof window === "undefined"
    ? true
    : browserDirectoryPickerAvailable();

  useEffect(() => {
    let active = true;
    void Promise.all(bindings.map((binding) => inspectDirectoryBinding(binding)))
      .then((statuses) => {
        if (!active) return;
        setBindingStatuses(Object.fromEntries(statuses.map((status) => [
          status.binding.bindingId,
          status,
        ])));
      });
    return () => {
      active = false;
    };
  }, [bindings]);

  const selectedSnapshots = useMemo(() => {
    const snapshotIds = new Set(
      (batch?.items ?? [])
        .filter((item) => item.decision === "reuse" && item.snapshotId)
        .map((item) => item.snapshotId!),
    );
    return state.configurationSnapshots.filter((snapshot) => snapshotIds.has(snapshot.id));
  }, [batch, state.configurationSnapshots]);

  const previewBlockers = useMemo(() => {
    const blockers: string[] = [];
    if (!batchConfirmed || !batch) blockers.push("请先确认 SnapshotBatch");
    if (!bindings.length) blockers.push("请绑定至少一个环境×渠道目标");
    if (!previewAvailability.enabled) {
      blockers.push(previewAvailability.disabledReasonText ?? "当前用户不能生成导出预览");
    }
    for (const binding of bindings) {
      const status = bindingStatuses[binding.bindingId];
      if (status?.permissionState !== "bound_granted") {
        blockers.push(`${binding.userLabel} 尚未获得目录读写授权`);
      }
    }
    if (batch?.items.some((item) => item.decision === "create")) {
      blockers.push("批次包含待创建 Snapshot；必须先由发布服务完成一次确认");
    }
    if (selectedSnapshots.some((snapshot) =>
      !snapshot.pricingPolicyVersion || !snapshot.automaticPricing?.formal)) {
      blockers.push("PricingPolicy 其余必填参数尚未发布，正式 Store 导出被阻断");
    }
    for (const binding of bindings) {
      if (!binding.mappingId || !binding.mappingVersion) {
        blockers.push(`${binding.userLabel} 未绑定已发布 ConfigExportMapping`);
      } else if (!state.configExportMappings.some((mapping) =>
        mapping.mappingId === binding.mappingId && mapping.version === binding.mappingVersion)) {
        blockers.push(`${binding.userLabel} 的 ConfigExportMapping 内容不存在或版本不一致`);
      }
      if (binding.targetKind === "EXPLICIT_CHANNEL_DIRECTORY" && !bindings.some((candidate) =>
        candidate.environmentId === binding.environmentId && candidate.targetKind === "DEFAULT_1001")) {
        blockers.push(`${binding.userLabel} 缺少同环境 1001 根目录绑定，无法读取 config.toml`);
      }
    }
    return [...new Set(blockers)];
  }, [
    batch,
    batchConfirmed,
    bindingStatuses,
    bindings,
    previewAvailability,
    selectedSnapshots,
    state.configExportMappings,
  ]);

  const createBatch = () => {
    const next = planSnapshotBatch({
      models: state.purchasableModels,
      skus: state.skuDrawers,
      snapshots: state.configurationSnapshots,
      selectedModelIds,
    });
    setBatch(next);
    setBatchConfirmed(false);
    setError("");
  };

  const confirmBatch = () => {
    if (!batch) return;
    try {
      assertSnapshotBatchCanConfirm(batch);
      setBatchConfirmed(true);
      setStage("targets");
      notify("SnapshotBatch 已确认；未变化快照将复用，阻断项保持跳过。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "SnapshotBatch 无法确认");
    }
  };

  const addBinding = () => {
    const environment = environmentId.trim();
    const channel = channelKey.trim();
    if (!environment || !channel) {
      setError("环境与渠道不能为空。");
      return;
    }
    const environmentProfile = state.configEnvironmentProfiles.find((profile) =>
      profile.environmentId === environment && profile.enabled);
    if (!environmentProfile?.mappingId || !environmentProfile.mappingVersion) {
      setError("该环境尚未启用，或未绑定已发布 ConfigExportMapping。");
      return;
    }
    const targetKind = channel === "1001"
      ? "DEFAULT_1001" as const
      : "EXPLICIT_CHANNEL_DIRECTORY" as const;
    const bindingId = `binding:${environment}:${channel}`;
    const next: LocalExportTargetBinding = {
      bindingId,
      environmentId: environment,
      channelKey: channel,
      targetKind,
      directoryHandleStorageKey: `directory:${identity.workspaceId}:${identity.userId}:${environment}:${channel}`,
      userLabel: userLabel.trim() || `${environment} / ${channel}`,
      mappingId: environmentProfile.mappingId,
      mappingVersion: environmentProfile.mappingVersion,
    };
    const nextBindings = [...bindings.filter((entry) => entry.bindingId !== bindingId), next];
    setBindings(nextBindings);
    saveLogicalBindings(identity, nextBindings);
    setError("");
  };

  const bindDirectory = async (binding: LocalExportTargetBinding) => {
    setError("");
    try {
      const status = await chooseAndSaveDirectory(binding);
      setBindingStatuses((current) => ({ ...current, [binding.bindingId]: status }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "目录绑定失败");
    }
  };

  const authorizeDirectory = async (binding: LocalExportTargetBinding) => {
    try {
      const status = await requestDirectoryWritePermission(binding);
      setBindingStatuses((current) => ({ ...current, [binding.bindingId]: status }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "目录授权失败");
    }
  };

  const removeBinding = (bindingId: string) => {
    const next = bindings.filter((binding) => binding.bindingId !== bindingId);
    setBindings(next);
    saveLogicalBindings(identity, next);
    setBindingStatuses((current) => {
      const copy = { ...current };
      delete copy[bindingId];
      return copy;
    });
  };

  const downloadFallback = () => {
    if (!batch) return;
    downloadJson(`tackle-forger-export-${batch.batchId.replace(/[^a-z0-9._-]/gi, "_")}.json`, {
      packageType: "manual_transport_fallback",
      warning: "此下载仅用于人工搬运，不代表已写入本机 Git 配置仓库。",
      snapshotBatch: batch,
      targets: bindings.map((binding) => ({
        bindingId: binding.bindingId,
        environmentId: binding.environmentId,
        channelKey: binding.channelKey,
        targetKind: binding.targetKind,
        expectedWorkbookPaths: binding.targetKind === "DEFAULT_1001"
          ? ["xlsx/tackle.xlsx", "xlsx/item.xlsx", "xlsx/store.xlsx"]
          : ["tackle.xlsx", "item.xlsx", "store.xlsx"],
      })),
      blockers: previewBlockers,
      generatedAt: new Date().toISOString(),
    });
    notify("已下载人工搬运 Manifest；尚未写入任何本机目录。");
  };

  const generatePreviews = async () => {
    if (previewBlockers.length || !batch) return;
    setBusy(true);
    setError("");
    const next: Record<string, BrowserExportPreview> = {};
    try {
      for (const binding of bindings) {
        const mapping = state.configExportMappings.find((entry) =>
          entry.mappingId === binding.mappingId && entry.version === binding.mappingVersion);
        if (!mapping) throw new Error(`${binding.userLabel} 缺少已发布映射内容。`);
        const configRootBinding = binding.targetKind === "DEFAULT_1001"
          ? binding
          : bindings.find((candidate) =>
              candidate.environmentId === binding.environmentId
              && candidate.targetKind === "DEFAULT_1001");
        if (!configRootBinding) throw new Error(`${binding.userLabel} 缺少环境根目录绑定。`);
        next[binding.bindingId] = await previewBrowserExport({
          binding,
          configRootBinding,
          packageId: `${batch.batchId}:${binding.bindingId}`,
          mapping,
          snapshots: selectedSnapshots,
        });
      }
      setPreviews(next);
      notify(Object.values(next).every((preview) => preview.status === "ready")
        ? "三表差异与增量关系校验已完成；尚未写入正式目录。"
        : "差异预览已完成；部分目标被精确阻断。" );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "生成差异预览失败");
    } finally {
      setBusy(false);
    }
  };

  const commitAll = async () => {
    if (!commitAvailability.enabled) return;
    setBusy(true);
    setError("");
    const next: Record<string, BrowserRecoveryManifest | { error: string }> = {};
    for (const binding of bindings) {
      const preview = previews[binding.bindingId];
      if (!preview || preview.status !== "ready") {
        next[binding.bindingId] = { error: "该目标预览未通过，未执行。" };
        continue;
      }
      try {
        next[binding.bindingId] = await commitBrowserExport({
          binding,
          packageId: preview.packageId,
          operations: preview.operations,
          createdAt: preview.createdAt,
        });
      } catch (caught) {
        next[binding.bindingId] = {
          error: caught instanceof Error ? caught.message : "恢复型提交失败",
        };
      }
    }
    setCommitResults(next);
    setBusy(false);
    notify("恢复型提交已结束；请逐目标核对 hash、备份与错误结果。");
  };

  const reset = () => {
    setStage("batch");
    setBatch(undefined);
    setBatchConfirmed(false);
    setPreviews({});
    setCommitResults({});
    setError("");
  };

  return (
    <div className="config-export-page browser-config-export">
      <section className="config-export-hero">
        <div>
          <span className="eyebrow">SNAPSHOT BATCH · LOCAL DIRECTORY</span>
          <h2>配置表交付</h2>
          <p>批量确认冻结快照，再由浏览器显式授权环境×渠道目录；服务端不保存本机绝对路径。</p>
        </div>
        <div className="config-export-capabilities">
          <span className={previewAvailability.enabled ? "ok" : "blocked"}>
            {previewAvailability.enabled ? <CheckCircle2 size={14} /> : <LockKeyhole size={14} />}预览
          </span>
          <span className={commitAvailability.enabled ? "ok" : "blocked"}>
            {commitAvailability.enabled ? <CheckCircle2 size={14} /> : <LockKeyhole size={14} />}提交
          </span>
        </div>
      </section>

      <ol className="config-export-steps">
        <li className={stage === "batch" ? "active" : "done"}><b>1</b><span>SnapshotBatch</span></li>
        <li className={stage === "targets" ? "active" : stage === "preview" || stage === "confirm" ? "done" : ""}><b>2</b><span>绑定环境×渠道目录</span></li>
        <li className={stage === "preview" ? "active" : stage === "confirm" ? "done" : ""}><b>3</b><span>生成差异与关系校验</span></li>
        <li className={stage === "confirm" ? "active" : ""}><b>4</b><span>确认并恢复型提交</span></li>
      </ol>

      {stage === "batch" ? (
        <section className="config-export-panel">
          <header><div><span className="eyebrow">SOURCE</span><h3>批量准备发布与导出</h3></div><PackageCheck size={18} /></header>
          <div className="browser-model-grid">
            {state.purchasableModels.map((model) => (
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
          <button className="button button-default button-md" type="button" disabled={!selectedModelIds.length} onClick={createBatch}>
            生成批量预检
          </button>
          {batch ? (
            <div className="snapshot-batch-result">
              <div className="snapshot-batch-summary">
                {(["reuse", "create", "skip"] as const).map((decision) => (
                  <div key={decision}><span>{decisionLabel(decision)}</span><strong>{batch.items.filter((item) => item.decision === decision).length}</strong></div>
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
      ) : null}

      {stage === "targets" ? (
        <div className="browser-target-layout">
          <section className="config-export-panel">
            <header><div><span className="eyebrow">BINDING</span><h3>新增环境×渠道目标</h3></div><FolderCog size={18} /></header>
            <div className="browser-binding-form">
              <label><span>环境</span><select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)}>
                <option value="">选择已发布环境</option>
                {state.configEnvironmentProfiles.filter((profile) => profile.enabled).map((profile) => (
                  <option key={profile.environmentId} value={profile.environmentId}>{profile.label} · {profile.environmentId}</option>
                ))}
              </select></label>
              <label><span>渠道</span><input value={channelKey} onChange={(event) => setChannelKey(event.target.value)} /></label>
              <label><span>用户标签</span><input value={userLabel} onChange={(event) => setUserLabel(event.target.value)} /></label>
              <button className="button button-default button-md" type="button" onClick={addBinding}>添加目标</button>
            </div>
            <div className="config-export-warning">
              <ShieldCheck size={16} />
              1001 绑定环境仓库根目录并固定写入 xlsx；其他渠道必须直接选择具体渠道目录，不扫描 config_system.toml。
            </div>
            {!state.configEnvironmentProfiles.some((profile) => profile.enabled) ? (
              <div className="config-export-warning"><AlertTriangle size={16} />尚未发布可用 ConfigEnvironmentProfile；不能用自由文本环境绕过映射版本。</div>
            ) : null}
          </section>
          <section className="config-export-panel">
            <header><div><span className="eyebrow">LOCAL HANDLES</span><h3>浏览器目录授权</h3></div><KeyRound size={18} /></header>
            {!pickerAvailable ? (
              <div className="config-export-warning"><AlertTriangle size={16} />当前浏览器不支持目录授权；只能下载变更包人工搬运。</div>
            ) : null}
            <div className="browser-binding-list">
              {bindings.map((binding) => {
                const status = bindingStatuses[binding.bindingId];
                return (
                  <article key={binding.bindingId}>
                    <div><strong>{binding.userLabel}</strong><small>{binding.environmentId} × {binding.channelKey} · {binding.targetKind}<br />{binding.mappingId || "映射缺失"}@{binding.mappingVersion || "-"}</small></div>
                    <span className={status?.permissionState === "bound_granted" ? "ok" : "warning"}>
                      {status?.directoryName ? `${status.directoryName} · ` : ""}{permissionLabel(status)}
                    </span>
                    <div>
                      <button type="button" onClick={() => void bindDirectory(binding)} disabled={!pickerAvailable}>
                        <FolderCheck size={14} />{status ? "重新绑定" : "选择目录"}
                      </button>
                      {status?.permissionState === "bound_needs_permission" ? (
                        <button type="button" onClick={() => void authorizeDirectory(binding)}>重新授权</button>
                      ) : null}
                      <button type="button" onClick={() => removeBinding(binding.bindingId)}>移除</button>
                    </div>
                  </article>
                );
              })}
              {!bindings.length ? <div className="config-export-empty">尚未添加环境×渠道目标。</div> : null}
            </div>
          </section>
        </div>
      ) : null}

      {stage === "preview" || stage === "confirm" ? (
        <section className="config-export-preview">
          <header>
            <div><span className="eyebrow">PREVIEW GATES</span><h3>{stage === "preview" ? "差异预览前置检查" : "人工确认与恢复型提交"}</h3></div>
            <span><ShieldCheck size={15} />未写入正式目录</span>
          </header>
          <div className="browser-preview-targets">
            {bindings.map((binding) => {
              const preview = previews[binding.bindingId];
              const result = commitResults[binding.bindingId];
              return (
                <div key={binding.bindingId}>
                  <span>{binding.userLabel}</span>
                  <strong>{preview ? (preview.status === "ready" ? "预览通过" : "预览阻断") : permissionLabel(bindingStatuses[binding.bindingId])}</strong>
                  <small>{binding.targetKind === "DEFAULT_1001" ? "xlsx/tackle.xlsx · item.xlsx · store.xlsx" : "显式目录/tackle.xlsx · item.xlsx · store.xlsx"}</small>
                  {preview?.operations.map((operation) => (
                    <small key={operation.relativePath}>{operation.relativePath} · {operation.changes.filter((change) => change.operation !== "skip").length} 项变化 · {operation.sourceHash.slice(0, 8)} → {operation.stagedHash.slice(0, 8)}</small>
                  ))}
                  {preview?.issues.map((issue, index) => (
                    <small className={issue.level === "error" ? "blocked" : "warning"} key={`${issue.code}:${index}`}>{issue.code} · {issue.message}</small>
                  ))}
                  {result ? (
                    "error" in result
                      ? <small className="blocked">未提交 · {result.error}</small>
                      : <small className="ok">已提交并回读 · {result.operations.filter((operation) => operation.state === "verified").length}/{result.operations.length} 文件</small>
                  ) : null}
                </div>
              );
            })}
          </div>
          {previewBlockers.map((blocker) => (
            <div className="config-export-warning" key={blocker}><AlertTriangle size={16} />{blocker}</div>
          ))}
          {!previewBlockers.length && !Object.keys(previews).length ? (
            <div className="browser-ready-note">
              <CheckCircle2 size={18} />
              已具备生成三表差异条件。点击“生成三表差异”后才会进入人工确认。
            </div>
          ) : null}
        </section>
      ) : null}

      {error ? <div className="config-export-error"><AlertTriangle size={16} />{error}</div> : null}

      <footer className="config-export-footer">
        <div>
          {stage === "preview" || stage === "confirm"
            ? previewBlockers.map((blocker) => <span key={blocker}><AlertTriangle size={12} />{blocker}</span>)
            : null}
        </div>
        {batch ? (
          <button type="button" className="button button-default button-md" onClick={downloadFallback}>
            <Download size={15} />下载人工搬运 Manifest
          </button>
        ) : null}
        {stage !== "batch" ? <button type="button" className="button button-default button-md" onClick={reset}><RotateCcw size={15} />重新开始</button> : null}
        {stage === "batch" ? (
          <button type="button" className="button button-primary button-md" disabled={!batch} onClick={confirmBatch}>一次确认 SnapshotBatch</button>
        ) : null}
        {stage === "targets" ? (
          <button type="button" className="button button-primary button-md" disabled={!bindings.length} onClick={() => setStage("preview")}>检查预览条件</button>
        ) : null}
        {stage === "preview" ? (
          <>
            <button type="button" className="button button-default button-md" disabled={previewBlockers.length > 0 || busy} onClick={() => void generatePreviews()}>{busy ? "生成中…" : "生成三表差异"}</button>
            <button type="button" className="button button-primary button-md" disabled={bindings.some((binding) => previews[binding.bindingId]?.status !== "ready") || busy} onClick={() => setStage("confirm")}>进入人工确认</button>
          </>
        ) : null}
        {stage === "confirm" ? (
          <button type="button" className="button button-primary button-md" disabled={previewBlockers.length > 0 || !commitAvailability.enabled || busy || bindings.some((binding) => previews[binding.bindingId]?.status !== "ready")} onClick={() => void commitAll()}>
            {busy ? "逐目标提交中…" : "确认并恢复型提交"}
          </button>
        ) : null}
      </footer>
    </div>
  );
}
