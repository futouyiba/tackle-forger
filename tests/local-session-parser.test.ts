import assert from "node:assert/strict";
import { File } from "node:buffer";
import test from "node:test";

import * as XLSX from "xlsx";

import { CANONICAL_FEISHU_SHEET_REGISTRY } from "../lib/feishu-workbook";
import {
  LocalSessionParserError,
  LocalSessionWorkbookLoader,
} from "../lib/local-session-parser";
import { sha256Hex as pureSha256Hex } from "../lib/five-axis-hash";
import {
  handleLocalSessionParserRequest,
} from "../lib/local-session-parser-worker";
import type {
  LocalSessionParserRequest,
  LocalSessionParserWorkerResponse,
} from "../lib/local-session-parser-protocol";
import type {
  LocalSessionObjectUrlApi,
  LocalSessionParserWorker,
} from "../lib/local-session-resource-scope";

function dimensions(sheetId: string) {
  if (sheetId === "23CsXE") return { rows: 3, columns: 6 };
  if (sheetId === "27hboC") return { rows: 5, columns: 6 };
  if (sheetId === "28fQhg") return { rows: 2, columns: 3 };
  if (sheetId === "19XKzU") return { rows: 2, columns: 19 };
  if (sheetId === "25UnTC") return { rows: 2, columns: 23 };
  return { rows: 2, columns: 30 };
}

function canonicalWorkbookBytes(extraSheet?: string) {
  const workbook = XLSX.utils.book_new();
  for (const entry of CANONICAL_FEISHU_SHEET_REGISTRY) {
    const { rows, columns } = dimensions(entry.sheetId);
    const values = Array.from(
      { length: rows },
      () => Array.from({ length: columns }, () => null as unknown),
    );
    values[0]![0] = `fixture:${entry.sheetId}`;
    if (entry.sheetId === "23CsXE") {
      values[0] = ["机器ID（勿改）", "实体类型", "钓具部位", "词条名称", "缩写", "程序开发"];
      values[1] = ["affix_rod_0001", "RodAffix", "竿", "拉力强化", "拉强", "不需要"];
    }
    if (entry.sheetId === "27hboC") {
      values[0] = ["品质", "代码", "≥最小评分", "<最大评分", "最小价格系数", "最大价格系数"];
      values[1] = ["C/绿", "C", 0, 20, 0.8, 1];
      values[2] = ["B/蓝", "B", 20, 40, 1, 1.2];
      values[3] = ["A/紫", "A", 40, 65, 1.2, 1.5];
      values[4] = ["S/橙", "S", 65, 100, 1.5, 2];
    }
    if (entry.sheetId === "28fQhg") {
      values[0] = ["词条1", "词条2", "组合评分"];
      values[1] = ["affix_rod_0001", "affix_rod_0001", 0];
    }
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(values),
      entry.expectedName,
    );
  }
  if (extraSheet) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["extra"]]),
      extraSheet,
    );
  }
  const output = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  if (output instanceof ArrayBuffer) return output;
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

class FakeObjectUrls implements LocalSessionObjectUrlApi {
  created: string[] = [];
  revoked: string[] = [];
  failNextCreate = false;

  createObjectURL() {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("controlled object URL failure");
    }
    const url = `blob:test-${this.created.length + 1}`;
    this.created.push(url);
    return url;
  }

  revokeObjectURL(url: string) {
    this.revoked.push(url);
  }
}

type WorkerBehavior =
  | "manual"
  | "crash"
  | ((request: LocalSessionParserRequest) => Promise<LocalSessionParserWorkerResponse>);

class FakeWorker implements LocalSessionParserWorker {
  terminated = false;
  transferredByteLength: number | null = null;
  request: LocalSessionParserRequest | null = null;
  #behavior: WorkerBehavior;
  #listeners = {
    message: new Set<(event: MessageEvent<unknown>) => void>(),
    error: new Set<(event: ErrorEvent) => void>(),
    messageerror: new Set<(event: MessageEvent<unknown>) => void>(),
  };

  constructor(behavior: WorkerBehavior) {
    this.#behavior = behavior;
  }

  postMessage(message: unknown, transfer: Transferable[]) {
    const request = message as LocalSessionParserRequest;
    const cloned = structuredClone(request, { transfer }) as LocalSessionParserRequest;
    this.transferredByteLength = request.bytes.byteLength;
    this.request = cloned;
    if (this.#behavior === "manual") return;
    if (this.#behavior === "crash") {
      queueMicrotask(() => this.emitError("controlled worker crash"));
      return;
    }
    void this.#behavior(cloned).then((response) => {
      this.emitMessage(response);
    });
  }

  terminate() {
    this.terminated = true;
  }

  addEventListener(type: "message" | "error" | "messageerror", listener: never) {
    (this.#listeners[type] as Set<never>).add(listener);
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: never) {
    (this.#listeners[type] as Set<never>).delete(listener);
  }

  emitMessage(value: unknown) {
    for (const listener of this.#listeners.message) {
      listener({ data: value } as MessageEvent<unknown>);
    }
  }

  emitError(message: string) {
    for (const listener of this.#listeners.error) {
      listener({ message } as ErrorEvent);
    }
  }
}

function workerFactory(behaviors: WorkerBehavior[]) {
  const workers: FakeWorker[] = [];
  return {
    workers,
    create: () => {
      const behavior = behaviors[workers.length];
      if (!behavior) throw new Error("No configured fake worker behavior.");
      const worker = new FakeWorker(behavior);
      workers.push(worker);
      return worker;
    },
  };
}

function canonicalFile(name = "canonical.xlsx", extraSheet?: string) {
  return new File([new Uint8Array(canonicalWorkbookBytes(extraSheet))], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LocalSessionParserError);
    assert.equal(error.code, code);
    return true;
  });
}

async function waitForRequest(worker: FakeWorker) {
  for (let count = 0; count < 20 && !worker.request; count += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(worker.request, "worker request was not posted");
  return worker.request;
}

async function waitForWorker(factory: ReturnType<typeof workerFactory>, index: number) {
  for (let count = 0; count < 20; count += 1) {
    const worker = factory.workers[index];
    if (worker) {
      return worker;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`worker ${index} was not created`);
}

test("canonical File 保持不可变，ArrayBuffer 转移到 disposable worker，并只投影本地规则/模板 DTO", async () => {
  const urls = new FakeObjectUrls();
  const factory = workerFactory([handleLocalSessionParserRequest]);
  const loader = new LocalSessionWorkbookLoader({
    workerFactory: factory.create,
    objectUrlApi: urls,
  });
  const file = canonicalFile();
  const original = new Uint8Array(await file.arrayBuffer());
  const ready = await loader.open(file);

  assert.equal(factory.workers[0]!.transferredByteLength, 0, "main-thread buffer must detach");
  assert.equal(factory.workers[0]!.terminated, true, "worker must terminate after one result");
  assert.equal(file.size, original.byteLength);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), original, "File must remain unchanged");
  assert.equal(ready.result.session.authority, "local");
  assert.equal(ready.result.session.source.kind, "local_excel");
  assert.equal(ready.result.workbook.contractVersion, "local-session-canonical-workbook/open009-v2");
  assert.equal(ready.result.workbook.semanticRevision.length, 8);
  assert.deepEqual(ready.result.workbook.editableDocument, ready.result.session.document);
  assert.equal("seriesDefinitions" in ready.result.workbook, false);
  assert.equal("qualityDraft" in ready.result.workbook, false);
  assert.equal("pricingDraft" in ready.result.workbook, false);
  assert.equal("workspaceId" in ready.result.workbook, false);
  assert.equal("configurationSnapshots" in ready.result.workbook, false);
  assert.deepEqual(loader.readyResourceSnapshot(), {
    generation: ready.generation,
    resourceHandle: ready.resourceHandle,
    disposed: false,
    aborted: false,
    workerOwned: false,
    bufferOwnership: "transferred",
    objectUrlCount: 1,
    parserCacheEntries: 1,
    timeoutCount: 0,
  });
  assert.deepEqual(urls.revoked, []);
});

test("operationId/resourceHandle 碰撞与 worker 身份错配均 fail-closed", async () => {
  const urls = new FakeObjectUrls();
  const duplicateIds = new (
    await import("../lib/local-session-operation-identity")
  ).LocalSessionIdentityAllocator({ createId: () => "duplicate" });
  const collisionFactory = workerFactory([handleLocalSessionParserRequest]);
  const collisionLoader = new LocalSessionWorkbookLoader({
    workerFactory: collisionFactory.create,
    objectUrlApi: urls,
    identityAllocator: duplicateIds,
  });
  await collisionLoader.open(canonicalFile("first-identity.xlsx"));
  await assert.rejects(
    collisionLoader.open(canonicalFile("second-identity.xlsx")),
    /identity collided/,
  );

  const mismatchFactory = workerFactory(["manual"]);
  const mismatchLoader = new LocalSessionWorkbookLoader({
    workerFactory: mismatchFactory.create,
    objectUrlApi: new FakeObjectUrls(),
  });
  const pending = mismatchLoader.open(canonicalFile("mismatch.xlsx"));
  const worker = await waitForWorker(mismatchFactory, 0);
  const request = await waitForRequest(worker);
  const valid = await handleLocalSessionParserRequest(request);
  worker.emitMessage({
    ...valid,
    operationId: `${request.operationId}:wrong`,
  });
  await rejectsCode(pending, "LOCAL_SESSION_RESOURCE_IDENTITY_MISMATCH");
  assert.equal(mismatchLoader.ready(), null);
  assert.equal(worker.terminated, true);
});

test("非 secure context 缺少 SubtleCrypto 时使用纯浏览器 SHA-256 fallback", async () => {
  const urls = new FakeObjectUrls();
  const factory = workerFactory([handleLocalSessionParserRequest]);
  const file = canonicalFile("http-fallback.xlsx");
  const bytes = await file.arrayBuffer();
  const expected = pureSha256Hex(new Uint8Array(bytes));
  const nativeDigest = await crypto.subtle.digest("SHA-256", bytes);
  assert.equal(
    expected,
    Buffer.from(nativeDigest).toString("hex"),
    "fallback must match the secure-context SHA-256 path",
  );

  const loader = new LocalSessionWorkbookLoader({
    workerFactory: factory.create,
    objectUrlApi: urls,
    subtleCrypto: null,
  });
  const ready = await loader.open(file);
  assert.equal(ready.result.session.source.kind, "local_excel");
  if (ready.result.session.source.kind !== "local_excel") assert.fail("expected local Excel source");
  assert.equal(ready.result.session.source.contentSha256, expected);
  assert.equal(factory.workers[0]!.terminated, true);
});

test("legacy _TackleForgerState 和主线程文件大小预算 fail-closed，失败资源完整释放", async () => {
  const urls = new FakeObjectUrls();
  const factory = workerFactory([handleLocalSessionParserRequest]);
  const loader = new LocalSessionWorkbookLoader({
    workerFactory: factory.create,
    objectUrlApi: urls,
  });
  await rejectsCode(
    loader.open(canonicalFile("legacy.xlsx", "_TackleForgerState")),
    "XLSX_LEGACY_WORKSPACE_EXPORT_REJECTED",
  );
  assert.equal(loader.ready(), null);
  assert.equal(factory.workers[0]!.terminated, true);
  assert.deepEqual(urls.revoked, ["blob:test-1"]);

  let arrayBufferCalls = 0;
  const oversize = {
    name: "oversize.xlsx",
    size: 20 * 1024 * 1024 + 1,
    arrayBuffer: async () => {
      arrayBufferCalls += 1;
      return new ArrayBuffer(0);
    },
  } as unknown as import("../lib/local-session-parser").LocalSessionFile;
  await rejectsCode(loader.open(oversize), "XLSX_FILE_TOO_LARGE");
  assert.equal(arrayBufferCalls, 0);
  assert.equal(factory.workers.length, 1);
});

test("replace 只在新候选成功后原子替换；失败、worker crash 和 timeout 保留旧 ready", async () => {
  const urls = new FakeObjectUrls();
  const factory = workerFactory([
    handleLocalSessionParserRequest,
    async (request) => ({
      type: "local_canonical_workbook_failed",
      generation: request.generation,
      operationId: request.operationId,
      resourceHandle: request.resourceHandle,
      error: { code: "CONTROLLED_FAILURE", message: "controlled failure" },
    }),
    "crash",
    "manual",
    handleLocalSessionParserRequest,
  ]);
  const loader = new LocalSessionWorkbookLoader({
    workerFactory: factory.create,
    objectUrlApi: urls,
    timeoutMs: 10,
  });

  const first = await loader.open(canonicalFile("first.xlsx"));
  urls.failNextCreate = true;
  await rejectsCode(loader.open(canonicalFile("url-failed.xlsx")), "LOCAL_SESSION_PARSE_FAILED");
  assert.equal(loader.ready()?.generation, first.generation);
  assert.equal(loader.pendingResourceSnapshot(), null);

  await rejectsCode(loader.open(canonicalFile("failed.xlsx")), "CONTROLLED_FAILURE");
  assert.equal(loader.ready()?.generation, first.generation);
  assert.deepEqual(urls.revoked, ["blob:test-2"]);

  await rejectsCode(loader.open(canonicalFile("crash.xlsx")), "LOCAL_SESSION_WORKER_CRASHED");
  assert.equal(loader.ready()?.generation, first.generation);
  assert.deepEqual(urls.revoked, ["blob:test-2", "blob:test-3"]);

  await rejectsCode(loader.open(canonicalFile("timeout.xlsx")), "LOCAL_SESSION_PARSE_TIMEOUT");
  assert.equal(loader.ready()?.generation, first.generation);
  assert.deepEqual(urls.revoked, ["blob:test-2", "blob:test-3", "blob:test-4"]);

  const replacement = await loader.open(canonicalFile("replacement.xlsx"));
  assert.notEqual(replacement.generation, first.generation);
  assert.equal(loader.ready()?.result.session.source.kind, "local_excel");
  assert.ok(urls.revoked.includes(first.sourceObjectUrl), "old ready URL must be revoked");
  assert.equal(factory.workers.every((worker) => worker.terminated), true);
});

test("cancel、clear 和 late response 不可破坏旧 ready，且所有 candidate/ready 资源均 dispose", async () => {
  const urls = new FakeObjectUrls();
  const factory = workerFactory([
    handleLocalSessionParserRequest,
    "manual",
  ]);
  const loader = new LocalSessionWorkbookLoader({
    workerFactory: factory.create,
    objectUrlApi: urls,
    timeoutMs: 5_000,
  });
  const first = await loader.open(canonicalFile("ready.xlsx"));
  const pending = loader.open(canonicalFile("pending.xlsx"));
  const worker = await waitForWorker(factory, 1);
  const request = await waitForRequest(worker);

  loader.cancelPending();
  await rejectsCode(pending, "LOCAL_SESSION_PARSE_CANCELLED");
  assert.equal(loader.ready()?.generation, first.generation);
  assert.equal(worker.terminated, true);
  assert.ok(urls.revoked.includes("blob:test-2"));

  worker.emitMessage({
    type: "parsed_local_canonical_workbook",
    generation: request.generation,
    result: first.result,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(loader.ready()?.generation, first.generation, "late response must be ignored");

  loader.clear();
  assert.equal(loader.ready(), null);
  assert.ok(urls.revoked.includes(first.sourceObjectUrl));
  assert.equal(loader.pendingResourceSnapshot(), null);
  assert.equal(loader.readyResourceSnapshot(), null);
});
