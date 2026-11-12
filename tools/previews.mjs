#!/usr/bin/env node
/**
 * Снимает собранные секции Playwright'ом и раскладывает превью для /structure.html.
 *
 *   node tools/previews.mjs [--only home-hero]
 *
 * Для каждой секции из design/figma/structure.json ищет на странице элемент
 * `[data-figma-node~="<id>"]`. Нашёл — снимает его в `.screens/<slug>.png` и
 * копирует в `public/structure/<slug>-site.png`. Не нашёл — секция ещё не
 * собрана, это нормальный результат, а не ошибка.
 *
 * Код возврата: 0 — снято хоть что-то или нечего снимать; 1 — страница не открылась.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? process.argv[i + 1] : null;
})();

const dist = join(root, 'dist');
if (!existsSync(dist)) {
  console.error('Нет dist/. Сначала: npm run build');
  process.exit(2);
}

const data = JSON.parse(readFileSync(join(root, 'design/figma/structure.json'), 'utf8'));
const sections = data.pages.flatMap((p) => p.sections.map((s) => ({ ...s, page: p.key })));
const targets = sections.filter((s) => s.slug && (!only || s.slug === only));

mkdirSync(join(root, '.screens'), { recursive: true });
mkdirSync(join(root, 'public/structure'), { recursive: true });

const port = Number(process.env.PREVIEWS_PORT ?? 4334);
const base = `http://127.0.0.1:${port}`;
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', base);
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

try {
  await page.goto(base + '/', { waitUntil: 'load', timeout: 60000 });
} catch (error) {
  console.error(`страница не открылась: ${error.message.split('\n')[0]}`);
  await browser.close();
  server.close();
  process.exit(1);
}

await page.evaluate(() => document.fonts.ready);
await page.evaluate(async () => {
  const pending = [...document.images].filter((i) => !i.complete);
  await Promise.race([
    Promise.all(pending.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
});

const shots = [];
const missing = [];

// Секции живут на разных страницах: перед каждой переходим на свою.
const projectCfg = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8'));
const routes = projectCfg.routes ?? {};
// Общие секции размечены id компонента, а не инстанса страницы.
const sharedNodes = projectCfg.shared ?? {};
let currentRoute = '/';

for (const s of targets) {
  const route = routes[s.page] ?? '/';
  if (route !== currentRoute) {
    await page.goto(base + route, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    currentRoute = route;
  }
  // У общего компонента на странице свой id инстанса (шапка на библиотеке —
  // 267:923, а не 79:104). Пробуем общий id, затем собственный.
  const candidates = [sharedNodes[s.name], s.id].filter(Boolean);
  let handle = null;
  for (const domId of candidates) {
    handle = await page.$(`[data-figma-node~="${domId}"]`);
    if (handle) break;
  }
  if (!handle) {
    missing.push(s);
    continue;
  }
  const box = await handle.boundingBox();
  if (!box || box.width < 2 || box.height < 2) {
    missing.push(s);
    continue;
  }
  const file = join(root, '.screens', `${s.slug}.png`);
  await handle.screenshot({ path: file });
  copyFileSync(file, join(root, 'public/structure', `${s.slug}-site.png`));
  shots.push({ slug: s.slug, w: Math.round(box.width), h: Math.round(box.height) });
}

await browser.close();
server.close();

for (const s of shots) console.log(`  снято  ${s.slug.padEnd(26)} ${s.w}×${s.h}`);
for (const s of missing) console.log(`  ждёт   ${s.slug.padEnd(26)} не собрано`);
console.log(`\nснято ${shots.length}, ещё не собрано ${missing.length}`);
