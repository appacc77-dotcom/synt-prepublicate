#!/usr/bin/env node
/**
 * Разница двух снимков файла: какие секции изменились, появились, исчезли.
 *
 *   node tools/snapshot-diff.mjs <A.json> <B.json>
 *   node tools/snapshot-diff.mjs --last        # снимок против предыдущего в git
 *
 * Зачем: после правки макета надо знать, что пересобирать, а не пересобирать
 * всё. Снимок пишет `npm run intake`; отпечатки секций лежат в нём же.
 *
 * Коды: 0 — различий нет, 1 — есть различия, 2 — не смогли прочитать.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const args = process.argv.slice(2);

const readSnapshot = (path) => {
  if (!existsSync(path)) {
    console.error(`нет файла снимка: ${path}`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`снимок не читается: ${path} — ${error.message}`);
    process.exit(2);
  }
};

let pathA;
let pathB;

if (args.includes('--last')) {
  // Предыдущая версия снимка из git: сравнить «что изменилось с прошлого раза».
  const rel = 'design/figma/live/snapshot.json';
  pathB = join(root, rel);
  try {
    const previous = execFileSync('git', ['show', `HEAD~1:${rel}`], { encoding: 'utf8' });
    const tmp = join(root, 'reports', 'snapshot-prev.json');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(root, 'reports'), { recursive: true });
    writeFileSync(tmp, previous);
    pathA = tmp;
  } catch {
    console.error('в git нет предыдущей версии снимка — сравните два файла явно');
    process.exit(2);
  }
} else {
  [pathA, pathB] = args;
  if (!pathA || !pathB) {
    console.error('укажите два снимка: node tools/snapshot-diff.mjs A.json B.json');
    process.exit(2);
  }
}

const a = readSnapshot(pathA);
const b = readSnapshot(pathB);
const sa = a.sections ?? {};
const sb = b.sections ?? {};

const added = Object.keys(sb).filter((unit) => !sa[unit]);
const removed = Object.keys(sa).filter((unit) => !sb[unit]);
const changed = [];
for (const unit of Object.keys(sa)) {
  const before = sa[unit];
  const after = sb[unit];
  if (!after) continue;
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff = [...files].filter((file) => before[file] !== after[file]);
  if (diff.length) changed.push({ unit, files: diff });
}

const sameFile = a.fileKey === b.fileKey;
console.log(`снимок A: ${a.at} · ${Object.keys(sa).length} секций`);
console.log(`снимок B: ${b.at} · ${Object.keys(sb).length} секций`);
if (!sameFile) console.log(`ВНИМАНИЕ: разные файлы — ${a.fileKey} → ${b.fileKey}`);
console.log('');

if (!added.length && !removed.length && !changed.length) {
  console.log('различий нет: файл и секции те же');
  process.exit(0);
}

if (added.length) {
  console.log(`появились (${added.length}):`);
  for (const unit of added) console.log(`  + ${unit}`);
}
if (removed.length) {
  console.log(`исчезли (${removed.length}):`);
  for (const unit of removed) console.log(`  − ${unit}`);
}
if (changed.length) {
  console.log(`изменились (${changed.length}):`);
  for (const item of changed) console.log(`  ~ ${item.unit} — ${item.files.join(', ')}`);
}
console.log(`\nпересобрать: ${[...added, ...changed.map((c) => c.unit)].join(' ') || 'нечего'}`);
process.exit(1);
