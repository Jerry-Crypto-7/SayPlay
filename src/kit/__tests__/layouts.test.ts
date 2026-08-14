import { describe, expect, it } from 'vitest';

import {
  KIT,
  LAYOUTS,
  PALETTES,
  buildLayoutScene,
  footprintSignature,
  measureScene,
  repaint,
  srgbHexToLinear,
  type PaletteName,
} from '../index';

const PIECE_IDS = new Set(KIT.map((piece) => piece.id));

/** Odstín 0–360 ze sRGB hexu. Šedé barvy vrací `null` — jejich odstín nic neznamená. */
function hueOf(hex: string): number | null {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  if (span < 0.04) return null;

  let hue: number;
  if (max === r) hue = ((g - b) / span) % 6;
  else if (max === g) hue = (b - r) / span + 2;
  else hue = (r - g) / span + 4;

  return ((hue * 60) % 360 + 360) % 360;
}

describe('ručně skládané layouty', () => {
  it('je jich nejméně šest a mají jedinečná id', () => {
    expect(LAYOUTS.length).toBeGreaterThanOrEqual(6);
    const ids = LAYOUTS.map((layout) => layout.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(LAYOUTS.map((layout) => [layout.id, layout] as const))(
    '%s odkazuje jen na existující kusy a existující paletu',
    (_id, layout) => {
      expect(Object.keys(PALETTES)).toContain(layout.palette);
      const unknown = layout.placements
        .map((placement) => placement.piece)
        .filter((piece) => !PIECE_IDS.has(piece));
      expect(unknown).toEqual([]);
      expect(layout.placements.length).toBeGreaterThan(0);
    },
  );

  it('žádná dvojice layoutů nesdílí paletu', () => {
    const palettes = LAYOUTS.map((layout) => layout.palette);
    expect(new Set(palettes).size).toBe(palettes.length);
  });

  it('žádná dvojice layoutů nesdílí topologii, ani otočenou', () => {
    const signatures = LAYOUTS.map((layout) => footprintSignature(layout));
    const duplicates = signatures.filter((signature, i) => signatures.indexOf(signature) !== i);
    expect(duplicates).toEqual([]);
  });

  it('podpis půdorysu je invariantní vůči posunu i otočení', () => {
    // Bez tohohle by test výš mohl srovnávat podpisy, které se liší jen tím,
    // kde layout náhodou leží — a tvrzení „nesdílí topologii" by neznamenalo nic.
    const source = LAYOUTS[0];
    const shifted = {
      ...source,
      placements: source.placements.map((placement) => ({
        ...placement,
        cell: [placement.cell[0] + 7, placement.cell[1] - 3] as const,
      })),
    };
    const rotated = {
      ...source,
      placements: source.placements.map((placement) => ({
        ...placement,
        cell: [-placement.cell[1], placement.cell[0]] as const,
      })),
    };

    expect(footprintSignature(shifted)).toBe(footprintSignature(source));
    expect(footprintSignature(rotated)).toBe(footprintSignature(source));
    // A protiklad: jiný tvar musí dát jiný podpis, jinak je funkce konstantní.
    expect(footprintSignature(LAYOUTS[1])).not.toBe(footprintSignature(source));
  });

  it.each(LAYOUTS.map((layout) => [layout.id, layout] as const))(
    '%s se postaví a nakreslí něco',
    (_id, layout) => {
      const measured = measureScene(buildLayoutScene(layout));
      expect(measured.drawCalls).toBe(layout.placements.length);
      expect(measured.triangles).toBeGreaterThan(0);
    },
  );
});

describe('palety', () => {
  it.each(Object.entries(PALETTES))('%s nemá fialový ani purpurový odstín', (_name, palette) => {
    // Globální pravidlo designu. Pásmo 250–320° je fialová až purpurová;
    // strojová kontrola je tu proto, že u šesti palet po šesti slotech se to
    // okem přehlédne.
    const offenders = Object.entries(palette).filter(([, hex]) => {
      const hue = hueOf(hex);
      return hue !== null && hue >= 250 && hue <= 320;
    });
    expect(offenders).toEqual([]);
  });

  it.each(Object.entries(PALETTES))('%s má všech šest slotů kitu', (_name, palette) => {
    expect(Object.keys(palette).sort()).toEqual(
      ['accent', 'deep', 'moss', 'sand', 'shell', 'warm'],
    );
  });

  it('repaint nahradí základní odstíny odstíny palety', () => {
    const geometry = KIT[0].build();
    const before = Array.from(geometry.getAttribute('color').array);

    repaint(geometry, PALETTES.kiln);
    const after = Array.from(geometry.getAttribute('color').array);
    expect(after).not.toEqual(before);

    const allowed = Object.values(PALETTES.kiln).map((hex) => srgbHexToLinear(hex));
    const color = geometry.getAttribute('color');
    for (let i = 0; i < color.count; i += 1) {
      const hit = allowed.some(
        ([r, g, b]) =>
          Math.abs(color.getX(i) - r) < 1e-5 &&
          Math.abs(color.getY(i) - g) < 1e-5 &&
          Math.abs(color.getZ(i) - b) < 1e-5,
      );
      expect(hit).toBe(true);
    }

    geometry.dispose();
  });

  it('repaint odmítne barvu, která do kitu nepatří', () => {
    const geometry = KIT[0].build();
    geometry.getAttribute('color').setXYZ(0, 0.123, 0.456, 0.789);

    expect(() => repaint(geometry, PALETTES.harbor)).toThrow(/nenese žádný odstín kitu/);
    geometry.dispose();
  });

  it('každý layout používá právě svou paletu', () => {
    for (const layout of LAYOUTS) {
      const palette = PALETTES[layout.palette as PaletteName];
      expect(palette).toBeDefined();
    }
  });
});
