#!/usr/bin/env node
/**
 * Убирает из склада ассеты, на которые не ссылается ни одна спека.
 *
 *   node tools/assets-prune.mjs [--dry]
 *
 * Нужен после смены схемы имён: старые `arrow-quiet.svg` остаются лежать,
 * хотя иконки теперь называются `arrow-quiet-white-right.svg`.
 */
import { readFileSync, readdirSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dry = process.argv.includes('--dry');
const project = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8'));

const assetsRoot = join(root, project.paths.assets ?? 'design/figma/assets');
const sectionsRoot = join(root, project.paths.sections ?? 'design/figma/pages');

if (!existsSync(assetsRoot) || !existsSync(sectionsRoot)) {
  console.error('нет склада или секций');
  process.exit(2);
}

const used = new Set();
for (const pageDir of readdirSync(sectionsRoot)) {
  const pagePath = join(sectionsRoot, pageDir);
  if (!statSync(pagePath).isDirectory()) continue;
  for (const sectionDir of readdirSync(pagePath)) {
    const specPath = join(pagePath, sectionDir, 'spec.json');
    if (!existsSync(specPath)) continue;
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    for (const list of [spec.assets?.images ?? [], spec.assets?.icons ?? []]) {
      for (const a of list) if (a.file) used.add(join(root, a.file));
    }
  }
}

const all = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else all.push(full);
  }
};
walk(assetsRoot);

const orphans = all.filter((f) => !used.has(f));
let bytes = 0;
for (const f of orphans) bytes += statSync(f).size;

for (const f of orphans) {
  if (!dry) unlinkSync(f);
  console.log(`  ${dry ? 'удалил бы' : 'удалён'}  ${f.slice(root.length + 1)}`);
}

console.log(`\nвсего файлов ${all.length}, используется ${used.size}, лишних ${orphans.length} (${(bytes / 1024 / 1024).toFixed(1)} МБ)`);
