import { NextResponse, type NextRequest } from "next/server";
import { requestUser } from "@/lib/auth";
import { AIRuntimeStoreError, createAIRuntimeStoreFromEnvironment } from "@/lib/ai-runtime-store";

export const dynamic = "force-dynamic";

function dismissCommand(value: unknown): { recommendationId: string; reason?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "recommendationId" && key !== "reason")
    || typeof record.recommendationId !== "string"
    || (record.reason !== undefined && typeof record.reason !== "string")) {
    return undefined;
  }
  return {
    recommendationId: record.recommendationId,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
  };
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
  if (!/^[A-Za-z0-9-]{1,128}$/.test(assessmentId)) {
    return NextResponse.json(
      { error: "AI 评估 ID 格式无效。", code: "AI_ASSESSMENT_ID_INVALID" },
      { status: 400 },
    );
  }
  const command = dismissCommand(await request.json().catch(() => undefined));
  if (!command || !/^[A-Za-z0-9_.:-]{1,128}$/.test(command.recommendationId)) {
    return NextResponse.json(
      { error: "AI 建议反馈格式无效。", code: "AI_RECOMMENDATION_FEEDBACK_INVALID" },
      { status: 400 },
    );
  }
  try {
    const store = createAIRuntimeStoreFromEnvironment();
    await store.initialize();
    const result = await store.dismissAssessmentRecommendation({
      assessmentId,
      actorStableId: user.openId ?? user.email,
      recommendationId: command.recommendationId,
      dismissedAt: new Date().toISOString(),
      reason: command.reason,
    });
    return NextResponse.json({
      assessmentId,
      recommendationId: command.recommendationId,
      state: "dismissed",
      idempotent: result.idempotent,
    });
  } catch (error) {
    if (error instanceof AIRuntimeStoreError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 422 },
      );
    }
    return NextResponse.json(
      { error: "AI 建议反馈暂时不可用。", code: "AI_RECOMMENDATION_FEEDBACK_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
