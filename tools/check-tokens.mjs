#!/usr/bin/env node
/**
 * Ищет `var(--token)` без определения и без запасного значения.
 *
 *   node tools/check-tokens.mjs
 *
 * Класс ошибки: `padding: var(--space-2xs) var(--space-m)` с несуществующим
 * токеном делает ВСЁ свойство недействительным — панель меню осталась без
 * отступов, и это не видно ни в замере, ни в пикселе. Браузер молчит.
 *
 * Определения собираются из src/styles/*.css. Если у `var()` есть второе
 * значение (`var(--x, 16px)`), токен не обязателен.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const root = process.cwd();
const stylesDir = join(root, 'src/styles');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// 1. Определения: --name: значение
const defined = new Set();
for (const file of walk(stylesDir)) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(match[1]);
}

if (!defined.size) {
  console.error('не найдено ни одного токена в src/styles — проверьте пути');
  process.exit(2);
}

// 2. Использования: var(--name) без запасного значения
const files = [...walk(join(root, 'src')), ...(existsSync(join(root, 'public')) ? [] : [])].filter((f) =>
  ['.astro', '.css'].includes(extname(f)),
);

const problems = [];
let usages = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const match of lines[i].matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)) {
      usages += 1;
      const name = match[1];
      const hasFallback = Boolean(match[2]);
      if (hasFallback) continue;
      if (defined.has(name)) continue;
      problems.push({ file: relative(root, file), line: i + 1, name });
    }
  }
}

console.log(`файлов: ${files.length} · использований var(): ${usages} · токенов определено: ${defined.size}`);

if (!problems.length) {
  console.log('несуществующих токенов нет');
  process.exit(0);
}

console.error(`\nнесуществующих токенов: ${problems.length}`);
for (const p of problems.slice(0, 25)) {
  console.error(`  ${p.file}:${p.line}  ${p.name}`);
}
console.error('\nсвойство с таким var() браузер отбросит целиком — оно молча исчезнет');
process.exit(1);
