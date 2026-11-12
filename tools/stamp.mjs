#!/usr/bin/env node
/**
 * Проставляет в спеки отпечаток содержимого и версию облака — без перевыгрузки.
 *
 *   node tools/stamp.mjs [--force]
 *
 * Зачем: полная выгрузка секции — это десяток обращений к мосту, а отпечаток
 * нужен всем. Здесь один пакетный вызов на все секции: быстро и без изменений
 * в спеке, кроме двух полей.
 *
 * `--force` перезаписывает даже те спеки, где отпечаток уже есть.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runFigma, FigmaError } from './figma/cli.mjs';

const root = process.cwd();
const force = process.argv.includes('--force');
const project = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8'));
const sectionsRoot = join(root, project.paths.sections);

// --- собрать секции и их узлы --------------------------------------------
const entries = [];
for (const pageDir of readdirSync(sectionsRoot)) {
  const pagePath = join(sectionsRoot, pageDir);
  if (!statSync(pagePath).isDirectory()) continue;
  for (const sectionDir of readdirSync(pagePath)) {
    const specPath = join(pagePath, sectionDir, 'spec.json');
    if (!existsSync(specPath)) continue;
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    if (spec.fingerprint && !force) continue;
    entries.push({ specPath, id: spec.section.id, name: `${pageDir}/${sectionDir}` });
  }
}

if (!entries.length) {
  console.log('отпечатки уже проставлены');
  process.exit(0);
}

// --- один вызов моста на всё ---------------------------------------------
const template = readFileSync(join(root, 'tools/figma/fingerprints.js'), 'utf8');
const tmp = join(tmpdir(), `figma-fps-${process.pid}.js`);
// split/join, а не replace: replace заменил бы первое вхождение — в комментарии.
writeFileSync(tmp, template.split('__IDS__').join(JSON.stringify(entries.map((e) => e.id))));

let reply;
try {
  reply = runFigma(['exec-js', tmp, '--timeout', '180000'], { timeoutMs: 240000 });
} catch (error) {
  if (error instanceof FigmaError) {
    console.error(`stamp: ${error.code}: ${error.message}`);
    process.exit(2);
  }
  throw error;
}

const map = reply?.result;
if (!map) {
  console.error('stamp: пустой ответ моста');
  process.exit(3);
}

// --- версия облака --------------------------------------------------------
// Версию берём из последнего успешного ответа API: если квота исчерпана,
// live/api.json хранит то, что облако отдавало в прошлый раз.
let cloudVersion = null;
try {
  execFileSync(process.execPath, [join(root, 'tools/figma-api.mjs'), 'meta'], { stdio: 'ignore' });
} catch {
  /* 429 или нет сети — ниже прочитаем сохранённое */
}
try {
  const saved = join(root, 'design/figma/live/api.json');
  if (existsSync(saved)) cloudVersion = JSON.parse(readFileSync(saved, 'utf8')).version ?? null;
} catch {
  cloudVersion = null;
}

// --- записать -------------------------------------------------------------
let stamped = 0;
let skipped = 0;
for (const entry of entries) {
  const fresh = map[entry.id];
  if (!fresh) {
    skipped++;
    continue;
  }
  const spec = JSON.parse(readFileSync(entry.specPath, 'utf8'));
  // Отпечаток ставим только если содержимое не разошлось с узлами спеки.
  const sameCount = spec.nodes.length === fresh.count;
  spec.fingerprint = fresh.fingerprint;
  // Не затираем известную версию нулём: API мог не ответить (429).
  spec.cloudVersion = cloudVersion ?? spec.cloudVersion ?? null;
  if (!sameCount) spec.fingerprintMismatch = { nodes: spec.nodes.length, bridge: fresh.count };
  writeFileSync(entry.specPath, JSON.stringify(spec, null, 2) + '\n');
  stamped++;
}

console.log(`отпечатков проставлено: ${stamped}${skipped ? `, узлов не найдено: ${skipped}` : ''}`);
console.log(`версия облака: ${cloudVersion ?? 'недоступна'}`);
