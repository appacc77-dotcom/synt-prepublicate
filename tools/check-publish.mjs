#!/usr/bin/env node
/**
 * Проверяет, что в публикуемую сборку не попали служебные страницы.
 *
 *   node tools/check-publish.mjs
 *
 * Класс ошибки: отладочная страница живёт в `src/pages/` и уезжает в `dist/`
 * вместе с сайтом. Внешне безобидно — её просто не видно из меню, — но она
 * открывается по прямой ссылке и попадает в поиск. У нас уже было четыре
 * таких (`check-home-*`), и заметили их только перед публикацией.
 *
 * Что проверяется:
 *   1. в `dist/` нет страниц с отладочными именами (`check-`, `test-`,
 *      `probe-`, `_gen`, `gen.html`);
 *   2. служебные страницы студии (`structure.html`, `ds.html`) помечены
 *      `noindex` — они нужны в работе, но не в выдаче.
 *
 * Коды: 0 — чисто, 1 — в сборке служебное, 2 — нет сборки.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');

if (!existsSync(dist)) {
  console.error('нет dist/ — сначала npm run build');
  process.exit(2);
}

const FORBIDDEN = /^(check-|test-|probe-|debug-|gen\b|gen\.html|_gen)/i;
const INTERNAL = ['structure.html', 'ds.html'];

const pages = readdirSync(dist).filter((f) => f.endsWith('.html'));
const problems = [];

for (const page of pages) {
  if (FORBIDDEN.test(page)) {
    problems.push({ kind: 'отладка', page });
  }
}

for (const page of INTERNAL) {
  const file = join(dist, page);
  if (!existsSync(file)) continue;
  const html = readFileSync(file, 'utf8');
  if (!/name="robots"[^>]*noindex/i.test(html)) {
    problems.push({ kind: 'индексируется', page });
  }
}

if (problems.length) {
  console.log(`страниц в сборке: ${pages.length} · проблем: ${problems.length}`);
  for (const p of problems.slice(0, 15)) {
    console.log(`  ${p.page}: ${p.kind === 'отладка' ? 'отладочная страница в публикации' : 'служебная страница без noindex'}`);
  }
  console.error('\nуберите страницу из src/pages или пометьте noindex — в публикацию идёт только сайт');
  process.exit(1);
}

console.log(`страниц в сборке: ${pages.length} · отладочных нет · служебные с noindex`);
process.exit(0);
