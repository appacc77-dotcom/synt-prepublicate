#!/usr/bin/env node
/**
 * Сверка двух мостов по одному контракту (tools/bridges/README.md).
 *
 *   node tools/bridges/compare.mjs --a /tmp/figma-home.json --b /tmp/figcraft-home.json
 *   node tools/bridges/compare.mjs --a a.json --b b.json --png-a crop-a.png --png-b crop-b.png --out reports/bridges-home.md
 *
 * Что считает:
 *   - состав: сколько узлов у каждого, сколько путей только у одного;
 *   - типы: расхождения type на одинаковом пути;
 *   - геометрия: |Δx|, |Δy|, |Δw|, |Δh| по совпавшим путям — точно/0,5/1 px, максимум, среднее;
 *   - текст: сколько TEXT-узлов, у скольких текст совпал;
 *   - пиксель (если дали два PNG): средняя разница, доля > 16 и > 48.
 *
 * Ключ сверки — путь из имён. `id` у мостов разные и не сравниваются (README).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng } from '../lib/png.mjs';

const argv = process.argv.slice(2);
function option(name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
}
function die(code, message) {
  console.error(message);
  process.exit(code);
}

const pathA = option('a');
const pathB = option('b');
if (!pathA || !pathB) die(2, 'нужны --a <tree.json> и --b <tree.json>');

const treeA = JSON.parse(readFileSync(pathA, 'utf8'));
const treeB = JSON.parse(readFileSync(pathB, 'utf8'));
const labelA = option('label-a', treeA.source ?? 'A');
const labelB = option('label-b', treeB.source ?? 'B');

const byPath = (tree) => new Map(tree.nodes.map((node) => [node.path, node]));
const mapA = byPath(treeA);
const mapB = byPath(treeB);

const onlyA = [...mapA.keys()].filter((key) => !mapB.has(key));
const onlyB = [...mapB.keys()].filter((key) => !mapA.has(key));
const common = [...mapA.keys()].filter((key) => mapB.has(key));

const typeMismatch = [];
const geometry = { exact: 0, leHalf: 0, leOne: 0, worst: [], deltas: [] };
const text = { total: 0, same: 0, different: [], missingA: 0, missingB: 0 };

for (const key of common) {
  const a = mapA.get(key);
  const b = mapB.get(key);
  if (a.type !== b.type) typeMismatch.push({ path: key, a: a.type, b: b.type });

  const fields = ['x', 'y', 'w', 'h'];
  const deltas = {};
  let hasGeometry = false;
  for (const field of fields) {
    if (typeof a[field] === 'number' && typeof b[field] === 'number') {
      hasGeometry = true;
      deltas[field] = Math.round(Math.abs(a[field] - b[field]) * 100) / 100;
    }
  }
  if (hasGeometry) {
    const worst = Math.max(...Object.values(deltas));
    geometry.deltas.push(worst);
    if (worst <= 0.01) geometry.exact += 1;
    if (worst <= 0.5) geometry.leHalf += 1;
    if (worst <= 1) geometry.leOne += 1;
    if (worst > 0.5) geometry.worst.push({ path: key, worst, deltas, a: pick(a), b: pick(b) });
  }

  if (a.type === 'TEXT' || b.type === 'TEXT') {
    text.total += 1;
    if (typeof a.text !== 'string') text.missingA += 1;
    else if (typeof b.text !== 'string') text.missingB += 1;
    else if (normalizeText(a.text) === normalizeText(b.text)) text.same += 1;
    else if (text.different.length < 10) text.different.push({ path: key, a: a.text, b: b.text });
  }
}

function pick(node) {
  return { x: node.x, y: node.y, w: node.w, h: node.h };
}
function normalizeText(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}
const stats = (values) => {
  if (!values.length) return { count: 0, mean: null, max: null };
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    count: values.length,
    mean: Math.round((sum / values.length) * 1000) / 1000,
    max: Math.round(Math.max(...values) * 100) / 100,
  };
};
const geometryStats = stats(geometry.deltas);
geometry.worst.sort((one, two) => two.worst - one.worst);

// --- пиксель, если дали два PNG -------------------------------------------------
let pixel = null;
const pngA = option('png-a');
const pngB = option('png-b');
if (pngA && pngB) {
  const a = decodePng(readFileSync(pngA));
  const b = decodePng(readFileSync(pngB));
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  let sum = 0;
  let over16 = 0;
  let over48 = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      const diff =
        (Math.abs(a.data[i] - b.data[j]) +
          Math.abs(a.data[i + 1] - b.data[j + 1]) +
          Math.abs(a.data[i + 2] - b.data[j + 2])) /
        3;
      sum += diff;
      if (diff > 16) over16 += 1;
      if (diff > 48) over48 += 1;
    }
  }
  const total = w * h;
  pixel = {
    sizeA: `${a.width}x${a.height}`,
    sizeB: `${b.width}x${b.height}`,
    mean: Math.round((sum / total) * 100) / 100,
    over16: Math.round((over16 / total) * 10000) / 100,
    over48: Math.round((over48 / total) * 10000) / 100,
    compared: `${w}x${h}`,
  };
}

const result = {
  a: { label: labelA, file: treeA.file ?? null, page: treeA.page, total: treeA.nodes.length },
  b: { label: labelB, file: treeB.file ?? null, page: treeB.page, total: treeB.nodes.length },
  match: { common: common.length, onlyA: onlyA.length, onlyB: onlyB.length },
  types: { mismatched: typeMismatch.length, samples: typeMismatch.slice(0, 10) },
  geometry: {
    matchedWithGeometry: geometryStats.count,
    exact: geometry.exact,
    leHalf: geometry.leHalf,
    leOne: geometry.leOne,
    mean: geometryStats.mean,
    max: geometryStats.max,
    worst: geometry.worst.slice(0, 10),
  },
  text: {
    total: text.total,
    same: text.same,
    different: text.different.length,
    missingA: text.missingA,
    missingB: text.missingB,
    samples: text.different,
  },
  pixel,
};

const markdown = [];
markdown.push(`# Сверка мостов: ${labelA} ↔ ${labelB}`);
markdown.push('');
markdown.push(`Страница: **${treeA.page ?? '—'}**. Ключ сверки — путь из имён; id мостов не сравниваются.`);
markdown.push('');
markdown.push('| Метрика | Значение |');
markdown.push('|---|---:|');
markdown.push(`| узлов: ${labelA} / ${labelB} | ${result.a.total} / ${result.b.total} |`);
markdown.push(`| общих путей | ${result.match.common} |`);
markdown.push(`| только у ${labelA} | ${result.match.onlyA} |`);
markdown.push(`| только у ${labelB} | ${result.match.onlyB} |`);
markdown.push(`| расхождений типа | ${result.types.mismatched} |`);
markdown.push(`| геометрия: точно (≤0,01 px) | ${result.geometry.exact} |`);
markdown.push(`| геометрия: ≤0,5 px | ${result.geometry.leHalf} |`);
markdown.push(`| геометрия: ≤1 px | ${result.geometry.leOne} |`);
markdown.push(`| геометрия: средняя Δ / максимум | ${result.geometry.mean} / ${result.geometry.max} px |`);
markdown.push(`| текст: совпало из общих TEXT | ${result.text.same} / ${result.text.total} |`);
if (pixel) {
  markdown.push('');
  markdown.push('| Пиксель | Значение |');
  markdown.push('|---|---:|');
  markdown.push(`| размеры | ${pixel.sizeA} ↔ ${pixel.sizeB} (сравнено ${pixel.compared}) |`);
  markdown.push(`| средняя разница | ${pixel.mean} |`);
  markdown.push(`| > 16 | ${pixel.over16} % |`);
  markdown.push(`| > 48 | ${pixel.over48} % |`);
}
if (result.geometry.worst.length) {
  markdown.push('');
  markdown.push('## Худшие расхождения геометрии');
  markdown.push('');
  markdown.push(`| путь | Δ | ${labelA} | ${labelB} |`);
  markdown.push('|---|---:|---|---|');
  for (const item of result.geometry.worst) {
    markdown.push(
      `| ${item.path} | ${item.worst} | ${JSON.stringify(item.a)} | ${JSON.stringify(item.b)} |`,
    );
  }
}
if (result.types.samples.length) {
  markdown.push('');
  markdown.push('## Расхождения типа');
  markdown.push('');
  for (const item of result.types.samples) markdown.push(`- ${item.path}: ${item.a} ↔ ${item.b}`);
}
if (result.text.samples.length) {
  markdown.push('');
  markdown.push('## Расхождения текста');
  markdown.push('');
  for (const item of result.text.samples) {
    markdown.push(`- ${item.path}: «${String(item.a).slice(0, 80)}» ↔ «${String(item.b).slice(0, 80)}»`);
  }
}

const out = option('out');
if (out) writeFileSync(out, markdown.join('\n') + '\n');
console.log(JSON.stringify(result, null, 1));
if (!out) console.error(`\n${markdown.join('\n')}`);
