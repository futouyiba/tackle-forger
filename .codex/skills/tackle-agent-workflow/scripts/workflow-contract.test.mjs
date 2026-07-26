import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildNavigationIndex, buildOwnedBaselineManifest, buildPatchManifest, checkFullReadSession, checkNavigationIndex, checkPolicy, checkReadReceipt, checkTaskBrief, checkVerdict, fullReadSessionHash, openRegistryHash, ownedBaselineHash, patchHash, prepareTaskBrief, receiptHash, runCli, runValidation, specReadPlan, taskBriefHash, validationExecutionPlan, writeNavigationIndex } from './workflow-contract.mjs';

function command(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function write(root, relative, content) { const target = path.join(root, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content); }
function temporaryRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workflow-contract-'));
  command(root, ['init', '-q']);
  command(root, ['config', 'user.email', 'test@example.com']);
  command(root, ['config', 'user.name', 'Workflow Test']);
  return root;
}
function commitBase(root) {
  command(root, ['add', '.']);
  command(root, ['commit', '-qm', 'base']);
  return command(root, ['rev-parse', 'HEAD']);
}
function cleanup(root) { rmSync(root, { recursive: true, force: true }); }
function specHash(root) { return buildNavigationIndex(root).source.sha256; }
function receipt(root, overrides = {}) {
  const specSha256 = specHash(root);
  return {
    schema: 'tackle-spec-read/v1', taskId: 'task-1', role: 'coordinator', specSha256,
    profile: 'FULL', riskProfile: 'workflow_docs_metadata', relevantSections: ['1', '20'],
    requiredSections: ['README', 'FULL_V3'], readSections: ['README', 'FULL_V3'], reason: 'coordination', ...overrides,
  };
}
function fullReadSession(root, overrides = {}) {
  const fullReadReceipt = receipt(root);
  return {
    schema: 'tackle-spec-full-read-session/v1', agentIdentity: 'agent:codex-test', contextSessionId: 'context:test-1', contextState: 'continuous',
    specSha256: specHash(root), readmeSha256: createHash('sha256').update(readFileSync(path.join(root, 'docs/README.md'))).digest('hex'),
    openRegistrySha256: openRegistryHash(root), fullReadReceipt, createdAt: '2026-07-26T00:00:00Z', ...overrides,
  };
}
function reusedReceipt(root, overrides = {}) {
  const session = fullReadSession(root);
  return {
    schema: 'tackle-spec-read/v2', taskId: 'task-2', role: 'coordinator', specSha256: specHash(root), profile: 'REUSE_FULL', riskProfile: 'workflow_docs_metadata', relevantSections: ['1', '20'],
    requiredSections: ['README', '0', '19', '20', '1'], readSections: ['README', '0', '19', '20', '1'], reason: 'same agent, explicit continuous context',
    reuseEvidence: { session, sessionSha256: fullReadSessionHash(session), agentIdentity: session.agentIdentity, contextSessionId: session.contextSessionId }, ...overrides,
  };
}
function currentReuseContext(session) {
  return { currentAgentIdentity: session.agentIdentity, currentContextSessionId: session.contextSessionId, currentContextState: 'continuous' };
}
function brief(root, overrides = {}) {
  const coordinatorReceipt = receipt(root);
  const baseSha = command(root, ['rev-parse', 'HEAD']);
  const openIds = buildNavigationIndex(root).openRegistry.map((entry) => entry.id);
  return {
    schema: 'tackle-task-brief/v1', taskId: 'task-1', workflowMode: 'local', phase: 'pre_dispatch', specSha256: coordinatorReceipt.specSha256,
    baseSha, reviewedHead: 'WORKTREE', scope: 'workflow hardening', relevantSections: ['1', '20'], openDecisionCheck: { registrySha256: openRegistryHash(root), checkedIds: openIds, applicableIds: openIds, noApplicableReason: null }, riskProfile: 'workflow_docs_metadata', scopeHasRuntimeSemantics: false, changeClass: 'workflow_metadata', allowedChanges: ['AGENTS.md'], acceptanceCriteria: ['contract validates'], exclusions: ['product runtime'], riskDimensions: { persistedData: false, historicalSnapshots: false, concurrency: false, authorization: false, externalSideEffects: false, userVisible: false }, validationPlan: { requiredCommands: ['node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-policy', 'node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-index', 'node --test .codex/skills/tackle-agent-workflow/scripts/workflow-contract.test.mjs', `git diff --check ${baseSha} -- AGENTS.md`], requiredScenarios: ['authority_and_scoped_diff'], intentionallyNotApplicable: { product_runtime_tests: 'No product code changes.', legacy_workspace_ci: 'No legacy-workspace path is owned.' } },
    specReadReceipts: [coordinatorReceipt], ownedPaths: ['AGENTS.md'], preexistingOwnedPaths: [],
    preexistingUnownedChanges: [], dirtyWorktreeDisposition: 'clean', ...overrides,
  };
}
function nonLegacyNa() { return { legacy_workspace_ci: 'No legacy-workspace path is owned.' }; }
function taskBase(root) {
  write(root, 'docs/tackle-forger-development-spec-v3.md', '# V3\n\n## 0. Authority\n\n### 0.1 Immutable\n\n## 1. Scope\n\n### 3.1 Method and type\n\n### 5.2 Derived template\n\n## 8. Patch\n\n## 13. Snapshot\n\n## 14. Version\n\n### 18.2 Snapshot\n\n### 18.3 Patch\n\n## 19. Delivery\n\n## 20. Open\n\n### 24.11 Snapshot\n\n## 25. Export\n\n| ID | Type | Status |\n| --- | --- | --- |\n| OPEN-001 Test | x | `OPEN` |\n');
  write(root, 'docs/README.md', '# Documentation\n');
  write(root, 'AGENTS.md', 'base\n');
  commitBase(root);
}

function prepareInput(root, overrides = {}) {
  return {
    schema: 'tackle-task-prepare-input/v1', taskId: 'prepared-task', workflowMode: 'local', baseSha: command(root, ['rev-parse', 'HEAD']),
    scope: 'explicit workflow preparation scope', relevantSections: ['0', '19', '20'],
    openDecisionApplicability: { applicableIds: [], noApplicableReason: 'No product OPEN decision is implemented.' },
    riskProfile: 'workflow_docs_metadata', scopeHasRuntimeSemantics: false, changeClass: 'workflow_metadata', ownedPaths: ['AGENTS.md'],
    acceptanceCriteria: ['The generated TaskBrief validates.'], exclusions: ['No product runtime behavior changes.'],
    riskDimensions: { persistedData: false, historicalSnapshots: false, concurrency: false, authorization: false, externalSideEffects: false, userVisible: false },
    coordinatorSpecReadReceipt: receipt(root, { taskId: 'prepared-task', relevantSections: ['0', '19', '20'], reason: 'Coordinator completed the required canonical reading before preparation.' }), ...overrides,
  };
}

test('TaskBrief preparation derives only mechanical fields and immediately validates', () => {
  const root = temporaryRepo();
  const handoff = mkdtempSync(path.join(os.tmpdir(), 'workflow-prepare-input-'));
  try {
    taskBase(root);
    const input = prepareInput(root);
    const prepared = prepareTaskBrief({ root, input });
    assert.equal(checkTaskBrief({ root, brief: prepared }).phase, 'pre_dispatch');
    assert.equal(prepared.reviewedHead, 'WORKTREE');
    assert.deepEqual(prepared.allowedChanges, input.ownedPaths);
    assert.deepEqual(prepared.openDecisionCheck.checkedIds, ['OPEN-001']);
    assert.equal(prepared.validationPlan.requiredCommands.includes(`git diff --check ${input.baseSha} -- AGENTS.md`), true);
    assert.equal(prepared.validationPlan.intentionallyNotApplicable.product_runtime_tests.length > 0, true);
    assert.equal(prepared.specReadReceipts[0].profile, 'FULL');
    const inputPath = path.join(handoff, 'prepare-input.json');
    writeFileSync(inputPath, `${JSON.stringify(input)}\n`);
    assert.equal(JSON.parse(runCli(['--prepare-task-brief', '--input', inputPath], root)).taskId, input.taskId);
  } finally { cleanup(root); cleanup(handoff); }
});

test('TaskBrief preparation accepts v2 reuse receipts only with trusted continuous context', () => {
  const root = temporaryRepo();
  const handoff = mkdtempSync(path.join(os.tmpdir(), 'workflow-prepare-reuse-'));
  try {
    taskBase(root);
    const v2 = reusedReceipt(root, {
      taskId: 'prepared-task', relevantSections: ['0', '19', '20'],
      requiredSections: ['README', '0', '19', '20'], readSections: ['README', '0', '19', '20'],
    });
    const input = prepareInput(root, { coordinatorSpecReadReceipt: v2 });
    const current = currentReuseContext(v2.reuseEvidence.session);
    assert.equal(prepareTaskBrief({ root, input, currentReuseContext: current }).specReadReceipts[0].schema, 'tackle-spec-read/v2');
    assert.throws(() => prepareTaskBrief({ root, input }), /currentReuseContext/);
    assert.throws(() => prepareTaskBrief({ root, input, currentReuseContext: { ...current, currentAgentIdentity: 'agent:other' } }), /caller-provided/);
    assert.throws(() => prepareTaskBrief({ root, input, currentReuseContext: { ...current, currentContextSessionId: 'context:other' } }), /caller-provided/);
    assert.throws(() => prepareTaskBrief({ root, input, currentReuseContext: { ...current, currentContextState: 'compacted' } }), /currentContextState/);
    const inputPath = path.join(handoff, 'reuse-input.json');
    writeFileSync(inputPath, `${JSON.stringify(input)}\n`);
    assert.throws(() => runCli(['--prepare-task-brief', '--input', inputPath], root), /currentReuseContext/);
    assert.equal(JSON.parse(runCli(['--prepare-task-brief', '--input', inputPath, '--current-agent-identity', current.currentAgentIdentity, '--current-context-session-id', current.currentContextSessionId, '--current-context-state', 'continuous'], root)).taskId, input.taskId);
  } finally { cleanup(root); cleanup(handoff); }
});

test('TaskBrief preparation preserves every declared risk dimension and its scenarios', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const dimensions = { persistedData: true, historicalSnapshots: false, concurrency: true, authorization: false, externalSideEffects: false, userVisible: true };
    const input = prepareInput(root, {
      riskProfile: 'durable_migration', changeClass: 'persistence_migration', scopeHasRuntimeSemantics: true, riskDimensions: dimensions,
      coordinatorSpecReadReceipt: receipt(root, { taskId: 'prepared-task', riskProfile: 'durable_migration', relevantSections: ['0', '19', '20'] }),
    });
    const prepared = prepareTaskBrief({ root, input });
    assert.deepEqual(prepared.riskDimensions, dimensions);
    for (const scenario of ['normal_path', 'boundary', 'conflict', 'version_freeze', 'production_shape_fixture', 'unknown_field_preservation', 'second_run_noop', 'authorization_denied', 'reauthorize_at_commit', 'concurrency_conflict', 'unified_visual_review_pending_or_completed']) assert.equal(prepared.validationPlan.requiredScenarios.includes(scenario), true);
    assert.equal(new Set(prepared.validationPlan.requiredScenarios).size, prepared.validationPlan.requiredScenarios.length);
  } finally { cleanup(root); }
});

test('TaskBrief preparation fails closed for dirty, ambiguous, and unsupported inputs', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const input = prepareInput(root);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, ownedPaths: ['../AGENTS.md'] } }), /Invalid owned path/);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, relevantSections: ['0', '20', '999'] } }), /current v3 sections/);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, changeClass: 'not_a_class' } }), /unsupported/);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, baseSha: '0'.repeat(40) } }), /resolve|baseSha/);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, coordinatorSpecReadReceipt: { ...input.coordinatorSpecReadReceipt, taskId: 'other-task' } } }), /coordinatorSpecReadReceipt/);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, riskProfile: 'durable_migration', changeClass: 'persistence_migration', scopeHasRuntimeSemantics: true, coordinatorSpecReadReceipt: receipt(root, { taskId: 'prepared-task', riskProfile: 'durable_migration', relevantSections: ['0', '19', '20'] }) } }), /risk dimension/);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, riskProfile: 'unknown_high_risk', changeClass: 'domain_behavior', scopeHasRuntimeSemantics: true, coordinatorSpecReadReceipt: receipt(root, { taskId: 'prepared-task', riskProfile: 'unknown_high_risk', relevantSections: ['0', '19', '20'] }) } }), /refuses unknown_high_risk/);
    mkdirSync(path.join(root, 'directory-path'));
    write(root, 'directory-path/child.txt', 'tracked\n');
    command(root, ['add', 'directory-path']); command(root, ['commit', '-qm', 'track directory fixture']);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, ownedPaths: ['directory-path'] } }), /Unsupported current entry/);
    try {
      symlinkSync('AGENTS.md', path.join(root, 'linked-path'));
      command(root, ['add', 'linked-path']); command(root, ['commit', '-qm', 'track symlink fixture']);
      assert.throws(() => prepareTaskBrief({ root, input: { ...input, ownedPaths: ['linked-path'] } }), /Symlink/);
    } catch (error) { if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error; }
    write(root, 'dirty.txt', 'dirty\n');
    assert.throws(() => prepareTaskBrief({ root, input }), /clean worktree/);
  } finally { cleanup(root); }
});
function validationFixture() {
  const root = temporaryRepo();
  const sourceRoot = path.resolve(process.cwd());
  try {
    taskBase(root);
    for (const relative of ['AGENTS.md', '.codex/skills/tackle-agent-workflow/SKILL.md', '.codex/skills/tackle-agent-workflow/agents/openai.yaml', '.github/pull_request_template.md']) write(root, relative, readFileSync(path.join(sourceRoot, relative), 'utf8'));
    const contract = readFileSync(path.join(sourceRoot, '.codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs'), 'utf8');
    write(root, '.codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs', `${contract}\nif (process.argv.includes('--check-policy')) writeFileSync(${JSON.stringify(path.join(root, 'validation-ran.marker'))}, 'ran\\n');\n`);
    write(root, '.codex/skills/tackle-agent-workflow/scripts/workflow-contract.test.mjs', `import { writeFileSync } from 'node:fs';\nimport test from 'node:test';\nwriteFileSync(${JSON.stringify(path.join(root, 'validation-ran.marker'))}, 'ran\\n');\ntest('validation command ran', () => {});\n`);
    writeNavigationIndex(root);
    command(root, ['add', '.']);
    command(root, ['commit', '-qm', 'validation fixture']);
    return root;
  } catch (error) { cleanup(root); throw error; }
}

test('patch manifest classifies explicit owned paths and is deterministic', () => {
  const root = temporaryRepo();
  try {
    write(root, 'tracked.txt', 'before\n');
    write(root, 'deleted.txt', 'gone\n');
    write(root, 'unchanged.txt', 'same\n');
    write(root, 'tool.sh', '#!/bin/sh\n');
    write(root, '目录/鱼.txt', '旧值\n');
    const baseSha = commitBase(root);
    write(root, 'tracked.txt', 'after\n');
    unlinkSync(path.join(root, 'deleted.txt'));
    write(root, 'untracked.txt', 'new\n');
    chmodSync(path.join(root, 'tool.sh'), 0o755);
    write(root, '目录/鱼.txt', '新值\n');
    const ownedPaths = ['untracked.txt', 'tool.sh', 'unchanged.txt', 'deleted.txt', 'tracked.txt', '目录/鱼.txt'];
    const first = patchHash({ root, baseSha, ownedPaths });
    const second = patchHash({ root, baseSha, ownedPaths: [...ownedPaths].reverse() });
    assert.equal(first.patchHash, second.patchHash);
    assert.deepEqual(first.manifest.entries.map((entry) => [entry.path, entry.state, entry.mode]), [
      ['deleted.txt', 'deleted', '100644'],
      ['tool.sh', 'tracked_changed', '100755'],
      ['tracked.txt', 'tracked_changed', '100644'],
      ['unchanged.txt', 'unchanged', '100644'],
      ['untracked.txt', 'untracked', '100644'],
      ['目录/鱼.txt', 'tracked_changed', '100644'],
    ]);
  } finally { cleanup(root); }
});

test('patch manifest rejects traversal and symlinks', (t) => {
  const root = temporaryRepo();
  try {
    write(root, 'safe.txt', 'safe\n');
    const baseSha = commitBase(root);
    assert.throws(() => buildPatchManifest({ root, baseSha, ownedPaths: ['../safe.txt'] }), /Invalid owned path/);
    try {
      symlinkSync('safe.txt', path.join(root, 'link.txt'));
    } catch (error) {
      t.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    assert.throws(() => buildPatchManifest({ root, baseSha, ownedPaths: ['link.txt'] }), /Symlink/);
  } finally { cleanup(root); }
});

test('navigation index is generated deterministically and detects drift', () => {
  const root = temporaryRepo();
  try {
    write(root, 'docs/tackle-forger-development-spec-v3.md', '# Title\n\n## 0. Authority\n\n### 0.1 Immutable\n\n### 3.1 Method and type\n\n### 5.2 Derived template\n\n## 8. Patch\n\n## 13. Snapshot\n\n## 14. Version\n\n### 18.2 Snapshot tests\n\n### 18.3 Patch tests\n\n## 20. Registry\n\n### 24.11 Snapshot detail\n\n## 25. Export\n\n| ID | Type | Status |\n| --- | --- | --- |\n| OPEN-001 Test | x | `OPEN` |\n');
    writeNavigationIndex(root);
    assert.equal(checkNavigationIndex(root), true);
    write(root, 'docs/tackle-forger-development-spec-v3.md', '# Title changed\n');
    assert.throws(() => checkNavigationIndex(root), /Navigation index drift|Navigation configuration/);
  } finally { cleanup(root); }
});

test('policy checker detects required workflow markers', () => {
  const root = temporaryRepo();
  try {
    const project = '## 项目级 Agent Skills\n- 对本仓库中的实现、修复或重构，`$tackle-agent-workflow`为所有路由提供项目约束与 TaskBrief；只有本地路由使用其编码与独立本地审核。Issue 与 PR 路由仍分别遵循`$agent-issue-loop`和`$agent-pr-loop`；仓库的合并、发布和部署门禁不因项目级Skill存在而放宽。\n';
    const canonicalAgents = readFileSync(path.resolve(process.cwd(), 'AGENTS.md'), 'utf8');
    const agents = `${project}\n## Tackle 工作流契约\n- \`$tackle-agent-workflow\`提供项目约束和 TaskBrief；仅本地路由使用其编码与独立本地审核。Issue 生命周期归\`$agent-issue-loop\`，PR 审核/CI/修复归\`$agent-pr-loop\`；已有 PR 直接使用后者。不得增加第二个独立审核者。\n<!-- workflow-contract-policy/v2\n{"dirtyIsolation":{"issuePr":"clean_synced","localOwnedBaseline":"tackle-owned-baseline/v1"},"issue":{"localReviewer":false,"owner":"agent-issue-loop","prReviewer":"agent-pr-loop"},"local":{"independentReviewer":true,"owner":"tackle-agent-workflow"},"localVerdict":{"required":["taskBriefSha256","specReceiptHashes","dirtyWorktreeDisposition","specSha256","baseSha","reviewedHead","ownedPaths","patchHash"],"schema":"tackle-local-verdict/v1"},"pullRequest":{"owner":"agent-pr-loop","reviewer":"agent-pr-loop"},"reviewSeverity":{"passBlocking":["P0","P1","P2"],"p3":"informational"},"scopedEligibility":{"allowedPathClasses":["AGENTS.md",".codex/skills/tackle-agent-workflow/**","docs/(workflow|agent-governance)-*.md",".github/*.md|yml|yaml"],"unknownForcesFull":true},"specReceipt":{"schema":"tackle-spec-read/v1"},"taskBrief":{"closedSchema":true,"openDecisionCheck":true,"phaseReceipts":{"pre_dispatch":["coordinator"],"verdict":["coordinator","coding","review"]},"receiptRiskAuthority":true,"schema":"tackle-task-brief/v1","structuredFields":["changeClass","allowedChanges","riskDimensions","validationPlan"]},"validationMatrix":{"commandsAndScenariosSeparated":true,"prFinalCommandsNonWaivable":["npm run typecheck","npm run lint","npm test"],"userVisibleScenario":"unified_visual_review_pending_or_completed"},"visual":{"minimalSmokeCompletesReview":false,"pendingMarker":"视觉与交互统一检查待执行"}}\n-->\n## 本机凭据与多 worktree\n`;
    const skill = '<!-- workflow-contract-policy-ref: AGENTS.md/workflow-contract-policy/v2 -->\n\n## Route before dispatch\n\n- **Local implementation, no Issue or PR:** this Skill owns one coding agent and one independent local reviewer.\n- **Issue delivery:** `$agent-issue-loop` owns Issue, branch, PR, closure, and handoff. Supply it this Skill\'s TaskBrief; do not start a local independent reviewer. Once a PR exists, `$agent-pr-loop` exclusively owns review, CI, fixes, and merge gates.\n- **Existing PR:** invoke `$agent-pr-loop` directly and supply the TaskBrief. Do not create a coding or review loop here.\n\n## Establish the TaskBrief\n\n<!-- workflow-contract-task-brief-ref/v1\n{"conditionalNaApplicability":{"legacyTouchedForbids":"legacy_workspace_ci","nonLegacyRequires":"legacy_workspace_ci","nonWorkflowForbids":"product_runtime_tests","workflowMetadataRequires":"product_runtime_tests"},"conditionalNaCatalog":{"legacyWorkspaceCi":"legacy_workspace_ci","productRuntimeTests":"product_runtime_tests"},"evidenceStages":{"development":"pre_dispatch_non_pr_final","localReviewHandoff":"local_verdict","prFinal":"pr_final_change_class"},"legacyWorkspaceCommands":["node --test tests/package-manager-boundaries.test.mjs","pnpm --dir legacy-workspace install --frozen-lockfile","pnpm --dir legacy-workspace --filter \'@tackle-forger/*\' typecheck","pnpm --dir legacy-workspace --filter \'@tackle-forger/*\' lint","pnpm --dir legacy-workspace --filter \'@tackle-forger/*\' test","pnpm --dir legacy-workspace --filter \'@tackle-forger/*\' build"],"triggeredCannotBeNa":true}\n-->\n\n## Spec receipts and worktree isolation\n';
    const yaml = 'interface:\n  display_name: "Tackle Agent Workflow"\n  short_description: "Prepare scoped work and locally review implementation"\n  default_prompt: "Use $tackle-agent-workflow to prepare the TaskBrief, choose the correct local, Issue, or PR route, and run only the applicable workflow. Preserve the pending unified visual-review marker unless full visual work is explicitly scoped."\n';
    const template = '## Visual evidence\n\n| Unified visual and interaction review | 视觉与交互统一检查待执行 / Full visual and interaction review completed |\n| Minimal render smoke | Not run / Completed; this never changes the unified-review status |\n\n## Risks, recovery, and rollback\n';
    write(root, 'AGENTS.md', canonicalAgents);
    write(root, '.codex/skills/tackle-agent-workflow/SKILL.md', skill);
    write(root, '.github/pull_request_template.md', template);
    write(root, '.codex/skills/tackle-agent-workflow/agents/openai.yaml', yaml);
    assert.equal(checkPolicy(root), true);
    write(root, 'AGENTS.md', canonicalAgents.replace('$tackle-agent-workflow', '$different-workflow'));
    assert.throws(() => checkPolicy(root), /broad project Skill statement differs|Workflow policy drift/);
    write(root, 'AGENTS.md', canonicalAgents);
    appendFileSync(path.join(root, 'AGENTS.md'), 'Issue 路由也必须再创建一个本地独立审核者。\n');
    assert.throws(() => checkPolicy(root), /Workflow policy drift/);
    write(root, 'AGENTS.md', canonicalAgents);
    appendFileSync(path.join(root, '.codex/skills/tackle-agent-workflow/SKILL.md'), 'Issue delivery uses a local independent reviewer.\n');
    assert.throws(() => checkPolicy(root), /contradictory normative text/);
    write(root, '.codex/skills/tackle-agent-workflow/SKILL.md', skill);
    write(root, '.codex/skills/tackle-agent-workflow/SKILL.md', skill.replace('"productRuntimeTests":"product_runtime_tests"', '"productRuntimeTests":"wrong_catalog_id"'));
    assert.throws(() => checkPolicy(root), /TaskBrief policy reference differs/);
    write(root, '.codex/skills/tackle-agent-workflow/SKILL.md', skill.replace('node --test tests/package-manager-boundaries.test.mjs', 'node --test tests/missing-boundaries.test.mjs'));
    assert.throws(() => checkPolicy(root), /TaskBrief policy reference differs/);
    write(root, '.codex/skills/tackle-agent-workflow/SKILL.md', skill.replace('"workflowMetadataRequires":"product_runtime_tests"', '"workflowMetadataRequires":"legacy_workspace_ci"'));
    assert.throws(() => checkPolicy(root), /TaskBrief policy reference differs/);
    write(root, '.codex/skills/tackle-agent-workflow/SKILL.md', skill.replace('"triggeredCannotBeNa":true', '"triggeredCannotBeNa":false'));
    assert.throws(() => checkPolicy(root), /TaskBrief policy reference differs/);
    write(root, '.codex/skills/tackle-agent-workflow/SKILL.md', skill);
    appendFileSync(path.join(root, '.codex/skills/tackle-agent-workflow/agents/openai.yaml'), 'Always inspect rendered UI for every route.\n');
    assert.throws(() => checkPolicy(root), /Workflow policy drift/);
    write(root, '.codex/skills/tackle-agent-workflow/agents/openai.yaml', yaml);
    appendFileSync(path.join(root, '.github/pull_request_template.md'), 'Minimal render smoke replaces the pending unified visual review.\n');
    assert.throws(() => checkPolicy(root), /Workflow policy drift/);
  } finally { cleanup(root); }
});

test('spec-read receipts enforce full/scoped plans and canonical v3 hash', () => {
  const root = temporaryRepo();
  try {
    write(root, 'docs/tackle-forger-development-spec-v3.md', '# V3\n\n## 0. Authority\n\n### 0.1 Immutable\n\n### 3.1 Method and type\n\n### 5.2 Derived template\n\n## 8. Patch\n\n## 13. Snapshot\n\n## 14. Version\n\n### 18.2 Snapshot\n\n### 18.3 Patch\n\n## 19. Risks\n\n## 20. Open\n\n## 21. Relevant\n\n### 24.11 Snapshot\n\n## 25. Export\n');
    const full = receipt(root);
    assert.equal(checkReadReceipt({ root, receipt: full }).receiptHash, receiptHash(full));
    const scoped = receipt(root, {
      role: 'coding', profile: 'SCOPED', riskProfile: 'workflow_docs_metadata', relevantSections: ['21'],
      requiredSections: ['README', '0', '19', '20', '21'], readSections: ['README', '0', '19', '20', '21'],
    });
    assert.equal(checkReadReceipt({ root, receipt: scoped }).requiredSections.includes('21'), true);
    assert.equal(specReadPlan({ role: 'review', riskProfile: 'workflow_docs_metadata', relevantSections: ['21'] }).profile, 'SCOPED');
    assert.throws(() => checkReadReceipt({ root, receipt: { ...scoped, specSha256: '0'.repeat(64) } }), /does not match/);
    for (const missing of ['0', '19', '20', '21']) {
      assert.throws(() => checkReadReceipt({ root, receipt: { ...scoped, readSections: scoped.readSections.filter((item) => item !== missing) } }), /missing a required/);
      assert.throws(() => checkReadReceipt({ root, receipt: { ...scoped, requiredSections: scoped.requiredSections.filter((item) => item !== missing), readSections: scoped.readSections.filter((item) => item !== missing) } }), /requiredSections does not match/);
    }
    assert.throws(() => checkReadReceipt({ root, receipt: { ...scoped, riskProfile: 'runtime_behavior' } }), /profile must be FULL/);
  } finally { cleanup(root); }
});

test('full-read sessions reuse only exact continuous low-risk evidence', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const session = fullReadSession(root);
    assert.equal(checkFullReadSession({ root, session }).sessionHash, fullReadSessionHash(session));
    write(root, 'session.json', `${JSON.stringify(session)}\n`);
    assert.equal(JSON.parse(runCli(['--check-full-read-session', '--session', 'session.json'], root)).sessionHash, fullReadSessionHash(session));
    const reused = reusedReceipt(root);
    const current = currentReuseContext(reused.reuseEvidence.session);
    assert.equal(checkReadReceipt({ root, receipt: reused, currentReuseContext: current }).sessionHash, fullReadSessionHash(session));
    write(root, 'reused-receipt.json', `${JSON.stringify(reused)}\n`);
    assert.equal(JSON.parse(runCli(['--check-read-receipt', '--receipt', 'reused-receipt.json', '--current-agent-identity', current.currentAgentIdentity, '--current-context-session-id', current.currentContextSessionId, '--current-context-state', current.currentContextState], root)).sessionHash, fullReadSessionHash(session));
    assert.equal(checkTaskBrief({ root, brief: brief(root, { taskId: 'task-2', specReadReceipts: [reused] }), currentReuseContext: current }).taskBriefSha256.length, 64);
    assert.throws(() => checkReadReceipt({ root, receipt: reused }), /currentReuseContext/);
    assert.throws(() => checkTaskBrief({ root, brief: brief(root, { taskId: 'task-2', specReadReceipts: [reused] }) }), /currentReuseContext/);
    assert.throws(() => checkFullReadSession({ root, session: { ...session, contextState: 'compacted' } }), /unknown or compacted/);
    assert.throws(() => checkReadReceipt({ root, receipt: { ...reused, reuseEvidence: { ...reused.reuseEvidence, agentIdentity: 'agent:other' } }, currentReuseContext: current }), /exact same agent/);
    assert.throws(() => checkReadReceipt({ root, receipt: { ...reused, riskProfile: 'runtime_product_domain' }, currentReuseContext: current }), /only valid/);
    assert.throws(() => checkReadReceipt({ root, receipt: { ...reused, readSections: ['README', '0', '19', '20'] }, currentReuseContext: current }), /explicitly read/);
    assert.throws(() => checkReadReceipt({ root, receipt: reused, currentReuseContext: { ...current, currentAgentIdentity: 'agent:other' } }), /caller-provided/);
    assert.throws(() => checkReadReceipt({ root, receipt: reused, currentReuseContext: { ...current, currentContextState: 'compacted' } }), /currentContextState/);
    const copiedSession = { ...reused.reuseEvidence.session, agentIdentity: 'agent:other' };
    const copiedReceipt = { ...reused, reuseEvidence: { ...reused.reuseEvidence, session: copiedSession, sessionSha256: fullReadSessionHash(copiedSession), agentIdentity: 'agent:other' } };
    assert.throws(() => checkReadReceipt({ root, receipt: copiedReceipt, currentReuseContext: current }), /caller-provided/);
    for (const invalid of ['2026-02-29T00:00:00Z', '2025-04-31T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00.1Z']) assert.throws(() => checkFullReadSession({ root, session: { ...session, createdAt: invalid } }), /RFC 3339|real UTC/);
    assert.equal(checkFullReadSession({ root, session: { ...session, createdAt: '2024-02-29T23:59:59Z' } }).sessionHash.length, 64);
    unlinkSync(path.join(root, 'session.json'));
    unlinkSync(path.join(root, 'reused-receipt.json'));
    const coding = receipt(root, { taskId: 'task-2', role: 'coding', profile: 'SCOPED', requiredSections: ['README', '0', '19', '20', '1'], readSections: ['README', '0', '19', '20', '1'], reason: 'implementation' });
    const review = receipt(root, { taskId: 'task-2', role: 'review', profile: 'SCOPED', requiredSections: ['README', '0', '19', '20', '1'], readSections: ['README', '0', '19', '20', '1'], reason: 'review' });
    const verdictBrief = brief(root, { taskId: 'task-2', phase: 'verdict', reviewedHead: command(root, ['rev-parse', 'HEAD']), specReadReceipts: [reused, coding, review] });
    assert.equal(validationExecutionPlan({ root, brief: verdictBrief, currentReuseContext: current }).artifact.artifactIdentity.kind, 'commit');
    assert.throws(() => validationExecutionPlan({ root, brief: verdictBrief }), /currentReuseContext/);
    assert.throws(() => validationExecutionPlan({ root, brief: verdictBrief, currentReuseContext: { ...current, currentContextState: 'compacted' } }), /currentContextState/);
    assert.throws(() => validationExecutionPlan({ root, brief: verdictBrief, currentReuseContext: { ...current, currentAgentIdentity: 'agent:other' } }), /caller-provided/);
    assert.throws(() => validationExecutionPlan({ root, brief: verdictBrief, currentReuseContext: { ...current, currentContextSessionId: 'context:other' } }), /caller-provided/);
    write(root, 'docs/README.md', '# Changed\n');
    assert.throws(() => checkFullReadSession({ root, session }), /README/);
  } finally { cleanup(root); }
});

test('REUSE_FULL runValidation and CLI fail before execution without trusted current context', () => {
  const root = validationFixture();
  const handoff = mkdtempSync(path.join(os.tmpdir(), 'workflow-validation-handoff-'));
  const marker = path.join(root, 'validation-ran.marker');
  try {
    const reused = reusedReceipt(root);
    const current = currentReuseContext(reused.reuseEvidence.session);
    const coding = receipt(root, { taskId: 'task-2', role: 'coding', profile: 'SCOPED', requiredSections: ['README', '0', '19', '20', '1'], readSections: ['README', '0', '19', '20', '1'], reason: 'implementation' });
    const review = receipt(root, { taskId: 'task-2', role: 'review', profile: 'SCOPED', requiredSections: ['README', '0', '19', '20', '1'], readSections: ['README', '0', '19', '20', '1'], reason: 'review' });
    const verdictBrief = brief(root, { taskId: 'task-2', phase: 'verdict', reviewedHead: command(root, ['rev-parse', 'HEAD']), specReadReceipts: [reused, coding, review] });
    const briefPath = path.join(handoff, 'verdict-brief.json');
    writeFileSync(briefPath, `${JSON.stringify(verdictBrief)}\n`);
    for (const invalid of [undefined, { ...current, currentContextState: 'compacted' }, { ...current, currentAgentIdentity: 'agent:other' }, { ...current, currentContextSessionId: 'context:other' }]) {
      assert.throws(() => runValidation({ root, brief: verdictBrief, currentReuseContext: invalid }), /currentReuseContext|currentContextState|caller-provided/);
      assert.equal(existsSync(marker), false);
    }
    const summary = runValidation({ root, brief: verdictBrief, currentReuseContext: current });
    assert.equal(summary.schema, 'tackle-validation-summary/v1');
    assert.equal(summary.results.every((result) => result.result === 'PASS'), true);
    assert.equal(existsSync(marker), true, JSON.stringify(summary.results));
    unlinkSync(marker);
    for (const args of [
      ['--run-validation', '--brief', briefPath],
      ['--run-validation', '--brief', briefPath, '--current-agent-identity', current.currentAgentIdentity, '--current-context-session-id', current.currentContextSessionId, '--current-context-state', 'compacted'],
      ['--run-validation', '--brief', briefPath, '--current-agent-identity', 'agent:other', '--current-context-session-id', current.currentContextSessionId, '--current-context-state', 'continuous'],
      ['--run-validation', '--brief', briefPath, '--current-agent-identity', current.currentAgentIdentity, '--current-context-session-id', 'context:other', '--current-context-state', 'continuous'],
    ]) {
      assert.throws(() => runCli(args, root), /currentReuseContext|currentContextState|caller-provided/);
      assert.equal(existsSync(marker), false);
    }
    const cliSummary = JSON.parse(runCli(['--run-validation', '--brief', briefPath, '--current-agent-identity', current.currentAgentIdentity, '--current-context-session-id', current.currentContextSessionId, '--current-context-state', 'continuous'], root));
    assert.equal(cliSummary.schema, 'tackle-validation-summary/v1');
    assert.equal(cliSummary.results.every((result) => result.result === 'PASS'), true);
    assert.equal(existsSync(marker), true);
  } finally { cleanup(root); cleanup(handoff); }
});

test('TaskBrief enforces dirty-worktree isolation and deterministic identity', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const clean = brief(root);
    const first = checkTaskBrief({ root, brief: clean });
    const second = checkTaskBrief({ root, brief: JSON.parse(JSON.stringify(clean)) });
    assert.equal(first.taskBriefSha256, second.taskBriefSha256);
    assert.equal(first.taskBriefSha256, taskBriefHash(clean));
    assert.throws(() => checkTaskBrief({ root, brief: { ...clean, workflowMode: 'issue', dirtyWorktreeDisposition: 'clean_synced', preexistingOwnedPaths: ['AGENTS.md'] } }), /Issue\/PR/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...clean, workflowMode: 'pull_request', dirtyWorktreeDisposition: 'clean' } }), /Issue\/PR/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...clean, workflowMode: 'issue', reviewedHead: clean.baseSha, dirtyWorktreeDisposition: 'clean_synced', preexistingOwnedPaths: ['AGENTS.md'] } }), /clean_synced/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...clean, workflowMode: 'pull_request', reviewedHead: clean.baseSha.slice(0, 12), dirtyWorktreeDisposition: 'clean_synced' } }), /exact 40-hex/);
    write(root, 'AGENTS.md', 'preexisting\n');
    const baseline = buildOwnedBaselineManifest({ root, baseSha: clean.baseSha, ownedPaths: ['docs/tackle-forger-development-spec-v3.md', 'AGENTS.md'] });
    assert.throws(() => checkTaskBrief({ root, brief: { ...clean, preexistingOwnedPaths: ['AGENTS.md'], dirtyWorktreeDisposition: 'include_with_frozen_baseline' } }), /unknown, missing, or inapplicable keys/);
    const frozen = { ...clean, ownedPaths: ['AGENTS.md', 'docs/tackle-forger-development-spec-v3.md'], allowedChanges: ['AGENTS.md', 'docs/tackle-forger-development-spec-v3.md'], preexistingOwnedPaths: ['AGENTS.md'], riskProfile: 'runtime_product_domain', scopeHasRuntimeSemantics: true, changeClass: 'typescript_api', validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test'], requiredScenarios: ['normal_path'], intentionallyNotApplicable: nonLegacyNa() }, specReadReceipts: [receipt(root, { riskProfile: 'runtime_product_domain', reason: 'authority baseline' })], dirtyWorktreeDisposition: 'include_with_frozen_baseline', preTaskOwnedBaselineManifest: baseline, preTaskOwnedBaselineHash: ownedBaselineHash(baseline) };
    assert.equal(checkTaskBrief({ root, brief: frozen }).dirtyWorktreeDisposition, 'include_with_frozen_baseline');
    assert.equal(ownedBaselineHash(baseline), ownedBaselineHash(JSON.parse(JSON.stringify(baseline))));
    assert.throws(() => checkTaskBrief({ root, brief: { ...frozen, preTaskOwnedBaselineHash: '0'.repeat(64) } }), /must match its deterministic baseline manifest/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...frozen, preTaskOwnedBaselineManifest: { ...baseline, entries: baseline.entries.map((entry) => ({ ...entry, state: 'unchanged' })) } } }), /does not match preexistingOwnedPaths/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...frozen, preTaskOwnedBaselineManifest: { ...baseline, entries: [...baseline.entries].reverse() } } }), /UTF-8-sort/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...frozen, preTaskOwnedBaselineManifest: { ...baseline, entries: baseline.entries.map((entry) => ({ ...entry, extra: true })) } } }), /unknown, missing, or inapplicable keys/);
  } finally { cleanup(root); }
});

test('TaskBrief rejects empty shells and verdict cross-checks all durable identities', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const preDispatch = brief(root);
    for (const field of ['scope', 'acceptanceCriteria', 'exclusions', 'riskDimensions', 'validationPlan', 'allowedChanges', 'baseSha', 'reviewedHead', 'preexistingUnownedChanges']) {
      const invalid = { ...preDispatch }; delete invalid[field];
      assert.throws(() => checkTaskBrief({ root, brief: invalid }), /TaskBrief/);
    }
    assert.throws(() => checkTaskBrief({ root, brief: { ...preDispatch, validation: [{ command: null, naReason: '' }] } }), /unknown, missing, or inapplicable keys/);
    const coding = receipt(root, { role: 'coding', profile: 'SCOPED', requiredSections: ['README', '0', '19', '20', '1'], readSections: ['README', '0', '19', '20', '1'], reason: 'implementation' });
    const review = receipt(root, { role: 'review', profile: 'SCOPED', requiredSections: ['README', '0', '19', '20', '1'], readSections: ['README', '0', '19', '20', '1'], reason: 'review' });
    const verdictBrief = { ...preDispatch, phase: 'verdict', specReadReceipts: [preDispatch.specReadReceipts[0], coding, review] };
    const checkedBrief = checkTaskBrief({ root, brief: verdictBrief });
    const verdict = {
      schema: 'tackle-local-verdict/v1', taskId: verdictBrief.taskId, taskBriefSha256: checkedBrief.taskBriefSha256,
      specReceiptHashes: checkedBrief.specReceiptHashes, dirtyWorktreeDisposition: verdictBrief.dirtyWorktreeDisposition,
      specSha256: verdictBrief.specSha256, baseSha: verdictBrief.baseSha, reviewedHead: 'WORKTREE', ownedPaths: verdictBrief.ownedPaths,
      artifactIdentity: { kind: 'worktree', commitSha: null, patchHash: patchHash({ root, baseSha: verdictBrief.baseSha, ownedPaths: verdictBrief.ownedPaths }).patchHash }, verdict: 'PASS', findings: [],
    };
    assert.equal(checkVerdict({ root, verdict, brief: verdictBrief }).taskBriefSha256, checkedBrief.taskBriefSha256);
    assert.throws(() => checkTaskBrief({ root, brief: { ...preDispatch, phase: 'verdict' } }), /requires exactly one coordinator, coding, and review/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...preDispatch, specReadReceipts: [{ ...preDispatch.specReadReceipts[0], relevantSections: ['2'] }] } }), /riskProfile and relevantSections/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...preDispatch, riskProfile: 'runtime_product_domain', scopeHasRuntimeSemantics: true } }), /workflow_metadata requires/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...preDispatch, unexpected: true } }), /unknown, missing, or inapplicable keys/);
    assert.throws(() => checkReadReceipt({ root, receipt: { ...preDispatch.specReadReceipts[0], unexpected: true } }), /unknown, missing, or inapplicable keys/);
    assert.throws(() => checkVerdict({ root, verdict: { ...verdict, artifactIdentity: { ...verdict.artifactIdentity, patchHash: '0'.repeat(64) } }, brief: verdictBrief }), /recomputed current patch hash/);
    assert.throws(() => checkVerdict({ root, verdict: { ...verdict, extra: true }, brief: verdictBrief }), /unknown, missing, or inapplicable keys/);
    assert.throws(() => checkVerdict({ root, verdict: { ...verdict, validationEvidence: { caller: 'authored' } }, brief: verdictBrief }), /unknown, missing, or inapplicable keys/);
    assert.throws(() => checkVerdict({ root, verdict: { ...verdict, findings: [{ severity: 'P1', file: 'AGENTS.md', line: 1, evidence: 'x', remediation: 'y' }] }, brief: verdictBrief }), /PASS verdict/);
    write(root, 'unowned.txt', 'dirty\n');
    assert.throws(() => validationExecutionPlan({ root, brief: verdictBrief }), /only TaskBrief owned-path changes/);
    unlinkSync(path.join(root, 'unowned.txt'));
    write(root, 'AGENTS.md', 'task-owned change\n');
    assert.equal(validationExecutionPlan({ root, brief: verdictBrief }).artifact.artifactIdentity.kind, 'worktree');
    write(root, 'AGENTS.md', 'base\n');
    assert.throws(() => validationExecutionPlan({ root, brief: { ...verdictBrief, preexistingUnownedChanges: ['unowned.txt'] } }), /no preexisting owned or unowned worktree changes/);
    assert.throws(() => runCli(['--patch-hash', '--base', verdictBrief.baseSha, '--base', verdictBrief.baseSha, '--owned', 'AGENTS.md'], root), /Usage/);
    assert.throws(() => runCli(['--check-policy', '--unknown', 'x'], root), /Usage/);
    assert.throws(() => runCli(['--check-verdict', '--brief', 'brief.json', '--brief', 'brief.json', '--verdict', 'verdict.json'], root), /Usage/);
    assert.throws(() => runCli(['--owned-baseline', '--base', verdictBrief.baseSha], root), /Usage/);
  } finally { cleanup(root); }
});

test('derived evidence stages keep development light and freeze only the review artifact', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const development = brief(root);
    assert.equal(checkTaskBrief({ root, brief: development }).phase, 'pre_dispatch');
    assert.throws(() => checkTaskBrief({ root, brief: { ...development, evidenceStage: 'local_review_handoff' } }), /unknown, missing, or inapplicable keys/);
    const coding = receipt(root, { role: 'coding', profile: 'SCOPED', requiredSections: ['README', '0', '19', '20', '1'], readSections: ['README', '0', '19', '20', '1'], reason: 'implementation' });
    const review = receipt(root, { role: 'review', profile: 'SCOPED', requiredSections: ['README', '0', '19', '20', '1'], readSections: ['README', '0', '19', '20', '1'], reason: 'review' });
    const committedBrief = { ...development, phase: 'verdict', reviewedHead: development.baseSha, specReadReceipts: [development.specReadReceipts[0], coding, review] };
    const checked = checkTaskBrief({ root, brief: committedBrief });
    const identity = committedBrief.reviewedHead;
    const committedVerdict = {
      schema: 'tackle-local-verdict/v1', taskId: committedBrief.taskId, taskBriefSha256: checked.taskBriefSha256,
      specReceiptHashes: checked.specReceiptHashes, dirtyWorktreeDisposition: committedBrief.dirtyWorktreeDisposition,
      specSha256: committedBrief.specSha256, baseSha: committedBrief.baseSha, reviewedHead: identity, ownedPaths: committedBrief.ownedPaths,
      artifactIdentity: { kind: 'commit', commitSha: identity, patchHash: null }, verdict: 'PASS', findings: [],
    };
    assert.equal(checkVerdict({ root, verdict: committedVerdict, brief: committedBrief }).artifactIdentity.commitSha, identity);
    assert.throws(() => checkVerdict({ root, verdict: { ...committedVerdict, artifactIdentity: { ...committedVerdict.artifactIdentity, patchHash: '0'.repeat(64) } }, brief: committedBrief }), /must not require a patch hash/);
    const execution = validationExecutionPlan({ root, brief: committedBrief });
    assert.equal(execution.artifact.inputIdentity, identity);
    assert.deepEqual(execution.commands.map((item) => item.command), committedBrief.validationPlan.requiredCommands);
    assert.match(execution.reuseIdentity.relevantInputsHash, /^[0-9a-f]{64}$/);
    assert.match(execution.reuseIdentity.commandContractHash, /^[0-9a-f]{64}$/);
    assert.match(execution.reuseIdentity.environmentIdentity, /^[0-9a-f]{64}$/);
    assert.deepEqual(execution.toolchain.tools.map((tool) => tool.executable), [...execution.toolchain.tools.map((tool) => tool.executable)].sort());
    assert.ok(execution.toolchain.tools.every((tool) => path.isAbsolute(tool.resolvedPath) && tool.version.length > 0));
    assert.match(execution.toolchain.environment.pathHash, /^[0-9a-f]{64}$/);
    assert.match(execution.toolchain.environment.installedDependencyHash, /^(none|[0-9a-f]{64})$/);
    write(root, 'unowned.txt', 'dirty\n');
    assert.throws(() => validationExecutionPlan({ root, brief: committedBrief }), /fully clean worktree/);
    unlinkSync(path.join(root, 'unowned.txt'));
    assert.throws(() => runCli(['--capture-validation', '--input', 'caller-authored.json'], root), /Usage/);
  } finally { cleanup(root); }
});

test('SCOPED eligibility, clean Issue/PR routing, sections, OPEN IDs, and receipt cardinality fail closed', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const local = brief(root);
    assert.throws(() => checkTaskBrief({ root, brief: { ...local, ownedPaths: ['src/runtime.ts'], allowedChanges: ['src/runtime.ts'] } }), /workflow_metadata may own only scoped/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...local, ownedPaths: ['docs/tackle-forger-development-spec-v3.md'], allowedChanges: ['docs/tackle-forger-development-spec-v3.md'] } }), /workflow_metadata may own only scoped/);
    const runtimeReceipt = receipt(root, { riskProfile: 'runtime_product_domain', reason: 'runtime change' });
    const runtimeBrief = { ...local, ownedPaths: ['src/runtime.ts'], allowedChanges: ['src/runtime.ts'], riskProfile: 'runtime_product_domain', scopeHasRuntimeSemantics: true, changeClass: 'typescript_api', validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test'], requiredScenarios: ['normal_path'], intentionallyNotApplicable: nonLegacyNa() }, specReadReceipts: [runtimeReceipt] };
    assert.equal(checkTaskBrief({ root, brief: runtimeBrief }).phase, 'pre_dispatch');
    assert.throws(() => checkTaskBrief({ root, brief: { ...runtimeBrief, specReadReceipts: [{ ...runtimeReceipt, profile: 'SCOPED' }] } }), /profile must be FULL/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...local, specReadReceipts: [local.specReadReceipts[0], local.specReadReceipts[0]] } }), /exactly one coordinator/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...local, relevantSections: ['1', '20', '404'] } }), /section absent/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...local, openDecisionCheck: { ...local.openDecisionCheck, checkedIds: ['OPEN-999'], applicableIds: ['OPEN-999'] } } }), /complete current v3 OPEN registry/);
    assert.equal(checkTaskBrief({ root, brief: { ...local, openDecisionCheck: { ...local.openDecisionCheck, applicableIds: [], noApplicableReason: 'No registry item affects this workflow-only change.' } } }).phase, 'pre_dispatch');
    const issue = { ...local, workflowMode: 'issue', reviewedHead: local.baseSha, dirtyWorktreeDisposition: 'clean_synced' };
    assert.equal(checkTaskBrief({ root, brief: issue }).reviewedHead, local.baseSha);
    write(root, 'untracked.txt', 'dirty\n');
    assert.throws(() => checkTaskBrief({ root, brief: issue }), /actually clean git status/);
    unlinkSync(path.join(root, 'untracked.txt'));
    write(root, 'later.txt', 'later\n'); command(root, ['add', '.']); command(root, ['commit', '-qm', 'later']);
    assert.throws(() => checkTaskBrief({ root, brief: issue }), /current HEAD|HEAD to equal baseSha/);
    const featureIssue = { ...issue, reviewedHead: command(root, ['rev-parse', 'HEAD']) };
    assert.equal(checkTaskBrief({ root, brief: featureIssue }).reviewedHead, featureIssue.reviewedHead);
    const coding = receipt(root, { role: 'coding', profile: 'SCOPED', requiredSections: ['README', '0', '19', '20', '1'], readSections: ['README', '0', '19', '20', '1'], reason: 'implementation' });
    const review = receipt(root, { role: 'review', profile: 'SCOPED', requiredSections: ['README', '0', '19', '20', '1'], readSections: ['README', '0', '19', '20', '1'], reason: 'review' });
    const duplicateBase = command(root, ['rev-parse', 'HEAD']);
    const duplicate = { ...local, baseSha: duplicateBase, reviewedHead: 'WORKTREE', validationPlan: { ...local.validationPlan, requiredCommands: [...local.validationPlan.requiredCommands.filter((item) => !item.startsWith('git diff --check')), `git diff --check ${duplicateBase} -- AGENTS.md`] }, phase: 'verdict', specReadReceipts: [local.specReadReceipts[0], coding, review, review] };
    assert.throws(() => checkTaskBrief({ root, brief: duplicate }), /exactly one coordinator, coding, and review/);
  } finally { cleanup(root); }
});

test('validation plan rejects command/scenario swaps, invalid N/A, and uncovered paths', () => {
  const root = temporaryRepo();
  try {
    taskBase(root); const base = brief(root);
    assert.throws(() => checkTaskBrief({ root, brief: { ...base, validationPlan: { ...base.validationPlan, requiredCommands: ['git diff --check'], requiredScenarios: ['authority_and_scoped_diff', 'node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-policy', 'node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-index'] } } }), /wrong collection|omits required command/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...base, validationPlan: { ...base.validationPlan, requiredCommands: [...base.validationPlan.requiredCommands, 'authority_and_scoped_diff'] } } }), /wrong collection/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...base, validationPlan: { ...base.validationPlan, requiredCommands: [base.validationPlan.requiredCommands[0], base.validationPlan.requiredCommands[0], ...base.validationPlan.requiredCommands.slice(2)] } } }), /must not contain duplicates/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...base, validationPlan: { ...base.validationPlan, intentionallyNotApplicable: { 'unknown-check': 'no' } } } }), /unknown or duplicated/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...base, validationPlan: { ...base.validationPlan, intentionallyNotApplicable: { 'git diff --check': 'no' } } } }), /unknown or duplicated/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...base, ownedPaths: ['x.md'] } }), /allowedChanges/);
  } finally { cleanup(root); }
});

test('validation matrix enforces PR, risk, user-visible, and domain-drift gates', () => {
  const root = temporaryRepo();
  try {
    taskBase(root); const base = brief(root);
    const runtimeReceipt = receipt(root, { riskProfile: 'runtime_product_domain', reason: 'runtime final gate' });
    const pr = { ...base, workflowMode: 'pull_request', reviewedHead: base.baseSha, dirtyWorktreeDisposition: 'clean_synced', riskProfile: 'runtime_product_domain', scopeHasRuntimeSemantics: true, changeClass: 'pr_final', specReadReceipts: [runtimeReceipt], validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test'], requiredScenarios: ['ci_gate'], intentionallyNotApplicable: nonLegacyNa() } };
    assert.equal(checkTaskBrief({ root, brief: pr }).phase, 'pre_dispatch');
    assert.throws(() => checkTaskBrief({ root, brief: { ...pr, validationPlan: { ...pr.validationPlan, requiredCommands: ['npm run typecheck', 'npm run lint'], intentionallyNotApplicable: { 'npm test': 'skip' } } } }), /cannot be N\/A/);
    const migration = { ...base, riskProfile: 'durable_migration', scopeHasRuntimeSemantics: true, changeClass: 'persistence_migration', specReadReceipts: [receipt(root, { riskProfile: 'durable_migration', reason: 'migration' })], validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test'], requiredScenarios: ['normal_path', 'boundary', 'conflict', 'version_freeze', 'production_shape_fixture', 'unknown_field_preservation', 'second_run_noop'], intentionallyNotApplicable: nonLegacyNa() } };
    assert.throws(() => checkTaskBrief({ root, brief: migration }), /requires persistedData/);
    const ui = { ...base, ownedPaths: ['components/view.css'], allowedChanges: ['components/view.css'], riskProfile: 'runtime_product_domain', scopeHasRuntimeSemantics: true, changeClass: 'typescript_api', specReadReceipts: [runtimeReceipt], validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test'], requiredScenarios: ['normal_path'], intentionallyNotApplicable: nonLegacyNa() } };
    assert.throws(() => checkTaskBrief({ root, brief: ui }), /User-visible owned paths require userVisible risk/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...ui, riskDimensions: { ...ui.riskDimensions, userVisible: true } } }), /unified_visual_review_pending_or_completed/);
    write(root, 'docs/tackle-forger-development-spec-v3.md', '# V3\n');
    assert.throws(() => buildNavigationIndex(root), /Navigation configuration/);
  } finally { cleanup(root); }
});

test('adversarial navigation and TaskBrief evidence fail closed', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const base = brief(root);
    assert.throws(() => checkTaskBrief({ root, brief: { ...base, validationPlan: { ...base.validationPlan, requiredCommands: base.validationPlan.requiredCommands.filter((item) => !item.includes('--check-index')), intentionallyNotApplicable: { 'node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-index': 'not allowed' } } } }), /cannot be N\/A/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...base, allowedChanges: ['AGENTS.md', '.codex/skills/tackle-agent-workflow/SKILL.md'] } }), /exactly equal ownedPaths/);
    const spec = readFileSync(path.join(root, 'docs/tackle-forger-development-spec-v3.md'), 'utf8');
    write(root, 'docs/tackle-forger-development-spec-v3.md', `${spec}\n\`\`\`md\n## 999. Fake heading\n\`\`\`\n## 14. Duplicate version\n`);
    assert.throws(() => buildNavigationIndex(root), /Duplicate v3 section identifier/);
    write(root, 'docs/tackle-forger-development-spec-v3.md', spec.replace('### 5.2 Derived template\n\n', ''));
    assert.throws(() => buildNavigationIndex(root), /Invariant nearest-derived-template-no-interpolation/);
  } finally { cleanup(root); }
});

test('reviewer N/A and user-visible classifier attacks fail closed', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const base = brief(root);
    assert.throws(() => checkTaskBrief({ root, brief: { ...base, validationPlan: { ...base.validationPlan, requiredScenarios: [], intentionallyNotApplicable: { authority_and_scoped_diff: 'skip authority' } } } }), /scenario cannot be N\/A: authority_and_scoped_diff/);
    const runtimeReceipt = receipt(root, { riskProfile: 'runtime_product_domain', reason: 'ui package' });
    const ui = { ...base, ownedPaths: ['packages/ui/Panel.tsx'], allowedChanges: ['packages/ui/Panel.tsx'], riskProfile: 'runtime_product_domain', scopeHasRuntimeSemantics: true, changeClass: 'typescript_api', specReadReceipts: [runtimeReceipt], validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test'], requiredScenarios: ['normal_path'], intentionallyNotApplicable: nonLegacyNa() } };
    assert.throws(() => checkTaskBrief({ root, brief: ui }), /User-visible owned paths require userVisible risk/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...ui, riskDimensions: { ...ui.riskDimensions, userVisible: true }, validationPlan: { ...ui.validationPlan, requiredScenarios: ['normal_path'], intentionallyNotApplicable: { unified_visual_review_pending_or_completed: 'skip visual' } } } }), /scenario cannot be N\/A: unified_visual_review_pending_or_completed/);
  } finally { cleanup(root); }
});

test('numeric v3 section depth must match Markdown heading level', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const spec = readFileSync(path.join(root, 'docs/tackle-forger-development-spec-v3.md'), 'utf8');
    write(root, 'docs/tackle-forger-development-spec-v3.md', spec.replace('## 25. Export', '###### 25. Export'));
    assert.throws(() => buildNavigationIndex(root), /heading depth does not match Markdown level: 25/);
  } finally { cleanup(root); }
});

test('conditional N/A catalog requires exactly the applicable product and legacy reasons', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const workflow = brief(root);
    assert.equal(checkTaskBrief({ root, brief: workflow }).phase, 'pre_dispatch');
    assert.throws(() => checkTaskBrief({ root, brief: { ...workflow, validationPlan: { ...workflow.validationPlan, intentionallyNotApplicable: { legacy_workspace_ci: 'No legacy-workspace path is owned.' } } } }), /requires a product_runtime_tests N\/A reason/);
    const runtime = { ...workflow, ownedPaths: ['src/runtime.ts'], allowedChanges: ['src/runtime.ts'], riskProfile: 'runtime_product_domain', scopeHasRuntimeSemantics: true, changeClass: 'typescript_api', specReadReceipts: [receipt(root, { riskProfile: 'runtime_product_domain', reason: 'runtime' })], validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test'], requiredScenarios: ['normal_path'], intentionallyNotApplicable: { product_runtime_tests: 'incorrect', legacy_workspace_ci: 'No legacy-workspace path is owned.' } } };
    assert.throws(() => checkTaskBrief({ root, brief: runtime }), /cannot mark product_runtime_tests N\/A/);
  } finally { cleanup(root); }
});

test('legacy workspace requires its full CI command set and no legacy N/A', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const base = brief(root);
    const runtimeReceipt = receipt(root, { riskProfile: 'runtime_product_domain', reason: 'legacy workspace' });
    const legacy = { ...base, ownedPaths: ['legacy-workspace/packages/core/index.ts'], allowedChanges: ['legacy-workspace/packages/core/index.ts'], riskProfile: 'runtime_product_domain', scopeHasRuntimeSemantics: true, changeClass: 'typescript_api', specReadReceipts: [runtimeReceipt], validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test'], requiredScenarios: ['normal_path'], intentionallyNotApplicable: {} } };
    assert.throws(() => checkTaskBrief({ root, brief: legacy }), /legacy workspace command cannot be N\/A/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...legacy, validationPlan: { ...legacy.validationPlan, intentionallyNotApplicable: { legacy_workspace_ci: 'incorrect' } } } }), /cannot mark legacy_workspace_ci N\/A/);
    const complete = { ...legacy, validationPlan: { ...legacy.validationPlan, requiredCommands: [...legacy.validationPlan.requiredCommands, 'node --test tests/package-manager-boundaries.test.mjs', 'pnpm --dir legacy-workspace install --frozen-lockfile', "pnpm --dir legacy-workspace --filter '@tackle-forger/*' typecheck", "pnpm --dir legacy-workspace --filter '@tackle-forger/*' lint", "pnpm --dir legacy-workspace --filter '@tackle-forger/*' test", "pnpm --dir legacy-workspace --filter '@tackle-forger/*' build"] } };
    assert.equal(checkTaskBrief({ root, brief: complete }).phase, 'pre_dispatch');
    const contractSource = readFileSync(new URL('./workflow-contract.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(contractSource, /\.codex\/skills\/tackle-agent-workflow\/scripts\/package-manager-boundaries\.mjs|pnpm -r/);
  } finally { cleanup(root); }
});
