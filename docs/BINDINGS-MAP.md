# Файл-сопоставление: Figma desktop ↔ FigCraft

Сгенерирован: 2026-11-14T18:17:46.462Z. Архив: `Website Syntonia-2.fig`.
Машинная версия: `reports/bindings-map.json`.

## Что сравнивается

Узлы сопоставляются по **пути из имён** (id у мостов разные, они не совпадают). У каждого узла
сравнивается **набор имён токенов**, на которые он ссылается: словари свойств у мостов разные
(`fills`/`fill`, `itemSpacing`/`gap`, `paddingLeft`+`paddingRight`/`paddingHorizontal`), а токены одни.

## Итог

| Метрика | Значение |
|---|---:|
| узлов: Figma / FigCraft | 2118 / 2174 |
| сопоставлено узлов | 2116 |
| из них с токенами | 1709 |
| наборы токенов совпали | **1426** |
| расхождений | **283** |
| ссылок на токены: Figma / FigCraft | 2291 / 1940 |
| неразрешённых id у Figma / у FigCraft | 0 / 0 |
| имён токенов добрано живым мостом | 38 |

## Как читать расхождения

| Класс | Узлов |
|---|---:|
| узел внутри инстанса Figma (id вида `I…`) — FigCraft раскрывает инстанс одним узлом и привязки нутра не отдаёт | 143 |
| у FigCraft на узле нет ни одного токена, хотя Figma видит | 113 |
| у FigCraft токен есть, у Figma нет | 5 |
| наборы частично совпали, часть токенов разная | 22 |

Потерянные токены (только у Figma): space-s ×101, space-m ×94, space-l ×45, radius-s ×43, space-xs ×23, radius-l ×23, space-xl ×19, container-max ×15

Лишние (только у FigCraft): space-xl ×8, space-2xl ×8, space-s ×7, space-xs ×7, space-l ×5, space-5xl ×4, space-3xl ×4, radius-m ×2

## Словарь токенов

| | Figma | FigCraft |
|---|---:|---:|
| переменных | 41 | 40 |
| только у Figma | 1 | — |
| только у FigCraft | — | 0 |

Только у Figma: bg-selected

## По секциям

| секция | узлов Figma/FigCraft | сопоставлено | с токенами | совпало | расхождения |
|---|---:|---:|---:|---:|---:|
| design-system/logo-gold (нет пути) | 0/0 | 0 | 0 | 0 | 0 |
| home/about-founder | 21/21 | 21 | 19 | 15 | 4 |
| home/air-photo | 1/1 | 1 | 0 | 0 | 0 |
| home/banner-founder | 5/5 | 5 | 5 | 3 | 2 |
| home/entry | 23/23 | 23 | 21 | 18 | 3 |
| home/faq | 52/52 | 52 | 33 | 23 | 10 |
| home/footer | 31/31 | 31 | 29 | 26 | 3 |
| home/formats | 76/77 | 76 | 71 | 49 | 22 |
| home/header | 29/29 | 29 | 23 | 20 | 3 |
| home/hero | 14/14 | 14 | 11 | 10 | 1 |
| home/library | 18/18 | 18 | 16 | 13 | 3 |
| home/method | 16/16 | 16 | 13 | 12 | 1 |
| home/pain | 34/34 | 34 | 31 | 29 | 2 |
| home/process | 25/25 | 25 | 21 | 17 | 4 |
| home/quiz | 17/17 | 17 | 14 | 12 | 2 |
| home/voices | 70/70 | 70 | 52 | 40 | 12 |
| masters/footer | 31/31 | 31 | 29 | 26 | 3 |
| masters/founder-hero | 66/70 | 66 | 55 | 42 | 13 |
| masters/header | 29/29 | 29 | 23 | 20 | 3 |
| masters/masters-more | 38/38 | 38 | 32 | 26 | 6 |
| masters/masters-team | 56/56 | 56 | 45 | 40 | 5 |
| library/footer | 31/31 | 31 | 29 | 26 | 3 |
| library/header | 29/29 | 29 | 23 | 20 | 3 |
| library/library-book | 15/15 | 15 | 13 | 10 | 3 |
| library/library-hero | 10/10 | 10 | 8 | 7 | 1 |
| library/library-issues | 59/63 | 59 | 46 | 36 | 10 |
| library/library-journal | 18/18 | 18 | 16 | 10 | 6 |
| practice/footer | 31/31 | 31 | 29 | 26 | 3 |
| practice/hero | 33/33 | 33 | 26 | 23 | 3 |
| practice/info-section | 35/35 | 35 | 25 | 25 | 0 |
| practice/kody-practice-pay | 249/249 | 249 | 177 | 161 | 16 |
| practice/practice-free | 112/112 | 112 | 88 | 84 | 4 |
| practice/practice-package | 119/119 | 119 | 92 | 92 | 0 |
| practice/practice-pay | 220/249 | 220 | 157 | 143 | 14 |
| practice/quiz | 19/19 | 19 | 12 | 12 | 0 |
| quiz/footer | 31/31 | 31 | 29 | 26 | 3 |
| quiz/header | 29/29 | 29 | 23 | 19 | 4 |
| quiz/quiz-result | 56/56 | 54 | 44 | 21 | 23 |
| quiz/quiz-section | 83/83 | 83 | 61 | 22 | 39 |
| booking/booking-formats | 130/144 | 130 | 127 | 109 | 18 |
| booking/booking-hero | 5/5 | 5 | 5 | 2 | 3 |
| booking/footer | 31/31 | 31 | 29 | 26 | 3 |
| booking/header | 29/29 | 29 | 23 | 20 | 3 |
| method/footer | 31/31 | 31 | 29 | 26 | 3 |
| method/header | 29/29 | 29 | 23 | 20 | 3 |
| method/method-about | 18/18 | 18 | 18 | 9 | 9 |
| method/method-cta | 10/14 | 10 | 10 | 7 | 3 |
| method/method-hero | 4/4 | 4 | 4 | 3 | 1 |

## Где расходятся (топ по числу узлов)

### quiz/quiz-section — 39 узлов

- `Quiz/quiz/quiz-section` — только у Figma: space-3xl, space-5xl
- `Quiz/quiz/quiz-section/container` — только у Figma: space-l
- `Quiz/quiz/quiz-section/container/text-block` — только у Figma: space-m
- `Quiz/quiz/quiz-section/container/text-block/container` — только у Figma: space-s
- `Quiz/quiz/quiz-section/container/text-block/text-logos` — только у Figma: space-l
- `Quiz/quiz/quiz-section/container/text-block/text-logos/time` — только у Figma: space-xs

### quiz/quiz-result — 23 узлов

- `Quiz/quiz-result-pain-short/quiz-section` — только у Figma: space-5xl
- `Quiz/quiz-result-pain-short/quiz-section/container` — только у Figma: space-2xl, space-l
- `Quiz/quiz-result-pain-short/quiz-section/container/result-section/text-block` — только у Figma: space-m
- `Quiz/quiz-result-pain-short/quiz-section/container/result-section/result-block` — только у Figma: radius-l, space-m, space-xl
- `Quiz/quiz-result-pain-short/quiz-section/container/result-section/result-block/description` — только у Figma: space-2xl, space-m
- `Quiz/quiz-result-pain-short/quiz-section/container/result-section/result-block/description/about` — только у Figma: space-l

### home/formats — 22 узлов

- `Home/main/formats` — только у Figma: space-l
- `Home/main/formats/formats-panel/formats-tabs/format-tab` — только у Figma: radius-m, space-m
- `Home/main/formats/formats-panel/formats-tabs/format-tab/tab-head` — только у Figma: space-s
- `Home/main/formats/formats-panel/formats-tabs/format-tab/tab-meta` — только у Figma: space-s
- `Home/main/formats/formats-panel/formats-tabs/format-tab/btn-primary` — только у Figma: radius-s, space-m, space-s
- `Home/main/formats/formats-panel/formats-tabs/format-tab#2` — только у Figma: space-m, space-s

### booking/booking-formats — 18 узлов

- `Booking/main/booking-formats` — только у Figma: space-l
- `Booking/main/booking-formats/container` — только у Figma: container-max
- `Booking/main/booking-formats/container/booking-layout/booking-list/format-option` — только у Figma: bg-selected, space-s
- `Booking/main/booking-formats/container/booking-layout/booking-list/format-option/option-body` — только у Figma: space-m
- `Booking/main/booking-formats/container/booking-layout/booking-list/format-option#2` — только у Figma: space-s
- `Booking/main/booking-formats/container/booking-layout/booking-list/format-option#2/option-body` — только у Figma: space-m

### practice/kody-practice-pay — 16 узлов

- `Practice/practice-page/kody-practice-pay/container/container/practice-card-pay/description-block/practive-time/soundroad-min` — только у Figma: radius-l, space-m, space-s
- `Practice/practice-page/kody-practice-pay/container/container/practice-card-pay/description-block/action/btn-primary` — только у Figma: radius-s, space-m, space-s
- `Practice/practice-page/kody-practice-pay/container/container/practice-card-pay#2/description-block/practive-time/soundroad-min` — только у Figma: radius-l, space-m, space-s
- `Practice/practice-page/kody-practice-pay/container/container/practice-card-pay#2/description-block/action/btn-primary` — только у Figma: radius-s, space-m, space-s
- `Practice/practice-page/kody-practice-pay/container/container#2/practice-card-pay/description-block/practive-time/soundroad-min` — только у Figma: radius-l, space-m, space-s
- `Practice/practice-page/kody-practice-pay/container/container#2/practice-card-pay/description-block/action/btn-primary` — только у Figma: radius-s, space-m, space-s

### practice/practice-pay — 14 узлов

- `Practice/practice-page/practice-pay/container/container/practice-card-pay/description-block/practive-time/soundroad-min` — только у Figma: radius-l, space-m, space-s
- `Practice/practice-page/practice-pay/container/container/practice-card-pay/description-block/action/btn-primary` — только у Figma: radius-s, space-m, space-s
- `Practice/practice-page/practice-pay/container/container/practice-card-pay#2/description-block/practive-time/soundroad-min` — только у Figma: radius-l, space-m, space-s
- `Practice/practice-page/practice-pay/container/container/practice-card-pay#2/description-block/action/btn-primary` — только у Figma: radius-s, space-m, space-s
- `Practice/practice-page/practice-pay/container/container#2/practice-card-pay/description-block/practive-time/soundroad-min` — только у Figma: radius-l, space-m, space-s
- `Practice/practice-page/practice-pay/container/container#2/practice-card-pay/description-block/action/btn-primary` — только у Figma: radius-s, space-m, space-s

### masters/founder-hero — 13 узлов

- `Masters/main/founder-hero/founder-photo/founder-content/player/player-row` — только у Figma: space-s
- `Masters/main/founder-hero/founder-aside/founder-panel/founder-accordion` — только у Figma: space-l
- `Masters/main/founder-hero/founder-aside/founder-panel/founder-accordion/bio-item` — только у Figma: space-m; только у FigCraft: space-l
- `Masters/main/founder-hero/founder-aside/founder-panel/founder-accordion/bio-item/bio-head/bio-label` — только у Figma: space-s
- `Masters/main/founder-hero/founder-aside/founder-panel/founder-accordion/bio-item/bio-text` — только у Figma: space-m
- `Masters/main/founder-hero/founder-aside/founder-panel/founder-accordion/bio-item#2` — только у Figma: space-m; только у FigCraft: space-l

### home/voices — 12 узлов

- `Home/main/voices` — только у Figma: space-l
- `Home/main/voices/container` — только у Figma: container-max, space-3xl
- `Home/main/voices/container/voices-heading` — только у Figma: space-s
- `Home/main/voices/container/voices-track` — только у Figma: space-2xl
- `Home/main/voices/container/voices-track/voice-card` — только у Figma: space-l
- `Home/main/voices/container/voices-track/voice-card/voice-body` — только у Figma: space-l

