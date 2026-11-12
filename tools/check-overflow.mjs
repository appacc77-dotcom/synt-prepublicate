#!/usr/bin/env node
/**
 * Проверяет, что содержимое блоков не вылезает за рамки и не налезает на
 * соседнюю секцию.
 *
 *   node tools/check-overflow.mjs [--url /booking.html]
 *
 * Класс ошибки: фиксированная высота там, где контент зависит от данных.
 * В макете нарисован один вариант — три пункта списка, короткое название,
 * одна строка формата. В собранной секции их больше, блок с `height: 209px`
 * не растёт, и текст уходит за границу: на соседнюю карточку, на форму, на
 * подвал. Замер и пиксель этого не видят — они снимают состояние, которое
 * совпадает с макетом.
 *
 * Две проверки:
 *   1. обрезанное содержимое — у блока `overflow: hidden`, а содержимое выше
 *      коробки: значит часть текста не видна никогда;
 *   2. наложение — содержимое секции заходит за верх следующей секции.
 *
 * Допуск (project.json.gates.overflowPx) отсекает разницу в пару пикселей:
 * это метрики шрифта, а не забытая высота. Осознанные исключения помечаются
 * в разметке атрибутом `data-overflow-ok` — чтобы решение было видно.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const dist = join(root, 'dist');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};

if (!existsSync(dist)) {
  console.error('нет dist/ — сначала npm run build');
  process.exit(2);
}

const project = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8'));
const LIMIT = project.gates?.overflowPx ?? 8;
const routes = Object.values(project.routes ?? {});
const pages = arg('--url', null) ? [arg('--url', '/')] : [...new Set(routes)];
if (!pages.length) {
  console.error('в project.json нет маршрутов');
  process.exit(2);
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2',
};

const server = createServer((req, res) => {
  const raw = decodeURIComponent(req.url.split('?')[0]);
  const path = normalize(join(dist, raw));
  if (!path.startsWith(dist)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const file = existsSync(path) && !path.endsWith('/') ? path : join(dist, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
// Занятый порт — не повод падать: берём свободный у системы.
const port = await new Promise((resolve, reject) => {
  const onError = (error) => {
    if (error.code !== 'EADDRINUSE') return reject(error);
    server.removeListener('error', onError);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  };
  server.once('error', onError);
  server.listen(4398, '127.0.0.1', () => resolve(4398));
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const problems = [];
let checked = 0;

for (const route of pages) {
  await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);

  const found = await page.evaluate((limit) => {
    const out = [];
    const skip = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
    const idOf = (el) => (el.getAttribute('data-figma-node') ?? '').trim().split(/\s+/)[0];
    const clsOf = (el) => (el.className ?? '').toString().split(/\s+/)[0];

    // 1. Обрезанное содержимое.
    for (const el of document.querySelectorAll('[data-figma-node]')) {
      if (skip.has(el.tagName) || el.hasAttribute('data-overflow-ok')) continue;
      const cs = getComputedStyle(el);
      const clipped = ['hidden', 'clip'].includes(cs.overflowY) || ['hidden', 'clip'].includes(cs.overflowX);
      if (!clipped) continue;
      const dy = el.scrollHeight - el.clientHeight;
      const dx = el.scrollWidth - el.clientWidth;
      if (dy > limit || dx > limit) {
        out.push({ kind: 'обрезано', id: idOf(el), tag: el.tagName.toLowerCase(), cls: clsOf(el), dy: Math.round(dy), dx: Math.round(dx) });
      }
    }

    // 2. Наложение: содержимое секции заходит за верх следующей.
    // Оверлеи (шапка поверх героя) и скрытые секции наложения не считают:
    // первое — задумано, второе — не видно.
    const sections = [...document.querySelectorAll('main > [data-figma-node], body > main > section[data-figma-node]')]
      .filter((el) => !el.hasAttribute('data-overlay') && getComputedStyle(el).display !== 'none');
    for (let i = 0; i < sections.length - 1; i += 1) {
      const cur = sections[i];
      const next = sections[i + 1];
      const nextTop = next.getBoundingClientRect().top;
      let bottom = cur.getBoundingClientRect().bottom;
      for (const el of cur.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.bottom > bottom) bottom = r.bottom;
      }
      const over = Math.round(bottom - nextTop);
      if (over > limit) {
        out.push({ kind: 'наложение', id: idOf(cur), tag: cur.tagName.toLowerCase(), cls: clsOf(cur), dy: over, dx: 0, next: idOf(next) });
      }
    }
    return out;
  }, LIMIT);

  checked += 1;
  for (const item of found) problems.push({ route, ...item });
}

await browser.close();
server.close();

console.log(`страниц: ${checked} · проблем: ${problems.length}`);
if (!problems.length) {
  console.log('содержимое влезает в свои блоки и не заходит на соседние секции');
  process.exit(0);
}

for (const p of problems) {
  const where = p.kind === 'наложение' ? `заходит на ${p.next} на ${p.dy} px` : `обрезано ${p.dy > 1 ? `по высоте ${p.dy} px` : ''}${p.dx > 1 ? ` по ширине ${p.dx} px` : ''}`;
  console.error(`  ${p.route} · ${p.id} (${p.tag}.${p.cls}) — ${where}`);
}
console.error('\nблок не растёт под содержимое: замените height на min-height');
process.exit(1);
