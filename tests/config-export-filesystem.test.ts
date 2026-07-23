import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";
import { createSeedState } from "../lib/seed";
import type { ConfigExportMapping } from "../lib/config-export-mapping";
import {
  commitFilesystemExport,
  previewFilesystemExport,
} from "../lib/config-export-filesystem";
import type { ExportTargetProfile } from "../lib/interaction-contracts";
import type {
  FormalConfigExportAuthorization,
  FormalConfigExportEvidenceVerifier,
} from "../lib/config-export-stage";

process.env.TACKLE_FORGER_PRODUCT_DELIVERY_STAGE = "PHASE_ONE_POINT_FIVE";
process.env.TACKLE_FORGER_FORMAL_CONFIG_EXPORT_RUNTIME_ENABLED = "true";

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
const FORMAL_VERIFIER: FormalConfigExportEvidenceVerifier = {
  async verify() {
    return {
      verified: true,
      manifestSetHash: "manifest-set:test",
      verifiedAt: "2026-07-23T00:00:00.000Z",
    };
  },
};

function mapping(): ConfigExportMapping {
  return {
    mappingId: "mapping:filesystem-test",
    version: "1",
    enumReferenceField: "name",
    logicalTables: {
      rods: {
        workbook: "tackle.xlsx",
        sheet: "Rods",
        required: true,
        stableBusinessKey: "id",
        dataStartRow: 5,
      },
    },
    rows: [
      {
        rowMappingId: "rod",
        logicalTable: "rods",
        businessKeyField: "id",
        configNameKeyField: "name",
        columns: {
          id: { kind: "constant", value: 301499001 },
          name: { kind: "constant", value: "rod_qinglu_15_fast" },
          drag: { kind: "snapshot_value", key: "杆最大拉力kgf", scale: 1000, precision: 0 },
        },
      },
    ],
  };
}

function workbookBytes() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["INT64", "STRING", "INT32"],
    ["id", "name", "drag"],
    ["ID", "名称", "拉力"],
    [null, null, null],
    [301499001, "rod_qinglu_15_fast", 1000],
  ]), "Rods");
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-export-"));
  const workbookRoot = path.join(root, "xlsx");
  await mkdir(workbookRoot, { recursive: true });
  await writeFile(path.join(root, "config.toml"), `
[tables.rods]
sheet = ["Rods"]
workbook = "tackle.xlsx"
enums = []
`);
  await writeFile(path.join(workbookRoot, "tackle.xlsx"), workbookBytes());
  const profile: ExportTargetProfile = {
    profileId: "profile:test",
    label: "测试",
    executorKind: "server_mounted_workspace",
    projectRoot: root,
    relativeWorkbookRoot: "xlsx",
    configTomlPath: "config.toml",
    enabled: true,
    mappingId: "mapping:filesystem-test",
    mappingVersion: "1",
  };
  return { root, workbookRoot, profile };
}

test("文件系统执行器预览不改正式文件，确认后备份并提交，重试幂等", async () => {
  const current = await fixture();
  try {
    const snapshot = createSeedState().configurationSnapshots[0]!;
    const target = path.join(current.workbookRoot, "tackle.xlsx");
    const before = await readFile(target);
    const preview = await previewFilesystemExport({
      packageId: "package-1",
      profile: current.profile,
      mapping: mapping(),
      snapshot,
      createdAt: "2026-07-21T00:00:00.000Z",
    });
    assert.equal(preview.status, "ready");
    assert.deepEqual(await readFile(target), before);
    assert.equal(preview.operations.length, 1);

    const committed = await commitFilesystemExport({
      preview,
      snapshot,
      profile: current.profile,
      confirmationProfileId: current.profile.profileId,
      idempotencyKey: "commit-1",
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    assert.equal(committed.status, "committed");
    const workbook = XLSX.read(await readFile(target), { type: "buffer" });
    assert.equal(workbook.Sheets.Rods.B5.v, "rod_qinglu_15_fast");

    const retried = await commitFilesystemExport({
      preview,
      snapshot,
      profile: current.profile,
      confirmationProfileId: current.profile.profileId,
      idempotencyKey: "commit-1",
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    assert.deepEqual(retried, committed);
  } finally {
    assert.ok(current.root.startsWith(os.tmpdir()));
    await rm(current.root, { recursive: true, force: true });
  }
});

test("预览后正式文件变化触发 hash 冲突且不覆盖外部内容", async () => {
  const current = await fixture();
  try {
    const snapshot = createSeedState().configurationSnapshots[0]!;
    const target = path.join(current.workbookRoot, "tackle.xlsx");
    const preview = await previewFilesystemExport({
      packageId: "package-2",
      profile: current.profile,
      mapping: mapping(),
      snapshot,
    });
    assert.equal(preview.status, "ready");
    const externallyChanged = new Uint8Array([...(await readFile(target)), 0]);
    await writeFile(target, externallyChanged);
    const result = await commitFilesystemExport({
      preview,
      snapshot,
      profile: current.profile,
      confirmationProfileId: current.profile.profileId,
      idempotencyKey: "commit-2",
      canCommit: true,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: FORMAL_VERIFIER,
    });
    assert.equal(result.status, "conflict");
    assert.deepEqual(new Uint8Array(await readFile(target)), externallyChanged);
  } finally {
    assert.ok(current.root.startsWith(os.tmpdir()));
    await rm(current.root, { recursive: true, force: true });
  }
});

test("Profile 相对路径越过允许根目录时在读取前阻止", async () => {
  const current = await fixture();
  try {
    const snapshot = createSeedState().configurationSnapshots[0]!;
    const preview = await previewFilesystemExport({
      packageId: "package-escape",
      profile: { ...current.profile, relativeWorkbookRoot: "../outside" },
      mapping: mapping(),
      snapshot,
    });
    assert.equal(preview.status, "blocked");
    assert.ok(preview.issues.some((entry) => entry.code === "EXPORT_PROFILE_PATH_INVALID"));
  } finally {
    assert.ok(current.root.startsWith(os.tmpdir()));
    await rm(current.root, { recursive: true, force: true });
  }
});

test("提交时拒绝被篡改到允许目录之外的 Manifest 路径", async () => {
  const current = await fixture();
  try {
    const snapshot = createSeedState().configurationSnapshots[0]!;
    const preview = await previewFilesystemExport({
      packageId: "package-tampered",
      profile: current.profile,
      mapping: mapping(),
      snapshot,
    });
    assert.equal(preview.status, "ready");
    const tampered = {
      ...preview,
      operations: preview.operations.map((operation) => ({
        ...operation,
        targetPath: path.join(current.root, "outside.xlsx"),
      })),
    };
    await assert.rejects(
      () => commitFilesystemExport({
        preview: tampered,
        snapshot,
        profile: current.profile,
        confirmationProfileId: current.profile.profileId,
        idempotencyKey: "commit-tampered",
        canCommit: true,
        formalAuthorization: FORMAL_AUTHORIZATION,
        formalAuthorizationVerifier: FORMAL_VERIFIER,
      }),
      /越过允许目录/,
    );
  } finally {
    assert.ok(current.root.startsWith(os.tmpdir()));
    await rm(current.root, { recursive: true, force: true });
  }
});
