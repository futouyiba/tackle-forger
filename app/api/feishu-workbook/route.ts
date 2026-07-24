import { NextRequest, NextResponse } from "next/server";
import { requestUser } from "@/lib/auth";
import {
  CANONICAL_FEISHU_WORKBOOK,
} from "@/lib/feishu-workbook";
import {
  readFeishuSheetRange,
  writeFeishuSheetRanges,
} from "@/lib/feishu-sheets";
import { FeishuApiError, type FeishuApiErrorInfo } from "@/lib/feishu-api-error";
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
  applyCanonicalRuleSourceDraft,
  createRuleSetDraftFromPull,
  publishRuleSetVersion,
  recordFeishuSourceRevision,
  recordWeightTemplatePolicyDraft,
  recordPricingPolicyDraft,
  recordQualityValuePolicyDraft,
  recordSourceIdentityMigrationReport,
} from "@/lib/workbook-governance";
import { ActionCommandPayloadError } from "@/lib/action-command-payloads";
import {
  executeProductionWorkspaceCommand,
  WorkspaceCommandTransientHttpError,
} from "@/lib/production-action-commands";

export const dynamic = "force-dynamic";

type WorkbookAction = "pull" | "create_ruleset_draft" | "publish_ruleset" | "identity_write";

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

/**
 * 把飞书接口失败写入服务端日志（含 code/msg/endpoint/tokenContext/堆栈），
 * 让运维可以从日志定位「权限不足 / 资源不存在 / 飞书 5xx / token 问题」，
 * 并返回脱敏的 errorInfo（不含 token）供响应体使用。既往实现只把错误塞进
 * 502 响应体、不写 server 日志，根因无法定位。
 */
function logWorkbookError(error: unknown, context: string): FeishuApiErrorInfo | undefined {
  if (error instanceof FeishuApiError) {
    console.error(`[feishu-workbook] ${context} FeishuApiError`, {
      message: error.message,
      code: error.code,
      msg: error.feishuMsg,
      httpStatus: error.httpStatus,
      endpoint: error.endpoint,
      tokenContext: error.tokenContext,
      stack: error.stack,
    });
    return error.toErrorInfo();
  }
  if (error instanceof Error) {
    console.error(`[feishu-workbook] ${context} ${error.name}: ${error.message}`, error.stack);
  } else {
    console.error(`[feishu-workbook] ${context} 非 Error 抛出`, error);
  }
  return undefined;
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
    const errorInfo = logWorkbookError(error, "GET /api/feishu-workbook");
    return NextResponse.json({ error: safeError(error), errorInfo }, { status: 502 });
  }
}

async function executeWorkbookBusinessRequest(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) return unavailable();
  const body = (await request.json()) as {
    action?: WorkbookAction;
    baseRevision?: number;
    expectedSourceRevision?: string;
    sourceRevisionId?: string;
    ruleSetDraftId?: string;
    warningAcknowledgements?: Array<{ issueKey: string; reason: string }>;
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
      const unresolvedIdentity = inspection.identityReport.items.filter(
        (item) => item.state === "NEW_SOURCE_ROW" || item.state === "CONFLICT" || item.requiresHumanConfirmation,
      );
      if (inspection.identityReport.blockingIssueCodes.length || unresolvedIdentity.length) {
        return NextResponse.json(
          {
            error: `飞书稳定身份未完成确认，已保留当前可用规则：${[
              ...inspection.identityReport.blockingIssueCodes,
              ...unresolvedIdentity.map((item) => item.state),
            ].join("、")}`,
            inspection,
          },
          { status: 422 },
        );
      }
      let next = recordFeishuSourceRevision(current.state, inspection.sourceRevision);
      const hasWeightTemplateErrors = inspection.canonicalRuleDraft.issues.some((issue) => issue.level === "error" && issue.code.startsWith("WEIGHT_TEMPLATE_"));
      if (hasWeightTemplateErrors) {
        // Preserve the complete source draft and its bad-row evidence without
        // attempting a reference migration or replacing active templates.
        next = {
          ...next,
          canonicalRuleSourceDrafts: [
            inspection.canonicalRuleDraft,
            ...next.canonicalRuleSourceDrafts.filter((draft) => draft.id !== inspection.canonicalRuleDraft.id),
          ],
        };
      } else next = applyCanonicalRuleSourceDraft(next, inspection.canonicalRuleDraft, { activateTemplates: false });
      next = recordWeightTemplatePolicyDraft(next, inspection.weightTemplateDraft);
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

    if (body.action === "publish_ruleset") {
      if (!hasCapability(user.capabilities, "ruleset.publish")) {
        return NextResponse.json({ error: "当前账号没有发布 RuleSetVersion 的权限。" }, { status: 403 });
      }
      if (!Number.isInteger(body.baseRevision) || !body.ruleSetDraftId) {
        return NextResponse.json({ error: "缺少工作区版本或 RuleSet 草稿。" }, { status: 400 });
      }
      const current = await loadWorkspaceState();
      if (current.revision !== body.baseRevision) {
        return NextResponse.json(
          { error: "团队工作区已有新版本，请刷新后重新审查规则草稿。", revision: current.revision },
          { status: 409 },
        );
      }
      const existingRuleSet = current.state.ruleSetVersions.find((item) => item.id === body.ruleSetDraftId);
      if (existingRuleSet?.status === "published") {
        return NextResponse.json({ state: current.state, revision: current.revision, ruleSetVersion: existingRuleSet });
      }
      const published = publishRuleSetVersion({
        state: current.state,
        ruleSetDraftId: body.ruleSetDraftId,
        publishedAt: new Date().toISOString(),
        publishedBy: user.name,
        warningAcknowledgements: body.warningAcknowledgements,
      });
      const saved = await saveWorkspaceState({
        state: published.state,
        baseRevision: current.revision,
        author: user.name,
        message: `显式发布 RuleSetVersion ${published.ruleSetVersion.id}`,
      });
      if (saved.conflict) {
        return NextResponse.json({ error: "发布 RuleSetVersion 时发生版本冲突。" }, { status: 409 });
      }
      return NextResponse.json({
        state: published.state,
        revision: saved.revision,
        ruleSetVersion: published.ruleSetVersion,
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
    const errorInfo = logWorkbookError(error, "POST /api/feishu-workbook 业务请求");
    return NextResponse.json({ error: safeError(error), errorInfo }, { status: 422 });
  }
}

function commandErrorStatus(error: ActionCommandPayloadError): number {
  if (error.code === "ACTION_COMMAND_PAYLOAD_NOT_FOUND") return 404;
  if (error.code === "ACTION_COMMAND_CAPABILITY_CHANGED") return 403;
  if (
    error.code === "ACTION_COMMAND_REVISION_CONFLICT"
    || error.code === "ACTION_COMMAND_INPUT_HASH_MISMATCH"
    || error.code === "STALE_FENCING_TOKEN"
    || error.code === "IDEMPOTENCY_KEY_REUSED"
  ) return 409;
  return 422;
}

const WORKBOOK_COMMAND_ACTIONS = {
  pull_feishu_workbook: "pull",
  create_ruleset_draft: "create_ruleset_draft",
  publish_ruleset: "publish_ruleset",
  write_feishu_identity: "identity_write",
} as const;

export async function POST(request: NextRequest) {
  const user = await requestUser(request);
  if (!user.authenticated) return unavailable();
  const invocation = await request.json().catch(() => null);
  const current = await loadWorkspaceState();
  try {
    const execution = await executeProductionWorkspaceCommand({
      expectedAction: [
        "pull_feishu_workbook",
        "create_ruleset_draft",
        "publish_ruleset",
        "write_feishu_identity",
      ],
      invocation,
      user,
      current,
      execute: async (storedPayload, commandAction) => {
        if (
          storedPayload.action
          !== WORKBOOK_COMMAND_ACTIONS[
            commandAction as keyof typeof WORKBOOK_COMMAND_ACTIONS
          ]
        ) {
          throw new ActionCommandPayloadError(
            "ACTION_COMMAND_ACTION_MISMATCH",
            "工作簿命令动作与服务端保存的业务载荷不一致。",
          );
        }
        const response = await executeWorkbookBusinessRequest(
          new NextRequest(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(storedPayload),
          }),
        );
        return { status: response.status, body: await response.json() };
      },
    });
    return NextResponse.json(
      {
        ...(execution.result.body as Record<string, unknown>),
        replayed: execution.replayed,
      },
      { status: execution.result.status },
    );
  } catch (error) {
    if (error instanceof WorkspaceCommandTransientHttpError) {
      return NextResponse.json(
        error.result.body,
        { status: error.result.status },
      );
    }
    if (error instanceof ActionCommandPayloadError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: commandErrorStatus(error) },
      );
    }
    throw error;
  }
}
