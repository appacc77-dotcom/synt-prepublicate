#!/usr/bin/env node
/**
 * Ворота ссылок: ни одна внутренняя ссылка не должна вести в пустоту.
 *
 *   node tools/check-links.mjs
 *
 * Класс ошибки, который они закрывают. В меню и подвале адресов не было, и
 * туда поставили заглушку `/404.html` — 223 ссылки. Половина вела в заглушку
 * при том, что страница существует: «Практики», «Форматы работы», «Отзывы»,
 * «Перейти к записи». Пользователь видит 404 там, где должен быть раздел.
 *
 * Правило: каждая ссылка `href="/..."` обязана указывать на существующий файл
 * сборки; исключения (юридические документы, соцсети) живут в
 * `design/links-exceptions.json` с причиной. Заглушка `/404.html` разрешена
 * всегда — это честный ответ «страницы нет», но её количество видно в отчёте.
 *
 * Коды: 0 — все ссылки живые, 1 — есть битые, 2 — нет сборки.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');

if (!existsSync(dist)) {
  console.error('нет dist/ — сначала npm run build');
  process.exit(2);
}

const exceptionsPath = join(root, 'design/links-exceptions.json');
const exceptions = existsSync(exceptionsPath)
  ? JSON.parse(readFileSync(exceptionsPath, 'utf8')).targets ?? {}
  : {};

const { readdirSync } = await import('node:fs');
const pages = readdirSync(dist).filter((f) => f.endsWith('.html'));

const broken = [];
const stubs = [];
const seen = new Set();

for (const page of pages) {
  const html = readFileSync(join(dist, page), 'utf8');
  for (const match of html.matchAll(/href="(\/[^"]*)"/g)) {
    const href = match[1];
    if (!href.startsWith('/')) continue;
    if (/^\/(_astro|fonts|img|svg|structure)\//.test(href)) continue;

    const path = href.split('#')[0].split('?')[0];
    if (!path) continue;

    if (path === '/404.html') {
      stubs.push(page);
      continue;
    }

    const target = path === '/' ? 'index.html' : path.replace(/^\//, '');
    const exists = existsSync(join(dist, target)) || existsSync(join(dist, target, 'index.html'));
    if (exists) continue;
    if (exceptions[path]) continue;

    const key = `${page} → ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    broken.push(key);
  }
}

if (broken.length) {
  console.log(`страниц: ${pages.length} · битых ссылок: ${broken.length}`);
  for (const row of broken.slice(0, 15)) console.log(`  ${row}`);
  console.error('\nссылка ведёт в пустоту: поправьте адрес или запишите исключение с причиной');
  process.exit(1);
}

const stubPages = new Set(stubs).size;
console.log(
  `ссылки живые · страниц ${pages.length} · на заглушку /404.html ведут ${stubs.length} ссылок ` +
    `на ${stubPages} страницах (юридические и контакты — без содержания)`,
);
process.exit(0);
