#!/usr/bin/env node
/**
 * Собирает выпуск: чистый набор файлов сайта и его манифест.
 *
 *   node tools/site-export.mjs                # собрать .site/ и манифест
 *   node tools/site-export.mjs --no-build     # только файлы, без сборки
 *   node tools/site-export.mjs --push         # ещё и ветка site для хостинга
 *
 * Зачем: мастерская — это весь репозиторий (спеки, кропы, отчёты, студийные
 * страницы, 250 МБ design/). Хостингу всё это не нужно и вредно: он тянет
 * 250 МБ при клоне, а студийные превью уезжают клиенту. Выпуск — только то,
 * что перечислено в `site-files.json`, и он обязан собираться **без**
 * `design/` и `docs/`.
 *
 * Контракт (решение 398): манифест пишет коммит мастерской, хеш дерева и
 * `runId` зелёного прогона приёмки. Ворота `site-contract` сверяют, что
 * публикуется именно проверенное состояние, а не «что-то похожее».
 *
 * Ветка `site` — генерируемая (решение 399): единственный писатель — этот
 * скрипт, и только он делает push --force. Правка ветки руками будет
 * затёрта следующим выпуском.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync, symlinkSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = process.cwd();
const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  // i >= 0: флаг может стоять первым в командной строке. С `i > 0` первый
  // аргумент молча игнорировался — так выпуск с --base ушёл без префикса,
  // и сайт по адресу /synt-prepublicate/ отдавал 404 на картинки.
  return i >= 0 ? args[i + 1] : fallback;
};

const outArg = arg('--out', '.site');
const outDir = isAbsolute(outArg) ? outArg : join(root, outArg);
const pushBranch = arg('--push-branch', 'site');
// Сайт может жить не в корне домена (проект GitHub Pages: /synt-prepublicate/).
// Тогда все абсолютные адреса в сборке получают префикс — иначе ссылки и
// картинки уедут на корень домена и дадут 404.
const basePath = arg('--base', null);
// Зеркало можно переопределить: второй репозиторий нужен, чтобы показать
// сборку по другому адресу, не ломая основной mirror.
const mirrorOverride = arg('--mirror', null);
// Ветка зеркала: по умолчанию main (зеркало — отдельный репозиторий только
// с выпуском). Если выпуск кладут в ветку того же репозитория, что и
// мастерская, нужна отдельная ветка — иначе публикация затрёт исходники.
const mirrorBranch = arg('--mirror-branch', 'main');
const shouldBuild = !has('--no-build');
const shouldPush = has('--push');
const writeManifest = !has('--no-manifest');

const fail = (message) => {
  console.error(`\nвыпуск не собран: ${message}\n`);
  process.exit(1);
};

const git = (cmdArgs, options = {}) =>
  execFileSync('git', cmdArgs, { cwd: root, encoding: 'utf8', ...options }).trim();

// --- 0. Состояние мастерской ----------------------------------------------
const manifestPath = join(root, 'site-files.json');
if (!existsSync(manifestPath)) fail('нет site-files.json — это и есть контракт, без него нечего выпускать');
const contract = JSON.parse(readFileSync(manifestPath, 'utf8'));

// Артефакты замера переписываются каждый прогон — они не делают мастерскую
// «грязной»: так же считает и провенанс конвейера.
const GENERATED = [
  /^design\/figma\/pages\/.+\/gate\.json$/,
  /^design\/figma\/pages\/.+\/pixel\.json$/,
  /^design\/figma-contention\.json$/,
];
const allowDirty = has('--allow-dirty');
const dirty = git(['status', '--porcelain'])
  .split('\n')
  .filter(Boolean)
  .filter((line) => !GENERATED.some((re) => re.test(line.slice(3).trim())))
  .join('\n');
if (dirty && !allowDirty) {
  fail(`дерево мастерской грязное — сначала коммит:\n${dirty.split('\n').slice(0, 8).join('\n')}\n\nвыпуск из незакоммиченного состояния нельзя связать с прогоном приёмки`);
}
const sourceCommit = git(['rev-parse', 'HEAD']);

// --- 1. Набор файлов -------------------------------------------------------
const toMatcher = (pattern) => {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3) + '/';
    return (path) => path.startsWith(prefix);
  }
  return (path) => path === pattern;
};

const includes = contract.include.map(toMatcher);
const excludes = (contract.exclude ?? []).map(toMatcher);

const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
const selected = tracked.filter(
  (path) =>
    includes.some((m) => m(path)) &&
    !excludes.some((m) => m(path)) &&
    // Файл мог быть удалён в мастерской, но ещё числиться в индексе:
    // копировать нечего, и падать из-за этого не нужно.
    existsSync(join(root, path)),
);

if (!selected.length) fail('набор пуст: проверьте include в site-files.json');

// --- 2. Копирование --------------------------------------------------------
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const hash = createHash('sha256');
let bytes = 0;

for (const path of selected.sort()) {
  const from = join(root, path);
  const to = join(outDir, path);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  const content = readFileSync(from);
  bytes += content.length;
  hash.update(`${path}\0${createHash('sha256').update(content).digest('hex')}\n`);
}

const sourceHash = hash.digest('hex');

// package.json выпуска: скрипты мастерской (prebuild из tools/, проверки,
// экспорт) в выпуске не нужны и не должны работать — tools/ туда не едет.
// Зависимости оставляем как есть, иначе npm ci разойдётся с package-lock.
const releasePkgPath = join(outDir, 'package.json');
if (existsSync(releasePkgPath)) {
  const pkg = JSON.parse(readFileSync(releasePkgPath, 'utf8'));
  pkg.scripts = {
    build: 'astro build',
    preview: 'astro preview',
  };
  writeFileSync(releasePkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

// --- 3. Сборка выпуска -----------------------------------------------------
let distBytes = null;
let distFiles = null;
let distHash = null;

if (shouldBuild) {
  // Зависимости не копируем: выпуск собирается теми, что уже стоят.
  const modules = join(root, 'node_modules');
  if (!existsSync(modules)) fail('нет node_modules — выполните npm install');
  symlinkSync(modules, join(outDir, 'node_modules'));

  try {
    execFileSync('npm', ['run', 'build'], {
      cwd: outDir,
      stdio: 'pipe',
      env: { ...process.env, RELEASE: '1', ASTRO_OUT_DIR: 'dist', ASTRO_TELEMETRY_DISABLED: '1' },
    });
  } catch (error) {
    const log = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n');
    fail(`сборка выпуска не прошла\n${log}`);
  }

  const dist = join(outDir, 'dist');
  if (!existsSync(dist)) fail('сборка прошла, но dist/ нет');

  const walk = (dir, base = '') => {
    const result = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) result.push(...walk(join(dir, entry.name), rel));
      else result.push(rel);
    }
    return result;
  };
  const distList = walk(dist).sort();
  const distH = createHash('sha256');
  distBytes = 0;
  for (const rel of distList) {
    const content = readFileSync(join(dist, rel));
    distBytes += content.length;
    distH.update(`${rel}\0${content.length}\n`);
  }
  distFiles = distList.length;
  distHash = distH.digest('hex');
}

// --- 4. Манифест -----------------------------------------------------------
const run = latestGreenRun();
if (run && run.commit && run.commit !== sourceCommit.slice(0, run.commit.length)) {
  const message = `последний зелёный прогон ${run.runId} снят с коммита ${run.commit}, а выпускается ${sourceCommit.slice(0, 8)}`;
  if (shouldPush) fail(`${message}\nсначала прогоните приёмку на этом коммите: node tools/conveyor.mjs check --all`);
  console.warn(`  внимание: ${message} — манифест не связан с прогоном`);
}

const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  sourceCommit,
  sourceBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  sourceHash,
  runId: run?.runId ?? null,
  runCommit: run?.commit ?? null,
  runMode: run?.mode ?? null,
  runFinishedAt: run?.finishedAt ?? null,
  files: selected.length,
  bytes,
  distFiles,
  distBytes,
  distHash,
  build: contract.build,
  publish: contract.publish,
};

if (writeManifest) writeFileSync(join(root, 'site-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const mb = (n) => (n === null ? '—' : `${(n / 1048576).toFixed(1)} МБ`);
console.log(`мастерская: ${sourceCommit.slice(0, 8)} · файлов ${manifest.files} · ${mb(bytes)}`);
console.log(`выпуск:     ${shouldBuild ? `${distFiles} файлов · ${mb(distBytes)}` : 'без сборки'}`);
console.log(`приёмка:    ${run ? `${run.runId} (${run.mode}, ${run.status})` : 'зелёного прогона нет'}`);
console.log(`манифест:   site-manifest.json · хеш ${sourceHash.slice(0, 12)}`);

// --- 5. Ветка site ---------------------------------------------------------
if (shouldPush) {
  if (!run) fail('нет зелёного прогона приёмки — публиковать нечего');
  const worktree = join(root, '.site-branch');
  rmSync(worktree, { recursive: true, force: true });
  git(['worktree', 'prune']);
  git(['worktree', 'add', '--detach', worktree]);
  try {
    // Чистим каталог, не трогая .git: в рабочем дереве worktree это файл-
    // ссылка на репозиторий, и его удаление ломает git worktree remove.
    execFileSync('sh', [
      '-c',
      `find "${worktree}" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +`,
    ]);
    if (basePath) prefixBase(join(outDir, 'dist'), basePath);
    execFileSync('sh', ['-c', `cd "${outDir}" && tar cf - . | (cd "${worktree}" && tar xf -)`]);
    execFileSync('git', ['add', '-A'], { cwd: worktree });
    execFileSync(
      'git',
      ['commit', '--no-verify', '-m', `site: из ${sourceCommit.slice(0, 8)} (прогон ${run.runId})`],
      { cwd: worktree },
    );
    execFileSync('git', ['push', '--force', 'origin', `HEAD:refs/heads/${pushBranch}`], { cwd: worktree });
    console.log(`ветка:      ${pushBranch} ← ${sourceCommit.slice(0, 8)}`);

    const mirrorUrl = mirrorOverride ?? contract.mirror;
    if (mirrorUrl) {
      pushMirror(join(outDir, 'dist'), mirrorUrl, mirrorBranch);
      console.log(`зеркало:    ${mirrorUrl.replace(/\.git$/, '').replace('https://github.com/', '')}`);
    }
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
  }
}


/**
 * Префикс пути для сайтов, которые живут не в корне домена.
 *
 * GitHub Pages отдаёт проект по адресу /<repo>/, а вёрстка собрана из макета
 * с адресами от корня (`/masters.html`, `/img/hero.jpg`). Без переписывания
 * каждая ссылка уезжает на корень домена и получает 404 — именно так ломался
 * первый показ из нового репозитория.
 *
 * Правим только абсолютные адреса в кавычках и url(/...) в CSS: адреса с
 * протоколом (`https://`, `//cdn`) не трогаем.
 */
function prefixBase(dir, base) {
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base;
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html|css|js|json|webmanifest)$/.test(entry.name)) files.push(full);
    }
  };
  walk(dir);

  let changed = 0;
  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    // href="/x" src="/x" action="/x" content="/x" — плюс url(/x) в CSS.
    const after = before
      .replace(/((?:href|src|action|poster|content)=")\/(?!\/)/g, `$1${prefix}/`)
      .replace(/(url\(['"]?)\/(?!\/)/g, `$1${prefix}/`)
      .replace(/(srcset=")([^"]*)"/g, (whole, head, body) =>
        `${head}${body.replace(/(^|,\s*)\/(?!\/)/g, `$1${prefix}/`)}"`,
      );
    if (after !== before) {
      writeFileSync(file, after);
      changed += 1;
    }
  }
  console.log(`база:       ${prefix}/ — переписано файлов: ${changed}`);
}

/**
 * Зеркало: второй адрес того же выпуска.
 *
 * Зачем: путь до Netlify из России бывает медленным — с одного маршрута
 * выпуск отдавался по 13 КБ в минуту, тогда как то же содержимое с GitHub
 * Pages приходит за 0.2 с. Зеркало не заменяет хостинг и не принимает формы,
 * но даёт второй адрес для проверки и быстрый показ.
 */
function pushMirror(distDir, mirrorUrl, branch = 'main') {
  const temp = join(root, '.site-mirror');
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  execFileSync('sh', ['-c', `cp -R "${distDir}"/. "${temp}"/ && touch "${temp}/.nojekyll"`]);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: temp });
  // Временный репозиторий не наследует ни личность, ни доступ основного:
  // без этого push просит пароль, которого в неинтерактивном режиме нет.
  execFileSync('git', ['config', 'user.name', 'site-export'], { cwd: temp });
  execFileSync('git', ['config', 'user.email', 'site-export@localhost'], { cwd: temp });
  const helper = execFileSync('git', ['config', '--get', 'credential.helper'], { cwd: root, encoding: 'utf8' }).trim();
  if (helper) execFileSync('git', ['config', 'credential.helper', helper], { cwd: temp });
  execFileSync('git', ['add', '-A'], { cwd: temp });
  execFileSync('git', ['commit', '-q', '--no-verify', '-m', `site: из ${sourceCommit.slice(0, 8)} (прогон ${run?.runId ?? '—'})`], { cwd: temp });
  execFileSync('git', ['push', '--force', mirrorUrl, `HEAD:refs/heads/${branch}`], { cwd: temp, stdio: 'pipe' });
  rmSync(temp, { recursive: true, force: true });
}

/**
 * Последний зелёный прогон приёмки: полный (`full`) или второй этап.
 * Только по нему разрешена публикация — это и есть контракт.
 */
function latestGreenRun() {
  const runsDir = join(root, 'reports/runs');
  if (!existsSync(runsDir)) return null;
  const runs = readdirSync(runsDir)
    .filter((name) => existsSync(join(runsDir, name, 'verdict.json')))
    .sort();
  for (const name of runs.reverse()) {
    try {
      const verdict = JSON.parse(readFileSync(join(runsDir, name, 'verdict.json'), 'utf8'));
      if (verdict.status !== 'PASS') continue;
      if (verdict.dirty) continue;
      if (!['full', 'accept-stage2'].includes(verdict.mode)) continue;
      return verdict;
    } catch {
      continue;
    }
  }
  return null;
}
