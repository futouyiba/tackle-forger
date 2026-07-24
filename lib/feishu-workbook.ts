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
  /** /wiki/ 挂载形式的 wiki 节点 token；/sheets/ 直接电子表格形式时缺省。 */
  wikiToken?: string;
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
 * v3 §14（2026-07-25 权威表迁移）指定的新表权威规则源身份（WQ8w，`/sheets/` 直接电子表格形式）。
 *
 * PR2a 地基：本 PR 仅登记新表身份与 50 张分表 registry，与既有 `CANONICAL_FEISHU_WORKBOOK`
 * （YsEKw `/wiki/`）并存；读取层、`CANONICAL_FEISHU_WORKBOOK` 与 `CANONICAL_FEISHU_SHEET_REGISTRY`
 * 全部保持不动，切流由后续 PR 跟踪（#143）。`wikiToken` 留空：`/sheets/` 直接形式不经 wiki 解析。
 */
export const NEW_CANONICAL_FEISHU_WORKBOOK: FeishuWorkbookRef = {
  id: "feishu-workbook:tackle-design-new",
  name: "钓具设计工作簿（新表·设计稿镜像）",
  provider: "feishu_sheets",
  shareUrl: "https://pisn3u3ony2.feishu.cn/sheets/WQ8wstS4ch29E2tAKnVcoh5KnJg?sheet=0iGCcx",
  spreadsheetToken: "WQ8wstS4ch29E2tAKnVcoh5KnJg",
  anchorSheetId: "0iGCcx",
  syncScope: "workbook",
  enabled: true,
};

/**
 * 新表（WQ8w）50 张分表注册表，按 `docs/audits/feishu-source-to-v3-mapping.md` 50 行登记。
 *
 * role 按对照表实现状态与语义映射：
 * - `rule_source`（对照表 ✅，required=true/importsRules=true）：竿/轮/线分表的重量模板、
 *   钓法类型、类型材质、功能定位、FunctionProfile 常量与功能模板、词条、技术、系列、品质评分、
 *   价格计算（公式/参数释义/维修消耗速度）、校验规则（枚举/竿组/竿/轮/线）；
 * - `historical_reference`：00_系统接入、02.5/03.5 派生模板镜像、12.x 组合SKU 样例、13 打包竿组；
 * - `staging_output`：09.3/09.4 空定价表、15-18 配置表 schema、19_Patch台账空镜像（均源数据待补/暂存）；
 * - `development_plan`：10 钓具甘特图示意；`publish_control`：14 上传发布。
 *
 * 全部 `canOverwriteDomainTruth=false`；`sheetId` 全局唯一（由 `validateFeishuWorkbookConfiguration` 校验）。
 */
export const NEW_CANONICAL_FEISHU_SHEET_REGISTRY: FeishuSheetRegistryEntry[] = [
  ["0iGCcx", "00_系统接入", "historical_reference", false, false],
  ["1cAihB", "01.0_重量模板-竿", "rule_source", true, true],
  ["2KCCHR", "01.1_重量模板-轮", "rule_source", true, true],
  ["3FYijT", "01.2_重量模板-线", "rule_source", true, true],
  ["4zXYpP", "02.0_钓法类型-竿", "rule_source", true, true],
  ["5oZXTO", "02.1_钓法类型-轮", "rule_source", true, true],
  ["6FwSyV", "02.2_钓法类型-线", "rule_source", true, true],
  ["7ygxLI", "02.5.0_钓法模板-竿", "historical_reference", false, false],
  ["8pvTQG", "02.5.1_钓法模板-轮", "historical_reference", false, false],
  ["9gvEsP", "02.5.2_钓法模板-线", "historical_reference", false, false],
  ["10TyFp", "03.0_类型材质-竿", "rule_source", true, true],
  ["11CfXW", "03.1_类型材质-轮", "rule_source", true, true],
  ["12VetE", "03.2_类型材质-线", "rule_source", true, true],
  ["13awql", "03.5.0_类型模板-竿", "historical_reference", false, false],
  ["14rhyG", "03.5.1_类型模板-轮", "historical_reference", false, false],
  ["15nsqs", "03.5.2_类型模板-线", "historical_reference", false, false],
  ["16qYVn", "04.0_功能定位-竿", "rule_source", true, true],
  ["17jqiE", "04.1_功能定位-轮", "rule_source", true, true],
  ["18pjcZ", "04.2_功能定位-线", "rule_source", true, true],
  ["19XKzU", "04.00_FunctionProfile常量", "rule_source", true, true],
  ["20OOnC", "04.5.0_功能模板-竿", "rule_source", true, true],
  ["21kEvM", "04.5.1_功能模板-轮", "rule_source", true, true],
  ["22RAak", "04.5.2_功能模板-线", "rule_source", true, true],
  ["23CsXE", "05_词条", "rule_source", true, true],
  ["24YDSO", "06_技术", "rule_source", true, true],
  ["25UnTC", "07_系列", "rule_source", true, true],
  ["26gpIF", "08.0_品质评分-公式", "rule_source", true, true],
  ["27hboC", "08.1_品质评分-品质定义", "rule_source", true, true],
  ["28fQhg", "08.2_品质评分-词条组合", "rule_source", true, true],
  ["31RxeB", "09.0_价格计算-公式", "rule_source", true, true],
  ["32BmZs", "09.1_价格计算-参数释义", "rule_source", true, true],
  ["33IGHy", "09.2_价格计算-维修消耗速度", "rule_source", true, true],
  ["34KaIv", "09.3_价格计算-部件占比", "staging_output", false, false],
  ["35bCfX", "09.4_价格计算-各部位全损时间-零整比", "staging_output", false, false],
  ["36GGVk", "10_钓具甘特图示意", "development_plan", false, false],
  ["37YLZE", "11.0_校验规则-枚举", "rule_source", true, true],
  ["38LXDQ", "11.1_校验规则-竿组", "rule_source", true, true],
  ["39IhAP", "11.2_校验规则-竿", "rule_source", true, true],
  ["40RwxO", "11.3_校验规则-轮", "rule_source", true, true],
  ["41CgUB", "11.4_校验规则-线", "rule_source", true, true],
  ["42ACks", "12.0_组合SKU-竿", "historical_reference", false, false],
  ["43dYFE", "12.1_组合SKU-轮", "historical_reference", false, false],
  ["44YIZT", "12.2_组合SKU-线", "historical_reference", false, false],
  ["45qauz", "13_打包竿组", "historical_reference", false, false],
  ["46ogtj", "14_上传发布", "publish_control", false, false],
  ["47PfUw", "15_Rods", "staging_output", false, false],
  ["48IxFG", "16_Reels", "staging_output", false, false],
  ["49kgpf", "17_Lines", "staging_output", false, false],
  ["50Yure", "18_Item", "staging_output", false, false],
  ["51FogM", "19_Patch台账", "staging_output", false, false],
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

/**
 * 校验权威规则源工作簿登记与工作表注册表的自洽性。
 *
 * 链接形式按 `parseCanonicalWorkbookLink` 的解析结果分支：
 * - `/wiki/`（wikiToken 存在）：wikiToken 必须与登记完全一致——`/wiki/` 旧行为完全不变；
 * - `/sheets/`（spreadsheetToken 存在、wikiToken 缺省）：按 spreadsheetToken 校验，
 *   不强求 wikiToken，也不与 `workbook.wikiToken` 比对。
 *
 * PR2a 地基：当前 `pullFeishuWorkbookRevision` 仍走既有内联校验，本函数供新表登记自检与
 * 后续切流 PR 复用；本 PR 不切 canonical、不动读取层。
 */
export function validateFeishuWorkbookConfiguration(
  workbook: FeishuWorkbookRef,
  registry: FeishuSheetRegistryEntry[],
): void {
  if (!workbook.id.trim() || !workbook.name.trim() || workbook.provider !== "feishu_sheets") {
    throw new Error("飞书规则工作簿登记缺少稳定身份或 provider 无效。");
  }
  if (workbook.syncScope !== "workbook") {
    throw new Error("飞书唯一规则源的同步范围必须是整本工作簿。");
  }
  const parsed = parseCanonicalWorkbookLink(workbook.shareUrl);
  if (parsed.wikiToken) {
    // /wiki/ 挂载形式：保持既有契约，wikiToken 必须与登记一致。
    if (parsed.wikiToken !== workbook.wikiToken) {
      throw new Error("工作簿链接与已登记 wikiToken 不一致。");
    }
  } else if (parsed.spreadsheetToken) {
    // /sheets/ 直接电子表格形式：按 spreadsheetToken 校验，不强求也不比对 wikiToken。
    if (workbook.spreadsheetToken && parsed.spreadsheetToken !== workbook.spreadsheetToken) {
      throw new Error("工作簿链接与已登记 spreadsheetToken 不一致。");
    }
  } else {
    throw new Error("唯一规则源必须使用飞书知识库工作簿链接。");
  }
  if (workbook.anchorSheetId && parsed.anchorSheetId !== workbook.anchorSheetId) {
    throw new Error("工作簿链接的定位 sheet 与已登记 anchorSheetId 不一致。");
  }
  const seen = new Set<string>();
  for (const entry of registry) {
    if (!entry.sheetId.trim() || !entry.expectedName.trim()) {
      throw new Error("飞书工作表注册表存在空 sheet_id 或名称。");
    }
    if (seen.has(entry.sheetId)) {
      throw new Error(`飞书工作表注册表存在重复 sheet_id ${entry.sheetId}。`);
    }
    seen.add(entry.sheetId);
  }
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
  if (parsed.wikiToken !== input.workbook.wikiToken) {
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
