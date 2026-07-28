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
  cryptoSource?: LocalSessionCryptoSource;
}

export interface LocalSessionCryptoSource {
  randomUUID?: () => string;
  getRandomValues(array: Uint8Array): Uint8Array;
}

/**
 * Mirrors the secure branches of browser-utils.randomUUID without its weak
 * Math.random fallback. Insecure RFC1918 HTTP still exposes getRandomValues.
 */
export function createLocalSessionSecureRandomId(
  source: LocalSessionCryptoSource = crypto,
): string {
  if (typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

/**
 * Tab-lifetime identity ledger. Values are never released, including after
 * clear/replace, so a late worker response cannot become valid again.
 */
export class LocalSessionIdentityAllocator {
  #used = new Map<string, LocalSessionIdentityKind>();
  #consumedOperationHandoffs = new Set<string>();
  #createId: () => string;

  constructor(options: LocalSessionIdentityAllocatorOptions = {}) {
    const cryptoSource = options.cryptoSource ?? crypto;
    this.#createId = options.createId
      ?? (() => createLocalSessionSecureRandomId(cryptoSource));
  }

  allocate(kind: LocalSessionIdentityKind): string {
    return this.claim(kind, `${kind}:${this.#createId()}`);
  }

  claim(kind: LocalSessionIdentityKind, value: string): string {
    if (!value.trim()) throw new TypeError(`Local-session ${kind} identity must not be empty.`);
    if (this.#used.has(value)) {
      throw new LocalSessionIdentityCollisionError(kind, value);
    }
    this.#used.set(value, kind);
    return value;
  }

  has(value: string): boolean {
    return this.#used.has(value);
  }

  consumeClaimedOperation(value: string): string {
    if (
      this.#used.get(value) !== "operation"
      || this.#consumedOperationHandoffs.has(value)
    ) {
      throw new LocalSessionIdentityCollisionError("operation", value);
    }
    this.#consumedOperationHandoffs.add(value);
    return value;
  }
}
