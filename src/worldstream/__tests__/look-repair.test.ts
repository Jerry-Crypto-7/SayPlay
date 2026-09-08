import { describe, expect, it } from 'vitest';

import { PALETTES, type PaletteName } from '@/kit';

import { IMAGE_PROPERTIES, IMAGE_THRESHOLDS, judgedHueBucket } from '../image-judge';
import { LOOK_BUDGETS, deriveLook, type LookDescriptor, type TerrainKind } from '../look';
import { PURPLE_BAND, acceptLook, hueOf, isPurple } from '../look-schema';
import {
  ALLOWED_HUE_BUCKETS,
  COLOURLESS_SKY_HUE,
  HUE_BUCKET_WIDTH,
  HUE_STEP_BUCKETS,
  LOOK_FLOOR,
  bucketCentre,
  luminanceOf,
  repairLook,
  saturationOf,
} from '../look-repair';

/**
 * Oracle úlohy T11 — **podlaha, ne strop**.
 *
 * Vada, kterou tenhle soubor hlídá, je oprava, která běží, nic nezkazí a nic
 * nezaručí: vrátí vzhled, zapíše pár změn a obraz z něj vyjde přesně tak plochý
 * jako předtím. „Vrátila vzhled" je pravda i o funkci, která nedělá nic, takže
 * se tu neměří, že oprava proběhla — měří se, že po ní **prahy platí**.
 *
 * Druhá vada, se kterou se počítá, je opačná: oprava, která platí až po pátém
 * průchodu. Vzhled se v prohlížeči přepočítává při každé změně světa, takže
 * neidempotentní oprava by barvu posouvala pořád dál a po deseti snímcích by
 * ze světa byla duha. Proto tu stojí vlastní test na druhý průchod.
 */

const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];
const TERRAINS: readonly TerrainKind[] = ['flat', 'ridge', 'basin', 'plateau'];
const SEEDS = [1, 7, 4242, 98_765, 2_147_483_646] as const;

const WORLDS = PALETTE_NAMES.flatMap((palette) =>
  TERRAINS.flatMap((terrain) => SEEDS.map((seed) => ({ palette, terrain, seed }))),
);

/**
 * Barvy pozadí, které jsou na snímku vidět — tři, ne čtyři.
 *
 * Napsané tady znovu schválně: kdyby test volal `visibleBackground` z modulu,
 * měřil by opravu jejím vlastním pravidlem a chyba v tom pravidle by prošla
 * oběma stranami naráz. Deska země leží pod hladinou, takže ve světě s vodou
 * nemaluje ani pixel.
 */
function backgroundOf(look: LookDescriptor): readonly string[] {
  return look.water.present
    ? [look.sky.color, look.water.color, look.fog.color]
    : [look.sky.color, look.ground.color, look.fog.color];
}

function bucketsOf(look: LookDescriptor): Set<number> {
  const buckets = new Set<number>();
  for (const hex of backgroundOf(look)) {
    if (saturationOf(hex) < IMAGE_THRESHOLDS.minSaturation) continue;
    const n = Number.parseInt(hex.slice(1), 16);
    const [r, g, b] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    const max = Math.max(r, g, b);
    const span = max - Math.min(r, g, b);
    if (span === 0) continue;
    let hue: number;
    if (max === r) hue = ((g - b) / span) % 6;
    else if (max === g) hue = (b - r) / span + 2;
    else hue = (r - g) / span + 4;
    buckets.add(Math.floor(((((hue * 60) % 360) + 360) % 360) / HUE_BUCKET_WIDTH));
  }
  return buckets;
}

/** Vzhled, jak ho může vyrobit nešťastná paleta: jedna barva na všechno. */
function flatLook(color = '#8d6a3c'): LookDescriptor {
  return {
    palette: 'dunes',
    sky: { color, height: 0.4 },
    water: { present: false, color },
    ground: { present: true, color },
    fog: { density: LOOK_BUDGETS.fogDensity.min, color },
    key: { direction: [0, 1, 0], temperature: 5200 },
    rim: LOOK_BUDGETS.rim.min,
    exposure: 1.2,
    dust: 0.4,
  };
}

describe('podlaha vytáhne i vzhled, který nemá nic', () => {
  it('plochý vzhled — jedna barva, žádné protisvětlo, žádná mlha — projde po opravě všemi prahy', () => {
    // AC úlohy. Vstup je schválně ta nejhorší legální hodnota každého pole,
    // ne náhodný nesmysl: přesně takový vzhled umí odvození vyrobit z palety,
    // která má jediný odstín.
    const before = flatLook();
    const after = repairLook(before);

    expect(after.ok, `nepovedlo se: ${after.failed.join(', ')}`).toBe(true);
    expect(after.failed).toEqual([]);

    expect(bucketsOf(after.look).size).toBeGreaterThanOrEqual(LOOK_FLOOR.minHueBuckets);
    expect(after.look.rim).toBeGreaterThanOrEqual(LOOK_FLOOR.minRim);
    expect(after.look.fog.density).toBeGreaterThanOrEqual(LOOK_FLOOR.fog.min);
    expect(after.look.fog.density).toBeLessThanOrEqual(LOOK_FLOOR.fog.max);
    expect(luminanceOf(after.look.sky.color) - luminanceOf(after.look.ground.color)).toBeGreaterThanOrEqual(
      LOOK_FLOOR.minValueStep,
    );

    // A ta nejdůležitější polovina: **před** opravou ani jeden z těch prahů
    // neplatil. Bez tohohle by test prošel i nad opravou, která nedělá nic.
    expect(bucketsOf(before).size).toBeLessThan(LOOK_FLOOR.minHueBuckets);
    expect(before.rim).toBeLessThan(LOOK_FLOOR.minRim);
    expect(before.fog.density).toBeLessThan(LOOK_FLOOR.fog.min);
  });

  it('každý odvozený svět obstojí po opravě, všech sto čtyřicet', () => {
    for (const world of WORLDS) {
      const after = repairLook(deriveLook(world));

      expect(
        after.ok,
        `${world.palette}/${world.terrain}/${world.seed}: ${after.failed.join(', ')}`,
      ).toBe(true);
      expect(bucketsOf(after.look).size).toBeGreaterThanOrEqual(LOOK_FLOOR.minHueBuckets);
    }
  });

  it('svět, který tři koše odstínu už má, se v barvách nedotkne', () => {
    // Podlaha, ne přemalování. Oprava, která sahá i na vzhled, jemuž nic
    // nechybí, by zahodila rozdíly mezi světy — a rozdílnost je jediná věc,
    // kterou kontaktní list doopravdy měří.
    const rich: LookDescriptor = {
      ...flatLook(),
      sky: { color: '#3f6f8f', height: 0.5 },
      ground: { color: '#6f4f2f', present: true },
      fog: { density: 0.5, color: '#3f8f6f' },
      rim: 0.6,
    };

    expect(bucketsOf(rich).size).toBeGreaterThanOrEqual(LOOK_FLOOR.minHueBuckets);

    const after = repairLook(rich);

    expect(after.repairs.filter((repair) => repair.property === 'hues')).toEqual([]);
    expect(after.look.sky.color).toBe(rich.sky.color);
    expect(after.look.fog.color).toBe(rich.fog.color);
  });
});

describe('oprava je deterministická, idempotentní a zapsaná', () => {
  it('týž vzhled dá vždy touž opravu', () => {
    expect(repairLook(flatLook())).toStrictEqual(repairLook(flatLook()));
  });

  it('druhý průchod nad opraveným vzhledem nezmění nic', () => {
    for (const world of WORLDS) {
      const first = repairLook(deriveLook(world));
      const second = repairLook(first.look);

      expect(
        second.repairs,
        `${world.palette}/${world.terrain} se opravuje pořád dokola: ${JSON.stringify(second.repairs)}`,
      ).toEqual([]);
      expect(second.look).toStrictEqual(first.look);
    }
  });

  it('opravený plochý vzhled se podruhé neopravuje', () => {
    const once = repairLook(flatLook());
    const twice = repairLook(once.look);

    expect(twice.repairs).toEqual([]);
    expect(twice.look).toStrictEqual(once.look);
  });

  it('krok jasu nesmí sebrat odstín, který krok odstínů právě započítal', () => {
    // **Doložený vstup, ne vymyšlený.** Nezávislé review 29. 8. 2026 protáhlo
    // branou `acceptLook` 25 410 fuzzovaných vzhledů a 174 z nich se při
    // druhém průchodu pohnulo — všech 174 z téhle jediné příčiny: koše se
    // počítají ze země, a krok jasu o pár řádků níž tutéž zem ztmavil do
    // černé, takže jí koš vzal. Průchod dva pak viděl míň než tři koše a
    // otáčel barvy znovu; ze tří průchodů vyšly **tři různé obrazy**.
    //
    // Odvozené světy sem nevedou, takže na tuhle cestu musí vzhled napsaný
    // ručně: obloha tmavší než zem, a zem, která nese jediný koš pozadí.
    const dark: LookDescriptor = {
      ...flatLook(),
      sky: { color: '#0908c1', height: 0.4 },
      ground: { color: '#f63a14', present: true },
      fog: { density: 0.4, color: '#035fff' },
    };

    const once = repairLook(dark);
    const twice = repairLook(once.look);
    const thrice = repairLook(twice.look);

    expect(once.repairs.some((repair) => repair.property === 'luminanceSpread')).toBe(true);
    expect(twice.repairs, JSON.stringify(twice.repairs)).toEqual([]);
    expect(twice.look).toStrictEqual(once.look);
    expect(thrice.look).toStrictEqual(once.look);

    // A to, co tu drží: plocha, kterou krok jasu ztmavil, si koš nechala.
    expect(judgedHueBucket(once.look.ground.color)).toBe(judgedHueBucket(dark.ground.color));
  });

  it('ani jeden z pěti tisíc vzhledů, které projdou branou, se podruhé nepohne', () => {
    // Jediná sada, která tu vadu vidí. Odvozené světy i `flatLook` chodí
    // stejnou úzkou cestou, takže nad nimi stála idempotence zelená celou dobu,
    // co byla rozbitá.
    let state = 987_654_321;
    const random = () => {
      state = (state * 1_103_515_245 + 12_345) & 0x7fff_ffff;
      return state / 0x7fff_ffff;
    };
    const color = () =>
      `#${Array.from({ length: 3 }, () =>
        Math.floor(random() * 256)
          .toString(16)
          .padStart(2, '0'),
      ).join('')}`;

    let checked = 0;
    for (let attempt = 0; attempt < 40_000 && checked < 5_000; attempt += 1) {
      const gate = acceptLook(
        {
          ...flatLook(),
          sky: { color: color(), height: 0.4 },
          water: { present: random() < 0.5, color: color() },
          ground: { present: true, color: color() },
          fog: { density: 0.4, color: color() },
        },
        { palette: 'dunes', terrain: 'flat', seed: 1 },
      );
      if (!gate.ok) continue;
      checked += 1;

      const once = repairLook(gate.look);
      const twice = repairLook(once.look);
      expect(twice.repairs, `${JSON.stringify(gate.look)} se opravuje pořád dokola`).toEqual([]);
      expect(twice.look).toStrictEqual(once.look);
    }

    expect(checked).toBe(5_000);
  });

  it('každá změna nese vlastnost, cestu, obě hodnoty i důvod', () => {
    // Bez tohohle by se v Inspect dalo ukázat jen „něco se opravilo".
    const after = repairLook(flatLook());

    expect(after.repairs.length).toBeGreaterThan(0);
    for (const repair of after.repairs) {
      expect(IMAGE_PROPERTIES, `${repair.path} drží neznámou vlastnost`).toContain(repair.property);
      expect(repair.path).toMatch(/^[a-z]+(\/[a-z]+)?$/);
      expect(repair.from).not.toBe(repair.to);
      expect(repair.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('oprava sahá jen do vzhledu', () => {
  it('nedotkne se ničeho, co patří světu, ne počasí', () => {
    // Geometrii napsal model a paletu vybrala rodina. Přepsat jim je potichu
    // je vada, ne oprava — tenhle test je jediné místo, kde se to dá chytit
    // dřív, než se to objeví v obraze jako svět z jiného materiálu.
    for (const world of WORLDS) {
      const before = deriveLook(world);
      const after = repairLook(before).look;

      expect(after.palette).toBe(before.palette);
      expect(after.water.present).toBe(before.water.present);
      expect(after.ground.present).toBe(before.ground.present);
      expect(after.key.direction).toStrictEqual(before.key.direction);
      expect(after.key.temperature).toBe(before.key.temperature);
      expect(after.dust).toBe(before.dust);
      expect(after.sky.height).toBe(before.sky.height);
    }
  });

  it('opravený vzhled pořád projde branou z T9', () => {
    // Podlaha nesmí vyrobit něco, co kontrakt vzhledu odmítne — to by byl
    // rozpor, ve kterém by scéna dostala odvozený vzhled místo opraveného
    // a celá oprava by tiše zmizela.
    for (const world of WORLDS) {
      const repaired = repairLook(deriveLook(world)).look;
      const accepted = acceptLook(repaired, world);

      expect(
        accepted.ok,
        `${world.palette}/${world.terrain}: ${accepted.issues.join('; ')}`,
      ).toBe(true);
      expect(accepted.adjustments).toEqual([]);
    }
  });

  it('podlaha leží uvnitř rozpočtu, ne mimo něj', () => {
    expect(LOOK_FLOOR.exposure.min).toBeGreaterThanOrEqual(LOOK_BUDGETS.exposure.min);
    expect(LOOK_FLOOR.exposure.max).toBeLessThanOrEqual(LOOK_BUDGETS.exposure.max);
    expect(LOOK_FLOOR.fog.min).toBeGreaterThanOrEqual(LOOK_BUDGETS.fogDensity.min);
    expect(LOOK_FLOOR.fog.max).toBeLessThanOrEqual(LOOK_BUDGETS.fogDensity.max);
    expect(LOOK_FLOOR.minRim).toBeGreaterThanOrEqual(LOOK_BUDGETS.rim.min);
  });
});

describe('fialová se neopraví ani omylem', () => {
  it('žádný koš, do kterého oprava smí mířit, neleží ve fialovém pásmu', () => {
    // Od 29. 8. 2026 se necílí na tři pevné odstíny, ale kamkoli po prstenci
    // povolených košů — takže se tenhle test musí ptát na **všechny**, ne na tři.
    expect(ALLOWED_HUE_BUCKETS.length).toBeGreaterThan(0);
    for (const bucket of ALLOWED_HUE_BUCKETS) {
      const centre = bucketCentre(bucket);
      expect(centre < PURPLE_BAND.min || centre > PURPLE_BAND.max, String(centre)).toBe(true);
    }
  });

  it('prstenec sahá až po fialovou a ani o koš míň', () => {
    // Dvě mutace naráz. Kdyby se prstenec jen usekl na počet, prošel by test
    // nad středy taky — a kdyby se usekl o koš navíc, přišla by oprava o odstín,
    // který jí nikdo nezakázal, a světy by se sbíhaly rychleji.
    //
    // Meze se **nečtou z modulu**, jsou napsané tady znovu: test, který si
    // hranici půjčí od kódu, potvrdí každou hranici, kterou si kód zvolí.
    const PLUM_FROM = 320;
    for (const bucket of ALLOWED_HUE_BUCKETS) {
      const centre = bucketCentre(bucket);
      expect(centre, 'koš ' + String(bucket) + ' míří do fialové').toBeLessThan(PURPLE_BAND.min);
      expect(centre, 'koš ' + String(bucket) + ' míří za fialovou, do švestkové').toBeLessThan(
        PLUM_FROM,
      );
    }
    for (let bucket = 0; bucket < 360 / HUE_BUCKET_WIDTH; bucket += 1) {
      if (bucketCentre(bucket) >= PURPLE_BAND.min) continue;
      expect(
        ALLOWED_HUE_BUCKETS,
        'koš ' + String(bucket) + ' (' + String(bucketCentre(bucket)) + '°) nikdo nezakázal',
      ).toContain(bucket);
    }
  });

  it('ani jedna barva žádného opraveného světa nesahá do fialové', () => {
    for (const world of WORLDS) {
      for (const hex of backgroundOf(repairLook(deriveLook(world)).look)) {
        expect(isPurple(hex), `${world.palette}/${world.terrain}: ${hex}`).toBe(false);
      }
    }
  });

  it('fialový vstup oprava nerozmnoží do plochy, kterou sama otočí', () => {
    // Fialový vzhled dnes vzniknout nemůže: `deriveLook` ho nevyrobí a brána
    // z T9 ho nepustí. Tenhle test proto netvrdí, že oprava fialovou **uklidí**
    // — otáčí nejmenší počet ploch, který stačí, a na tu poslední se nemusí
    // dostat. Tvrdí to jediné, co je její věc: co otočí, otočí mimo pásmo.
    const after = repairLook(flatLook('#7c3aed'));
    const rotated = after.repairs.filter((repair) => repair.property === 'hues');

    expect(rotated.length, 'jednobarevný vzhled musí opravu vyvolat').toBeGreaterThan(0);
    for (const repair of rotated) {
      expect(isPurple(String(repair.to)), `${repair.path} → ${String(repair.to)}`).toBe(false);
    }
  });
});

describe('co se opravit nedá, skončí pojmenovaným selháním', () => {
  it('téměř černá obloha se od země neodstupní a řekne to', () => {
    const night = repairLook({ ...flatLook('#040404'), sky: { color: '#050505', height: 0.4 } });

    expect(night.ok).toBe(false);
    expect(night.failed).toContain('luminanceSpread');
  });

  it('selhání se neschovává za prázdný seznam oprav', () => {
    // Ticho by se od úspěchu nedalo rozeznat: oprava, která nic nezapsala a nic
    // nenahlásila, vypadá stejně jako svět, kterému nic nechybělo.
    const night = repairLook({ ...flatLook('#040404'), sky: { color: '#050505', height: 0.4 } });

    expect(night.repairs.length).toBeGreaterThan(0);
    expect(night.failed.length).toBeGreaterThan(0);
  });

  it('a přesto se vzhled vrací opravený, jak to šlo', () => {
    // Scéna musí něco dostat. Prahy, na které oprava dosáhne, platí i ve světě,
    // který jako celek neobstojí.
    const night = repairLook({ ...flatLook('#040404'), sky: { color: '#050505', height: 0.4 } });

    expect(night.ok).toBe(false);
    expect(night.look.rim).toBeGreaterThanOrEqual(LOOK_FLOOR.minRim);
    expect(night.look.fog.density).toBeGreaterThanOrEqual(LOOK_FLOOR.fog.min);
  });
});

/**
 * Tři vady, kvůli kterým podlaha neplatila, a všechny prošly kolem prvních
 * asercí.
 *
 * Test o sto čtyřiceti světech chytil dvě z nich, jenže pod jménem, které
 * o příčině neříká nic („foundry/flat/1: hues"). Třetí — otočená obloha —
 * neshodila jednotkový test vůbec, protože se projeví až v obraze. Tyhle testy
 * pojmenují **pravidlo**, takže se z červené barvy dá poznat, které se porušilo.
 */
describe('tři vady, kvůli kterým podlaha neplatila', () => {
  it('tmavá kovová barva je pro opravu barva, ne šedá', () => {
    // `#2b3033` je zem světa `foundry`. Poměrná sytost 0,157 je nad prahem
    // soudce, absolutní rozpětí kanálů 0,031 pod prahem `hueOf`. Dokud si
    // oprava počítala koše vlastním pravidlem složeným z obojího, byla ta barva
    // pro ni šedá a pro soudce barevná — a `foundry` propadal prahu, který si
    // oprava odškrtla jako splněný.
    expect(saturationOf('#2b3033')).toBeGreaterThanOrEqual(IMAGE_THRESHOLDS.minSaturation);
    expect(hueOf('#2b3033'), 'zákaz fialové tuhle barvu za barvu nepovažuje').toBeNull();
    expect(judgedHueBucket('#2b3033'), 'soudce ano — a rozhoduje soudce').not.toBeNull();

    const foundry = repairLook(deriveLook({ palette: 'foundry', terrain: 'flat', seed: 1 }));
    expect(foundry.ok, foundry.failed.join(', ')).toBe(true);
  });

  it('zem pod hladinou nedodá třetí odstín, ať má jakoukoli barvu', () => {
    // Naměřeno 29. 8. 2026 na `frost-plateau`: hladina maluje 50,6 % snímku,
    // obloha 31,8 %, země není vidět nikde. Oprava přesto otočila **ji**, popis
    // vzhledu vykázal tři koše a soudce v obraze viděl dva.
    //
    // Vzhled níž je na tu vadu ušitý: obloha a voda drží týž koš, opar druhý
    // a **třetí drží jen zem** — kterou nikdo neuvidí. Oprava, která ji do
    // počtu bere, se tady nechá odbýt a neudělá nic. Odvozený svět tuhle vadu
    // nechytí: tam vyjdou nejdřív všechny čtyři plochy stejné, takže se oprava
    // spustí tak jako tak.
    const submerged: LookDescriptor = {
      ...flatLook(),
      sky: { color: '#3d5f6a', height: 0.4 },
      water: { present: true, color: '#3d6a7a' },
      fog: { density: 0.5, color: '#3d7a6a' },
      ground: { present: true, color: '#4a3620' },
    };

    const after = repairLook(submerged);

    expect(
      after.repairs.some((repair) => repair.property === 'hues'),
      'oprava se nechala odbýt odstínem země, kterou nikdo neuvidí',
    ).toBe(true);
    expect(
      after.repairs.filter((repair) => repair.property === 'hues').map((repair) => repair.path),
      'zem se kvůli odstínům otáčet nemá — pod hladinou nemaluje ani pixel',
    ).not.toContain('ground/color');

    // A tvrdší polovina: tři koše musí vyjít **bez** země.
    const visible = new Set(
      [after.look.sky.color, after.look.water.color, after.look.fog.color]
        .map(judgedHueBucket)
        .filter((bucket) => bucket !== null),
    );
    expect(visible.size).toBeGreaterThanOrEqual(LOOK_FLOOR.minHueBuckets);
  });

  it('odstup jasu se měří proti hladině, ne proti desce pod ní', () => {
    // **Táž vada o jedno patro níž.** Pro odstíny se deska pod hladinou
    // nepočítala, pro jas ano: krok jasu porovnával oblohu vždycky se zemí.
    // Naměřeno 30. 8. 2026 nad 25 410 fuzzovanými vzhledy, které projdou
    // branou: **7 390 světů s vodou** vyšlo jako `ok: true` se dvěma
    // viditelnými plochami blíž, než práh dovolí.
    //
    // Vzhled níž je doložený vstup review. Obloha a voda stojí 0,048 od sebe
    // proti podlaze 0,06, ale zem má jas 0,006, takže staré měření nevidělo
    // vadu nikde.
    const lagoon: LookDescriptor = {
      ...flatLook(),
      sky: { color: '#6f97b4', height: 0.4 },
      water: { present: true, color: '#a97f4e' },
      ground: { present: true, color: '#101010' },
      fog: { density: 0.4, color: '#12c20b' },
    };

    expect(
      luminanceOf(lagoon.sky.color) - luminanceOf(lagoon.water.color),
      'vstup už tu vadu nemá — test by měřil nic',
    ).toBeLessThan(LOOK_FLOOR.minValueStep);

    const after = repairLook(lagoon);

    expect(after.repairs.map((repair) => repair.path)).toContain('water/color');
    expect(
      luminanceOf(after.look.sky.color) - luminanceOf(after.look.water.color),
      'obloha a hladina pořád stojí v téže hodnotě',
    ).toBeGreaterThanOrEqual(LOOK_FLOOR.minValueStep);
    expect(
      after.look.ground.color,
      'ztmavila se deska pod hladinou, která nemaluje ani pixel',
    ).toBe(lagoon.ground.color);
  });

  it('a nehlásí vadu obrazu, kterému nic není', () => {
    // Opačný konec téže osy: deska pod hladinou stojí obloze v jasu blízko,
    // hladina má odstup. Staré měření tu ohlásilo `failed: ['luminanceSpread']`
    // u snímku, na kterém ta deska není vidět.
    const shallow: LookDescriptor = {
      ...flatLook(),
      sky: { color: '#a0c8dd', height: 0.4 },
      water: { present: true, color: '#4a3620' },
      ground: { present: true, color: '#c8d2d8' },
      fog: { density: 0.4, color: '#3d7a6a' },
    };

    expect(
      luminanceOf(shallow.sky.color) - luminanceOf(shallow.ground.color),
      'vstup musí mít neviditelnou zem blízko obloze, jinak test neměří nic',
    ).toBeLessThan(LOOK_FLOOR.minValueStep);

    const after = repairLook(shallow);

    expect(after.failed).not.toContain('luminanceSpread');
    expect(after.repairs.map((repair) => repair.path)).not.toContain('ground/color');
  });

  it('obloha je poslední plocha, které se oprava dotkne', () => {
    // Obloha je třetina snímku a nese charakter světa. Když stačí opar a plocha
    // pod obzorem, obloha zůstává. Naměřeno 29. 8. 2026, proč: dokud se otáčela
    // první, dostal `kiln-court` místo teplé pece studenou modř a jeho mrtvá
    // plocha vyskočila z 0,493 na 0,597, tedy nad práh soudce.
    const before = deriveLook({ palette: 'kiln', terrain: 'flat', seed: 1 });
    const after = repairLook(before);

    expect(after.ok, after.failed.join(', ')).toBe(true);
    expect(after.look.sky.color, 'pec přišla o teplou oblohu, a nemusela').toBe(before.sky.color);
    expect(after.repairs.some((repair) => repair.path === 'sky/color')).toBe(false);
  });

  it('bezbarvá obloha dostane nejmenší nádech, který soudce rozezná', () => {
    // Šedá plocha nemaluje žádný koš a rotace to nezmění, protože nese sytost
    // s sebou. Svět `worldstream` má oblohu se sytostí 0,085, takže mu bez
    // nabarvení zbývaly dvě plochy na tři koše.
    const before = deriveLook({ palette: 'worldstream', terrain: 'flat', seed: 1 });
    expect(saturationOf(before.sky.color)).toBeLessThan(IMAGE_THRESHOLDS.minSaturation);

    const after = repairLook(before);

    expect(after.ok, after.failed.join(', ')).toBe(true);
    expect(judgedHueBucket(after.look.sky.color), 'obloha pořád nemá odstín').not.toBeNull();
    // Nádech, ne přemalování: nad prahem soudce, ale hluboko pod barvou, kterou
    // by si někdo vymyslel. Horní mez je tu proto, že bez ní by testem prošla
    // i oprava, která šedé obloze nasadí sytost 0,9.
    expect(saturationOf(after.look.sky.color)).toBeGreaterThan(IMAGE_THRESHOLDS.minSaturation);
    expect(saturationOf(after.look.sky.color)).toBeLessThan(IMAGE_THRESHOLDS.minSaturation * 2);
  });

  it('šedý vzhled se opraví — nádech není vymyšlená barva', () => {
    // Dřív to byl případ, který oprava vzdala. Je to ale právě ten bezbarvý
    // prostor, kvůli kterému podlaha existuje, a nádech na prahu soudce si
    // nevymýšlí nic, co by svět neměl: sytost je jediné, co se dopisuje.
    const grey = repairLook(flatLook('#808080'));

    expect(grey.ok, grey.failed.join(', ')).toBe(true);
    for (const hex of backgroundOf(grey.look)) {
      expect(judgedHueBucket(hex), `${hex} nemá odstín`).not.toBeNull();
    }
  });
});

describe('kotvy se váží na oblohu toho světa, ne na tři pevné odstíny', () => {
  /**
   * Vada, kterou tenhle blok hlídá, je **sbíhavost**: oprava, která běží,
   * splní všech pět prahů u každého snímku zvlášť, a přitom rozdá všem světům
   * tytéž tři barvy. Soudce ji nechytí, protože soudí jeden snímek po druhém a
   * pojem „jiný než ostatní" nezná — je to vlastnost dvojice, ne snímku.
   *
   * Naměřeno 29. 8. 2026 nad absolutními kotvami: přístav dostal 196 / 166 / 44
   * a poušť 37 / 195 / 165, tedy **tytéž tři koše, jen jinak rozdané**. Průměrná
   * barva obou snímků pak stála 2,7 od sebe proti prahu 8 v e2e sadě.
   */

  it('vysvětlivka jmenuje tentýž počet košů, o kolik se barva doopravdy hnula', () => {
    // `LookRepair.reason` se v Inspect ukazuje vedle propadlého prahu, takže to
    // čte porotce. Prohození kotev 29. 8. 2026 nechalo texty být: páka oparu
    // pořád tvrdila „one bucket", zatímco kód šel o čtyři, a páka vody slibovala
    // „furthest apart", přestože je z těch dvou ta bližší.
    //
    // Text se proto počítá z `HUE_STEP_BUCKETS` a tenhle test měří, že to
    // číslo souhlasí s **naměřenou** vzdáleností po prstenci — ne se sebou samým.
    const after = repairLook(flatLook());
    const skyBucket = judgedHueBucket(after.look.sky.color);
    expect(skyBucket, 'obloha nemá koš, od kterého se dá měřit').not.toBeNull();
    const start = ALLOWED_HUE_BUCKETS.indexOf(skyBucket!);
    expect(start, 'obloha stojí mimo prstenec, test měří něco jiného').toBeGreaterThanOrEqual(0);

    const moved = after.repairs.filter(
      (repair) => repair.property === 'hues' && repair.path !== 'sky/color',
    );
    expect(moved.length, 'nic se neotočilo, text není z čeho soudit').toBeGreaterThan(0);

    for (const repair of moved) {
      const bucket = judgedHueBucket(String(repair.to));
      expect(bucket, `${repair.path} skončil bez odstínu`).not.toBeNull();

      const steps =
        (ALLOWED_HUE_BUCKETS.indexOf(bucket!) - start + ALLOWED_HUE_BUCKETS.length) %
        ALLOWED_HUE_BUCKETS.length;
      const claimed = /steps ([0-9]+) buckets on/.exec(repair.reason)?.[1];

      expect(claimed, `${repair.path}: text nejmenuje počet košů — "${repair.reason}"`).toBe(
        String(steps),
      );
    }
  });

  it('krok po prstenci nechá mezi každými dvěma plochami celý prázdný koš', () => {
    // **Tohle je ta tabulka u `HUE_STEP_BUCKETS`, jen strojově.** Ta tabulka
    // se jednou už rozešla s kódem: byla naměřená nad devítiprvkovým prstencem
    // a commit, který z ringu vyhodil koš 11, ji nechal být — po něm neplatil
    // ani jeden její řádek, a nikdo se to nedozvěděl, protože komentář nikdo
    // nespustí.
    //
    // Drží se vlastnost, ne čísla: ať má prstenec kolik chce košů, trojice
    // musí vyjít **různá** a s rezervou celého prázdného koše, kterou
    // zaokrouhlení do osmi bitů nesebere. Krok 4 nad osmi koši ji poruší —
    // `start` a `start + 4` je po dvojím kroku tentýž koš.
    for (let start = 0; start < ALLOWED_HUE_BUCKETS.length; start += 1) {
      const trio = [0, HUE_STEP_BUCKETS, HUE_STEP_BUCKETS * 2].map(
        (steps) => ALLOWED_HUE_BUCKETS[(start + steps) % ALLOWED_HUE_BUCKETS.length]!,
      );

      expect(new Set(trio).size, `start ${String(start)}: trojice ${trio.join('/')} není trojice`).toBe(3);

      for (let i = 0; i < trio.length; i += 1) {
        for (let j = i + 1; j < trio.length; j += 1) {
          const raw = Math.abs(bucketCentre(trio[i]!) - bucketCentre(trio[j]!));
          expect(
            Math.min(raw, 360 - raw),
            `start ${String(start)}: koše ${String(trio[i])} a ${String(trio[j])} stojí bez mezery`,
          ).toBeGreaterThanOrEqual(HUE_BUCKET_WIDTH * 2);
        }
      }
    }
  });

  it('přístav a poušť sdílejí nejvýš jeden koš ze tří', () => {
    // Ta naměřená vada, přišpendlená na dvojici, na které se ukázala.
    //
    // **Do 29. 8. 2026 sdílely všechny tři** — {1, 5, 6} obojí, jen jinak
    // rozdané. Práh je jeden, protože při jednom sdíleném koši nese každý ze
    // dvou světů dvě plochy v odstínu, který ten druhý nemá; při dvou už je to
    // jedna plocha a snímky se v průměru barvy začnou sbíhat zpátky.
    const harbor = bucketsOf(
      repairLook(deriveLook({ palette: 'harbor', terrain: 'flat', seed: 1 })).look,
    );
    const dunes = bucketsOf(
      repairLook(deriveLook({ palette: 'dunes', terrain: 'flat', seed: 1 })).look,
    );

    expect(harbor.size, 'přístav nemá tři koše, test měří něco jiného').toBe(3);
    expect(dunes.size, 'poušť nemá tři koše, test měří něco jiného').toBe(3);
    const shared = [...harbor].filter((bucket) => dunes.has(bucket));
    expect(shared.length, 'sdílené koše: ' + shared.join(', ')).toBeLessThanOrEqual(1);
  });

  it('dva světy s různou oblohou nedostanou tutéž trojici košů', () => {
    // Obecná podoba téhož: koš oblohy určuje celou trojici, takže dva světy,
    // které se liší oblohou, se musí lišit i pozadím. Světy se **stejnou**
    // oblohou tutéž trojici dostat smí a mají — rozlišuje je jas a sytost,
    // kterých se oprava nedotkne.
    const bySky = new Map<number, Set<string>>();
    for (const world of WORLDS) {
      const repaired = repairLook(deriveLook(world)).look;
      const sky = judgedHueBucket(repaired.sky.color);
      if (sky === null) continue;
      const triple = [...bucketsOf(repaired)].sort((a, b) => a - b).join('-');
      if (!bySky.has(sky)) bySky.set(sky, new Set());
      bySky.get(sky)!.add(triple);
    }

    expect(bySky.size, 'měří se míň než dvě oblohy, invariant se nedá porušit').toBeGreaterThan(1);
    const triples = [...bySky.values()].flatMap((set) => [...set]);
    expect(
      new Set(triples).size,
      String(bySky.size) + ' obloh dalo jen ' + String(new Set(triples).size) + ' trojic',
    ).toBe(triples.length);
  });

  it('obloha nikdy neopustí svůj koš', () => {
    // Nosná vlastnost celého návrhu — a zároveň to, co drží pec teplou. Kdyby
    // se obloha směla otočit jinam, byla by z ní studená modř a mrtvá plocha
    // světa kiln-court by vyskočila na 0,597, tedy nad práh soudce.
    for (const world of WORLDS) {
      const before = deriveLook(world);
      const skyBefore = judgedHueBucket(before.sky.color);
      if (skyBefore === null) continue;
      const after = repairLook(before).look;
      expect(
        judgedHueBucket(after.sky.color),
        world.palette + '/' + world.terrain + '/' + String(world.seed),
      ).toBe(skyBefore);
    }
  });

  it('trojice drží rozestup, který zaokrouhlení do osmi bitů nesebere', () => {
    // 60° při šířce koše 30° znamená celý prázdný koš mezi sousedy. Bez tohohle
    // testu by prošel i krok o jeden koš — devět různých trojic dá taky, jenže
    // bez rezervy, a barva spočítaná na hranu koše se po zaokrouhlení do osmi
    // bitů přelije k sousedovi.
    expect(HUE_STEP_BUCKETS).toBeGreaterThanOrEqual(2);
    const gap = (a: number, b: number) => {
      const raw = Math.abs(bucketCentre(a) - bucketCentre(b));
      return Math.min(raw, 360 - raw);
    };
    for (let index = 0; index < ALLOWED_HUE_BUCKETS.length; index += 1) {
      const at = (steps: number) =>
        ALLOWED_HUE_BUCKETS[(index + steps) % ALLOWED_HUE_BUCKETS.length]!;
      const [sky, fog, floor] = [at(0), at(HUE_STEP_BUCKETS), at(HUE_STEP_BUCKETS * 2)];
      expect(new Set([sky, fog, floor]).size, 'koš ' + String(sky) + ' nedá tři různé').toBe(3);
      for (const [a, b] of [
        [sky, fog],
        [fog, floor],
        [sky, floor],
      ] as const) {
        expect(
          gap(a, b),
          'koše ' + String(a) + ' a ' + String(b) + ' stojí příliš blízko',
        ).toBeGreaterThanOrEqual(HUE_BUCKET_WIDTH * 2);
      }
    }
  });
});

describe('páka oblohy — jediná, kterou 140 odvozených světů nespustí', () => {
  /**
   * **Naměřeno 29. 8. 2026 mutací, která přežila.** Test „obloha nikdy
   * neopustí svůj koš" nad `WORLDS` prošel i tehdy, když se páce oblohy
   * podstrčil cíl o koš vedle — protože na žádném z těch 140 světů se k ní
   * oprava nedostane. Opar a plocha pod obzorem stačí vždy, páka oblohy je
   * poslední a smyčka se do ní neprokouše.
   *
   * Vlastnost tím nezmizela, jen ji nešlo měřit tam, kde se měřila. Tenhle
   * blok ji proto zkouší na dvou vzhledech, které tu páku **spustit musí**.
   */

  it('bezbarvá obloha se posadí na odstín, ze kterého se prstenec odpíchne', () => {
    // Šedá obloha koš nemaluje, takže se od ní odpíchnout nedá a začátek
    // prstence je volba. Je to chladná modř — ta, na které stála absolutní
    // kotva do 29. 8. 2026, aby se šedý svět tou změnou nehnul.
    const before = deriveLook({ palette: 'worldstream', terrain: 'flat', seed: 1 });
    expect(judgedHueBucket(before.sky.color), 'obloha odstín má, test měří něco jiného').toBeNull();

    const after = repairLook(before);

    expect(after.repairs.some((repair) => repair.path === 'sky/color'), 'páka oblohy nespustila').toBe(true);
    expect(judgedHueBucket(after.look.sky.color)).toBe(
      Math.floor(COLOURLESS_SKY_HUE / HUE_BUCKET_WIDTH),
    );
  });

  it('barevná obloha, které se oprava dotkne, zůstane ve svém koši', () => {
    // Vzhled postavený tak, aby se smyčka k obloze dostala: zem je černá, a tu
    // rotace odstínu nevytáhne (sytost se počítá z jasu, nula krát cokoliv je
    // nula). Opar tedy zbarví jednu plochu, zem žádnou, a na tři koše to pořád
    // nestačí — takže přijde na řadu obloha.
    const sky = '#66473a';
    const before: LookDescriptor = {
      ...flatLook(sky),
      ground: { present: true, color: '#000000' },
    };
    const skyBucket = judgedHueBucket(sky);
    expect(skyBucket, 'obloha testu nemá odstín').not.toBeNull();

    const after = repairLook(before);

    expect(after.repairs.some((repair) => repair.path === 'sky/color'), 'páka oblohy nespustila').toBe(true);
    expect(judgedHueBucket(after.look.sky.color), 'obloha se odstěhovala do cizího koše').toBe(
      skyBucket,
    );
  });

  it('a zůstane i v koši, který prstenec nemá — dokud není fialový', () => {
    // **Prstenec je užší než zákaz fialové a obloha do něj nepatří.** Koš 11
    // (střed 345°) z něj vypadl kvůli zaprášené švestkové, kterou oprava sama
    // vyrábí. Obloha je ale plocha zděděná po světě, ne vyrobená opravou —
    // `acceptLook` karmínovou pustí a nic ji zakazovat nemá.
    //
    // Naměřeno 30. 8. 2026: nad 25 410 vzhledy branou se tahle cesta neotevřela
    // ani jednou, protože páku oblohy spustí až svět, kde obě zbylé plochy
    // nemají co otočit. V tom jediném doloženém případě je ale ztráta čistá —
    // černé plochy koš nenesou, takže `failed` hlásí `hues` tak jako tak
    // a za přemalovaný západ se nekoupí nic.
    const crimson = '#bf5f8f';
    expect(judgedHueBucket(crimson), 'test měří jiný koš, než o který jde').toBe(11);
    expect(ALLOWED_HUE_BUCKETS, 'koš 11 je v prstenci, test neměří nic').not.toContain(11);
    expect(isPurple(crimson), 'karmín je fialový — pak se stěhovat má').toBe(false);

    const after = repairLook({
      ...flatLook(crimson),
      sky: { color: crimson, height: 0.4 },
      ground: { present: true, color: '#000000' },
      fog: { density: 0.4, color: '#000000' },
    });

    // Doráz doprostřed koše je v pořádku a dělá se i uvnitř prstence — drží se
    // **koš**, ne přesný odstín. Co se stát nesmí, je stěhování do koše 0.
    expect(judgedHueBucket(after.look.sky.color), 'karmínový západ zhnědl').toBe(11);
    expect(isPurple(after.look.sky.color)).toBe(false);
  });

  it('ale fialová obloha se odstěhuje, i když je to jediná plocha s odstínem', () => {
    // Druhá strana téhož: koše 8–10 leží uvnitř zákazu fialové, takže si je
    // obloha nechat nesmí. Bez tohohle testu by výjimka pro koš 11 šla napsat
    // jako „obloha si nechá koš vždycky" a fialová by prošla.
    const plum = '#bf5fd0';
    expect(isPurple(plum), 'test měří barvu, která fialová není').toBe(true);

    const after = repairLook({
      ...flatLook(plum),
      sky: { color: plum, height: 0.4 },
      ground: { present: true, color: '#000000' },
      fog: { density: 0.4, color: '#000000' },
    });

    expect(after.repairs.map((repair) => repair.path)).toContain('sky/color');
    expect(isPurple(after.look.sky.color), 'fialová obloha zůstala fialová').toBe(false);
  });
});

describe('rotace odstínu nese jas beze změny', () => {
  /**
   * **Hlavička modulu to tvrdila od začátku a do 29. 8. 2026 to nebyla pravda.**
   * `withHue` držel při rotaci HSV *value*, tedy nejvyšší kanál — jenže jas
   * podle Rec. 709 váží zelenou 0,715 a červenou 0,213. Otočení tyrkysu do
   * červené proto snížilo jas až o 27 %, aniž o tom kdokoliv věděl.
   *
   * Naměřený následek: `foundry-hall` propadl na kontaktním listu mrtvou
   * plochou **0,528 → 0,597**, přestože se mu měnil jen odstín oparu. `dead`
   * se přitom počítá **výhradně z jasu** — buňka je mrtvá, když má rozpětí jasu
   * pod `deadRange`. Oprava, která má srovnat odstíny, tak tiše rozhodovala
   * o prahu, se kterým nemá nic společného.
   */

  const EIGHT_BIT_NOISE = 0.01;

  /** Nejvyšší kanál. Na 255 stojí barva na stropu svého odstínu — tam se ořezává. */
  function peakChannel(hex: string): number {
    const value = Number.parseInt(hex.slice(1), 16);
    return Math.max((value >> 16) & 255, (value >> 8) & 255, value & 255);
  }

  it('žádná opravená plocha nezmění jas o víc, než co spolkne osm bitů', () => {
    // ⚠ **Tohle je vlastnost téhle sady světů, ne záruka kódu** — a stálo to
    // jeden nález. Nad 140 odvozenými světy se otočí 300 ploch a ani jedna
    // z nich nedosáhne na oříznutí, takže jas vyjde vždycky přesně. Kdyby
    // aserce níž zůstala sama, četla by se jako „rotace jas nikdy nezmění",
    // což pravda není: nad vzhledy, které projdou branou, se ořízne skoro
    // každá pátá a jedna z nich ztratí 0,61.
    //
    // Druhá aserce proto **měří ten předpoklad**, ne jen důsledek. Kdyby se
    // odvozené světy jednou posunuly do jasů, na které odstín nedosáhne,
    // spadne tady — a ne o dvě sady dál na nesrozumitelném čísle.
    let rotations = 0;
    for (const world of WORLDS) {
      for (const repair of repairLook(deriveLook(world)).repairs) {
        if (repair.property !== 'hues') continue;
        rotations += 1;
        const from = luminanceOf(String(repair.from));
        const to = luminanceOf(String(repair.to));

        expect(
          peakChannel(String(repair.to)),
          world.palette + '/' + repair.path + ': tenhle svět na oříznutí dosáhl, ' +
            'takže se nad ním jas přenášet nedá a aserce níž měří něco jiného',
        ).toBeLessThan(255);
        expect(
          Math.abs(to - from),
          world.palette + '/' + repair.path + ': ' + from.toFixed(3) + ' -> ' + to.toFixed(3),
        ).toBeLessThanOrEqual(EIGHT_BIT_NOISE);
      }
    }

    expect(rotations, 'sada přestala otáčet plochy, test neměří nic').toBeGreaterThan(0);
  });

  it('na stropu odstínu ustoupí až na jeho nejjasnější barvu — a tam skončí', () => {
    // Cesta, na kterou 140 odvozených světů nedojde. Sytá zeleň má v Rec. 709
    // jas 0,715; červená při plné sytosti nejvýš 0,213, takže stejně jasnou
    // červeň z ní udělat nelze a `Math.min(1, wanted / unit)` se uplatní.
    //
    // Co se v tom případě slibuje: oprava **ustoupí, nedorovná**. Vezme
    // nejjasnější barvu, kterou ten odstín má — tedy `value` na stropu — a víc
    // z ní nevytáhne. Rozsvítit ji přes předlohu by znamenalo vymyslet barvu,
    // kterou svět nikdy neměl.
    const green = repairLook(flatLook('#00ff00'));
    const ceiling = luminanceOf('#00ff00');
    const rotated = green.repairs.filter((repair) => repair.property === 'hues');

    expect(rotated.length, 'jednobarevný vzhled musí opravu vyvolat').toBeGreaterThan(0);

    const clamped = rotated.filter((repair) => peakChannel(String(repair.to)) === 255);
    expect(
      clamped.length,
      'ani jedna plocha na oříznutí nedosáhla — test měří tutéž větev jako ten nad ním',
    ).toBeGreaterThan(0);

    for (const repair of clamped) {
      expect(
        luminanceOf(String(repair.to)),
        repair.path + ': jas se dorovnal nahoru místo ústupu',
      ).toBeLessThan(ceiling);
    }
  });

  it('a ať se ořízne, nebo ne, žádná rotace jas nezvedne', () => {
    // Jediná půlka, která platí **vždycky** — a proto se měří nad vzhledy,
    // které projdou branou, ne nad odvozenými světy. Naměřeno 30. 8. 2026:
    // z 12 777 rotací nad 25 410 vzhledy se 2 284 ořízlo (skoro každá pátá),
    // nejhorší ztratila 0,61 jasu (`#e3f606 → #0644ff`, 0,881 → 0,268),
    // a **ani jedna** jas nezvedla.
    let state = 555_777;
    const random = () => {
      state = (state * 1_103_515_245 + 12_345) & 0x7fff_ffff;
      return state / 0x7fff_ffff;
    };
    const color = () =>
      `#${Array.from({ length: 3 }, () =>
        Math.floor(random() * 256)
          .toString(16)
          .padStart(2, '0'),
      ).join('')}`;

    let rotations = 0;
    let clamped = 0;
    let checked = 0;
    for (let attempt = 0; attempt < 40_000 && checked < 5_000; attempt += 1) {
      const gate = acceptLook(
        {
          ...flatLook(),
          sky: { color: color(), height: 0.4 },
          water: { present: random() < 0.5, color: color() },
          ground: { present: true, color: color() },
          fog: { density: 0.4, color: color() },
        },
        { palette: 'dunes', terrain: 'flat', seed: 1 },
      );
      if (!gate.ok) continue;
      checked += 1;

      for (const repair of repairLook(gate.look).repairs) {
        if (repair.property !== 'hues') continue;
        rotations += 1;
        if (peakChannel(String(repair.to)) === 255) clamped += 1;

        expect(
          luminanceOf(String(repair.to)),
          `${repair.path} ${String(repair.from)} -> ${String(repair.to)}: rotace jas zvedla`,
        ).toBeLessThanOrEqual(luminanceOf(String(repair.from)) + EIGHT_BIT_NOISE);
      }
    }

    expect(rotations, 'nic se neotočilo').toBeGreaterThan(0);
    expect(clamped, 'ani jedna rotace nedosáhla na oříznutí — sada tu větev míjí').toBeGreaterThan(
      0,
    );
  });

});
