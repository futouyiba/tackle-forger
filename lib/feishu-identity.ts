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
  "series.edit",
  "sku.read",
  "sku.edit",
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
  "patch.absorption.review",
  "patch.create",
  "patch.review",
  "patch.mirror.write",
  "patch.mirror.pull",
  "rules.proposal.create",
  "snapshot.read",
  "feishu.workbook.read",
  "feishu.workbook.pull",
  "feishu.identity.write",
  "ruleset.draft.create",
  "ruleset.publish",
  "data_source.resolve",
  "data_source.preview",
  "data_source.publish",
  "data_source.writeback.preview",
  "data_source.writeback.commit",
  "excel.import",
  "revision.read",
  "config.export.preview",
  "rules.five_axis.publish",
  "workspace.policy.manage",
  "workspace.save",
] as const satisfies readonly CapabilityCode[];
