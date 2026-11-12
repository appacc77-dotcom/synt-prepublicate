#!/usr/bin/env node
/**
 * Ворота кропа: фон показывает то, что просил файл, а не «примерно то фото».
 *
 *   node tools/check-crops.mjs [--url /practice.html]
 *
 * Класс ошибки. У фото в Figma есть `imageTransform`: какую часть картинки и
 * с каким масштабом показать. Если компонент просто пишет
 * `background-size: cover`, картинка показывается целиком — визуально похоже,
 * но это другое фото. Так было в карточках «Практики для мягкого входа»:
 * в макете видна арка, на сайте — вся комната (пиксель 9,4 вместо 3,5).
 *
 * Как проверяем. Собираем по всем спекам ожидания: картинка (по имени файла)
 * → допустимые масштабы в процентах. Потом идём по страницам и у каждого
 * элемента с `background-image` из этой картинки сравниваем вычисленный
 * `background-size` с ожидаемым. Расхождение больше 2 % — красные.
 *
 * Проверка не требует `data-figma-node`: она цепляется за сам файл картинки,
 * поэтому покрывает и узлы, которые разметка схлопнула.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname, normalize, basename } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const root = process.cwd();
const dist = join(root, 'dist');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};

if (!existsSync(join(dist, 'index.html'))) {
  console.error('нет сборки — сначала npm run build');
  process.exit(2);
}

// --- 1. Ожидания из спек ------------------------------------------------
const units = [];
for (const page of readdirSync(join(root, 'design/figma/pages'), { withFileTypes: true })) {
  if (!page.isDirectory()) continue;
  for (const section of readdirSync(join(root, 'design/figma/pages', page.name), { withFileTypes: true })) {
    if (!section.isDirectory()) continue;
    const specPath = join(root, 'design/figma/pages', page.name, section.name, 'spec.json');
    if (!existsSync(specPath)) continue;
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const route = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8')).routes?.[page.name] ?? null;
    for (const node of spec.nodes ?? []) {
      for (const fill of node.fills ?? []) {
        if (fill.type !== 'IMAGE' || !fill.imageHash) continue;
        // Только CROP: у FILL transform описывает позицию внутри кадра, и
        // cover — верный ответ. Иначе ворота краснели на founder-hero зря.
        if (fill.scaleMode !== 'CROP') continue;
        const t = fill.imageTransform;
        if (!t) continue;
        const sx = (100 / (t[0][0] || 1)).toFixed(1);
        const sy = (100 / (t[1][1] || 1)).toFixed(1);
        // В имени файла живёт короткий префикс хеша (practice-card-9fae), поэтому
        // ожидание индексируется четырьмя символами: 12 символов в имени не найти.
        units.push({ unit: `${page.name}/${section.name}`, hash: fill.imageHash.slice(0, 4), sx, sy, route });
      }
    }
  }
}

// Имя файла в сборке начинается с хеша: practice-card-9fae.jpg → 9fae.
const expectations = new Map();
for (const item of units) {
  if (!expectations.has(item.hash)) expectations.set(item.hash, []);
  expectations.get(item.hash).push(item);
}

const routes = [
  ...new Set(
    JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8')).routes
      ? Object.values(JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8')).routes)
      : [],
  ),
];
const pageList = arg('--url', null) ? [arg('--url', null)] : routes.filter(Boolean);

// --- 2. Смотрим фактическую сборку ---------------------------------------
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';
  const file = normalize(join(dist, path));
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
const port = Number(process.env.CROPS_PORT ?? 4344);
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const problems = [];
let checked = 0;

for (const urlPath of pageList) {
  await page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const found = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const style = getComputedStyle(el);
      const image = style.backgroundImage;
      if (!image || image === 'none') continue;
      const match = image.match(/url\("?([^")]+)"?\)/);
      if (!match) continue;
      out.push({ url: match[1], size: style.backgroundSize });
    }
    return out;
  });

  for (const item of found) {
    const name = basename(item.url).replace(/\.[a-z0-9]+$/i, '');
    // Ищем ожидание по короткому хешу в имени файла (practice-card-9fae).
    const hit = [...expectations.entries()].find(([hash]) => name.includes(hash));
    if (!hit) continue;
    const [hash, list] = hit;
    // `cover`/`auto` — это тоже ответ, и почти всегда неверный: файл просил
    // показать часть картинки, а не «как влезет». Раньше такие значения
    // молча пропускались, и дефект карточек практик проходил мимо ворот.
    const [w, h] = item.size.split(' ').map((v) => parseFloat(v));
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      const exp = list[0];
      const wantsCrop = Math.abs(Number(exp.sx) - 100) > 2 || Math.abs(Number(exp.sy) - 100) > 2;
      if (wantsCrop) {
        checked += 1;
        problems.push(`${exp.unit}: ${name} → фон ${item.size} вместо ${exp.sx}% ${exp.sy}% (узел ${hash})`);
      }
      continue;
    }
    const ok = list.some((exp) => Math.abs(w - Number(exp.sx)) <= 2 && Math.abs(h - Number(exp.sy)) <= 2);
    checked += 1;
    if (!ok) {
      const exp = list[0];
      problems.push(
        `${exp.unit}: ${name} → фон ${item.size}, в файле ${exp.sx}% ${exp.sy}% (узел ${hash})`,
      );
    }
  }
}

await browser.close();
server.close();

if (problems.length) {
  console.log(`проверено фонов: ${checked} · расходятся с файлом: ${problems.length}`);
  for (const row of [...new Set(problems)].slice(0, 12)) console.log(`  ${row}`);
  console.error('\nкроп из Figma не перенесён: возьмите imageTransform из спеки (backgroundOf)');
  process.exit(1);
}

console.log(`кропы совпадают с файлом · проверено фонов: ${checked}`);
process.exit(0);
