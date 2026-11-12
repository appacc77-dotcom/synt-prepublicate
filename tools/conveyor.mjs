#!/usr/bin/env node
/**
 * Единый вход для проверок. Тонкая обёртка над существующими инструментами:
 * ни один из них не переписан, но запускаются они вместе, не срезая друг
 * друга, и оставляют след прогона.
 *
 *   node tools/conveyor.mjs check [--unit home/hero] [--json]
 *   node tools/conveyor.mjs status [--json]
 *   node tools/conveyor.mjs plan [--unit home/hero]
 *   node tools/conveyor.mjs push-ok        — можно ли пушить (последний полный PASS на этом же содержимом)
 *
 * Зачем:
 *   1. `npm run verify` — цепочка `&&`: первая красная проверка скрывает
 *      остальные. Здесь выполняются все, каждая пишет свой результат.
 *   2. `gate.json` лежит рядом со спекой и затирается каждым прогоном.
 *      Здесь результат прогона живёт в `reports/runs/<runId>/` и не пропадает.
 *   3. Код возврата один на всё, и он не различал «не измерено» и «плохо».
 *      Здесь четыре статуса: PASS, FAIL, INCOMPLETE, ERROR.
 *
 * Шаги — дочерние процессы: `spawn(node, [tool, ...args])`, без shell-строк.
 * Упавший шаг не останавливает остальные; решение принимает политика.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const root = process.cwd();
const runsDir = join(root, 'reports/runs');

// --- Шаги ------------------------------------------------------------------
// needsDist: без собранной страницы шаг не имеет смысла.
// kind: 'gate' — влияет на вердикт; 'signal' — диагностика, вердикт не меняет.


/**
 * Отпечатки прогона: к какому коду и каким артефактам он относится.
 *
 * Зачем: `reports/runs/` не коммитится, а `gate.json` рядом со спекой
 * перезаписывается. Без этого вердикт нельзя связать с кодом — «прогон был
 * зелёным» ничего не говорит, если неизвестно, когда и на чём.
 */
function hashFiles(paths) {
  const h = createHash('sha256');
  // Путь — относительный от корня проекта: иначе один и тот же набор файлов
  // в другом каталоге даёт другой отпечаток.
  for (const path of paths.sort()) {
    h.update(relative(process.cwd(), path));
    h.update('\0');
    h.update(readFileSync(path));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

function walkFiles(dir, ext, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, ext, out);
    else if (!ext || full.endsWith(ext)) out.push(full);
  }
  return out;
}

// Файлы, которые прогон сам переписывает (замер и пиксель кладут числа рядом
// со спекой). Они отслеживаются, но «грязным» дерево из-за них не считается:
// иначе любой полный прогон делал себя же непригодным к выпуску.
const GENERATED = [
  /^design\/figma\/pages\/.+\/gate\.json$/,
  /^design\/figma\/pages\/.+\/pixel\.json$/,
  // Счётчик очереди моста: его переписывает figma-agent на каждом обращении
  // к плагину. Без исключения любой прогон с шагом `bindings` объявлял дерево
  // изменившимся, и `releaseEligible` не мог стать true никогда.
  /^design\/figma-contention\.json$/,
];
const isGenerated = (path) => GENERATED.some((re) => re.test(path));

/**
 * Состояние git на момент СТАРТА прогона: коммит, есть ли правки (без
 * генерируемых файлов) и отпечаток содержимого отслеживаемых файлов с диска.
 * contentHash сверяет хук пуша: зелёный прогон относится ровно к этому дереву.
 */
function gitState() {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const changed = execFileSync('git', ['status', '--porcelain', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .map((line) => line.slice(3));
    const dirtyFiles = changed.filter((path) => !isGenerated(path));
    const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter((path) => path && !isGenerated(path) && existsSync(join(root, path)))
      .map((path) => join(root, path));
    return { commit, dirty: dirtyFiles.length > 0, dirtyFiles: dirtyFiles.slice(0, 20), contentHash: hashFiles(tracked) };
  } catch {
    // не git-репозиторий — провенанс просто пустой, прогон от этого не падает
    return { commit: null, dirty: null, dirtyFiles: [], contentHash: null };
  }
}

function provenance() {
  const pagesDir = join(process.cwd(), 'design/figma/pages');
  const specs = walkFiles(pagesDir, 'spec.json');
  const crops = walkFiles(pagesDir, 'crop.png');
  const dist = walkFiles(join(process.cwd(), 'dist'));

  return {
    hashes: {
      specs: specs.length ? hashFiles(specs) : null,
      crops: crops.length ? hashFiles(crops) : null,
      dist: dist.length ? hashFiles(dist) : null,
    },
    files: { specs: specs.length, crops: crops.length, dist: dist.length },
  };
}

/** Сколько секций файла покрыто прогоном: «19 из 46». */
function coverage(units) {
  const path = join(process.cwd(), 'design/figma/structure.json');
  if (!existsSync(path)) return null;
  const total = JSON.parse(readFileSync(path, 'utf8'))?.totals?.total ?? null;
  if (!total) return null;
  // Юнитов может быть больше, чем секций в карте: экран результата квиза
  // лежит вне карты. Тогда так и пишем, а не «47 из 46».
  const extra = Math.max(0, units.length - total);
  const text = extra
    ? `${total} секций карты и ${extra} экран вне её`
    : `${units.length} из ${total}`;
  return { units: units.length, total, extra, text };
}

const GLOBAL_STEPS = [
  {
    id: 'designer-report',
    tool: 'report-designer',
    args: ['--check'],
    kind: 'gate',
    needsDist: false,
    about: 'отчёт дизайнеру совпадает с реестром долгов',
  },
  { id: 'gen-drift', tool: 'check-gen', args: ['--gate', 'drift'], kind: 'gate', needsDist: false, about: 'сгенерированные файлы совпадают с пересборкой' },
  { id: 'gen-coverage', tool: 'check-gen', args: ['--gate', 'coverage'], kind: 'gate', needsDist: false, about: 'генератор берёт не меньше узлов, чем порог' },
  { id: 'gen-overrides', tool: 'check-gen', args: ['--gate', 'overrides'], kind: 'gate', needsDist: false, about: 'у каждого пропуска генератора есть причина' },
  { id: 'lib-purity', tool: 'check-lib', kind: 'gate', needsDist: false, about: 'lib/ без зависимостей от проекта' },
  { id: 'site-clean', tool: 'check-site-clean', kind: 'gate', needsDist: false, about: 'выпуск без мастерской' },
  { id: 'site-contract', tool: 'check-site-contract', kind: 'gate', needsDist: false, about: 'выпуск связан с прогоном' },
  { id: 'links', tool: 'check-links', kind: 'gate', needsDist: true, about: 'внутренние ссылки не ведут в пустоту' },
  { id: 'publish', tool: 'check-publish', kind: 'gate', needsDist: true, about: 'в публикации нет отладочных страниц' },
  {
    id: 'spec-contract',
    tool: 'check-spec-contract',
    kind: 'gate',
    needsDist: false,
    about: 'спека по контракту: версия схемы, поля, типографика',
  },
  {
    id: 'spec-bounds',
    tool: 'check-spec-bounds',
    kind: 'gate',
    needsDist: false,
    about: 'координаты спеки сходятся: содержимое внутри рамки секции',
  },
  {
    id: 'overflow',
    tool: 'check-overflow',
    kind: 'gate',
    needsDist: true,
    about: 'контент не вылезает за блоки',
  },
  // Сборка — не наш скрипт, а бинарь Astro из node_modules.
  { id: 'contracts', tool: 'check-contracts', kind: 'gate', needsDist: false, about: 'контракты проверок сходятся' },
  { id: 'build', bin: 'node_modules/.bin/astro', args: ['build'], kind: 'gate', needsDist: false, about: 'сборка dist/' },
  // Без моста: в приёмке основы сверяемся со снимком, живой файл — в sources-live.
  { id: 'sources', tool: 'verify-sources', args: ['--offline'], kind: 'gate', needsDist: false, about: 'экспорт не устарел' },
  { id: 'changes', tool: 'check-changes', kind: 'gate', needsDist: false, about: 'изменения покрыты запросами' },
  { id: 'assets', tool: 'check-assets', kind: 'gate', needsDist: false, about: 'ассеты на месте' },
  { id: 'tokens', tool: 'check-tokens', kind: 'gate', needsDist: false, about: 'нет var() без токена' },
  { id: 'tokens-dtcg', tool: 'check-tokens-dtcg', kind: 'gate', needsDist: false, about: 'токены DTCG совпадают с CSS' },
  { id: 'invented', tool: 'check-invented', kind: 'gate', needsDist: false, about: 'нет вёрстки под несуществующие ширины' },
  { id: 'registry', tool: 'check-registry', kind: 'gate', needsDist: false, about: 'изобретённое и долги в реестрах' },
  { id: 'enhancements', tool: 'check-enhancements', kind: 'gate', needsDist: false, about: 'дополнения согласованы и отключаемы' },
  { id: 'portability', tool: 'check-portability', kind: 'gate', needsDist: false, about: 'нет привязки к проекту' },
  { id: 'scaffold', tool: 'check-scaffold', kind: 'gate', needsDist: false, about: 'шаблон не отстал' },
  { id: 'bindings', tool: 'check-bindings', kind: 'gate', needsDist: false, about: 'цвета из переменных' },
  { id: 'states', tool: 'check-states', kind: 'gate', needsDist: true, about: 'контент всех состояний собран' },
  { id: 'interactive', tool: 'check-interactive', kind: 'gate', needsDist: true, about: 'блоки живые' },
  { id: 'motion', tool: 'check-motion', kind: 'gate', needsDist: true, about: 'есть переходы' },
  { id: 'motion-manifest', tool: 'check-motion-manifest', kind: 'gate', needsDist: false, about: 'движение описано в манифесте' },
  { id: 'layout', tool: 'check-layout', kind: 'gate', needsDist: true, about: 'нет прокрутки на ширине макета' },
  { id: 'stretch', tool: 'check-stretch', kind: 'gate', needsDist: true, about: 'блоки у края тянутся вместе с окном' },
  { id: 'coverage-map', tool: 'page-map', kind: 'gate', needsDist: false, about: 'карта страниц: каждая секция покрыта' },
  { id: 'weight', tool: 'check-weight', kind: 'gate', needsDist: true, about: 'вес картинок и страниц в бюджете' },
  { id: 'issues', tool: 'issues', kind: 'gate', needsDist: false, about: 'реестр ошибок сходится' },
  { id: 'crops', tool: 'check-crops', kind: 'gate', needsDist: true, about: 'фон вырезан как в макете' },
  { id: 'images', tool: 'check-images', kind: 'gate', needsDist: true, about: 'картинки не растянуты' },
  // Интеграционные: дополнения не ломают основу. Сборка base отдельная —
  // поэтому шаг собирает её сам и проверяет.
  { id: 'base-parity', tool: 'check-base-parity', kind: 'gate', needsDist: true, about: 'основа не изменилась от дополнений' },
  {
    id: 'enhancement-off',
    tool: 'check-enhancement-off',
    kind: 'gate',
    needsDist: true,
    about: 'base-сборка без дополнений',
    // base-сборка идёт в dist-base: обычный dist не пересобирается, и
    // возвращать окружение не нужно.
    prepare: () => runSync('npm', ['run', 'build:base']),
  },
];

// Все секции, которые уже в конвейере: у них есть замер рядом со спекой.
// Так «проверить всё» не зависит от того, собрана ли страница целиком.
/**
 * Объём приёмки — то, что обещано сдать, а не то, что уже измерено.
 *
 * Раньше секция попадала в прогон по наличию `gate.json`: результат прошлого
 * замера сам решал, входит ли секция в проверку. Удали результат — секция
 * тихо выпадала из объёма. Теперь список лежит в `project.json.acceptance`.
 */
function acceptedUnits() {
  const projectPath = join(root, 'design/figma/project.json');
  const list = existsSync(projectPath)
    ? JSON.parse(readFileSync(projectPath, 'utf8')).acceptance
    : null;
  if (!Array.isArray(list)) return null;
  // Ничего не фильтруем: обещанная, но несуществующая секция обязана упасть
  // на замере, а не тихо выпасть из объёма.
  return list;
}

/**
 * Профиль проверок.
 *
 * Набор шагов берётся из контрактов (`tools/checks.json`, поле `mandatoryFor`),
 * а не из списка в коде: добавили проверку — она попадает в профиль там же,
 * где описана. Неизвестный профиль — ошибка конфигурации, а не пустой прогон.
 */
/**
 * Предел шага из контракта проверки. Один файл — один источник правды:
 * таймаут описан там же, где слой и входы.
 */
function contractTimeout(id) {
  const path = join(root, 'tools/checks.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')).checks?.[id]?.timeoutMs ?? null;
  } catch {
    return null;
  }
}

/**
 * Кэш результатов проверок.
 *
 * Ключ — содержимое входов из контракта плюс отпечаток самого инструмента и
 * окружения. Не «тот же код»: если изменился эталон, кроп или браузер, кэш
 * недействителен. Красный результат не кэшируется никогда — иначе дефект
 * переживёт своё исправление.
 *
 * Чего не кэшируем: сборку, замер, снимки и интеграционные ворота — они
 * пишут dist и артефакты, их «результат» неотделим от побочного действия.
 */
const CACHE_EXCLUDED = new Set(['build', 'measure', 'shot', 'visual', 'base-parity', 'enhancement-off', 'contracts']);
const cacheDir = join(root, 'reports/cache');

/** Отпечаток файла или дерева по маске: содержимое, не время. */
function hashInputs(patterns) {
  const hash = createHash('sha256');
  let files = 0;
  for (const pattern of patterns) {
    const star = pattern.indexOf('*');
    if (star < 0) {
      const path = join(root, pattern);
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      hash.update(pattern).update(readFileSync(path));
      files += 1;
      continue;
    }
    const base = join(root, pattern.slice(0, star).replace(/\/$/, ''));
    if (!existsSync(base)) continue;
    const suffix = pattern.slice(star).replace(/^\*\*?\/?/, '');
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (!suffix || entry.name.endsWith(suffix) || path.endsWith(suffix)) {
          hash.update(relative(root, path)).update(readFileSync(path));
          files += 1;
        }
      }
    };
    walk(base);
  }
  return files ? hash.digest('hex').slice(0, 16) : null;
}

/** Ключ проверки: входы + сам инструмент + окружение. */
function cacheKey(id) {
  const path = join(root, 'tools/checks.json');
  if (!existsSync(path)) return null;
  const check = JSON.parse(readFileSync(path, 'utf8')).checks?.[id];
  if (!check) return null;
  if (CACHE_EXCLUDED.has(id)) return null;
  const inputs = hashInputs(check.inputs ?? []);
  if (!inputs) return null;
  const toolPath = join(root, 'tools', `${id}.mjs`);
  const tool = existsSync(toolPath)
    ? createHash('sha256').update(readFileSync(toolPath)).digest('hex').slice(0, 8)
    : 'bin';
  // Окружение в ключе: обновился браузер — прежний результат про другой
  // браузер, и переиспользовать его нельзя.
  let browser = '';
  if ((check.resources ?? []).includes('browser')) {
    try {
      browser = JSON.parse(readFileSync(join(root, 'node_modules/playwright/package.json'), 'utf8')).version;
    } catch {
      browser = 'unknown';
    }
  }
  const env = `${process.version}|${browser}|${check.timeoutMs}|${check.retryPolicy?.attempts ?? 0}`;
  return createHash('sha256').update(`${inputs}|${tool}|${env}`).digest('hex').slice(0, 16);
}

function cacheGet(id, key) {
  const path = join(cacheDir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8'));
    return entry.key === key && entry.status === 'PASS' ? entry : null;
  } catch {
    return null;
  }
}

function cacheSet(id, key, result) {
  if (result.status !== 'PASS') return;
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, `${id}.json`),
    JSON.stringify({ key, status: result.status, ms: result.ms, about: result.about, at: new Date().toISOString() }, null, 1) + '\n',
  );
}

/**
 * Зависимости проверки из контракта. Пустой список — шаг ни от кого не зависит.
 */
function contractDeps(id) {
  const path = join(root, 'tools/checks.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')).checks?.[id]?.dependsOn ?? [];
  } catch {
    return null;
  }
}

/**
 * Топологическая сортировка шагов по dependsOn из контрактов.
 *
 * Если зависимость не входит в профиль, она не учитывается: профиль уже
 * выбрал, что запускать. Порядок внутри равных сохраняется (стабильно).
 */
function orderByDeps(steps) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const result = [];
  const state = new Map();
  const visit = (step) => {
    const mark = state.get(step.id);
    if (mark === 'done') return;
    if (mark === 'open') return; // цикл поймает check-contracts, здесь не падаем
    state.set(step.id, 'open');
    for (const dep of contractDeps(step.id) ?? []) {
      const next = byId.get(dep);
      if (next) visit(next);
    }
    state.set(step.id, 'done');
    result.push(step);
  };
  for (const step of steps) visit(step);
  return result;
}

function stepsForProfile(profile) {
  const path = join(root, 'tools/checks.json');
  if (!existsSync(path)) {
    console.error('нет tools/checks.json — профили не из чего собрать');
    return null;
  }
  const contracts = JSON.parse(readFileSync(path, 'utf8'));
  if (!contracts.profiles?.[profile]) {
    console.error(`профиля «${profile}» нет. Есть: ${Object.keys(contracts.profiles ?? {}).join(', ')}`);
    return null;
  }
  const wanted = new Set();
  for (const [id, check] of Object.entries(contracts.checks ?? {})) {
    if ((check.mandatoryFor ?? []).includes(profile)) wanted.add(id);
  }
  if (!wanted.size) {
    console.error(`профиль «${profile}» не включает ни одной проверки — это ошибка контрактов`);
    return null;
  }
  return wanted;
}

/**
 * Набор регрессии: быстрый прогон по секциям разного типа.
 *
 * Не заменяет полный: `releaseEligible` по нему не выдаётся. Задача — за
 * минуту понять, что ничего не поехало, а не принять выпуск.
 */
function regressionUnits() {
  const path = join(root, 'design/figma/regression.json');
  if (!existsSync(path)) {
    console.error('нет design/figma/regression.json — набор регрессии не задан');
    return null;
  }
  const list = JSON.parse(readFileSync(path, 'utf8')).units ?? [];
  if (!list.length) {
    console.error('набор регрессии пуст');
    return null;
  }
  // Секция вне приёмки — ошибка в наборе, а не повод её молча пропустить.
  const accepted = new Set(acceptedUnits() ?? []);
  const unknown = list.filter((unit) => accepted.size && !accepted.has(unit));
  if (unknown.length) {
    console.error(`в наборе регрессии секции вне приёмки: ${unknown.join(', ')}`);
    return null;
  }
  return list;
}

function builtUnits() {
  const pagesRoot = join(root, 'design/figma/pages');
  // Объём берётся из реестра; скан по gate.json остаётся запасным путём для
  // проектов, где реестра ещё нет.
  const accepted = acceptedUnits();
  if (accepted) return accepted.sort();

  // Новый проект: секций ещё не экспортировали. Это не поломка конвейера —
  // проверять нечего, и об этом надо сказать, а не падать с ENOENT.
  if (!existsSync(pagesRoot)) return [];

  const units = [];
  for (const page of readdirSync(pagesRoot)) {
    const pageDir = join(pagesRoot, page);
    if (!statSync(pageDir).isDirectory()) continue;
    for (const section of readdirSync(pageDir)) {
      // Объём — всё, что экспортировано: `spec.json` появляется с первым
      // экспортом. `gate.json` — запасной признак для старых папок.
      // Без этого новый проект не проверялся никогда: реестр `acceptance`
      // пишется руками, а скан искал только gate.json.
      const dir = join(pageDir, section);
      if (existsSync(join(dir, 'spec.json')) || existsSync(join(dir, 'gate.json'))) {
        units.push(`${page}/${section}`);
      }
    }
  }
  return units.sort();
}

// Адрес страницы берётся из project.json: секция может жить не на «/».
const routes = JSON.parse(readFileSync(join(process.cwd(), 'design/figma/project.json'), 'utf8')).routes ?? {};
// Отдельная секция может открываться не по адресу страницы: экран результата
// живёт за ?result=1. Такие адреса лежат в project.json.unitUrls.
const unitUrls = JSON.parse(readFileSync(join(process.cwd(), 'design/figma/project.json'), 'utf8')).unitUrls ?? {};
const unitUrl = (unit) => unitUrls[unit] ?? routes[unit.split('/')[0]] ?? '/';

// Общие секции (шапка, подвал) стоят на каждой странице своим инстансом:
// в спеке страницы id свой, в компоненте — id канонической секции. Список
// лежит в project.json.shared, чтобы это было данными, а не знанием в коде.
const sharedNodes = JSON.parse(readFileSync(join(process.cwd(), 'design/figma/project.json'), 'utf8')).shared ?? {};
// Доп. аргументы замера для конкретной секции (например, --root и --by-suffix,
// когда узел спеки не совпадает с корнем компонента). Данные, не код.
const unitArgs = JSON.parse(readFileSync(join(process.cwd(), 'design/figma/project.json'), 'utf8')).unitArgs ?? {};
const extraArgs = (unit) => unitArgs[unit] ?? [];
// Явные аргументы юнита заменяют общие: иначе в списке окажутся два --root,
// и замер возьмёт первый — от общего компонента.
const argsFor = (unit) => (unitArgs[unit] ? extraArgs(unit) : sharedArgs(unit));
const sharedArgs = (unit) => {
  const node = sharedNodes[unit.split('/').pop()];
  return node ? ['--root', node, '--by-suffix'] : [];
};

// id шага — это ещё и имя файла `results/<id>.json`. Без страницы пять шапок
// писали в один файл и затирали друг друга; слеш в имени дал бы подпапку,
// поэтому заменяем его дефисом — так же, как имена снимков.
const stepId = (prefix, unit) => `${prefix}:${unit.replace('/', '-')}`;

/**
 * Замер всех секций одним запуском.
 *
 * Раньше на каждую секцию поднимался свой сервер и Chromium — самая дорогая
 * часть прогона. Теперь задания идут списком, браузер один, страница
 * загружается один раз на адрес.
 */
/** Синхронный запуск для подготовки окружения шага (сборка base и обратно). */
const runSync = (command, args) =>
  spawnSync(command, args, { cwd: root, stdio: 'ignore', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } });

/**
 * id, по которому секцию искать в DOM.
 *
 * У общих секций (шапка, подвал) в спеке страницы свой id инстанса, а в
 * разметке — id канонического компонента. Тот же выбор, что делает замер:
 * сначала `unitArgs`, потом `shared`, иначе id из спеки.
 */
function domRootOf(unit) {
  const explicit = (unitArgs[unit] ?? []).indexOf('--root');
  if (explicit !== -1) return unitArgs[unit][explicit + 1];
  return sharedNodes[unit.split('/').pop()] ?? rootNodeOf(unit);
}

/** id корня секции из её спеки — по нему снимок находит элемент. */
function rootNodeOf(unit) {
  const path = join(root, 'design/figma/pages', unit, 'spec.json');
  if (!existsSync(path)) return unit;
  try {
    return JSON.parse(readFileSync(path, 'utf8')).section?.id ?? unit;
  } catch {
    return unit;
  }
}

const measureBatchStep = (units) => {
  const jobs = units.map((unit) => {
    const root = argsFor(unit);
    const rootIndex = root.indexOf('--root');
    return {
      spec: `design/figma/pages/${unit}/spec.json`,
      url: unitUrl(unit),
      ...(rootIndex >= 0 ? { root: root[rootIndex + 1] } : {}),
      ...(root.includes('--by-suffix') ? { bySuffix: true } : {}),
    };
  });
  const file = join(runsDir, 'measure-jobs.json');
  return {
    id: 'measure',
    tool: 'measure',
    args: ['--batch', file],
    prepare: () => {
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(file, JSON.stringify(jobs, null, 1) + '\n');
    },
    kind: 'gate',
    needsDist: true,
    about: `геометрия ${units.length} секций одним запуском`,
  };
};

const unitSteps = (unit) => [
  {
    id: 'measure',
    tool: 'measure',
    args: [`design/figma/pages/${unit}/spec.json`, '--url', unitUrl(unit), ...argsFor(unit)],
    kind: 'gate',
    needsDist: true,
    about: 'геометрия секции',
  },
  // Снимок нужен до сравнения: compare не снимает страницу сам.
  {
    id: 'shot',
    tool: 'shot',
    // Корень секции ищется по id из спеки: класс угадывать не нужно, а id
    // не меняется при переименовании разметки. Раньше селектор собирался из
    // имени секции, и `.booking-formats` не находился — класс `.bformats`.
    args: ['--node', rootNodeOf(unit), `.screens/${unit.replace('/', '-')}.png`, '1440', '--url', unitUrl(unit)],
    kind: 'signal',
    needsDist: true,
    about: 'снимок секции',
  },
  {
    id: 'visual',
    tool: 'compare',
    args: [`design/figma/pages/${unit}/crop.png`, `.screens/${unit.replace('/', '-')}.png`],
    kind: 'signal',
    needsDist: true,
    about: 'пиксель — диагностика, не приёмка',
  },
];

// --- Исполнение ------------------------------------------------------------

function runStep(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    const [command, args] = step.bin
      ? [join(root, step.bin), step.args ?? []]
      : [process.execPath, [join(root, 'tools', `${step.tool}.mjs`), ...(step.args ?? [])]];

    // Своя группа процессов: у шага бывают дети (Chromium у снимка и замера,
    // astro у сборки). Убийство только родителя оставляло их сиротами —
    // следующий шаг открывал страницу на живом браузере и занятом порту.
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      detached: true,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    // Пульс: снаружи долгая проверка и зависание выглядят одинаково, пока
    // шаг молчит. Раз в 10 с печатаем, сколько он уже идёт и что успел
    // сказать последней строкой.
    let heartbeatShown = false;
    const heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - started) / 1000);
      const last = (stderr || stdout).trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
      // Ведущий перевод строки закрывает недописанную строку шага, иначе
      // пульс приклеивается к её началу.
      process.stdout.write(`\n  ${step.id.padEnd(34)} … ${seconds} с${last ? ` · ${last.slice(0, 90)}` : ''}\n`);
      heartbeatShown = true;
    }, 10000);

    // Зависший инструмент не должен останавливать весь прогон: у шага есть
    // предел, после которого он снимается и считается непройденным по среде.
    // Предел берётся из контракта проверки, если он там задан.
    const limit = step.timeoutMs ?? contractTimeout(step.id) ?? 300000;
    /** Снять шаг вместе со всеми его детьми. */
    const killTree = () => {
      try {
        // Отрицательный pid — вся группа, а не только прямой ребёнок.
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // процесс уже умер — это нормально
        }
      }
    };

    const timer = setTimeout(() => {
      clearInterval(heartbeat);
      killTree();
      resolve({
        ...step,
        status: 'ERROR',
        ms: Date.now() - started,
        heartbeat: heartbeatShown,
        note: `превышен таймаут ${Math.round(limit / 1000)} с — шаг снят`,
      });
    }, limit);

    child.on('error', (error) => {
      clearInterval(heartbeat);
      resolve({ ...step, status: 'ERROR', ms: Date.now() - started, heartbeat: heartbeatShown, note: String(error.message).slice(0, 200) });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      // 0 — выполнено и чисто; 1 — выполнено и есть дефект; 3 — выполнено
      // частично (часть источников не прочитана); 2 и прочее — не смогло.
      const status = code === 0 ? 'PASS' : code === 1 ? 'FAIL' : code === 3 ? 'INCOMPLETE' : 'ERROR';
      const note = (stderr || stdout).trim().split('\n').slice(-1)[0] ?? '';
      resolve({ ...step, status, exitCode: code, ms: Date.now() - started, heartbeat: heartbeatShown, note: note.slice(0, 200) });
    });
  });
}

/**
 * Политика: что считается итогом.
 *
 * Порядок важен и не симметричен:
 *   ERROR      — инструмент не смог выполниться, мы не знаем ничего;
 *   FAIL       — проверка выполнена и нашла дефект. Это определённость,
 *                поэтому она сильнее INCOMPLETE: сломанная сборка — не
 *                «неизвестно», а точно плохо;
 *   INCOMPLETE — ничего не сломалось, но часть не измерена (нет спеки,
 *                пропущено из-за упавшей сборки);
 *   PASS       — всё измерено и чисто.
 *
 * Сигналы (пиксель) в вердикт не входят: это диагностика, а не приёмка.
 */
function evaluate(results, mandatory = null) {
  const gates = results.filter((r) => r.kind === 'gate');
  if (gates.some((r) => r.status === 'ERROR')) return { status: 'ERROR', exitCode: 2 };
  if (gates.some((r) => r.status === 'FAIL')) return { status: 'FAIL', exitCode: 1 };
  if (gates.some((r) => r.status === 'INCOMPLETE')) return { status: 'INCOMPLETE', exitCode: 2 };
  // BLOCKED сам по себе вердикт не портит: причина уже названа тем шагом, от
  // которого он зависит. Но если заблокирована обязательная проверка, её
  // результат неизвестен — это INCOMPLETE, а не зелёный.
  const blocked = gates.filter((r) => r.status === 'BLOCKED');
  if (blocked.length && (!mandatory || blocked.some((r) => mandatory.has(r.id)))) {
    return { status: 'INCOMPLETE', exitCode: 2 };
  }
  return { status: 'PASS', exitCode: 0 };
}

function runId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${process.pid}`;
}

/** Одинаковые id шагов — это коллизия: их файлы результатов перезапишутся. */
function assertUniqueIds(steps) {
  const seen = new Set();
  const dupes = new Set();
  for (const step of steps) {
    if (seen.has(step.id)) dupes.add(step.id);
    seen.add(step.id);
  }
  if (dupes.size) {
    throw new Error(`коллизия id шагов: ${[...dupes].join(', ')}`);
  }
}

async function commandCheck(unit, json, all, set = null, resume = null, profileName = null, useCache = false) {
  // Профиль задаёт и объём: приёмка — всегда все секции, регрессия — набор,
  // локальная проверка — одна единица (или всё, если её не назвали).
  const allUnits = profileName === 'accept-stage1' || profileName === 'accept-stage2' || all;
  const units = profileName === 'regression' || set === 'regression'
    ? regressionUnits()
    : allUnits
      ? builtUnits()
      : unit
        ? [unit]
        : profileName === 'sources-live'
          ? []
          : builtUnits();
  if (set === 'regression' && units === null) return 2;

  // Набор шагов — из контрактов: у каждой проверки есть mandatoryFor, и
  // профиль решает, обязательна ли она. Зашитых списков больше нет.
  const profile = profileName ?? (all ? 'accept-stage1' : set === 'regression' ? 'regression' : 'local');
  const wanted = stepsForProfile(profile);
  if (wanted === null) return 2;
  const needsSections = wanted.has('measure');

  // Страницы сайта могут быть ещё не собраны (новый проект: в dist только
  // служебная). Тогда ворота, которым нужна страница, не «красные» — они
  // просто не могут работать. Один честный ответ вместо восьми красных.
  const projectFile = join(root, 'design/figma/project.json');
  const projectData = existsSync(projectFile) ? JSON.parse(readFileSync(projectFile, 'utf8')) : {};
  const routes = Object.values(projectData.routes ?? {});
  const pagesBuilt = routes.some((route) => {
    const file = route === '/' ? 'index.html' : route.replace(/^\//, '').split('?')[0];
    return existsSync(join(process.cwd(), 'dist', file));
  });
  if (units.length && !pagesBuilt) {
    console.log('страниц сайта в dist нет — собрана только служебная');
    console.log('ворота, которым нужна страница, не запускались: states, interactive, motion, layout, stretch, images');
    return 3;
  }

  // Новый проект: секций ещё не экспортировали, страниц сайта нет. Гонять
  // ворота не по чему, но и зелёным это называть нельзя — проверено ноль.
  if (!units.length && needsSections) {
    console.log('секций в объёме нет — проверять нечего');
    console.log('сначала: npm run discover -- --write → npm run intake → npm run ds:tokens → npm run structure → npm run build');
    return 3;
  }

  const local = profile === 'local' || profile === 'regression';
  // sources-live — единственный профиль, которому нужен живой мост: он и есть
  // сверка с текущим состоянием Figma. Остальные работают по снимку.
  const globalSteps = GLOBAL_STEPS.filter((step) => wanted.has(step.id)).map((step) =>
    step.id === 'sources' && profile === 'sources-live' ? { ...step, args: [] } : step,
  );
  const steps = [
    ...globalSteps,
    ...(needsSections ? (local ? unitSteps(units[0]) : [measureBatchStep(units)]) : []),
  ];
  assertUniqueIds(steps);
  // Порядок — из зависимостей контракта, а не из порядка в массиве: шаг не
  // должен проверять «прошла ли зависимость» до того, как она запускалась.
  const ordered = orderByDeps(steps);
  // Возобновление: берём результаты прошлого прогона, но только если дерево
  // то же самое. Иначе «пропущенные» шаги относятся к другому коду.
  let resumeFrom = null;
  if (resume) {
    const prevDir = join(runsDir, resume);
    const prevPath = join(prevDir, 'verdict.json');
    if (!existsSync(prevPath)) {
      console.error(`прогона ${resume} нет — возобновлять нечего`);
      return 2;
    }
    const prev = JSON.parse(readFileSync(prevPath, 'utf8'));
    const now = gitState();
    if (!prev.contentHash || !now.contentHash || prev.contentHash !== now.contentHash) {
      console.error('содержимое изменилось с прошлого прогона — возобновление отменено');
      console.error(`  было ${prev.contentHash ?? 'нет'} · сейчас ${now.contentHash ?? 'нет'}`);
      return 2;
    }
    resumeFrom = new Map();
    for (const file of readdirSync(join(prevDir, 'results'))) {
      if (!file.endsWith('.json')) continue;
      const result = JSON.parse(readFileSync(join(prevDir, 'results', file), 'utf8'));
      if (result.status === 'PASS') resumeFrom.set(result.id, result);
    }
    if (!json) console.log(`возобновление прогона ${resume}: зелёных шагов ${resumeFrom.size}`);
  }

  const id = runId();
  const dir = join(runsDir, id);
  mkdirSync(join(dir, 'results'), { recursive: true });

  // Провенанс снимается ДО шагов: замер во время прогона переписывает gate.json,
  // и снимок после него говорил бы о другом дереве.
  const gitBefore = gitState();

  const idWidth = Math.max(...steps.map((step) => step.id.length));
  const events = [];
  const results = [];
  const startedAt = new Date().toISOString();

  for (const step of ordered) {
    // Зависимости — из контрактов. Если зависимость не прошла, шаг не
    // пытается работать: BLOCKED с именем причины, а не ERROR и не тишина.
    // Раньше это было частным случаем сборки; теперь работает для любой
    // цепочки (снимок → сравнение, сборка → все страничные ворота).
    const broken = (contractDeps(step.id) ?? [])
      .map((dep) => results.find((r) => r.id === dep))
      .filter((dep) => dep && dep.status !== 'PASS');
    if (broken.length) {
      const why = broken.map((dep) => `${dep.id}: ${dep.status}`).join(', ');
      results.push({ ...step, status: 'BLOCKED', ms: 0, blockedBy: broken.map((d) => d.id), note: why });
      events.push({ at: new Date().toISOString(), step: step.id, status: 'BLOCKED', blockedBy: broken.map((d) => d.id) });
      if (!json) {
        process.stdout.write(`  ${step.id.padEnd(idWidth)} заблокировано  ${why}\n`);
      }
      writeFileSync(join(dir, 'results', `${step.id}.json`), JSON.stringify({ ...step, status: 'BLOCKED', ms: 0, blockedBy: broken.map((d) => d.id), note: why }, null, 2) + '\n');
      continue;
    }

    const resumed = resumeFrom?.get(step.id);
    if (resumed) {
      results.push({ ...resumed, resumed: true, ms: 0 });
      events.push({ at: new Date().toISOString(), step: step.id, status: 'PASS', ms: 0, resumed: true });
      if (!json) process.stdout.write(`  ${step.id.padEnd(idWidth)} ок  (возобновлён)  ${step.about}\n`);
      writeFileSync(join(dir, 'results', `${step.id}.json`), JSON.stringify({ ...resumed, resumed: true }, null, 2) + '\n');
      continue;
    }

    // Кэш: результат с теми же входами и тем же инструментом. Только PASS —
    // красный результат не кэшируется, иначе дефект переживёт исправление.
    if (useCache) {
      const key = cacheKey(step.id);
      const hit = key ? cacheGet(step.id, key) : null;
      if (hit) {
        results.push({ ...step, status: 'PASS', ms: 0, cached: true, note: hit.about });
        events.push({ at: new Date().toISOString(), step: step.id, status: 'PASS', ms: 0, cached: true });
        if (!json) process.stdout.write(`  ${step.id.padEnd(idWidth)} ок  (кэш)  ${step.about}\n`);
        writeFileSync(join(dir, 'results', `${step.id}.json`), JSON.stringify({ ...step, status: 'PASS', ms: 0, cached: true, note: hit.about }, null, 2) + '\n');
        continue;
      }
    }

    // Шаг может готовить входные файлы (пакетный замер пишет список заданий)
    // и возвращать окружение обратно (base-сборка вместо обычной).
    step.prepare?.();

    // Строку шага не печатаем заранее: если шаг длинный, её место займёт
    // пульс, и получилась бы задвоенная строка.
    const result = await runStep(step);
    step.restore?.();
    if (useCache) {
      const key = cacheKey(step.id);
      if (key) cacheSet(step.id, key, result);
    }
    results.push(result);
    events.push({ at: new Date().toISOString(), step: step.id, status: result.status, ms: result.ms });
    if (!json) {
      const mark = result.status === 'PASS' ? 'ок' : result.status === 'FAIL' ? 'КРАСНЫЙ' : result.status;
      // После пульса строка шага уже закрыта — начинаем результат с новой.
      const prefix = result.heartbeat ? '\n' : '';
      process.stdout.write(`${prefix}  ${step.id.padEnd(idWidth)} ${mark}  ${String(result.ms).padStart(6)} мс  ${result.about}\n`);
    }
    writeFileSync(join(dir, 'results', `${step.id}.json`), JSON.stringify(result, null, 2) + '\n');
  }

  const verdict = evaluate(results, wanted);
  const provenanceInfo = provenance();
  // Дерево поменялось во время прогона — вердикт не относится ни к одному
  // состоянию целиком.
  const gitAfter = gitState();
  const stable = gitBefore.contentHash !== null && gitBefore.contentHash === gitAfter.contentHash;
  // full — полный объём (--all); unit — одна секция. Выпуск только по полному.
  // «full» остаётся признаком выпускной приёмки: только она даёт releaseEligible.
  const mode = profile === 'accept-stage1' ? 'full' : profile;
  const report = {
    schemaVersion: 1,
    runId: id,
    unit: all ? null : unit ?? null,
    units,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: verdict.status,
    exitCode: verdict.exitCode,
    mode,
    commit: gitBefore.commit,
    dirty: gitBefore.dirty,
    dirtyFiles: gitBefore.dirtyFiles,
    contentHash: gitBefore.contentHash,
    changedDuringRun: !stable,
    hashes: provenanceInfo.hashes,
    files: provenanceInfo.files,
    coverage: coverage(units),
    // Рабочий прогон может быть зелёным, но доказательством готовности
    // коммита он не становится: правки не зафиксированы.
    releaseEligible:
      verdict.status === 'PASS' && mode === 'full' && gitBefore.dirty === false && Boolean(gitBefore.commit) && stable,
    steps: results.map((r) => ({
      id: r.id,
      status: r.status,
      ms: r.ms,
      kind: r.kind,
      ...(r.resumed ? { resumed: true } : {}),
      ...(r.cached ? { cached: true } : {}),
    })),
  };

  writeFileSync(join(dir, 'verdict.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(runsDir, 'latest'), id + '\n');

  if (json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    const failed = results.filter((r) => r.kind === 'gate' && r.status !== 'PASS');
    if (all) {
      // Покрытие печатается явно: «19 из 46» нельзя прочитать как «весь файл».
      const cov = coverage(units);
      process.stdout.write(
        `\nсекций проверено: ${cov ? cov.text : units.length}`,
      );
    }
    process.stdout.write(
      `\nвердикт: ${verdict.status}${verdict.status === 'PASS' && !report.releaseEligible ? ` (рабочий: ${notEligibleReason(report)})` : ''}`,
    );
    // Заблокированные — не красные: их причина уже названа тем шагом, от
    // которого они зависят. Смешивать их в один список значит врать о числе.
    const red = failed.filter((r) => r.status !== 'BLOCKED');
    const blocked = results.filter((r) => r.status === 'BLOCKED');
    if (red.length) process.stdout.write(` · красных ${red.length}: ${red.map((r) => r.id).join(', ')}`);
    if (blocked.length) process.stdout.write(` · заблокировано ${blocked.length}: ${blocked.map((r) => r.id).join(', ')}`);
    process.stdout.write(`\nпрогон: reports/runs/${id}/\n`);
  }

  return verdict.exitCode;
}

function notEligibleReason(report) {
  if (report.mode === 'regression') return 'проверен набор регрессии, для выпуска нужен --profile accept-stage1';
  if (report.mode === 'local') return 'проверена одна единица, для выпуска нужен --profile accept-stage1';
  if (report.mode === 'sources-live') return 'сверены источники, основа не проверялась';
  if (report.mode === 'accept-stage2') return 'проверены дополнения, выпуск даёт accept-stage1';
  if (report.mode !== 'full') return `профиль ${report.mode}, для выпуска нужен --profile accept-stage1`;
  if (report.dirty) return 'есть незакоммиченные правки';
  if (report.changedDuringRun) return 'файлы менялись во время прогона';
  return 'нет коммита';
}

/**
 * Можно ли пушить: последний прогон зелёный, полный, на чистом дереве, и
 * отпечаток содержимого совпадает с текущим. Код 0 — можно, 1 — нельзя
 * (причина в stdout). Вызывается хуком post-commit.
 */
/**
 * Пиксельная сверка всех секций одним проходом.
 *
 * Сорок семь отдельных запусков Chromium ради сорока семи кадров — та же
 * работа, что уже сделана для замера: один браузер, один сервер, страница
 * грузится один раз на адрес. Сравнение — чистый JS над PNG.
 */
function commandPixels(unit) {
  const units = unit ? [unit] : acceptedUnits() ?? [];
  if (!units.length) {
    console.error('нечего снимать: в project.json нет списка acceptance');
    return 2;
  }
  if (!existsSync(join(root, 'dist'))) {
    console.error('нет dist/ — сначала npm run build');
    return 2;
  }

  const jobs = [];
  const noCrop = [];
  for (const item of units) {
    if (!existsSync(join(root, 'design/figma/pages', item, 'crop.png'))) {
      noCrop.push(item);
      continue;
    }
    jobs.push({ node: domRootOf(item), out: `.screens/${item.replace('/', '-')}.png`, url: unitUrl(item) });
  }
  if (noCrop.length) console.log(`без кропа пропущено: ${noCrop.length} — ${noCrop.slice(0, 3).join(', ')}`);

  const jobsFile = join(runsDir, 'pixels.json');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(jobsFile, JSON.stringify(jobs, null, 1) + '\n');

  const started = Date.now();
  const shot = spawnSync(process.execPath, [join(root, 'tools/shot.mjs'), '--batch', jobsFile], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
  });
  if (shot.status !== 0) {
    console.error(`съёмка не прошла (код ${shot.status}) — пиксель не обновлён`);
    return shot.status === 1 ? 1 : 2;
  }

  const means = [];
  const failed = [];
  for (const item of units) {
    const crop = join(root, 'design/figma/pages', item, 'crop.png');
    const shotPath = join(root, '.screens', `${item.replace('/', '-')}.png`);
    if (!existsSync(crop) || !existsSync(shotPath)) {
      failed.push(item);
      continue;
    }
    // compare пишет pixel.json рядом с кропом и печатает «средняя разница: N».
    const run = spawnSync(process.execPath, [join(root, 'tools/compare.mjs'), crop, shotPath], {
      cwd: root,
      encoding: 'utf8',
    });
    const match = /средняя разница: ([\d.]+)/.exec(run.stdout ?? '');
    if (run.status !== 0 || !match) {
      failed.push(item);
      continue;
    }
    means.push({ unit: item, mean: Number(match[1]) });
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (!means.length) {
    console.error(`пиксель не посчитан ни для одной секции (${secs} с)`);
    return 1;
  }
  const sorted = [...means].sort((a, b) => b.mean - a.mean);
  const values = means.map((m) => m.mean).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  const threshold = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8')).gates?.pixelDelta ?? 16;

  console.log(`снято ${means.length} секций за ${secs} с · медиана ${median.toFixed(2)}`);
  console.log('худшие пять:');
  for (const item of sorted.slice(0, 5)) console.log(`  ${item.unit.padEnd(28)} ${item.mean.toFixed(2)}`);
  const above = sorted.filter((m) => m.mean > threshold);
  if (above.length) console.log(`выше порога ${threshold}: ${above.length}`);
  if (failed.length) console.log(`не посчитано: ${failed.length} — ${failed.slice(0, 3).join(', ')}`);
  return failed.length ? 1 : 0;
}

function commandPushOk() {
  const report = latestRun();
  if (!report) {
    process.stdout.write('прогонов не было\n');
    return 1;
  }
  if (!report.releaseEligible) {
    process.stdout.write(
      `последний прогон ${report.runId}: ${report.status}` +
        (report.status === 'PASS' ? `, ${notEligibleReason(report)}` : '') +
        '\n',
    );
    return 1;
  }
  const now = gitState();
  if (now.contentHash !== report.contentHash) {
    process.stdout.write(`последний зелёный прогон ${report.runId} относится к другому содержимому — нужен новый check --all\n`);
    return 1;
  }
  process.stdout.write(`прогон ${report.runId}: PASS, полный, содержимое совпадает\n`);
  return 0;
}

function latestRun() {
  const marker = join(runsDir, 'latest');
  if (!existsSync(marker)) return null;
  const id = readFileSync(marker, 'utf8').trim();
  const file = join(runsDir, id, 'verdict.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

function commandStatus(json) {
  const report = latestRun();
  if (!report) {
    process.stderr.write('прогонов не было: node tools/conveyor.mjs check\n');
    return 2;
  }
  if (json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    process.stdout.write(`прогон ${report.runId} · ${report.status}${report.unit ? ` · ${report.unit}` : ''}\n`);
    const width = Math.max(...report.steps.map((step) => step.id.length));
    for (const step of report.steps) process.stdout.write(`  ${step.id.padEnd(width)} ${step.status}\n`);
  }
  return 0;
}

function commandPlan(unit, all, json = false) {
  const units = all ? builtUnits() : unit ? [unit] : [];
  const steps = [...GLOBAL_STEPS, ...units.flatMap((item) => (all ? [measureStep(item)] : unitSteps(item)))];
  assertUniqueIds(steps);
  // Порядок — из зависимостей контракта, а не из порядка в массиве: шаг не
  // должен проверять «прошла ли зависимость» до того, как она запускалась.
  const ordered = orderByDeps(steps);
  // --json — машинный список шагов: по нему ворота contracts сверяют состав
  // конвейера с контрактами, не разбирая исходник регуляркой.
  if (json) {
    process.stdout.write(JSON.stringify({ steps: ordered.map((step) => ({ id: step.id, kind: step.kind })) }, null, 1) + '\n');
    return 0;
  }
  process.stdout.write(`план${unit ? ` для ${unit}` : all ? ` для ${units.length} секций` : ''} — ${steps.length} шагов, последовательно:\n`);
  const idWidth = Math.max(...steps.map((step) => step.id.length));
  for (const step of ordered) {
    process.stdout.write(`  ${step.id.padEnd(idWidth)} ${step.kind.padEnd(6)} ${step.about}\n`);
  }
  process.stdout.write('\nничего не выполнено: это план\n');
  return 0;
}

// --- Вход ------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: true,
  options: {
    unit: { type: 'string' },
    all: { type: 'boolean', default: false },
    set: { type: 'string' },
    resume: { type: 'string' },
    profile: { type: 'string' },
    cache: { type: 'boolean', default: false },
    'no-cache': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const unit = values.unit ?? positionals[0] ?? null;

try {
  let code;
  if (command === 'check') code = await commandCheck(unit, values.json, values.all, values.set ?? null, values.resume ?? null, values.profile ?? null, values.cache && !values['no-cache']);
  else if (command === 'status') code = commandStatus(values.json);
  else if (command === 'plan') code = commandPlan(unit, values.all, values.json);
  else if (command === 'push-ok') code = commandPushOk();
  else if (command === 'pixels') code = commandPixels(unit);
  else {
    process.stderr.write('команды: check [--unit home/hero | --all] | pixels [--unit home/hero] | status | plan | push-ok\n');
    code = 2;
  }
  process.exitCode = code;
} catch (error) {
  process.stderr.write(`${String(error.message).slice(0, 300)}\n`);
  process.exitCode = 2;
}
