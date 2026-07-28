import {
  LOCAL_SESSION_PARSER_REQUEST,
  parseLocalSessionParserWorkerResponse,
  type LocalSessionParsedWorkbook,
  type LocalSessionParserRequest,
} from "./local-session-parser-protocol";
import {
  SessionResourceScope,
  type LocalSessionObjectUrlApi,
  type LocalSessionParserWorker,
} from "./local-session-resource-scope";
import { sha256Hex as pureSha256Hex } from "./five-axis-hash";
import { LocalSessionIdentityAllocator } from "./local-session-operation-identity";

const LOCAL_SESSION_OBSERVED_AT = "1970-01-01T00:00:00.000Z";
const DEFAULT_PARSE_TIMEOUT_MS = 30_000;
// Keep the main-thread preflight aligned with the worker-enforced canonical adapter limit.
const MAXIMUM_LOCAL_SESSION_FILE_BYTES = 20 * 1024 * 1024;

export type LocalSessionParserWorkerFactory = () => LocalSessionParserWorker;

export interface LocalSessionFile {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export class LocalSessionParserError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalSessionParserError";
  }
}

export interface LocalSessionReadyWorkbook {
  generation: number;
  operationId: string;
  resourceHandle: string;
  sourceObjectUrl: string;
  result: LocalSessionParsedWorkbook;
}

interface OwnedReadyWorkbook extends LocalSessionReadyWorkbook {
  scope: SessionResourceScope;
}

export interface LocalSessionWorkbookLoaderOptions {
  workerFactory?: LocalSessionParserWorkerFactory;
  objectUrlApi?: LocalSessionObjectUrlApi;
  timeoutMs?: number;
  subtleCrypto?: SubtleCrypto | null;
  identityAllocator?: LocalSessionIdentityAllocator;
}

function defaultWorkerFactory(): LocalSessionParserWorker {
  return new Worker(new URL("./local-session-parser-worker.ts", import.meta.url), {
    type: "module",
    name: "tackle-forger-local-session-parser",
  }) as LocalSessionParserWorker;
}

async function sha256Hex(bytes: ArrayBuffer, subtleCrypto?: SubtleCrypto) {
  if (!subtleCrypto) return pureSha256Hex(new Uint8Array(bytes));
  const digest = await subtleCrypto.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function publicReady(ready: OwnedReadyWorkbook | null): LocalSessionReadyWorkbook | null {
  if (!ready) return null;
  return {
    generation: ready.generation,
    operationId: ready.operationId,
    resourceHandle: ready.resourceHandle,
    sourceObjectUrl: ready.sourceObjectUrl,
    result: ready.result,
  };
}

export class LocalSessionWorkbookLoader {
  #generation = 0;
  #candidate: SessionResourceScope | null = null;
  #ready: OwnedReadyWorkbook | null = null;
  #workerFactory: LocalSessionParserWorkerFactory;
  #objectUrlApi: LocalSessionObjectUrlApi;
  #timeoutMs: number;
  #subtleCrypto: SubtleCrypto | undefined;
  #identities: LocalSessionIdentityAllocator;

  constructor(options: LocalSessionWorkbookLoaderOptions = {}) {
    this.#workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.#objectUrlApi = options.objectUrlApi ?? URL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS;
    this.#subtleCrypto = options.subtleCrypto === undefined
      ? globalThis.crypto?.subtle
      : options.subtleCrypto ?? undefined;
    this.#identities = options.identityAllocator ?? new LocalSessionIdentityAllocator();
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new TypeError("Local-session parser timeout must be a positive safe integer.");
    }
  }

  ready() {
    return publicReady(this.#ready);
  }

  pendingResourceSnapshot() {
    return this.#candidate?.snapshot() ?? null;
  }

  readyResourceSnapshot() {
    return this.#ready?.scope.snapshot() ?? null;
  }

  async open(
    file: LocalSessionFile,
    requestedOperationId?: string,
    operationAlreadyClaimed = false,
  ): Promise<LocalSessionReadyWorkbook> {
    this.cancelPending();
    if (file.size > MAXIMUM_LOCAL_SESSION_FILE_BYTES) {
      throw new LocalSessionParserError(
        "XLSX_FILE_TOO_LARGE",
        `本地规则工作簿不能超过 ${MAXIMUM_LOCAL_SESSION_FILE_BYTES / 1024 / 1024}MB。`,
      );
    }
    const generation = this.#nextGeneration();
    const operationId = requestedOperationId
      ? operationAlreadyClaimed
        ? this.#identities.assertClaimed("operation", requestedOperationId)
        : this.#identities.claim("operation", requestedOperationId)
      : this.#identities.allocate("operation");
    const resourceHandle = this.#identities.allocate("resource");
    const scope = new SessionResourceScope(
      generation,
      resourceHandle,
      this.#objectUrlApi,
    );
    this.#candidate = scope;
    let sourceObjectUrl: string;
    try {
      sourceObjectUrl = scope.createObjectUrl(file as unknown as Blob);
      const bytes = await file.arrayBuffer();
      if (scope.disposed || this.#candidate !== scope) {
        throw new LocalSessionParserError(
          "LOCAL_SESSION_PARSE_CANCELLED",
          "本地工作簿解析已取消。",
        );
      }
      if (bytes.byteLength !== file.size) {
        throw new LocalSessionParserError(
          "LOCAL_SESSION_FILE_SIZE_CHANGED",
          "读取到的文件字节数与选择时不一致。",
        );
      }
      scope.attachBuffer(bytes);
      const contentSha256 = await sha256Hex(bytes, this.#subtleCrypto);
      if (scope.disposed || this.#candidate !== scope) {
        throw new LocalSessionParserError(
          "LOCAL_SESSION_PARSE_CANCELLED",
          "本地工作簿解析已取消。",
        );
      }
      const result = await this.#parseInWorker(scope, {
        type: LOCAL_SESSION_PARSER_REQUEST,
        generation,
        operationId,
        resourceHandle,
        fileName: file.name,
        byteLength: bytes.byteLength,
        contentSha256,
        observedAt: LOCAL_SESSION_OBSERVED_AT,
        bytes,
      });
      if (scope.disposed || this.#candidate !== scope) {
        throw new LocalSessionParserError(
          "LOCAL_SESSION_PARSE_SUPERSEDED",
          "本地工作簿解析结果已被更新的候选替代。",
        );
      }
      scope.cacheParserValue(contentSha256, result.workbook);
      const nextReady: OwnedReadyWorkbook = {
        generation,
        operationId,
        resourceHandle,
        sourceObjectUrl,
        result,
        scope,
      };
      const previousReady = this.#ready;
      this.#ready = nextReady;
      this.#candidate = null;
      previousReady?.scope.dispose("local_session_replaced");
      return publicReady(nextReady)!;
    } catch (error) {
      if (this.#candidate === scope) this.#candidate = null;
      scope.dispose("local_session_candidate_failed");
      if (error instanceof LocalSessionParserError) throw error;
      throw new LocalSessionParserError(
        "LOCAL_SESSION_PARSE_FAILED",
        error instanceof Error ? error.message : "本地工作簿解析失败。",
      );
    }
  }

  cancelPending() {
    const candidate = this.#candidate;
    if (!candidate) return;
    this.#candidate = null;
    this.#nextGeneration();
    candidate.dispose("local_session_candidate_cancelled");
  }

  clear() {
    this.cancelPending();
    const ready = this.#ready;
    this.#ready = null;
    this.#nextGeneration();
    ready?.scope.dispose("local_session_cleared");
  }

  async #parseInWorker(
    scope: SessionResourceScope,
    request: LocalSessionParserRequest,
  ): Promise<LocalSessionParsedWorkbook> {
    const worker = this.#workerFactory();
    scope.attachWorker(worker);
    return new Promise<LocalSessionParsedWorkbook>((resolve, reject) => {
      let settled = false;
      const finish = (
        outcome:
          | { ok: true; value: LocalSessionParsedWorkbook }
          | { ok: false; error: LocalSessionParserError },
      ) => {
        if (settled) return;
        settled = true;
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        worker.removeEventListener("messageerror", onMessageError);
        scope.signal.removeEventListener("abort", onAbort);
        scope.clearTimeout(timeout);
        scope.releaseWorker(worker);
        if (outcome.ok) resolve(outcome.value);
        else reject(outcome.error);
      };
      const onMessage = (event: MessageEvent<unknown>) => {
        let response;
        try {
          response = parseLocalSessionParserWorkerResponse(event.data);
        } catch (error) {
          finish({
            ok: false,
            error: new LocalSessionParserError(
              "LOCAL_SESSION_PARSER_PROTOCOL_INVALID",
              error instanceof Error ? error.message : "解析 worker 返回了无效协议。",
            ),
          });
          return;
        }
        if (response.generation !== scope.generation || scope.disposed) return;
        if (
          response.operationId !== request.operationId
          || response.resourceHandle !== scope.resourceHandle
        ) {
          finish({
            ok: false,
            error: new LocalSessionParserError(
              "LOCAL_SESSION_RESOURCE_IDENTITY_MISMATCH",
              "解析 worker 返回了不匹配的操作或资源身份。",
            ),
          });
          return;
        }
        if (response.type === "local_canonical_workbook_failed") {
          finish({
            ok: false,
            error: new LocalSessionParserError(response.error.code, response.error.message),
          });
          return;
        }
        finish({ ok: true, value: response.result });
      };
      const onError = (event: ErrorEvent) => {
        finish({
          ok: false,
          error: new LocalSessionParserError(
            "LOCAL_SESSION_WORKER_CRASHED",
            event.message || "本地工作簿解析 worker 异常终止。",
          ),
        });
      };
      const onMessageError = () => {
        finish({
          ok: false,
          error: new LocalSessionParserError(
            "LOCAL_SESSION_WORKER_MESSAGE_INVALID",
            "本地工作簿解析 worker 返回了不可反序列化的数据。",
          ),
        });
      };
      const onAbort = () => {
        finish({
          ok: false,
          error: new LocalSessionParserError(
            "LOCAL_SESSION_PARSE_CANCELLED",
            "本地工作簿解析已取消。",
          ),
        });
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onMessageError);
      scope.signal.addEventListener("abort", onAbort, { once: true });
      const timeout = scope.setTimeout(() => {
        finish({
          ok: false,
          error: new LocalSessionParserError(
            "LOCAL_SESSION_PARSE_TIMEOUT",
            "本地工作簿解析超时。",
          ),
        });
      }, this.#timeoutMs);
      try {
        worker.postMessage(request, [request.bytes]);
        scope.markBufferTransferred(request.bytes);
      } catch (error) {
        finish({
          ok: false,
          error: new LocalSessionParserError(
            "LOCAL_SESSION_WORKER_TRANSFER_FAILED",
            error instanceof Error ? error.message : "无法把工作簿传给解析 worker。",
          ),
        });
      }
    });
  }

  #nextGeneration() {
    if (this.#generation === Number.MAX_SAFE_INTEGER) {
      throw new LocalSessionParserError(
        "LOCAL_SESSION_GENERATION_EXHAUSTED",
        "本地会话 generation 已耗尽。",
      );
    }
    this.#generation += 1;
    return this.#generation;
  }
}
