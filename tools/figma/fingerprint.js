// Отпечаток секции на стороне моста. __NODE_ID__ подставляет экспортёр.
// Считается ровно так же, как в export-section.mjs: id|x|y|w|h|текст.
const root = await figma.getNodeByIdAsync("__NODE_ID__");
if (!root) return { error: "E_NOT_FOUND", id: "__NODE_ID__" };

const lines = [];
function walk(n) {
  lines.push(
    [n.id, Math.round(n.x), Math.round(n.y), Math.round(n.width), Math.round(n.height), n.type === "TEXT" ? n.characters : ""].join("|"),
  );
  if ("children" in n) for (const c of n.children) walk(c);
}
walk(root);

// Тот же SHA-1 через WebCrypto недоступен синхронно, поэтому считаем простую
// контрольную сумму и отдаём её — сравнение идёт с той же функцией в Node.
let h1 = 0x811c9dc5;
for (const line of lines) {
  for (let i = 0; i < line.length; i++) {
    h1 ^= line.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  h1 ^= 10;
  h1 = Math.imul(h1, 0x01000193) >>> 0;
}

return { fingerprint: h1.toString(16).padStart(8, "0"), count: lines.length };
