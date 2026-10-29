/**
 * QR kód výzvy ve VR (P67 T5). Kód, který se načte, ale vede jinam, vypadá na panelu správně – proto se kresba
 * dekóduje zpět nezávislým dekodérem (`jsqr`, závislost jen pro testy) a musí dát přesně tentýž odkaz. Dekodér
 * nesmí zkoušet obrácené barvy: světlý kód na tmavém podkladu telefon nepřečte. Plátno kolem čtverce je schválně
 * tmavé – tichou zónu musí nakreslit kresba sama, ne karta pod ní.
 */

import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';

import { color } from '@/brand/tokens';

import { QUIET, paintQr, qrModules } from '../qr';

/** Plátno jako pole RGBA s `fillRect` v barvě `#rrggbb`, jako 2D kontext prohlížeče; na začátku celé `fill`. */
function canvasOf(width: number, height: number, fill: string) {
  const data = new Uint8ClampedArray(width * height * 4);
  const ctx = {
    fillStyle: fill as string | CanvasGradient | CanvasPattern,
    fillRect(x: number, y: number, w: number, h: number): void {
      const hex = String(ctx.fillStyle);
      const rgba = [...[1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)), 255];
      for (let row = Math.max(0, Math.round(y)); row < Math.min(height, Math.round(y + h)); row += 1) {
        for (let col = Math.max(0, Math.round(x)); col < Math.min(width, Math.round(x + w)); col += 1) data.set(rgba, (row * width + col) * 4);
      }
    },
  };
  ctx.fillRect(0, 0, width, height);
  return { ctx, data, at: (x: number, y: number) => `#${[...data.slice((y * width + x) * 4, (y * width + x) * 4 + 3)].map((part) => part.toString(16).padStart(2, '0')).join('')}` };
}

/** Odkaz, jak ho skládá `XrShare`: hraná verze, značka sdílení a výzva. */
const DARE = 'https://sayplay.example/play/3f9a0c2b7d1e4a68?via=share&dare=0123456789abcdef0123456789abcdef';
/** Nejdelší odkaz, který může vzniknout: id verze 64 znaků a dlouhá adresa náhledu nasazení. */
const LONGEST = `https://sayplay-git-features-p67-vr-nova-uroven.vercel.app/play/${'ab'.repeat(32)}?via=share&dare=${'9f'.repeat(16)}`;
/** Prohraný běh sdílí jen hru, bez výzvy. */
const PLAIN = 'https://sayplay.example/play/3f9a0c2b7d1e4a68?via=share';

/** Čtverec QR na kartě panelu: 200 px kitu × 4 px plátna, posunutý od rohu plátna. */
const SQUARE = { x: 52, y: 37, size: 800 };

describe('the dare link as a QR code', () => {
  it.each([DARE, LONGEST, PLAIN])('decodes back to exactly the link it was made from: %s', (link) => {
    const width = SQUARE.x + SQUARE.size + 30;
    const height = SQUARE.y + SQUARE.size + 30;
    const { ctx, data } = canvasOf(width, height, color.ink);
    paintQr(ctx, qrModules(link), SQUARE.x, SQUARE.y, SQUARE.size, color.ink, color.paper);
    const read = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
    expect(read?.data).toBe(link);
  });

  it('is dark modules on light paper inside a quiet zone of four modules', () => {
    const modules = qrModules(DARE);
    expect(QUIET).toBe(4);
    const light = (line: readonly boolean[]) => line.every((dark) => !dark);
    for (let at = 0; at < QUIET; at += 1) {
      expect(light(modules[at]!), `row ${String(at)}`).toBe(true);
      expect(light(modules[modules.length - 1 - at]!), `row ${String(modules.length - 1 - at)}`).toBe(true);
      expect(light(modules.map((row) => row[at]!)), `column ${String(at)}`).toBe(true);
      expect(light(modules.map((row) => row[row.length - 1 - at]!)), `column ${String(modules.length - 1 - at)}`).toBe(true);
    }
    // Hned za tichou zónou začíná vyhledávací čtverec – tmavý roh.
    expect(modules[QUIET]![QUIET]).toBe(true);

    const { ctx, at } = canvasOf(SQUARE.x + SQUARE.size, SQUARE.y + SQUARE.size, color.ink);
    paintQr(ctx, modules, SQUARE.x, SQUARE.y, SQUARE.size, color.ink, color.paper);
    // Rohy čtverce jsou tichá zóna v barvě papíru, i když karta pod nimi byla tmavá.
    expect(at(SQUARE.x, SQUARE.y)).toBe(color.paper.toLowerCase());
    expect(at(SQUARE.x + SQUARE.size - 1, SQUARE.y + SQUARE.size - 1)).toBe(color.paper.toLowerCase());
    // Modul má celé pixely plátna, i v nejdelším odkazu aspoň 12.
    expect(Math.floor(SQUARE.size / qrModules(LONGEST).length)).toBeGreaterThanOrEqual(12);
  });

  it('draws each module where the encoder put it, not mirrored', () => {
    // Dekodér přečte i zrcadlený kód, telefon nemusí – proto střed každého modulu proti matici kodéru.
    const modules = qrModules(DARE);
    const { ctx, at } = canvasOf(SQUARE.x + SQUARE.size, SQUARE.y + SQUARE.size, color.ink);
    paintQr(ctx, modules, SQUARE.x, SQUARE.y, SQUARE.size, color.ink, color.paper);
    const cell = Math.floor(SQUARE.size / modules.length);
    const offset = (SQUARE.size - cell * modules.length) / 2;
    const drawn = modules.map((row, my) => row.map((_, mx) => at(Math.floor(SQUARE.x + offset + (mx + 0.5) * cell), Math.floor(SQUARE.y + offset + (my + 0.5) * cell)) === color.ink.toLowerCase()));
    expect(drawn).toEqual(modules);
  });
});
