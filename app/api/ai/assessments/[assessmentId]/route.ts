import { NextResponse, type NextRequest } from "next/server";
import { requestUser } from "@/lib/auth";
import { AIRuntimeStoreError, createAIRuntimeStoreFromEnvironment } from "@/lib/ai-runtime-store";

export const dynamic = "force-dynamic";

function validAssessmentId(value: string): boolean {
  return /^[A-Za-z0-9-]{1,128}$/.test(value);
}

async function authenticatedActor(request: NextRequest): Promise<string | undefined> {
  const user = await requestUser(request);
  if (!user.authenticated) return undefined;
  return user.openId ?? user.email;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ assessmentId: string }> },
) {
  const actorStableId = await authenticatedActor(request);
  if (!actorStableId) return NextResponse.json({ error: "请使用公司飞书账号登录。" }, { status: 401 });
  const { assessmentId } = await context.params;
  if (!validAssessmentId(assessmentId)) {
    return NextResponse.json({ error: "AI 评估 ID 格式无效。", code: "AI_ASSESSMENT_ID_INVALID" }, { status: 400 });
  }
  try {
    const store = createAIRuntimeStoreFromEnvironment();
    await store.initialize();
    const record = await store.readAssessmentForActor({ assessmentId, actorStableId });
    if (!record) return NextResponse.json({ error: "AI 评估不存在。", code: "AI_ASSESSMENT_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({
      metadata: record.metadata,
      semanticContent: record.semanticContent,
      acceptedArtifactProvenance: record.acceptedArtifactProvenance,
      visibility: record.visibility,
    });
  } catch (error) {
    if (error instanceof AIRuntimeStoreError) {
      return NextResponse.json({ error: "AI 留存服务暂时不可用。", code: error.code }, { status: 503 });
    }
    return NextResponse.json({ error: "AI 留存服务暂时不可用。", code: "AI_RETENTION_UNKNOWN_FAILURE" }, { status: 503 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ assessmentId: string }> },
) {
  const actorStableId = await authenticatedActor(request);
  if (!actorStableId) return NextResponse.json({ error: "请使用公司飞书账号登录。" }, { status: 401 });
  const { assessmentId } = await context.params;
  if (!validAssessmentId(assessmentId)) {
    return NextResponse.json({ error: "AI 评估 ID 格式无效。", code: "AI_ASSESSMENT_ID_INVALID" }, { status: 400 });
  }
  try {
    const store = createAIRuntimeStoreFromEnvironment();
    await store.initialize();
    const record = await store.requestAssessmentDeletion({ assessmentId, actorStableId });
    if (!record) return NextResponse.json({ error: "AI 评估不存在。", code: "AI_ASSESSMENT_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({
      assessmentId,
      visibility: record.visibility,
      state: record.metadata?.state ?? "USER_DELETED",
      requestedAt: record.deletionTombstone?.requestedAt,
    });
  } catch (error) {
    if (error instanceof AIRuntimeStoreError) {
      return NextResponse.json({ error: "AI 留存服务暂时不可用。", code: error.code }, { status: 503 });
    }
    return NextResponse.json({ error: "AI 留存服务暂时不可用。", code: "AI_RETENTION_UNKNOWN_FAILURE" }, { status: 503 });
  }
}
