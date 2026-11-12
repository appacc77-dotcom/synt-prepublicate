#!/usr/bin/env node
/**
 * Проверяет, что элементы управления действительно что-то делают.
 *
 *   node tools/check-interactive.mjs [--url /] [--only .faq]
 *
 * Класс ошибки, который ловит: блок собран как картинка. Геометрия сходится,
 * пиксель сходится, а кнопка, вкладка или вопрос не реагируют — потому что
 * обработчика нет. Так было с меню, вкладками форматов, слайдером отзывов
 * и аккордеоном FAQ: все четыре проходили ворота статичными.
 *
 * Как работает: находит в секции кнопки и `summary`, снимает отпечаток
 * состояния секции, нажимает и сравнивает отпечаток. Не изменилось — значит
 * элемент мёртвый.
 *
 * Ссылки `a[href="#"]` не проверяются: это заглушки навигации, а не управление.
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
const routes = JSON.parse(readFileSync(join(process.cwd(), 'design/figma/project.json'), 'utf8')).routes ?? {};
// По умолчанию проверяем все страницы проекта: пока страница была одна, ворота
// молча смотрели только главную.
const project = JSON.parse(readFileSync(join(process.cwd(), 'design/figma/project.json'), 'utf8'));
// Экраны, живущие на адресе с параметром (результат теста), тоже проверяются:
// без этого скрытая секция молча пропускалась, и её элементы управления не
// проверял никто.
const extraUrls = Object.values(project.unitUrls ?? {});
const pageList = onlyUrl ? [onlyUrl] : [...new Set([...Object.values(routes), ...extraUrls])];
const only = arg('--only', null);
const width = Number(arg('--width', 1440));

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

const port = Number(process.env.INTERACTIVE_PORT ?? 4336);
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height: 900 } });
let dead = 0;
// Известные долги: элемент помечен `data-inert-ok="<id долга>"`. Он не работает,
// но это решение, а не дефект вёрстки. Печатается каждый прогон.
const known = [];
// Секции, которые на странице скрыты: проверить их нельзя, но и молчать о них
// нельзя — иначе прогон выглядит полным.
const skipped = [];
// Секция может быть скрыта на одном адресе и видна на другом (результат теста
// живёт на /quiz.html?result=1). Считаем проверенной, если её проверили хоть
// где-то, и не жалуемся на скрытость там, где она скрыта по делу.
const checkedSomewhere = new Set();
let pretenders = 0;
let checked = 0;
for (const urlPath of pageList) {
await page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);

// Отпечаток секции: классы, атрибуты и число узлов. Достаточно, чтобы увидеть
// смену состояния, и не зависит от конкретной разметки блока.
const signature = (selector) =>
  page.evaluate((sel) => {
    const rootEl = document.querySelector(sel);
    if (!rootEl) return null;
    const parts = [];
    const walk = (el) => {
      // Только то, что видно: тег, классы, инлайн-стиль и реальная видимость.
      // Геометрии мало: закрытое меню шапки скрыто через visibility, но бокс
      // у него есть — по getClientRects оно выглядело открытым.
      const cs = getComputedStyle(el);
      // Текст листьев тоже виден пользователю: подсказка может сменить только
      // содержимое, оставшись видимой.
      const text = el.children.length === 0 ? (el.textContent ?? '').trim().slice(0, 60) : '';
      parts.push(
        `${el.tagName}|${el.className}|${el.getAttribute('style') ?? ''}|${cs.visibility}|${cs.display}|${cs.opacity}|${text}`,
      );
      for (const child of el.children) walk(child);
    };
    walk(rootEl);
    return parts.join('\n');
  }, selector);

// Отпечаток самого переключателя: меняется ли его вид, когда он открывает
// состояние. Иначе пользователь не видит, что меню открыто.
const controlSignature = (handle) =>
  handle.evaluate((el) => {
    const parts = [];
    const walk = (node) => {
      const cs = getComputedStyle(node);
      parts.push(
        `${node.tagName}|${node.className}|${cs.transform}|${cs.opacity}|${cs.backgroundColor}|${cs.display}|${cs.visibility}|${node.open ?? ''}`,
      );
      for (const child of node.children) walk(child);
    };
    walk(el);
    return parts.join('\n');
  });

const sections = await page.evaluate((onlySel) => {
  // Секция — самый внешний узел с data-figma-node внутри <section>: вложенные
  // узлы проверять бессмысленно, их состояние меняется снаружи.
  const out = [];
  for (const section of document.querySelectorAll('section')) {
    const outer = section.matches('[data-figma-node]')
      ? section
      : section.querySelector('[data-figma-node]');
    if (!outer) continue;
    if (!outer.querySelector('button, summary')) continue;
    const id = outer.getAttribute('data-figma-node');
    const sel = `[data-figma-node="${id}"]`;
    if (onlySel && !outer.matches(onlySel) && !outer.closest(onlySel)) continue;
    out.push({ id, name: (outer.className || section.className).split(' ')[0] || outer.tagName.toLowerCase(), selector: sel });
  }
  return out;
}, only);

if (!sections.length) {
  console.log(`${urlPath}: элементов управления нет`);
  continue;
}


for (const section of sections) {
  const controls = await page.$$(`${section.selector} button, ${section.selector} summary`);
  if (!controls.length) continue;

  // Скрытая секция: кликать нечего, элементы не отрисованы.
  const visible = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, section.selector);
  if (!visible) {
    // Скрытая секция с элементами управления — это не «проверено»: кликнуть
    // по ней нельзя. Раньше она молча пропускалась, и прогон выглядел полным.
    console.log(`${section.name.padEnd(18)} секция скрыта — не проверена`);
    skipped.push(section.name);
    continue;
  }

  checkedSomewhere.add(section.name);
  let alive = false;
  let ariaOnly = [];
  let blind = [];
  let covered = [];
  let inert = [];

  for (const control of controls) {
    const label = (await control.evaluate((el) => (el.textContent ?? '').trim().slice(0, 24) || el.getAttribute('aria-label') || el.tagName.toLowerCase())).trim();
    // Состояние снимается ПЕРЕД каждым кликом: сравнение с исходным делало
    // секцию «живой навсегда» — одного работающего элемента хватало, чтобы
    // мёртвые рядом не считались дефектом.
    const before = await signature(section.selector);
    const skip = await control.evaluate((el) => {
      // Выбранный пункт радиогруппы и точка «вы здесь» при повторном клике
      // ничего не меняют — это поведение, а не дефект.
      if (el.getAttribute('role') === 'radio' && el.getAttribute('aria-checked') === 'true') return true;
      // Уже выбранный переключатель и точка «вы здесь» при повторном клике
      // ничего не меняют по определению.
      if (el.getAttribute('aria-pressed') === 'true') return true;
      // Отключённый элемент по определению ничего не делает.
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return true;
      return el.getAttribute('aria-current') === 'true';
    });
    if (skip) continue;

    const ariaBefore = await control.evaluate((el) => el.getAttribute('aria-expanded'));
    const selfBefore = await controlSignature(control);
    try {
      await control.click({ timeout: 2000 });
    } catch (error) {
      // Перекрытый элемент — такой же дефект, как мёртвый: до него не добраться.
      const isCovered = String(error.message).includes('intercepts pointer events');
      if (isCovered) covered.push(label);
      continue;
    }
    // Ждём не «на всякий случай 320 мс», а изменения разметки: обычный клик
    // отзывается за десятки миллисекунд, и сто тринадцать фиксированных
    // ожиданий давали 36 секунд из 42. Предел 400 мс — чтобы медленный
    // обработчик не был принят за мёртвый.
    await page
      .waitForFunction(
        ([sel, was]) => {
          const rootEl = document.querySelector(sel);
          if (!rootEl) return true;
          const parts = [];
          const walk = (el) => {
            const cs = getComputedStyle(el);
            const text = el.children.length === 0 ? (el.textContent ?? '').trim().slice(0, 60) : '';
            parts.push(`${el.tagName}|${el.className}|${el.getAttribute('style') ?? ''}|${cs.visibility}|${cs.display}|${cs.opacity}|${text}`);
            for (const child of el.children) walk(child);
          };
          walk(rootEl);
          return parts.join('\n') !== was;
        },
        [section.selector, before],
        { timeout: 400, polling: 30 },
      )
      .catch(() => {
        // Не изменилось за 400 мс — это и есть повод считать элемент мёртвым;
        // решение принимает код ниже, а не ожидание.
      });
    // Паузы нет: у большинства элементов подпись уже конечная. Ждём только
    // тогда, когда собираемся обвинить элемент в «меняет лишь атрибут»:
    // переход мог ещё не дойти до конца, и обвинение было бы ложным.
    void 0;
    checked += 1;

    // Элемент мог увести на другой адрес (кнопка «пройти тест» на экране
    // результата). Это не «мёртвый»: он сработал. Возвращаемся на страницу
    // и продолжаем — иначе контекст разрушен и проверка падает.
    let now;
    try {
      now = await signature(section.selector);
    } catch (error) {
      if (!String(error.message).includes('Execution context was destroyed')) throw error;
      alive = true;
      await page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'load' });
      await page.waitForTimeout(200);
      continue;
    }
    const ariaAfter = await control.evaluate((el) => el.getAttribute('aria-expanded')).catch(() => null);
    let selfAfter = await controlSignature(control).catch(() => null);
    if (ariaBefore !== null && ariaAfter !== null && ariaBefore !== ariaAfter && selfBefore === selfAfter) {
      // Атрибут переключился, а computed-стили ещё стартовые: даём переходу
      // доиграть и смотрим снова. Платят только подозрительные элементы.
      await page.waitForTimeout(160);
      selfAfter = await controlSignature(control).catch(() => null);
    }

    // Переключатель обязан показать своё состояние: крестик вместо полос,
    // повёрнутый шеврон, другая иконка. Иначе открытие не читается.
    if (selfAfter === null) {
      // Элемент увёл на другой адрес — это сработавшая кнопка, а не дефект.
      alive = true;
      await page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'load' });
      await page.waitForTimeout(200);
      continue;
    }
    if (ariaBefore !== null && ariaAfter !== null && ariaBefore !== ariaAfter && selfBefore === selfAfter) {
      blind.push(label);
    }

    if (now !== before) {
      alive = true;
    } else if (ariaBefore !== null && ariaAfter !== null && ariaBefore !== ariaAfter) {
      // Атрибут переключился, а на экране ничего: элемент делает вид, что живой.
      ariaOnly.push(label);
    } else {
      const debt = await control.evaluate((el) => el.getAttribute('data-inert-ok')).catch(() => null);
      if (debt) known.push({ unit: section.name, label, debt });
      else inert.push(label);
    }
  }

  // Мёртвые элементы считаются поштучно, а не «секция целиком»: иначе один
  // живой элемент скрывал бы четыре мёртвых.
  dead += ariaOnly.length + blind.length + covered.length + inert.length;
  pretenders += ariaOnly.length + blind.length;
  const status = covered.length
    ? 'ПЕРЕКРЫТ'
    : ariaOnly.length
      ? 'ПРИТВОРЯЕТСЯ'
      : blind.length
        ? 'МОЛЧАЛИВЫЙ ПЕРЕКЛЮЧАТЕЛЬ'
        : inert.length
          ? 'МЁРТВЫЕ ЭЛЕМЕНТЫ'
          : alive
            ? 'живой'
            : 'СТАТИЧНЫЙ';
  console.log(`${section.name.padEnd(18)} элементов ${String(controls.length).padStart(2)} · ${status}`);
  for (const label of ariaOnly) console.log(`   «${label}» — меняет только aria, на экране ничего`);
  for (const label of blind) console.log(`   «${label}» — открывает состояние, но сам не меняется`);
  for (const label of covered) console.log(`   «${label}» — перекрыт другим слоем, клик не доходит`);
  for (const label of inert) console.log(`   «${label}» — нажатие не меняет ничего`);

  await page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
}
}

console.log(`\nпроверено элементов: ${checked}, притворяются: ${pretenders}, статичных секций: ${dead}`);

await browser.close();
server.close();

// Сначала печатаем всё, что собрали, и только потом выносим вердикт.
// Раньше выход по дефекту стоял выше и съедал список известных долгов и
// отметку «не проверено»: агент видел одну строку вместо картины.
if (known.length) {
  console.log(`известные долги (элемент не работает, есть решение): ${known.length}`);
  for (const item of known) console.log(`  ${item.unit} · «${item.label}» — долг ${item.debt}`);
}

const neverChecked = skipped.filter((name) => !checkedSomewhere.has(name));
if (neverChecked.length) {
  // Скрытые секции не проверены, а не пройдены: честный ответ — INCOMPLETE.
  console.log(`не проверено (секция скрыта везде): ${neverChecked.length} — ${neverChecked.join(', ')}`);
  console.log('проверить можно после действия, которое её открывает');
}

// Вердикт по приоритету, как у конвейера: ERROR (выход выше) > FAIL >
// INCOMPLETE > PASS. Дефект сильнее «не проверено», но оба видны в отчёте.
if (dead > 0) {
  console.error('\nэлемент, который меняет только атрибут, и секция без движения — это картинка: добавьте состояние и переход');
  process.exit(1);
}
if (neverChecked.length) process.exit(3);
console.log('все элементы управления меняют то, что видно');
