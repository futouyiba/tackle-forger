import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Temporary auth directory fixture
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory to serve as `FEISHU_SESSION_DATA_DIR`, set
 * the env var, and clean up after all tests in the parent suite.
 *
 * Usage (top-level describe or file scope):
 *
 * ```ts
 * const authDir = await useTemporaryAuthDir(import.meta);
 * ```
 *
 * The returned string is the temp directory path; `process.env.FEISHU_SESSION_DATA_DIR`
 * is set to it for the lifetime of the test file.
 */
export async function useTemporaryAuthDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-auth-"));
  process.env.FEISHU_SESSION_DATA_DIR = dir;
  test.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

// ---------------------------------------------------------------------------
// Trusted-proxy test identity fixture
// ---------------------------------------------------------------------------

/**
 * Standard trusted-proxy header set for use in route tests.
 *
 * These headers simulate an authenticated Feishu user via the trusted-proxy
 * code path.  The caller must also set environment variables
 * (`FEISHU_TRUST_PROXY_HEADERS=true`, `FEISHU_PROXY_SHARED_SECRET=test-secret`,
 * `FEISHU_TENANT_KEY=tenant`) for the identity to be accepted; use
 * {@link withTrustedProxyEnvironment} or {@link withEnvironment}.
 */
export function trustedProxyHeaders(overrides?: Record<string, string>): Record<string, string> {
  return {
    "x-feishu-tenant-key": "tenant",
    "x-feishu-open-id": "test-user",
    "x-feishu-display-name": "测试用户",
    "x-tf-proxy-secret": "test-secret",
    ...overrides,
  };
}

/**
 * Environment variables required for the trusted-proxy identity path to
 * accept a request.
 */
export const TRUSTED_PROXY_ENV = {
  FEISHU_TRUST_PROXY_HEADERS: "true",
  FEISHU_PROXY_SHARED_SECRET: "test-secret",
  FEISHU_TENANT_KEY: "tenant",
} as const satisfies Record<string, string>;

/**
 * Wrap an operation with trusted-proxy environment, then restore.
 */
export async function withTrustedProxyEnvironment(
  operation: () => Promise<void>,
): Promise<void> {
  await withEnvironment(TRUSTED_PROXY_ENV, operation);
}

/**
 * Create a `NextRequest` carrying trusted-proxy identity headers.
 *
 * The caller should still wrap the test body in
 * `withTrustedProxyEnvironment` for the env vars.
 */
export function createMockAuthRequest(
  init?: { path?: string; method?: string; headers?: Record<string, string> },
): NextRequest {
  const url = init?.path ?? "http://localhost/api/state";
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    headers: {
      ...trustedProxyHeaders(),
      ...init?.headers,
    },
  });
}

// ---------------------------------------------------------------------------
// General environment fixture (shared from auth.test.ts)
// ---------------------------------------------------------------------------

/**
 * Temporarily override environment variables for the duration of
 * `operation`, then restore the prior values.
 *
 * - A value of `undefined` **deletes** the key during the operation.
 * - Keys not present in `values` are left untouched.
 * - After the operation, each key is restored to its original value (or
 *   deleted if it was not set originally).
 *
 * This is safe against concurrent test runners because each invocation
 * captures and restores its own snapshot.  However, the underlying
 * `process.env` is a shared global, so tests that modify the same key
 * concurrently in different file-level suites may still interfere if the
 * test framework runs them in parallel (node:test runs files sequentially
 * by default).
 */
export async function withEnvironment(
  values: Record<string, string | undefined>,
  operation: () => Promise<void>,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        Reflect.set(process.env, key, value);
      }
    }
    await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        Reflect.set(process.env, key, value);
      }
    }
  }
}
