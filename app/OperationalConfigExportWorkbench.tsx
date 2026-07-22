"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileCheck2,
  FolderCog,
  HardDrive,
  Link2,
  LoaderCircle,
  LockKeyhole,
  PackageCheck,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ActionAvailabilityMap } from "@/lib/interaction-contracts";
import type { ConfigurationSnapshot, WorkspaceState } from "@/lib/types";

interface OperationalConfigExportWorkbenchProps {
  state: WorkspaceState;
  actionAvailabilities: ActionAvailabilityMap;
  identity: {
    workspaceId: string;
    userId: string;
  };
  notify: (message: string) => void;
}

type ExportStage = "select" | "preview" | "confirm" | "complete";
type ConnectionState = "idle" | "connecting" | "ready" | "error";

interface CompanionProfile {
  profileId: string;
  label: string;
  enabled: boolean;
  mappingId?: string;
  mappingVersion?: string;
}

interface CompanionHealth {
  status: "ready";
  capabilities: string[];
  pairing: { workspaceId: string; userId: string };
  profiles: CompanionProfile[];
}

interface PreviewIssue {
  level: "warning" | "error";
  code: string;
  message: string;
}

interface PreviewEntry {
  profileId: string;
  label: string;
  status: "ready" | "blocked";
  files: Array<{
    workbook: string;
    changeCount: number;
    sourceHash: string;
    stagedHash: string;
    changes: Array<{ sheet: string; excelRow: number; businessKey: string; operation: string; changedFields: string[] }>;
  }>;
  backupRoot?: string;
  issues: PreviewIssue[];
}

interface PreviewResponse {
  previewToken: string;
  packageId: string;
  expiresAt: string;
  results: PreviewEntry[];
}

interface CommitResponse {
  packageId: string;
  results: Array<{
    profileId: string;
    status: "committed" | "conflict" | "failed";
    replacedWorkbooks: string[];
    rolledBackWorkbooks: string[];
    issues: PreviewIssue[];
  }>;
}
type CommitEntry = CommitResponse["results"][number];

interface StatusResponse {
  packageId: string;
  results: Array<
    CommitEntry | { profileId: string; status: "unknown" }
  >;
}


function snapshotLabel(snapshot: ConfigurationSnapshot) {
  return `${snapshot.modelId} · Snapshot v${snapshot.version}`;
}

function localCompanionUrl(raw: string) {
  const url = new URL(raw);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
  ) {
    throw new Error("本地助手地址必须使用 localhost 或 127.0.0.1。");
  }
  return url.origin;
}

async function companionRequest<T>(input: {
  baseUrl: string;
  token: string;
  identity: OperationalConfigExportWorkbenchProps["identity"];
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<T> {
  const response = await fetch(`${localCompanionUrl(input.baseUrl)}${input.path}`, {
    method: input.method ?? "GET",
    headers: {
      authorization: `Bearer ${input.token}`,
      "x-tackle-forger-workspace": input.identity.workspaceId,
      "x-tackle-forger-user": input.identity.userId,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    cache: "no-store",
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `本地助手返回 ${response.status}`);
  return payload;
}

function stepClass(stage: ExportStage, target: ExportStage) {
  const order: ExportStage[] = ["select", "preview", "confirm", "complete"];
  const currentIndex = order.indexOf(stage);
  const targetIndex = order.indexOf(target);
  return currentIndex === targetIndex ? "active" : currentIndex > targetIndex ? "done" : "";
}

export function OperationalConfigExportWorkbench({
  state,
  actionAvailabilities,
  identity,
  notify,
}: OperationalConfigExportWorkbenchProps) {
  const [stage, setStage] = useState<ExportStage>("select");
  const [snapshotId, setSnapshotId] = useState(state.configurationSnapshots[0]?.id ?? "");
  const [profileIds, setProfileIds] = useState<string[]>([]);
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:47831");
  const [pairingToken, setPairingToken] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [health, setHealth] = useState<CompanionHealth>();
  const [preview, setPreview] = useState<PreviewResponse>();
  const [commit, setCommit] = useState<CommitResponse>();
  const [confirmations, setConfirmations] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryPackageId, setRecoveryPackageId] = useState("");

  const snapshot = state.configurationSnapshots.find((entry) => entry.id === snapshotId);
  const availableProfiles: CompanionProfile[] = health?.profiles
    ?? state.exportTargetProfiles.map((profile) => ({
      profileId: profile.profileId,
      label: profile.label,
      enabled: profile.enabled,
      mappingId: profile.mappingId,
      mappingVersion: profile.mappingVersion,
    }));
  const selectedProfiles = availableProfiles.filter((profile) =>
    profileIds.includes(profile.profileId),
  );
  const previewAvailability = actionAvailabilities.preview_config_export;
  const commitAvailability = actionAvailabilities.commit_config_export;
  const companionCanPreview = Boolean(health?.capabilities.includes("config.export.preview"));
  const companionCanCommit = Boolean(health?.capabilities.includes("config.export.commit"));
  const canPreview = previewAvailability.enabled && companionCanPreview;
  const canCommit = commitAvailability.enabled && companionCanCommit;
  const readyResults = preview?.results.filter((result) => result.status === "ready") ?? [];
  const exactConfirmation = readyResults.length > 0 && readyResults.every(
    (result) => confirmations[result.profileId] === result.profileId,
  );
  const blockers = useMemo(() => {
    const items: string[] = [];
    if (connection !== "ready") items.push("请先连接本地助手");
    if (!identity.workspaceId || !identity.userId) {
      items.push("当前飞书身份不完整，请重新登录");
    }
    if (!snapshot) items.push("请选择冻结 ConfigurationSnapshot");
    if (!selectedProfiles.length) items.push("请选择至少一个已启用目标 Profile");
    if (!previewAvailability.enabled) {
      items.push(previewAvailability.disabledReasonText ?? "当前用户不能生成导出预览");
    } else if (!companionCanPreview) {
      items.push("本地助手尚未声明预览执行能力");
    }
    selectedProfiles.forEach((profile) => {
      if (!profile.enabled) items.push(`${profile.label} 已停用`);
      if (!profile.mappingId || !profile.mappingVersion) {
        items.push(`${profile.label} 尚未绑定已发布映射版本`);
      }
    });
    return items;
  }, [companionCanPreview, connection, identity, previewAvailability, selectedProfiles, snapshot]);

  const connect = async () => {
    setConnection("connecting");
    setError("");
    try {
      const result = await companionRequest<CompanionHealth>({
        baseUrl,
        token: pairingToken,
        identity,
        path: "/health",
      });
      setHealth(result);
      setProfileIds((current) => current.filter((id) =>
        result.profiles.some((profile) => profile.profileId === id && profile.enabled),
      ));
      setConnection("ready");
      notify("本地助手已连接；目录权限与映射版本以执行端登记为准。");
    } catch (caught) {
      setConnection("error");
      setHealth(undefined);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const generatePreview = async () => {
    if (!snapshot || blockers.length) return;
    setBusy(true);
    setError("");
    try {
      const result = await companionRequest<PreviewResponse>({
        baseUrl,
        token: pairingToken,
        identity,
        path: "/preview",
        method: "POST",
        body: {
          packageId: `package:${snapshot.id}:${Date.now()}`,
          profileIds,
          snapshot,
        },
      });
      setPreview(result);
      setRecoveryPackageId(result.packageId);
      setConfirmations({});
      setStage("preview");
      notify("暂存预览已生成；正式配置目录尚未改动。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const commitPreview = async () => {
    if (!preview || !canCommit || !exactConfirmation) return;
    setBusy(true);
    setError("");
    try {
      const result = await companionRequest<CommitResponse>({
        baseUrl,
        token: pairingToken,
        identity,
        path: "/commit",
        method: "POST",
        body: {
          previewToken: preview.previewToken,
          confirmations,
        },
      });
      setCommit(result);
      setStage("complete");
      const committedCount = result.results.filter((entry) => entry.status === "committed").length;
      notify(`已原子提交 ${committedCount} 个目标；冲突目标未被覆盖。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const queryTaskStatus = async () => {
    if (!recoveryPackageId.trim() || !selectedProfiles.length) return;
    setBusy(true);
    setError("");
    try {
      const result = await companionRequest<StatusResponse>({
        baseUrl,
        token: pairingToken,
        identity,
        path: "/status",
        method: "POST",
        body: {
          packageId: recoveryPackageId.trim(),
          profileIds: selectedProfiles.map((profile) => profile.profileId),
        },
      });
      const completed = result.results.filter(
        (entry): entry is CommitEntry => entry.status !== "unknown",
      );
      if (!completed.length) throw new Error("未找到该任务包的已提交记录。");
      setCommit({
        packageId: result.packageId,
        results: completed,
      });
      setStage("complete");
      const unknownCount = result.results.length - completed.length;
      notify(
        unknownCount
          ? `已恢复 ${completed.length} 个目标；${unknownCount} 个目标暂无提交记录。`
          : "已恢复全部目标的幂等提交结果。",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  const downloadManifest = () => {
    if (!snapshot || !selectedProfiles.length) return;
    const manifest = {
      packageType: "manual_transport_fallback",
      warning: "此下载仅用于人工搬运，不代表已写入本机配置目录。",
      sourceSnapshotId: snapshot.id,
      sourceSnapshotHash: snapshot.contentHash,
      targets: selectedProfiles.map((profile) => ({
        profileId: profile.profileId,
        mappingId: profile.mappingId,
        mappingVersion: profile.mappingVersion,
      })),
      generatedAt: new Date().toISOString(),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], {
      type: "application/json",
    }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tackle-forger-export-${snapshot.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    notify("已下载人工搬运 Manifest；尚未写入任何配置目录。");
  };

  const reset = () => {
    setStage("select");
    setPreview(undefined);
    setCommit(undefined);
    setConfirmations({});
    setError("");
  };

  return (
    <div className="config-export-page">
      <section className="config-export-hero">
        <div>
          <span className="eyebrow">CONFIG DELIVERY</span>
          <h2>配置表交付</h2>
          <p>从冻结快照生成暂存包，经关系校验和精确确认后备份并原子提交。</p>
        </div>
        <div className="config-export-capabilities">
          <span className={canPreview ? "ok" : "blocked"}>
            {canPreview ? <CheckCircle2 size={14} /> : <LockKeyhole size={14} />}预览
          </span>
          <span className={canCommit ? "ok" : "blocked"}>
            {canCommit ? <CheckCircle2 size={14} /> : <LockKeyhole size={14} />}提交
          </span>
        </div>
      </section>

      <section className="config-export-connection">
        <div>
          <span className="eyebrow">LOCAL COMPANION</span>
          <strong>连接本地受限助手</strong>
          <small>令牌只用于本次页面会话；目标目录与映射不能由浏览器下发。</small>
        </div>
        <label>
          <span>助手地址</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <label>
          <span>配对令牌</span>
          <input type="password" autoComplete="off" value={pairingToken} onChange={(event) => setPairingToken(event.target.value)} />
        </label>
        <button type="button" className="button button-default button-md" disabled={!pairingToken || connection === "connecting"} onClick={connect}>
          {connection === "connecting" ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />}
          {connection === "ready" ? "重新连接" : "连接"}
        </button>
        <span className={connection === "ready" ? "connection-ready" : "connection-idle"}>
          {connection === "ready" ? <ShieldCheck size={14} /> : <HardDrive size={14} />}
          {connection === "ready" ? `已配对 · ${health?.pairing.userId}` : "未连接"}
        </span>
      </section>

      <section className="config-export-recovery">
        <div>
          <span className="eyebrow">TASK RECOVERY</span>
          <strong>恢复已提交任务</strong>
          <small>助手重启或页面断线后，可按任务包 ID 查询幂等提交记录。</small>
        </div>
        <label>
          <span>任务包 ID</span>
          <input value={recoveryPackageId} onChange={(event) => setRecoveryPackageId(event.target.value)} placeholder="package:snapshot:timestamp" />
        </label>
        <button type="button" className="button button-default button-md" disabled={connection !== "ready" || !recoveryPackageId.trim() || !selectedProfiles.length || busy} onClick={queryTaskStatus}>
          <RotateCcw size={15} />查询任务
        </button>
      </section>

      <ol className="config-export-steps">
        <li className={stepClass(stage, "select")}><b>1</b><span>选择冻结快照与目标</span></li>
        <li className={stepClass(stage, "preview")}><b>2</b><span>生成暂存变更包</span></li>
        <li className={stepClass(stage, "confirm")}><b>3</b><span>关系校验与人工确认</span></li>
        <li className={stepClass(stage, "complete")}><b>4</b><span>原子提交或回滚</span></li>
      </ol>

      {stage === "select" ? (
        <div className="config-export-grid">
          <section className="config-export-panel">
            <header><div><span className="eyebrow">SOURCE</span><h3>冻结 ConfigurationSnapshot</h3></div><LockKeyhole size={17} /></header>
            <div className="config-export-options">
              {state.configurationSnapshots.map((entry) => (
                <label key={entry.id} className={snapshotId === entry.id ? "selected" : ""}>
                  <input type="radio" name="snapshot" checked={snapshotId === entry.id} onChange={() => setSnapshotId(entry.id)} />
                  <span><strong>{snapshotLabel(entry)}</strong><small>{entry.id}</small></span>
                  <em>{entry.contentHash.slice(0, 8)}</em>
                </label>
              ))}
            </div>
          </section>
          <section className="config-export-panel">
            <header><div><span className="eyebrow">TARGETS</span><h3>执行端登记目标</h3></div><FolderCog size={17} /></header>
            <div className="config-export-options">
              {availableProfiles.map((profile) => (
                <label key={profile.profileId} className={profileIds.includes(profile.profileId) ? "selected" : ""}>
                  <input
                    type="checkbox"
                    disabled={connection !== "ready" || !profile.enabled || !profile.mappingId || !profile.mappingVersion}
                    checked={profileIds.includes(profile.profileId)}
                    onChange={() => setProfileIds((current) =>
                      current.includes(profile.profileId)
                        ? current.filter((id) => id !== profile.profileId)
                        : [...current, profile.profileId],
                    )}
                  />
                  <HardDrive size={17} />
                  <span><strong>{profile.label}</strong><small>{profile.profileId} · {profile.mappingId && profile.mappingVersion ? `${profile.mappingId}@${profile.mappingVersion}` : "映射未配置"}</small></span>
                  <em>{profile.enabled ? "已登记" : "未启用"}</em>
                </label>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {stage === "preview" && preview ? (
        <section className="config-export-preview">
          <header>
            <div><span className="eyebrow">STAGING PACKAGE</span><h3>暂存配置表变更包</h3><small>{preview.packageId}</small></div>
            <span><PackageCheck size={15} />未写入正式目录</span>
          </header>
          {preview.results.map((result) => (
            <div className="config-export-result-group" key={result.profileId}>
              <div className="config-export-target-result">
                <span>{result.label}</span>
                <strong>{result.status === "ready" ? "预检通过" : "已阻止"}</strong>
                <small>{result.profileId} · {result.files.length} 个工作簿</small>
                {result.backupRoot ? <small>预定备份：{result.backupRoot}</small> : null}
              </div>
              <div className="config-export-files">
                {result.files.map((file) => (
                  <div key={file.workbook}>
                    <FileCheck2 size={18} />
                    <span>
                      <strong>{file.workbook}</strong>
                      <small>{file.changeCount} 行记录 · 原 {file.sourceHash.slice(0, 8)} → 暂存 {file.stagedHash.slice(0, 8)}</small>
                      <small>
                        {file.changes.slice(0, 6).map((change) => `${change.sheet} 第${change.excelRow}行 [${change.businessKey}]`).join(" · ")}
                        {file.changes.length > 6 ? ` · 另 ${file.changes.length - 6} 行` : ""}
                      </small>
                    </span>
                    <em>已暂存</em>
                  </div>
                ))}
              </div>
              {result.issues.map((issue) => (
                <div className="config-export-warning" key={`${issue.code}:${issue.message}`}>
                  <AlertTriangle size={16} /><span><strong>{issue.code}</strong><small>{issue.message}</small></span>
                </div>
              ))}
            </div>
          ))}
          <div className="config-export-warning">
            <AlertTriangle size={16} />
            枚举解析、业务 ID、单位换算和起始行均来自已发布映射；缺失会阻止整行，不会生成半行。
          </div>
        </section>
      ) : null}

      {stage === "confirm" && preview ? (
        <section className="config-export-preview">
          <header>
            <div><span className="eyebrow">EXACT CONFIRMATION</span><h3>逐目标人工确认</h3></div>
            <span><ShieldCheck size={15} />预览 {new Date(preview.expiresAt).toLocaleTimeString()} 前有效</span>
          </header>
          <div className="config-export-confirmations">
            {readyResults.map((result) => (
              <label key={result.profileId}>
                <span><strong>{result.label}</strong><small>请输入 {result.profileId}</small></span>
                <input
                  value={confirmations[result.profileId] ?? ""}
                  onChange={(event) => setConfirmations((current) => ({
                    ...current,
                    [result.profileId]: event.target.value,
                  }))}
                  placeholder={result.profileId}
                />
              </label>
            ))}
          </div>
          <div className="config-export-warning">
            <AlertTriangle size={16} />
            提交前会再次校验原文件 hash；任何外部修改都会作为冲突保留，不会被覆盖。
          </div>
        </section>
      ) : null}

      {stage === "complete" && commit ? (
        <section className="config-export-preview">
          <header>
            <div><span className="eyebrow">COMMIT RESULT</span><h3>配置交付结果</h3></div>
            <span><CheckCircle2 size={15} />已完成</span>
          </header>
          {commit.results.map((result) => (
            <div className="config-export-target-result" key={result.profileId}>
              <span>{result.profileId}</span>
              <strong>{result.status === "committed" ? "提交成功" : result.status === "conflict" ? "发现冲突，未覆盖" : "提交失败"}</strong>
              <small>
                {result.replacedWorkbooks.length ? `已替换：${result.replacedWorkbooks.join("、")}` : "未替换正式文件"}
                {result.rolledBackWorkbooks.length ? ` · 已回滚：${result.rolledBackWorkbooks.join("、")}` : ""}
              </small>
            </div>
          ))}
        </section>
      ) : null}

      {error ? <div className="config-export-error"><AlertTriangle size={16} />{error}</div> : null}

      <footer className="config-export-footer">
        <div>
          {stage === "select" ? blockers.map((blocker) => <span key={blocker}><AlertTriangle size={12} />{blocker}</span>) : null}
        </div>
        {stage === "select" ? (
          <>
            <button type="button" className="button button-default button-md" disabled={!snapshot || !selectedProfiles.length} onClick={downloadManifest}>
              <Download size={15} />下载人工搬运 Manifest
            </button>
            <button type="button" className="button button-primary button-md" disabled={blockers.length > 0 || busy} onClick={generatePreview}>
              {busy ? <LoaderCircle className="spin" size={15} /> : <PackageCheck size={15} />}生成暂存预览
            </button>
          </>
        ) : null}
        {stage === "preview" ? (
          <>
            <button type="button" className="button button-default button-md" onClick={reset}><RotateCcw size={15} />重新选择</button>
            <button type="button" className="button button-primary button-md" disabled={!readyResults.length} onClick={() => setStage("confirm")}>进入人工确认</button>
          </>
        ) : null}
        {stage === "confirm" ? (
          <>
            <button type="button" className="button button-default button-md" onClick={() => setStage("preview")}>返回预览</button>
            <button type="button" className="button button-primary button-md" disabled={!canCommit || !exactConfirmation || busy} onClick={commitPreview}>
              {busy ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}原子提交
            </button>
          </>
        ) : null}
        {stage === "complete" ? (
          <button type="button" className="button button-primary button-md" onClick={reset}>完成并返回</button>
        ) : null}
      </footer>
    </div>
  );
}
