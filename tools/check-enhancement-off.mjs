#!/usr/bin/env node
/**
 * Сборка «только из макета» действительно без дополнений.
 *
 *   npm run build:base && node tools/check-enhancement-off.mjs
 *
 * Проверяется не только разметка, но и поведение: в макете нет ни
 * выпадающих меню, ни подсказок, ни анимаций — значит их не должно быть ни в
 * HTML, ни в скриптах, ни в переходах.
 *
 * Коды: 0 — дополнений нет, 1 — есть, 2 — нечего проверять.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
// base-сборка живёт отдельно: обычный dist не пересобирается ради проверки.
const dist = join(root, process.env.ASTRO_OUT_DIR ?? 'dist-base');

if (!existsSync(dist)) {
  console.error(`нет ${process.env.ASTRO_OUT_DIR ?? 'dist-base'}/ — сначала npm run build:base`);
  process.exit(2);
}

const htmlFiles = readdirSync(dist).filter((f) => f.endsWith('.html'));
if (!htmlFiles.length) {
  console.error('в dist нет страниц — проверять нечего');
  process.exit(2);
}

const problems = [];

// 1. Атрибут слоя: в base-сборке он должен быть выключен на каждой странице.
for (const file of htmlFiles) {
  const html = readFileSync(join(dist, file), 'utf8');
  if (!html.includes('data-enhancements="off"')) {
    problems.push(`${file}: нет data-enhancements="off" — страница собрана не в base-режиме`);
  }
  // 2. Изобретённые элементы не должны попасть в разметку.
  if (html.includes('data-invented')) {
    const count = (html.match(/data-invented/g) ?? []).length;
    problems.push(`${file}: осталось изобретённых элементов — ${count}`);
  }
}

// 3. Скрипты дополнений: в base-сборке их код не должен выполняться.
//    Проверяем по маркерам, которые есть только в обработчиках дополнений.
const MARKERS = [
  ['data-dropdown', 'выпадающее меню шапки'],
  ['data-burger', 'мобильная панель'],
  ['data-play-note', 'подсказка прослушивания'],
  ['data-format', 'переключение формата'],
];
// Скрипты Astro встраивает в страницу, если они небольшие: ищем и в HTML,
// и в отдельных бандлах — иначе проверка смотрит в пустоту.
const scriptTexts = [];
for (const file of htmlFiles) scriptTexts.push([file, readFileSync(join(dist, file), 'utf8')]);
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (entry.endsWith('.js')) scriptTexts.push([path, readFileSync(path, 'utf8')]);
  }
};
if (existsSync(join(dist, '_astro'))) walk(join(dist, '_astro'));

const hasGuard = scriptTexts.some(([, text]) => text.includes('dataset.enhancements'));

for (const [marker, what] of MARKERS) {
  const inHtml = htmlFiles.some((f) => readFileSync(join(dist, f), 'utf8').includes(marker));
  if (inHtml && !hasGuard) {
    problems.push(`${what}: разметка есть, а условия слоя в скриптах нет`);
  }
}
if (!hasGuard) {
  problems.push('ни в одном собранном скрипте нет проверки слоя — обработчики работают всегда');
}

if (problems.length) {
  console.error(`base-сборка: страниц ${htmlFiles.length} · проблем ${problems.length}`);
  for (const problem of problems.slice(0, 12)) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`base-сборка: ${htmlFiles.length} страниц · дополнений нет (разметка, обработчики, движение)`);
