#!/usr/bin/env node
/**
 * Подбирает тон изображения под рендер Figma.
 *
 *   node tools/fit-tone.mjs <эталон.png> <снимок.png> [--json]
 *
 * Зачем: Figma применяет к заливке `filters` (экспозиция, насыщенность), но её
 * формула не описана. Вместо угадывания коэффициенты снимаются с самого рендера
 * Figma: по каналам подбирается `эталон ≈ k·снимок + b` в sRGB.
 *
 * Текст и графика в кадре мешают подгонке, поэтому пиксели-выбросы отбрасываются
 * итеративно: после каждой подгонки остаются те, что ближе медианы.
 *
 * Печатает `k,b` по каналам — их передают в `bake-image.mjs --affine`.
 */
import { decodePngFile } from './lib/png.mjs';

const [refPath, shotPath] = process.argv.slice(2);
if (!refPath || !shotPath) {
  console.error('Укажи два файла: node tools/fit-tone.mjs <эталон.png> <снимок.png>');
  process.exit(2);
}

const ref = decodePngFile(refPath);
const shot = decodePngFile(shotPath);

const w = Math.min(ref.width, shot.width);
const h = Math.min(ref.height, shot.height);

const channels = [0, 1, 2].map(() => ({ xs: [], ys: [] }));
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const ri = (y * ref.width + x) * ref.bpp;
    const si = (y * shot.width + x) * shot.bpp;
    for (let ch = 0; ch < 3; ch++) {
      channels[ch].xs.push(shot.data[si + ch]);
      channels[ch].ys.push(ref.data[ri + ch]);
    }
  }
}

/** Линейная регрессия y = k·x + b. */
function fit(xs, ys) {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    varX += (xs[i] - mx) ** 2;
  }
  const k = varX ? cov / varX : 1;
  return [k, my - k * mx];
}

// Итеративная отбраковка: текст и картинки внутри кадра дают большие остатки.
let keep = channels.map((c) => new Uint8Array(c.xs.length).fill(1));
const coef = [];

for (let ch = 0; ch < 3; ch++) {
  let [k, b] = [1, 0];
  for (let iter = 0; iter < 4; iter++) {
    const xs = [];
    const ys = [];
    for (let i = 0; i < channels[ch].xs.length; i++) {
      if (!keep[ch][i]) continue;
      xs.push(channels[ch].xs[i]);
      ys.push(channels[ch].ys[i]);
    }
    [k, b] = fit(xs, ys);

    // остатки и медиана абсолютного отклонения
    const res = new Float64Array(xs.length);
    for (let i = 0; i < xs.length; i++) res[i] = Math.abs(ys[i] - (k * xs[i] + b));
    const sorted = Array.from(res).sort((a, b2) => a - b2);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    const limit = Math.max(4, median * 2.5);

    let idx = 0;
    for (let i = 0; i < channels[ch].xs.length; i++) {
      if (!keep[ch][i]) continue;
      keep[ch][i] = res[idx++] <= limit ? 1 : 0;
    }
  }
  coef.push([k, b]);
}

const kept = keep[0].reduce((s, v) => s + v, 0);
const total = keep[0].length;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    affine: coef.map(([k, b]) => [+k.toFixed(4), +b.toFixed(2)]),
    keptPixels: kept,
    totalPixels: total,
    keptShare: +(kept / total).toFixed(3),
  }));
} else {
  console.log(`эталон: ${refPath}`);
  console.log(`снимок: ${shotPath}`);
  console.log(`оставлено пикселей: ${kept} из ${total} (${((kept / total) * 100).toFixed(1)} %)`);
  for (const [name, [k, b]] of coef.map((c, i) => [['R', 'G', 'B'][i], c])) {
    console.log(`  ${name}: эталон ≈ ${k.toFixed(4)} · снимок ${b >= 0 ? '+' : ''}${b.toFixed(2)}`);
  }
  console.log(`\n--affine ${coef.map(([k, b]) => `${k.toFixed(4)},${b.toFixed(2)}`).join(',')}`);
}
