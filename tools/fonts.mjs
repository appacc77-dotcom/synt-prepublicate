#!/usr/bin/env node
/**
 * Шрифты проекта: скачивает woff2 из Google Fonts по семьям и весам из
 * дизайн-системы и пишет `public/fonts/fonts.css`.
 *
 *   node tools/fonts.mjs            # скачать и записать
 *   node tools/fonts.mjs --check    # только сверить, что файлы на месте
 *
 * Зачем: холодный старт без этого шага даёт сайт на системных шрифтах, и
 * никто не знает, откуда взять настоящие. Семьи и веса берутся из
 * `design/figma/live/reality.json` — из текстовых стилей живого файла, а не
 * из списка в коде.
 *
 * Подмножества сохраняются отдельными файлами (cyrillic, latin, …): так
 * браузер грузит только нужное. Имена — `<семья>-<вес>[-italic]-<подмножество>.woff2`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const checkOnly = process.argv.includes('--check');
const fontsDir = join(root, 'public/fonts');
const realityPath = join(root, 'design/figma/live/reality.json');

if (!existsSync(realityPath)) {
  console.error('нет design/figma/live/reality.json — сначала npm run intake');
  process.exit(2);
}

const slug = (name) => name.toLowerCase().replace(/\s+/g, '-');
const reality = JSON.parse(readFileSync(realityPath, 'utf8'));

/** Семьи, веса и курсив из текстовых стилей файла. */
const wanted = new Map();
for (const style of reality.textStyles ?? []) {
  const font = style.font ?? {};
  if (!font.family) continue;
  const weight = (font.variationSettings ?? {}).wght ?? 400;
  const italic = String(font.style ?? '').includes('Italic');
  const key = `${font.family}|${weight}|${italic}`;
  wanted.set(key, { family: font.family, weight, italic });
}

if (!wanted.size) {
  console.log('в файле нет текстовых стилей — шрифты не нужны');
  process.exit(0);
}

/** Семейство для API: пробелы через плюс, курсив через ital. */
const apiFamily = (family) => family.replace(/\s+/g, '+');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const fetchText = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
};

/** Подмножество из комментария перед блоком: /* cyrillic *\/ */
const parseFaces = (css) => {
  const out = [];
  const parts = css.split('/*').slice(1);
  for (const part of parts) {
    const subset = part.slice(0, part.indexOf('*/')).trim();
    const block = part.slice(part.indexOf('@font-face'));
    if (!block) continue;
    const weight = /font-weight:\s*(\d+)/.exec(block)?.[1] ?? '400';
    const style = /font-style:\s*(\w+)/.exec(block)?.[1] ?? 'normal';
    const url = /url\((https:[^)]+\.woff2)\)/.exec(block)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1];
    if (url) out.push({ subset, weight, style, url, range });
  }
  return out;
};

if (checkOnly) {
  const missing = [];
  for (const { family, weight, italic } of wanted.values()) {
    const base = `${slug(family)}-${weight}${italic ? '-italic' : ''}`;
    const files = existsSync(fontsDir)
      ? readdirSync(fontsDir).filter((f) => f.startsWith(`${base}-`) && f.endsWith('.woff2'))
      : [];
    if (!files.length) missing.push(`${family} ${weight}${italic ? ' italic' : ''}`);
  }
  if (missing.length) {
    console.error(`нет файлов шрифтов (${missing.length}): ${missing.join(', ')}`);
    console.error('скачать: node tools/fonts.mjs');
    process.exit(1);
  }
  console.log(`шрифты на месте: ${wanted.size} начертаний`);
  process.exit(0);
}

mkdirSync(fontsDir, { recursive: true });
const css = [
  '/* Сгенерировано tools/fonts.mjs из текстовых стилей живого файла. Не править руками. */',
  '',
];
let downloaded = 0;

for (const { family, weight, italic } of wanted.values()) {
  const axis = italic ? `ital,wght@1,${weight}` : `wght@${weight}`;
  const url = `https://fonts.googleapis.com/css2?family=${apiFamily(family)}:${axis}&display=swap`;
  const faces = parseFaces(await fetchText(url));
  if (!faces.length) {
    console.error(`не нашлось начертаний: ${family} ${weight}`);
    continue;
  }
  for (const face of faces) {
    const name = `${slug(family)}-${weight}${italic ? '-italic' : ''}-${face.subset}.woff2`;
    const target = join(fontsDir, name);
    if (!existsSync(target)) {
      const res = await fetch(face.url, { headers: { 'user-agent': UA } });
      if (!res.ok) throw new Error(`${res.status} ${face.url}`);
      writeFileSync(target, Buffer.from(await res.arrayBuffer()));
      downloaded += 1;
    }
    css.push(
      '@font-face {',
      `  font-family: '${family}';`,
      `  font-style: ${italic ? 'italic' : 'normal'};`,
      `  font-weight: ${weight};`,
      '  font-display: swap;',
      `  src: url('${name}') format('woff2');`,
      face.range ? `  unicode-range: ${face.range};` : null,
      '}',
      '',
    );
  }
}

writeFileSync(join(fontsDir, 'fonts.css'), css.filter((l) => l !== null).join('\n'));
console.log(`шрифтов: ${wanted.size} начертаний · скачано файлов: ${downloaded} · fonts.css записан`);
