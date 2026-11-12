// Read-only P1 reality: scaled instances, style definitions, frame widths.
await figma.loadAllPagesAsync();

const rgba = (c) => {
  if (!c) return null;
  if (c.type === 'VARIABLE_ALIAS') return { alias: c.id };
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return { hex: `#${h(c.r)}${h(c.g)}${h(c.b)}`, a: +(c.a ?? 1).toFixed(3) };
};

// 1. Scaled / overridden instances
let total = 0;
const scaled = [];
const byPage = {};
for (const p of figma.root.children) {
  const inst = p.findAll((n) => n.type === 'INSTANCE');
  byPage[p.name] = inst.length;
  total += inst.length;
  for (const n of inst) {
    const t = n.absoluteTransform;
    const sx = Math.hypot(t[0][0], t[1][0]);
    const sy = Math.hypot(t[0][1], t[1][1]);
    if (Math.abs(sx - 1) > 0.002 || Math.abs(sy - 1) > 0.002) {
      if (scaled.length < 40) {
        scaled.push({ id: n.id, name: n.name, page: p.name, sx: +sx.toFixed(3), sy: +sy.toFixed(3) });
      }
    }
  }
}

// 2. Text styles, full definition
const textStyles = (await figma.getLocalTextStylesAsync()).map((s) => ({
  id: s.id,
  name: s.name,
  font: s.fontName,
  size: s.fontSize,
  lineHeight: s.lineHeight,
  letterSpacing: s.letterSpacing,
  textCase: s.textCase,
  fills: s.fills?.map((f) => ({ type: f.type, color: rgba(f.color), opacity: f.opacity })),
}));

// 3. Paint styles
const paintStyles = (await figma.getLocalPaintStylesAsync()).map((s) => ({
  id: s.id,
  name: s.name,
  paints: s.paints?.map((p) => ({
    type: p.type,
    color: rgba(p.color),
    opacity: p.opacity,
    gradientTransform: p.gradientTransform,
    stops: p.gradientStops?.map((g) => ({ position: +g.position.toFixed(3), color: rgba(g.color) })),
  })),
}));

// 4. Frame widths (adaptivity signal)
const widths = {};
for (const p of figma.root.children) {
  for (const f of p.children) {
    if (f.type === 'FRAME') widths[Math.round(f.width)] = (widths[Math.round(f.width)] || 0) + 1;
  }
}

return {
  file: { name: figma.root.name },
  instances: { total, byPage, scaledCount: scaled.length, scaled },
  textStyles,
  paintStyles,
  topLevelWidths: widths,
};
