import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AIOutboundError,
  type AIModelDescriptorV1,
  type AIRequestEnvelopeV1,
  PromptTemplateRegistry,
  createRequestAliasMap,
  describeFancyHubModels,
  jcsCanonicalize,
  prepareAIRequest,
  promptTemplateHash,
  requestAliasFor,
  sha256Hex,
} from "../lib/ai-outbound";
import {
  AI_BATCH_LIMIT_POLICY_VERSION,
  FancyHubConnector,
  FancyHubError,
  FetchFancyHubTransport,
  InMemoryFancyHubAdmissionCoordinator,
  OPEN009_AI_BATCH_LIMITS,
  fancyHubConfigFromEnvironment,
  fancyHubEnablement,
  evaluateAIBatchAdmission,
  type AIProviderHardLimits,
  type FancyHubAssessmentResponse,
  type FancyHubConnectorConfig,
  type FancyHubTransport,
} from "../lib/fancy-hub";
import {
  AI_RETENTION_POLICY_VERSION,
  decryptAIRawContent,
  encryptAIRawContent,
  purgeAIAssessmentBackups,
  requestAIAssessmentDeletion,
  sweepAIAssessmentRetention,
  type AIAssessmentRetentionRecord,
} from "../lib/ai-retention";
import { feishuCapabilities } from "../lib/feishu-identity";
import { createAIRuntimeStoreFromEnvironment } from "../lib/ai-runtime-store";

function modelList(modelVersion = "2026-07-23"): AIModelDescriptorV1 {
  return describeFancyHubModels([{
    modelId: "model.alpha",
    modelVersion,
    deploymentRevision: "deploy.7",
    modelArtifactDigest: "sha256:abc",
  }]).models[0]!;
}

function envelope(model = modelList()): AIRequestEnvelopeV1 {
  const hash = "a".repeat(64);
  return {
    schemaVersion: "ai-request/v1",
    policyVersion: "ai-provider/open006-v1",
    promptTemplateVersion: "prompt-v1",
    promptTemplateHash: promptTemplateHash("controlled prompt\n"),
    assessmentAlias: "a001",
    analysisIntent: "suggest_tradeoffs",
    model,
    scope: { scopeType: "model", scopeAlias: "a002", revisionAlias: "a003" },
    panelValues: [
      { subjectAlias: "a002", parameterKey: "weight", value: { kind: "number", value: 8 }, unitCode: "kg" },
      { subjectAlias: "a002", parameterKey: "drag", value: { kind: "number", value: 10 }, unitCode: "kg" },
    ],
    traces: [
      { subjectAlias: "a002", parameterKey: "drag", sequence: 5, layerCode: "model_patch", sourceAlias: "a004", sourceVersionAlias: "a005", operationCode: "multiply", before: { kind: "number", value: 8 }, operand: { kind: "number", value: 1.25 }, after: { kind: "number", value: 10 }, effectCode: "benefit", warningCodes: ["WARN_B", "WARN_A"] },
      { subjectAlias: "a002", parameterKey: "weight", sequence: 0, layerCode: "weight_template", sourceAlias: "a006", sourceVersionAlias: "a007", operationCode: "set", before: { kind: "null", value: null }, operand: { kind: "number", value: 8 }, after: { kind: "number", value: 8 }, effectCode: "neutral", warningCodes: [] },
    ],
    patches: [
      { patchAlias: "a004", patchRevisionAlias: "a005", chainIndex: 0, operationIndex: 2, scopeType: "model", subjectAlias: "a002", parameterKey: "drag", operation: "add", operand: { kind: "number", value: 2 }, before: { kind: "number", value: 8 }, after: { kind: "number", value: 10 } },
      { patchAlias: "a004", patchRevisionAlias: "a005", chainIndex: 0, operationIndex: 0, scopeType: "model", subjectAlias: "a002", parameterKey: "drag", operation: "multiply", operand: { kind: "number", value: 1 }, before: { kind: "number", value: 8 }, after: { kind: "number", value: 8 } },
    ],
    compatibility: [{ subjectAlias: "a002", result: "allow", ruleCode: "RULE_1", parameterKeys: ["weight", "drag"], conditionCodes: ["TYPE_OK"] }],
    affinity: [{ subjectAlias: "a002", axisCode: "type_function", ruleCode: "AFF_1", score: 2, weight: 1, weightedContribution: 2 }],
    invariants: [{ subjectAlias: "a002", invariantCode: "INV_1", parameterKey: "drag", expectedDirection: "positive", expected: { kind: "number", value: 8 }, actual: { kind: "number", value: 10 } }],
    fiveAxis: [{ subjectAlias: "a002", axisCode: "pull", source: "direct", rawValue: 10, normalizedRatio: 0.8, officialDisplayScore: 80, comparisonScore: 80 }],
    evidenceRefs: [{ evidenceType: "trace", evidenceAlias: "a008", contentHash: hash }],
  };
}

function shuffle<T>(items: readonly T[]): T[] {
  return [...items].sort(() => Math.random() - 0.5);
}

test("RFC 8785 固定向量、转义、-0 与 prompt 换行规范化", () => {
  const canonical = jcsCanonicalize({
    schemaVersion: "ai-request/v1",
    promptTemplateVersion: "prompt-v1",
    policyVersion: "ai-provider/open006-v1",
  });
  assert.equal(canonical, "{\"policyVersion\":\"ai-provider/open006-v1\",\"promptTemplateVersion\":\"prompt-v1\",\"schemaVersion\":\"ai-request/v1\"}");
  assert.equal(sha256Hex(canonical), "4e455bbba4a0c3a6d3048e2f5e372ab76a26336485ad1b26359b15f8add46e97");
  assert.equal(jcsCanonicalize({ z: -0, a: "line\n\"quote\"" }), "{\"a\":\"line\\n\\\"quote\\\"\",\"z\":0}");
  assert.equal(promptTemplateHash("\ufeffa\r\nb\r"), promptTemplateHash("a\nb\n"));
});

test("请求级别名按三分量 UTF-8 排序，随机输入 100 次保持布局且不复用状态", () => {
  const references = [
    { referenceKindCode: "model" as const, stableLocalId: "model-2", stableRevisionId: "r2" },
    { referenceKindCode: "model" as const, stableLocalId: "model-1", stableRevisionId: "r1" },
    { referenceKindCode: "assessment" as const, stableLocalId: "assessment-1" },
  ];
  const baseline = [...createRequestAliasMap(references).entries()];
  for (let index = 0; index < 100; index += 1) {
    assert.deepEqual([...createRequestAliasMap(shuffle(references)).entries()], baseline);
  }
  const first = createRequestAliasMap(references);
  const second = createRequestAliasMap(references);
  assert.notEqual(first, second);
  assert.equal(requestAliasFor(first, references[2]!), "a001");
});

test("完整 Envelope 随机重排 100 次恢复集合顺序并保持 canonical bytes/inputHash", () => {
  const source = envelope();
  const baseline = prepareAIRequest({ envelope: source });
  for (let index = 0; index < 100; index += 1) {
    const reordered = structuredClone(source);
    reordered.panelValues = shuffle(reordered.panelValues);
    reordered.traces = shuffle(reordered.traces).map((entry) => ({ ...entry, warningCodes: shuffle(entry.warningCodes) }));
    reordered.patches = shuffle(reordered.patches);
    reordered.compatibility = shuffle(reordered.compatibility).map((entry) => ({ ...entry, parameterKeys: shuffle(entry.parameterKeys), conditionCodes: shuffle(entry.conditionCodes) }));
    const prepared = prepareAIRequest({ envelope: reordered });
    assert.equal(prepared.canonicalJson, baseline.canonicalJson);
    assert.equal(prepared.inputHash, baseline.inputHash);
  }
  assert.deepEqual(baseline.envelope.traces.map((entry) => entry.sequence), [0, 5]);
  assert.deepEqual(baseline.envelope.patches.map((entry) => entry.operationIndex), [0, 2]);
});

test("未知字段、自由正文形态、重复元素、Trace/Patch 冲突和非有限数均在发送前拒绝", () => {
  const unknown = envelope() as AIRequestEnvelopeV1 & { actionLink?: unknown };
  unknown.actionLink = { url: "https://forbidden" };
  assert.throws(() => prepareAIRequest({ envelope: unknown }), (error) => error instanceof AIOutboundError && error.code === "AI_PAYLOAD_SCHEMA_REJECTED");

  const duplicate = envelope(); duplicate.panelValues.push(structuredClone(duplicate.panelValues[0]!));
  assert.throws(() => prepareAIRequest({ envelope: duplicate }), (error) => error instanceof AIOutboundError && error.code === "AI_PAYLOAD_DUPLICATE_ELEMENT");

  const traceConflict = envelope(); traceConflict.traces[1]!.sequence = 5;
  assert.throws(() => prepareAIRequest({ envelope: traceConflict }), (error) => error instanceof AIOutboundError && error.code === "AI_TRACE_SEQUENCE_CONFLICT");

  const patchConflict = envelope(); patchConflict.patches[1]!.operationIndex = 2;
  assert.throws(() => prepareAIRequest({ envelope: patchConflict }), (error) => error instanceof AIOutboundError && error.code === "AI_PATCH_ORDER_CONFLICT");

  const invalidNumber = envelope(); invalidNumber.affinity[0]!.score = Number.NaN;
  assert.throws(() => prepareAIRequest({ envelope: invalidNumber }), (error) => error instanceof AIOutboundError && error.code === "AI_PAYLOAD_SCHEMA_REJECTED");
});

test("加载凭据精确值、Authorization/Cookie/private key 模式命中时请求计数保持 0", () => {
  for (const forbidden of ["loaded-secret", "Bearer abcdefghijklmnop", "Cookie: sid=abcdef", "-----BEGIN PRIVATE KEY-----"]) {
    const value = envelope();
    value.compatibility[0]!.ruleCode = forbidden === "loaded-secret" ? "loaded-secret" : "SAFE";
    if (forbidden !== "loaded-secret") {
      // SafeCode prevents pattern-bearing free text before the secret scanner.
      assert.throws(() => prepareAIRequest({ envelope: { ...value, promptTemplateVersion: forbidden } }), AIOutboundError);
    } else {
      assert.throws(
        () => prepareAIRequest({ envelope: value, loadedCredentialValues: [forbidden] }),
        (error) => error instanceof AIOutboundError && error.code === "AI_SECRET_DETECTED",
      );
    }
  }
});

test("同一 prompt version 不允许绑定不同正文 hash", () => {
  const registry = new PromptTemplateRegistry();
  registry.register("prompt-v1", "first");
  registry.register("prompt-v1", "first");
  assert.throws(() => registry.register("prompt-v1", "second"), (error) => error instanceof AIOutboundError && error.code === "AI_PROMPT_TEMPLATE_VERSION_CONFLICT");
});

test("模型列表冻结全部修订标识；缺失修订被排除，任一修订变化都会改变描述", () => {
  const described = describeFancyHubModels([
    { modelId: "model.alpha", deploymentRevision: "d1", modelVersion: "v1", modelArtifactDigest: "digest:1" },
    { modelId: "model.invalid" },
  ]);
  assert.equal(described.models.length, 1);
  assert.deepEqual(described.models[0]!.revisions, { modelVersion: "v1", deploymentRevision: "d1", modelArtifactDigest: "digest:1" });
  assert.equal(described.rejected[0]?.code, "AI_MODEL_REVISION_UNAVAILABLE");
  assert.notEqual(described.models[0]!.revisionIdentityHash, describeFancyHubModels([{ modelId: "model.alpha", deploymentRevision: "d2", modelVersion: "v1", modelArtifactDigest: "digest:1" }]).models[0]!.revisionIdentityHash);
});

const hardLimits: AIProviderHardLimits = {
  maxInputTokens: 50_000,
  maxOutputTokens: 8_000,
  maxConcurrentRequests: 4,
  maxRequestsPerMinute: 60,
  requestTimeoutMs: 30_000,
  maxCostMicroUsdPerRequest: 200_000,
};

function connectorConfig(overrides: Partial<FancyHubConnectorConfig> = {}): FancyHubConnectorConfig {
  return {
    enabled: true,
    policyVersion: "ai-provider/open006-v1",
    baseUrl: "https://fancy-hub.internal/",
    apiToken: "hub-secret",
    primaryModelId: "model.alpha",
    fallbackModelIds: ["model.beta"],
    providerHardLimits: hardLimits,
    tenantHardLimits: hardLimits,
    batchLimits: { ...OPEN009_AI_BATCH_LIMITS },
    assessmentEstimatePolicy: {
      maxOutputTokens: 100,
      maxInputCostMicroUsdPer1KTokens: 1_000,
      maxOutputCostMicroUsdPer1KTokens: 1_000,
    },
    ...overrides,
  };
}

class MockTransport implements FancyHubTransport {
  calls: string[] = [];
  constructor(
    private readonly models: unknown,
    private readonly assessments: Array<unknown | Error>,
  ) {}
  async listModels() { this.calls.push("models"); return this.models; }
  async assess() {
    this.calls.push("assess");
    const next = this.assessments.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

function discoveryModels() {
  return {
    models: [
      { modelId: "model.alpha", modelVersion: "v1" },
      { modelId: "model.beta", deploymentRevision: "d2" },
    ],
    hardLimits,
  };
}

function response(model: AIModelDescriptorV1): Omit<FancyHubAssessmentResponse, "outputHash"> {
  return {
    model,
    result: {
      schemaVersion: "ai-response/v1",
      assessmentAlias: "a001",
      findings: [], recommendations: [], assumptions: [], uncoveredInformation: [],
    },
    usage: { inputTokens: 100, outputTokens: 50, costMicroUsd: 1_000 },
  };
}

test("真实连接器默认关闭、配置或硬限额缺失时 fail-closed 且 transport 计数为 0", async () => {
  const transport = new MockTransport(discoveryModels(), []);
  const audit: Array<{ actorStableId: string; resultCode: string; attemptedModelIds: string[] }> = [];
  const connector = new FancyHubConnector(connectorConfig({ enabled: false }), transport, (event) => { audit.push(event); });
  await assert.rejects(
    connector.assess({ workspaceId: "w1", actorStableId: "ou-test", buildEnvelope: envelope }),
    (error) => error instanceof FancyHubError && error.code === "AI_CONNECTOR_DISABLED",
  );
  assert.deepEqual(transport.calls, []);
  assert.equal(audit[0]?.resultCode, "AI_CONNECTOR_DISABLED");
  assert.equal(audit[0]?.actorStableId, "ou-test");
  assert.deepEqual(audit[0]?.attemptedModelIds, []);
  assert.equal(fancyHubEnablement(connectorConfig({ enabled: false })).enabled, false);
  assert.equal(fancyHubEnablement(connectorConfig({ providerHardLimits: undefined })).code, "AI_HARD_LIMIT_POLICY_MISSING");
  assert.equal(fancyHubEnablement(connectorConfig({ tenantHardLimits: undefined })).code, "AI_HARD_LIMIT_POLICY_MISSING");
  assert.equal(AI_BATCH_LIMIT_POLICY_VERSION, "ai-batch-limits/open009-v1");
});

test("首个模型发现请求也使用部署期 provider 硬上限，缺失时零出网", async () => {
  const missingTransport = new MockTransport(discoveryModels(), []);
  await assert.rejects(
    new FancyHubConnector(connectorConfig({ providerHardLimits: undefined }), missingTransport)
      .assess({ workspaceId: "w1", actorStableId: "ou-test", buildEnvelope: envelope }),
    (error) => error instanceof FancyHubError && error.code === "AI_HARD_LIMIT_POLICY_MISSING",
  );
  assert.deepEqual(missingTransport.calls, []);

  const bootstrapLimits = { ...hardLimits, maxRequestsPerMinute: 1 };
  const limitedTransport = new MockTransport(discoveryModels(), [response(modelList())]);
  await assert.rejects(
    new FancyHubConnector(connectorConfig({ providerHardLimits: bootstrapLimits }), limitedTransport)
      .assess({ workspaceId: "w1", actorStableId: "ou-test", buildEnvelope: envelope }),
    (error) => error instanceof FancyHubError && error.code === "AI_HARD_LIMIT_EXCEEDED",
  );
  assert.deepEqual(limitedTransport.calls, ["models"]);
});

test("Fancy Hub 正常调用冻结模型描述，临时错误才按有序列表降级", async () => {
  const discovered = describeFancyHubModels(discoveryModels().models);
  const transient = new FancyHubError("AI_PROVIDER_TEMPORARILY_UNAVAILABLE", "temporary", true);
  const transport = new MockTransport(discoveryModels(), [transient, response(discovered.models.find((entry) => entry.modelId === "model.beta")!)]);
  let auditedActor: string | undefined;
  const connector = new FancyHubConnector(connectorConfig(), transport, (event) => { auditedActor = event.actorStableId; });
  const result = await connector.assess({
    workspaceId: "w1",
    actorStableId: "ou-test",
    loadedCredentialValues: ["hub-secret"],
    buildEnvelope: envelope,
  });
  assert.deepEqual(result.attemptedModelIds, ["model.alpha", "model.beta"]);
  assert.equal(result.response.model.modelId, "model.beta");
  assert.match(result.response.outputHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(transport.calls, ["models", "assess", "assess"]);
  assert.equal(auditedActor, "ou-test");
});

test("不同 connector 实例共享原子准入协调，模型发现和评估都在 transport 前受控", async () => {
  const coordinator = new InMemoryFancyHubAdmissionCoordinator();
  const constrained = connectorConfig({
    tenantHardLimits: { ...hardLimits, maxConcurrentRequests: 1 },
    fallbackModelIds: [],
  });
  let releaseFirst!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const blockingTransport: FancyHubTransport = {
    async listModels() { return discoveryModels(); },
    async assess(input) {
      markEntered();
      await release;
      return response(input.model);
    },
  };
  const secondTransport = new MockTransport(discoveryModels(), [response(modelList())]);
  const first = new FancyHubConnector(constrained, blockingTransport, undefined, coordinator)
    .assess({ workspaceId: "w1", actorStableId: "ou-test", buildEnvelope: envelope });
  await entered;
  await assert.rejects(
    new FancyHubConnector(constrained, secondTransport, undefined, coordinator)
      .assess({ workspaceId: "w1", actorStableId: "ou-test", buildEnvelope: envelope }),
    (error) => error instanceof FancyHubError && error.code === "AI_HARD_LIMIT_EXCEEDED",
  );
  assert.deepEqual(secondTransport.calls, []);
  releaseFirst();
  await first;
});

test("降级列表按所有最坏尝试累计批次预算，超限时不发评估请求", async () => {
  const transport = new MockTransport(discoveryModels(), [
    new FancyHubError("AI_PROVIDER_TEMPORARILY_UNAVAILABLE", "temporary", true),
    response(describeFancyHubModels(discoveryModels().models).models[1]!),
  ]);
  const connector = new FancyHubConnector(connectorConfig({
    tenantHardLimits: { ...hardLimits, maxCostMicroUsdPerRequest: 500_000 },
    assessmentEstimatePolicy: {
      maxOutputTokens: 100,
      maxInputCostMicroUsdPer1KTokens: 20_000,
      maxOutputCostMicroUsdPer1KTokens: 20_000,
    },
  }), transport);
  await assert.rejects(
    connector.assess({
      workspaceId: "w1",
      actorStableId: "ou-test",
      buildEnvelope: envelope,
      batch: { assessmentCount: 20, inFlightForUser: 0, startedAtMs: Date.now() },
    }),
    (error) => error instanceof FancyHubError && error.code === "AI_HARD_LIMIT_EXCEEDED",
  );
  assert.deepEqual(transport.calls, ["models"]);
});

test("provider 较低 RPM 持久化到共享准入，后续发现请求在出网前阻断", async () => {
  const coordinator = new InMemoryFancyHubAdmissionCoordinator();
  const providerLimits = { ...hardLimits, maxRequestsPerMinute: 1 };
  const firstTransport = new MockTransport(
    { ...discoveryModels(), hardLimits: providerLimits },
    [response(modelList())],
  );
  await assert.rejects(
    new FancyHubConnector(connectorConfig(), firstTransport, undefined, coordinator)
      .assess({ workspaceId: "w1", actorStableId: "ou-test", buildEnvelope: envelope }),
    (error) => error instanceof FancyHubError && error.code === "AI_HARD_LIMIT_EXCEEDED",
  );
  assert.deepEqual(firstTransport.calls, ["models"]);

  const secondTransport = new MockTransport(
    { ...discoveryModels(), hardLimits: providerLimits },
    [response(modelList())],
  );
  await assert.rejects(
    new FancyHubConnector(connectorConfig(), secondTransport, undefined, coordinator)
      .assess({ workspaceId: "w1", actorStableId: "ou-test", buildEnvelope: envelope }),
    (error) => error instanceof FancyHubError && error.code === "AI_HARD_LIMIT_EXCEEDED",
  );
  assert.deepEqual(secondTransport.calls, []);
});

test("响应结果递归拒绝未知字段、越界正文与请求外别名，并在成功前生成 outputHash", async () => {
  const requested = describeFancyHubModels(discoveryModels().models).models[0]!;
  const recommendation = {
    recommendationCode: "R1",
    title: "review",
    summary: "review evidence",
    subjectAliases: ["a002"],
    evidenceAliases: ["a008"],
    suggestedAction: "preview_only",
  } as const;
  for (const [raw, code] of [
    [{ ...response(requested), result: { ...response(requested).result, unknown: true } }, "AI_FANCY_HUB_RESPONSE_INVALID"],
    [{ ...response(requested), result: { ...response(requested).result, findings: [{ findingCode: "F1", summary: "ok", subjectAliases: ["a999"], evidenceAliases: [] }] } }, "AI_RESPONSE_ALIAS_UNKNOWN"],
    [{ ...response(requested), result: { ...response(requested).result, findings: [{ findingCode: "F1", summary: "x".repeat(4_097), subjectAliases: ["a002"], evidenceAliases: [] }] } }, "AI_FANCY_HUB_RESPONSE_INVALID"],
    [{ ...response(requested), result: { ...response(requested).result, recommendations: [{ ...recommendation, evidenceAliases: [] }] } }, "AI_FANCY_HUB_RESPONSE_INVALID"],
    [{ ...response(requested), result: { ...response(requested).result, recommendations: [{ ...recommendation, evidenceAliases: ["a002"] }] } }, "AI_RESPONSE_ALIAS_UNKNOWN"],
  ] as const) {
    const transport = new MockTransport(discoveryModels(), [raw]);
    await assert.rejects(
      new FancyHubConnector(connectorConfig(), transport).assess({ workspaceId: "w1", actorStableId: "ou-test", buildEnvelope: envelope }),
      (error) => error instanceof FancyHubError && error.code === code,
    );
  }

  const supported = new MockTransport(discoveryModels(), [{
    ...response(requested),
    result: { ...response(requested).result, recommendations: [recommendation] },
  }]);
  const accepted = await new FancyHubConnector(connectorConfig({ fallbackModelIds: [] }), supported)
    .assess({ workspaceId: "w1", actorStableId: "ou-test", buildEnvelope: envelope });
  assert.deepEqual(accepted.response.result.recommendations[0]?.evidenceAliases, ["a008"]);
});

test("批次绝对期限在每次降级前重验，并按剩余时间收紧单次 timeout", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  const timeouts: number[] = [];
  let assessCalls = 0;
  const transport: FancyHubTransport = {
    async listModels(input) { timeouts.push(input.timeoutMs); return discoveryModels(); },
    async assess(input) {
      timeouts.push(input.timeoutMs);
      assessCalls += 1;
      now = 601_000;
      throw new FancyHubError("AI_PROVIDER_TEMPORARILY_UNAVAILABLE", "temporary", true);
    },
  };
  try {
    await assert.rejects(
      new FancyHubConnector(connectorConfig(), transport).assess({
        workspaceId: "w1",
        actorStableId: "ou-test",
        buildEnvelope: envelope,
        batch: { assessmentCount: 1, inFlightForUser: 0, startedAtMs: 1_000 },
      }),
      (error) => error instanceof FancyHubError && error.code === "AI_HARD_LIMIT_EXCEEDED",
    );
    assert.equal(assessCalls, 1);
    assert.ok(timeouts.every((timeout) => timeout <= 30_000));
  } finally {
    Date.now = originalNow;
  }
});

test("真实 HTTP adapter 只向配置 HTTPS origin 发送 canonical ai-request/v1，禁止重定向且凭据不进正文", async () => {
  const prepared = prepareAIRequest({ envelope: envelope() });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Response.json(response(envelope().model));
  }) as typeof fetch;
  const transport = new FetchFancyHubTransport("https://fancy-hub.internal/gateway/", "top-secret-token", fetchImpl);
  await transport.assess({ canonicalJson: prepared.canonicalJson, inputHash: prepared.inputHash, model: prepared.envelope.model, maxOutputTokens: 100, timeoutMs: 1_000 });
  assert.equal(calls[0]?.url, "https://fancy-hub.internal/gateway/v1/assessments");
  assert.equal(calls[0]?.init.body, prepared.canonicalJson);
  assert.equal(String(calls[0]?.init.body).includes("top-secret-token"), false);
  assert.equal(calls[0]?.init.redirect, "error");
  assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), "Bearer top-secret-token");
  assert.throws(() => new FetchFancyHubTransport("http://outside.example/", "secret", fetchImpl), (error) => error instanceof FancyHubError && error.code === "AI_OUTBOUND_TARGET_REJECTED");
});

test("响应增加、减少或改变模型修订标识均 fail-closed，不形成有效结果", async () => {
  const requested = describeFancyHubModels(discoveryModels().models).models[0]!;
  const changed = { ...requested, revisions: { modelVersion: "v2" }, revisionIdentityHash: describeFancyHubModels([{ modelId: "model.alpha", modelVersion: "v2" }]).models[0]!.revisionIdentityHash };
  const transport = new MockTransport(discoveryModels(), [response(changed)]);
  await assert.rejects(
    new FancyHubConnector(connectorConfig(), transport).assess({ workspaceId: "w1", actorStableId: "ou-test", buildEnvelope: envelope }),
    (error) => error instanceof FancyHubError && error.code === "AI_MODEL_REVISION_MISMATCH",
  );
});

test("请求估算超过 provider/租户硬 token 或费用上限时不发评估请求", async () => {
  const transport = new MockTransport(discoveryModels(), []);
  await assert.rejects(
    new FancyHubConnector(connectorConfig({ tenantHardLimits: { ...hardLimits, maxInputTokens: 10 } }), transport)
      .assess({ workspaceId: "w1", actorStableId: "ou-test", buildEnvelope: envelope }),
    (error) => error instanceof FancyHubError && error.code === "AI_HARD_LIMIT_EXCEEDED",
  );
  assert.deepEqual(transport.calls, ["models"]);
});

test("OPEN-009 批次硬值不可越过，用户1/工作区4/单项60秒只返回软提示", () => {
  const now = 1_000_000;
  const admitted = evaluateAIBatchAdmission({
    assessmentCount: 20,
    inFlightForUser: 1,
    inFlightForWorkspace: 4,
    estimatedInputTokens: 200_000,
    estimatedOutputTokens: 40_000,
    estimatedCostMicroUsd: 1_000_000,
    startedAtMs: now - 60_000,
    nowMs: now,
  });
  assert.deepEqual(admitted.softWarnings, ["AI_USER_SOFT_CONCURRENCY", "AI_WORKSPACE_SOFT_CONCURRENCY", "AI_ASSESSMENT_MAY_BE_SLOW"]);
  for (const override of [
    { assessmentCount: 21 },
    { inFlightForWorkspace: 8 },
    { estimatedInputTokens: 200_001 },
    { estimatedOutputTokens: 40_001 },
    { estimatedCostMicroUsd: 1_000_001 },
    { startedAtMs: now - 600_000 },
  ]) {
    assert.throws(
      () => evaluateAIBatchAdmission({ assessmentCount: 1, inFlightForUser: 0, inFlightForWorkspace: 0, estimatedInputTokens: 1, estimatedOutputTokens: 1, estimatedCostMicroUsd: 1, startedAtMs: now, nowMs: now, ...override }),
      (error) => error instanceof FancyHubError && error.code === "AI_HARD_LIMIT_EXCEEDED",
    );
  }
});

test("环境配置默认关闭且不会从缺失值猜硬上限", () => {
  const previous = process.env.FANCY_HUB_ENABLED;
  try {
    delete process.env.FANCY_HUB_ENABLED;
    const config = fancyHubConfigFromEnvironment();
    assert.equal(config.enabled, false);
    assert.equal(config.providerHardLimits, undefined);
    assert.equal(config.tenantHardLimits, undefined);
  } finally {
    if (previous === undefined) delete process.env.FANCY_HUB_ENABLED;
    else process.env.FANCY_HUB_ENABLED = previous;
  }
});

test("环境配置完整解析部署期 provider 硬上限，任一缺失则整体 fail-closed", () => {
  const names = [
    "FANCY_HUB_PROVIDER_MAX_INPUT_TOKENS",
    "FANCY_HUB_PROVIDER_MAX_OUTPUT_TOKENS",
    "FANCY_HUB_PROVIDER_MAX_CONCURRENT_REQUESTS",
    "FANCY_HUB_PROVIDER_MAX_REQUESTS_PER_MINUTE",
    "FANCY_HUB_PROVIDER_REQUEST_TIMEOUT_MS",
    "FANCY_HUB_PROVIDER_MAX_COST_MICRO_USD_PER_REQUEST",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    const values = ["50000", "8000", "4", "60", "30000", "200000"];
    names.forEach((name, index) => { process.env[name] = values[index]!; });
    assert.deepEqual(fancyHubConfigFromEnvironment().providerHardLimits, hardLimits);

    delete process.env.FANCY_HUB_PROVIDER_MAX_REQUESTS_PER_MINUTE;
    assert.equal(fancyHubConfigFromEnvironment().providerHardLimits, undefined);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("R730 生产模板列出真实连接器启用所需的全部限额与留存配置", async () => {
  const template = await readFile(path.join(process.cwd(), "deploy", "tackle-forger.env.example"), "utf8");
  for (const name of [
    "FANCY_HUB_PROVIDER_MAX_INPUT_TOKENS",
    "FANCY_HUB_PROVIDER_MAX_OUTPUT_TOKENS",
    "FANCY_HUB_PROVIDER_MAX_CONCURRENT_REQUESTS",
    "FANCY_HUB_PROVIDER_MAX_REQUESTS_PER_MINUTE",
    "FANCY_HUB_PROVIDER_REQUEST_TIMEOUT_MS",
    "FANCY_HUB_PROVIDER_MAX_COST_MICRO_USD_PER_REQUEST",
    "FANCY_HUB_TENANT_MAX_INPUT_TOKENS",
    "FANCY_HUB_TENANT_MAX_OUTPUT_TOKENS",
    "FANCY_HUB_TENANT_MAX_CONCURRENT_REQUESTS",
    "FANCY_HUB_TENANT_MAX_REQUESTS_PER_MINUTE",
    "FANCY_HUB_REQUEST_TIMEOUT_MS",
    "FANCY_HUB_TENANT_MAX_COST_MICRO_USD_PER_REQUEST",
    "FANCY_HUB_ASSESSMENT_MAX_OUTPUT_TOKENS",
    "FANCY_HUB_MAX_INPUT_COST_MICRO_USD_PER_1K_TOKENS",
    "FANCY_HUB_MAX_OUTPUT_COST_MICRO_USD_PER_1K_TOKENS",
    "AI_RETENTION_DATA_DIR",
    "AI_RETENTION_ENCRYPTION_KEY_BASE64",
    "AI_RETENTION_ENCRYPTION_KEY_VERSION",
  ]) {
    assert.match(template, new RegExp(`^${name}=`, "m"), `${name} missing from production template`);
  }
});

test("真实运行时在响应返回前持久化审计事件与加密留存记录", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tackle-forger-ai-runtime-"));
  const key = randomBytes(32);
  const previous = {
    dataDir: process.env.AI_RETENTION_DATA_DIR,
    key: process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64,
    keyVersion: process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION,
  };
  process.env.AI_RETENTION_DATA_DIR = directory;
  process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = key.toString("base64");
  process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = "key-v1";
  try {
    const store = createAIRuntimeStoreFromEnvironment();
    await store.initialize();
    const coordinatorA = store.admissionCoordinator();
    const coordinatorB = createAIRuntimeStoreFromEnvironment().admissionCoordinator();
    const lease = await coordinatorA.acquire({
      workspaceId: "default",
      maxConcurrentForWorkspace: 1,
      maxConcurrentTotal: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
    });
    await assert.rejects(
      coordinatorB.acquire({
        workspaceId: "default",
        maxConcurrentForWorkspace: 1,
        maxConcurrentTotal: 1,
        leaseExpiresAtMs: Date.now() + 60_000,
      }),
      (error) => error instanceof FancyHubError && error.code === "AI_HARD_LIMIT_EXCEEDED",
    );
    await lease.release();
    const requestEnvelope = envelope();
    const canonicalRequestJson = jcsCanonicalize(requestEnvelope);
    const rawResponse = response(requestEnvelope.model);
    const successfulResponse: FancyHubAssessmentResponse = {
      ...rawResponse,
      outputHash: sha256Hex(jcsCanonicalize(rawResponse)),
    };
    await store.appendAuditEvent({
      action: "AI_FANCY_HUB_ASSESSMENT",
      workspaceId: "default",
      actorStableId: "ou-user-1",
      requestedAt: "2026-07-23T00:00:00.000Z",
      completedAt: "2026-07-23T00:00:01.000Z",
      durationMs: 1_000,
      resultCode: "SUCCESS",
      attemptedModelIds: [requestEnvelope.model.modelId],
      modelDescriptor: requestEnvelope.model,
      inputHash: sha256Hex(canonicalRequestJson),
      outputHash: successfulResponse.outputHash,
      usage: successfulResponse.usage,
    });
    const record = store.successfulAssessmentRecord({
      assessmentId: "assessment-1",
      actorStableId: "ou-user-1",
      scopeStableRef: "model:model-1",
      requestedAt: "2026-07-23T00:00:00.000Z",
      completedAt: "2026-07-23T00:00:01.000Z",
      requestEnvelope,
      canonicalRequestJson,
      inputHash: sha256Hex(canonicalRequestJson),
      response: successfulResponse,
    });
    await store.saveAssessment(record);
    const persisted = JSON.parse(await readFile(path.join(directory, "assessments", "assessment-1.json"), "utf8")) as AIAssessmentRetentionRecord;
    assert.equal(persisted.metadata?.actorStableId, "ou-user-1");
    assert.equal(persisted.metadata?.inputHash, sha256Hex(canonicalRequestJson));
    assert.equal(persisted.metadata?.outputHash, successfulResponse.outputHash);
    assert.equal(JSON.stringify(persisted).includes(canonicalRequestJson), false);
    const raw = decryptAIRawContent({ assessmentId: "assessment-1", encrypted: persisted.encryptedRawContent!, key });
    assert.equal(JSON.parse(raw).request.schemaVersion, "ai-request/v1");
    assert.match(await readFile(path.join(directory, "audit.jsonl"), "utf8"), /"resultCode":"SUCCESS"/);
  } finally {
    if (previous.dataDir === undefined) delete process.env.AI_RETENTION_DATA_DIR;
    else process.env.AI_RETENTION_DATA_DIR = previous.dataDir;
    if (previous.key === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_BASE64 = previous.key;
    if (previous.keyVersion === undefined) delete process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION;
    else process.env.AI_RETENTION_ENCRYPTION_KEY_VERSION = previous.keyVersion;
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI 原始内容只加密保存；删除立即隐藏、24h 主存储与 30d 备份经删除回读后才标记完成", async () => {
  const now = new Date("2026-07-23T00:00:00Z");
  const key = randomBytes(32);
  const encrypted = encryptAIRawContent({ assessmentId: "assessment-1", plaintext: "sensitive body", key, keyVersion: "key-v1" });
  assert.equal(JSON.stringify(encrypted).includes("sensitive body"), false);
  assert.equal(decryptAIRawContent({ assessmentId: "assessment-1", encrypted, key }), "sensitive body");
  const record: AIAssessmentRetentionRecord = {
    policyVersion: AI_RETENTION_POLICY_VERSION,
    visibility: "VISIBLE",
    encryptedRawContent: encrypted,
    rawContentCreatedAt: now.toISOString(),
    semanticContentCreatedAt: now.toISOString(),
    semanticContent: { findings: [], recommendations: [], assumptions: [], uncoveredInformation: [], evidenceRefs: [] },
    acceptedArtifactProvenance: {
      assessmentId: "assessment-1", modelDescriptor: modelList(), selectedRecommendation: { code: "R1" }, evidenceContentHashes: ["a".repeat(64)], humanDiff: { changed: true }, artifactStableRefs: ["patch:1"], retainedWithArtifact: true,
    },
  };
  const deleted = requestAIAssessmentDeletion({ record, requestedBy: "user-1", now });
  assert.equal(deleted.record.visibility, "HIDDEN");
  assert.ok(deleted.record.encryptedRawContent);
  const purged = sweepAIAssessmentRetention({ record: deleted.record, now: new Date(now.getTime() + 24 * 60 * 60 * 1_000) });
  assert.equal(purged.record.encryptedRawContent, undefined);
  assert.equal(purged.record.semanticContent, undefined);
  assert.ok(purged.record.acceptedArtifactProvenance);
  const backupDue = sweepAIAssessmentRetention({ record: purged.record, now: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000) });
  assert.equal(backupDue.record.deletionTombstone?.backupPurgedAt, undefined);
  assert.equal(backupDue.record.deletionTombstone?.backupPurgeState, "PENDING");
  const failed = await purgeAIAssessmentBackups({
    record: backupDue.record,
    now: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
    adapter: { async purgeAssessmentBackups() {}, async verifyAssessmentBackupsAbsent() { return false; } },
  });
  assert.equal(failed.record.deletionTombstone?.backupPurgeState, "FAILED");
  assert.equal(failed.record.deletionTombstone?.backupPurgedAt, undefined);
  const completed = await purgeAIAssessmentBackups({
    record: failed.record,
    now: new Date(now.getTime() + 31 * 24 * 60 * 60 * 1_000),
    adapter: { async purgeAssessmentBackups() {}, async verifyAssessmentBackupsAbsent() { return true; } },
  });
  assert.equal(completed.record.deletionTombstone?.backupPurgeState, "PURGED");
  assert.ok(completed.record.deletionTombstone?.backupPurgedAt);
});

test("保留矩阵分别执行 180天/1年/3年，到期不删除随产物来源", () => {
  const created = new Date("2020-01-01T00:00:00Z");
  const record: AIAssessmentRetentionRecord = {
    policyVersion: AI_RETENTION_POLICY_VERSION,
    visibility: "VISIBLE",
    rawContentCreatedAt: created.toISOString(),
    encryptedRawContent: encryptAIRawContent({ assessmentId: "a", plaintext: "raw", key: randomBytes(32), keyVersion: "v1" }),
    semanticContentCreatedAt: created.toISOString(),
    semanticContent: { findings: [], recommendations: [], assumptions: [], uncoveredInformation: [], evidenceRefs: [] },
    operationLogCreatedAt: created.toISOString(),
    operationLog: { action: "AI_CALL", resultCode: "OK" },
    metadata: {
      assessmentId: "a", actorStableId: "u", scopeStableRef: "m", modelDescriptor: modelList(), promptTemplateVersion: "p", promptTemplateHash: "a".repeat(64), schemaVersion: "ai-request/v1", allowlistPolicyVersion: "ai-provider/open006-v1", inputHash: "b".repeat(64), requestedAt: created.toISOString(), resultCode: "OK", state: "ACTIVE",
    },
    acceptedArtifactProvenance: { assessmentId: "a", modelDescriptor: modelList(), selectedRecommendation: {}, evidenceContentHashes: [], humanDiff: {}, artifactStableRefs: ["patch:1"], retainedWithArtifact: true },
  };
  const swept = sweepAIAssessmentRetention({ record, now: new Date("2024-01-02T00:00:00Z") });
  assert.equal(swept.record.encryptedRawContent, undefined);
  assert.equal(swept.record.semanticContent, undefined);
  assert.equal(swept.record.operationLog, undefined);
  assert.equal(swept.record.metadata, undefined);
  assert.ok(swept.record.acceptedArtifactProvenance);
});

test("全体公司用户获得 AI 评估/草稿能力，只有显式部署管理员获得 provider 配置能力", () => {
  const ordinary = feishuCapabilities("user-1", ["admin-1"]);
  assert.ok(ordinary.includes("ai.evaluate"));
  assert.ok(ordinary.includes("ai.patch_draft.create"));
  assert.ok(ordinary.includes("ai.rule_source_change_draft.create"));
  assert.equal(ordinary.includes("ai.provider_policy.manage"), false);
  assert.equal(feishuCapabilities("admin-1", ["admin-1"]).includes("ai.provider_policy.manage"), true);
});
