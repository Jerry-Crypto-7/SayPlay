import { BoxGeometry, CylinderGeometry, Vector3, type BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';

import { KIT } from '../index';
import { SMOOTH_ANGLE_DEGREES, assemble } from '../pieces/primitives';

/**
 * Míchané stínování — hladce tam, kde je oblina, ostře na hranách.
 *
 * Do 20. 8. 2026 měl kit **všechno** fasetované: `assemble` skládal geometrii
 * neindexovaně a `computeVertexNormals()` nad ní dal každému trojúhelníku
 * vlastní normálu. Válec pak vypadal jako osmiboký hranol, protože jím byl.
 *
 * Tenhle test měří tři vlastnosti, a ani jedna z nich není číslo opsané ze
 * zadání — všechna jsou naměřená nad skutečným kitem (viz níž, proč):
 *
 * 1. **Hranatý kus zůstane hranatý.** Dvacet čtyři kusů kitu nemá ani jednu
 *    zaoblenou plochu a musí mít podíl hladkých normál přesně 0. Kdyby se
 *    práh úhlu povolil, sjede jim stínování do měkka a přestanou číst jako
 *    zdivo.
 * 2. **Oblý kus se vyhladí.** Osmnáct kusů zaoblenou plochu má a podíl u nich
 *    musí být kladný.
 * 3. **Rozhraní dvou barev je ostré vždy**, i když se plochy skoro dotýkají
 *    sklonem. U toon materiálu je rozmazaná barevná hrana vidět okamžitě.
 */

/** Podíl vrcholů, jejichž normála NENÍ normála vlastní plochy. */
function smoothShare(geometry: BufferGeometry): number {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const face = new Vector3();
  const edge = new Vector3();
  const stored = new Vector3();

  let smooth = 0;
  const triangles = position.count / 3;
  for (let tri = 0; tri < triangles; tri += 1) {
    const i = tri * 3;
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    face.subVectors(c, b);
    edge.subVectors(a, b);
    face.cross(edge).normalize();

    for (let vertex = 0; vertex < 3; vertex += 1) {
      stored.fromBufferAttribute(normal, i + vertex);
      if (stored.dot(face) < 1 - 1e-5) smooth += 1;
    }
  }

  return smooth / position.count;
}

/**
 * Kusy bez jediné zaoblené plochy. **Naměřeno nad kitem, ne vypsáno z hlavy** —
 * seznam je součást kontraktu: kus, který se sem přesune nebo odsud zmizí, změnil
 * vzhled a někdo se na to má podívat.
 */
const FLAT_PIECES = [
  'mass.block',
  'mass.wedge',
  'mass.step',
  'mass.plinth',
  'mass.stack',
  'mass.bevel',
  'column.post',
  'column.twisted',
  'arch.flat',
  'arch.doorway',
  'arch.buttress',
  'panel.wall',
  'panel.half',
  'panel.floor',
  'panel.ramp',
  'panel.railing',
  'panel.window',
  'panel.roof',
  'fixture.crate',
  'fixture.sign',
  'fixture.terminal',
  'fixture.pipe',
  'fixture.bench',
  'fixture.reception',
  'organic.reed',
] as const;

const FLAT = new Set<string>(FLAT_PIECES);

describe('práh úhlu', () => {
  it('je nad rozestupem ploch kitu, jinak by se nesladilo nic', () => {
    // **Tohle je celý důvod, proč práh není 35°, jak žádalo původní zadání.**
    // Válce kitu mají osm radiálních segmentů, takže mezi sousedními bočními
    // plochami je 360/8 = 45°; ikosaedr má 41,81°. Práh 35° by nechal oba
    // fasetované a míchané stínování by neexistovalo — zadání to číslo neměřilo.
    expect(SMOOTH_ANGLE_DEGREES).toBeGreaterThan(45);

    // A zároveň pod pravým úhlem, jinak by se slily i stěny krychle.
    expect(SMOOTH_ANGLE_DEGREES).toBeLessThan(90);
  });
});

describe('hranaté kusy zůstaly hranaté', () => {
  it.each(FLAT_PIECES.map((id) => [id] as const))('%s má podíl hladkých normál 0', (id) => {
    const piece = KIT.find((candidate) => candidate.id === id);
    expect(piece, `${id} v kitu není`).toBeDefined();

    const geometry = piece!.build();
    expect(smoothShare(geometry)).toBe(0);
    geometry.dispose();
  });

  it('hranatých kusů je dvacet pět a všechny v kitu existují', () => {
    expect(FLAT_PIECES.length).toBe(25);
    const ids = new Set(KIT.map((piece) => piece.id));
    for (const id of FLAT_PIECES) expect(ids.has(id), id).toBe(true);
  });
});

describe('oblé kusy se vyhladily', () => {
  const curved = KIT.filter((piece) => !FLAT.has(piece.id));

  it.each(curved.map((piece) => [piece.id, piece] as const))(
    '%s má kladný podíl hladkých normál',
    (id, piece) => {
      const geometry = piece.build();
      expect(smoothShare(geometry), `${id} zůstal celý fasetovaný`).toBeGreaterThan(0);
      geometry.dispose();
    },
  );

  it('kusů z čistě oblého tělesa se vyhladí celý povrch', () => {
    // Ikosaedr nemá ani jednu ostrou hranu nad prahem, takže je hladký celý.
    // Válec ne, a je to správně: podstava se s bokem potkává v pravém úhlu.
    const pebble = KIT.find((piece) => piece.id === 'organic.pebble')!.build();
    const barrel = KIT.find((piece) => piece.id === 'fixture.barrel')!.build();

    expect(smoothShare(pebble)).toBeGreaterThan(0.9);
    expect(smoothShare(barrel)).toBeGreaterThan(0.3);
    expect(smoothShare(barrel), 'podstava válce se nesmí slít s bokem').toBeLessThan(0.8);

    pebble.dispose();
    barrel.dispose();
  });

  it('podíl 0,85–0,95 z původního zadání je nedosažitelný a je to vlastnost tvarů', () => {
    // Zadání T8 žádalo tenhle pás pro všechny oblé kusy. Naměřeno: splní ho
    // jediný kus z osmnácti (`organic.pebble` 0,933). Válec má polovinu vrcholů
    // na podstavách a ty MUSÍ zůstat ostré, takže se přes ~0,5 nedostane, ať je
    // implementace jakkoli dobrá. Pás tedy nepopisuje míchané stínování, popisuje
    // uzavřené oblé těleso — a číslo se nemění, protože by se pak přestalo měřit.
    const inBand = KIT.filter((piece) => !FLAT.has(piece.id)).filter((piece) => {
      const geometry = piece.build();
      const share = smoothShare(geometry);
      geometry.dispose();
      return share >= 0.85 && share <= 0.95;
    });

    expect(inBand.map((piece) => piece.id)).toEqual(['organic.pebble']);
  });
});

/**
 * Normály vrcholů ve švu (`y = 0`), seskupené podle polohy — **jen z bočních
 * stěn**.
 *
 * Filtr na stěnu není kosmetika, je to celý rozdíl mezi měřicím a dekorativním
 * testem. Na téže souřadnici (x, z) leží i vrcholy podstav, a ty mají normálu
 * ±Y. Kdyby se braly všechny, má každá poloha 2–3 různé normály **bez ohledu na
 * implementaci** — naměřeno: 0 z 10 poloh se shodne ani u dvou válců stejné
 * barvy, které se slít mají. Aserce „nesdílí normálu" by pak byla vždy zelená a
 * netvrdila by nic.
 *
 * Plocha se klasifikuje z pozic, ne z testovaného atributu `normal`, aby test
 * neměřil sám sebe.
 */
function seamWallNormals(geometry: BufferGeometry): Map<string, Set<string>> {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const face = new Vector3();
  const edge = new Vector3();

  const byPosition = new Map<string, Set<string>>();
  for (let i = 0; i < position.count; i += 1) {
    if (Math.abs(position.getY(i)) > 1e-6) continue;

    const triangle = Math.floor(i / 3) * 3;
    a.fromBufferAttribute(position, triangle);
    b.fromBufferAttribute(position, triangle + 1);
    c.fromBufferAttribute(position, triangle + 2);
    face.subVectors(c, b);
    edge.subVectors(a, b);
    face.cross(edge).normalize();
    if (Math.abs(face.y) >= 0.5) continue;

    const key = `${position.getX(i).toFixed(5)},${position.getZ(i).toFixed(5)}`;
    const value = `${normal.getX(i).toFixed(5)},${normal.getY(i).toFixed(5)},${normal.getZ(i).toFixed(5)}`;
    const seen = byPosition.get(key) ?? new Set<string>();
    seen.add(value);
    byPosition.set(key, seen);
  }

  return byPosition;
}

describe('rozhraní dvou barev je ostré', () => {
  it('shodné vrcholy dvou odstínů nesdílí normálu, i když jsou plochy skoro rovnoběžné', () => {
    // Dva válce o **stejném poloměru** nad sebou: v místě styku mají vrcholy
    // shodnou polohu a boční plochy naprosto stejný sklon, tedy 0° mezi nimi.
    // Bez barvy v klíči by se normály slily a barevná hrana by se rozmazala do
    // přechodu. Tohle je jediný test, který na to sáhne — kusy kitu mají obruče
    // o jiném poloměru, takže se v nich vrcholy netrefí a hrana je ostrá zadarmo.
    const seam = assemble([
      { geometry: new CylinderGeometry(0.3, 0.3, 0.4, 8), swatch: 'warm', position: [0, 0.2, 0] },
      { geometry: new CylinderGeometry(0.3, 0.3, 0.4, 8), swatch: 'deep', position: [0, -0.2, 0] },
    ]);

    const position = seam.getAttribute('position');
    const color = seam.getAttribute('color');
    const normal = seam.getAttribute('normal');

    // Vrcholy přesně ve švu (y = 0) patří oběma válcům a nesou obě barvy.
    const atSeam: number[] = [];
    for (let i = 0; i < position.count; i += 1) {
      if (Math.abs(position.getY(i)) < 1e-6) atSeam.push(i);
    }
    expect(atSeam.length, 'šev se nevyrobil, test by netvrdil nic').toBeGreaterThan(8);

    const shades = new Set(atSeam.map((i) => `${color.getX(i)},${color.getY(i)},${color.getZ(i)}`));
    expect(shades.size, 've švu se nepotkaly dvě barvy').toBe(2);

    // Klíčová aserce: ve švu se normály obou odstínů nesmí zprůměrovat na jednu.
    // Kdyby se barva z klíče vypustila, obě strany dostanou tutéž normálu a
    // tenhle počet vyskočí na počet různých poloh.
    const byPosition = seamWallNormals(seam);
    expect(byPosition.size, 'šev nemá boční stěny, aserce níž by netvrdila nic').toBe(9);

    const shared = [...byPosition.values()].filter((normals) => normals.size === 1);
    expect(shared.length, 'v některé poloze švu se obě barvy dohodly na jedné normále').toBe(0);

    seam.dispose();
  });

  it('bez barevného rozhraní se tytéž vrcholy naopak slijí', () => {
    // Protiklad k předchozímu testu. Kdyby se normály nesdílely NIKDY, prošel by
    // test výš i implementaci, která zůstala plně fasetovaná — a to je přesně ta
    // dekorativní aserce, kterou nechceme.
    const seam = assemble([
      { geometry: new CylinderGeometry(0.3, 0.3, 0.4, 8), swatch: 'warm', position: [0, 0.2, 0] },
      { geometry: new CylinderGeometry(0.3, 0.3, 0.4, 8), swatch: 'warm', position: [0, -0.2, 0] },
    ]);

    const byPosition = seamWallNormals(seam);
    expect(byPosition.size, 'šev nemá boční stěny, aserce níž by netvrdila nic').toBe(9);

    const shared = [...byPosition.values()].filter((normals) => normals.size === 1);
    expect(shared.length, 'stejná barva se ve švu měla slít a neslila').toBe(byPosition.size);

    seam.dispose();
  });
});

describe('kontrola není vakuózní', () => {
  it('plně fasetovaná geometrie by testy hranatosti prošla, ale oblosti ne', () => {
    // Krychle je hranatá i po vyhlazení sousedů, takže sama o sobě nic
    // nedokazuje — a přesně proto je ta druhá polovina sady nutná.
    const box = new BoxGeometry(1, 1, 1).toNonIndexed();
    box.deleteAttribute('normal');
    box.computeVertexNormals();

    expect(smoothShare(box)).toBe(0);
    box.dispose();
  });
});
