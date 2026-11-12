#!/usr/bin/env node
/**
 * Проверяет, что общий `tools/lib/` остаётся чистым.
 *
 *   node tools/check-lib.mjs
 *
 * Решение 393 смягчило правило самостоятельности инструментов: код в `lib/`
 * разрешён, но только как чистые функции формата. Это работает, пока `lib/`
 * не начинает зависеть от проекта — иначе получается тот самый общий
 * «conveyor-core», против которого правило и заводилось.
 *
 * Что проверяется:
 *   1. файл из `tools/lib/` импортирует только `node:` и другие файлы `lib/`;
 *   2. в `lib/` нет обращений к проекту: `design/`, `src/`, `dist/`,
 *      `reports/`, `process.cwd()`.
 *
 * Коды: 0 — чисто, 1 — нарушение, 2 — нет каталога.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const lib = join(root, 'tools/lib');

if (!existsSync(lib)) {
  console.error('нет tools/lib');
  process.exit(2);
}

const files = readdirSync(lib).filter((f) => f.endsWith('.mjs'));
const problems = [];

for (const file of files) {
  const source = readFileSync(join(lib, file), 'utf8');
  for (const line of source.split('\n')) {
    const spec = line.match(/^\s*import\s.*?from\s+['"]([^'"]+)['"]/);
    if (spec) {
      const target = spec[1];
      const ok = target.startsWith('node:') || target.startsWith('./');
      if (!ok) problems.push(`${file}: импорт ${target} — из lib можно только node: и соседние файлы`);
    }
    if (/process\.cwd\(\)|['"]design\/|['"]src\/|['"]dist\/|['"]reports\//.test(line)) {
      problems.push(`${file}: обращение к проекту — ${line.trim().slice(0, 60)}`);
    }
  }
}

if (problems.length) {
  console.log(`файлов в lib: ${files.length} · нарушений: ${problems.length}`);
  for (const p of problems.slice(0, 12)) console.log(`  ${p}`);
  console.error('\nlib/ — чистые функции формата: без проекта и без его путей');
  process.exit(1);
}

console.log(`файлов в lib: ${files.length} · только node: и соседние файлы · проекта не видит`);
process.exit(0);
