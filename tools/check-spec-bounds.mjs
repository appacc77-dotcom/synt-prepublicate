#!/usr/bin/env node
/**
 * Проверяет, что узлы первого уровня спеки лежат внутри своей секции.
 *
 *   node tools/check-spec-bounds.mjs [--unit booking/booking-formats] [--all]
 *
 * Класс ошибки: координаты в спеке поняты не тем способом, каким их хранит
 * источник. В архиве .fig `transform` — смещение от родителя; если сложить
 * их как абсолютные (или наоборот), дерево не ломается — просто всё уезжает
 * целиком. Замер этого не видит: он сверяет вёрстку с той же спекой, и обе
 * стороны смещены одинаково.
 *
 * Инвариант, который ловит такую ошибку без браузера и без эталона:
 * **секция нарисована вокруг своего содержимого**. Значит узел первого уровня
 * не может выходить за её прямоугольник. При ошибке в координатах он выходит
 * на сотни пикселей — сигнал однозначный.
 *
 * Что считается рамкой: секция и любой узел, совпадающий с ней по размеру —
 * холст, внутри которого нарисован макет. В архиве .fig между секцией и
 * содержимым стоит такой фрейм (0:3 → 0:4), у моста его нет. Проверяются
 * дети рамки; глубже в макете нормально, когда иконка или подпись вылезает
 * за свою коробку на 3–15 px (обводка, выносные элементы, подпись у поля).
 * Такие случаи видит `--all`, но ворота они не валят.
 *
 * Допуск — project.json.gates.specBoundsPx (по умолчанию 1 px).
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const projectPath = join(root, 'design/figma/project.json');
if (!existsSync(projectPath)) {
  console.error('нет design/figma/project.json');
  process.exit(2);
}
const project = JSON.parse(readFileSync(projectPath, 'utf8'));
const limit = project.gates?.specBoundsPx ?? 1;
const only = arg('--unit', null);
const all = process.argv.includes('--all');

// Осознанные исключения: узлы, которые по замыслу шире секции (карусель,
// вылет за обрез). Список — отдельный файл, потому что спеки генерируются.
const exceptionsPath = join(root, 'design/figma/bounds-exceptions.json');
const exceptions = new Set();
if (existsSync(exceptionsPath)) {
  for (const item of JSON.parse(readFileSync(exceptionsPath, 'utf8')).exceptions ?? []) {
    exceptions.add(`${item.unit}#${item.id}`);
  }
}

function findSpecs() {
  const base = join(root, project.paths?.sections ?? 'design/figma/pages');
  if (!existsSync(base)) return [];
  const out = [];
  for (const page of readdirSync(base)) {
    const pageDir = join(base, page);
    if (!statSync(pageDir).isDirectory()) continue;
    for (const section of readdirSync(pageDir)) {
      const file = join(pageDir, section, 'spec.json');
      if (existsSync(file)) out.push({ unit: `${page}/${section}`, file });
    }
  }
  return out;
}

const specs = findSpecs().filter((s) => !only || s.unit === only);
if (!specs.length) {
  console.error(only ? `нет спеки ${only}` : 'спек не найдено');
  process.exit(2);
}

const problems = [];
let checked = 0;
let nested = 0;
let frames = 0;

for (const { unit, file } of specs) {
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const { w: W, h: H } = spec.section ?? {};
  const stack = [];

  for (const node of spec.nodes ?? []) {
    while (stack.length && stack[stack.length - 1].depth >= node.depth) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    node._ax = node.depth === 0 ? 0 : node.x + (parent?._ax ?? 0);
    node._ay = node.depth === 0 ? 0 : node.y + (parent?._ay ?? 0);
    // Рамка — секция или узел во весь её размер: холст, на котором нарисован макет.
    node._frame = node.depth === 1 || Math.abs(node.w - W) <= 1 && Math.abs(node.h - H) <= 1;
    if (node.depth > 1 && node._frame) frames += 1;
    stack.push(node);
    if (node.depth === 0) continue;

    // Ближайшая рамка, внутри которой узел должен лежать.
    let canvas = { ax: 0, ay: 0, w: W, h: H, depth: 0 };
    if (!node._frame) {
      for (let i = stack.length - 2; i >= 0; i -= 1) {
        if (stack[i]._frame) {
          canvas = { ax: stack[i]._ax, ay: stack[i]._ay, w: stack[i].w, h: stack[i].h, depth: stack[i].depth };
          break;
        }
      }
    }

    if (node.depth === canvas.depth + 1) {
      const outside = {
        right: node._ax + node.w - (canvas.ax + canvas.w),
        bottom: node._ay + node.h - (canvas.ay + canvas.h),
        left: canvas.ax - node._ax,
        top: canvas.ay - node._ay,
      };
      checked += 1;
      if (exceptions.has(`${unit}#${node.id}`)) continue;
      if (Math.max(...Object.values(outside)) > limit) {
        problems.push({ unit, id: node.id, name: node.name, kind: 'вне секции', dx: Math.round(Math.max(outside.right, outside.left)), dy: Math.round(Math.max(outside.bottom, outside.top)) });
      }
      continue;
    }

    if (!all) continue;
    nested += 1;
    const parentOut = {
      right: node._ax + node.w - (parent._ax + parent.w),
      bottom: node._ay + node.h - (parent._ay + parent.h),
      left: parent._ax - node._ax,
      top: parent._ay - node._ay,
    };
    const worstParent = Math.max(...Object.values(parentOut));
    if (worstParent > limit) {
      problems.push({ unit, id: node.id, name: node.name, kind: 'вне родителя', dx: Math.round(Math.max(parentOut.right, parentOut.left)), dy: Math.round(Math.max(parentOut.bottom, parentOut.top)) });
    }
  }
}

if (problems.length) {
  console.log(`секций: ${specs.length} · узлов первого уровня: ${checked} · проблем: ${problems.length}`);
  for (const p of problems.slice(0, 25)) {
    console.log(`  ${p.unit} · ${p.id} ${p.kind} +${p.dx}×${p.dy} «${(p.name ?? '').slice(0, 40)}»`);
  }
  if (problems.length > 25) console.log(`  … и ещё ${problems.length - 25}`);
  console.error('\nсодержимое выходит за прямоугольник секции: проверьте, как поняты координаты');
  process.exit(1);
}

console.log(`секций: ${specs.length} · узлов у рамки: ${checked}${frames ? ` · рамок внутри секции: ${frames}` : ''}${all ? ` · вложенных: ${nested}` : ''} · проблем: 0`);
console.log('узлы лежат внутри секций');
process.exit(0);
