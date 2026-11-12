#!/usr/bin/env node
/**
 * Ищет вёрстку под ширины, которых нет в макете.
 *
 *   node tools/check-invented.mjs
 *
 * Класс ошибки: медиазапрос на 1100 px, когда кадр в файле один — 1440.
 * Это не перенос, а догадка: сжимать «по месту» значит придумать макет,
 * который некому проверить — замеру не с чем сверяться.
 *
 * Правило: ширины макета берутся из спек (корень каждой секции). Если кадр
 * один, то любой `@media` с шириной — выдумка. Если кадров несколько, запрос
 * оправдан только на ширине одного из них.
 *
 * Не ширинные запросы (`prefers-reduced-motion`, `print`) не трогаем.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// --- 1. Ширины макета ------------------------------------------------------
// Берём кадры страниц, объявленные в project.json, и их размер из снимка
// структуры. Секции внутри кадра уже (шапка 1424 при кадре 1440) — это не
// отдельная ширина макета.
const project = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8'));
const live = JSON.parse(readFileSync(join(root, 'design/figma/live/structure.json'), 'utf8'));

// Кадры страниц-макетов. Страница дизайн-системы — не макет: её «кадры» это
// образцы компонентов разной ширины (type-scale 824, play 47 и т. д.).
const dsPage = project.designSystemPage;
const frameIds = new Set(
  Object.entries(project.frames ?? {})
    .filter(([key]) => key !== dsPage)
    .map(([, frame]) => frame.id),
);
const widths = new Map();
for (const page of live.pages ?? []) {
  for (const frame of page.frames ?? []) {
    if (!frameIds.size || frameIds.has(frame.id)) {
      if (frame.w) widths.set(frame.w, `${page.name}/${frame.name}`);
    }
  }
}

// Страница структуры — наш инструмент, а не макет: у неё своя раскладка.
const skip = new Set(['src/pages/structure.astro']);

if (!widths.size) {
  console.error('в спеках нет ни одной ширины — проверять нечего');
  process.exit(2);
}

const designWidths = [...widths.keys()].sort((a, b) => a - b);

// --- 2. Медиазапросы -------------------------------------------------------
const files = walk(join(root, 'src')).filter(
  (f) => ['.astro', '.css'].includes(f.slice(f.lastIndexOf('.'))) && !skip.has(relative(root, f)),
);
const found = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes('@media')) continue;
    // ширина может быть в скобках: (max-width: 1100px), (width < 1024px), (width >= 768px)
    const numbers = [...line.matchAll(/(?:max-width|min-width|width)\s*[:<>=]+\s*(\d+)px/g)].map((m) => Number(m[1]));
    if (!numbers.length) continue;
    found.push({ file: relative(root, file), line: i + 1, widths: numbers, text: line.trim() });
  }
}

console.log(`ширины макета: ${designWidths.join(', ')} px (${widths.size} спек)`);
console.log(`медиазапросов с шириной: ${found.length}`);

const invented = [];
for (const query of found) {
  // Мобильный слой: ширины, разрешённые записью в design/mobile.json,
  // не считаются выдумкой — это дополнение по решению владельца.
  const mobile = existsSync(join(root, 'design/mobile.json'))
    ? JSON.parse(readFileSync(join(root, 'design/mobile.json'), 'utf8'))
    : null;
  const allowed = new Set([...(mobile?.breakpoints ?? []), ...designWidths]);
  if (query.widths.every((w) => allowed.has(w))) continue;

  // Кадр один — любой шириный запрос под него не опирается.
  if (designWidths.length === 1) {
    invented.push(query);
    continue;
  }
  // Кадров несколько — запрос должен совпасть с одним из них.
  const matches = query.widths.some((w) => designWidths.some((d) => Math.abs(d - w) <= 1));
  if (!matches) invented.push(query);
}

if (!invented.length) {
  console.log('вёрстки под несуществующие ширины нет');
  process.exit(0);
}

console.error(`\nпод ширины, которых нет в макете: ${invented.length}`);
for (const item of invented.slice(0, 15)) {
  console.error(`  ${item.file}:${item.line}  ${item.text}`);
}
console.error(
  designWidths.length === 1
    ? `\nв файле один кадр — ${designWidths[0]} px. Адаптив не изобретается: нет макета — нет слоя.`
    : `\nзапрос не совпал ни с одной шириной кадра: ${designWidths.join(', ')}`,
);
process.exit(1);
