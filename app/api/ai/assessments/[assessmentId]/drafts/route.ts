import { NextResponse, type NextRequest } from "next/server";
import {
  AIDraftConversionError,
  applyAIDraftArtifactPlan,
  assertAIDraftArtifactProvenanceCompatible,
  planAIDraftConversion,
  type AIDraftArtifactPlan,
  type AIDraftConversionCommand,
} from "@/lib/ai-draft-conversion";
import { AIRuntimeStoreError, createAIRuntimeStoreFromEnvironment } from "@/lib/ai-runtime-store";
import { stableAuditActor } from "@/lib/api-command-boundaries";
import { requestUser } from "@/lib/auth";
import {
  ItemPartChainInconsistentError,
  ItemPartNotEnabledError,
} from "@/lib/enabled-item-parts";
import { PatchOffsetPolicyError } from "@/lib/patch-offset-policy";
import { loadWorkspaceState, saveWorkspaceState } from "@/lib/storage";
import type { WorkspaceState } from "@/lib/types";

export const dynamic = "force-dynamic";

function validAssessmentId(value: string): boolean {
  return /^[A-Za-z0-9-]{1,128}$/.test(value);
}

function commandFromBody(value: unknown): AIDraftConversionCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "assessmentInputHash",
    "idempotencyKey",
    "mode",
    "recommendationId",
    "selectedChangeIds",
    "targetModelRef",
    "targetRuleRef",
    "userReason",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  if ((record.mode !== "preview" && record.mode !== "create")
    || typeof record.recommendationId !== "string"
    || typeof record.assessmentInputHash !== "string"
    || !Array.isArray(record.selectedChangeIds)
    || record.selectedChangeIds.some((entry) => typeof entry !== "string")
    || typeof record.userReason !== "string"
    || typeof record.idempotencyKey !== "string") {
    return undefined;
  }
  const targetModelRef = record.targetModelRef;
  if (targetModelRef !== undefined
    && (!targetModelRef
      || typeof targetModelRef !== "object"
      || Array.isArray(targetModelRef)
      || Object.keys(targetModelRef).sort().join(",") !== "entityId,revisionId"
      || typeof (targetModelRef as Record<string, unknown>).entityId !== "string"
      || typeof (targetModelRef as Record<string, unknown>).revisionId !== "string")) {
    return undefined;
  }
  const targetRuleRef = record.targetRuleRef;
  if (targetRuleRef !== undefined
    && (!targetRuleRef
      || typeof targetRuleRef !== "object"
      || Array.isArray(targetRuleRef)
      || Object.keys(targetRuleRef).sort().join(",")
        !== "parameterKey,sheetId,sourceRevision,spreadsheetToken,stableRuleId"
      || ["spreadsheetToken", "sheetId", "stableRuleId", "parameterKey", "sourceRevision"]
        .some((key) => typeof (targetRuleRef as Record<string, unknown>)[key] !== "string"))) {
    return undefined;
  }
  return {
    mode: record.mode,
    recommendationId: record.recommendationId,
    assessmentInputHash: record.assessmentInputHash,
    selectedChangeIds: record.selectedChangeIds as string[],
    userReason: record.userReason,
    idempotencyKey: record.idempotencyKey,
    ...(targetModelRef ? {
      targetModelRef: targetModelRef as AIDraftConversionCommand["targetModelRef"],
    } : {}),
    ...(targetRuleRef ? {
      targetRuleRef: targetRuleRef as AIDraftConversionCommand["targetRuleRef"],
    } : {}),
  };
}

function conversionStatus(error: AIDraftConversionError): number {
  if (error.code === "AI_ASSESSMENT_OWNER_MISMATCH") return 404;
  if (error.code === "AI_CAPABILITY_MISSING") return 403;
  if ([
    "AI_ASSESSMENT_NOT_ACTIONABLE",
    "AI_ASSESSMENT_ARTIFACT_PROVENANCE_CONFLICT",
    "AI_DRAFT_TARGET_FROZEN",
    "AI_DRAFT_TARGET_REVISION_CHANGED",
    "AI_PATCH_CONFLICT_REQUIRES_REBASE",
    "AI_RULE_SOURCE_REVISION_CHANGED",
  ].includes(error.code)) return 409;
  return 422;
}

function artifactExists(state: WorkspaceState, plan: AIDraftArtifactPlan): boolean {
  if (plan.kind === "model_patch") {
    return state.patchLedger.revisions.some((entry) =>
      entry.patchId === plan.patch.patchId
      && entry.patchRevision === plan.patch.patchRevision
      && entry.rawPayload !== null
      && typeof entry.rawPayload === "object"
      && !Array.isArray(entry.rawPayload)
      && (entry.rawPayload as Record<string, unknown>).idempotencyKey
        === plan.provenanceSyncRecord.idempotencyKey
      && (entry.rawPayload as Record<string, unknown>).commandHash
        === plan.provenanceSyncRecord.commandHash);
  }
  return state.aiRuleSourceChangeDrafts.some((entry) =>
    entry.changeDraftId === plan.ruleDraft.changeDraftId
    && entry.commandHash === plan.ruleDraft.commandHash);
}

async function persistArtifact(input: {
  state: WorkspaceState;
  revision: number;
  plan: AIDraftArtifactPlan;
  author: string;
}): Promise<{ state: WorkspaceState; revision: number; idempotent: boolean }> {
  const applied = applyAIDraftArtifactPlan(input.state, input.plan);
  if (applied.idempotent) {
    if (!artifactExists(applied.state, input.plan)) {
      throw new AIDraftConversionError(
        "AI_DRAFT_IDEMPOTENCY_CONFLICT",
        "幂等记录存在，但对应草稿产物缺失。",
      );
    }
    return { state: applied.state, revision: input.revision, idempotent: true };
  }
  const saved = await saveWorkspaceState({
    state: applied.state,
    baseRevision: input.revision,
    author: input.author,
    message: `创建 ${input.plan.artifactRef.artifactId}`,
  });
  if (!saved.conflict) {
    return { state: applied.state, revision: saved.revision, idempotent: false };
  }
  const latest = await loadWorkspaceState();
  const recovered = applyAIDraftArtifactPlan(latest.state, input.plan);
  if (!recovered.idempotent || !artifactExists(recovered.state, input.plan)) {
    throw new AIDraftConversionError(
      "AI_DRAFT_TARGET_REVISION_CHANGED",
      "其他成员已保存新版本，请刷新并重新预览。",
    );
  }
  return { state: recovered.state, revision: latest.revision, idempotent: true };
}

async function markProvenanceSynced(input: {
  state: WorkspaceState;
  revision: number;
  plan: AIDraftArtifactPlan;
  author: string;
  now: string;
}): Promise<{ state: WorkspaceState; revision: number }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = attempt === 0
      ? { state: input.state, revision: input.revision }
      : await loadWorkspaceState();
    const next = structuredClone(current.state);
    const sync = next.aiArtifactProvenanceSyncRecords.find((entry) =>
      entry.syncRecordId === input.plan.provenanceSyncRecord.syncRecordId);
    if (!sync || sync.commandHash !== input.plan.provenanceSyncRecord.commandHash) {
      throw new AIDraftConversionError(
        "AI_DRAFT_IDEMPOTENCY_CONFLICT",
        "草稿来源同步记录缺失或与命令不一致。",
      );
    }
    if (sync.state === "SYNCED") return current;
    sync.state = "SYNCED";
    sync.attempts += 1;
    sync.updatedAt = input.now;
    delete sync.lastErrorCode;
    const saved = await saveWorkspaceState({
      state: next,
      baseRevision: current.revision,
      author: input.author,
      message: `确认 AI 产物来源 ${input.plan.artifactRef.artifactId}`,
    });
    if (!saved.conflict) return { state: next, revision: saved.revision };
  }
  throw new AIRuntimeStoreError(
    "AI_RETENTION_STORE_UNAVAILABLE",
    "AI 草稿已创建，但来源同步状态尚未完成。",
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ assessmentId: string }> },
) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json({ error: "请使用公司飞书账号登录。" }, { status: 401 });
  }
  const { assessmentId } = await context.params;
  if (!validAssessmentId(assessmentId)) {
    return NextResponse.json(
      { error: "AI 评估 ID 格式无效。", code: "AI_ASSESSMENT_ID_INVALID" },
      { status: 400 },
    );
  }
  const command = commandFromBody(await request.json().catch(() => undefined));
  if (!command) {
    return NextResponse.json(
      { error: "AI 草稿转换请求格式无效。", code: "AI_DRAFT_COMMAND_INVALID" },
      { status: 400 },
    );
  }
  const actorStableId = user.openId ?? user.email;
  const author = stableAuditActor(user);
  try {
    const store = createAIRuntimeStoreFromEnvironment();
    await store.initialize();
    const record = await store.readAssessmentForActor({ assessmentId, actorStableId });
    if (!record) {
      return NextResponse.json(
        { error: "AI 评估不存在。", code: "AI_ASSESSMENT_NOT_FOUND" },
        { status: 404 },
      );
    }
    const current = await loadWorkspaceState();
    const now = new Date().toISOString();
    const plan = planAIDraftConversion({
      state: current.state,
      record,
      assessmentId,
      actorStableId,
      actorDisplayName: user.name,
      capabilities: user.capabilities,
      command,
      now,
    });
    if (command.mode === "preview") {
      return NextResponse.json(plan.preview);
    }
    // Dry-run the Workspace write first so an existing idempotency binding keeps
    // its authoritative conflict semantics without creating any revision.
    applyAIDraftArtifactPlan(current.state, plan);
    const latestRecord = await store.readAssessmentForActor({ assessmentId, actorStableId });
    if (!latestRecord) {
      throw new AIDraftConversionError(
        "AI_ASSESSMENT_OWNER_MISMATCH",
        "评估不存在或不属于当前用户。",
      );
    }
    assertAIDraftArtifactProvenanceCompatible(latestRecord, plan);
    const persisted = await persistArtifact({
      state: current.state,
      revision: current.revision,
      plan,
      author,
    });
    try {
      await store.acceptAssessmentArtifact({
        assessmentId,
        actorStableId,
        provenance: plan.provenanceSyncRecord.acceptedArtifactProvenance,
        acceptedAt: now,
      });
      const synced = await markProvenanceSynced({
        state: persisted.state,
        revision: persisted.revision,
        plan,
        author,
        now,
      });
      return NextResponse.json({
        mode: "create",
        kind: plan.kind,
        assessmentId,
        recommendationId: command.recommendationId,
        artifactRef: plan.artifactRef,
        state: synced.state,
        revision: synced.revision,
        workspaceRevision: synced.revision,
        provenanceSyncState: "SYNCED",
        idempotent: persisted.idempotent,
        message: `${plan.artifactRef.artifactId} 已创建；仍需人工审核，未批准、应用或发布。`,
      });
    } catch (error) {
      if (error instanceof AIRuntimeStoreError) {
        return NextResponse.json({
          error: "草稿已创建，但永久来源仍待同步；请使用相同幂等键安全重试。",
          code: "AI_ARTIFACT_PROVENANCE_SYNC_PENDING",
          artifactRef: plan.artifactRef,
          workspaceRevision: persisted.revision,
          provenanceSyncState: "PENDING",
        }, { status: 503 });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ItemPartNotEnabledError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          itemPartId: error.itemPartId,
          policyMode: error.policyMode,
        },
        { status: 422 },
      );
    }
    if (error instanceof ItemPartChainInconsistentError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          itemPartIds: error.itemPartIds,
          policyMode: error.policyMode,
        },
        { status: 422 },
      );
    }
    if (error instanceof AIDraftConversionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: conversionStatus(error) },
      );
    }
    if (error instanceof PatchOffsetPolicyError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 422 },
      );
    }
    if (error instanceof AIRuntimeStoreError) {
      return NextResponse.json(
        { error: "AI 留存服务暂时不可用。", code: error.code },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "AI 草稿转换暂时不可用。", code: "AI_DRAFT_UNKNOWN_FAILURE" },
      { status: 503 },
    );
  }
}
