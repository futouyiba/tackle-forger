import { inspectSqliteRevisionStorage } from "../lib/sqlite-revision-diagnostics";

const databasePath = process.env.WORKSPACE_DATABASE_PATH?.trim();
if (!databasePath) {
  throw new Error("必须设置 WORKSPACE_DATABASE_PATH；诊断不会回退到相对路径或创建数据库。");
}

const diagnostics = await inspectSqliteRevisionStorage(databasePath);
console.log(JSON.stringify(diagnostics, null, 2));
