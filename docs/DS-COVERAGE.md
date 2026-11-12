# Набор компонентов: покрытие (E-02)

В файле **54** компонентов, в вёрстке **6** (`src/components/ds/`). Осталось **47**.

## Собрано

- `arrow-quiet`
- `btn-primary`
- `btn-quiet`
- `btn-secondary`
- `list-item`
- `play`

## Не собрано

| компонент | примечание |
|---|---|
| `logo-gold` | — |
| `logo-gold-gradient` | логотип: три варианта из файла |
| `logo-evolution-gold-gradient` | логотип: вариант эволюции |
| `logo-evolution` | логотип: вариант эволюции |
| `stage-card` | — |
| `dot-leaf` | — |
| `quote-mark` | — |
| `voice-card` | — |
| `arrow-quiet 90` | повёрнутый инстанс того же компонента — не отдельная карточка |
| `arrow-quiet 180` | повёрнутый инстанс — не отдельная карточка |
| `faq-item` | — |
| `footer` | общий блок: уже собран как компонент страницы, не в ds/ |
| `burger` | мобильное меню — слой дополнений |
| `header` | — |
| `btn-login` | — |
| `arrow-quiet white` | — |
| `sound` | — |
| `bio-item` | — |
| `sun-vabisabi` | — |
| `divider-sun` | — |
| `player` | — |
| `master-card` | — |
| `link-card` | — |
| `journal-card` | — |
| `accept` | — |
| `format-option` | — |
| `form-field` | — |
| `practice-card-free` | — |
| `practice-card-pay` | — |
| `accordeon` | — |
| `watch` | — |
| `soundwave` | — |
| `soundroad-min` | — |
| `gift` | — |
| `round` | — |
| `option-item` | — |
| `quiz-card` | — |
| `get-practice` | — |
| `cancel` | — |
| `thanks` | — |
| `format-tab` | — |
| `slider-arrow` | — |
| `booking-details` | — |
| `btn-submit` | — |
| `breadcrumbs` | — |
| `toc-item` | — |
| `article-head` | — |

## Что это значит

Из 48 «не собранных» несколько не являются отдельными компонентами:
повёрнутые инстансы (`arrow-quiet 90/180`) — это один компонент с поворотом,
`footer` уже есть как компонент страницы, `burger` относится к слою дополнений.
Реальный объём меньше и требует сверки с файлом, а она сейчас невозможна:
мост отключён (Figma закрыта).

Приёмка каждой карточки по плану — `measure` по компоненту зелёный.

## Закрыто решением 378

Сборку остальных наборов не делаем: это инвентаризация, страницы их не
используют, пиксель для компонентов не работает. Порядок сборки проверен на
`logo-gold` и записан в `docs/DS-HARNESS.md`.
