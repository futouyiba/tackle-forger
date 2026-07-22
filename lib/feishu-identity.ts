import type { CapabilityCode } from "./interaction-contracts";

export interface FeishuIdentity {
  tenantKey: string;
  openId: string;
  displayName: string;
  avatarUrl?: string;
  lastLoginAt: string;
}

export const PHASE_ONE_CAPABILITIES = [
  "series.read",
  "sku.read",
  "model.read",
  "model.edit",
  "model.review",
  "model.publish",
  "candidate.generate",
  "candidate.materialize",
  "candidate.select",
  "candidate.dismiss",
  "model.patch.create",
  "model.patch.review",
  "patch.rebase",
  "snapshot.read",
  "snapshot.export",
  "feishu.workbook.read",
  "feishu.workbook.pull",
  "feishu.identity.write",
  "ruleset.draft.create",
  "data_source.resolve",
  "data_source.preview",
  "data_source.publish",
  "data_source.writeback.preview",
  "data_source.writeback.commit",
  "excel.import",
  "revision.read",
  "config.export.preview",
  "config.export.commit",
  "rules.five_axis.publish",
  "workspace.policy.manage",
  "workspace.save",
] as const satisfies readonly CapabilityCode[];
