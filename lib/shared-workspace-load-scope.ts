export const SHARED_WORKSPACE_LOAD_TIMEOUT_MS = 20_000;

export interface SharedWorkspaceLoadScopeSnapshot {
  operationId: string;
  terminal: boolean;
  aborted: boolean;
  timeoutPending: boolean;
}

export class SharedWorkspaceLoadScope {
  readonly operationId: string;
  readonly abortController = new AbortController();

  #terminal = false;
  #timeout: ReturnType<typeof setTimeout> | null;

  constructor(
    operationId: string,
    timeoutMs = SHARED_WORKSPACE_LOAD_TIMEOUT_MS,
    onTimeout: (operationId: string) => void,
  ) {
    if (!operationId.trim()) {
      throw new TypeError("Shared load operationId must not be empty.");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError("Shared load timeout must be a positive safe integer.");
    }
    this.operationId = operationId;
    this.#timeout = setTimeout(() => {
      if (!this.#finish()) return;
      this.abortController.abort("shared_load_timeout");
      onTimeout(this.operationId);
    }, timeoutMs);
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  complete(): boolean {
    return this.#finish();
  }

  cancel(reason = "shared_load_cancelled"): boolean {
    if (!this.#finish()) return false;
    this.abortController.abort(reason);
    return true;
  }

  snapshot(): SharedWorkspaceLoadScopeSnapshot {
    return {
      operationId: this.operationId,
      terminal: this.#terminal,
      aborted: this.signal.aborted,
      timeoutPending: this.#timeout !== null,
    };
  }

  #finish(): boolean {
    if (this.#terminal) return false;
    this.#terminal = true;
    if (this.#timeout !== null) {
      clearTimeout(this.#timeout);
      this.#timeout = null;
    }
    return true;
  }
}
