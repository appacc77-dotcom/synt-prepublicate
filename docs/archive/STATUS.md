# STATUS — Syntonia

Дата: 06.11.2026.

## Сделано

- 11 страниц: Home, Method, Masters, Practice, Library, Booking, Quiz,
  Offer, Privacy, Consent, 404.
- Внутренние `/structure.html` и `/progress.html`.
- 43 завершённых блока структуры; 4 todo: journal-start, journal-issue,
  quiz cover, quiz thanks.
- Figma-секции и полные фреймы для всех страниц, где есть Figma.
- Подвал: текстура исправлена, карточка в review.
- Проект перенесён в самостоятельную папку `syntonia/`.

## Доска

| Колонка | Карточек |
|---|---:|
| done | 27 |
| review | 1 |
| progress | 0 |

Review: `Shared · Подвал`.

## Проверки

```bash
npm ci
npx playwright install chromium
npm run build
npm run smoke
npm run audit:paths
```

- build: 13 страниц;
- smoke: 13 страниц × 1440/390, console 0, overflow 0, битых картинок 0;
- audit:paths: 0 абсолютных/соседних путей.

## Открытые хвосты

- приёмка подвала;
- 4 блока структуры без сравнений;
- legal-тексты — заглушки;
- Booking без endpoint;
- Quiz — 4 draft-вопроса;
- цены Practice/Booking не подтверждены;
- journal-выпуски без отдельных страниц;
- аудио в Masters — заглушки.

## Точка входа

- перенос: `docs/PORTABILITY.md`;
- процесс: `docs/system/PROCESS.md`;
- решения: `docs/system/figma/decisions.md`;
- эталоны: `public/structure/figma/`, `design/export/`.
