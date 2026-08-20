import { BoxGeometry, BufferGeometry, Color, SRGBColorSpace, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { KIT, SWATCHES, srgbHexToLinear } from '../index';
import { SMOOTH_ANGLE_DEGREES } from '../pieces/primitives';

const COS_LIMIT = Math.cos((SMOOTH_ANGLE_DEGREES * Math.PI) / 180);

/**
 * Vrátí popis každého porušení kontraktu normál. Prázdné pole = kus je v pořádku.
 *
 * **Do 20. 8. 2026 tenhle soubor žádal ploché stínování všude** a byl to jediný
 * strážce toho, že stínování nese geometrie a ne materiál. T8 fasetování zrušila
 * jen tam, kde je plocha zaoblená, takže „všechny tři normály trojúhelníku jsou
 * shodné" už neplatí — a nahradit to nulovou kontrolou by byla tichá díra.
 *
 * Zůstávají tři vlastnosti, které platí dál a každá něco chrání:
 *
 * 1. **Geometrie je neindexovaná.** Indexovaná by sdílela normály přes hrany,
 *    které mají zůstat ostré, a míchané stínování by nešlo vyrobit vůbec.
 * 2. **Každá normála je jednotková.** Nenormalizovaný součet ploch ztmaví kus.
 * 3. **Žádná normála neuhne od své plochy o víc, než dovoluje práh.** Tohle je
 *    nová hranice místo staré rovnosti: normála se smí složit ze sousedů, ale
 *    jen z těch blízkých, takže výsledek zůstane v kuželu kolem vlastní plochy.
 *
 * Které kusy se vyhladily a které zůstaly hranaté, měří `shading.test.ts`.
 */
function normalViolations(geometry: BufferGeometry): string[] {
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
      if (stored.dot(face) < COS_LIMIT - 1e-4) {
        problems.push(
          `trojúhelník ${tri}, vrchol ${vertex}: normála uhnula od plochy za práh (dot ${stored.dot(face).toFixed(4)})`,
        );
      }
    }
  }

  return problems;
}

describe('kit má zapečené normály a nesdílí je za práh úhlu', () => {
  it.each(KIT.map((piece) => [piece.id, piece] as const))(
    '%s má jednotkové normály v kuželu kolem své plochy',
    (_id, piece) => {
      const geometry = piece.build();
      expect(normalViolations(geometry)).toEqual([]);
      geometry.dispose();
    },
  );

  it('kontrola není vakuózní — plně vyhlazená geometrie ji neprojde', () => {
    // Indexovaná krychle: rohový vrchol patří třem stěnám v pravém úhlu, takže
    // mu `computeVertexNormals()` normály zprůměruje na (±1,±1,±1)/√3. Od
    // vlastní stěny je to 54,7°, tedy za prahem. Kdyby tohle prošlo,
    // neprokazuje test nad kitem vůbec nic.
    const smooth = new BoxGeometry(1, 1, 1);
    smooth.deleteAttribute('normal');
    smooth.computeVertexNormals();

    expect(normalViolations(smooth)).not.toEqual([]);
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
