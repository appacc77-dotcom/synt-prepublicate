/**
 * Сверяет цвета в спеке со значениями переменных в файле.
 *
 * Зачем: заливка и штрих могут быть привязаны к переменной, и тогда действует
 * её значение, а не цвет краски. Один раз это уже стоило 164 непрозрачных узлов:
 * карточка отзыва должна была просвечивать (0.35), а рисовалась белой.
 *
 * На вход — список узлов, у которых в спеке есть привязка. Возвращает только
 * расхождения: где ожидаемый цвет не совпал с тем, что даёт переменная.
 */
// Узлы лежат на разных страницах, а открыта одна. Без загрузки страниц
// getNodeByIdAsync на чужой странице тянет сеть и падает с «Unable to
// establish connection to Figma after 10 seconds».
await figma.loadAllPagesAsync();

const items = __PAYLOAD__;

/**
 * Узел по id. Прямое чтение ребёнка инстанса (`I383:916;383:835`) тянет из
 * сети главный компонент и падает с «Unable to establish connection to Figma».
 * Тогда идём от инстанса по детям — это локальная операция.
 */
async function resolveNode(id) {
  let failure = null;
  try {
    const node = await figma.getNodeByIdAsync(id);
    if (node) return node;
  } catch (error) {
    failure = error;
  }
  if (!id.includes(";")) {
    // Узел не найден по-настоящему — это расхождение, а не сбой связи.
    if (failure) throw failure;
    return null;
  }
  const parts = id.replace(/^I/, "").split(";");
  let node = null;
  try {
    node = await figma.getNodeByIdAsync(parts[0]);
  } catch (error) {
    throw error;
  }
  for (const part of parts.slice(1)) {
    if (!node) return null;
    const children = node.children || [];
    node = children.find((c) => c.id === part || c.id.endsWith(`;${part}`)) ?? null;
  }
  return node;
}
const out = [];
// skipped — узлы, которые не удалось сверить по существу: привязки в файле нет
// или значение переменной не цвет (например, ссылка на другую переменную).
// Раньше они молча входили в «проверено».
const skipped = [];
let verified = 0;
// Переменная одна и та же у десятков узлов: без кэша каждый узел делает
// отдельный запрос к плагину и пачка не укладывается в бюджет вызова.
const variableCache = new Map();

for (const item of items) {
  let node = null;
  try {
    node = await resolveNode(item.id);
  } catch (error) {
    // Сбой связи не должен выглядеть как «узел пропал»: пусть пачка упадёт
    // и повторится, а не запишет ложное расхождение.
    throw error;
  }
  if (!node) {
    out.push({ id: item.id, kind: item.kind, index: item.index, error: "узел не найден" });
    continue;
  }
  const bound = (node.boundVariables && node.boundVariables[item.kind]) || [];
  const alias = bound[item.index];
  if (!alias) {
    skipped.push({ id: item.id, kind: item.kind, index: item.index, reason: "no-binding" });
    continue;
  }

  try {
    let variable = variableCache.get(alias.id);
    if (variable === undefined) {
      variable = await figma.variables.getVariableByIdAsync(alias.id);
      variableCache.set(alias.id, variable);
    }
    const modes = variable && variable.valuesByMode;
    let value = modes && modes[Object.keys(modes)[0]];
    // Переменная может ссылаться на другую переменную (alias-chain). Разрешаем
    // цепочку до цвета, но не глубже пяти шагов: иначе легко уйти в цикл.
    let hops = 0;
    while (value && typeof value === "object" && value.type === "VARIABLE_ALIAS" && hops < 5) {
      const next = await figma.variables.getVariableByIdAsync(value.id);
      const nextModes = next && next.valuesByMode;
      value = nextModes && nextModes[Object.keys(nextModes)[0]];
      hops += 1;
    }
    if (!value || typeof value !== "object" || !("r" in value)) {
      const reason = hops >= 5 ? "alias-chain-too-deep" : "not-color";
      skipped.push({ id: item.id, kind: item.kind, index: item.index, reason, variable: variable && variable.name });
      continue;
    }
    verified += 1;

    const h = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
    const actual = { hex: `#${h(value.r)}${h(value.g)}${h(value.b)}`, a: +(value.a ?? 1).toFixed(3) };
    const same = actual.hex.toLowerCase() === String(item.expected.hex).toLowerCase()
      && Math.abs(actual.a - item.expected.a) < 0.01;
    if (!same) {
      out.push({
        id: item.id,
        kind: item.kind,
        index: item.index,
        variable: variable.name,
        expected: item.expected,
        actual,
      });
    }
  } catch (error) {
    out.push({ id: item.id, kind: item.kind, index: item.index, error: String(error && error.message).slice(0, 80) });
  }
}

return { checked: verified, total: items.length, skipped, mismatches: out };
