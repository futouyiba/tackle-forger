# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read before changing code

Before implementation, refactoring, review, or test work, read these files completely:

- `AGENTS.md`
- `docs/README.md`
- `docs/tackle-forger-development-spec-v3.md`

The v3 specification is the sole authoritative product/domain specification. Files under `docs/2026-*` and `crystal/` are historical. If sources conflict, follow the user's latest explicit decision, update the canonical specification, and then make the implementation match it. Do not resolve open decisions by hard-coding an assumption.

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

- Next.js 16 App Router and React 19 are built through Vinext/Vite, not the standard Next CLI used by `vercel.json`.
- `app/page.tsx` seeds the client workbench; `app/Workbench.tsx` is the main navigation/state shell and composes focused workbenches for the v3 flow, rule workbook, series Gantt, candidate generation, and browser config export.
- Most product logic belongs in `lib/`, not React components. Components should consume deterministic domain results and API contracts rather than reimplement calculations.
- `worker/index.ts` is the Cloudflare Worker entry. `vite.config.ts` wires Vinext, the build plugin, and local D1/R2 bindings from `.openai/hosting.json` (`DB` and `FILES`). Wrangler/Miniflare state is intentionally kept under `.wrangler/`.

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

The whole canonical Feishu workbook is the sole general rule source; a URL `sheet` parameter only selects the initially visible sheet. Synchronization identifies sheets and entities by stable IDs, not names or row positions.

- `lib/feishu-workbook.ts`, `lib/feishu-sheets.ts`, and `lib/rule-workbook-inspection.ts` read and validate workbook revisions.
- `lib/workbook-governance.ts`, `lib/source-id-migration.ts`, and `app/api/feishu-workbook/route.ts` enforce separate actions for inspection, explicit pull, draft creation, stable-ID writeback, readback verification, and publication.
- Writeback is not pull, and pull is not publication. Never combine these transitions or hard-code an observed workbook revision as the latest revision.

### Persistence, concurrency, and API boundaries

`lib/storage.ts` selects storage at runtime:

1. Vercel Blob when `BLOB_READ_WRITE_TOKEN` is present;
2. Cloudflare D1 for workspace/revisions plus R2 for imported files when bindings are available;
3. an in-process seeded document for local fallback.

Workspace saves use optimistic concurrency: Blob ETags or D1 revision-checked updates. Preserve `baseRevision`/409 conflict behavior in API and UI changes.

Key route families under `app/api/` include:

- `state` and `revisions`: shared workspace state, saves, and history;
- `auth/*`: Feishu OAuth session lifecycle;
- `feishu-workbook` and `data-sources`: canonical source inspection/governance;
- `series-gantt`: server-side series/SKU/Model query projection;
- `import-file`: source file storage.

### Authentication and authorization

Authentication is company Feishu OAuth, implemented by `lib/auth-config.ts`, `lib/auth-store.ts`, `lib/feishu-oauth.ts`, and `lib/auth.ts`. The opaque `tf_session` cookie resolves to server-side session data. Production requires the variables documented in `.env.example`, especially a persistent, backed-up `FEISHU_SESSION_DATA_DIR`; a Vercel temporary filesystem is not suitable for production sessions.

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

`npm run build` uses `vinext build`. `vercel.json` currently invokes `next build` after removing `package.json`'s ESM type and exists as a review deployment path; do not assume it represents the canonical production build. The formal target is the company intranet Dell R730 with persistent storage, company Feishu credentials, and real configuration repositories. Cloudflare/OpenAI Sites bindings and Vercel Blob remain supported runtime paths in the current code, but deployment decisions must preserve the v3 persistence and identity requirements.
