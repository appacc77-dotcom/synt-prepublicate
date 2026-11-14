#!/usr/bin/env node
/**
 * Единый CLI двух мостов.
 *
 *   node tools/bridge.mjs list
 *   node tools/bridge.mjs figma   status|pages|tree|png|timing [опции]
 *   node tools/bridge.mjs figcraft status|pages|tree|png|timing --fig <file> [опции]
 *
 * Общие опции: --page <имя>, --depth <n>, --node <id>, --out <файл>, --scale <n>.
 * Мост берёт только то, что ему нужно: `--fig` нужен figcraft (у desktop файл
 * открыт в приложении), desktop игнорирует `--fig`.
 *
 * Печатает один JSON-объект: { source, command, ms, ... }.
 * Ошибки: 2 — конфигурация/транспорт, 3 — ошибка источника данных.
 */
import { bridgeByName, bridgeList } from './bridges/index.mjs';

const args = process.argv.slice(2);
const [source, command] = args;

function option(name, fallback = null) {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
}
function flag(name) {
  return args.includes(`--${name}`);
}
function die(code, message) {
  console.error(message);
  process.exit(code);
}

if (!source || source === 'list') {
  console.log(JSON.stringify({ bridges: bridgeList }, null, 1));
  process.exit(0);
}

let bridge;
try {
  bridge = bridgeByName(source);
} catch (error) {
  die(2, String(error.message ?? error));
}

const opts = {
  fig: option('fig'),
  page: option('page', 'Home'),
  depth: Number(option('depth', '6')),
  node: option('node'),
  out: option('out'),
  scale: Number(option('scale', '1')),
  json: flag('json'),
};

const commands = {
  status: () => bridge.status(opts),
  pages: () => bridge.pages(opts),
  tree: () => bridge.tree(opts),
  png: () => bridge.png(opts),
  timing: () => bridge.timing(opts),
};

const run = commands[command];
if (!run) die(2, `команды: ${Object.keys(commands).join(' | ')}`);

try {
  const result = await run();
  console.log(JSON.stringify({ source: bridge.meta.id, command, ...result }, null, opts.json ? 0 : 1));
} catch (error) {
  const code = error?.code === 2 ? 2 : 3;
  die(code, `${bridge.meta.id} ${command}: ${error.message ?? error}`);
}
