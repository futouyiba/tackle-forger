import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  commitBrowserExportFromHandle,
  previewBrowserExportFromHandles,
  type BrowserDirectoryHandle,
  type BrowserFileHandle,
  type LocalExportTargetBinding,
} from "../lib/browser-config-export";
import type { ConfigExportMapping } from "../lib/config-export-mapping";
import { createSeedState } from "../lib/seed";
import { deterministicHash } from "../lib/rule-kernel";

function toBytes(data: BufferSource | Blob | string): Promise<Uint8Array> | Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Blob) return data.arrayBuffer().then((value) => new Uint8Array(value));
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return new Uint8Array(data.slice(0));
}

class MemoryFileHandle implements BrowserFileHandle {
  readonly kind = "file" as const;
  constructor(public name: string, private bytes: Uint8Array) {}
  async getFile(): Promise<File> {
    const current = this.bytes.slice();
    return { arrayBuffer: async () => current.buffer.slice(0) } as File;
  }
  async createWritable() {
    let pending = this.bytes;
    return {
      write: async (data: BufferSource | Blob | string) => { pending = await toBytes(data); },
      close: async () => { this.bytes = pending.slice(); },
    };
  }
  value() { return this.bytes.slice(); }
  replace(bytes: Uint8Array) { this.bytes = bytes.slice(); }
}

class MemoryDirectoryHandle implements BrowserDirectoryHandle {
  readonly kind = "directory" as const;
  readonly directories = new Map<string, MemoryDirectoryHandle>();
  readonly files = new Map<string, MemoryFileHandle>();
  constructor(public name: string) {}
  async queryPermission() { return "granted" as const; }
  async requestPermission() { return "granted" as const; }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw new Error(`目录 ${name} 不存在`);
    const created = new MemoryDirectoryHandle(name);
    this.directories.set(name, created);
    return created;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw new Error(`文件 ${name} 不存在`);
    const created = new MemoryFileHandle(name, new Uint8Array());
    this.files.set(name, created);
    return created;
  }
}

function workbook(sheet: string, rows: unknown[][]) {
  const value = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(value, XLSX.utils.aoa_to_sheet(rows), sheet);
  return new Uint8Array(XLSX.write(value, { type: "buffer", bookType: "xlsx" }));
}

function mapping(): ConfigExportMapping {
  const table = (workbookName: string, sheet: string) => ({
    workbook: workbookName,
    sheet,
    required: true,
    stableBusinessKey: "id",
    dataStartRow: 5,
  });
  const row = (rowMappingId: string, logicalTable: string, id: number, name: string, extra = {}) => ({
    rowMappingId,
    logicalTable,
    businessKeyField: "id",
    configNameKeyField: "name",
    columns: {
      id: { kind: "constant" as const, value: id },
      name: { kind: "constant" as const, value: name },
      ...extra,
    },
  });
  return {
    mappingId: "mapping:browser-v1",
    version: "1",
    enumReferenceField: "name",
    logicalTables: {
      rods: table("tackle.xlsx", "Rods"),
      item: table("item.xlsx", "Item"),
      goods_basic: table("store.xlsx", "GoodsBasic"),
      store_buy: table("store.xlsx", "StoreBuy"),
    },
    rows: [
      row("rod", "rods", 1, "rod_one", { drag: { kind: "snapshot_value" as const, key: "杆最大拉力kgf" } }),
      row("item", "item", 2, "item_one"),
      row("goods", "goods_basic", 3, "goods_one", { item_id: { kind: "constant" as const, value: "item_one" } }),
      row("store", "store_buy", 4, "store_one", {
        goods_id: { kind: "constant" as const, value: "goods_one" },
        enabled: { kind: "target_existing_or_constant" as const, value: false },
      }),
    ],
  };
}

async function fixture(storeName = "store_one") {
  const root = new MemoryDirectoryHandle("configs-dev");
  root.files.set("config.toml", new MemoryFileHandle("config.toml", new TextEncoder().encode(`
[tables.rods]
sheet = ["Rods"]
workbook = "tackle.xlsx"
enums = []
[tables.item]
sheet = ["Item"]
workbook = "item.xlsx"
enums = []
[tables.goods_basic]
sheet = ["GoodsBasic"]
workbook = "store.xlsx"
enums = [{ field = "item_id", table = "item" }]
[tables.store_buy]
sheet = ["StoreBuy"]
workbook = "store.xlsx"
enums = [{ field = "goods_id", table = "goods_basic" }]
`)));
  const xlsx = await root.getDirectoryHandle("xlsx", { create: true });
  xlsx.files.set("tackle.xlsx", new MemoryFileHandle("tackle.xlsx", workbook("Rods", [
    ["INT64", "STRING", "FLOAT"], ["id", "name", "drag"], ["ID", "名称", "拉力"], [], [1, "rod_one", 1],
  ])));
  xlsx.files.set("item.xlsx", new MemoryFileHandle("item.xlsx", workbook("Item", [
    ["INT64", "STRING"], ["id", "name"], ["ID", "名称"], [], [2, "item_one"],
  ])));
  const storeBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(storeBook, XLSX.utils.aoa_to_sheet([
    ["INT64", "STRING", "STRING"], ["id", "name", "item_id"], ["ID", "名称", "物品"], [], [3, "goods_one", "item_one"],
  ]), "GoodsBasic");
  XLSX.utils.book_append_sheet(storeBook, XLSX.utils.aoa_to_sheet([
    ["INT64", "STRING", "STRING", "BOOL"], ["id", "name", "goods_id", "enabled"], ["ID", "名称", "商品", "上架"], [], [4, storeName, "goods_one", true],
  ]), "StoreBuy");
  xlsx.files.set("store.xlsx", new MemoryFileHandle("store.xlsx", new Uint8Array(XLSX.write(storeBook, { type: "buffer", bookType: "xlsx" }))));
  const binding: LocalExportTargetBinding = {
    bindingId: "binding:dev:1001",
    environmentId: "dev",
    channelKey: "1001",
    targetKind: "DEFAULT_1001",
    directoryHandleStorageKey: "directory:test",
    userLabel: "dev / 1001",
    mappingId: "mapping:browser-v1",
    mappingVersion: "1",
  };
  return { root, xlsx, binding };
}

test("浏览器预览从环境根 config.toml 生成三表差异，提交后回读并保留 StoreBuy.enabled", async () => {
  const current = await fixture();
  const snapshot = createSeedState().configurationSnapshots[0]!;
  const preview = await previewBrowserExportFromHandles({
    binding: current.binding,
    targetRoot: current.root,
    configRoot: current.root,
    packageId: "browser-package-1",
    mapping: mapping(),
    snapshots: [snapshot],
    createdAt: "2026-07-21T00:00:00.000Z",
  });
  assert.equal(preview.status, "ready");
  assert.equal(preview.operations.length, 3);
  const manifest = await commitBrowserExportFromHandle({
    root: current.root,
    binding: current.binding,
    preview,
    snapshots: [snapshot],
  });
  assert.equal(manifest.operations.every((operation) => operation.state === "verified"), true);
  const store = XLSX.read(current.xlsx.files.get("store.xlsx")!.value(), { type: "array" });
  assert.equal(store.Sheets.StoreBuy.D5.v, true);
});

test("ID 与 configNameKey 分裂命中时阻断目标，不产生可提交操作", async () => {
  const current = await fixture("different_name");
  const preview = await previewBrowserExportFromHandles({
    binding: current.binding,
    targetRoot: current.root,
    configRoot: current.root,
    packageId: "browser-package-split",
    mapping: mapping(),
    snapshots: [createSeedState().configurationSnapshots[0]],
  });
  assert.equal(preview.status, "blocked");
  assert.deepEqual(preview.operations, []);
  assert.ok(preview.issues.some((issue) => issue.code === "EXPORT_IDENTITY_SPLIT_MATCH"));
});

test("预览后源文件变化时恢复型提交拒绝覆盖", async () => {
  const current = await fixture();
  const snapshot = createSeedState().configurationSnapshots[0]!;
  const preview = await previewBrowserExportFromHandles({
    binding: current.binding,
    targetRoot: current.root,
    configRoot: current.root,
    packageId: "browser-package-conflict",
    mapping: mapping(),
    snapshots: [snapshot],
  });
  assert.equal(preview.status, "ready");
  const tackle = current.xlsx.files.get("tackle.xlsx")!;
  tackle.replace(new Uint8Array([...tackle.value(), 0]));
  await assert.rejects(() => commitBrowserExportFromHandle({
    root: current.root,
    binding: current.binding,
    preview,
    snapshots: [snapshot],
  }), /预览后已变化/);
});

test("扩展部位预览与提交在浏览器文件写入前 fail-closed", async () => {
  const current = await fixture();
  const snapshot = structuredClone(createSeedState().configurationSnapshots[0]);
  snapshot.projectionMatch.itemPartId = "part:hook";
  const content = structuredClone(snapshot);
  Reflect.deleteProperty(content, "contentHash");
  snapshot.contentHash = deterministicHash(content);
  const beforeFiles = Object.fromEntries(
    [...current.xlsx.files].map(([name, file]) => [name, [...file.value()]]),
  );
  await assert.rejects(() => previewBrowserExportFromHandles({
    binding: current.binding,
    targetRoot: current.root,
    configRoot: current.root,
    packageId: "browser-package-hook-preview",
    mapping: mapping(),
    snapshots: [snapshot],
  }), (error) => (
    error instanceof Error
    && "code" in error
    && error.code === "ITEM_PART_NOT_ENABLED"
  ));
  assert.deepEqual(
    Object.fromEntries([...current.xlsx.files].map(([name, file]) => [name, [...file.value()]])),
    beforeFiles,
  );

  const allowedPreview = await previewBrowserExportFromHandles({
    binding: current.binding,
    targetRoot: current.root,
    configRoot: current.root,
    packageId: "browser-package-hook-commit",
    mapping: mapping(),
    snapshots: [createSeedState().configurationSnapshots[0]],
  });
  const beforeDirectories = [...current.root.directories.keys()];
  await assert.rejects(() => commitBrowserExportFromHandle({
    root: current.root,
    binding: current.binding,
    preview: allowedPreview,
    snapshots: [snapshot],
  }), (error) => (
    error instanceof Error
    && "code" in error
    && error.code === "ITEM_PART_NOT_ENABLED"
  ));
  assert.deepEqual([...current.root.directories.keys()], beforeDirectories);
});
