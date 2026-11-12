// Отпечатки всех секций за один вызов моста.
// __IDS__ подставляет список id узлов (JSON-массив).
// Формула та же, что в export-section.mjs и tools/figma/fingerprint.js.
const ids = __IDS__;
const out = {};

for (const id of ids) {
  const root = await figma.getNodeByIdAsync(id);
  if (!root) {
    out[id] = null;
    continue;
  }
  let h = 0x811c9dc5;
  let count = 0;
  const walk = (n) => {
    count++;
    const line = [
      n.id,
      Math.round(n.x),
      Math.round(n.y),
      Math.round(n.width),
      Math.round(n.height),
      n.type === "TEXT" ? n.characters : "",
    ].join("|");
    for (let i = 0; i < line.length; i++) {
      h ^= line.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 10;
    h = Math.imul(h, 0x01000193) >>> 0;
    if ("children" in n) for (const c of n.children) walk(c);
  };
  walk(root);
  out[id] = { fingerprint: h.toString(16).padStart(8, "0"), count };
}

return out;
