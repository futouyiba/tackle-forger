/**
 * 最小连通性验证：不依赖 Snapshot、不依赖 mapping。
 * 只检查 companion 能否访问注册表中登记的目录和文件。
 *
 * 用法：npx tsx scripts/verify-config-connectivity.ts [registry路径]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const registryPath = process.argv[2] ?? "config-export-registry.json";
const registry = JSON.parse(
  readFileSync(path.resolve(registryPath), "utf8"),
) as {
  profiles: Array<{
    profileId: string;
    label: string;
    projectRoot: string;
    relativeWorkbookRoot: string;
    configTomlPath: string;
    enabled: boolean;
  }>;
};

console.log("=== companion 连通性验证 ===\n");

let allOk = true;

for (const profile of registry.profiles) {
  console.log(`Profile: ${profile.profileId} (${profile.label})`);
  console.log(`  enabled: ${profile.enabled}`);

  // 1. projectRoot 存在？
  const root = profile.projectRoot;
  if (!existsSync(root)) {
    console.log(`  ❌ projectRoot 不存在: ${root}`);
    allOk = false;
    continue;
  }
  console.log(`  ✅ projectRoot: ${root}`);

  // 2. config.toml 存在？
  const tomlPath = path.join(root, profile.configTomlPath);
  if (!existsSync(tomlPath)) {
    console.log(`  ❌ config.toml 不存在: ${tomlPath}`);
    allOk = false;
  } else {
    const size = statSync(tomlPath).size;
    console.log(`  ✅ config.toml (${size} bytes)`);
  }

  // 3. workbookRoot 存在？列出 xlsx
  const xlsxRoot = path.join(root, profile.relativeWorkbookRoot);
  if (!existsSync(xlsxRoot)) {
    console.log(`  ❌ workbookRoot 不存在: ${xlsxRoot}`);
    allOk = false;
  } else {
    const xlsxFiles = readdirSync(xlsxRoot).filter(
      (f) => f.endsWith(".xlsx"),
    );
    console.log(`  ✅ workbookRoot: ${xlsxRoot}`);
    if (xlsxFiles.length === 0) {
      console.log(`  ⚠️  没有找到 xlsx 文件`);
    } else {
      for (const f of xlsxFiles) {
        const size = statSync(path.join(xlsxRoot, f)).size;
        console.log(`    📄 ${f} (${size} bytes)`);
      }
    }
  }

  console.log();
}

console.log(allOk ? "✅ 连通性验证全部通过！" : "❌ 存在问题，见上。");
console.log("\n下一步：启动 companion → 浏览器连接 → 选 Snapshot → 预览 → 提交");
