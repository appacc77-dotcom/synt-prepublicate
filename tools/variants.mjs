#!/usr/bin/env node
/**
 * Все состояния секции и их различия.
 *
 *   node tools/variants.mjs <nodeId> [--name slug] [--write]
 *
 * Секция в файле живёт не в одном виде: у `formats` пять инстансов, по одному
 * на активный формат, и у каждого своя картинка слайдера и свои описания.
 * Выгрузка одного инстанса даёт одно состояние — остальные теряются молча.
 *
 *   --name   куда положить: design/figma/pages/<page>/<name>/states.json
 *            (страницу берёт из project.json по узлу; без --name только печатает)
 *   --write  записать states.json рядом со спекой
 *
 * Печатает таблицу различий: какие картинки, тексты и свойства инстансов
 * отличаются от первого состояния.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runFigma } from './figma/cli.mjs';

const root = process.cwd();
const nodeId = process.argv[2];
if (!nodeId) {
  console.error('использование: node tools/variants.mjs <nodeId> [--name slug] [--write]');
  process.exit(2);
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const name = arg('--name');
const write = process.argv.includes('--write');

const template = readFileSync(join(root, 'tools/figma/variants.template.js'), 'utf8');
const tmp = join(tmpdir(), `figma-variants-${process.pid}.js`);
writeFileSync(tmp, template.split('__ID__').join(nodeId));

let reply;
try {
  reply = runFigma(['exec-js', tmp, '--timeout', '120000']);
} catch (error) {
  console.error(String(error.message).slice(0, 300));
  process.exit(3);
}
const data = reply.result;
if (data.error) {
  console.error(data.error);
  process.exit(3);
}

console.log(`секция: ${data.name} (${data.nodeId})`);
console.log(`состояний в файле: ${data.total}`);
console.log('');

const short = (value) => (value == null ? '—' : String(value).slice(0, 28));

for (const state of data.states) {
  const bits = [];
  if (state.images.length) bits.push(`картинок ${state.images.length}`);
  if (state.texts.length) bits.push(`текстов ${state.texts.length}`);
  if (state.props.length) bits.push(`пропсов ${state.props.length}`);
  console.log(`  ${state.id.padEnd(12)} ${bits.length ? bits.join(' · ') : 'как первое'}`);
  for (const image of state.images.slice(0, 3)) {
    console.log(`     image ${short(image.name).padEnd(18)} ${short(image.from)} → ${short(image.to)}`);
  }
  for (const text of state.texts.slice(0, 2)) {
    console.log(`     text  ${short(text.name).padEnd(18)} «${short(text.from)}» → «${short(text.to)}»`);
  }
  for (const prop of state.props.slice(0, 2)) {
    for (const [key, change] of Object.entries(prop.changed)) {
      console.log(`     prop  ${short(prop.name).padEnd(18)} ${key}: ${short(change.from)} → ${short(change.to)}`);
    }
  }
}

if (!write) {
  console.log('\nничего не записано. Для записи: --write --name <slug>');
  process.exit(0);
}
if (!name) {
  console.error('\nдля записи нужен --name <slug>');
  process.exit(2);
}

// Страницу ищем по узлу: секция лежит в design/figma/pages/<page>/<name>/.
const pagesRoot = join(root, 'design/figma/pages');
let target = null;
for (const page of readdirSync(pagesRoot)) {
  const candidate = join(pagesRoot, page, name);
  if (existsSync(candidate)) {
    target = join(candidate, 'states.json');
    break;
  }
}
if (!target) {
  console.error(`\nне найдена папка секции для --name ${name} в ${pagesRoot}`);
  process.exit(2);
}

writeFileSync(
  target,
  JSON.stringify(
    { at: new Date().toISOString(), section: data.name, nodeId: data.nodeId, total: data.total, states: data.states },
    null,
    2,
  ) + '\n',
);
console.log(`\nзаписано: ${target}`);
