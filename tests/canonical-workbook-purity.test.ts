import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 依赖边界：canonical 纯核心与浏览器适配器（及其纯领域依赖）不得静态依赖
 * 飞书网络/鉴权/持久化模块。飞书工作簿常量/类型模块（feishu-workbook）允许，
 * 因为它本身只导入纯领域模块；本测试同时验证这一前提仍然成立。
 */
const FORBIDDEN_IMPORT = [
  /from\s+["']\.\/feishu-sheets["']/,
  /from\s+["']\.\/feishu["']/,
  /from\s+["']\.\/auth(?:-[^"']+)?["']/,
  /from\s+["']\.\/storage["']/,
  /from\s+["']\.\/sqlite(?:-[^"']+)?["']/,
];

const PURE_MODULES = [
  "lib/canonical-workbook-core.ts",
  "lib/browser-canonical-workbook.ts",
  "lib/canonical-rule-source.ts",
  "lib/pricing-policy.ts",
  "lib/quality-value-policy.ts",
  "lib/source-id-migration.ts",
  "lib/rule-kernel.ts",
  "lib/types.ts",
  "lib/feishu-workbook.ts",
  "lib/reduction-stacking-policy.ts",
  "lib/five-axis-weight-band-policy-source.ts",
];

test("canonical 纯核心与浏览器适配器及其纯依赖不导入飞书网络/鉴权/持久化模块", () => {
  const violations: string[] = [];
  for (const file of PURE_MODULES) {
    const source = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN_IMPORT) {
      const match = source.match(pattern);
      if (match) violations.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(violations, [], `纯核心依赖边界被打破:\n${violations.join("\n")}`);
});

test("飞书规则工作簿 facade 单向依赖纯核心，纯核心不反向依赖 facade", () => {
  const facade = readFileSync("lib/rule-workbook-inspection.ts", "utf8");
  assert.ok(facade.includes('from "./canonical-workbook-core"'), "facade 应依赖纯核心");
  const core = readFileSync("lib/canonical-workbook-core.ts", "utf8");
  assert.ok(!core.includes('from "./rule-workbook-inspection"'), "纯核心不得反向依赖 facade");
  const browser = readFileSync("lib/browser-canonical-workbook.ts", "utf8");
  assert.ok(!browser.includes('from "./rule-workbook-inspection"'), "浏览器适配器应直接依赖纯核心，而非飞书 facade");
  assert.ok(browser.includes('from "./canonical-workbook-core"'), "浏览器适配器应依赖纯核心");
});
