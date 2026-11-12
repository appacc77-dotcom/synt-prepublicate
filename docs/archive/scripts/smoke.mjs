#!/usr/bin/env node
/**
 * Локальный smoke без DSH и без соседних проектов.
 * Поднимает dist/ на 127.0.0.1:4325, проходит все страницы в Chromium
 * на 1440 и 390, проверяет console, overflow и битые картинки.
 *
 * Требует: npm run build (или npm run check) и установленный chromium
 * Playwright: npx playwright install chromium.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const dist = join(root, 'dist');
const port = Number(process.env.SMOKE_PORT ?? 4325);
const base = `http://127.0.0.1:${port}`;
const pages = [
  '/', '/method.html', '/masters.html', '/practice.html', '/library.html',
  '/booking.html', '/quiz.html', '/offer.html', '/privacy.html',
  '/consent.html', '/404.html', '/structure.html', '/progress.html',
];

if (!existsSync(dist)) {
  console.error('Нет dist/. Сначала: npm run build');
  process.exit(1);
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', base);
  if (url.pathname === '/kanban/api/board') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ board: { cards: [] } }));
    return;
  }
  if (url.pathname === '/structure/pages/live/version.json') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ updatedAt: null, pages: {} }));
    return;
  }
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
});

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
console.log(`[smoke] ${base} ← ${dist}`);

const browser = await chromium.launch({ headless: true });
const failures = [];
for (const width of [1440, 390]) {
  for (const route of pages) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    try {
      const response = await page.goto(base + route, { waitUntil: 'networkidle' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        const height = document.body.scrollHeight;
        for (let y = 0; y < height; y += 800) {
          window.scrollTo(0, y);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(100);
      const state = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        broken: [...document.images]
          .filter((image) => image.getClientRects().length > 0)
          .filter((image) => !image.complete || image.naturalWidth === 0)
          .map((image) => image.getAttribute('src'))
          .slice(0, 5),
      }));
      if (!response || response.status() >= 400) {
        failures.push(`${width} ${route}: HTTP ${response?.status() ?? 'no response'}`);
      }
      if (state.scrollWidth > width + 1) {
        failures.push(`${width} ${route}: overflow ${state.scrollWidth} > ${width}`);
      }
      if (state.broken.length) {
        failures.push(`${width} ${route}: broken images ${state.broken.join(', ')}`);
      }
      if (consoleErrors.length) {
        failures.push(`${width} ${route}: console ${consoleErrors.join(' | ')}`);
      }
    } catch (error) {
      failures.push(`${width} ${route}: ${error.message}`);
    } finally {
      await page.close();
    }
  }
  console.log(`[smoke] ${width}px: ${pages.length} страниц`);
}
await browser.close();
await new Promise((resolve) => server.close(resolve));

if (failures.length) {
  console.error(`\n${failures.length} ошибок:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('\n[smoke] все страницы зелёные');
