#!/usr/bin/env node
/**
 * Пиксельная сверка снимка с кропом из Figma. Без внешних зависимостей.
 *
 *   node tools/compare.mjs design/figma/pages/home/hero/crop.png .screens/hero.png
 *
 * Печатает размеры, среднюю разницу, долю пикселей > 16 и худшие полосы.
 * Пиксель — сигнал регрессии, не ворота приёмки: текст растеризуется по-разному,
 * фон и заливки совпадают. Код возврата всегда 0, если файлы прочитаны.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname, isAbsolute } from 'node:path';

// Декодер PNG — один на проект: tools/lib/png.mjs. Три копии уже
// разошлись один раз (interlace в C-03), решение 393.
import { decodePng } from './lib/png.mjs';

const [refPath, curPath] = process.argv.slice(2);
if (!refPath || !curPath) {
  console.error('Укажи два файла: node tools/compare.mjs <эталон.png> <снимок.png>');
  process.exit(2);
}

const ref = decodePng(readFileSync(refPath));
const cur = decodePng(readFileSync(curPath));

console.log(`эталон: ${refPath}  ${ref.width}x${ref.height}`);
console.log(`снимок: ${curPath}  ${cur.width}x${cur.height}`);

const w = Math.min(ref.width, cur.width);
const h = Math.min(ref.height, cur.height);
if (ref.width !== cur.width || ref.height !== cur.height) {
  console.log(`ВНИМАНИЕ: размеры не совпали, сравниваю ${w}x${h} из левого верхнего угла`);
}

let sum = 0;
let over16 = 0;
let over48 = 0;
const bandStep = Math.max(1, Math.floor(h / 8));
const bands = new Map();

for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const ri = (y * ref.width + x) * ref.bpp;
    const ci = (y * cur.width + x) * cur.bpp;
    const dr = Math.abs(ref.data[ri] - cur.data[ci]);
    const dg = Math.abs(ref.data[ri + 1] - cur.data[ci + 1]);
    const db = Math.abs(ref.data[ri + 2] - cur.data[ci + 2]);
    const d = Math.max(dr, dg, db);
    sum += dr + dg + db;
    if (d > 16) over16++;
    if (d > 48) over48++;
    const band = Math.floor(y / bandStep);
    const b = bands.get(band) ?? { sum: 0, over: 0, n: 0 };
    b.sum += d;
    if (d > 16) b.over++;
    b.n++;
    bands.set(band, b);
  }
}

const total = w * h;
console.log(`средняя разница: ${(sum / (total * 3)).toFixed(2)}`);
console.log(`пикселей > 16:   ${((over16 / total) * 100).toFixed(2)} %`);
console.log(`пикселей > 48:   ${((over48 / total) * 100).toFixed(2)} %`);

const worst = [...bands.entries()]
  .map(([i, b]) => ({ y: i * bandStep, mean: b.sum / b.n, over: (b.over / b.n) * 100 }))
  .sort((a, b) => b.mean - a.mean)
  .slice(0, 3);

// Числа рядом с кропом — их читает страница структуры.
const pixel = {
  at: new Date().toISOString(),
  reference: refPath,
  shot: curPath,
  width: w,
  height: h,
  mean: +(sum / (total * 3)).toFixed(2),
  over16: +((over16 / total) * 100).toFixed(2),
  over48: +((over48 / total) * 100).toFixed(2),
};
// Абсолютный путь эталона не должен склеиваться с cwd: join('/a', '/b') даёт
// '/a/b', и pixel.json ложился в несуществующий каталог.
const refFull = isAbsolute(refPath) ? refPath : join(process.cwd(), refPath);
writeFileSync(join(dirname(refFull), 'pixel.json'), JSON.stringify(pixel, null, 2) + '\n');

console.log('худшие полосы (средняя, y, % > 16):');
for (const b of worst) {
  console.log(`   y=${String(b.y).padEnd(5)} ${b.mean.toFixed(2).padStart(6)}   ${b.over.toFixed(1).padStart(5)} %`);
}
