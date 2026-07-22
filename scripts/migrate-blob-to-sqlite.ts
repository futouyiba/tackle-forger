import { get } from "@vercel/blob";
import { stat } from "node:fs/promises";
import path from "node:path";
import { closeSqliteStorage, importSqliteWorkspace } from "../lib/sqlite-storage";
import type { RevisionInfo, WorkspaceState } from "../lib/types";

type BlobDocument = {
  state: WorkspaceState;
  revision: number;
  revisions: Array<RevisionInfo & { state: WorkspaceState }>;
};

const target = process.env.WORKSPACE_DATABASE_PATH?.trim();
if (!target) throw new Error("必须设置 WORKSPACE_DATABASE_PATH。");
if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("必须设置 BLOB_READ_WRITE_TOKEN。");

const resolved = path.resolve(target);
if (await stat(resolved).then(() => true).catch(() => false)) {
  throw new Error(`目标数据库已存在，拒绝覆盖：${resolved}`);
}

const result = await get("workspace/main.json", { access: "private" });
if (!result || result.statusCode !== 200 || !result.stream) {
  throw new Error("Blob 中没有找到 workspace/main.json。");
}
const document = JSON.parse(await new Response(result.stream).text()) as BlobDocument;
await importSqliteWorkspace(resolved, document);
await closeSqliteStorage(resolved);
console.log(JSON.stringify({ databasePath: resolved, revision: document.revision, revisionCount: document.revisions.length }));
