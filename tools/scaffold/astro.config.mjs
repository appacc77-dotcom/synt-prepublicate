import { defineConfig } from 'astro/config';

const dshUrl = process.env.DSH_URL ?? 'http://127.0.0.1:57686';

export default defineConfig({
  // Каталог сборки задаётся окружением: base-сборка («только из макета»)
  // кладёт результат в dist-base, не трогая обычный dist. Иначе проверка
  // слоя пересобирала dist дважды за прогон.
  outDir: process.env.ASTRO_OUT_DIR ?? 'dist',
  build: {
    format: 'file',
  },
  devToolbar: {
    enabled: false,
  },
  server: {
    host: '127.0.0.1',
    port: 4321,
  },
  vite: {
    server: {
      proxy: {
        '/kanban': {
          target: dshUrl,
          changeOrigin: true,
        },
      },
    },
  },
});
