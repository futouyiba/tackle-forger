import {
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const roleEnum = pgEnum("role", ["ADMIN", "EDITOR", "VIEWER"]);
export const scopeEnum = pgEnum("equipment_scope", ["ROD", "REEL", "LINE", "SHARED"]);
export const valueTypeEnum = pgEnum("parameter_value_type", ["DECIMAL", "INTEGER", "TEXT", "BOOLEAN", "ENUM"]);
export const ruleOperationEnum = pgEnum("rule_operation", ["ADD", "MULTIPLY", "SET"]);
export const operandModeEnum = pgEnum("operand_mode", ["CONSTANT", "FORMULA"]);
export const affixKindEnum = pgEnum("affix_kind", ["ATTRIBUTE", "PASSIVE"]);
export const affixSourceEnum = pgEnum("affix_source", ["SERIES", "SKU", "GENERATED", "MANUAL"]);
export const qualityAggregationEnum = pgEnum("quality_aggregation", ["SUM", "DIMINISHING_RETURNS"]);

const auditColumns = {
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const organizations = pgTable("organization", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ...auditColumns,
});

export const users = pgTable("app_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull().default("VIEWER"),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
}, (table) => [uniqueIndex("app_user_org_email_uq").on(table.organizationId, table.email)]);

export const parameterDefinitions = pgTable("parameter_definition", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  key: text("key").notNull(),
  displayName: text("display_name").notNull(),
  scope: scopeEnum("scope").notNull(),
  valueType: valueTypeEnum("value_type").notNull(),
  unit: text("unit"),
  category: text("category").notNull(),
  precision: integer("precision"),
  minimum: numeric("minimum"),
  maximum: numeric("maximum"),
  enumOptions: jsonb("enum_options").$type<string[]>(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
}, (table) => [uniqueIndex("parameter_org_key_uq").on(table.organizationId, table.key)]);

export const weightTemplates = pgTable("weight_template", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  fishingMethod: text("fishing_method").notNull(),
  weightBand: text("weight_band").notNull(),
  nominalWeight: numeric("nominal_weight").notNull(),
  coverageMin: numeric("coverage_min").notNull(),
  coverageMax: numeric("coverage_max").notNull(),
  notes: text("notes").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
}, (table) => [
  uniqueIndex("weight_template_org_key_uq").on(table.organizationId, table.key),
  check("weight_template_range_ck", sql`${table.coverageMin} <= ${table.nominalWeight} and ${table.nominalWeight} <= ${table.coverageMax}`),
]);

export const weightTemplateValues = pgTable("weight_template_value", {
  templateId: uuid("template_id").notNull().references(() => weightTemplates.id, { onDelete: "cascade" }),
  parameterId: uuid("parameter_id").notNull().references(() => parameterDefinitions.id),
  decimalValue: numeric("decimal_value"),
  textValue: text("text_value"),
  booleanValue: boolean("boolean_value"),
}, (table) => [primaryKey({ columns: [table.templateId, table.parameterId] })]);

export const dimensionCatalogs = pgTable("dimension_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  notes: text("notes").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
}, (table) => [uniqueIndex("dimension_catalog_org_key_uq").on(table.organizationId, table.key)]);

export const dimensionOptions = pgTable("dimension_option", {
  id: uuid("id").primaryKey().defaultRandom(),
  catalogId: uuid("catalog_id").notNull().references(() => dimensionCatalogs.id, { onDelete: "cascade" }),
  parentOptionId: uuid("parent_option_id"),
  key: text("key").notNull(),
  name: text("name").notNull(),
  level: integer("level"),
  scope: text("scope").notNull(),
  notes: text("notes").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  ...auditColumns,
}, (table) => [uniqueIndex("dimension_option_catalog_key_uq").on(table.catalogId, table.key)]);

export const calculationLayers = pgTable("calculation_layer", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  layerOrder: integer("layer_order").notNull(),
  version: integer("version").notNull().default(1),
  notes: text("notes").notNull().default(""),
  isEnabled: boolean("is_enabled").notNull().default(true),
  ...auditColumns,
}, (table) => [uniqueIndex("calculation_layer_org_key_version_uq").on(table.organizationId, table.key, table.version)]);

export const modifierRules = pgTable("modifier_rule", {
  id: uuid("id").primaryKey().defaultRandom(),
  layerId: uuid("layer_id").notNull().references(() => calculationLayers.id, { onDelete: "cascade" }),
  optionId: uuid("option_id").notNull().references(() => dimensionOptions.id, { onDelete: "cascade" }),
  parameterId: uuid("parameter_id").notNull().references(() => parameterDefinitions.id),
  operation: ruleOperationEnum("operation").notNull(),
  operandMode: operandModeEnum("operand_mode").notNull(),
  decimalOperand: numeric("decimal_operand"),
  formulaSource: text("formula_source"),
  formulaAst: jsonb("formula_ast"),
  conditionSource: text("condition_source"),
  conditionAst: jsonb("condition_ast"),
  priority: integer("priority").notNull().default(0),
  precision: integer("precision"),
  notes: text("notes").notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
});

export const affixDefinitions = pgTable("affix_definition", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  kind: affixKindEnum("kind").notNull(),
  score: numeric("score").notNull(),
  description: text("description").notNull(),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
}, (table) => [uniqueIndex("affix_definition_org_key_uq").on(table.organizationId, table.key)]);

export const affixRules = pgTable("affix_rule", {
  affixId: uuid("affix_id").notNull().references(() => affixDefinitions.id, { onDelete: "cascade" }),
  ruleId: uuid("rule_id").notNull().references(() => modifierRules.id, { onDelete: "cascade" }),
}, (table) => [primaryKey({ columns: [table.affixId, table.ruleId] })]);

export const qualityRubrics = pgTable("quality_rubric", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  version: integer("version").notNull(),
  aggregation: qualityAggregationEnum("aggregation").notNull(),
  diminishingFactor: numeric("diminishing_factor"),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
});

export const qualityTiers = pgTable("quality_tier", {
  id: uuid("id").primaryKey().defaultRandom(),
  rubricId: uuid("rubric_id").notNull().references(() => qualityRubrics.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  name: text("name").notNull(),
  minimumScore: numeric("minimum_score").notNull(),
  maximumScore: numeric("maximum_score"),
  color: text("color").notNull(),
}, (table) => [uniqueIndex("quality_tier_rubric_key_uq").on(table.rubricId, table.key)]);

export const combinationSkus = pgTable("combination_sku", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  comboCode: text("combo_code").notNull(),
  platformId: text("platform_id").notNull(),
  platformPositioning: text("platform_positioning").notNull(),
  templateId: uuid("template_id").notNull().references(() => weightTemplates.id),
  targetWeightMin: numeric("target_weight_min").notNull(),
  targetWeightMax: numeric("target_weight_max").notNull(),
  seriesName: text("series_name").notNull(),
  usageScenario: text("usage_scenario").notNull().default(""),
  status: text("status").notNull().default("DRAFT"),
  calculatedQualityScore: numeric("calculated_quality_score"),
  calculatedQualityTierId: uuid("calculated_quality_tier_id").references(() => qualityTiers.id),
  qualityOverrideTierId: uuid("quality_override_tier_id").references(() => qualityTiers.id),
  qualityOverrideReason: text("quality_override_reason"),
  calculationVersion: integer("calculation_version").notNull().default(1),
  inputHash: text("input_hash"),
  ...auditColumns,
}, (table) => [
  uniqueIndex("combination_sku_org_code_uq").on(table.organizationId, table.comboCode),
  check("combination_sku_range_ck", sql`${table.targetWeightMin} <= ${table.targetWeightMax}`),
]);

export const skuOptionSelections = pgTable("sku_option_selection", {
  skuId: uuid("sku_id").notNull().references(() => combinationSkus.id, { onDelete: "cascade" }),
  optionId: uuid("option_id").notNull().references(() => dimensionOptions.id),
  selectionOrder: integer("selection_order").notNull().default(0),
}, (table) => [primaryKey({ columns: [table.skuId, table.optionId] })]);

export const skuAffixSelections = pgTable("sku_affix_selection", {
  skuId: uuid("sku_id").notNull().references(() => combinationSkus.id, { onDelete: "cascade" }),
  affixId: uuid("affix_id").notNull().references(() => affixDefinitions.id),
  source: affixSourceEnum("source").notNull(),
  scoreOverride: numeric("score_override"),
}, (table) => [primaryKey({ columns: [table.skuId, table.affixId] })]);

export const skuComputedValues = pgTable("sku_computed_value", {
  skuId: uuid("sku_id").notNull().references(() => combinationSkus.id, { onDelete: "cascade" }),
  parameterId: uuid("parameter_id").notNull().references(() => parameterDefinitions.id),
  decimalValue: numeric("decimal_value"),
  textValue: text("text_value"),
  booleanValue: boolean("boolean_value"),
  trace: jsonb("trace").notNull(),
  calculationVersion: integer("calculation_version").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.skuId, table.parameterId] })]);

export const skuOverrides = pgTable("sku_override", {
  skuId: uuid("sku_id").notNull().references(() => combinationSkus.id, { onDelete: "cascade" }),
  parameterId: uuid("parameter_id").notNull().references(() => parameterDefinitions.id),
  decimalValue: numeric("decimal_value"),
  textValue: text("text_value"),
  booleanValue: boolean("boolean_value"),
  reason: text("reason").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.skuId, table.parameterId] })]);

export const componentDetails = pgTable("component_detail", {
  id: uuid("id").primaryKey().defaultRandom(),
  skuId: uuid("sku_id").notNull().references(() => combinationSkus.id, { onDelete: "cascade" }),
  scope: scopeEnum("scope").notNull(),
  componentCode: text("component_code").notNull(),
  generatedModel: text("generated_model").notNull().default(""),
  modelOverride: text("model_override"),
  generatedName: text("generated_name").notNull().default(""),
  nameOverride: text("name_override"),
  generationRevision: integer("generation_revision").notNull().default(1),
  ...auditColumns,
}, (table) => [
  uniqueIndex("component_detail_sku_scope_uq").on(table.skuId, table.scope),
  uniqueIndex("component_detail_code_uq").on(table.componentCode),
]);

export const changeSets = pgTable("change_set", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  reason: text("reason").notNull().default(""),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const changeItems = pgTable("change_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  changeSetId: uuid("change_set_id").notNull().references(() => changeSets.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
});

export const reviewAdjustments = pgTable("review_adjustment", {
  id: uuid("id").primaryKey().defaultRandom(),
  skuId: uuid("sku_id").notNull().references(() => combinationSkus.id, { onDelete: "cascade" }),
  parameterId: uuid("parameter_id").notNull().references(() => parameterDefinitions.id),
  reviewerId: uuid("reviewer_id").notNull().references(() => users.id),
  beforeValue: jsonb("before_value").notNull(),
  afterValue: jsonb("after_value").notNull(),
  reason: text("reason").notNull(),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
