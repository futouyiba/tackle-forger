import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildNavigationIndex, buildOwnedBaselineManifest, buildPatchManifest, checkFullReadSession, checkNavigationIndex, checkOwnedWhitespace, checkPolicy, checkReadReceipt, checkTaskBrief, checkTaskCard, checkVerdict, classifyOwnedPaths, fullReadSessionHash, openRegistryHash, ownedBaselineHash, patchHash, prepareTaskBrief, prepareTaskCard, promoteTaskBrief, receiptHash, runCli, runValidation, specReadPlan, taskBriefHash, upgradeTaskCard, VALIDATION_EXECUTION_TIERS, validationExecutionPlan, writeNavigationIndex, writeTaskBriefRun, writeTaskCardRun, writeTaskRun } from './workflow-contract.mjs';

const POLICY_RELATIVE = '.codex/skills/tackle-agent-workflow/references/workflow-contract-policy.v2.json';
const POLICY_CONSUMERS = [
  'AGENTS.md',
  'CLAUDE.md',
  '.codex/skills/tackle-agent-workflow/SKILL.md',
  '.codex/skills/agent-pr-loop/SKILL.md',
  '.codex/skills/agent-issue-loop/SKILL.md',
  '.claude/skills/agent-pr-loop/SKILL.md',
];

function command(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function taskBriefRunPath(runDirectory, brief) {
  const taskDigest = createHash('sha256').update(brief.taskId).digest('hex');
  const briefDigest = createHash('sha256').update(canonicalJson(brief)).digest('hex');
  return path.join(runDirectory, `task-brief-${taskDigest}-${briefDigest}.json`);
}
function taskCardRunPath(runDirectory, card) {
  const taskDigest = createHash('sha256').update(card.semantic.taskId).digest('hex');
  const cardDigest = createHash('sha256').update(canonicalJson(card)).digest('hex');
  return path.join(runDirectory, `task-card-${taskDigest}-${cardDigest}.json`);
}
function lstatMode(target) { return lstatSync(target).mode & 0o777; }
function concurrentStore(root, brief) {
  const moduleUrl = new URL('./workflow-contract.mjs', import.meta.url).href;
  const source = `import { writeTaskBriefRun } from ${JSON.stringify(moduleUrl)};\nconst [root, brief] = process.argv.slice(1);\nprocess.stdout.write(JSON.stringify(writeTaskBriefRun({ root, brief: JSON.parse(brief) })));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source, root, JSON.stringify(brief)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => status === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`concurrent store failed (${status}): ${stderr}`)));
  });
}
function ownedWhitespaceCommand(baseSha, ownedPaths) { return `node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-owned-whitespace --base ${baseSha} ${ownedPaths.flatMap((owned) => ['--owned', owned]).join(' ')}`; }
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
  const result = {
    schema: 'tackle-spec-read/v1', taskId: 'task-1', role: 'coordinator', specSha256,
    profile: 'FULL', riskProfile: 'workflow_docs_metadata', relevantSections: ['1', '20'],
    requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'coordination', ...overrides,
  };
  if (result.profile === 'SCOPED') {
    const plan = specReadPlan({ root, role: result.role, riskProfile: result.riskProfile, relevantSections: result.relevantSections, applicableIds: [] });
    result.requiredSections = plan.requiredSections;
    result.readSections = plan.requiredSections;
  }
  return result;
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
  const requiredSections = specReadPlan({ root, role: 'coordinator', riskProfile: 'workflow_docs_metadata', relevantSections: ['1', '20'], applicableIds: [] }).requiredSections;
  return {
    schema: 'tackle-spec-read/v2', taskId: 'task-2', role: 'coordinator', specSha256: specHash(root), profile: 'REUSE_FULL', riskProfile: 'workflow_docs_metadata', relevantSections: ['1', '20'],
    requiredSections, readSections: requiredSections, reason: 'same agent, explicit continuous context',
    reuseEvidence: { session, sessionSha256: fullReadSessionHash(session), agentIdentity: session.agentIdentity, contextSessionId: session.contextSessionId }, ...overrides,
  };
}
function reusedReceiptForRole(root, role, overrides = {}) {
  const fullReadReceipt = receipt(root, { taskId: 'task-2', role });
  const session = { ...fullReadSession(root), fullReadReceipt };
  const requiredSections = specReadPlan({ root, role, riskProfile: 'workflow_docs_metadata', relevantSections: ['1', '20'], applicableIds: [] }).requiredSections;
  return {
    schema: 'tackle-spec-read/v2', taskId: 'task-2', role, specSha256: specHash(root), profile: 'REUSE_FULL', riskProfile: 'workflow_docs_metadata', relevantSections: ['1', '20'],
    requiredSections, readSections: requiredSections, reason: 'same agent, explicit continuous context',
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
    baseSha, reviewedHead: 'WORKTREE', scope: 'workflow hardening', relevantSections: ['1', '20'], openDecisionCheck: { registrySha256: openRegistryHash(root), checkedIds: openIds, applicableIds: [], noApplicableReason: 'No OPEN decision applies to this workflow-only fixture.' }, riskProfile: 'workflow_docs_metadata', reviewTier: 'strict', scopeHasRuntimeSemantics: false, changeClass: 'workflow_metadata', allowedChanges: ['AGENTS.md'], acceptanceCriteria: ['contract validates'], exclusions: ['product runtime'], riskDimensions: { persistedData: false, historicalSnapshots: false, concurrency: false, authorization: false, externalSideEffects: false, userVisible: false }, validationPlan: { requiredCommands: ['node scripts/spec-v3-modules.mjs --check', 'node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-policy', 'node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-index', 'node --test .codex/skills/tackle-agent-workflow/scripts/workflow-contract.test.mjs', ownedWhitespaceCommand(baseSha, ['AGENTS.md'])], requiredScenarios: ['authority_and_scoped_diff'], intentionallyNotApplicable: { product_runtime_tests: 'No product code changes.' } },
    specReadReceipts: [coordinatorReceipt], ownedPaths: ['AGENTS.md'], preexistingOwnedPaths: [],
    preexistingUnownedChanges: [], dirtyWorktreeDisposition: 'clean', ...overrides,
  };
}
function taskBase(root) {
  const sourceRoot = path.resolve(process.cwd());
  write(root, 'docs/tackle-forger-development-spec-v3.md', '# V3\n\n## 0. Authority\n\n### 0.1 Immutable\n\n## 1. Scope\n\n### 3.1 Method and type\n\n### 5.2 Derived template\n\n## 8. Patch\n\n## 13. Snapshot\n\n## 14. Version\n\n### 18.2 Snapshot\n\n### 18.3 Patch\n\n## 19. Delivery\n\n## 20. Open\n\n### 24.11 Snapshot\n\n## 25. Export\n\n| ID | Type | Status |\n| --- | --- | --- |\n| OPEN-001 Test | x | `OPEN` |\n');
  write(root, 'docs/README.md', '# Documentation\n');
  write(root, 'scripts/spec-v3-modules.mjs', "process.stdout.write('legacy fixture has no split modules\\n');\n");
  for (const relative of [POLICY_RELATIVE, ...POLICY_CONSUMERS]) write(root, relative, readFileSync(path.join(sourceRoot, relative), 'utf8'));
  commitBase(root);
}

function prepareInput(root, overrides = {}) {
  return {
    schema: 'tackle-task-prepare-input/v1', taskId: 'prepared-task', workflowMode: 'local', baseSha: command(root, ['rev-parse', 'HEAD']),
    scope: 'explicit workflow preparation scope', relevantSections: ['0', '19', '20'],
    openDecisionApplicability: { applicableIds: [], noApplicableReason: 'No product OPEN decision is implemented.' },
    riskProfile: 'workflow_docs_metadata', reviewTier: 'standard', scopeHasRuntimeSemantics: false, changeClass: 'workflow_metadata', ownedPaths: ['AGENTS.md'],
    acceptanceCriteria: ['The generated TaskBrief validates.'], exclusions: ['No product runtime behavior changes.'],
    riskDimensions: { persistedData: false, historicalSnapshots: false, concurrency: false, authorization: false, externalSideEffects: false, userVisible: false },
    coordinatorSpecReadReceipt: receipt(root, { taskId: 'prepared-task', relevantSections: ['0', '19', '20'], reason: 'Coordinator completed the required canonical reading before preparation.' }), ...overrides,
  };
}

test('daily Task Card has exactly six semantic fields and only mechanical evidence', () => {
  const root = temporaryRepo();
  const handoff = mkdtempSync(path.join(os.tmpdir(), 'workflow-task-card-'));
  try {
    taskBase(root);
    const input = { schema: 'tackle-task-card/v1', taskId: 'card-1', workflowMode: 'local', scope: 'Tighten workflow wording.', ownedPaths: ['AGENTS.md'], riskProfile: 'workflow_docs_metadata', changeClass: 'workflow_metadata' };
    const card = prepareTaskCard({ root, input });
    assert.deepEqual(Object.keys(card.semantic).sort(), ['changeClass', 'ownedPaths', 'riskProfile', 'scope', 'taskId', 'workflowMode']);
    assert.equal(card.derived.readingAssertion, 'none_generated');
    assert.equal(card.derived.formalTaskBriefRequiredAtBoundary, true);
    assert.equal(card.derived.earlyEscalationRequired, false);
    assert.deepEqual(card.derived.openDecisionCheck.checkedIds, ['OPEN-001']);
    assert.deepEqual(card.derived.receiptDraft.readSections, []);
    assert.equal(card.derived.receiptDraft.reason, 'Pending human completion after actual routed reading.');
    assert.equal(checkTaskCard({ root, card }).semantic.taskId, 'card-1');
    const cardPath = path.join(handoff, 'card.json'); writeFileSync(cardPath, `${JSON.stringify(card)}\n`);
    assert.equal(JSON.parse(runCli(['--check-task-card', '--card', cardPath], root)).schema, 'tackle-task-card/v1');
    assert.throws(() => prepareTaskCard({ root, input: { ...input, extra: true } }), /unknown, missing, or inapplicable keys/);
    assert.throws(() => checkTaskCard({ root, card: { ...card, derived: { ...card.derived, baseSha: '0'.repeat(40) } } }), /stale or was not mechanically generated/);
  } finally { cleanup(root); cleanup(handoff); }
});

test('Task Card fail-closes by requiring formal boundary escalation for runtime and external work', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    write(root, 'src/runtime.ts', 'export {};\n'); command(root, ['add', 'src/runtime.ts']); command(root, ['commit', '-qm', 'runtime fixture']);
    const card = prepareTaskCard({ root, input: { schema: 'tackle-task-card/v1', taskId: 'card-2', workflowMode: 'local', scope: 'Runtime change.', ownedPaths: ['src/runtime.ts'], riskProfile: 'runtime_product_domain', changeClass: 'typescript_api' } });
    assert.equal(card.derived.formalTaskBriefRequiredAtBoundary, true);
    assert.equal(card.derived.earlyEscalationRequired, true);
    assert.equal(card.derived.escalationMarkers.includes('owned_paths_outside_scoped_governance'), true);
    assert.equal(card.derived.escalationMarkers.includes('non_workflow_or_runtime_semantics'), true);
    assert.equal(card.derived.routeSelection.status, 'formal_boundary_required');
    assert.equal(card.derived.readPlanTemplate, null);
    assert.throws(() => prepareTaskCard({ root, input: { ...card.semantic, schema: 'tackle-task-card/v1', riskProfile: 'unknown_high_risk' } }), /unknown or unsupported riskProfile/);
  } finally { cleanup(root); }
});

test('Task Card storage has a distinct private type, filename, and stderr report', () => {
  const root = temporaryRepo();
  const handoff = mkdtempSync(path.join(os.tmpdir(), 'workflow-card-store-'));
  const originalWrite = process.stderr.write;
  const stderr = [];
  try {
    taskBase(root);
    const input = { schema: 'tackle-task-card/v1', taskId: 'card-store', workflowMode: 'local', scope: 'Persist daily routing.', ownedPaths: ['AGENTS.md'], riskProfile: 'workflow_docs_metadata', changeClass: 'workflow_metadata' };
    const inputPath = path.join(handoff, 'card-input.json'); writeFileSync(inputPath, `${JSON.stringify(input)}\n`);
    process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
    const stdout = runCli(['--prepare-task-card', '--input', inputPath, '--store-run'], root);
    const card = JSON.parse(stdout);
    const storagePath = taskCardRunPath(command(root, ['rev-parse', '--path-format=absolute', '--git-path', 'codex-runs']), card);
    assert.equal(existsSync(storagePath), true);
    assert.equal(path.basename(storagePath).startsWith('task-card-'), true);
    assert.match(stderr.join(''), new RegExp(`^TaskCard-Run-Path: ${storagePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`));
    assert.deepEqual(JSON.parse(stdout), card);
    assert.equal(writeTaskCardRun({ root, card }).reused, true);
    assert.throws(() => writeTaskRun({ root, kind: 'task-brief', record: card }), /tackle-task-brief/);
    assert.throws(() => writeTaskCardRun({ root, card: { ...card, extra: true } }), /unknown, missing, or inapplicable keys/);
  } finally { process.stderr.write = originalWrite; cleanup(root); cleanup(handoff); }
});

test('exported Task Card preparation rejects dirty work even with a caller dirty override', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const input = { schema: 'tackle-task-card/v1', taskId: 'card-dirty', workflowMode: 'local', scope: 'Runtime routing probe.', ownedPaths: ['AGENTS.md'], riskProfile: 'workflow_docs_metadata', changeClass: 'workflow_metadata' };
    const card = prepareTaskCard({ root, input });
    write(root, 'dirty.txt', 'dirty\n');
    assert.throws(() => prepareTaskCard({ root, input, allowOwnedDirty: true }), /clean worktree/);
    assert.equal(checkTaskCard({ root, card }).semantic.taskId, 'card-dirty');
  } finally { cleanup(root); }
});

test('Task Card upgrades dirty owned work into a formal TaskBrief and fails closed otherwise', () => {
  const root = temporaryRepo();
  const handoff = mkdtempSync(path.join(os.tmpdir(), 'workflow-card-upgrade-store-'));
  const originalWrite = process.stderr.write;
  const stderr = [];
  try {
    taskBase(root);
    const card = prepareTaskCard({ root, input: { schema: 'tackle-task-card/v1', taskId: 'card-upgrade', workflowMode: 'local', scope: 'Workflow change.', ownedPaths: ['AGENTS.md'], riskProfile: 'workflow_docs_metadata', changeClass: 'workflow_metadata' } });
    write(root, 'AGENTS.md', 'changed\n');
    const baseInput = prepareInput(root, { taskId: 'card-upgrade', scope: card.semantic.scope, ownedPaths: card.semantic.ownedPaths, coordinatorSpecReadReceipt: receipt(root, { taskId: 'card-upgrade', relevantSections: ['0', '19', '20'], reason: 'Coordinator completed routed reading.' }) });
    const boundaryInput = (({ reviewTier, relevantSections, openDecisionApplicability, scopeHasRuntimeSemantics, acceptanceCriteria, exclusions, riskDimensions, coordinatorSpecReadReceipt }) => ({ schema: 'tackle-task-card-upgrade-input/v1', reviewTier, relevantSections, openDecisionApplicability, scopeHasRuntimeSemantics, acceptanceCriteria, exclusions, riskDimensions, coordinatorSpecReadReceipt }))(baseInput);
    const brief = upgradeTaskCard({ root, card, boundaryInput });
    assert.equal(checkTaskBrief({ root, brief }).phase, 'pre_dispatch');
    assert.deepEqual(brief.preexistingOwnedPaths, []);
    const cardPath = path.join(handoff, 'card.json');
    const boundaryPath = path.join(handoff, 'boundary.json');
    writeFileSync(cardPath, `${JSON.stringify(card)}\n`); writeFileSync(boundaryPath, `${JSON.stringify(boundaryInput)}\n`);
    process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
    const stdout = runCli(['--upgrade-task-card', '--card', cardPath, '--boundary-input', boundaryPath, '--store-run'], root);
    const storedBrief = JSON.parse(stdout);
    const storagePath = taskBriefRunPath(command(root, ['rev-parse', '--path-format=absolute', '--git-path', 'codex-runs']), storedBrief);
    assert.deepEqual(storedBrief, brief);
    assert.equal(existsSync(storagePath), true);
    assert.equal(path.basename(storagePath).startsWith('task-brief-'), true);
    assert.equal(path.basename(storagePath).startsWith('task-card-'), false);
    assert.match(stderr.join(''), new RegExp(`^TaskBrief-Run-Path: ${storagePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`));
    assert.equal(writeTaskBriefRun({ root, brief: storedBrief }).reused, true);
    assert.throws(() => prepareTaskBrief({ root, input: baseInput, allowOwnedDirty: true }), /clean worktree/);
    write(root, 'unowned.txt', 'no\n');
    assert.throws(() => upgradeTaskCard({ root, card, boundaryInput }), /unowned dirty paths/);
    unlinkSync(path.join(root, 'unowned.txt'));
    write(root, 'later.txt', 'commit\n'); command(root, ['add', 'later.txt']); command(root, ['commit', '-qm', 'advance head']);
    assert.throws(() => upgradeTaskCard({ root, card, boundaryInput }), /stale card base\/head/);
  } finally { process.stderr.write = originalWrite; cleanup(root); cleanup(handoff); }
});

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
    assert.equal(prepared.validationPlan.requiredCommands.includes(ownedWhitespaceCommand(input.baseSha, ['AGENTS.md'])), true);
    assert.equal(prepared.validationPlan.intentionallyNotApplicable.product_runtime_tests.length > 0, true);
    assert.equal(prepared.specReadReceipts[0].profile, 'FULL');
    const inputPath = path.join(handoff, 'prepare-input.json');
    writeFileSync(inputPath, `${JSON.stringify(input)}\n`);
    assert.equal(JSON.parse(runCli(['--prepare-task-brief', '--input', inputPath], root)).taskId, input.taskId);
  } finally { cleanup(root); cleanup(handoff); }
});

test('TaskBrief preparation optionally stores a canonical Git-private run without changing stdout', () => {
  const root = temporaryRepo();
  const handoff = mkdtempSync(path.join(os.tmpdir(), 'workflow-prepare-store-'));
  const originalWrite = process.stderr.write;
  const stderr = [];
  try {
    taskBase(root);
    const input = prepareInput(root);
    const inputPath = path.join(handoff, 'prepare-input.json');
    writeFileSync(inputPath, `${JSON.stringify(input)}\n`);
    process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
    const stdout = runCli(['--prepare-task-brief', '--input', inputPath, '--store-run'], root);
    const prepared = JSON.parse(stdout);
    const runDirectory = command(root, ['rev-parse', '--path-format=absolute', '--git-path', 'codex-runs']);
    const storagePath = taskBriefRunPath(runDirectory, prepared);
    assert.equal(existsSync(storagePath), true);
    assert.equal(readFileSync(storagePath, 'utf8'), `${canonicalJson(prepared)}\n`, 'stored content must use canonical JSON');
    assert.match(stderr.join(''), new RegExp(`^TaskBrief-Run-Path: ${storagePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`));
    assert.deepEqual(JSON.parse(stdout), prepared);
    assert.equal(writeTaskBriefRun({ root, brief: prepared }).reused, true);
    const evolvedInput = prepareInput(root, { scope: 'evolved scope with the same task id' });
    const evolved = prepareTaskBrief({ root, input: evolvedInput });
    const evolvedRun = writeTaskBriefRun({ root, brief: evolved });
    assert.notEqual(evolvedRun.storagePath, storagePath, 'same task ID must preserve a distinct evolved TaskBrief');
    assert.equal(existsSync(evolvedRun.storagePath), true);
  } finally { process.stderr.write = originalWrite; cleanup(root); cleanup(handoff); }
});

test('TaskBrief run storage is traversal-safe, per linked worktree, and fails closed on write errors', () => {
  const root = temporaryRepo();
  const linked = mkdtempSync(path.join(os.tmpdir(), 'workflow-linked-worktree-'));
  try {
    cleanup(linked);
    taskBase(root);
    const maliciousTaskId = '../outside/../../task';
    const maliciousInput = prepareInput(root, { taskId: maliciousTaskId, coordinatorSpecReadReceipt: receipt(root, { taskId: maliciousTaskId, relevantSections: ['0', '19', '20'] }) });
    const maliciousBrief = prepareTaskBrief({ root, input: maliciousInput });
    const maliciousRun = writeTaskBriefRun({ root, brief: maliciousBrief });
    assert.equal(maliciousRun.storagePath.includes('..'), false);
    assert.equal(path.dirname(maliciousRun.storagePath), command(root, ['rev-parse', '--path-format=absolute', '--git-path', 'codex-runs']));
    command(root, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const linkedInput = prepareInput(linked, { taskId: 'linked-task', coordinatorSpecReadReceipt: receipt(linked, { taskId: 'linked-task', relevantSections: ['0', '19', '20'] }) });
    const linkedRun = writeTaskBriefRun({ root: linked, brief: prepareTaskBrief({ root: linked, input: linkedInput }) });
    const rootRunDirectory = command(root, ['rev-parse', '--path-format=absolute', '--git-path', 'codex-runs']);
    const linkedRunDirectory = command(linked, ['rev-parse', '--path-format=absolute', '--git-path', 'codex-runs']);
    assert.notEqual(linkedRunDirectory, rootRunDirectory);
    assert.equal(path.dirname(linkedRun.storagePath), linkedRunDirectory);
    const failingRoot = temporaryRepo();
    try {
      taskBase(failingRoot);
      const failingDirectory = command(failingRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'codex-runs']);
      writeFileSync(failingDirectory, 'not a directory\n');
      assert.throws(() => writeTaskBriefRun({ root: failingRoot, brief: prepareTaskBrief({ root: failingRoot, input: prepareInput(failingRoot) }) }), /Cannot write Git-private TaskBrief run storage/);
    } finally { cleanup(failingRoot); }
  } finally {
    if (existsSync(linked)) command(root, ['worktree', 'remove', '--force', linked]);
    cleanup(root);
  }
});

test('TaskBrief run storage publishes complete records atomically and rejects unsafe or stale artifacts', async () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const prepared = prepareTaskBrief({ root, input: prepareInput(root) });
    const runDirectory = command(root, ['rev-parse', '--path-format=absolute', '--git-path', 'codex-runs']);
    mkdirSync(runDirectory, { recursive: true });
    const storagePath = taskBriefRunPath(runDirectory, prepared);
    const prefix = path.basename(storagePath, '.json');
    const staleTemporary = path.join(runDirectory, `.${prefix}.tmp-abandoned`);
    writeFileSync(staleTemporary, '{partial');
    utimesSync(staleTemporary, 1, 1);
    const first = writeTaskBriefRun({ root, brief: prepared });
    assert.equal(first.reused, false);
    assert.equal(existsSync(staleTemporary), false, 'old partial temporary artifacts are cleaned before publication');
    assert.equal(readdirSync(runDirectory).some((name) => name.startsWith(`.${prefix}.tmp-`)), false, 'publisher cleans its own temporary file');
    assert.equal(readFileSync(storagePath, 'utf8'), `${canonicalJson(prepared)}\n`);
    assert.equal(writeTaskBriefRun({ root, brief: prepared }).reused, true, 'a second publisher observes only the complete final record');
    unlinkSync(storagePath);
    const concurrent = await Promise.all([concurrentStore(root, prepared), concurrentStore(root, prepared)]);
    assert.equal(concurrent.filter((result) => result.reused === false).length, 1);
    assert.equal(concurrent.filter((result) => result.reused === true).length, 1);
    assert.equal(readFileSync(storagePath, 'utf8'), `${canonicalJson(prepared)}\n`);
    if (process.platform !== 'win32') {
      assert.equal(lstatMode(runDirectory), 0o700);
      assert.equal(lstatMode(storagePath), 0o600);
      chmodSync(storagePath, 0o644);
      assert.throws(() => writeTaskBriefRun({ root, brief: prepared }), /mode 600/);
      chmodSync(storagePath, 0o600);
    }
    unlinkSync(storagePath);
    try {
      symlinkSync('../outside', storagePath);
      assert.throws(() => writeTaskBriefRun({ root, brief: prepared }), /unsafe/);
    } catch (error) { if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error; }
    const unsafeRoot = temporaryRepo();
    const unsafeTarget = mkdtempSync(path.join(os.tmpdir(), 'workflow-run-storage-target-'));
    try {
      taskBase(unsafeRoot);
      const unsafeDirectory = command(unsafeRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'codex-runs']);
      symlinkSync(unsafeTarget, unsafeDirectory);
      assert.equal(lstatSync(unsafeDirectory).isSymbolicLink(), true);
      assert.throws(() => writeTaskBriefRun({ root: unsafeRoot, brief: prepareTaskBrief({ root: unsafeRoot, input: prepareInput(unsafeRoot) }) }), /run storage path escaped|directory is unsafe/);
    } finally { cleanup(unsafeRoot); cleanup(unsafeTarget); }
  } finally { cleanup(root); }
});

test('TaskBrief preparation accepts v2 reuse receipts only with trusted continuous context', () => {
  const root = temporaryRepo();
  const handoff = mkdtempSync(path.join(os.tmpdir(), 'workflow-prepare-reuse-'));
  try {
    taskBase(root);
    const v2 = reusedReceipt(root, {
      taskId: 'prepared-task', relevantSections: ['0', '19', '20'],
      requiredSections: ['README', 'V3_INDEX', '0', '19', 'OPEN_REGISTRY'], readSections: ['README', 'V3_INDEX', '0', '19', 'OPEN_REGISTRY'],
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
      riskProfile: 'durable_migration', reviewTier: 'strict', changeClass: 'persistence_migration', scopeHasRuntimeSemantics: true, riskDimensions: dimensions,
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
    assert.throws(() => runCli([], root), /Review tier safety floor: unknown_high_risk.*requires strict/s);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, ownedPaths: ['../AGENTS.md'] } }), /Invalid owned path/);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, relevantSections: ['0', '20', '999'] } }), /current v3 sections/);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, changeClass: 'not_a_class' } }), /unsupported/);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, reviewTier: 'urgent' } }), /fast, standard, or strict/);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, baseSha: '0'.repeat(40) } }), /resolve|baseSha/);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, coordinatorSpecReadReceipt: { ...input.coordinatorSpecReadReceipt, taskId: 'other-task' } } }), /coordinatorSpecReadReceipt/);
    assert.throws(() => prepareTaskBrief({ root, input: { ...input, riskProfile: 'durable_migration', changeClass: 'persistence_migration', scopeHasRuntimeSemantics: true, coordinatorSpecReadReceipt: receipt(root, { taskId: 'prepared-task', riskProfile: 'durable_migration', relevantSections: ['0', '19', '20'] }) } }), /risk dimension/);
    const unknownRiskInput = { ...input, riskProfile: 'unknown_high_risk', changeClass: 'domain_behavior', scopeHasRuntimeSemantics: true, coordinatorSpecReadReceipt: receipt(root, { taskId: 'prepared-task', riskProfile: 'unknown_high_risk', relevantSections: ['0', '19', '20'] }) };
    assert.throws(() => prepareTaskBrief({ root, input: { ...unknownRiskInput, reviewTier: 'standard' } }), /reviewTier must be strict when riskProfile unknown_high_risk/);
    assert.throws(() => prepareTaskBrief({ root, input: { ...unknownRiskInput, reviewTier: 'strict' } }), /refuses unknown_high_risk/);
    mkdirSync(path.join(root, 'directory-path'));
    write(root, 'directory-path/child.txt', 'tracked\n');
    command(root, ['add', 'directory-path']); command(root, ['commit', '-qm', 'track directory fixture']);
    const currentInput = { ...input, baseSha: command(root, ['rev-parse', 'HEAD']) };
    assert.throws(() => prepareTaskBrief({ root, input: { ...currentInput, ownedPaths: ['directory-path'] } }), /Unsupported (base-tree|current) entry/);
    try {
      symlinkSync('AGENTS.md', path.join(root, 'linked-path'));
      command(root, ['add', 'linked-path']); command(root, ['commit', '-qm', 'track symlink fixture']);
      assert.throws(() => prepareTaskBrief({ root, input: { ...currentInput, baseSha: command(root, ['rev-parse', 'HEAD']), ownedPaths: ['linked-path'] } }), /Symlink/);
    } catch (error) { if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error; }
    write(root, 'dirty.txt', 'dirty\n');
    assert.throws(() => prepareTaskBrief({ root, input }), /clean worktree/);
  } finally { cleanup(root); }
});

test('owned whitespace checker catches a new untracked owned file', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const baseSha = command(root, ['rev-parse', 'HEAD']);
    write(root, 'new-owned.md', 'trailing space \n');
    assert.throws(() => checkOwnedWhitespace({ root, baseSha, ownedPaths: ['new-owned.md'] }), /Owned whitespace check failed.*trailing whitespace/);
    write(root, 'new-owned.md', 'clean\n');
    assert.deepEqual(checkOwnedWhitespace({ root, baseSha, ownedPaths: ['new-owned.md'] }).checkedPaths, ['new-owned.md']);
    assert.deepEqual(JSON.parse(runCli(['--check-owned-whitespace', '--base', baseSha, '--owned', 'new-owned.md'], root)).checkedPaths, ['new-owned.md']);
  } finally { cleanup(root); }
});

test('local TaskBrief preparation rejects a base before current HEAD', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const input = prepareInput(root);
    write(root, 'already-committed.txt', 'later\n'); command(root, ['add', 'already-committed.txt']); command(root, ['commit', '-qm', 'later commit']);
    assert.throws(() => prepareTaskBrief({ root, input }), /baseSha to equal current HEAD/);
  } finally { cleanup(root); }
});
function validationFixture() {
  const root = temporaryRepo();
  const sourceRoot = path.resolve(process.cwd());
  try {
    taskBase(root);
    const contract = readFileSync(path.join(sourceRoot, '.codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs'), 'utf8');
    write(root, '.codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs', `${contract}\nif (process.argv.includes('--check-policy')) writeFileSync(${JSON.stringify(path.join(root, 'validation-ran.marker'))}, 'ran\\n');\n`);
    write(root, '.codex/skills/tackle-agent-workflow/scripts/workflow-contract.test.mjs', `import { writeFileSync } from 'node:fs';\nimport test from 'node:test';\nwriteFileSync(${JSON.stringify(path.join(root, 'validation-ran.marker'))}, 'ran\\n');\ntest('validation command ran', () => {});\n`);
    writeNavigationIndex(root);
    command(root, ['add', '.']);
    command(root, ['commit', '-qm', 'validation fixture']);
    return root;
  } catch (error) { cleanup(root); throw error; }
}

test('role-keyed reuse contexts flow through validation and verdict APIs and CLIs', () => {
  const root = validationFixture();
  const handoff = mkdtempSync(path.join(os.tmpdir(), 'workflow-role-contexts-'));
  try {
    const ownedPath = '.codex/skills/tackle-agent-workflow/references/v3-navigation.json';
    const baseSha = command(root, ['rev-parse', 'HEAD']);
    const reuseFor = (role, agentIdentity, contextSessionId) => {
      const receiptValue = reusedReceiptForRole(root, role);
      const session = { ...receiptValue.reuseEvidence.session, agentIdentity, contextSessionId };
      return { ...receiptValue, reuseEvidence: { ...receiptValue.reuseEvidence, session, sessionSha256: fullReadSessionHash(session), agentIdentity, contextSessionId } };
    };
    const coordinator = reuseFor('coordinator', 'agent:coordinator', 'context:coordinator');
    const coding = reuseFor('coding', 'agent:coding', 'context:coding');
    const review = reuseFor('review', 'agent:review', 'context:review');
    const contexts = { coordinator: currentReuseContext(coordinator.reuseEvidence.session), coding: currentReuseContext(coding.reuseEvidence.session), review: currentReuseContext(review.reuseEvidence.session) };
    const source = brief(root, { taskId: 'task-2', ownedPaths: [ownedPath], allowedChanges: [ownedPath], validationPlan: { ...brief(root).validationPlan, requiredCommands: ['node scripts/spec-v3-modules.mjs --check', 'node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-policy', 'node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-index', 'node --test .codex/skills/tackle-agent-workflow/scripts/workflow-contract.test.mjs', ownedWhitespaceCommand(baseSha, [ownedPath])] }, specReadReceipts: [coordinator] });
    const promoted = promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review, reuseContexts: contexts });
    const checked = checkTaskBrief({ root, brief: promoted, reuseContexts: contexts });
    assert.equal(validationExecutionPlan({ root, brief: promoted, reuseContexts: contexts }).artifact.artifactIdentity.kind, 'worktree');
    const apiSummary = runValidation({ root, brief: promoted, reuseContexts: contexts });
    assert.equal(apiSummary.results.every((result) => result.result === 'PASS'), true, JSON.stringify(apiSummary.results));
    unlinkSync(path.join(root, 'validation-ran.marker'));
    const verdict = { schema: 'tackle-local-verdict/v1', taskId: promoted.taskId, taskBriefSha256: checked.taskBriefSha256, specReceiptHashes: checked.specReceiptHashes, dirtyWorktreeDisposition: promoted.dirtyWorktreeDisposition, specSha256: promoted.specSha256, baseSha: promoted.baseSha, reviewedHead: 'WORKTREE', ownedPaths: promoted.ownedPaths, artifactIdentity: { kind: 'worktree', commitSha: null, patchHash: patchHash({ root, baseSha: promoted.baseSha, ownedPaths: promoted.ownedPaths }).patchHash }, verdict: 'PASS', findings: [] };
    assert.equal(checkVerdict({ root, verdict, brief: promoted, reuseContexts: contexts }).taskBriefSha256, checked.taskBriefSha256);
    for (const [name, value] of Object.entries({ 'brief.json': promoted, 'verdict.json': verdict, 'contexts.json': contexts })) writeFileSync(path.join(handoff, name), JSON.stringify(value));
    assert.equal(JSON.parse(runCli(['--run-validation', '--brief', path.join(handoff, 'brief.json'), '--reuse-contexts', path.join(handoff, 'contexts.json')], root)).results.every((result) => result.result === 'PASS'), true);
    assert.equal(JSON.parse(runCli(['--check-verdict', '--brief', path.join(handoff, 'brief.json'), '--verdict', path.join(handoff, 'verdict.json'), '--reuse-contexts', path.join(handoff, 'contexts.json')], root)).taskBriefSha256, checked.taskBriefSha256);
    assert.throws(() => runCli(['--run-validation', '--brief', path.join(handoff, 'brief.json')], root), /currentReuseContext/);
    for (const bad of [{ coordinator: contexts.coordinator, coding: contexts.coding }, { ...contexts, extra: contexts.review }, { ...contexts, review: { ...contexts.review, currentAgentIdentity: 'agent:wrong' } }, { ...contexts, coding: { ...contexts.coding, currentContextSessionId: 'context:wrong' } }, { ...contexts, coordinator: { ...contexts.coordinator, currentContextState: 'compacted' } }]) {
      writeFileSync(path.join(handoff, 'bad-contexts.json'), JSON.stringify(bad));
      assert.throws(() => runCli(['--check-verdict', '--brief', path.join(handoff, 'brief.json'), '--verdict', path.join(handoff, 'verdict.json'), '--reuse-contexts', path.join(handoff, 'bad-contexts.json')], root), /currentReuseContext|unknown receipt role|does not match|must be continuous/);
    }
  } finally { cleanup(root); cleanup(handoff); }
});

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

test('policy checker validates the closed authority and versioned consumer references', () => {
  const root = temporaryRepo();
  try {
    const sourceRoot = path.resolve(process.cwd());
    const consumers = ['AGENTS.md', 'CLAUDE.md', '.codex/skills/tackle-agent-workflow/SKILL.md', '.codex/skills/agent-pr-loop/SKILL.md', '.codex/skills/agent-issue-loop/SKILL.md', '.claude/skills/agent-pr-loop/SKILL.md'];
    const policyPath = '.codex/skills/tackle-agent-workflow/references/workflow-contract-policy.v2.json';
    const canonicalPolicy = readFileSync(path.join(sourceRoot, policyPath), 'utf8');
    for (const relative of consumers) write(root, relative, readFileSync(path.join(sourceRoot, relative), 'utf8'));
    write(root, policyPath, canonicalPolicy);
    assert.equal(checkPolicy(root), true);

    const policy = JSON.parse(canonicalPolicy);
    write(root, policyPath, JSON.stringify({ ...policy, extra: true }));
    assert.throws(() => checkPolicy(root), /unknown, missing, or inapplicable keys/);
    write(root, policyPath, JSON.stringify({ ...policy, schemaVersion: 'workflow-contract-policy/v3' }));
    assert.throws(() => checkPolicy(root), /schemaVersion/);
    write(root, policyPath, JSON.stringify({ ...policy, reviewTier: { ...policy.reviewTier, strictWhenRiskProfile: [] } }));
    assert.throws(() => checkPolicy(root), /unknown_high_risk strict-review floor/);
    write(root, policyPath, JSON.stringify({ ...policy, reviewTier: { ...policy.reviewTier, strictWhenRiskDimensions: policy.reviewTier.strictWhenRiskDimensions.filter((value) => value !== 'authorization') } }));
    assert.throws(() => checkPolicy(root), /durable strict-review dimensions/);
    const parityMutations = [
      { label: 'taskCard.dailySemanticFields', value: { ...policy, taskCard: { ...policy.taskCard, dailySemanticFields: policy.taskCard.dailySemanticFields.filter((field) => field !== 'scope') } } },
      { label: 'scopedEligibility.allowedPathClasses', value: { ...policy, scopedEligibility: { ...policy.scopedEligibility, allowedPathClasses: policy.scopedEligibility.allowedPathClasses.filter((pathClass) => pathClass !== 'AGENTS.md') } } },
      { label: 'validationMatrix.mandatoryWorkflowCommands', value: { ...policy, validationMatrix: { ...policy.validationMatrix, mandatoryWorkflowCommands: policy.validationMatrix.mandatoryWorkflowCommands.slice(1) } } },
      { label: 'validationMatrix.executionTiers', value: { ...policy, validationMatrix: { ...policy.validationMatrix, executionTiers: { ...policy.validationMatrix.executionTiers, focused_script_or_rule: { ...policy.validationMatrix.executionTiers.focused_script_or_rule, iterationFullCi: 'allowed' } } } } },
      { label: 'taskBrief.conditionalNaApplicability', value: { ...policy, taskBrief: { ...policy.taskBrief, conditionalNaApplicability: { ...policy.taskBrief.conditionalNaApplicability, workflowMetadataRequires: 'different_n_a' } } } },
      { label: 'localVerdict.schema', value: { ...policy, localVerdict: { ...policy.localVerdict, schema: 'tackle-local-verdict/v2' } } },
    ];
    for (const mutation of parityMutations) {
      write(root, policyPath, JSON.stringify(mutation.value));
      assert.throws(() => checkPolicy(root), new RegExp(mutation.label.replaceAll('.', '\\.')));
    }
    write(root, policyPath, canonicalPolicy);

    const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    write(root, 'AGENTS.md', agents.replace('workflow-contract-policy-ref/v2', 'workflow-contract-policy-ref/v3'));
    assert.throws(() => checkPolicy(root), /unsupported workflow policy/);
    write(root, 'AGENTS.md', agents.replace(/<!-- workflow-contract-policy-ref\/v2:[^\n]+ -->\n/, ''));
    assert.throws(() => checkPolicy(root), /exactly one versioned policy reference/);
    write(root, 'AGENTS.md', `${agents}<!-- workflow-contract-policy-ref/v2: ${policyPath} -->\n`);
    assert.throws(() => checkPolicy(root), /exactly one versioned policy reference/);
    write(root, 'AGENTS.md', `${agents}\nDisplay prose may change without changing the machine policy.\n`);
    assert.equal(checkPolicy(root), true);
  } finally { cleanup(root); }
});

test('review-tier execution consumes the authority and display prose cannot lower the safety floor', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const policyPath = '.codex/skills/tackle-agent-workflow/references/workflow-contract-policy.v2.json';
    const policy = JSON.parse(readFileSync(path.join(root, policyPath), 'utf8'));
    policy.taskBrief.phaseReceiptsByReviewTier.verdict.fast.all = ['coordinator', 'coding', 'review'];
    write(root, policyPath, JSON.stringify(policy));
    command(root, ['add', policyPath]);
    command(root, ['commit', '-qm', 'policy fixture']);
    const coordinator = receipt(root);
    const coding = receipt(root, { role: 'coding' });
    const fastVerdict = brief(root, { phase: 'verdict', reviewTier: 'fast', specReadReceipts: [coordinator, coding] });
    assert.throws(() => checkTaskBrief({ root, brief: fastVerdict }), /coordinator, coding, review/);

    appendFileSync(path.join(root, 'AGENTS.md'), 'Display-only claim: unknown high risk may use fast review.\n');
    const unsafe = brief(root, {
      reviewTier: 'fast',
      riskProfile: 'unknown_high_risk',
      riskDimensions: { persistedData: false, historicalSnapshots: false, concurrency: false, authorization: false, externalSideEffects: false, userVisible: false },
    });
    assert.throws(() => checkTaskBrief({ root, brief: unsafe }), /reviewTier must be strict/);
  } finally { cleanup(root); }
});

test('validation execution tiers keep routine work targeted and full CI at stable boundaries', () => {
  assert.deepEqual(Object.keys(VALIDATION_EXECUTION_TIERS), [
    'inspection_only',
    'documentation_or_nonbehavior_workflow',
    'focused_script_or_rule',
    'deployment_configuration',
    'business_code',
    'durable_or_external',
    'stable_pr_candidate',
    'rebase_refresh',
  ]);
  assert.equal(VALIDATION_EXECUTION_TIERS.inspection_only.iterationFullCi, 'forbidden');
  assert.equal(VALIDATION_EXECUTION_TIERS.documentation_or_nonbehavior_workflow.iterationFullCi, 'forbidden');
  assert.deepEqual(VALIDATION_EXECUTION_TIERS.focused_script_or_rule.requiredEvidence, ['targeted_test']);
  assert.deepEqual(VALIDATION_EXECUTION_TIERS.deployment_configuration.requiredEvidence, ['config_validation', 'service_restart', 'actual_listener', 'health_check']);
  assert.deepEqual(VALIDATION_EXECUTION_TIERS.business_code.requiredEvidence, ['typecheck', 'lint', 'related_tests']);
  assert.deepEqual(VALIDATION_EXECUTION_TIERS.durable_or_external.requiredEvidence, ['boundary', 'failure_recovery', 'idempotency', 'readback']);
  assert.equal(VALIDATION_EXECUTION_TIERS.stable_pr_candidate.candidateFullCi, 'once_per_exact_head_base');
  assert.deepEqual(VALIDATION_EXECUTION_TIERS.stable_pr_candidate.requiredEvidence, ['root_full_ci', 'windows_policy']);
  assert.equal(VALIDATION_EXECUTION_TIERS.rebase_refresh.candidateFullCi, 'broad_impact_or_new_stable_candidate');
  assert.deepEqual(VALIDATION_EXECUTION_TIERS.rebase_refresh.requiredEvidence, ['actual_diff_classification', 'affected_checks']);
  for (const changeType of ['business_code', 'deployment_configuration', 'durable_or_external']) {
    assert.equal(VALIDATION_EXECUTION_TIERS[changeType].iterationFullCi, 'forbidden');
    assert.equal(VALIDATION_EXECUTION_TIERS.stable_pr_candidate.candidateFullCi, 'once_per_exact_head_base');
  }
  assert.equal(VALIDATION_EXECUTION_TIERS.rebase_refresh.requiredEvidence.includes('affected_checks'), true);
  assert.equal(VALIDATION_EXECUTION_TIERS.stable_pr_candidate.requiredEvidence.includes('root_full_ci'), true);
});

test('CI returns a Draft transition through its PR candidate concurrency group', () => {
  const workflow = readFileSync(path.resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  assert.doesNotMatch(workflow, /^\s{2}push:/m);
  assert.match(workflow, /types: \[opened, reopened, synchronize, ready_for_review, converted_to_draft\]/);
  assert.match(workflow, /group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /github\.event\.pull_request\.draft == false/g);
  assert.doesNotMatch(workflow, /schedule:|workflow_dispatch:|Historical workspace \(pnpm\)/);
});

test('spec-read receipts enforce full/scoped plans and canonical v3 hash', () => {
  const root = temporaryRepo();
  try {
    write(root, 'docs/tackle-forger-development-spec-v3.md', '# V3\n\n## 0. Authority\n\n### 0.1 Immutable\n\n### 3.1 Method and type\n\n### 5.2 Derived template\n\n## 8. Patch\n\n## 13. Snapshot\n\n## 14. Version\n\n### 18.2 Snapshot\n\n### 18.3 Patch\n\n## 19. Risks\n\n## 20. Open\n\n## 21. Relevant\n\n### 24.11 Snapshot\n\n## 25. Export\n');
    write(root, POLICY_RELATIVE, readFileSync(path.join(process.cwd(), POLICY_RELATIVE), 'utf8'));
    const full = receipt(root);
    assert.equal(checkReadReceipt({ root, receipt: full }).receiptHash, receiptHash(full));
    const voluntaryFullCoding = receipt(root, { role: 'coding' });
    const voluntaryFullReview = receipt(root, { role: 'review' });
    assert.equal(checkReadReceipt({ root, receipt: voluntaryFullCoding }).requiredSections.includes('FULL_V3'), true);
    assert.equal(checkReadReceipt({ root, receipt: voluntaryFullReview }).requiredSections.includes('FULL_V3'), true);
    assert.throws(() => checkReadReceipt({ root, receipt: { ...voluntaryFullCoding, requiredSections: ['README', 'V3_INDEX', '0', '19', '20'], readSections: ['README', 'V3_INDEX', '0', '19', '20'] } }), /requiredSections does not match/);
    assert.throws(() => checkReadReceipt({ root, receipt: { ...voluntaryFullReview, readSections: ['README'] } }), /missing a required/);
    const scoped = receipt(root, {
      role: 'coding', profile: 'SCOPED', riskProfile: 'workflow_docs_metadata', relevantSections: ['21'],
      requiredSections: ['README', 'V3_INDEX', '0', '19', '20', '21'], readSections: ['README', 'V3_INDEX', '0', '19', '20', '21'],
    });
    assert.equal(checkReadReceipt({ root, receipt: scoped }).requiredSections.includes('21'), true);
    assert.equal(specReadPlan({ role: 'review', riskProfile: 'workflow_docs_metadata', relevantSections: ['21'] }).profile, 'SCOPED');
    assert.throws(() => checkReadReceipt({ root, receipt: { ...scoped, specSha256: '0'.repeat(64) } }), /does not match/);
    for (const missing of ['0', '19', 'OPEN_REGISTRY', '21']) {
      assert.throws(() => checkReadReceipt({ root, receipt: { ...scoped, readSections: scoped.readSections.filter((item) => item !== missing) } }), /missing a required/);
      assert.throws(() => checkReadReceipt({ root, receipt: { ...scoped, requiredSections: scoped.requiredSections.filter((item) => item !== missing), readSections: scoped.readSections.filter((item) => item !== missing) } }), /requiredSections does not match/);
    }
    assert.throws(() => checkReadReceipt({ root, receipt: { ...scoped, riskProfile: 'runtime_behavior' } }), /profile must be ROUTED/);
    const routed = specReadPlan({ role: 'coordinator', riskProfile: 'runtime_product_domain', relevantSections: ['6', '20'] });
    assert.equal(routed.profile, 'ROUTED');
    assert.deepEqual(routed.requiredSections, ['README', 'V3_INDEX', '0', '19', 'OPEN_REGISTRY', '6']);
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
    assert.throws(() => checkReadReceipt({ root, receipt: { ...reused, readSections: ['README', 'V3_INDEX', '0', '19', 'OPEN_REGISTRY'] }, currentReuseContext: current, applicableIds: ['OPEN-001'] }), /explicitly read/);
    assert.throws(() => checkReadReceipt({ root, receipt: reused, currentReuseContext: { ...current, currentAgentIdentity: 'agent:other' } }), /caller-provided/);
    assert.throws(() => checkReadReceipt({ root, receipt: reused, currentReuseContext: { ...current, currentContextState: 'compacted' } }), /currentContextState/);
    const copiedSession = { ...reused.reuseEvidence.session, agentIdentity: 'agent:other' };
    const copiedReceipt = { ...reused, reuseEvidence: { ...reused.reuseEvidence, session: copiedSession, sessionSha256: fullReadSessionHash(copiedSession), agentIdentity: 'agent:other' } };
    assert.throws(() => checkReadReceipt({ root, receipt: copiedReceipt, currentReuseContext: current }), /caller-provided/);
    for (const invalid of ['2026-02-29T00:00:00Z', '2025-04-31T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00.1Z']) assert.throws(() => checkFullReadSession({ root, session: { ...session, createdAt: invalid } }), /RFC 3339|real UTC/);
    assert.equal(checkFullReadSession({ root, session: { ...session, createdAt: '2024-02-29T23:59:59Z' } }).sessionHash.length, 64);
    unlinkSync(path.join(root, 'session.json'));
    unlinkSync(path.join(root, 'reused-receipt.json'));
    const coding = receipt(root, { taskId: 'task-2', role: 'coding', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'implementation' });
    const review = receipt(root, { taskId: 'task-2', role: 'review', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'review' });
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
    const coding = receipt(root, { taskId: 'task-2', role: 'coding', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'implementation' });
    const review = receipt(root, { taskId: 'task-2', role: 'review', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'review' });
    const verdictBrief = brief(root, { taskId: 'task-2', phase: 'verdict', reviewedHead: command(root, ['rev-parse', 'HEAD']), specReadReceipts: [reused, coding, review] });
    const briefPath = path.join(handoff, 'verdict-brief.json');
    const contextsPath = path.join(handoff, 'reuse-contexts.json');
    writeFileSync(briefPath, `${JSON.stringify(verdictBrief)}\n`);
    writeFileSync(contextsPath, `${JSON.stringify({ coordinator: current })}\n`);
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
      assert.throws(() => runCli(args, root), /currentReuseContext|currentContextState|caller-provided|Usage/);
      assert.equal(existsSync(marker), false);
    }
    const cliSummary = JSON.parse(runCli(['--run-validation', '--brief', briefPath, '--reuse-contexts', contextsPath], root));
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
    const frozen = { ...clean, ownedPaths: ['AGENTS.md', 'docs/tackle-forger-development-spec-v3.md'], allowedChanges: ['AGENTS.md', 'docs/tackle-forger-development-spec-v3.md'], preexistingOwnedPaths: ['AGENTS.md'], riskProfile: 'runtime_product_domain', scopeHasRuntimeSemantics: true, changeClass: 'typescript_api', validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test', 'node scripts/spec-v3-modules.mjs --check'], requiredScenarios: ['normal_path'], intentionallyNotApplicable: {} }, specReadReceipts: [receipt(root, { riskProfile: 'runtime_product_domain', reason: 'authority baseline' })], dirtyWorktreeDisposition: 'include_with_frozen_baseline', preTaskOwnedBaselineManifest: baseline, preTaskOwnedBaselineHash: ownedBaselineHash(baseline) };
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
    const coding = receipt(root, { role: 'coding', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'implementation' });
    const review = receipt(root, { role: 'review', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'review' });
    const verdictBrief = { ...preDispatch, phase: 'verdict', specReadReceipts: [preDispatch.specReadReceipts[0], coding, review] };
    const checkedBrief = checkTaskBrief({ root, brief: verdictBrief });
    const verdict = {
      schema: 'tackle-local-verdict/v1', taskId: verdictBrief.taskId, taskBriefSha256: checkedBrief.taskBriefSha256,
      specReceiptHashes: checkedBrief.specReceiptHashes, dirtyWorktreeDisposition: verdictBrief.dirtyWorktreeDisposition,
      specSha256: verdictBrief.specSha256, baseSha: verdictBrief.baseSha, reviewedHead: 'WORKTREE', ownedPaths: verdictBrief.ownedPaths,
      artifactIdentity: { kind: 'worktree', commitSha: null, patchHash: patchHash({ root, baseSha: verdictBrief.baseSha, ownedPaths: verdictBrief.ownedPaths }).patchHash }, verdict: 'PASS', findings: [],
    };
    assert.equal(checkVerdict({ root, verdict, brief: verdictBrief }).taskBriefSha256, checkedBrief.taskBriefSha256);
    assert.throws(() => checkTaskBrief({ root, brief: { ...preDispatch, phase: 'verdict' } }), /requires exactly these spec-read receipt roles: coordinator, coding, review/);
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

test('TaskBrief promotion preserves semantics and rejects mismatched, duplicate, and unowned evidence', () => {
  const root = temporaryRepo();
  const evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'workflow-promotion-evidence-'));
  try {
    taskBase(root);
    const source = brief(root);
    const coding = receipt(root, { role: 'coding', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'implementation coverage' });
    const review = receipt(root, { role: 'review', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'independent review coverage' });
    write(root, 'AGENTS.md', 'task-owned change\n');
    const promoted = promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review });
    assert.equal(checkTaskBrief({ root, brief: promoted }).phase, 'verdict');
    assert.deepEqual({ ...promoted, phase: source.phase, reviewedHead: source.reviewedHead, specReadReceipts: source.specReadReceipts, dirtyWorktreeDisposition: source.dirtyWorktreeDisposition }, source);
    writeFileSync(path.join(evidenceDir, 'brief.json'), JSON.stringify(source));
    writeFileSync(path.join(evidenceDir, 'coding.json'), JSON.stringify(coding));
    writeFileSync(path.join(evidenceDir, 'review.json'), JSON.stringify(review));
    const cli = JSON.parse(runCli(['--promote-task-brief', '--brief', path.join(evidenceDir, 'brief.json'), '--coding-receipt', path.join(evidenceDir, 'coding.json'), '--review-receipt', path.join(evidenceDir, 'review.json')], root));
    assert.equal(cli.phase, 'verdict');
    assert.throws(() => promoteTaskBrief({ root, brief: source, codingReceipt: review, reviewReceipt: review }), /role coding/);
    assert.throws(() => promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: coding }), /role review/);
    assert.throws(() => promoteTaskBrief({ root, brief: { ...source, phase: 'verdict', specReadReceipts: [source.specReadReceipts[0], coding, review] }, codingReceipt: coding, reviewReceipt: review }), /requires a valid pre_dispatch/);
    write(root, 'unowned.txt', 'unowned\n');
    assert.throws(() => promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review }), /dirty or unowned/);
  } finally {
    cleanup(root);
    cleanup(evidenceDir);
  }
});

test('review tiers stay independent from riskProfile and enforce tier-specific receipt boundaries', () => {
  const root = temporaryRepo();
  const evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'workflow-review-tier-'));
  try {
    taskBase(root);
    const source = brief(root);
    const coding = receipt(root, { role: 'coding', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'implementation coverage' });
    const review = receipt(root, { role: 'review', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'independent review coverage' });
    const prBase = { ...source, workflowMode: 'pull_request', reviewedHead: source.baseSha, dirtyWorktreeDisposition: 'clean_synced' };
    const prFast = { ...prBase, phase: 'verdict', reviewTier: 'fast', specReadReceipts: [source.specReadReceipts[0], coding] };
    assert.equal(checkTaskBrief({ root, brief: prFast }).phase, 'verdict');
    const prStandard = { ...prFast, reviewTier: 'standard', specReadReceipts: [source.specReadReceipts[0], coding, review] };
    assert.equal(checkTaskBrief({ root, brief: prStandard }).phase, 'verdict');
    assert.throws(() => checkTaskBrief({ root, brief: { ...prStandard, specReadReceipts: [source.specReadReceipts[0], coding] } }), /coordinator, coding, review/);
    assert.equal(prFast.riskProfile, prStandard.riskProfile);

    write(root, 'AGENTS.md', 'task-owned change\n');
    for (const reviewTier of ['fast', 'standard']) {
      const tierSource = { ...source, reviewTier };
      const promoted = promoteTaskBrief({ root, brief: tierSource, codingReceipt: coding });
      assert.deepEqual(promoted.specReadReceipts.map((item) => item.role), ['coordinator', 'coding']);
      assert.throws(() => promoteTaskBrief({ root, brief: tierSource, codingReceipt: coding, reviewReceipt: review }), /forbids a local review receipt/);
    }
    assert.throws(() => promoteTaskBrief({ root, brief: source, codingReceipt: coding }), /role review|receipt/);
    assert.deepEqual(promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review }).specReadReceipts.map((item) => item.role), ['coordinator', 'coding', 'review']);

    const fastSourcePath = path.join(evidenceDir, 'fast-brief.json');
    const codingPath = path.join(evidenceDir, 'coding.json');
    writeFileSync(fastSourcePath, JSON.stringify({ ...source, reviewTier: 'fast' }));
    writeFileSync(codingPath, JSON.stringify(coding));
    const cli = JSON.parse(runCli(['--promote-task-brief', '--brief', fastSourcePath, '--coding-receipt', codingPath], root));
    assert.deepEqual(cli.specReadReceipts.map((item) => item.role), ['coordinator', 'coding']);

    for (const dimension of ['persistedData', 'historicalSnapshots', 'concurrency', 'authorization', 'externalSideEffects']) {
      assert.throws(
        () => checkTaskBrief({ root, brief: { ...source, reviewTier: 'standard', riskDimensions: { ...source.riskDimensions, [dimension]: true } } }),
        new RegExp(`reviewTier must be strict when riskDimensions\\.${dimension}`),
      );
    }
    assert.throws(
      () => checkTaskBrief({ root, brief: { ...source, riskProfile: 'unknown_high_risk', reviewTier: 'fast' } }),
      /reviewTier must be strict when riskProfile unknown_high_risk/,
    );
    assert.throws(
      () => checkTaskBrief({ root, brief: { ...source, riskProfile: 'unknown_high_risk', reviewTier: 'strict' } }),
      /workflow_metadata requires workflow_docs_metadata/,
    );
  } finally {
    cleanup(root);
    cleanup(evidenceDir);
  }
});

test('TaskBrief promotion rejects a source artifact made stale by a new HEAD', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const source = brief(root);
    const coding = receipt(root, { role: 'coding', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'implementation coverage' });
    const review = receipt(root, { role: 'review', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'review coverage' });
    write(root, 'later.txt', 'new HEAD\n');
    command(root, ['add', 'later.txt']);
    command(root, ['commit', '-qm', 'advance HEAD']);
    assert.throws(() => promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review }), /stale base\/head artifact/);
  } finally { cleanup(root); }
});

test('TaskBrief promotion validates frozen baselines and trusted REUSE_FULL context', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    write(root, 'AGENTS.md', 'preexisting owned change\n');
    const baseline = buildOwnedBaselineManifest({ root, baseSha: command(root, ['rev-parse', 'HEAD']), ownedPaths: ['AGENTS.md'] });
    const frozen = brief(root, { preexistingOwnedPaths: ['AGENTS.md'], dirtyWorktreeDisposition: 'include_with_frozen_baseline', preTaskOwnedBaselineManifest: baseline, preTaskOwnedBaselineHash: ownedBaselineHash(baseline) });
    write(root, 'AGENTS.md', 'post-baseline owned change\n');
    const coding = receipt(root, { role: 'coding', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'coding coverage' });
    const review = receipt(root, { role: 'review', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'review coverage' });
    assert.equal(promoteTaskBrief({ root, brief: frozen, codingReceipt: coding, reviewReceipt: review }).dirtyWorktreeDisposition, 'include_with_frozen_baseline');
    assert.throws(() => promoteTaskBrief({ root, brief: { ...frozen, preTaskOwnedBaselineHash: '0'.repeat(64) }, codingReceipt: coding, reviewReceipt: review }), /must match its deterministic baseline manifest/);

    const coordinatorReuse = reusedReceiptForRole(root, 'coordinator');
    const reuseBrief = brief(root, { taskId: 'task-2', specReadReceipts: [coordinatorReuse] });
    const codingReuse = receipt(root, { taskId: 'task-2', role: 'coding', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'coding scoped coverage' });
    const reviewReuse = receipt(root, { taskId: 'task-2', role: 'review', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'review scoped coverage' });
    const current = currentReuseContext(coordinatorReuse.reuseEvidence.session);
    assert.equal(promoteTaskBrief({ root, brief: reuseBrief, codingReceipt: codingReuse, reviewReceipt: reviewReuse, currentReuseContext: current }).phase, 'verdict');
    assert.throws(() => promoteTaskBrief({ root, brief: reuseBrief, codingReceipt: codingReuse, reviewReceipt: reviewReuse }), /currentReuseContext/);
    assert.throws(() => promoteTaskBrief({ root, brief: reuseBrief, codingReceipt: codingReuse, reviewReceipt: reviewReuse, currentReuseContext: { ...current, currentAgentIdentity: 'agent:other' } }), /does not match/);
    assert.throws(() => promoteTaskBrief({ root, brief: reuseBrief, codingReceipt: codingReuse, reviewReceipt: reviewReuse, currentReuseContext: { ...current, currentContextSessionId: 'context:other' } }), /does not match/);
    assert.throws(() => promoteTaskBrief({ root, brief: reuseBrief, codingReceipt: codingReuse, reviewReceipt: reviewReuse, currentReuseContext: { ...current, currentContextState: 'compacted' } }), /must be continuous/);
  } finally { cleanup(root); }
});

test('TaskBrief promotion assigns independent trusted contexts to every REUSE_FULL role', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    write(root, 'AGENTS.md', 'task-owned change\n');
    const reuseFor = (role, agentIdentity, contextSessionId) => {
      const receiptValue = reusedReceiptForRole(root, role);
      const session = { ...receiptValue.reuseEvidence.session, agentIdentity, contextSessionId };
      return { ...receiptValue, reuseEvidence: { ...receiptValue.reuseEvidence, session, sessionSha256: fullReadSessionHash(session), agentIdentity, contextSessionId } };
    };
    const coordinator = reuseFor('coordinator', 'agent:coordinator', 'context:coordinator');
    const coding = reuseFor('coding', 'agent:coding', 'context:coding');
    const review = reuseFor('review', 'agent:review', 'context:review');
    const source = brief(root, { taskId: 'task-2', specReadReceipts: [coordinator] });
    const contexts = {
      coordinator: currentReuseContext(coordinator.reuseEvidence.session),
      coding: currentReuseContext(coding.reuseEvidence.session),
      review: currentReuseContext(review.reuseEvidence.session),
    };
    assert.equal(promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review, reuseContexts: contexts }).phase, 'verdict');
    assert.throws(() => promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review }), /currentReuseContext/);
    assert.throws(() => promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review, reuseContexts: { coordinator: contexts.coordinator, review: contexts.review } }), /currentReuseContext|exactly one trusted/);
    assert.throws(() => promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review, reuseContexts: { ...contexts, coding: { ...contexts.coding, currentAgentIdentity: 'agent:wrong' } } }), /does not match/);
    assert.throws(() => promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review, reuseContexts: { ...contexts, review: { ...contexts.review, currentContextSessionId: 'context:wrong' } } }), /does not match/);
    assert.throws(() => promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review, reuseContexts: { ...contexts, review: { ...contexts.review, currentContextState: 'compacted' } } }), /must be continuous/);
    assert.throws(() => promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review, reuseContexts: { ...contexts, extra: contexts.review } }), /unknown receipt role/);
  } finally { cleanup(root); }
});

test('TaskBrief promotion accepts deleted and untracked owned artifacts but rejects invalid manifest paths', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const source = brief(root);
    const coding = receipt(root, { role: 'coding', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'coding coverage' });
    const review = receipt(root, { role: 'review', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'review coverage' });
    unlinkSync(path.join(root, 'AGENTS.md'));
    assert.equal(promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review }).phase, 'verdict');
    assert.throws(() => buildPatchManifest({ root, baseSha: source.baseSha, ownedPaths: ['bad\0path'] }), /Invalid owned path/);
  } finally { cleanup(root); }
});

test('TaskBrief promotion accepts an untracked scoped owned artifact', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const ownedPath = '.codex/skills/tackle-agent-workflow/new-owned.md';
    const baseSha = command(root, ['rev-parse', 'HEAD']);
    const source = brief(root, { ownedPaths: [ownedPath], allowedChanges: [ownedPath], validationPlan: { ...brief(root).validationPlan, requiredCommands: ['node scripts/spec-v3-modules.mjs --check', 'node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-policy', 'node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-index', 'node --test .codex/skills/tackle-agent-workflow/scripts/workflow-contract.test.mjs', ownedWhitespaceCommand(baseSha, [ownedPath])] } });
    const coding = receipt(root, { role: 'coding', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'coding coverage' });
    const review = receipt(root, { role: 'review', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'review coverage' });
    write(root, ownedPath, 'new owned artifact\n');
    assert.equal(promoteTaskBrief({ root, brief: source, codingReceipt: coding, reviewReceipt: review }).phase, 'verdict');
  } finally { cleanup(root); }
});

test('derived evidence stages keep development light and freeze only the review artifact', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const development = brief(root);
    assert.equal(checkTaskBrief({ root, brief: development }).phase, 'pre_dispatch');
    assert.throws(() => checkTaskBrief({ root, brief: { ...development, evidenceStage: 'local_review_handoff' } }), /unknown, missing, or inapplicable keys/);
    const coding = receipt(root, { role: 'coding', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'implementation' });
    const review = receipt(root, { role: 'review', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'review' });
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
    assert.deepEqual(classifyOwnedPaths(['.github/workflows/ci.yml']), { scopedEligible: true, unrecognizedPaths: [] });
    assert.deepEqual(classifyOwnedPaths(['CLAUDE.md']), { scopedEligible: true, unrecognizedPaths: [] });
    for (const scopedPath of [
      '.codex/skills/agent-project-bootstrap/SKILL.md',
      '.codex/skills/agent-issue-loop/SKILL.md',
      '.codex/skills/agent-pr-loop/SKILL.md',
      '.claude/skills/agent-pr-loop/SKILL.md',
    ]) assert.deepEqual(classifyOwnedPaths([scopedPath]), { scopedEligible: true, unrecognizedPaths: [] });
    assert.deepEqual(classifyOwnedPaths(['.github/nested/arbitrary.md']), { scopedEligible: false, unrecognizedPaths: ['.github/nested/arbitrary.md'] });
    assert.deepEqual(classifyOwnedPaths(['.github/workflows/nested/ci.yml']), { scopedEligible: false, unrecognizedPaths: ['.github/workflows/nested/ci.yml'] });
    for (const unrecognizedPath of [
      '.codex/skills/agent-project-bootstrapper/SKILL.md',
      '.codex/skills/agent-issue-loop-backup/SKILL.md',
      '.claude/skills/deploy-r730/SKILL.md',
      '.claude/skills/agent-pr-loop-backup/SKILL.md',
      '.claude/skill/tackle-agent-workflow/SKILL.md',
      '.claude/skills.md',
      'CLAUDE.md.bak',
      'nested/CLAUDE.md',
      '.claude/CLAUDE.md',
    ]) assert.deepEqual(classifyOwnedPaths([unrecognizedPath]), { scopedEligible: false, unrecognizedPaths: [unrecognizedPath] });
    for (const malformed of [
      '.codex/skills/tackle-agent-workflow/../../../lib/runtime.ts',
      '../evil.md',
      '.github/./workflows/ci.yml',
      '.github//workflows/ci.yml',
      '.github\\workflows\\ci.yml',
      '/tmp/ci.yml',
    ]) {
      assert.deepEqual(classifyOwnedPaths([malformed]), { scopedEligible: false, unrecognizedPaths: [malformed] });
      assert.throws(() => checkTaskBrief({ root, brief: { ...local, ownedPaths: [malformed], allowedChanges: [malformed] } }), /Invalid owned path/);
    }
    const workflowOwned = {
      ...local,
      ownedPaths: ['.github/workflows/ci.yml'],
      allowedChanges: ['.github/workflows/ci.yml'],
      validationPlan: {
        ...local.validationPlan,
        requiredCommands: [
          ...local.validationPlan.requiredCommands.filter((item) => !item.includes('--check-owned-whitespace')),
          ownedWhitespaceCommand(local.baseSha, ['.github/workflows/ci.yml']),
        ],
      },
    };
    assert.equal(checkTaskBrief({ root, brief: workflowOwned }).phase, 'pre_dispatch');
    assert.throws(() => checkTaskBrief({ root, brief: { ...local, ownedPaths: ['src/runtime.ts'], allowedChanges: ['src/runtime.ts'], validationPlan: { ...local.validationPlan, requiredCommands: [...local.validationPlan.requiredCommands.filter((item) => !item.includes('--check-owned-whitespace')), ownedWhitespaceCommand(local.baseSha, ['src/runtime.ts'])] } } }), /workflow_metadata may own only scoped/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...local, ownedPaths: ['docs/tackle-forger-development-spec-v3.md'], allowedChanges: ['docs/tackle-forger-development-spec-v3.md'], validationPlan: { ...local.validationPlan, requiredCommands: [...local.validationPlan.requiredCommands.filter((item) => !item.includes('--check-owned-whitespace')), ownedWhitespaceCommand(local.baseSha, ['docs/tackle-forger-development-spec-v3.md'])] } } }), /workflow_metadata may own only scoped/);
    const runtimeReceipt = receipt(root, { riskProfile: 'runtime_product_domain', reason: 'runtime change' });
    const runtimeBrief = { ...local, ownedPaths: ['src/runtime.ts'], allowedChanges: ['src/runtime.ts'], riskProfile: 'runtime_product_domain', scopeHasRuntimeSemantics: true, changeClass: 'typescript_api', validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test'], requiredScenarios: ['normal_path'], intentionallyNotApplicable: {} }, specReadReceipts: [runtimeReceipt] };
    assert.equal(checkTaskBrief({ root, brief: runtimeBrief }).phase, 'pre_dispatch');
    assert.throws(() => checkTaskBrief({ root, brief: { ...runtimeBrief, specReadReceipts: [{ ...runtimeReceipt, profile: 'SCOPED' }] } }), /profile must be (?:ROUTED|FULL)/);
    assert.throws(() => checkTaskBrief({ root, brief: { ...local, specReadReceipts: [local.specReadReceipts[0], local.specReadReceipts[0]] } }), /requires exactly these spec-read receipt roles: coordinator/);
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
    const coding = receipt(root, { role: 'coding', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'implementation' });
    const review = receipt(root, { role: 'review', profile: 'FULL', requiredSections: ['README', 'V3_INDEX', 'FULL_V3'], readSections: ['README', 'V3_INDEX', 'FULL_V3'], reason: 'review' });
    const duplicateBase = command(root, ['rev-parse', 'HEAD']);
    const duplicate = { ...local, baseSha: duplicateBase, reviewedHead: 'WORKTREE', validationPlan: { ...local.validationPlan, requiredCommands: [...local.validationPlan.requiredCommands.filter((item) => !item.includes('--check-owned-whitespace')), ownedWhitespaceCommand(duplicateBase, ['AGENTS.md'])] }, phase: 'verdict', specReadReceipts: [local.specReadReceipts[0], coding, review, review] };
    assert.throws(() => checkTaskBrief({ root, brief: duplicate }), /requires exactly these spec-read receipt roles: coordinator, coding, review/);
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
    assert.throws(() => checkTaskBrief({ root, brief: { ...base, ownedPaths: ['x.md'], validationPlan: { ...base.validationPlan, requiredCommands: [...base.validationPlan.requiredCommands.filter((item) => !item.includes('--check-owned-whitespace')), ownedWhitespaceCommand(base.baseSha, ['x.md'])] } } }), /allowedChanges/);
  } finally { cleanup(root); }
});

test('validation matrix enforces PR, risk, user-visible, and domain-drift gates', () => {
  const root = temporaryRepo();
  try {
    taskBase(root); const base = brief(root);
    const runtimeReceipt = receipt(root, { riskProfile: 'runtime_product_domain', reason: 'runtime final gate' });
    const pr = { ...base, workflowMode: 'pull_request', reviewedHead: base.baseSha, dirtyWorktreeDisposition: 'clean_synced', riskProfile: 'runtime_product_domain', scopeHasRuntimeSemantics: true, changeClass: 'pr_final', specReadReceipts: [runtimeReceipt], validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test'], requiredScenarios: ['ci_gate'], intentionallyNotApplicable: {} } };
    assert.equal(checkTaskBrief({ root, brief: pr }).phase, 'pre_dispatch');
    assert.throws(() => checkTaskBrief({ root, brief: { ...pr, validationPlan: { ...pr.validationPlan, requiredCommands: ['npm run typecheck', 'npm run lint'], intentionallyNotApplicable: { 'npm test': 'skip' } } } }), /cannot be N\/A/);
    const migration = { ...base, riskProfile: 'durable_migration', scopeHasRuntimeSemantics: true, changeClass: 'persistence_migration', specReadReceipts: [receipt(root, { riskProfile: 'durable_migration', reason: 'migration' })], validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test'], requiredScenarios: ['normal_path', 'boundary', 'conflict', 'version_freeze', 'production_shape_fixture', 'unknown_field_preservation', 'second_run_noop'], intentionallyNotApplicable: {} } };
    assert.throws(() => checkTaskBrief({ root, brief: migration }), /requires persistedData/);
    const ui = { ...base, ownedPaths: ['components/view.css'], allowedChanges: ['components/view.css'], riskProfile: 'runtime_product_domain', scopeHasRuntimeSemantics: true, changeClass: 'typescript_api', specReadReceipts: [runtimeReceipt], validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test'], requiredScenarios: ['normal_path'], intentionallyNotApplicable: {} } };
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
    const ui = { ...base, ownedPaths: ['packages/ui/Panel.tsx'], allowedChanges: ['packages/ui/Panel.tsx'], riskProfile: 'runtime_product_domain', scopeHasRuntimeSemantics: true, changeClass: 'typescript_api', specReadReceipts: [runtimeReceipt], validationPlan: { requiredCommands: ['npm run typecheck', 'npm run lint', 'npm test'], requiredScenarios: ['normal_path'], intentionallyNotApplicable: {} } };
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

test('canonical modular routes reject incomplete runtime coverage and accept a complete route', () => {
  const root = process.cwd();
  assert.throws(
    () => specReadPlan({ root, role: 'coordinator', riskProfile: 'runtime_product_domain', relevantSections: ['20'] }),
    /complete applicable canonical v3 route/,
  );
  const plan = specReadPlan({
    root,
    role: 'coordinator',
    riskProfile: 'runtime_product_domain',
    relevantSections: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '19', '20'],
  });
  assert.equal(plan.profile, 'ROUTED');
  assert.equal(plan.requiredSections.includes('FULL_V3'), false);
});

test('OPEN registry read plans are compact, applicable-only, dependency-bound, and strict-safe', () => {
  const root = process.cwd();
  const empty = specReadPlan({
    root,
    role: 'coordinator',
    riskProfile: 'workflow_docs_metadata',
    reviewTier: 'standard',
    relevantSections: ['0', '19', '20'],
    applicableIds: [],
  });
  assert.equal(empty.profile, 'SCOPED');
  assert.equal(empty.requiredSections.includes('20'), false);
  assert.equal(empty.requiredSections.includes('OPEN_REGISTRY'), true);
  assert.equal(empty.requiredSections.some((section) => section.startsWith('OPEN:')), false);

  const applicable = specReadPlan({
    root,
    role: 'coordinator',
    riskProfile: 'workflow_docs_metadata',
    reviewTier: 'standard',
    relevantSections: ['0', '19', '20'],
    applicableIds: ['OPEN-009'],
  });
  assert.equal(applicable.profile, 'SCOPED');
  assert.equal(applicable.requiredSections.includes('OPEN:OPEN-009'), true);
  assert.equal(applicable.requiredSections.includes('23.6'), true);
  assert.equal(applicable.requiredSections.includes('20'), false);

  const strict = specReadPlan({
    root,
    role: 'coordinator',
    riskProfile: 'workflow_docs_metadata',
    reviewTier: 'strict',
    relevantSections: ['0', '19', '20'],
    applicableIds: [],
  });
  assert.equal(strict.profile, 'FULL');
  assert.deepEqual(strict.requiredSections, ['README', 'V3_INDEX', 'FULL_V3']);
  assert.equal(specReadPlan({ root, role: 'coordinator', riskProfile: 'unknown_high_risk', relevantSections: [], applicableIds: [] }).profile, 'FULL');
  assert.throws(
    () => specReadPlan({ root, role: 'coordinator', riskProfile: 'workflow_docs_metadata', reviewTier: 'standard', relevantSections: ['0', '19', '20'], applicableIds: ['OPEN-999'] }),
    /current OPEN registry IDs/,
  );

  const registry = buildNavigationIndex(root).openRegistry;
  assert.equal(registry.length, 11);
  assert.equal(new Set(registry.map((entry) => entry.id)).size, registry.length);
  assert.equal(registry.every((entry) => entry.path.startsWith('docs/spec-v3/') && entry.startLine <= entry.endLine && entry.contentSha256.length === 64), true);

  const fixture = temporaryRepo();
  try {
    taskBase(fixture);
    const fixturePlan = specReadPlan({
      root: fixture,
      role: 'coordinator',
      riskProfile: 'workflow_docs_metadata',
      reviewTier: 'standard',
      relevantSections: ['1', '20'],
      applicableIds: ['OPEN-001'],
    });
    const coordinator = {
      ...receipt(fixture),
      profile: fixturePlan.profile,
      requiredSections: fixturePlan.requiredSections,
      readSections: fixturePlan.requiredSections,
    };
    const applicableBrief = brief(fixture, {
      reviewTier: 'standard',
      openDecisionCheck: {
        registrySha256: openRegistryHash(fixture),
        checkedIds: ['OPEN-001'],
        applicableIds: ['OPEN-001'],
        noApplicableReason: null,
      },
      specReadReceipts: [coordinator],
    });
    assert.equal(checkTaskBrief({ root: fixture, brief: applicableBrief }).phase, 'pre_dispatch');
    assert.throws(
      () => checkTaskBrief({ root: fixture, brief: { ...applicableBrief, specReadReceipts: [{ ...coordinator, requiredSections: coordinator.requiredSections.filter((section) => section !== 'OPEN:OPEN-001'), readSections: coordinator.readSections.filter((section) => section !== 'OPEN:OPEN-001') }] } }),
      /requiredSections does not match/,
    );

    const before = openRegistryHash(fixture);
    appendFileSync(path.join(fixture, 'docs/tackle-forger-development-spec-v3.md'), '\nSpecification identity change.\n');
    assert.notEqual(openRegistryHash(fixture), before);
  } finally { cleanup(fixture); }
});

test('canonical specification paths always trigger the module consistency command', () => {
  const root = temporaryRepo();
  try {
    taskBase(root);
    const input = prepareInput(root, {
      riskProfile: 'runtime_product_domain',
      scopeHasRuntimeSemantics: true,
      changeClass: 'typescript_api',
      ownedPaths: ['docs/tackle-forger-development-spec-v3.md'],
      coordinatorSpecReadReceipt: receipt(root, {
        taskId: 'prepared-task',
        riskProfile: 'runtime_product_domain',
        relevantSections: ['0', '19', '20'],
        reason: 'Canonical specification structure change requires full authority coverage.',
      }),
    });
    const prepared = prepareTaskBrief({ root, input });
    assert.equal(prepared.validationPlan.requiredCommands.includes('node scripts/spec-v3-modules.mjs --check'), true);
  } finally { cleanup(root); }
});

test('machine policy preserves review boundaries without a prose mirror', () => {
  const root = process.cwd();
  const policy = JSON.parse(readFileSync(path.join(root, POLICY_RELATIVE), 'utf8'));
  assert.deepEqual(policy.reviewTier.values, ['fast', 'standard', 'strict']);
  assert.deepEqual(policy.taskBrief.phaseReceiptsByReviewTier.verdict.standard.pull_request, ['coordinator', 'coding', 'review']);
  assert.deepEqual(policy.taskBrief.phaseReceiptsByReviewTier.verdict.standard.local, ['coordinator', 'coding']);
  assert.equal(Object.hasOwn(policy, 'pullRequest'), false);
  assert.equal(Object.hasOwn(policy.taskBrief, 'evidenceStages'), false);
});

test('merge gate document owns the complete review signal envelope', () => {
  const gatePolicy = readFileSync(path.join(process.cwd(), '.github/merge-gates.md'), 'utf8');
  assert.match(gatePolicy, /A current review signal is additionally required only\s+when the workflow machine policy, repository or platform policy, or the\s+high-risk merge gate requires one\./);
  assert.match(gatePolicy, /When a review signal is required, the canonical integrated Agent review uses/);
  for (const field of [
    'Agent-Review-Version: v1',
    'Reviewer-Role: independent-review-agent',
    'Head-SHA: <full SHA>',
    'Base-SHA: <full SHA>',
    'Verdict: PASS',
    'Agent-Review: PASS',
  ]) assert.equal(gatePolicy.split(field).length - 1 >= 1, true, field);
});
