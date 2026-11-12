#!/usr/bin/env node
/**
 * Проверяет, что цвета в спеках совпадают со значениями переменных в файле.
 *
 *   node tools/check-bindings.mjs
 *
 * Класс ошибки, который ловит: в спеке записано хранимое значение (цвет краски),
 * а действует значение переменной. Так 164 узла с полупрозрачной заливкой
 * оказались непрозрачными: карточка отзыва должна была просвечивать (0.35).
 *
 * Читает все спеки, собирает узлы с привязкой к переменной и одним вызовом
 * моста сверяет цвета. Возвращает exit 1 при расхождении.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { runFigma, waitForPlugin } from './figma/cli.mjs';

const root = process.cwd();
const pagesRoot = join(root, 'design/figma/pages');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === 'spec.json') out.push(full);
  }
  return out;
}

// Новый проект: секций ещё не экспортировали — проверять действительно нечего,
// и это не ошибка. Ошибка — когда секции есть в карте, а папки нет.
const project = existsSync(join(root, 'design/figma/project.json'))
  ? JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8'))
  : {};
const hasUnits = (project.acceptance ?? []).length > 0;

if (!existsSync(pagesRoot)) {
  if (!hasUnits) {
    console.log('нет design/figma/pages — проверять нечего');
    process.exit(0);
  }
  console.error('нет design/figma/pages, хотя в карте есть секции — нужен экспорт');
  process.exit(2);
}

// Без живого плагина сверка не начнётся: ждать её в тишине — значит
// получить многосекундный «зависший» шаг вместо честного «моста нет».
if (!waitForPlugin(15)) {
  console.error('плагин моста не отвечает 15 с — открой Figma и запусти плагин');
  process.exit(2);
}

const items = [];
const specs = walk(pagesRoot);

for (const specPath of specs) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  for (const node of spec.nodes) {
    const bound = node.bound || {};
    for (const kind of ['fills', 'strokes']) {
      const aliases = bound[kind] || [];
      const paints = node[kind] || [];
      for (let index = 0; index < aliases.length; index += 1) {
        const paint = paints[index];
        if (!paint || !paint.color) continue;
        items.push({ id: node.id, kind, index, expected: paint.color });
      }
    }
  }
}

if (!items.length) {
  console.log('привязок к переменным в спеках нет');
  process.exit(0);
}

const template = readFileSync(join(root, 'tools/figma/check-bindings.template.js'), 'utf8');

// Пачки: у плагина жёсткий бюджет на вызов, а привязок больше тысячи. Пачка
// из 30 узлов рвёт транспорт плагина («outcome-unknown»), из 10 проходит.
const CHUNK = 10;
let checked = 0;
const mismatches = [];
const skipped = [];

/**
 * Одна пачка. Если плагин не выдержал (транспорт рвётся на большом вызове),
 * пачка делится пополам и повторяется — вплоть до одного узла. Так размер
 * пачки не магическое число: он подстраивается под файл.
 */
/**
 * Сверка одной пачки узлов.
 *
 * Повторов здесь нет намеренно: `runFigma` уже повторяет временные сбои сам
 * (E_TIMEOUT, обрыв связи, зависшая задача) и знает их коды. Свой повтор поверх
 * него удваивал ожидание и — из-за проверки несуществующего поля — мог уходить
 * в бесконечную рекурсию, пока шаг не снимался по таймауту.
 *
 * Здесь остаётся только деление пачки: одна упавшая пачка из тридцати узлов
 * не должна отменять сверку остальных.
 */
function checkChunk(chunk) {
  const source = template.replace('__PAYLOAD__', JSON.stringify(chunk));
  const tmp = join(tmpdir(), `check-bindings-${process.pid}-${chunk[0]?.id?.replace(':', '-') ?? 'x'}.js`);
  writeFileSync(tmp, source);

  try {
    // Бюджет задан явно: 45 с на попытку, две попытки внутри обёртки. Худший
    // случай одной пачки — 90 с, это укладывается в таймаут шага (300 с) даже
    // вместе с делением.
    const reply = runFigma(['exec-js', tmp, '--timeout', '45000'], { timeoutMs: 45000, retries: 2 });
    // Пустой ответ — сбой транспорта, а не «ноль привязок»: делим и повторяем.
    if (!reply || !reply.result || typeof reply.result !== 'object') {
      throw new Error('пустой ответ плагина');
    }
    const part = reply.result;
    checked += part.checked ?? 0;
    mismatches.push(...(part.mismatches ?? []));
    skipped.push(...(part.skipped ?? []));
    return true;
  } catch (error) {
    if (chunk.length === 1) {
      console.error(`сверка не выполнена на узле ${chunk[0].id}: ${String(error.message).slice(0, 160)}`);
      return false;
    }
    const half = Math.ceil(chunk.length / 2);
    return checkChunk(chunk.slice(0, half)) && checkChunk(chunk.slice(half));
  }
}

// Непроходимый кусок не должен обрывать остальные: иначе агент видит одну
// ошибку и не знает, сколько ещё. Собираем все и выходим в конце.
const failedChunks = [];
for (let start = 0; start < items.length; start += CHUNK) {
  const chunk = items.slice(start, start + CHUNK);
  if (!checkChunk(chunk)) failedChunks.push(`${chunk[0]?.id ?? '?'}…${chunk[chunk.length - 1]?.id ?? '?'}`);
}

console.log(`спек: ${specs.length} · привязок проверено: ${checked} из ${items.length}`);

// Пропущенные — не зелёные: их никто не сверил. Ссылка на другую переменную
// (alias-chain) и «не цвет» — справка; отсутствие привязки в файле значит,
// что спека устарела, и вердикт не может быть PASS.
const byReason = {};
for (const item of skipped) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
if (skipped.length) {
  console.log(
    `пропущено ${skipped.length}: ` +
      Object.entries(byReason)
        .map(([reason, n]) => `${reason} ${n}`)
        .join(', '),
  );
  for (const item of skipped.filter((i) => i.reason === 'no-binding').slice(0, 10)) {
    console.log(`  ${item.id} ${item.kind}[${item.index}] — в спеке привязка есть, в файле нет`);
  }
}
const noBinding = byReason['no-binding'] ?? 0;

// Непрошедшие пачки — среда, а не расхождение: о них говорим до вердикта,
// чтобы отчёт не выглядел зелёным при неполной сверке.
if (failedChunks.length) {
  console.error(`\nне сверено пачек: ${failedChunks.length} — ${failedChunks.join(', ')}`);
}

if (!mismatches.length) {
  if (noBinding) {
    console.error(`\nне сверено ${noBinding}: привязки нет в файле — перевыгрузить секции (npm run export)`);
    process.exit(3);
  }
  if (failedChunks.length) {
    console.error('часть пачек не сверена — вердикт не может быть зелёным');
    process.exit(2);
  }
  console.log('цвета в спеках совпадают со значениями переменных');
  process.exit(0);
}

console.error(`\nрасхождений: ${mismatches.length}`);
for (const item of mismatches.slice(0, 20)) {
  if (item.error) {
    console.error(`  ${item.id} ${item.kind}[${item.index}] — ${item.error}`);
  } else {
    console.error(
      `  ${item.id} ${item.kind}[${item.index}] ${item.variable}: ` +
        `в спеке ${item.expected.hex}@${item.expected.a}, в файле ${item.actual.hex}@${item.actual.a}`,
    );
  }
}
console.error('\nперевыгрузить секции: npm run export -- <nodeId> --name <slug>');
process.exit(1);
