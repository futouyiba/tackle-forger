import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as configExportApi } from "../app/api/config-export/route";
import {
  CONFIG_PREVIEW_NOTICE,
  createConfigPreviewPackage,
} from "../lib/config-preview-package";
import {
  assertFormalConfigExportAllowed,
  assertProductionShapeConfigExportEnabled,
  ConfigExportStageError,
  formalConfigExportActionBlock,
  type FormalConfigExportAuthorization,
} from "../lib/config-export-stage";
import { commitExportPackage, type ExportCommitAdapter } from "../lib/config-export";
import { PHASE_ONE_CAPABILITIES } from "../lib/feishu-identity";
import { actionAvailability } from "../lib/interaction-contracts";
import { createSeedState } from "../lib/seed";

const FORMAL_AUTHORIZATION: FormalConfigExportAuthorization = {
  packageKind: "EXPORT_PACKAGE",
  publicationState: "FORMAL",
  formal: true,
  configIdBundleId: "bundle:test",
  configIdPolicyVersionId: "config-id:test",
  configTargetCatalogVersionId: "catalog:test",
  approvedFreshManifestId: "manifest:test",
  governanceLeaseId: "lease:test",
  fencingToken: "1",
  expectedOldOid: "a".repeat(40),
  protectedRefCasAvailable: true,
};

test("一期生成固定 CONFIG_PREVIEW/NON_FORMAL 契约且不泄漏生产身份或文件名", () => {
  const snapshot = createSeedState().configurationSnapshots[0]!;
  const frozenBefore = structuredClone(snapshot);
  const preview = createConfigPreviewPackage({
    packageId: "preview:test",
    workspaceId: "workspace:test",
    snapshots: [snapshot],
    createdAt: "2026-07-23T00:00:00.000Z",
  });

  assert.equal(preview.packageKind, "CONFIG_PREVIEW");
  assert.equal(preview.publicationState, "NON_FORMAL");
  assert.equal(preview.formal, false);
  assert.equal(preview.notice, CONFIG_PREVIEW_NOTICE);
  assert.deepEqual(preview.files, [{
    fileName: "configuration.preview.report.json",
    kind: "DIFF_REPORT",
    notice: CONFIG_PREVIEW_NOTICE,
  }]);
  assert.equal(preview.objects.length, 4);
  assert.equal(preview.objects.every((entry) => entry.numericId === null), true);
  assert.equal(preview.objects.every((entry) => entry.configNameKey === null), true);
  assert.equal(
    preview.objects.every((entry) =>
      entry.symbolicRef === `NON_FORMAL:${entry.modelId}:${entry.objectKind}`),
    true,
  );
  const serialized = JSON.stringify(preview);
  assert.doesNotMatch(serialized, /(?:^|[/"])tackle\.xlsx/i);
  assert.doesNotMatch(serialized, /(?:^|[/"])item\.xlsx/i);
  assert.doesNotMatch(serialized, /(?:^|[/"])store\.xlsx/i);
  assert.doesNotMatch(serialized, /rod_qinglu_15_fast|301499001/);
  assert.deepEqual(snapshot, frozenBefore);
});

test("一期服务端阶段门禁优先于 Capability，PHASE_ONE 能力集不授予正式导出", () => {
  const capabilities = new Set<string>(PHASE_ONE_CAPABILITIES);
  assert.equal(capabilities.has("config.export.commit"), false);
  assert.equal(capabilities.has("snapshot.export"), false);
  const block = formalConfigExportActionBlock({
    stage: "PHASE_ONE",
    formalExportRuntimeEnabled: true,
  });
  assert.equal(block?.code, "CONFIG_EXPORT_PHASE_DISABLED");
  assert.throws(
    () => assertProductionShapeConfigExportEnabled({
      stage: "PHASE_ONE",
      formalExportRuntimeEnabled: true,
    }),
    (error) => error instanceof ConfigExportStageError
      && error.code === "CONFIG_EXPORT_PHASE_DISABLED",
  );

  const previousStage = process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE;
  const previousRuntime = process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED;
  try {
    process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE = "PHASE_ONE";
    process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED = "true";
    const availability = actionAvailability(
      "commit_config_export",
      ["config.export.commit"],
    );
    assert.equal(availability.enabled, false);
    assert.equal(availability.disabledReasonCode, "CONFIG_EXPORT_PHASE_DISABLED");
  } finally {
    if (previousStage === undefined) {
      delete process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE;
    } else {
      process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE = previousStage;
    }
    if (previousRuntime === undefined) {
      delete process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED;
    } else {
      process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED = previousRuntime;
    }
  }
});

test("1.5 期骨架只有阶段、运行时和完整治理证据同时具备才开放", () => {
  assert.throws(
    () => assertFormalConfigExportAllowed(FORMAL_AUTHORIZATION, {
      stage: "PHASE_ONE",
      formalExportRuntimeEnabled: true,
    }),
    (error) => error instanceof ConfigExportStageError
      && error.code === "CONFIG_EXPORT_PHASE_DISABLED",
  );
  assert.throws(
    () => assertFormalConfigExportAllowed(FORMAL_AUTHORIZATION, {
      stage: "PHASE_ONE_POINT_FIVE",
      formalExportRuntimeEnabled: false,
    }),
    (error) => error instanceof ConfigExportStageError
      && error.code === "CONFIG_EXPORT_RUNTIME_NOT_READY",
  );
  assert.throws(
    () => assertFormalConfigExportAllowed(undefined, {
      stage: "PHASE_ONE_POINT_FIVE",
      formalExportRuntimeEnabled: true,
    }),
    (error) => error instanceof ConfigExportStageError
      && error.code === "CONFIG_EXPORT_NON_FORMAL_PACKAGE",
  );
  assert.throws(
    () => assertFormalConfigExportAllowed({
      ...FORMAL_AUTHORIZATION,
      configIdBundleId: "",
    }, {
      stage: "PHASE_ONE_POINT_FIVE",
      formalExportRuntimeEnabled: true,
    }),
    (error) => error instanceof ConfigExportStageError
      && error.code === "CONFIG_EXPORT_FORMAL_IDENTITY_MISSING",
  );
  assert.throws(
    () => assertFormalConfigExportAllowed({
      ...FORMAL_AUTHORIZATION,
      governanceLeaseId: "",
    }, {
      stage: "PHASE_ONE_POINT_FIVE",
      formalExportRuntimeEnabled: true,
    }),
    (error) => error instanceof ConfigExportStageError
      && error.code === "CONFIG_EXPORT_GOVERNANCE_EVIDENCE_MISSING",
  );
  assert.doesNotThrow(() => assertFormalConfigExportAllowed(
    FORMAL_AUTHORIZATION,
    {
      stage: "PHASE_ONE_POINT_FIVE",
      formalExportRuntimeEnabled: true,
    },
  ));
});

test("直接调用底层 commit_config_export 在一期无任何文件副作用", async () => {
  const previousStage = process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE;
  const previousRuntime = process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED;
  const sideEffects: string[] = [];
  const adapter: ExportCommitAdapter = {
    async getCurrentHash() { sideEffects.push("hash"); return "before"; },
    async createBackup() { sideEffects.push("backup"); return "backup"; },
    async replaceFile() { sideEffects.push("replace"); return "after"; },
    async restoreBackup() { sideEffects.push("restore"); },
    async findCommittedResult() { sideEffects.push("find"); return undefined; },
    async recordCommittedResult() { sideEffects.push("record"); },
  };
  try {
    process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE = "PHASE_ONE";
    process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED = "true";
    await assert.rejects(
      () => commitExportPackage({
        profileId: "dev",
        packageId: "preview:test",
        snapshots: [createSeedState().configurationSnapshots[0]!],
        idempotencyKey: "phase-one",
        operations: [{
          workbook: "production.xlsx",
          stagedPath: "staged",
          targetPath: "target",
          expectedOriginalHash: "before",
        }],
        adapter,
        formalAuthorization: FORMAL_AUTHORIZATION,
      }),
      (error) => error instanceof ConfigExportStageError
        && error.code === "CONFIG_EXPORT_PHASE_DISABLED",
    );
    assert.deepEqual(sideEffects, []);
  } finally {
    if (previousStage === undefined) delete process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE;
    else process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE = previousStage;
    if (previousRuntime === undefined) {
      delete process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED;
    } else {
      process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED = previousRuntime;
    }
  }
});

test("直接 API 绕过在一期返回稳定 403 阶段阻断", async () => {
  const previous = {
    trust: process.env.FEISHU_TRUST_PROXY_HEADERS,
    secret: process.env.FEISHU_PROXY_SHARED_SECRET,
    tenant: process.env.FEISHU_TENANT_KEY,
    stage: process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE,
    runtime: process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED,
  };
  try {
    process.env.FEISHU_TRUST_PROXY_HEADERS = "true";
    process.env.FEISHU_PROXY_SHARED_SECRET = "proxy-secret";
    process.env.FEISHU_TENANT_KEY = "tenant";
    process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE = "PHASE_ONE";
    process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED = "true";
    const response = await configExportApi(new NextRequest(
      "http://localhost/api/config-export",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-feishu-tenant-key": "tenant",
          "x-feishu-open-id": "planner",
          "x-tf-proxy-secret": "proxy-secret",
        },
        body: JSON.stringify({
          action: "commit",
          formalAuthorization: FORMAL_AUTHORIZATION,
        }),
      },
    ));
    const payload = await response.json() as { code?: string };
    assert.equal(response.status, 403);
    assert.equal(payload.code, "CONFIG_EXPORT_PHASE_DISABLED");
  } finally {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("FEISHU_TRUST_PROXY_HEADERS", previous.trust);
    restore("FEISHU_PROXY_SHARED_SECRET", previous.secret);
    restore("FEISHU_TENANT_KEY", previous.tenant);
    restore("TACKLE_FORGER_PRODUCT_DELIVERY_STAGE", previous.stage);
    restore("TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED", previous.runtime);
  }
});

test("一期 UI 不暴露目录绑定、生产文件或正式提交入口", async () => {
  const source = await readFile(
    new URL("../app/BrowserConfigExportWorkbench.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /CONFIG_PREVIEW/);
  assert.match(source, /NON_FORMAL/);
  assert.match(source, /正式提交禁用/);
  assert.doesNotMatch(source, /commitBrowserExport|chooseAndSaveDirectory|showDirectoryPicker/);
  assert.doesNotMatch(source, /tackle\.xlsx|item\.xlsx|store\.xlsx/);
  assert.doesNotMatch(source, /人工搬运 Manifest|恢复型提交/);
});
