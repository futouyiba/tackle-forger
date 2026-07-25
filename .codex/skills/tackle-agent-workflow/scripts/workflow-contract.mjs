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
function compareUtf8(left, right) { return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')); }
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
  lines.forEach((line, index) => {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) headings.push({ line: index + 1, level: heading[1].length, title: heading[2] });
    const open = line.match(/^\|\s*(OPEN-\d+)\b[^|]*\|[^|]*\|\s*`?([^|`]+?)`?\s*\|/);
    if (open) openRegistry.push({ id: open[1], status: open[2].trim(), line: index + 1, raw: line });
  });
  return { format: 'tackle-v3-navigation/v1', nonAuthoritative: true, openRegistry, source: { path: SPEC_RELATIVE, sha256: sha256(Buffer.from(source, 'utf8')) }, headings };
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
  const policyMatches = [...agents.matchAll(/<!-- workflow-contract-policy\/v1\n([\s\S]*?)\n-->/g)];
  if (policyMatches.length !== 1) fail('Workflow policy drift: expected one canonical AGENTS policy block');
  let policy;
  try { policy = JSON.parse(policyMatches[0][1]); } catch { fail('Workflow policy drift: invalid canonical AGENTS policy JSON'); }
  const expectedPolicy = {
    issue: { localReviewer: false, owner: 'agent-issue-loop', prReviewer: 'agent-pr-loop' },
    local: { independentReviewer: true, owner: 'tackle-agent-workflow' },
    pullRequest: { owner: 'agent-pr-loop', reviewer: 'agent-pr-loop' },
    visual: { minimalSmokeCompletesReview: false, pendingMarker: '视觉与交互统一检查待执行' },
  };
  if (canonicalJson(policy) !== canonicalJson(expectedPolicy)) fail('Workflow policy drift: canonical AGENTS policy differs');
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
  if (!skill.includes('<!-- workflow-contract-policy-ref: AGENTS.md/workflow-contract-policy/v1 -->')) fail('Workflow policy drift: Skill does not reference AGENTS policy');
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
  return `Usage:\n  node ${SCRIPT_RELATIVE} --generate-index\n  node ${SCRIPT_RELATIVE} --check-index\n  node ${SCRIPT_RELATIVE} --check-policy\n  node ${SCRIPT_RELATIVE} --patch-hash --base <sha> --owned <repo-relative-path> [--owned <path> ...]`;
}
export function runCli(argv = process.argv.slice(2), cwd = process.cwd()) {
  const actions = argv.filter((arg) => ['--generate-index', '--check-index', '--check-policy', '--patch-hash'].includes(arg));
  if (actions.length !== 1) fail(usage());
  const root = repositoryRoot(cwd);
  if (actions[0] === '--generate-index') { writeNavigationIndex(root); return 'Generated navigation index'; }
  if (actions[0] === '--check-index') { checkNavigationIndex(root); return 'Navigation index is current'; }
  if (actions[0] === '--check-policy') { checkPolicy(root); return 'Workflow policy is consistent'; }
  const baseIndex = argv.indexOf('--base');
  const ownedPaths = argv.flatMap((arg, index) => arg === '--owned' && argv[index + 1] ? [argv[index + 1]] : []);
  if (baseIndex < 0 || !argv[baseIndex + 1]) fail(usage());
  return JSON.stringify(patchHash({ root, baseSha: argv[baseIndex + 1], ownedPaths }), null, 2);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${runCli()}\n`); }
  catch (error) { process.stderr.write(`workflow-contract: ${error.message}\n`); process.exitCode = 1; }
}
