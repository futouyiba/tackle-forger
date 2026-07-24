import { deterministicHash } from "./rule-kernel";
import type { ReductionPolicyMachineRule } from "./reduction-stacking-policy";
import { parseFiveAxisWeightBandPolicyFromWeightTemplate } from "./five-axis-weight-band-policy-source";
import type { FiveAxisWeightBandPolicy } from "./types";

export type FeishuSheetRole =
  | "rule_source"
  | "development_plan"
  | "historical_reference"
  | "staging_output"
  | "publish_control";

export interface FeishuWorkbookRef {
  id: string;
  name: string;
  provider: "feishu_sheets";
  shareUrl: string;
  wikiToken: string;
  spreadsheetToken?: string;
  anchorSheetId?: string;
  syncScope: "workbook";
  enabled: boolean;
}

export interface FeishuSheetRegistryEntry {
  sheetId: string;
  expectedName: string;
  role: FeishuSheetRole;
  required: boolean;
  importsRules: boolean;
  canOverwriteDomainTruth: boolean;
}

export interface RemoteFeishuSheet {
  sheetId: string;
  name: string;
  rowCount?: number;
  columnCount?: number;
}

export interface FeishuSheetRegistryIssue {
  code: "SHEET_MISSING" | "SHEET_RENAMED" | "UNREGISTERED_SHEET" | "DUPLICATE_SHEET_ID";
  severity: "warning" | "error";
  sheetId: string;
  expectedName?: string;
  observedName?: string;
  message: string;
}

export interface FeishuSourceRevision {
  id: string;
  workbookRefId: string;
  sourceRevision: string;
  spreadsheetToken: string;
  pulledAt: string;
  pulledBy: string;
  anchorSheetId?: string;
  syncScope: "workbook";
  registryHash: string;
  sheets: RemoteFeishuSheet[];
  issues: FeishuSheetRegistryIssue[];
  /** 仅由权威 04_词条/zrVOxd 机器规则区解析；外部工作簿不得填充为运行时规则。 */
  reductionPolicyMachineRules?: ReductionPolicyMachineRule[];
  /** Hash of the immutable W-band policy payload read from this exact workbook revision. */
  fiveAxisWeightBandPolicyContentHash?: string;
  /** Normalized immutable payload read from d6e928; absence is non-formal. */
  fiveAxisWeightBandPolicy?: FiveAxisWeightBandPolicy;
  state: "PULLED" | "RULESET_DRAFT" | "PUBLISHED";
}

export interface FeishuWorkbookPullAdapter {
  resolveWorkbook(ref: FeishuWorkbookRef): Promise<{
    spreadsheetToken: string;
    sourceRevision: string;
    sheets: RemoteFeishuSheet[];
  }>;
  readRanges?(input: { spreadsheetToken: string; requests: Array<{ sheetId: string; range: string }> }): Promise<Array<{ sheetId: string; range: string; revision: string; values: unknown[][] }>>;
}

export const CANONICAL_FEISHU_WORKBOOK: FeishuWorkbookRef = {
  id: "feishu-workbook:tackle-design",
  name: "钓具设计工作簿",
  provider: "feishu_sheets",
  shareUrl: "https://pisn3u3ony2.feishu.cn/wiki/YsEKwSUJ5i86HCkZKBVcNMw7nOh?from=from_copylink&sheet=9nE3Rx",
  wikiToken: "YsEKwSUJ5i86HCkZKBVcNMw7nOh",
  anchorSheetId: "9nE3Rx",
  syncScope: "workbook",
  enabled: true,
};

/**
 * 由飞书分享链接构造可配置的工作簿引用。支持 `/wiki/` 与 `/sheets/` 两种形式：
 *
 * - `/wiki/{node_token}`：填 `wikiToken`，`spreadsheetToken` 留空，由拉取层后续
 *   调用 wiki get_node 解析得到电子表格 token。
 * - `/sheets/{spreadsheet_token}`：直接填 `spreadsheetToken`，`wikiToken` 留空字符串，
 *   不经过 wiki 解析。
 *
 * `id` 由 token 稳定派生（`feishu-workbook:<token>`），同一链接反复解析得到同一引用，
 * 便于前端历史去重。`name` 缺省时给一个中立默认值，调用方可传入更贴切的标签。
 */
export function buildWorkbookRefFromShareUrl(
  shareUrl: string,
  name?: string,
): FeishuWorkbookRef {
  const parsed = parseCanonicalWorkbookLink(shareUrl);
  const token = parsed.wikiToken ?? parsed.spreadsheetToken ?? "";
  if (!token) {
    throw new Error("飞书规则工作簿链接缺少可识别的 token。");
  }
  const trimmedName = name?.trim();
  return {
    id: `feishu-workbook:${token}`,
    name: trimmedName || "自定义规则工作簿",
    provider: "feishu_sheets",
    shareUrl: shareUrl.trim(),
    wikiToken: parsed.wikiToken ?? "",
    ...(parsed.spreadsheetToken ? { spreadsheetToken: parsed.spreadsheetToken } : {}),
    ...(parsed.anchorSheetId ? { anchorSheetId: parsed.anchorSheetId } : {}),
    syncScope: "workbook",
    enabled: true,
  };
}

export const CANONICAL_FEISHU_SHEET_REGISTRY: FeishuSheetRegistryEntry[] = [
  ["mLpTLK", "04.0_FunctionProfile常量", "rule_source", true, true],
  ["d6e928", "01_重量模板", "rule_source", true, true],
  ["4IfBoX", "00_使用说明", "historical_reference", false, false],
  ["rgFPUu", "02_钓法类型", "rule_source", true, true],
  ["m3eQCg", "02.5_钓法模板", "historical_reference", false, false],
  ["fATowU", "03_类型材质", "rule_source", true, true],
  ["vviXo0", "04_功能定位", "rule_source", true, true],
  ["zrVOxd", "04_词条", "rule_source", true, true],
  ["RdZv0J", "05_技术", "rule_source", true, true],
  ["9nE3Rx", "06_系列", "rule_source", true, true],
  ["FqD4j7", "07_品质评分", "rule_source", true, true],
  ["u87sRh", "08_价格计算", "rule_source", true, true],
  ["wxORcd", "09_甘特图", "development_plan", false, false],
  ["KZv4o2", "10_校验规则", "rule_source", true, true],
  ["eXV1dI", "11_组合SKU", "historical_reference", false, false],
  ["lf4wIM", "12_打包竿组", "historical_reference", false, false],
  ["M17p0j", "13_上传发布", "publish_control", false, false],
  ["hekdpO", "14_Rods", "staging_output", false, false],
  ["oUp48w", "15_Reels", "staging_output", false, false],
  ["YTYwgS", "16_Lines", "staging_output", false, false],
  ["VFxDxt", "17_Item", "staging_output", false, false],
].map(([sheetId, expectedName, role, required, importsRules]) => ({
  sheetId: String(sheetId),
  expectedName: String(expectedName),
  role: role as FeishuSheetRole,
  required: Boolean(required),
  importsRules: Boolean(importsRules),
  canOverwriteDomainTruth: false,
}));

/**
 * 解析权威规则源工作簿链接。
 *
 * - `/wiki/{node_token}`：知识库挂载形式，提取 wikiToken；电子表格 token 由读取层
 *   后续调用 wiki get_node 解析得到（`resolveWikiSpreadsheetToken`）。
 * - `/sheets/{spreadsheet_token}`：未挂载知识库的直接电子表格形式，直接把 path 段
 *   当作 spreadsheetToken，不经过 wiki 解析。
 *
 * 两种形式都剥离 `sheet=`/`from=` 等 query 参数：`sheet` 仅用于定位初始可见工作表，
 * 同步边界始终是链接解析后的整个工作簿。
 */
export type ParsedCanonicalWorkbookLink = {
  /** `/wiki/` 形式解析得到的 wiki 节点 token；`/sheets/` 直接形式时缺省。 */
  wikiToken?: string;
  /** `/sheets/` 直接形式解析得到的电子表格 token；`/wiki/` 形式时缺省。 */
  spreadsheetToken?: string;
  anchorSheetId?: string;
  syncScope: "workbook";
};

export function parseCanonicalWorkbookLink(input: string): ParsedCanonicalWorkbookLink {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("飞书规则工作簿链接格式不正确。");
  }
  const wikiMatch = url.pathname.match(/\/wiki\/([^/?#]+)/i);
  if (wikiMatch) {
    return {
      wikiToken: decodeURIComponent(wikiMatch[1]),
      anchorSheetId: url.searchParams.get("sheet") ?? undefined,
      syncScope: "workbook",
    };
  }
  const sheetsMatch = url.pathname.match(/\/sheets\/([^/?#]+)/i);
  if (sheetsMatch) {
    return {
      spreadsheetToken: decodeURIComponent(sheetsMatch[1]),
      anchorSheetId: url.searchParams.get("sheet") ?? undefined,
      syncScope: "workbook",
    };
  }
  throw new Error("唯一规则源必须使用飞书知识库工作簿链接。");
}

export function validateSheetRegistry(
  registry: FeishuSheetRegistryEntry[],
  remoteSheets: RemoteFeishuSheet[],
): FeishuSheetRegistryIssue[] {
  const issues: FeishuSheetRegistryIssue[] = [];
  const duplicateIds = remoteSheets.filter((sheet, index) =>
    remoteSheets.findIndex((candidate) => candidate.sheetId === sheet.sheetId) !== index,
  );
  for (const sheet of duplicateIds) {
    issues.push({
      code: "DUPLICATE_SHEET_ID",
      severity: "error",
      sheetId: sheet.sheetId,
      observedName: sheet.name,
      message: `远端返回重复 sheet_id ${sheet.sheetId}，已阻止拉取。`,
    });
  }
  const remoteById = new Map(remoteSheets.map((sheet) => [sheet.sheetId, sheet]));
  const registryById = new Map(registry.map((entry) => [entry.sheetId, entry]));
  for (const expected of registry) {
    const observed = remoteById.get(expected.sheetId);
    if (!observed) {
      if (expected.required) {
        issues.push({
          code: "SHEET_MISSING",
          severity: "error",
          sheetId: expected.sheetId,
          expectedName: expected.expectedName,
          message: `缺少必需工作表 ${expected.expectedName}/${expected.sheetId}。`,
        });
      }
      continue;
    }
    if (observed.name !== expected.expectedName) {
      issues.push({
        code: "SHEET_RENAMED",
        severity: "warning",
        sheetId: expected.sheetId,
        expectedName: expected.expectedName,
        observedName: observed.name,
        message: `sheet_id ${expected.sheetId} 名称已从“${expected.expectedName}”变为“${observed.name}”；仍按稳定 ID 读取。`,
      });
    }
  }
  for (const observed of remoteSheets) {
    if (!registryById.has(observed.sheetId)) {
      issues.push({
        code: "UNREGISTERED_SHEET",
        severity: "warning",
        sheetId: observed.sheetId,
        observedName: observed.name,
        message: `发现未注册工作表“${observed.name}”/${observed.sheetId}；不会按同名猜测用途。`,
      });
    }
  }
  return issues;
}

export async function pullFeishuWorkbookRevision(input: {
  workbook: FeishuWorkbookRef;
  registry?: FeishuSheetRegistryEntry[];
  adapter: FeishuWorkbookPullAdapter;
  pulledAt: string;
  pulledBy: string;
}): Promise<FeishuSourceRevision> {
  if (!input.workbook.enabled) throw new Error("飞书规则工作簿已停用。");
  const parsed = parseCanonicalWorkbookLink(input.workbook.shareUrl);
  // /wiki/ 挂载形式必须与已登记 wikiToken 一致；/sheets/ 直接形式无 wikiToken，
  // 电子表格 token 由 ref.spreadsheetToken 直接提供，跳过该一致性校验。
  if (parsed.wikiToken !== undefined && parsed.wikiToken !== input.workbook.wikiToken) {
    throw new Error("工作簿链接与已登记 wikiToken 不一致。");
  }
  const remote = await input.adapter.resolveWorkbook(input.workbook);
  if (!remote.sourceRevision.trim()) throw new Error("飞书未返回工作簿 revision。");
  const registry = input.registry ?? CANONICAL_FEISHU_SHEET_REGISTRY;
  const issues = validateSheetRegistry(registry, remote.sheets);
  const policyRanges = input.adapter.readRanges
    ? await input.adapter.readRanges({ spreadsheetToken: remote.spreadsheetToken, requests: [{ sheetId: "d6e928", range: "A1:AE54" }] })
    : undefined;
  const policyRange = policyRanges?.find((entry) => entry.sheetId === "d6e928" && entry.range === "A1:AE54");
  if (policyRanges && (!policyRange || policyRange.revision !== remote.sourceRevision)) throw new Error("FIVE_AXIS_WEIGHT_BAND_POLICY_SOURCE_INVALID：未读取到同一 revision 的 d6e928 机器区。");
  const fiveAxisWeightBandPolicy = policyRange
    ? parseFiveAxisWeightBandPolicyFromWeightTemplate({ sourceRevision: remote.sourceRevision, values: policyRange.values })
    : undefined;
  const content = {
    workbookRefId: input.workbook.id,
    sourceRevision: remote.sourceRevision,
    spreadsheetToken: remote.spreadsheetToken,
    pulledAt: input.pulledAt,
    pulledBy: input.pulledBy,
    anchorSheetId: parsed.anchorSheetId,
    syncScope: "workbook" as const,
    registryHash: deterministicHash(registry),
    sheets: structuredClone(remote.sheets),
    issues,
    ...(fiveAxisWeightBandPolicy ? { fiveAxisWeightBandPolicy, fiveAxisWeightBandPolicyContentHash: fiveAxisWeightBandPolicy.contentHash } : {}),
    state: "PULLED" as const,
  };
  return { id: `feishu-revision:${deterministicHash(content)}`, ...content };
}
