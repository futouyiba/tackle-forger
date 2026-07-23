import {
  AIOutboundError,
  AI_PROVIDER_POLICY_VERSION,
  type AIModelDescriptorV1,
  type AIRequestEnvelopeV1,
  describeFancyHubModels,
  jcsCanonicalize,
  prepareAIRequest,
  sameModelDescriptor,
  sha256Hex,
  type RequestAlias,
} from "./ai-outbound";

export const AI_BATCH_LIMIT_POLICY_VERSION = "ai-batch-limits/open009-v1" as const;

export interface AIBatchLimitPolicyV1 {
  policyVersion: typeof AI_BATCH_LIMIT_POLICY_VERSION;
  maxAssessmentsPerBatch: number;
  maxConcurrentAssessmentsPerWorkspace: number;
  softConcurrentAssessmentsPerUser: number;
  softConcurrentAssessmentsPerWorkspace: number;
  softPerAssessmentWarningMs: number;
  batchHardTimeoutMs: number;
  maxEstimatedInputTokensPerBatch: number;
  maxEstimatedOutputTokensPerBatch: number;
  maxEstimatedCostMicroUsdPerBatch: number;
}

export const OPEN009_AI_BATCH_LIMITS: Readonly<AIBatchLimitPolicyV1> = Object.freeze({
  policyVersion: AI_BATCH_LIMIT_POLICY_VERSION,
  maxAssessmentsPerBatch: 20,
  maxConcurrentAssessmentsPerWorkspace: 8,
  softConcurrentAssessmentsPerUser: 1,
  softConcurrentAssessmentsPerWorkspace: 4,
  softPerAssessmentWarningMs: 60_000,
  batchHardTimeoutMs: 600_000,
  maxEstimatedInputTokensPerBatch: 200_000,
  maxEstimatedOutputTokensPerBatch: 40_000,
  maxEstimatedCostMicroUsdPerBatch: 1_000_000,
});

export interface AIProviderHardLimits {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxConcurrentRequests: number;
  maxRequestsPerMinute: number;
  requestTimeoutMs: number;
  maxCostMicroUsdPerRequest: number;
}

export interface FancyHubConnectorConfig {
  enabled: boolean;
  policyVersion: typeof AI_PROVIDER_POLICY_VERSION;
  baseUrl?: string;
  apiToken?: string;
  primaryModelId?: string;
  fallbackModelIds: string[];
  tenantHardLimits?: AIProviderHardLimits;
  batchLimits?: AIBatchLimitPolicyV1;
  assessmentEstimatePolicy?: AIAssessmentEstimatePolicyV1;
}

export interface AIAssessmentEstimatePolicyV1 {
  maxOutputTokens: number;
  maxInputCostMicroUsdPer1KTokens: number;
  maxOutputCostMicroUsdPer1KTokens: number;
}

export type FancyHubErrorCode =
  | "AI_BATCH_LIMIT_POLICY_MISSING_OR_INVALID"
  | "AI_CONNECTOR_DISABLED"
  | "AI_FANCY_HUB_RESPONSE_INVALID"
  | "AI_HARD_LIMIT_EXCEEDED"
  | "AI_HARD_LIMIT_POLICY_MISSING"
  | "AI_MODEL_LIST_UNAVAILABLE"
  | "AI_MODEL_REVISION_MISMATCH"
  | "AI_NO_CONFIGURED_MODEL_AVAILABLE"
  | "AI_OUTBOUND_TARGET_REJECTED"
  | "AI_RESPONSE_ALIAS_UNKNOWN"
  | "AI_RUNTIME_COORDINATOR_UNAVAILABLE"
  | "AI_PROVIDER_TEMPORARILY_UNAVAILABLE";

export class FancyHubError extends Error {
  constructor(public readonly code: FancyHubErrorCode, message: string, public readonly retryable = false) {
    super(message);
    this.name = "FancyHubError";
  }
}

interface FancyHubModelListResponse {
  models: unknown[];
  hardLimits: AIProviderHardLimits;
}

export interface FancyHubFindingV1 {
  findingCode: string;
  summary: string;
  subjectAliases: RequestAlias[];
  evidenceAliases: RequestAlias[];
}

export interface FancyHubRecommendationV1 {
  recommendationCode: string;
  title: string;
  summary: string;
  subjectAliases: RequestAlias[];
  evidenceAliases: RequestAlias[];
  suggestedAction: "preview_only" | "create_model_patch_draft" | "create_rule_source_change_draft";
}

export interface FancyHubAssessmentResultV1 {
  schemaVersion: "ai-response/v1";
  assessmentAlias: RequestAlias;
  findings: FancyHubFindingV1[];
  recommendations: FancyHubRecommendationV1[];
  assumptions: string[];
  uncoveredInformation: string[];
}

export interface FancyHubAssessmentResponse {
  model: AIModelDescriptorV1;
  result: FancyHubAssessmentResultV1;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costMicroUsd: number;
  };
  outputHash: string;
}

export interface FancyHubTransport {
  listModels(input: { timeoutMs: number }): Promise<unknown>;
  assess(input: {
    canonicalJson: string;
    inputHash: string;
    model: AIModelDescriptorV1;
    maxOutputTokens: number;
    timeoutMs: number;
  }): Promise<unknown>;
}

export interface FancyHubAuditEvent {
  action: "AI_FANCY_HUB_ASSESSMENT";
  workspaceId: string;
  requestedAt: string;
  completedAt: string;
  durationMs: number;
  resultCode: string;
  attemptedModelIds: string[];
  modelDescriptor?: AIModelDescriptorV1;
  inputHash?: string;
  usage?: FancyHubAssessmentResponse["usage"];
  outputHash?: string;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], label: string): void {
  const keys = Object.keys(value).sort();
  const expected = [...required].sort();
  if (jcsCanonicalize(keys) !== jcsCanonicalize(expected)) {
    throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", `${label} 字段不符合连接器契约。`);
  }
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && Number.isSafeInteger(value);
}

function parseHardLimits(value: unknown, label: string): AIProviderHardLimits {
  if (!plainObject(value)) throw new FancyHubError("AI_HARD_LIMIT_POLICY_MISSING", `${label} 缺失。`);
  exactKeys(value, ["maxInputTokens", "maxOutputTokens", "maxConcurrentRequests", "maxRequestsPerMinute", "requestTimeoutMs", "maxCostMicroUsdPerRequest"], label);
  for (const key of Object.keys(value) as Array<keyof AIProviderHardLimits>) {
    if (!positiveInteger(value[key])) throw new FancyHubError("AI_HARD_LIMIT_POLICY_MISSING", `${label}.${key} 必须是正整数。`);
  }
  return value as unknown as AIProviderHardLimits;
}

function parseAssessmentEstimatePolicy(value: unknown): AIAssessmentEstimatePolicyV1 {
  if (!plainObject(value)) {
    throw new FancyHubError("AI_HARD_LIMIT_POLICY_MISSING", "AI 评估 token 与费用估算策略缺失。");
  }
  exactKeys(value, [
    "maxOutputTokens",
    "maxInputCostMicroUsdPer1KTokens",
    "maxOutputCostMicroUsdPer1KTokens",
  ], "assessmentEstimatePolicy");
  for (const key of Object.keys(value) as Array<keyof AIAssessmentEstimatePolicyV1>) {
    if (!positiveInteger(value[key])) {
      throw new FancyHubError("AI_HARD_LIMIT_POLICY_MISSING", `assessmentEstimatePolicy.${key} 必须是正整数。`);
    }
  }
  return value as unknown as AIAssessmentEstimatePolicyV1;
}

export function validateBatchLimitPolicy(value: unknown): AIBatchLimitPolicyV1 {
  if (!plainObject(value)) throw new FancyHubError("AI_BATCH_LIMIT_POLICY_MISSING_OR_INVALID", "批量 AI 限额策略缺失。" );
  const keys = Object.keys(OPEN009_AI_BATCH_LIMITS) as Array<keyof AIBatchLimitPolicyV1>;
  exactKeys(value, keys, "ai-batch-limits");
  if (value.policyVersion !== AI_BATCH_LIMIT_POLICY_VERSION) throw new FancyHubError("AI_BATCH_LIMIT_POLICY_MISSING_OR_INVALID", "批量 AI 限额策略版本不受支持。" );
  for (const key of keys.filter((entry) => entry !== "policyVersion")) {
    if (!positiveInteger(value[key])) throw new FancyHubError("AI_BATCH_LIMIT_POLICY_MISSING_OR_INVALID", `${key} 必须是正整数。`);
    if (value[key] !== OPEN009_AI_BATCH_LIMITS[key]) throw new FancyHubError("AI_BATCH_LIMIT_POLICY_MISSING_OR_INVALID", `${key} 与 ${AI_BATCH_LIMIT_POLICY_VERSION} 冻结值不一致。`);
  }
  return value as unknown as AIBatchLimitPolicyV1;
}

function assertConfiguredTarget(config: FancyHubConnectorConfig): URL {
  if (!config.baseUrl || !config.apiToken || !config.primaryModelId) {
    throw new FancyHubError("AI_CONNECTOR_DISABLED", "Fancy Hub 连接器尚未完成独立部署配置。" );
  }
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { throw new FancyHubError("AI_OUTBOUND_TARGET_REJECTED", "Fancy Hub 地址无效。" ); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new FancyHubError("AI_OUTBOUND_TARGET_REJECTED", "Fancy Hub 只允许无凭据、query 和 fragment 的 HTTPS 地址。" );
  }
  if (url.pathname !== "/" && !url.pathname.endsWith("/")) url.pathname += "/";
  const modelIds = [config.primaryModelId, ...config.fallbackModelIds];
  if (modelIds.some((entry) => !entry || !/^[A-Za-z0-9_.:-]{1,128}$/.test(entry)) || new Set(modelIds).size !== modelIds.length) {
    throw new FancyHubError("AI_CONNECTOR_DISABLED", "主模型与有序降级列表必须是唯一 SafeCode。" );
  }
  return url;
}

export function fancyHubEnablement(config: FancyHubConnectorConfig): { enabled: boolean; code?: FancyHubErrorCode } {
  if (!config.enabled) return { enabled: false, code: "AI_CONNECTOR_DISABLED" };
  if (config.policyVersion !== AI_PROVIDER_POLICY_VERSION) return { enabled: false, code: "AI_CONNECTOR_DISABLED" };
  try {
    assertConfiguredTarget(config);
    parseHardLimits(config.tenantHardLimits, "tenantHardLimits");
    validateBatchLimitPolicy(config.batchLimits);
    parseAssessmentEstimatePolicy(config.assessmentEstimatePolicy);
    return { enabled: true };
  } catch (error) {
    return { enabled: false, code: error instanceof FancyHubError ? error.code : "AI_CONNECTOR_DISABLED" };
  }
}

export class FetchFancyHubTransport implements FancyHubTransport {
  private readonly root: URL;
  constructor(
    baseUrl: string,
    private readonly apiToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.root = new URL(baseUrl);
    if (this.root.protocol !== "https:" || this.root.username || this.root.password || this.root.search || this.root.hash) {
      throw new FancyHubError("AI_OUTBOUND_TARGET_REJECTED", "Fancy Hub transport 目标不安全。" );
    }
  }

  private url(path: "v1/models" | "v1/assessments"): URL {
    const target = new URL(path, this.root.pathname.endsWith("/") ? this.root : new URL(`${this.root.toString()}/`));
    if (target.origin !== this.root.origin) throw new FancyHubError("AI_OUTBOUND_TARGET_REJECTED", "Fancy Hub 请求试图离开配置 origin。" );
    return target;
  }

  private async request(path: "v1/models" | "v1/assessments", init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      headers.set("authorization", `Bearer ${this.apiToken}`);
      if (init.body) headers.set("content-type", "application/json");
      response = await this.fetchImpl(this.url(path), {
        ...init,
        redirect: "error",
        headers,
      });
    } catch {
      throw new FancyHubError("AI_PROVIDER_TEMPORARILY_UNAVAILABLE", "Fancy Hub 网络请求失败。", true);
    }
    if (!response.ok) {
      throw new FancyHubError(
        response.status === 429 || response.status >= 500 ? "AI_PROVIDER_TEMPORARILY_UNAVAILABLE" : "AI_FANCY_HUB_RESPONSE_INVALID",
        `Fancy Hub 返回 HTTP ${response.status}。`,
        response.status === 429 || response.status >= 500,
      );
    }
    try { return await response.json(); } catch { throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", "Fancy Hub 返回的 JSON 无效。" ); }
  }

  listModels(input: { timeoutMs: number }): Promise<unknown> {
    return this.request("v1/models", { method: "GET", signal: AbortSignal.timeout(input.timeoutMs) });
  }

  assess(input: { canonicalJson: string; inputHash: string; model: AIModelDescriptorV1; maxOutputTokens: number; timeoutMs: number }): Promise<unknown> {
    return this.request("v1/assessments", {
      method: "POST",
      signal: AbortSignal.timeout(input.timeoutMs),
      headers: {
        "x-fancy-hub-input-hash": input.inputHash,
        "x-fancy-hub-max-output-tokens": String(input.maxOutputTokens),
        "x-fancy-hub-timeout-ms": String(input.timeoutMs),
      },
      body: input.canonicalJson,
    });
  }
}

function parseModelListResponse(value: unknown): FancyHubModelListResponse {
  if (!plainObject(value)) throw new FancyHubError("AI_MODEL_LIST_UNAVAILABLE", "Fancy Hub 模型列表响应无效。" );
  exactKeys(value, ["models", "hardLimits"], "model list response");
  if (!Array.isArray(value.models)) throw new FancyHubError("AI_MODEL_LIST_UNAVAILABLE", "Fancy Hub models 必须是数组。" );
  return { models: value.models, hardLimits: parseHardLimits(value.hardLimits, "providerHardLimits") };
}

const RESPONSE_ALIAS = /^[a-z][0-9]{3,7}$/;
const RESPONSE_SAFE_CODE = /^[A-Za-z0-9_.:-]{1,128}$/;
const RESPONSE_MAX_BYTES = 131_072;

function responseString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", `${label} 必须是 ${maxBytes} 字节以内的字符串。`);
  }
  // JCS performs the canonical Unicode validation used by the outbound contract.
  jcsCanonicalize(value);
  return value;
}

function responseCode(value: unknown, label: string): string {
  const code = responseString(value, label, 128);
  if (!RESPONSE_SAFE_CODE.test(code)) throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", `${label} 不是 SafeCode。`);
  return code;
}

function responseAlias(value: unknown, label: string, authorizedAliases: ReadonlySet<string>): RequestAlias {
  const alias = responseString(value, label, 16);
  if (!RESPONSE_ALIAS.test(alias)) throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", `${label} 不是请求级别名。`);
  if (!authorizedAliases.has(alias)) throw new FancyHubError("AI_RESPONSE_ALIAS_UNKNOWN", `${label} 不属于本次请求。`);
  return alias;
}

function responseAliasArray(value: unknown, label: string, authorizedAliases: ReadonlySet<string>): RequestAlias[] {
  if (!Array.isArray(value) || value.length > 32) throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", `${label} 必须是最多 32 项的数组。`);
  const aliases = value.map((entry, index) => responseAlias(entry, `${label}[${index}]`, authorizedAliases));
  if (new Set(aliases).size !== aliases.length) throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", `${label} 不能包含重复别名。`);
  return aliases;
}

function responseTextArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", `${label} 必须是最多 32 项的数组。`);
  return value.map((entry, index) => responseString(entry, `${label}[${index}]`, 1_024));
}

function parseAssessmentResult(value: unknown, authorizedAliases: ReadonlySet<string>): FancyHubAssessmentResultV1 {
  if (!plainObject(value)) throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", "Fancy Hub result 无效。" );
  exactKeys(value, ["schemaVersion", "assessmentAlias", "findings", "recommendations", "assumptions", "uncoveredInformation"], "assessment result");
  if (value.schemaVersion !== "ai-response/v1") throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", "Fancy Hub result Schema 版本无效。" );
  if (!Array.isArray(value.findings) || value.findings.length > 128) throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", "findings 必须是最多 128 项的数组。" );
  if (!Array.isArray(value.recommendations) || value.recommendations.length > 64) throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", "recommendations 必须是最多 64 项的数组。" );
  const findings = value.findings.map((entry, index): FancyHubFindingV1 => {
    if (!plainObject(entry)) throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", `findings[${index}] 无效。`);
    exactKeys(entry, ["findingCode", "summary", "subjectAliases", "evidenceAliases"], `findings[${index}]`);
    return {
      findingCode: responseCode(entry.findingCode, `findings[${index}].findingCode`),
      summary: responseString(entry.summary, `findings[${index}].summary`, 4_096),
      subjectAliases: responseAliasArray(entry.subjectAliases, `findings[${index}].subjectAliases`, authorizedAliases),
      evidenceAliases: responseAliasArray(entry.evidenceAliases, `findings[${index}].evidenceAliases`, authorizedAliases),
    };
  });
  const recommendations = value.recommendations.map((entry, index): FancyHubRecommendationV1 => {
    if (!plainObject(entry)) throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", `recommendations[${index}] 无效。`);
    exactKeys(entry, ["recommendationCode", "title", "summary", "subjectAliases", "evidenceAliases", "suggestedAction"], `recommendations[${index}]`);
    if (!["preview_only", "create_model_patch_draft", "create_rule_source_change_draft"].includes(String(entry.suggestedAction))) {
      throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", `recommendations[${index}].suggestedAction 无效。`);
    }
    return {
      recommendationCode: responseCode(entry.recommendationCode, `recommendations[${index}].recommendationCode`),
      title: responseString(entry.title, `recommendations[${index}].title`, 512),
      summary: responseString(entry.summary, `recommendations[${index}].summary`, 4_096),
      subjectAliases: responseAliasArray(entry.subjectAliases, `recommendations[${index}].subjectAliases`, authorizedAliases),
      evidenceAliases: responseAliasArray(entry.evidenceAliases, `recommendations[${index}].evidenceAliases`, authorizedAliases),
      suggestedAction: entry.suggestedAction as FancyHubRecommendationV1["suggestedAction"],
    };
  });
  const result: FancyHubAssessmentResultV1 = {
    schemaVersion: "ai-response/v1",
    assessmentAlias: responseAlias(value.assessmentAlias, "assessmentAlias", authorizedAliases),
    findings,
    recommendations,
    assumptions: responseTextArray(value.assumptions, "assumptions"),
    uncoveredInformation: responseTextArray(value.uncoveredInformation, "uncoveredInformation"),
  };
  if (Buffer.byteLength(jcsCanonicalize(result), "utf8") > RESPONSE_MAX_BYTES) {
    throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", `Fancy Hub result 超过 ${RESPONSE_MAX_BYTES} 字节。`);
  }
  return result;
}

function parseAssessmentResponse(value: unknown, authorizedAliases: ReadonlySet<string>): FancyHubAssessmentResponse {
  if (!plainObject(value)) throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", "Fancy Hub 评估响应无效。" );
  exactKeys(value, ["model", "result", "usage"], "assessment response");
  if (!plainObject(value.usage)) throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", "Fancy Hub usage 无效。" );
  exactKeys(value.usage, ["inputTokens", "outputTokens", "costMicroUsd"], "assessment usage");
  for (const key of ["inputTokens", "outputTokens", "costMicroUsd"] as const) {
    if (!Number.isInteger(value.usage[key]) || (value.usage[key] as number) < 0) throw new FancyHubError("AI_FANCY_HUB_RESPONSE_INVALID", `usage.${key} 无效。`);
  }
  const result = parseAssessmentResult(value.result, authorizedAliases);
  const model = value.model as AIModelDescriptorV1;
  return {
    model,
    result,
    usage: value.usage as FancyHubAssessmentResponse["usage"],
    outputHash: sha256Hex(jcsCanonicalize({ model, result })),
  };
}

function authorizedResponseAliases(envelope: AIRequestEnvelopeV1): ReadonlySet<string> {
  return new Set([
    envelope.assessmentAlias,
    envelope.scope.scopeAlias,
    envelope.scope.revisionAlias,
    ...envelope.panelValues.map((entry) => entry.subjectAlias),
    ...envelope.traces.flatMap((entry) => [entry.subjectAlias, entry.sourceAlias, entry.sourceVersionAlias]),
    ...envelope.patches.flatMap((entry) => [entry.patchAlias, entry.patchRevisionAlias, entry.subjectAlias]),
    ...envelope.compatibility.map((entry) => entry.subjectAlias),
    ...envelope.affinity.map((entry) => entry.subjectAlias),
    ...envelope.invariants.map((entry) => entry.subjectAlias),
    ...envelope.fiveAxis.flatMap((entry) => [entry.subjectAlias, ...(entry.componentAlias ? [entry.componentAlias] : [])]),
    ...envelope.evidenceRefs.map((entry) => entry.evidenceAlias),
  ]);
}

function effectiveLimits(provider: AIProviderHardLimits, tenant: AIProviderHardLimits): AIProviderHardLimits {
  return {
    maxInputTokens: Math.min(provider.maxInputTokens, tenant.maxInputTokens),
    maxOutputTokens: Math.min(provider.maxOutputTokens, tenant.maxOutputTokens),
    maxConcurrentRequests: Math.min(provider.maxConcurrentRequests, tenant.maxConcurrentRequests),
    maxRequestsPerMinute: Math.min(provider.maxRequestsPerMinute, tenant.maxRequestsPerMinute),
    requestTimeoutMs: Math.min(provider.requestTimeoutMs, tenant.requestTimeoutMs),
    maxCostMicroUsdPerRequest: Math.min(provider.maxCostMicroUsdPerRequest, tenant.maxCostMicroUsdPerRequest),
  };
}

export interface AIAssessmentEstimate {
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
}

export interface AIBatchAdmissionInput {
  assessmentCount: number;
  inFlightForUser: number;
  inFlightForWorkspace: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostMicroUsd: number;
  startedAtMs: number;
  nowMs: number;
}

export function evaluateAIBatchAdmission(
  input: AIBatchAdmissionInput,
  policyValue: unknown = OPEN009_AI_BATCH_LIMITS,
): { softWarnings: Array<"AI_USER_SOFT_CONCURRENCY" | "AI_WORKSPACE_SOFT_CONCURRENCY" | "AI_ASSESSMENT_MAY_BE_SLOW"> } {
  const policy = validateBatchLimitPolicy(policyValue);
  for (const [key, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new FancyHubError("AI_BATCH_LIMIT_POLICY_MISSING_OR_INVALID", `${key} 必须是非负安全整数。`);
  }
  if (input.assessmentCount < 1 || input.assessmentCount > policy.maxAssessmentsPerBatch) {
    throw new FancyHubError("AI_HARD_LIMIT_EXCEEDED", `批次必须包含 1..${policy.maxAssessmentsPerBatch} 个去重评估。`);
  }
  if (input.inFlightForWorkspace >= policy.maxConcurrentAssessmentsPerWorkspace
    || input.nowMs - input.startedAtMs >= policy.batchHardTimeoutMs
    || input.estimatedInputTokens > policy.maxEstimatedInputTokensPerBatch
    || input.estimatedOutputTokens > policy.maxEstimatedOutputTokensPerBatch
    || input.estimatedCostMicroUsd > policy.maxEstimatedCostMicroUsdPerBatch) {
    throw new FancyHubError("AI_HARD_LIMIT_EXCEEDED", "批次命中并发、期限、token 或费用硬上限。" );
  }
  const softWarnings: Array<"AI_USER_SOFT_CONCURRENCY" | "AI_WORKSPACE_SOFT_CONCURRENCY" | "AI_ASSESSMENT_MAY_BE_SLOW"> = [];
  if (input.inFlightForUser >= policy.softConcurrentAssessmentsPerUser) softWarnings.push("AI_USER_SOFT_CONCURRENCY");
  if (input.inFlightForWorkspace >= policy.softConcurrentAssessmentsPerWorkspace) softWarnings.push("AI_WORKSPACE_SOFT_CONCURRENCY");
  if (input.nowMs - input.startedAtMs >= policy.softPerAssessmentWarningMs) softWarnings.push("AI_ASSESSMENT_MAY_BE_SLOW");
  return { softWarnings };
}

export function estimateAIAssessmentRequest(canonicalJson: string, policyValue: unknown): AIAssessmentEstimate {
  const policy = parseAssessmentEstimatePolicy(policyValue);
  // One tokenizer token cannot represent less than one UTF-8 byte. Counting bytes
  // therefore gives a deterministic, conservative upper bound before transport.
  const inputTokens = Buffer.byteLength(canonicalJson, "utf8");
  const outputTokens = policy.maxOutputTokens;
  const costMicroUsd = Math.ceil((
    inputTokens * policy.maxInputCostMicroUsdPer1KTokens
    + outputTokens * policy.maxOutputCostMicroUsdPer1KTokens
  ) / 1_000);
  const estimate = { inputTokens, outputTokens, costMicroUsd };
  for (const [key, value] of Object.entries(estimate)) {
    if (!positiveInteger(value)) throw new FancyHubError("AI_HARD_LIMIT_POLICY_MISSING", `${key} 无法确定性估算。`);
  }
  return estimate;
}

export interface FancyHubAdmissionLease {
  readonly inFlightForWorkspaceBefore: number;
  readonly inFlightTotalBefore: number;
  consumeAssessmentRequest(input: { nowMs: number; maxRequestsPerMinute: number }): Promise<void>;
  release(): Promise<void>;
}

export interface FancyHubAdmissionCoordinator {
  acquire(input: {
    workspaceId: string;
    maxConcurrentForWorkspace: number;
    maxConcurrentTotal: number;
    leaseExpiresAtMs: number;
  }): Promise<FancyHubAdmissionLease>;
}

export class InMemoryFancyHubAdmissionCoordinator implements FancyHubAdmissionCoordinator {
  private readonly inFlightByWorkspace = new Map<string, number>();
  private inFlightTotal = 0;
  private readonly assessmentRequestTimes: number[] = [];

  async acquire(input: {
    workspaceId: string;
    maxConcurrentForWorkspace: number;
    maxConcurrentTotal: number;
    leaseExpiresAtMs: number;
  }): Promise<FancyHubAdmissionLease> {
    const current = this.inFlightByWorkspace.get(input.workspaceId) ?? 0;
    if (current >= input.maxConcurrentForWorkspace) {
      throw new FancyHubError("AI_HARD_LIMIT_EXCEEDED", "工作区或 provider 并发硬上限已满。");
    }
    if (this.inFlightTotal >= input.maxConcurrentTotal) {
      throw new FancyHubError("AI_HARD_LIMIT_EXCEEDED", "provider 或租户全局并发硬上限已满。");
    }
    this.inFlightByWorkspace.set(input.workspaceId, current + 1);
    const inFlightTotalBefore = this.inFlightTotal;
    this.inFlightTotal += 1;
    let released = false;
    return {
      inFlightForWorkspaceBefore: current,
      inFlightTotalBefore,
      consumeAssessmentRequest: async ({ nowMs, maxRequestsPerMinute }) => {
        while (this.assessmentRequestTimes.length && this.assessmentRequestTimes[0]! <= nowMs - 60_000) {
          this.assessmentRequestTimes.shift();
        }
        if (this.assessmentRequestTimes.length >= maxRequestsPerMinute) {
          throw new FancyHubError("AI_HARD_LIMIT_EXCEEDED", "provider 或租户速率硬上限已满。");
        }
        this.assessmentRequestTimes.push(nowMs);
      },
      release: async () => {
        if (released) return;
        released = true;
        const remaining = (this.inFlightByWorkspace.get(input.workspaceId) ?? 1) - 1;
        if (remaining > 0) this.inFlightByWorkspace.set(input.workspaceId, remaining);
        else this.inFlightByWorkspace.delete(input.workspaceId);
        this.inFlightTotal -= 1;
      },
    };
  }
}

export class FancyHubConnector {
  constructor(
    private readonly config: FancyHubConnectorConfig,
    private readonly transport: FancyHubTransport,
    private readonly auditSink: (event: FancyHubAuditEvent) => void | Promise<void> = () => undefined,
    private readonly admissionCoordinator: FancyHubAdmissionCoordinator = new InMemoryFancyHubAdmissionCoordinator(),
  ) {}

  private assertEnabled(): {
    tenantLimits: AIProviderHardLimits;
    batchLimits: AIBatchLimitPolicyV1;
    estimatePolicy: AIAssessmentEstimatePolicyV1;
  } {
    if (!this.config.enabled || this.config.policyVersion !== AI_PROVIDER_POLICY_VERSION) throw new FancyHubError("AI_CONNECTOR_DISABLED", "Fancy Hub 真实连接器默认关闭." );
    assertConfiguredTarget(this.config);
    return {
      tenantLimits: parseHardLimits(this.config.tenantHardLimits, "tenantHardLimits"),
      batchLimits: validateBatchLimitPolicy(this.config.batchLimits),
      estimatePolicy: parseAssessmentEstimatePolicy(this.config.assessmentEstimatePolicy),
    };
  }

  private async listAvailableModels(timeoutMs?: number): Promise<{
    models: AIModelDescriptorV1[];
    providerHardLimits: AIProviderHardLimits;
    rejectedModels: Array<{ index: number; code: string }>;
  }> {
    const { tenantLimits } = this.assertEnabled();
    const effectiveTimeoutMs = timeoutMs ?? tenantLimits.requestTimeoutMs;
    if (!positiveInteger(effectiveTimeoutMs)) throw new FancyHubError("AI_HARD_LIMIT_EXCEEDED", "模型发现没有剩余执行时间。" );
    const response = parseModelListResponse(await this.transport.listModels({ timeoutMs: effectiveTimeoutMs }));
    const described = describeFancyHubModels(response.models);
    return { models: described.models, providerHardLimits: response.hardLimits, rejectedModels: described.rejected };
  }

  async assess(input: {
    workspaceId: string;
    loadedCredentialValues?: readonly string[];
    buildEnvelope: (model: AIModelDescriptorV1) => AIRequestEnvelopeV1;
    batch?: Pick<AIBatchAdmissionInput, "assessmentCount" | "inFlightForUser" | "startedAtMs">;
  }): Promise<{
    response: FancyHubAssessmentResponse;
    inputHash: string;
    attemptedModelIds: string[];
    requestEnvelope: AIRequestEnvelopeV1;
    canonicalRequestJson: string;
  }> {
    const auditStartedAt = new Date();
    const auditAttemptedModelIds: string[] = [];
    try {
      const { tenantLimits, batchLimits, estimatePolicy } = this.assertEnabled();
      const batchStartedAtMs = input.batch?.startedAtMs ?? Date.now();
      const batchDeadlineMs = batchStartedAtMs + batchLimits.batchHardTimeoutMs;
      const discoveryRemainingMs = batchDeadlineMs - Date.now();
      if (discoveryRemainingMs <= 0) throw new FancyHubError("AI_HARD_LIMIT_EXCEEDED", "批次已经达到 10 分钟硬期限。" );
      const assessmentCount = input.batch?.assessmentCount ?? 1;
      const lease = await this.admissionCoordinator.acquire({
        workspaceId: input.workspaceId,
        maxConcurrentForWorkspace: Math.min(batchLimits.maxConcurrentAssessmentsPerWorkspace, tenantLimits.maxConcurrentRequests),
        maxConcurrentTotal: tenantLimits.maxConcurrentRequests,
        leaseExpiresAtMs: batchDeadlineMs,
      });
      const attemptedModelIds: string[] = [];
      try {
        await lease.consumeAssessmentRequest({
          nowMs: Date.now(),
          maxRequestsPerMinute: tenantLimits.maxRequestsPerMinute,
        });
        const discovery = await this.listAvailableModels(Math.min(tenantLimits.requestTimeoutMs, discoveryRemainingMs));
        const limits = effectiveLimits(discovery.providerHardLimits, tenantLimits);
        if (lease.inFlightForWorkspaceBefore >= Math.min(batchLimits.maxConcurrentAssessmentsPerWorkspace, limits.maxConcurrentRequests)
          || lease.inFlightTotalBefore >= limits.maxConcurrentRequests) {
          throw new FancyHubError("AI_HARD_LIMIT_EXCEEDED", "模型发现返回的 provider 并发硬上限已满。" );
        }
        const byId = new Map(discovery.models.map((model) => [model.modelId, model]));
        const configured = [this.config.primaryModelId, ...this.config.fallbackModelIds]
          .filter((entry): entry is string => Boolean(entry));
        const models = configured.map((id) => byId.get(id)).filter((entry): entry is AIModelDescriptorV1 => Boolean(entry));
        if (!models.length) throw new FancyHubError("AI_NO_CONFIGURED_MODEL_AVAILABLE", "主模型和有序降级列表当前均不可用。" );
        const preparedModels = models.map((model) => {
          const prepared = prepareAIRequest({
            envelope: input.buildEnvelope(model),
            loadedCredentialValues: [this.config.apiToken!, ...loadedProcessCredentials(), ...(input.loadedCredentialValues ?? [])],
          });
          return { model, prepared, estimate: estimateAIAssessmentRequest(prepared.canonicalJson, estimatePolicy) };
        });
        if (preparedModels.some(({ estimate }) => estimate.inputTokens > limits.maxInputTokens
          || estimate.outputTokens > limits.maxOutputTokens
          || estimate.costMicroUsd > limits.maxCostMicroUsdPerRequest)) {
          throw new FancyHubError("AI_HARD_LIMIT_EXCEEDED", "按实际出站 Envelope 计算的 token 或费用估算超过 provider/租户硬上限。" );
        }
        const fallbackWorstCaseEstimate = preparedModels.reduce<AIAssessmentEstimate>((current, entry) => ({
          inputTokens: current.inputTokens + entry.estimate.inputTokens,
          outputTokens: current.outputTokens + entry.estimate.outputTokens,
          costMicroUsd: current.costMicroUsd + entry.estimate.costMicroUsd,
        }), { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
        evaluateAIBatchAdmission({
          assessmentCount,
          inFlightForUser: input.batch?.inFlightForUser ?? 0,
          inFlightForWorkspace: lease.inFlightForWorkspaceBefore,
          estimatedInputTokens: fallbackWorstCaseEstimate.inputTokens * assessmentCount,
          estimatedOutputTokens: fallbackWorstCaseEstimate.outputTokens * assessmentCount,
          estimatedCostMicroUsd: fallbackWorstCaseEstimate.costMicroUsd * assessmentCount,
          startedAtMs: batchStartedAtMs,
          nowMs: Date.now(),
        }, batchLimits);
        let lastRetryable: FancyHubError | undefined;
        for (const { model, prepared, estimate: modelEstimate } of preparedModels) {
          const remainingMs = batchDeadlineMs - Date.now();
          if (remainingMs <= 0) throw new FancyHubError("AI_HARD_LIMIT_EXCEEDED", "批次已经达到 10 分钟硬期限，不再启动降级调用。" );
          attemptedModelIds.push(model.modelId);
          auditAttemptedModelIds.push(model.modelId);
          try {
            await lease.consumeAssessmentRequest({ nowMs: Date.now(), maxRequestsPerMinute: limits.maxRequestsPerMinute });
            const response = parseAssessmentResponse(await this.transport.assess({
              canonicalJson: prepared.canonicalJson,
              inputHash: prepared.inputHash,
              model,
              maxOutputTokens: Math.min(modelEstimate.outputTokens, limits.maxOutputTokens),
              timeoutMs: Math.min(limits.requestTimeoutMs, remainingMs),
            }), authorizedResponseAliases(prepared.envelope));
            if (!sameModelDescriptor(response.model, model)) throw new FancyHubError("AI_MODEL_REVISION_MISMATCH", "Fancy Hub 响应模型描述与请求不一致。" );
            if (response.usage.inputTokens > limits.maxInputTokens || response.usage.outputTokens > limits.maxOutputTokens || response.usage.costMicroUsd > limits.maxCostMicroUsdPerRequest) {
              throw new FancyHubError("AI_HARD_LIMIT_EXCEEDED", "Fancy Hub 响应用量超过硬上限。" );
            }
            await this.auditSink({
              action: "AI_FANCY_HUB_ASSESSMENT",
              workspaceId: input.workspaceId,
              requestedAt: auditStartedAt.toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: Date.now() - auditStartedAt.getTime(),
              resultCode: "SUCCESS",
              attemptedModelIds: [...attemptedModelIds],
              modelDescriptor: response.model,
              inputHash: prepared.inputHash,
              outputHash: response.outputHash,
              usage: structuredClone(response.usage),
            });
            return {
              response,
              inputHash: prepared.inputHash,
              attemptedModelIds,
              requestEnvelope: prepared.envelope,
              canonicalRequestJson: prepared.canonicalJson,
            };
          } catch (error) {
            if (error instanceof FancyHubError && error.retryable) { lastRetryable = error; continue; }
            throw error;
          }
        }
        throw lastRetryable ?? new FancyHubError("AI_NO_CONFIGURED_MODEL_AVAILABLE", "模型降级列表耗尽。" );
      } finally {
        await lease.release();
      }
    } catch (error) {
      await this.auditSink({
        action: "AI_FANCY_HUB_ASSESSMENT",
        workspaceId: input.workspaceId,
        requestedAt: auditStartedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - auditStartedAt.getTime(),
        resultCode: error instanceof FancyHubError || error instanceof AIOutboundError ? error.code : "AI_UNKNOWN_FAILURE",
        attemptedModelIds: auditAttemptedModelIds,
      });
      throw error;
    }
  }
}

function loadedProcessCredentials(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => Boolean(value) && /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY|COOKIE|AUTHORIZATION)/i.test(name))
    .map(([, value]) => value!)
    .filter((value) => value.length >= 4);
}

function envPositiveInteger(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return positiveInteger(value) ? value : undefined;
}

export function fancyHubConfigFromEnvironment(): FancyHubConnectorConfig {
  const tenantValues = {
    maxInputTokens: envPositiveInteger("FANCY_HUB_TENANT_MAX_INPUT_TOKENS"),
    maxOutputTokens: envPositiveInteger("FANCY_HUB_TENANT_MAX_OUTPUT_TOKENS"),
    maxConcurrentRequests: envPositiveInteger("FANCY_HUB_TENANT_MAX_CONCURRENT_REQUESTS"),
    maxRequestsPerMinute: envPositiveInteger("FANCY_HUB_TENANT_MAX_REQUESTS_PER_MINUTE"),
    requestTimeoutMs: envPositiveInteger("FANCY_HUB_REQUEST_TIMEOUT_MS"),
    maxCostMicroUsdPerRequest: envPositiveInteger("FANCY_HUB_TENANT_MAX_COST_MICRO_USD_PER_REQUEST"),
  };
  const tenantHardLimits = Object.values(tenantValues).every((entry) => entry !== undefined)
    ? tenantValues as AIProviderHardLimits
    : undefined;
  const estimateValues = {
    maxOutputTokens: envPositiveInteger("FANCY_HUB_ASSESSMENT_MAX_OUTPUT_TOKENS"),
    maxInputCostMicroUsdPer1KTokens: envPositiveInteger("FANCY_HUB_MAX_INPUT_COST_MICRO_USD_PER_1K_TOKENS"),
    maxOutputCostMicroUsdPer1KTokens: envPositiveInteger("FANCY_HUB_MAX_OUTPUT_COST_MICRO_USD_PER_1K_TOKENS"),
  };
  const assessmentEstimatePolicy = Object.values(estimateValues).every((entry) => entry !== undefined)
    ? estimateValues as AIAssessmentEstimatePolicyV1
    : undefined;
  return {
    enabled: process.env.FANCY_HUB_ENABLED?.trim().toLowerCase() === "true",
    policyVersion: AI_PROVIDER_POLICY_VERSION,
    baseUrl: process.env.FANCY_HUB_BASE_URL?.trim(),
    apiToken: process.env.FANCY_HUB_API_TOKEN?.trim(),
    primaryModelId: process.env.FANCY_HUB_PRIMARY_MODEL_ID?.trim(),
    fallbackModelIds: (process.env.FANCY_HUB_FALLBACK_MODEL_IDS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
    tenantHardLimits,
    batchLimits: OPEN009_AI_BATCH_LIMITS,
    assessmentEstimatePolicy,
  };
}

export function createFancyHubConnectorFromEnvironment(input: {
  fetchImpl?: typeof fetch;
  auditSink?: (event: FancyHubAuditEvent) => void | Promise<void>;
  admissionCoordinator?: FancyHubAdmissionCoordinator;
} = {}): FancyHubConnector {
  const config = fancyHubConfigFromEnvironment();
  const target = assertConfiguredTarget(config);
  if (!input.admissionCoordinator) {
    throw new FancyHubError("AI_RUNTIME_COORDINATOR_UNAVAILABLE", "真实 Fancy Hub 调用缺少跨进程原子准入协调器。");
  }
  const transport = new FetchFancyHubTransport(target.toString(), config.apiToken!, input.fetchImpl);
  return new FancyHubConnector(config, transport, input.auditSink, input.admissionCoordinator);
}
