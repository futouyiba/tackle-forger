#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const mirrorPath = path.join(root, 'docs/tackle-forger-development-spec-v3.md');
const moduleDir = path.join(root, 'docs/spec-v3');
const manifestPath = path.join(moduleDir, 'manifest.json');

const modules = [
  { id: '00', file: '00-authority.md', sections: ['0'], title: '权威、固定原则与禁止事项' },
  { id: '01', file: '01-product-foundations.md', sections: ['1', '2', '3', '4', '5'], title: '产品范围、术语、生成顺序与结构匹配' },
  { id: '02', file: '02-product-model.md', sections: ['6', '7', '8'], title: 'Collection、Series、SKU、Model 与 Patch' },
  { id: '03', file: '03-rules-and-validation.md', sections: ['9', '10', '11', '12', '13'], title: '兼容、数值、词条、品质与校验' },
  { id: '04', file: '04-persistence-and-lifecycle.md', sections: ['14', '15', '16', '17', '18'], title: '版本、快照、飞书、工作区与回归' },
  { id: '05', file: '05-open-decisions.md', sections: ['19', '20'], title: 'Agent 检查表与未决事项登记表' },
  { id: '06', file: '06-visualization-and-ai.md', sections: ['21', '22', '23'], title: '五维图、比较、甘特图与 AI 建议' },
  { id: '07', file: '07-interaction-contract.md', sections: ['24'], title: '交互与后端统一需求契约' },
  { id: '08', file: '08-deployment-and-export.md', sections: ['25'], title: '内网部署、身份与配置表交付' },
];

const routes = {
  ai: ['00', '05', '06', '07'],
  authorization: ['00', '04', '05', '07', '08'],
  compatibility: ['00', '01', '02', '03', '05'],
  deployment: ['00', '04', '05', '08'],
  export: ['00', '04', '05', '08'],
  feishu: ['00', '03', '04', '05', '07'],
  five_axis: ['00', '05', '06', '07', '08'],
  generation: ['00', '01', '02', '03', '05'],
  migration: ['00', '02', '03', '04', '05'],
  model_series_sku: ['00', '01', '02', '03', '05'],
  patch: ['00', '02', '03', '04', '05'],
  persistence_snapshot: ['00', '03', '04', '05'],
  pricing_quality_affix: ['00', '03', '04', '05'],
  ui_workbench: ['00', '01', '02', '05', '06', '07'],
  workflow_governance: ['00', '05'],
};

const openRegistry = [
  { id: 'OPEN-001', moduleId: '05', subsection: 'OPEN-001', title: 'OPEN-001：降低型词条叠加', dependencies: ['11.4', '14'] },
  { id: 'OPEN-002', moduleId: '05', subsection: 'OPEN-002', title: 'OPEN-002：性能定位派生语义（已决，待实现）', dependencies: [] },
  { id: 'OPEN-003', moduleId: '05', subsection: 'OPEN-003', title: 'OPEN-003：扩展部位启用时间', dependencies: [] },
  { id: 'OPEN-004', moduleId: '05', subsection: 'OPEN-004', title: 'OPEN-004：Patch属性偏移阈值', dependencies: ['14'] },
  { id: 'OPEN-005', moduleId: '06', subsection: '21', title: '21. Model五维图预览', dependencies: ['22', '24.6', '25.3'] },
  { id: 'OPEN-006', moduleId: '06', subsection: '23.6', title: '23.6 AI服务与数据边界', dependencies: [] },
  { id: 'OPEN-007', moduleId: '05', subsection: '20.1', title: '20.1 价值分自动定价与PricingPolicy', dependencies: [] },
  { id: 'OPEN-008', moduleId: '05', subsection: 'OPEN-008', title: 'OPEN-008：ConfigIdPolicy数字区间与命名规则', dependencies: ['25'] },
  { id: 'OPEN-009', moduleId: '05', subsection: '20.2', title: '20.2 OPEN-009：AI与发布工作流治理策略', dependencies: ['23.6'] },
  { id: 'OPEN-010', moduleId: '04', subsection: '14.4', title: '14.4 Patch台账远端schema、哈希、协作、回读与补偿契约', dependencies: ['20.2'] },
  { id: 'OPEN-011', moduleId: '05', subsection: 'OPEN-011', title: 'OPEN-011：工作区revision归档与裁剪启用', dependencies: ['14.3'] },
];

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function fail(message) {
  throw new Error(message);
}

function parseMonolith(source) {
  const matches = [...source.matchAll(/^## (\d+)\. .+$/gm)];
  if (matches.length !== 26 || matches.some((match, index) => Number(match[1]) !== index)) {
    fail('Expected exactly the ordered top-level v3 sections 0..25');
  }
  const preamble = source.slice(0, matches[0].index);
  const sections = new Map();
  matches.forEach((match, index) => {
    const end = matches[index + 1]?.index ?? source.length;
    sections.set(match[1], source.slice(match.index, end));
  });
  return { preamble, sections };
}

function moduleContent(definition, sections) {
  return definition.sections.map((section) => sections.get(section)).join('').replaceAll('](./', '](../');
}

function buildManifest(preamble, renderedModules) {
  const knownSections = new Set([...renderedModules.values()].flatMap((source) => [...source.matchAll(/^#{2,6}\s+(\d+(?:\.\d+)*)(?:\.|\s)/gm)].map((match) => match[1])));
  const knownModuleIds = new Set(modules.map((definition) => definition.id));
  for (const entry of openRegistry) {
    if (!knownModuleIds.has(entry.moduleId)) fail(`OPEN registry references unknown module: ${entry.id}`);
    if (!entry.dependencies.every((section) => knownSections.has(section))) fail(`OPEN registry references unknown dependency: ${entry.id}`);
    const source = renderedModules.get(entry.moduleId);
    const matches = [...source.matchAll(/^#{2,6}\s+(.+?)\s*#*\s*$/gm)].filter((match) => match[1] === entry.title);
    if (matches.length !== 1) fail(`OPEN registry canonical subsection must resolve exactly once: ${entry.id}`);
    const locator = matches[0][1].match(/^(\d+(?:\.\d+)*)(?:\.|\s)/)?.[1] ?? matches[0][1].match(/^(OPEN-\d+)\b/)?.[1];
    if (locator !== entry.subsection) fail(`OPEN registry subsection locator does not match its canonical heading: ${entry.id}`);
  }
  return {
    format: 'tackle-v3-modules/v1',
    canonicalRoot: 'docs/spec-v3',
    compatibilityMirror: 'docs/tackle-forger-development-spec-v3.md',
    readingProtocol: {
      alwaysRead: ['docs/spec-v3/README.md', 'docs/spec-v3/00-authority.md', '.codex/skills/tackle-agent-workflow/references/v3-open-registry.json'],
      alwaysReadSections: ['0', '19', 'OPEN_REGISTRY'],
      selectRoutesBeforeReading: true,
      fullReadWhen: ['scope_unknown', 'cross_domain_broad', 'canonical_structure_change'],
    },
    preamble,
    modules: modules.map((definition) => ({
      ...definition,
      path: `docs/spec-v3/${definition.file}`,
      sha256: sha256(renderedModules.get(definition.id)),
    })),
    openRegistry,
    routes,
  };
}

function assemble(manifest) {
  const body = manifest.modules.map((module) => readFileSync(path.join(root, module.path), 'utf8')).join('').replaceAll('](../', '](./');
  return `${manifest.preamble}${body}`;
}

const mode = process.argv[2];
if (mode === '--split') {
  const source = readFileSync(mirrorPath, 'utf8');
  const { preamble, sections } = parseMonolith(source);
  mkdirSync(moduleDir, { recursive: true });
  const rendered = new Map();
  for (const definition of modules) {
    const content = moduleContent(definition, sections);
    rendered.set(definition.id, content);
    writeFileSync(path.join(moduleDir, definition.file), content, 'utf8');
  }
  writeFileSync(manifestPath, `${JSON.stringify(buildManifest(preamble, rendered), null, 2)}\n`, 'utf8');
  process.stdout.write(`split ${modules.length} canonical modules\n`);
} else if (mode === '--assemble') {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(mirrorPath, assemble(manifest), 'utf8');
  process.stdout.write('assembled compatibility mirror\n');
} else if (mode === '--refresh') {
  const previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rendered = new Map(modules.map((definition) => [definition.id, readFileSync(path.join(moduleDir, definition.file), 'utf8')]));
  const manifest = buildManifest(previous.preamble, rendered);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(mirrorPath, assemble(manifest), 'utf8');
  process.stdout.write('refreshed module hashes and compatibility mirror\n');
} else if (mode === '--check') {
  if (!existsSync(manifestPath)) fail('Missing v3 module manifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== 'tackle-v3-modules/v1') fail('Unsupported v3 module manifest');
  if (JSON.stringify(manifest.routes) !== JSON.stringify(routes)) fail('V3 route manifest drift');
  if (JSON.stringify(manifest.openRegistry) !== JSON.stringify(openRegistry)) fail('V3 OPEN registry manifest drift');
  if (JSON.stringify(manifest.readingProtocol) !== JSON.stringify(buildManifest(manifest.preamble, new Map(modules.map((definition) => [definition.id, readFileSync(path.join(moduleDir, definition.file), 'utf8')]))).readingProtocol)) fail('V3 reading protocol manifest drift');
  const expectedModules = modules.map(({ id, file, sections, title }) => ({ id, file, sections, title }));
  const actualModules = manifest.modules.map(({ id, file, sections, title }) => ({ id, file, sections, title }));
  if (JSON.stringify(actualModules) !== JSON.stringify(expectedModules)) fail('V3 module order or membership drift');
  for (const specModule of manifest.modules) {
    const content = readFileSync(path.join(root, specModule.path), 'utf8');
    if (sha256(content) !== specModule.sha256) fail(`V3 module hash drift: ${specModule.path}`);
    const actualSections = [...content.matchAll(/^## (\d+)\. /gm)].map((match) => match[1]);
    if (JSON.stringify(actualSections) !== JSON.stringify(specModule.sections)) fail(`V3 module section drift: ${specModule.path}`);
  }
  if (readFileSync(mirrorPath, 'utf8') !== assemble(manifest)) fail('V3 compatibility mirror drift; run --assemble');
  process.stdout.write('v3 modules and compatibility mirror are consistent\n');
} else {
  fail('Usage: node scripts/spec-v3-modules.mjs --split|--refresh|--assemble|--check');
}
