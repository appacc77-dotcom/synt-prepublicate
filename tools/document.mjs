#!/usr/bin/env node
/**
 * Полный снимок документа: переменные, стили и дерево узлов со всеми свойствами.
 *
 *   node tools/document.mjs [--page home]
 *
 * Пишет `design/figma/live/document.json`. Это «всё, что Figma отдаёт»:
 * привязки к токенам (`bound`), раскладка (sizing, pad, gap), эффекты, обводки,
 * радиусы, ограничения, описания и аннотации, компоненты и их пропсы.
 *
 * Секции берут из этого файла то, что им нужно, а не пересказ.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFigma, FigmaError } from './figma/cli.mjs';

const root = process.cwd();
const live = join(root, 'design/figma/live');
mkdirSync(live, { recursive: true });

const project = JSON.parse(readFileSync(join(root, 'design/figma/project.json'), 'utf8'));

let reply;
try {
  reply = runFigma(['exec-js', join(root, 'tools/figma/read-document.js')], { timeoutMs: 240000 });
} catch (error) {
  if (error instanceof FigmaError) {
    console.error(`document: ${error.code}: ${error.message}`);
    process.exit(2);
  }
  throw error;
}

if (reply?.error) {
  console.error(`document: ${reply.error.code}: ${reply.error.message}`);
  process.exit(3);
}

const data = reply?.result;
if (!data?.meta) {
  console.error('document: пустой ответ моста');
  process.exit(3);
}

if (data.meta.fileKey && data.meta.fileKey !== project.source.fileKey) {
  console.error(`чужой файл: ${data.meta.fileKey} вместо ${project.source.fileKey}`);
  process.exit(1);
}

const path = join(live, 'document.json');
writeFileSync(path, JSON.stringify(data, null, 1) + '\n');

const bytes = JSON.stringify(data).length;
const withBound = data.nodes.filter((n) => n.bound).length;
const withDesc = data.nodes.filter((n) => n.description).length;
const withAnn = data.nodes.filter((n) => n.annotations).length;
const withEffects = data.nodes.filter((n) => n.effects).length;

console.log(`документ: ${data.meta.name} · ${data.meta.fileKey}`);
console.log(`узлов:    ${data.count}`);
console.log(`переменных: ${data.variables.length} в ${data.variableCollections.length} коллекциях`);
console.log(`стилей:   paint ${data.styles.paint.length}, text ${data.styles.text.length}, effect ${data.styles.effect.length}`);
console.log(`привязок к токенам: ${withBound} узлов`);
console.log(`эффектов: ${withEffects} · описаний: ${withDesc} · аннотаций: ${withAnn}`);
console.log(`файл:     ${path} (${(bytes / 1024 / 1024).toFixed(1)} МБ)`);
