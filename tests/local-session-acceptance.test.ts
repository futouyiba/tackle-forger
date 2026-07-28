import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  SessionResourceScope,
  type LocalSessionObjectUrlApi,
  type LocalSessionParserWorker,
} from "../lib/local-session-resource-scope";
import { deterministicHash } from "../lib/rule-kernel";

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

test("instrumented local create/edit/derive/undo/redo/clear has zero external or durable effects", () => {
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
  ];
  const source = localRuntimeFiles
    .map((path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    source,
    /\b(?:fetch|sendBeacon|WebSocket|indexedDB|localStorage|CacheStorage|caches|sqlite|console\.(?:log|info|warn|error))\b/u,
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

test("formal-looking local payload is rejected and shared snapshot evidence remains byte-stable", () => {
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

  const sharedSnapshot = {
    id: "snapshot:existing",
    modelId: "model:existing",
    contentHash: "frozen-content-hash",
    finalPanelValues: { pull: 3 },
  };
  const before = deterministicHash(sharedSnapshot);
  let local: LocalSessionReducerState = {
    status: "active",
    session: createLocalSessionModel({ kind: "temporary_workspace" }, fixture()),
  };
  local = reduceLocalSession(local, {
    type: "commit_local_edit",
    document: { ...local.session.document, notes: "local-only" },
  });
  local = reduceLocalSession(local, { type: "clear_local_session" });
  assert.equal(local.status, "empty");
  assert.equal(deterministicHash(sharedSnapshot), before);
  assert.deepEqual(sharedSnapshot, {
    id: "snapshot:existing",
    modelId: "model:existing",
    contentHash: "frozen-content-hash",
    finalPanelValues: { pull: 3 },
  });

  const workbench = readFileSync(
    new URL("../app/LocalSessionWorkbench.tsx", import.meta.url),
    "utf8",
  );
  assert.match(workbench, /if \(sharedState\) return <Workbench initialState=\{sharedState\} \/>;/u);
  assert.match(workbench, /setSharedState\(payload\.state!\);/u);
  assert.doesNotMatch(workbench, /reduceLocalSession\([^)]*sharedState/u);
});
