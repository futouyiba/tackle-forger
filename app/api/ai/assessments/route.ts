import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requestUser } from "@/lib/auth";
import { buildWorkspaceAssessmentEnvelope, workspaceAssessmentScopeExists } from "@/lib/ai-assessment-request";
import { AIRuntimeStoreError, createAIRuntimeStoreFromEnvironment } from "@/lib/ai-runtime-store";
import { createFancyHubConnectorFromEnvironment, FancyHubError } from "@/lib/fancy-hub";
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
  try {
    const runtimeStore = createAIRuntimeStoreFromEnvironment();
    await runtimeStore.initialize();
    const requestedAt = new Date().toISOString();
    const connector = createFancyHubConnectorFromEnvironment({
      auditSink: (event) => runtimeStore.appendAuditEvent(event),
      admissionCoordinator: runtimeStore.admissionCoordinator(),
    });
    const result = await connector.assess({
      workspaceId: "default",
      actorStableId: user.openId ?? user.email,
      buildEnvelope: (model) => buildWorkspaceAssessmentEnvelope({ state: current.state, scope: body, assessmentId, model }),
    });
    const completedAt = new Date().toISOString();
    await runtimeStore.saveAssessment(runtimeStore.successfulAssessmentRecord({
      assessmentId,
      actorStableId: user.openId ?? user.email,
      scopeStableRef: `${body.scopeType}:${body.scopeId}`,
      requestedAt,
      completedAt,
      requestEnvelope: result.requestEnvelope,
      canonicalRequestJson: result.canonicalRequestJson,
      inputHash: result.inputHash,
      response: result.response,
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
  } catch (error) {
    if (error instanceof Error && error.message === "AI_SCOPE_NOT_FOUND") {
      return NextResponse.json({ error: "评估对象不存在或已经变化。", code: "AI_SCOPE_NOT_FOUND" }, { status: 404 });
    }
    if (error instanceof FancyHubError || error instanceof AIOutboundError || error instanceof AIRuntimeStoreError) {
      return NextResponse.json({ error: "AI 评估未完成，核心工作流不受影响。", code: error.code }, { status: error instanceof FancyHubError && error.retryable ? 503 : 422 });
    }
    return NextResponse.json({ error: "AI 服务暂时不可用，核心工作流不受影响。", code: "AI_UNKNOWN_FAILURE" }, { status: 503 });
  }
}
