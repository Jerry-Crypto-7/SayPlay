import { BoxGeometry, BufferGeometry, Color, SRGBColorSpace, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { KIT, SWATCHES, srgbHexToLinear } from '../index';

/**
 * Vrátí popis každého porušení plochého stínování. Prázdné pole = kus má
 * zapečené ploché normály.
 *
 * Netestuje se jen „normály se dají přepočítat" — to by splnila i vyhlazená
 * geometrie. Testuje se to, co AC úlohy myslí doslova: **žádná normála se
 * nesdílí mezi trojúhelníky**, tedy uvnitř trojúhelníku jsou všechny tři
 * shodné a rovné normále jeho plochy.
 */
function flatNormalViolations(geometry: BufferGeometry): string[] {
  const problems: string[] = [];

  if (geometry.index !== null) {
    problems.push('geometrie je indexovaná, takže vrcholy sdílí normály');
    return problems;
  }

  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  if (normal === undefined) return ['chybí atribut normal'];
  if (position.count % 3 !== 0) return [`počet vrcholů ${position.count} není dělitelný třemi`];

  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const face = new Vector3();
  const edge = new Vector3();
  const stored = new Vector3();

  for (let tri = 0; tri < position.count / 3; tri += 1) {
    const i = tri * 3;
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);

    // Stejná konvence jako `computeVertexNormals()`: (C-B) x (A-B).
    face.subVectors(c, b);
    edge.subVectors(a, b);
    face.cross(edge);

    if (face.length() < 1e-10) {
      problems.push(`trojúhelník ${tri} je degenerovaný, normála nemá směr`);
      continue;
    }
    face.normalize();

    for (let vertex = 0; vertex < 3; vertex += 1) {
      stored.fromBufferAttribute(normal, i + vertex);
      if (Math.abs(stored.length() - 1) > 1e-4) {
        problems.push(`trojúhelník ${tri}, vrchol ${vertex}: normála není jednotková`);
      }
      if (stored.dot(face) < 1 - 1e-4) {
        problems.push(
          `trojúhelník ${tri}, vrchol ${vertex}: normála neodpovídá ploše (dot ${stored.dot(face).toFixed(4)})`,
        );
      }
    }
  }

  return problems;
}

describe('kit má zapečené ploché normály', () => {
  it.each(KIT.map((piece) => [piece.id, piece] as const))(
    '%s nesdílí normálu mezi trojúhelníky',
    (_id, piece) => {
      const geometry = piece.build();
      expect(flatNormalViolations(geometry)).toEqual([]);
      geometry.dispose();
    },
  );

  it.each(KIT.map((piece) => [piece.id, piece] as const))(
    '%s má normály shodné s toNonIndexed() + computeVertexNormals()',
    (_id, piece) => {
      const geometry = piece.build();
      const clone = geometry.clone();
      // `toNonIndexed()` na neindexované geometrii jen varuje a vrátí totéž;
      // že index chybí, tvrdí test výš.
      const recomputed = clone.index === null ? clone : clone.toNonIndexed();
      recomputed.deleteAttribute('normal');
      recomputed.computeVertexNormals();

      const stored = geometry.getAttribute('normal').array;
      const expected = recomputed.getAttribute('normal').array;
      expect(stored.length).toBe(expected.length);
      for (let i = 0; i < stored.length; i += 1) {
        expect(stored[i]).toBeCloseTo(expected[i] as number, 5);
      }

      geometry.dispose();
      recomputed.dispose();
    },
  );

  it('kontrola není vakuózní — vyhlazená geometrie ji neprojde', () => {
    // Indexovaná krychle: rohový vrchol patří třem stěnám, takže mu
    // `computeVertexNormals()` normály zprůměruje. Kdyby tohle prošlo,
    // neprokazuje test nad kitem vůbec nic.
    const smooth = new BoxGeometry(1, 1, 1);
    smooth.deleteAttribute('normal');
    smooth.computeVertexNormals();

    expect(flatNormalViolations(smooth)).not.toEqual([]);
    smooth.dispose();
  });
});

describe('kit má lineární vertex colours', () => {
  it.each(KIT.map((piece) => [piece.id, piece] as const))(
    '%s má barvu na každém vrcholu',
    (_id, piece) => {
      const geometry = piece.build();
      const position = geometry.getAttribute('position');
      const color = geometry.getAttribute('color');

      expect(color).toBeDefined();
      expect(color.count).toBe(position.count);
      expect(color.itemSize).toBe(3);
      geometry.dispose();
    },
  );

  it.each(Object.entries(SWATCHES))(
    'swatch %s je převedený do lineárního prostoru',
    (_name, hex) => {
      const [r, g, b] = srgbHexToLinear(hex);

      // Nezávislá cesta k téže hodnotě: `setStyle` se zdrojovým prostorem sRGB
      // konvertuje do pracovního (lineárního) prostoru sám.
      const reference = new Color().setStyle(hex, SRGBColorSpace);
      expect(r).toBeCloseTo(reference.r, 6);
      expect(g).toBeCloseTo(reference.g, 6);
      expect(b).toBeCloseTo(reference.b, 6);

      // A protiklad: surová sRGB hodnota to není. Bez tohohle by test prošel
      // i kitu, který konverzi vynechal — což je přesně ta vybledlá paleta.
      const n = Number.parseInt(hex.slice(1), 16);
      const rawR = ((n >> 16) & 0xff) / 255;
      if (rawR > 0.05 && rawR < 0.95) {
        expect(Math.abs(r - rawR)).toBeGreaterThan(0.02);
      }
    },
  );

  it('barvy v geometrii jsou lineární hodnoty ze swatche, ne sRGB', () => {
    const geometry = KIT[0].build();
    const color = geometry.getAttribute('color');
    const linear = Object.values(SWATCHES).map((hex) => srgbHexToLinear(hex));

    for (let i = 0; i < color.count; i += 1) {
      const match = linear.some(
        ([r, g, b]) =>
          Math.abs(color.getX(i) - r) < 1e-5 &&
          Math.abs(color.getY(i) - g) < 1e-5 &&
          Math.abs(color.getZ(i) - b) < 1e-5,
      );
      expect(match).toBe(true);
    }

    geometry.dispose();
  });
});
