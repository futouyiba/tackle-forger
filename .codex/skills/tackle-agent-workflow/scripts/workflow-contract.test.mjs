import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPatchManifest, checkNavigationIndex, checkPolicy, patchHash, writeNavigationIndex } from './workflow-contract.mjs';

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
    write(root, 'docs/tackle-forger-development-spec-v3.md', '# Title\n\n## 20. Registry\n\n| ID | Type | Status |\n| --- | --- | --- |\n| OPEN-001 Test | x | `OPEN` |\n');
    writeNavigationIndex(root);
    assert.equal(checkNavigationIndex(root), true);
    write(root, 'docs/tackle-forger-development-spec-v3.md', '# Title changed\n');
    assert.throws(() => checkNavigationIndex(root), /Navigation index drift/);
  } finally { cleanup(root); }
});

test('policy checker detects required workflow markers', () => {
  const root = temporaryRepo();
  try {
    const project = '## 项目级 Agent Skills\n- 对本仓库中的实现、修复或重构，`$tackle-agent-workflow`为所有路由提供项目约束与 TaskBrief；只有本地路由使用其编码与独立本地审核。Issue 与 PR 路由仍分别遵循`$agent-issue-loop`和`$agent-pr-loop`；仓库的合并、发布和部署门禁不因项目级Skill存在而放宽。\n';
    const agents = `${project}\n## Tackle 工作流契约\n- \`$tackle-agent-workflow\`提供项目约束和 TaskBrief；仅本地路由使用其编码与独立本地审核。Issue 生命周期归\`$agent-issue-loop\`，PR 审核/CI/修复归\`$agent-pr-loop\`；已有 PR 直接使用后者。不得增加第二个独立审核者。\n<!-- workflow-contract-policy/v1\n{"issue":{"localReviewer":false,"owner":"agent-issue-loop","prReviewer":"agent-pr-loop"},"local":{"independentReviewer":true,"owner":"tackle-agent-workflow"},"pullRequest":{"owner":"agent-pr-loop","reviewer":"agent-pr-loop"},"visual":{"minimalSmokeCompletesReview":false,"pendingMarker":"视觉与交互统一检查待执行"}}\n-->\n## 本机凭据与多 worktree\n`;
    const skill = '<!-- workflow-contract-policy-ref: AGENTS.md/workflow-contract-policy/v1 -->\n\n## Route before dispatch\n\n- **Local implementation, no Issue or PR:** this Skill owns one coding agent and one independent local reviewer.\n- **Issue delivery:** `$agent-issue-loop` owns Issue, branch, PR, closure, and handoff. Supply it this Skill\'s TaskBrief; do not start a local independent reviewer. Once a PR exists, `$agent-pr-loop` exclusively owns review, CI, fixes, and merge gates.\n- **Existing PR:** invoke `$agent-pr-loop` directly and supply the TaskBrief. Do not create a coding or review loop here.\n\n## Establish the TaskBrief\n';
    const yaml = 'interface:\n  display_name: "Tackle Agent Workflow"\n  short_description: "Prepare scoped work and locally review implementation"\n  default_prompt: "Use $tackle-agent-workflow to prepare the TaskBrief, choose the correct local, Issue, or PR route, and run only the applicable workflow. Preserve the pending unified visual-review marker unless full visual work is explicitly scoped."\n';
    const template = '## Visual evidence\n\n| Unified visual and interaction review | 视觉与交互统一检查待执行 / Full visual and interaction review completed |\n| Minimal render smoke | Not run / Completed; this never changes the unified-review status |\n\n## Risks, recovery, and rollback\n';
    write(root, 'AGENTS.md', agents);
    write(root, '.codex/skills/tackle-agent-workflow/SKILL.md', skill);
    write(root, '.github/pull_request_template.md', template);
    write(root, '.codex/skills/tackle-agent-workflow/agents/openai.yaml', yaml);
    assert.equal(checkPolicy(root), true);
    write(root, 'AGENTS.md', `${agents.replace(project, '## 项目级 Agent Skills\n- 对本仓库中的实现、修复或重构，仍使用\`$tackle-agent-workflow\`编排不同的编码与只读审核Agent；仓库的合并、发布和部署门禁不因项目级Skill存在而放宽。\n')}`);
    assert.throws(() => checkPolicy(root), /broad project Skill statement differs/);
    write(root, 'AGENTS.md', agents);
    appendFileSync(path.join(root, 'AGENTS.md'), 'Issue 路由也必须再创建一个本地独立审核者。\n');
    assert.throws(() => checkPolicy(root), /Workflow policy drift/);
    write(root, 'AGENTS.md', agents);
    appendFileSync(path.join(root, '.codex/skills/tackle-agent-workflow/SKILL.md'), 'Issue delivery uses a local independent reviewer.\n');
    assert.throws(() => checkPolicy(root), /contradictory normative text/);
    write(root, '.codex/skills/tackle-agent-workflow/SKILL.md', skill);
    appendFileSync(path.join(root, '.codex/skills/tackle-agent-workflow/agents/openai.yaml'), 'Always inspect rendered UI for every route.\n');
    assert.throws(() => checkPolicy(root), /Workflow policy drift/);
    write(root, '.codex/skills/tackle-agent-workflow/agents/openai.yaml', yaml);
    appendFileSync(path.join(root, '.github/pull_request_template.md'), 'Minimal render smoke replaces the pending unified visual review.\n');
    assert.throws(() => checkPolicy(root), /Workflow policy drift/);
  } finally { cleanup(root); }
});
