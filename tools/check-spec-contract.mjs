#!/usr/bin/env node
/**
 * Проверяет, что спека соответствует контракту: версия схемы, обязательные
 * поля, целостность ссылок, типографика текста.
 *
 *   node tools/check-spec-contract.mjs [--unit booking/booking-formats]
 *
 * Класс ошибки: спека неполна, а сборка об этом не знает. Дважды случалось
 * одно и то же: в спеке нет шрифта — вёрстка рисует подставным, строки
 * переносятся иначе, заголовок наезжает на соседа. Геометрия при этом
 * зелёная, потому что координаты верны. Второй раз — координаты: они были
 * поняты не тем способом, каким их хранит источник, и уехало всё содержимое.
 *
 * Что проверяется:
 *   1. `schemaVersion` — одна известная версия; незнакомая это код 3,
 *      а не «наверное, сойдёт»;
 *   2. обязательные поля спеки и узла;
 *   3. целостность: id уникальны, цепочка depth не рвётся;
 *   4. у текста есть `fontFamily` и `fontSize` — либо явная пометка, что в
 *      файле смешаны стили (`fontMixed`/`fontSizeMixed`). Такие узлы не
 *      считаются нарушением контракта: шрифта нет не потому, что его забыли
 *      выгрузить, а потому что он разный в одном абзаце. Это дефект файла
 *      (FI-5), он живёт в реестре долгов, а не в воротах.
 *
 * Привязки здесь не проверяются: этим занимается `check-bindings`, который
 * спрашивает живой файл. Снимок `ds.json` содержит только часть переменных,
 * и сверка по нему давала бы тысячу ложных срабатываний.
 *
 * Осознанные исключения — `design/figma/spec-exceptions.json`: узел, поле,
 * причина, решение. Спеки генерируются, поэтому правка живёт отдельным
 * файлом, а не в самой спеке.
 *
 * Коды возврата: 0 — сходится, 1 — нарушения, 2 — ошибка запуска,
 * 3 — проверить нельзя (нет версии схемы, нет снимка переменных).
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_VERSION = 1;
const REQUIRED_SPEC = ['file', 'section', 'nodes'];
const REQUIRED_SECTION = ['id', 'name', 'w', 'h'];
const REQUIRED_NODE = ['id', 'type', 'depth', 'x', 'y', 'w', 'h', 'visible'];

const root = process.cwd();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const only = arg('--unit', null);

const projectPath = join(root, 'design/figma/project.json');
if (!existsSync(projectPath)) {
  console.error('нет design/figma/project.json');
  process.exit(2);
}
const project = JSON.parse(readFileSync(projectPath, 'utf8'));

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`не разобран ${path}: ${error.message}`);
    process.exit(2);
  }
}

// Исключения: «здесь шрифта нет осознанно».
const exceptions = new Set();
const exceptionsPath = join(root, 'design/figma/spec-exceptions.json');
for (const item of readJson(exceptionsPath, { exceptions: [] }).exceptions ?? []) {
  exceptions.add(`${item.unit}#${item.id}#${item.field}`);
}

function findSpecs() {
  const base = join(root, project.paths?.sections ?? 'design/figma/pages');
  if (!existsSync(base)) return [];
  const out = [];
  for (const page of readdirSync(base)) {
    const pageDir = join(base, page);
    if (!statSync(pageDir).isDirectory()) continue;
    for (const section of readdirSync(pageDir)) {
      const file = join(pageDir, section, 'spec.json');
      if (existsSync(file)) out.push({ unit: `${page}/${section}`, file });
    }
  }
  return out;
}

const specs = findSpecs().filter((s) => !only || s.unit === only);
if (!specs.length) {
  console.error(only ? `нет спеки ${only}` : 'спек не найдено');
  process.exit(2);
}

const problems = [];
const incomplete = [];
const mixed = [];
const allowed = (unit, id, field) => exceptions.has(`${unit}#${id}#${field}`);

for (const { unit, file } of specs) {
  const spec = readJson(file);
  if (!spec) {
    problems.push({ unit, text: 'спека не читается' });
    continue;
  }

  // 1. Версия схемы.
  if (spec.schemaVersion === undefined) {
    incomplete.push({ unit, text: 'нет schemaVersion — перевыгрузите секцию' });
  } else if (spec.schemaVersion !== SCHEMA_VERSION) {
    incomplete.push({ unit, text: `schemaVersion ${spec.schemaVersion}, контракт знает ${SCHEMA_VERSION}` });
  }

  // 2. Обязательные поля.
  for (const key of REQUIRED_SPEC) {
    if (spec[key] === undefined) problems.push({ unit, text: `нет поля ${key}` });
  }
  // Ключ файла обязателен, но у спеки из архива его нет: архив не знает
  // облачного ключа. Такое отступление живёт записью, а не тишиной.
  if (!spec.file?.key && !allowed(unit, spec.section?.id ?? '', 'file.key')) {
    problems.push({ unit, text: 'нет file.key — число без файла не число' });
  }
  for (const key of REQUIRED_SECTION) {
    if (spec.section?.[key] === undefined) problems.push({ unit, text: `нет section.${key}` });
  }

  const nodes = spec.nodes ?? [];
  if (!nodes.length) problems.push({ unit, text: 'в спеке нет узлов' });

  const seen = new Set();
  let previousDepth = 0;
  for (const node of nodes) {
    for (const key of REQUIRED_NODE) {
      if (node[key] === undefined) problems.push({ unit, text: `узел ${node.id ?? '?'}: нет ${key}` });
    }
    if (node.id !== undefined) {
      if (seen.has(node.id)) problems.push({ unit, text: `id ${node.id} встречается дважды` });
      seen.add(node.id);
    }
    // Глубина растёт не больше чем на шаг: иначе родитель не находится
    // и координаты считаются не от того предка.
    if (typeof node.depth === 'number') {
      if (node.depth > previousDepth + 1) {
        problems.push({ unit, text: `узел ${node.id}: глубина ${node.depth} после ${previousDepth} — родитель потерян` });
      }
      previousDepth = node.depth;
    }

    // 3. Типографика текста.
    const isText = node.type === 'TEXT' && (node.text ?? '').trim();
    if (isText && !node.fontFamily && !node.fontMixed && !allowed(unit, node.id, 'fontFamily')) {
      problems.push({ unit, text: `текст ${node.id} без fontFamily — рисуется подставным шрифтом` });
    }
    if (isText && !node.fontSize && !node.fontSizeMixed && !allowed(unit, node.id, 'fontSize')) {
      problems.push({ unit, text: `текст ${node.id} без fontSize` });
    }
    if (isText && (node.fontMixed || node.fontSizeMixed)) mixed.push(`${unit} · ${node.id}`);
  }
}

if (incomplete.length) {
  console.log(`секций: ${specs.length} · проверить нельзя: ${incomplete.length}`);
  for (const item of incomplete.slice(0, 8)) console.log(`  ${item.unit}: ${item.text}`);
  if (incomplete.length > 8) console.log(`  … и ещё ${incomplete.length - 8}`);
  console.error('\nсхема спеки не та, что знает контракт: перевыгрузите секции (npm run export)');
  process.exit(3);
}

if (problems.length) {
  console.log(`секций: ${specs.length} · нарушений: ${problems.length}`);
  for (const p of problems.slice(0, 20)) console.log(`  ${p.unit}: ${p.text}`);
  if (problems.length > 20) console.log(`  … и ещё ${problems.length - 20}`);
  console.error('\nспека не по контракту: починится перевыгрузкой или записью в spec-exceptions.json');
  process.exit(1);
}

const texts = specs.reduce((n, s) => n + (readJson(s.file)?.nodes ?? []).filter((x) => x.type === 'TEXT' && (x.text ?? '').trim()).length, 0);
console.log(`секций: ${specs.length} · текстов: ${texts} · версия схемы: ${SCHEMA_VERSION} · нарушений: 0`);
if (mixed.length) {
  console.log(`смешанные стили в узле (FI-5, дефект файла): ${mixed.length}`);
  for (const item of mixed.slice(0, 6)) console.log(`  ${item}`);
}
console.log('спеки соответствуют контракту: поля, ссылки и типографика на месте');
process.exit(0);
