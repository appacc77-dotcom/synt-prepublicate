/**
 * Реестр мостов. Новый источник макета = новый модуль рядом + строчка здесь.
 *
 * Модуль обязан отдавать: meta, status, pages, tree, png, timing
 * (контракт — tools/bridges/README.md).
 */
import * as figmaDesktop from './figma-desktop/index.mjs';
import * as figcraftCli from './figcraft-cli/index.mjs';

export const bridges = {
  figma: figmaDesktop,
  figcraft: figcraftCli,
};

export const bridgeList = Object.entries(bridges).map(([id, mod]) => ({
  id,
  title: mod.meta.title,
  requires: mod.meta.requires,
  source: mod.meta.source,
}));

export function bridgeByName(name) {
  const mod = bridges[name];
  if (!mod) {
    throw new Error(`неизвестный мост «${name}»; есть: ${Object.keys(bridges).join(', ')}`);
  }
  return mod;
}
