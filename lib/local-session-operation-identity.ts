export type LocalSessionIdentityKind = "operation" | "resource";

export class LocalSessionIdentityCollisionError extends Error {
  constructor(
    readonly kind: LocalSessionIdentityKind,
    readonly value: string,
  ) {
    super(`Local-session ${kind} identity collided: ${value}`);
    this.name = "LocalSessionIdentityCollisionError";
  }
}

export interface LocalSessionIdentityAllocatorOptions {
  createId?: () => string;
}

/**
 * Tab-lifetime identity ledger. Values are never released, including after
 * clear/replace, so a late worker response cannot become valid again.
 */
export class LocalSessionIdentityAllocator {
  #used = new Set<string>();
  #createId: () => string;

  constructor(options: LocalSessionIdentityAllocatorOptions = {}) {
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  allocate(kind: LocalSessionIdentityKind): string {
    return this.claim(kind, `${kind}:${this.#createId()}`);
  }

  claim(kind: LocalSessionIdentityKind, value: string): string {
    if (!value.trim()) throw new TypeError(`Local-session ${kind} identity must not be empty.`);
    if (this.#used.has(value)) {
      throw new LocalSessionIdentityCollisionError(kind, value);
    }
    this.#used.add(value);
    return value;
  }

  has(value: string): boolean {
    return this.#used.has(value);
  }
}
