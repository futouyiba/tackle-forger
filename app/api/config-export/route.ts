import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import {
  BROWSER_COMPILER_TABLES,
  BROWSER_EXPORT_MAPPING,
  BROWSER_FIELD_LABELS,
  filterMappingForPart,
  nonFormalRef,
} from "@/lib/config-export-browser-mapping";
import type { MaterializedConfigRow } from "@/lib/config-export-mapping";
import { materializeConfigExport } from "@/lib/config-export-mapping";
import {
  assertConfigExportSnapshotReplayable,
  ConfigPreviewSnapshotError,
  createConfigPreviewPackage,
} from "@/lib/config-preview-package";
import {
  assertFormalConfigExportAllowed,
  ConfigExportStageError,
  type FormalConfigExportAuthorization,
} from "@/lib/config-export-stage";
import { generatePreviewXlsx } from "@/lib/config-export-xlsx-generator";
import { loadWorkspaceState } from "@/lib/storage";

export const dynamic = "force-dynamic";

type ConfigExportRequest =
  | {
      action: "preview";
      packageId: string;
      snapshotIds: string[];
    }
  | {
      action: "xlsx-download";
      packageId: string;
      snapshotIds: string[];
    }
  | {
      action: "commit";
      formalAuthorization?: FormalConfigExportAuthorization;
    };

export async function POST(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json(
      { error: "请使用公司飞书账号登录。", action: "feishu_login" },
      { status: 401 },
    );
  }
  const body = (await request.json().catch(() => null)) as ConfigExportRequest | null;
  if (!body || (body.action !== "preview" && body.action !== "commit" && body.action !== "xlsx-download")) {
    return NextResponse.json({ error: "配置导出请求无效。" }, { status: 400 });
  }

  if (body.action === "commit") {
    const availability = user.actionAvailability.commit_config_export;
    if (!availability.enabled) {
      return NextResponse.json(
        {
          error: availability.disabledReasonText ?? "正式配置提交未启用。",
          code: availability.disabledReasonCode ?? "CONFIG_EXPORT_PHASE_DISABLED",
          actionAvailability: availability,
        },
        { status: 403 },
      );
    }
    try {
      await assertFormalConfigExportAllowed(body.formalAuthorization, undefined, undefined);
    } catch (error) {
      if (error instanceof ConfigExportStageError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: 422 },
        );
      }
      throw error;
    }
    return NextResponse.json(
      {
        error: "1.5 期正式执行器由 Issue #55/#56 实现；当前没有可执行提交路径。",
        code: "CONFIG_EXPORT_RUNTIME_NOT_IMPLEMENTED",
      },
      { status: 501 },
    );
  }

  if (body.action === "xlsx-download") {
    const availability = user.actionAvailability.preview_config_export;
    if (!availability.enabled) {
      return NextResponse.json(
        {
          error: availability.disabledReasonText ?? "当前账号不能下载导出 XLSX。",
          actionAvailability: availability,
        },
        { status: 403 },
      );
    }
    if (
      typeof body.packageId !== "string"
      || !Array.isArray(body.snapshotIds)
      || !body.snapshotIds.length
      || body.snapshotIds.some((entry) => typeof entry !== "string" || !entry.trim())
    ) {
      return NextResponse.json(
        { error: "XLSX 下载必须指定 packageId 和至少一个 Snapshot。" },
        { status: 400 },
      );
    }
    // 检测重复 Snapshot ID
    if (new Set(body.snapshotIds).size !== body.snapshotIds.length) {
      return NextResponse.json(
        { error: "请求包含重复的 Snapshot ID。" },
        { status: 400 },
      );
    }
    const current = await loadWorkspaceState();
    const requested = new Set(body.snapshotIds);
    const snapshots = current.state.configurationSnapshots.filter((snapshot) =>
      requested.has(snapshot.id));
    if (snapshots.length !== requested.size) {
      return NextResponse.json(
        { error: "请求包含不存在的 ConfigurationSnapshot。" },
        { status: 404 },
      );
    }
    // 检测同一 Model 的多个 Snapshot
    const seenModels = new Set<string>();
    const dupModels: string[] = [];
    for (const s of snapshots) {
      if (seenModels.has(s.modelId)) dupModels.push(s.modelId);
      seenModels.add(s.modelId);
    }
    if (dupModels.length) {
      return NextResponse.json(
        { error: "不能同时导出同一 Model 的多个快照。", code: "SNAPSHOT_MODEL_DUPLICATE", modelIds: dupModels },
        { status: 422 },
      );
    }
    // 快照数量硬上限
    const MAX_SNAPSHOTS = 50;
    if (snapshots.length > MAX_SNAPSHOTS) {
      return NextResponse.json(
        { error: `单次最多导出 ${MAX_SNAPSHOTS} 个快照，请分批下载。` },
        { status: 413 },
      );
    }
    try {
      // 逐快照校验完整性门禁，失败即全部拒绝
      const policies = current.state.reductionStackingPolicyVersions;
      const gateErrors: Array<{ snapshotId: string; code: string; message: string }> = [];
      for (const snapshot of snapshots) {
        try {
          assertConfigExportSnapshotReplayable(snapshot, policies);
        } catch (err) {
          gateErrors.push({
            snapshotId: snapshot.id,
            code: err instanceof ConfigPreviewSnapshotError ? err.code : "SNAPSHOT_GATE_FAILED",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (gateErrors.length) {
        return NextResponse.json(
          { error: "部分快照未通过导出完整性校验", gateErrors },
          { status: 422 },
        );
      }
      // 逐快照物化，按部位筛选映射，失败即全部拒绝
      const allRows: MaterializedConfigRow[] = [];
      const materializeErrors: Array<{ snapshotId: string; code: string; message: string }> = [];
      for (const snapshot of snapshots) {
        const itemPartId = snapshot.projectionMatch?.itemPartId;
        const partMapping = itemPartId
          ? filterMappingForPart(BROWSER_EXPORT_MAPPING, itemPartId)
          : BROWSER_EXPORT_MAPPING;
        try {
          const result = materializeConfigExport({
            snapshot,
            availableReductionPolicies: policies,
            mapping: partMapping,
            compilerTables: BROWSER_COMPILER_TABLES,
          });
          const errors = result.issues.filter((i) => i.level === "error");
          if (errors.length) {
            materializeErrors.push({
              snapshotId: snapshot.id,
              code: errors[0].code,
              message: errors.map((e) => e.message).join("；"),
            });
          } else {
            allRows.push(...result.rows);
          }
        } catch (err) {
          materializeErrors.push({
            snapshotId: snapshot.id,
            code: "MATERIALIZE_FAILED",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (materializeErrors.length) {
        return NextResponse.json(
          { error: "部分快照物化失败", materializeErrors },
          { status: 422 },
        );
      }
      if (!allRows.length) {
        return NextResponse.json(
          { error: "所选快照经物化后无有效行。" },
          { status: 422 },
        );
      }
      // 将 modelId 转为 NON_FORMAL 符号引用
      const nonFormalRows = allRows.map((row) => ({
        ...row,
        values: Object.fromEntries(
          Object.entries(row.values).map(([key, value]) => [
            key,
            key === "non_formal_ref" || key === "tackle_ref" || key === "item_ref" || key === "goods_ref"
              ? nonFormalRef(String(value), row.rowMappingId)
              : value,
          ]),
        ),
      }));
      const xlsxBytes = generatePreviewXlsx({
        rows: nonFormalRows,
        mapping: BROWSER_EXPORT_MAPPING,
        labels: BROWSER_FIELD_LABELS,
      });
      return new NextResponse(Buffer.from(xlsxBytes), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="config-export-${body.packageId.replace(/[^a-z0-9._-]/gi, "_")}.preview.xlsx"`,
        },
      });
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "生成 XLSX 导出文件失败。",
        },
        { status: 422 },
      );
    }
  }

  const availability = user.actionAvailability.preview_config_export;
  if (!availability.enabled) {
    return NextResponse.json(
      {
        error: availability.disabledReasonText ?? "当前账号不能生成配置预览。",
        actionAvailability: availability,
      },
      { status: 403 },
    );
  }
  if (
    typeof body.packageId !== "string"
    || !Array.isArray(body.snapshotIds)
    || !body.snapshotIds.length
    || body.snapshotIds.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    return NextResponse.json(
      { error: "NON_FORMAL 预览必须指定 packageId 和至少一个 Snapshot。" },
      { status: 400 },
    );
  }
  const current = await loadWorkspaceState();
  const requested = new Set(body.snapshotIds);
  const snapshots = current.state.configurationSnapshots.filter((snapshot) =>
    requested.has(snapshot.id));
  if (snapshots.length !== requested.size) {
    return NextResponse.json(
      { error: "请求包含不存在或重复的 ConfigurationSnapshot。" },
      { status: 404 },
    );
  }
  try {
    const previewPackage = createConfigPreviewPackage({
      packageId: body.packageId,
      workspaceId: current.state.workspaceId ?? "",
      snapshots,
      availableReductionPolicies: current.state.reductionStackingPolicyVersions,
    });
    return NextResponse.json({ previewPackage });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "生成 NON_FORMAL 预览失败。",
        ...(error instanceof ConfigPreviewSnapshotError ? { code: error.code } : {}),
      },
      { status: 422 },
    );
  }
}
