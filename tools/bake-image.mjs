#!/usr/bin/env node
/**
 * Запекает настройки изображения Figma в сам файл.
 *
 *   node tools/bake-image.mjs in.jpg out.jpg --exposure 0.35 --saturation -0.13
 *
 * Зачем: Figma хранит `filters` рядом с заливкой и применяет при отрисовке.
 * Переносить их в CSS нельзя — `brightness()` считает в sRGB и выжигает светлые
 * каналы, а композиция фильтров в браузере не совпадает с Figma. Соседний
 * прошлый проект прошёл это же: запекание дало 96,29 % → 8,24 %.
 *
 * Формулы повторяют bin/img-filters.py оттуда же:
 *   яркость      × 2^exposure   (экспозиция в стопах)
 *   насыщенность × (1 + saturation), серая точка — среднее каналов
 *   контраст     × (1 + contrast) вокруг середины
 *
 * Код возврата 1 — картинка не прочиталась.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';

const [input, output] = process.argv.slice(2);
const arg = (name, fallback = 0) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};

if (!input || !output) {
  console.error('Укажи вход и выход: node tools/bake-image.mjs in.jpg out.jpg [--exposure e --saturation s --contrast c]');
  process.exit(2);
}

const exposure = arg('--exposure', 0);
const saturation = arg('--saturation', 0);
const contrast = arg('--contrast', 0);

// Покомпонентные множители в линейном пространстве: так считает Figma.
// Без них экспозиция в sRGB не добирает синий канал (у pain расхождение 46 единиц).
const gainsArg = (() => {
  const i = process.argv.indexOf('--gains');
  return i > 0 ? process.argv[i + 1].split(',').map(Number) : null;
})();
const gains = gainsArg ?? [2 ** exposure, 2 ** exposure, 2 ** exposure];

// Аффинная кривая по каналам в sRGB: value → k·value + b.
// Это то, что делает Figma: поднимает тени и поджимает светá, поэтому чистое
// умножение выжигает плоские участки в 255. Коэффициенты снимаются с рендера
// Figma (tools/fit-tone.mjs), как в прошлом проекте.
const affineArg = (() => {
  const i = process.argv.indexOf('--affine');
  if (i < 0) return null;
  const v = process.argv[i + 1].split(',').map(Number);
  return [[v[0], v[1]], [v[2], v[3]], [v[4], v[5]]];
})();
const affine = affineArg;

const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const ext = extname(input).toLowerCase();
const dataUrl = `data:${mime[ext] ?? 'image/png'};base64,${readFileSync(input).toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage();

const result = await page.evaluate(
  async ({ dataUrl, exposure, saturation, contrast, gains, affine }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = image.data;

    const toLinear = (v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const toSrgb = (c) => {
      const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
      return v * 255;
    };

    // Линейные таблицы: экспозиция Figma работает в линейном RGB.
    const lut = [0, 1, 2].map((ch) => {
      const t = new Float32Array(256);
      for (let v = 0; v < 256; v++) t[v] = toSrgb(Math.min(1, toLinear(v) * gains[ch]));
      return t;
    });

    const sat = 1 + saturation;
    const con = 1 + contrast;

    for (let i = 0; i < d.length; i += 4) {
      let r = lut[0][d[i]];
      let g = lut[1][d[i + 1]];
      let b = lut[2][d[i + 2]];

      if (sat !== 1) {
        const gray = (r + g + b) / 3;
        r = gray + (r - gray) * sat;
        g = gray + (g - gray) * sat;
        b = gray + (b - gray) * sat;
      }

      if (con !== 1) {
        r = 127.5 + (r - 127.5) * con;
        g = 127.5 + (g - 127.5) * con;
        b = 127.5 + (b - 127.5) * con;
      }

      d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }

    if (affine) {
      for (let ch = 0; ch < 3; ch++) {
        const [k, b] = affine[ch];
        const lut = new Float32Array(256);
        for (let v = 0; v < 256; v++) lut[v] = k * v + b;
        for (let i = ch; i < d.length; i += 4) {
          const v = lut[d[i]];
          d[i] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }

    ctx.putImageData(image, 0, 0);
    return {
      url: canvas.toDataURL('image/jpeg', 0.92),
      width: canvas.width,
      height: canvas.height,
    };
  },
  { dataUrl, exposure, saturation, contrast, gains, affine },
);

await browser.close();

if (!result?.url) {
  console.error('bake: картинка не прочиталась');
  process.exit(1);
}

writeFileSync(output, Buffer.from(result.url.split(',')[1], 'base64'));
console.log(
  `bake: ${input} → ${output}  ${result.width}×${result.height}  ` +
    `экспозиция ${exposure >= 0 ? '+' : ''}${exposure}, насыщенность ${saturation >= 0 ? '+' : ''}${saturation}`,
);
