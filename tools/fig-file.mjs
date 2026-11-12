#!/usr/bin/env node
/**
 * Чтение файла .fig без Figma и без плагина.
 *
 *   node tools/fig-file.mjs inspect <file.fig>
 *   node tools/fig-file.mjs verify  <file.fig>
 *   node tools/fig-file.mjs extract <file.fig> [--missing]
 *
 * .fig — это ZIP: `meta.json`, `canvas.fig` и `images/<sha1>`.
 * `canvas.fig` устроен так:
 *   "fig-kiwi" (8) + версия (4) + длина схемы (4) + схема (raw deflate)
 *   + длина данных (4) + данные (zstd)
 *
 * Зачем инструмент: плагин — единственный источник истины, но .fig даёт
 * независимую сверку. Картинки из него должны совпадать с выгруженными
 * байт в байт, иначе где-то потеря.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync, inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { readZip } from './lib/zip.mjs';

const root = process.cwd();
const [command, file] = process.argv.slice(2);

if (!command || !file) {
  console.error('Использование: node tools/fig-file.mjs <inspect|verify|extract> <file.fig>');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`нет файла: ${file}`);
  process.exit(2);
}

const zip = readZip(file);
const meta = zip.json('meta.json');

// --- canvas.fig ------------------------------------------------------------
function readCanvas() {
  const raw = zip.read('canvas.fig');
  if (!raw) return null;
  if (raw.toString('latin1', 0, 8) !== 'fig-kiwi') return { error: 'не fig-kiwi' };

  const version = raw.readUInt32LE(8);
  const schemaLen = raw.readUInt32LE(12);
  const schema = inflateRawSync(raw.subarray(16, 16 + schemaLen));

  let pos = 16 + schemaLen;
  let data = null;
  if (pos + 4 <= raw.length) {
    const dataLen = raw.readUInt32LE(pos);
    pos += 4;
    try {
      data = zstdDecompressSync(raw.subarray(pos, pos + dataLen));
    } catch (error) {
      data = null;
    }
  }
  return { version, schema, data };
}

// --- картинки --------------------------------------------------------------
function listImages() {
  return zip.names.filter((n) => n.startsWith('images/') && !n.endsWith('/'));
}

function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

// --- команды ---------------------------------------------------------------
if (command === 'inspect') {
  const canvas = readCanvas();
  const images = listImages();
  console.log(`файл:    ${basename(file)}`);
  console.log(`имя:     ${meta?.file_name ?? '—'}`);
  console.log(`выгружен: ${meta?.exported_at ?? '—'}`);
  if (meta?.client_meta?.render_coordinates) {
    const r = meta.client_meta.render_coordinates;
    console.log(`холст:   ${Math.round(r.width)}×${Math.round(r.height)}`);
  }
  if (canvas?.error) {
    console.log(`канвас:  ${canvas.error}`);
  } else if (canvas) {
    console.log(`канвас:  kiwi v${canvas.version}, схема ${(canvas.schema.length / 1024).toFixed(0)} КБ, данные ${canvas.data ? (canvas.data.length / 1024 / 1024).toFixed(1) + ' МБ' : 'не распаковались'}`);
  }
  console.log(`картинок: ${images.length}`);
} else if (command === 'verify') {
  const assetsRoot = join(root, 'design/figma/assets/img');
  if (!existsSync(assetsRoot)) {
    console.error('нет склада design/figma/assets/img');
    process.exit(2);
  }

  // хеш в имени файла .fig — это sha1 содержимого
  const figHashes = new Map();
  for (const name of listImages()) {
    const buf = zip.read(name);
    figHashes.set(sha1(buf), buf.length);
  }

  const ours = readdirSafe(assetsRoot);
  let found = 0;
  let same = 0;
  const different = [];
  for (const entry of ours) {
    const buf = readFileSync(join(assetsRoot, entry.file));
    const hash = sha1(buf);
    const hit = figHashes.has(hash);
    if (hit) {
      found++;
      same++;
    } else {
      different.push(entry.file);
    }
  }

  console.log(`в .fig картинок:        ${figHashes.size}`);
  console.log(`у нас в складе:         ${ours.length}`);
  console.log(`совпало байт в байт:    ${same}`);
  console.log(`нет в .fig:             ${different.length}${different.length ? ' — ' + different.slice(0, 3).join(', ') : ''}`);

  const canvas = readCanvas();
  if (canvas?.data) {
    // Независимая сверка содержимого: тексты из наших спек должны находиться
    // в канвасе .fig. Если текст пропал — значит его не выгрузили.
    const blob = canvas.data.toString('utf8');
    const specs = readSpecs();
    const texts = new Set();
    for (const spec of specs) {
      for (const node of spec.nodes ?? []) {
        if (node.type === 'TEXT' && node.text && node.text.trim().length > 3) texts.add(node.text.trim());
      }
    }
    // U+2028 и NBSP в .fig и в спеке могут стоять по-разному — сравниваем
    // по нормализованным пробелам, иначе получаем ложные «не найдено».
    const norm = (x) => x.replace(/[\u2028\u2029\u00a0\s]+/g, ' ').trim();
    const haystack = norm(blob);
    const missing = [];
    for (const t of texts) {
      const probe = norm(t).slice(0, 40);
      if (probe && !haystack.includes(probe)) missing.push(t);
    }
    console.log(`текстов в канвасе:      ${countTexts(canvas.data)}`);
    console.log(`уникальных в спеках:    ${texts.size}`);
    console.log(`нашлись в .fig:         ${texts.size - missing.length}`);
    if (missing.length) {
      console.log(`не нашлись:             ${missing.length} — ${missing.slice(0, 2).map((t) => t.slice(0, 40)).join(' | ')}`);
    }
  }
} else if (command === 'extract') {
  const assetsRoot = join(root, 'design/figma/assets/img');
  mkdirSync(assetsRoot, { recursive: true });
  const onlyMissing = process.argv.includes('--missing');
  const known = new Set(readdirSafe(assetsRoot).map((e) => e.file.split('.')[0]));

  let added = 0;
  for (const name of listImages()) {
    const hash = name.slice('images/'.length);
    const short = hash.slice(0, 12);
    if (onlyMissing && known.has(short)) continue;
    const buf = zip.read(name);
    const ext = sniff(buf);
    const target = join(assetsRoot, `${short}.${ext}`);
    if (existsSync(target)) continue;
    writeFileSync(target, buf);
    added++;
  }
  console.log(`добавлено в склад: ${added}`);
} else {
  console.error(`неизвестная команда: ${command}`);
  process.exit(2);
}

// --- вспомогательное -------------------------------------------------------
function readSpecs() {
  const dir = join(root, 'design/figma/pages');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const pageDir of readdirSync(dir)) {
    const pagePath = join(dir, pageDir);
    if (!statSync(pagePath).isDirectory()) continue;
    for (const sectionDir of readdirSync(pagePath)) {
      const p = join(pagePath, sectionDir, 'spec.json');
      if (!existsSync(p)) continue;
      try {
        out.push(JSON.parse(readFileSync(p, 'utf8')));
      } catch {}
    }
  }
  return out;
}

function readdirSafe(dir) {
  return readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
    .map((f) => ({ file: f }));
}

function sniff(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'gif';
  return 'bin';
}

function countTexts(data) {
  const text = data.toString('utf8');
  const matches = text.match(/[\u0400-\u04FFA-Za-z][\u0400-\u04FFA-Za-z0-9 ,.!?«»—:;()\-]{14,}/g);
  return matches ? matches.length : 0;
}
