/**
 * 飞书开放接口失败的结构化错误载体（可诊断性改进）。
 *
 * 既往实现把飞书失败拼成单个字符串（`飞书电子表格接口失败：${msg}`），
 * 丢弃了飞书 envelope 的 `code`、HTTP status、出错的 open-apis 端点以及
 * 涉及的 token 类型，导致服务端日志与前端 DevTools 都无法区分
 * 「权限不足 / 资源不存在 / 飞书 5xx / token 问题」。
 *
 * `FeishuApiError` 保留可读的中文 message（兼容既有 UI 文案与 `error.message`
 * 消费方），同时携带结构化字段供路由写入服务端日志、并输出脱敏后的
 * `errorInfo` 到响应体。token 永远以脱敏形式出现在 `tokenContext`，
 * 不会进入响应体。
 */
export interface FeishuApiErrorInit {
  /** 可读中文原因前缀，例如「飞书电子表格接口失败」「飞书身份认证失败」。 */
  reason: string;
  /** 飞书 envelope 的 `code`（0 表示成功；非 0 为错误码）。 */
  code?: number;
  /** 飞书 envelope 的 `msg`。 */
  msg?: string;
  /** open-apis 响应的 HTTP status。 */
  httpStatus: number;
  /** 失败的 open-apis 端点路径（已去除 query string 与 host）。 */
  endpoint: string;
  /** 涉及 token / 资源的脱敏描述，例如 `wiki:YsEK…7nOh`。 */
  tokenContext?: string;
}

/** 响应体 / DevTools 使用的脱敏 errorInfo（不含 token 任何信息）。 */
export interface FeishuApiErrorInfo {
  code?: number;
  msg?: string;
  endpoint: string;
  httpStatus: number;
}

export class FeishuApiError extends Error {
  readonly code: number | undefined;
  readonly feishuMsg: string | undefined;
  readonly httpStatus: number;
  readonly endpoint: string;
  readonly tokenContext: string | undefined;

  constructor(init: FeishuApiErrorInit) {
    const detail = init.msg || `HTTP ${init.httpStatus}`;
    const codePart = init.code !== undefined ? `（code=${init.code}）` : "";
    super(`${init.reason}：${detail}${codePart}`);
    this.name = "FeishuApiError";
    this.code = init.code;
    this.feishuMsg = init.msg;
    this.httpStatus = init.httpStatus;
    this.endpoint = init.endpoint;
    this.tokenContext = init.tokenContext;
  }

  /** 安全、不含 secret 的投影，用于 API 响应体与 DevTools。 */
  toErrorInfo(): FeishuApiErrorInfo {
    return {
      code: this.code,
      msg: this.feishuMsg,
      endpoint: this.endpoint,
      httpStatus: this.httpStatus,
    };
  }
}

/**
 * 脱敏 token：仅保留首尾若干字符。即便 token 本身不算长期 secret，
 * 日志里也只暴露足够识别「是哪个 token」的少量字符。
 */
export function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return `${token.slice(0, 2)}…`;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/**
 * 从完整的 open-apis URL 或相对路径中提取用于诊断的端点路径：
 * 去掉协议与 host，去掉 query string。例如
 * `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=x`
 * → `/open-apis/wiki/v2/spaces/get_node`。
 */
export function feishuEndpointPath(pathOrUrl: string): string {
  const withoutHost = pathOrUrl.replace(/^https?:\/\/[^/]+/i, "");
  const queryIndex = withoutHost.indexOf("?");
  return queryIndex >= 0 ? withoutHost.slice(0, queryIndex) : withoutHost;
}
