#!/usr/bin/env node
/**
 * Сверка ДАННЫХ дизайн-системы: desktop-Figma ↔ FigCraft CLI.
 *
 *   node tools/bridges/data-parity.mjs --fig "<file.fig>" [--out report.md] [--refresh]
 *
 * Что сравнивает:
 *   - коллекции и переменные (токены): имена, коллекции, типы, значения по режимам;
 *   - стили: имена, типы и свойства текстовых стилей (шрифт, кегль, интерлиньяж, трекинг);
 *   - компоненты: имена, типы и оси вариантов (для структуры сайта это ключевое);
 *   - страницы и кадры страниц.
 *
 * Источники: со стороны Figma — артефакты проекта (`design/figma/live/*.json`,
 * их пишут intake/document/scan-design-system), со стороны FigCraft — CLI в
 * режиме MCP (variable.list, style.list, inspect_document, component.properties).
 *
 * --refresh пересобирает Figma-артефакт дизайн-системы живым мостом
 * (`figma-agent scan-design-system`), иначе берётся уже записанный.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from './figcraft-cli/mcp-client.mjs';
import { cliPath } from './figcraft-cli/index.mjs';
import { runFigma } from '../figma/cli.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(moduleDir, '..', '..');
const argv = process.argv.slice(2);

function option(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
}
function hasFlag(name) {
  return argv.includes(`--${name}`);
}
function die(code, message) {
  console.error(message);
  process.exit(code);
}

const fig = option('fig');
if (!fig) die(2, 'нужен --fig <file.fig>');
const outPath = option('out');
const liveDir = join(repoRoot, 'design/figma/live');

// --- 1. Данные со стороны Figma -------------------------------------------------
if (hasFlag('refresh')) {
  const target = join(liveDir, 'ds.json');
  try {
    runFigma(['scan-design-system', '--out', target], { timeoutMs: 120000 });
    console.error('обновлён design/figma/live/ds.json живым мостом');
  } catch (error) {
    console.error(`не удалось обновить ds.json: ${error.message}; беру записанный`);
  }
}
const readJson = (path) => {
  if (!existsSync(join(repoRoot, path))) return null;
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
};
const document = readJson('design/figma/live/document.json');
const ds = readJson('design/figma/live/ds.json');
const structure = readJson('design/figma/live/structure.json');
if (!document || !ds) die(3, 'нет design/figma/live/document.json или ds.json — сначала npm run document / npm run intake');

const figma = {
  variables: document.variables ?? [],
  collections: document.variableCollections ?? [],
  styles: {
    text: document.styles?.text ?? [],
    paint: document.styles?.paint ?? [],
    effect: document.styles?.effect ?? [],
    grid: document.styles?.grid ?? [],
  },
  components: ds.components ?? [],
  pages: structure?.pages ?? [],
};

// --- 2. Данные со стороны FigCraft ---------------------------------------------
const client = new McpClient({
  command: cliPath(),
  // чтение архива — откуда он лежит; запись не нужна, но CLI требует хотя бы один корень
  args: ['mcp', '--automation-read-root', dirname(fig), '--automation-write-root', '/tmp'],
});
const figcraft = { variables: null, collections: [], styles: [], components: [], pages: [], componentsChecked: 0 };
try {
  await client.initialize();
  await client.call('open_file', { path: fig });
  const varList = await client.call('run_command', { command: 'variable.list', params: {} });
  figcraft.collections = varList?.collections ?? [];
  figcraft.variables = varList?.variables ?? [];
  const styleList = await client.call('run_command', { command: 'style.list', params: {} });
  figcraft.styles = typeof styleList === 'string' ? JSON.parse(styleList.slice(styleList.indexOf('['))) : styleList;

  const doc = await client.call('inspect_document', { depth: 2, allPages: true });
  const root = doc.document ?? doc;
  figcraft.pages = root.pages ?? [];

  // Оси вариантов у наборов компонентов: component.properties на каждый набор.
  const sets = [];
  for (const page of figcraft.pages) {
    for (const node of page.children ?? []) {
      if (node.type === 'COMPONENT_SET') sets.push(node);
      if (node.type === 'COMPONENT') figcraft.components.push({ id: node.id, name: node.name, type: 'COMPONENT' });
    }
  }
  for (const set of sets) {
    const props = await client.call('run_command', { command: 'component.properties', params: { id: set.id } });
    figcraft.componentsChecked += 1;
    const allProps = props?.properties ?? [];
    const variantProps = allProps.filter((item) => (item.type ?? 'variant') === 'variant');
    figcraft.components.push({
      id: set.id,
      name: set.name,
      type: 'COMPONENT_SET',
      axes: Object.fromEntries(variantProps.map((item) => [item.name, item.options ?? []])),
      otherProps: allProps.length - variantProps.length,
    });
  }
} finally {
  client.close();
}

// --- 3. Сверка ------------------------------------------------------------------
const normUnit = (unit) => String(unit ?? '').toLowerCase().replace('pixels', 'px');
const num = (value) => (typeof value === 'number' ? Math.round(value * 100) / 100 : value);
const normValue = (value) => {
  if (typeof value === 'number') return num(value);
  if (typeof value === 'string') return value.toLowerCase();
  if (value && typeof value === 'object') {
    if ('hex' in value) return String(value.hex).toLowerCase();
    // FigCraft отдаёт цвет как {r,g,b,a} в долях единицы — приводим к #hex.
    if (['r', 'g', 'b'].every((key) => typeof value[key] === 'number')) {
      const h = (c) => Math.round(c * 255).toString(16).padStart(2, '0');
      const hex = `#${h(value.r)}${h(value.g)}${h(value.b)}`;
      return (value.a ?? 1) < 1 ? `${hex}@${num(value.a ?? 1)}` : hex;
    }
    if ('value' in value) return normValue(value.value);
  }
  return value;
};
const diff = (a, b) => [...a].filter((item) => !b.has(item));
const setOf = (list) => new Set(list.map((item) => String(item).trim()));

// --- переменные
const figmaVarByName = new Map(figma.variables.map((item) => [item.name, item]));
const figcraftVarByName = new Map(figcraft.variables.map((item) => [item.name, item]));
const figcraftCollectionName = new Map(figcraft.collections.map((item) => [item.id, item.name]));
const figcraftModeName = new Map();
for (const collection of figcraft.collections) {
  for (const mode of collection.modes ?? []) figcraftModeName.set(mode.id, mode.name);
}

const varCommon = [...figmaVarByName.keys()].filter((name) => figcraftVarByName.has(name));
const varMismatch = [];
for (const name of varCommon) {
  const a = figmaVarByName.get(name);
  const b = figcraftVarByName.get(name);
  const collectionB = figcraftCollectionName.get(b.collection) ?? b.collection;
  const modesB = {};
  for (const [modeId, payload] of Object.entries(b.values ?? {})) {
    modesB[figcraftModeName.get(modeId) ?? modeId] = normValue(payload?.value);
  }
  const modesA = Object.fromEntries(Object.entries(a.values ?? {}).map(([mode, value]) => [mode, normValue(value)]));
  const problems = [];
  if (a.collection !== collectionB) problems.push(`коллекция: «${a.collection}» ↔ «${collectionB}»`);
  // FLOAT у Figma = number у FigCraft: разные словари, один смысл.
  const TYPE_ALIASES = { float: 'number', color: 'color', string: 'string', boolean: 'boolean' };
  const typesA = TYPE_ALIASES[String(a.type ?? '').toLowerCase()] ?? String(a.type ?? '').toLowerCase();
  const typesB = TYPE_ALIASES[String(b.resolvedType ?? '').toLowerCase()] ?? String(b.resolvedType ?? '').toLowerCase();
  if (typesA !== typesB) problems.push(`тип: ${typesA} ↔ ${typesB}`);
  for (const mode of Object.keys(modesA)) {
    if (!(mode in modesB)) problems.push(`нет режима «${mode}»`);
    else if (JSON.stringify(modesA[mode]) !== JSON.stringify(modesB[mode])) {
      problems.push(`значение «${mode}»: ${JSON.stringify(modesA[mode])} ↔ ${JSON.stringify(modesB[mode])}`);
    }
  }
  if (problems.length) varMismatch.push({ name, problems });
}

// --- стили
const styleKey = (item) => `${item.type}:${item.name}`;
const figmaStyleKeys = new Set(
  [
    ...figma.styles.text.map((item) => ({ type: 'text', name: item.name })),
    ...figma.styles.paint.map((item) => ({ type: 'paint', name: item.name })),
    ...figma.styles.effect.map((item) => ({ type: 'effect', name: item.name })),
    ...figma.styles.grid.map((item) => ({ type: 'grid', name: item.name })),
  ].map(styleKey),
);
const figcraftStyleKeys = new Set(figcraft.styles.map(styleKey));
const figmaTextByName = new Map(figma.styles.text.map((item) => [item.name, item]));
const figcraftTextByName = new Map(
  figcraft.styles.filter((item) => item.type === 'text').map((item) => [item.name, item]),
);
const textStyleMismatch = [];
for (const [name, a] of figmaTextByName) {
  const b = figcraftTextByName.get(name);
  if (!b) continue;
  const problems = [];
  const pair = (label, left, right) => {
    if (String(left ?? '').toLowerCase() !== String(right ?? '').toLowerCase()) {
      problems.push(`${label}: ${JSON.stringify(left)} ↔ ${JSON.stringify(right)}`);
    }
  };
  pair('шрифт', a.font?.family, b.style?.font_family);
  pair('начертание', a.font?.style, b.style?.font_style);
  pair('кегль', num(a.size), num(b.style?.font_size));
  pair('интерлиньяж', `${normUnit(a.lineHeight?.unit)} ${num(a.lineHeight?.value)}`, `${normUnit(b.style?.line_height?.unit)} ${num(b.style?.line_height?.value)}`);
  pair('трекинг', `${normUnit(a.letterSpacing?.unit)} ${num(a.letterSpacing?.value)}`, `${normUnit(b.style?.letter_spacing?.unit)} ${num(b.style?.letter_spacing?.value)}`);
  pair('регистр', String(a.case ?? '').toLowerCase(), String(b.style?.case ?? '').toLowerCase());
  pair('подчёркивание', String(a.decoration ?? '').toLowerCase(), String(b.style?.decoration ?? '').toLowerCase());
  if (problems.length) textStyleMismatch.push({ name, problems });
}

// --- компоненты
const figmaComponentNames = setOf(figma.components.map((item) => item.name));
const figcraftComponentNames = setOf(figcraft.components.map((item) => item.name));
const axesMismatch = [];
for (const component of figma.components) {
  const other =
    figcraft.components.find((item) => item.name === component.name && item.type === component.type) ??
    figcraft.components.find((item) => item.name === component.name);
  if (!other || !component.variantAxes) continue;
  const problems = [];
  const axesA = Object.entries(component.variantAxes);
  const axesB = Object.entries(other.axes ?? {});
  if (axesA.length !== axesB.length) problems.push(`осей: ${axesA.length} ↔ ${axesB.length}`);
  for (const [axis, optionsA] of axesA) {
    const optionsB = other.axes?.[axis];
    if (!optionsB) {
      problems.push(`нет оси «${axis}»`);
      continue;
    }
    const onlyA = diff(new Set(optionsA.map(String)), new Set(optionsB.map(String)));
    const onlyB = diff(new Set(optionsB.map(String)), new Set(optionsA.map(String)));
    if (onlyA.length || onlyB.length) problems.push(`ось «${axis}»: только Figma ${JSON.stringify(onlyA)}, только FigCraft ${JSON.stringify(onlyB)}`);
  }
  if (problems.length) axesMismatch.push({ name: component.name, problems });
}

// --- страницы
const figmaPageNames = setOf(figma.pages.map((item) => item.name));
const figcraftPageNames = setOf(figcraft.pages.map((item) => item.name));

const result = {
  file: fig,
  variables: {
    figma: figma.variables.length,
    figcraft: figcraft.variables.length,
    common: varCommon.length,
    onlyFigma: diff(setOf(figma.variables.map((item) => item.name)), setOf(figcraft.variables.map((item) => item.name))),
    onlyFigcraft: diff(setOf(figcraft.variables.map((item) => item.name)), setOf(figma.variables.map((item) => item.name))),
    collections: { figma: figma.collections.map((item) => item.name), figcraft: figcraft.collections.map((item) => item.name) },
    mismatched: varMismatch,
  },
  styles: {
    figma: figma.styles.text.length + figma.styles.paint.length + figma.styles.effect.length + figma.styles.grid.length,
    figcraft: figcraft.styles.length,
    onlyFigma: diff(figmaStyleKeys, figcraftStyleKeys),
    onlyFigcraft: diff(figcraftStyleKeys, figmaStyleKeys),
    textChecked: figmaTextByName.size,
    textMismatched: textStyleMismatch,
  },
  components: {
    figma: figma.components.length,
    figcraft: figcraft.components.length,
    figcraftSetsChecked: figcraft.componentsChecked,
    onlyFigma: diff(figmaComponentNames, figcraftComponentNames),
    onlyFigcraft: diff(figcraftComponentNames, figmaComponentNames),
    axesMismatched: axesMismatch,
  },
  pages: {
    figma: figma.pages.length,
    figcraft: figcraft.pages.length,
    onlyFigma: diff(figmaPageNames, figcraftPageNames),
    onlyFigcraft: diff(figcraftPageNames, figmaPageNames),
  },
};

// --- 4. Отчёт -------------------------------------------------------------------
const markdown = [];
markdown.push('# Данные дизайн-системы: Figma desktop ↔ FigCraft');
markdown.push('');
markdown.push('Ключ сверки — **имя** (переменной, стиля, компонента, страницы). Значения — по режимам и свойствам.');
markdown.push('');
markdown.push('## Переменные (токены)');
markdown.push('');
markdown.push('| | Figma | FigCraft |');
markdown.push('|---|---:|---:|');
markdown.push(`| переменных | **${result.variables.figma}** | **${result.variables.figcraft}** |`);
markdown.push(`| коллекций | ${figma.collections.length} | ${figcraft.collections.length} |`);
markdown.push(`| общих имён | ${result.variables.common} | — |`);
markdown.push(`| только у Figma | ${result.variables.onlyFigma.length} | — |`);
markdown.push(`| только у FigCraft | — | ${result.variables.onlyFigcraft.length} |`);
markdown.push(`| расхождений по коллекции/типу/значению | ${varMismatch.length} | — |`);
markdown.push('');
markdown.push(`Коллекции Figma: ${figma.collections.map((item) => item.name).join(', ')}`);
markdown.push('');
markdown.push(`Коллекции FigCraft: ${figcraft.collections.map((item) => item.name).join(', ')}`);
if (result.variables.onlyFigma.length) markdown.push(`\nТолько у Figma: ${result.variables.onlyFigma.join(', ')}`);
if (result.variables.onlyFigcraft.length) markdown.push(`\nТолько у FigCraft: ${result.variables.onlyFigcraft.join(', ')}`);
if (varMismatch.length) {
  markdown.push('\n| переменная | расхождение |');
  markdown.push('|---|---|');
  for (const item of varMismatch) markdown.push(`| ${item.name} | ${item.problems.join('; ')} |`);
}

markdown.push('');
markdown.push('## Стили');
markdown.push('');
markdown.push('| | Figma | FigCraft |');
markdown.push('|---|---:|---:|');
markdown.push(`| всего | **${result.styles.figma}** | **${result.styles.figcraft}** |`);
markdown.push(`| только у Figma | ${result.styles.onlyFigma.length} | — |`);
markdown.push(`| только у FigCraft | — | ${result.styles.onlyFigcraft.length} |`);
markdown.push(`| текстовых проверено по свойствам | ${result.styles.textChecked} | ${result.styles.textMismatched.length} расхождений |`);
if (result.styles.onlyFigma.length) markdown.push(`\nТолько у Figma: ${result.styles.onlyFigma.join(', ')}`);
if (result.styles.onlyFigcraft.length) markdown.push(`\nТолько у FigCraft: ${result.styles.onlyFigcraft.join(', ')}`);
if (textStyleMismatch.length) {
  markdown.push('\n| стиль | расхождение |');
  markdown.push('|---|---|');
  for (const item of textStyleMismatch) markdown.push(`| ${item.name} | ${item.problems.join('; ')} |`);
}

markdown.push('');
markdown.push('## Компоненты и оси вариантов');
markdown.push('');
markdown.push('| | Figma | FigCraft |');
markdown.push('|---|---:|---:|');
markdown.push(`| компонентов и наборов | **${result.components.figma}** | **${result.components.figcraft}** |`);
markdown.push(`| наборов проверено по осям | — | ${figcraft.componentsChecked} |`);
markdown.push(`| только у Figma | ${result.components.onlyFigma.length} | — |`);
markdown.push(`| только у FigCraft | — | ${result.components.onlyFigcraft.length} |`);
markdown.push(`| расхождений по осям | ${axesMismatch.length} | — |`);
if (result.components.onlyFigma.length) markdown.push(`\nТолько у Figma: ${result.components.onlyFigma.join(', ')}`);
if (result.components.onlyFigcraft.length) markdown.push(`\nТолько у FigCraft: ${result.components.onlyFigcraft.join(', ')}`);
if (axesMismatch.length) {
  markdown.push('\n| компонент | расхождение |');
  markdown.push('|---|---|');
  for (const item of axesMismatch) markdown.push(`| ${item.name} | ${item.problems.join('; ')} |`);
}

markdown.push('');
markdown.push('## Страницы');
markdown.push('');
markdown.push(`Figma: ${[...figmaPageNames].join(', ')}`);
markdown.push('');
markdown.push(`FigCraft: ${[...figcraftPageNames].join(', ')}`);
if (result.pages.onlyFigma.length) markdown.push(`\nТолько у Figma: ${result.pages.onlyFigma.join(', ')}`);
if (result.pages.onlyFigcraft.length) markdown.push(`\nТолько у FigCraft: ${result.pages.onlyFigcraft.join(', ')}`);

if (outPath) {
  writeFileSync(outPath, markdown.join('\n') + '\n');
  console.error(`отчёт: ${outPath}`);
} else {
  console.error(markdown.join('\n'));
}
console.log(JSON.stringify(result, null, 1));
