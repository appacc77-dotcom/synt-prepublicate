#!/usr/bin/env node
/**
 * Модуль 1 — figma-intake (P0 + P1).
 *
 * Снимает живой файл Figma через мост: структуру страниц, дизайн-систему и
 * реальность (масштабы, ширины). Ничего не выдумывает и ничего не выгружает
 * заранее — читает то, что открыто сейчас.
 *
 *   node tools/intake.mjs [--quiet]
 *
 * Вход:  design/figma/project.json
 * Выход: design/figma/live/{structure,ds,reality}.json + snapshot.json
 *
 * ВАЖНО: `design/figma/live/structure.json` — снимок живого файла (что есть в
 * Figma). Это не то же самое, что `design/figma/structure.json` — данные
 * страницы /structure.html, которые собирает tools/structure.mjs. Одинаковое
 * имя у двух разных смыслов уже путало; держим различие в шапках обоих.
 *
 * Коды возврата:
 *   0 — снимок снят, fileKey совпал
 *   1 — открыт другой файл (или fileKey не совпал с project.json)
 *   2 — мост недоступен: не запущен плагин или Figma закрыта
 *   3 — скрипт Figma вернул ошибку
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runFigma, FigmaError } from './figma/cli.mjs';

const root = process.cwd();
const quiet = process.argv.includes('--quiet');

const die = (code, message) => {
  console.error(`intake: ${message}`);
  process.exit(code);
};

const projectPath = join(root, 'design/figma/project.json');
if (!existsSync(projectPath)) die(3, 'нет design/figma/project.json');
const project = JSON.parse(readFileSync(projectPath, 'utf8'));

const liveDir = join(root, project.paths.live);
mkdirSync(liveDir, { recursive: true });

// `--sections-only` — пересчитать отпечатки секций без обращения к Figma.
// Нужно после переэкспорта: файл не менялся, менялись только спеки на диске.
if (process.argv.includes('--sections-only')) {
  const snapshotPath = join(liveDir, 'snapshot.json');
  if (!existsSync(snapshotPath)) die(3, 'нет снимка — сначала npm run intake');
  const previous = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const pagesRoot = join(root, 'design/figma/pages');
  const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  const sections = {};
  if (existsSync(pagesRoot)) {
    for (const page of readdirSync(pagesRoot)) {
      const pageDir = join(pagesRoot, page);
      if (!statSync(pageDir).isDirectory()) continue;
      for (const name of readdirSync(pageDir)) {
        const dir = join(pageDir, name);
        if (!statSync(dir).isDirectory()) continue;
        const entry = {};
        for (const [key, file] of [['spec', 'spec.json'], ['crop', 'crop.png'], ['states', 'states.json']]) {
          const path = join(dir, file);
          if (existsSync(path)) entry[key] = hashFile(path);
        }
        if (Object.keys(entry).length) sections[`${page}/${name}`] = entry;
      }
    }
  }
  const before = Object.keys(previous.sections ?? {}).length;
  previous.sections = sections;
  previous.at = new Date().toISOString();
  writeFileSync(snapshotPath, JSON.stringify(previous, null, 2) + '\n');
  console.log(`отпечатки секций обновлены без моста: ${before} → ${Object.keys(sections).length}`);
  process.exit(0);
}

/** Ответ моста читается через файловый дескриптор: pipe теряет всё сверх 64 КБ. */
function figma(args, timeoutMs = 120000) {
  try {
    return runFigma(args, { timeoutMs });
  } catch (error) {
    if (error instanceof FigmaError) {
      const transport = ['E_NO_PLUGIN', 'E_NO_BROKER', 'E_TIMEOUT', 'E_NO_ANSWER', 'E_VERSION_MISMATCH'];
      die(transport.includes(error.code) ? 2 : 3, `${error.code}: ${error.message}`);
    }
    die(3, String(error.message ?? error));
  }
}

// --- 1. Мост жив? ---------------------------------------------------------
const peek = figma(['status', '--peek']);
if (!peek.connected) {
  die(2, 'мост не подключён — открой файл в Figma desktop и запусти плагин DESIGN:OS Bridge');
}

const live = peek.plugins?.[0] ?? {};
if (live.fileName && live.fileName !== project.source.fileName) {
  die(1, `открыт «${live.fileName}», а проект настроен на «${project.source.fileName}»`);
}
if (peek.versionMatch === false || peek.protocolMatch === false) {
  die(2, 'версия плагина не совпадает с CLI — обнови одну из сторон');
}

// --- 2. Дизайн-система ----------------------------------------------------
const dsPath = join(liveDir, 'ds.json');
figma(['scan-design-system', '--out', dsPath, '--timeout', '60000']);
const ds = JSON.parse(readFileSync(dsPath, 'utf8'));

// --- 3. Структура и реальность -------------------------------------------
const runScript = (name, outName) => {
  const result = figma(['exec-js', join(root, 'tools/figma', name), '--timeout', '90000']);
  if (!result.result) die(3, `${name}: пустой результат`);
  writeFileSync(join(liveDir, outName), JSON.stringify(result.result, null, 2) + '\n');
  return result;
};

const structureReply = runScript('read-structure.js', 'structure.json');
const realityReply = runScript('read-reality.js', 'reality.json');

// --- 4. Тот ли это файл? --------------------------------------------------
const fileKey = structureReply.fileContext?.fileKey;
if (fileKey !== project.source.fileKey) {
  die(1, `fileKey ${fileKey} ≠ ${project.source.fileKey} в project.json`);
}

// --- 5. Сводка ------------------------------------------------------------
const reality = realityReply.result;

// Файл редактируют прямо во время работы: сравниваем с прошлым снимком.
const snapshotPath = join(liveDir, 'snapshot.json');
const previous = existsSync(snapshotPath)
  ? JSON.parse(readFileSync(snapshotPath, 'utf8'))
  : null;

const drift = [];
if (previous?.byPage) {
  for (const [page, n] of Object.entries(reality.instances.byPage)) {
    const before = previous.byPage[page];
    if (before !== undefined && before !== n) drift.push(`${page}: ${before} → ${n}`);
  }
  if (previous.fileKey !== project.source.fileKey) drift.push('fileKey сменился');
}

// Отпечатки секций: по ним видно, что изменилось между снимками, не сверяя
// каждую спеку руками. Секции появляются с экспортом, поэтому снимок берёт
// то, что уже лежит на диске.
const pagesRoot = join(root, 'design/figma/pages');
const sections = {};
const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
if (existsSync(pagesRoot)) {
  for (const page of readdirSync(pagesRoot)) {
    const pageDir = join(pagesRoot, page);
    if (!statSync(pageDir).isDirectory()) continue;
    for (const name of readdirSync(pageDir)) {
      const dir = join(pageDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const unit = `${page}/${name}`;
      const entry = {};
      for (const [key, file] of [['spec', 'spec.json'], ['crop', 'crop.png'], ['states', 'states.json']]) {
        const path = join(dir, file);
        if (existsSync(path)) entry[key] = hashFile(path);
      }
      if (Object.keys(entry).length) sections[unit] = entry;
    }
  }
}

const snapshot = {
  at: new Date().toISOString(),
  sections,
  fileName: project.source.fileName,
  fileKey,
  counts: {
    pages: structureReply.result.pages.length,
    components: ds.counts.components,
    tokens: ds.counts.tokens,
    styles: ds.counts.styles,
    instances: reality.instances.total,
    scaled: reality.instances.scaledCount,
    frames1440: reality.topLevelWidths['1440'] ?? 0,
  },
  byPage: reality.instances.byPage,
};
writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');

if (!quiet) {
  const c = snapshot.counts;
  console.log(`файл:        ${snapshot.fileName}  ${fileKey}`);
  console.log(`страниц:     ${c.pages}`);
  console.log(`компонентов: ${c.components}`);
  console.log(`токенов:     ${c.tokens}`);
  console.log(`стилей:      ${c.styles}`);
  console.log(`инстансов:   ${c.instances}  отмасштабированных: ${c.scaled}`);
  console.log(`фреймов 1440: ${c.frames1440}`);
  console.log(`секций в снимке: ${Object.keys(snapshot.sections).length}`);
  if (c.scaled > 0) {
    console.log(`\nВНИМАНИЕ: ${c.scaled} отмасштабированных инстансов — размер из дерева не равен размеру на холсте.`);
  }
  if (drift.length) {
    console.log(`\nФАЙЛ МЕНЯЛСЯ с прошлого снимка (${previous.at}):`);
    for (const d of drift) console.log(`   ${d}`);
    console.log('   спеки и кропы, снятые раньше, могли устареть.');
  }
}
