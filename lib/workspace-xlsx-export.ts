import * as XLSX from "xlsx";
import type { WorkspaceState } from "./types";

/**
 * 只读派生导出：把当前工作区状态序列化为多 sheet xlsx，用于与飞书规则源
 * 逐表对照、排查数据结构不一致。
 *
 * 设计约束（与 CLAUDE.md / v3 规范一致）：
 * - 纯函数、确定性：相同输入产生相同的 sheet 名、列顺序与单元格值；不读取
 *   系统时钟、不生成随机 ID、不触发任何写操作或新 revision。
 * - 不修改任何正式数据/快照/规则源；调用方负责权限校验。
 * - 敏感字段（键名命中 token/secret/password/credential/nonce/session/apiKey
 *   的值）一律脱敏为常量标记 `<redacted>`，不把任何凭据写进导出。
 * - 列顺序按类型字段顺序与飞书源表结构选取，便于人工逐列对照；未在规范中
 *   明确的列命名采用合理默认，并在导出说明 sheet 中文档化，不硬编码领域语义。
 */

export interface WorkspaceExportInput {
  state: WorkspaceState;
  revision: number;
}

export const REDACTED = "<redacted>";
const SENSITIVE_KEY = /token|secret|password|credential|nonce|session|apikey/i;

type Cell = string | number | boolean | null;
type Row = Cell[];

export interface WorkspaceSheetSpec {
  /** sheet 名（中文，便于和飞书源对照）。 */
  name: string;
  /** 在「导出说明」中展示的该 sheet 含义。 */
  description: string;
  /** 表头列名。 */
  header: string[];
  /** 数据行；每行长度与 header 一致。 */
  rows: Row[];
}

/**
 * 递归脱敏：对键名命中敏感模式的值替换为常量标记。返回深拷贝，不修改入参。
 * 数组元素按位置递归；基本类型原样返回。
 */
export function redactSensitive<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item)) as T;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(entry);
  }
  return result as T;
}

/**
 * 稳定 JSON 序列化：对象键按字典序排序，保证相同语义内容产生相同字符串。
 * 用于把嵌套结构（如 values、selector、requirements）压缩成单个单元格。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return "{" + entries.join(",") + "}";
}

function joinList(values: unknown[]): string {
  return values.map((value) => String(value ?? "")).filter(Boolean).join(",");
}

function countRules(rules: unknown): number {
  return Array.isArray(rules) ? rules.length : 0;
}

/**
 * 构建全部 sheet 规格。顺序固定，列命名与飞书源表对齐。导出范围是合理默认：
 * 覆盖与飞书源最相关的结构化集合（规则源修订绑定、RuleSet、参数/模板/部位、
 * 钓法/类型/功能/性能/品质档案、兼容与亲和规则、词条与技术、合集/系列/SKU/
 * Model/快照、定价与品质策略草稿、五轴定义、修订与治理审计），以及派生投影
 * 与 Patch 台账的摘要。深嵌套 trace 不展开，仅导出摘要列与 hash，便于定位
 * 结构差异而不膨胀文件。
 */
export function buildWorkspaceSheetSpecs(input: WorkspaceExportInput): WorkspaceSheetSpec[] {
  const { state, revision } = input;
  const sheets: WorkspaceSheetSpec[] = [];

  sheets.push({
    name: "工作区元数据",
    description: "当前工作区的 schema/revision 与主要集合记录数，作为对照起点。",
    header: ["字段", "值"],
    rows: [
      ["schemaVersion", state.schemaVersion],
      ["revision", revision],
      ["reductionStackingMode", state.ruleSettings.reductionStackingMode ?? ""],
      ["reductionStackingPolicyVersion", state.ruleSettings.reductionStackingPolicyVersion ?? ""],
      ["importedAt", state.importedAt],
      ["notes", state.notes],
      ["feishuWorkbooks", state.feishuWorkbooks.length],
      ["feishuSourceRevisions", state.feishuSourceRevisions.length],
      ["ruleSetVersions", state.ruleSetVersions.length],
      ["parameters", state.parameters.length],
      ["templates", state.templates.length],
      ["itemParts", state.itemParts.length],
      ["methodProfiles", state.methodProfiles.length],
      ["itemTypeProfiles", state.itemTypeProfiles.length],
      ["functionProfiles", state.functionProfiles.length],
      ["performanceProfiles", state.performanceProfiles.length],
      ["qualityProfiles", state.qualityProfiles.length],
      ["v3Affixes", state.v3Affixes.length],
      ["technologies", state.technologies.length],
      ["collections", state.collections.length],
      ["seriesDefinitions", state.seriesDefinitions.length],
      ["skuDrawers", state.skuDrawers.length],
      ["purchasableModels", state.purchasableModels.length],
      ["configurationSnapshots", state.configurationSnapshots.length],
      ["derivedProjections", state.derivedProjections.length],
      ["pricingPolicyDrafts", state.pricingPolicyDrafts.length],
      ["pricingPolicyVersions", state.pricingPolicyVersions.length],
      ["qualityValuePolicyDrafts", state.qualityValuePolicyDrafts.length],
      ["fiveAxisViewDefinitions", state.fiveAxisViewDefinitions.length],
    ],
  });

  sheets.push({
    name: "飞书源修订",
    description: "feishuSourceRevisions：显式拉取的源修订绑定，用于核对工作区引用的源版本是否最新。",
    header: [
      "id", "workbookRefId", "sourceRevision", "spreadsheetToken", "pulledAt",
      "pulledBy", "anchorSheetId", "syncScope", "registryHash", "state",
      "sheetCount", "issueCount",
    ],
    rows: state.feishuSourceRevisions.map((entry) => [
      entry.id,
      entry.workbookRefId,
      entry.sourceRevision,
      REDACTED,
      entry.pulledAt,
      entry.pulledBy,
      entry.anchorSheetId ?? "",
      entry.syncScope,
      entry.registryHash,
      entry.state,
      entry.sheets.length,
      entry.issues.length,
    ]),
  });

  sheets.push({
    name: "飞书工作簿",
    description: "feishuWorkbooks：canonical 规则工作簿引用；token 类字段已脱敏。",
    header: [
      "id", "name", "provider", "shareUrl", "wikiToken", "spreadsheetToken",
      "anchorSheetId", "syncScope", "enabled",
    ],
    rows: state.feishuWorkbooks.map((entry) => [
      entry.id,
      entry.name,
      entry.provider,
      entry.shareUrl,
      REDACTED,
      entry.spreadsheetToken ? REDACTED : "",
      entry.anchorSheetId ?? "",
      entry.syncScope,
      entry.enabled,
    ]),
  });

  sheets.push({
    name: "RuleSet版本",
    description: "ruleSetVersions：已发布/草稿规则集版本及其源修订绑定。",
    header: [
      "id", "version", "status", "sourceRevisionIds", "createdAt",
      "publishedAt", "publishedBy", "publicationHash", "notes",
    ],
    rows: state.ruleSetVersions.map((entry) => [
      entry.id,
      entry.version,
      entry.status,
      joinList(entry.sourceRevisionIds),
      entry.createdAt,
      entry.publishedAt ?? "",
      entry.publishedBy ?? "",
      entry.publicationHash ?? "",
      entry.notes,
    ]),
  });

  sheets.push({
    name: "参数定义",
    description: "parameters：参数注册表，对照飞书参数列。",
    header: [
      "key", "label", "itemKind", "itemPartId", "unit", "precision",
      "benefitMode", "balanceWeight", "normalizationScale", "notes",
    ],
    rows: state.parameters.map((entry) => [
      entry.key,
      entry.label,
      entry.itemKind,
      entry.itemPartId ?? "",
      entry.unit,
      entry.precision,
      entry.benefitMode ?? "",
      entry.balanceWeight ?? "",
      entry.normalizationScale ?? "",
      entry.notes,
    ]),
  });

  sheets.push({
    name: "部位定义",
    description: "itemParts：v3 部位注册表（竿/轮/线等），对照部位与参数归属。",
    header: [
      "id", "name", "legacyItemKind", "activeInGeneration", "parameterKeys", "notes",
    ],
    rows: state.itemParts.map((entry) => [
      entry.id,
      entry.name,
      entry.legacyItemKind ?? "",
      entry.activeInGeneration,
      joinList(entry.parameterKeys),
      entry.notes,
    ]),
  });

  sheets.push({
    name: "重量模板",
    description: "templates：重量模板（结构标杆），values 以稳定 JSON 汇总。",
    header: [
      "id", "name", "fishMinKg", "fishMaxKg", "nominalFishKg",
      "tier", "templatePriority", "values", "notes",
    ],
    rows: state.templates.map((entry) => [
      entry.id,
      entry.name,
      entry.fishMinKg,
      entry.fishMaxKg,
      entry.nominalFishKg,
      entry.tier,
      entry.templatePriority ?? "",
      stableStringify(redactSensitive(entry.values)),
      entry.notes,
    ]),
  });

  sheets.push({
    name: "钓法档案",
    description: "methodProfiles：钓法规则层。",
    header: ["id", "name", "enabled", "sourceRevisionId", "ruleCount", "notes"],
    rows: state.methodProfiles.map((entry) => [
      entry.id,
      entry.name,
      entry.enabled,
      entry.sourceRevisionId ?? "",
      countRules(entry.rules),
      entry.notes,
    ]),
  });

  sheets.push({
    name: "类型档案",
    description: "itemTypeProfiles：类型规则层及其关联钓法/部位。",
    header: [
      "id", "name", "methodIds", "itemPartIds", "enabled",
      "sourceRevisionId", "ruleCount", "notes",
    ],
    rows: state.itemTypeProfiles.map((entry) => [
      entry.id,
      entry.name,
      joinList(entry.methodIds),
      joinList(entry.itemPartIds),
      entry.enabled,
      entry.sourceRevisionId ?? "",
      countRules(entry.rules),
      entry.notes,
    ]),
  });

  sheets.push({
    name: "功能档案",
    description: "functionProfiles：功能定位规则层及功能专精强度档位数。",
    header: ["id", "name", "enabled", "sourceRevisionId", "intensityRuleCount", "notes"],
    rows: state.functionProfiles.map((entry) => [
      entry.id,
      entry.name,
      entry.enabled,
      entry.sourceRevisionId ?? "",
      entry.intensityRules.length,
      entry.notes,
    ]),
  });

  sheets.push({
    name: "性能档案",
    description: "performanceProfiles：性能规则层（强度命名属开放决策，仅导出旧标签）。",
    header: ["id", "name", "legacyIntensityLabel", "enabled", "sourceRevisionId", "ruleCount", "notes"],
    rows: state.performanceProfiles.map((entry) => [
      entry.id,
      entry.name,
      entry.legacyIntensityLabel ?? "",
      entry.enabled,
      entry.sourceRevisionId ?? "",
      countRules(entry.rules),
      entry.notes,
    ]),
  });

  sheets.push({
    name: "品质档案",
    description: "qualityProfiles：品质 C/B/A/S 固定映射。",
    header: ["id", "letter", "colorName", "rank", "enabled", "ruleCount"],
    rows: state.qualityProfiles.map((entry) => [
      entry.id,
      entry.letter,
      entry.colorName,
      entry.rank,
      entry.enabled,
      countRules(entry.rules),
    ]),
  });

  sheets.push({
    name: "兼容规则",
    description: "compatibilityRules：硬允许/拒绝/要求规则；selector 与 requirements 以稳定 JSON 汇总。",
    header: [
      "id", "axis", "effect", "priority", "ruleSetVersion",
      "enabled", "reason", "selector", "requirements",
    ],
    rows: state.compatibilityRules.map((entry) => [
      entry.id,
      entry.axis,
      entry.effect,
      entry.priority,
      entry.ruleSetVersion,
      entry.enabled,
      entry.reason,
      stableStringify(redactSensitive(entry.selector)),
      stableStringify(redactSensitive(entry.requirements)),
    ]),
  });

  sheets.push({
    name: "亲和规则",
    description: "affinityRules：软 Affinity 评分规则；selector 以稳定 JSON 汇总。",
    header: ["id", "axis", "score", "priority", "ruleSetVersion", "enabled", "reason", "selector"],
    rows: state.affinityRules.map((entry) => [
      entry.id,
      entry.axis,
      entry.score,
      entry.priority,
      entry.ruleSetVersion,
      entry.enabled,
      entry.reason,
      stableStringify(redactSensitive(entry.selector)),
    ]),
  });

  sheets.push({
    name: "词条_V3",
    description: "v3Affixes：属性/被动词条库。",
    header: [
      "id", "version", "name", "category", "itemPartId", "generationPolicy",
      "rarity", "valueScore", "enabled", "tags", "attributeEffectIds",
    ],
    rows: state.v3Affixes.map((entry) => [
      entry.id,
      entry.version,
      entry.name,
      entry.category,
      entry.itemPartId,
      entry.generationPolicy,
      entry.rarity,
      entry.valueScore,
      entry.enabled,
      joinList(entry.tags),
      joinList(entry.attributeEffects.map((effect) => effect.id)),
    ]),
  });

  sheets.push({
    name: "技术",
    description: "technologies：词条组合包，核对不与成员词条重复。",
    header: [
      "id", "version", "name", "description", "affixIds",
      "generationPolicy", "valueScorePolicy", "minimumQualityId", "enabled",
    ],
    rows: state.technologies.map((entry) => [
      entry.id,
      entry.version,
      entry.name,
      entry.description,
      joinList(entry.affixIds),
      entry.generationPolicy,
      entry.valueScorePolicy,
      entry.minimumQualityId ?? "",
      entry.enabled,
    ]),
  });

  sheets.push({
    name: "合集",
    description: "collections：系列合集分组。",
    header: ["id", "name", "seriesIds", "createdAt", "updatedAt"],
    rows: state.collections.map((entry) => [
      entry.id,
      entry.name,
      joinList(entry.seriesIds),
      entry.createdAt,
      entry.updatedAt,
    ]),
  });

  sheets.push({
    name: "系列",
    description: "seriesDefinitions：系列定义与目标拉力规格（离散，不做插值）。",
    header: [
      "id", "collectionId", "revision", "name", "fishingMethodId", "typeId",
      "itemPartId", "qualityId", "coreFunctionId", "functionIntensityPolicy",
      "performanceProfileId", "coreAffixIds", "secondaryAffixPoolIds",
      "forbiddenAffixIds", "planningPullRange", "targetPullSpecCount",
      "patchIds", "status", "createdAt", "updatedAt",
    ],
    rows: state.seriesDefinitions.map((entry) => [
      entry.id,
      entry.collectionId ?? "",
      entry.revision,
      entry.name,
      entry.fishingMethodId,
      entry.typeId,
      entry.itemPartId ?? "",
      entry.qualityId,
      entry.coreFunctionId,
      stableStringify(redactSensitive(entry.functionIntensityPolicy)),
      entry.performanceProfileId ?? "",
      joinList(entry.coreAffixIds),
      joinList(entry.secondaryAffixPoolIds),
      joinList(entry.forbiddenAffixIds),
      stableStringify(redactSensitive(entry.planningPullRange)),
      entry.targetPullSpecifications.length,
      joinList(entry.patchIds),
      entry.status,
      entry.createdAt,
      entry.updatedAt,
    ]),
  });

  sheets.push({
    name: "SKU抽屉",
    description: "skuDrawers：离散目标拉力抽屉，含匹配投影与校验摘要计数。",
    header: [
      "id", "revision", "seriesId", "targetPullKg", "projectionId",
      "matchedStructuralPullKg", "pullDistance", "affinityScore",
      "pinnedByUser", "displayOrder", "defaultModelId", "modelCount",
      "patchIds", "validationIssueCount", "status", "createdAt", "updatedAt",
    ],
    rows: state.skuDrawers.map((entry) => [
      entry.id,
      entry.revision,
      entry.seriesId,
      entry.targetPullKg,
      entry.projectionMatch.projectionId,
      entry.projectionMatch.matchedStructuralPullKg,
      entry.projectionMatch.pullDistance,
      entry.projectionMatch.affinityScore,
      entry.projectionMatch.pinnedByUser,
      entry.displayOrder,
      entry.defaultModelId ?? "",
      entry.modelIds.length,
      joinList(entry.patchIds),
      entry.validationSummary.length,
      entry.status,
      entry.createdAt,
      entry.updatedAt,
    ]),
  });

  sheets.push({
    name: "可购买Model",
    description: "purchasableModels：实际选择/购买对象及其快照引用。",
    header: [
      "id", "revision", "skuId", "name", "modelVariantKey", "action",
      "hardness", "lengthM", "fishWeightGradeId", "componentSelectionCount",
      "technologyIds", "attributeAffixIds", "passiveAffixIds", "patchIds",
      "price", "configurationSnapshotId", "status", "createdAt", "updatedAt",
    ],
    rows: state.purchasableModels.map((entry) => [
      entry.id,
      entry.revision,
      entry.skuId,
      entry.name,
      entry.modelVariantKey ?? "",
      entry.action,
      entry.hardness,
      entry.lengthM,
      entry.fishWeightGradeId ?? "",
      entry.componentSelections.length,
      joinList(entry.technologyIds),
      joinList(entry.attributeAffixIds),
      joinList(entry.passiveAffixIds),
      joinList(entry.patchIds),
      entry.price,
      entry.configurationSnapshotId ?? "",
      entry.status,
      entry.createdAt,
      entry.updatedAt,
    ]),
  });

  sheets.push({
    name: "配置快照",
    description: "configurationSnapshots：已发布不可变快照摘要与完整性 hash。",
    header: [
      "id", "version", "modelId", "modelRevision", "skuRevision",
      "seriesRevision", "ruleSetVersion", "projectionId", "reductionStackingMode",
      "patchSetHash", "modelFinalPullKg", "pricingPolicyVersion",
      "technologyCount", "attributeAffixCount", "passiveAffixCount",
      "validationIssueCount", "publishedBy", "publishedAt", "contentHash",
    ],
    rows: state.configurationSnapshots.map((entry) => [
      entry.id,
      entry.version,
      entry.modelId,
      entry.modelRevision,
      entry.skuRevision,
      entry.seriesRevision,
      entry.ruleSetVersion,
      entry.projectionId,
      entry.reductionStackingMode ?? "",
      entry.patchSetHash,
      entry.modelFinalPullKg ?? "",
      entry.pricingPolicyVersion ?? "",
      entry.technologyIds.length,
      entry.attributeAffixIds.length,
      entry.passiveAffixIds.length,
      entry.validationReport.length,
      entry.publishedBy,
      entry.publishedAt,
      entry.contentHash,
    ]),
  });

  sheets.push({
    name: "派生投影摘要",
    description: "derivedProjections：派生结构投影摘要（深 trace 不展开），用于核对源 hash 与层引用。",
    header: [
      "id", "weightTemplateId", "methodId", "typeId", "functionId",
      "functionIntensity", "performanceId", "qualityId", "ruleSetVersion",
      "reductionStackingMode", "sourceHash", "valueKeys", "createdAt",
    ],
    rows: state.derivedProjections.map((entry) => [
      entry.id,
      entry.weightTemplateId,
      entry.methodId,
      entry.typeId,
      entry.functionId,
      entry.functionIntensity,
      entry.performanceId ?? "",
      entry.qualityId ?? "",
      entry.ruleSetVersion,
      entry.reductionStackingMode ?? "",
      entry.sourceHash,
      joinList(Object.keys(entry.values).sort()),
      entry.createdAt,
    ]),
  });

  sheets.push({
    name: "Patch台账摘要",
    description: "patchLedger.revisions：分层 Patch 台账摘要，用于排查手工修改与基线偏移。",
    header: [
      "patchId", "patchRevision", "scopeType", "layerType", "subjectEntityId",
      "subjectName", "parentEntityId", "baseRuleSetVersion", "baseObjectRevision",
      "state", "mirrorSyncState", "attentionStates", "reason", "createdBy",
      "createdAt", "reviewedBy", "reviewedAt", "operationCount", "revisionHash",
    ],
    rows: state.patchLedger.revisions.map((entry) => [
      entry.patchId,
      entry.patchRevision,
      entry.scopeType,
      entry.layerType,
      entry.subjectEntityId,
      entry.subjectName,
      entry.parentEntityId ?? "",
      entry.baseRuleSetVersion,
      entry.baseObjectRevision,
      entry.state,
      entry.mirrorSyncState,
      joinList(entry.attentionStates),
      entry.reason,
      entry.createdBy,
      entry.createdAt,
      entry.reviewedBy ?? "",
      entry.reviewedAt ?? "",
      entry.operations.length,
      entry.revisionHash,
    ]),
  });

  sheets.push({
    name: "定价策略草稿",
    description: "pricingPolicyDrafts：版本化定价草稿状态与输入 hash。",
    header: [
      "id", "sourceRevisionId", "sourceRevision", "pricingSheetId",
      "qualitySheetId", "typeMaterialSheetId", "formalStatus",
      "issueCount", "inputHash", "importedAt",
    ],
    rows: state.pricingPolicyDrafts.map((entry) => [
      entry.id,
      entry.sourceRevisionId,
      entry.sourceRevision,
      entry.pricingSheetId,
      entry.qualitySheetId ?? "",
      entry.typeMaterialSheetId,
      entry.formalStatus,
      entry.issues.length,
      entry.inputHash,
      entry.importedAt,
    ]),
  });

  sheets.push({
    name: "定价策略版本",
    description: "pricingPolicyVersions：已发布定价策略版本。",
    header: [
      "id", "version", "sourceRevisionId", "sourceRevision",
      "pricingSheetId", "typeMaterialSheetId", "publishedAt", "publishedBy",
      "inputHash", "importedAt",
    ],
    rows: state.pricingPolicyVersions.map((entry) => [
      entry.id,
      entry.version,
      entry.sourceRevisionId,
      entry.sourceRevision,
      entry.pricingSheetId,
      entry.typeMaterialSheetId,
      entry.publishedAt,
      entry.publishedBy,
      entry.inputHash,
      entry.importedAt,
    ]),
  });

  sheets.push({
    name: "品质价值策略草稿",
    description: "qualityValuePolicyDrafts：品质评分策略草稿状态。",
    header: [
      "id", "sourceRevisionId", "sourceRevision", "qualitySheetId",
      "affixSheetId", "rangeCount", "combinationRuleCount",
      "legacyPerformanceScoringEnabled", "formalStatus", "issueCount",
      "inputHash", "importedAt",
    ],
    rows: state.qualityValuePolicyDrafts.map((entry) => [
      entry.id,
      entry.sourceRevisionId,
      entry.sourceRevision,
      entry.qualitySheetId,
      entry.affixSheetId,
      entry.ranges.length,
      entry.combinationRules.length,
      entry.legacyPerformanceScoringEvidence?.enabled ?? "",
      entry.formalStatus,
      entry.issues.length,
      entry.inputHash,
      entry.importedAt,
    ]),
  });

  sheets.push({
    name: "五轴视图定义",
    description: "fiveAxisViewDefinitions：五轴视图定义的发布状态与定义 hash。",
    header: [
      "definitionId", "version", "revision", "publicationState",
      "definitionHash", "fiveAxisRuleVersion", "sourceRevision", "axisCount",
    ],
    rows: state.fiveAxisViewDefinitions.map((entry) => [
      entry.definitionId,
      entry.version,
      entry.revision,
      entry.publicationState,
      entry.definitionHash,
      entry.fiveAxisRuleVersion,
      entry.sourceRevision,
      entry.axes.length,
    ]),
  });

  sheets.push({
    name: "修订历史",
    description: "revisions：工作区 revision 历史（最近 100 条）。",
    header: ["revision", "author", "message", "createdAt"],
    rows: state.revisions.map((entry) => [
      entry.revision,
      entry.author,
      entry.message,
      entry.createdAt,
    ]),
  });

  sheets.push({
    name: "治理审计",
    description: "governanceAuditLog：发布/审批等治理动作审计。",
    header: ["id", "action", "entityType", "entityId", "actor", "occurredAt"],
    rows: state.governanceAuditLog.map((entry) => [
      entry.id,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.actor,
      entry.occurredAt,
    ]),
  });

  return sheets;
}

/** 组装导出说明 sheet，放在所有数据 sheet 之前，文档化每个 sheet 的含义。 */
function buildManifestSpec(sheets: WorkspaceSheetSpec[]): WorkspaceSheetSpec {
  return {
    name: "导出说明",
    description: "本 sheet 说明每个数据 sheet 的含义与记录数。",
    header: ["sheet名", "含义", "记录数"],
    rows: sheets.map((sheet) => [sheet.name, sheet.description, sheet.rows.length]),
  };
}

/** 构建导出工作簿（不含系统时钟、不含随机元数据），列顺序与 sheet 顺序固定。 */
export function buildWorkspaceExportWorkbook(input: WorkspaceExportInput): XLSX.WorkBook {
  const dataSheets = buildWorkspaceSheetSpecs(input);
  const manifest = buildManifestSpec(dataSheets);
  const workbook = XLSX.utils.book_new();
  // 不设置 Props 时钟字段，保证二进制可复现。
  const ordered = [manifest, ...dataSheets];
  for (const spec of ordered) {
    const worksheet = XLSX.utils.aoa_to_sheet([spec.header, ...spec.rows]);
    XLSX.utils.book_append_sheet(workbook, worksheet, spec.name);
  }
  return workbook;
}

/** 序列化为 xlsx ArrayBuffer。相同输入产生相同输出。 */
export function serializeWorkspaceExport(input: WorkspaceExportInput): ArrayBuffer {
  const workbook = buildWorkspaceExportWorkbook(input);
  return XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
    compression: true,
  }) as ArrayBuffer;
}

/** 生成确定性下载文件名（仅依赖 revision，不含时间戳）。 */
export function workspaceExportFilename(input: WorkspaceExportInput): string {
  return `工作区数据导出_r${input.revision}.xlsx`;
}
