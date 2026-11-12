#!/usr/bin/env node
/**
 * Модуль 2 — экспорт секции из живого файла Figma.
 *
 *   node tools/export-section.mjs 79:105 --name hero
 *
 * Выход: design/figma/pages/<page>/<section>/
 *   spec.json  — факты: геометрия, текст, заливки, авто-раскладка, ссылки на ассеты
 *   crop.png   — эталон, снятый с самого узла
 *   assets/    — img/<hash>.<ext> (фото), svg/<component>.svg (иконки-инстансы)
 *
 * Коды возврата: 0 — ок, 1 — чужой файл, 2 — мост недоступен, 3 — ошибка Figma.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runFigma, FigmaError } from './figma/cli.mjs';

const root = process.cwd();
const argv = process.argv.slice(2);
const nodeId = argv.find((a) => /^\d+:\d+$/.test(a));
const nameArg = argv.includes('--name') ? argv[argv.indexOf('--name') + 1] : null;

const die = (code, message) => {
  console.error(`export: ${message}`);
  process.exit(code);
};

if (!nodeId) die(3, 'укажи узел: node tools/export-section.mjs 79:105 --name hero');

const projectPath = join(root, 'design/figma/project.json');
if (!existsSync(projectPath)) die(3, 'нет design/figma/project.json');
const project = JSON.parse(readFileSync(projectPath, 'utf8'));

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-|-$/g, '');

/** Ошибки моста — код 2, ошибки скрипта Figma — код 3. */
function figma(args, timeoutMs) {
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

/** Подставляет параметры в шаблон exec-js и исполняет его. */
function runTemplate(templateName, replacements, timeoutMs = 90000) {
  let source = readFileSync(join(root, 'tools/figma', templateName), 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    source = source.split(key).join(value);
  }
  const tmp = join(tmpdir(), `figma-${templateName.replace('.js', '')}-${process.pid}.js`);
  writeFileSync(tmp, source);
  const reply = figma(['exec-js', tmp, '--timeout', String(timeoutMs)]);
  if (reply.error) die(3, `${reply.error.code}: ${reply.error.message}`);
  return reply;
}

/** Как runTemplate, но не убивает процесс: сбой возвращает null. */
function runTemplateSafe(templateName, replacements, timeoutMs) {
  let source = readFileSync(join(root, 'tools/figma', templateName), 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    source = source.split(key).join(value);
  }
  const tmp = join(tmpdir(), `figma-${templateName.replace('.js', '')}-${process.pid}.js`);
  writeFileSync(tmp, source);
  try {
    const reply = runFigma(['exec-js', tmp, '--timeout', String(timeoutMs)], { timeoutMs: timeoutMs + 10000 });
    return reply.error ? null : reply;
  } catch {
    return null;
  }
}

// --- 1. Прочитать секцию ---------------------------------------------------
const read = runTemplate('read-section.template.js', { __NODE_ID__: nodeId });
const section = read.result;
if (!section || section.error) die(3, `узел ${nodeId} не найден`);

const fileKey = read.fileContext?.fileKey;
// Работать по чужому файлу нельзя, но копия файла — законный случай:
// дизайнер выгружает копию и продолжает в ней. Флаг делает это осознанным:
// спека получает ключ того файла, с которого снята, и это видно в отчёте.
if (fileKey !== project.source.fileKey && !process.argv.includes('--accept-other-file')) {
  die(
    1,
    `fileKey ${fileKey} ≠ ${project.source.fileKey} — открыт другой файл.\n` +
      'если это копия, с которой теперь работают, — повторите с --accept-other-file',
  );
}

// --- 2. Каталог секции -----------------------------------------------------
const slug = slugify(nameArg ?? section.root.name);
const sectionsRoot = join(root, project.paths.sections ?? 'design/figma/pages');
// Секции лежат по страницам, как в Figma: pages/<страница>/<секция>/.
const pageSlug = slugify(section.page?.name ?? 'page');
const dir = join(sectionsRoot, pageSlug, slug);
mkdirSync(dir, { recursive: true });

// Ассеты живут в общем складе по хешу: одно фото и одна иконка на весь проект.
// Иначе одна и та же текстура кнопки лежит в двадцати папках секций.
const assetsRoot = join(root, project.paths.assets ?? 'design/figma/assets');
mkdirSync(join(assetsRoot, 'img'), { recursive: true });
mkdirSync(join(assetsRoot, 'svg'), { recursive: true });

const rel = (abs) => abs.slice(root.length + 1);

// --- 3. Кроп ---------------------------------------------------------------
const cropPath = join(dir, 'crop.png');
const cropReply = figma([
  // Таймаут кропа вынесен в переменную: большие секции (practice-package)
  // не укладываются в 120 с, и выгрузка падала на последнем шаге, оставляя
  // спеку от прошлого прогона.
  'export-png', '--node', nodeId, '--out', cropPath, '--scale', '1',
  '--timeout', String(Number(process.env.FIGMA_CROP_TIMEOUT_MS ?? 120000)),
]);
if (!existsSync(cropPath)) die(3, 'кроп не записался');

// --- 4. Фото по imageHash --------------------------------------------------
const images = [];
for (const img of section.images) {
  const fetched = runTemplate('fetch-image.template.js', { __HASH__: img.hash });
  const bytes = Buffer.from(fetched.result.b64, 'base64');
  const ext =
    bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpg'
    : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png'
    : 'bin';
  const abs = join(assetsRoot, 'img', `${img.hash.slice(0, 12)}.${ext}`);
  if (!existsSync(abs)) writeFileSync(abs, bytes);
  images.push({ hash: img.hash, file: rel(abs), bytes: bytes.length, usedBy: img.nodeName });
}

// --- 5. Иконки вектором ----------------------------------------------------
// Отпечаток содержимого: считается ровно как в tools/figma/fingerprint.js.
// По нему видно, изменилась ли секция после выгрузки.
function fingerprintOf(nodes) {
  let h = 0x811c9dc5;
  for (const n of nodes) {
    const line = [n.id, n.x, n.y, n.w, n.h, n.type === 'TEXT' ? n.text ?? '' : ''].join('|');
    for (let i = 0; i < line.length; i++) {
      h ^= line.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 10;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Версия облака на момент выгрузки: из аргумента или из live/api.json. */
function cloudVersion() {
  const i = process.argv.indexOf('--cloud-version');
  if (i > 0) return process.argv[i + 1];
  const p = join(root, 'design/figma/live/api.json');
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')).version ?? null;
    } catch {}
  }
  return null;
}

const icons = [];
const iconErrors = [];

// Компонент может быть одним вектором: логотип, кавычка, декоративная
// засечка. Плагин считает иконками только инстансы, поэтому такой вектор в
// список не попадал, и собрать компонент было не из чего.
if (!(section.icons ?? []).length) {
  const vector = (section.nodes ?? []).find((n) => n.type === 'VECTOR' && n.depth <= 1);
  if (vector) section.icons = [{ id: vector.id, name: vector.name, componentName: section.root?.name }];
}
const usedNames = new Set();
for (const icon of section.icons) {
  // Сбой одной иконки не должен убивать секцию: спека и кроп нужны всё равно.
  // Бывает, что Figma не может отрендерить инстанс («Unable to establish
  // connection to Figma») — тогда иконка берётся из готовых или рисуется заново.
  // Короткий таймаут и безопасная выгрузка: нерендерящаяся иконка не должна
  // ни держать выгрузку две минуты, ни убивать процесс.
  // Таймаут вынесен в переменную: под нагрузкой мост отвечает дольше 20 с,
  // и иконка молча выпадала из выгрузки.
  const fetched = runTemplateSafe(
    'fetch-svg.template.js',
    { __NODE_ID__: icon.id },
    Number(process.env.FIGMA_ICON_TIMEOUT_MS ?? 45000),
  );
  if (!fetched) {
    iconErrors.push({ id: icon.id, name: icon.name, reason: 'svg не выгрузился' });
    continue;
  }
  const svg = fetched.result?.svg;
  if (!svg) {
    iconErrors.push({ id: icon.id, name: icon.name, reason: 'svg пустой' });
    continue;
  }
  // Вариант в имени: arrow-quiet + {color: white, direction: right} →
  // arrow-quiet-white-right.svg. Иначе разные стрелки перезапишут друг друга.
  const variant = icon.props
    ? Object.values(icon.props)
        .filter((v) => typeof v === 'string' && v.length < 20)
        .map((v) => slugify(v))
        .filter(Boolean)
        .join('-')
    : '';
  let base = slugify(icon.componentName || icon.name) || icon.id.replace(':', '-');
  if (variant) base = `${base}-${variant}`;
  let name = `${base}.svg`;
  let n = 2;
  while (usedNames.has(name)) name = `${base}-${n++}.svg`;
  usedNames.add(name);
  const abs = join(assetsRoot, 'svg', name);
  if (!existsSync(abs)) writeFileSync(abs, svg.trim() + '\n');
  icons.push({
    node: icon.id,
    component: icon.componentName,
    variant: icon.props ?? null,
    file: rel(abs),
    bytes: svg.length,
  });
}

// --- 6. Спека --------------------------------------------------------------
const spec = {
  // Версия контракта спеки: по ней ворота spec-contract понимают, как читать
  // файл. Меняется, только когда меняется сам контракт.
  schemaVersion: 1,
  file: { name: project.source.fileName, key: fileKey, at: new Date().toISOString() },
  section: section.root,
  // Отпечаток от плагина: он видит дерево целиком, как и раньше.
  fingerprint: section.fingerprint ?? fingerprintOf(section.nodes),
  cloudVersion: cloudVersion(),
  counts: { nodes: section.count, images: images.length, icons: icons.length, iconInstances: section.iconInstances },
  assets: { crop: 'crop.png', images, icons },
  nodes: section.nodes,
};

// --- 6.1 Иконки: не терять молча -------------------------------------------
// Было так: fetch-svg не ответил за 20 с, иконка выпала из списка, спека
// записалась, ворота зелёные — а в вёрстке нет стрелки. Сравниваем с прошлой
// выгрузкой: меньше иконок без объяснения — это отказ выгрузки, а не
// изменение макета.
const previousIcons = existsSync(join(dir, 'spec.json'))
  ? (JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8')).counts?.icons ?? null)
  : null;

if (iconErrors.length) {
  console.error(`иконки не выгрузились: ${iconErrors.length}`);
  for (const e of iconErrors) console.error(`  ${e.id} ${e.name}: ${e.reason}`);
  console.error('спека не перезаписана: почините выгрузку иконок или повторите');
  process.exit(1);
}

if (previousIcons !== null && icons.length < previousIcons && !process.argv.includes('--allow-icon-loss')) {
  console.error(`иконок стало меньше: было ${previousIcons}, стало ${icons.length}`);
  console.error('это потеря при выгрузке, а не изменение макета: спека не перезаписана');
  console.error('если потеря осознанная — повторите с --allow-icon-loss');
  process.exit(1);
}

writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2) + '\n');

// --- 6.2 Состояния секции --------------------------------------------------
// Секция живёт в файле не в одном виде: у `formats` пять инстансов, по одному
// на активный формат, и у каждого своя картинка слайдера и свои описания.
// Один выгруженный инстанс — одно состояние; остальные теряются молча.
//
// Исключения (`exclude`) — решения «это не состояние секции, а другая
// секция с тем же компонентом». Они лежат в states-exclude.json и
// переносятся в states.json при каждой выгрузке, иначе ручная правка
// затирается генерацией.
try {
  const variantsTemplate = readFileSync(join(root, 'tools/figma/variants.template.js'), 'utf8');
  const variantsTmp = join(tmpdir(), `figma-variants-${process.pid}.js`);
  writeFileSync(variantsTmp, variantsTemplate.split('__ID__').join(nodeId));
  // runFigma напрямую: обёртка figma() при ошибке завершает процесс, и
  // отсутствие состояний валило бы всю выгрузку.
  const variantsReply = runFigma(['exec-js', variantsTmp, '--timeout', '120000']);
  if (variantsReply.result && !variantsReply.result.error) {
    const excludePath = join(dir, 'states-exclude.json');
    const exclude = existsSync(excludePath) ? (JSON.parse(readFileSync(excludePath, 'utf8')).exclude ?? []) : [];
    writeFileSync(
      join(dir, 'states.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          section: variantsReply.result.name,
          nodeId,
          total: variantsReply.result.total,
          states: variantsReply.result.states,
          ...(exclude.length ? { exclude } : {}),
        },
        null,
        2,
      ) + '\n',
    );
    spec.counts.states = variantsReply.result.total;
    // Сохраняем спеку ещё раз: число состояний появилось только сейчас.
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2) + '\n');
  }
} catch (error) {
  console.warn(`состояния не сняты: ${String(error.message).slice(0, 120)}`);
}

// --- 7. Сводка -------------------------------------------------------------
console.log(`секция:  ${section.root.name}  ${section.root.w}×${section.root.h}  (${nodeId})`);
console.log(`узлов:   ${section.count}`);
console.log(`фото:    ${images.length}${images.length ? ' — ' + images.map((i) => i.file.split('/').pop()).join(', ') : ''}`);
console.log(`иконок:  ${icons.length}${icons.length ? ' — ' + icons.map((i) => i.component ?? i.node).join(', ') : ''}`);
console.log(`каталог: ${dir.replace(root + '/', '')}`);
