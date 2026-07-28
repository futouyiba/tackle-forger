import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as XLSX from "xlsx";

import {
  createInitialAppShellState,
  transitionAppShell,
} from "../lib/app-shell-state";
import { CANONICAL_FEISHU_SHEET_REGISTRY } from "../lib/feishu-workbook";
import {
  createLocalSessionModel,
  parseLocalSessionModel,
  reduceLocalSession,
  type LocalSessionDocument,
  type LocalSessionReducerState,
} from "../lib/local-session-contracts";
import {
  deriveLocalSessionTemplate,
} from "../lib/local-session-rules-kernel";
import {
  LocalSessionWorkbookLoader,
} from "../lib/local-session-parser";
import {
  handleLocalSessionParserRequest,
} from "../lib/local-session-parser-worker";
import type {
  LocalSessionParserRequest,
  LocalSessionParserWorkerResponse,
} from "../lib/local-session-parser-protocol";
import {
  SessionResourceScope,
  type LocalSessionObjectUrlApi,
  type LocalSessionParserWorker,
} from "../lib/local-session-resource-scope";
import { deterministicHash } from "../lib/rule-kernel";
import type { WorkspaceState } from "../lib/types";
import { ensureSharedWorkflowFields } from "../lib/workflow";

function dimensions(sheetId: string) {
  if (sheetId === "23CsXE") return { rows: 3, columns: 6 };
  if (sheetId === "27hboC") return { rows: 5, columns: 6 };
  if (sheetId === "28fQHg") return { rows: 2, columns: 3 };
  if (sheetId === "19XKzU") return { rows: 2, columns: 19 };
  if (sheetId === "25UnTC") return { rows: 2, columns: 23 };
  return { rows: 2, columns: 30 };
}

function canonicalWorkbookBytes() {
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
    if (entry.sheetId === "28fQHg") {
      values[0] = ["词条1", "词条2", "组合评分"];
      values[1] = ["affix_rod_0001", "affix_rod_0001", 0];
    }
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(values),
      entry.expectedName,
    );
  }
  const output = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  if (output instanceof ArrayBuffer) return output;
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

class AcceptanceWorker implements LocalSessionParserWorker {
  #listeners = {
    message: new Set<(event: MessageEvent<unknown>) => void>(),
    error: new Set<(event: ErrorEvent) => void>(),
    messageerror: new Set<(event: MessageEvent<unknown>) => void>(),
  };
  terminated = 0;

  postMessage(message: unknown, transfer: Transferable[]) {
    const request = structuredClone(
      message as LocalSessionParserRequest,
      { transfer },
    );
    void handleLocalSessionParserRequest(request).then(
      (response: LocalSessionParserWorkerResponse) => {
        for (const listener of this.#listeners.message) {
          listener({ data: response } as MessageEvent<unknown>);
        }
      },
    );
  }

  terminate() {
    this.terminated += 1;
  }

  addEventListener(type: "message" | "error" | "messageerror", listener: never) {
    (this.#listeners[type] as Set<never>).add(listener);
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: never) {
    (this.#listeners[type] as Set<never>).delete(listener);
  }
}

function fixture(): LocalSessionDocument {
  return {
    title: "P5 acceptance",
    notes: "",
    sourceIssues: [],
    parameters: [{
      id: "parameter:pull",
      key: "pull",
      label: "拉力",
      itemPart: "rod",
      unit: "kgf",
      precision: 2,
      notes: "",
    }],
    templates: [{
      id: "template:rod",
      name: "竿模板",
      itemPart: "rod",
      targetPullMinKgf: 1,
      nominalTargetPullKgf: 2,
      targetPullMaxKgf: 3,
      values: { pull: 2 },
      notes: "",
    }],
    rules: [{
      id: "rule:add",
      sourceKind: "layer",
      sourceId: "local",
      sourceName: "本地规则",
      sequence: 0,
      parameterKey: "pull",
      operation: "add",
      value: 1,
      condition: "",
      notes: "",
      enabled: true,
    }],
  };
}

test("instrumented real canonical open plus local create/edit/derive/undo/redo/clear has zero external or durable effects", async () => {
  const calls = {
    fetch: 0,
    sendBeacon: 0,
    webSocket: 0,
    indexedDb: 0,
    localStorage: 0,
    cacheStorage: 0,
    persistentLogs: 0,
  };
  const originalFetch = globalThis.fetch;
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const restorers: Array<() => void> = [];
  const patch = (target: object, key: PropertyKey, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value,
    });
    restorers.push(() => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    });
  };
  globalThis.fetch = (() => {
    calls.fetch += 1;
    throw new Error("local-only flow attempted fetch");
  }) as typeof fetch;
  patch(globalThis, "WebSocket", function ForbiddenWebSocket() {
    calls.webSocket += 1;
    throw new Error("local-only flow attempted WebSocket");
  });
  patch(globalThis, "indexedDB", {
    open() {
      calls.indexedDb += 1;
      throw new Error("local-only flow attempted IndexedDB");
    },
  });
  patch(globalThis, "localStorage", new Proxy({}, {
    get() {
      calls.localStorage += 1;
      throw new Error("local-only flow attempted localStorage");
    },
  }));
  patch(globalThis, "caches", new Proxy({}, {
    get() {
      calls.cacheStorage += 1;
      throw new Error("local-only flow attempted CacheStorage");
    },
  }));
  if (typeof navigator === "object") {
    patch(navigator, "sendBeacon", () => {
      calls.sendBeacon += 1;
      throw new Error("local-only flow attempted sendBeacon");
    });
  }
  console.log = () => { calls.persistentLogs += 1; };
  console.info = () => { calls.persistentLogs += 1; };
  console.warn = () => { calls.persistentLogs += 1; };
  console.error = () => { calls.persistentLogs += 1; };
  try {
    let state: LocalSessionReducerState = {
      status: "active",
      session: createLocalSessionModel({ kind: "temporary_workspace" }, fixture()),
    };
    const edited = {
      ...state.session.document,
      notes: "仅存在当前标签页内存",
    };
    state = reduceLocalSession(state, {
      type: "commit_local_edit",
      document: edited,
    });
    assert.equal(state.status, "active");
    assert.equal(deriveLocalSessionTemplate(state.session.document, "template:rod").values.pull, 3);
    state = reduceLocalSession(state, { type: "undo_local_edit" });
    state = reduceLocalSession(state, { type: "redo_local_edit" });
    state = reduceLocalSession(state, { type: "clear_local_session" });
    assert.deepEqual(state, { status: "empty" });

    const workers: AcceptanceWorker[] = [];
    const revoked: string[] = [];
    const loader = new LocalSessionWorkbookLoader({
      workerFactory: () => {
        const worker = new AcceptanceWorker();
        workers.push(worker);
        return worker;
      },
      objectUrlApi: {
        createObjectURL: () => "blob:p5-canonical",
        revokeObjectURL: (url) => { revoked.push(url); },
      },
    });
    const canonicalFile = new File(
      [new Uint8Array(canonicalWorkbookBytes())],
      "canonical-p5.xlsx",
      {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    );
    const ready = await loader.open(canonicalFile);
    assert.equal(ready.result.session.source.kind, "local_excel");
    assert.equal(ready.result.session.authority, "local");
    loader.clear();
    assert.deepEqual(workers.map((worker) => worker.terminated), [1]);
    assert.deepEqual(revoked, ["blob:p5-canonical"]);

    assert.deepEqual(calls, {
      fetch: 0,
      sendBeacon: 0,
      webSocket: 0,
      indexedDb: 0,
      localStorage: 0,
      cacheStorage: 0,
      persistentLogs: 0,
    });
  } finally {
    for (const restore of restorers.reverse()) restore();
    globalThis.fetch = originalFetch;
    Object.assign(console, originalConsole);
  }
});

test("local runtime dependency surface contains no browser persistence, socket, SQLite or logging sink", () => {
  const localRuntimeFiles = [
    "lib/local-session-contracts.ts",
    "lib/local-session-operation-identity.ts",
    "lib/local-session-parser-protocol.ts",
    "lib/local-session-parser-worker.ts",
    "lib/local-session-parser.ts",
    "lib/local-session-resource-scope.ts",
    "lib/local-session-rules-kernel.ts",
    "lib/browser-canonical-workbook.ts",
  ];
  const source = localRuntimeFiles
    .map((path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    source,
    /\b(?:fetch|sendBeacon|WebSocket|indexedDB|localStorage|CacheStorage|caches|sqlite|console\.(?:log|info|warn|error))\b/u,
  );

  const workbench = readFileSync(
    new URL("../app/LocalSessionWorkbench.tsx", import.meta.url),
    "utf8",
  );
  assert.equal([...workbench.matchAll(/\bfetch\s*\(/gu)].length, 3);
  assert.equal(
    [...workbench.matchAll(/fetch\("\/api\/auth\/session"/gu)].length,
    2,
  );
  assert.equal(
    [...workbench.matchAll(/fetch\("\/api\/state"/gu)].length,
    1,
  );
  assert.doesNotMatch(
    workbench,
    /\b(?:sendBeacon|WebSocket|indexedDB|localStorage|CacheStorage|caches|sqlite|console\.(?:log|info|warn|error))\b/u,
  );
});

test("resource disposal is idempotent and releases worker, URL, buffer and cache exactly once", () => {
  const terminated: string[] = [];
  const revoked: string[] = [];
  const worker: LocalSessionParserWorker = {
    postMessage() {},
    terminate() { terminated.push("worker"); },
    addEventListener() {},
    removeEventListener() {},
  };
  const urls: LocalSessionObjectUrlApi = {
    createObjectURL() { return "blob:p5"; },
    revokeObjectURL(url) { revoked.push(url); },
  };
  const scope = new SessionResourceScope(1, "resource:p5", urls);
  scope.attachWorker(worker);
  scope.attachBuffer(new ArrayBuffer(8));
  scope.createObjectUrl(new Blob(["p5"]));
  scope.cacheParserValue("parsed", { safe: true });
  scope.dispose("clear");
  scope.dispose("late-response");
  assert.deepEqual(terminated, ["worker"]);
  assert.deepEqual(revoked, ["blob:p5"]);
  assert.deepEqual(scope.snapshot(), {
    generation: 1,
    resourceHandle: "resource:p5",
    disposed: true,
    aborted: true,
    workerOwned: false,
    bufferOwnership: "released",
    objectUrlCount: 0,
    parserCacheEntries: 0,
    timeoutCount: 0,
  });
});

test("formal-looking local payload is rejected and shared activation preserves frozen snapshots byte-for-byte", () => {
  const formalLooking = {
    contractVersion: "local-session/open009-v2",
    authority: "local",
    source: { kind: "temporary_workspace" },
    document: {
      ...fixture(),
      seriesDefinitions: [{ id: "series:forbidden" }],
      configurationSnapshots: [{ id: "snapshot:forbidden" }],
    },
    history: {
      current: { authority: "local_ephemeral", sequence: 0 },
      undo: [],
      redo: [],
    },
  };
  assert.throws(() => parseLocalSessionModel(formalLooking), /unknown field/u);

  const sharedPayload = JSON.parse(readFileSync(
    new URL("./fixtures/workspace-production-schema-v17.json", import.meta.url),
    "utf8",
  )) as WorkspaceState;
  const frozenSnapshotsBefore = JSON.stringify(sharedPayload.configurationSnapshots);
  const frozenSnapshotsHashBefore = deterministicHash(sharedPayload.configurationSnapshots);
  const activatedSharedState = ensureSharedWorkflowFields(sharedPayload);
  assert.notEqual(activatedSharedState, sharedPayload);
  assert.equal(
    JSON.stringify(activatedSharedState.configurationSnapshots),
    frozenSnapshotsBefore,
  );
  assert.equal(
    deterministicHash(activatedSharedState.configurationSnapshots),
    frozenSnapshotsHashBefore,
  );
  let shell = createInitialAppShellState("auth:bootstrap");
  const apply = (event: Parameters<typeof transitionAppShell>[1]) => {
    const transition = transitionAppShell(shell, event);
    assert.equal(transition.accepted, true, transition.rejectionReason);
    shell = transition.state;
  };
  apply({
    type: "auth_session_authenticated",
    operationId: "auth:bootstrap",
    principal: { openId: "p5-user", displayName: "P5 User" },
  });
  let local: LocalSessionReducerState = {
    status: "active",
    session: createLocalSessionModel({ kind: "temporary_workspace" }, fixture()),
  };
  local = reduceLocalSession(local, {
    type: "commit_local_edit",
    document: { ...local.session.document, notes: "local-only" },
  });
  assert.equal(local.status, "active");
  if (local.status !== "active") assert.fail("local session unexpectedly cleared");
  apply({ type: "local_selection_requested", operationId: "local:open" });
  apply({
    type: "local_parse_started",
    operationId: "local:open",
    selectionRef: "selection:canonical",
  });
  apply({
    type: "local_parse_succeeded",
    operationId: "local:open",
    readyId: "ready:canonical",
    session: local.session,
  });
  apply({
    type: "shared_open_requested",
    operationId: "shared:open",
    workspaceId: "workspace:shared",
  });
  apply({
    type: "shared_load_succeeded",
    operationId: "shared:open",
    resource: {
      workspaceId: "workspace:shared",
      revision: 1,
      resourceId: "resource:shared",
    },
  });
  assert.equal(shell.authority.status, "shared_workspace");
  assert.equal(
    JSON.stringify(activatedSharedState.configurationSnapshots),
    frozenSnapshotsBefore,
  );
  assert.equal(
    deterministicHash(activatedSharedState.configurationSnapshots),
    frozenSnapshotsHashBefore,
  );

  const workbench = readFileSync(
    new URL("../app/Workbench.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    workbench,
    /useState<WorkspaceState>\(\(\) => ensureSharedWorkflowFields\(initialState\)\)/u,
  );
  assert.match(
    workbench,
    /useRef<WorkspaceState>\(ensureSharedWorkflowFields\(initialState\)\)/u,
  );
});
