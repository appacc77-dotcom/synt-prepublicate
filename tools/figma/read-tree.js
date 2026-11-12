// Read-only: full subtree with layout, visibility, text, fills.
const ROOT_ID = "79:105";
const MAX_DEPTH = 8;

// dynamic-page: синхронный getStyleById запрещён — заранее читаем имена стилей
const styleNames = new Map();
for (const s of await figma.getLocalTextStylesAsync()) styleNames.set(s.id, s.name);
for (const s of await figma.getLocalPaintStylesAsync()) styleNames.set(s.id, s.name);

function info(n, depth) {
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
    o.fontSize = n.fontSize;
    o.lineHeight = n.lineHeight;
    o.letterSpacing = n.letterSpacing;
  }
  if ("fills" in n && Array.isArray(n.fills) && n.fills.length) {
    o.fills = n.fills.map((f) => ({
      type: f.type,
      visible: f.visible,
      opacity: f.opacity,
      color: f.color ? {
        hex: "#" + [f.color.r, f.color.g, f.color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join(""),
        a: +(f.color.a ?? 1).toFixed(3),
      } : null,
      imageRef: f.imageRef ?? null,
      scaleMode: f.scaleMode ?? null,
      gradientStops: f.gradientStops?.length ?? null,
    }));
  }
  if ("layoutMode" in n && n.layoutMode && n.layoutMode !== "NONE") {
    o.autoLayout = {
      mode: n.layoutMode,
      gap: n.itemSpacing,
      pad: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft],
      primary: n.primaryAxisAlignItems,
      counter: n.counterAxisAlignItems,
    };
  }
  if ("cornerRadius" in n && n.cornerRadius) o.radius = n.cornerRadius;
  return o;
}

const root = await figma.getNodeByIdAsync(ROOT_ID);
if (!root) return { error: "E_NOT_FOUND", id: ROOT_ID };

const out = [];
function walk(n, depth) {
  out.push(info(n, depth));
  if (depth >= MAX_DEPTH) return;
  if ("children" in n) for (const c of n.children) walk(c, depth + 1);
}
walk(root, 0);
return { root: ROOT_ID, count: out.length, nodes: out };
