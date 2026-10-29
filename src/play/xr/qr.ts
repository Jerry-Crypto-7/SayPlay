/**
 * QR kód odkazu ve VR (P67 T5): kóduje knihovna `uqr` (MIT, port kodéru Nayuki), tady je jen volba opravy chyb
 * a kresba do plátna panelu (`XrPanel`). Tmavé moduly na světlém podkladu s tichou zónou 4 moduly, jak ji chce
 * norma – bez ní telefon kód nenajde. Moduly se kreslí na celé pixely plátna, ať mezi sousedními tmavými nevzniknou
 * světlé spáry z vyhlazování.
 *
 * Soubor načítá jen XR chunk (`XrPanel`), do prvního JS telefonu nejde.
 */

import { encode } from 'uqr';

/** Tichá zóna kolem kódu v modulech (norma: aspoň 4). */
export const QUIET = 4;

/**
 * Moduly kódu i s tichou zónou, řádky shora dolů (`true` = tmavý). Oprava `L` dá při téže ploše největší moduly;
 * kde verze kódu unese víc, `boostEcc` ji zvýší zadarmo.
 */
export function qrModules(text: string): readonly (readonly boolean[])[] {
  return encode(text, { ecc: 'L', boostEcc: true, border: QUIET }).data;
}

/** Část 2D kontextu, kterou kresba potřebuje. */
export interface QrPainter {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/**
 * Kód do čtverce plátna (`x`, `y`, `size` v pixelech plátna, bez transformace): světlý čtverec přes celou plochu,
 * na něm tmavé moduly po celých pixelech, kód uprostřed čtverce.
 */
export function paintQr(ctx: QrPainter, modules: readonly (readonly boolean[])[], x: number, y: number, size: number, dark: string, light: string): void {
  const cell = Math.floor(size / modules.length);
  const left = Math.round(x + (size - cell * modules.length) / 2);
  const top = Math.round(y + (size - cell * modules.length) / 2);
  ctx.fillStyle = light;
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = dark;
  modules.forEach((row, my) =>
    row.forEach((on, mx) => {
      if (on) ctx.fillRect(left + mx * cell, top + my * cell, cell, cell);
    }),
  );
}
