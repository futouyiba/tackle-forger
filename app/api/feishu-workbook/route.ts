import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import {
  CANONICAL_FEISHU_WORKBOOK,
} from "@/lib/feishu-workbook";
import {
  readFeishuSheetRange,
  writeFeishuSheetRanges,
} from "@/lib/feishu-sheets";
import { inspectCanonicalRuleWorkbook } from "@/lib/rule-workbook-inspection";
import {
  buildStableIdWriteCommands,
  executeStableIdWrite,
  type SourceIdentityConfirmation,
  type StableIdWriteAdapter,
} from "@/lib/source-id-migration";
import { loadWorkspaceState, saveWorkspaceState } from "@/lib/storage";
import {
  assertExplicitPullDidNotPublish,
  createRuleSetDraftFromPull,
  recordFeishuSourceRevision,
  recordPricingPolicyDraft,
  recordQualityValuePolicyDraft,
  recordSourceIdentityMigrationReport,
} from "@/lib/workbook-governance";

export const dynamic = "force-dynamic";

type WorkbookAction = "pull" | "create_ruleset_draft" | "identity_write";

function unavailable() {
  return NextResponse.json(
    { error: "请使用公司飞书账号登录。", action: "feishu_login" },
    { status: 401 },
  );
}

function hasCapability(capabilities: string[], capability: string) {
  return capabilities.includes(capability);
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : "飞书规则工作簿操作失败。";
}

export async function GET(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) return unavailable();
  if (!hasCapability(user.capabilities, "feishu.workbook.read")) {
    return NextResponse.json({ error: "当前账号没有读取规则工作簿的权限。" }, { status: 403 });
  }
  try {
    const inspection = await inspectCanonicalRuleWorkbook({
      observedAt: new Date().toISOString(),
      observedBy: user.name,
    });
    return NextResponse.json({ inspection });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) return unavailable();
  const body = (await request.json()) as {
    action?: WorkbookAction;
    baseRevision?: number;
    expectedSourceRevision?: string;
    sourceRevisionId?: string;
    reportId?: string;
    confirmations?: SourceIdentityConfirmation[];
  };
  if (!body.action) return NextResponse.json({ error: "缺少操作类型。" }, { status: 400 });

  try {
    if (body.action === "pull") {
      if (!hasCapability(user.capabilities, "feishu.workbook.pull")) {
        return NextResponse.json({ error: "当前账号没有显式拉取权限。" }, { status: 403 });
      }
      if (!Number.isInteger(body.baseRevision)) {
        return NextResponse.json({ error: "缺少有效的工作区基线版本。" }, { status: 400 });
      }
      const current = await loadWorkspaceState();
      if (current.revision !== body.baseRevision) {
        return NextResponse.json(
          { error: "团队工作区已有新版本，请刷新后重新检查。", revision: current.revision },
          { status: 409 },
        );
      }
      const inspection = await inspectCanonicalRuleWorkbook({
        observedAt: new Date().toISOString(),
        observedBy: user.name,
      });
      if (
        body.expectedSourceRevision
        && body.expectedSourceRevision !== inspection.sourceRevision.sourceRevision
      ) {
        return NextResponse.json(
          {
            error: `飞书 revision 已从 ${body.expectedSourceRevision} 变为 ${inspection.sourceRevision.sourceRevision}，请重新检查。`,
            inspection,
          },
          { status: 409 },
        );
      }
      let next = recordFeishuSourceRevision(current.state, inspection.sourceRevision);
      next = recordSourceIdentityMigrationReport(next, inspection.identityReport);
      next = recordQualityValuePolicyDraft(next, inspection.qualityDraft);
      next = recordPricingPolicyDraft(next, inspection.pricingDraft);
      assertExplicitPullDidNotPublish(current.state, next);
      const saved = await saveWorkspaceState({
        state: next,
        baseRevision: current.revision,
        author: user.name,
        message: `显式拉取飞书规则工作簿 revision ${inspection.sourceRevision.sourceRevision}`,
      });
      if (saved.conflict) {
        return NextResponse.json(
          { error: "保存拉取结果时发生版本冲突，请重新检查。", revision: saved.revision },
          { status: 409 },
        );
      }
      return NextResponse.json({ state: next, revision: saved.revision, inspection });
    }

    if (body.action === "create_ruleset_draft") {
      if (!hasCapability(user.capabilities, "ruleset.draft.create")) {
        return NextResponse.json({ error: "当前账号没有创建规则草稿的权限。" }, { status: 403 });
      }
      if (!Number.isInteger(body.baseRevision) || !body.sourceRevisionId) {
        return NextResponse.json({ error: "缺少工作区版本或源修订。" }, { status: 400 });
      }
      const current = await loadWorkspaceState();
      if (current.revision !== body.baseRevision) {
        return NextResponse.json(
          { error: "团队工作区已有新版本，请刷新后重试。", revision: current.revision },
          { status: 409 },
        );
      }
      const created = createRuleSetDraftFromPull({
        state: current.state,
        sourceRevisionId: body.sourceRevisionId,
        createdAt: new Date().toISOString(),
        createdBy: user.name,
      });
      const saved = await saveWorkspaceState({
        state: created.state,
        baseRevision: current.revision,
        author: user.name,
        message: `由飞书源修订 ${body.sourceRevisionId} 创建 RuleSet 草稿`,
      });
      if (saved.conflict) {
        return NextResponse.json({ error: "保存规则草稿时发生版本冲突。" }, { status: 409 });
      }
      return NextResponse.json({
        state: created.state,
        revision: saved.revision,
        ruleSetDraft: created.ruleSetDraft,
      });
    }

    if (!hasCapability(user.capabilities, "feishu.identity.write")) {
      return NextResponse.json({ error: "当前账号没有稳定 ID 回写权限。" }, { status: 403 });
    }
    if (!Number.isInteger(body.baseRevision)) {
      return NextResponse.json({ error: "缺少有效的工作区基线版本。" }, { status: 400 });
    }
    if (!body.reportId || !body.confirmations?.length) {
      return NextResponse.json({ error: "缺少迁移报告或人工确认记录。" }, { status: 400 });
    }
    const current = await loadWorkspaceState();
    if (current.revision !== body.baseRevision) {
      return NextResponse.json(
        { error: "团队工作区已有新版本，请刷新并重新检查迁移报告。", revision: current.revision },
        { status: 409 },
      );
    }
    const report = current.state.sourceIdentityMigrationReports.find((item) => item.reportId === body.reportId);
    if (!report) return NextResponse.json({ error: "找不到已登记的迁移报告，请先显式拉取。" }, { status: 404 });
    const source = current.state.feishuSourceRevisions.find((item) => item.sourceRevision === report.sourceRevision);
    if (!source) return NextResponse.json({ error: "迁移报告引用的源修订不存在。" }, { status: 409 });
    const inspection = await inspectCanonicalRuleWorkbook({
      observedAt: new Date().toISOString(),
      observedBy: user.name,
    });
    const commands = buildStableIdWriteCommands({
      report,
      rows: inspection.identityRows,
      confirmations: body.confirmations,
    });
    const adapter: StableIdWriteAdapter = {
      getCurrentRevision: async () => {
        const probe = await readFeishuSheetRange({
          spreadsheetToken: source.spreadsheetToken,
          sheetId: source.sheets[0].sheetId,
          range: "A1:A1",
        });
        return probe.revision;
      },
      writeStableIds: async ({ commands: pending }) => {
        await writeFeishuSheetRanges({
          spreadsheetToken: source.spreadsheetToken,
          valueRanges: pending.map((command) => ({
            sheetId: command.sheetId,
            cell: `${command.idColumnKey}${command.rowKey}`,
            value: command.stableId,
          })),
        });
      },
      readStableIds: async ({ commands: pending }) => Promise.all(pending.map(async (command) => {
        const cell = `${command.idColumnKey}${command.rowKey}`;
        const valueRange = await readFeishuSheetRange({
          spreadsheetToken: source.spreadsheetToken,
          sheetId: command.sheetId,
          range: `${cell}:${cell}`,
        });
        return {
          sheetId: command.sheetId,
          rowKey: command.rowKey,
          stableId: String(valueRange.values[0]?.[0] ?? ""),
        };
      })),
    };
    const result = await executeStableIdWrite({
      workbook: { ...CANONICAL_FEISHU_WORKBOOK, spreadsheetToken: source.spreadsheetToken },
      report,
      commands,
      idempotencyKey: `identity-write:${report.reportId}`,
      adapter,
    });
    return NextResponse.json({ result, requiresExplicitPull: result.state === "WRITE_VERIFIED" });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 422 });
  }
}
