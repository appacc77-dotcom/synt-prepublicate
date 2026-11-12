#!/usr/bin/env node
/**
 * Проверяет, что каждый ассет, на который ссылается разметка, лежит в public.
 *
 *   node tools/check-assets.mjs
 *
 * Ловит случай, который уже дважды случался: иконка есть в складе Figma, но в
 * public/svg её не скопировали — страница показывает битую картинку, а ворота
 * геометрии этого не видят, потому что узел на месте.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = process.cwd();
const src = join(root, 'src');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(astro|ts|js|css)$/.test(entry)) out.push(full);
  }
  return out;
}

const refs = new Map();
for (const file of walk(src)) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/['"`(](\/(?:img|svg|fonts)\/[^'"`)\s]+)['"`)]/g)) {
    const ref = match[1];
    if (!refs.has(ref)) refs.set(ref, new Set());
    refs.get(ref).add(file.replace(`${root}/`, ''));
  }
}

const missing = [];
for (const [ref, files] of refs) {
  if (!existsSync(join(root, 'public', ref))) missing.push({ ref, files: [...files] });
}

console.log(`ассетов в разметке: ${refs.size}`);
if (!missing.length) {
  console.log('все файлы на месте');
  process.exit(0);
}

console.error(`\nне хватает ${missing.length}:`);
for (const { ref, files } of missing) console.error(`  ${ref}  ← ${files.join(', ')}`);
console.error('\nскопировать из склада: design/figma/assets/{img,svg}/');
process.exit(1);
