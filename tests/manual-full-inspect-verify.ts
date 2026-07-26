/**
 * 端到端验证：用 lark-cli 读 WQ8w 真实数据，跑完整品质+定价解析。
 * npx tsx tests/manual-full-inspect-verify.ts
 */
import { execSync } from "node:child_process";
import { CANONICAL_FEISHU_WORKBOOK } from "../lib/feishu-workbook";
import {
  qualityDraftFromRanges,
  pricingDraftFromRanges,
  pricingQualitySourceRowsFromDraft,
} from "../lib/rule-workbook-inspection";

const URL = CANONICAL_FEISHU_WORKBOOK.shareUrl;
const TOKEN = CANONICAL_FEISHU_WORKBOOK.spreadsheetToken!;

function readCsv(sheetId: string, range: string): unknown[][] {
  const r = execSync(
    `lark-cli sheets +csv-get --url "${URL}" --sheet-id "${sheetId}" --range "${range}" --json`,
    { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  );
  const j = JSON.parse(r);
  if (!j.ok || !j.data?.annotated_csv) return [];
  return j.data.annotated_csv.split(/\r?\n/).filter(Boolean).map((line: string) =>
    line.replace(/^\[row=\d+\]\s*/, "").split(","),
  );
}

function getMeta(sheetId: string) {
  const r = execSync(`lark-cli sheets +workbook-info --url "${URL}" --json`, { encoding: "utf8" });
  const s = (JSON.parse(r).data.sheets as Array<{ sheet_id: string; row_count: number; column_count: number }>)
    .find((s: { sheet_id: string }) => s.sheet_id === sheetId);
  return s ?? { row_count: 200, column_count: 30 };
}

console.log("=== WQ8w 品质+定价 解析验证 ===\n");

const sr = { id: "verify", workbookRefId: CANONICAL_FEISHU_WORKBOOK.id, sourceRevision: "1", spreadsheetToken: TOKEN, pulledAt: new Date().toISOString(), pulledBy: "verify", syncScope: "workbook" as const, registryHash: "x", sheets: [], issues: [], state: "PULLED" as const };

// Read data
console.log("读取数据...");
const qv = readCsv("27hboC", "A1:F6");
const av = readCsv("23CsXE", "A1:E47");
const mv = readCsv("28fQhg", "A1:C711");
const pv = readCsv("31RxeB", "A1:A7");
const pv2 = readCsv("32BmZs", "A1:E10");
const pv3 = readCsv("33IGHy", "A1:E193");
const tv = readCsv("10TyFp", "A1:V22").concat(readCsv("11CfXW", "A1:AD30"), readCsv("12VetE", "A1:V22"));
console.log(`  品质:${qv.length} 词条:${av.length} 矩阵:${mv.length} 定价:${pv.length}/${pv2.length}/${pv3.length} 类型:${tv.length}`);

// Quality
console.log("\n--- 品质解析 ---");
try {
  const qd = qualityDraftFromRanges({ sourceRevision: sr, qualityValues: qv, qualityRange: `A1:F6`, affixValues: av, matrixValues: mv, pricingEndpointValues: pv3, importedAt: new Date().toISOString() });
  const e = qd.issues?.filter((i: { severity: string }) => i.severity === "ERROR") ?? [];
  const g = new Map<string, number>();
  for (const i of e) g.set(i.code, (g.get(i.code) ?? 0) + 1);
  console.log(`  ranges: ${qd.ranges?.length}, errors: ${e.length}, descriptor rows: ${qd.qualityTableDescriptor?.rows?.length ?? 0}`);
  if (g.size) { console.log("  错误汇总:"); for (const [k, c] of g) console.log(`    ${k} ×${c}`); }
  else console.log("  ✅ 品质解析无阻断错误");

  // Pricing
  console.log("\n--- 定价解析 ---");
  const pq = pricingQualitySourceRowsFromDraft(qd);
  const pd = pricingDraftFromRanges({ sourceRevision: sr, qualityValues: [], qualitySourceRows: pq, pricingValues: pv, pricingParamsValues: pv2, pricingEndpointValues: pv3, typeValues: tv, importedAt: new Date().toISOString() });
  const pe = pd.issues.filter((i: { severity: string }) => i.severity === "error");
  console.log(`  errors: ${pe.length}, formalStatus: ${pd.formalStatus}`);
  for (const i of pe) console.log(`    ${i.code}: ${i.message}`);
  if (!pe.length) console.log("  ✅ 定价解析无阻断错误");

  console.log("\n=== 总结 ===");
  const total = e.length + pe.length;
  console.log(total === 0 ? "✅ 零阻断！品质+定价全部通过。" : `❌ ${total} 个阻断。`);
} catch (err) { console.error("异常:", err instanceof Error ? err.message : String(err)); }
