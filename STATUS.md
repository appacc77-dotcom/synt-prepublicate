# STATUS — Syntonia

Работаем **только через живой мост** `figma-agent`: файл «Website Syntonia2»,
`fileKey NInjODHyOOjIitF3lq4Vpe`, открытый в Figma desktop.

## Объём

Объём выводится из экспорта (`design/figma/pages/**`, решение 353): все семь
страниц файла — home, practice, library, masters, method, booking, quiz.
Адрес каждой страницы — `design/figma/project.json` → `routes`.
Мобильных макетов нет: только 1440 (решения 2, 186; долг D-2).

## Секции

Блок ниже собирается из артефактов: `node tools/status.mjs --write`.
Числа — из `gate.json` и `pixel.json` рядом с секцией, последнего прогона
`reports/runs/latest` и реестров. Руками не правится.

<!-- status:start -->
секций собрано: **48** из 49, красных: 1

| секция | геометрия | узлов | пиксель | > 16 | > 48 |
|---|---:|---:|---:|---:|---:|
| book/book-hero | зелёная | 12 | — | — | — |
| booking/booking-formats | зелёная | 21 | 9.28 | 10.18 % | 8.59 % |
| booking/header | зелёная | 14 | 4.08 | 5.77 % | 1.93 % |
| booking/booking-hero | зелёная | 5 | 3.87 | 4.08 % | 0.34 % |
| booking/footer | зелёная | 31 | 1.04 | 1.22 % | 0.44 % |
| design-system/logo-gold | **0 красных** | 0 | 229.66 | 100.00 % | 100.00 % |
| home/voices | зелёная | 35 | 13.23 | 23.30 % | 6.43 % |
| home/air-photo | зелёная | 1 | 5.91 | 0.38 % | 0.00 % |
| home/faq | зелёная | 32 | 5.41 | 2.89 % | 1.82 % |
| home/entry | зелёная | 17 | 5.10 | 11.24 % | 1.15 % |
| home/pain | зелёная | 29 | 4.14 | 3.43 % | 1.91 % |
| home/header | зелёная | 14 | 3.83 | 5.94 % | 1.97 % |
| home/formats | зелёная | 24 | 3.71 | 4.98 % | 1.65 % |
| home/banner-founder | зелёная | 5 | 3.06 | 2.02 % | 0.66 % |
| home/process | зелёная | 25 | 2.56 | 5.46 % | 1.94 % |
| home/quiz | зелёная | 12 | 2.20 | 2.53 % | 1.75 % |
| home/hero | зелёная | 8 | 1.76 | 0.99 % | 0.56 % |
| home/library | зелёная | 15 | 1.48 | 1.04 % | 0.50 % |
| home/about-founder | зелёная | 16 | 1.24 | 1.52 % | 0.45 % |
| home/method | зелёная | 11 | 1.23 | 1.10 % | 0.49 % |
| home/footer | зелёная | 31 | 1.04 | 1.22 % | 0.44 % |
| library/library-journal | зелёная | 14 | 11.17 | 19.36 % | 8.91 % |
| library/library-issues | зелёная | 11 | 6.76 | 15.68 % | 3.49 % |
| library/header | зелёная | 14 | 4.47 | 5.80 % | 1.93 % |
| library/footer | зелёная | 31 | 3.16 | 1.26 % | 0.44 % |
| library/library-book | зелёная | 11 | 2.90 | 3.00 % | 1.20 % |
| library/library-hero | зелёная | 6 | 2.17 | 2.70 % | 0.40 % |
| masters/founder-hero | зелёная | 15 | 12.15 | 33.31 % | 3.02 % |
| masters/masters-more | зелёная | 8 | 4.18 | 2.88 % | 1.13 % |
| masters/header | зелёная | 14 | 3.82 | 5.99 % | 1.90 % |
| masters/masters-team | зелёная | 12 | 1.82 | 2.18 % | 0.65 % |
| masters/footer | зелёная | 31 | 1.04 | 1.22 % | 0.44 % |
| method/method-about | зелёная | 18 | 3.90 | 4.48 % | 3.16 % |
| method/header | зелёная | 14 | 3.75 | 5.84 % | 1.93 % |
| method/method-cta | зелёная | 8 | 1.75 | 1.75 % | 0.70 % |
| method/method-hero | зелёная | 4 | 1.11 | 0.70 % | 0.22 % |
| method/footer | зелёная | 31 | 1.04 | 1.22 % | 0.44 % |
| practice/practice-pay | зелёная | 16 | 12.36 | 32.80 % | 3.64 % |
| practice/kody-practice-pay | зелёная | 16 | 11.85 | 31.43 % | 3.21 % |
| practice/practice-package | зелёная | 9 | 10.91 | 23.96 % | 6.27 % |
| practice/info-section | зелёная | 16 | 9.81 | 11.06 % | 3.82 % |
| practice/practice-free | зелёная | 16 | 9.13 | 10.42 % | 6.86 % |
| practice/hero | зелёная | 18 | 5.46 | 3.07 % | 2.36 % |
| practice/quiz | зелёная | 15 | 2.41 | 1.97 % | 1.39 % |
| practice/footer | зелёная | 31 | 1.04 | 1.22 % | 0.44 % |
| quiz/header | зелёная | 14 | 3.77 | 5.64 % | 1.86 % |
| quiz/quiz-section | зелёная | 16 | 3.22 | 3.27 % | 1.77 % |
| quiz/quiz-result | зелёная | 32 | 2.34 | 2.75 % | 1.53 % |
| quiz/footer | зелёная | 31 | 1.04 | 1.22 % | 0.44 % |

средний пиксель по собранным: **4.53**

последний прогон: `20261112-203241-16169` · **PASS** · full · к выпуску пригоден

изобретённое (`design/figma/invented.json`): **7** записей
долги этапа 1 (`docs/debts.json`): открыто **31** из 38 · designer 28, studio 1, owner 2

### Закрытие этапа 1

готово: блокирующих долгов нет

закрыто 7 из 38 · открыто 31
по типу: figma 26, scope 3, tool 1, site 1
<!-- status:end -->

## Где смотреть остальное

- изобретённое (нет в макете) — `design/figma/invented.json`, анимации — `design/motion/motion.json`;
- долги этапа 1 (вопросы дизайнеру, заказчику, владельцу) — `docs/debts.json`;
- вопросы к файлу Figma — `docs/FIGMA-ISSUES.md`;
- доработки конвейера — `docs/BACKLOG.md` и `docs/AGENT-REFACTOR-TASKS.md`;
- решения — `docs/decisions.md`.
