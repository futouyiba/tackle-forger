export interface ParsedFeishuSourceLink {
  appToken: string;
  tableId: string;
  viewId: string;
}

export interface FeishuTableOption {
  id: string;
  name: string;
}

export interface FeishuViewOption {
  id: string;
  name: string;
  type: string;
}

export interface ResolvedFeishuSource extends ParsedFeishuSourceLink {
  tables: FeishuTableOption[];
  views: FeishuViewOption[];
}

export function parseFeishuSourceLink(input: string): ParsedFeishuSourceLink {
  const value = input.trim();
  if (!value) throw new Error("请粘贴飞书多维表格分享链接。");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("链接格式不正确，请从飞书地址栏或分享面板复制完整链接。");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname !== "feishu.cn" &&
    !hostname.endsWith(".feishu.cn") &&
    hostname !== "larksuite.com" &&
    !hostname.endsWith(".larksuite.com")
  ) {
    throw new Error("这不是飞书或 Lark 链接。");
  }

  const baseMatch = url.pathname.match(/\/base\/([^/?#]+)/i);
  if (!baseMatch) {
    if (/\/sheets\//i.test(url.pathname)) {
      throw new Error("当前连接器读取的是飞书多维表格（Base），请粘贴 /base/ 开头的链接。");
    }
    if (/\/wiki\//i.test(url.pathname)) {
      throw new Error("知识库链接暂不能直接解析，请在飞书中打开原始多维表格后复制 /base/ 链接。");
    }
    throw new Error("链接中没有找到多维表格标识，请确认链接包含 /base/。");
  }

  return {
    appToken: decodeURIComponent(baseMatch[1]),
    tableId: url.searchParams.get("table") ?? url.searchParams.get("table_id") ?? "",
    viewId: url.searchParams.get("view") ?? url.searchParams.get("view_id") ?? "",
  };
}