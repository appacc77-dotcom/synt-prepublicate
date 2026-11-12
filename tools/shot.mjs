#!/usr/bin/env node
/**
 * Снимок элемента собранного сайта для сверки с кропом из Figma.
 *
 *   node tools/shot.mjs .hero .screens/hero.png 1440 [--url /structure.html]
 *   node tools/shot.mjs --node 383:761 .screens/x.png 1440 [--url /booking.html]
 *
 * `--node` берёт элемент по `data-figma-node`: имя CSS-класса угадывать не
 * нужно, а id узла есть в спеке и не меняется при переименовании класса.
 *
 * `--batch jobs.json` — много секций за один запуск: браузер и сервер одни
 * на всех, страница загружается один раз на адрес. Сорок семь отдельных
 * запусков Chromium ради сорока семи кадров — та же работа, что уже сделана
 * для замера.
 *
 * Поднимает dist/ на локальном порту, ждёт шрифты и картинки, снимает элемент.
 * Требует npm run build и установленный chromium.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { extname, join, normalize, dirname, isAbsolute } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const dist = join(root, 'dist');

// Пакетный режим: список заданий вместо одного.
const batchPath = process.argv.includes('--batch') ? process.argv[process.argv.indexOf('--batch') + 1] : null;
const batchJobs = batchPath
  ? JSON.parse(readFileSync(isAbsolute(batchPath) ? batchPath : join(root, batchPath), 'utf8'))
  : null;
const port = Number(process.env.SHOT_PORT ?? 4330);
const base = `http://127.0.0.1:${port}`;

const nodeArg = process.argv.includes('--node') ? process.argv[process.argv.indexOf('--node') + 1] : null;
// С --node позиционные аргументы сдвигаются: файл и ширина, селектора нет.
const positionals = process.argv.slice(2).filter((a, i, all) => {
  if (a.startsWith('--')) return false;
  if (all[i - 1] === '--node' || all[i - 1] === '--url') return false;
  return true;
});
const selector = batchJobs ? null : nodeArg ? `[data-figma-node~="${nodeArg}"]` : positionals[0] ?? '.hero';
const urlArg = (() => {
  const i = process.argv.indexOf('--url');
  return i > 0 ? process.argv[i + 1] : '/';
})();
const out = batchJobs ? null : nodeArg ? (positionals[0] ?? '.screens/shot.png') : (positionals[1] ?? '.screens/shot.png');
const width = Number(nodeArg ? (positionals[1] ?? 1440) : (positionals[2] ?? 1440));

// Старый снимок удаляем сразу: если съёмка упадёт, сравнение не должно
// молча взять кадр прошлого прогона.
const target = out ? (isAbsolute(out) ? out : join(root, out)) : null;
if (target) rmSync(target, { force: true });

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
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', base);
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

await new Promise((r) => server.listen(port, '127.0.0.1', r));

const browser = await chromium.launch();

/** Снимает один элемент: общая часть для одиночного и пакетного режима. */
async function shoot(page, job) {
  const sel = job.node ? `[data-figma-node~="${job.node}"]` : job.selector;
  const file = isAbsolute(job.out) ? job.out : join(root, job.out);
  rmSync(file, { force: true });

  const el = await page.$(sel);
  if (!el) {
    console.error(`Не найден селектор ${sel}`);
    return 'missing';
  }
  // Скрытая секция (результат квиза до ответов) не снимается: ожидание
  // стабильности элемента висит до таймаута и роняет весь проход.
  const visible = await el.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  });
  if (!visible) {
    console.error(`Секция скрыта на странице: ${sel}`);
    return 'hidden';
  }

  // Оверлеи (шапка поверх секции) прячем, если цель их не содержит.
  const isOverlayTarget = await el.evaluate(
    (node) => !!node.closest('[data-overlay]') || !!node.querySelector('[data-overlay]'),
  );
  if (!isOverlayTarget) {
    await page.evaluate(() => {
      for (const node of document.querySelectorAll('[data-overlay]')) {
        node.dataset.shotWas = node.style.visibility;
        node.style.visibility = 'hidden';
      }
    });
  }

  const box = await el.boundingBox();
  mkdirSync(dirname(file), { recursive: true });
  try {
    await el.screenshot({ path: file, timeout: 20000 });
  } catch (error) {
    console.error(`Снимок не вышел (${sel}): ${String(error.message).split('\n')[0]}`);
    return 'failed';
  } finally {
    // Оверлеи возвращаем: страница переиспользуется, и спрятанная шапка
    // делала следующую секцию «скрытой» без причины.
    await page.evaluate(() => {
      for (const node of document.querySelectorAll('[data-overlay]')) {
        node.style.visibility = node.dataset.shotWas ?? '';
        delete node.dataset.shotWas;
      }
    });
  }
  console.log(JSON.stringify({ selector: sel, out: job.out, height: Math.round(box.height), w: Math.round(box.width) }));
  return 'ok';
}

if (batchJobs) {
  // Группируем по адресу: страница грузится один раз на группу.
  const byUrl = new Map();
  for (const job of batchJobs) {
    const url = job.url ?? '/';
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(job);
  }
  let failed = false;
  for (const [url, group] of byUrl) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(base + url, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(async () => {
      const pending = [...document.images].filter((i) => !i.complete);
      await Promise.race([
        Promise.all(pending.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
    });
    await page.evaluate(() => document.fonts.ready);
    for (const job of group) {
      // Одна неснятая секция не обрывает проход: остальные нужны.
      const status = await shoot(page, job).catch((error) => {
        console.error(`Снимок упал (${job.out}): ${String(error.message).split('\n')[0]}`);
        return 'failed';
      });
      if (status !== 'ok') failed = true;
    }
    await page.close();
  }
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
}

const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
// networkidle на странице с десятками картинок не наступает — ждём load,
// а изображения добираем явно.
await page.goto(base + urlArg, { waitUntil: 'load', timeout: 60000 });
// Ждём картинки, но не бесконечно: битая ссылка не должна вешать съёмку.
await page.evaluate(async () => {
  const pending = [...document.images].filter((i) => !i.complete);
  await Promise.race([
    Promise.all(pending.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
});
await page.evaluate(() => document.fonts.ready);

const el = await page.$(selector);
if (!el) {
  console.error(`Не найден селектор ${selector}`);
  await browser.close();
  server.close();
  process.exit(1);
}

// Шапка и подобные слои лежат поверх секций. При съёмке секции их прячем,
// иначе в кадр попадает чужой блок и сравнение с кропом врёт.
// Прячем оверлеи только когда снимаем секцию: если цель сама их содержит
// (страница целиком), они часть кадра и скрывать их нельзя.
const isOverlayTarget = await el.evaluate(
  (node) => !!node.closest('[data-overlay]') || !!node.querySelector('[data-overlay]'),
);
if (!isOverlayTarget) {
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('[data-overlay]')) node.style.visibility = 'hidden';
  });
}

const box = await el.boundingBox();
// Абсолютный путь берём как есть: join(root, '/tmp/x') склеил бы корень.
mkdirSync(dirname(target), { recursive: true });
await el.screenshot({ path: target });

console.log(JSON.stringify({ selector, out, width, height: Math.round(box.height), w: Math.round(box.width) }));

await browser.close();
server.close();
