#!/usr/bin/env node
/**
 * Визуальный проверяющий: только читает и пишет замечания, ничего не правит.
 *
 *   node tools/review.mjs --unit practice/practice-pay
 *   node tools/review.mjs --set regression        # по набору регрессии
 *   node tools/review.mjs --unit home/voices --run my-run
 *
 * Сравнивает снимок секции с кропом из Figma и раскладывает разницу на
 * области: где именно расходится и насколько. Результат — `reviews/<run>/<unit>.json`
 * со списком замечаний и координатами. Это вход для человека и для агента,
 * который будет править; сам проверяющий не меняет ни строки.
 *
 * Коды: 0 — замечаний нет, 1 — есть, 2 — не смогли проверить.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';

const root = process.cwd();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const unit = arg('--unit', null);
const set = arg('--set', null);
const runName = arg('--run', `review-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
const CELL = 64; // размер клетки при поиске областей расхождения
// Порог откалиброван на живых данных: у зелёной секции (voices, пиксель 1,00)
// худшая клетка даёт среднюю 13,6 при 3,5 % пикселей > 48 — это край фотографии.
// У известных дефектов (practice-pay, library-journal) — 59–114 при 28–96 %.
const CELL_MEAN = 25;
const CELL_OVER = 10; // доля пикселей > 48, с которой клетка проблемная

// Декодер PNG — один на проект: tools/lib/png.mjs (решение 393).
import { decodePng } from './lib/png.mjs';

// --- области расхождения ---------------------------------------------------
function findingsOf(ref, cur) {
  const w = Math.min(ref.width, cur.width);
  const h = Math.min(ref.height, cur.height);
  const cells = [];
  for (let cy = 0; cy < h; cy += CELL) {
    for (let cx = 0; cx < w; cx += CELL) {
      let sum = 0, n = 0, over = 0;
      for (let y = cy; y < Math.min(cy + CELL, h); y++) {
        for (let x = cx; x < Math.min(cx + CELL, w); x++) {
          const ri = (y * ref.width + x) * ref.bpp;
          const ci = (y * cur.width + x) * cur.bpp;
          const d = Math.max(
            Math.abs(ref.data[ri] - cur.data[ci]),
            Math.abs(ref.data[ri + 1] - cur.data[ci + 1]),
            Math.abs(ref.data[ri + 2] - cur.data[ci + 2]),
          );
          sum += d; n++; if (d > 48) over++;
        }
      }
      const mean = sum / n;
      if (mean >= CELL_MEAN || (over / n) * 100 >= CELL_OVER) cells.push({ x: cx, y: cy, w: Math.min(CELL, w - cx), h: Math.min(CELL, h - cy), mean: +mean.toFixed(1), over: +((over / n) * 100).toFixed(1) });
    }
  }
  // Склейка соседних клеток в области: одна проблема читается лучше десятка.
  const merged = [];
  for (const cell of cells.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const near = merged.find((m) => cell.x <= m.x + m.w && cell.x + cell.w >= m.x && cell.y <= m.y + m.h + CELL && cell.y + cell.h + CELL >= m.y);
    if (near) {
      const x1 = Math.min(near.x, cell.x), y1 = Math.min(near.y, cell.y);
      const x2 = Math.max(near.x + near.w, cell.x + cell.w), y2 = Math.max(near.y + near.h, cell.y + cell.h);
      near.x = x1; near.y = y1; near.w = x2 - x1; near.h = y2 - y1;
      near.mean = +Math.max(near.mean, cell.mean).toFixed(1);
      near.over = +Math.max(near.over, cell.over).toFixed(1);
    } else {
      merged.push({ ...cell });
    }
  }
  return merged.sort((a, b) => b.mean - a.mean).slice(0, 8);
}

// --- объём ----------------------------------------------------------------
let units = [];
if (unit) units = [unit];
else if (set === 'regression') {
  const path = join(root, 'design/figma/regression.json');
  if (!existsSync(path)) { console.error('нет design/figma/regression.json'); process.exit(2); }
  units = JSON.parse(readFileSync(path, 'utf8')).units ?? [];
} else {
  console.error('укажите --unit <секция> или --set regression');
  process.exit(2);
}

const outDir = join(root, 'reviews', runName);
mkdirSync(outDir, { recursive: true });
let withFindings = 0;

for (const item of units) {
  const cropPath = join(root, 'design/figma/pages', item, 'crop.png');
    // Снимок можно подменить: калибровка генератора сравнивает свой снимок,
  // а не тот, что снят с сайта.
  const shotPath = arg('--shot', null) ?? join(root, '.screens', `${item.replace('/', '-')}.png`);
  if (!existsSync(cropPath)) {
    console.log(`${item}: нет кропа — пропущен`);
    continue;
  }
  if (!existsSync(shotPath)) {
    console.log(`${item}: нет снимка — сделайте node tools/shot.mjs`);
    continue;
  }
  const ref = decodePng(readFileSync(cropPath));
  const cur = decodePng(readFileSync(shotPath));
  const findings = findingsOf(ref, cur);
  const report = {
    unit: item,
    at: new Date().toISOString(),
    reference: `design/figma/pages/${item}/crop.png`,
    shot: shotPath,
    size: { ref: [ref.width, ref.height], shot: [cur.width, cur.height] },
    findings,
  };
  writeFileSync(join(outDir, `${item.replace('/', '-')}.json`), JSON.stringify(report, null, 2) + '\n');
  if (findings.length) {
    withFindings += 1;
    console.log(`${item}: замечаний ${findings.length} · худшее ${findings[0].mean}`);
    for (const f of findings.slice(0, 3)) console.log(`   ${f.x},${f.y} ${f.w}×${f.h} — средняя ${f.mean}, > 48 у ${f.over} %`);
  } else {
    console.log(`${item}: замечаний нет`);
  }
}

console.log(`\nзамечания: ${withFindings} из ${units.length} секций · отчёт: reviews/${runName}/`);
process.exit(withFindings ? 1 : 0);
