import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigExportCompanionController,
  loadCompanionRegistry,
  type CompanionCommitRequest,
  type CompanionPairingIdentity,
  type CompanionPreviewRequest,
  type CompanionStatusRequest,
} from "../lib/config-export-companion";

interface CompanionServerOptions {
  registryPath: string;
  port: number;
  token?: string;
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function bearerToken(request: IncomingMessage) {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

function pairingIdentity(request: IncomingMessage): CompanionPairingIdentity {
  return {
    workspaceId: String(request.headers["x-tackle-forger-workspace"] ?? ""),
    userId: String(request.headers["x-tackle-forger-user"] ?? ""),
  };
}

function originAllowed(origin: string | undefined, allowedOrigins: string[]) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return (
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && (url.protocol === "http:" || url.protocol === "https:")
    );
  } catch {
    return false;
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  origin?: string,
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
  }
  response.end(JSON.stringify(value));
}

async function jsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 10 * 1024 * 1024) throw new Error("请求体超过 10MB 限制。");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function startConfigExportCompanion(options: CompanionServerOptions) {
  const registry = await loadCompanionRegistry(path.resolve(options.registryPath));
  const token = options.token ?? randomBytes(24).toString("base64url");
  const controller = new ConfigExportCompanionController({ registry, token });
  const server = createServer(async (request, response) => {
    const origin = typeof request.headers.origin === "string"
      ? request.headers.origin
      : undefined;
    if (!originAllowed(origin, registry.allowedOrigins ?? [])) {
      sendJson(response, 403, { error: "请求来源未被本地助手允许。" });
      return;
    }
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader(
        "access-control-allow-headers",
        "authorization, content-type, x-tackle-forger-workspace, x-tackle-forger-user",
      );
      response.setHeader("access-control-max-age", "600");
      if (origin) response.setHeader("access-control-allow-origin", origin);
      response.end();
      return;
    }
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(
          response,
          200,
          controller.health(bearerToken(request), pairingIdentity(request)),
          origin,
        );
        return;
      }
      if (request.method === "POST" && request.url === "/preview") {
        const result = await controller.preview(
          bearerToken(request),
          pairingIdentity(request),
          await jsonBody(request) as CompanionPreviewRequest,
        );
        sendJson(response, 200, result, origin);
        return;
      }
      if (request.method === "POST" && request.url === "/commit") {
        const result = await controller.commit(
          bearerToken(request),
          pairingIdentity(request),
          await jsonBody(request) as CompanionCommitRequest,
        );
        sendJson(response, 200, result, origin);
        return;
      }
      if (request.method === "POST" && request.url === "/status") {
        const result = await controller.status(
          bearerToken(request),
          pairingIdentity(request),
          await jsonBody(request) as CompanionStatusRequest,
        );
        sendJson(response, 200, result, origin);
        return;
      }
      sendJson(response, 404, { error: "接口不存在。" }, origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /令牌|配对/.test(message) ? 401 : 400;
      sendJson(response, status, { error: message }, origin);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    token,
    url: `http://127.0.0.1:${address.port}`,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const registryPath = argument("--registry");
  if (!registryPath) {
    console.error("用法：npm run config-export:companion -- --registry <registry.json> [--port 47831] [--token-file <path>]");
    process.exitCode = 1;
  } else {
    const rawPort = Number(argument("--port") ?? "47831");
    if (!Number.isInteger(rawPort) || rawPort < 1024 || rawPort > 65535) {
      console.error("端口必须是 1024 到 65535 的整数。");
      process.exitCode = 1;
    } else {
      const started = await startConfigExportCompanion({
        registryPath,
        port: rawPort,
      });
      const tokenFile = path.resolve(
        argument("--token-file") ?? `${registryPath}.pairing-token`,
      );
      await writeFile(tokenFile, `${started.token}\n`, { mode: 0o600 });
      console.log(`Tackle Forger 本地助手已启动：${started.url}`);
      console.log(`配对令牌已写入：${tokenFile}`);
      console.log("仅监听 127.0.0.1；关闭此窗口即可停止服务。");
    }
  }
}
