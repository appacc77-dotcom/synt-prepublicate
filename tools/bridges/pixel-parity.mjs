#!/usr/bin/env node
/**
 * Пиксельная сверка «кроп Figma ↔ рендер FigCraft» по всем собранным секциям.
 *
 *   node tools/bridges/pixel-parity.mjs --fig "<file.fig>" [--out reports/pixel-parity.md] [--page Home]
 *
 * Что делает: берёт спеки секций (`design/figma/pages/<page>/<section>/spec.json`),
 * их эталонные кропы (снятые мостом Figma) и рендерит тот же узел из архива
 * через FigCraft, затем считает расхождение. Это и есть цена «другого
 * рендерера» — числа, а не мнение.
 *
 * Узел ищется по имени и размеру секции из спеки: id у мостов разные, поэтому
 * ключ только (имя, ширина, высота) внутри своей страницы.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpClient } from './figcraft-cli/mcp-client.mjs';
import { cliPath } from './figcraft-cli/index.mjs';
import { decodePng } from '../lib/png.mjs';

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
const onlyPage = option('page');
const outPath = option('out');
const scale = Number(option('scale', '1'));

/**
 * Каталог страницы → имя страницы в файле.
 * Ничего не зашито: `project.json` даёт id страницы по каталогу, а снимок
 * `live/structure.json` — имя по id. Каталог без записи (например, `book`)
 * ищется по всем страницам по имени и размеру секции.
 */
function loadPageNames(root) {
  const readJson = (path) => {
    try {
      return JSON.parse(readFileSync(join(root, path), 'utf8'));
    } catch {
      return null;
    }
  };
  const project = readJson('design/figma/project.json');
  const structure = readJson('design/figma/live/structure.json');
  const nameById = new Map((structure?.pages ?? []).map((page) => [page.id, page.name]));
  const byDir = new Map();
  for (const [dir, id] of Object.entries(project?.pages ?? {})) {
    const name = nameById.get(id);
    if (name) byDir.set(dir, name);
  }
  return byDir;
}

/** Совпадение «кроп Figma ↔ рендер FigCraft»: та же метрика, что у tools/compare.mjs. */
function pixelDiff(refBuf, curBuf) {
  const ref = decodePng(refBuf);
  const cur = decodePng(curBuf);
  const w = Math.min(ref.width, cur.width);
  const h = Math.min(ref.height, cur.height);
  let sum = 0;
  let over16 = 0;
  let over48 = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * ref.width + x) * 4;
      const j = (y * cur.width + x) * 4;
      const diff =
        (Math.abs(ref.data[i] - cur.data[j]) +
          Math.abs(ref.data[i + 1] - cur.data[j + 1]) +
          Math.abs(ref.data[i + 2] - cur.data[j + 2])) /
        3;
      sum += diff;
      if (diff > 16) over16 += 1;
      if (diff > 48) over48 += 1;
    }
  }
  const total = w * h || 1;
  return {
    mean: Math.round((sum / total) * 100) / 100,
    over16: Math.round((over16 / total) * 10000) / 100,
    over48: Math.round((over48 / total) * 10000) / 100,
    sizeRef: `${ref.width}x${ref.height}`,
    sizeCur: `${cur.width}x${cur.height}`,
    sameSize: ref.width === cur.width && ref.height === cur.height,
  };
}

const pagesDir = join(repoRoot, 'design/figma/pages');
const pageByDir = loadPageNames(repoRoot);
const sections = [];
for (const pageDir of readdirSync(pagesDir)) {
  if (!existsSync(join(pagesDir, pageDir))) continue;
  for (const sectionDir of readdirSync(join(pagesDir, pageDir))) {
    const dir = join(pagesDir, pageDir, sectionDir);
    const specPath = join(dir, 'spec.json');
    const cropPath = join(dir, 'crop.png');
    if (!existsSync(specPath) || !existsSync(cropPath)) continue;
    if (onlyPage && pageDir !== onlyPage) continue;
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    sections.push({
      pageDir,
      page: pageByDir.get(pageDir) ?? null,
      name: spec.section?.name ?? sectionDir,
      width: spec.section?.w ?? null,
      height: spec.section?.h ?? null,
      cropPath,
      unit: `${pageDir}/${sectionDir}`,
    });
  }
}

const workDir = join(tmpdir(), 'pixel-parity');
mkdirSync(workDir, { recursive: true });
const client = new McpClient({
  command: cliPath(),
  args: ['mcp', '--automation-read-root', dirname(fig), '--automation-write-root', workDir],
});

const rows = [];
try {
  await client.initialize();
  await client.call('open_file', { path: fig });

  /** Дерево нужной страницы один раз: узлы ищем по (имя, ширина, высота). */
  const treeCache = new Map();
  const treeOf = async (page) => {
    if (treeCache.has(page) || page === '__all__') {
      if (page === '__all__') {
        if (!treeCache.has('__all__')) {
          const payload = await client.call('inspect_document', { depth: 99, allPages: true });
          const document = payload?.document ?? payload;
          treeCache.set('__all__', document?.pages ?? []);
        }
        return treeCache.get('__all__');
      }
      return treeCache.get(page);
    }
    const payload = await client.call('inspect_document', { depth: 99, allPages: true });
    const document = payload?.document ?? payload;
    for (const item of document?.pages ?? []) treeCache.set(item.name, item);
    return treeCache.get(page);
  };
  for (const page of new Set(['__all__', ...sections.map((section) => section.page).filter(Boolean)])) {
    await treeOf(page);
  }

  for (const section of sections) {
    const root = section.page ? treeCache.get(section.page) : treeCache.get('__all__');
    if (!root) {
      rows.push({ ...section, status: 'страница не найдена' });
      continue;
    }
    let found = null;
    const walk = (node, depth) => {
      const nameOk = String(node.name).trim() === String(section.name).trim();
      const sizeOk =
        (section.width == null || Math.abs((node.width ?? 0) - section.width) < 0.6) &&
        (section.height == null || Math.abs((node.height ?? 0) - section.height) < 0.6);
      if (nameOk && sizeOk && (!found || depth < found.depth)) {
        found = { id: node.id, depth, width: node.width, height: node.height };
      }
      for (const child of node.children ?? []) walk(child, depth + 1);
    };
    if (Array.isArray(root)) for (const pageNode of root) walk(pageNode, 0);
    else walk(root, 0);
    if (!found) {
      rows.push({ ...section, status: 'узел не найден' });
      continue;
    }
    const renderPath = join(workDir, `${section.unit.replace('/', '-')}.png`);
    await client.call('export', { ids: [found.id], format: 'png', scale, path: renderPath });
    if (!existsSync(renderPath)) {
      rows.push({ ...section, status: 'рендер не создан' });
      continue;
    }
    const diff = pixelDiff(readFileSync(section.cropPath), readFileSync(renderPath));
    rows.push({ ...section, id: found.id, status: 'ок', ...diff });
    if (!diff.sameSize) console.error(`размер: ${section.unit} ${diff.sizeRef} ↔ ${diff.sizeCur}`);
  }
} finally {
  client.close();
}

const done = rows.filter((row) => row.status === 'ок');
const failed = rows.filter((row) => row.status !== 'ок');
const sorted = [...done].sort((one, two) => two.mean - one.mean);
const meanOfMeans = done.length
  ? Math.round((done.reduce((sum, row) => sum + row.mean, 0) / done.length) * 100) / 100
  : null;

const markdown = [];
markdown.push('# Пиксель: кроп Figma ↔ рендер FigCraft');
markdown.push('');
markdown.push(`Файл: \`${relative(repoRoot, fig) || fig}\`. Секций сверено: **${done.length}** (не сверено: ${failed.length}).`);
markdown.push('');
markdown.push('| Метрика | Значение |');
markdown.push('|---|---:|');
markdown.push(`| среднее по секциям | ${meanOfMeans} |`);
markdown.push(`| медиана | ${done.length ? median(done.map((row) => row.mean)) : '—'} |`);
markdown.push(`| худшая секция | ${sorted[0] ? `${sorted[0].unit} — ${sorted[0].mean}` : '—'} |`);
markdown.push('');
markdown.push('| секция | размер | средняя | > 16 | > 48 |');
markdown.push('|---|---|---:|---:|---:|');
for (const row of sorted) {
  markdown.push(
    `| ${row.unit} | ${row.sizeRef} | ${row.mean} | ${row.over16} % | ${row.over48} % |`,
  );
}
if (failed.length) {
  markdown.push('');
  markdown.push('## Не сверено');
  for (const row of failed) markdown.push(`- ${row.unit}: ${row.status}`);
}

if (outPath) {
  writeFileSync(outPath, markdown.join('\n') + '\n');
  console.error(`отчёт: ${outPath}`);
} else {
  console.error(markdown.join('\n'));
}
console.log(
  JSON.stringify(
    {
      file: fig,
      compared: done.length,
      failed: failed.length,
      meanOfMeans,
      median: done.length ? median(done.map((row) => row.mean)) : null,
      worst: sorted.slice(0, 5).map((row) => ({ unit: row.unit, mean: row.mean, over16: row.over16 })),
      rows: sorted,
    },
    null,
    1,
  ),
);

function median(values) {
  const sortedValues = [...values].sort((one, two) => one - two);
  const middle = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2
    ? sortedValues[middle]
    : Math.round(((sortedValues[middle - 1] + sortedValues[middle]) / 2) * 100) / 100;
}
