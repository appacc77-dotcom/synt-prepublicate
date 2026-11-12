#!/usr/bin/env node
/**
 * Ворота контракта: публикуется проверенное состояние, а не «что-то похожее».
 *
 *   node tools/check-site-contract.mjs
 *
 * Смысл (решение 398). Выпуск — это снимок мастерской. Между ними должен
 * быть след: из какого коммита сделан сайт и какой прогон приёмки это
 * подтвердил. Без сверки получается «сайт обновляли, но не перепроверяли» —
 * ровно то, из-за чего проект перезапускали в ноябре.
 *
 * Что проверяется:
 *   1. манифест есть (его пишет `npm run site:export`);
 *   2. прогон из манифеста существует, зелёный и снят с чистого дерева;
 *   3. коммит прогона совпадает с коммитом, из которого собран выпуск;
 *   4. хеш выпускаемого набора совпадает с записанным — мастерская не ушла
 *      вперёд после экспорта.
 *
 * Коды: 0 — можно публиковать, 1 — контракт нарушен, 2 — это не выпуск.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = process.cwd();
const problems = [];

const manifestPath = join(root, 'site-manifest.json');
if (!existsSync(manifestPath)) {
  console.error('\nвыпуска нет: нет site-manifest.json\n');
  console.error('сначала: npm run site:export');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// --- 1. Прогон приёмки -----------------------------------------------------
const runDir = join(root, 'reports/runs', manifest.runId ?? '');
const verdictPath = join(runDir, 'verdict.json');
if (!manifest.runId || !existsSync(verdictPath)) {
  problems.push(`прогона ${manifest.runId ?? '(нет)'} нет в reports/runs — приёмка не подтверждает выпуск`);
} else {
  const verdict = JSON.parse(readFileSync(verdictPath, 'utf8'));
  if (verdict.status !== 'PASS') problems.push(`прогон ${manifest.runId} не зелёный: ${verdict.status}`);
  if (verdict.dirty !== false) problems.push(`прогон ${manifest.runId} снят с грязного дерева — он не доказывает коммит`);
  if (!verdict.commit) problems.push(`у прогона ${manifest.runId} нет коммита — связать выпуск не с чем`);
  else if (verdict.commit !== manifest.sourceCommit.slice(0, verdict.commit.length)) {
    problems.push(`прогон ${manifest.runId} снят с коммита ${verdict.commit}, а выпуск собран из ${manifest.sourceCommit.slice(0, 8)}`);
  }
  if (!['full', 'accept-stage2'].includes(verdict.mode)) {
    problems.push(`прогон ${manifest.runId} — режим ${verdict.mode}, а нужен полный (full) или accept-stage2`);
  }
}

// --- 2. Хеш выпускаемого набора -------------------------------------------
const contract = JSON.parse(readFileSync(join(root, 'site-files.json'), 'utf8'));
const toMatcher = (pattern) => {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3) + '/';
    return (path) => path.startsWith(prefix);
  }
  return (path) => path === pattern;
};
const includes = contract.include.map(toMatcher);
const excludes = (contract.exclude ?? []).map(toMatcher);

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const selected = tracked.filter((p) => includes.some((m) => m(p)) && !excludes.some((m) => m(p))).sort();

const hash = createHash('sha256');
for (const path of selected) {
  const content = readFileSync(join(root, path));
  hash.update(`${path}\0${createHash('sha256').update(content).digest('hex')}\n`);
}
const currentHash = hash.digest('hex');

if (currentHash !== manifest.sourceHash) {
  problems.push('мастерская изменилась после экспорта — выпуск устарел, нужен новый npm run site:export');
}

// --- 3. Итог ---------------------------------------------------------------
if (problems.length) {
  console.log(`выпуск: ${manifest.sourceCommit?.slice(0, 8) ?? '?'} · прогон ${manifest.runId ?? '—'} · проблем: ${problems.length}`);
  for (const p of problems.slice(0, 8)) console.log(`  ${p}`);
  console.error('\nпубликовать нельзя: контракт между мастерской и выпуском нарушен');
  process.exit(1);
}

const mb = (n) => (n == null ? '—' : `${(n / 1048576).toFixed(1)} МБ`);
console.log(
  `выпуск ${manifest.sourceCommit.slice(0, 8)} · прогон ${manifest.runId} (${manifest.runMode}) · ` +
    `${manifest.files} файлов · сборка ${mb(manifest.distBytes)} · хеш ${manifest.sourceHash.slice(0, 12)}`,
);
process.exit(0);
