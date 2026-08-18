import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const gatesDir = join(repoRoot, 'evals', 'gates');
const lockPath = join(gatesDir, 'divergence.lock.json');
const manifestPath = join(gatesDir, 'MANIFEST.lock');
const frozenPromptsPath = join(repoRoot, 'evals', 'frozen', 'prompts.v1.jsonl');
const basePromptsPath = join(repoRoot, 'evals', 'prompts.jsonl');

/**
 * Jméno splitu, kterým je označená kalibrační sada. Zmrazený korpus používá
 * slovo `calibration`, základní `evals/prompts.jsonl` používá `dev` — jsou to
 * dvě jména téže věci a holdout prompt nesmí být ani v jedné.
 */
const CALIBRATION_SPLITS = new Set(['calibration', 'dev']);

/** §18 #8: „deset holdout promptů". Ne devět a ne jedenáct. */
const HOLDOUT_COUNT = 10;

/** §18 #8: „nejméně pět předem označených dvojic". */
const MIN_PAIRS = 5;

/** AC T703: „nejméně dvě, které mají skončit pod prahem" — jinak metrika nemá jak selhat. */
const MIN_BELOW_RECOLOR_PAIRS = 2;

/**
 * Nejmenší přípustný rozdíl palety u dvojice označené jako přebarvení.
 *
 * **Co drží:** dvojici označenou za přebarvení nejde srovnat na shodnou paletu.
 * Bez toho by u `P01` stačilo posunout odstín z 205 na 30,0001 — „liší se
 * paletou" by pořád platilo, obě aserce by zůstaly zelené a dvojice, která má
 * metriku shodit, by neměla co měřit. Čísla dvojic navíc leží mimo enumeraci
 * zámku (jsou v jiných souborech), takže je nehlídá ani ta.
 *
 * **Co NEdrží, a nikde se nesmí tvrdit opak (nález review 18. 8. 2026).** Práh
 * je slabý: naměřeno `P01` = 0,972 a `P02` = 0,550, takže `P01` jde seříznout
 * na necelou třetinu a nic nezčervená. Vyšší práh se odvodit dá — složka 3
 * (histogram) nese váhu 0,2 a práh přebarvení je 0,12, takže pod rozdílem 0,6
 * nemůže paleta složenou metriku k prahu přebarvení dotlačit ani teoreticky —
 * jenže **na 0,6 nedosáhne `P02` (0,550)**, a zvednout práh tak, aby data těsně
 * prošla, je dolaďování podle výsledku. Zůstává 0,25 a slabina je zapsaná;
 * zavře ji až dvojice s poctivě větší barevnou vzdáleností.
 *
 * Měří se největší rozdíl přes tři kanály, každý normalizovaný na svůj rozsah;
 * odstín se počítá po kruhu, aby 350 a 10 byly blízko, ne na opačných koncích.
 */
const MIN_PALETTE_DELTA = 0.25;

/**
 * Hash se počítá nad obsahem normalizovaným na LF, stejně jako u `evals/frozen`.
 * Bez toho by týž soubor dal na Windows jiný hash než na Linuxu a zámek by
 * neznamenal nic ověřitelného.
 */
function normalisedSha256(absolutePath: string): string {
  const normalised = readFileSync(absolutePath).toString('utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(Buffer.from(normalised, 'utf8')).digest('hex');
}

/**
 * Ukazatele, na kterých se páka schovala do jiného typu než `number`.
 *
 * Vytažené z aserce ven, aby se dalo doložit, že výjimka `/lockVersion` je
 * ukazatel a ne jméno klíče – nad samotným zámkem to doložit nejde, ten vnořený
 * `lockVersion` nemá.
 */
const TYPE_HIDING_EXEMPT = new Set(['/lockVersion']);

function typeHidingOffenders(root: unknown): string[] {
  const offenders: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (TYPE_HIDING_EXEMPT.has(path)) return;
    if (typeof value === 'boolean') offenders.push(`${path} (boolean)`);
    else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
      offenders.push(`${path} (řetězec „${value}" je číslo)`);
    else if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}/${i}`));
    else if (value !== null && typeof value === 'object')
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) walk(child, `${path}/${key}`);
  };
  walk(root, '');
  return offenders;
}

/** Viz `gold-frozen.test.ts` – `--no-replace-objects` patří na každé volání gitu. */
function git(...args: string[]): string {
  return execFileSync('git', ['--no-replace-objects', ...args], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

interface Palette {
  hueDeg: number;
  satPct: number;
  litPct: number;
}

/** Největší rozdíl přes kanály, normalizovaný; odstín po kruhu. */
function paletteDelta(a: Palette, b: Palette): number {
  const hue = Math.abs(a.hueDeg - b.hueDeg);
  return Math.max(
    Math.min(hue, 360 - hue) / 180,
    Math.abs(a.satPct - b.satPct) / 100,
    Math.abs(a.litPct - b.litPct) / 100,
  );
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...listFilesRecursive(abs));
    else out.push(abs);
  }
  return out;
}

function readJsonl<T>(absolutePath: string): T[] {
  return readFileSync(absolutePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as T);
}

interface Lock {
  lockVersion: unknown;
  status: string;
  weights: { topology: number; parameters: number; histogram: number };
  seed: number;
  thresholds: { divergence: number; recolor: number };
  histogram: { binCount: number; binEdges: number[]; subsampleFactor: number };
  camera: { angles: { azimuthDeg: number; elevationDeg: number }[] };
  normalization: Record<string, Record<string, { min: number; max: number }>>;
  holdoutPrompts: string[];
  pairs: string[];
}

interface Manifest {
  algorithm: string;
  scope: string;
  files: Record<string, string>;
}

interface FrozenPrompt {
  id: string;
  split: string;
  source?: string;
  baseWorld?: string;
}

interface BasePrompt {
  id: string;
  split: string;
}

interface PairSide {
  layout: unknown;
  modules: unknown;
  palette: Palette;
}

interface Pair {
  id: string;
  label: string;
  expect: 'below_recolor' | 'above_divergence';
  rationale: string;
  a: PairSide;
  b: PairSide;
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Lock;
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

// ---------------------------------------------------------------------------
// Výčet povolených ukazatelů. Tohle je jádro AC: „soubor s definicí nesmí
// obsahovat číselnou hodnotu mimo tenhle výčet a test to enumerací ověří."
//
// Výčet se staví ZDE, z konstant v testu — nikdy ne z obsahu zámku. Kdyby se
// stavěl ze zámku, přidaná rodina, přidaný parametr nebo změněný počet binů by
// si povolení k sobě přinesly samy a kontrola by neověřovala nic.
// ---------------------------------------------------------------------------

const LOCKED_FAMILIES = ['mass', 'panel', 'tower', 'organic'] as const;

const LOCKED_FAMILY_PARAMS: Record<(typeof LOCKED_FAMILIES)[number], readonly string[]> = {
  mass: ['footprintM', 'heightM', 'taper', 'bevelM', 'floors', 'corniceM'],
  panel: ['openingPitchM', 'openingRadiusM', 'thicknessM', 'frameM', 'breachRatio', 'openingRows'],
  tower: ['floors', 'taperPerFloor', 'galleryRadiusM', 'crownHeightM', 'crownEmissive', 'shaftRadiusM'],
  organic: ['sweepCurvature', 'segments', 'taper', 'twistTurns', 'waviness', 'branchDepth'],
};

const LOCKED_BIN_COUNT = 16;
const LOCKED_CAMERA_ANGLE_COUNT = 2;

function allowedNumericPointers(): string[] {
  const pointers = [
    '/weights/topology',
    '/weights/parameters',
    '/weights/histogram',
    '/seed',
    '/thresholds/divergence',
    '/thresholds/recolor',
    '/histogram/binCount',
    '/histogram/subsampleFactor',
  ];
  // Hranic je přesně o jednu víc než binů, a počet binů je konstanta testu, ne zámku.
  for (let i = 0; i <= LOCKED_BIN_COUNT; i += 1) pointers.push(`/histogram/binEdges/${i}`);
  for (let i = 0; i < LOCKED_CAMERA_ANGLE_COUNT; i += 1) {
    pointers.push(`/camera/angles/${i}/azimuthDeg`, `/camera/angles/${i}/elevationDeg`);
  }
  for (const family of LOCKED_FAMILIES) {
    for (const param of LOCKED_FAMILY_PARAMS[family]) {
      pointers.push(`/normalization/${family}/${param}/min`, `/normalization/${family}/${param}/max`);
    }
  }
  return pointers.sort();
}

/** Ukazatele na KAŽDOU číselnou hodnotu kdekoli ve stromu, včetně prvků polí. */
function numericPointers(value: unknown, prefix = ''): string[] {
  if (typeof value === 'number') return [prefix];
  if (Array.isArray(value)) return value.flatMap((item, i) => numericPointers(item, `${prefix}/${i}`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      numericPointers(child, `${prefix}/${key}`),
    );
  }
  return [];
}

describe('evals/gates — zámek metriky divergence je hashem v manifestu', () => {
  it('používá sha256', () => {
    expect(manifest.algorithm).toBe('sha256');
  });

  it('každý soubor v manifestu existuje a jeho hash sedí', () => {
    for (const [rel, expected] of Object.entries(manifest.files)) {
      const abs = join(gatesDir, rel);
      expect(existsSync(abs), `chybí zamčený soubor ${rel}`).toBe(true);
      expect(normalisedSha256(abs), `hash nesedí u ${rel}`).toBe(expected);
    }
  });

  // Bez téhle kontroly by šlo do zámku nepozorovaně PŘIDAT dvojici: hash
  // existujících souborů by dál seděl a manifest by o nové mlčel. Rozšíření je
  // vždycky levnější než přepis, takže je to ta cesta, kterou by někdo šel.
  it('manifest kryje definici i každou dvojici na disku', () => {
    const onDisk = listFilesRecursive(gatesDir)
      .map((abs) => relative(gatesDir, abs).split(sep).join(posix.sep))
      .filter((rel) => rel === 'divergence.lock.json' || rel.startsWith('divergence-pairs/'))
      .sort();
    expect(onDisk).toEqual(Object.keys(manifest.files).sort());
  });
});

describe('evals/gates — v definici není číselná páka mimo výčet', () => {
  const found = numericPointers(lock).sort();
  const allowed = allowedNumericPointers();

  it('každé číslo v souboru leží na enumerovaném ukazateli', () => {
    const extra = found.filter((pointer) => !allowed.includes(pointer));
    expect(extra, `číselná páka mimo výčet: ${extra.join(', ')}`).toEqual([]);
  });

  it('žádný enumerovaný ukazatel v souboru nechybí', () => {
    const missing = allowed.filter((pointer) => !found.includes(pointer));
    expect(missing, `enumerovaná páka chybí v zámku: ${missing.join(', ')}`).toEqual([]);
  });

  // `lockVersion` je záměrně řetězec. Kdyby bylo číslo, muselo by být ve výčtu —
  // a výčet by pak nesl položku, která páka není. Tím se rozvolní přesně ta
  // hranice, kvůli které se zamyká celý soubor a ne jen seznam pák.
  it('metadata nejsou čísla', () => {
    expect(typeof lock.lockVersion).toBe('string');
  });

  /**
   * **Enumerace vidí jen `typeof === 'number'`, takže páka schovaná do jiného
   * typu jí projde pod rukama.** `"minSampleCount": "512"` je číslo pro každého,
   * kdo ho čte, a řetězec pro `numericPointers`; `"histogramEnabled": false`
   * je vypínač celé třetí složky. Zámek si přitom sám předepisuje, že všechno
   * mimo výčet je řetězec — čímž je řetězcová páka k nerozeznání od prózy.
   * Zavírá se to shora: booleany se nesmějí vyskytnout vůbec a řetězec se nesmí
   * dát přečíst jako číslo.
   *
   * Jediná výjimka je `/lockVersion`. Zámek si sám předepisuje, že je řetězec
   * (`numericEnumerationRule`), a aserce o blok výš to vynucuje — číslo by tam
   * muselo do výčtu a výčet by pak nesl položku, která páka není. Výjimka je
   * proto celý ukazatel, ne jméno klíče: `/nested/lockVersion` jde dál červeně,
   * což hlídá sonda hned za touhle asercí.
   */
  it('žádná páka se neschovala do jiného typu', () => {
    expect(typeHidingOffenders(lock)).toEqual([]);
    // Výjimka, která nic nekryje, je mrtvá výjimka – a mrtvá výjimka se časem
    // rozšíří na něco živého, protože ji nikdo neuvidí padnout. Existence klíče
    // na to nestačí: kdyby v něm bylo `"v1"`, `Number()` dá NaN, výjimka by
    // nekryla nic a aserce by přesto zůstala zelená. Doloží se to sondou nad
    // TOUŽE hodnotou o úroveň níž – tam výjimka neplatí, takže musí být nález.
    expect(Object.keys(lock), 'výjimka /lockVersion nemá co krýt').toContain('lockVersion');
    expect(
      typeHidingOffenders({ nested: { lockVersion: lock.lockVersion } }),
      'hodnota /lockVersion se nedá přečíst jako číslo – výjimka nic nekryje a je mrtvá',
    ).toHaveLength(1);
  });

  /**
   * **Výjimka výš je ukazatel, ne jméno klíče – a dokud to nic nezkusí, je to
   * jen tvrzení v komentáři.** Napsat `path.endsWith('/lockVersion')` projde
   * dnes zeleně, protože zámek žádný vnořený `lockVersion` nemá; teprve tahle
   * sonda ten rozdíl uvidí. Zkouší se na vyrobených objektech, ne na zámku,
   * aby aserce nezávisela na tom, co v zámku zrovna je.
   */
  it('výjimka platí na kořeni a nikde jinde', () => {
    expect(typeHidingOffenders({ lockVersion: '1' })).toEqual([]);
    expect(typeHidingOffenders({ nested: { lockVersion: '7' } })).toHaveLength(1);
    expect(typeHidingOffenders({ minSampleCount: '512' })).toHaveLength(1);
    expect(typeHidingOffenders({ histogramEnabled: false })).toHaveLength(1);
    expect(typeHidingOffenders({ pairsRule: 'šest dvojic' })).toEqual([]);
  });
});

/**
 * **Most mezi bajty a historií.** Hash lock výš čte zámek z disku a manifest taky
 * z disku, takže „přepiš zámek a přepočítej manifest" projde zeleně bez jediného
 * git příkazu. `evals/frozen` má na tohle vlastní blok od commitu `1e81dac`;
 * bez něj by tady zůstala tatáž díra o dva adresáře vedle.
 *
 * **Co to NEdokazuje, a nikde se nesmí tvrdit opak:** commit, který zámek i
 * manifest změní najednou, je pořád zelený. Vynutitelnost zmrazení je otevřená
 * věc (`CLAUDE.md`, rozpor 5) a tenhle blok ji nezavírá — zavírá jen tichý
 * přepis pracovního stromu.
 */
describe('evals/gates — disk se rovná commitnutému stromu', () => {
  const headFiles = (() => {
    try {
      return git('ls-tree', '-r', '--name-only', 'HEAD', '--', 'evals/gates')
        .split('\n')
        .filter(Boolean)
        .map((path) => path.replace(/^evals\/gates\//, ''))
        .filter((rel) => rel === 'divergence.lock.json' || rel.startsWith('divergence-pairs/'))
        .sort();
    } catch {
      return [];
    }
  })();

  const headSha = (repoRelative: string): string => {
    const raw = execFileSync('git', ['--no-replace-objects', 'show', `HEAD:${repoRelative}`], {
      cwd: repoRoot,
      maxBuffer: 1 << 28,
    });
    return createHash('sha256').update(Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')).digest('hex');
  };

  // **Prázdný `headFiles` nesmí projít.** `git ls-tree` nad neexistující cestou
  // skončí nulou a nevypíše nic, takže překlep v cestě o pár řádků výš by obě
  // aserce nechal vrátit se naprázdno nad libovolně přepsaným zámkem. Množina
  // se proto porovnává s manifestem — druhým, nezávislým seznamem těch souborů.
  const manifestFiles = Object.keys(manifest.files).sort();

  it('HEAD skutečně nese zamčené soubory', () => {
    expect(headFiles, 'git nevrátil pod evals/gates nic — cesta je špatně nebo git chybí').toEqual(manifestFiles);
  });

  it('množina zamčených souborů na disku se rovná té v HEADu', () => {
    expect(headFiles).toEqual(manifestFiles);
    const onDisk = listFilesRecursive(gatesDir)
      .map((abs) => relative(gatesDir, abs).split(sep).join(posix.sep))
      .filter((rel) => rel === 'divergence.lock.json' || rel.startsWith('divergence-pairs/'))
      .sort();
    expect(onDisk).toEqual(headFiles);
  });

  it('každý zamčený soubor má na disku bajty svého commitnutého protějšku', () => {
    expect(headFiles).toEqual(manifestFiles);
    for (const rel of headFiles) {
      expect(
        normalisedSha256(join(gatesDir, rel)),
        `${rel}: bajty na disku se liší od commitnutých — zámek je přepsaný v pracovním stromu`,
      ).toBe(headSha(`evals/gates/${rel}`));
    }
  });
});

describe('evals/gates — zamčené páky drží vztahy, na kterých stojí verdikt', () => {
  it('váhy tří složek dávají přesně jedna', () => {
    const sum = lock.weights.topology + lock.weights.parameters + lock.weights.histogram;
    expect(sum).toBeCloseTo(1, 12);
  });

  it('práh přebarvení je ostře pod prahem divergence', () => {
    expect(lock.thresholds.recolor).toBeLessThan(lock.thresholds.divergence);
  });

  it('hranic binů je přesně o jednu víc než binů a rostou', () => {
    expect(lock.histogram.binCount).toBe(LOCKED_BIN_COUNT);
    expect(lock.histogram.binEdges).toHaveLength(lock.histogram.binCount + 1);
    for (let i = 1; i < lock.histogram.binEdges.length; i += 1) {
      expect(lock.histogram.binEdges[i]).toBeGreaterThan(lock.histogram.binEdges[i - 1]);
    }
  });

  it('kamera má přesně dva pevné úhly a nejsou to tytéž dva', () => {
    expect(lock.camera.angles).toHaveLength(LOCKED_CAMERA_ANGLE_COUNT);
    const [first, second] = lock.camera.angles;
    expect(`${first.azimuthDeg}/${first.elevationDeg}`).not.toBe(`${second.azimuthDeg}/${second.elevationDeg}`);
  });

  it('každý normalizační rozsah je neprázdný', () => {
    for (const family of LOCKED_FAMILIES) {
      for (const param of LOCKED_FAMILY_PARAMS[family]) {
        const range = lock.normalization[family][param];
        expect(range.max, `${family}.${param}: prázdný rozsah dělí nulou`).toBeGreaterThan(range.min);
      }
    }
  });
});

describe('evals/gates — holdout prompty jsou odvozené, ne vybrané', () => {
  const frozen = readJsonl<FrozenPrompt>(frozenPromptsPath);
  const base = new Map(readJsonl<BasePrompt>(basePromptsPath).map((prompt) => [prompt.id, prompt]));

  // Tenhle výpočet je celá obrana proti nálezu review B („ponechává autorovi
  // volnost ve volbě dvojice, vah i promptů"). Autor nevybírá deset id; pořadí
  // je vybírá za něj a test ten výpočet opakuje.
  const derived = frozen
    .filter((prompt) => prompt.split === 'holdout')
    .map((prompt) => prompt.id)
    .sort()
    .slice(0, HOLDOUT_COUNT);

  it('zámek nese přesně deset holdout promptů', () => {
    expect(lock.holdoutPrompts).toHaveLength(HOLDOUT_COUNT);
  });

  it('deset v zámku se rovná deseti odvozeným ze zmrazeného korpusu', () => {
    expect(lock.holdoutPrompts).toEqual(derived);
  });

  it('každý z nich je ve zmrazeném korpusu označený jako holdout', () => {
    for (const id of lock.holdoutPrompts) {
      const record = frozen.find((prompt) => prompt.id === id);
      expect(record, `${id} není ve zmrazeném korpusu`).toBeDefined();
      expect(record!.split, `${id} má ve zmrazeném korpusu split ${record!.split}`).toBe('holdout');
    }
  });

  // Zmrazený záznam smí deklarovat původ v základním korpusu. Kdyby ten zdrojový
  // řádek byl kalibrační, prosákla by kalibrace do holdoutu jednu úroveň pod
  // kontrolou výš — a přesně takhle se holdout nepozorovaně ztrácí.
  it('žádný z nich nepochází z kalibrační sady základního korpusu', () => {
    for (const id of lock.holdoutPrompts) {
      const record = frozen.find((prompt) => prompt.id === id)!;
      if (!record.source) continue;
      const sourceId = record.source.split('#')[1];
      const sourceRecord = base.get(sourceId);
      expect(sourceRecord, `${id} odkazuje na neexistující ${record.source}`).toBeDefined();
      expect(
        CALIBRATION_SPLITS.has(sourceRecord!.split),
        `${id} pochází z ${sourceId}, který je v kalibrační sadě (${sourceRecord!.split})`,
      ).toBe(false);
    }
  });

  /**
   * **Kontrola výš přeskočí každý záznam bez `source`, a to je šest z deseti.**
   * Editační prompty žádný `source` nenesou — jejich vazba na korpus jde přes
   * `baseWorld`, tedy přes svět, nad kterým se úprava provádí. Kdyby ten svět
   * byl kalibrační, prosákne kalibrace do holdoutu cestou, na kterou se první
   * kontrola vůbec nedívá, a strukturálně ji nemá jak vidět.
   *
   * Naměřeno 18. 8. 2026: šest editačních holdoutů (`E01`, `E08`, `E10`, `E14`,
   * `E19`, `E22`) staví na `C02` a `C09`, obojí `holdout`. Aserce tedy dnes
   * nezakazuje nic, co v korpusu je — zavírá cestu, ne existující vadu.
   */
  it('ani základní svět editačního holdoutu není kalibrační', () => {
    const checked: string[] = [];
    for (const id of lock.holdoutPrompts) {
      const record = frozen.find((prompt) => prompt.id === id)!;
      if (!record.baseWorld) continue;
      const baseRecord = frozen.find((prompt) => prompt.id === record.baseWorld);
      expect(baseRecord, `${id} staví na neexistujícím světě ${record.baseWorld}`).toBeDefined();
      expect(
        CALIBRATION_SPLITS.has(baseRecord!.split),
        `${id} staví na ${record.baseWorld}, který je v kalibrační sadě (${baseRecord!.split})`,
      ).toBe(false);
      // **Split základního světa je jen půlka.** Kontrola o blok výš existuje
      // právě proto, že `split: 'holdout'` může sedět nad `source` mířícím do
      // kalibrační sady základního korpusu; u základního světa platí totéž
      // a bez tohohle by ta cesta zůstala otevřená o jednu úroveň hlouběji.
      if (baseRecord!.source) {
        const baseSourceId = baseRecord!.source!.split('#')[1];
        const baseSourceRecord = base.get(baseSourceId);
        expect(baseSourceRecord, `${record.baseWorld} odkazuje na neexistující ${baseRecord!.source}`).toBeDefined();
        expect(
          CALIBRATION_SPLITS.has(baseSourceRecord!.split),
          `${id} staví na ${record.baseWorld}, který pochází z kalibračního ${baseSourceId}`,
        ).toBe(false);
      }
      checked.push(id);
    }
    // Bez tohohle by aserce mlčky prošla naprázdno, kdyby `baseWorld` z korpusu zmizel.
    expect(checked.length, 'žádný z deseti nedeklaruje baseWorld — kontrola by běžela naprázdno').toBeGreaterThan(0);
  });
});

describe('evals/gates — označené dvojice mají jak selhat', () => {
  const pairs = lock.pairs.map((rel) => JSON.parse(readFileSync(join(gatesDir, rel), 'utf8')) as Pair);

  it('dvojic je nejméně pět', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(MIN_PAIRS);
  });

  it('nejméně dvě mají skončit pod prahem přebarvení', () => {
    const below = pairs.filter((pair) => pair.expect === 'below_recolor');
    expect(below.length, 'bez dvojice, která má spadnout, metrika nemá jak selhat').toBeGreaterThanOrEqual(
      MIN_BELOW_RECOLOR_PAIRS,
    );
  });

  it('nejméně jedna má skončit nad prahem divergence', () => {
    expect(pairs.filter((pair) => pair.expect === 'above_divergence').length).toBeGreaterThanOrEqual(1);
  });

  it('každá dvojice nese id, očekávání a odůvodnění, a obě strany', () => {
    for (const pair of pairs) {
      expect(['below_recolor', 'above_divergence'], `${pair.id}: neznámé očekávání`).toContain(pair.expect);
      expect(pair.rationale.length, `${pair.id}: bez odůvodnění je dvojice autorova volba`).toBeGreaterThan(0);
      expect(pair.a, `${pair.id}: chybí strana a`).toBeDefined();
      expect(pair.b, `${pair.id}: chybí strana b`).toBeDefined();
    }
  });

  it('id dvojic jsou jedinečná', () => {
    expect(new Set(pairs.map((pair) => pair.id)).size).toBe(pairs.length);
  });

  // Přebarvení znamená TÝŽ svět v jiné barvě. Dvojice označená `below_recolor`,
  // která se liší i geometrií, projde jakoukoli metrikou a neprokáže nic.
  it('dvojice označená jako přebarvení se liší výhradně paletou', () => {
    const world = (side: PairSide) => JSON.stringify({ layout: side.layout, modules: side.modules });
    for (const pair of pairs.filter((candidate) => candidate.expect === 'below_recolor')) {
      expect(world(pair.a), `${pair.id}: „přebarvení", které mění i svět`).toBe(world(pair.b));
      expect(JSON.stringify(pair.a.palette), `${pair.id}: „přebarvení" beze změny palety`).not.toBe(
        JSON.stringify(pair.b.palette),
      );
    }
  });

  // „Liší se paletou" bez dolní meze je splnitelné rozdílem, který nikdo nezměří.
  // Viz MIN_PALETTE_DELTA — tohle je jediná aserce, která drží negativní kontrolu
  // při životě, a zámek ji vlastní enumerací pokrýt nemůže (dvojice jsou jinde).
  it('přebarvení je znatelné, ne kosmetické', () => {
    for (const pair of pairs.filter((candidate) => candidate.expect === 'below_recolor')) {
      const delta = paletteDelta(pair.a.palette, pair.b.palette);
      expect(delta, `${pair.id}: rozdíl palety ${delta.toFixed(3)} je pod ${MIN_PALETTE_DELTA}`).toBeGreaterThanOrEqual(
        MIN_PALETTE_DELTA,
      );
    }
  });
});

describe('evals/gates — zámek je zamčený a nepoužitý, a říká to nahlas', () => {
  it('zámek se sám prohlašuje za nepoužitý', () => {
    expect(lock.status).toBe('unused');
  });

  // Odběratel (P5 T504) byl zrušen. Až zámek odběratele dostane, tahle aserce
  // zčervená — a to je celý smysl: zpráva brány tvrdí, že zámek nikdo nečte,
  // a to tvrzení nesmí zestárnout tiše.
  it('žádný kód v src/ zámek nečte', () => {
    const consumers = listFilesRecursive(join(repoRoot, 'src')).filter((abs) =>
      readFileSync(abs, 'utf8').includes('divergence.lock'),
    );
    expect(
      consumers.map((abs) => relative(repoRoot, abs)),
      'zámek dostal odběratele — zpráva brány (P7b T704) tvrdí opak a musí se přepsat',
    ).toEqual([]);
  });
});

/**
 * **`git replace` obchází celý aparát historie, a jediná obrana je vlajka na
 * KAŽDÉM volání.** Dvě náhrady blobů (`refs/replace/*`, defaultně zapnuté)
 * nechají OID, tree hashe i tagy bitově shodné, zatímco `git show HEAD:<cesta>`
 * vrátí podvržené bajty; reprodukováno nad celou sadou (`CLAUDE.md`, rozpor 5).
 * Volání bez `--no-replace-objects` je proto díra bez ohledu na to, co čte.
 *
 * Hlídá se to nad `evals/`, protože tam leží testy, které z historie odvozují
 * zmrazení. Naměřeno 18. 8. 2026: pět volání gitu ve třech souborech, všech pět
 * vlajku má — tahle aserce tedy dnes nezakazuje nic, co v repu je. Zavírá cestu
 * pro to šesté, které někdo napíše zítra.
 */
describe('evals — každé volání gitu obchází refs/replace', () => {
  it('žádné volání gitu pod evals/ nechybí --no-replace-objects', () => {
    const calls = listFilesRecursive(join(repoRoot, 'evals'))
      .filter((f) => f.endsWith('.ts'))
      .flatMap((abs) => {
        const source = readFileSync(abs, 'utf8');
        return [...source.matchAll(/execFileSync\('git',\s*\[([^\]]*)\]/g)].map((m) => ({
          where: relative(repoRoot, abs),
          args: m[1],
        }));
      });
    // Bez tohohle by aserce prošla naprázdno, kdyby se volání přesunula jinam.
    expect(calls.length, 'pod evals/ není jediné volání gitu — kontrola běží naprázdno').toBeGreaterThan(0);
    expect(
      calls.filter((c) => !c.args.includes('--no-replace-objects')).map((c) => c.where),
      'volání gitu bez vlajky',
    ).toEqual([]);
  });
});
