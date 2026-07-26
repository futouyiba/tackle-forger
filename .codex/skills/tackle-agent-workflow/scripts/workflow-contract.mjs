#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_RELATIVE = '.codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs';
const INDEX_RELATIVE = '.codex/skills/tackle-agent-workflow/references/v3-navigation.json';
const SPEC_RELATIVE = 'docs/tackle-forger-development-spec-v3.md';
const PATCH_SCHEMA = 'tackle-local-patch/v1';
const SPEC_READ_SCHEMA = 'tackle-spec-read/v1';
const SPEC_READ_REUSE_SCHEMA = 'tackle-spec-read/v2';
const SPEC_FULL_READ_SESSION_SCHEMA = 'tackle-spec-full-read-session/v1';
const TASK_BRIEF_SCHEMA = 'tackle-task-brief/v1';
const TASK_PREPARE_INPUT_SCHEMA = 'tackle-task-prepare-input/v1';
const OWNED_BASELINE_SCHEMA = 'tackle-owned-baseline/v1';
const VERDICT_SCHEMA = 'tackle-local-verdict/v1';
const VALIDATION_SUMMARY_SCHEMA = 'tackle-validation-summary/v1';
const README_SECTION = 'README';
const FULL_V3_SECTION = 'FULL_V3';
const SCOPED_BASE_SECTIONS = [README_SECTION, '0', '19', '20'];
const NAVIGATION_DOMAINS = { export: ['20', '25'], patch: ['8', '14', '18.3', '20'], snapshot: ['13', '14', '18.2', '24.11'] };
const NAVIGATION_INVARIANTS = [
  { id: 'nearest-derived-template-no-interpolation', sourceSections: ['5.2'] },
  { id: 'method-and-type-are-separate-rule-layers', sourceSections: ['3.1'] },
  { id: 'published-snapshots-are-immutable', sourceSections: ['0.1', '14'] },
];
const STRICT_NAVIGATION_SECTIONS = new Set([
  ...Object.values(NAVIGATION_DOMAINS).flat(),
  ...NAVIGATION_INVARIANTS.flatMap((invariant) => invariant.sourceSections),
  '20',
]);
const MANDATORY_WORKFLOW_COMMANDS = ['node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-index', 'node .codex/skills/tackle-agent-workflow/scripts/workflow-contract.mjs --check-policy', 'node --test .codex/skills/tackle-agent-workflow/scripts/workflow-contract.test.mjs'];
const CONDITIONAL_NA_CATALOG = ['product_runtime_tests', 'legacy_workspace_ci'];
const LEGACY_WORKSPACE_COMMANDS = ['node --test tests/package-manager-boundaries.test.mjs', 'pnpm --dir legacy-workspace install --frozen-lockfile', "pnpm --dir legacy-workspace --filter '@tackle-forger/*' typecheck", "pnpm --dir legacy-workspace --filter '@tackle-forger/*' lint", "pnpm --dir legacy-workspace --filter '@tackle-forger/*' test", "pnpm --dir legacy-workspace --filter '@tackle-forger/*' build"];
const CONDITIONAL_NA_APPLICABILITY = { legacyTouchedForbids: 'legacy_workspace_ci', nonLegacyRequires: 'legacy_workspace_ci', nonWorkflowForbids: 'product_runtime_tests', workflowMetadataRequires: 'product_runtime_tests' };
const CHANGE_CLASS_MATRIX = {
  workflow_metadata: { commands: MANDATORY_WORKFLOW_COMMANDS, scenarios: ['authority_and_scoped_diff'], nonWaivableCommands: MANDATORY_WORKFLOW_COMMANDS, nonWaivableScenarios: ['authority_and_scoped_diff'] },
  typescript_api: { commands: ['npm run typecheck', 'npm run lint', 'npm test'], scenarios: ['normal_path'], nonWaivableCommands: ['npm run typecheck', 'npm run lint', 'npm test'], nonWaivableScenarios: ['normal_path'] },
  domain_behavior: { commands: ['npm run typecheck', 'npm run lint', 'npm test'], scenarios: ['normal_path', 'boundary', 'conflict', 'version_freeze'], nonWaivableCommands: ['npm run typecheck', 'npm run lint', 'npm test'], nonWaivableScenarios: ['normal_path', 'boundary', 'conflict', 'version_freeze'] },
  persistence_migration: { commands: ['npm run typecheck', 'npm run lint', 'npm test'], scenarios: ['normal_path', 'boundary', 'conflict', 'version_freeze', 'production_shape_fixture', 'unknown_field_preservation', 'second_run_noop'], nonWaivableCommands: ['npm run typecheck', 'npm run lint', 'npm test'], nonWaivableScenarios: ['normal_path', 'boundary', 'conflict', 'version_freeze', 'production_shape_fixture', 'unknown_field_preservation', 'second_run_noop'] },
  authorization_shared_write: { commands: ['npm run typecheck', 'npm run lint', 'npm test'], scenarios: ['authorization_denied', 'reauthorize_at_commit', 'concurrency_conflict'], nonWaivableCommands: ['npm run typecheck', 'npm run lint', 'npm test'], nonWaivableScenarios: ['authorization_denied', 'reauthorize_at_commit', 'concurrency_conflict'] },
  external_side_effect: { commands: ['npm run typecheck', 'npm run lint', 'npm test'], scenarios: ['prepare_write_readback', 'partial_failure_recovery', 'idempotent_retry'], nonWaivableCommands: ['npm run typecheck', 'npm run lint', 'npm test'], nonWaivableScenarios: ['prepare_write_readback', 'partial_failure_recovery', 'idempotent_retry'] },
  pr_final: { commands: ['npm run typecheck', 'npm run lint', 'npm test'], scenarios: ['ci_gate'], nonWaivableCommands: ['npm run typecheck', 'npm run lint', 'npm test'], nonWaivableScenarios: ['ci_gate'] },
};

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function git(root, args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: null, ...options });
  if (result.status !== 0) return null;
  return result.stdout;
}
export function repositoryRoot(cwd = process.cwd()) {
  try { return realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()); }
  catch { fail(`Not inside a Git repository: ${cwd}`); }
}
function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  fail('Unsupported manifest value');
}
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requireExactKeys(value, keys, field) {
  if (!isPlainObject(value)) fail(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!sameSet(actual, expected)) fail(`${field} has unknown, missing, or inapplicable keys`);
}
function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a non-empty string`);
  return value;
}
function requireStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) fail(`${field} must be an array of non-empty strings`);
  if (new Set(value).size !== value.length) fail(`${field} must not contain duplicates`);
  return value;
}
function requireNonEmptyStringArray(value, field) {
  const result = requireStringArray(value, field);
  if (result.length === 0) fail(`${field} must not be empty`);
  return result;
}
function sameSet(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === left.length && rightSet.size === right.length && leftSet.size === rightSet.size && [...leftSet].every((item) => rightSet.has(item));
}
function requireCurrentSpecHash(root, value) {
  const expected = sha256(readFileSync(path.join(root, SPEC_RELATIVE)));
  if (value !== expected) fail('specSha256 does not match the current canonical v3 specification');
  return expected;
}
function currentReadmeHash(root) { return sha256(readFileSync(path.join(root, 'docs/README.md'))); }
function readJsonFile(file, label) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { fail(`${label} must be readable JSON: ${file}`); }
}
function compareUtf8(left, right) { return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')); }
function isScopedGovernancePath(repoPath) {
  return repoPath === 'AGENTS.md'
    || repoPath.startsWith('.codex/skills/tackle-agent-workflow/')
    || /^docs\/(?:workflow|agent-governance)-[^/]+\.md$/.test(repoPath)
    || /^\.github\/[^/]+\.(?:md|ya?ml)$/.test(repoPath);
}
export function classifyOwnedPaths(ownedPaths) {
  const unrecognized = ownedPaths.filter((repoPath) => !isScopedGovernancePath(repoPath));
  return { scopedEligible: unrecognized.length === 0, unrecognizedPaths: unrecognized };
}
function validatePath(root, input) {
  if (typeof input !== 'string' || input.length === 0 || Buffer.from(input, 'utf8').toString('utf8') !== input || input.includes('\0') || path.isAbsolute(input) || input.includes('\\')) fail(`Invalid owned path: ${String(input)}`);
  const parts = input.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) fail(`Invalid owned path: ${input}`);
  const resolved = path.resolve(root, ...parts);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`Owned path escapes repository: ${input}`);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail(`Symlink is not supported: ${input}`);
  }
  return { path: parts.join('/'), absolute: resolved };
}
function baseEntry(root, baseSha, repoPath) {
  const listing = git(root, ['ls-tree', '-z', baseSha, '--', repoPath]);
  if (!listing || listing.length === 0) return null;
  const nul = listing.indexOf(0);
  if (nul < 0 || nul !== listing.length - 1) fail(`Ambiguous base-tree entry: ${repoPath}`);
  const record = listing.subarray(0, nul);
  const tab = record.indexOf(0x09);
  if (tab < 0) fail(`Unsupported base-tree entry: ${repoPath}`);
  const match = record.subarray(0, tab).toString('ascii').match(/^(\d+) blob ([0-9a-f]{40,64})$/);
  const pathBytes = record.subarray(tab + 1);
  if (!match || !pathBytes.equals(Buffer.from(repoPath, 'utf8'))) fail(`Unsupported base-tree entry: ${repoPath}`);
  if (match[1] !== '100644' && match[1] !== '100755') fail(`Unsupported base-tree mode: ${repoPath}`);
  const bytes = git(root, ['show', `${baseSha}:${repoPath}`]);
  if (bytes === null) fail(`Cannot read base content: ${repoPath}`);
  return { mode: match[1], bytes };
}
function currentEntry(absolute, repoPath) {
  if (!existsSync(absolute)) return null;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`Unsupported current entry: ${repoPath}`);
  if (typeof stat.mode !== 'number') fail(`Cannot read POSIX mode: ${repoPath}`);
  const mode = (stat.mode & 0o111) !== 0 ? '100755' : '100644';
  const bytes = readFileSync(absolute);
  return { mode, bytes };
}
function indexTracks(root, repoPath) { return git(root, ['ls-files', '--error-unmatch', '--', repoPath]) !== null; }
export function buildPatchManifest({ root = repositoryRoot(), baseSha, ownedPaths }) {
  if (!/^[0-9a-f]{40,64}$/i.test(baseSha ?? '') || git(root, ['rev-parse', '--verify', `${baseSha}^{commit}`]) === null) fail('base SHA must resolve to a commit');
  if (!Array.isArray(ownedPaths) || ownedPaths.length === 0) fail('At least one --owned path is required');
  const paths = ownedPaths.map((owned) => validatePath(root, owned));
  if (new Set(paths.map((item) => item.path)).size !== paths.length) fail('Owned paths must be unique');
  const entries = paths.map(({ path: repoPath, absolute }) => {
    const before = baseEntry(root, baseSha, repoPath);
    const after = currentEntry(absolute, repoPath);
    if (!after && !before) fail(`Owned path is neither current nor in base: ${repoPath}`);
    if (!after) return { path: repoPath, state: 'deleted', mode: before.mode, length: before.bytes.length, contentSha256: sha256(before.bytes) };
    const same = before && before.mode === after.mode && before.bytes.equals(after.bytes);
    const state = same ? 'unchanged' : (before || indexTracks(root, repoPath) ? 'tracked_changed' : 'untracked');
    return { path: repoPath, state, mode: after.mode, length: after.bytes.length, contentSha256: sha256(after.bytes) };
  }).sort((left, right) => compareUtf8(left.path, right.path));
  return { baseSha: git(root, ['rev-parse', baseSha]).toString('utf8').trim(), entries, schemaVersion: PATCH_SCHEMA };
}
export function patchHash(options) {
  const manifest = buildPatchManifest(options);
  const canonical = canonicalJson(manifest);
  return { manifest, patchHash: sha256(Buffer.from(canonical, 'utf8')) };
}
export function buildNavigationIndex(root = repositoryRoot()) {
  const specPath = path.join(root, SPEC_RELATIVE);
  const source = readFileSync(specPath, 'utf8');
  const lines = source.split(/\r?\n/);
  const headings = [];
  const openRegistry = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const title = heading[2];
      if (/^\d/.test(title) && !/^(\d+(?:\.\d+)*)(?:\.|\s)/.test(title)) fail(`Malformed v3 section heading at line ${index + 1}`);
      headings.push({ line: index + 1, level: heading[1].length, title });
    }
    const open = line.match(/^\|\s*(OPEN-\d+)\b[^|]*\|[^|]*\|\s*`?([^|`]+?)`?\s*\|/);
    if (open) openRegistry.push({ id: open[1], status: open[2].trim(), line: index + 1, raw: line });
  });
  const sectionIds = new Set();
  for (const heading of headings) {
    const section = heading.title.match(/^(\d+(?:\.\d+)*)(?:\.|\s)/)?.[1];
    if (!section) continue;
    if (STRICT_NAVIGATION_SECTIONS.has(section) && heading.level !== section.split('.').length + 1) fail(`v3 section heading depth does not match Markdown level: ${section}`);
    if (sectionIds.has(section)) fail(`Duplicate v3 section identifier: ${section}`);
    sectionIds.add(section);
  }
  for (const sections of Object.values(NAVIGATION_DOMAINS)) if (!sections.every((section) => sectionIds.has(section))) fail('Navigation configuration references a v3 section that does not exist');
  const globalInvariants = NAVIGATION_INVARIANTS.map((invariant) => {
    if (!invariant.sourceSections.every((section) => sectionIds.has(section))) fail(`Invariant ${invariant.id} is missing an authoritative v3 heading`);
    return { ...invariant, headingsVerified: true };
  });
  return { format: 'tackle-v3-navigation/v2', nonAuthoritative: true, globalInvariants, openDecisions: openRegistry, openRegistry, domains: NAVIGATION_DOMAINS, source: { path: SPEC_RELATIVE, sha256: sha256(Buffer.from(source, 'utf8')) }, headings };
}
export function writeNavigationIndex(root = repositoryRoot()) {
  const rendered = `${JSON.stringify(buildNavigationIndex(root), null, 2)}\n`;
  const target = path.join(root, INDEX_RELATIVE);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, rendered, 'utf8');
  return rendered;
}
export function checkNavigationIndex(root = repositoryRoot()) {
  const expected = `${JSON.stringify(buildNavigationIndex(root), null, 2)}\n`;
  const target = path.join(root, INDEX_RELATIVE);
  if (!existsSync(target) || readFileSync(target, 'utf8') !== expected) fail(`Navigation index drift: run node ${SCRIPT_RELATIVE} --generate-index`);
  return true;
}
export function specReadPlan({ role, riskProfile, relevantSections = [] }) {
  if (!['coordinator', 'coding', 'review'].includes(role)) fail('role must be coordinator, coding, or review');
  requireString(riskProfile, 'riskProfile');
  const relevant = requireStringArray(relevantSections, 'relevantSections');
  const scoped = role !== 'coordinator' && riskProfile === 'workflow_docs_metadata';
  const profile = scoped ? 'SCOPED' : 'FULL';
  const requiredSections = scoped ? [...new Set([...SCOPED_BASE_SECTIONS, ...relevant])] : [README_SECTION, FULL_V3_SECTION];
  return { schema: SPEC_READ_SCHEMA, role, riskProfile, profile, requiredSections, relevantSections: relevant };
}
export function receiptHash(receipt) { return sha256(Buffer.from(canonicalJson(receipt), 'utf8')); }
export function fullReadSessionHash(session) { return sha256(Buffer.from(canonicalJson(session), 'utf8')); }
function requireRfc3339Utc(value, field) {
  requireString(value, field);
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)Z$/);
  if (!match) fail(`${field} must be an RFC 3339 UTC timestamp at whole-second precision (no leap second or 24:00)`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const daysInMonth = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) fail(`${field} must name a real UTC calendar instant`);
}
function requireCurrentReuseContext(value) {
  requireExactKeys(value, ['currentAgentIdentity', 'currentContextSessionId', 'currentContextState'], 'currentReuseContext');
  requireString(value.currentAgentIdentity, 'currentReuseContext.currentAgentIdentity');
  requireString(value.currentContextSessionId, 'currentReuseContext.currentContextSessionId');
  if (value.currentContextState !== 'continuous') fail('currentReuseContext.currentContextState must be continuous; unknown or compacted context cannot be reused');
  return value;
}
export function checkFullReadSession({ root = repositoryRoot(), session }) {
  requireExactKeys(session, ['schema', 'agentIdentity', 'contextSessionId', 'contextState', 'specSha256', 'readmeSha256', 'openRegistrySha256', 'fullReadReceipt', 'createdAt'], 'fullReadSession');
  if (session.schema !== SPEC_FULL_READ_SESSION_SCHEMA) fail(`fullReadSession.schema must be ${SPEC_FULL_READ_SESSION_SCHEMA}`);
  requireString(session.agentIdentity, 'fullReadSession.agentIdentity');
  requireString(session.contextSessionId, 'fullReadSession.contextSessionId');
  if (session.contextState !== 'continuous') fail('fullReadSession.contextState must be continuous; unknown or compacted context cannot be reused');
  requireCurrentSpecHash(root, session.specSha256);
  if (session.readmeSha256 !== currentReadmeHash(root)) fail('fullReadSession.readmeSha256 does not match docs/README.md');
  if (session.openRegistrySha256 !== openRegistryHash(root)) fail('fullReadSession.openRegistrySha256 does not match the current OPEN registry');
  requireRfc3339Utc(session.createdAt, 'fullReadSession.createdAt');
  if (!isPlainObject(session.fullReadReceipt) || session.fullReadReceipt.schema !== SPEC_READ_SCHEMA) fail('fullReadSession.fullReadReceipt must be a v1 full-read receipt');
  const checked = checkReadReceipt({ root, receipt: session.fullReadReceipt });
  if (session.fullReadReceipt.profile !== 'FULL') fail('fullReadSession.fullReadReceipt must record FULL reading');
  return { sessionHash: fullReadSessionHash(session), receiptHash: checked.receiptHash };
}
export function checkReadReceipt({ root = repositoryRoot(), receipt, currentReuseContext }) {
  if (receipt?.schema === SPEC_READ_REUSE_SCHEMA) return checkReusedReadReceipt({ root, receipt, currentReuseContext });
  requireExactKeys(receipt, ['schema', 'taskId', 'role', 'specSha256', 'profile', 'riskProfile', 'relevantSections', 'requiredSections', 'readSections', 'reason'], 'receipt');
  if (receipt.schema !== SPEC_READ_SCHEMA) fail(`receipt.schema must be ${SPEC_READ_SCHEMA}`);
  requireString(receipt.taskId, 'receipt.taskId');
  const role = requireString(receipt.role, 'receipt.role');
  const riskProfile = requireString(receipt.riskProfile, 'receipt.riskProfile');
  const profile = requireString(receipt.profile, 'receipt.profile');
  const relevantSections = requireStringArray(receipt.relevantSections, 'receipt.relevantSections');
  const requiredSections = requireStringArray(receipt.requiredSections, 'receipt.requiredSections');
  const readSections = requireStringArray(receipt.readSections, 'receipt.readSections');
  requireString(receipt.reason, 'receipt.reason');
  requireCurrentSpecHash(root, receipt.specSha256);
  const plan = specReadPlan({ role, riskProfile, relevantSections });
  if (profile !== plan.profile) fail(`receipt.profile must be ${plan.profile} for role/risk`);
  if (!sameSet(requiredSections, plan.requiredSections)) fail('receipt.requiredSections does not match the required read plan');
  if (!requiredSections.every((section) => readSections.includes(section))) fail('receipt.readSections is missing a required section');
  return { receiptHash: receiptHash(receipt), requiredSections: plan.requiredSections };
}
function checkReusedReadReceipt({ root, receipt, currentReuseContext }) {
  requireExactKeys(receipt, ['schema', 'taskId', 'role', 'specSha256', 'profile', 'riskProfile', 'relevantSections', 'requiredSections', 'readSections', 'reason', 'reuseEvidence'], 'receipt');
  if (receipt.schema !== SPEC_READ_REUSE_SCHEMA) fail(`receipt.schema must be ${SPEC_READ_REUSE_SCHEMA}`);
  requireString(receipt.taskId, 'receipt.taskId');
  const role = requireString(receipt.role, 'receipt.role');
  const riskProfile = requireString(receipt.riskProfile, 'receipt.riskProfile');
  if (riskProfile !== 'workflow_docs_metadata') fail('reused full-read evidence is only valid for workflow_docs_metadata');
  if (receipt.profile !== 'REUSE_FULL') fail('reused full-read receipt.profile must be REUSE_FULL');
  const relevantSections = requireStringArray(receipt.relevantSections, 'receipt.relevantSections');
  const requiredSections = requireStringArray(receipt.requiredSections, 'receipt.requiredSections');
  const readSections = requireStringArray(receipt.readSections, 'receipt.readSections');
  requireString(receipt.reason, 'receipt.reason');
  requireCurrentSpecHash(root, receipt.specSha256);
  const scopedRequiredSections = [...new Set([...SCOPED_BASE_SECTIONS, ...relevantSections])];
  if (!sameSet(requiredSections, scopedRequiredSections) || !sameSet(readSections, scopedRequiredSections)) fail('reused full-read receipt must explicitly read every current scoped task section');
  requireExactKeys(receipt.reuseEvidence, ['session', 'sessionSha256', 'agentIdentity', 'contextSessionId'], 'receipt.reuseEvidence');
  const sessionResult = checkFullReadSession({ root, session: receipt.reuseEvidence.session });
  const current = requireCurrentReuseContext(currentReuseContext);
  if (receipt.reuseEvidence.sessionSha256 !== sessionResult.sessionHash) fail('reused full-read evidence sessionSha256 does not match its session');
  if (receipt.reuseEvidence.agentIdentity !== receipt.reuseEvidence.session.agentIdentity || receipt.reuseEvidence.contextSessionId !== receipt.reuseEvidence.session.contextSessionId) fail('reused full-read evidence must preserve the exact same agent and continuous context session identity');
  if (current.currentAgentIdentity !== receipt.reuseEvidence.session.agentIdentity || current.currentContextSessionId !== receipt.reuseEvidence.session.contextSessionId) fail('reused full-read evidence does not match the caller-provided current agent/context baseline');
  if (receipt.reuseEvidence.session.fullReadReceipt.role !== role) fail('reused full-read evidence cannot cross roles');
  return { receiptHash: receiptHash(receipt), requiredSections: scopedRequiredSections, sessionHash: sessionResult.sessionHash };
}
export function taskBriefHash(brief) { return sha256(Buffer.from(canonicalJson(brief), 'utf8')); }
function canonicalCommit(root, value, field) {
  requireString(value, field);
  if (!/^[0-9a-f]{40,64}$/i.test(value) || git(root, ['rev-parse', '--verify', `${value}^{commit}`]) === null) fail(`${field} must resolve to a commit`);
  return git(root, ['rev-parse', value]).toString('utf8').trim();
}
function validateIdentity(root, value, field, allowWorktree = false) {
  if (allowWorktree && value === 'WORKTREE') return 'WORKTREE';
  return canonicalCommit(root, value, field);
}
function stableHash(value) { return sha256(Buffer.from(canonicalJson(value), 'utf8')); }
function validationStatusPaths(root) {
  const porcelain = git(root, ['status', '--porcelain=v1', '-z']);
  if (porcelain === null) fail('Cannot read Git worktree status for validation');
  const records = porcelain.toString('utf8').split('\0');
  records.pop();
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== ' ') fail('Unsupported Git worktree status record for validation');
    const status = record.slice(0, 2);
    if (/[RC]/.test(status)) fail('Renamed or copied worktree paths cannot produce reusable validation evidence');
    paths.push(record.slice(3));
  }
  return paths;
}
function assertReusableValidationIsolation(root, brief, briefResult) {
  if (brief.preexistingOwnedPaths.length !== 0 || brief.preexistingUnownedChanges.length !== 0 || !['clean', 'clean_synced'].includes(brief.dirtyWorktreeDisposition)) fail('Reusable validation requires no preexisting owned or unowned worktree changes');
  const dirtyPaths = validationStatusPaths(root);
  if (briefResult.reviewedHead !== 'WORKTREE' && dirtyPaths.length !== 0) fail('Committed validation requires a fully clean worktree');
  if (briefResult.reviewedHead === 'WORKTREE' && dirtyPaths.some((repoPath) => !brief.ownedPaths.includes(repoPath))) fail('WORKTREE validation permits only TaskBrief owned-path changes');
  return dirtyPaths;
}
function validationArtifact(root, brief, briefResult, dirtyPaths) {
  if (briefResult.reviewedHead === 'WORKTREE') {
    const current = patchHash({ root, baseSha: briefResult.baseSha, ownedPaths: brief.ownedPaths });
    const manifestDirtyPaths = current.manifest.entries.filter((entry) => entry.state !== 'unchanged').map((entry) => entry.path);
    if (!sameSet(dirtyPaths, manifestDirtyPaths)) fail('WORKTREE validation status does not match the TaskBrief owned artifact manifest');
    return { artifactIdentity: { kind: 'worktree', commitSha: null, patchHash: current.patchHash }, inputIdentity: current.patchHash, relevantInputsHash: stableHash(current.manifest) };
  }
  const currentHead = git(root, ['rev-parse', 'HEAD'])?.toString('utf8').trim();
  if (currentHead !== briefResult.reviewedHead) fail('Committed validation requires the current clean HEAD to equal the verdict TaskBrief reviewedHead');
  const entries = brief.ownedPaths.map((repoPath) => {
    const entry = baseEntry(root, briefResult.reviewedHead, repoPath);
    if (!entry) return { path: repoPath, state: 'absent' };
    return { path: repoPath, state: 'present', mode: entry.mode, length: entry.bytes.length, contentSha256: sha256(entry.bytes) };
  }).sort((left, right) => compareUtf8(left.path, right.path));
  return {
    artifactIdentity: { kind: 'commit', commitSha: briefResult.reviewedHead, patchHash: null },
    inputIdentity: briefResult.reviewedHead,
    relevantInputsHash: stableHash({ baseSha: briefResult.baseSha, headSha: briefResult.reviewedHead, entries }),
  };
}
function dependencyLockHash(root) {
  const candidates = ['package-lock.json', 'npm-shrinkwrap.json', 'legacy-workspace/pnpm-lock.yaml'];
  const entries = candidates.filter((relative) => existsSync(path.join(root, relative))).map((relative) => ({ path: relative, contentSha256: sha256(readFileSync(path.join(root, relative))) }));
  return entries.length === 0 ? 'none' : stableHash(entries);
}
function installedDependencyHash(root) {
  const candidates = ['node_modules/.package-lock.json', 'node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml', 'legacy-workspace/node_modules/.modules.yaml'];
  const entries = candidates.filter((relative) => existsSync(path.join(root, relative))).map((relative) => ({ path: relative, contentSha256: sha256(readFileSync(path.join(root, relative))) }));
  return entries.length === 0 ? 'none' : stableHash(entries);
}
function resolveExecutable(root, executable) {
  const candidates = path.isAbsolute(executable)
    ? [executable]
    : (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry.length > 0).map((entry) => path.join(entry, executable));
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      if (lstatSync(resolved).isFile()) return resolved;
    } catch { /* Try the next PATH entry. */ }
  }
  fail(`Validation tool cannot be resolved from the current PATH: ${executable}`);
}
function toolchainIdentity(root, plan) {
  const requested = [...new Set(plan.map((entry) => entry.executable))].sort(compareUtf8);
  const tools = requested.map((executable) => {
    const resolvedPath = resolveExecutable(root, executable);
    const version = spawnSync(resolvedPath, ['--version'], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 });
    const versionText = `${version.stdout ?? ''}${version.stderr ?? ''}`.trim();
    if (version.status !== 0 || version.error || versionText.length === 0) fail(`Validation tool version cannot be determined before execution: ${executable}`);
    return { executable, resolvedPath, version: versionText };
  });
  const environment = {
    pathHash: sha256(Buffer.from(process.env.PATH ?? '', 'utf8')),
    executionEnvironmentHash: stableHash({ PATH: process.env.PATH ?? null, NODE_OPTIONS: process.env.NODE_OPTIONS ?? null, NODE_PATH: process.env.NODE_PATH ?? null, PNPM_HOME: process.env.PNPM_HOME ?? null, npm_config_userconfig: process.env.npm_config_userconfig ?? null }),
    installedDependencyHash: installedDependencyHash(root),
    platform: process.platform,
    arch: process.arch,
  };
  return { tools, environment, environmentIdentity: stableHash({ tools, environment }) };
}
function commandSpec(briefResult, brief, command) {
  const node = process.execPath;
  const script = SCRIPT_RELATIVE;
  const staticCommands = new Map([
    [`node ${script} --check-index`, [node, [script, '--check-index']]],
    [`node ${script} --check-policy`, [node, [script, '--check-policy']]],
    [`node --test ${script.replace('.mjs', '.test.mjs')}`, [node, ['--test', script.replace('.mjs', '.test.mjs')]]],
    ['npm run typecheck', ['npm', ['run', 'typecheck']]],
    ['npm run lint', ['npm', ['run', 'lint']]],
    ['npm test', ['npm', ['test']]],
    ['node --test tests/package-manager-boundaries.test.mjs', [node, ['--test', 'tests/package-manager-boundaries.test.mjs']]],
    ['pnpm --dir legacy-workspace install --frozen-lockfile', ['pnpm', ['--dir', 'legacy-workspace', 'install', '--frozen-lockfile']]],
    ["pnpm --dir legacy-workspace --filter '@tackle-forger/*' typecheck", ['pnpm', ['--dir', 'legacy-workspace', '--filter', '@tackle-forger/*', 'typecheck']]],
    ["pnpm --dir legacy-workspace --filter '@tackle-forger/*' lint", ['pnpm', ['--dir', 'legacy-workspace', '--filter', '@tackle-forger/*', 'lint']]],
    ["pnpm --dir legacy-workspace --filter '@tackle-forger/*' test", ['pnpm', ['--dir', 'legacy-workspace', '--filter', '@tackle-forger/*', 'test']]],
    ["pnpm --dir legacy-workspace --filter '@tackle-forger/*' build", ['pnpm', ['--dir', 'legacy-workspace', '--filter', '@tackle-forger/*', 'build']]],
  ]);
  if (staticCommands.has(command)) {
    const [executable, args] = staticCommands.get(command);
    return { command, executable, args };
  }
  if (isWorkflowWhitespaceCommand(command, briefResult.baseSha, brief.ownedPaths)) return { command, executable: node, args: [script, '--check-owned-whitespace', '--base', briefResult.baseSha, ...brief.ownedPaths.flatMap((owned) => ['--owned', owned])] };
  fail(`Validation command is not in the closed execution catalog: ${command}`);
}
export function validationExecutionPlan({ root = repositoryRoot(), brief, currentReuseContext }) {
  const briefResult = checkTaskBrief({ root, brief, currentReuseContext });
  if (briefResult.phase !== 'verdict') fail('Validation execution requires a verdict-phase TaskBrief');
  const commands = requireNonEmptyStringArray(brief.validationPlan.requiredCommands, 'TaskBrief.validationPlan.requiredCommands');
  const plan = commands.map((command) => commandSpec(briefResult, brief, command));
  const dirtyPaths = assertReusableValidationIsolation(root, brief, briefResult);
  const artifact = validationArtifact(root, brief, briefResult, dirtyPaths);
  const toolchain = toolchainIdentity(root, plan);
  const resolvedPlan = plan.map((entry) => ({ ...entry, executable: toolchain.tools.find((tool) => tool.executable === entry.executable).resolvedPath }));
  return {
    taskBriefSha256: briefResult.taskBriefSha256,
    artifact,
    reuseIdentity: {
      artifactIdentity: artifact.inputIdentity,
      relevantInputsHash: artifact.relevantInputsHash,
      dependencyLockHash: dependencyLockHash(root),
      commandContractHash: stableHash(resolvedPlan.map(({ command, executable, args }) => ({ command, executable, args }))),
      environmentIdentity: toolchain.environmentIdentity,
    },
    toolchain,
    commands: resolvedPlan,
  };
}
function failureDetail(result) {
  const output = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]).toString('utf8').trim();
  const detail = output.slice(0, 8192) || result.error?.message || `process exited ${result.status ?? 'without an exit status'}`;
  return detail;
}
export function runValidation({ root = repositoryRoot(), brief, currentReuseContext }) {
  const plan = validationExecutionPlan({ root, brief, currentReuseContext });
  const results = plan.commands.map(({ command, executable, args }) => {
    const started = new Date();
    const result = spawnSync(executable, args, { cwd: root, encoding: null, timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
    const durationMs = Math.max(0, Date.now() - started.getTime());
    const exitCode = result.status === 0 && !result.error ? 0 : (Number.isSafeInteger(result.status) && result.status >= 0 ? result.status : 1);
    return { command, inputIdentity: plan.artifact.inputIdentity, exitCode, result: exitCode === 0 ? 'PASS' : 'FAIL', timestamp: started.toISOString(), durationMs, failureDetail: exitCode === 0 ? null : failureDetail(result) };
  });
  return { schema: VALIDATION_SUMMARY_SCHEMA, runner: 'closed_command_catalog/v1', taskBriefSha256: plan.taskBriefSha256, artifactIdentity: plan.artifact.artifactIdentity, inputIdentity: plan.artifact.inputIdentity, reuseIdentity: plan.reuseIdentity, results };
}
function validateBriefNarrative(brief, { legacyTouched }) {
  requireString(brief.scope, 'TaskBrief.scope');
  requireNonEmptyStringArray(brief.acceptanceCriteria, 'TaskBrief.acceptanceCriteria');
  requireStringArray(brief.exclusions, 'TaskBrief.exclusions');
  if (!CHANGE_CLASS_MATRIX[brief.changeClass]) fail('TaskBrief.changeClass is invalid');
  requireNonEmptyStringArray(brief.allowedChanges, 'TaskBrief.allowedChanges');
  requireExactKeys(brief.riskDimensions, ['persistedData', 'historicalSnapshots', 'concurrency', 'authorization', 'externalSideEffects', 'userVisible'], 'TaskBrief.riskDimensions');
  if (Object.values(brief.riskDimensions).some((value) => typeof value !== 'boolean')) fail('TaskBrief.riskDimensions values must be boolean');
  requireExactKeys(brief.validationPlan, ['requiredCommands', 'requiredScenarios', 'intentionallyNotApplicable'], 'TaskBrief.validationPlan');
  const commands = requireStringArray(brief.validationPlan.requiredCommands, 'TaskBrief.validationPlan.requiredCommands');
  const scenarios = requireStringArray(brief.validationPlan.requiredScenarios, 'TaskBrief.validationPlan.requiredScenarios');
  const na = brief.validationPlan.intentionallyNotApplicable;
  if (!isPlainObject(na) || Object.values(na).some((reason) => typeof reason !== 'string' || reason.length === 0)) fail('TaskBrief.validationPlan.intentionallyNotApplicable must map each omitted item to a non-empty reason');
  const matrix = CHANGE_CLASS_MATRIX[brief.changeClass];
  const riskScenarios = requiredRiskScenarios(brief.riskDimensions);
  const nonWaivableScenarios = [...matrix.scenarios, ...riskScenarios];
  const allowedNa = new Set(CONDITIONAL_NA_CATALOG);
  for (const item of Object.keys(na)) {
    if (matrix.commands.includes(item)) fail(`TaskBrief.validationPlan command cannot be N/A: ${item}`);
    if (nonWaivableScenarios.includes(item)) fail(`TaskBrief.validationPlan scenario cannot be N/A: ${item}`);
  }
  if (Object.keys(na).some((item) => !allowedNa.has(item) || commands.includes(item) || scenarios.includes(item))) fail('TaskBrief.validationPlan.intentionallyNotApplicable contains unknown or duplicated item');
  if (brief.changeClass === 'workflow_metadata') {
    if (!Object.hasOwn(na, 'product_runtime_tests')) fail('workflow_metadata requires a product_runtime_tests N/A reason');
  } else if (Object.hasOwn(na, 'product_runtime_tests')) {
    fail('Non-workflow changeClass cannot mark product_runtime_tests N/A');
  }
  if (legacyTouched ? Object.hasOwn(na, 'legacy_workspace_ci') : !Object.hasOwn(na, 'legacy_workspace_ci')) fail(legacyTouched ? 'legacy workspace changes cannot mark legacy_workspace_ci N/A' : 'Non-legacy work requires a legacy_workspace_ci N/A reason');
  const allowedCommands = new Set([...matrix.commands, ...(legacyTouched ? LEGACY_WORKSPACE_COMMANDS : [])]);
  if (commands.some((item) => !allowedCommands.has(item) && !(brief.changeClass === 'workflow_metadata' && isWorkflowWhitespaceCommand(item, brief.baseSha, brief.ownedPaths))) || scenarios.some((item) => ![...matrix.scenarios, ...riskScenarios].includes(item))) fail('TaskBrief.validationPlan command/scenario is in the wrong collection');
  for (const item of matrix.commands) if (!commands.includes(item) && !Object.hasOwn(na, item)) fail(`TaskBrief.validationPlan omits required command: ${item}`);
  for (const item of nonWaivableScenarios) if (!scenarios.includes(item)) fail(`TaskBrief.validationPlan scenario cannot be N/A: ${item}`);
  for (const item of matrix.nonWaivableCommands ?? []) if (!commands.includes(item)) fail(`TaskBrief.validationPlan command cannot be N/A: ${item}`);
  if (legacyTouched) for (const item of LEGACY_WORKSPACE_COMMANDS) if (!commands.includes(item)) fail(`TaskBrief.validationPlan legacy workspace command cannot be N/A: ${item}`);
  if (brief.changeClass === 'persistence_migration' && !(brief.riskDimensions.persistedData || brief.riskDimensions.historicalSnapshots)) fail('persistence_migration requires persistedData or historicalSnapshots risk');
  if (brief.changeClass === 'authorization_shared_write' && !(brief.riskDimensions.authorization || brief.riskDimensions.concurrency)) fail('authorization_shared_write requires authorization or concurrency risk');
  if (brief.changeClass === 'external_side_effect' && !brief.riskDimensions.externalSideEffects) fail('external_side_effect requires externalSideEffects risk');
}
function requiredRiskScenarios(riskDimensions) {
  const scenarios = [];
  if (riskDimensions.persistedData || riskDimensions.historicalSnapshots) scenarios.push(...CHANGE_CLASS_MATRIX.persistence_migration.scenarios);
  if (riskDimensions.concurrency || riskDimensions.authorization) scenarios.push(...CHANGE_CLASS_MATRIX.authorization_shared_write.scenarios);
  if (riskDimensions.externalSideEffects) scenarios.push(...CHANGE_CLASS_MATRIX.external_side_effect.scenarios);
  if (riskDimensions.userVisible) scenarios.push('unified_visual_review_pending_or_completed');
  return [...new Set(scenarios)];
}
function isUserVisiblePath(repoPath) {
  return repoPath.startsWith('apps/web/') || repoPath.startsWith('packages/ui/') || repoPath.startsWith('legacy-workspace/apps/web/') || repoPath.startsWith('legacy-workspace/packages/ui/') || /\.(?:tsx|jsx|css|scss|sass|less|html)$/.test(repoPath);
}
function dynamicDiffCommand(baseSha, ownedPaths) { return `node ${SCRIPT_RELATIVE} --check-owned-whitespace --base ${baseSha} ${ownedPaths.flatMap((owned) => ['--owned', owned]).join(' ')}`; }
function legacyDynamicDiffCommand(baseSha, ownedPaths) { return `git diff --check ${baseSha} -- ${ownedPaths.join(' ')}`; }
function isWorkflowWhitespaceCommand(command, baseSha, ownedPaths) { return command === dynamicDiffCommand(baseSha, ownedPaths) || command === legacyDynamicDiffCommand(baseSha, ownedPaths); }
export function checkOwnedWhitespace({ root = repositoryRoot(), baseSha, ownedPaths }) {
  const manifest = buildPatchManifest({ root, baseSha, ownedPaths });
  for (const entry of manifest.entries) {
    if (entry.state === 'unchanged') continue;
    const args = entry.state === 'untracked'
      ? ['diff', '--no-index', '--check', '/dev/null', entry.path]
      : ['diff', '--check', manifest.baseSha, '--', entry.path];
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    // git diff --no-index returns 1 for an ordinary, clean difference. --check
    // emits diagnostics for whitespace errors, which is the only nonzero case we reject.
    if (result.error || (entry.state !== 'untracked' && result.status !== 0) || detail.length > 0) {
      const detailMessage = detail || result.error?.message || `git diff exited ${result.status}`;
      fail(`Owned whitespace check failed for ${entry.path}: ${detailMessage}`);
    }
  }
  return { baseSha: manifest.baseSha, checkedPaths: manifest.entries.filter((entry) => entry.state !== 'unchanged').map((entry) => entry.path) };
}
function sectionIdsFromNavigation(root) {
  return new Set(buildNavigationIndex(root).headings.map((heading) => heading.title.match(/^(\d+(?:\.\d+)*)(?:\.|\s)/)?.[1]).filter(Boolean));
}
export function openRegistryHash(root = repositoryRoot()) { return sha256(Buffer.from(canonicalJson(buildNavigationIndex(root).openRegistry), 'utf8')); }
function currentHead(root) {
  const head = git(root, ['rev-parse', 'HEAD'])?.toString('utf8').trim();
  if (!head || !/^[0-9a-f]{40}$/.test(head)) fail('Cannot resolve current exact Git HEAD');
  return head;
}
function requireCleanWorktree(root) {
  const status = git(root, ['status', '--porcelain=v1', '-z']);
  if (status === null || status.length !== 0) fail('Task preparation requires a clean worktree; preserve or isolate existing changes first');
}
function prepareInputKeys() {
  return ['schema', 'taskId', 'workflowMode', 'baseSha', 'scope', 'relevantSections', 'openDecisionApplicability', 'riskProfile', 'scopeHasRuntimeSemantics', 'changeClass', 'ownedPaths', 'acceptanceCriteria', 'exclusions', 'riskDimensions', 'coordinatorSpecReadReceipt'];
}
function defaultNaReasons(changeClass, legacyTouched) {
  const na = {};
  if (changeClass === 'workflow_metadata') na.product_runtime_tests = 'No product runtime code changes are owned by this TaskBrief.';
  if (!legacyTouched) na.legacy_workspace_ci = 'No legacy-workspace path is owned by this TaskBrief.';
  return na;
}
function prepareValidationPlan({ baseSha, ownedPaths, changeClass, riskDimensions }) {
  const matrix = CHANGE_CLASS_MATRIX[changeClass];
  if (!matrix) fail('Task preparation changeClass is unsupported');
  const legacyTouched = ownedPaths.some((owned) => owned.startsWith('legacy-workspace/'));
  const requiredCommands = [...matrix.commands];
  if (changeClass === 'workflow_metadata') requiredCommands.push(dynamicDiffCommand(baseSha, ownedPaths));
  if (legacyTouched) requiredCommands.push(...LEGACY_WORKSPACE_COMMANDS);
  const requiredScenarios = [...new Set([...matrix.scenarios, ...requiredRiskScenarios(riskDimensions)])];
  return { requiredCommands, requiredScenarios, intentionallyNotApplicable: defaultNaReasons(changeClass, legacyTouched) };
}
function validatePreparationRisk({ riskProfile, changeClass, riskDimensions, scopeHasRuntimeSemantics }) {
  if (riskProfile === 'unknown_high_risk') fail('Task preparation refuses unknown_high_risk; prepare an explicitly classified conservative TaskBrief instead');
  const required = {
    workflow_docs_metadata: { changeClasses: ['workflow_metadata'], runtime: false, dimensions: [] },
    runtime_product_domain: { changeClasses: ['typescript_api', 'domain_behavior'], runtime: true, dimensions: [] },
    durable_migration: { changeClasses: ['persistence_migration'], runtime: true, dimensions: ['persistedData|historicalSnapshots'] },
    concurrency_auth: { changeClasses: ['authorization_shared_write'], runtime: true, dimensions: ['concurrency|authorization'] },
    publication_export_external: { changeClasses: ['external_side_effect'], runtime: true, dimensions: ['externalSideEffects'] },
  }[riskProfile];
  if (!required) fail('Task preparation input.riskProfile is invalid');
  if (!required.changeClasses.includes(changeClass) || scopeHasRuntimeSemantics !== required.runtime) fail('Task preparation riskProfile/changeClass/runtime-semantics combination is unsupported');
  for (const dimension of required.dimensions) {
    const keys = dimension.split('|');
    if (!keys.some((key) => riskDimensions[key])) fail(`Task preparation ${riskProfile} requires risk dimension ${dimension}`);
  }
}
function prepareOwnedFilePath(root, baseSha, inputPath) {
  const validated = validatePath(root, inputPath);
  const before = baseEntry(root, baseSha, validated.path);
  const after = existsSync(validated.absolute) ? currentEntry(validated.absolute, validated.path) : null;
  if (!before && !after) {
    let parent = path.dirname(validated.absolute);
    while (parent !== root) {
      if (existsSync(parent)) {
        const stat = lstatSync(parent);
        if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`New owned path parent is unsafe: ${validated.path}`);
      }
      parent = path.dirname(parent);
    }
  }
  return validated.path;
}
/**
 * Builds only fields whose values are mechanically bound to the current repository.
 * The input intentionally carries every human/semantic decision; it is closed to avoid
 * silently treating a new decision as machine-owned metadata.
 */
export function prepareTaskBrief({ root = repositoryRoot(), input, currentReuseContext }) {
  requireExactKeys(input, prepareInputKeys(), 'Task preparation input');
  if (input.schema !== TASK_PREPARE_INPUT_SCHEMA) fail(`Task preparation input.schema must be ${TASK_PREPARE_INPUT_SCHEMA}`);
  requireCleanWorktree(root);
  const taskId = requireString(input.taskId, 'Task preparation input.taskId');
  const workflowMode = requireString(input.workflowMode, 'Task preparation input.workflowMode');
  if (!['local', 'issue', 'pull_request'].includes(workflowMode)) fail('Task preparation input.workflowMode is invalid');
  const baseSha = canonicalCommit(root, input.baseSha, 'Task preparation input.baseSha');
  const head = currentHead(root);
  if (workflowMode === 'local' && baseSha !== head) fail('Local task preparation requires baseSha to equal current HEAD');
  if (git(root, ['merge-base', '--is-ancestor', baseSha, head]) === null) fail('Task preparation input.baseSha must be an ancestor of current HEAD');
  const ownedPaths = requireNonEmptyStringArray(input.ownedPaths, 'Task preparation input.ownedPaths');
  const canonicalOwnedPaths = ownedPaths.map((item) => prepareOwnedFilePath(root, baseSha, item));
  if (new Set(canonicalOwnedPaths).size !== canonicalOwnedPaths.length) fail('Task preparation input.ownedPaths must be unique canonical repository paths');
  const relevantSections = requireNonEmptyStringArray(input.relevantSections, 'Task preparation input.relevantSections');
  const knownSections = sectionIdsFromNavigation(root);
  if (!relevantSections.every((section) => knownSections.has(section)) || !relevantSections.includes('20')) fail('Task preparation input.relevantSections must name current v3 sections and include 20');
  requireExactKeys(input.openDecisionApplicability, ['applicableIds', 'noApplicableReason'], 'Task preparation input.openDecisionApplicability');
  const applicableIds = requireStringArray(input.openDecisionApplicability.applicableIds, 'Task preparation input.openDecisionApplicability.applicableIds');
  const noApplicableReason = input.openDecisionApplicability.noApplicableReason;
  if (noApplicableReason !== null && (typeof noApplicableReason !== 'string' || noApplicableReason.length === 0)) fail('Task preparation input.openDecisionApplicability.noApplicableReason must be a non-empty string or null');
  const riskProfile = requireString(input.riskProfile, 'Task preparation input.riskProfile');
  if (typeof input.scopeHasRuntimeSemantics !== 'boolean') fail('Task preparation input.scopeHasRuntimeSemantics must be boolean');
  const changeClass = requireString(input.changeClass, 'Task preparation input.changeClass');
  if (!Object.hasOwn(CHANGE_CLASS_MATRIX, changeClass)) fail('Task preparation input.changeClass is unsupported');
  requireString(input.scope, 'Task preparation input.scope');
  requireNonEmptyStringArray(input.acceptanceCriteria, 'Task preparation input.acceptanceCriteria');
  requireNonEmptyStringArray(input.exclusions, 'Task preparation input.exclusions');
  requireExactKeys(input.riskDimensions, ['persistedData', 'historicalSnapshots', 'concurrency', 'authorization', 'externalSideEffects', 'userVisible'], 'Task preparation input.riskDimensions');
  if (Object.values(input.riskDimensions).some((value) => typeof value !== 'boolean')) fail('Task preparation input.riskDimensions values must be boolean');
  validatePreparationRisk({ riskProfile, changeClass, riskDimensions: input.riskDimensions, scopeHasRuntimeSemantics: input.scopeHasRuntimeSemantics });
  const registry = buildNavigationIndex(root).openRegistry;
  const checkedIds = registry.map((entry) => entry.id);
  if (!applicableIds.every((id) => checkedIds.includes(id))) fail('Task preparation input.openDecisionApplicability.applicableIds must be current OPEN ids');
  if ((applicableIds.length === 0) !== (noApplicableReason !== null)) fail('Task preparation input.openDecisionApplicability must give a no-applicable reason exactly when applicableIds is empty');
  const receipt = input.coordinatorSpecReadReceipt;
  checkReadReceipt({ root, receipt, currentReuseContext });
  if (receipt.taskId !== taskId || receipt.role !== 'coordinator' || receipt.specSha256 !== sha256(readFileSync(path.join(root, SPEC_RELATIVE))) || receipt.riskProfile !== riskProfile || !sameSet(receipt.relevantSections, relevantSections)) fail('Task preparation coordinatorSpecReadReceipt must bind the exact task, coordinator role, current spec, risk profile, and relevant sections');
  const brief = {
    schema: TASK_BRIEF_SCHEMA, taskId, workflowMode, phase: 'pre_dispatch', specSha256: receipt.specSha256,
    baseSha, reviewedHead: workflowMode === 'local' ? 'WORKTREE' : head, scope: input.scope, relevantSections,
    openDecisionCheck: { registrySha256: openRegistryHash(root), checkedIds, applicableIds, noApplicableReason },
    riskProfile, scopeHasRuntimeSemantics: input.scopeHasRuntimeSemantics, changeClass, allowedChanges: canonicalOwnedPaths,
    acceptanceCriteria: input.acceptanceCriteria, exclusions: input.exclusions, riskDimensions: input.riskDimensions,
    validationPlan: prepareValidationPlan({ baseSha, ownedPaths: canonicalOwnedPaths, changeClass, riskDimensions: input.riskDimensions }), specReadReceipts: [receipt],
    ownedPaths: canonicalOwnedPaths, preexistingOwnedPaths: [], preexistingUnownedChanges: [],
    dirtyWorktreeDisposition: workflowMode === 'local' ? 'clean' : 'clean_synced',
  };
  // Reuse the authoritative checker rather than duplicating its risk/path matrix.
  checkTaskBrief({ root, brief, currentReuseContext });
  return brief;
}
function validateOpenDecisionCheck(root, value, relevantSections) {
  requireExactKeys(value, ['registrySha256', 'checkedIds', 'applicableIds', 'noApplicableReason'], 'TaskBrief.openDecisionCheck');
  const checkedIds = requireStringArray(value.checkedIds, 'TaskBrief.openDecisionCheck.checkedIds');
  const applicableIds = requireStringArray(value.applicableIds, 'TaskBrief.openDecisionCheck.applicableIds');
  if (value.noApplicableReason !== null && (typeof value.noApplicableReason !== 'string' || value.noApplicableReason.length === 0)) fail('TaskBrief.openDecisionCheck.noApplicableReason must be a non-empty string or null');
  if (!relevantSections.includes('20')) fail('TaskBrief.relevantSections must include section 20 for OPEN decision checking');
  const registry = buildNavigationIndex(root).openRegistry;
  const actualIds = registry.map((entry) => entry.id);
  if (value.registrySha256 !== openRegistryHash(root) || !sameSet(checkedIds, actualIds)) fail('TaskBrief.openDecisionCheck must bind and check the complete current v3 OPEN registry');
  if (!applicableIds.every((id) => checkedIds.includes(id))) fail('TaskBrief.openDecisionCheck.applicableIds must be a checked OPEN subset');
  if (applicableIds.length === 0 && value.noApplicableReason === null) fail('TaskBrief.openDecisionCheck requires a reason when no checked OPEN decision applies');
  if (applicableIds.length > 0 && value.noApplicableReason !== null) fail('TaskBrief.openDecisionCheck.noApplicableReason is only allowed when applicableIds is empty');
}
export function buildOwnedBaselineManifest({ root = repositoryRoot(), baseSha, ownedPaths }) {
  const manifest = buildPatchManifest({ root, baseSha, ownedPaths });
  return { baseSha: manifest.baseSha, entries: manifest.entries, schemaVersion: OWNED_BASELINE_SCHEMA };
}
export function ownedBaselineHash(manifest) { return sha256(Buffer.from(canonicalJson(manifest), 'utf8')); }
function checkOwnedBaselineManifest({ root, manifest, baseSha, ownedPaths, preexistingOwnedPaths }) {
  requireExactKeys(manifest, ['schemaVersion', 'baseSha', 'entries'], 'preTaskOwnedBaselineManifest');
  if (manifest.schemaVersion !== OWNED_BASELINE_SCHEMA) fail(`preTaskOwnedBaselineManifest.schemaVersion must be ${OWNED_BASELINE_SCHEMA}`);
  const canonicalBase = canonicalCommit(root, manifest.baseSha, 'preTaskOwnedBaselineManifest.baseSha');
  if (canonicalBase !== baseSha) fail('preTaskOwnedBaselineManifest.baseSha must match TaskBrief.baseSha');
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== ownedPaths.length) fail('preTaskOwnedBaselineManifest.entries must cover exactly the owned paths');
  const paths = manifest.entries.map((entry, index) => {
    requireExactKeys(entry, ['path', 'state', 'mode', 'length', 'contentSha256'], `preTaskOwnedBaselineManifest.entries[${index}]`);
    const repoPath = requireString(entry.path, `preTaskOwnedBaselineManifest.entries[${index}].path`);
    if (validatePath(root, repoPath).path !== repoPath) fail(`preTaskOwnedBaselineManifest.entries[${index}].path is not canonical`);
    if (!['tracked_changed', 'untracked', 'unchanged', 'deleted'].includes(entry.state)) fail(`preTaskOwnedBaselineManifest.entries[${index}].state is invalid`);
    if (!['100644', '100755'].includes(entry.mode) || !Number.isInteger(entry.length) || entry.length < 0 || !/^[0-9a-f]{64}$/.test(entry.contentSha256 ?? '')) fail(`preTaskOwnedBaselineManifest.entries[${index}] has invalid file identity`);
    return repoPath;
  });
  const sortedPaths = [...paths].sort(compareUtf8);
  if (new Set(paths).size !== paths.length || !sameSet(paths, ownedPaths) || paths.some((item, index) => item !== sortedPaths[index])) fail('preTaskOwnedBaselineManifest.entries must UTF-8-sort, be unique, and exactly match owned paths');
  const derivedPreexisting = manifest.entries.filter((entry) => entry.state !== 'unchanged').map((entry) => entry.path);
  if (!sameSet(derivedPreexisting, preexistingOwnedPaths)) fail('preTaskOwnedBaselineManifest does not match preexistingOwnedPaths');
  return ownedBaselineHash(manifest);
}
export function checkTaskBrief({ root = repositoryRoot(), brief, currentReuseContext }) {
  if (!isPlainObject(brief)) fail('TaskBrief must be an object');
  if (brief.schema !== TASK_BRIEF_SCHEMA) fail(`TaskBrief.schema must be ${TASK_BRIEF_SCHEMA}`);
  const taskId = requireString(brief.taskId, 'TaskBrief.taskId');
  const workflowMode = requireString(brief.workflowMode, 'TaskBrief.workflowMode');
  const phase = requireString(brief.phase, 'TaskBrief.phase');
  if (!['pre_dispatch', 'verdict'].includes(phase)) fail('TaskBrief.phase must be pre_dispatch or verdict');
  if (!['local', 'issue', 'pull_request'].includes(workflowMode)) fail('TaskBrief.workflowMode must be local, issue, or pull_request');
  const baseKeys = ['schema', 'taskId', 'workflowMode', 'phase', 'specSha256', 'baseSha', 'reviewedHead', 'scope', 'relevantSections', 'openDecisionCheck', 'riskProfile', 'scopeHasRuntimeSemantics', 'changeClass', 'allowedChanges', 'acceptanceCriteria', 'exclusions', 'riskDimensions', 'validationPlan', 'specReadReceipts', 'ownedPaths', 'preexistingOwnedPaths', 'preexistingUnownedChanges', 'dirtyWorktreeDisposition'];
  const hasPreexistingOwned = workflowMode === 'local' && Array.isArray(brief.preexistingOwnedPaths) && brief.preexistingOwnedPaths.length > 0;
  requireExactKeys(brief, hasPreexistingOwned ? [...baseKeys, 'preTaskOwnedBaselineManifest', 'preTaskOwnedBaselineHash'] : baseKeys, 'TaskBrief');
  requireCurrentSpecHash(root, brief.specSha256);
  const baseSha = canonicalCommit(root, brief.baseSha, 'TaskBrief.baseSha');
  if (workflowMode !== 'local' && (!/^[0-9a-f]{40}$/.test(brief.reviewedHead ?? '') || !/^[0-9a-f]{40}$/.test(brief.baseSha ?? ''))) fail('Issue/PR TaskBrief baseSha and reviewedHead must be exact 40-hex commits');
  const reviewedHead = validateIdentity(root, brief.reviewedHead, 'TaskBrief.reviewedHead', true);
  if (workflowMode === 'local' && reviewedHead !== 'WORKTREE' && reviewedHead !== git(root, ['rev-parse', 'HEAD']).toString('utf8').trim()) fail('Local TaskBrief.reviewedHead must be the current HEAD or explicit WORKTREE');
  const ownedPaths = requireStringArray(brief.ownedPaths, 'TaskBrief.ownedPaths');
  const legacyTouched = ownedPaths.some((owned) => owned.startsWith('legacy-workspace/'));
  validateBriefNarrative(brief, { legacyTouched });
  const relevantSections = requireNonEmptyStringArray(brief.relevantSections, 'TaskBrief.relevantSections');
  const knownSections = sectionIdsFromNavigation(root);
  if (!relevantSections.every((section) => knownSections.has(section))) fail('TaskBrief.relevantSections contains a section absent from current v3 navigation');
  validateOpenDecisionCheck(root, brief.openDecisionCheck, relevantSections);
  const riskProfile = requireString(brief.riskProfile, 'TaskBrief.riskProfile');
  if (!['workflow_docs_metadata', 'runtime_product_domain', 'durable_migration', 'concurrency_auth', 'publication_export_external', 'unknown_high_risk'].includes(riskProfile)) fail('TaskBrief.riskProfile is invalid');
  if (typeof brief.scopeHasRuntimeSemantics !== 'boolean') fail('TaskBrief.scopeHasRuntimeSemantics must be boolean');
  if (riskProfile === 'workflow_docs_metadata' && brief.scopeHasRuntimeSemantics) fail('workflow_docs_metadata TaskBrief cannot claim runtime semantics');
  if (!sameSet(ownedPaths, brief.allowedChanges)) fail('TaskBrief.allowedChanges must UTF-8-set exactly equal ownedPaths');
  if (brief.changeClass === 'workflow_metadata') {
    if (riskProfile !== 'workflow_docs_metadata' || brief.scopeHasRuntimeSemantics) fail('workflow_metadata requires workflow_docs_metadata with no runtime semantics');
  } else if (riskProfile === 'workflow_docs_metadata' || !brief.scopeHasRuntimeSemantics) {
    fail('Non-workflow changeClass requires a non-workflow riskProfile and runtime semantics');
  }
  const classification = classifyOwnedPaths(ownedPaths);
  if (brief.changeClass === 'workflow_metadata' && !classification.scopedEligible) fail('workflow_metadata may own only scoped governance paths');
  if (!classification.scopedEligible && (!brief.scopeHasRuntimeSemantics || riskProfile === 'workflow_docs_metadata')) fail('TaskBrief owned paths require runtime/high-risk declaration and non-workflow riskProfile');
  if (ownedPaths.some(isUserVisiblePath) && !brief.riskDimensions.userVisible) fail('User-visible owned paths require userVisible risk');
  const dynamicDiff = dynamicDiffCommand(baseSha, ownedPaths);
  if (brief.changeClass === 'workflow_metadata' && !brief.validationPlan.requiredCommands.some((command) => isWorkflowWhitespaceCommand(command, baseSha, ownedPaths))) fail(`TaskBrief.validationPlan command cannot be N/A: ${dynamicDiff}`);
  const preexistingOwnedPaths = requireStringArray(brief.preexistingOwnedPaths, 'TaskBrief.preexistingOwnedPaths');
  requireStringArray(brief.preexistingUnownedChanges, 'TaskBrief.preexistingUnownedChanges');
  if (!preexistingOwnedPaths.every((item) => ownedPaths.includes(item))) fail('TaskBrief.preexistingOwnedPaths must be owned paths');
  const disposition = requireString(brief.dirtyWorktreeDisposition, 'TaskBrief.dirtyWorktreeDisposition');
  if (!Array.isArray(brief.specReadReceipts) || brief.specReadReceipts.length === 0) fail('TaskBrief.specReadReceipts must be a non-empty array');
  const receiptHashes = brief.specReadReceipts.map((receipt) => {
    const checked = checkReadReceipt({ root, receipt, currentReuseContext });
    if (receipt.taskId !== taskId) fail('TaskBrief receipt taskId must match TaskBrief.taskId');
    if (receipt.specSha256 !== brief.specSha256) fail('TaskBrief receipt specSha256 must match TaskBrief.specSha256');
    if (receipt.riskProfile !== riskProfile || !sameSet(receipt.relevantSections, relevantSections)) fail('TaskBrief receipts must use TaskBrief riskProfile and relevantSections');
    if (['SCOPED', 'REUSE_FULL'].includes(receipt.profile) && (!classification.scopedEligible || riskProfile !== 'workflow_docs_metadata' || brief.scopeHasRuntimeSemantics)) fail('TaskBrief owned paths/risk/scope do not permit SCOPED or reused receipts');
    if ((riskProfile !== 'workflow_docs_metadata' || brief.scopeHasRuntimeSemantics) && receipt.profile !== 'FULL') fail('TaskBrief risk/scope requires FULL receipts');
    return checked.receiptHash;
  });
  const roles = brief.specReadReceipts.map((receipt) => receipt.role);
  if (phase === 'pre_dispatch' && (roles.length !== 1 || roles[0] !== 'coordinator')) fail('Pre-dispatch TaskBrief requires exactly one coordinator spec-read receipt');
  if (phase === 'verdict' && (!sameSet(roles, ['coordinator', 'coding', 'review']) || roles.length !== 3)) fail('Verdict-phase TaskBrief requires exactly one coordinator, coding, and review spec-read receipt');
  if (workflowMode === 'issue' || workflowMode === 'pull_request') {
    if (disposition !== 'clean_synced' || preexistingOwnedPaths.length !== 0) fail('Issue/PR TaskBrief requires clean_synced with no preexisting owned paths');
    const head = git(root, ['rev-parse', 'HEAD'])?.toString('utf8').trim();
    const porcelain = git(root, ['status', '--porcelain=v1', '-z']);
    if (!head || head !== reviewedHead || git(root, ['merge-base', '--is-ancestor', baseSha, reviewedHead]) === null) fail('Issue/PR TaskBrief clean_synced requires reviewedHead=current HEAD and baseSha to be its ancestor');
    if (porcelain === null || porcelain.length !== 0) fail('Issue/PR TaskBrief clean_synced requires an actually clean git status');
  } else if (preexistingOwnedPaths.length > 0) {
    if (disposition !== 'include_with_frozen_baseline') fail('Local TaskBrief with preexisting owned paths requires include_with_frozen_baseline');
    const actualBaselineHash = checkOwnedBaselineManifest({ root, manifest: brief.preTaskOwnedBaselineManifest, baseSha, ownedPaths, preexistingOwnedPaths });
    if (brief.preTaskOwnedBaselineHash !== actualBaselineHash) fail('Local TaskBrief preTaskOwnedBaselineHash must match its deterministic baseline manifest');
  } else if (!['clean', 'unowned_dirty_excluded'].includes(disposition)) {
    fail('Local TaskBrief without preexisting owned paths requires clean or unowned_dirty_excluded');
  }
  return { taskBriefSha256: taskBriefHash(brief), specReceiptHashes: [...receiptHashes].sort(compareUtf8), dirtyWorktreeDisposition: disposition, baseSha, reviewedHead, phase };
}
export function checkVerdict({ root = repositoryRoot(), verdict, brief, currentReuseContext }) {
  requireExactKeys(verdict, ['schema', 'taskId', 'taskBriefSha256', 'specReceiptHashes', 'dirtyWorktreeDisposition', 'specSha256', 'baseSha', 'reviewedHead', 'ownedPaths', 'artifactIdentity', 'verdict', 'findings'], 'verdict');
  if (verdict.schema !== VERDICT_SCHEMA) fail(`verdict.schema must be ${VERDICT_SCHEMA}`);
  const briefResult = checkTaskBrief({ root, brief, currentReuseContext });
  if (briefResult.phase !== 'verdict') fail('Verdict requires a verdict-phase TaskBrief');
  if (requireString(verdict.taskId, 'verdict.taskId') !== brief.taskId) fail('verdict.taskId must match TaskBrief.taskId');
  if (verdict.taskBriefSha256 !== briefResult.taskBriefSha256) fail('verdict.taskBriefSha256 must match TaskBrief');
  if (!Array.isArray(verdict.specReceiptHashes) || !sameSet(verdict.specReceiptHashes, briefResult.specReceiptHashes)) fail('verdict.specReceiptHashes must match TaskBrief receipt hashes');
  if (verdict.dirtyWorktreeDisposition !== briefResult.dirtyWorktreeDisposition) fail('verdict.dirtyWorktreeDisposition must match TaskBrief');
  if (verdict.specSha256 !== brief.specSha256) fail('verdict.specSha256 must match TaskBrief');
  if (canonicalCommit(root, verdict.baseSha, 'verdict.baseSha') !== briefResult.baseSha) fail('verdict.baseSha must match TaskBrief');
  if (validateIdentity(root, verdict.reviewedHead, 'verdict.reviewedHead', true) !== briefResult.reviewedHead) fail('verdict.reviewedHead must match TaskBrief (WORKTREE is explicit)');
  if (!sameSet(requireStringArray(verdict.ownedPaths, 'verdict.ownedPaths'), brief.ownedPaths)) fail('verdict.ownedPaths must match TaskBrief');
  requireExactKeys(verdict.artifactIdentity, ['kind', 'commitSha', 'patchHash'], 'verdict.artifactIdentity');
  const identityKind = requireString(verdict.artifactIdentity.kind, 'verdict.artifactIdentity.kind');
  let currentPatchHash = null;
  if (identityKind === 'commit') {
    if (canonicalCommit(root, verdict.artifactIdentity.commitSha, 'verdict.artifactIdentity.commitSha') !== briefResult.reviewedHead || verdict.reviewedHead === 'WORKTREE') fail('Committed verdict artifact identity must be the reviewed commit');
    if (verdict.artifactIdentity.patchHash !== null) fail('Committed verdict artifact identity must not require a patch hash');
  } else if (identityKind === 'worktree') {
    if (verdict.reviewedHead !== 'WORKTREE' || verdict.artifactIdentity.commitSha !== null) fail('Worktree verdict artifact identity must use WORKTREE without a commit SHA');
    currentPatchHash = patchHash({ root, baseSha: briefResult.baseSha, ownedPaths: brief.ownedPaths }).patchHash;
    if (verdict.artifactIdentity.patchHash !== currentPatchHash) fail('Worktree verdict patchHash must match the recomputed current patch hash');
  } else fail('verdict.artifactIdentity.kind must be commit or worktree');
  if (!['PASS', 'FINDINGS'].includes(verdict.verdict)) fail('verdict.verdict must be PASS or FINDINGS');
  if (!Array.isArray(verdict.findings)) fail('verdict.findings must be an array');
  verdict.findings.forEach((finding, index) => {
    requireExactKeys(finding, ['severity', 'file', 'line', 'evidence', 'remediation'], `verdict.findings[${index}]`);
    if (!['P0', 'P1', 'P2', 'P3'].includes(finding.severity) || typeof finding.line !== 'number' || !Number.isInteger(finding.line) || finding.line < 1) fail(`verdict.findings[${index}] has invalid severity or location`);
    requireString(finding.file, `verdict.findings[${index}].file`); requireString(finding.evidence, `verdict.findings[${index}].evidence`); requireString(finding.remediation, `verdict.findings[${index}].remediation`);
  });
  if (verdict.verdict === 'PASS' && verdict.findings.some((finding) => ['P0', 'P1', 'P2'].includes(finding.severity))) fail('PASS verdict cannot contain P0, P1, or P2 findings');
  return { artifactIdentity: verdict.artifactIdentity, taskBriefSha256: briefResult.taskBriefSha256 };
}
export function checkPolicy(root = repositoryRoot()) {
  const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const skill = readFileSync(path.join(root, '.codex/skills/tackle-agent-workflow/SKILL.md'), 'utf8');
  const yaml = readFileSync(path.join(root, '.codex/skills/tackle-agent-workflow/agents/openai.yaml'), 'utf8');
  const template = readFileSync(path.join(root, '.github/pull_request_template.md'), 'utf8');
  const boundedSection = (text, start, end) => {
    const from = text.indexOf(start);
    const to = text.indexOf(end, from + start.length);
    if (from < 0 || to < 0) fail(`Workflow policy drift: missing bounded section ${start}`);
    return { content: text.slice(from, to), outside: `${text.slice(0, from)}${text.slice(to)}` };
  };
  const policyMatches = [...agents.matchAll(/<!-- workflow-contract-policy\/v2\n([\s\S]*?)\n-->/g)];
  if (policyMatches.length !== 1) fail('Workflow policy drift: expected one canonical AGENTS policy block');
  let policy;
  try { policy = JSON.parse(policyMatches[0][1]); } catch { fail('Workflow policy drift: invalid canonical AGENTS policy JSON'); }
  const expectedPolicy = {
    dirtyIsolation: { issuePr: 'clean_synced', localOwnedBaseline: OWNED_BASELINE_SCHEMA },
    issue: { localReviewer: false, owner: 'agent-issue-loop', prReviewer: 'agent-pr-loop' },
    local: { independentReviewer: true, owner: 'tackle-agent-workflow' },
    localVerdict: { artifactIdentity: { committed: 'commit_sha_only', worktree: 'base_owned_paths_patch_hash' }, required: ['taskBriefSha256', 'specReceiptHashes', 'dirtyWorktreeDisposition', 'specSha256', 'baseSha', 'reviewedHead', 'ownedPaths', 'artifactIdentity'], schema: VERDICT_SCHEMA },
    pullRequest: { owner: 'agent-pr-loop', reviewer: 'agent-pr-loop' },
    reviewSeverity: { passBlocking: ['P0', 'P1', 'P2'], p3: 'informational' },
    scopedEligibility: { allowedPathClasses: ['AGENTS.md', '.codex/skills/tackle-agent-workflow/**', 'docs/(workflow|agent-governance)-*.md', '.github/*.md|yml|yaml'], unknownForcesFull: true },
    specReceipt: { schema: SPEC_READ_SCHEMA }, taskBrief: { allowedChangesEqualsOwnedPaths: true, closedSchema: true, conditionalNaApplicability: CONDITIONAL_NA_APPLICABILITY, conditionalNaCatalog: { legacyWorkspaceCi: 'legacy_workspace_ci', productRuntimeTests: 'product_runtime_tests' }, evidenceStages: { development: 'pre_dispatch_non_pr_final', localReviewHandoff: 'local_verdict', prFinal: 'pr_final_change_class' }, openDecisionCheck: true, phaseReceipts: { pre_dispatch: ['coordinator'], verdict: ['coordinator', 'coding', 'review'] }, receiptRiskAuthority: true, schema: TASK_BRIEF_SCHEMA, structuredFields: ['changeClass', 'allowedChanges', 'riskDimensions', 'validationPlan'] }, validationRunner: { closedCommandCatalog: true, formalVerdictEvidence: false, reusableWorktree: 'committed_clean_or_worktree_owned_manifest_only', reuseRequiresUnchanged: ['artifact', 'relevant_inputs', 'dependency_lock', 'command_contract', 'toolchain', 'path_and_execution_environment', 'installed_dependency_state'], schema: VALIDATION_SUMMARY_SCHEMA }, validationMatrix: { commandsAndScenariosSeparated: true, legacyWorkspaceCommands: LEGACY_WORKSPACE_COMMANDS, mandatoryWorkflowCommands: MANDATORY_WORKFLOW_COMMANDS, prFinalCommandsNonWaivable: ['npm run typecheck', 'npm run lint', 'npm test'], triggeredCannotBeNa: true, triggeredScenariosNonWaivable: true, userVisiblePathClassifier: 'tsx_jsx_css_scss_sass_less_html_and_ui_roots', userVisibleScenario: 'unified_visual_review_pending_or_completed', workflowMetadataDynamicDiff: true },
    visual: { minimalSmokeCompletesReview: false, pendingMarker: '视觉与交互统一检查待执行' },
  };
  if (canonicalJson(policy) !== canonicalJson(expectedPolicy)) fail('Workflow policy drift: canonical AGENTS policy differs');
  const expectedSkillTaskBriefRef = { conditionalNaApplicability: policy.taskBrief.conditionalNaApplicability, conditionalNaCatalog: policy.taskBrief.conditionalNaCatalog, evidenceStages: policy.taskBrief.evidenceStages, legacyWorkspaceCommands: policy.validationMatrix.legacyWorkspaceCommands, triggeredCannotBeNa: policy.validationMatrix.triggeredCannotBeNa };
  const skillTaskBrief = boundedSection(skill, '## Establish the TaskBrief', '## Spec receipts and worktree isolation');
  const skillTaskBriefMatches = [...skillTaskBrief.content.matchAll(/<!-- workflow-contract-task-brief-ref\/v1\n([\s\S]*?)\n-->/g)];
  if (skillTaskBriefMatches.length !== 1) fail('Workflow policy drift: Skill TaskBrief policy reference is missing or ambiguous');
  let skillTaskBriefRef;
  try { skillTaskBriefRef = JSON.parse(skillTaskBriefMatches[0][1]); } catch { fail('Workflow policy drift: Skill TaskBrief policy reference is invalid JSON'); }
  if (canonicalJson(skillTaskBriefRef) !== canonicalJson(expectedSkillTaskBriefRef)) fail('Workflow policy drift: Skill TaskBrief policy reference differs from AGENTS');
  const projectSkills = boundedSection(agents, '## 项目级 Agent Skills', '## Tackle 工作流契约');
  const expectedProjectTackle = '- 对本仓库中的实现、修复或重构，`$tackle-agent-workflow`为所有路由提供项目约束与 TaskBrief；只有本地路由使用其编码与独立本地审核。Issue 与 PR 路由仍分别遵循`$agent-issue-loop`和`$agent-pr-loop`；仓库的合并、发布和部署门禁不因项目级Skill存在而放宽。';
  if (!projectSkills.content.includes(expectedProjectTackle) || projectSkills.content.includes('`$tackle-agent-workflow`编排不同的编码与只读审核Agent')) fail('Workflow policy drift: broad project Skill statement differs');
  const agentsRouting = boundedSection(agents, '## Tackle 工作流契约', '## 本机凭据与多 worktree');
  if (!agentsRouting.content.includes(policyMatches[0][0])) fail('Workflow policy drift: AGENTS policy block is outside routing section');
  const expectedTaskBriefRole = '- `$tackle-agent-workflow`提供项目约束和 TaskBrief；仅本地路由使用其编码与独立本地审核。Issue 生命周期归`$agent-issue-loop`，PR 审核/CI/修复归`$agent-pr-loop`；已有 PR 直接使用后者。不得增加第二个独立审核者。';
  if (!agentsRouting.content.includes(expectedTaskBriefRole)) fail('Workflow policy drift: AGENTS TaskBrief role differs');
  const expectedRoute = expectedTaskBriefRole;
  const routeLines = agentsRouting.content.split(/\r?\n/).filter((line) => line.includes('Issue 生命周期') || /Issue\s*路由/.test(line));
  if (routeLines.length !== 1 || routeLines[0] !== expectedRoute) fail('Workflow policy drift: AGENTS route statement differs');
  const skillRouting = boundedSection(skill, '## Route before dispatch', '## Establish the TaskBrief');
  const expectedSkillRoutes = [
    '- **Local implementation, no Issue or PR:** this Skill owns one coding agent and one independent local reviewer.',
    '- **Issue delivery:** `$agent-issue-loop` owns Issue, branch, PR, closure, and handoff. Supply it this Skill\'s TaskBrief; do not start a local independent reviewer. Once a PR exists, `$agent-pr-loop` exclusively owns review, CI, fixes, and merge gates.',
    '- **Existing PR:** invoke `$agent-pr-loop` directly and supply the TaskBrief. Do not create a coding or review loop here.',
  ];
  for (const route of expectedSkillRoutes) if (!skillRouting.content.includes(route)) fail('Workflow policy drift: Skill route statement differs');
  const skillRouteRemainder = expectedSkillRoutes.reduce((remaining, route) => remaining.replace(route, ''), skillRouting.content);
  if (!skill.includes('<!-- workflow-contract-policy-ref: AGENTS.md/workflow-contract-policy/v2 -->')) fail('Workflow policy drift: Skill does not reference AGENTS policy');
  const expectedYaml = 'interface:\n  display_name: "Tackle Agent Workflow"\n  short_description: "Prepare scoped work and locally review implementation"\n  default_prompt: "Use $tackle-agent-workflow to prepare the TaskBrief, choose the correct local, Issue, or PR route, and run only the applicable workflow. Preserve the pending unified visual-review marker unless full visual work is explicitly scoped."';
  if (yaml.trimEnd() !== expectedYaml) fail('Workflow policy drift: openai.yaml is not aligned');
  const visual = boundedSection(template, '## Visual evidence', '## Risks, recovery, and rollback');
  const unified = visual.content.match(/^\| Unified visual and interaction review \| (.+) \|$/m)?.[1];
  const smoke = visual.content.match(/^\| Minimal render smoke \| (.+) \|$/m)?.[1];
  if (!unified?.includes(policy.visual.pendingMarker) || !unified.includes('Full visual and interaction review completed') || !smoke?.includes('never changes the unified-review status')) fail('Workflow policy drift: PR visual fields are not aligned');
  const contradictions = [
    [agentsRouting.content.replace(expectedRoute, '').replace(expectedTaskBriefRole, ''), /(?:Issue\s*路由|PR\s*路由|本地\s*路由)[^\n]*(?:审核|reviewer|review)/i],
    [agentsRouting.outside, /Issue\s*路由[^\n]*(?:审核|reviewer|review|独立审核者)/i],
    [projectSkills.content.replace(expectedProjectTackle, ''), /tackle-agent-workflow[^\n]*(?:编码与只读审核Agent|独立审核)/i],
    [skillRouteRemainder, /(?:Issue\s*路由|Issue delivery|Existing PR)[^\n]*(?:local independent reviewer|本地独立审核者|tackle-agent-workflow[^\n]*review)/i],
    [skillRouting.outside, /(?:Issue\s*路由|Issue delivery|Existing PR)[^\n]*(?:local independent reviewer|本地独立审核者|tackle-agent-workflow[^\n]*review)/i],
    [visual.content, /(?:Minimal render smoke|最小渲染)[^\n]*(?:replaces|completes|removes|clears|替代|完成)[^\n]*(?:unified|pending|visual|视觉)/i],
    [visual.outside, /(?:Minimal render smoke|最小渲染)[^\n]*(?:replaces|completes|removes|clears|替代|完成)[^\n]*(?:unified|pending|visual|视觉)/i],
  ];
  for (const [text, forbidden] of contradictions) if (forbidden.test(text)) fail(`Workflow policy drift: contradictory normative text (${forbidden})`);
  return true;
}
function usage() {
  return `Usage:\n  node ${SCRIPT_RELATIVE} --generate-index\n  node ${SCRIPT_RELATIVE} --check-index\n  node ${SCRIPT_RELATIVE} --check-policy\n  node ${SCRIPT_RELATIVE} --prepare-task-brief --input <semantic-input.json> [--current-agent-identity <id> --current-context-session-id <id> --current-context-state continuous]\n  node ${SCRIPT_RELATIVE} --check-owned-whitespace --base <sha> --owned <repo-relative-path> [--owned <path> ...]\n  node ${SCRIPT_RELATIVE} --spec-read-plan --role <coordinator|coding|review> --risk <risk-profile> [--relevant <v3-section> ...]\n  node ${SCRIPT_RELATIVE} --check-read-receipt --receipt <receipt.json> [--current-agent-identity <id> --current-context-session-id <id> --current-context-state continuous]\n  node ${SCRIPT_RELATIVE} --check-full-read-session --session <session.json>\n  node ${SCRIPT_RELATIVE} --check-task-brief --brief <task-brief.json> [--current-agent-identity <id> --current-context-session-id <id> --current-context-state continuous]\n  node ${SCRIPT_RELATIVE} --owned-baseline --base <sha> --owned <repo-relative-path> [--owned <path> ...]\n  node ${SCRIPT_RELATIVE} --run-validation --brief <verdict-task-brief.json> [--current-agent-identity <id> --current-context-session-id <id> --current-context-state continuous]\n  node ${SCRIPT_RELATIVE} --check-verdict --verdict <verdict.json> --brief <task-brief.json> [--current-agent-identity <id> --current-context-session-id <id> --current-context-state continuous]\n  node ${SCRIPT_RELATIVE} --patch-hash --base <sha> --owned <repo-relative-path> [--owned <path> ...]`;
}
function parseActionOptions(argv, action, allowed, required = []) {
  if (argv[0] !== action) fail(usage());
  const values = Object.fromEntries(Object.keys(allowed).map((key) => [key, []]));
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!Object.hasOwn(allowed, flag) || index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail(usage());
    values[flag].push(argv[index + 1]);
  }
  for (const flag of Object.keys(allowed)) if (!allowed[flag] && values[flag].length > 1) fail(usage());
  for (const flag of required) if (values[flag].length !== 1) fail(usage());
  return values;
}
export function runCli(argv = process.argv.slice(2), cwd = process.cwd()) {
  const action = argv[0];
  if (!['--generate-index', '--check-index', '--check-policy', '--prepare-task-brief', '--check-owned-whitespace', '--spec-read-plan', '--check-read-receipt', '--check-full-read-session', '--check-task-brief', '--owned-baseline', '--run-validation', '--check-verdict', '--patch-hash'].includes(action)) fail(usage());
  const root = repositoryRoot(cwd);
  if (action === '--generate-index' || action === '--check-index' || action === '--check-policy') {
    if (argv.length !== 1) fail(usage());
    if (action === '--generate-index') { writeNavigationIndex(root); return 'Generated navigation index'; }
    if (action === '--check-index') { checkNavigationIndex(root); return 'Navigation index is current'; }
    checkPolicy(root); return 'Workflow policy is consistent';
  }
  if (action === '--prepare-task-brief') {
    const values = parseActionOptions(argv, action, { '--input': false, '--current-agent-identity': false, '--current-context-session-id': false, '--current-context-state': false }, ['--input']);
    const currentReuseContext = values['--current-agent-identity'].length === 0 && values['--current-context-session-id'].length === 0 && values['--current-context-state'].length === 0 ? undefined : {
      currentAgentIdentity: values['--current-agent-identity'][0], currentContextSessionId: values['--current-context-session-id'][0], currentContextState: values['--current-context-state'][0],
    };
    return JSON.stringify(prepareTaskBrief({ root, input: readJsonFile(path.resolve(cwd, values['--input'][0]), 'Task preparation input'), currentReuseContext }), null, 2);
  }
  if (action === '--check-owned-whitespace') {
    const values = parseActionOptions(argv, action, { '--base': false, '--owned': true }, ['--base']);
    if (values['--owned'].length === 0) fail(usage());
    return JSON.stringify(checkOwnedWhitespace({ root, baseSha: values['--base'][0], ownedPaths: values['--owned'] }), null, 2);
  }
  if (action === '--spec-read-plan') {
    const values = parseActionOptions(argv, action, { '--role': false, '--risk': false, '--relevant': true }, ['--role', '--risk']);
    return JSON.stringify(specReadPlan({ role: values['--role'][0], riskProfile: values['--risk'][0], relevantSections: values['--relevant'] }), null, 2);
  }
  if (action === '--check-read-receipt') {
    const values = parseActionOptions(argv, action, { '--receipt': false, '--current-agent-identity': false, '--current-context-session-id': false, '--current-context-state': false }, ['--receipt']);
    const currentReuseContext = values['--current-agent-identity'].length === 0 && values['--current-context-session-id'].length === 0 && values['--current-context-state'].length === 0 ? undefined : {
      currentAgentIdentity: values['--current-agent-identity'][0], currentContextSessionId: values['--current-context-session-id'][0], currentContextState: values['--current-context-state'][0],
    };
    return JSON.stringify(checkReadReceipt({ root, receipt: readJsonFile(path.resolve(cwd, values['--receipt'][0]), 'receipt'), currentReuseContext }), null, 2);
  }
  if (action === '--check-full-read-session') {
    const values = parseActionOptions(argv, action, { '--session': false }, ['--session']);
    return JSON.stringify(checkFullReadSession({ root, session: readJsonFile(path.resolve(cwd, values['--session'][0]), 'full read session') }), null, 2);
  }
  if (action === '--check-task-brief') {
    const values = parseActionOptions(argv, action, { '--brief': false, '--current-agent-identity': false, '--current-context-session-id': false, '--current-context-state': false }, ['--brief']);
    const currentReuseContext = values['--current-agent-identity'].length === 0 && values['--current-context-session-id'].length === 0 && values['--current-context-state'].length === 0 ? undefined : {
      currentAgentIdentity: values['--current-agent-identity'][0], currentContextSessionId: values['--current-context-session-id'][0], currentContextState: values['--current-context-state'][0],
    };
    return JSON.stringify(checkTaskBrief({ root, brief: readJsonFile(path.resolve(cwd, values['--brief'][0]), 'TaskBrief'), currentReuseContext }), null, 2);
  }
  if (action === '--run-validation') {
    const values = parseActionOptions(argv, action, { '--brief': false, '--current-agent-identity': false, '--current-context-session-id': false, '--current-context-state': false }, ['--brief']);
    const currentReuseContext = values['--current-agent-identity'].length === 0 && values['--current-context-session-id'].length === 0 && values['--current-context-state'].length === 0 ? undefined : {
      currentAgentIdentity: values['--current-agent-identity'][0], currentContextSessionId: values['--current-context-session-id'][0], currentContextState: values['--current-context-state'][0],
    };
    return JSON.stringify(runValidation({ root, brief: readJsonFile(path.resolve(cwd, values['--brief'][0]), 'verdict TaskBrief'), currentReuseContext }), null, 2);
  }
  if (action === '--check-verdict') {
    const values = parseActionOptions(argv, action, { '--verdict': false, '--brief': false, '--current-agent-identity': false, '--current-context-session-id': false, '--current-context-state': false }, ['--verdict', '--brief']);
    const currentReuseContext = values['--current-agent-identity'].length === 0 && values['--current-context-session-id'].length === 0 && values['--current-context-state'].length === 0 ? undefined : {
      currentAgentIdentity: values['--current-agent-identity'][0], currentContextSessionId: values['--current-context-session-id'][0], currentContextState: values['--current-context-state'][0],
    };
    return JSON.stringify(checkVerdict({ root, verdict: readJsonFile(path.resolve(cwd, values['--verdict'][0]), 'verdict'), brief: readJsonFile(path.resolve(cwd, values['--brief'][0]), 'TaskBrief'), currentReuseContext }), null, 2);
  }
  const values = parseActionOptions(argv, action, { '--base': false, '--owned': true }, ['--base']);
  if (values['--owned'].length === 0) fail(usage());
  const result = action === '--owned-baseline'
    ? buildOwnedBaselineManifest({ root, baseSha: values['--base'][0], ownedPaths: values['--owned'] })
    : patchHash({ root, baseSha: values['--base'][0], ownedPaths: values['--owned'] });
  return JSON.stringify(result, null, 2);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${runCli()}\n`); }
  catch (error) { process.stderr.write(`workflow-contract: ${error.message}\n`); process.exitCode = 1; }
}
