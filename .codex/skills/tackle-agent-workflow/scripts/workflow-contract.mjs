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
const TASK_BRIEF_SCHEMA = 'tackle-task-brief/v1';
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
function sameSet(left, right) { return left.length === right.length && left.every((item) => right.includes(item)); }
function requireCurrentSpecHash(root, value) {
  const expected = sha256(readFileSync(path.join(root, SPEC_RELATIVE)));
  if (value !== expected) fail('specSha256 does not match the current canonical v3 specification');
  return expected;
}
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
export function checkReadReceipt({ root = repositoryRoot(), receipt }) {
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
function requireSha256OrNone(value, field, allowNone = false) {
  if ((allowNone && value === 'none') || /^[0-9a-f]{64}$/.test(value ?? '')) return value;
  fail(`${field} must be a lowercase SHA-256${allowNone ? ' or none' : ''}`);
}
function validateReuseIdentity(value, inputIdentity, field = 'validationEvidence.reuseIdentity') {
  requireExactKeys(value, ['artifactIdentity', 'relevantInputsHash', 'dependencyLockHash', 'commandContractHash', 'environmentIdentity'], field);
  if (value.artifactIdentity !== inputIdentity) fail(`${field}.artifactIdentity must match the validation input identity`);
  requireSha256OrNone(value.relevantInputsHash, `${field}.relevantInputsHash`);
  requireSha256OrNone(value.dependencyLockHash, `${field}.dependencyLockHash`, true);
  requireSha256OrNone(value.commandContractHash, `${field}.commandContractHash`);
  requireString(value.environmentIdentity, `${field}.environmentIdentity`);
  return value;
}
export function canReuseValidation(previous, current) {
  const previousIdentity = validateReuseIdentity(previous.reuseIdentity, previous.inputIdentity, 'previous.reuseIdentity');
  const currentIdentity = validateReuseIdentity(current.reuseIdentity, current.inputIdentity, 'current.reuseIdentity');
  return canonicalJson(previousIdentity) === canonicalJson(currentIdentity);
}
export function captureValidationSummary({ inputIdentity, reuseIdentity, results, timestamp = new Date().toISOString() }) {
  requireString(inputIdentity, 'capture.inputIdentity');
  validateReuseIdentity(reuseIdentity, inputIdentity, 'capture.reuseIdentity');
  if (!Array.isArray(results) || results.length === 0) fail('capture.results must be non-empty');
  if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) fail('capture.timestamp must be strict ISO-8601 UTC');
  return {
    schema: VALIDATION_SUMMARY_SCHEMA, inputIdentity, reuseIdentity,
    results: results.map((entry, index) => {
      requireExactKeys(entry, ['command', 'exitCode', 'durationMs', 'failureDetail'], `capture.results[${index}]`);
      requireString(entry.command, `capture.results[${index}].command`);
      if (!Number.isSafeInteger(entry.exitCode) || entry.exitCode < 0 || !Number.isSafeInteger(entry.durationMs) || entry.durationMs < 0) fail(`capture.results[${index}] has invalid exitCode or durationMs`);
      if (entry.exitCode === 0 && entry.failureDetail !== null) fail(`capture.results[${index}] successful command cannot have failure detail`);
      if (entry.exitCode !== 0 && (typeof entry.failureDetail !== 'string' || entry.failureDetail.length === 0)) fail(`capture.results[${index}] failed command requires failure detail`);
      return { command: entry.command, inputIdentity, exitCode: entry.exitCode, result: entry.exitCode === 0 ? 'PASS' : 'FAIL', timestamp, durationMs: entry.durationMs, failureDetail: entry.failureDetail };
    }),
  };
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
  const riskScenarios = [];
  if (brief.riskDimensions.persistedData || brief.riskDimensions.historicalSnapshots) riskScenarios.push(...CHANGE_CLASS_MATRIX.persistence_migration.scenarios);
  if (brief.riskDimensions.concurrency || brief.riskDimensions.authorization) riskScenarios.push(...CHANGE_CLASS_MATRIX.authorization_shared_write.scenarios);
  if (brief.riskDimensions.externalSideEffects) riskScenarios.push(...CHANGE_CLASS_MATRIX.external_side_effect.scenarios);
  if (brief.riskDimensions.userVisible) riskScenarios.push('unified_visual_review_pending_or_completed');
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
  if (commands.some((item) => !allowedCommands.has(item) && !(brief.changeClass === 'workflow_metadata' && /^git diff --check [0-9a-f]{40} -- .+$/.test(item))) || scenarios.some((item) => ![...matrix.scenarios, ...riskScenarios].includes(item))) fail('TaskBrief.validationPlan command/scenario is in the wrong collection');
  for (const item of matrix.commands) if (!commands.includes(item) && !Object.hasOwn(na, item)) fail(`TaskBrief.validationPlan omits required command: ${item}`);
  for (const item of nonWaivableScenarios) if (!scenarios.includes(item)) fail(`TaskBrief.validationPlan scenario cannot be N/A: ${item}`);
  for (const item of matrix.nonWaivableCommands ?? []) if (!commands.includes(item)) fail(`TaskBrief.validationPlan command cannot be N/A: ${item}`);
  if (legacyTouched) for (const item of LEGACY_WORKSPACE_COMMANDS) if (!commands.includes(item)) fail(`TaskBrief.validationPlan legacy workspace command cannot be N/A: ${item}`);
  if (brief.changeClass === 'persistence_migration' && !(brief.riskDimensions.persistedData || brief.riskDimensions.historicalSnapshots)) fail('persistence_migration requires persistedData or historicalSnapshots risk');
  if (brief.changeClass === 'authorization_shared_write' && !(brief.riskDimensions.authorization || brief.riskDimensions.concurrency)) fail('authorization_shared_write requires authorization or concurrency risk');
  if (brief.changeClass === 'external_side_effect' && !brief.riskDimensions.externalSideEffects) fail('external_side_effect requires externalSideEffects risk');
}
function isUserVisiblePath(repoPath) {
  return repoPath.startsWith('apps/web/') || repoPath.startsWith('packages/ui/') || repoPath.startsWith('legacy-workspace/apps/web/') || repoPath.startsWith('legacy-workspace/packages/ui/') || /\.(?:tsx|jsx|css|scss|sass|less|html)$/.test(repoPath);
}
function dynamicDiffCommand(baseSha, ownedPaths) { return `git diff --check ${baseSha} -- ${ownedPaths.join(' ')}`; }
function sectionIdsFromNavigation(root) {
  return new Set(buildNavigationIndex(root).headings.map((heading) => heading.title.match(/^(\d+(?:\.\d+)*)(?:\.|\s)/)?.[1]).filter(Boolean));
}
export function openRegistryHash(root = repositoryRoot()) { return sha256(Buffer.from(canonicalJson(buildNavigationIndex(root).openRegistry), 'utf8')); }
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
export function checkTaskBrief({ root = repositoryRoot(), brief }) {
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
  if (brief.changeClass === 'workflow_metadata' && !brief.validationPlan.requiredCommands.includes(dynamicDiff)) fail(`TaskBrief.validationPlan command cannot be N/A: ${dynamicDiff}`);
  const preexistingOwnedPaths = requireStringArray(brief.preexistingOwnedPaths, 'TaskBrief.preexistingOwnedPaths');
  requireStringArray(brief.preexistingUnownedChanges, 'TaskBrief.preexistingUnownedChanges');
  if (!preexistingOwnedPaths.every((item) => ownedPaths.includes(item))) fail('TaskBrief.preexistingOwnedPaths must be owned paths');
  const disposition = requireString(brief.dirtyWorktreeDisposition, 'TaskBrief.dirtyWorktreeDisposition');
  if (!Array.isArray(brief.specReadReceipts) || brief.specReadReceipts.length === 0) fail('TaskBrief.specReadReceipts must be a non-empty array');
  const receiptHashes = brief.specReadReceipts.map((receipt) => {
    const checked = checkReadReceipt({ root, receipt });
    if (receipt.taskId !== taskId) fail('TaskBrief receipt taskId must match TaskBrief.taskId');
    if (receipt.specSha256 !== brief.specSha256) fail('TaskBrief receipt specSha256 must match TaskBrief.specSha256');
    if (receipt.riskProfile !== riskProfile || !sameSet(receipt.relevantSections, relevantSections)) fail('TaskBrief receipts must use TaskBrief riskProfile and relevantSections');
    if (receipt.profile === 'SCOPED' && (!classification.scopedEligible || riskProfile !== 'workflow_docs_metadata' || brief.scopeHasRuntimeSemantics)) fail('TaskBrief owned paths/risk/scope do not permit SCOPED receipts');
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
export function checkVerdict({ root = repositoryRoot(), verdict, brief }) {
  requireExactKeys(verdict, ['schema', 'taskId', 'taskBriefSha256', 'specReceiptHashes', 'dirtyWorktreeDisposition', 'specSha256', 'baseSha', 'reviewedHead', 'ownedPaths', 'artifactIdentity', 'validationEvidence', 'verdict', 'findings'], 'verdict');
  if (verdict.schema !== VERDICT_SCHEMA) fail(`verdict.schema must be ${VERDICT_SCHEMA}`);
  const briefResult = checkTaskBrief({ root, brief });
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
  requireExactKeys(verdict.validationEvidence, ['schema', 'inputIdentity', 'reuseIdentity', 'results'], 'verdict.validationEvidence');
  if (verdict.validationEvidence.schema !== VALIDATION_SUMMARY_SCHEMA) fail(`verdict.validationEvidence.schema must be ${VALIDATION_SUMMARY_SCHEMA}`);
  if (verdict.validationEvidence.inputIdentity !== (identityKind === 'commit' ? verdict.artifactIdentity.commitSha : currentPatchHash)) fail('verdict.validationEvidence.inputIdentity must bind the reviewed artifact');
  validateReuseIdentity(verdict.validationEvidence.reuseIdentity, verdict.validationEvidence.inputIdentity);
  if (!Array.isArray(verdict.validationEvidence.results) || verdict.validationEvidence.results.length === 0) fail('verdict.validationEvidence.results must be non-empty');
  const requiredCommands = brief.validationPlan.requiredCommands;
  const summarizedCommands = verdict.validationEvidence.results.map((result) => result.command);
  if (!sameSet(summarizedCommands, requiredCommands)) fail('validationEvidence must cover each TaskBrief required command exactly once, with no unrelated command');
  verdict.validationEvidence.results.forEach((result, index) => {
    requireExactKeys(result, ['command', 'inputIdentity', 'exitCode', 'result', 'timestamp', 'durationMs', 'failureDetail'], `verdict.validationEvidence.results[${index}]`);
    requireString(result.command, `verdict.validationEvidence.results[${index}].command`);
    const parsedTimestamp = Date.parse(result.timestamp);
    if (result.inputIdentity !== verdict.validationEvidence.inputIdentity || !Number.isSafeInteger(result.exitCode) || result.exitCode < 0 || !['PASS', 'FAIL'].includes(result.result) || typeof result.timestamp !== 'string' || Number.isNaN(parsedTimestamp) || new Date(parsedTimestamp).toISOString() !== result.timestamp || parsedTimestamp > Date.now() + 5 * 60 * 1000 || !Number.isSafeInteger(result.durationMs) || result.durationMs < 0) fail(`verdict.validationEvidence.results[${index}] is invalid`);
    if (result.result === 'PASS' && (result.exitCode !== 0 || result.failureDetail !== null)) fail(`verdict.validationEvidence.results[${index}] PASS must have exit 0 and no failure detail`);
    if (result.result === 'FAIL' && (result.exitCode === 0 || typeof result.failureDetail !== 'string' || result.failureDetail.length === 0)) fail(`verdict.validationEvidence.results[${index}] FAIL must contain expandable failure detail`);
  });
  if (!['PASS', 'FINDINGS'].includes(verdict.verdict)) fail('verdict.verdict must be PASS or FINDINGS');
  if (!Array.isArray(verdict.findings)) fail('verdict.findings must be an array');
  verdict.findings.forEach((finding, index) => {
    requireExactKeys(finding, ['severity', 'file', 'line', 'evidence', 'remediation'], `verdict.findings[${index}]`);
    if (!['P0', 'P1', 'P2', 'P3'].includes(finding.severity) || typeof finding.line !== 'number' || !Number.isInteger(finding.line) || finding.line < 1) fail(`verdict.findings[${index}] has invalid severity or location`);
    requireString(finding.file, `verdict.findings[${index}].file`); requireString(finding.evidence, `verdict.findings[${index}].evidence`); requireString(finding.remediation, `verdict.findings[${index}].remediation`);
  });
  if (verdict.verdict === 'PASS' && (verdict.findings.some((finding) => ['P0', 'P1', 'P2'].includes(finding.severity)) || verdict.validationEvidence.results.some((result) => result.result === 'FAIL'))) fail('PASS verdict cannot contain P0, P1, P2 findings, or failed validation');
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
    localVerdict: { artifactIdentity: { committed: 'commit_sha_only', worktree: 'base_owned_paths_patch_hash' }, required: ['taskBriefSha256', 'specReceiptHashes', 'dirtyWorktreeDisposition', 'specSha256', 'baseSha', 'reviewedHead', 'ownedPaths', 'artifactIdentity', 'validationEvidence'], schema: VERDICT_SCHEMA },
    pullRequest: { owner: 'agent-pr-loop', reviewer: 'agent-pr-loop' },
    reviewSeverity: { passBlocking: ['P0', 'P1', 'P2'], p3: 'informational' },
    scopedEligibility: { allowedPathClasses: ['AGENTS.md', '.codex/skills/tackle-agent-workflow/**', 'docs/(workflow|agent-governance)-*.md', '.github/*.md|yml|yaml'], unknownForcesFull: true },
    specReceipt: { schema: SPEC_READ_SCHEMA }, taskBrief: { allowedChangesEqualsOwnedPaths: true, closedSchema: true, conditionalNaApplicability: CONDITIONAL_NA_APPLICABILITY, conditionalNaCatalog: { legacyWorkspaceCi: 'legacy_workspace_ci', productRuntimeTests: 'product_runtime_tests' }, evidenceStages: { development: 'pre_dispatch_non_pr_final', localReviewHandoff: 'local_verdict', prFinal: 'pr_final_change_class' }, openDecisionCheck: true, phaseReceipts: { pre_dispatch: ['coordinator'], verdict: ['coordinator', 'coding', 'review'] }, receiptRiskAuthority: true, schema: TASK_BRIEF_SCHEMA, structuredFields: ['changeClass', 'allowedChanges', 'riskDimensions', 'validationPlan'] }, validationEvidence: { automaticSummary: 'capture_validation_cli_no_command_execution', reuseRequiresUnchanged: ['version', 'relevant_inputs', 'dependency_lock', 'command_contract', 'environment_identity'], schema: VALIDATION_SUMMARY_SCHEMA }, validationMatrix: { commandsAndScenariosSeparated: true, legacyWorkspaceCommands: LEGACY_WORKSPACE_COMMANDS, mandatoryWorkflowCommands: MANDATORY_WORKFLOW_COMMANDS, prFinalCommandsNonWaivable: ['npm run typecheck', 'npm run lint', 'npm test'], triggeredCannotBeNa: true, triggeredScenariosNonWaivable: true, userVisiblePathClassifier: 'tsx_jsx_css_scss_sass_less_html_and_ui_roots', userVisibleScenario: 'unified_visual_review_pending_or_completed', workflowMetadataDynamicDiff: true },
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
  return `Usage:\n  node ${SCRIPT_RELATIVE} --generate-index\n  node ${SCRIPT_RELATIVE} --check-index\n  node ${SCRIPT_RELATIVE} --check-policy\n  node ${SCRIPT_RELATIVE} --spec-read-plan --role <coordinator|coding|review> --risk <risk-profile> [--relevant <v3-section> ...]\n  node ${SCRIPT_RELATIVE} --check-read-receipt --receipt <receipt.json>\n  node ${SCRIPT_RELATIVE} --check-task-brief --brief <task-brief.json>\n  node ${SCRIPT_RELATIVE} --owned-baseline --base <sha> --owned <repo-relative-path> [--owned <path> ...]\n  node ${SCRIPT_RELATIVE} --capture-validation --input <executed-results.json>\n  node ${SCRIPT_RELATIVE} --check-verdict --verdict <verdict.json> --brief <task-brief.json>\n  node ${SCRIPT_RELATIVE} --patch-hash --base <sha> --owned <repo-relative-path> [--owned <path> ...]`;
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
  if (!['--generate-index', '--check-index', '--check-policy', '--spec-read-plan', '--check-read-receipt', '--check-task-brief', '--owned-baseline', '--capture-validation', '--check-verdict', '--patch-hash'].includes(action)) fail(usage());
  const root = repositoryRoot(cwd);
  if (action === '--generate-index' || action === '--check-index' || action === '--check-policy') {
    if (argv.length !== 1) fail(usage());
    if (action === '--generate-index') { writeNavigationIndex(root); return 'Generated navigation index'; }
    if (action === '--check-index') { checkNavigationIndex(root); return 'Navigation index is current'; }
    checkPolicy(root); return 'Workflow policy is consistent';
  }
  if (action === '--spec-read-plan') {
    const values = parseActionOptions(argv, action, { '--role': false, '--risk': false, '--relevant': true }, ['--role', '--risk']);
    return JSON.stringify(specReadPlan({ role: values['--role'][0], riskProfile: values['--risk'][0], relevantSections: values['--relevant'] }), null, 2);
  }
  if (action === '--check-read-receipt') {
    const values = parseActionOptions(argv, action, { '--receipt': false }, ['--receipt']);
    return JSON.stringify(checkReadReceipt({ root, receipt: readJsonFile(path.resolve(cwd, values['--receipt'][0]), 'receipt') }), null, 2);
  }
  if (action === '--check-task-brief') {
    const values = parseActionOptions(argv, action, { '--brief': false }, ['--brief']);
    return JSON.stringify(checkTaskBrief({ root, brief: readJsonFile(path.resolve(cwd, values['--brief'][0]), 'TaskBrief') }), null, 2);
  }
  if (action === '--capture-validation') {
    const values = parseActionOptions(argv, action, { '--input': false }, ['--input']);
    const input = readJsonFile(path.resolve(cwd, values['--input'][0]), 'executed validation result input');
    requireExactKeys(input, ['inputIdentity', 'reuseIdentity', 'results', 'timestamp'], 'executed validation result input');
    return JSON.stringify(captureValidationSummary(input), null, 2);
  }
  if (action === '--check-verdict') {
    const values = parseActionOptions(argv, action, { '--verdict': false, '--brief': false }, ['--verdict', '--brief']);
    return JSON.stringify(checkVerdict({ root, verdict: readJsonFile(path.resolve(cwd, values['--verdict'][0]), 'verdict'), brief: readJsonFile(path.resolve(cwd, values['--brief'][0]), 'TaskBrief') }), null, 2);
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
