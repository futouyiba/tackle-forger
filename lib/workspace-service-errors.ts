/**
 * Stable, non-sensitive diagnostics for the authenticated workspace bootstrap.
 *
 * Authentication and workspace persistence are independent boundaries.  Do not
 * turn a storage or deployment-identity failure into an authentication failure:
 * doing so encourages users to repeat OAuth even though their session is valid.
 */
export type WorkspaceServiceFailure = {
  errorCode: "WORKSPACE-IDENTITY-001" | "WORKSPACE-SERVICE-001";
  error: string;
  action: "contact_deployment_administrator" | "retry_workspace_load";
};

export function workspaceServiceFailure(error: unknown): WorkspaceServiceFailure {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("WORKSPACE_IDENTITY_MISMATCH")) {
    return {
      errorCode: "WORKSPACE-IDENTITY-001",
      error: "工作区的部署身份与已保存的数据不一致。为保护历史数据，系统未加载该工作区。请由部署管理员核对工作区身份配置后重试。",
      action: "contact_deployment_administrator",
    };
  }
  return {
    errorCode: "WORKSPACE-SERVICE-001",
    error: "工作区服务暂时不可用，请稍后重试；若持续出现，请联系部署管理员。",
    action: "retry_workspace_load",
  };
}
