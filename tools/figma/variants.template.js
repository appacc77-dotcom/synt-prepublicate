/**
 * Находит все состояния секции в файле и их различия.
 *
 * Зачем: секция живёт в файле не в одном виде. У `formats` пять инстансов —
 * по одному на активный формат, и у каждого своя картинка слайдера, свой
 * счётчик и свои описания вкладок. Выгрузка одного инстанса даёт одно
 * состояние, и всё, что отличается в остальных, теряется молча.
 *
 * Возвращает: имя секции, число состояний и различия каждого состояния
 * с первым — по картинкам, текстам и свойствам инстансов.
 */
const id = "__ID__";
const base = await figma.getNodeByIdAsync(id);
if (!base) return { error: "not found" };

function collect(node) {
  const acc = { texts: [], images: [], props: [] };
  const walk = (n) => {
    if (n.type === "TEXT") acc.texts.push({ name: n.name, text: n.characters });
    // У части узлов fills — не массив: проверяем, как в read-section.
    const fills = Array.isArray(n.fills) ? n.fills : [];
    const fill = fills.find((f) => f.type === "IMAGE");
    if (fill) acc.images.push({ name: n.name, hash: fill.imageHash });
    if (n.type === "INSTANCE" && n.componentProperties) {
      const props = {};
      for (const [key, value] of Object.entries(n.componentProperties)) props[key] = value.value;
      acc.props.push({ name: n.name, props });
    }
    for (const child of n.children || []) walk(child);
  };
  walk(node);
  return acc;
}

// Одноимённые узлы того же типа по всему файлу: страницы у секций разные.
const twins = [];
for (const page of figma.root.children) {
  for (const node of page.findAll((n) => n.name === base.name && n.type === base.type && n.id !== base.id)) {
    twins.push(node);
  }
}

const states = [{ id: base.id, acc: collect(base) }];
for (const twin of twins) states.push({ id: twin.id, acc: collect(twin) });

const primary = states[0].acc;

const diffs = states.map((state) => {
  const images = [];
  const texts = [];
  const props = [];

  for (let i = 0; i < state.acc.images.length; i += 1) {
    const mine = state.acc.images[i];
    const other = primary.images[i];
    if (other && other.hash !== mine.hash) images.push({ name: mine.name, from: other.hash, to: mine.hash });
  }
  for (let i = 0; i < state.acc.texts.length; i += 1) {
    const mine = state.acc.texts[i];
    const other = primary.texts[i];
    if (other && other.text !== mine.text) texts.push({ name: mine.name, from: other.text, to: mine.text });
  }
  for (let i = 0; i < state.acc.props.length; i += 1) {
    const mine = state.acc.props[i];
    const other = primary.props[i];
    if (!other) continue;
    const changed = {};
    for (const key of Object.keys(mine.props)) {
      if (other.props[key] !== mine.props[key]) changed[key] = { from: other.props[key], to: mine.props[key] };
    }
    if (Object.keys(changed).length) props.push({ name: mine.name, changed });
  }

  return { id: state.id, images, texts, props };
});

return {
  name: base.name,
  nodeId: base.id,
  total: states.length,
  states: diffs,
};
