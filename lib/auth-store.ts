import { createHmac, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FeishuIdentity } from "./feishu-identity";

interface StoredSession { identity: FeishuIdentity; createdAt: string; expiresAt: string }
interface PendingLogin { returnTo: string; createdAt: string; expiresAt: string }
interface AuthDocument {
  version: 1;
  sessions: Record<string, StoredSession>;
  pendingLogins: Record<string, PendingLogin>;
}

const EMPTY_DOCUMENT: AuthDocument = { version: 1, sessions: {}, pendingLogins: {} };
const LOCK_RETRIES = 100;

function authPath() {
  const configured = process.env.FEISHU_SESSION_DATA_DIR?.trim() || ".data/auth";
  return path.join(path.resolve(configured), "sessions.json");
}

function digest(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

async function readDocument(file = authPath()): Promise<AuthDocument> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as AuthDocument;
    if (value.version !== 1 || !value.sessions || !value.pendingLogins) {
      throw new Error("会话存储格式无效。");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_DOCUMENT);
    throw error;
  }
}

async function acquireLock(file: string) {
  const lockPath = `${file}.lock`;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
      return async () => {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) {
        await unlink(lockPath).catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 2));
    }
  }
  throw new Error("会话存储暂时繁忙，请重试。");
}

function purgeExpired(document: AuthDocument, nowMs: number) {
  for (const [key, session] of Object.entries(document.sessions)) {
    if (Date.parse(session.expiresAt) <= nowMs) delete document.sessions[key];
  }
  for (const [key, pending] of Object.entries(document.pendingLogins)) {
    if (Date.parse(pending.expiresAt) <= nowMs) delete document.pendingLogins[key];
  }
}

async function mutate<T>(
  operation: (document: AuthDocument) => T | Promise<T>,
  nowMs = Date.now(),
) {
  const file = authPath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = await acquireLock(file);
  try {
    const document = await readDocument(file);
    purgeExpired(document, nowMs);
    const result = await operation(document);
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
    return result;
  } finally {
    await release();
  }
}

export function newOpaqueId() {
  return randomBytes(32).toString("base64url");
}

export async function savePendingLogin(input: { state: string; secret: string; returnTo: string; ttlSeconds?: number; now?: Date }) {
  const now = input.now ?? new Date();
  await mutate((document) => {
    document.pendingLogins[digest(input.state, input.secret)] = {
      returnTo: input.returnTo,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.ttlSeconds ?? 600) * 1000).toISOString(),
    };
  }, now.getTime());
}

export async function consumePendingLogin(input: { state: string; secret: string; now?: Date }) {
  const now = input.now ?? new Date();
  return mutate((document) => {
    const key = digest(input.state, input.secret);
    const pending = document.pendingLogins[key];
    delete document.pendingLogins[key];
    return pending && Date.parse(pending.expiresAt) > now.getTime() ? structuredClone(pending) : undefined;
  }, now.getTime());
}

export async function createSession(input: { sessionId: string; secret: string; identity: FeishuIdentity; ttlSeconds: number; now?: Date }) {
  const now = input.now ?? new Date();
  const session: StoredSession = {
    identity: structuredClone(input.identity),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString(),
  };
  await mutate((document) => {
    document.sessions[digest(input.sessionId, input.secret)] = session;
  }, now.getTime());
  return structuredClone(session);
}

export async function findSession(input: { sessionId: string; secret: string; now?: Date }) {
  const session = (await readDocument()).sessions[digest(input.sessionId, input.secret)];
  return session && Date.parse(session.expiresAt) > (input.now ?? new Date()).getTime()
    ? structuredClone(session)
    : undefined;
}

export async function revokeSession(input: { sessionId: string; secret: string }) {
  await mutate((document) => {
    delete document.sessions[digest(input.sessionId, input.secret)];
  });
}
