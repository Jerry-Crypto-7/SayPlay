import { describe, expect, it } from 'vitest';

import { PALETTES, type PaletteName } from '@/kit';

import { IMAGE_PROPERTIES, IMAGE_THRESHOLDS, judgedHueBucket } from '../image-judge';
import { LOOK_BUDGETS, deriveLook, type LookDescriptor, type TerrainKind } from '../look';
import { PURPLE_BAND, acceptLook, hueOf, isPurple } from '../look-schema';
import {
  ALLOWED_HUE_BUCKETS,
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

  it('prstenec fialové koše vynechává, nezmenšuje se o ně jen počtem', () => {
    // Mutace, kterou tenhle test zabíjí: prstenec sestavený jako `slice(0, 9)`
    // má taky devět prvků a taky projde testem nad středy — ale vypustí koš 11
    // (345°, ta nejteplejší červeň) a jeden fialový si nechá.
    const purple = Array.from({ length: 360 / HUE_BUCKET_WIDTH }, (_unused, b) => b).filter((b) => {
      const centre = bucketCentre(b);
      return centre >= PURPLE_BAND.min && centre <= PURPLE_BAND.max;
    });
    expect(purple.length, 'fialové pásmo nepokrývá žádný koš, test nic neměří').toBeGreaterThan(0);
    expect([...ALLOWED_HUE_BUCKETS].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 360 / HUE_BUCKET_WIDTH }, (_unused, b) => b).filter(
        (b) => !purple.includes(b),
      ),
    );
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
