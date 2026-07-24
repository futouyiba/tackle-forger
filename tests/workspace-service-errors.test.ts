import assert from "node:assert/strict";
import test from "node:test";
import { workspaceServiceFailure } from "../lib/workspace-service-errors";

test("工作区部署身份错配保留 fail-closed 行为并提供稳定、无敏感诊断", () => {
  const result = workspaceServiceFailure(new Error("WORKSPACE_IDENTITY_MISMATCH：saved and deployment identities differ"));
  assert.deepEqual(result, {
    errorCode: "WORKSPACE-IDENTITY-001",
    error: "工作区的部署身份与已保存的数据不一致。为保护历史数据，系统未加载该工作区。请由部署管理员核对工作区身份配置后重试。",
    action: "contact_deployment_administrator",
  });
  assert.equal(JSON.stringify(result).includes("saved and deployment identities differ"), false);
});

test("其他工作区初始化失败不会被映射为认证故障", () => {
  const result = workspaceServiceFailure(new Error("sqlite unavailable"));
  assert.equal(result.errorCode, "WORKSPACE-SERVICE-001");
  assert.equal(result.action, "retry_workspace_load");
  assert.equal(result.error.includes("sqlite"), false);
});
