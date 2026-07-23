import { deterministicHash } from "./rule-kernel";
import type { ReductionPolicyMachineRule } from "./reduction-stacking-policy";

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
  state: "PULLED" | "RULESET_DRAFT" | "PUBLISHED";
}

export interface FeishuWorkbookPullAdapter {
  resolveWorkbook(ref: FeishuWorkbookRef): Promise<{
    spreadsheetToken: string;
    sourceRevision: string;
    sheets: RemoteFeishuSheet[];
  }>;
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

export function parseCanonicalWorkbookLink(input: string): Pick<FeishuWorkbookRef, "wikiToken" | "anchorSheetId" | "syncScope"> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("飞书规则工作簿链接格式不正确。");
  }
  const match = url.pathname.match(/\/wiki\/([^/?#]+)/i);
  if (!match) throw new Error("唯一规则源必须使用飞书知识库工作簿链接。");
  return {
    wikiToken: decodeURIComponent(match[1]),
    anchorSheetId: url.searchParams.get("sheet") ?? undefined,
    syncScope: "workbook",
  };
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
    state: "PULLED" as const,
  };
  return { id: `feishu-revision:${deterministicHash(content)}`, ...content };
}
