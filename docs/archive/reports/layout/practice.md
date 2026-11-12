# practice — «Пространство практики»

- карточка: `Page · Пространство практики`
- Figma: `practice/main` (1440×9291 по extracted)
- файлы: `src/pages/practice.astro`, `PracticeHero`, `PracticeInfo`,
  `PracticeFree`, `PracticeCardFree`, `PracticePay`, `PracticeCardPay`,
  `PracticeCodes`, `PracticePackages`, `PracticePackageCard`, `PracticeQuiz`,
  `PracticeSectionHead`, `PracticeSoundroadMin`
- данные: `src/data/practice.ts`; ассеты `public/img/practice-*`, иконки

## Проверено

| Проверка | 1440 | 390 |
|---|---:|---:|
| страница | 9292 | 14287 |
| hero | 900 | 620 |
| free | 916 | 754 |
| quiz | 550 | 381 |
| pay | 2001 | 4092 |
| codes | 2078 | 3995 |
| packages | 1533 | 2673 |
| info | 953 | 999 |
| переполнение | нет | нет |
| консоль | 0 | 0 |

- Build: 11 страниц, зелёный; failed images 0.
- Секции собраны по extracted; сумма 9292 против 9291 (+1 px).
- Цены/длительности не подтверждены; взяты из старого проекта.
- Figma main `408:241` и секции экспортированы; полная страница: средняя Δ **11,28**, >16 — **16,53 %**.
