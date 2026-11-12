#!/usr/bin/env node
/**
 * Проверяет, что шаблон холодного старта не отстал от конвейера.
 *
 *   node tools/check-scaffold.mjs
 *
 * Класс ошибки: инструменты развиваются, а `tools/scaffold/**` остаётся
 * прежним. Так и вышло: шаблон разворачивал Astro `^5` при установленном 7.4.5
 * и не содержал половины команд — `variants`, `bindings`, `motion`,
 * `interactive`, `tokens:check`. Новый сайт получил бы урезанный конвейер.
 *
 * Два условия:
 *   1. файл, который есть и в шаблоне, и в проекте, совпадает байт в байт;
 *   2. каждая команда проекта, зовущая `tools/`, есть в шаблоне.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const root = process.cwd();
const scaffold = join(root, 'tools/scaffold');

if (!existsSync(scaffold)) {
  console.error('нет tools/scaffold — проверять нечего');
  process.exit(2);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const problems = [];

// 1. Совпадение файлов
let compared = 0;
for (const templateFile of walk(scaffold)) {
  const rel = relative(scaffold, templateFile);
  const live = join(root, rel);
  if (!existsSync(live)) continue; // шаблон может быть богаче проекта — это нормально
  // package.json у нового проекта свой: имя, версия, набор команд.
  // Его проверяет правило 2 — по составу команд.
  if (rel === 'package.json') continue;
  // `public/**` — данные проекта (шрифты, картинки), а не шаблон: каркас
  // кладёт туда заглушку, проект — свои файлы.
  if (rel.startsWith('public/')) continue;
  compared += 1;
  const a = readFileSync(templateFile, 'utf8');
  const b = readFileSync(live, 'utf8');
  if (a !== b) problems.push({ kind: 'файл', file: rel });
}

// 2. Команды
const templatePkg = JSON.parse(readFileSync(join(scaffold, 'package.json'), 'utf8'));
const projectPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
let scripts = 0;
for (const [name, command] of Object.entries(projectPkg.scripts)) {
  if (!command.includes('tools/')) continue;
  scripts += 1;
  if (!templatePkg.scripts[name]) problems.push({ kind: 'команда', name, command });
}

console.log(`сверено файлов: ${compared} · команд с tools/: ${scripts}`);

if (!problems.length) {
  console.log('шаблон холодного старта совпадает с конвейером');
  process.exit(0);
}

console.error(`\nрасхождений: ${problems.length}`);
for (const item of problems.slice(0, 20)) {
  if (item.kind === 'файл') console.error(`  файл: ${item.file}`);
  else console.error(`  команда: ${item.name} → ${item.command}`);
}
console.error('\nновый сайт получит устаревший конвейер — обновите tools/scaffold');
process.exit(1);
