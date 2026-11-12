#!/usr/bin/env node
/**
 * Чтение файла .fig без Figma и без плагина — полноценно, с деревом узлов.
 *
 *   node tools/fig-kiwi.mjs inspect <file.fig>
 *   node tools/fig-kiwi.mjs pages   <file.fig>
 *   node tools/fig-kiwi.mjs tree    <file.fig> "<страница>" [глубина]
 *
 * Зачем: `.fig` — независимый от моста источник. Мост показывает, что в файле
 * сейчас; архив — что было в момент выгрузки. Сверка двух источников ловит
 * потерю при выгрузке, а без Figma под рукой архив остаётся единственным.
 *
 * Формат разобран целиком, без внешних зависимостей:
 *
 *   .fig — ZIP: meta.json, canvas.fig, images/<sha1>
 *   canvas.fig: "fig-kiwi" (8) + версия (4) + длина схемы (4) + схема (deflate)
 *              + длина данных (4) + данные (zstd)
 *
 * Схема — тоже бинарная: таблица определений (ENUM / STRUCT / MESSAGE) с полями.
 * Данные читаются по ней:
 *   - STRUCT  — поля подряд в порядке схемы;
 *   - MESSAGE — пары «номер поля + значение» до нуля. Номера не совпадают с
 *               порядком (у Message это 1, 2, 42, 3, 37, 4 …): сообщение само
 *               говорит, какое поле идёт следующим, поэтому пропущенные поля
 *               не занимают места;
 *   - строка  — до нулевого байта;
 *   - число   — LEB128; знаковое — зигзагом;
 *   - дробь   — сжатая: ноль это один байт, иначе четыре с поворотом бит на 9;
 *   - uint64  — LEB128, но после 56 бит продолжение не учитывается: последний
 *               байт берётся как есть, следующий принадлежит другому полю.
 *               Обычный LEB128 уходит на два байта дальше и разъезжается.
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync, inflateRawSync } from 'node:zlib';
import { readZip } from './lib/zip.mjs';

const BUILTIN = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'];
const KINDS = ['ENUM', 'STRUCT', 'MESSAGE'];

/**
 * Версии kiwi, на которых декодер проверен.
 *
 * Формат закрытый и меняется вместе с Figma. Незнакомая версия — это не
 * «наверное, сойдёт»: при первом разборе рассинхрон был молчаливым (uint64
 * читался на два байта дальше), дерево собиралось, но врало. Лучше громкий
 * отказ с кодом 3, чем тихо неверные числа.
 */
const SUPPORTED_KIWI = [106];

/** Последнее прочитанное сообщение: из него берутся словари стилей. */
let currentMessage = null;

/** Чтение значений из байтов: ровно кодировки спецификации kiwi. */
class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  byte() {
    return this.bytes[this.pos++];
  }

  /** LEB128 без знака. Длиннее 10 байт — признак рассинхрона, а не числа. */
  varuint() {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.bytes[this.pos++];
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return value;
      shift += 7;
      if (shift > 70) throw new Error(`varuint длиннее 10 байт (смещение ${this.pos})`);
    }
  }

  /** То же для 64 бит, с особенностью kiwi на 56 битах (см. шапку). */
  varuint64() {
    let value = 0n;
    let shift = 0n;
    let byte;
    while (((byte = this.bytes[this.pos++]) & 0x80) && shift < 56n) {
      value |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    }
    value |= BigInt(byte & 0x7f) << shift;
    return value;
  }

  /** Зигзаг: младший бит — знак. */
  varint() {
    const v = this.varuint();
    return v & 1 ? -((v + 1) / 2) : v / 2;
  }

  /** Строка до нуля в UTF-8. */
  string() {
    const start = this.pos;
    while (this.bytes[this.pos] !== 0) this.pos++;
    const text = Buffer.from(this.bytes.subarray(start, this.pos)).toString('utf8');
    this.pos++;
    return text;
  }

  /**
   * Сжатая дробь: ноль — один байт, иначе четыре с поворотом битов на 9.
   * Так экономится по три байта на каждом нуле координат и матриц.
   */
  float() {
    if (this.bytes[this.pos] === 0) {
      this.pos += 1;
      return 0;
    }
    const raw =
      this.bytes[this.pos] |
      (this.bytes[this.pos + 1] << 8) |
      (this.bytes[this.pos + 2] << 16) |
      (this.bytes[this.pos + 3] << 24);
    this.pos += 4;
    const bits = ((raw << 23) | (raw >>> 9)) >>> 0;
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, bits, true);
    return view.getFloat32(0, true);
  }
}

/** Схема: определения, их поля, имена типов и номера полей сообщений. */
function parseSchema(bytes) {
  const r = new Reader(bytes);
  const count = r.varuint();
  const definitions = [];
  for (let i = 0; i < count; i++) {
    const name = r.string();
    const kind = KINDS[r.byte()];
    const fieldCount = r.varuint();
    const fields = [];
    for (let j = 0; j < fieldCount; j++) {
      fields.push({ name: r.string(), type: r.varint(), isArray: (r.byte() & 1) !== 0, value: r.varuint() });
    }
    definitions.push({ name, kind, fields });
  }
  // Тип поля — номер определения (>= 0) или встроенный тип (< 0, через ~).
  for (const def of definitions) {
    def.byId = new Map(def.fields.map((f) => [f.value, f]));
    for (const field of def.fields) {
      field.typeName = field.type < 0 ? BUILTIN[~field.type] : definitions[field.type]?.name;
      if (field.typeName === undefined) throw new Error(`неизвестный тип ${field.type} у ${def.name}.${field.name}`);
    }
  }
  return { definitions, byName: new Map(definitions.map((d) => [d.name, d])) };
}

function readOne(r, schema, typeName) {
  switch (typeName) {
    case 'bool': return r.byte() !== 0;
    case 'byte': return r.byte();
    case 'int': return r.varint();
    case 'uint': return r.varuint();
    case 'float': return r.float();
    case 'string': return r.string();
    case 'int64':
    case 'uint64': return r.varuint64();
    default: {
      const def = schema.byName.get(typeName);
      if (!def) throw new Error(`нет определения ${typeName}`);
      if (def.kind === 'ENUM') return r.varuint();
      return readStruct(r, schema, def);
    }
  }
}

function readValue(r, schema, field) {
  if (!field.isArray) return readOne(r, schema, field.typeName);
  const n = r.varuint();
  const out = [];
  for (let i = 0; i < n; i++) out.push(readOne(r, schema, field.typeName));
  return out;
}

/** STRUCT — поля подряд; MESSAGE — пары «номер поля + значение» до нуля. */
function readStruct(r, schema, def) {
  const out = {};
  if (def.kind !== 'MESSAGE') {
    for (const field of def.fields) out[field.name] = readValue(r, schema, field);
    return out;
  }
  const byId = def.byId ?? new Map(def.fields.map((f) => [f.value, f]));
  for (;;) {
    const at = r.pos;
    const id = r.varuint();
    if (id === 0) return out;
    const field = byId.get(id);
    if (!field) throw new Error(`неизвестное поле ${id} в ${def.name} (смещение ${at})`);
    out[field.name] = readValue(r, schema, field);
  }
}

/** canvas.fig → { meta, version, schema, data, message } */
/** Все узлы сообщения — нужны словари стилей и переменных. */
function allChanges(schema) {
  return currentMessage?.nodeChanges ?? [];
}

export function readFig(file) {
  const zip = readZip(file);
  const meta = zip.json('meta.json');
  const raw = zip.read('canvas.fig');
  if (!raw) throw new Error('в архиве нет canvas.fig');
  if (raw.toString('latin1', 0, 8) !== 'fig-kiwi') throw new Error('canvas.fig не в формате fig-kiwi');

  const version = raw.readUInt32LE(8);
  if (!SUPPORTED_KIWI.includes(version)) {
    const error = new Error(
      `формат kiwi v${version} не проверен (декодер знает ${SUPPORTED_KIWI.join(', ')}). ` +
        'Обновите Figma-файл или проверьте декодер: молчаливый разбор может дать неверные числа.',
    );
    error.exitCode = 3;
    throw error;
  }
  const schemaLen = raw.readUInt32LE(12);
  const schema = parseSchema(inflateRawSync(raw.subarray(16, 16 + schemaLen)));

  let pos = 16 + schemaLen;
  const dataLen = raw.readUInt32LE(pos);
  pos += 4;
  const data = zstdDecompressSync(raw.subarray(pos, pos + dataLen));

  const message = readStruct(new Reader(data), schema, schema.byName.get('Message'));
  currentMessage = message;
  return { meta, version, schema, data, message };
}

/** Спеки: design/figma/pages/<page>/<section>/spec.json */
function specsOf(base) {
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

/** Имя значения перечисления по номеру. */
export function enumName(schema, name, value) {
  return schema.byName.get(name)?.fields.find((f) => f.value === value)?.name ?? String(value);
}

const guidKey = (g) => `${g?.sessionID}:${g?.localID}`;

/** Дерево из плоского списка изменений: дети по родителю, порядок — position. */
export function buildTree(message) {
  // phase: CREATED — узел есть, REMOVED — удалён и в дереве не нужен.
  const changes = (message.nodeChanges ?? []).filter((c) => enumName !== null && (c.phase === 0 || c.phase === undefined));
  const byGuid = new Map(changes.map((c) => [guidKey(c.guid), c]));
  const children = new Map();
  for (const change of changes) {
    const parent = change.parentIndex?.guid ? guidKey(change.parentIndex.guid) : null;
    if (parent === null) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push({ position: change.parentIndex.position ?? '', change });
  }
  for (const list of children.values()) list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  return { changes, byGuid, children };
}

const sizeOf = (node) => (node.size ? `${Math.round(node.size.x)}×${Math.round(node.size.y)}` : '—');
const kindOf = (schema, node) => enumName(schema, 'NodeType', node.type);

/** Служебный холст Figma: кисти и прочее, к макету отношения не имеет. */
const INTERNAL = 'Internal Only Canvas';

// --- Команды ---------------------------------------------------------------
// Только при прямом запуске: модуль импортируют, чтобы читать .fig из кода.

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isCli) {
  // Импорт: отдаём только функции, команд не выполняем.
} else {

const [command, file, ...rest] = process.argv.slice(2);
const usage = 'Использование: node tools/fig-kiwi.mjs <inspect|pages|tree|crosscheck|export> <file.fig> …';

if (!command || !file) {
  console.error(usage);
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`нет файла: ${file}`);
  process.exit(2);
}

let fig;
try {
  fig = readFig(file);
} catch (error) {
  console.error(`не прочитан: ${error.message}`);
  process.exit(error.exitCode ?? 1);
}

const { meta, version, schema, message } = fig;
const { byGuid, children } = buildTree(message);
const kidsOf = (node) => (children.get(guidKey(node.guid)) ?? []).map((x) => x.change);
const canvases = [...byGuid.values()].filter((c) => kindOf(schema, c) === 'CANVAS');
const pages = canvases.filter((c) => c.name !== INTERNAL);

if (command === 'inspect') {
  const kinds = schema.definitions.reduce((acc, d) => ({ ...acc, [d.kind]: (acc[d.kind] ?? 0) + 1 }), {});
  console.log(`файл:      ${file}`);
  console.log(`имя:       ${meta.file_name ?? '—'} · выгружен ${meta.export_date ?? '—'}`);
  console.log(`канвас:    kiwi v${version} (проверено на ${SUPPORTED_KIWI.join(', ')}) · определений ${schema.definitions.length} (${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  console.log(`сообщение: ${enumName(schema, 'MessageType', message.type)} · узлов ${(message.nodeChanges ?? []).length}`);
  console.log(`страниц:   ${pages.length} (служебных холстов ${canvases.length - pages.length})`);
  for (const page of pages) console.log(`  ${page.name} — ${kidsOf(page).length}`);
  process.exit(0);
}

if (command === 'pages') {
  console.log(`страниц: ${pages.length}`);
  for (const page of pages) {
    const frames = kidsOf(page);
    console.log(`  ${page.name} (${frames.length})`);
    for (const frame of frames) {
      console.log(`     ${kindOf(schema, frame).padEnd(9)} ${frame.name} · ${sizeOf(frame)} · детей ${kidsOf(frame).length}`);
    }
  }
  process.exit(0);
}

/** Узел в том же виде, в каком его отдаёт мост: id, тип, размеры, текст, заливки. */
function toSpecNodes(schema, page, frame) {
  const nodes = [];

  // Стили и переменные живут в том же потоке узлов: стиль — это узел с
  // styleType и именем («H2», «quote»), переменная — узел VARIABLE. Собираем
  // словари один раз, чтобы у каждого узла было имя стиля и привязки — как
  // их отдаёт мост.
  const styleNames = new Map();
  const styleData = new Map();
  for (const change of allChanges(schema)) {
    if (change.styleType === undefined) continue;
    const key = `${change.guid.sessionID}:${change.guid.localID}`;
    styleNames.set(key, change.name);
    styleData.set(key, change);
  }
  const styleOfText = (ref) =>
    ref?.guid ? styleData.get(`${ref.guid.sessionID}:${ref.guid.localID}`) ?? null : null;
  // В архиве высота строки — доля единицы (`{value: 1.25, units: 0}`), у моста
  // проценты. Приводим к виду моста: спека должна читаться одинаково, откуда
  // её ни сняли.
  const lineHeightOf = (lh) =>
    lh && typeof lh.value === 'number' ? { unit: 'PERCENT', value: Math.round(lh.value * 100) } : null;
  const styleOf = (ref) => (ref?.guid ? styleNames.get(`${ref.guid.sessionID}:${ref.guid.localID}`) ?? null : null);

  // Привязки: variableConsumptionMap → имя поля и ссылка на переменную.
  const boundOf = (node) => {
    const entries = node.variableConsumptionMap?.entries ?? [];
    if (!entries.length) return null;
    const out = {};
    for (const entry of entries) {
      const guid = entry.variableData?.value?.alias?.guid;
      if (!guid) continue;
      // Имена полей приводим к одному виду: STACK_SPACING → stackSpacing.
      // У моста свои имена (itemSpacing), они отличаются — это записано в
      // ARCHITECTURE; смешивать две записи в одной спеке нельзя.
      const field = enumName(schema, 'VariableField', entry.variableField)
        .toLowerCase()
        .replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      out[field] = `VariableID:${guid.sessionID}:${guid.localID}`;
    }
    return Object.keys(out).length ? out : null;
  };
  const hex = (c) => {
    const to = (v) => Math.round(Math.max(0, Math.min(1, v ?? 0)) * 255).toString(16).padStart(2, '0');
    return `#${to(c?.r)}${to(c?.g)}${to(c?.b)}`;
  };
  // transform — смещение от родителя: у корня оно и есть его место на
  // странице, у остальных складывается по цепочке (как у моста).
  const walk = (node, depth) => {
    const t = node.transform ?? {};
    const isText = kindOf(schema, node) === 'TEXT';
    nodes.push({
      id: `${node.guid.sessionID}:${node.guid.localID}`,
      name: node.name,
      type: kindOf(schema, node),
      depth,
      visible: node.visible !== false,
      x: Math.round(t.m02 ?? 0),
      y: Math.round(t.m12 ?? 0),
      w: Math.round(node.size?.x ?? 0),
      h: Math.round(node.size?.y ?? 0),
      ...(node.styleIdForText || node.styleIdForFill ? { styleName: styleOf(node.styleIdForText) ?? styleOf(node.styleIdForFill) } : {}),
      ...(boundOf(node) ? { bound: boundOf(node) } : {}),
      ...(isText && node.textData?.characters
        ? {
            // Поля — как у моста: спека должна читаться одинаково, откуда её
            // ни сняли, иначе контракт спеки ругается на «нет fontFamily».
            text: node.textData.characters,
            fontFamily: (styleOfText(node.styleIdForText)?.fontName ?? node.fontName)?.family ?? null,
            fontStyle: (styleOfText(node.styleIdForText)?.fontName ?? node.fontName)?.style ?? null,
            fontSize: Math.round(styleOfText(node.styleIdForText)?.fontSize ?? node.fontSize ?? 16),
            ...(lineHeightOf(styleOfText(node.styleIdForText)?.lineHeight ?? node.lineHeight)
              ? { lineHeight: lineHeightOf(styleOfText(node.styleIdForText)?.lineHeight ?? node.lineHeight) }
              : {}),
            letterSpacing: { unit: 'PIXELS', value: (styleOfText(node.styleIdForText)?.textTracking ?? node.textTracking ?? 0) / 1000 * (styleOfText(node.styleIdForText)?.fontSize ?? node.fontSize ?? 16) },
            // Гарнитура и метрики: без них текст рисуется чужим шрифтом и
            // наезжает на соседей — в архиве они есть, надо только достать.
            ...(() => {
              // Стиль главнее: на текстовом узле архива fontName часто устарел,
              // а актуальная гарнитура лежит в стиле (проверено на hero: у узла
              // был Cormorant, в стиле — Literata, как в мосте).
              const style = styleOfText(node.styleIdForText);
              const fontName = style?.fontName ?? node.fontName;
              if (!fontName?.family) return {};
              const lineHeight = lineHeightOf(style?.lineHeight ?? node.lineHeight);
              return {
                font: {
                  family: fontName.family,
                  style: fontName.style ?? 'Regular',
                  weight: /bold/i.test(fontName.style ?? '') ? 700 : /light/i.test(fontName.style ?? '') ? 300 : 400,
                  ...(lineHeight ? { lineHeight } : {}),
                  tracking: (style?.textTracking ?? node.textTracking ?? 0) / 1000,
                  align: node.textAlignHorizontal ?? 0,
                },
              };
            })(),
          }
        : {}),
      ...(node.fillPaints?.length
        ? {
            fills: node.fillPaints
              .filter((p) => p.visible !== false)
              .map((p) =>
                p.type === 0
                  ? { type: 'SOLID', visible: true, color: { hex: hex(p.color), a: p.color?.a ?? 1 } }
                  : // Хеш картинки связывает заливку с файлом в images/ архива.
                    {
                      type: 'IMAGE',
                      visible: true,
                      imageHash: p.image?.hash?.length ? Buffer.from(p.image.hash).toString('hex').slice(0, 12) : null,
                      scaleMode: 'FILL',
                    },
              ),
          }
        : {}),
    });
    for (const child of kidsOf(node)) walk(child, depth + 1);
  };
  walk(frame, 0);
  return nodes;
}

if (command === 'export') {
  const pageName = rest[0];
  const frameName = rest[1];
  const outIndex = rest.indexOf('--out');
  const outDir = outIndex >= 0 ? rest[outIndex + 1] : null;
  if (!pageName || !frameName || !outDir) {
    console.error('Использование: node tools/fig-kiwi.mjs export <file.fig> "<страница>" "<фрейм>" --out <каталог>');
    process.exit(2);
  }
  const page = pages.find((p) => p.name === pageName);
  const frame = page && kidsOf(page).find((f) => f.name === frameName);
  if (!frame) {
    console.error(`нет фрейма "${frameName}" на странице "${pageName}"`);
    process.exit(1);
  }
  const spec = {
    schemaVersion: 1,
    file: { key: null, name: meta.file_name ?? null },
    source: 'fig-archive',
    section: {
      id: `${frame.guid.sessionID}:${frame.guid.localID}`,
      name: frame.name,
      w: Math.round(frame.size?.x ?? 0),
      h: Math.round(frame.size?.y ?? 0),
    },
    nodes: toSpecNodes(schema, page, frame),
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'spec.json'), JSON.stringify(spec, null, 1) + '\n');
  console.log(`секция: ${spec.section.name} ${spec.section.w}×${spec.section.h} (${spec.section.id})`);
  console.log(`узлов:  ${spec.nodes.length} · текстов: ${spec.nodes.filter((n) => n.text).length}`);
  console.log(`записано: ${join(outDir, 'spec.json')}`);
  process.exit(0);
}

/** Сколько узлов в поддереве архива — для сверки с числом узлов спеки. */
function countSubtree(node) {
  let n = 1;
  for (const child of kidsOf(node)) n += countSubtree(child);
  return n;
}

if (command === 'crosscheck') {
  // Сверка архива со спеками: потерялось ли что-то при выгрузке.
  // Мост показывает файл сейчас, архив — что было в момент выгрузки; это
  // единственная проверка, где источник независим от спеки.
  //
  // Сравниваются только размеры секций. Число узлов сравнить нельзя:
  // в архиве инстансы не раскрываются (634 инстанса, ни у одного нет детей),
  // а спека, снятая мостом, их раскрывает. Поэтому счётчик в архиве — это
  // нижняя граница, и врать «узлов меньше — потеря» было бы нечестно.
  const specsDir = join(process.cwd(), 'design/figma/pages');
  if (!existsSync(specsDir)) {
    console.error(`нет каталога спек: ${specsDir}`);
    process.exit(2);
  }
  const tolerance = Number(process.env.CROSSCHECK_TOLERANCE_PX ?? 1);

  const byName = new Map();
  const collect = (node, pageName) => {
    for (const child of kidsOf(node)) {
      if (!byName.has(child.name)) byName.set(child.name, []);
      byName.get(child.name).push({
        page: pageName,
        w: Math.round(child.size?.x ?? 0),
        h: Math.round(child.size?.y ?? 0),
        instances: enumName(schema, 'NodeType', child.type) === 'INSTANCE',
      });
      collect(child, pageName);
    }
  };
  for (const page of pages) collect(page, page.name);

  const problems = [];
  let checked = 0;
  let instancesInSpec = 0;
  for (const { unit, file } of specsOf(specsDir)) {
    const spec = JSON.parse(readFileSync(file, 'utf8'));
    const name = spec.section?.name;
    const w = Math.round(spec.section?.w ?? 0);
    const h = Math.round(spec.section?.h ?? 0);
    checked += 1;
    instancesInSpec += (spec.nodes ?? []).filter((n) => n.type === 'INSTANCE').length;

    const candidates = byName.get(name) ?? [];
    if (!candidates.length) {
      problems.push({ unit, text: `в архиве нет фрейма «${name}»` });
      continue;
    }
    const match = candidates.find((c) => Math.abs(c.w - w) <= tolerance && Math.abs(c.h - h) <= tolerance);
    if (!match) {
      const sizes = [...new Set(candidates.map((c) => `${c.w}×${c.h}`))].join(', ');
      problems.push({ unit, text: `размер разошёлся: спека ${w}×${h}, архив ${sizes}` });
    }
  }

  if (problems.length) {
    console.log(`спек: ${checked} · расхождений: ${problems.length}`);
    for (const p of problems.slice(0, 20)) console.log(`  ${p.unit}: ${p.text}`);
    if (problems.length > 20) console.log(`  … и ещё ${problems.length - 20}`);
    console.error('\nархив и спеки расходятся: либо выгрузка потеряла секции, либо файл изменился');
    process.exit(1);
  }
  console.log(`спек: ${checked} · расхождений: 0`);
  console.log(`размеры секций в архиве и в спеках совпадают (инстансов в спеках ${instancesInSpec}: их дети в архиве не раскрыты, поэтому число узлов не сравнивается)`);
  process.exit(0);
}

if (command === 'tree') {
  const pageName = rest[0];
  if (!pageName) {
    console.error(`укажите страницу: ${pages.map((p) => `"${p.name}"`).join(', ')}`);
    process.exit(2);
  }
  const page = pages.find((p) => p.name === pageName);
  if (!page) {
    console.error(`нет страницы "${pageName}"`);
    process.exit(1);
  }
  const maxDepth = Number(rest[1] ?? 2);
  let nodes = 0;
  const walk = (node, depth) => {
    nodes += 1;
    console.log(`${'  '.repeat(depth)}${kindOf(schema, node).padEnd(9)} ${node.name} · ${sizeOf(node)}`);
    if (depth >= maxDepth) return;
    for (const child of kidsOf(node)) walk(child, depth + 1);
  };
  console.log(`страница ${page.name}`);
  for (const frame of kidsOf(page)) walk(frame, 1);
  console.log(`\nузлов: ${nodes} · максимальная глубина: ${maxDepth}`);
  process.exit(0);
}

console.error(usage);
process.exit(2);
}
