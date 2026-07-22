import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import {
  applyDataSourcePreview,
  datasetLabel,
  prepareDataSourceWriteback,
  sourceFingerprint,
} from "@/lib/data-sources";
import {
  commitFeishuWriteback,
  fetchFeishuRecords,
  pullDataSourcePreview,
  resolveFeishuSourceLink,
} from "@/lib/feishu";
import {
  dataSourceWritebackIdempotencyKey,
  executeRecoverableDataSourceWriteback,
} from "@/lib/data-source-writeback-recovery";
import { loadWorkspaceState, saveWorkspaceState } from "@/lib/storage";
import type { ActionCode } from "@/lib/interaction-contracts";
import type { DataSourceProfile } from "@/lib/types";
import { ensureWorkflowFields } from "@/lib/workflow";
import { preserveReadOnlyLegacyProductHistory } from "@/lib/legacy-history";

export const dynamic = "force-dynamic";

function validSource(value: unknown): value is DataSourceProfile {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<DataSourceProfile>;
  return (
    typeof source.id === "string" &&
    source.id.length > 0 &&
    source.id.length <= 80 &&
    typeof source.name === "string" &&
    source.name.length > 0 &&
    source.name.length <= 80 &&
    source.provider === "feishu_bitable" &&
    (source.dataset === "weight_templates" || source.dataset === "modifiers") &&
    typeof source.appToken === "string" &&
    typeof source.tableId === "string" &&
    typeof source.viewId === "string" &&
    typeof source.shareUrl === "string" &&
    typeof source.enabled === "boolean" &&
    typeof source.notes === "string"
  );
}

export async function POST(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json(
      { error: "请使用公司飞书账号登录。", action: "feishu_login" },
      { status: 401 },
    );
  }
  try {
    const body = (await request.json()) as {
      action?: "resolve" | "preview" | "publish" | "writeback-preview" | "writeback";
      source?: DataSourceProfile;
      shareUrl?: string;
      selectedTableId?: string;
      baseRevision?: number;
      checksum?: string;
      sourceFingerprint?: string;
    };
    const actionCodes = {
      resolve: "resolve_data_source",
      preview: "preview_data_source",
      publish: "publish_data_source",
      "writeback-preview": "preview_data_source_writeback",
      writeback: "commit_data_source_writeback",
    } satisfies Record<NonNullable<typeof body.action>, ActionCode>;
    if (!body.action || !(body.action in actionCodes)) {
      return NextResponse.json({ error: "缺少或无法识别数据源操作。" }, { status: 400 });
    }
    const actionCode = actionCodes[body.action];
    const availability = user.actionAvailability[actionCode];
    if (!availability.enabled) {
      return NextResponse.json(
        { error: availability.disabledReasonText ?? "当前账号不能执行该数据源操作。", actionAvailability: availability },
        { status: 403 },
      );
    }
    if (body.action === "resolve") {
      if (typeof body.shareUrl !== "string") {
        return NextResponse.json({ error: "请粘贴飞书多维表格分享链接。" }, { status: 400 });
      }
      const resolved = await resolveFeishuSourceLink(
        body.shareUrl,
        typeof body.selectedTableId === "string" ? body.selectedTableId : "",
      );
      return NextResponse.json({ resolved });
    }

    if (!validSource(body.source)) {
      return NextResponse.json({ error: "数据源配置无效。" }, { status: 400 });
    }

    const current = await loadWorkspaceState();
    const isCommit = body.action === "publish";
    if (isCommit && current.revision !== body.baseRevision) {
      return NextResponse.json(
        { error: "正式配置已产生新版本，请重新检查后再操作。", revision: current.revision },
        { status: 409 },
      );
    }

    if (body.action === "writeback-preview" || body.action === "writeback") {
      const requestedKey = typeof body.checksum === "string" && typeof body.sourceFingerprint === "string"
        ? dataSourceWritebackIdempotencyKey({
            sourceId: body.source.id,
            sourceFingerprint: body.sourceFingerprint,
            checksum: body.checksum,
          })
        : undefined;
      const recoverableIntent = requestedKey
        ? current.state.dataSourceWritebackIntents.find((intent) => intent.idempotencyKey === requestedKey)
        : undefined;
      const preview = recoverableIntent
        ? {
            sourceId: recoverableIntent.sourceId,
            sourceName: recoverableIntent.sourceName,
            dataset: recoverableIntent.dataset,
            sourceFingerprint: recoverableIntent.sourceFingerprint,
            checksum: recoverableIntent.checksum,
            pulledAt: recoverableIntent.requestedAt,
            recordCount: recoverableIntent.recordCount,
            fieldCount: recoverableIntent.fieldCount,
            issues: [],
            rows: structuredClone(recoverableIntent.rows),
          }
        : prepareDataSourceWriteback(
            body.source,
            await fetchFeishuRecords(body.source),
            current.state,
          );
      if (body.action === "writeback-preview") {
        return NextResponse.json({ writebackPreview: preview, revision: current.revision });
      }
      if (
        preview.checksum !== body.checksum ||
        preview.sourceFingerprint !== body.sourceFingerprint ||
        sourceFingerprint(body.source) !== body.sourceFingerprint
      ) {
        return NextResponse.json(
          { error: "检查后本地版本、飞书源表或数据源配置发生了变化，请重新检查。" },
          { status: 409 },
        );
      }
      const errors = preview.issues.filter((issue) => issue.level === "error");
      if (errors.length) {
        return NextResponse.json(
          { error: "存在来源冲突或字段问题，已阻止回写。", issues: preview.issues },
          { status: 422 },
        );
      }
      if (!preview.rows.length) {
        return NextResponse.json({ error: "没有需要回写的本地修订。" }, { status: 422 });
      }

      const writeback = await executeRecoverableDataSourceWriteback({
        source: body.source,
        preview,
        author: user.name,
        requestedAt: new Date().toISOString(),
        expectedBaseRevision: typeof body.baseRevision === "number" ? body.baseRevision : undefined,
        store: { load: loadWorkspaceState, save: saveWorkspaceState },
        writeRemote: commitFeishuWriteback,
      });
      if (writeback.intent.state === "WRITE_FAILED") {
        return NextResponse.json(
          {
            error: "飞书回写未确认，已停止。请重试——重试会先回读，已落地的记录不会重复写入。",
            evidence: writeback.intent.evidence,
            detail: writeback.intent.error,
            revision: writeback.revision,
          },
          { status: 502 },
        );
      }
      return NextResponse.json({
        state: writeback.state,
        revision: writeback.revision,
        writebackPreview: preview,
        idempotent: writeback.idempotent,
        remoteChangesAvailable: true,
        message: "飞书写回已回读确认；本地规则尚未拉取或发布。",
      });
    }

    const preview = await pullDataSourcePreview(body.source, current.state);
    if (body.action !== "publish") {
      return NextResponse.json({ preview, revision: current.revision });
    }
    if (
      preview.checksum !== body.checksum ||
      preview.sourceFingerprint !== body.sourceFingerprint ||
      sourceFingerprint(body.source) !== body.sourceFingerprint
    ) {
      return NextResponse.json(
        { error: "预览后源表或数据源配置发生了变化，请重新预览。" },
        { status: 409 },
      );
    }
    const errors = preview.issues.filter((issue) => issue.level === "error");
    if (errors.length) {
      return NextResponse.json(
        { error: "数据校验未通过，已阻止发布。", issues: preview.issues },
        { status: 422 },
      );
    }

    let next = applyDataSourcePreview(current.state, preview);
    const sourceIndex = next.dataSources.findIndex((item) => item.id === body.source?.id);
    if (sourceIndex >= 0) next.dataSources[sourceIndex] = body.source;
    else next.dataSources.push(body.source);
    const publishedRevision = current.revision + 1;
    next.dataSourceImports = [
      {
        id: crypto.randomUUID(),
        sourceId: body.source.id,
        sourceName: body.source.name,
        dataset: body.source.dataset,
        checksum: preview.checksum,
        recordCount: preview.recordCount,
        publishedRevision,
        publishedAt: new Date().toISOString(),
        publishedBy: user.name,
      },
      ...next.dataSourceImports,
    ].slice(0, 100);
    next = preserveReadOnlyLegacyProductHistory(
      current.state,
      ensureWorkflowFields(next),
    );

    const result = await saveWorkspaceState({
      state: next,
      baseRevision: current.revision,
      author: user.name,
      message:
        "从" +
        body.source.name +
        "发布" +
        datasetLabel(body.source.dataset) +
        "（" +
        preview.recordCount +
        " 条）",
    });
    if (result.conflict) {
      return NextResponse.json(
        { error: "发布时检测到新版本，请重新预览。", revision: result.revision },
        { status: 409 },
      );
    }
    return NextResponse.json({ state: next, revision: result.revision, preview });
  } catch (error) {
    const conflict = error as Error & { code?: string; revision?: number };
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "飞书数据操作失败。",
        revision: conflict.revision,
      },
      { status: conflict.code === "WORKSPACE_REVISION_CONFLICT" ? 409 : 502 },
    );
  }
}
