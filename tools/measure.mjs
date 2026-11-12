#!/usr/bin/env node
/**
 * Ворота геометрии: DOM против spec.json, связь через data-figma-node.
 *
 *   node tools/measure.mjs design/figma/pages/home/hero/spec.json
 *   node tools/measure.mjs design/figma/pages/home/hero/spec.json --tol 1 --url /
 *
 * Как читается связь:
 *   - элемент с data-figma-node="79:106" сверяется с узлом 79:106 из спеки;
 *   - на одном элементе можно указать несколько id через пробел, если разметка
 *     схлопывает служебные фреймы (hero и hero-video — один <section>);
 *   - координаты считаются от корня секции, а не от DOM-родителя: разметка
 *     вправе отличаться от дерева Figma, пока совпадает геометрия.
 *
 * Ворота закрываются, если:
 *   1) нет элементов с id, которых нет в спеке;
 *   2) у всех узлов глубины ≤ 2 есть свой элемент (иначе часть секции не собрана);
 *   3) расхождение по x/y/w/h не больше допуска (по умолчанию 1 px).
 *
 * Код возврата 1 — ворота красные, 0 — зелёные.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, dirname, isAbsolute } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const specPath = process.argv[2];
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const batchPath = arg('--batch', null);

if (!specPath && !batchPath) {
  console.error('Укажи спеку: node tools/measure.mjs design/figma/pages/home/hero/spec.json');
  console.error('Или пакет:      node tools/measure.mjs --batch jobs.json');
  process.exit(2);
}

const tol = Number(arg('--tol', 1));
const width = Number(arg('--width', 1440));

// Задание — одна секция: спека, адрес страницы и способ найти корень.
// В пакетном режиме их много, и браузер со сервером одни на всех: поднимать
// Chromium на каждую секцию — самая дорогая часть замера.
const jobs = batchPath
  // Путь может быть абсолютным (конвейер передаёт свой): join склеил бы его
  // с корнем и получился бы несуществующий путь.
  ? JSON.parse(readFileSync(isAbsolute(batchPath) ? batchPath : join(root, batchPath), 'utf8'))
  : [{ spec: specPath, url: arg('--url', '/'), root: arg('--root', null), bySuffix: process.argv.includes('--by-suffix') }];

// --- Индекс узлов: id → узел, родитель восстанавливается по depth ----------
function indexSpec(spec) {
  const byId = new Map();
  const stack = [];
  for (const node of spec.nodes) {
    while (stack.length && stack[stack.length - 1].depth >= node.depth) stack.pop();
    node.parentId = stack.length ? stack[stack.length - 1].id : null;
    stack.push(node);
    byId.set(node.id, node);
  }
  return byId;
}

/**
 * Абсолютные координаты узла от корня секции.
 * Смещение самого корня не учитывается: в макете он стоит на странице
 * (например, pain на y=1305), а в DOM корень и есть начало координат.
 */
function absolute(node, rootId, byId) {
  let x = 0;
  let y = 0;
  let cur = node;
  while (cur && cur.id !== rootId) {
    x += cur.x;
    y += cur.y;
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return { x, y };
}

const dist = join(root, 'dist');
if (!existsSync(dist)) {
  console.error('Нет dist/. Сначала: npm run build');
  process.exit(2);
}

const port = Number(process.env.SHOT_PORT ?? 4332);
const base = `http://127.0.0.1:${port}`;
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', base);
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const browser = await chromium.launch();

/**
 * Одно задание: спека, адрес, корень. Всё дорогое (сервер, браузер) уже
 * поднято снаружи — внутри только навигация и сверка.
 */
async function measureJob(job, page, navigate = true) {
  const specPath = job.spec;
  const urlPath = job.url ?? '/';

  // Страницы может не быть в сборке: в новом проекте есть только structure.html.
  // Без этой проверки замер открывал 404 и сообщал «корень секции не размечен» —
  // то есть врал о причине.
  // Адрес может быть с параметром (`/quiz.html?result=1`) — в сборке это тот же
  // файл: параметр разбирает страница, а не сервер.
  const urlPathname = urlPath.split('?')[0].split('#')[0];
  const distFile = urlPathname === '/' ? 'index.html' : urlPathname.replace(/^\//, '');
  if (!existsSync(join(dist, distFile))) {
    // Это «не проверено», а не дефект вёрстки: страницы ещё нет в сборке.
    console.error(`Страницы ${urlPath} нет в dist/ (${distFile}) — сначала соберите её: npm run build`);
    return { ok: false, incomplete: true };
  }


  const raw = readFileSync(join(root, specPath), 'utf8');
  const spec = JSON.parse(raw.slice(raw.indexOf('{')));
  const byId = indexSpec(spec);

  // Навигация — только при смене адреса: страница на группу загружается один
  // раз, иначе каждая секция заново ждёт networkidle.
  if (navigate) {
    // networkidle ждал 500 мс тишины сети на каждой загрузке — семь страниц
    // давали 3.5 с. Но совсем без ожидания картинок нельзя: у карусели и
    // слайдера ширина зависит от загруженного изображения, и замер ловил
    // их до загрузки (voices давал 24 красных узла). Ждём то, что влияет:
    // шрифты и декодирование картинок, затем кадр.
    await page.goto(base + urlPath, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode().catch(() => null)));

      // Скрипты страницы (карусель, слайдер, аккордеон) доводят раскладку
      // после load. Ждём, пока она перестанет меняться: два одинаковых
      // замера подряд с паузой 60 мс, потолок 600 мс.
      const shape = () => {
        const parts = [document.body.scrollHeight];
        for (const el of document.querySelectorAll('section, [data-figma-node]')) {
          const r = el.getBoundingClientRect();
          parts.push(Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height));
        }
        return parts.join(',');
      };
      const started = performance.now();
      let previous = shape();
      while (performance.now() - started < 600) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        const current = shape();
        if (current === previous) break;
        previous = current;
      }
    });
  }

  // Общие секции (шапка, подвал) стоят на каждой странице своим инстансом:
  // id корня в спеке страницы свой, а в компоненте — id главной. --root
  // указывает, какой DOM-элемент считать корнем, --by-suffix сопоставляет
  // остальные узлы по внутреннему id инстанса (I<инстанс>;<внутренний>).
  const rootId = spec.section.id;
  const domRootId = job.root ?? spec.section.id;
  const bySuffix = job.bySuffix ?? false;
  const suffixOf = (id) => String(id).split(';').pop();

  const measured = await page.evaluate((rootNodeId) => {
    const rootEl = document.querySelector(`[data-figma-node~="${rootNodeId}"]`);
    if (!rootEl) return { error: 'root-not-found' };
    const origin = rootEl.getBoundingClientRect();
    const out = [];
    // сам корень тоже меряем: он должен совпасть с (0,0,w,h)
    const roots = [rootEl, ...rootEl.querySelectorAll('[data-figma-node]')];
    for (const el of roots) {
      const ids = (el.getAttribute('data-figma-node') ?? '').trim().split(/\s+/).filter(Boolean);
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      out.push({
        ids,
        x: +(r.x - origin.x).toFixed(2),
        y: +(r.y - origin.y).toFixed(2),
        w: +r.width.toFixed(2),
        h: +r.height.toFixed(2),
        hidden: style.display === 'none' || style.visibility === 'hidden',
        // Типографика: у текста она важнее координат, а сверялась только ширина.
        fs: +parseFloat(style.fontSize).toFixed(2),
        lh: style.lineHeight === 'normal' ? null : +parseFloat(style.lineHeight).toFixed(2),
        ls: style.letterSpacing === 'normal' ? 0 : +parseFloat(style.letterSpacing).toFixed(2),
        // Ширина задана явно из спеки — поправка на трекинг не нужна.
        fixedWidth: el.style.width !== '',
        tag: el.tagName.toLowerCase(),
        cls: String(el.className ?? '').slice(0, 40),
      });
    }
    return { origin: { x: origin.x, y: origin.y, w: origin.width, h: origin.height }, elements: out };
  }, domRootId);

  // Браузер и сервер закрываются снаружи: они одни на все задания.
  // gate.json пишется только при изменении содержимого: метка времени сама по
  // себе не повод менять отслеживаемый файл (иначе каждый прогон «грязнит» дерево).
  const gatePath = join(dirname(join(root, specPath)), 'gate.json');
  function writeGate(gate) {
    const strip = (g) => JSON.stringify({ ...g, at: undefined });
    if (existsSync(gatePath)) {
      try {
        if (strip(JSON.parse(readFileSync(gatePath, 'utf8'))) === strip(gate)) return;
      } catch {
        // битый файл — перепишем
      }
    }
    writeFileSync(gatePath, JSON.stringify(gate, null, 2) + '\n');
  }

  if (measured.error) {
    console.error(`Нет элемента с data-figma-node="${domRootId}" — корень секции не размечен.`);
    // Красный gate.json обязателен: иначе старый зелёный переживёт поломку
    // и его прочтут структура, статус и ворота состояний.
    writeGate({
      at: new Date().toISOString(),
      section: spec.section,
      ok: false,
      error: 'root-not-found',
      red: 0,
      unknown: 0,
      missing: [{ id: spec.section.id, name: spec.section.name }],
      marked: 0,
      nodes: spec.nodes.length,
      coverage: 0,
      markedRatio: 0,
      tolerance: tol,
      worstDelta: 0,
    });
    // Корень не размечен — секция не собрана. Дефект это или нет, решает не
    // замер: он честно говорит «не измерено».
    return { ok: false, incomplete: true };
  }

  // --- Сверка ---------------------------------------------------------------
  const rows = [];
  const seen = new Set();
  // covered — узлы, у которых есть ВИДИМЫЙ элемент. Обязательный узел,
  // размеченный только на скрытом элементе, секцию не собирает.
  const covered = new Set();
  let unknown = 0;
  let red = 0;

  // Карта «внутренний id → узел спеки» для общих секций.
  const bySuffixMap = new Map();
  if (bySuffix) {
    for (const node of spec.nodes) {
      const key = suffixOf(node.id);
      if (!bySuffixMap.has(key)) bySuffixMap.set(key, node);
    }
  }

  for (const el of measured.elements) {
    for (const id of el.ids) {
      // Сам корень: в DOM он размечен id главной, в спеке страницы — своим.
      const node =
        id === domRootId
          ? byId.get(rootId)
          : byId.get(id) ?? (bySuffix ? bySuffixMap.get(suffixOf(id)) : undefined);
      if (node) seen.add(node.id);
      if (!node) {
        unknown++;
        rows.push({ id, name: '—', status: 'НЕТ В СПЕКЕ', el });
        continue;
      }
      if (el.hidden) {
        rows.push({ id: node.id, name: node.name, status: 'СКРЫТ', el });
        continue;
      }
      covered.add(node.id);
      const abs = absolute(node, rootId, byId);

      // Типографика: fontSize в px, lineHeight и letterSpacing — в процентах
      // от кегля. Это ровно те три числа, которые я дважды взял на глаз.
      const typo = [];
      if (node.type === 'TEXT' && node.fontSize) {
        const fs = node.fontSize;
        const expectLh = node.lineHeight
          ? node.lineHeight.unit === 'PERCENT'
            ? (fs * node.lineHeight.value) / 100
            : node.lineHeight.value
          : null;
        const expectLs = node.letterSpacing
          ? node.letterSpacing.unit === 'PERCENT'
            ? (fs * node.letterSpacing.value) / 100
            : node.letterSpacing.value
          : 0;

        if (Math.abs(el.fs - fs) > 0.5) typo.push(`кегль ${fs} → ${el.fs}`);
        if (expectLh !== null && el.lh !== null && Math.abs(el.lh - expectLh) > 1) {
          typo.push(`межстрочный ${+expectLh.toFixed(1)} → ${el.lh}`);
        }
        if (Math.abs(el.ls - expectLs) > 0.15) typo.push(`трекинг ${+expectLs.toFixed(2)} → ${el.ls}`);
      }
      // Ширину текста сверяем: блоки ограничены max-width из спеки, поэтому
      // совпадает и ширина, и точки переноса. Если у блока ширины нет — он
      // растянется на колонку и ворота это покажут.
      //
      // Исключение — текст с HUG-шириной и ненулевым трекингом: браузер
      // добавляет трекинг и после последней буквы, Figma — нет. Коробка выходит
      // шире на один трекинг, хотя «чернила» совпадают. Сравниваем по чернилам.
      const ink = (() => {
        if (node.type !== 'TEXT' || node.sizing?.h !== 'HUG' || !node.letterSpacing) return el.w;
        // Ширина взята из узла спеки — коробка уже равна эталону: поправка
        // на трекинг (браузер добавляет его после последней буквы) только врёт.
        if (el.fixedWidth) return el.w;
        // Ширина уже равна узлу — поправка на трекинг только врёт.
        if (Math.abs(el.w - node.w) < 0.5) return el.w;
        const ls = node.letterSpacing;
        const trim = ls.unit === 'PERCENT' ? (ls.value / 100) * node.fontSize : ls.value;
        return el.w - trim;
      })();
      const worst = Math.max(
        Math.abs(el.x - abs.x),
        Math.abs(el.y - abs.y),
        Math.abs(ink - node.w),
        Math.abs(el.h - node.h),
      );
      const ok = worst <= tol && typo.length === 0;
      if (!ok) red++;
      rows.push({
        id,
        name: node.name,
        typo,
        figma: { ...abs, w: node.w, h: node.h },
        dom: el,
        worst,
        ok,
        status: ok ? 'ok' : 'РАСХОЖДЕНИЕ',
      });
    }
  }

  // Узлы глубины ≤ 2 обязаны иметь элемент: иначе секция собрана не целиком.
  const required = spec.nodes.filter((n) => n.depth > 0 && n.depth <= 2 && n.visible);
  const missing = required.filter((n) => !covered.has(n.id));
  const coverage = required.length ? ((required.length - missing.length) / required.length) * 100 : 100;

  // --- Печать ---------------------------------------------------------------
  const pad = (v, n) => String(v).padStart(n);
  console.log(`секция: ${spec.section.name}  ${spec.section.w}×${spec.section.h}  (${rootId})`);
  console.log(`допуск: ${tol} px · ширина: ${width}\n`);
  console.log('узел                        эталон (x,y,w,h)      DOM (x,y,w,h)         Δ max  статус');

  const depthOf = (id) => byId.get(id)?.depth ?? 99;
  for (const r of rows.sort((a, b) => depthOf(a.id) - depthOf(b.id))) {
    if (r.status === 'НЕТ В СПЕКЕ') {
      console.log(`${r.id.padEnd(26)}  ${'—'.padEnd(20)}  ${`${r.el.x},${r.el.y},${r.el.w},${r.el.h}`.padEnd(20)}  ${'—'.padStart(5)}  ${r.status}`);
      continue;
    }
    if (r.status === 'СКРЫТ') {
      console.log(`${r.id.padEnd(26)}  ${'скрыт'.padEnd(20)}  ${''.padEnd(20)}  ${'—'.padStart(5)}  ${r.status}`);
      continue;
    }
    const f = `${r.figma.x},${r.figma.y},${r.figma.w},${r.figma.h}`;
    const a = `${r.dom.x},${r.dom.y},${r.dom.w},${r.dom.h}`;
    // Типографика печатается отдельной строкой: у неё другая единица, и
    // складывать её с пикселями в «Δ max» нельзя.
    const typoNote = r.typo?.length ? `\n      типографика: ${r.typo.join('; ')}` : '';
    console.log(
      `${(r.ok ? '  ' : '! ') + r.id.padEnd(24)}  ${f.padEnd(20)}  ${a.padEnd(20)}  ${pad(r.worst.toFixed(2), 5)}  ${r.status}${typoNote}`,
    );
  }

  console.log(`\nразмечено узлов: ${seen.size} из ${spec.nodes.length} (${((seen.size / Math.max(1, spec.nodes.length)) * 100).toFixed(0)} %)`);
  console.log(`обязательных (глубина ≤ 2): ${required.length}, покрыто ${coverage.toFixed(0)} %`);
  if (seen.size < spec.nodes.length) {
    console.log(`не размечено ${spec.nodes.length - seen.size}: их геометрия не проверяется, только пиксель`);
  }
  if (missing.length) {
    console.log('не размечены:');
    for (const n of missing) console.log(`   ${n.id}  ${n.name}  ${n.w}×${n.h} (глубина ${n.depth})`);
  }
  if (unknown) console.log(`\nВНИМАНИЕ: ${unknown} атрибут(ов) ссылаются на узлы, которых нет в спеке.`);

  const failed = red > 0 || unknown > 0 || missing.length > 0;

  // Числа остаются на диске: страница структуры читает их, а не пересказ.
  const gate = {
    at: new Date().toISOString(),
    section: spec.section,
    ok: !failed,
    red,
    unknown,
    missing: missing.map((n) => ({ id: n.id, name: n.name })),
    marked: seen.size,
    nodes: spec.nodes.length,
    // coverage — доля обязательных узлов (глубина ≤ 2), по ним вердикт.
    coverage: +coverage.toFixed(1),
    // markedRatio — доля размеченных от всех узлов. Замер проверяет только
    // размеченные: 24 из 76 значит, что 52 узла не сверяются вовсе, и «100 %»
    // относится к обязательным, а не ко всей секции.
    markedRatio: +((seen.size / Math.max(1, spec.nodes.length)) * 100).toFixed(1),
    tolerance: tol,
    worstDelta: rows.reduce((m, r) => (r.worst > m ? r.worst : m), 0),
  };
  writeGate(gate);

  console.log(
    `\nвердикт: ${failed ? 'КРАСНЫЕ' : 'зелёные'} · расхождений ${red}, вне спеки ${unknown}, ` +
      `не размечено обязательных ${missing.length} · размечено ${seen.size} из ${spec.nodes.length}`,
  );
  return { ok: !failed };
}

// --- Прогон ---------------------------------------------------------------
// Задания группируются по адресу: страница загружается один раз на группу,
// а не на каждую секцию. Это и есть выигрыш пакетного режима.
const byUrl = new Map();
for (const job of jobs) {
  const url = job.url ?? '/';
  if (!byUrl.has(url)) byUrl.set(url, []);
  byUrl.get(url).push(job);
}

let failedAny = false;
let incompleteAny = false;
for (const [url, group] of byUrl) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  let first = true;
  for (const job of group) {
    const result = await measureJob(job, page, first);
    first = false;
    if (!result.ok) {
      if (result.incomplete) incompleteAny = true;
      else failedAny = true;
    }
  }
  await page.close();
}

await browser.close();
server.close();
// Коды как у конвейера: 1 — дефект, 3 — не проверено. Смешивать их значит
// объявлять несобранную страницу дефектом вёрстки.
process.exit(failedAny ? 1 : incompleteAny ? 3 : 0);
