import assert from "node:assert/strict";
import test from "node:test";
import {
  commitExportPackage,
  validateLogicalTableRelations,
  type ExportCommitAdapter,
  type ExportCommitResult,
} from "../lib/config-export";
import { deterministicHash } from "../lib/rule-kernel";
import { createSeedState } from "../lib/seed";
import type {
  FormalConfigExportAuthorization,
  FormalConfigExportContext,
  FormalConfigExportEvidenceVerifier,
} from "../lib/config-export-stage";
import { formalConfigExportContextHash } from "../lib/config-export-stage";

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
  async verify(_authorization, context) {
    return {
      verified: true,
      manifestSetHash: "manifest-set:test",
      verifiedAt: "2026-07-23T00:00:00.000Z",
      contextHash: formalConfigExportContextHash(context),
    };
  },
};

function exportSnapshot(itemPartId = "part:rod") {
  const snapshot = structuredClone(createSeedState().configurationSnapshots[0]!);
  snapshot.projectionMatch.itemPartId = itemPartId;
  const content = structuredClone(snapshot);
  Reflect.deleteProperty(content, "contentHash");
  snapshot.contentHash = deterministicHash(content);
  return snapshot;
}

test("配置表枚举关系未声明按 id/name 解析时阻止而不猜测", () => {
  const issues = validateLogicalTableRelations({
    tables: [
      {
        logicalName: "store_buy",
        workbook: "store.xlsx",
        sheet: "StoreBuy",
        keyField: "id",
        rows: [{ excelRow: 5, values: { id: "buy:1", goods_id: "goods:1" } }],
      },
      {
        logicalName: "goods_basic",
        workbook: "store.xlsx",
        sheet: "GoodsBasic",
        keyField: "id",
        rows: [{ excelRow: 5, values: { id: "goods:1", name: "商品1" } }],
      },
    ],
    relations: [{
      sourceLogicalTable: "store_buy",
      field: "goods_id",
      targetLogicalTables: ["goods_basic"],
      allowCommaSeparatedTargets: false,
    }],
  });
  assert.equal(issues[0].code, "ENUM_RESOLUTION_POLICY_MISSING");
});

test("StoreBuy 断链精确定位 workbook/sheet/行/字段", () => {
  const issues = validateLogicalTableRelations({
    tables: [
      {
        logicalName: "store_buy",
        workbook: "store.xlsx",
        sheet: "StoreBuy",
        keyField: "id",
        rows: [{ excelRow: 8, values: { id: "buy:1", goods_id: "missing" } }],
      },
      {
        logicalName: "goods_basic",
        workbook: "store.xlsx",
        sheet: "GoodsBasic",
        keyField: "id",
        rows: [{ excelRow: 5, values: { id: "goods:1" } }],
      },
    ],
    relations: [{
      sourceLogicalTable: "store_buy",
      field: "goods_id",
      targetLogicalTables: ["goods_basic"],
      referenceField: "id",
      allowCommaSeparatedTargets: false,
    }],
  });
  assert.equal(issues[0].code, "EXPORT_ENUM_REFERENCE_BROKEN");
  assert.equal(issues[0].workbook, "store.xlsx");
  assert.equal(issues[0].sheet, "StoreBuy");
  assert.equal(issues[0].excelRow, 8);
  assert.equal(issues[0].parameterKey, "goods_id");
});

function adapter(failWorkbook?: string): ExportCommitAdapter & {
  restored: string[];
  replaced: string[];
} {
  const committed = new Map<string, ExportCommitResult>();
  const result = {
    restored: [] as string[],
    replaced: [] as string[],
    async getCurrentHash() { return "before"; },
    async createBackup(targetPath: string) { return targetPath + ".backup"; },
    async replaceFile(_stagedPath: string, targetPath: string) {
      const workbook = targetPath.split("/").at(-1)!;
      if (workbook === failWorkbook) throw new Error("模拟第二张表替换失败");
      result.replaced.push(workbook);
      return "after-" + workbook;
    },
    async restoreBackup(_backupPath: string, targetPath: string) {
      result.restored.push(targetPath.split("/").at(-1)!);
    },
    async findCommittedResult(key: string) { return committed.get(key); },
    async recordCommittedResult(key: string, value: ExportCommitResult) {
      committed.set(key, structuredClone(value));
    },
  };
  return result;
}

const operations = ["tackle.xlsx", "item.xlsx", "store.xlsx"].map((workbook) => ({
  workbook,
  targetRef: workbook,
  stagedPath: "staged/" + workbook,
  targetPath: "target/" + workbook,
  expectedOriginalHash: "before",
  stagedHash: `staged-hash:${workbook}`,
}));

function formalContext(
  snapshot: ReturnType<typeof exportSnapshot>,
  packageId: string,
): FormalConfigExportContext {
  return {
    packageId,
    profileId: "dev",
    environmentId: "dev",
    channelKey: "1001",
    mappingId: "mapping:test",
    mappingVersion: "1",
    snapshots: [{
      snapshotId: snapshot.id,
      snapshotHash: snapshot.contentHash,
    }],
    operations: operations.map((operation) => ({
      workbook: operation.workbook,
      targetRef: operation.targetRef,
      expectedOriginalHash: operation.expectedOriginalHash,
      stagedHash: operation.stagedHash,
    })),
  };
}

function formalTargetContext(channelKey = "1001") {
  return {
    environmentId: "dev",
    channelKey,
    mappingId: "mapping:test",
    mappingVersion: "1",
  };
}

test("三表替换到第二张失败时回滚第一张且不替换第三张", async () => {
  const io = adapter("item.xlsx");
  const snapshot = exportSnapshot();
  const result = await commitExportPackage({
    profileId: "dev",
    packageId: "package:1",
    snapshots: [snapshot],
    idempotencyKey: "key:1",
    operations,
    adapter: io,
    formalAuthorization: FORMAL_AUTHORIZATION,
    formalAuthorizationVerifier: FORMAL_VERIFIER,
    formalTargetContext: formalTargetContext(),
  });
  assert.equal(result.status, "failed");
  assert.equal(
    result.formalEvidence.contextHash,
    formalConfigExportContextHash(formalContext(snapshot, "package:1")),
  );
  assert.equal(result.formalEvidence.governanceLeaseId, "lease:test");
  assert.equal(result.formalEvidence.fencingToken, "1");
  assert.equal(result.formalEvidence.expectedOldOid, "a".repeat(40));
  assert.deepEqual(io.replaced, ["tackle.xlsx"]);
  assert.deepEqual(io.restored, ["tackle.xlsx"]);
  assert.deepEqual(result.rolledBackWorkbooks, ["tackle.xlsx"]);
});

test("导出提交使用幂等键，相同提交不重复插入或替换", async () => {
  const io = adapter();
  const snapshot = exportSnapshot();
  const first = await commitExportPackage({
    profileId: "dev",
    packageId: "package:1",
    snapshots: [snapshot],
    idempotencyKey: "key:same",
    operations,
    adapter: io,
    formalAuthorization: FORMAL_AUTHORIZATION,
    formalAuthorizationVerifier: FORMAL_VERIFIER,
    formalTargetContext: formalTargetContext(),
  });
  const second = await commitExportPackage({
    profileId: "dev",
    packageId: "package:1",
    snapshots: [snapshot],
    idempotencyKey: "key:same",
    operations,
    adapter: io,
    formalAuthorization: FORMAL_AUTHORIZATION,
    formalAuthorizationVerifier: undefined,
    formalTargetContext: formalTargetContext(),
  });
  assert.equal(first.status, "committed");
  assert.deepEqual(second, first);
  await assert.rejects(
    () => commitExportPackage({
      profileId: "dev",
      packageId: "package:1",
      snapshots: [snapshot],
      idempotencyKey: "key:same",
      operations,
      adapter: io,
      formalAuthorization: {
        ...FORMAL_AUTHORIZATION,
        governanceLeaseId: "lease:other",
      },
      formalAuthorizationVerifier: undefined,
      formalTargetContext: formalTargetContext(),
    }),
    /不同正式导出上下文或授权证据/,
  );
  assert.deepEqual(io.replaced, ["tackle.xlsx", "item.xlsx", "store.xlsx"]);
});

test("幂等恢复冻结正式上下文 hash，不允许换目标重放治理证据", async () => {
  const io = adapter();
  const snapshot = exportSnapshot();
  const context = formalContext(snapshot, "package:context");
  const first = await commitExportPackage({
    profileId: "dev",
    packageId: "package:context",
    snapshots: [snapshot],
    idempotencyKey: "key:context",
    operations,
    adapter: io,
    formalAuthorization: FORMAL_AUTHORIZATION,
    formalAuthorizationVerifier: FORMAL_VERIFIER,
    formalTargetContext: formalTargetContext(),
  });
  assert.equal(
    first.formalEvidence.contextHash,
    formalConfigExportContextHash(context),
  );
  await assert.rejects(
    () => commitExportPackage({
      profileId: "dev",
      packageId: "package:context",
      snapshots: [snapshot],
      idempotencyKey: "key:context",
      operations,
      adapter: io,
      formalAuthorization: FORMAL_AUTHORIZATION,
      formalAuthorizationVerifier: undefined,
      formalTargetContext: formalTargetContext("2001"),
    }),
    /相同幂等键绑定了不同正式导出上下文或授权证据/,
  );
  assert.deepEqual(io.replaced, ["tackle.xlsx", "item.xlsx", "store.xlsx"]);
});

test("扩展部位提交在任何备份或文件替换前返回稳定错误", async () => {
  const io = adapter();
  const snapshot = exportSnapshot("part:hook");
  await assert.rejects(() => commitExportPackage({
    profileId: "dev",
    packageId: "package:hook",
    snapshots: [snapshot],
    idempotencyKey: "key:hook",
    operations,
    adapter: io,
    formalAuthorization: FORMAL_AUTHORIZATION,
    formalAuthorizationVerifier: FORMAL_VERIFIER,
    formalTargetContext: formalTargetContext(),
  }), (error) => (
    error instanceof Error
    && "code" in error
    && error.code === "ITEM_PART_NOT_ENABLED"
  ));
  assert.deepEqual(io.replaced, []);
  assert.deepEqual(io.restored, []);
});
