#!/usr/bin/env node
/**
 * Готовит ассеты сборки: ресайз под макет и WebP вместо тяжёлых PNG.
 *
 *   node tools/optimize-assets.mjs [--max 1440] [--quality 82] [--dry]
 *
 * Склад `design/figma/assets` не трогается — там исходные байты из Figma.
 * Здесь только то, что уезжает в браузер: `public/img`.
 *
 * Правила:
 *   - ширина больше `--max` → уменьшается до него;
 *   - PNG без прозрачности → WebP (фото в PNG весят в разы больше);
 *   - PNG с прозрачностью остаётся PNG, но пережимается;
 *   - JPEG меньше 300 КБ не трогается вовсе: он уже сжат, повторное кодирование
 *     только портит картинку (проверено на hero: 65 КБ → WebP 51 КБ, но
 *     расхождение с макетом выросло с 1,76 до 6,11).
 *
 * Печатает таблицу «было → стало» и список ссылок, которые надо обновить.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const root = process.cwd();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const maxWidth = arg('--max', 1440);
const quality = arg('--quality', 82);
const dry = process.argv.includes('--dry');
// Формат задаётся флагом: webp (по умолчанию, через Chromium) или avif
// (через системный sips). AVIF при том же весе даёт заметно меньше
// артефактов на градиентах — ради этого он и добавлен (решение 407).
const format = (process.argv.includes('--format') ? process.argv[process.argv.indexOf('--format') + 1] : 'webp');

const dir = join(root, 'public/img');
if (!existsSync(dir)) {
  console.error('нет public/img');
  process.exit(2);
}

const files = readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f));
if (!files.length) {
  console.log('нечего оптимизировать');
  process.exit(0);
}

if (format === 'avif') {
  // sips есть только на macOS; на других системах честно говорим, что делать.
  try {
    execFileSync('sips', ['--version'], { stdio: 'pipe' });
  } catch {
    console.error('AVIF собирается через sips (macOS). На этой системе его нет.');
    process.exit(2);
  }

  const results = [];
  for (const file of files) {
    const abs = join(dir, file);
    const before = statSync(abs).size;
    const isPng = extname(file).toLowerCase() === '.png';
    // Мелкие JPEG не трогаем: перекодирование мелочи портит картинку.
    if (!isPng && before < 300 * 1024) {
      results.push({ file, target: file, before, after: before, skipped: true, out: { sourceWidth: 0, sourceHeight: 0, width: 0, height: 0 } });
      continue;
    }

    const width = Number(
      execFileSync('sips', ['-g', 'pixelWidth', abs], { encoding: 'utf8' }).match(/pixelWidth: (\d+)/)?.[1] ?? 0,
    );
    const target = basename(file, extname(file)) + '.avif';
    const outPath = join(dir, target);
    const args = ['-s', 'format', 'avif', '-s', 'formatOptions', String(quality)];
    if (width > maxWidth) args.push('--resampleWidth', String(maxWidth));
    args.push(abs, '--out', outPath);

    if (!dry) {
      execFileSync('sips', args, { stdio: 'pipe' });
      if (target !== file) unlinkSync(abs);
    }
    const after = dry ? before : statSync(outPath).size;
    results.push({ file, target, before, after, out: { sourceWidth: width, sourceHeight: 0, width: Math.min(width, maxWidth), height: 0 } });
  }

  const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} МБ`;
  const totalBefore = results.reduce((sum, r) => sum + r.before, 0);
  const totalAfter = results.reduce((sum, r) => sum + r.after, 0);
  console.log(`оптимизация в AVIF${dry ? ' (пробный прогон)' : ''}: ширина ≤ ${maxWidth}, качество ${quality}\n`);
  for (const r of results) {
    if (r.skipped) continue;
    const saved = 100 - (r.after / r.before) * 100;
    console.log(`${(r.target === r.file ? r.file : `${r.file} → ${r.target}`).padEnd(46)} ${mb(r.before).padStart(9)} → ${mb(r.after).padStart(9)}  ${saved.toFixed(0)} %`);
  }
  console.log(`\nвсего: ${mb(totalBefore)} → ${mb(totalAfter)} (${(100 - (totalAfter / totalBefore) * 100).toFixed(0)} % меньше)`);
  const renamed = results.filter((r) => r.changed !== false && r.target !== r.file);
  if (renamed.length) {
    console.log('\nобновить ссылки в разметке:');
    for (const r of renamed) console.log(`  /img/${r.file}  →  /img/${r.target}`);
  }
  process.exit(0);
}

const browser = await chromium.launch();
const page = await browser.newPage();

const results = [];

for (const file of files) {
  const abs = join(dir, file);
  const before = statSync(abs).size;
  const dataUrl = `data:image/${extname(file).slice(1)};base64,${readFileSync(abs).toString('base64')}`;

  const isPng = extname(file).toLowerCase() === '.png';
  const skip = !isPng && before < 300 * 1024;
  if (skip) {
    results.push({ file, target: file, before, after: before, out: { sourceWidth: 0, sourceHeight: 0, width: 0, height: 0 }, changed: false, skipped: true });
    continue;
  }

  const out = await page.evaluate(
    async ({ dataUrl, maxWidth, quality, isPng }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();

      // прозрачность: смотрим альфу по краям и в центре
      const probe = document.createElement('canvas');
      probe.width = img.naturalWidth;
      probe.height = img.naturalHeight;
      const pctx = probe.getContext('2d');
      pctx.drawImage(img, 0, 0);
      const data = pctx.getImageData(0, 0, probe.width, probe.height).data;
      let hasAlpha = false;
      for (let i = 3; i < data.length; i += 4 * 97) {
        if (data[i] < 250) {
          hasAlpha = true;
          break;
        }
      }

      const scale = Math.min(1, maxWidth / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);

      // PNG с прозрачностью остаётся PNG, остальное — WebP
      const format = isPng && hasAlpha ? 'image/png' : 'image/webp';
      return {
        dataUrl: canvas.toDataURL(format, quality / 100),
        format,
        width: w,
        height: h,
        sourceWidth: img.naturalWidth,
        sourceHeight: img.naturalHeight,
        hasAlpha,
      };
    },
    { dataUrl, maxWidth, quality, isPng },
  );

  const ext = out.format === 'image/webp' ? '.webp' : '.png';
  const target = basename(file, extname(file)) + ext;
  const bytes = Buffer.from(out.dataUrl.split(',')[1], 'base64');

  results.push({ file, target, before, after: bytes.length, out, changed: target !== file });

  if (!dry) {
    writeFileSync(join(dir, target), bytes);
    if (target !== file) unlinkSync(abs);
  }
}

await browser.close();

const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} МБ`;
console.log(`оптимизация ${dry ? '(пробный прогон)' : ''}: ширина ≤ ${maxWidth}, качество ${quality}\n`);
console.log('файл                     было        стало       экономия   размер');
for (const r of results) {
  const saved = 100 - (r.after / r.before) * 100;
  const size = `${r.out.sourceWidth}×${r.out.sourceHeight} → ${r.out.width}×${r.out.height}`;
  if (r.skipped) {
    console.log(`${r.file.padEnd(24)} ${mb(r.before).padStart(9)}  ${'пропущен'.padStart(9)}        —  JPEG уже сжат`);
    continue;
  }
  const name = r.target === r.file ? r.file : `${r.file} → ${r.target}`;
  console.log(
    `${name.padEnd(24)} ${mb(r.before).padStart(9)}  ${mb(r.after).padStart(9)}  ${saved.toFixed(0).padStart(6)} %  ${size}`,
  );
}

const totalBefore = results.reduce((s, r) => s + r.before, 0);
const totalAfter = results.reduce((s, r) => s + r.after, 0);
console.log(`\nвсего: ${mb(totalBefore)} → ${mb(totalAfter)} (${(100 - (totalAfter / totalBefore) * 100).toFixed(0)} % меньше)`);

const renamed = results.filter((r) => r.changed);
if (renamed.length) {
  console.log('\nобновить ссылки в разметке:');
  for (const r of renamed) console.log(`  /img/${r.file}  →  /img/${r.target}`);
}
