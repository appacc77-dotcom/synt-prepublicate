#!/usr/bin/env node
/**
 * Ловит растяжение фоновых картинок.
 *
 *   node tools/check-images.mjs [--url /]
 *
 * Класс ошибки: `background-size: 100% 100%` тянет картинку по обоим осям.
 * Если пропорции картинки и коробки совпадают — это безвредно; если нет,
 * фото искажается. Так было с air-photo: 1280×397 в коробке 1440×400 тянулось
 * по ширине на 12 %, и это не видел ни замер (геометрия сходилась), ни пиксель
 * (он давал 12,99 без объяснения причины).
 *
 * В Figma `scaleMode: FILL` — это `cover`: пропорции сохраняются, лишнее
 * обрезается. Поэтому растяжение почти всегда ошибка переноса.
 *
 * Проверка смотрит фактические пропорции: элемент с `background-size: 100% 100%`
 * и картинкой другой формы — дефект. Совпадающие пропорции не считаются.
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
// про остальные. `--url` сужает до конкретной.
const routes = existsSync(join(root, 'design/figma/project.json'))
  ? (JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8')).routes ?? {})
  : {};
const pageList = onlyUrl ? [onlyUrl] : [...new Set(Object.values(routes))];

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

const port = Number(process.env.IMAGES_PORT ?? 4340);
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let result = { checked: [], stretched: [] };

for (const urlPath of pageList.length ? pageList : ['/']) {
await page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);

const part = await page.evaluate(async () => {
  const TOLERANCE = 0.02; // 2 % — уже заметно на фото
  const stretched = [];
  const checked = [];

  // Слои фона разделяются запятыми, но внутри gradient(...) тоже есть запятые —
  // делим по верхнему уровню скобок.
  const splitLayers = (value) => {
    const out = [];
    let depth = 0;
    let current = '';
    for (const ch of value) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        out.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) out.push(current.trim());
    return out;
  };

  const loadSize = (url) =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = url;
    });

  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.backgroundImage === 'none') continue;
    const sizes = splitLayers(cs.backgroundSize);
    const layers = splitLayers(cs.backgroundImage);
    // Размеры и картинки идут параллельными списками: сверяем слой со слоем,
    // иначе первая картинка сравнивается с размером второй.
    const index = layers.findIndex((layer, i) => layer.startsWith('url(') && sizes[i] === '100% 100%');
    if (index < 0) continue;

    const url = (layers[index].match(/url\(["']?([^"')]+)/) ?? [])[1];
    if (!url) continue;

    const natural = await loadSize(url);
    if (!natural) continue;

    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;

    const imageRatio = natural.w / natural.h;
    const boxRatio = rect.width / rect.height;
    const delta = Math.abs(imageRatio - boxRatio) / imageRatio;
    checked.push({ cls: (el.className || '').toString().split(' ')[0], delta: +delta.toFixed(3) });

    if (delta > TOLERANCE) {
      stretched.push({
        cls: (el.className || '').toString().split(' ')[0] || el.tagName.toLowerCase(),
        image: `${natural.w}×${natural.h}`,
        box: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
        stretch: `${Math.round(delta * 100)} %`,
        url: url.split('/').pop(),
      });
    }
  }
  return { checked, stretched };
});

result.checked.push(...part.checked.map((c) => ({ ...c, urlPath })));
result.stretched.push(...part.stretched.map((c) => ({ ...c, urlPath })));
}

await browser.close();
server.close();

console.log(`элементов с растяжением по обеим осям: ${result.checked.length}`);

if (!result.stretched.length) {
  console.log('растянутых картинок нет');
  process.exit(0);
}

console.error(`\nрастянуто: ${result.stretched.length}`);
for (const item of result.stretched) {
  console.error(
    `  ${item.urlPath} ${item.cls}: картинка ${item.image} в коробке ${item.box} — искажение ${item.stretch} (${item.url})`,
  );
}
console.error('\nв Figma scaleMode FILL — это cover: пропорции сохраняются, лишнее обрезается');
process.exit(1);
