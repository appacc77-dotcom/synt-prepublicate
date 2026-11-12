---
id: ds-btn-primary
unit: component            # component | section | page
figma_set: btn-primary     # имя набора в Figma, 1:1
figma_node: "1234:5678"    # узел или инстанс-эталон
figma_version: "2417384741313174684"  # из extracted/manifest.json
page: home                 # страница-потребитель (для section)
spec: spec/home.json#/components/btn-primary
crop: crops/btn-primary.png
files:
  - src/components/ds/btn-primary.astro
  - src/pages/ds.astro
gate: npm run ds:check -- --only btn-primary
content_status: confirmed  # confirmed | placeholder — placeholder блокирует публикацию, не вёрстку
assignee: agent            # agent | human
status: backlog            # backlog | process | review | done
priority: high
depends_on: []
---

# {{Название карточки}}

## Задача

Одно-два предложения: что должно появиться и зачем. Без «улучшить» и «привести
в порядок» — только проверяемый результат.

## Definition of Ready

- [ ] узел Figma существует и это канонический фрейм;
- [ ] `figma_version` в карточке совпадает с `extracted/manifest.json`;
- [ ] срез spec собран, масштаб и override разрешены (эталон — холст, не дерево);
- [ ] кроп вырезан из рендера канваса 1:1;
- [ ] строка в `inventory.md` есть;
- [ ] открытых 🔴 в `decisions.md` по единице нет;
- [ ] команда приёмки существует и сейчас красная (или её нет — тогда это
      инфраструктурная карточка, а не вёрстка);
- [ ] список `files:` полный; всё остальное — «вне задачи».

Если хоть один пункт не выполнен — карточка не берётся в работу. Это не
бюрократия: именно на этих пунктах первая сессия потеряла последние часы.

Масштабированный или переопределённый узел не блокирует карточку, если решение
по нему записано (например, «нормализуем к ближайшему варианту, отклонение
0,7 px»). Блокирует именно отсутствие решения.

## Заметки

- что уже пробовали и почему не сработало;
- ссылки на решения и отчёты;
- известные ловушки файла (из каталога «файл врёт»).

## Результат

Заполняет приёмка после ворот, не автор:

- [ ] G1/G2 зелёный: <команда> → <числа>;
- [ ] отчёт: `reports/layout/<id>.md`;
- [ ] вердикт: `green` / `red` (дефекты — в карточку).
