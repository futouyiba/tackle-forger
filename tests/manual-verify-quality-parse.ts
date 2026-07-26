/**
 * 本地验证：直接用 lark-cli 读 WQ8w 真实数据，跑 qualityDraftFromRanges。
 * 用法：npx tsx tests/manual-verify-quality-parse.ts
 */
import { execSync } from "node:child_process";
import { CANONICAL_FEISHU_WORKBOOK } from "../lib/feishu-workbook";
import { qualityDraftFromRanges } from "../lib/rule-workbook-inspection";

function readWq8wRange(sheetId: string, range: string): unknown[][] {
  const cmd = `lark-cli sheets +csv-get --url "${CANONICAL_FEISHU_WORKBOOK.shareUrl}" --sheet-id "${sheetId}" --range "${range}" --json`;
  const output = execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  const json = JSON.parse(output) as { ok: boolean; data?: { annotated_csv?: string } };
  if (!json.ok || !json.data?.annotated_csv) return [];
  return json.data.annotated_csv.split(/\r?\n/).filter(Boolean).map((line) => {
    const content = line.replace(/^\[row=\d+\]\s*/, "");
    return content.split(",");
  });
}

const sourceRevision = { id: "local-verify", workbookRefId: CANONICAL_FEISHU_WORKBOOK.id, sourceRevision: "1", spreadsheetToken: CANONICAL_FEISHU_WORKBOOK.spreadsheetToken!, pulledAt: new Date().toISOString(), pulledBy: "verify", syncScope: "workbook" as const, registryHash: "x", sheets: [], issues: [], state: "PULLED" as const };

console.log("=== 读 WQ8w 品质数据 ===");
const q = readWq8wRange("27hboC", "A1:F6");
console.log(`  27hboC: ${q.length} 行, 表头: ${q[0]?.filter(Boolean).join(",")}`);
for(let i=1;i<q.length;i++) console.log(`  [${i}] ${q[i]?.filter(Boolean).join("|")}`);
const affix = readWq8wRange("23CsXE", "A1:F86");
console.log(`  23CsXE: ${affix.length} 行`);
const ep = readWq8wRange("33IGHy", "A1:E193");
console.log(`  33IGHy: ${ep.length} 行`);
const matrix = readWq8wRange("28fQhg", "A1:C711");
console.log(`  28fQhg: ${matrix.length} 行`);

console.log("\n=== 跑解析 ===");
try {
  const draft = qualityDraftFromRanges({ sourceRevision, qualityValues: q, qualityRange: `A1:F6`, affixValues: affix, matrixValues: matrix, pricingEndpointValues: ep, importedAt: new Date().toISOString() });
  console.log(`  ranges: ${draft.ranges?.length}, issues: ${draft.issues?.length}`);
  for(const i of draft.issues??[]) console.log(`    ${i.severity} ${i.code}: ${i.message}`);
  console.log(`  matrixCells: ${draft.matrixCells?.length}`);
  console.log(`  descriptorRows: ${draft.qualityTableDescriptor?.rows?.length}`);
} catch(e) { console.error("  FAIL:", e instanceof Error ? e.message : String(e)); }
