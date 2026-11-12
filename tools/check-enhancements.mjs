#!/usr/bin/env node
/**
 * Реестр дополнений и его связь с изобретёнными элементами.
 *
 *   node tools/check-enhancements.mjs
 *
 * Правила:
 *   - у каждого дополнения есть слой, происхождение, статус и выключатель;
 *   - активное дополнение согласовано (approvedBy — номер решения) и
 *     проверяется хотя бы одной проверкой;
 *   - изобретённый элемент ссылается на существующее дополнение;
 *   - у каждого дополнения со статусом active есть область (scope).
 *
 * Коды: 0 — сходится, 1 — расхождение, 2 — не смогли прочитать.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const path = join(root, 'design/enhancements.json');
const inventedPath = join(root, 'design/figma/invented.json');

if (!existsSync(path)) {
  console.error('нет design/enhancements.json');
  process.exit(2);
}

const registry = JSON.parse(readFileSync(path, 'utf8'));
const invented = existsSync(inventedPath) ? JSON.parse(readFileSync(inventedPath, 'utf8')) : { entries: [] };
const contracts = existsSync(join(root, 'tools/checks.json'))
  ? JSON.parse(readFileSync(join(root, 'tools/checks.json'), 'utf8'))
  : { checks: {} };

const problems = [];
const known = new Set(Object.keys(registry.enhancements ?? {}));
const statuses = new Set(['active', 'not-started', 'disabled']);

for (const [id, item] of Object.entries(registry.enhancements ?? {})) {
  if (item.layer !== 'enhancements') problems.push(`${id}: слой «${item.layer}», ожидался enhancements`);
  if (!item.why) problems.push(`${id}: нет причины — зачем дополнение нужно`);
  if (!item.origin) problems.push(`${id}: нет происхождения`);
  if (!statuses.has(item.status)) problems.push(`${id}: статус «${item.status}» не из списка`);
  if (!item.offSwitch) problems.push(`${id}: нет выключателя — дополнение нельзя отключить`);
  if (!Array.isArray(item.allowedChanges)) problems.push(`${id}: не указано, что разрешено менять в основе`);

  if (item.status === 'active') {
    if (!item.approvedBy) problems.push(`${id}: активно, но не согласовано (approvedBy пуст)`);
    if (!Array.isArray(item.scope) || !item.scope.length) problems.push(`${id}: активно, но не указана область`);
    if (!Array.isArray(item.checks) || !item.checks.length) problems.push(`${id}: активно, но не проверяется ни одной проверкой`);
  }
  for (const check of item.checks ?? []) {
    if (!contracts.checks?.[check]) problems.push(`${id}: проверка «${check}» не описана в checks.json`);
  }
}

// Изобретённые элементы обязаны ссылаться на дополнение.
for (const entry of invented.entries ?? []) {
  if (!entry.enhancement) {
    problems.push(`invented/${entry.id}: нет ссылки на дополнение`);
  } else if (!known.has(entry.enhancement)) {
    problems.push(`invented/${entry.id}: дополнение «${entry.enhancement}» не описано`);
  }
}

if (problems.length) {
  console.error(`дополнения: ${known.size} · проблем ${problems.length}`);
  for (const problem of problems.slice(0, 12)) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`дополнения: ${known.size} записей · статусы, согласование, выключатели и связи сходятся`);
