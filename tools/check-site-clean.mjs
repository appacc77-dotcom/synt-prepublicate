#!/usr/bin/env node
/**
 * Ворота выпуска: набор файлов сайта собирается сам, без мастерской.
 *
 *   node tools/check-site-clean.mjs
 *
 * Смысл (решение 397): уезжает не «весь репозиторий», а только то, что
 * перечислено в `site-files.json`. Проверка собирает этот набор в стороне
 * и смотрит, что он живёт без `design/`, `docs/`, `reports/` и `tools/`.
 * Если в выпуск просочился студийный файл или страница потянула спеку —
 * здесь это станет красным, а не в браузере заказчика.
 *
 * Коды: 0 — чисто, 1 — выпуск тянет мастерскую, 2 — среда (нет node_modules).
 */
import { readFileSync, existsSync, rmSync, readdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
// Собираем вне рабочего каталога: прогон приёмки сверяет содержимое дерева
// до и после, и временный каталог внутри проекта делал бы каждый прогон
// «изменявшимся» — то есть негодным как доказательство коммита.
const out = mkdtempSync(join(tmpdir(), 'site-check-'));
const outName = out;

const fail = (message) => {
  console.error(`\nвыпуск не готов: ${message}\n`);
  process.exit(1);
};

if (!existsSync(join(root, 'node_modules'))) {
  console.error('нет node_modules — выполните npm install');
  process.exit(2);
}
if (!existsSync(join(root, 'site-files.json'))) fail('нет site-files.json — контракта выпуска');

// Экспорт сам по себе ценен как проверка: он копирует только разрешённое
// и собирает результат. Красный код — либо набор неверный, либо сборка
// требует мастерскую.
try {
  execFileSync(process.execPath, [join(root, 'tools/site-export.mjs'), '--allow-dirty', '--no-manifest', '--out', outName], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  });
} catch (error) {
  const log = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').slice(-10).join('\n');
  fail(`сборка набора не прошла\n${log}`);
}

const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
const problems = [];

// 1. В наборе не должно быть студийных страниц и их данных.
for (const page of ['src/pages/structure.astro', 'src/pages/ds.astro']) {
  if (existsSync(join(out, page))) problems.push(`${page}: студийная страница в выпуске`);
}
if (existsSync(join(out, 'public/structure'))) problems.push('public/structure: студийные превью в выпуске');

// 2. Никакой файл выпуска не импортирует мастерскую.
const walk = (dir, base = '') => {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...walk(join(dir, entry.name), rel));
    else result.push(rel);
  }
  return result;
};

const allFiles = walk(out).filter((p) => !p.startsWith('node_modules') && !p.startsWith('dist'));
const sourceFiles = walk(out).filter((p) => /\.(astro|mjs|js|ts|json)$/.test(p) && !p.startsWith('node_modules'));
for (const rel of sourceFiles) {
  const text = readFileSync(join(out, rel), 'utf8');
  for (const line of text.split('\n')) {
    if (!/^\s*import\s/.test(line)) continue;
    const spec = line.match(/from\s+['"]([^'"]+)['"]/);
    if (!spec) continue;
    const target = spec[1];
    if (target.startsWith('node:') || target.startsWith('.')) {
      // Относительный импорт не должен выводить за пределы выпуска.
      if (/(^|[/\\])design[/\\]|(^|[/\\])docs[/\\]|(^|[/\\])reports[/\\]|(^|[/\\])tools[/\\]/.test(target)) {
        problems.push(`${rel}: импорт из мастерской — ${target}`);
      }
      continue;
    }
    // Пакет из package.json — нормально; всё остальное значит, что файл
    // выпуска тянет что-то, чего в наборе нет.
    const pkgName = target.startsWith('@') ? target.split('/').slice(0, 2).join('/') : target.split('/')[0];
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (!deps[pkgName]) problems.push(`${rel}: пакет ${pkgName} не объявлен в package.json`);
  }
}

// 3. Стили на месте: они генерируются студией, но лежат в src/ и едут с сайтом.
for (const style of ['src/styles/tokens.css', 'src/styles/typography.css']) {
  if (!existsSync(join(out, style))) problems.push(`${style}: нет сгенерированных стилей`);
}

// 4. Сборка не содержит студийных адресов.
const dist = join(out, 'dist');
if (!existsSync(dist)) fail('сборка прошла, но dist/ нет');
for (const page of ['structure.html', 'ds.html']) {
  if (existsSync(join(dist, page))) problems.push(`dist/${page}: студийная страница собралась`);
}
if (!existsSync(join(dist, 'index.html'))) problems.push('dist/index.html: главной нет');



if (problems.length) {
  console.log(`файлов в выпуске: ${sourceFiles.length} · проблем: ${problems.length}`);
  for (const p of problems.slice(0, 12)) console.log(`  ${p}`);
  rmSync(out, { recursive: true, force: true });
  fail('выпуск зависит от мастерской');
}

// Вес считаем по собранному набору, а не по манифесту: манифест может быть
// от прошлого выпуска, и тогда число врёт.
let distBytes = 0;
for (const rel of walk(join(out, 'dist'))) distBytes += statSync(join(out, 'dist', rel)).size;
const mb = (distBytes / 1048576).toFixed(1);
console.log(`набор: ${allFiles.length} файлов · сборка ${mb} МБ · без design/ и docs/ · студийных страниц нет`);
rmSync(out, { recursive: true, force: true });
process.exit(0);
