/**
 * Sady prostředí arkády (P26 T11): `theme` → nebe, mlha, světlo, zem a
 * rekvizity na okrajích trati. Pravidlo P26 – co AI napíše, musí být vidět:
 * dřív měla každá arkádová hra totéž modré nebe a zelenou trávu, ať věta
 * zněla „na Marsu“, nebo „pod vodou“.
 *
 * Výběr: model píše `theme.look` (výčet ve schématu odpovědi), návrh ze slov
 * a starší spec bez něj jdou přes klíčová slova v `setting` a `mood`
 * (`lookFor`). `null` = věta místo nejmenuje nebo ho sady neznají – pak
 * výchozí louka, a sada věrnosti prostředí nepočítá jako přečtené.
 *
 * Jediný runtime import je tabulka rekvizit prostředí (P45H) – skripty ho
 * holým Nodem načtou přes `scripts/ts-paths.mjs`, který JSON doplní atribut.
 * Nic fialového: odstíny 250–320° tu nejsou.
 */

import settingKits from './setting-kits.json';

/** Počasí a denní doba nad sadou (P29D): živá změna je píše do logu, sdílená verze do `theme`. */
export const WEATHERS = ['clear', 'rain', 'snow', 'fog'] as const;
export type Weather = (typeof WEATHERS)[number];
export const TIMES_OF_DAY = ['day', 'dusk', 'night'] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

export function timeOfDayFor(setting: string): TimeOfDay | null {
  if (/\b(?:at night|nighttime|night-time|midnight)\b/i.test(setting) || /^night$/i.test(setting.trim())) return 'night';
  if (/\b(?:dusk|sunset|evening)\b/i.test(setting)) return 'dusk';
  return null;
}

export const LOOK_IDS = [
  'meadow',
  'city',
  'mall',
  'supermarket',
  'living_room',
  'factory',
  'forest',
  'jungle',
  'desert',
  'beach',
  'ocean',
  'underwater',
  'snow',
  'volcano',
  'cave',
  'space',
  'castle',
  'graveyard',
] as const;
export type LookId = (typeof LOOK_IDS)[number];

export const PROP_KINDS = [
  'tree',
  'pine',
  'palm',
  'cactus',
  'rock',
  'building',
  'lamp',
  'shelf',
  'crate',
  'sofa',
  'chimney',
  'tower',
  'grave',
  'coral',
  'seaweed',
  'crystal',
  'iceblock',
  'buoy',
  'volcano',
] as const;
export type PropKind = (typeof PROP_KINDS)[number];

/**
 * Kulisy z katalogu (P28D T6) a jejich výška v metrech. Primitivy výš
 * hodnotitel nepozná („sparse gray blocks“ = město, 1/24 prostředí), model
 * taxíku nebo regálu ano. Jen modely s málo sítěmi; vícedílné se při
 * načtení slijí po materiálech (`look/load.ts`).
 */
export const SCENERY_MODELS = {
  'townhouse': 7,
  'cc0-car-taxi': 1.6,
  'cc0-fire-hydrant': 1,
  'cc0-bench': 1,
  'cc0-bush': 1.3,
  'cc0-flower': 0.9,
  'cc0-cabinet-shelves': 2.4,
  'shopping-cart': 1.2,
  'cc0-can-fridge': 2.3,
  'potted-plant': 1.8,
  'cc0-couch': 1.1,
  'cc0-armchair': 1.2,
  'cc0-lamp-standing': 2.2,
  'steam-machine': 3.5,
  'cc0-barrel-stack': 2,
  'cc0-pallet': 0.5,
  'cc0-tree-pine': 5,
  'cc0-stump': 0.8,
  'cc0-log-stack': 1.2,
  'cc0-palm-tree': 5.5,
  'cc0-bamboo': 4.5,
  'cc0-bush-berries': 1.4,
  'cc0-cactus-flowers': 3,
  'cc0-boat-row': 1.2,
  'cc0-clownfish': 1,
  'cc0-tang': 1,
  'penguin': 1.3,
  'cc0-sled': 0.8,
  'cc0-torch-lit': 2.2,
  'cc0-rock-moss': 1.4,
  'cc0-asteroid': 2.5,
  'rocket': 6,
  'stone-wall': 2.8,
  'cc0-barrel': 1.3,
  'cc0-pumpkin': 0.9,
  'cc0-skull-candle': 1,
  // Vlastní modely z gen3d (dávky 26.–28. 9.), jedna síť na model.
  'gen3d-windmill': 7,
  'gen3d-sunflower': 1.6,
  'gen3d-street-mailbox': 1.3,
  'gen3d-traffic-light': 3.5,
  'gen3d-bus-stop': 2.6,
  'gen3d-fountain': 2,
  'gen3d-vending-machine': 2,
  'gen3d-fruit-stand': 1.4,
  'gen3d-cash-register': 1.2,
  'gen3d-bookshelf': 2,
  'gen3d-television': 1.2,
  'gen3d-crane': 7,
  'gen3d-container': 2.6,
  'gen3d-treehouse': 6,
  'gen3d-large-boulder': 1.5,
  'gen3d-ruin': 2.5,
  'gen3d-termite-hill': 2,
  'gen3d-camel': 2.2,
  'gen3d-sandcastle': 0.8,
  'gen3d-surfboard': 2,
  'gen3d-lighthouse': 8,
  'gen3d-sailboat': 4,
  'gen3d-jellyfish': 1,
  'gen3d-seahorse': 0.8,
  'gen3d-octopus': 1.2,
  'gen3d-ice-igloo': 2.2,
  'gen3d-snowman-with-hat': 1.7,
  'gen3d-iceberg': 3,
  'gen3d-volcano': 8,
  'gen3d-crystal-cluster': 1.2,
  'gen3d-mine-cart': 1.2,
  'gen3d-moon-lander': 3,
  'gen3d-satellite-radar-dish': 3,
  'gen3d-space-colony-dome': 4,
  'gen3d-drawbridge': 4,
  'gen3d-stone-water-well': 1.8,
  'gen3d-gravestone': 1.3,
} as const satisfies Readonly<Record<string, number>>;
/** Rekvizita prostředí z `setting-kits.json` (P45H): model gen3d, který žádná sada nenese. */
export type KitModel = `gen3d-${string}`;
export type SceneryModel = keyof typeof SCENERY_MODELS | KitModel;
export type SceneryKind = PropKind | SceneryModel;

/**
 * Prostředí z věty → rekvizity (P45H T2, `scripts/p45h/build-setting-kits.mjs`):
 * jen modely povýšené do katalogu, s výškou kulisy v metrech.
 */
const SETTING_KITS = settingKits.kits.map((kit) => ({ pattern: new RegExp(kit.pattern), props: kit.props.map((prop) => prop.id as KitModel) }));
const KIT_HEIGHTS: ReadonlyMap<string, number> = new Map(settingKits.kits.flatMap((kit) => kit.props.map((prop) => [prop.id, prop.height] as const)));

export const isSceneryModel = (kind: SceneryKind): kind is SceneryModel => Object.hasOwn(SCENERY_MODELS, kind) || KIT_HEIGHTS.has(kind);

/** Výška modelu kulisy při měřítku 1 (m): sady ze `SCENERY_MODELS`, rekvizity prostředí z tabulky. */
export const modelHeight = (id: SceneryModel): number => (Object.hasOwn(SCENERY_MODELS, id) ? SCENERY_MODELS[id as keyof typeof SCENERY_MODELS] : KIT_HEIGHTS.get(id)!);

/** Povrch ostrůvků a podlahy arény (P32A T9): tráva, sníh a led, písek, dlažba, holá skála. */
export const COVERS = ['grass', 'snow', 'sand', 'paving', 'rock'] as const;
export type Cover = (typeof COVERS)[number];

/**
 * Povrch cesty závodu a běžce (P46G T2): pás, jeho okraj a značení jdou po jedné
 * křivce (`look/road-strip.ts`). Asfalt má přerušovanou středovou čáru, prkna spáry.
 */
export interface Surface {
  readonly color: string;
  /** Okrajová čára asfaltu, jinde tmavší lem pásu. */
  readonly edge: string;
  readonly marks?: { readonly kind: 'dashes' | 'seams'; readonly color: string };
}

export const SURFACES = {
  asphalt: { color: '#5a5f66', edge: '#e8e6df', marks: { kind: 'dashes', color: '#e8e6df' } },
  dirt: { color: '#94754f', edge: '#75593b' },
  sand: { color: '#dcc193', edge: '#c3a476' },
  snow: { color: '#e6edf4', edge: '#bccbd9' },
  planks: { color: '#a07a4e', edge: '#6e5034', marks: { kind: 'seams', color: '#6e5034' } },
  paving: { color: '#a29d93', edge: '#7d786f' },
} as const satisfies Record<string, Surface>;
export type SurfaceKind = keyof typeof SURFACES;

/** Druh vegetace (P46G T4): model katalogu a jeho výška (m) při velikosti 1. Opakované id = častější druh. */
export interface PlantSpecies {
  readonly id: string;
  readonly height: number;
}

/**
 * Vegetace sady ve třech vrstvách (P46G T4, `look/vegetation-places.ts`): u cesty
 * drobnosti (keře, tráva, kameny, pařezy), uprostřed shluky stromů, v dálce
 * souvislá linie. Vrstva bez druhů se nekreslí.
 */
export interface Flora {
  readonly near: readonly PlantSpecies[];
  readonly mid: readonly PlantSpecies[];
  readonly far: readonly PlantSpecies[];
  /** Barva listí: nahradí šedou, kterou mají listí, mech a kaktusy modelů katalogu z jeho palety. */
  readonly leaf: string;
  /** Násobek hustoty lesa. */
  readonly density: number;
  /** Podzim („autumn“, „fall“): listí oranžové a jehličí zůstane oranžové. Píše jen `sceneLook`. */
  readonly autumn?: boolean;
}

/*
 * Druhy z gen3d (P46G T8) mají barvy ve vrcholech a výšku 1 v katalogu: výška tady je
 * jejich skutečná velikost. Drobnost u cesty je nižší než 1,4 m (× velikost 1,4 < 2 m,
 * přes ni kamera arény vidí na paty hrdiny). Sada nese nejvýš `FLORA_SPECIES` druhů –
 * každý druh je jedno kreslicí volání navíc. Do vegetace nejdou modely v květináči
 * (monstera, agáve, aloe), fialové (levandule, bodlák), podzimní javor ani hrubé sítě.
 */
const FOREST_FLORA: Flora = {
  near: [
    { id: 'cc0-bush', height: 1.1 },
    { id: 'cc0-bush-berries', height: 1 },
    { id: 'cc0-grass', height: 0.7 },
    { id: 'cc0-grass', height: 0.7 },
    { id: 'cc0-stump', height: 0.5 },
    { id: 'gen3d-mossy-stump', height: 0.6 },
    { id: 'cc0-rock-moss', height: 0.9 },
    { id: 'gen3d-mossy-boulder', height: 0.9 },
    { id: 'gen3d-mossy-fallen-log', height: 0.55 },
  ],
  mid: [
    { id: 'cc0-tree-pine', height: 7 },
    { id: 'gen3d-fir-tree', height: 7 },
    { id: 'gen3d-fir-tree', height: 7 },
    { id: 'cc0-pine-tree', height: 7.5 },
    { id: 'gen3d-larch-tree', height: 7.5 },
    { id: 'cc0-birch-tree', height: 6.5 },
    { id: 'oak-tree', height: 6 },
  ],
  far: [
    { id: 'cc0-tree-pine', height: 9 },
    { id: 'gen3d-fir-tree', height: 9 },
    { id: 'gen3d-larch-tree', height: 9.5 },
    { id: 'oak-tree', height: 7.5 },
  ],
  leaf: '#3b7a3a',
  density: 1,
};

const JUNGLE_FLORA: Flora = {
  near: [
    { id: 'cc0-bush-berries', height: 1.2 },
    { id: 'cc0-bush', height: 1.3 },
    { id: 'cc0-grass', height: 0.9 },
    { id: 'cc0-grass', height: 0.9 },
    { id: 'cc0-rock-moss', height: 1 },
    { id: 'gen3d-mossy-rock-cluster', height: 0.9 },
    { id: 'cc0-tree-stump', height: 0.6 },
  ],
  mid: [
    { id: 'cc0-palm-tree', height: 6 },
    { id: 'gen3d-banana-plant', height: 4 },
    { id: 'gen3d-banana-plant', height: 4 },
    { id: 'gen3d-kapok-tree', height: 8 },
    { id: 'gen3d-mangrove-tree', height: 5 },
    { id: 'gen3d-bamboo-cluster', height: 5 },
    { id: 'gen3d-rubber-tree', height: 5.5 },
    { id: 'gen3d-strangler-fig-tree', height: 7 },
    { id: 'gen3d-cycad-palm', height: 3.5 },
  ],
  far: [
    { id: 'gen3d-kapok-tree', height: 9 },
    { id: 'gen3d-strangler-fig-tree', height: 8 },
    { id: 'cc0-palm-tree', height: 7 },
    { id: 'gen3d-mangrove-tree', height: 6 },
  ],
  leaf: '#2f8a3c',
  density: 1.1,
};

const MEADOW_FLORA: Flora = {
  near: [
    { id: 'cc0-grass', height: 0.7 },
    { id: 'cc0-grass', height: 0.7 },
    { id: 'gen3d-tall-grass-tuft', height: 0.9 },
    { id: 'gen3d-wildflower-patch', height: 0.45 },
    { id: 'cc0-bush', height: 1.1 },
    { id: 'cc0-rock-moss', height: 0.7 },
  ],
  mid: [
    { id: 'oak-tree', height: 6.5 },
    { id: 'cc0-birch-tree', height: 6 },
    { id: 'gen3d-apple-tree', height: 5 },
    { id: 'gen3d-willow-tree', height: 6.5 },
    { id: 'gen3d-olive-tree', height: 5 },
  ],
  far: [
    { id: 'oak-tree', height: 7 },
    { id: 'cc0-birch-tree', height: 6.5 },
    { id: 'gen3d-poplar-tree', height: 9 },
  ],
  leaf: '#4f9a3a',
  density: 0.45,
};

const DESERT_FLORA: Flora = {
  near: [
    { id: 'gen3d-sandstone-rock', height: 0.7 },
    { id: 'cc0-grass', height: 0.5 },
    { id: 'gen3d-prickly-pear-cactus', height: 1.1 },
  ],
  mid: [
    { id: 'gen3d-cactus', height: 2.2 },
    { id: 'cc0-cactus-flowers', height: 2.4 },
    { id: 'gen3d-saguaro-cactus', height: 4 },
    { id: 'gen3d-cholla-cactus', height: 1.8 },
    { id: 'gen3d-dead-desert-tree', height: 3.2 },
    { id: 'gen3d-layered-canyon-rock', height: 2.5 },
  ],
  // Bez linie stromů; skály v dálce stály souvislou zdí (vrstva v dálce je hustá), proto jsou ve shlucích uprostřed.
  far: [],
  leaf: '#7f8f45',
  density: 0.3,
};

/** Pláž (P46G T8): palmy, duny trávy a kameny u moře, řídce. */
const BEACH_FLORA: Flora = {
  near: [
    { id: 'gen3d-dune-grass-clump', height: 0.9 },
    { id: 'gen3d-dune-grass-clump', height: 0.9 },
    { id: 'gen3d-sea-rock', height: 0.8 },
    { id: 'gen3d-sandstone-rock', height: 0.7 },
  ],
  mid: [
    { id: 'cc0-palm-tree', height: 6 },
    { id: 'gen3d-leaning-palm-tree', height: 6.5 },
    { id: 'gen3d-pandanus-tree', height: 4.5 },
  ],
  far: [
    { id: 'cc0-palm-tree', height: 7 },
    { id: 'gen3d-leaning-palm-tree', height: 7.5 },
  ],
  leaf: '#3f9a3c',
  density: 0.4,
};

/** Sníh (P46G T8): zasněžené jedle a holé stromy jednotlivě, kameny a led – sněžná pláň zůstane otevřená. */
const SNOW_FLORA: Flora = {
  near: [
    { id: 'gen3d-snowy-rock', height: 0.8 },
    { id: 'gen3d-river-boulder', height: 0.7 },
    { id: 'gen3d-ice-block-pile', height: 0.8 },
    { id: 'gen3d-frozen-shrub', height: 1.1 },
  ],
  mid: [
    { id: 'gen3d-snowy-fir-tree', height: 6 },
    { id: 'gen3d-snowy-fir-tree', height: 6 },
    { id: 'gen3d-bare-winter-tree', height: 5 },
    { id: 'gen3d-frozen-dead-tree', height: 4.5 },
  ],
  far: [
    { id: 'gen3d-snowy-fir-tree', height: 8 },
    { id: 'gen3d-snowy-fir-tree', height: 8 },
    { id: 'gen3d-bare-winter-tree', height: 6 },
  ],
  leaf: '#4f7d5a',
  density: 0.35,
};

/** Nejvýš tolik druhů vegetace na sadu: každý druh je jedna `InstancedMesh`, tedy kreslicí volání (P46G T8). */
export const FLORA_SPECIES = 14;

/** Rekvizity z primitiv, které jsou rostlina: vedle vegetace je kulisa nekreslí. */
const PLANT_PRIMITIVES: readonly SceneryKind[] = ['tree', 'pine', 'palm', 'cactus'];

/** Id všech druhů vegetace sady. */
export const floraIds = (flora: Flora): ReadonlySet<string> => new Set([...flora.near, ...flora.mid, ...flora.far].map((species) => species.id));

/**
 * Rekvizity sady ve scéně s vegetací (P46G T4): stromy a keře kreslí vegetace,
 * v řadě kulis zůstanou stavby a věci. Sada bez vegetace má rekvizity celé.
 */
export function landmarks(look: Look): readonly SceneryKind[] {
  if (look.flora === undefined) return look.props;
  const plants = new Set<string>([...PLANT_PRIMITIVES, ...floraIds(look.flora)]);
  return look.props.filter((prop) => !plants.has(prop));
}

/**
 * Obrys jedné vrstvy kulisy za mlhou (P46G T6, `look/backdrop-shapes.ts`): hory se špičkami,
 * oblé kopce, duny, linie jehličnanů, linie korun, stolové hory, panorama domů, pobřeží s mysy.
 */
export const SILHOUETTES = ['peaks', 'hills', 'dunes', 'pines', 'crowns', 'mesas', 'blocks', 'coast'] as const;
export type Silhouette = (typeof SILHOUETTES)[number];

/**
 * Kulisa za mlhou (P46G T6): 2–3 vrstvy obrysů od nejvzdálenější po nejbližší.
 * Barvu vrstvy dává barva mlhy (`horizon`, i po náladě a v noci) vynásobená `tone`:
 * silueta je vždy tmavší než mlha a má odstín sady.
 */
export interface Skyline {
  readonly layers: readonly Silhouette[];
  readonly tone: string;
}

export interface Look {
  /** Pozadí i barva mlhy. */
  readonly sky: string;
  readonly fog: readonly [near: number, far: number];
  /** Polokulové světlo: barva shora, zespodu, síla. */
  readonly light: readonly [sky: string, ground: string, intensity: number];
  readonly sun: number;
  /** Plocha kolem trati. */
  readonly ground: string;
  /** Dráha běžce. */
  readonly track: string;
  /** Hladina pod plošinami. */
  readonly water: string;
  readonly props: readonly SceneryKind[];
  /** Hlavní a doplňková barva rekvizit. */
  readonly tint: readonly [string, string];
  /** Hmota pevných plošin a bloků: bok a horní plocha (P30B T6). Bez ní hlína s trávou a dřevo. */
  readonly block?: readonly [side: string, top: string];
  /** Závod jede po hladině, dráha má barvu vody (P30B T6, „jungle river“). Píše jen `sceneLook`. */
  readonly afloat?: boolean;
  /** Hrdina jede (klouže, lyžuje), neběží – póza jízdy běžce (P32A T5-R1, `theme.motion`). Píše jen `sceneLook`. */
  readonly ride?: boolean;
  /* P32A – rig (`StyleRig`): kreslená obloha, slunce se stínem, ACES. Sníh má hodnoty z ukázky B. */
  /** Obloha v zenitu. */
  readonly skyTop: string;
  /** Obloha u obzoru a barva mlhy: vzdálený terén mizí do téže barvy, kterou má obloha za ním. */
  readonly horizon: string;
  readonly sunColor: string;
  /** Směr ke slunci z pohledu kamery: x vlevo, y nahoru, z dopředu (délka nerozhoduje). */
  readonly sunDir: readonly [left: number, up: number, forward: number];
  /** `toneMappingExposure` pod ACES. */
  readonly exposure: number;
  /** Síla slunce a záře na obloze; 0 = bez slunce (interiér, jeskyně, pod vodou – světlo jde shora). */
  readonly glow: number;
  /**
   * P32A T3 – údolí běžce (`terrain/valley.ts`): dráha, stín a skála; povrch je `ground`.
   * `cap` = sněhová čepička na kulisách. Sada bez něj si barvy odvodí ze země a dráhy.
   */
  readonly terrain?: { readonly lane: string; readonly shade: string; readonly rock: string; readonly cap?: string };
  /**
   * P32A T9 – povrch ostrůvků a podlahy arény (`terrain/islands.ts`, `terrain/arenaFloor.ts`).
   * `land` = barva souše tam, kde `ground` souš není (oceán: zem sady je hladina); jinak souš má barvu `ground`.
   */
  readonly cover: Cover;
  readonly land?: string;
  /** Povrch cesty závodu a běžce (P46G T2); slova místa ho přebijí v `sceneLook` (přístav = prkna). */
  readonly surface: SurfaceKind;
  /** Vegetace podél cesty (P46G T4); bez ní má scéna jen řadu kulis. */
  readonly flora?: Flora;
  /** Kulisa za mlhou (P46G T6); bez ní je za scénou jen mlha. */
  readonly skyline?: Skyline;
}

/** Slunce za kamerou vlevo nahoře – stín padá dopředu doprava, jako v ukázce B. */
const BEHIND_LEFT = [0.51, 0.81, -0.31] as const;
/** Světlo shora, mírně ze strany kamery: stropní lampy, hladina nad vodou, světlo v jeskyni. */
const OVERHEAD = [0.2, 1, -0.15] as const;

export const LOOKS: Readonly<Record<LookId, Look>> = {
  meadow: { sky: '#bae6fd', fog: [30, 90], light: ['#e0f2fe', '#166534', 0.9], sun: 1.6, ground: '#15803d', track: '#334155', water: '#0284c7', props: ['tree', 'cc0-bench', 'cc0-bush', 'cc0-flower', 'gen3d-windmill', 'gen3d-sunflower'], tint: ['#16a34a', '#78716c'], skyTop: '#3a86d8', horizon: '#d7ecf8', sunColor: '#fff0d4', sunDir: BEHIND_LEFT, exposure: 1, glow: 1, cover: 'grass', surface: 'dirt', flora: MEADOW_FLORA, skyline: { layers: ['peaks', 'hills', 'crowns'], tone: '#6a9a5c' } },
  city: { sky: '#cbd5e1', fog: [25, 80], light: ['#f1f5f9', '#475569', 0.9], sun: 1.4, ground: '#64748b', track: '#1f2937', water: '#0369a1', props: ['townhouse', 'cc0-car-taxi', 'lamp', 'cc0-fire-hydrant', 'building', 'gen3d-traffic-light', 'gen3d-bus-stop', 'gen3d-street-mailbox'], tint: ['#94a3b8', '#fbbf24'], skyTop: '#5b8fc7', horizon: '#dfe6ee', sunColor: '#fff1dc', sunDir: [0.45, 0.75, -0.5], exposure: 1, glow: 0.8, terrain: { lane: '#2b3036', shade: '#56606e', rock: '#8b9098' }, cover: 'paving', surface: 'asphalt', skyline: { layers: ['blocks', 'blocks'], tone: '#6c7686' } },
  mall: { sky: '#fef3c7', fog: [20, 70], light: ['#fffbeb', '#d6d3d1', 1.1], sun: 1.1, ground: '#e7e5e4', track: '#d6d3d1', water: '#38bdf8', props: ['potted-plant', 'cc0-bench', 'shopping-cart', 'shelf', 'lamp', 'gen3d-fountain', 'gen3d-vending-machine'], tint: ['#f97316', '#0ea5e9'], skyTop: '#f3e2b8', horizon: '#fef3c7', sunColor: '#fff7e6', sunDir: OVERHEAD, exposure: 1, glow: 0, cover: 'paving', surface: 'paving', skyline: { layers: ['blocks', 'blocks'], tone: '#b09c80' } },
  supermarket: { sky: '#f1f5f9', fog: [20, 70], light: ['#ffffff', '#cbd5e1', 1.1], sun: 1.0, ground: '#e2e8f0', track: '#cbd5e1', water: '#38bdf8', props: ['cc0-cabinet-shelves', 'shopping-cart', 'cc0-can-fridge', 'shelf', 'gen3d-fruit-stand', 'gen3d-cash-register'], tint: ['#dc2626', '#16a34a'], skyTop: '#dfe5ec', horizon: '#f1f5f9', sunColor: '#ffffff', sunDir: OVERHEAD, exposure: 1, glow: 0, cover: 'paving', surface: 'paving', skyline: { layers: ['blocks', 'blocks'], tone: '#9aa6b0' } },
  living_room: { sky: '#fde68a', fog: [18, 60], light: ['#fff7ed', '#a16207', 1.0], sun: 1.1, ground: '#b45309', track: '#92400e', water: '#0ea5e9', props: ['cc0-couch', 'cc0-lamp-standing', 'cc0-armchair', 'potted-plant', 'gen3d-bookshelf', 'gen3d-television'], tint: ['#0f766e', '#f59e0b'], skyTop: '#f2d27e', horizon: '#fde68a', sunColor: '#ffe8c2', sunDir: [0.35, 0.9, -0.25], exposure: 1, glow: 0, cover: 'paving', surface: 'planks', skyline: { layers: ['blocks', 'blocks'], tone: '#a07850' } },
  factory: { sky: '#a8a29e', fog: [20, 70], light: ['#e7e5e4', '#44403c', 0.8], sun: 1.3, ground: '#57534e', track: '#292524', water: '#155e75', props: ['steam-machine', 'cc0-barrel-stack', 'chimney', 'cc0-pallet', 'gen3d-crane', 'gen3d-container'], tint: ['#78716c', '#ea580c'], skyTop: '#86807a', horizon: '#b8b1aa', sunColor: '#ffe2c2', sunDir: [0.5, 0.7, -0.4], exposure: 1, glow: 0.5, cover: 'paving', surface: 'asphalt', skyline: { layers: ['blocks', 'blocks'], tone: '#6e665e' } },
  forest: { sky: '#bbf7d0', fog: [20, 70], light: ['#dcfce7', '#14532d', 0.8], sun: 1.3, ground: '#166534', track: '#78350f', water: '#0e7490', props: ['cc0-tree-pine', 'tree', 'cc0-stump', 'cc0-log-stack', 'gen3d-treehouse', 'gen3d-large-boulder'], tint: ['#14532d', '#57534e'], skyTop: '#4f97c9', horizon: '#cfeedd', sunColor: '#fff2cf', sunDir: BEHIND_LEFT, exposure: 1, glow: 0.8, cover: 'grass', surface: 'dirt', flora: FOREST_FLORA, skyline: { layers: ['peaks', 'crowns', 'pines'], tone: '#3f6e4c' } },
  jungle: { sky: '#a7f3d0', fog: [15, 60], light: ['#ecfdf5', '#064e3b', 0.9], sun: 1.2, ground: '#065f46', track: '#713f12', water: '#0f766e', props: ['cc0-palm-tree', 'cc0-bamboo', 'cc0-bush-berries', 'tree', 'gen3d-ruin'], tint: ['#15803d', '#65a30d'], skyTop: '#3f9fb0', horizon: '#c3f0dc', sunColor: '#fff5d0', sunDir: [0.4, 0.85, -0.3], exposure: 1, glow: 0.8, cover: 'grass', surface: 'dirt', flora: JUNGLE_FLORA, skyline: { layers: ['hills', 'crowns', 'crowns'], tone: '#3c7a4e' } },
  desert: { sky: '#fde68a', fog: [40, 120], light: ['#fffbeb', '#b45309', 1.0], sun: 2.0, ground: '#d97706', track: '#b45309', water: '#0891b2', props: ['cc0-cactus-flowers', 'rock', 'cactus', 'gen3d-termite-hill', 'gen3d-camel'], tint: ['#65a30d', '#92400e'], skyTop: '#2f7dd1', horizon: '#fbe3a8', sunColor: '#ffe6b8', sunDir: [0.55, 0.7, -0.35], exposure: 0.95, glow: 1, terrain: { lane: '#e6c38c', shade: '#c47f33', rock: '#8f5530' }, cover: 'sand', surface: 'sand', flora: DESERT_FLORA, skyline: { layers: ['mesas', 'dunes', 'dunes'], tone: '#d09a5e' } },
  beach: { sky: '#7dd3fc', fog: [40, 120], light: ['#f0f9ff', '#fcd34d', 1.0], sun: 1.9, ground: '#fcd34d', track: '#fde68a', water: '#0ea5e9', props: ['cc0-palm-tree', 'rock', 'cc0-boat-row', 'gen3d-sandcastle', 'gen3d-surfboard', 'gen3d-lighthouse'], tint: ['#16a34a', '#a8a29e'], skyTop: '#1f8fe0', horizon: '#cdeefd', sunColor: '#fff0d0', sunDir: [0.5, 0.75, -0.4], exposure: 0.95, glow: 1, cover: 'sand', surface: 'sand', flora: BEACH_FLORA, skyline: { layers: ['hills', 'coast'], tone: '#9fae8c' } },
  ocean: { sky: '#7dd3fc', fog: [30, 100], light: ['#f0f9ff', '#0369a1', 1.0], sun: 1.7, ground: '#0284c7', track: '#0c4a6e', water: '#0369a1', props: ['cc0-boat-row', 'buoy', 'rock', 'gen3d-sailboat', 'gen3d-lighthouse'], tint: ['#ef4444', '#64748b'], skyTop: '#1f7fd0', horizon: '#c2e6fb', sunColor: '#fff1d6', sunDir: [0.5, 0.75, -0.4], exposure: 0.95, glow: 1, cover: 'sand', land: '#e9d29a', surface: 'planks', skyline: { layers: ['coast', 'coast'], tone: '#8aa0a8' } },
  // Pod vodou je nahoře světlejší hladina, ne tmavší zenit.
  underwater: { sky: '#0e7490', fog: [8, 45], light: ['#67e8f9', '#164e63', 1.0], sun: 0.8, ground: '#155e75', track: '#0f766e', water: '#083344', props: ['coral', 'cc0-clownfish', 'seaweed', 'cc0-tang', 'rock', 'gen3d-jellyfish', 'gen3d-seahorse', 'gen3d-octopus'], tint: ['#fb7185', '#22c55e'], skyTop: '#3fb6cf', horizon: '#0e7490', sunColor: '#bff4ff', sunDir: OVERHEAD, exposure: 1, glow: 0, cover: 'sand', surface: 'sand', skyline: { layers: ['hills', 'crowns'], tone: '#2f6f73' } },
  // Ukázka B (`D:/caches/p32-style/page.html`, `renderVariant('B')`): obloha, polokoule, slunce 2,2 a expozice 0,9.
  snow: { sky: '#e0f2fe', fog: [25, 80], light: ['#bcd6ff', '#7d8ea8', 0.9], sun: 2.2, ground: '#f8fafc', track: '#cbd5e1', water: '#7dd3fc', props: ['pine', 'penguin', 'iceblock', 'cc0-sled', 'gen3d-ice-igloo', 'gen3d-snowman-with-hat', 'gen3d-iceberg'], tint: ['#e2e8f0', '#7dd3fc'], block: ['#cbd5e1', '#f8fafc'], skyTop: '#3d7bd9', horizon: '#e4eef8', sunColor: '#ffe9cc', sunDir: BEHIND_LEFT, exposure: 0.9, glow: 1, terrain: { lane: '#a7cde4', shade: '#c7d5e6', rock: '#66727f', cap: '#f4f8fc' }, cover: 'snow', surface: 'snow', flora: SNOW_FLORA, skyline: { layers: ['peaks', 'peaks', 'pines'], tone: '#9fb4cc' } },
  cave: { sky: '#1c1917', fog: [8, 40], light: ['#a8a29e', '#0c0a09', 0.8], sun: 0.7, ground: '#44403c', track: '#292524', water: '#155e75', props: ['rock', 'crystal', 'cc0-torch-lit', 'cc0-rock-moss', 'gen3d-crystal-cluster', 'gen3d-mine-cart'], tint: ['#2dd4bf', '#57534e'], block: ['#292524', '#57534e'], skyTop: '#0c0a09', horizon: '#292524', sunColor: '#ffd9a8', sunDir: OVERHEAD, exposure: 1.05, glow: 0, cover: 'rock', surface: 'dirt', skyline: { layers: ['peaks', 'peaks'], tone: '#6b625a' } },
  volcano: { sky: '#7c2d12', fog: [15, 60], light: ['#fdba74', '#450a0a', 0.9], sun: 1.2, ground: '#292524', track: '#44403c', water: '#ea580c', props: ['volcano', 'rock', 'crystal', 'gen3d-volcano', 'gen3d-crystal-cluster'], tint: ['#1c1917', '#f97316'], skyTop: '#2a0e0a', horizon: '#a4431d', sunColor: '#ffb27a', sunDir: [0.4, 0.7, -0.45], exposure: 1, glow: 0.6, cover: 'rock', surface: 'dirt', skyline: { layers: ['peaks', 'hills'], tone: '#5a3a2e' } },
  space: { sky: '#020617', fog: [40, 140], light: ['#e2e8f0', '#7f1d1d', 0.7], sun: 1.6, ground: '#b45309', track: '#7c2d12', water: '#0f172a', props: ['cc0-asteroid', 'crystal', 'rocket', 'rock', 'gen3d-moon-lander', 'gen3d-satellite-radar-dish', 'gen3d-space-colony-dome'], tint: ['#22d3ee', '#78350f'], skyTop: '#01030c', horizon: '#0b1730', sunColor: '#fff6e8', sunDir: [0.6, 0.55, -0.5], exposure: 1, glow: 1, cover: 'rock', surface: 'dirt', skyline: { layers: ['peaks', 'mesas'], tone: '#8a6a50' } },
  castle: { sky: '#bfdbfe', fog: [30, 90], light: ['#eff6ff', '#3f6212', 0.9], sun: 1.5, ground: '#4d7c0f', track: '#78716c', water: '#1d4ed8', props: ['tower', 'stone-wall', 'cc0-torch-lit', 'cc0-barrel', 'gen3d-drawbridge', 'gen3d-stone-water-well'], tint: ['#a8a29e', '#dc2626'], block: ['#57534e', '#a8a29e'], skyTop: '#3f7fd4', horizon: '#d6e6f7', sunColor: '#fff0d2', sunDir: [0.5, 0.75, -0.4], exposure: 1, glow: 1, cover: 'paving', surface: 'paving', skyline: { layers: ['peaks', 'hills', 'crowns'], tone: '#6f8a62' } },
  // Noc: slunce je měsíc – studené, slabé, záře nízko.
  graveyard: { sky: '#0f172a', fog: [10, 50], light: ['#94a3b8', '#1e293b', 0.7], sun: 0.6, ground: '#1e293b', track: '#334155', water: '#0c4a6e', props: ['grave', 'pine', 'cc0-pumpkin', 'cc0-skull-candle', 'gen3d-gravestone'], tint: ['#64748b', '#14532d'], skyTop: '#060b16', horizon: '#1e2a3d', sunColor: '#c9d8ee', sunDir: [0.45, 0.7, -0.45], exposure: 1, glow: 0.6, cover: 'grass', surface: 'dirt', skyline: { layers: ['hills', 'pines'], tone: '#4a5a52' } },
};

/**
 * Klíčová slova → sada. Pořadí rozhoduje: konkrétnější místo před obecnějším
 * („icy moon“ je vesmír, „jungle river“ džungle, „snow fort“ sníh).
 */
const KEYWORDS: readonly (readonly [LookId, RegExp])[] = [
  ['underwater', /under ?water|sea ?floor|seabed|reef|coral|aquarium|submarine|sunken|deep sea/],
  ['space', /space|mars|\bmoon|planet|asteroid|galax|orbit|alien|comet|\bstars?\b|cosmic/],
  ['volcano', /volcan|lava|magma|inferno/],
  ['cave', /\bcaves?\b|cavern|underground|grotto|tunnel/],
  ['jungle', /jungle|rainforest|swamp|amazon/],
  ['snow', /snow|\bice\b|\bicy\b|glacier|arctic|frozen|winter|polar|igloo|tundra/],
  ['desert', /desert|dune|sahara|outback|canyon|oasis|pyramid/],
  ['beach', /beach|coast|shore|island|tropic|vacation|holiday/],
  ['ocean', /ocean|\bsea\b|harbou?r|pirate|\blake\b|river|\bboat/],
  ['castle', /castle|kingdom|medieval|dungeon|fortress|\bfort\b|throne/],
  ['graveyard', /haunted|graveyard|cemetery|ghost|spooky|crypt|hospital|horror|zombie/],
  ['forest', /forest|woods|woodland|grove|campsite|camp\b/],
  ['factory', /factory|warehouse|workshop|laborator|\blab\b|construction|\bmine\b|mining|colony|garage/],
  ['supermarket', /supermarket|grocery|market|\bstore\b|bakery|kitchen|restaurant/],
  ['mall', /\bmall\b|shopping|arcade hall|plaza/],
  ['living_room', /living room|house|\bhome\b|bedroom|apartment|office|classroom|school|toy/],
  ['city', /city|street|town|downtown|road|traffic|rooftop|neon|subway|highway|urban|skyscraper/],
  // Věž až za městem a kuchyní: „pancake tower in a kitchen“ je kuchyně, samotná věž hrad (P30B T6).
  ['castle', /\btower\b/],
  ['meadow', /park|meadow|garden|farm|field|pond|countryside|hill/],
];

const match = (text: string): LookId | null => KEYWORDS.find(([, pattern]) => pattern.test(text.toLowerCase()))?.[0] ?? null;

/** Pozice slov textu, podle kterých `lookFor` sadu vybral, v pořadí textu (P27A T5: návrh z nich skládá místo). */
export function lookWords(text: string): number[] {
  const lower = text.toLowerCase();
  const found = KEYWORDS.find(([, pattern]) => pattern.test(lower));
  return found === undefined ? [] : [...lower.matchAll(new RegExp(found[1].source, 'g'))].map((hit) => hit.index);
}

/**
 * Sada podle slov prostředí, nálada až když místo nic neřekne („spooky“ nesmí
 * z obchoďáku udělat hřbitov). `null` = sady místo neznají.
 */
export function lookFor(setting: string, mood = ''): LookId | null {
  return match(setting) ?? match(mood);
}

/** Sada, kterou scéna vykreslí: volba modelu, jinak slova, jinak louka. */
export function lookOf(theme: { readonly setting: string; readonly mood: string; readonly look?: LookId }): LookId {
  return theme.look ?? lookFor(theme.setting, theme.mood) ?? 'meadow';
}

/**
 * Místo z věty, které sada nemá (P30B T6): porota u „Mars“, „moon“ a
 * „hospital“ viděla zem, která místo neřekla. Přebije jen barvu země, první
 * shoda vyhrává; `null` = zem sady („icy moon“ je sníh, ne regolit).
 */
const PLACE_GROUNDS: readonly (readonly [RegExp, string | null])[] = [
  [/\bic[ey]\b|frozen|glacier/, null],
  [/\bmoon\b|lunar/, '#a3a3a3'],
  [/\bmars\b|martian/, '#b5532f'],
  [/hospital|clinic/, '#d3ddd9'],
];

/** Voda pod závodem: loď po řece nejede po asfaltu. */
const WATERWAY = /\brivers?\b|canal|\blake\b|rapids|\bsea\b|ocean/;

/** Místo z věty, které přebije povrch cesty sady (P46G T2): přístav jde po prknech, silnice po asfaltu. */
const PLACE_SURFACES: readonly (readonly [RegExp, SurfaceKind])[] = [
  [/harbou?r|\bdocks?\b|\bpiers?\b|boardwalk|wharf|marina|jetty/, 'planks'],
  [/\broads?\b|street|highway|motorway|freeway|race ?track|speedway|parking/, 'asphalt'],
];

/**
 * Rekvizity prostředí, které text jmenuje (P45H T3): nejdelší shoda vyhrává
 * („desert canyon“ před „canyon“), při shodné délce dřívější řádek tabulky.
 * Prázdný seznam = prostředí bez kitu.
 */
export function kitFor(setting: string): readonly KitModel[] {
  const lower = setting.toLowerCase();
  let best: { readonly props: readonly KitModel[]; readonly length: number } | null = null;
  for (const kit of SETTING_KITS) {
    const hit = kit.pattern.exec(lower);
    if (hit !== null && (best === null || hit[0].length > best.length)) best = { props: kit.props, length: hit[0].length };
  }
  return best?.props ?? [];
}

/**
 * Rekvizity sady s kitem prostředí: kit a sada se střídají, sada si nechá
 * rekvizity z lichých pozic, kit zabere místo sudých. Seznam má sudou délku
 * 4–8, protože `sceneryPlaces` jde po rekvizitách krokem 7: ze sady o sedmi
 * by viděl jen první a poslední. Počet kulis ve scéně dává délka trati, ne seznam.
 */
export function withKit(props: readonly SceneryKind[], kit: readonly KitModel[]): readonly SceneryKind[] {
  if (kit.length === 0) return props;
  const kept = props.filter((_, index) => index % 2 === 1);
  return Array.from({ length: Math.max(kept.length, kit.length) }, (_, index) => [kit[index % kit.length]!, kept[index % kept.length]!]).flat();
}

/** Podzim z věty (P46G T4): jen slovo, „waterfall“ ani „falling“ ne. */
const AUTUMN = /\bautumn\w*|\bfall\b/;

/** Nálada z věty (P46G T5): co věta řekne o světle, scéna ukáže. */
export type Mood = 'spooky' | 'storm' | 'gloom' | 'fog' | 'bright' | 'dusk';

/** Slova → nálada. Pořadí rozhoduje: strašidelný temný les je strašidelný, bouřka je tmavá i bez „dark“. */
const MOOD_WORDS: readonly (readonly [Mood, RegExp])[] = [
  ['spooky', /\b(?:spooky|haunted|creepy)\b/],
  ['storm', /\b(?:storm|stormy|rain|rainy|raining)\b/],
  ['gloom', /\b(?:dark|darkness|gloomy|shadowy)\b/],
  ['fog', /\b(?:fog|foggy|mist|misty)\b/],
  ['bright', /\b(?:sunny|bright)\b/],
  ['dusk', /\b(?:sunset|dusk)\b/],
];

/** Nálada ze slov místa i nálady specu; `null` = věta o světle nic neřekne a sada zůstane, jaká byla. */
export function moodFor(setting: string, mood: string): Mood | null {
  const text = `${setting} ${mood}`.toLowerCase();
  return MOOD_WORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/**
 * Úprava sady náladou: obloha, obzor (= barva mlhy) a polokoule zespodu jdou
 * o `amount` k `tone`, světlo shora a slunce k `lightTone`; síla polokoule,
 * slunce, záře a začátek a konec mlhy se násobí.
 */
interface MoodShift {
  readonly tone: string;
  readonly lightTone: string;
  readonly amount: number;
  readonly light: number;
  readonly sun: number;
  readonly glow: number;
  readonly fog: readonly [near: number, far: number];
}

/*
 * Tóny oblohy mají zelenou aspoň jako modrou: směs s rudou oblohou sopky tak
 * jde přes šedou, ne přes fialovou.
 */
const MOOD_SHIFTS: Readonly<Record<Exclude<Mood, 'dusk'>, MoodShift>> = {
  // Šero: tlumené světlo, tmavší mlha, studené barvy.
  gloom: { tone: '#283a3a', lightTone: '#a9bdc8', amount: 0.65, light: 0.9, sun: 0.45, glow: 0.15, fog: [0.6, 0.8] },
  // Strašidelno: šero do zelenomodra (ne do fialova) a hustší mlha.
  spooky: { tone: '#1d3a37', lightTone: '#a3d6c8', amount: 0.7, light: 0.85, sun: 0.3, glow: 0.15, fog: [0.45, 0.65] },
  // Bouřka: tmavé šedé nebe; déšť kreslí `Weather.tsx`.
  storm: { tone: '#3a4a4a', lightTone: '#b0bcc4', amount: 0.7, light: 0.9, sun: 0.35, glow: 0.08, fog: [0.6, 0.8] },
  // Mlha: světlá a blíž.
  fog: { tone: '#c8d0d0', lightTone: '#e2e8ec', amount: 0.6, light: 1, sun: 0.6, glow: 0.4, fog: [0.3, 0.55] },
  // Jasno: barvy sady, silnější slunce a dohled dál.
  bright: { tone: '#ffffff', lightTone: '#ffffff', amount: 0, light: 1.1, sun: 1.2, glow: 1, fog: [1.25, 1.25] },
};

/** Noc nad sadou: slunce je měsíc – studené, slabé, záře nízko. */
const NIGHT = { sky: '#101d32', skyTop: '#050d1b', horizon: '#172c45', light: ['#92b9df', '#283747', 0.8], sun: 0.35, sunColor: '#bcdcff', glow: 0.12 } as const;
const DUSK = { sky: '#785944', skyTop: '#233a51', horizon: '#d59461', light: ['#e3b28b', '#4c4137', 0.95], sun: 0.75, sunColor: '#ffd1a0', glow: 0.55 } as const;

/** Směs dvou `#rrggbb` po kanálech. */
const mix = (from: string, to: string, t: number): string =>
  `#${[1, 3, 5]
    .map((at) => {
      const a = Number.parseInt(from.slice(at, at + 2), 16);
      return Math.round(a + (Number.parseInt(to.slice(at, at + 2), 16) - a) * t)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;

/** Relativní jas `#rrggbb` (lineární sRGB). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Světlo na matné ploše: polokoule shora a slunce. simplified: bez úhlů a ACES – stačí na srovnání nálady s nocí. */
const brightness = (look: Pick<Look, 'light' | 'sun' | 'sunColor'>): number => look.light[2] * luminance(look.light[0]) + look.sun * luminance(look.sunColor);

/** Sada v náladě. Světlo neklesne pod noc: hrdina a překážky zůstanou proti zemi čitelné aspoň jako v noci. */
function withMood(look: Look, shift: MoodShift): Look {
  const tone = (hex: string) => mix(hex, shift.tone, shift.amount);
  const toLight = (hex: string) => mix(hex, shift.lightTone, shift.amount);
  const moody = { light: [toLight(look.light[0]), tone(look.light[1]), look.light[2] * shift.light] as const, sun: look.sun * shift.sun, sunColor: toLight(look.sunColor) };
  const lift = Math.max(1, brightness(NIGHT) / brightness(moody));
  return {
    ...look,
    sky: tone(look.sky),
    skyTop: tone(look.skyTop),
    horizon: tone(look.horizon),
    light: [moody.light[0], moody.light[1], moody.light[2] * lift],
    sun: moody.sun * lift,
    sunColor: moody.sunColor,
    glow: look.glow * shift.glow,
    fog: [look.fog[0] * shift.fog[0], look.fog[1] * shift.fog[1]],
  };
}

/**
 * Sada, jak ji scéna kreslí: `lookOf` plus místo z věty (zem, hladina pod závodem, rekvizity prostředí, podzim),
 * jízda hrdiny, denní doba a nálada. Noc přebije náladu; věta bez slov nálady a denní doby má sadu beze změny.
 */
export function sceneLook(theme: { readonly setting: string; readonly mood: string; readonly look?: LookId; readonly motion?: string; readonly timeOfDay?: TimeOfDay }): Look {
  const look = LOOKS[lookOf(theme)];
  const setting = theme.setting.toLowerCase();
  const ground = PLACE_GROUNDS.find(([pattern]) => pattern.test(setting))?.[1] ?? look.ground;
  const afloat = WATERWAY.test(setting);
  const ride = theme.motion === 'ride';
  const kit = kitFor(setting);
  const surface = PLACE_SURFACES.find(([pattern]) => pattern.test(setting))?.[1] ?? look.surface;
  const autumn = look.flora !== undefined && AUTUMN.test(`${setting} ${theme.mood.toLowerCase()}`);
  const placed =
    ground === look.ground && !afloat && !ride && kit.length === 0 && surface === look.surface && !autumn
      ? look
      : { ...look, ground, afloat, surface, props: withKit(look.props, kit), ...(ride ? { ride } : {}), ...(autumn ? { flora: { ...look.flora!, autumn } } : {}) };
  const mood = moodFor(theme.setting, theme.mood);
  const time = theme.timeOfDay ?? timeOfDayFor(theme.setting) ?? (mood === 'dusk' ? 'dusk' : null);
  if (time === 'night') return { ...placed, ...NIGHT, exposure: Math.min(placed.exposure, 1) };
  const timed = time === 'dusk' ? { ...placed, ...DUSK } : placed;
  return mood === null || mood === 'dusk' ? timed : withMood(timed, MOOD_SHIFTS[mood]);
}
