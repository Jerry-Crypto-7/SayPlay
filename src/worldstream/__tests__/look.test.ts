import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FAMILIES } from '@/geom/families';
import { PALETTES, type PaletteName } from '@/kit';

import {
  LOOK_BUDGETS,
  LOOK_FIELDS,
  LOOK_PRESETS,
  boundLookPreset,
  deriveLook,
  deriveLookPreset,
  lookDifference,
  terrainOfProgram,
  type LookDescriptor,
  type TerrainKind,
} from '../look';

/**
 * Oracle úlohy T2 — **odvození doopravdy rozlišuje světy**.
 *
 * Vada, kterou tenhle soubor hlídá, není pád. Je to funkce, která vrátí sedm
 * věrohodně vypadajících polí, jenže pro každý svět stejná — obraz pak vyjde
 * přesně tak plochý jako dnes a nic nezčervená, protože „vrátila popis" je
 * pravda i o konstantě. Testy níž proto neměří existenci polí, měří **odstup
 * mezi světy**.
 */

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

  return (((hue * 60) % 360) + 360) % 360;
}

/** Pásmo 250–320° je fialová až purpurová. Globální pravidlo designu. */
function inPurpleBand(hex: string): boolean {
  const hue = hueOf(hex);
  return hue !== null && hue >= 250 && hue <= 320;
}

/** Každá barva, kterou popis nese. Testy nad odstínem nesmí žádnou přeskočit. */
function colorsOf(look: LookDescriptor): readonly string[] {
  return [look.sky.color, look.water.color, look.fog.color];
}

const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];
const TERRAINS: readonly TerrainKind[] = ['flat', 'ridge', 'basin', 'plateau'];
const SEEDS = [1, 7, 4242, 98_765, 2_147_483_646] as const;

/** Vzhled rodiny: paleta z rodiny, terén z programu, který rodina opravdu staví. */
function lookOfFamily(index: number, seed: number): LookDescriptor {
  const family = FAMILIES[index];
  return deriveLook({
    palette: family.palette,
    terrain: terrainOfProgram(family.compose(seed)),
    seed,
  });
}

describe('vzhled se odvozuje ze světa, ne z konstanty', () => {
  it('čtyři rodiny dají čtyři různé popisy, každá dvojice aspoň ve třech ze sedmi polí', () => {
    // AC úlohy. Práh je 3, ne 1: jediné odlišné pole by splnila i funkce,
    // která mění pouze směr světla podle semínka a zbytek nechává konstantní.
    const looks = FAMILIES.map((_family, index) => lookOfFamily(index, 4242));

    const pairs = looks.flatMap((a, i) =>
      looks.slice(i + 1).map((b, j) => [FAMILIES[i].id, FAMILIES[i + 1 + j].id, lookDifference(a, b)] as const),
    );

    expect(pairs.length, 'čtyři rodiny dávají šest dvojic').toBe(6);
    expect(pairs.filter(([, , difference]) => difference < 3)).toEqual([]);

    // **Práh tří polí sám o sobě nestačí a je to naměřeno, ne tušeno.**
    // Mutace, která nechala všem paletám tentýž vzduch a rozlišovala světy
    // pouze barvou, tenhle test přesto prošla: `sky`, `water` a `fog` nesou
    // barvu z palety, takže tři pole se lišila i bez jediného rozhodnutí
    // o počasí. Obraz by přitom zůstal přesně tak plochý jako dnes, jen
    // v jiném odstínu. Aserce níž proto míří na čísla, ne na barvy.
    expect(new Set(looks.map((look) => look.exposure)).size, 'expozice se mezi rodinami nehýbe').toBeGreaterThanOrEqual(3);
    expect(new Set(looks.map((look) => look.water.present)).size, 'buď má vodu každý svět, nebo žádný').toBe(2);
  });

  it('totéž semínko dá pokaždé týž popis', () => {
    for (const seed of SEEDS) {
      for (const palette of PALETTE_NAMES) {
        for (const terrain of TERRAINS) {
          const once = deriveLook({ palette, terrain, seed });
          const again = deriveLook({ palette, terrain, seed });
          expect(again).toEqual(once);
        }
      }
    }
  });

  it('jiné semínko pohne světlem, ne rozhodnutími o světě', () => {
    // Semínko smí měnit úhel stínu a drobný rozptyl hustot. Kdyby měnilo
    // přítomnost vody nebo teplotu, přestala by o světě rozhodovat paleta
    // a dvě věty o téže krajině by daly dvě různá počasí.
    const first = deriveLook({ palette: 'frost', terrain: 'ridge', seed: 1 });
    const second = deriveLook({ palette: 'frost', terrain: 'ridge', seed: 2 });

    expect(second.key.direction).not.toEqual(first.key.direction);
    expect(second.water.present).toBe(first.water.present);
    expect(second.key.temperature).toBe(first.key.temperature);
    expect(second.sky).toEqual(first.sky);
  });

  it('terén mění vzhled i při stejné paletě', () => {
    const dry = deriveLook({ palette: 'harbor', terrain: 'plateau', seed: 9 });
    const wet = deriveLook({ palette: 'harbor', terrain: 'basin', seed: 9 });

    expect(wet.fog.density).toBeGreaterThan(dry.fog.density);
    expect(wet.dust).toBeGreaterThan(dry.dust);
    expect(wet.sky.height).toBeGreaterThan(dry.sky.height);
  });

  it('terén se čte z programu, který rodinu staví', () => {
    // Kdyby se druh terénu psal do vzhledu ručně, dal by se napsat jiný, než
    // na jakém svět doopravdy stojí. Tahle aserce ten most drží napnutý.
    const byFamily = FAMILIES.map((family) => terrainOfProgram(family.compose(4242)));

    expect(byFamily).toEqual(['plateau', 'ridge', 'ridge', 'flat']);
  });

  it('svět bez terénního uzlu je rovina, ne výjimka', () => {
    expect(
      terrainOfProgram({
        version: 'geom-program-v1',
        nodes: [{ kind: 'mass', variant: 'block' }],
        root: 0,
      }),
    ).toBe('flat');
  });
});

describe('pravidla, která odvození nesmí porušit', () => {
  it('Duny vodu nedostanou na žádném terénu ani semínku', () => {
    for (const terrain of TERRAINS) {
      for (const seed of SEEDS) {
        expect(deriveLook({ palette: 'dunes', terrain, seed }).water.present).toBe(false);
      }
    }
  });

  it('Háj má nejhustší prach ze všech palet', () => {
    const dust = PALETTE_NAMES.map(
      (palette) => [palette, deriveLook({ palette, terrain: 'flat', seed: 4242 }).dust] as const,
    );
    const ranked = [...dust].sort((a, b) => b[1] - a[1]);

    expect(ranked[0][0]).toBe('thicket');
  });

  it('žádný odvozený odstín nepadne do fialového pásma', () => {
    // Míchání dvou nefialových barev v sRGB může odstín poslat mimo oblouk
    // mezi nimi, takže „paleta fialovou nemá" tuhle vlastnost nedokazuje.
    // Prochází se celý součin palet, terénů a semínek.
    const purple = PALETTE_NAMES.flatMap((palette) =>
      TERRAINS.flatMap((terrain) =>
        SEEDS.flatMap((seed) =>
          colorsOf(deriveLook({ palette, terrain, seed }))
            .filter(inPurpleBand)
            .map((hex) => `${palette}/${terrain}/${String(seed)}: ${hex}`),
        ),
      ),
    );

    expect(purple).toEqual([]);
  });

  it('každé číslo zůstává ve svém rozsahu', () => {
    for (const palette of PALETTE_NAMES) {
      for (const terrain of TERRAINS) {
        for (const seed of SEEDS) {
          const look = deriveLook({ palette, terrain, seed });

          expect(look.fog.density).toBeGreaterThanOrEqual(0.05);
          expect(look.fog.density).toBeLessThanOrEqual(1);
          expect(look.dust).toBeGreaterThanOrEqual(0);
          expect(look.dust).toBeLessThanOrEqual(1);
          expect(look.rim).toBeGreaterThanOrEqual(0.1);
          expect(look.rim).toBeLessThanOrEqual(1);
          expect(look.exposure).toBeGreaterThanOrEqual(0.8);
          expect(look.exposure).toBeLessThanOrEqual(1.8);
          expect(look.sky.height).toBeGreaterThanOrEqual(0.1);
          expect(look.sky.height).toBeLessThanOrEqual(0.9);

          const [x, y, z] = look.key.direction;
          expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
          expect(y, 'klíčové světlo svítí shora, ne zespodu').toBeGreaterThan(0);
        }
      }
    }
  });

  it('každá barva je platný šestimístný hex', () => {
    for (const palette of PALETTE_NAMES) {
      for (const seed of SEEDS) {
        for (const hex of colorsOf(deriveLook({ palette, terrain: 'basin', seed }))) {
          expect(hex).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  it('osm polí je osm a jsou to ta, která popis nese', () => {
    const look = deriveLook({ palette: 'worldstream', terrain: 'flat', seed: 1 });

    // **Bylo sedm, je osm — a tady je proč.** `ground` přibylo 28. 8. 2026
    // rozhodnutím uživatele v bráně H2. Do té doby byla jediná zem, kterou svět
    // mohl mít, hladina, takže tři palety bez vody neměly pod obzorem nic
    // a obloha jim brala 90–96 % snímku. Číslo se nepřepsalo, aby test zezelenal
    // — pohnulo se, protože se popis rozrostl o pole, které mu chybělo.
    expect(LOOK_FIELDS.length).toBe(8);
    // `palette` je vstup, ne deváté pole — a `LOOK_FIELDS` ho proto nesmí nést.
    expect(Object.keys(look).filter((key) => !LOOK_FIELDS.includes(key as never))).toEqual([
      'palette',
    ]);
  });

  it('každý svět má zem, a ta je tmavší než jeho obloha', () => {
    // Zem barvy oblohy by vadu neopravila: soudce by pořád viděl jednu plochu
    // jednoho jasu, jen by ji maloval jiný objekt. Rozdíl hodnot je celý smysl.
    const luminance = (hex: string): number => {
      const value = Number.parseInt(hex.slice(1), 16);
      return (
        (0.2126 * ((value >> 16) & 0xff) + 0.7152 * ((value >> 8) & 0xff) + 0.0722 * (value & 0xff)) /
        255
      );
    };

    for (const palette of ['harbor', 'kiln', 'thicket', 'foundry', 'dunes', 'frost'] as const) {
      const look = deriveLook({ palette, terrain: 'flat', seed: 7 });

      expect(look.ground.present, `${palette} nemá zem`).toBe(true);
      expect(look.ground.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(
        luminance(look.ground.color),
        `${palette}: zem ${look.ground.color} není tmavší než obloha ${look.sky.color}`,
      ).toBeLessThan(luminance(look.sky.color));
    }
  });

  it('jediná PRNG je pure-rand', () => {
    // Lexikálně nad zdrojem: `Math.random()` přepisuje replay a v tomhle repu
    // je zakázaná (`CLAUDE.md`). Test se ptá souboru, ne komentáře — a proto
    // se komentáře nejdřív odstraní. Bez toho by tenhle test padal na vlastní
    // hlavičce `look.ts`, kde slovo `Math.random` stojí jako zákaz.
    const source = readFileSync(resolve(process.cwd(), 'src/worldstream/look.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toContain('Math.random');
    expect(code).not.toContain('seedrandom');
    expect(code).toContain('xoroshiro128plus');
  });
});

/**
 * Oracle úlohy P22 T12 – **předvolby vzhledu, které pravidlo umí přepnout**.
 *
 * Vada, kterou tenhle blok hlídá, je předvolba, která vypadá jako bouře
 * v názvu a v obraze se od dne neliší – nebo se liší tím, že sáhla do
 * fialového pásma. Soudí se odstup předvoleb, směr změn (bouře tmavší
 * a s nízkým světlem, mlha hustší a s tmavší oblohou), rozpočty a odstíny,
 * a to nad celým součinem palet, terénů a předvoleb.
 */
describe('předvolby vzhledu odvozené z jednoho popisu', () => {
  const luminance = (hex: string): number => {
    const value = Number.parseInt(hex.slice(1), 16);
    return (0.2126 * ((value >> 16) & 0xff) + 0.7152 * ((value >> 8) & 0xff) + 0.0722 * (value & 0xff)) / 255;
  };
  const base = deriveLook({ palette: 'harbor', terrain: 'flat', seed: 4242 });

  it('pět předvoleb je pět a den je popis sám', () => {
    expect([...LOOK_PRESETS]).toEqual(['day', 'dusk', 'night', 'storm', 'fog']);
    expect(deriveLookPreset(base, 'day')).toEqual(base);
  });

  it('každá dvojice předvoleb se liší aspoň ve dvou polích', () => {
    const looks = LOOK_PRESETS.map((preset) => [preset, deriveLookPreset(base, preset)] as const);
    const pairs = looks.flatMap(([a, lookA], i) =>
      looks.slice(i + 1).map(([b, lookB]) => [a, b, lookDifference(lookA, lookB)] as const));
    for (const [a, b, difference] of pairs) expect(difference, `${a} a ${b} jsou skoro totéž`).toBeGreaterThanOrEqual(2);
  });

  it('bouře je tmavší a svítí nízko, mlha je hustší s tmavší oblohou', () => {
    for (const palette of PALETTE_NAMES) {
      for (const terrain of TERRAINS) {
        const look = deriveLook({ palette, terrain, seed: 7 });
        const storm = deriveLookPreset(look, 'storm');
        const fog = deriveLookPreset(look, 'fog');
        const where = `${palette}/${terrain}`;

        expect(storm.exposure, `${where}: bouře není tmavší`).toBeLessThan(look.exposure);
        expect(storm.key.direction[1], `${where}: klíčové světlo bouře není níž`).toBeLessThan(look.key.direction[1]);
        expect(luminance(storm.sky.color), `${where}: obloha bouře není tmavší`).toBeLessThan(luminance(look.sky.color));

        // Kotlina v hutích už stojí na stropu hustoty; tam se žádá strop, ne víc než strop.
        expect(fog.fog.density, `${where}: mlha není hustší`)
          .toBeGreaterThanOrEqual(Math.min(LOOK_BUDGETS.fogDensity.max, look.fog.density * 1.5));
        expect(luminance(fog.sky.color), `${where}: obloha v mlze není tmavší`).toBeLessThan(luminance(look.sky.color));
        expect(luminance(deriveLookPreset(look, 'night').sky.color), `${where}: noc není tmavší než bouře`)
          .toBeLessThan(luminance(storm.sky.color));
      }
    }
  });

  it('žádná předvolba nepadne do fialového pásma a všechny drží rozpočty', () => {
    const purple: string[] = [];
    for (const palette of PALETTE_NAMES) {
      for (const terrain of TERRAINS) {
        for (const seed of SEEDS) {
          const look = deriveLook({ palette, terrain, seed });
          for (const preset of LOOK_PRESETS) {
            const derived = deriveLookPreset(look, preset);
            for (const hex of [...colorsOf(derived), derived.ground.color]) {
              expect(hex).toMatch(/^#[0-9a-f]{6}$/);
              if (inPurpleBand(hex)) purple.push(`${palette}/${terrain}/${String(seed)}/${preset}: ${hex}`);
            }
            expect(derived.fog.density).toBeGreaterThanOrEqual(0.05);
            expect(derived.fog.density).toBeLessThanOrEqual(1);
            expect(derived.exposure).toBeGreaterThanOrEqual(0.8);
            expect(derived.exposure).toBeLessThanOrEqual(1.8);
            expect(derived.rim).toBeGreaterThanOrEqual(0.1);
            expect(derived.rim).toBeLessThanOrEqual(1);
            expect(derived.dust).toBeGreaterThanOrEqual(0);
            expect(derived.dust).toBeLessThanOrEqual(1);
            expect(derived.key.temperature).toBeGreaterThanOrEqual(1500);
            expect(derived.key.temperature).toBeLessThanOrEqual(12_000);
            const [x, y, z] = derived.key.direction;
            expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
            expect(y, `${preset}: světlo zespodu`).toBeGreaterThan(0);
            expect(derived.palette).toBe(look.palette);
            expect(derived.water.present).toBe(look.water.present);
          }
        }
      }
    }
    expect(purple).toEqual([]);
  });

  it('předvolba se čte z hodnoty proměnné, ne z tweenu: první vazba se známou hodnotou rozhoduje', () => {
    const bindings = [
      { variable: 'storm', values: { '0': 'day', '1': 'storm' } },
      { variable: 'hour', values: { '0': 'night', '2': 'dusk' } },
    ] as const;
    const read = (values: Record<string, number>) => (variable: string) => values[variable] ?? null;

    expect(boundLookPreset(bindings, read({ storm: 1, hour: 0 }))).toBe('storm');
    expect(boundLookPreset(bindings, read({ storm: 0, hour: 2 }))).toBe('day');
    // Hodnota mimo tabulku první vazby propadne k další; žádná shoda = žádná předvolba.
    expect(boundLookPreset(bindings, read({ storm: 5, hour: 2 }))).toBe('dusk');
    expect(boundLookPreset(bindings, read({ storm: 5, hour: 9 }))).toBeNull();
    expect(boundLookPreset(bindings, read({}))).toBeNull();
    expect(boundLookPreset([], read({ storm: 1 }))).toBeNull();
  });
});
