export interface LocalSessionParserWorker {
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(type: "messageerror", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
}

export interface LocalSessionObjectUrlApi {
  createObjectURL(value: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface SessionResourceSnapshot {
  generation: number;
  resourceHandle: string;
  disposed: boolean;
  aborted: boolean;
  workerOwned: boolean;
  bufferOwnership: "none" | "attached" | "transferred" | "released";
  objectUrlCount: number;
  parserCacheEntries: number;
  timeoutCount: number;
}

export class SessionResourceScope {
  readonly abortController = new AbortController();
  readonly generation: number;
  readonly resourceHandle: string;

  #worker: LocalSessionParserWorker | null = null;
  #buffer: ArrayBuffer | null = null;
  #bufferOwnership: SessionResourceSnapshot["bufferOwnership"] = "none";
  #objectUrls = new Set<string>();
  #parserCache = new Map<string, unknown>();
  #timeouts = new Set<ReturnType<typeof setTimeout>>();
  #disposed = false;
  #objectUrlApi: LocalSessionObjectUrlApi;

  constructor(
    generation: number,
    resourceHandle: string,
    objectUrlApi: LocalSessionObjectUrlApi = URL,
  ) {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new TypeError("SessionResourceScope generation must be a positive safe integer.");
    }
    if (!resourceHandle.trim()) {
      throw new TypeError("SessionResourceScope resourceHandle must not be empty.");
    }
    this.generation = generation;
    this.resourceHandle = resourceHandle;
    this.#objectUrlApi = objectUrlApi;
  }

  get signal() {
    return this.abortController.signal;
  }

  get disposed() {
    return this.#disposed;
  }

  attachWorker(worker: LocalSessionParserWorker) {
    this.#assertActive();
    if (this.#worker) throw new Error("SessionResourceScope already owns a worker.");
    this.#worker = worker;
  }

  releaseWorker(worker: LocalSessionParserWorker) {
    if (this.#worker !== worker) return;
    worker.terminate();
    this.#worker = null;
  }

  attachBuffer(buffer: ArrayBuffer) {
    this.#assertActive();
    if (this.#bufferOwnership !== "none") {
      throw new Error("SessionResourceScope already owns an ArrayBuffer.");
    }
    this.#buffer = buffer;
    this.#bufferOwnership = "attached";
  }

  markBufferTransferred(buffer: ArrayBuffer) {
    this.#assertActive();
    if (this.#buffer !== buffer || this.#bufferOwnership !== "attached") {
      throw new Error("SessionResourceScope cannot transfer an unowned ArrayBuffer.");
    }
    this.#buffer = null;
    this.#bufferOwnership = "transferred";
  }

  createObjectUrl(value: Blob) {
    this.#assertActive();
    const url = this.#objectUrlApi.createObjectURL(value);
    this.#objectUrls.add(url);
    return url;
  }

  cacheParserValue(key: string, value: unknown) {
    this.#assertActive();
    this.#parserCache.set(key, value);
  }

  parserValue<T>(key: string): T | undefined {
    return this.#parserCache.get(key) as T | undefined;
  }

  setTimeout(callback: () => void, delayMs: number) {
    this.#assertActive();
    const handle = setTimeout(() => {
      this.#timeouts.delete(handle);
      callback();
    }, delayMs);
    this.#timeouts.add(handle);
    return handle;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>) {
    clearTimeout(handle);
    this.#timeouts.delete(handle);
  }

  snapshot(): SessionResourceSnapshot {
    return {
      generation: this.generation,
      resourceHandle: this.resourceHandle,
      disposed: this.#disposed,
      aborted: this.signal.aborted,
      workerOwned: this.#worker !== null,
      bufferOwnership: this.#bufferOwnership,
      objectUrlCount: this.#objectUrls.size,
      parserCacheEntries: this.#parserCache.size,
      timeoutCount: this.#timeouts.size,
    };
  }

  dispose(reason = "local_session_disposed") {
    if (this.#disposed) return;
    this.#disposed = true;
    this.abortController.abort(reason);
    this.#worker?.terminate();
    this.#worker = null;
    for (const handle of this.#timeouts) clearTimeout(handle);
    this.#timeouts.clear();
    for (const url of this.#objectUrls) this.#objectUrlApi.revokeObjectURL(url);
    this.#objectUrls.clear();
    this.#parserCache.clear();
    this.#buffer = null;
    this.#bufferOwnership = "released";
  }

  #assertActive() {
    if (this.#disposed) throw new Error("SessionResourceScope is already disposed.");
  }
}
