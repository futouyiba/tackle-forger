export const LOCAL_SESSION_LOGIN_TIMEOUT_MS = 120_000;
export const LOCAL_SESSION_LOGIN_INTERVAL_MS = 1_000;

export interface LocalSessionLoginPollScopeSnapshot {
  operationId: string;
  terminal: boolean;
  aborted: boolean;
  inFlight: boolean;
  retryPending: boolean;
  deadlinePending: boolean;
}

interface LocalSessionLoginPollOptions<T> {
  poll(signal: AbortSignal): Promise<T | null>;
  onAuthenticated(result: T): void;
  onTimeout(operationId: string): void;
  timeoutMs?: number;
  intervalMs?: number;
}

export class LocalSessionLoginPollScope<T> {
  readonly operationId: string;
  readonly abortController = new AbortController();

  #terminal = false;
  #inFlight = false;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #deadline: ReturnType<typeof setTimeout> | null;
  readonly #options: LocalSessionLoginPollOptions<T>;

  constructor(operationId: string, options: LocalSessionLoginPollOptions<T>) {
    if (!operationId.trim()) {
      throw new TypeError("Login operationId must not be empty.");
    }
    const timeoutMs = options.timeoutMs ?? LOCAL_SESSION_LOGIN_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? LOCAL_SESSION_LOGIN_INTERVAL_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError("Login timeout must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
      throw new TypeError("Login interval must be a non-negative safe integer.");
    }
    this.operationId = operationId;
    this.#options = { ...options, timeoutMs, intervalMs };
    this.#deadline = setTimeout(() => {
      if (!this.#finish("login_timeout")) return;
      options.onTimeout(this.operationId);
    }, timeoutMs);
    this.#schedule();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  cancel(reason = "login_cancelled"): boolean {
    return this.#finish(reason);
  }

  snapshot(): LocalSessionLoginPollScopeSnapshot {
    return {
      operationId: this.operationId,
      terminal: this.#terminal,
      aborted: this.signal.aborted,
      inFlight: this.#inFlight,
      retryPending: this.#retry !== null,
      deadlinePending: this.#deadline !== null,
    };
  }

  #schedule(): void {
    if (this.#terminal || this.#retry !== null) return;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.#tick();
    }, this.#options.intervalMs);
  }

  async #tick(): Promise<void> {
    if (this.#terminal || this.#inFlight) return;
    this.#inFlight = true;
    try {
      const result = await this.#options.poll(this.signal);
      if (this.#terminal) return;
      if (result !== null) {
        if (!this.#finish("login_succeeded")) return;
        this.#options.onAuthenticated(result);
        return;
      }
    } catch {
      if (this.#terminal) return;
    } finally {
      this.#inFlight = false;
    }
    this.#schedule();
  }

  #finish(reason: string): boolean {
    if (this.#terminal) return false;
    this.#terminal = true;
    if (this.#retry !== null) {
      clearTimeout(this.#retry);
      this.#retry = null;
    }
    if (this.#deadline !== null) {
      clearTimeout(this.#deadline);
      this.#deadline = null;
    }
    this.abortController.abort(reason);
    return true;
  }
}
