import { NextRequest, NextResponse } from "next/server";
import { stableAuditActor } from "@/lib/api-command-boundaries";
import { confirmAIRuleSourceChangeDraft, AIDraftConversionError } from "@/lib/ai-draft-conversion";
import { requestUser } from "@/lib/auth";
import { loadWorkspaceState, saveWorkspaceState } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) {
    return NextResponse.json({ error: "请使用公司飞书账号登录。" }, { status: 401 });
  }
  if (!user.capabilities.includes("feishu.rule_change.confirm_write")) {
    return NextResponse.json({ error: "当前账号没有确认规则写回的权限。" }, { status: 403 });
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body
    || !Number.isInteger(body.baseRevision)
    || typeof body.changeDraftId !== "string"
    || typeof body.expectedCommandHash !== "string"
    || typeof body.idempotencyKey !== "string"
    || !body.idempotencyKey.trim()) {
    return NextResponse.json({ error: "工作区基线、草稿引用、内容哈希或幂等键无效。" }, { status: 400 });
  }
  const current = await loadWorkspaceState();
  const actor = stableAuditActor(user);
  try {
    const confirmed = confirmAIRuleSourceChangeDraft({
      state: current.state,
      changeDraftId: body.changeDraftId,
      expectedCommandHash: body.expectedCommandHash,
      idempotencyKey: body.idempotencyKey,
      actorStableId: actor,
      confirmedAt: new Date().toISOString(),
      capabilities: user.capabilities,
    });
    if (confirmed.idempotent) {
      return NextResponse.json({ ...confirmed, revision: current.revision });
    }
    if (current.revision !== body.baseRevision) {
      return NextResponse.json(
        { error: "团队工作区已有新版本，请重载草稿后确认。", revision: current.revision },
        { status: 409 },
      );
    }
    const saved = await saveWorkspaceState({
      state: confirmed.state,
      baseRevision: current.revision,
      author: actor,
      message: `人工确认 AI 规则源变更草稿 ${confirmed.draft.changeDraftId}`,
    });
    if (saved.conflict) {
      return NextResponse.json({ error: "保存确认结果时发生版本冲突。", revision: saved.revision }, { status: 409 });
    }
    return NextResponse.json({ ...confirmed, revision: saved.revision });
  } catch (error) {
    if (error instanceof AIDraftConversionError) {
      const status = error.code === "AI_RULE_DRAFT_NOT_FOUND" ? 404
        : error.code === "AI_DRAFT_PERMISSION_DENIED" ? 403 : 409;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: "AI 规则草稿确认失败。" }, { status: 500 });
  }
}
