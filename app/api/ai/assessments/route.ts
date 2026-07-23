import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requestUser } from "@/lib/auth";
import {
  buildWorkspaceAssessmentRequestProjection,
  workspaceAssessmentScopeExists,
  type WorkspaceAssessmentRequestProjection,
} from "@/lib/ai-assessment-request";
import {
  AIRuntimeStoreError,
  createAIRuntimeStoreFromEnvironment,
  type FileAIRuntimeStore,
} from "@/lib/ai-runtime-store";
import {
  createFancyHubConnectorFromEnvironment,
  FancyHubError,
  type FancyHubRawAssessmentAttempt,
} from "@/lib/fancy-hub";
import { AIOutboundError } from "@/lib/ai-outbound";
import { loadWorkspaceState } from "@/lib/storage";

export const dynamic = "force-dynamic";

function assessmentRequest(value: unknown): { scopeType: "series" | "model"; scopeId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "scopeId,scopeType") return undefined;
  if (record.scopeType !== "series" && record.scopeType !== "model") return undefined;
  if (typeof record.scopeId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(record.scopeId)) return undefined;
  return { scopeType: record.scopeType, scopeId: record.scopeId };
}

export async function POST(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) return NextResponse.json({ error: "请使用公司飞书账号登录。" }, { status: 401 });
  const availability = user.actionAvailability.run_ai_assessment;
  if (!availability.enabled) {
    return NextResponse.json({ error: availability.disabledReasonText, actionAvailability: availability }, { status: 403 });
  }
  const body = assessmentRequest(await request.json().catch(() => undefined));
  if (!body) return NextResponse.json({ error: "AI 评估请求格式无效。", code: "AI_ASSESSMENT_REQUEST_INVALID" }, { status: 400 });
  const current = await loadWorkspaceState();
  if (!workspaceAssessmentScopeExists(current.state, body)) {
    return NextResponse.json({ error: "评估对象不存在或已经变化。", code: "AI_SCOPE_NOT_FOUND" }, { status: 404 });
  }
  const assessmentId = randomUUID();
  const actorStableId = user.openId ?? user.email;
  const requestedAt = new Date().toISOString();
  const rawAttempts: FancyHubRawAssessmentAttempt[] = [];
  let requestProjection: WorkspaceAssessmentRequestProjection | undefined;
  let runtimeStore: FileAIRuntimeStore | undefined;
  try {
    const store = createAIRuntimeStoreFromEnvironment();
    runtimeStore = store;
    await store.initialize();
    const connector = createFancyHubConnectorFromEnvironment({
      auditSink: (event) => store.appendAuditEvent(event),
      admissionCoordinator: store.admissionCoordinator(),
    });
    const result = await connector.assess({
      workspaceId: "default",
      actorStableId,
      buildEnvelope: (model) => {
        requestProjection = buildWorkspaceAssessmentRequestProjection({
          state: current.state,
          scope: body,
          assessmentId,
          model,
        });
        return requestProjection.envelope;
      },
      rawAttemptSink: (attempt) => {
        rawAttempts.push(attempt);
      },
    });
    const completedAt = new Date().toISOString();
    if (!requestProjection) {
      throw new AIRuntimeStoreError("AI_RETENTION_STORE_UNAVAILABLE", "AI 请求缺少可留存的安全投影。");
    }
    await store.saveAssessment(store.successfulAssessmentRecord({
      assessmentId,
      actorStableId,
      scopeStableRef: `${body.scopeType}:${body.scopeId}`,
      requestedAt,
      completedAt,
      requestEnvelope: result.requestEnvelope,
      canonicalRequestJson: result.canonicalRequestJson,
      inputHash: result.inputHash,
      response: result.response,
      prompt: requestProjection.prompt,
      requestAliasMapping: requestProjection.requestAliasMapping,
      rawAttempts,
    }));
    return NextResponse.json({
      assessmentId,
      inputHash: result.inputHash,
      outputHash: result.response.outputHash,
      modelDescriptor: result.response.model,
      result: result.response.result,
      usage: result.response.usage,
      attemptedModelIds: result.attemptedModelIds,
    });
  } catch (caughtError) {
    let error = caughtError;
    if (runtimeStore && requestProjection && rawAttempts.length) {
      const completedAt = new Date().toISOString();
      const resultCode = caughtError instanceof FancyHubError || caughtError instanceof AIOutboundError || caughtError instanceof AIRuntimeStoreError
        ? caughtError.code
        : "AI_UNKNOWN_FAILURE";
      try {
        await runtimeStore.saveAssessment(runtimeStore.failedAssessmentRecord({
          assessmentId,
          actorStableId,
          scopeStableRef: `${body.scopeType}:${body.scopeId}`,
          requestedAt,
          completedAt,
          resultCode,
          prompt: requestProjection.prompt,
          requestAliasMapping: requestProjection.requestAliasMapping,
          rawAttempts,
        }));
      } catch (retentionError) {
        error = retentionError;
      }
    }
    if (error instanceof Error && error.message === "AI_SCOPE_NOT_FOUND") {
      return NextResponse.json({ error: "评估对象不存在或已经变化。", code: "AI_SCOPE_NOT_FOUND" }, { status: 404 });
    }
    if (error instanceof FancyHubError || error instanceof AIOutboundError || error instanceof AIRuntimeStoreError) {
      return NextResponse.json({ error: "AI 评估未完成，核心工作流不受影响。", code: error.code }, { status: error instanceof FancyHubError && error.retryable ? 503 : 422 });
    }
    return NextResponse.json({ error: "AI 服务暂时不可用，核心工作流不受影响。", code: "AI_UNKNOWN_FAILURE" }, { status: 503 });
  }
}
