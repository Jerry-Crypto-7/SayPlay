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
 * Hash se počítá nad obsahem normalizovaným na LF, stejně jako u `evals/frozen`.
 * Bez toho by týž soubor dal na Windows jiný hash než na Linuxu a zámek by
 * neznamenal nic ověřitelného.
 */
function normalisedSha256(absolutePath: string): string {
  const normalised = readFileSync(absolutePath).toString('utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(Buffer.from(normalised, 'utf8')).digest('hex');
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
}

interface BasePrompt {
  id: string;
  split: string;
}

interface PairSide {
  layout: unknown;
  modules: unknown;
  palette: unknown;
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
