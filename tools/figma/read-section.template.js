// Read-only: one section subtree + asset candidates. __NODE_ID__ подставляет экспортёр.
const ROOT_ID = "__NODE_ID__";
const MAX_DEPTH = 12;
const ICON_MAX = 64;

// Страницы грузим заранее: инстансы ищут главные компоненты на других
// страницах, и без этого выгрузка иконки может зависнуть.
await figma.loadAllPagesAsync();

const styleNames = new Map();
for (const s of await figma.getLocalTextStylesAsync()) styleNames.set(s.id, s.name);
for (const s of await figma.getLocalPaintStylesAsync()) styleNames.set(s.id, s.name);

// Секция может лежать не на той странице, что открыта у дизайнера. При
// dynamic-page доступе exportAsync на узле с другой страницы падает с
// «may not have any visible layers». Переключаемся на страницу узла и обратно.
const openedPage = figma.currentPage;
const findPage = (node) => {
  let current = node;
  while (current && current.type !== "PAGE") current = current.parent;
  return current;
};

const root = await figma.getNodeByIdAsync(ROOT_ID);
if (!root) return { error: "E_NOT_FOUND", id: ROOT_ID };

const rootPage = findPage(root);
const switched = rootPage && rootPage.id !== openedPage.id;
if (switched) {
  await figma.setCurrentPageAsync(rootPage);
  // Дать странице отрисоваться: сразу после переключения exportAsync может упасть.
  await new Promise((r) => setTimeout(r, 300));
}

const rgba = (c) => {
  if (!c) return null;
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return { hex: `#${h(c.r)}${h(c.g)}${h(c.b)}`, a: +(c.a ?? 1).toFixed(3) };
};

const nodes = [];
const images = [];
const iconCandidates = [];
const seenImage = new Set();

function hasText(n) {
  if (n.type === "TEXT") return true;
  if ("children" in n) return n.children.some(hasText);
  return false;
}

async function walk(n, depth) {
  const o = {
    id: n.id,
    name: n.name,
    type: n.type,
    depth,
    visible: n.visible,
    x: Math.round(n.x),
    y: Math.round(n.y),
    w: Math.round(n.width),
    h: Math.round(n.height),
  };

  if (n.type === "TEXT") {
    o.text = n.characters;
    o.styleName = n.textStyleId ? styleNames.get(n.textStyleId) ?? null : null;
    o.fontFamily = n.fontName?.family ?? null;
    o.fontStyle = n.fontName?.style ?? null;
    // Смешанные стили внутри одного узла: единого шрифта нет, и Figma отдаёт
    // символ mixed. Без пометки это выглядело как пропуск в спеке — теперь
    // видно, что так нарисовано, и дефект файла (FI-5) остаётся на виду.
    if (n.fontName === figma.mixed) o.fontMixed = true;
    if (n.fontSize === figma.mixed) o.fontSizeMixed = true;
    else o.fontSize = n.fontSize;
    o.lineHeight = n.lineHeight;
    o.letterSpacing = n.letterSpacing;
    // Без этого текст расходится с макетом: регистр, выравнивание, подчёркивание.
    if (n.textCase && n.textCase !== "ORIGINAL") o.textCase = n.textCase;
    if (n.textAlignHorizontal && n.textAlignHorizontal !== "LEFT") o.textAlign = n.textAlignHorizontal;
    if (n.textAlignVertical && n.textAlignVertical !== "TOP") o.textAlignV = n.textAlignVertical;
    if (n.textDecoration && n.textDecoration !== "NONE") o.textDecoration = n.textDecoration;
    if (n.paragraphSpacing) o.paragraphSpacing = n.paragraphSpacing;
    // Формат списка: без него маркеры теряются и текст собирается не тем.
    if (n.listType && n.listType !== "NONE") o.listType = n.listType;
    if (n.textAutoResize && n.textAutoResize !== "NONE") o.autoResize = n.textAutoResize;

    // Figma хранит перевод строки как U+2028, неразрывный пробел — как U+00A0.
    // В HTML U+2028 ненадёжен: пишем строки явно, сборка развернёт в <br>.
    if (n.characters.includes("\u2028")) o.lines = n.characters.split("\u2028");
    if (n.characters.includes("\u00a0")) o.nbsp = true;

    // Текст с разными стилями внутри одного узла: в файле таких 12, но без
    // сегментов выделенное слово теряет свой шрифт или цвет.
    try {
      const segs = n.getStyledTextSegments(["textStyleId", "fontName", "fontSize", "fills"]);
      const distinct = new Set(
        segs.map((g) => `${g.textStyleId}|${g.fontName?.family}|${g.fontSize}|${g.fills?.[0]?.color ? rgba(g.fills[0].color).hex : ""}`),
      );
      if (distinct.size > 1) {
        o.segments = segs.map((g) => ({
          text: g.characters,
          style: g.textStyleId ? styleNames.get(g.textStyleId) ?? null : null,
          font: g.fontName?.family ?? null,
          size: g.fontSize,
          color: g.fills?.[0]?.color ? rgba(g.fills[0].color).hex : null,
        }));
      }
    } catch (e) {
      /* старые версии плагина не умеют сегменты */
    }
  }

  if ("fills" in n && Array.isArray(n.fills) && n.fills.length) {
    o.fills = [];
    const boundFills = (n.boundVariables && n.boundVariables.fills) || [];
    for (let fi = 0; fi < n.fills.length; fi += 1) {
      const f = n.fills[fi];
      const rec = { type: f.type, visible: f.visible, opacity: f.opacity };
      if (f.type === "SOLID") {
        rec.color = rgba(f.color);
        // Заливка может быть привязана к переменной: тогда действует её
        // значение, а не цвет краски. Без этого полупрозрачное (bg-glass-light
        // #ffffff@0.35) выгружалось непрозрачным — 164 узла в файле.
        const bound = boundFills[fi];
        if (bound) {
          try {
            const variable = await figma.variables.getVariableByIdAsync(bound.id);
            const modes = variable && variable.valuesByMode;
            const value = modes && modes[Object.keys(modes)[0]];
            if (value && typeof value === "object" && "r" in value) {
              rec.color = rgba(value);
              rec.variable = variable.name;
            }
          } catch (error) {
            rec.variableError = String(error && error.message).slice(0, 80);
          }
        }
      }
      if (f.type === "IMAGE") {
        rec.scaleMode = f.scaleMode;
        rec.imageTransform = f.imageTransform;
        rec.imageHash = f.imageHash;
        // Настройки изображения (экспозиция, насыщенность…) — часть заливки.
        // Без них фон уезжает по цвету: у pain exposure +0,35, saturation −0,13.
        rec.filters = f.filters ?? null;
        if (f.imageHash && !seenImage.has(f.imageHash)) {
          seenImage.add(f.imageHash);
          images.push({ hash: f.imageHash, nodeId: n.id, nodeName: n.name, w: o.w, h: o.h });
        }
      }
      if (f.gradientStops) {
        rec.gradientStops = f.gradientStops.map((g) => ({
          position: +g.position.toFixed(3),
          color: rgba(g.color),
        }));
        rec.gradientTransform = f.gradientTransform;
      }
      o.fills.push(rec);
    }
  }

  if ("layoutMode" in n && n.layoutMode && n.layoutMode !== "NONE") {
    o.autoLayout = {
      mode: n.layoutMode,
      gap: n.itemSpacing,
      pad: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft],
      primary: n.primaryAxisAlignItems,
      counter: n.counterAxisAlignItems,
    };
    if (n.layoutWrap && n.layoutWrap !== "NO_WRAP") o.autoLayout.wrap = n.layoutWrap;
  }

  if ("cornerRadius" in n && n.cornerRadius) o.radius = n.cornerRadius;
  if ("strokes" in n && Array.isArray(n.strokes) && n.strokes.length) {
    // Штрихи тоже привязаны к переменным (1141 узел в файле) — берём значение
    // переменной, а не цвет краски, иначе полупрозрачная обводка станет плотной.
    const boundStrokes = (n.boundVariables && n.boundVariables.strokes) || [];
    o.strokes = [];
    for (let si = 0; si < n.strokes.length; si += 1) {
      const s = n.strokes[si];
      const rec = { type: s.type, color: rgba(s.color) };
      const bound = boundStrokes[si];
      if (bound && s.type === "SOLID") {
        try {
          const variable = await figma.variables.getVariableByIdAsync(bound.id);
          const modes = variable && variable.valuesByMode;
          const value = modes && modes[Object.keys(modes)[0]];
          if (value && typeof value === "object" && "r" in value) {
            rec.color = rgba(value);
            rec.variable = variable.name;
          }
        } catch (error) {
          rec.variableError = String(error && error.message).slice(0, 80);
        }
      }
      o.strokes.push(rec);
    }
    o.strokeWeight = n.strokeWeight;
    if (n.strokeAlign && n.strokeAlign !== "INSIDE") o.strokeAlign = n.strokeAlign;
  }

  // Эффекты: размытие фона (шапка) и тени карточек. Без них вёрстка «плоская».
  if ("effects" in n && Array.isArray(n.effects) && n.effects.length) {
    o.effects = n.effects
      .filter((e) => e.visible !== false)
      .map((e) => ({
        type: e.type,
        radius: e.radius,
        ...(e.offset ? { offset: { x: +e.offset.x.toFixed(1), y: +e.offset.y.toFixed(1) } } : {}),
        ...(e.color ? { color: rgba(e.color) } : {}),
        ...(e.spread ? { spread: e.spread } : {}),
      }));
    if (!o.effects.length) delete o.effects;
  }

  // Как узел ведёт себя в раскладке: FILL — тянется, HUG — по содержимому.
  if ("layoutSizingHorizontal" in n) {
    const sizing = {};
    if (n.layoutSizingHorizontal !== "FIXED") sizing.h = n.layoutSizingHorizontal;
    if (n.layoutSizingVertical !== "FIXED") sizing.v = n.layoutSizingVertical;
    if (Object.keys(sizing).length) o.sizing = sizing;
  }

  // Поведение ребёнка в авто-раскладке: STRETCH — на всю ширину родителя,
  // ABSOLUTE — вне потока, координаты от родителя.
  if (n.layoutAlign && n.layoutAlign !== "INHERIT") o.align = n.layoutAlign;
  if (n.layoutGrow) o.grow = n.layoutGrow;
  if (n.layoutPositioning === "ABSOLUTE") o.absolute = true;
  if (n.clipsContent === false) o.clips = false;
  // Повёрнутые элементы: в файле их 298, без угла вёрстка их не воспроизводит.
  if (n.rotation) o.rotation = +n.rotation.toFixed(2);
  if (n.isMask) o.mask = true;
  if (n.blendMode && n.blendMode !== "PASS_THROUGH" && n.blendMode !== "NORMAL") o.blend = n.blendMode;
  if (n.strokeDashes?.length) o.strokeDashes = n.strokeDashes;
  if (n.opacity !== 1) o.opacity = +n.opacity.toFixed(3);
  if ("minWidth" in n && (n.maxWidth != null || n.minWidth != null)) {
    o.limits = {};
    if (n.minWidth != null) o.limits.minW = n.minWidth;
    if (n.maxWidth != null) o.limits.maxW = n.maxWidth;
  }

  // Привязки к переменным: чем на самом деле задан отступ или цвет.
  const bound = n.boundVariables;
  if (bound && Object.keys(bound).length) {
    o.bound = Object.fromEntries(
      Object.entries(bound).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => x.id) : v?.id ?? v]),
    );
  }
  if (n.description && n.description.trim()) o.description = n.description.trim();
  try {
    const ann = n.annotations;
    if (ann && ann.length) o.annotations = ann.map((a) => a.label ?? a.labelMarkdown ?? "");
  } catch (e) {
    /* аннотации есть не во всех версиях плагина */
  }

  nodes.push(o);

  // Варианты компонента: из них собирается API компонента (theme × size × caps).
  if (n.type === "INSTANCE" && n.componentProperties && Object.keys(n.componentProperties).length) {
    o.props = Object.fromEntries(
      Object.entries(n.componentProperties).map(([k, v]) => [k, v.value]),
    );
  }

  // Иконка: инстанс без текста внутри и небольшой — его выгодно держать вектором.
  if (n.type === "INSTANCE" && o.w <= ICON_MAX && o.h <= ICON_MAX && !hasText(n)) {
    iconCandidates.push({ node: n, id: n.id, name: n.name, w: o.w, h: o.h, depth });
  }

  if (depth < MAX_DEPTH && "children" in n) {
    for (const c of n.children) await walk(c, depth + 1);
  }
}
await walk(root, 0);

// Имена главных компонентов для иконок — только асинхронно (dynamic-page).
const icons = [];
for (const c of iconCandidates) {
  let componentId = null;
  let componentName = c.name;
  try {
    const main = await c.node.getMainComponentAsync();
    if (main) {
      componentId = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent.id : main.id;
      componentName = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent.name : main.name;
    }
  } catch (e) {
    /* инстанс без главного компонента — оставим имя узла */
  }
  icons.push({
    id: c.id,
    name: c.name,
    componentId,
    componentName,
    // Варианты одного набора различаются геометрией: у arrow-quiet восемь
    // сочетаний color × direction. Без них все стрелки получают один SVG.
    props: c.node.componentProperties
      ? Object.fromEntries(Object.entries(c.node.componentProperties).map(([k, v]) => [k, v.value]))
      : null,
    w: c.w,
    h: c.h,
    depth: c.depth,
  });
}

// Уникальные иконки по компоненту И варианту: один SVG на сочетание свойств.
const uniqueIcons = [];
const seenIcon = new Set();
for (const i of icons) {
  const variant = i.props ? JSON.stringify(i.props) : "";
  const key = `${i.componentId ?? i.id}|${variant}`;
  if (seenIcon.has(key)) continue;
  seenIcon.add(key);
  uniqueIcons.push(i);
}

// Страница — предок узла, а не figma.currentPage: открыта может быть любая.
let pageNode = root;
while (pageNode && pageNode.type !== "PAGE") pageNode = pageNode.parent;

// Возвращаем дизайнеру ту страницу, с которой он работал.
if (switched) await figma.setCurrentPageAsync(openedPage);

// Отпечаток содержимого считается здесь, а не в экспортёре: два независимых
// алгоритма на одном смысле расходятся молча, и «экспорт устарел» появляется
// на ровном месте. Один источник — плагин.
const fingerprintLines = [];
function fingerprintWalk(n) {
  fingerprintLines.push(
    [n.id, Math.round(n.x), Math.round(n.y), Math.round(n.width), Math.round(n.height), n.type === "TEXT" ? n.characters : ""].join("|"),
  );
  if ("children" in n) for (const c of n.children) fingerprintWalk(c);
}
fingerprintWalk(root);
let fingerprintHash = 0x811c9dc5;
for (const line of fingerprintLines) {
  for (let i = 0; i < line.length; i++) {
    fingerprintHash ^= line.charCodeAt(i);
    fingerprintHash = Math.imul(fingerprintHash, 0x01000193) >>> 0;
  }
  fingerprintHash ^= 10;
  fingerprintHash = Math.imul(fingerprintHash, 0x01000193) >>> 0;
}

return {
  page: { id: pageNode?.id ?? null, name: pageNode?.name ?? "page" },
  root: { id: root.id, name: root.name, w: Math.round(root.width), h: Math.round(root.height) },
  fingerprint: fingerprintHash.toString(16).padStart(8, "0"),
  count: nodes.length,
  nodes,
  images,
  icons: uniqueIcons,
  iconInstances: icons.length,
};
