#!/usr/bin/env node
/**
 * Сопоставление узлов и привязок токенов: Figma desktop ↔ FigCraft CLI.
 *
 *   node tools/bridges/bindings-parity.mjs --fig "<file.fig>" \
 *        [--json reports/bindings-map.json] [--md docs/BINDINGS-MAP.md]
 *
 * Что делает:
 *   1. снимает дерево каждой страницы живым мостом Figma (путь + id + спека);
 *   2. снимает дерево всего файла из FigCraft с полем `boundVariables` (один вызов);
 *   3. сопоставляет узлы по пути и сравнивает **наборы имён токенов** на узле.
 *
 * Почему наборы, а не свойства: словари разные. Figma пишет `fills`, `itemSpacing`,
 * `paddingLeft`/`paddingRight`, `topLeftRadius`; FigCraft — `fill`, `gap`,
 * `paddingHorizontal`/`paddingVertical`, `cornerRadius`, а у градиентов ещё и
 * `fills/0/stops/0/color`. Один и тот же токен при этом виден с обеих сторон,
 * поэтому сверяется факт «узел ссылается на такие-то токены», а не имя свойства.
 *
 * Файл-сопоставление: соответствие id мостов, словарь токенов (id↔имя) и
 * расхождения по каждому узлу.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as figmaBridge from './figma-desktop/index.mjs';
import { runFigma } from '../figma/cli.mjs';
import { McpClient } from './figcraft-cli/mcp-client.mjs';
import { cliPath } from './figcraft-cli/index.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(moduleDir, '..', '..');
const argv = process.argv.slice(2);
function option(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
}
function die(code, message) {
  console.error(message);
  process.exit(code);
}

const fig = option('fig');
if (!fig) die(2, 'нужен --fig <file.fig>');
const jsonPath = option('json', join(repoRoot, 'reports/bindings-map.json'));
const mdPath = option('md', join(repoRoot, 'docs/BINDINGS-MAP.md'));

// --- проектные данные: страницы и секции ---------------------------------------
const project = JSON.parse(readFileSync(join(repoRoot, 'design/figma/project.json'), 'utf8'));
const structure = JSON.parse(readFileSync(join(repoRoot, 'design/figma/live/structure.json'), 'utf8'));
const documentDump = JSON.parse(readFileSync(join(repoRoot, 'design/figma/live/document.json'), 'utf8'));
// project.json хранит id КАДРА страницы, а structure.json — кадры внутри страниц.
const pageNameByFrame = new Map();
for (const page of structure.pages ?? []) {
  for (const frame of page.frames ?? []) pageNameByFrame.set(frame.id, page.name);
}
const scope = project.scope ?? Object.keys(project.frames ?? {});

const sections = [];
for (const pageDir of Object.keys(project.frames ?? {})) {
  const dirPath = join(repoRoot, 'design/figma/pages', pageDir);
  if (!existsSync(dirPath)) continue;
  for (const name of readdir(dirPath)) {
    const specPath = join(dirPath, name, 'spec.json');
    if (!existsSync(specPath)) continue;
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    if (!spec.section?.id) continue;
    sections.push({
      unit: `${pageDir}/${name}`,
      pageDir,
      page: pageNameByFrame.get(project.frames?.[pageDir]?.id) ?? pageDir,
      id: spec.section.id,
      name: spec.section.name,
      width: spec.section.w,
      height: spec.section.h,
      specPath,
    });
  }
}

function readdir(dir) {
  return existsSync(dir) ? require$readdir(dir) : [];
}
// require без ESM-обвязки: используем fs через уже загруженный модуль
import { readdirSync as require$readdir } from 'node:fs';

// --- Figma: дерево страниц через живой мост -------------------------------------
const figmaNodes = new Map(); // path -> {id, page}
const figmaPathById = new Map(); // id -> path
for (const pageDir of scope) {
  const pageName = pageNameByFrame.get(project.frames?.[pageDir]?.id);
  if (!pageName) continue;
  try {
    const tree = await figmaBridge.tree({ page: pageName, depth: 99 });
    for (const node of tree.data.nodes) {
      figmaNodes.set(node.path, { id: node.id, page: pageName });
      if (!figmaPathById.has(node.id)) figmaPathById.set(node.id, node.path);
    }
  } catch (error) {
    console.error(`страница «${pageName}» не снята: ${error.message}`);
  }
}

// --- FigCraft: дерево всего файла с boundVariables ------------------------------
const client = new McpClient({
  command: cliPath(),
  args: ['mcp', '--automation-read-root', dirname(fig), '--automation-write-root', '/tmp'],
});
let figcraftVariables = [];
const figcraftNodes = new Map(); // path -> {id, bound: {prop: tokenName}}
try {
  await client.initialize();
  await client.call('open_file', { path: fig });
  const varList = await client.call('run_command', { command: 'variable.list', params: {} });
  figcraftVariables = varList?.variables ?? [];
  const payload = await client.call('inspect_document', {
    depth: 99,
    allPages: true,
    fields: ['name', 'type', 'boundVariables'],
  });
  const root = payload.document ?? payload;
  const walk = (node, path) => {
    const record = { id: node.id, bound: {} };
    for (const [prop, id] of Object.entries(node.boundVariables ?? {})) record.bound[prop] = id;
    figcraftNodes.set(path, record);
    const counters = new Map();
    for (const child of node.children ?? []) {
      const count = (counters.get(child.name) ?? 0) + 1;
      counters.set(child.name, count);
      walk(child, `${path}/${count > 1 ? `${child.name}#${count}` : child.name}`);
    }
  };
  for (const page of root.pages ?? []) walk(page, page.name);
} finally {
  client.close();
}

// --- словари токенов ------------------------------------------------------------
const figmaTokenNameById = new Map((documentDump.variables ?? []).map((item) => [item.id, item.name]));
const figcraftTokenNameById = new Map(figcraftVariables.map((item) => [item.id, item.name]));
const figcraftTokenIdByName = new Map(figcraftVariables.map((item) => [item.name, item.id]));

// --- доразрешение имён: локальный дамп не содержит всех переменных ----------------
// `document.json` собран через getLocalVariablesAsync и в нём нет части переменных
// (например, созданных/переименованных позже). Имена добираем живым мостом.
// `bound` в спеке бывает скаляром (`itemSpacing`) и списком (`fills`, `strokes`).
const flattenBound = (bound) => {
  const ids = [];
  for (const value of Object.values(bound ?? {})) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item) ids.push(item);
    } else if (typeof value === 'string') {
      ids.push(value);
    }
  }
  return ids;
};
const boundIdsInSpecs = new Set();
for (const section of sections) {
  const spec = JSON.parse(readFileSync(section.specPath, 'utf8'));
  for (const node of spec.nodes) for (const id of flattenBound(node.bound)) boundIdsInSpecs.add(id);
}
// Дамп может быть снят раньше файла: id в нём тогда чужие. Поэтому имена берём
// живым мостом для ВСЕХ уникальных id из спек, а дамп используем как запасной.
const idsToResolve = [...boundIdsInSpecs];
const missingIds = idsToResolve;
let resolvedByBridge = 0;
if (missingIds.length) {
  const scriptPath = join(tmpdir(), 'bindings-resolve-variables.js');
  writeFileSync(
    scriptPath,
    `const ids = ${JSON.stringify(missingIds)};\n` +
      'const out = {};\n' +
      'for (const id of ids) {\n' +
      '  try { const v = await figma.variables.getVariableByIdAsync(id); out[id] = v ? v.name : null; }\n' +
      '  catch (error) { out[id] = null; }\n' +
      '}\n' +
      'return { resolved: out };\n',
  );
  try {
    const reply = runFigma(['exec-js', scriptPath], { timeoutMs: 180000 });
    const parsed = typeof reply === 'string' ? JSON.parse(reply) : reply;
    const resolved = parsed?.result?.resolved ?? parsed?.resolved ?? {};
    for (const [id, name] of Object.entries(resolved)) {
      // мост возвращает либо имя, либо объект переменной
      const realName = typeof name === 'string' ? name : name?.name ?? null;
      if (realName) {
        figmaTokenNameById.set(id, realName);
        resolvedByBridge += 1;
      }
    }
  } catch (error) {
    console.error(`имена переменных не доразрешены: ${error.message}`);
  }
}


const figmaTokensOf = (specNode) => {
  const names = [];
  const unresolved = [];
  for (const value of flattenBound(specNode.bound)) {
    const name = figmaTokenNameById.get(value);
    if (name) names.push(name);
    else unresolved.push(value);
  }
  return { names: [...new Set(names)].sort(), unresolved: [...new Set(unresolved)].sort() };
};
const figcraftTokensOf = (record) => {
  const names = [];
  const unresolved = [];
  for (const value of flattenBound(record?.bound)) {
    const name = figcraftTokenNameById.get(value);
    if (name) names.push(name);
    else unresolved.push(value);
  }
  return { names: [...new Set(names)].sort(), unresolved: [...new Set(unresolved)].sort() };
};

// --- сопоставление по узлам и секциям -------------------------------------------
const nodePairs = [];
const sectionRows = [];
const allUnresolvedFigma = new Set();
const allUnresolvedFigcraft = new Set();

for (const section of sections) {
  const spec = JSON.parse(readFileSync(section.specPath, 'utf8'));
  const sectionPath = figmaPathById.get(section.id);
  const row = {
    unit: section.unit,
    path: sectionPath ?? null,
    specNodes: spec.nodes.length,
    figmaNodes: 0,
    figcraftNodes: 0,
    matched: 0,
    withTokens: 0,
    equal: 0,
    differing: [],
    onlyFigmaPaths: [],
    onlyFigcraftPaths: [],
    figmaTokens: 0,
    figcraftTokens: 0,
  };
  if (sectionPath) {
    const prefix = `${sectionPath}/`;
    const figmaSpecById = new Map(spec.nodes.map((node) => [node.id, node]));
    const figmaPaths = [...figmaNodes.keys()].filter((path) => path === sectionPath || path.startsWith(prefix));
    row.figmaNodes = figmaPaths.length;
    const figcraftPaths = [...figcraftNodes.keys()].filter((path) => path === sectionPath || path.startsWith(prefix));
    row.figcraftNodes = figcraftPaths.length;
    const figcraftPathSet = new Set(figcraftPaths);

    for (const path of figmaPaths) {
      const figmaNode = figmaNodes.get(path);
      const specNode = figmaSpecById.get(figmaNode.id);
      const a = specNode ? figmaTokensOf(specNode) : { names: [], unresolved: [] };
      for (const id of a.unresolved) allUnresolvedFigma.add(id);
      if (!figcraftPathSet.has(path)) {
        if (a.names.length) row.onlyFigmaPaths.push(path);
        continue;
      }
      row.matched += 1;
      const b = figcraftTokensOf(figcraftNodes.get(path));
      for (const id of b.unresolved) allUnresolvedFigcraft.add(id);
      row.figmaTokens += a.names.length;
      row.figcraftTokens += b.names.length;
      if (!a.names.length && !b.names.length) continue;
      row.withTokens += 1;
      const onlyFigma = a.names.filter((name) => !b.names.includes(name));
      const onlyFigcraft = b.names.filter((name) => !a.names.includes(name));
      if (!onlyFigma.length && !onlyFigcraft.length) {
        row.equal += 1;
      } else {
        row.differing.push({ path, onlyFigma, onlyFigcraft });
      }
      nodePairs.push({
        path,
        figmaId: figmaNode.id,
        figcraftId: figcraftNodes.get(path)?.id ?? null,
        figmaTokens: a.names,
        figcraftTokens: b.names,
        onlyFigma,
        onlyFigcraft,
      });
    }
    for (const path of figcraftPaths) {
      if (!figmaNodes.has(path)) {
        const b = figcraftTokensOf(figcraftNodes.get(path));
        if (b.names.length) row.onlyFigcraftPaths.push(path);
      }
    }
  }
  sectionRows.push(row);
}

// --- файлы ----------------------------------------------------------------------
// классы расхождений: важно понять, это потеря привязки или особенность словаря
const differingNodes = nodePairs.filter((node) => node.onlyFigma.length || node.onlyFigcraft.length);
const classes = {
  insideInstance: 0,
  figcraftNoTokens: 0,
  figmaNoTokens: 0,
  mixed: 0,
};
const lostTokens = new Map();
const extraTokens = new Map();
for (const node of differingNodes) {
  for (const name of node.onlyFigma) lostTokens.set(name, (lostTokens.get(name) ?? 0) + 1);
  for (const name of node.onlyFigcraft) extraTokens.set(name, (extraTokens.get(name) ?? 0) + 1);
  if (String(node.figmaId).startsWith('I')) classes.insideInstance += 1;
  else if (node.onlyFigma.length && !node.onlyFigcraft.length) classes.figcraftNoTokens += 1;
  else if (node.onlyFigcraft.length && !node.onlyFigma.length) classes.figmaNoTokens += 1;
  else classes.mixed += 1;
}
const topEntries = (map, limit = 8) => [...map.entries()].sort((one, two) => two[1] - one[1]).slice(0, limit);

const mapping = {
  generatedAt: new Date().toISOString(),
  file: fig,
  note: 'Сопоставление мостов: id разных систем, словарь токенов и привязки по узлам (сравниваются наборы имён токенов).',
  tokens: {
    figmaCount: figmaTokenNameById.size,
    figcraftCount: figcraftTokenNameById.size,
    lastPair: Object.fromEntries([...figmaTokenNameById].slice(0, 3)),
    lastPairFigcraft: Object.fromEntries([...figcraftTokenIdByName].slice(0, 3)),
    figmaOnly: [...figmaTokenNameById.values()].filter((name) => !figcraftTokenIdByName.has(name)).sort(),
    figcraftOnly: [...figcraftTokenIdByName.keys()].filter((name) => ![...figmaTokenNameById.values()].includes(name)).sort(),
  },
  unresolved: {
    figmaIds: [...allUnresolvedFigma].sort(),
    figcraftIds: [...allUnresolvedFigcraft].sort(),
    resolvedByBridge,
  },
  classes: { ...classes, lostTokens: topEntries(lostTokens, 20), extraTokens: topEntries(extraTokens, 20) },
  sections: sectionRows,
  nodes: nodePairs,
};
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, JSON.stringify(mapping, null, 1) + '\n');

const totals = sectionRows.reduce(
  (acc, row) => {
    acc.figmaNodes += row.figmaNodes;
    acc.figcraftNodes += row.figcraftNodes;
    acc.matched += row.matched;
    acc.withTokens += row.withTokens;
    acc.equal += row.equal;
    acc.differing += row.differing.length;
    acc.figmaTokens += row.figmaTokens;
    acc.figcraftTokens += row.figcraftTokens;
    return acc;
  },
  { figmaNodes: 0, figcraftNodes: 0, matched: 0, withTokens: 0, equal: 0, differing: 0, figmaTokens: 0, figcraftTokens: 0 },
);

const markdown = [];
markdown.push('# Файл-сопоставление: Figma desktop ↔ FigCraft');
markdown.push('');
markdown.push(`Сгенерирован: ${mapping.generatedAt}. Архив: \`${fig.split('/').pop()}\`.`);
markdown.push(`Машинная версия: \`${jsonPath.replace(repoRoot + '/', '')}\`.`);
markdown.push('');
markdown.push('## Что сравнивается');
markdown.push('');
markdown.push('Узлы сопоставляются по **пути из имён** (id у мостов разные, они не совпадают). У каждого узла');
markdown.push('сравнивается **набор имён токенов**, на которые он ссылается: словари свойств у мостов разные');
markdown.push('(`fills`/`fill`, `itemSpacing`/`gap`, `paddingLeft`+`paddingRight`/`paddingHorizontal`), а токены одни.');
markdown.push('');
markdown.push('## Итог');
markdown.push('');
markdown.push('| Метрика | Значение |');
markdown.push('|---|---:|');
markdown.push(`| узлов: Figma / FigCraft | ${totals.figmaNodes} / ${totals.figcraftNodes} |`);
markdown.push(`| сопоставлено узлов | ${totals.matched} |`);
markdown.push(`| из них с токенами | ${totals.withTokens} |`);
markdown.push(`| наборы токенов совпали | **${totals.equal}** |`);
markdown.push(`| расхождений | **${totals.differing}** |`);
markdown.push(`| ссылок на токены: Figma / FigCraft | ${totals.figmaTokens} / ${totals.figcraftTokens} |`);
markdown.push(`| неразрешённых id у Figma / у FigCraft | ${mapping.unresolved.figmaIds.length} / ${mapping.unresolved.figcraftIds.length} |`);
markdown.push(`| имён токенов добрано живым мостом | ${mapping.unresolved.resolvedByBridge} |`);
markdown.push('');
markdown.push('## Как читать расхождения');
markdown.push('');
markdown.push('| Класс | Узлов |');
markdown.push('|---|---:|');
markdown.push(`| узел внутри инстанса Figma (id вида \`I…\`) — FigCraft раскрывает инстанс одним узлом и привязки нутра не отдаёт | ${classes.insideInstance} |`);
markdown.push(`| у FigCraft на узле нет ни одного токена, хотя Figma видит | ${classes.figcraftNoTokens} |`);
markdown.push(`| у FigCraft токен есть, у Figma нет | ${classes.figmaNoTokens} |`);
markdown.push(`| наборы частично совпали, часть токенов разная | ${classes.mixed} |`);
markdown.push('');
markdown.push('Потерянные токены (только у Figma): ' + topEntries(lostTokens).map(([name, count]) => `${name} ×${count}`).join(', '));
markdown.push('');
markdown.push('Лишние (только у FigCraft): ' + topEntries(extraTokens).map(([name, count]) => `${name} ×${count}`).join(', '));
markdown.push('');
markdown.push('## Словарь токенов');
markdown.push('');
markdown.push(`| | Figma | FigCraft |`);
markdown.push('|---|---:|---:|');
markdown.push(`| переменных | ${mapping.tokens.figmaCount} | ${mapping.tokens.figcraftCount} |`);
markdown.push(`| только у Figma | ${mapping.tokens.figmaOnly.length} | — |`);
markdown.push(`| только у FigCraft | — | ${mapping.tokens.figcraftOnly.length} |`);
if (mapping.tokens.figmaOnly.length) markdown.push(`\nТолько у Figma: ${mapping.tokens.figmaOnly.join(', ')}`);
if (mapping.tokens.figcraftOnly.length) markdown.push(`\nТолько у FigCraft: ${mapping.tokens.figcraftOnly.join(', ')}`);
if (mapping.unresolved.figmaIds.length) {
  markdown.push(`\nНеразрешённые id Figma (нет в локальном дампе переменных): ${mapping.unresolved.figmaIds.join(', ')}`);
}
markdown.push('');
markdown.push('## По секциям');
markdown.push('');
markdown.push('| секция | узлов Figma/FigCraft | сопоставлено | с токенами | совпало | расхождения |');
markdown.push('|---|---:|---:|---:|---:|---:|');
for (const row of sectionRows) {
  markdown.push(
    `| ${row.unit}${row.path ? '' : ' (нет пути)'} | ${row.figmaNodes}/${row.figcraftNodes} | ${row.matched} | ${row.withTokens} | ${row.equal} | ${row.differing.length} |`,
  );
}
const worst = [...sectionRows].sort((a, b) => b.differing.length - a.differing.length).slice(0, 8);
if (worst.some((row) => row.differing.length)) {
  markdown.push('');
  markdown.push('## Где расходятся (топ по числу узлов)');
  markdown.push('');
  for (const row of worst) {
    if (!row.differing.length) continue;
    markdown.push(`### ${row.unit} — ${row.differing.length} узлов`);
    markdown.push('');
    for (const item of row.differing.slice(0, 6)) {
      const parts = [];
      if (item.onlyFigma.length) parts.push(`только у Figma: ${item.onlyFigma.join(', ')}`);
      if (item.onlyFigcraft.length) parts.push(`только у FigCraft: ${item.onlyFigcraft.join(', ')}`);
      markdown.push(`- \`${item.path}\` — ${parts.join('; ')}`);
    }
    markdown.push('');
  }
}
writeFileSync(mdPath, markdown.join('\n') + '\n');
console.error(`файл-сопоставление: ${mdPath}`);
console.error(`машинная версия: ${jsonPath}`);
console.log(
  JSON.stringify(
    {
      sections: sectionRows.length,
      totals,
      tokens: { figma: mapping.tokens.figmaCount, figcraft: mapping.tokens.figcraftCount, onlyFigma: mapping.tokens.figmaOnly },
      unresolved: mapping.unresolved,
    },
    null,
    1,
  ),
);
