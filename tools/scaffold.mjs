#!/usr/bin/env node
/**
 * Разворачивает минимальное приложение в пустой папке: конфиг Astro, каркас
 * страницы и внутренняя страница структуры. Всё остальное приносит конвейер.
 *
 *   node tools/scaffold.mjs [--force]
 *
 * Зачем: конвейер должен доводить новый сайт до /structure.html одними и теми
 * же командами. Инструменты уже лежат в `tools/`, но без каркаса Astro собрать
 * страницу не из чего. Шаблоны — в `tools/scaffold/`, они не знают ни про какой
 * проект: имя файла, страницы и кадры приходят из `design/figma/project.json`.
 *
 * Существующие файлы не перезаписываются без `--force`.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const root = process.cwd();
const force = process.argv.includes('--force');
const templates = join(root, 'tools/scaffold');

if (!existsSync(templates)) {
  console.error('нет tools/scaffold — нечего разворачивать');
  process.exit(2);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const written = [];
const skipped = [];

for (const file of walk(templates)) {
  const rel = relative(templates, file);
  const target = join(root, rel);
  if (existsSync(target) && !force) {
    skipped.push(rel);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(file));
  written.push(rel);
}

// package.json берётся из шаблона: список команд и версии живут в одном файле,
// иначе шаблон отстаёт от конвейера (так и случилось: Astro ^5 при живом 7.4.5
// и половина команд отсутствовала).
const pkgPath = join(root, 'package.json');
const pkgTemplate = join(templates, 'package.json');
if (!existsSync(pkgTemplate)) {
  console.error('нет tools/scaffold/package.json — нечего разворачивать');
  process.exit(2);
}
if (!existsSync(pkgPath) || force) {
  const pkg = JSON.parse(readFileSync(pkgTemplate, 'utf8'));
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  written.push('package.json');
} else {
  skipped.push('package.json');
}

console.log(`развёрнуто файлов: ${written.length}`);
for (const file of written) console.log(`  + ${file}`);
if (skipped.length) {
  console.log(`\nуже было, не тронуто: ${skipped.length}`);
  for (const file of skipped) console.log(`  = ${file}`);
}

console.log(`
дальше:
  npm install
  npm run discover -- --write     # project.json из живого файла
  npm run intake                  # снимок файла
  npm run ds:tokens               # токены и типографика
  npm run structure               # структура всех секций
  npm run build                   # dist/ со страницей structure.html
`);
