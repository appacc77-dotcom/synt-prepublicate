#!/usr/bin/env node
/**
 * Сверка трёх источников истины.
 *
 *   node tools/verify-sources.mjs [--fig <file.fig>]
 *
 *   A. Наш экспорт — то, что мы собрали через мост (design/figma/pages/**).
 *   B. Figma REST API — версия файла на сервере, без открытого приложения.
 *   C. .fig — снимок файла на диске (если передан).
 *
 * Источники независимы: мост читает открытое приложение, API — серверную
 * версию, .fig — архив. Если они расходятся, значит либо файл изменился,
 * либо выгрузка неполная. Печатает расхождения, код возврата 1 при них.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readZip } from './lib/zip.mjs';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { runFigma, FigmaError, waitForPlugin } from './figma/cli.mjs';
import { tmpdir } from 'node:os';

/** Подставляет id узла в шаблон моста и выполняет его. */
function bridgeFingerprint(nodeId) {
  const template = readFileSync(join(root, 'tools/figma/fingerprint.js'), 'utf8');
  const tmp = join(tmpdir(), `figma-fp-${process.pid}-${nodeId.replace(':', '-')}.js`);
  writeFileSync(tmp, template.split('__NODE_ID__').join(nodeId));
  const reply = runFigma(['exec-js', tmp, '--timeout', '60000'], { timeoutMs: 90000 });
  const result = reply?.result;
  if (!result?.fingerprint) return null;
  // count — число узлов в секции. Единица значит «только сам фрейм, детей нет»:
  // сверять нечего, кроп не снимается. Это не устаревание, а пустая секция.
  return { fingerprint: result.fingerprint, count: result.count ?? 1 };
}

const root = process.cwd();

// `--offline` — сверка без живого моста: экспорт фиксирован, и его
// согласованность проверяется по снимку файла. Сверка с текущим состоянием
// Figma — отдельный профиль `sources-live`.
const offline = process.argv.includes('--offline');

// Пакет из десятков вызовов не должен падать на первом: ждём живой плагин.
if (!offline && !waitForPlugin(30)) {
  console.error('плагин моста не отвечает 30 с — открой Figma и запусти плагин');
  process.exit(2);
}
const project = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8'));
const fileKey = project.source.fileKey;

const figArg = process.argv.includes('--fig') ? process.argv[process.argv.indexOf('--fig') + 1] : null;

function token() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN.trim();
  const path = project.api?.tokenFile;
  if (path && existsSync(join(root, path))) return readFileSync(join(root, path), 'utf8').trim();
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Figma ограничивает частоту: на серии запросов прилетает 429.
// Повторяем с нарастающей паузой, иначе проверка падает не по делу.
async function api(path, attempt = 1) {
  const t = token();
  if (!t) throw new Error('нет токена');
  // Висевший TCP держал шаг до контрактного таймаута: 120 с ожидания ради
  // ответа, который уже не придёт.
  const res = await fetch(`https://api.figma.com/v1${path}`, {
    headers: { 'X-Figma-Token': t },
    signal: AbortSignal.timeout(15000),
  });
  // Ответ может быть не JSON (прокси, страница ошибки) — тогда res.json()
  // падает с невнятным «Unexpected token» вместо кода ответа.
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${res.status}: ответ не JSON — ${text.slice(0, 80)}`);
  }
  if (res.status === 429 && attempt <= 4) {
    await sleep(1000 * 2 ** (attempt - 1));
    return api(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status}: ${json.err ?? 'ошибка API'}`);
  return json;
}

const rows = [];
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 * @param {boolean} [required] провал обязательной проверки роняет команду;
 *   недоступность вспомогательного источника — только запись в отчёте
 */
const check = (name, ok, detail, required = true) => {
  rows.push({ name, ok, detail, required });
};

// --- A: наш экспорт -------------------------------------------------------
const structurePath = join(root, 'design/figma/structure.json');
const structure = existsSync(structurePath) ? JSON.parse(readFileSync(structurePath, 'utf8')) : null;
const dsPath = join(root, 'design/figma/live/ds.json');
const ds = existsSync(dsPath) ? JSON.parse(readFileSync(dsPath, 'utf8')) : null;
const apiMetaPath = join(root, 'design/figma/live/api.json');
const apiMeta = existsSync(apiMetaPath) ? JSON.parse(readFileSync(apiMetaPath, 'utf8')) : null;

if (!structure) {
  console.error('нет design/figma/structure.json — сначала npm run structure');
  process.exit(2);
}

// --- B: REST API ----------------------------------------------------------
// Облачное API — опция, а не часть приёмки: оно отдаёт 429, видит только
// опубликованные стили и требует токен. Работаем с мостом; API включается
// явно: `npm run verify -- --api` или FIGMA_API=1.
const useApi = process.argv.includes('--api') || process.env.FIGMA_API === '1';
let apiFile = null;
let apiStyles = null;
let apiComponents = null;
if (!useApi) {
  check('REST API', true, 'выключено: работаем с мостом (включить: --api или FIGMA_API=1)', false);
}
try {
  if (!useApi) throw new Error('выключено');
  apiFile = await api(`/files/${fileKey}?depth=2`);
  apiStyles = await api(`/files/${fileKey}/styles`);
  apiComponents = await api(`/files/${fileKey}/components`);
} catch (error) {
  if (useApi) check('REST API доступен', false, `сверка пропущена: ${error.message}`, false);
}

if (apiFile) {
  check('REST API доступен', true, `${apiFile.name}, версия ${apiFile.version}`);

  // Страницы: проверяем в одну сторону — каждая наша страница должна быть в API.
  // Лишние страницы в API нормальны: Design system и разделители мы не ведём.
  const apiPages = (apiFile.document?.children ?? []).filter((p) => p.type === 'CANVAS');
  const apiNames = new Set(apiPages.map((p) => p.name));
  const ours = structure.pages.map((p) => p.title);
  const missing = ours.filter((n) => !apiNames.has(n));
  const extra = [...apiNames].filter((n) => !ours.includes(n));
  check(
    'наши страницы есть в API',
    missing.length === 0,
    missing.length ? `нет в API: ${missing.join(', ')}` : `${ours.length} из ${ours.length}${extra.length ? `, сверх них в API: ${extra.join(', ')}` : ''}`,
  );

  // Секции: depth=2 отдаёт фреймы с пустыми children, поэтому каждый
  // канонический фрейм запрашиваем отдельно — depth=1 даёт его детей.
  let sectionDiff = [];
  let sectionsCompared = 0;
  for (const page of structure.pages) {
    let children = [];
    await sleep(300);
    try {
      const reply = await api(`/files/${fileKey}/nodes?ids=${encodeURIComponent(page.frame.id)}&depth=1`);
      children = reply.nodes?.[page.frame.id]?.document?.children ?? [];
    } catch (error) {
      sectionDiff.push(`${page.title}: ${error.message}`);
      continue;
    }
    sectionsCompared += page.sections.length;
    const apiSet = new Set(children.map((c) => c.name));
    for (const s of page.sections) if (!apiSet.has(s.name)) sectionDiff.push(`${page.title}/${s.name}`);
  }
  check(
    'секции совпадают с API',
    sectionDiff.length === 0,
    sectionDiff.length ? `нет в API: ${sectionDiff.slice(0, 3).join(', ')}` : `сверено ${sectionsCompared}`,
  );

  // секции: имена и размеры канонических фреймов
  let compared = 0;
  let mismatched = [];
  for (const page of structure.pages) {
    const apiPage = apiPages.find((p) => p.name === page.title);
    if (!apiPage) continue;
    const apiFrame = (apiPage.children ?? []).find((f) => f.id === page.frame.id);
    if (!apiFrame) {
      mismatched.push(`${page.title}: фрейм ${page.frame.id} не найден`);
      continue;
    }
    compared++;
    const box = apiFrame.absoluteBoundingBox ?? {};
    if (Math.round(box.width) !== page.frame.w || Math.round(box.height) !== page.frame.h) {
      mismatched.push(`${page.title}: ${Math.round(box.width)}×${Math.round(box.height)} в API против ${page.frame.w}×${page.frame.h}`);
    }
  }
  check('фреймы страниц совпадают', mismatched.length === 0, mismatched.length ? mismatched.slice(0, 3).join('; ') : `сверено ${compared}`);

  // Стили и компоненты API отдаёт только опубликованные в библиотеку.
  // В этом файле они локальные, поэтому эндпоинты пусты — это не расхождение,
  // а граница API: локальные стили проверяются через мост.
  if (apiStyles && ds) {
    const apiCount = apiStyles.meta?.styles?.length ?? 0;
    if (apiCount === 0) {
      check('стили: проверка через API', true, `API отдаёт только опубликованные (0); локальных ${ds.counts.styles} — только через мост`);
    } else {
      check('стили совпадают', apiCount === ds.counts.styles, `${apiCount} в API, ${ds.counts.styles} у нас`);
    }
  }
  if (apiComponents && ds) {
    const apiCount = apiComponents.meta?.components?.length ?? 0;
    if (apiCount === 0) {
      check('компоненты: проверка через API', true, `API отдаёт только опубликованные (0); локальных ${ds.counts.components} — только через мост`);
    } else {
      check('компоненты совпадают', apiCount === ds.counts.components, `${apiCount} в API, ${ds.counts.components} у нас`);
    }
  }
}

// --- A↔мост: не устарел ли экспорт -------------------------------------
const limitArg = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : Infinity;

const sections = [];
for (const page of structure.pages) for (const s of page.sections) if (s.dir) sections.push({ page: page.title, ...s });

let checked = 0;
const stale = [];
const unread = [];
// Объём проекта: страницы, которые собираем. Устаревание чужих страниц —
// информация, а не провал ворот: их никто не обещал поддерживать в актуальном
// виде, и они не влияют на то, что сдаётся.
// Снимок файла: отпечатки всех снятых секций одним файлом (R3.1).
const snapshotPath = join(root, 'design/figma/live/snapshot.json');
const snapshotSections = existsSync(snapshotPath)
  ? JSON.parse(readFileSync(snapshotPath, 'utf8')).sections ?? null
  : null;

const scopeOf = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8')).scope ?? [];
const scope = scopeOf.map((p) => p.toLowerCase());
const inScope = (page) => !scope.length || scope.includes(page.toLowerCase());
const staleOutside = [];
for (const s of sections.slice(0, limitArg)) {
  const specPath = join(root, s.dir, 'spec.json');
  // Нет спеки или отпечатка — сверять не с чем. Для секций в объёме это
  // «не прочитано» (INCOMPLETE), а не молчаливый пропуск: иначе ворота
  // зелёные на секции, которую никто не сверял.
  if (!existsSync(specPath)) {
    if (inScope(s.page)) unread.push(`${s.page}/${s.name}: нет spec.json`);
    continue;
  }
  // Снимок файла знает, какие секции и с какими отпечатками сняты. Если
  // спека есть, а в снимке её нет — снимок отстал, и сверять по нему нельзя.
  // Ключ снимка — путь на диске: страница в нижнем регистре, как каталог.
  if (snapshotSections && !snapshotSections[`${s.page.toLowerCase()}/${s.name}`]) {
    if (inScope(s.page)) unread.push(`${s.page}/${s.name}: нет в снимке файла — npm run intake`);
    continue;
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  if (!spec.fingerprint) {
    if (inScope(s.page)) unread.push(`${s.page}/${s.name}: нет отпечатка в spec.json`);
    continue;
  }
  // Без моста сверяем не с живым файлом, а со снимком: он снят с той же
  // версии, что и экспорт, и хранит отпечатки секций.
  if (offline) {
    // Снимок хранит отпечаток файла спеки, а не поле fingerprint внутри неё:
    // сравнивать надо то же самое — иначе все секции «устарели» разом.
    const snapshotEntry = snapshotSections?.[`${s.page.toLowerCase()}/${s.name}`];
    const snapshotSpec = snapshotEntry?.spec;
    if (!snapshotSpec) {
      if (inScope(s.page)) unread.push(`${s.page}/${s.name}: в снимке нет отпечатка спеки`);
      continue;
    }
    const fileHash = createHash('sha256').update(readFileSync(specPath)).digest('hex').slice(0, 16);
    checked++;
    if (snapshotSpec !== fileHash) {
      const item = `${s.page}/${s.name}: спека менялась после снимка`;
      if (inScope(s.page)) stale.push(item);
      else staleOutside.push(item);
    }
    continue;
  }
  try {
    const fresh = bridgeFingerprint(s.id);
    if (!fresh) {
      unread.push(`${s.page}/${s.name}: пустой ответ`);
      continue;
    }
    checked++;
    if (fresh.fingerprint !== spec.fingerprint) {
      const item = `${s.page}/${s.name}: ${spec.fingerprint} → ${fresh.fingerprint}`;
      if (inScope(s.page)) stale.push(item);
      else staleOutside.push(item);
    }
  } catch (error) {
    if (error instanceof FigmaError) unread.push(`${s.page}/${s.name}: ${error.code}`);
    else unread.push(`${s.page}/${s.name}: ${String(error.message).slice(0, 40)}`);
  }
}
// Непрочитанное не доказывает актуальность: если обязательные секции не
// прочитаны, сверка не «сошлась», она не состоялась. Код 3 = INCOMPLETE.
// Информационная строка: полнота чтения. Провал здесь — не расхождение,
// а невозможность проверить, поэтому required = false и отдельный код выхода.
check(
  'экспорт прочитан полностью',
  unread.length === 0,
  unread.length ? `не прочитано ${unread.length}: ${unread.slice(0, 5).join('; ')}` : 'все секции прочитаны',
  false,
);

check(
  'экспорт соответствует мосту',
  stale.length === 0,
  stale.length
    ? `устарело ${stale.length} из ${checked}: ${stale.slice(0, 8).join('; ')}` +
      (stale.length > 8 ? `; ещё ${stale.length - 8}` : '')
    : `сверено ${checked}${unread.length ? `, не прочитано ${unread.length}` : ''}` +
      (staleOutside.length ? `, вне объёма устарело ${staleOutside.length}` : ''),
  unread.length < checked,
);

// --- A↔облако: не ушла ли вперёд версия ---------------------------------
if (apiMeta?.version) {
  const stamped = new Set();
  for (const page of structure.pages) {
    for (const s of page.sections) {
      if (!s.dir) continue;
      const specPath = join(root, s.dir, 'spec.json');
      if (!existsSync(specPath)) continue;
      const v = JSON.parse(readFileSync(specPath, 'utf8')).cloudVersion;
      if (v) stamped.add(v);
    }
  }
  const list = [...stamped];
  check(
    'экспорт снят с актуальной версии облака',
    list.length === 1 && list[0] === apiMeta.version,
    list.length === 0
      ? 'в спеках нет версии облака'
      : list.length > 1
        ? `спеки из разных версий: ${list.length}`
        : list[0] === apiMeta.version
          ? `версия ${list[0]}`
          : `спека ${list[0]} → облако ${apiMeta.version}`,
    list.length > 0,
  );
}

// --- C: .fig --------------------------------------------------------------
if (figArg) {
  if (!existsSync(figArg)) {
    check('.fig найден', false, figArg, false);
  } else {
    const zip = readZip(figArg);
    const meta = zip.json('meta.json');
    check('.fig найден', true, `${meta?.file_name ?? '?'}, выгружен ${meta?.exported_at ?? '?'}`);

    // картинки: хеш в имени = sha1 содержимого
    const figHashes = new Set();
    for (const name of zip.names) {
      if (!name.startsWith('images/') || name.endsWith('/')) continue;
      figHashes.add(createHash('sha1').update(zip.read(name)).digest('hex'));
    }
    const assetsRoot = join(root, 'design/figma/assets/img');
    let same = 0;
    let diff = 0;
    if (existsSync(assetsRoot)) {
      const { readdirSync } = await import('node:fs');
      for (const f of readdirSync(assetsRoot)) {
        const buf = readFileSync(join(assetsRoot, f));
        if (figHashes.has(createHash('sha1').update(buf).digest('hex'))) same++;
        else diff++;
      }
    }
    check('картинки совпадают с .fig', diff === 0, `${same} совпало, ${diff} отличается`);

    // тексты: ищем строки спек в канвасе
    const canvas = zip.read('canvas.fig');
    if (canvas && canvas.toString('latin1', 0, 8) === 'fig-kiwi') {
      const schemaLen = canvas.readUInt32LE(12);
      let pos = 16 + schemaLen;
      const dataLen = canvas.readUInt32LE(pos);
      pos += 4;
      const data = zstdDecompressSync(canvas.subarray(pos, pos + dataLen));
      const norm = (x) => x.replace(/[\u2028\u2029\u00a0\s]+/g, ' ').trim();
      const haystack = norm(data.toString('utf8'));

      const texts = new Set();
      for (const page of structure.pages) {
        for (const s of page.sections) {
          if (!s.dir) continue;
          const specPath = join(root, s.dir, 'spec.json');
          if (!existsSync(specPath)) continue;
          for (const n of JSON.parse(readFileSync(specPath, 'utf8')).nodes ?? []) {
            if (n.type === 'TEXT' && n.text?.trim().length > 3) texts.add(n.text.trim());
          }
        }
      }
      let found = 0;
      for (const t of texts) if (haystack.includes(norm(t).slice(0, 40))) found++;
      check('тексты есть в .fig', found === texts.size, `${found} из ${texts.size}`);
    }
  }
}

// --- отчёт ----------------------------------------------------------------
const width = Math.max(...rows.map((r) => r.name.length));
console.log(`источники: экспорт${apiFile ? ' · API' : ''}${figArg ? ' · .fig' : ''}\n`);
for (const r of rows) {
  console.log(`  ${r.ok ? '✓' : '✗'}  ${r.name.padEnd(width)}  ${r.detail ?? ''}`);
}

const failed = rows.filter((r) => !r.ok && r.required);
const skipped = rows.filter((r) => !r.ok && !r.required);
// Не смогли прочитать часть секций — это не «сошлось» и не «разошлось».
const incomplete = failed.length === 0 && unread.length > 0;
console.log(
  `\n${failed.length ? `расхождений: ${failed.length}` : 'все источники сходятся'}` +
    (skipped.length ? ` · сверок пропущено: ${skipped.length}` : ''),
);
if (apiMeta?.version) console.log(`версия файла на сервере: ${apiMeta.version}`);
// 0 — проверено и сходится, 1 — расхождение, 3 — проверить не удалось.
if (failed.length) process.exit(1);
process.exit(incomplete ? 3 : 0);
