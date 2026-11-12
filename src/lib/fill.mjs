/**
 * Перевод заливки-картинки из Figma в CSS-фон.
 *
 * В файле у изображения два режима:
 *   FILL  — вписать с обрезкой по центру: `cover` + центр;
 *   CROP  — рамка вырезает кусок по матрице `imageTransform` [[a,0,e],[0,d,f]].
 *           Размер фона — величина, обратная масштабу (1/a и 1/d), а позиция —
 *           смещение, делённое на свободное место: e/(1−a) и f/(1−d).
 *
 * Путать масштаб и обратную величину уже приходилось: в `method-cta` из-за
 * этого фото сжималось в полоску (пиксель 36,22 против 1,73).
 */

/** @param {{ scaleMode?: string, imageTransform?: number[][], url: string }} fill */
export function backgroundOf(fill) {
  const url = `url('${fill.url}')`;
  const mode = fill.scaleMode ?? 'FILL';
  const m = fill.imageTransform;

  if (mode !== 'CROP' || !m) {
    return `${url} center / cover no-repeat`;
  }

  const a = m[0][0] || 1;
  const d = m[1][1] || 1;
  const e = m[0][2] ?? 0;
  const f = m[1][2] ?? 0;

  const sizeW = 100 / a;
  const sizeH = 100 / d;
  // При масштабе 1 свободного места нет — позиция не определена, берём 0.
  const posX = a < 1 ? (e / (1 - a)) * 100 : 0;
  const posY = d < 1 ? (f / (1 - d)) * 100 : 0;

  return `${url} ${posX.toFixed(2)}% ${posY.toFixed(2)}% / ${sizeW.toFixed(2)}% ${sizeH.toFixed(2)}% no-repeat`;
}
