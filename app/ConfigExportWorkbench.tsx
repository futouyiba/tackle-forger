"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileCheck2,
  FolderCog,
  HardDrive,
  LockKeyhole,
  PackageCheck,
  Server,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ActionAvailabilityMap } from "@/lib/interaction-contracts";
import type {
  ConfigurationSnapshot,
  WorkspaceExportTargetProfile,
  WorkspaceState,
} from "@/lib/types";

interface ConfigExportWorkbenchProps {
  state: WorkspaceState;
  actionAvailabilities: ActionAvailabilityMap;
  notify: (message: string) => void;
}

type ExportStage = "select" | "preview";

function snapshotLabel(snapshot: ConfigurationSnapshot) {
  return `${snapshot.modelId} · Snapshot v${snapshot.version}`;
}

function executorLabel(profile: WorkspaceExportTargetProfile) {
  return profile.executorKind === "local_companion"
    ? "本地受限助手"
    : "服务端挂载工作区";
}

export function ConfigExportWorkbench({
  state,
  actionAvailabilities,
  notify,
}: ConfigExportWorkbenchProps) {
  const [stage, setStage] = useState<ExportStage>("select");
  const [snapshotId, setSnapshotId] = useState(
    state.configurationSnapshots[0]?.id ?? "",
  );
  const [profileIds, setProfileIds] = useState<string[]>([]);
  const snapshot = state.configurationSnapshots.find(
    (entry) => entry.id === snapshotId,
  );
  const selectedProfiles = state.exportTargetProfiles.filter((profile) =>
    profileIds.includes(profile.profileId),
  );
  const previewAvailability = actionAvailabilities.preview_config_export;
  const commitAvailability = actionAvailabilities.commit_config_export;
  const canPreview = previewAvailability.enabled;
  const canCommit = commitAvailability.enabled;
  const blockers = useMemo(() => {
    const items: string[] = [];
    if (!snapshot) items.push("请选择冻结 ConfigurationSnapshot");
    if (!selectedProfiles.length) items.push("请选择至少一个已启用目标 Profile");
    if (!canPreview) items.push(previewAvailability.disabledReasonText ?? "当前用户不能生成导出预览");
    selectedProfiles.forEach((profile) => {
      if (!profile.enabled) items.push(`${profile.label} 已停用`);
      if (!profile.mappingId || !profile.mappingVersion) {
        items.push(`${profile.label} 尚未绑定已发布映射版本`);
      }
    });
    return items;
  }, [snapshot, selectedProfiles, canPreview, previewAvailability.disabledReasonText]);

  const downloadManifest = () => {
    if (!snapshot || !selectedProfiles.length) return;
    const manifest = {
      packageType: "manual_transport_fallback",
      warning: "此下载仅用于人工搬运，不代表已写入本机配置目录。",
      sourceSnapshotId: snapshot.id,
      sourceSnapshotHash: snapshot.contentHash,
      targets: selectedProfiles.map((profile) => ({
        profileId: profile.profileId,
        executorKind: profile.executorKind,
        relativeWorkbookRoot: profile.relativeWorkbookRoot,
        configTomlPath: profile.configTomlPath,
        mappingId: profile.mappingId,
        mappingVersion: profile.mappingVersion,
      })),
      workbooks: ["tackle.xlsx", "item.xlsx", "store.xlsx"],
      generatedAt: new Date().toISOString(),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(manifest, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tackle-forger-export-${snapshot.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    notify("已下载人工搬运 Manifest；尚未写入任何配置目录。");
  };

  return (
    <div className="config-export-page">
      <section className="config-export-hero">
        <div>
          <span className="eyebrow">CONFIG DELIVERY</span>
          <h2>配置表交付</h2>
          <p>只从冻结快照生成暂存包；每个目标独立预检、校验、提交与回滚。</p>
        </div>
        <div className="config-export-capabilities">
          <span className={canPreview ? "ok" : "blocked"}>
            {canPreview ? <CheckCircle2 size={14} /> : <LockKeyhole size={14} />}
            预览
          </span>
          <span className={canCommit ? "ok" : "blocked"}>
            {canCommit ? <CheckCircle2 size={14} /> : <LockKeyhole size={14} />}
            提交
          </span>
        </div>
      </section>

      <ol className="config-export-steps">
        <li className={stage === "select" ? "active" : "done"}><b>1</b><span>选择冻结快照与目标</span></li>
        <li className={stage === "preview" ? "active" : ""}><b>2</b><span>生成暂存变更包</span></li>
        <li><b>3</b><span>关系校验与人工确认</span></li>
        <li><b>4</b><span>原子提交或回滚</span></li>
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
              {!state.configurationSnapshots.length ? <div className="config-export-empty">没有可导出的冻结快照。</div> : null}
            </div>
          </section>

          <section className="config-export-panel">
            <header><div><span className="eyebrow">TARGETS</span><h3>ExportTargetProfile</h3></div><FolderCog size={17} /></header>
            <div className="config-export-options">
              {state.exportTargetProfiles.map((profile) => (
                <label key={profile.profileId} className={profileIds.includes(profile.profileId) ? "selected" : ""}>
                  <input
                    type="checkbox"
                    disabled={!profile.enabled}
                    checked={profileIds.includes(profile.profileId)}
                    onChange={() => setProfileIds((current) =>
                      current.includes(profile.profileId)
                        ? current.filter((id) => id !== profile.profileId)
                        : [...current, profile.profileId],
                    )}
                  />
                  {profile.executorKind === "local_companion" ? <HardDrive size={17} /> : <Server size={17} />}
                  <span><strong>{profile.label}</strong><small>{executorLabel(profile)} · {profile.relativeWorkbookRoot} · {profile.mappingId && profile.mappingVersion ? `${profile.mappingId}@${profile.mappingVersion}` : "映射未配置"}</small></span>
                  <em>{profile.enabled ? "已启用" : "未启用"}</em>
                </label>
              ))}
              {!state.exportTargetProfiles.length ? (
                <div className="config-export-empty">
                  <AlertTriangle size={18} />
                  <span><strong>尚未配置导出目标</strong><small>请由管理员创建受限 Profile；浏览器不能直接写任意本机路径。</small></span>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : (
        <section className="config-export-preview">
          <header>
            <div><span className="eyebrow">STAGING PACKAGE</span><h3>暂存配置表变更包</h3></div>
            <span><PackageCheck size={15} />未写入正式目录</span>
          </header>
          <div className="config-export-files">
            {["tackle.xlsx", "item.xlsx", "store.xlsx"].map((file) => (
              <div key={file}><FileCheck2 size={18} /><span><strong>{file}</strong><small>等待执行器读取 config.toml 后解析逻辑表与 sheet</small></span><em>待预检</em></div>
            ))}
          </div>
          {selectedProfiles.map((profile) => (
            <div className="config-export-target-result" key={profile.profileId}>
              <span>{profile.label}</span>
              <strong>等待 {executorLabel(profile)} 连接</strong>
              <small>未获得原文件 hash、schema 与文件锁前，提交保持禁用。</small>
            </div>
          ))}
          <div className="config-export-warning">
            <AlertTriangle size={16} />
            枚举解析方式、业务 ID、单位换算和数据起始行均来自已发布映射；任一缺失都会阻止整行，不会猜测或生成半行。
          </div>
        </section>
      )}

      <footer className="config-export-footer">
        <div>
          {blockers.map((blocker) => <span key={blocker}><AlertTriangle size={12} />{blocker}</span>)}
        </div>
        <button type="button" className="button button-default button-md" disabled={!snapshot || !selectedProfiles.length} onClick={downloadManifest}>
          <Download size={15} />下载人工搬运 Manifest
        </button>
        {stage === "preview" ? (
          <button type="button" className="button button-default button-md" onClick={() => setStage("select")}>返回选择</button>
        ) : null}
        <button type="button" className="button button-primary button-md" disabled={blockers.length > 0} onClick={() => setStage("preview")}>
          生成暂存预览
        </button>
        <button type="button" className="button button-primary button-md" disabled>
          原子提交
        </button>
      </footer>
    </div>
  );
}
