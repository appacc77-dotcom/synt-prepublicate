#!/usr/bin/env node
/**
 * Проверяет, что страница не шире экрана на ширине макета.
 *
 *   node tools/check-layout.mjs [--url /] [--widths 1440]
 *
 * Класс ошибки: блок шире кадра — появляется горизонтальная прокрутка.
 *
 * **Мобильной вёрстки нет.** В файле только кадр 1440; макетов 390 и 768
 * дизайнер не делал. Поэтому по умолчанию проверяется одна ширина — 1440.
 * Другие ширины можно передать руками, но это не приёмка: сверять не с чем.
 * Адаптив не «сжимается по месту» — он появится, когда появятся макеты.
 *
 * Что считается дефектом:
 *   - `scrollWidth` больше ширины окна — появилась горизонтальная прокрутка;
 *   - элемент с `data-figma-node` выходит за правый или левый край.
 *
 * Тап-таргеты не проверяются: текстовые ссылки законно ниже 44 px, а правило
 * про 44 касается управляющих элементов — это отдельное решение, не ворота.
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
// По умолчанию — все страницы проекта: пока проверялась одна, ворота молчали
// про раскладку остальных.
const routes = existsSync(join(root, 'design/figma/project.json'))
  ? (JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8')).routes ?? {})
  : {};
const pageList = onlyUrl ? [onlyUrl] : [...new Set(Object.values(routes))];
// Ширины по умолчанию: макет 1440 и, если мобильный слой объявлен записью
// (design/mobile.json), ещё 768 и 390. Ворота не должны «забывать» про
// телефон, когда слой уже в сборке.
const mobileFile = join(root, 'design/mobile.json');
const mobileWidths = existsSync(mobileFile)
  ? JSON.parse(readFileSync(mobileFile, 'utf8')).breakpoints ?? []
  : [];
const defaultWidths = [1440, ...mobileWidths].join(',');
const widths = arg('--widths', defaultWidths)
  .split(',')
  .map((w) => Number(w.trim()))
  .filter(Boolean);

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

const port = Number(process.env.LAYOUT_PORT ?? 4338);
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const browser = await chromium.launch();
let failed = false;

for (const urlPath of pageList.length ? pageList : ['/']) {
for (const width of widths) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  // Схлопывание отступа: margin-top у первого блока секции уходит наружу,
  // если у секции нет padding/border/overflow. Три раза подряд это стоило
  // сдвига всей секции на 64–96 px.
  const collapsed = await page.evaluate(() => {
    const out = [];
    for (const section of document.querySelectorAll('section[data-figma-node]')) {
      const first = section.firstElementChild;
      if (!first) continue;
      const cs = getComputedStyle(first);
      const parent = getComputedStyle(section);
      const margin = parseFloat(cs.marginTop) || 0;
      if (margin <= 0) continue;
      // Схлопывание не происходит, если у родителя есть отсечка.
      const blocked =
        (parseFloat(parent.paddingTop) || 0) > 0 ||
        (parseFloat(parent.borderTopWidth) || 0) > 0 ||
        ['hidden', 'clip', 'auto', 'scroll'].includes(parent.overflowY) ||
        parent.display === 'flex' || parent.display === 'grid';
      if (!blocked) {
        out.push({
          section: section.className || section.getAttribute('data-figma-node'),
          first: first.className || first.tagName.toLowerCase(),
          margin,
        });
      }
    }
    return out;
  });

  for (const item of collapsed) {
    console.error(`  схлопывание: ${item.section} → ${item.first} (margin-top ${item.margin} px)`);
  }

  const result = await page.evaluate((viewportWidth) => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth - viewportWidth;
    const offenders = [];

    // Элемент за краем — не дефект, если его подрезает предок с overflow.
    // Так устроена лента слайдера: она шире экрана намеренно.
    const clipped = (el) => {
      let node = el.parentElement;
      while (node) {
        const style = getComputedStyle(node);
        if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)) return true;
        node = node.parentElement;
      }
      return false;
    };

    for (const el of document.querySelectorAll('[data-figma-node]')) {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.right > viewportWidth + 1 || rect.left < -1) {
        if (clipped(el)) continue;
        offenders.push({
          id: el.getAttribute('data-figma-node'),
          cls: (el.className || '').toString().split(' ')[0],
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        });
      }
    }
    return { overflow, offenders };
  }, width);

  const ok = result.overflow <= 1 && !result.offenders.length && !collapsed.length;
  if (!ok) failed = true;
  console.log(`${width}px: ${ok ? 'ок' : 'ПЕРЕПОЛНЕНИЕ'} · запас по ширине ${-result.overflow}px · вылезло ${result.offenders.length}`);
  for (const item of result.offenders.slice(0, 6)) {
    console.log(`   ${item.cls || '—'} [${item.id}] ${item.left}…${item.right}`);
  }

  await page.close();
}
}

await browser.close();
server.close();

console.log('');
console.log('390 и 768 не проверяются: макетов нет, адаптива нет — это не дефект, а отсутствие исходника.');

if (failed) {
  console.error('раскладка не держится: горизонтальная прокрутка или схлопнутый отступ секции');
  process.exit(1);
}
console.log('на ширине макета раскладка держится');
