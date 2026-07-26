/**
 * 将 config-export-companion 打包为独立可执行脚本。
 * 用法：npm run config-export:companion:build
 */
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["scripts/config-export-companion.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/companion.js",
  external: [],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  minify: false,
  sourcemap: false,
});

// 生成 Windows 启动脚本
import { writeFile } from "node:fs/promises";
await writeFile("dist/companion.bat", '@echo off\r\nnode "%~dp0companion.js" %*\r\n', "utf8");

console.log("companion 打包完成 → dist/companion.js + dist/companion.bat");
