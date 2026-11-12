#!/usr/bin/env node
/**
 * Проверяет, что блоки, доходящие до края, тянутся вместе с окном.
 *
 *   node tools/check-stretch.mjs [--url /] [--narrow 1440] [--wide 1512]
 *
 * Класс ошибки: элемент с фоном держит фиксированную ширину, а окно шире —
 * справа остаётся полоса фона секции. Так нашлись три случая подряд: секции
 * `width: 1440px` на «Методе», панель в шапке «Мастеров» (фото 876 + панель
 * 564 = ровно 1440) и сама плавающая шапка (1424 при окне 1512).
 *
 * Правило одно: если при ширине макета элемент доходит до правого края
 * (отступ ≤ 16 px), то при более широком окне его ширина должна вырасти
 * ровно на прибавку окна. Не выросла — это полоса, а не дизайн.
 *
 * Коды: 0 — тянется всё, 1 — есть полоса, 2 — не смогли проверить.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const dist = join(root, 'dist');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const onlyUrl = arg('--url', null);
const routes = existsSync(join(root, 'design/figma/project.json'))
  ? (JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8')).routes ?? {})
  : {};
const pageList = onlyUrl ? [onlyUrl] : [...new Set(Object.values(routes))];
const narrow = Number(arg('--narrow', 1440));
const wide = Number(arg('--wide', 1512));
const EDGE = 16; // отступ, при котором элемент считается доходящим до края
const TOLERANCE = 2;

// Различаем два состояния: сборки нет вовсе и сборка есть, но страниц сайта
// в ней нет (новый проект: собрана только structure.html). Иначе сообщение
// «нет dist/» врёт о причине.
if (!existsSync(dist)) {
  console.error('нет dist/ — сначала npm run build');
  process.exit(2);
}
if (!existsSync(join(dist, 'index.html'))) {
  console.error('в dist нет страниц сайта (собрана только служебная) — сначала соберите страницы');
  process.exit(2);
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';
  const file = normalize(join(dist, path));
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

const port = Number(process.env.STRETCH_PORT ?? 4344);
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const browser = await chromium.launch();
let failed = false;

/**
 * Элементы с фоном, доходящие до правого края. Ключ — тег, класс и порядковый
 * номер среди таких же: между двумя загрузками разметка одна и та же.
 */
const collect = (page) =>
  page.evaluate((edge) => {
    // Нумеруем ВСЕ подходящие элементы, а не только доходящие до края:
    // иначе на широком окне «переставший доходить» элемент выпадал из
    // выборки, и ворота молчали — проверено подменой width обратно на 1440.
    const seen = new Map();
    const out = [];
    // Карточки внутри прокручиваемых лент не тянутся по определению: их
    // ширина задана, а лента обрезает. Ищем ближайшего предка с обрезкой.
    const inScroller = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
      }
      return false;
    };

    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      const hasBg = cs.backgroundImage !== 'none' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
      if (!hasBg) continue;
      if (inScroller(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 20) continue;
      const cls = String(el.className).split(' ')[0] || el.tagName.toLowerCase();
      const n = seen.get(cls) ?? 0;
      seen.set(cls, n + 1);
      out.push({
        key: `${cls}#${n}`,
        width: Math.round(r.width),
        right: Math.round(r.right),
        touchesEdge: window.innerWidth - r.right <= edge,
      });
    }
    return { vw: window.innerWidth, items: out };
  }, EDGE);

for (const urlPath of pageList.length ? pageList : ['/']) {
  const atNarrow = await browser.newPage({ viewport: { width: narrow, height: 900 } });
  // networkidle ждал 500 мс тишины сети на каждой загрузке: 14 загрузок —
  // восемь секунд на пустом месте. Ширину меряем после шрифтов, этого хватает.
  await atNarrow.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'load' });
  await atNarrow.evaluate(() => document.fonts.ready);
  const a = await collect(atNarrow);
  await atNarrow.close();

  const atWide = await browser.newPage({ viewport: { width: wide, height: 900 } });
  await atWide.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'load' });
  await atWide.evaluate(() => document.fonts.ready);
  const b = await collect(atWide);
  await atWide.close();

  const expected = b.vw - a.vw;
  const byKey = new Map(b.items.map((i) => [i.key, i]));
  const bad = [];
  for (const item of a.items) {
    if (!item.touchesEdge) continue;
    const grown = byKey.get(item.key);
    if (!grown) {
      bad.push({ key: item.key, was: item.width, now: null, delta: null, expected });
      continue;
    }
    const delta = grown.width - item.width;
    if (Math.abs(delta - expected) > TOLERANCE) {
      bad.push({ key: item.key, was: item.width, now: grown.width, delta, expected });
    }
  }

  if (bad.length) {
    failed = true;
    console.log(`${urlPath}: полоса справа — ${bad.length}`);
    for (const x of bad.slice(0, 6)) {
      const now = x.now === null ? 'исчез' : `стало ${x.now} (прибавка ${x.delta}, ожидалась ${x.expected})`;
      console.log(`  ${x.key}: было ${x.was}, ${now}`);
    }
  }
}

await browser.close();
server.close();

if (!failed) console.log(`тянется всё: ${pageList.length} страниц, окна ${narrow} → ${wide}`);
process.exit(failed ? 1 : 0);
