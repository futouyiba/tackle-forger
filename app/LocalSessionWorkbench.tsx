"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  createInitialAppShellState,
  transitionAppShell,
  type AppShellEvent,
  type AppShellState,
} from "@/lib/app-shell-state";
import {
  createLocalSessionModel,
  reduceLocalSession,
  type LocalEditableRuleOperation,
  type LocalSessionDocument,
  type LocalSessionReducerState,
} from "@/lib/local-session-contracts";
import { LocalSessionIdentityAllocator } from "@/lib/local-session-operation-identity";
import {
  LocalSessionParserError,
  LocalSessionWorkbookLoader,
} from "@/lib/local-session-parser";
import {
  deriveLocalSessionTemplate,
  parseLocalTemplateValuesJson,
  validateLocalSessionDocument,
} from "@/lib/local-session-rules-kernel";
import type { WorkspaceState } from "@/lib/types";
import { Workbench } from "./Workbench";

type EditorTab = "parameters" | "templates" | "rules" | "trace";
type SharedPayload = {
  revision?: number;
  state?: WorkspaceState;
  user?: { openId?: string; name?: string; displayName?: string };
  error?: string;
};

const OPERATION_LABELS: Record<LocalEditableRuleOperation, string> = {
  add: "加",
  multiply: "乘",
  set: "设为",
  min: "上限",
  max: "下限",
  formula: "公式",
};

function applyAcceptedEvents(
  state: AppShellState,
  events: readonly AppShellEvent[],
): AppShellState | null {
  let current = state;
  for (const event of events) {
    const transition = transitionAppShell(current, event);
    if (!transition.accepted) return null;
    current = transition.state;
  }
  return current;
}

function authName(state: AppShellState) {
  if (state.auth.status === "authenticated") return state.auth.principal.displayName;
  if (state.auth.status === "loading") return "检查登录状态…";
  if (state.auth.status === "failed") return "登录服务暂不可用";
  return "匿名本地模式";
}

function numericInput(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function LocalSessionWorkbench() {
  const [identities] = useState(() => new LocalSessionIdentityAllocator());
  const [loader] = useState(() => new LocalSessionWorkbookLoader({
    identityAllocator: identities,
  }));
  const [bootstrapOperation] = useState(() => identities.allocate("operation"));
  const [shell, setShell] = useState(() =>
    createInitialAppShellState(bootstrapOperation));
  const [local, setLocal] = useState<LocalSessionReducerState>({ status: "empty" });
  const [tab, setTab] = useState<EditorTab>("parameters");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [notice, setNotice] = useState("本地模式不写入浏览器或服务器存储。");
  const [sharedState, setSharedState] = useState<WorkspaceState | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const loginPoll = useRef<number | null>(null);
  const loginOperation = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as SharedPayload;
        if (!active) return;
        if (response.status === 401) {
          setShell((state) => transitionAppShell(state, {
            type: "auth_session_anonymous",
            operationId: bootstrapOperation,
          }).state);
          return;
        }
        if (!response.ok || !payload.user?.openId) {
          setShell((state) => transitionAppShell(state, {
            type: "auth_session_failed",
            operationId: bootstrapOperation,
            code: "AUTH_SESSION_UNAVAILABLE",
          }).state);
          return;
        }
        setShell((state) => transitionAppShell(state, {
          type: "auth_session_authenticated",
          operationId: bootstrapOperation,
          principal: {
            openId: payload.user!.openId!,
            displayName:
              payload.user!.displayName ?? payload.user!.name ?? payload.user!.openId!,
          },
        }).state);
      })
      .catch(() => {
        if (!active) return;
        setShell((state) => transitionAppShell(state, {
          type: "auth_session_failed",
          operationId: bootstrapOperation,
          code: "AUTH_NETWORK_UNAVAILABLE",
        }).state);
      });
    return () => {
      active = false;
      if (loginPoll.current !== null) window.clearInterval(loginPoll.current);
      loginPoll.current = null;
      loginOperation.current = null;
      loader.clear();
    };
  }, [bootstrapOperation, loader]);

  const session = local.status === "active" ? local.session : undefined;
  const derivation = useMemo(
    () => session && selectedTemplateId
      ? deriveLocalSessionTemplate(session.document, selectedTemplateId)
      : null,
    [selectedTemplateId, session],
  );
  const issues = useMemo(
    () => session ? validateLocalSessionDocument(session.document) : [],
    [session],
  );

  if (sharedState) return <Workbench initialState={sharedState} />;

  const commit = (document: LocalSessionDocument, label: string) => {
    const operationId = identities.allocate("operation");
    setLocal((state) => reduceLocalSession(state, {
      type: "commit_local_edit",
      document,
    }));
    setNotice(`${label} · 操作 ${operationId}`);
  };

  const activateBlank = () => {
    const operationId = identities.allocate("operation");
    const readyId = identities.allocate("resource");
    const sessionModel = createLocalSessionModel({ kind: "temporary_workspace" });
    const nextShell = applyAcceptedEvents(shell, [
      { type: "local_selection_requested", operationId },
      { type: "local_parse_started", operationId, selectionRef: "temporary:blank" },
      { type: "local_parse_succeeded", operationId, readyId, session: sessionModel },
    ]);
    if (!nextShell) {
      setNotice("共享工作区正在加载；本地会话保持不变。");
      return;
    }
    setShell(nextShell);
    loader.clear();
    setLocal({ status: "active", session: sessionModel });
    setSelectedTemplateId("");
    setNotice(`已创建完全空白的临时会话 · 资源 ${readyId}`);
  };

  const openWorkbook = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const operationId = identities.allocate("operation");
    const nextShell = applyAcceptedEvents(shell, [
      { type: "local_selection_requested", operationId },
      { type: "local_parse_started", operationId, selectionRef: file.name },
    ]);
    if (!nextShell) {
      setNotice("共享工作区正在加载；已拒绝新的本地文件操作。");
      return;
    }
    setShell(nextShell);
    setNotice(`正在解析 ${file.name}；现有本地会话保持可用。`);
    try {
      const ready = await loader.open(file, operationId, true);
      let handled = false;
      setShell((state) => {
        const transition = transitionAppShell(state, {
          type: "local_parse_succeeded",
          operationId,
          readyId: ready.resourceHandle,
          session: ready.result.session,
        });
        if (!handled) {
          handled = true;
          queueMicrotask(() => {
            if (transition.accepted) {
              setLocal({ status: "active", session: ready.result.session });
              setSelectedTemplateId(
                ready.result.session.document.templates[0]?.id ?? "",
              );
              setNotice(`已打开 canonical WQ8w 工作簿 · 资源 ${ready.resourceHandle}`);
            } else {
              loader.clear();
              setNotice("迟到的解析结果已拒绝并释放。");
            }
          });
        }
        return transition.state;
      });
    } catch (error) {
      setShell((state) => transitionAppShell(state, {
        type: "local_parse_failed",
        operationId,
      }).state);
      setNotice(
        error instanceof LocalSessionParserError
          ? `${error.code}：${error.message}（原本地会话未变）`
          : "本地工作簿解析失败（原本地会话未变）。",
      );
    }
  };

  const clear = () => {
    identities.allocate("operation");
    loader.clear();
    const activeLoginOperation = loginOperation.current;
    if (loginPoll.current !== null) window.clearInterval(loginPoll.current);
    loginPoll.current = null;
    loginOperation.current = null;
    setShell((state) => {
      let next = transitionAppShell(
        state,
        { type: "local_source_clear_requested" },
      ).state;
      if (activeLoginOperation) {
        const cancelled = transitionAppShell(next, {
          type: "oauth_cancelled",
          operationId: activeLoginOperation,
        });
        if (cancelled.accepted) next = cancelled.state;
      }
      return next;
    });
    setLocal((state) => reduceLocalSession(state, { type: "clear_local_session" }));
    setSelectedTemplateId("");
    setNotice("本地会话及其内存资源已清除；刷新后不可恢复。");
  };

  const login = () => {
    const operationId = identities.allocate("operation");
    const transition = transitionAppShell(shell, {
      type: "login_requested",
      operationId,
    });
    if (!transition.accepted) return;
    if (loginPoll.current !== null) window.clearInterval(loginPoll.current);
    loginOperation.current = operationId;
    setShell(transition.state);
    window.open(
      "/api/auth/feishu/start?return_to=%2F%3Flocal_auth_complete%3D1",
      "tackle-forger-feishu-login",
      "popup,width=560,height=760",
    );
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      void fetch("/api/auth/session", { cache: "no-store" }).then(async (response) => {
        const timedOut = Date.now() - startedAt > 120_000;
        if (!response.ok || timedOut) {
          if (!timedOut) return;
          window.clearInterval(timer);
          loginPoll.current = null;
          loginOperation.current = null;
          setShell((state) => transitionAppShell(state, {
            type: "oauth_cancelled",
            operationId,
          }).state);
          return;
        }
        const payload = await response.json() as SharedPayload;
        if (!payload.user?.openId) {
          if (Date.now() - startedAt <= 120_000) return;
          window.clearInterval(timer);
          loginPoll.current = null;
          loginOperation.current = null;
          setShell((state) => transitionAppShell(state, {
            type: "oauth_cancelled",
            operationId,
          }).state);
          return;
        }
        window.clearInterval(timer);
        loginPoll.current = null;
        loginOperation.current = null;
        setShell((state) => transitionAppShell(state, {
          type: "login_succeeded",
          operationId,
          principal: {
            openId: payload.user!.openId!,
            displayName:
              payload.user!.displayName ?? payload.user!.name ?? payload.user!.openId!,
          },
        }).state);
        setNotice("登录成功；当前本地会话权限与内容均未升级。");
      }).catch(() => {
        if (Date.now() - startedAt <= 120_000) return;
        window.clearInterval(timer);
        loginPoll.current = null;
        loginOperation.current = null;
        setShell((state) => transitionAppShell(state, {
          type: "oauth_cancelled",
          operationId,
        }).state);
      });
    }, 1_000);
    loginPoll.current = timer;
  };

  const openShared = async () => {
    const operationId = identities.allocate("operation");
    const workspaceId = "canonical-shared-workspace";
    const requested = transitionAppShell(shell, {
      type: "shared_open_requested",
      operationId,
      workspaceId,
    });
    if (!requested.accepted) {
      setNotice("需要先完成飞书登录，才能显式打开共享工作区。");
      return;
    }
    setShell(requested.state);
    setNotice("正在加载共享工作区；本地会话继续有效。");
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as SharedPayload;
      if (!response.ok || !payload.state || !Number.isSafeInteger(payload.revision)) {
        const kind = response.status === 401
          ? "unauthorized_401"
          : response.status === 403
            ? "forbidden_403"
            : response.status === 409
              ? "conflict_409"
              : "server_5xx";
        setShell((state) => transitionAppShell(state, {
          type: "shared_load_failed",
          operationId,
          kind,
        }).state);
        setNotice(`${payload.error ?? "共享工作区加载失败"}；有效本地会话已保留。`);
        return;
      }
      const resourceId = identities.allocate("resource");
      let handled = false;
      setShell((state) => {
        const transition = transitionAppShell(state, {
          type: "shared_load_succeeded",
          operationId,
          resource: {
            workspaceId,
            revision: payload.revision!,
            resourceId,
          },
        });
        if (!transition.accepted) return state;
        if (!handled) {
          handled = true;
          queueMicrotask(() => {
            // P2 effect order is activate-first, dispose-local-last.
            setSharedState(payload.state!);
            loader.clear();
            setLocal({ status: "empty" });
          });
        }
        return transition.state;
      });
    } catch {
      setShell((state) => transitionAppShell(state, {
        type: "shared_load_failed",
        operationId,
        kind: "server_5xx",
      }).state);
      setNotice("共享工作区网络加载失败；有效本地会话已保留。");
    }
  };

  const document = session?.document;
  const dirty = Boolean(session && session.history.current.sequence > 0);
  return (
    <main className="local-session-shell" id="main-content">
      <header className="local-session-header">
        <div>
          <span className="local-session-kicker">LOCAL SESSION · OPEN-009 v2</span>
          <h1>规则与模板临时工坊</h1>
          <p>只在当前标签页内编辑 canonical WQ8w 的白名单字段。</p>
        </div>
        <div className="local-session-header-actions">
          <span className="local-session-auth">{authName(shell)}</span>
          {shell.auth.status !== "authenticated" && (
            <button type="button" className="local-button" onClick={login}>
              飞书登录
            </button>
          )}
          <button
            type="button"
            className="local-button local-button-primary"
            onClick={() => void openShared()}
            disabled={shell.auth.status !== "authenticated"
              || shell.authority.status === "shared_loading"}
          >
            {shell.authority.status === "shared_loading" ? "加载共享中…" : "打开共享工作区"}
          </button>
        </div>
      </header>

      <section className="local-session-guard" aria-label="本地会话边界">
        <strong>内存临时态</strong>
        <span>无登录也可用</span>
        <span>不自动载入生产 seed</span>
        <span>不含 Series / SKU / Model</span>
        <span>无下载、导出或浏览器持久化</span>
      </section>

      <section className="local-session-source">
        <div>
          <h2>{session ? session.document.title || "未命名临时会话" : "开始一个本地会话"}</h2>
          <p aria-live="polite">{notice}</p>
        </div>
        <div className="local-session-source-actions">
          <input
            ref={fileInput}
            className="local-file-input"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => void openWorkbook(event)}
          />
          <button
            type="button"
            className="local-button"
            onClick={() => fileInput.current?.click()}
            disabled={shell.authority.status === "shared_loading"}
          >
            {session ? "替换 WQ8w 工作簿" : "打开 WQ8w 工作簿"}
          </button>
          <button type="button" className="local-button" onClick={activateBlank} disabled={shell.authority.status === "shared_loading"}>
            新建空白临时会话
          </button>
          <button
            type="button"
            className="local-button local-button-danger"
            disabled={!session}
            onClick={clear}
          >
            清除
          </button>
        </div>
      </section>

      {!document ? (
        <section className="local-session-empty">
          <div aria-hidden="true">TF</div>
          <h2>没有恢复点，也不会自动打开任何生产数据</h2>
          <p>请选择 canonical WQ8w 工作簿，或从完全空白的临时会话开始。</p>
        </section>
      ) : (
        <>
          <nav className="local-session-tabs" aria-label="本地编辑区域">
            {([
              ["parameters", `参数 ${document.parameters.length}`],
              ["templates", `模板 ${document.templates.length}`],
              ["rules", `规则 ${document.rules.length}`],
              ["trace", `派生与校验 ${issues.length}`],
            ] as const).map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={tab === value ? "active" : ""}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
            <span className={dirty ? "dirty" : ""}>{dirty ? "未保存的内存修改" : "源数据未修改"}</span>
            <button
              type="button"
              disabled={session.history.undo.length === 0}
              onClick={() => {
                identities.allocate("operation");
                setLocal((state) => reduceLocalSession(state, { type: "undo_local_edit" }));
              }}
            >
              撤销
            </button>
            <button
              type="button"
              disabled={session.history.redo.length === 0}
              onClick={() => {
                identities.allocate("operation");
                setLocal((state) => reduceLocalSession(state, { type: "redo_local_edit" }));
              }}
            >
              重做
            </button>
          </nav>

          <section className="local-session-editor">
            {tab === "parameters" && (
              <EditableParameters document={document} commit={commit} identities={identities} />
            )}
            {tab === "templates" && (
              <EditableTemplates document={document} commit={commit} identities={identities} />
            )}
            {tab === "rules" && (
              <EditableRules document={document} commit={commit} identities={identities} />
            )}
            {tab === "trace" && (
              <TracePanel
                document={document}
                selectedTemplateId={selectedTemplateId}
                setSelectedTemplateId={setSelectedTemplateId}
                derivation={derivation}
                issues={issues}
              />
            )}
          </section>
        </>
      )}
    </main>
  );
}

type EditorProps = {
  document: LocalSessionDocument;
  commit(document: LocalSessionDocument, label: string): void;
  identities: LocalSessionIdentityAllocator;
};

function EditableParameters({ document, commit, identities }: EditorProps) {
  return (
    <>
      <EditorHeading
        title="参数白名单"
        description="仅名称、键、部位、单位、精度与备注。"
        onAdd={() => commit({
          ...document,
          parameters: [...document.parameters, {
            id: identities.allocate("resource"),
            key: "",
            label: "新参数",
            itemPart: "rod",
            unit: "",
            precision: 3,
            notes: "",
          }],
        }, "新增参数")}
      />
      <div className="local-table-scroll">
        <table className="local-table">
          <thead><tr><th>显示名</th><th>参数键</th><th>部位</th><th>单位</th><th>精度</th><th>备注</th></tr></thead>
          <tbody>
            {document.parameters.map((parameter, index) => (
              <tr key={parameter.id}>
                <td><input aria-label={`参数 ${index + 1} 显示名`} value={parameter.label} onChange={(event) => commit({ ...document, parameters: document.parameters.map((entry, row) => row === index ? { ...entry, label: event.target.value } : entry) }, "编辑参数显示名")} /></td>
                <td><input aria-label={`参数 ${index + 1} 参数键`} value={parameter.key} onChange={(event) => commit({ ...document, parameters: document.parameters.map((entry, row) => row === index ? { ...entry, key: event.target.value } : entry) }, "编辑参数键")} /></td>
                <td><select aria-label={`参数 ${index + 1} 部位`} value={parameter.itemPart} onChange={(event) => commit({ ...document, parameters: document.parameters.map((entry, row) => row === index ? { ...entry, itemPart: event.target.value as "rod" | "reel" | "line" } : entry) }, "编辑参数部位")}><option value="rod">竿</option><option value="reel">轮</option><option value="line">线</option></select></td>
                <td><input aria-label={`参数 ${index + 1} 单位`} value={parameter.unit} onChange={(event) => commit({ ...document, parameters: document.parameters.map((entry, row) => row === index ? { ...entry, unit: event.target.value } : entry) }, "编辑参数单位")} /></td>
                <td><input aria-label={`参数 ${index + 1} 精度`} type="number" min="0" step="1" value={parameter.precision} onChange={(event) => commit({ ...document, parameters: document.parameters.map((entry, row) => row === index ? { ...entry, precision: Math.max(0, Math.trunc(numericInput(event.target.value))) } : entry) }, "编辑参数精度")} /></td>
                <td><input aria-label={`参数 ${index + 1} 备注`} value={parameter.notes} onChange={(event) => commit({ ...document, parameters: document.parameters.map((entry, row) => row === index ? { ...entry, notes: event.target.value } : entry) }, "编辑参数备注")} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function EditableTemplates({ document, commit, identities }: EditorProps) {
  return (
    <>
      <EditorHeading
        title="重量模板白名单"
        description="保留最近派生模板语义，不做连续插值。"
        onAdd={() => commit({
          ...document,
          templates: [...document.templates, {
            id: identities.allocate("resource"),
            name: "新重量模板",
            itemPart: "rod",
            targetPullMinKgf: 0,
            nominalTargetPullKgf: 0,
            targetPullMaxKgf: 0,
            values: {},
            notes: "",
          }],
        }, "新增重量模板")}
      />
      <div className="local-card-grid">
        {document.templates.map((template, index) => (
          <article className="local-template-card" key={template.id}>
            <label>名称<input value={template.name} onChange={(event) => commit({ ...document, templates: document.templates.map((entry, row) => row === index ? { ...entry, name: event.target.value } : entry) }, "编辑模板名称")} /></label>
            <label>部位<select value={template.itemPart} onChange={(event) => commit({ ...document, templates: document.templates.map((entry, row) => row === index ? { ...entry, itemPart: event.target.value as "rod" | "reel" | "line" } : entry) }, "编辑模板部位")}><option value="rod">竿</option><option value="reel">轮</option><option value="line">线</option></select></label>
            {(["targetPullMinKgf", "nominalTargetPullKgf", "targetPullMaxKgf"] as const).map((field) => <label key={field}>{field === "targetPullMinKgf" ? "最小拉力" : field === "nominalTargetPullKgf" ? "标称拉力" : "最大拉力"}<input type="number" value={template[field]} onChange={(event) => commit({ ...document, templates: document.templates.map((entry, row) => row === index ? { ...entry, [field]: numericInput(event.target.value) } : entry) }, "编辑模板拉力")} /></label>)}
            <TemplateValuesEditor
              key={template.id}
              errorId={`local-template-json-error-${index}`}
              values={template.values}
              onCommit={(values) => commit({
                ...document,
                templates: document.templates.map((entry, row) =>
                  row === index ? { ...entry, values } : entry),
              }, "编辑模板值")}
            />
          </article>
        ))}
      </div>
    </>
  );
}

function TemplateValuesEditor({
  errorId,
  values,
  onCommit,
}: {
  errorId: string;
  values: Record<string, number | string>;
  onCommit(values: Record<string, number | string>): void;
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(values, null, 2));
  const [error, setError] = useState("");
  const lastCommitted = useRef(JSON.stringify(values));
  useEffect(() => {
    const external = JSON.stringify(values);
    if (external === lastCommitted.current) return;
    lastCommitted.current = external;
    setDraft(JSON.stringify(values, null, 2));
    setError("");
  }, [values]);
  return (
    <label className="span-two">
      模板值（JSON 对象）
      <textarea
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        value={draft}
        onChange={(event) => {
          const nextDraft = event.target.value;
          setDraft(nextDraft);
          try {
            const nextValues = parseLocalTemplateValuesJson(nextDraft);
            lastCommitted.current = JSON.stringify(nextValues);
            setError("");
            onCommit(nextValues);
          } catch (nextError) {
            setError(
              nextError instanceof SyntaxError
                ? "JSON 尚未完整；会保留上一次有效模板值。"
                : nextError instanceof Error
                  ? nextError.message
                  : "模板值格式无效。",
            );
          }
        }}
      />
      {error && (
        <span id={errorId} className="local-field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

function EditableRules({ document, commit, identities }: EditorProps) {
  return (
    <>
      <EditorHeading
        title="规则白名单"
        description="技术仍是词条组合包；本地只编辑调整规则，不创建正式对象。"
        onAdd={() => commit({
          ...document,
          rules: [...document.rules, {
            id: identities.allocate("resource"),
            sourceKind: "layer",
            sourceId: "local",
            sourceName: "本地规则",
            sequence: document.rules.reduce((max, entry) => Math.max(max, entry.sequence), -1) + 1,
            parameterKey: document.parameters[0]?.key ?? "",
            operation: "add",
            value: 0,
            condition: "",
            notes: "",
            enabled: true,
          }],
        }, "新增规则")}
      />
      <div className="local-table-scroll">
        <table className="local-table local-rule-table">
          <thead><tr><th>启用</th><th>来源</th><th>参数</th><th>操作</th><th>值 / 公式</th><th>条件（只展示）</th><th>序号</th></tr></thead>
          <tbody>
            {document.rules.map((rule, index) => (
              <tr key={rule.id}>
                <td><input aria-label={`规则 ${index + 1} 启用`} type="checkbox" checked={rule.enabled} onChange={(event) => commit({ ...document, rules: document.rules.map((entry, row) => row === index ? { ...entry, enabled: event.target.checked } : entry) }, "切换规则")} /></td>
                <td><strong>{rule.sourceName}</strong><small>{rule.sourceKind}</small></td>
                <td><select aria-label={`规则 ${index + 1} 参数`} value={rule.parameterKey} onChange={(event) => commit({ ...document, rules: document.rules.map((entry, row) => row === index ? { ...entry, parameterKey: event.target.value } : entry) }, "编辑规则参数")}>{document.parameters.map((parameter) => <option key={parameter.id} value={parameter.key}>{parameter.label || parameter.key}</option>)}</select></td>
                <td><select aria-label={`规则 ${index + 1} 操作`} value={rule.operation} onChange={(event) => {
                  const operation = event.target.value as LocalEditableRuleOperation;
                  commit({
                    ...document,
                    rules: document.rules.map((entry, row) => row === index
                      ? {
                          ...entry,
                          operation,
                          value: operation === "formula"
                            ? String(entry.value)
                            : operation === "set" || typeof entry.value === "number"
                              ? entry.value
                              : numericInput(String(entry.value)),
                        }
                      : entry),
                  }, "编辑规则操作");
                }}>{Object.entries(OPERATION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
                <td>
                  <RuleValueEditor
                    key={rule.id}
                    errorId={`local-rule-value-error-${rule.id}`}
                    index={index}
                    operation={rule.operation}
                    value={rule.value}
                    onCommit={(value) => commit({
                      ...document,
                      rules: document.rules.map((entry, row) =>
                        row === index ? { ...entry, value } : entry),
                    }, "编辑规则值")}
                  />
                </td>
                <td><input aria-label={`规则 ${index + 1} 条件`} value={rule.condition} onChange={(event) => commit({ ...document, rules: document.rules.map((entry, row) => row === index ? { ...entry, condition: event.target.value } : entry) }, "编辑规则条件")} /></td>
                <td><input aria-label={`规则 ${index + 1} 序号`} type="number" min="0" step="1" value={rule.sequence} onChange={(event) => commit({ ...document, rules: document.rules.map((entry, row) => row === index ? { ...entry, sequence: Math.max(0, Math.trunc(numericInput(event.target.value))) } : entry) }, "编辑规则顺序")} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RuleValueEditor({
  errorId,
  index,
  operation,
  value,
  onCommit,
}: {
  errorId: string;
  index: number;
  operation: LocalEditableRuleOperation;
  value: number | string;
  onCommit(value: number | string): void;
}) {
  const numeric = operation !== "formula"
    && !(operation === "set" && typeof value === "string");
  const [draft, setDraft] = useState(() => String(value));
  const [error, setError] = useState("");
  const lastCommitted = useRef({ operation, value });
  useEffect(() => {
    const previous = lastCommitted.current;
    if (previous.operation === operation && Object.is(previous.value, value)) return;
    lastCommitted.current = { operation, value };
    setDraft(String(value));
    setError("");
  }, [operation, value]);
  return (
    <span className="local-inline-editor">
      <input
        aria-label={`规则 ${index + 1} 值或公式（${numeric ? "数值" : "文本"}）`}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        inputMode={numeric ? "decimal" : undefined}
        value={draft}
        onChange={(event) => {
          const nextDraft = event.target.value;
          setDraft(nextDraft);
          if (!numeric) {
            lastCommitted.current = { operation, value: nextDraft };
            setError("");
            onCommit(nextDraft);
            return;
          }
          const nextValue = Number(nextDraft);
          if (!nextDraft.trim() || !Number.isFinite(nextValue)) {
            setError("请输入有限数值；会保留上一次有效规则值。");
            return;
          }
          lastCommitted.current = { operation, value: nextValue };
          setError("");
          onCommit(nextValue);
        }}
      />
      {error && (
        <span id={errorId} className="local-field-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

function EditorHeading({
  title,
  description,
  onAdd,
}: {
  title: string;
  description: string;
  onAdd(): void;
}) {
  return (
    <header className="local-editor-heading">
      <div><h2>{title}</h2><p>{description}</p></div>
      <button type="button" className="local-button local-button-primary" onClick={onAdd}>
        新增
      </button>
    </header>
  );
}

function TracePanel({
  document,
  selectedTemplateId,
  setSelectedTemplateId,
  derivation,
  issues,
}: {
  document: LocalSessionDocument;
  selectedTemplateId: string;
  setSelectedTemplateId(value: string): void;
  derivation: ReturnType<typeof deriveLocalSessionTemplate> | null;
  issues: ReturnType<typeof validateLocalSessionDocument>;
}) {
  return (
    <>
      <div className="local-trace-toolbar">
        <label>派生模板<select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}><option value="">请选择</option>{document.templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
        <span>按 sequence 与规则 ID 稳定排序；有条件规则不猜测执行。</span>
      </div>
      <div className="local-trace-layout">
        <section>
          <h3>校验问题</h3>
          {issues.length === 0 ? <p className="local-clean">当前白名单数据通过校验。</p> : issues.map((issue) => <article className={`local-issue ${issue.severity}`} key={`${issue.code}:${issue.path}`}><strong>{issue.code}</strong><span>{issue.message}</span><code>{issue.path}</code></article>)}
        </section>
        <section>
          <h3>确定性 Trace</h3>
          {!derivation ? <p className="local-muted">选择模板后生成预览；结果不保存。</p> : derivation.trace.map((entry) => <article className={`local-trace ${entry.status}`} key={entry.traceId}><span>#{entry.sequence} · {entry.sourceKind}</span><strong>{entry.parameterKey}: {String(entry.before)} → {String(entry.after)}</strong><small>{OPERATION_LABELS[entry.operation]} {String(entry.operand)} · {entry.message}</small></article>)}
        </section>
      </div>
    </>
  );
}
