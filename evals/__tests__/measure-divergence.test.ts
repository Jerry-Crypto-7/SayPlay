import { describe, expect, it } from 'vitest';

import {
  allPairs,
  coverage,
  divergence,
  mean,
  paletteSignature,
  silhouetteProfile,
  type Frame,
} from '../measure-divergence';

const SIZE = 16;

/**
 * Snímek se zakrytým obdélníkem dané barvy. Sloupce `from` až `to` jsou
 * zakryté odspodu do výšky `height` řádků; zbytek je pozadí s alfou 0.
 */
function frameWith(options: {
  readonly from: number;
  readonly to: number;
  readonly height: number;
  readonly color: readonly [number, number, number];
}): Frame {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let row = 0; row < options.height; row += 1) {
    for (let column = options.from; column < options.to; column += 1) {
      const at = (row * SIZE + column) * 4;
      pixels[at] = options.color[0];
      pixels[at + 1] = options.color[1];
      pixels[at + 2] = options.color[2];
      pixels[at + 3] = 255;
    }
  }
  return { width: SIZE, height: SIZE, pixels };
}

const GREEN = [40, 200, 60] as const;
const ORANGE = [230, 110, 30] as const;

describe('zakrytí se čte z alfy', () => {
  it('prázdný snímek nezakrývá nic', () => {
    expect(coverage({ width: SIZE, height: SIZE, pixels: new Uint8Array(SIZE * SIZE * 4) })).toBe(0);
  });

  it('obdélník přes čtvrtinu plochy zakrývá čtvrtinu', () => {
    expect(coverage(frameWith({ from: 0, to: SIZE / 2, height: SIZE / 2, color: GREEN }))).toBe(0.25);
  });

  it('barva pozadí na zakrytí nemá vliv', () => {
    // Kdyby se zakrytí hádalo z barvy, splynul by s pozadím černý kus.
    const black = frameWith({ from: 0, to: SIZE, height: SIZE / 2, color: [0, 0, 0] });

    expect(coverage(black)).toBe(0.5);
  });

  it('snímek se špatnou délkou pole je vada, ne poloviční měření', () => {
    expect(() => coverage({ width: SIZE, height: SIZE, pixels: new Uint8Array(4) })).toThrow(
      /bajtů, čekalo se/,
    );
  });
});

describe('podpis palety popisuje barvy, ne rozmístění', () => {
  it('je to rozdělení — součet přes přihrádky je jedna', () => {
    const signature = paletteSignature(frameWith({ from: 2, to: 9, height: 5, color: ORANGE }));

    expect(signature.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
  });

  it('týž odstín na jiném místě dá týž podpis', () => {
    const left = paletteSignature(frameWith({ from: 0, to: 4, height: 8, color: GREEN }));
    const right = paletteSignature(frameWith({ from: 10, to: 14, height: 8, color: GREEN }));

    expect(left).toEqual(right);
  });

  it('prázdný snímek nemá podpis, ne rovnoměrný', () => {
    const signature = paletteSignature({ width: SIZE, height: SIZE, pixels: new Uint8Array(SIZE * SIZE * 4) });

    expect(signature.reduce((sum, value) => sum + value, 0)).toBe(0);
  });
});

describe('profil siluety popisuje proporce', () => {
  it('má jednu hodnotu na sloupec a vyjadřuje podíl zakrytých řádků', () => {
    const profile = silhouetteProfile(frameWith({ from: 0, to: 4, height: SIZE / 2, color: GREEN }));

    expect(profile).toHaveLength(SIZE);
    expect(profile.slice(0, 4)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(profile.slice(4)).toEqual(new Array(SIZE - 4).fill(0));
  });

  it('široké nízké a úzké vysoké se v profilu nepotkají', () => {
    const wide = silhouetteProfile(frameWith({ from: 0, to: SIZE, height: 2, color: GREEN }));
    const tall = silhouetteProfile(frameWith({ from: 7, to: 9, height: SIZE, color: GREEN }));

    expect(mean(wide.map((value, index) => Math.abs(value - tall[index])))).toBeGreaterThan(0.2);
  });
});

describe('odlišnost skládá obojí a nic jiného', () => {
  it('tentýž snímek se od sebe neliší', () => {
    const frame = frameWith({ from: 3, to: 11, height: 9, color: ORANGE });

    expect(divergence(frame, frame)).toEqual({ palette: 0, profile: 0, total: 0 });
  });

  it('jiná paleta při stejné siluetě hne jen paletou', () => {
    const shape = { from: 4, to: 12, height: 10 } as const;
    const result = divergence(frameWith({ ...shape, color: GREEN }), frameWith({ ...shape, color: ORANGE }));

    expect(result.profile).toBe(0);
    expect(result.palette).toBeCloseTo(1, 10);
    expect(result.total).toBeCloseTo(0.5, 10);
  });

  it('jiná silueta při stejné paletě hne jen profilem', () => {
    const result = divergence(
      frameWith({ from: 0, to: SIZE, height: 2, color: GREEN }),
      frameWith({ from: 7, to: 9, height: SIZE, color: GREEN }),
    );

    expect(result.palette).toBe(0);
    expect(result.profile).toBeGreaterThan(0.2);
  });

  it('rozmístění samo o sobě odlišnost nedělá', () => {
    // Tohle je celý důvod, proč se neporovnává pixel s pixelem: dva snímky
    // téže rodiny se liší jen tím, kde co stojí, a metrika to musí přejít.
    const result = divergence(
      frameWith({ from: 0, to: 4, height: 8, color: GREEN }),
      frameWith({ from: 10, to: 14, height: 8, color: GREEN }),
    );

    expect(result.palette).toBe(0);
    expect(result.total).toBeLessThan(0.15);
  });

  it('snímky různého rozlišení se porovnat nedají', () => {
    const small: Frame = { width: 2, height: 2, pixels: new Uint8Array(16) };

    expect(() => divergence(small, frameWith({ from: 0, to: 4, height: 4, color: GREEN }))).toThrow(
      /stejné rozlišení/,
    );
  });
});

describe('dvojice a průměr', () => {
  it('vrátí každou neuspořádanou dvojici právě jednou a žádnou se sebou', () => {
    const frames = new Map<string, Frame>([
      ['a', frameWith({ from: 0, to: 4, height: 4, color: GREEN })],
      ['b', frameWith({ from: 4, to: 8, height: 8, color: ORANGE })],
      ['c', frameWith({ from: 8, to: 12, height: 12, color: GREEN })],
    ]);

    const pairs = allPairs(frames);

    expect(pairs).toHaveLength(3);
    expect(pairs.map((pair) => `${pair.first}${pair.second}`).sort()).toEqual(['ab', 'ac', 'bc']);
  });

  it('průměr prázdné množiny není nula, je to vada', () => {
    expect(() => mean([])).toThrow(/prázdné množiny/);
  });
});
