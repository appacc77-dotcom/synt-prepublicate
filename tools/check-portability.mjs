#!/usr/bin/env node
/**
 * Проверяет, что конвейер не знает про конкретный проект.
 *
 *   node tools/check-portability.mjs
 *
 * Смысл: инструменты и скилы должны переноситься на любой сайт. Значит в них не
 * может быть `fileKey`, имени файла, ключей страниц и адресов узлов этого
 * проекта — всё это приходит из `design/figma/project.json`.
 *
 * Проверяются: `tools/**` (кроме самих спек и ассетов), `skills/**`.
 * Комментарии не разбираются: если имя проекта упомянуто в объяснении, это
 * ошибка тоже — при переносе оно станет ложью.
 *
 * Исключения — в `tools/portability-allow.txt`, по одной строке на файл:
 * там ссылки на соседние проекты, которые как раз и есть источник
 * проверенных решений.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const root = process.cwd();
const projectPath = join(root, 'design/figma/project.json');
if (!existsSync(projectPath)) {
  console.error('нет design/figma/project.json — проверять нечего');
  process.exit(2);
}

const project = JSON.parse(readFileSync(projectPath, 'utf8'));
const fileKey = project.source?.fileKey ?? '';
const projectName = project.source?.fileName ?? project.source?.name ?? '';
// Бренд из имени файла: последнее слово без цифр. Именно он протекает в текст
// и заголовки: из имени файла вида «Website <Бренд>2» остаётся «<Бренд>».
const brand = (projectName.split(/\s+/).pop() ?? '').replace(/\d+$/, '');
const pageKeys = Object.keys(project.pages ?? {});

const allowPath = join(root, 'tools/portability-allow.txt');
const allowed = existsSync(allowPath)
  ? new Set(
      readFileSync(allowPath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')),
    )
  : new Set();

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (['.mjs', '.js', '.astro', '.md', '.css', '.ts'].includes(extname(entry))) out.push(full);
  }
  return out;
}

const files = [...walk(join(root, 'tools')), ...walk(join(root, 'skills'))].filter(
  (file) => !relative(root, file).startsWith('tools/portability-allow.txt'),
);

const problems = [];

for (const file of files) {
  const rel = relative(root, file);
  if (allowed.has(rel)) continue;
  const text = readFileSync(file, 'utf8');

  if (fileKey && text.includes(fileKey)) {
    problems.push({ rel, what: `fileKey ${fileKey}`, line: lineOf(text, fileKey) });
  }
  if (projectName && text.includes(projectName)) {
    problems.push({ rel, what: `имя файла «${projectName}»`, line: lineOf(text, projectName) });
  }
  if (brand.length > 3 && new RegExp(brand, 'i').test(text)) {
    problems.push({ rel, what: `бренд «${brand}»`, line: lineOf(text, brand) });
  }
  for (const key of pageKeys) {
    // ключ страницы как строковый литерал в коде — признак привязки к проекту
    const pattern = new RegExp(`['"\`]${key}['"\`]`);
    if (pattern.test(text)) {
      problems.push({ rel, what: `ключ страницы «${key}»`, line: lineOf(text, key) });
    }
  }
}

function lineOf(text, needle) {
  const index = text.indexOf(needle);
  return index < 0 ? 0 : text.slice(0, index).split('\n').length;
}

console.log(`проверено файлов: ${files.length}`);
console.log(`fileKey: ${fileKey || '—'} · имя: ${projectName || '—'} · страниц: ${pageKeys.length}`);

if (!problems.length) {
  console.log('\nинструменты и скилы от проекта не зависят');
  process.exit(0);
}

console.error(`\nнайдено ${problems.length} привязок к проекту:`);
for (const { rel, what, line } of problems) {
  console.error(`  ${rel}:${line} — ${what}`);
}
console.error('\nвсё проектное должно приходить из design/figma/project.json');
console.error(`если упоминание оправдано — добавьте файл в ${relative(root, allowPath)}`);
process.exit(1);
