/**
 * Rámování kamery.
 *
 * **Špatné rámování je z testu neviditelné.** Obraz vypadá jako obraz, jen se
 * dívá jinam — přesně to uřízlo cílovému snímku ocas, když kamera mířila do
 * počátku, a přesně to shodilo bránu K0 nad kontaktním listem. Proto se tady
 * neměří, že funkce něco vrátila, ale **kam ten snímek doopravdy míří**: kde
 * leží obzor, kde sedí hrdina a jestli je celý obal uvnitř jehlanu vidění.
 *
 * Projekci si test nepíše sám. Kdyby ano, měřil by vlastní matematiku proti
 * vlastní matematice a obě by se mýlily společně.
 */

import { describe, expect, it } from 'vitest';

import {
  FRAMING_FOV,
  HERO_HEIGHT,
  SKY_SHARE,
  type Bounds,
  followSeat,
  frameScene,
  insideFrustum,
  pitchForSky,
  project,
  safeAreaFromRects,
  skyShareForPitch,
} from '../framing';

const ASPECT = 16 / 9;

/** Běžný svět produktu: mřížka zhruba 12×8 s kulisou kolem a nízkou zástavbou. */
const WORLD: Bounds = { min: { x: -14, y: 0, z: -10 }, max: { x: 14, y: 6, z: 10 } };

it('centers an indoor inspection subject in the free viewport without cropping its room', () => {
  const bounds={min:{x:-4,y:0,z:-3},max:{x:4,y:3,z:3}},hero={x:0,y:1,z:0};
  const view=frameScene({bounds,hero,aspect:ASPECT,pitch:Math.PI*.27,heroHeight:.5});
  expect(project(hero,view.eye,view.target,view.fov,ASPECT).y).toBeCloseTo(0,8);
  for(const x of [-4,4])for(const y of [0,3])for(const z of [-3,3])
    expect(insideFrustum({x,y,z},view.eye,view.target,view.fov,ASPECT)).toBe(true);
});

/** Osm rohů obalu. Koule opsaná obalu je odhad, rohy jsou odpověď. */
function cornersOf(bounds: Bounds): readonly { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) out.push({ x, y, z });
    }
  }
  return out;
}

/** Podíl snímku nad obzorem, odečtený z hotového rámování, ne z parametru. */
function skyOf(framing: ReturnType<typeof frameScene>): number {
  return (1 - Math.tan(framing.pitch) / Math.tan(((framing.fov / 2) * Math.PI) / 180)) / 2;
}

describe('obzor', () => {
  it('klopení a podíl oblohy jsou navzájem obrácené', () => {
    for (const share of [0, 0.15, 0.3, 0.45, 0.5]) {
      expect(skyShareForPitch(pitchForSky(share, 45), 45)).toBeCloseTo(share, 10);
      expect(skyShareForPitch(pitchForSky(share, 38), 38)).toBeCloseTo(share, 10);
    }
  });

  it('rámování ze scény dá obzor do pásma, které žádá brána', () => {
    const framing = frameScene({ bounds: WORLD, aspect: ASPECT });

    expect(framing.skyShare).toBeCloseTo(SKY_SHARE, 10);
    expect(framing.skyShare).toBeGreaterThanOrEqual(0.15);
    expect(framing.skyShare).toBeLessThanOrEqual(0.45);
    // Odečteno z vrácené osy, ne z parametru: kdyby `frameScene` klopení
    // spočítalo a pak posadilo oko jinam, tahle aserce si toho všimne a ta
    // předchozí ne.
    expect(skyOf(framing)).toBeCloseTo(SKY_SHARE, 10);
  });

  it('kamera míří dolů, ale mělce — ne do podlahy jako do brány K0', () => {
    const framing = frameScene({ bounds: WORLD, aspect: ASPECT });
    const degrees = (framing.pitch * 180) / Math.PI;

    expect(degrees).toBeGreaterThan(0);
    // Původní `[7, 7, 9]` do počátku klopilo o 31,5° a obzor tím vytlačilo nad
    // horní hranu. Cokoliv nad 20° je zpátky tam.
    expect(degrees).toBeLessThan(20);
  });

  it('frameScene souhlasí s ručně vyladěným cílovým snímkem', () => {
    // Ta tři čísla jsou opsaná z `TargetFrame.tsx` — z obrazu, který branou K0
    // prošel. Když se model rámování s ním rozejde, je vadný model, ne obraz.
    const eye = { x: 10, y: 8.6, z: 36 };
    const target = { x: -1, y: 3.6, z: -6 };
    const fov = 38;

    const flat = Math.hypot(target.x - eye.x, target.z - eye.z);
    const pitch = Math.atan((eye.y - target.y) / flat);

    expect((pitch * 180) / Math.PI).toBeCloseTo(6.57, 1);
    const sky = skyShareForPitch(pitch, fov);
    expect(sky).toBeGreaterThanOrEqual(0.15);
    expect(sky).toBeLessThanOrEqual(0.45);
    expect(sky).toBeCloseTo(0.335, 2);
  });
});

describe('hrdina a obal', () => {
  it('hlavní objekt sedí na spodní třetině, ne uprostřed', () => {
    const hero = { x: 2, y: 1, z: -3 };
    const framing = frameScene({ bounds: WORLD, hero, aspect: ASPECT });

    const at = project(hero, framing.eye, framing.target, framing.fov, ASPECT);
    expect(at.behind).toBe(false);
    // `y` je v podílu poloviny snímku, takže třetina odspodu je `−1/3`.
    expect(at.y).toBeCloseTo(2 * HERO_HEIGHT - 1, 6);
    expect(at.y).toBeLessThan(0);
  });

  it('celý obal je v záběru, u malé i velké scény', () => {
    const shapes: readonly Bounds[] = [
      WORLD,
      { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } },
      { min: { x: -60, y: -4, z: -60 }, max: { x: 60, y: 30, z: 60 } },
      { min: { x: -3, y: 0, z: -40 }, max: { x: 3, y: 2, z: 40 } },
    ];

    for (const bounds of shapes) {
      const framing = frameScene({ bounds, aspect: ASPECT });
      for (const corner of cornersOf(bounds)) {
        expect(
          insideFrustum(corner, framing.eye, framing.target, framing.fov, ASPECT),
          `roh ${JSON.stringify(corner)} vypadl ze záběru`,
        ).toBe(true);
      }
    }
  });

  it('oko stojí vně obalu, nikdy uvnitř geometrie', () => {
    const shapes: readonly Bounds[] = [
      WORLD,
      { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } },
      { min: { x: -60, y: -4, z: -60 }, max: { x: 60, y: 30, z: 60 } },
    ];

    for (const bounds of shapes) {
      const { eye } = frameScene({ bounds, aspect: ASPECT });
      const inside =
        eye.x > bounds.min.x &&
        eye.x < bounds.max.x &&
        eye.y > bounds.min.y &&
        eye.y < bounds.max.y &&
        eye.z > bounds.min.z &&
        eye.z < bounds.max.z;
      expect(inside, `oko ${JSON.stringify(eye)} uvnitř obalu`).toBe(false);
    }
  });

  it('bez hrdiny se rámuje na střed obalu', () => {
    const framing = frameScene({ bounds: WORLD, hero: null, aspect: ASPECT });
    expect(framing.target.x).toBeCloseTo(0, 10);
    expect(framing.target.z).toBeCloseTo(0, 10);
    expect(framing.fallback).toBeNull();
  });

  it('týž vstup dá pokaždé totéž', () => {
    const once = frameScene({ bounds: WORLD, hero: { x: 1, y: 2, z: 3 }, aspect: ASPECT });
    const twice = frameScene({ bounds: WORLD, hero: { x: 1, y: 2, z: 3 }, aspect: ASPECT });
    expect(once).toEqual(twice);
  });
});

describe('volná plocha okna', () => {
  /** Dok přes spodní třetinu, ovládání a otevřená zásuvka po čtvrtině šířky. */
  const SAFE = { bottom: 0.3, left: 0.25, right: 0.25 };
  const CENTER = { x: 0, y: 3, z: 0 };

  it('obal padne nad dolní pruh a mezi krajní sloupce, ne pod dok', () => {
    const framing = frameScene({ bounds: WORLD, aspect: ASPECT, safeArea: SAFE });

    // Střed obalu je na třetině **volné plochy** (naměřeno 16. 9. 2026:
    // `+0,0667`), zatímco bez `safeArea` sedí na třetině okna (`−1/3`) —
    // tedy uvnitř pruhu, který kryje dok.
    const at = project(CENTER, framing.eye, framing.target, framing.fov, ASPECT);
    expect(at.y).toBeGreaterThan(-1 + 2 * SAFE.bottom);
    expect(at.y).toBeCloseTo(2 * HERO_HEIGHT * (1 - SAFE.bottom) - 1 + 2 * SAFE.bottom, 6);

    for (const corner of cornersOf(WORLD)) {
      expect(
        insideFrustum(corner, framing.eye, framing.target, framing.fov, ASPECT, SAFE),
        `roh ${JSON.stringify(corner)} skončil pod rozhraním`,
      ).toBe(true);
    }
  });

  it('bez safeArea by pod rozhraním skončil — jinak by test neměřil nic', () => {
    const plain = frameScene({ bounds: WORLD, aspect: ASPECT });

    // Střed obalu sedí na třetině okna, tedy jen 0,067 nad hranou pruhu — celá
    // spodní polovina světa i s hrdinou už je pod dokem. Váhu nese aserce nad
    // rohy: střed sám by prošel a vada by zůstala neviditelná.
    const at = project(CENTER, plain.eye, plain.target, plain.fov, ASPECT);
    expect(at.y).toBeCloseTo(2 * HERO_HEIGHT - 1, 6);
    expect(
      cornersOf(WORLD).every((corner) =>
        insideFrustum(corner, plain.eye, plain.target, plain.fov, ASPECT, SAFE),
      ),
    ).toBe(false);
  });

  it('prázdná safeArea nehne ani jedním dnešním číslem', () => {
    const hero = { x: 2, y: 1, z: -3 };
    expect(frameScene({ bounds: WORLD, hero, aspect: ASPECT, safeArea: {} })).toEqual(
      frameScene({ bounds: WORLD, hero, aspect: ASPECT }),
    );
    // Nesmyslná hodnota z měření v DOM (nulové plátno dá `NaN`) je totéž jako
    // žádná, ne `NaN` v kameře.
    expect(
      frameScene({ bounds: WORLD, hero, aspect: ASPECT, safeArea: { bottom: Number.NaN } }),
    ).toEqual(frameScene({ bounds: WORLD, hero, aspect: ASPECT }));
  });

  it('nesouměrné sloupce posunou obal do zbylé půlky', () => {
    const framing = frameScene({ bounds: WORLD, aspect: ASPECT, safeArea: { left: 0.4 } });

    const at = project(CENTER, framing.eye, framing.target, framing.fov, ASPECT);
    // Střed volné plochy leží na `left − right`, tedy 0,4 vpravo od středu okna.
    expect(at.x).toBeCloseTo(0.4, 6);
  });
});

describe('safeAreaFromRects — zakrytí se počítá z průniku, ne z rozdílu hran', () => {
  /** Plátno 1000×600 u levého horního rohu okna. */
  const FRAME = { left: 0, top: 0, right: 1000, bottom: 600 };

  it('plátno, které pod rozhraní nesahá, není zakryté ničím', () => {
    // **Tohle je ta vada, kvůli které funkce vznikla** (P18 T2b). Po T2 končí
    // plátno nad dolním pruhem, takže dok leží celý pod ním. Rozdíl hran by dal
    // záporné číslo a `cover()` by ho ořízl na nulu — tedy tentýž výsledek, ale
    // ze špatného důvodu a jen náhodou.
    const area = safeAreaFromRects(FRAME, {
      bottom: { left: 300, top: 620, right: 700, bottom: 700 },
      left: { left: 0, top: 620, right: 250, bottom: 700 },
      right: { left: 760, top: 620, right: 1000, bottom: 700 },
    });

    expect(area).toEqual({ bottom: 0, left: 0, right: 0 });
  });

  it('nezakryté plátno nehne rámováním ani o kousek', () => {
    // Váhu nese až tohle: nula se musí projevit jako **dnešní** snímek. Kdyby
    // některá hrana vyšla kladně, kamera by se odtlačila a nikdo by to z obrazu
    // nepoznal — jen by se svět „nějak krčil".
    const area = safeAreaFromRects(FRAME, {
      bottom: { left: 300, top: 620, right: 700, bottom: 700 },
      left: null,
      right: null,
    });

    expect(frameScene({ bounds: WORLD, aspect: ASPECT, safeArea: area })).toEqual(
      frameScene({ bounds: WORLD, aspect: ASPECT }),
    );
  });

  it('dok ležící na plátně zakryje přesně svůj průnik', () => {
    const area = safeAreaFromRects(FRAME, {
      bottom: { left: 300, top: 500, right: 700, bottom: 700 },
    });

    // Sto pixelů z šesti set.
    expect(area.bottom).toBeCloseTo(100 / 600, 12);
  });

  it('ovládání vedle plátna nezúží obraz, ovládání na plátně ano', () => {
    // Stará podoba počítala `controls.right − frame.left`, tedy kladných 0,25
    // i pro sloupec, který s plátnem nemá jediný společný pixel.
    const beside = safeAreaFromRects(FRAME, {
      left: { left: 0, top: 620, right: 250, bottom: 700 },
    });
    expect(beside.left).toBe(0);

    const across = safeAreaFromRects(FRAME, {
      left: { left: 0, top: 100, right: 250, bottom: 500 },
    });
    expect(across.left).toBeCloseTo(0.25, 12);
  });

  it('zásuvka zprava se počítá jen tehdy, když do plátna zasahuje', () => {
    expect(
      safeAreaFromRects(FRAME, { right: { left: 800, top: 0, right: 1000, bottom: 600 } }).right,
    ).toBeCloseTo(0.2, 12);

    // Plátno zúžené na 700: zásuvka začíná až za jeho pravou hranou.
    expect(
      safeAreaFromRects(
        { ...FRAME, right: 700 },
        { right: { left: 760, top: 0, right: 1000, bottom: 600 } },
      ).right,
    ).toBe(0);
  });

  it('nerozvržené plátno nekryje nic, místo aby dělilo nulou', () => {
    const area = safeAreaFromRects(
      { left: 0, top: 0, right: 0, bottom: 0 },
      { bottom: { left: 0, top: 0, right: 100, bottom: 100 } },
    );

    expect(area).toEqual({});
    // A projde to až do kamery, ne jako `Infinity` v klopení.
    expect(frameScene({ bounds: WORLD, aspect: ASPECT, safeArea: area })).toEqual(
      frameScene({ bounds: WORLD, aspect: ASPECT }),
    );
  });
});

describe('failure paths — vstupy, které scéna nikdy nevyrobí', () => {
  const finite = (framing: ReturnType<typeof frameScene>): boolean =>
    [
      framing.eye.x,
      framing.eye.y,
      framing.eye.z,
      framing.target.x,
      framing.target.y,
      framing.target.z,
      framing.pitch,
      framing.distance,
      framing.fov,
      framing.skyShare,
    ].every((value) => Number.isFinite(value));

  it('prázdná scéna dá kameru a přizná se k tomu', () => {
    const framing = frameScene({ bounds: null, aspect: ASPECT });
    expect(framing.fallback).toBe('empty');
    expect(finite(framing)).toBe(true);
    expect(framing.distance).toBeGreaterThan(0);
  });

  it('scéna o jediném kusu se orámuje', () => {
    const one: Bounds = { min: { x: 0.4, y: 0, z: 0.4 }, max: { x: 1.4, y: 1.8, z: 1.4 } };
    const framing = frameScene({ bounds: one, aspect: ASPECT });
    expect(framing.fallback).toBeNull();
    expect(finite(framing)).toBe(true);
    for (const corner of cornersOf(one)) {
      expect(insideFrustum(corner, framing.eye, framing.target, framing.fov, ASPECT)).toBe(true);
    }
  });

  it('obal s nulovou hloubkou dá kameru, ne dělení nulou', () => {
    const flat: Bounds = { min: { x: -5, y: 0, z: 2 }, max: { x: 5, y: 0, z: 2 } };
    const framing = frameScene({ bounds: flat, aspect: ASPECT });
    expect(framing.fallback).toBe('degenerate');
    expect(finite(framing)).toBe(true);
    expect(framing.distance).toBeGreaterThan(0);
  });

  it('NaN a Infinity v obalu spadnou na prázdnou scénu, ne na NaN v kameře', () => {
    for (const broken of [
      { min: { x: Number.NaN, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      { min: { x: 0, y: 0, z: 0 }, max: { x: Number.POSITIVE_INFINITY, y: 1, z: 1 } },
    ] satisfies Bounds[]) {
      const framing = frameScene({ bounds: broken, aspect: ASPECT });
      expect(framing.fallback).toBe('empty');
      expect(finite(framing)).toBe(true);
    }
  });

  it('prohozené min a max se srovnají, ne odmítnou', () => {
    const swapped: Bounds = { min: WORLD.max, max: WORLD.min };
    expect(frameScene({ bounds: swapped, aspect: ASPECT })).toEqual(
      frameScene({ bounds: WORLD, aspect: ASPECT }),
    );
  });

  it('nesmyslný poměr stran i zorný úhel padnou na výchozí', () => {
    const base = frameScene({ bounds: WORLD });
    for (const aspect of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(frameScene({ bounds: WORLD, aspect })).toEqual(base);
    }
    for (const fov of [0, 180, 500, Number.NaN]) {
      expect(frameScene({ bounds: WORLD, fov }).fov).toBe(FRAMING_FOV);
    }
  });

  it('hrdina s NaN se ignoruje a rámuje se na střed', () => {
    const framing = frameScene({
      bounds: WORLD,
      hero: { x: Number.NaN, y: 0, z: 0 },
      aspect: ASPECT,
    });
    expect(finite(framing)).toBe(true);
    expect(framing.target.x).toBeCloseTo(0, 10);
  });
});

describe('sledovací kamera', () => {
  const SPAN = 9.6;

  it('drží zadanou vzdálenost a klopí osu na týž obzor', () => {
    const { offset, lift, pitch } = followSeat(SPAN, FRAMING_FOV);

    expect(Math.hypot(offset.x, offset.y, offset.z)).toBeCloseTo(SPAN, 10);
    // Osa jde z oka na `hrdina + lift` a musí klesat právě o `pitch`.
    expect(Math.atan((offset.y - lift) / offset.z)).toBeCloseTo(pitch, 10);
    expect(skyShareForPitch(pitch, FRAMING_FOV)).toBeCloseTo(SKY_SHARE, 10);
  });

  it('postava sedí na třetině i ve sledovacím režimu', () => {
    const { offset, lift } = followSeat(SPAN, FRAMING_FOV);
    const hero = { x: 0, y: 0, z: 0 };
    const eye = { x: offset.x, y: offset.y, z: offset.z };
    const target = { x: 0, y: lift, z: 0 };

    const at = project(hero, eye, target, FRAMING_FOV, ASPECT);
    expect(at.y).toBeCloseTo(2 * HERO_HEIGHT - 1, 10);
  });

  it('nesmyslná vzdálenost nevyrobí NaN', () => {
    for (const span of [0, -5, Number.NaN]) {
      const { offset, lift } = followSeat(span);
      expect(Number.isFinite(offset.y) && Number.isFinite(offset.z) && Number.isFinite(lift)).toBe(
        true,
      );
    }
  });
});
