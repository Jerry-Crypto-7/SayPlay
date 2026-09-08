import { describe, expect, it } from 'vitest';

import { PALETTES, type PaletteName } from '@/kit';

import { LOOK_BUDGETS, deriveLook, type LookDescriptor, type LookInput, type TerrainKind } from '../look';
import { PURPLE_BAND, acceptLook, hueOf, isPurple } from '../look-schema';

/**
 * Oracle úlohy T9 — **brána, která nepustí nesmysl a nezahodí svět**.
 *
 * Vada, kterou tenhle soubor hlídá, není pád. Je to validátor, který propustí
 * všechno: zelený, hotově vypadající a nechránící nic. Tuhle cestu bude psát
 * model, takže se na jednotlivý vstup nikdo nedívá — jediné, co mezi „model
 * napsal expozici 40" a vypáleným snímkem stojí, je tenhle kontrakt.
 *
 * ## Dvě čísla, která si v zadání odporovala, a jak se to rozhodlo
 *
 * `AC` úlohy říká „odmítne s důvodem hodnotu mimo rozsah", podkrok pod ním
 * říká „hodnoty mimo rozsah se **osekávají do rozpočtu**, ne odmítají" a cituje
 * design book §7.5. Ověřeno v §7.5: *„Smí: normalizovat čísla do rozpočtů."*
 * Platí tedy podkrok — a `s důvodem` z AC se plní tím, že se oseknutí **přizná**
 * v `adjustments` s cestou, oběma čísly a důvodem. Nic se neděje potichu, což
 * je ta vlastnost, kterou AC chtělo.
 *
 * Odmítnutí zůstává pro to, co osekat nejde: chybějící pole, pole navíc, jiný
 * typ, `NaN`, nekonečno, směr bez směru a fialovou.
 */

const WORLD: LookInput = { palette: 'harbor', terrain: 'basin', seed: 4242 };

const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];
const TERRAINS: readonly TerrainKind[] = ['flat', 'ridge', 'basin', 'plateau'];
const SEEDS = [1, 7, 4242, 98_765, 2_147_483_646] as const;

/** Platný autorovaný vzhled. Každý test níž mění právě jedno pole. */
function authored(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(deriveLook(WORLD))) as Record<string, unknown>;
}

/** Barvy, které popis nese. Testy nad odstínem nesmí ani jednu přeskočit. */
function colorsOf(look: LookDescriptor): readonly string[] {
  return [look.sky.color, look.water.color, look.ground.color, look.fog.color];
}

describe('odmítnutí vrací důvod a odvozený vzhled, nikdy prázdno', () => {
  const broken: readonly (readonly [string, unknown])[] = [
    ['prázdný objekt', {}],
    ['chybějící pole', (() => { const look = authored(); delete look.fog; return look; })()],
    ['pole navíc', { ...authored(), mood: 'spooky' }],
    ['číslo jako řetězec', { ...authored(), exposure: '1.2' }],
    ['NaN', { ...authored(), rim: Number.NaN }],
    ['Infinity', { ...authored(), dust: Number.POSITIVE_INFINITY }],
    ['nulový vektor směru', (() => {
      const look = authored();
      look.key = { direction: [0, 0, 0], temperature: 5600 };
      return look;
    })()],
    ['úplně jiný typ', 'a nice sunset'],
    ['null', null],
  ];

  it.each(broken)('%s se odmítne s pojmenovaným důvodem', (_name, input) => {
    const result = acceptLook(input, WORLD);

    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    // Důvod musí být čitelný, ne prázdný řetězec s dvojtečkou.
    for (const issue of result.issues) expect(issue.length).toBeGreaterThan('look:/: '.length);
  });

  it.each(broken)('%s dostane místo prázdna odvozený vzhled', (_name, input) => {
    // Tohle je ta polovina AC, kvůli které podlaha z T2 vůbec existuje:
    // porotce nikdy neuvidí prázdno, i když model napíše cokoliv.
    expect(acceptLook(input, WORLD).look).toStrictEqual(deriveLook(WORLD));
  });

  it('odmítnutí neoseká nic — obě cesty se nemíchají', () => {
    const result = acceptLook({ ...authored(), mood: 'spooky', exposure: 40 }, WORLD);

    expect(result.ok).toBe(false);
    expect(result.adjustments).toHaveLength(0);
  });

  it('`NaN` a `Infinity` neprojdou, i když je nezakazuje žádná mez', () => {
    // Připnuto schválně: nechrání před nimi rozpočty, ale `zod` v4 sám
    // (`plainNaN: false`, `plainInfinity: false`). Kdyby se to ve verzi
    // změnilo, spadne tenhle test, ne až tone-mapping.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(acceptLook({ ...authored(), exposure: value }, WORLD).ok).toBe(false);
    }
  });
});

describe('fialová je tvrdé odmítnutí, ne oseknutí', () => {
  const PURPLES = ['#7c3aed', '#8b5cf6', '#a855f7', '#9333ea', '#2a1f33'] as const;

  it('každý hex, který zakazuje globální pravidlo, pozná i `isPurple`', () => {
    for (const hex of PURPLES) {
      const hue = hueOf(hex);
      expect(hue, `${hex} nemá odstín`).not.toBeNull();
      expect(isPurple(hex), `${hex} má odstín ${String(hue)}`).toBe(true);
    }
  });

  // Čtyři barvy, čtyři cesty. Jediná kontrola nad `sky` by nechala tři otevřené
  // a test by byl zelený — přesně tak vznikla mezera, kterou tenhle soubor
  // zavírá i pro odvozenou cestu (zpáteční jízda níž).
  const FIELDS: readonly (readonly [string, (look: Record<string, unknown>, hex: string) => void])[] = [
    ['sky', (look, hex) => { look.sky = { ...(look.sky as object), color: hex }; }],
    ['water', (look, hex) => { look.water = { ...(look.water as object), color: hex }; }],
    ['ground', (look, hex) => { look.ground = { ...(look.ground as object), color: hex }; }],
    ['fog', (look, hex) => { look.fog = { ...(look.fog as object), color: hex }; }],
  ];

  it.each(FIELDS)('fialová v poli `%s` shodí celý vzhled', (field, set) => {
    for (const hex of PURPLES) {
      const look = authored();
      set(look, hex);
      const result = acceptLook(look, WORLD);

      expect(result.ok, `${field} = ${hex} prošlo`).toBe(false);
      expect(result.issues.join(' ')).toContain(String(PURPLE_BAND.min));
      expect(result.adjustments, 'fialová se nesmí osekat, jen odmítnout').toHaveLength(0);
    }
  });

  it('barva mimo pásmo projde, aby zákaz nebyl zákaz všeho', () => {
    const look = authored();
    look.sky = { ...(look.sky as object), color: '#1d7a6c' };

    expect(acceptLook(look, WORLD).ok).toBe(true);
  });

  it('řetězec, který není hex, se odmítne dřív než se počítá odstín', () => {
    for (const bad of ['rebeccapurple', '#zzz', '#7c3ae', 'rgb(124,58,237)', '']) {
      const look = authored();
      look.sky = { ...(look.sky as object), color: bad };
      expect(acceptLook(look, WORLD).ok, `${bad} prošlo`).toBe(false);
    }
  });
});

describe('čísla mimo rozpočet se osekávají a přiznávají', () => {
  const CASES = [
    ['exposure', 'exposure', 40, LOOK_BUDGETS.exposure.max],
    ['exposure', 'exposure', -5, LOOK_BUDGETS.exposure.min],
    ['dust', 'dust', -3, LOOK_BUDGETS.dust.min],
    ['dust', 'dust', 12, LOOK_BUDGETS.dust.max],
    ['rim', 'rim', 0, LOOK_BUDGETS.rim.min],
    ['rim', 'rim', 9, LOOK_BUDGETS.rim.max],
  ] as const;

  it.each(CASES)('%s = %s se oseká na mez', (field, path, value, expected) => {
    const result = acceptLook({ ...authored(), [field]: value }, WORLD);

    expect(result.ok, 'oseknutí není odmítnutí — §7.5 to dovoluje').toBe(true);
    expect(result.look[field as 'exposure' | 'dust' | 'rim']).toBe(expected);

    const adjustment = result.adjustments.find((entry) => entry.path === path);
    expect(adjustment, `${field} se osekalo potichu`).toBeDefined();
    expect(adjustment?.from).toBe(value);
    expect(adjustment?.to).toBe(expected);
    expect(adjustment?.reason).toContain('clamped');
  });

  it('vnořená čísla se osekávají taky, a nesou svou cestu', () => {
    const look = authored();
    look.sky = { ...(look.sky as object), height: 5 };
    look.fog = { ...(look.fog as object), density: 0 };
    look.key = { direction: [0, 1, 0], temperature: 90_000 };

    const result = acceptLook(look, WORLD);

    expect(result.ok).toBe(true);
    expect(result.look.sky.height).toBe(LOOK_BUDGETS.skyHeight.max);
    expect(result.look.fog.density).toBe(LOOK_BUDGETS.fogDensity.min);
    expect(result.look.key.temperature).toBe(LOOK_BUDGETS.temperature.max);

    expect(result.adjustments.map((entry) => entry.path).sort()).toStrictEqual([
      'fog/density',
      'key/temperature',
      'sky/height',
    ]);
  });

  it('směr se dopočítá na jednotkový a řekne o tom', () => {
    const look = authored();
    look.key = { direction: [0, 3, 4], temperature: 5600 };

    const result = acceptLook(look, WORLD);
    const [x, y, z] = result.look.key.direction;

    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
    expect(result.adjustments).toContainEqual({
      path: 'key/direction',
      from: 5,
      to: 1,
      reason: 'normalised to unit length',
    });
  });

  it('oseknutí je idempotentní — druhý průchod už nic nemění', () => {
    const first = acceptLook({ ...authored(), exposure: 40, dust: -3 }, WORLD);
    const second = acceptLook(first.look, WORLD);

    expect(second.ok).toBe(true);
    expect(second.adjustments).toHaveLength(0);
    expect(second.look).toStrictEqual(first.look);
  });
});

describe('odvozený vzhled prochází vlastním kontraktem', () => {
  // Nejdůležitější test souboru. Rozpočty čte odvození i brána z jednoho místa
  // (`LOOK_BUDGETS`), takže jakmile se jedno z nich pohne samo, tahle zpáteční
  // jízda zčervená. Zároveň projede **všechny čtyři barvy** každého odvozeného
  // vzhledu přes zákaz fialové — což `look.test.ts` u `ground` nedělá, protože
  // to pole přibylo až po něm.
  const worlds = PALETTE_NAMES.flatMap((palette) =>
    TERRAINS.flatMap((terrain) => SEEDS.map((seed) => ({ palette, terrain, seed }))),
  );

  it('každý odvozený vzhled projde beze změny a bez jediného oseknutí', () => {
    for (const world of worlds) {
      const derived = deriveLook(world);
      const result = acceptLook(derived, world);

      expect(result.ok, `${world.palette}/${world.terrain}/${world.seed} neprošel: ${result.issues.join('; ')}`).toBe(true);
      expect(
        result.adjustments,
        `${world.palette}/${world.terrain} se osekal sám sobě: ${JSON.stringify(result.adjustments)}`,
      ).toHaveLength(0);
      expect(result.look).toStrictEqual(derived);
    }
  });

  it('ani jedna ze čtyř barev žádného odvozeného vzhledu nesahá do fialové', () => {
    for (const world of worlds) {
      for (const hex of colorsOf(deriveLook(world))) {
        expect(isPurple(hex), `${world.palette}/${world.terrain}: ${hex}`).toBe(false);
      }
    }
  });

  it('kontrakt zná všechny palety kitu, ne jen ty čtyři z rodin', () => {
    // Paleta mimo kit je odmítnutí; paleta z kitu projít musí. Bez druhé
    // poloviny by výčet mohl zkamenět na jediném jméně.
    for (const palette of PALETTE_NAMES) {
      expect(acceptLook({ ...authored(), palette }, WORLD).ok, palette).toBe(true);
    }
    expect(acceptLook({ ...authored(), palette: 'lavender' }, WORLD).ok).toBe(false);
  });
});
