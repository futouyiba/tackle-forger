import assert from "node:assert/strict";
import test from "node:test";
import {
  commitExportPackage,
  validateLogicalTableRelations,
  type ExportCommitAdapter,
  type ExportCommitResult,
} from "../lib/config-export";

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
  stagedPath: "staged/" + workbook,
  targetPath: "target/" + workbook,
  expectedOriginalHash: "before",
}));

test("三表替换到第二张失败时回滚第一张且不替换第三张", async () => {
  const io = adapter("item.xlsx");
  const result = await commitExportPackage({
    profileId: "dev",
    packageId: "package:1",
    itemPartIds: ["part:rod"],
    idempotencyKey: "key:1",
    operations,
    adapter: io,
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(io.replaced, ["tackle.xlsx"]);
  assert.deepEqual(io.restored, ["tackle.xlsx"]);
  assert.deepEqual(result.rolledBackWorkbooks, ["tackle.xlsx"]);
});

test("导出提交使用幂等键，相同提交不重复插入或替换", async () => {
  const io = adapter();
  const first = await commitExportPackage({
    profileId: "dev",
    packageId: "package:1",
    itemPartIds: ["part:rod"],
    idempotencyKey: "key:same",
    operations,
    adapter: io,
  });
  const second = await commitExportPackage({
    profileId: "dev",
    packageId: "package:1",
    itemPartIds: ["part:rod"],
    idempotencyKey: "key:same",
    operations,
    adapter: io,
  });
  assert.equal(first.status, "committed");
  assert.deepEqual(second, first);
  assert.deepEqual(io.replaced, ["tackle.xlsx", "item.xlsx", "store.xlsx"]);
});

test("扩展部位提交在任何备份或文件替换前返回稳定错误", async () => {
  const io = adapter();
  await assert.rejects(() => commitExportPackage({
    profileId: "dev",
    packageId: "package:hook",
    itemPartIds: ["part:hook"],
    idempotencyKey: "key:hook",
    operations,
    adapter: io,
  }), (error) => (
    error instanceof Error
    && "code" in error
    && error.code === "ITEM_PART_NOT_ENABLED"
  ));
  assert.deepEqual(io.replaced, []);
  assert.deepEqual(io.restored, []);
});
