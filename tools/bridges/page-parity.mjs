#!/usr/bin/env node
/**
 * Сверка страниц целиком: PNG из моста Figma ↔ PNG из FigCraft.
 *
 *   node tools/bridges/page-parity.mjs --fig "<file.fig>" [--out report.md] [--dir /tmp/page-parity]
 *
 * Берёт кадры страниц из `design/figma/project.json` (id — для моста Figma),
 * находит тот же кадр в архиве по имени (для FigCraft), рендерит оба PNG в
 * масштабе 1 и сравнивает пиксель той же метрикой, что `tools/compare.mjs`.
 *
 * Кадр страницы берётся из `project.json` (там он назван по-проектному);
 * секционные кропы — отдельный инструмент
 * (`pixel-parity.mjs`); здесь именно страница целиком.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as figmaBridge from './figma-desktop/index.mjs';
import * as figcraftBridge from './figcraft-cli/index.mjs';
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
const outPath = option('out');
const workDir = option('dir', join(tmpdir(), 'page-parity'));
mkdirSync(workDir, { recursive: true });

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
    sizeA: `${ref.width}x${ref.height}`,
    sizeB: `${cur.width}x${cur.height}`,
    sameSize: ref.width === cur.width && ref.height === cur.height,
  };
}

const project = JSON.parse(readFileSync(join(repoRoot, 'design/figma/project.json'), 'utf8'));
const structure = JSON.parse(readFileSync(join(repoRoot, 'design/figma/live/structure.json'), 'utf8'));
const pageNameByFrame = new Map();
for (const page of structure.pages ?? []) {
  for (const frame of page.frames ?? []) pageNameByFrame.set(frame.id, page.name);
}

const scope = project.scope ?? Object.keys(project.frames ?? {});
const rows = [];
for (const dir of scope) {
  const frame = project.frames?.[dir];
  if (!frame) continue;
  const pageName = pageNameByFrame.get(frame.id) ?? dir;
  const figmaOut = join(workDir, `${dir}-figma.png`);
  const figcraftOut = join(workDir, `${dir}-figcraft.png`);
  const row = { dir, page: pageName, frame: frame.name, figmaId: frame.id, status: 'ок' };
  try {
    const startedFigma = process.hrtime.bigint();
    const figmaResult = await figmaBridge.png({ node: frame.id, out: figmaOut, scale: 1 });
    row.figmaMs = Math.round(Number(process.hrtime.bigint() - startedFigma) / 1e6);
    row.figmaBytes = figmaResult.bytes;

    const tree = await figcraftBridge.tree({ fig, page: pageName, depth: 2 });
    // ищем кадр страницы по имени на глубине 1: `<Страница>/<имя кадра>`
    const target = tree.data.nodes.find(
      (node) => node.depth === 1 && node.name.trim() === String(frame.name).trim(),
    );
    if (!target) throw new Error(`кадр «${frame.name}» не найден на странице «${pageName}»`);
    row.figcraftId = target.id;
    const startedFigcraft = process.hrtime.bigint();
    const figcraftResult = await figcraftBridge.png({ fig, node: target.id, out: figcraftOut, scale: 1 });
    row.figcraftMs = Math.round(Number(process.hrtime.bigint() - startedFigcraft) / 1e6);
    row.figcraftBytes = figcraftResult.bytes;

    Object.assign(row, pixelDiff(readFileSync(figmaOut), readFileSync(figcraftOut)));
  } catch (error) {
    row.status = `ошибка: ${error.message}`;
  }
  rows.push(row);
  console.error(`${dir.padEnd(10)} ${row.status === 'ок' ? `средняя ${row.mean}` : row.status}`);
}

const done = rows.filter((row) => row.status === 'ок');
const summary = {
  file: fig,
  workDir,
  pages: rows.length,
  compared: done.length,
  meanOfMeans: done.length
    ? Math.round((done.reduce((sum, row) => sum + row.mean, 0) / done.length) * 100) / 100
    : null,
  rows,
};

const markdown = [];
markdown.push('# Пиксель страниц: PNG моста Figma ↔ PNG FigCraft');
markdown.push('');
markdown.push(`Файл: \`${fig}\`. Страниц сверено: **${done.length}** из ${rows.length}.`);
markdown.push('');
markdown.push('| страница | кадр | размер | средняя | > 16 | > 48 | Figma PNG / рисовали | FigCraft PNG / рисовали |');
markdown.push('|---|---|---|---:|---:|---:|---:|---:|');
for (const row of rows) {
  if (row.status !== 'ок') {
    markdown.push(`| ${row.dir} | ${row.frame} | — | ${row.status} | — | — | — | — |`);
    continue;
  }
  markdown.push(
    `| ${row.dir} | ${row.frame} | ${row.sizeA} ↔ ${row.sizeB} | **${row.mean}** | ${row.over16} % | ${row.over48} % | ${Math.round(row.figmaBytes / 1024)} КБ / ${row.figmaMs} мс | ${Math.round(row.figcraftBytes / 1024)} КБ / ${row.figcraftMs} мс |`,
  );
}

if (outPath) {
  writeFileSync(outPath, markdown.join('\n') + '\n');
  console.error(`отчёт: ${outPath}`);
} else {
  console.error(markdown.join('\n'));
}
console.error(`PNG: ${workDir}`);
console.log(JSON.stringify(summary, null, 1));
