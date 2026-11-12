#!/usr/bin/env node
/**
 * Проверяет, что интерактивные элементы не переключаются рывком.
 *
 *   node tools/check-motion.mjs [--url /]
 *
 * Класс ошибки: блок статичен по умолчанию. В макете есть только состояние
 * покоя, поэтому переход надо закладывать — и легко забыть. Базовый слой
 * `motion.css` даёт переход всем ссылкам, кнопкам и `summary`; этот скрипт
 * проверяет, что он действительно доехал до страницы и что собственные
 * правила компонентов его не отменили.
 *
 * Второе: при `prefers-reduced-motion: reduce` переходы должны выключаться —
 * иначе мы ломаем доступность ради красоты.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const dist = join(root, 'dist');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const urlPath = arg('--url', '/');

// Различаем два состояния: сборки нет вовсе и сборка есть, но страниц сайта
// в ней нет (новый проект: собрана только structure.html). Иначе сообщение
// «нет dist/» врёт о причине.
if (!existsSync(dist)) {
  console.error('нет dist/ — сначала npm run build');
  process.exit(2);
}
if (!existsSync(join(dist, 'index.html'))) {
  console.error('в dist нет страниц сайта (собрана только служебная) — сначала соберите страницы');
  process.exit(2);
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
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

// Порт по умолчанию может быть занят — например, вторым сайтом на машине.
// Тогда берём свободный от системы, а не падаем с EADDRINUSE: проверка
// движения не должна зависеть от того, что ещё запущено.
const wanted = Number(process.env.MOTION_PORT ?? 4337);
const port = await new Promise((resolve, reject) => {
  const onError = (error) => {
    if (error.code !== 'EADDRINUSE') return reject(error);
    server.removeListener('error', onError);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  };
  server.once('error', onError);
  server.listen(wanted, '127.0.0.1', () => resolve(wanted));
});
if (port !== wanted) console.log(`порт ${wanted} занят, проверяю на ${port}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);

const report = await page.evaluate(() => {
  const selector = 'a[href], button, summary, [role="tab"], [role="button"], input, select, textarea';
  const out = { total: 0, dead: [], byDuration: {} };

  for (const el of document.querySelectorAll(selector)) {
    // Только то, что реально видно: скрытые пункты меню не в счёт.
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;

    out.total += 1;
    const cs = getComputedStyle(el);
    const properties = cs.transitionProperty.split(',').map((p) => p.trim());
    const durations = cs.transitionDuration.split(',').map((d) => parseFloat(d) || 0);
    const animated = properties.some((p, i) => p !== 'none' && (durations[i] ?? durations[0]) > 0);

    const label = (el.textContent ?? '').trim().slice(0, 28) || el.getAttribute('aria-label') || el.tagName.toLowerCase();
    if (animated) {
      const key = `${durations[0] * 1000}мс`;
      out.byDuration[key] = (out.byDuration[key] ?? 0) + 1;
    } else {
      out.dead.push({ label, tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().split(' ')[0] });
    }
  }
  return out;
});

console.log(`интерактивных элементов видно: ${report.total}`);
for (const [duration, count] of Object.entries(report.byDuration)) {
  console.log(`  переход ${duration}: ${count}`);
}

// Доступность: при reduce переходы должны гаснуть у ВСЕХ видимых элементов,
// а не у первого. Раньше проверялся один `querySelector` — элемент, у которого
// защита не сработала, проходил мимо ворот.
await page.emulateMedia({ reducedMotion: 'reduce' });
const reduced = await page.evaluate(() => {
  const selector = 'a[href], button, summary, [role="tab"], [role="button"], input, select, textarea';
  const slow = [];
  let checked = 0;
  for (const el of document.querySelectorAll(selector)) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    checked += 1;
    const durations = getComputedStyle(el).transitionDuration.split(',').map((d) => parseFloat(d) || 0);
    const worst = Math.max(...durations);
    if (worst > 0.01) {
      slow.push({
        label: (el.textContent ?? '').trim().slice(0, 24) || el.getAttribute('aria-label') || el.tagName.toLowerCase(),
        duration: worst,
      });
    }
  }
  return { checked, slow };
});

await browser.close();
server.close();

let failed = false;

if (report.dead.length) {
  failed = true;
  console.error(`\nбез перехода: ${report.dead.length}`);
  for (const item of report.dead.slice(0, 15)) {
    console.error(`  ${item.tag}.${item.cls || '—'} «${item.label}»`);
  }
  console.error('\nэлемент без перехода переключается рывком — добавьте transition или используйте базовый слой');
}

if (reduced && reduced.slow.length) {
  failed = true;
  console.error(
    `\nprefers-reduced-motion не отключает переходы: ${reduced.slow.length} из ${reduced.checked}`,
  );
  for (const item of reduced.slow.slice(0, 8)) {
    console.error(`  «${item.label}» — ${item.duration}s`);
  }
}

if (failed) process.exit(1);

console.log('\nу всех видимых интерактивных элементов есть переход');
console.log('prefers-reduced-motion отключает движение');
