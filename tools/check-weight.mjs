#!/usr/bin/env node
/**
 * Ворота веса: страница не должна тянуть десятки мегабайт картинок.
 *
 *   node tools/check-weight.mjs
 *
 * Класс ошибки, который они закрывают. До 12.11.2026 `public/img` весил
 * 108 МБ: главная тянула ~29 МБ, «Практика» ~33 МБ. Оптимизатор в проекте
 * был, но никто его не запускал, и вес вернулся бы с первым переэкспортом:
 * в файле фото лежат PNG. Поэтому бюджет — воротами, а не в голове.
 *
 * Бюджеты:
 *   картинка  ≤ 950 КБ   (исключения — design/figma/weight-exceptions.json)
 *   страница  ≤ 20 МБ    (сумма всего, что она просит у /img и /fonts)
 *
 * Бюджеты подняты решением 405 (600 КБ / 14 МБ) и 406 (950 КБ / 20 МБ):
 * качество картинок важнее веса. При q82 большие фото «мылило» на тёмных
 * участках, при q92 — на градиентах неба и воды.
 *
 * Коды: 0 — в бюджете, 1 — перевес, 2 — нет сборки.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');

if (!existsSync(dist)) {
  console.error('нет dist/ — сначала npm run build');
  process.exit(2);
}

const IMAGE_BUDGET = 950 * 1024;
const PAGE_BUDGET = 20 * 1024 * 1024;

const exceptionsPath = join(root, 'design/figma/weight-exceptions.json');
const exceptions = existsSync(exceptionsPath)
  ? JSON.parse(readFileSync(exceptionsPath, 'utf8')).files ?? {}
  : {};

const problems = [];

// --- 1. Каждая картинка в бюджете -----------------------------------------
const imgDir = join(root, 'public/img');
const images = existsSync(imgDir)
  ? readdirSync(imgDir).filter((f) => /\.(png|jpe?g|webp|avif)$/i.test(f))
  : [];

let heaviest = { name: null, size: 0 };
for (const name of images) {
  const size = statSync(join(imgDir, name)).size;
  if (size > heaviest.size) heaviest = { name, size };
  if (size <= IMAGE_BUDGET) continue;
  if (exceptions[name]) continue;
  problems.push(`/img/${name}: ${(size / 1024).toFixed(0)} КБ — больше ${IMAGE_BUDGET / 1024} КБ`);
}

// --- 2. Каждая страница в бюджете ------------------------------------------
const pages = readdirSync(dist).filter((f) => f.endsWith('.html'));
const pageRows = [];
for (const page of pages) {
  const html = readFileSync(join(dist, page), 'utf8');
  const refs = new Set();
  const collect = (text) => {
    for (const match of text.matchAll(/["'(](\/(?:img|fonts|svg)\/[^"')\s]+)/g)) refs.add(match[1]);
  };
  collect(html);
  // Фоновые картинки живут в CSS: без этого страница «весила» бы 0.2 МБ,
  // хотя тянет те же мегабайты через background-image.
  for (const match of html.matchAll(/href="(\/_astro\/[^"]+\.css)"/g)) {
    const cssFile = join(dist, match[1].replace(/^\//, ''));
    if (existsSync(cssFile)) collect(readFileSync(cssFile, 'utf8'));
  }
  let bytes = 0;
  for (const ref of refs) {
    const file = join(dist, ref.split('?')[0]);
    if (existsSync(file)) bytes += statSync(file).size;
    const source = join(root, 'public', ref.split('?')[0]);
    if (!existsSync(file) && existsSync(source)) bytes += statSync(source).size;
  }
  pageRows.push({ page, bytes, refs: refs.size });
  if (bytes > PAGE_BUDGET) problems.push(`${page}: ${(bytes / 1048576).toFixed(1)} МБ — больше ${PAGE_BUDGET / 1048576} МБ`);
}

pageRows.sort((a, b) => b.bytes - a.bytes);

if (problems.length) {
  console.log(`картинок: ${images.length} · страниц: ${pages.length} · проблем: ${problems.length}`);
  for (const p of problems.slice(0, 12)) console.log(`  ${p}`);
  console.error('\nперевес: оптимизируйте картинку (tools/optimize-assets.mjs) или добавьте исключение с причиной');
  process.exit(1);
}

const mb = (n) => `${(n / 1048576).toFixed(2)} МБ`;
console.log(
  `картинок ${images.length} (максимум ${heaviest.name}: ${(heaviest.size / 1024).toFixed(0)} КБ) · ` +
    `самая тяжёлая страница ${pageRows[0].page}: ${mb(pageRows[0].bytes)} · бюджет ${PAGE_BUDGET / 1048576} МБ`,
);
process.exit(0);
