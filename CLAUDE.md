# CLAUDE.md

<!-- workflow-contract-policy-ref/v2: .codex/skills/tackle-agent-workflow/references/workflow-contract-policy.v2.json -->

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read before changing code

Before implementation, refactoring, review, or test work, follow the generated read plan:

- `AGENTS.md`
- `docs/README.md`
- `docs/spec-v3/README.md`
- `docs/spec-v3/00-authority.md`
- section 19 of `docs/spec-v3/05-open-decisions.md`
- `.codex/skills/tackle-agent-workflow/references/v3-open-registry.json`
- routed sections plus the canonical OPEN subsections and dependencies selected mechanically from TaskBrief `applicableIds`

Read the full modular v3 specification for strict/high-risk work, unknown or broad scope, canonical structure changes, or when OPEN applicability cannot be determined reliably. The generated OPEN registry is navigation evidence, not product authority. The v3 specification is the sole authoritative product/domain specification. Files under `docs/2026-*` and `crystal/` are historical. If sources conflict, follow the user's latest explicit decision, update the canonical specification, and then make the implementation match it. Do not resolve open decisions by hard-coding an assumption.

项目尚未正式交付，无生产环境历史 workspace state 需迁就。PR2b 切流后生产读取链默认走 WQ8w（`CANONICAL_FEISHU_WORKBOOK`）。旧表 YsEKw 的运行时兼容代码与 `LEGACY_YS_EKW_*` 常量已移除（历史拓扑仅 spec §14 审计文档保留）；`/wiki/` 通用解析能力保留。`lib/migrations.ts` 的 schema 迁移链仍需维护与测试覆盖。

The UI and domain vocabulary are primarily Chinese. Preserve established terminology in user-facing text and tests.

## Commands

Node.js 22.16 or newer is required. The project is ESM; this lower bound is required by the workspace backup command's `node:sqlite` `backup()` API.

```powershell
npm install
npm run dev
npm run build
npm run start
npm run typecheck
npm run lint
npm test
npm run db:generate
```

The historical pnpm workspace has been removed from the main tree and is retained only through Git history and the annotated tag `legacy-workspace-last-green-2026-07-26` (commit `702938b36bed0c2ea5489238318778a18d53059f`, Node 22.16.0 / pnpm 10.33.2). The authoritative root v3 application uses npm. Any restoration must start on an isolated branch and pass a dedicated governance review; never reconnect the archived app, PostgreSQL schema, or browser-local state directly to the current runtime.

On Windows, the recommended local launcher is:

```powershell
.\scripts\start-dev.ps1 -Port 3000
.\scripts\start-dev.ps1 -Port 3000 -Foreground
```

The background form writes logs to `.run/dev-<port>.stdout.log` and `.run/dev-<port>.stderr.log`.

Tests use `node:test`; TypeScript tests run through `tsx`. Run one test file or one named test with:

```powershell
npx tsx --test tests/v3-rule-kernel.test.ts
npx tsx --test --test-name-pattern="<name or regex>" tests/v3-rule-kernel.test.ts
node --test --test-name-pattern="<name or regex>" tests/rendered-html.test.mjs
```

Many test names are Chinese. `tests/rendered-html.test.mjs` inspects `dist/`, so run `npm run build` first. The full `npm test` command builds before running all domain and rendered-output tests.

## Architecture

### Runtime and application shell

- Next.js 16 App Router and React 19 are built through Vinext/Vite. Vinext is the build adapter, not a second product application; the only supported deployment build is `npm run build`, never `next build`.
- `app/page.tsx` seeds the client workbench; `app/Workbench.tsx` is the main navigation/state shell and composes focused workbenches for the v3 flow, rule workbook, series Gantt, candidate generation, and browser config export.
- Most product logic belongs in `lib/`, not React components. Components should consume deterministic domain results and API contracts rather than reimplement calculations.
- `vite.config.ts` wires the Node/Vinext build only. Cloudflare Worker, D1/R2, Vercel and OpenAI Sites deployment adapters are retired.

### Central data model and migration

- `lib/types.ts` contains the shared domain and API contracts. `WorkspaceState` is the central persisted workspace document.
- `lib/migrations.ts` owns schema evolution (`CURRENT_WORKSPACE_SCHEMA_VERSION`). Preserve old fields and migrate data; do not delete history to simplify a change.
- `lib/seed.ts` and `lib/v3-seed.ts` construct initial/compatibility state from imported workbook data.
- API state writes accept existing supported schema versions and pass loaded state through migration/normalization helpers. Update migration tests whenever persisted shapes change.

### Deterministic domain pipeline

The canonical flow is:

```text
Feishu source revision
→ published RuleSetVersion
→ WeightTemplate + Method + Type + Function structural projection
→ nearest structural match for an exact SKU targetPullKg
→ intensity/performance/material + layered Series/SKU/Model patches
→ Affix/Technology settlement and validation
→ purchasable Model
→ immutable ConfigurationSnapshot
→ SnapshotBatch/config export
```

Important modules:

- `lib/rule-kernel.ts`: deterministic projection, stable serialization/hash, ordered calculation trace, and reduction modes.
- `lib/projection-matcher.ts`: nearest structural projection selection; selection uses pull-ratio distance and never continuous interpolation.
- `lib/compatibility.ts`: hard allow/deny/require rules and separate soft Affinity scoring.
- `lib/patch-engine.ts`: layered, replayable patches and rebase behavior.
- `lib/affix-engine.ts` and `lib/quality-value-policy.ts`: attribute/passive affixes, Technology expansion, combination scores, and selected-Quality validation.
- `lib/pricing-policy.ts`: versioned pricing drafts/trials and formal-policy gates.
- `lib/product-model.ts`, `lib/model-candidate-generation.ts`, and `lib/publishing.ts`: Series/SKU/Model identity, deterministic candidates, snapshot publication, integrity hashes, and upgrade candidates.
- `lib/five-axis.ts`: versioned five-axis previews/comparisons derived from final Model values.
- `lib/snapshot-batch.ts`: explicit batch planning that reuses unchanged snapshots, creates eligible snapshots, and skips blocked Models.
- `lib/workflow.ts`: legacy/general rule-DAG execution and normalization still used by the workbench.

Published snapshots are immutable. Upstream changes create new revisions or `UpgradeCandidate`s; they never silently rewrite an existing snapshot or its hash.

### Feishu rule-source governance

The whole canonical Feishu workbook is the sole general rule source; a URL `sheet` parameter only selects the initially visible sheet. Synchronization identifies sheets and entities by stable IDs, not names or row positions. The concept ↔ sheet ↔ code-position mapping is documented in `docs/audits/feishu-source-to-v3-mapping.md` (mapped by concept, not by sheet_id; the domain spec does not hardcode concrete table IDs — concrete IDs are registered centrally in `CANONICAL_FEISHU_SHEET_REGISTRY` and consumed by code via the registry).

- `lib/feishu-workbook.ts`, `lib/feishu-sheets.ts`, and `lib/rule-workbook-inspection.ts` read and validate workbook revisions.
- `lib/workbook-governance.ts`, `lib/source-id-migration.ts`, and `app/api/feishu-workbook/route.ts` enforce separate actions for inspection, explicit pull, draft creation, stable-ID writeback, readback verification, and publication.
- Writeback is not pull, and pull is not publication. Never combine these transitions or hard-code an observed workbook revision as the latest revision.

### Persistence, concurrency, and API boundaries

`lib/storage.ts` selects storage through the explicit `WORKSPACE_STORAGE_BACKEND` deployment contract. `sqlite` is the only R730 production backend and `ephemeral` is development/test only. Production must fail closed on a missing, invalid, or deployment-mismatched backend. `@vercel/blob` remains isolated to the one-time Blob→SQLite migration tool.

Workspace saves use SQLite revision-checked updates. Preserve `baseRevision`/409 conflict behavior in API and UI changes.

Key route families under `app/api/` include:

- `state` and `revisions`: shared workspace state, saves, and history;
- `auth/*`: Feishu OAuth session lifecycle;
- `feishu-workbook` and `data-sources`: canonical source inspection/governance;
- `series-gantt`: server-side series/SKU/Model query projection;
- `import-file`: source file storage.

### Authentication and authorization

Authentication is company Feishu OAuth, implemented by `lib/auth-config.ts`, `lib/auth-store.ts`, `lib/feishu-oauth.ts`, and `lib/auth.ts`. The opaque `tf_session` cookie resolves to server-side session data. Production requires the variables documented in `.env.example`, especially a persistent, backed-up R730 `FEISHU_SESSION_DATA_DIR`.

Authorization is capability/action based. Read contracts expose server-derived `ActionAvailability`, and write routes recheck capabilities. Do not infer permissions from role labels, UI state, or whether a user object exists. Trusted proxy headers are disabled unless explicitly enabled and authenticated with `FEISHU_PROXY_SHARED_SECRET`.

### Browser config export

The v3 delivery path uses the Chromium File System Access API:

- directory handles remain in browser/origin/user IndexedDB;
- `lib/browser-config-export.ts` handles browser-side access and recoverable writes;
- `lib/config-export*.ts` modules build mappings, workbook changes, validation, manifests, backups, and recovery behavior;
- formal export reads frozen snapshots and resolves logical tables from each environment root's `config.toml`.

The service must not claim a download fallback wrote to a local Git workspace. Export modifies configuration files only; it does not run Git commands. The companion service is retained for compatibility/testing, not as the v3 primary delivery path.

## Domain invariants that must remain visible in implementation

- Target pull/weight matching selects the nearest derived structural template; it never interpolates continuously.
- Method and Type are separate rule/trace layers even when combined in one UI step.
- Quality is fixed as C/green, B/blue, A/purple, S/orange and is independent of `functionIntensity`.
- SKU is a discrete target-pull drawer; Model is the selectable/purchasable object.
- Hard compatibility cannot be overridden by Affinity Score.
- Manual changes are layered, traceable patches; never edit cached `DerivedProjection` data as source truth.
- Technology is a package of Affixes and must not duplicate its members' attribute or value contributions.
- Passive skills are stored, scored, displayed, and exported, but are not executed or simulator-validated here.
- Domain math must be deterministic, traceable, and replayable. Preserve stable ordering, input hashes, source versions, and before/operation/operand/after traces.
- AI evaluation is advisory only: it cannot arbitrate rules, downgrade blocking validation, approve changes, write Feishu directly, or modify published snapshots.
- The series Gantt is a query/navigation projection over Series, discrete SKU nodes, and Models; it is not a domain entity and its spans do not imply interpolation.

## Testing expectations from the canonical specification

New domain behavior must cover normal, boundary, conflict, recovery/version-freeze, and permission behavior as applicable. In particular, retain regression coverage for nearest matching, hard-vs-soft compatibility, patch replay/rebase, both reduction modes, Technology de-duplication, passive non-execution, deterministic candidate ordering, snapshot immutability/hash integrity, Feishu revision conflicts, and recoverable config export.

## Deployment notes

`npm run build` uses `vinext build`. The formal target is the company intranet Dell R730 with persistent SQLite storage, company Feishu credentials, and real configuration repositories. Cloudflare, Vercel and OpenAI Sites deployment paths are retired; Vercel Blob is retained only for an explicit one-time import into SQLite. See `docs/architecture/current-runtime-authority.md` for the current runtime authority table.

## Agent 工作模式

Task Card、TaskBrief、receipt、reviewTier、风险下限、验证矩阵和审核边界统一遵循
`.codex/skills/tackle-agent-workflow/references/workflow-contract-policy.v2.json`；本文件不维护平行规则。Claude 的PR协调、审核与修复步骤见`.claude/skills/agent-pr-loop/SKILL.md`。

本仓库managed mode为`autonomous`，作用域为当前仓库和当前明确目标，merge policy为`qualified_auto_merge`，重试上限为3；活跃任务轮次或已配置唤醒作为heartbeat，当前不声称存在额外后台Automation。独立review按reviewTier执行；合并资格、授权及暂停条件只由`.github/merge-gates.md`定义；部署/发布策略为`never`。

Pull Request合并资格、CI provenance、review signal、授权、暂停、workflow治理例外和合并回读统一遵循`.github/merge-gates.md`，本文件不维护第二份规则。合并不扩张为部署、发布、删除、范围扩张或其他外部副作用。
