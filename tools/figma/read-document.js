/**
 * Полный дамп документа: переменные, стили и дерево узлов со всеми свойствами.
 *
 * Запускается через `figma-agent exec-js` из tools/document.mjs.
 * Пишем только то, что отличается от значений по умолчанию: иначе файл
 * раздувается в разы, а разницы не видно.
 */

const rgba = (c) => {
  if (!c) return null;
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  const hex = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  return (c.a ?? 1) < 1 ? `${hex}@${+(c.a ?? 1).toFixed(2)}` : hex;
};

// --- переменные -----------------------------------------------------------
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const variables = await figma.variables.getLocalVariablesAsync();
const colById = new Map(collections.map((c) => [c.id, c]));

const variableDump = variables.map((v) => {
  const col = colById.get(v.variableCollectionId);
  const values = {};
  for (const [modeId, val] of Object.entries(v.valuesByMode)) {
    const modeName = col?.modes.find((m) => m.modeId === modeId)?.name ?? modeId;
    if (val && typeof val === "object" && "r" in val) values[modeName] = rgba(val);
    else if (val && val.type === "VARIABLE_ALIAS") values[modeName] = { alias: val.id };
    else values[modeName] = val;
  }
  return {
    id: v.id,
    name: v.name,
    collection: col?.name ?? null,
    type: v.resolvedType,
    description: v.description || undefined,
    values,
  };
});

const variableCollections = collections.map((c) => ({
  id: c.id,
  name: c.name,
  modes: c.modes.map((m) => m.name),
  defaultMode: c.defaultModeId,
}));

// --- стили ----------------------------------------------------------------
const paintStyles = await figma.getLocalPaintStylesAsync();
const textStyles = await figma.getLocalTextStylesAsync();
const effectStyles = await figma.getLocalEffectStylesAsync();
const gridStyles = await figma.getLocalGridStylesAsync();

const styleDump = (s, extra) => ({
  id: s.id,
  name: s.name,
  description: s.description || undefined,
  ...extra(s),
});

const styles = {
  paint: paintStyles.map((s) =>
    styleDump(s, (x) => ({ paints: (x.paints ?? []).map((p) => ({ type: p.type, color: rgba(p.color), opacity: p.opacity, visible: p.visible })) })),
  ),
  text: textStyles.map((s) =>
    styleDump(s, (x) => ({
      font: x.fontName,
      size: x.fontSize,
      lineHeight: x.lineHeight,
      letterSpacing: x.letterSpacing,
      case: x.textCase,
      decoration: x.textDecoration,
      paragraphSpacing: x.paragraphSpacing || undefined,
    })),
  ),
  effect: effectStyles.map((s) => styleDump(s, (x) => ({ effects: x.effects }))),
  grid: gridStyles.map((s) => styleDump(s, (x) => ({ grids: x.layoutGrids }))),
};

// --- дерево ---------------------------------------------------------------
const nodes = [];
const instances = [];

function dump(n, depth, parentId) {
  const o = {
    id: n.id,
    name: n.name,
    type: n.type,
    depth,
    parent: parentId,
    x: Math.round(n.x),
    y: Math.round(n.y),
    w: Math.round(n.width),
    h: Math.round(n.height),
  };

  if (n.visible === false) o.visible = false;
  if (n.opacity !== 1) o.opacity = +n.opacity.toFixed(3);
  if (n.blendMode && n.blendMode !== "PASS_THROUGH" && n.blendMode !== "NORMAL") o.blend = n.blendMode;
  if (n.isMask) o.mask = true;
  if (n.rotation) o.rotation = +n.rotation.toFixed(2);
  if (n.description && n.description.trim()) o.description = n.description.trim();
  try {
    const ann = n.annotations;
    if (ann && ann.length) o.annotations = ann.map((a) => a.label ?? a.labelMarkdown ?? "");
  } catch {}

  // раскладка
  if ("layoutMode" in n && n.layoutMode && n.layoutMode !== "NONE") {
    const l = { mode: n.layoutMode };
    if (n.layoutWrap && n.layoutWrap !== "NO_WRAP") l.wrap = n.layoutWrap;
    l.gap = n.itemSpacing;
    if (n.counterAxisSpacing != null && n.counterAxisSpacing !== n.itemSpacing) l.crossGap = n.counterAxisSpacing;
    const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft];
    if (pad.some((v) => v)) l.pad = pad;
    if (n.primaryAxisAlignItems && n.primaryAxisAlignItems !== "MIN") l.mainAlign = n.primaryAxisAlignItems;
    if (n.counterAxisAlignItems && n.counterAxisAlignItems !== "MIN") l.crossAlign = n.counterAxisAlignItems;
    if (n.primaryAxisSizingMode) l.mainSizing = n.primaryAxisSizingMode;
    if (n.counterAxisSizingMode) l.crossSizing = n.counterAxisSizingMode;
    o.layout = l;
  }
  if ("layoutSizingHorizontal" in n) {
    const sizing = {};
    if (n.layoutSizingHorizontal && n.layoutSizingHorizontal !== "FIXED") sizing.h = n.layoutSizingHorizontal;
    if (n.layoutSizingVertical && n.layoutSizingVertical !== "FIXED") sizing.v = n.layoutSizingVertical;
    if (Object.keys(sizing).length) o.sizing = sizing;
  }
  if (n.layoutAlign && n.layoutAlign !== "INHERIT") o.align = n.layoutAlign;
  if (n.layoutGrow) o.grow = n.layoutGrow;
  if (n.clipsContent === false) o.clips = false;
  if ("minWidth" in n && (n.minWidth != null || n.maxWidth != null)) {
    o.limits = {};
    if (n.minWidth != null) o.limits.minW = n.minWidth;
    if (n.maxWidth != null) o.limits.maxW = n.maxWidth;
    if (n.minHeight != null) o.limits.minH = n.minHeight;
    if (n.maxHeight != null) o.limits.maxH = n.maxHeight;
  }
  if ("constraints" in n && (n.constraints.horizontal !== "MIN" || n.constraints.vertical !== "MIN")) {
    o.constraints = n.constraints;
  }

  // заливки, обводки, углы, эффекты
  if ("fills" in n && Array.isArray(n.fills) && n.fills.length) {
    o.fills = n.fills.map((f) => {
      const r = { type: f.type };
      if (f.visible === false) r.hidden = true;
      if (f.opacity != null && f.opacity !== 1) r.opacity = f.opacity;
      if (f.blendMode && f.blendMode !== "NORMAL") r.blend = f.blendMode;
      if (f.type === "SOLID") r.color = rgba(f.color);
      if (f.type === "IMAGE") {
        r.imageHash = f.imageHash;
        r.scaleMode = f.scaleMode;
        if (f.scalingFactor && f.scalingFactor !== 1) r.scalingFactor = f.scalingFactor;
        if (f.imageTransform) r.transform = f.imageTransform;
        if (f.filters) {
          const on = Object.fromEntries(Object.entries(f.filters).filter(([, v]) => v));
          if (Object.keys(on).length) r.filters = on;
        }
      }
      if (f.gradientStops) r.stops = f.gradientStops.map((s) => ({ at: s.position, color: rgba(s.color) }));
      if (f.type && f.type.startsWith("GRADIENT")) r.handles = f.gradientHandlePositions;
      return r;
    });
  }
  if ("strokes" in n && Array.isArray(n.strokes) && n.strokes.length) {
    o.strokes = n.strokes.map((s) => ({ type: s.type, color: rgba(s.color), opacity: s.opacity }));
    o.strokeWeight = n.strokeWeight;
    if (n.strokeAlign && n.strokeAlign !== "INSIDE") o.strokeAlign = n.strokeAlign;
    if (n.strokeDashes?.length) o.strokeDashes = n.strokeDashes;
  }
  if ("cornerRadius" in n) {
    const r = n.cornerRadius;
    const corners = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
    if (typeof r === "number" && r) o.radius = r;
    else if (corners.some((v) => v)) o.radius = corners;
  }
  if ("effects" in n && Array.isArray(n.effects) && n.effects.length) {
    o.effects = n.effects.map((e) => ({
      type: e.type,
      visible: e.visible !== false ? undefined : false,
      color: rgba(e.color),
      offset: e.offset ? { x: e.offset.x, y: e.offset.y } : undefined,
      radius: e.radius,
      spread: e.spread || undefined,
    }));
  }

  // текст
  if (n.type === "TEXT") {
    o.text = n.characters;
    o.font = {
      family: n.fontName?.family,
      style: n.fontName?.style,
      size: n.fontSize,
      lineHeight: n.lineHeight,
      letterSpacing: n.letterSpacing,
    };
    if (n.textAlignHorizontal && n.textAlignHorizontal !== "LEFT") o.textAlign = n.textAlignHorizontal;
    if (n.textAlignVertical && n.textAlignVertical !== "TOP") o.textAlignV = n.textAlignVertical;
    if (n.textCase && n.textCase !== "ORIGINAL") o.textCase = n.textCase;
    if (n.textDecoration && n.textDecoration !== "NONE") o.textDecoration = n.textDecoration;
    if (n.textAutoResize && n.textAutoResize !== "NONE") o.autoResize = n.textAutoResize;
    if (n.paragraphSpacing) o.paragraphSpacing = n.paragraphSpacing;
    if (n.paragraphIndent) o.paragraphIndent = n.paragraphIndent;
    if (n.textStyleId) o.textStyleId = n.textStyleId;
  }

  // Компоненты и инстансы. mainComponent под documentAccess: dynamic-page
  // недоступен синхронно — доразрешим после обхода через getMainComponentAsync.
  if (n.type === "INSTANCE") {
    instances.push(n);
    const props = n.componentProperties;
    if (props && Object.keys(props).length) {
      o.props = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.value]));
    }
  }
  if (n.type === "COMPONENT_SET") o.componentSet = true;

  // привязки к переменным — связь вёрстки с токенами
  const bound = n.boundVariables;
  if (bound && Object.keys(bound).length) {
    o.bound = Object.fromEntries(
      Object.entries(bound).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => x.id) : v?.id ?? v]),
    );
  }

  nodes.push(o);
  if ("children" in n) for (const c of n.children) dump(c, depth + 1, n.id);
}

const pages = [];
for (const page of figma.root.children) {
  const pageInfo = { id: page.id, name: page.name, frames: [] };
  for (const frame of page.children) {
    pageInfo.frames.push(frame.id);
    dump(frame, 0, page.id);
  }
  pages.push(pageInfo);
}

// Инстансы: имя главного компонента нужен для сопоставления с дизайн-системой.
const byId = new Map(nodes.map((n) => [n.id, n]));
for (const inst of instances) {
  try {
    const mc = await inst.getMainComponentAsync();
    if (mc) byId.get(inst.id).mainComponent = { id: mc.id, name: mc.name };
  } catch {}
}

return {
  meta: {
    fileKey: figma.fileKey ?? null,
    name: figma.root.name,
    readAt: new Date().toISOString(),
    pages: figma.root.children.length,
  },
  variableCollections,
  variables: variableDump,
  styles,
  pages,
  count: nodes.length,
  nodes,
};
