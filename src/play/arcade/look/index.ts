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
 * Bez runtime importů – skript sady věrnosti soubor načítá holým Nodem.
 * Nic fialového: odstíny 250–320° tu nejsou.
 */

/** Počasí a denní doba nad sadou (P29D): živá změna je píše do logu, sdílená verze do `theme`. */
export const WEATHERS = ['clear', 'rain', 'snow', 'fog'] as const;
export type Weather = (typeof WEATHERS)[number];
export const TIMES_OF_DAY = ['day', 'dusk', 'night'] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

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
export type SceneryModel = keyof typeof SCENERY_MODELS;
export type SceneryKind = PropKind | SceneryModel;

export const isSceneryModel = (kind: SceneryKind): kind is SceneryModel => Object.hasOwn(SCENERY_MODELS, kind);

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
}

/** Slunce za kamerou vlevo nahoře – stín padá dopředu doprava, jako v ukázce B. */
const BEHIND_LEFT = [0.51, 0.81, -0.31] as const;
/** Světlo shora, mírně ze strany kamery: stropní lampy, hladina nad vodou, světlo v jeskyni. */
const OVERHEAD = [0.2, 1, -0.15] as const;

export const LOOKS: Readonly<Record<LookId, Look>> = {
  meadow: { sky: '#bae6fd', fog: [30, 90], light: ['#e0f2fe', '#166534', 0.9], sun: 1.6, ground: '#15803d', track: '#334155', water: '#0284c7', props: ['tree', 'cc0-bench', 'cc0-bush', 'cc0-flower', 'gen3d-windmill', 'gen3d-sunflower'], tint: ['#16a34a', '#78716c'], skyTop: '#3a86d8', horizon: '#d7ecf8', sunColor: '#fff0d4', sunDir: BEHIND_LEFT, exposure: 1, glow: 1 },
  city: { sky: '#cbd5e1', fog: [25, 80], light: ['#f1f5f9', '#475569', 0.9], sun: 1.4, ground: '#64748b', track: '#1f2937', water: '#0369a1', props: ['townhouse', 'cc0-car-taxi', 'lamp', 'cc0-fire-hydrant', 'building', 'gen3d-traffic-light', 'gen3d-bus-stop', 'gen3d-street-mailbox'], tint: ['#94a3b8', '#fbbf24'], skyTop: '#5b8fc7', horizon: '#dfe6ee', sunColor: '#fff1dc', sunDir: [0.45, 0.75, -0.5], exposure: 1, glow: 0.8 },
  mall: { sky: '#fef3c7', fog: [20, 70], light: ['#fffbeb', '#d6d3d1', 1.1], sun: 1.1, ground: '#e7e5e4', track: '#d6d3d1', water: '#38bdf8', props: ['potted-plant', 'cc0-bench', 'shopping-cart', 'shelf', 'lamp', 'gen3d-fountain', 'gen3d-vending-machine'], tint: ['#f97316', '#0ea5e9'], skyTop: '#f3e2b8', horizon: '#fef3c7', sunColor: '#fff7e6', sunDir: OVERHEAD, exposure: 1, glow: 0 },
  supermarket: { sky: '#f1f5f9', fog: [20, 70], light: ['#ffffff', '#cbd5e1', 1.1], sun: 1.0, ground: '#e2e8f0', track: '#cbd5e1', water: '#38bdf8', props: ['cc0-cabinet-shelves', 'shopping-cart', 'cc0-can-fridge', 'shelf', 'gen3d-fruit-stand', 'gen3d-cash-register'], tint: ['#dc2626', '#16a34a'], skyTop: '#dfe5ec', horizon: '#f1f5f9', sunColor: '#ffffff', sunDir: OVERHEAD, exposure: 1, glow: 0 },
  living_room: { sky: '#fde68a', fog: [18, 60], light: ['#fff7ed', '#a16207', 1.0], sun: 1.1, ground: '#b45309', track: '#92400e', water: '#0ea5e9', props: ['cc0-couch', 'cc0-lamp-standing', 'cc0-armchair', 'potted-plant', 'gen3d-bookshelf', 'gen3d-television'], tint: ['#0f766e', '#f59e0b'], skyTop: '#f2d27e', horizon: '#fde68a', sunColor: '#ffe8c2', sunDir: [0.35, 0.9, -0.25], exposure: 1, glow: 0 },
  factory: { sky: '#a8a29e', fog: [20, 70], light: ['#e7e5e4', '#44403c', 0.8], sun: 1.3, ground: '#57534e', track: '#292524', water: '#155e75', props: ['steam-machine', 'cc0-barrel-stack', 'chimney', 'cc0-pallet', 'gen3d-crane', 'gen3d-container'], tint: ['#78716c', '#ea580c'], skyTop: '#86807a', horizon: '#b8b1aa', sunColor: '#ffe2c2', sunDir: [0.5, 0.7, -0.4], exposure: 1, glow: 0.5 },
  forest: { sky: '#bbf7d0', fog: [20, 70], light: ['#dcfce7', '#14532d', 0.8], sun: 1.3, ground: '#166534', track: '#78350f', water: '#0e7490', props: ['cc0-tree-pine', 'tree', 'cc0-stump', 'cc0-log-stack', 'gen3d-treehouse', 'gen3d-large-boulder'], tint: ['#14532d', '#57534e'], skyTop: '#4f97c9', horizon: '#cfeedd', sunColor: '#fff2cf', sunDir: BEHIND_LEFT, exposure: 1, glow: 0.8 },
  jungle: { sky: '#a7f3d0', fog: [15, 60], light: ['#ecfdf5', '#064e3b', 0.9], sun: 1.2, ground: '#065f46', track: '#713f12', water: '#0f766e', props: ['cc0-palm-tree', 'cc0-bamboo', 'cc0-bush-berries', 'tree', 'gen3d-ruin'], tint: ['#15803d', '#65a30d'], skyTop: '#3f9fb0', horizon: '#c3f0dc', sunColor: '#fff5d0', sunDir: [0.4, 0.85, -0.3], exposure: 1, glow: 0.8 },
  desert: { sky: '#fde68a', fog: [40, 120], light: ['#fffbeb', '#b45309', 1.0], sun: 2.0, ground: '#d97706', track: '#b45309', water: '#0891b2', props: ['cc0-cactus-flowers', 'rock', 'cactus', 'gen3d-termite-hill', 'gen3d-camel'], tint: ['#65a30d', '#92400e'], skyTop: '#2f7dd1', horizon: '#fbe3a8', sunColor: '#ffe6b8', sunDir: [0.55, 0.7, -0.35], exposure: 0.95, glow: 1 },
  beach: { sky: '#7dd3fc', fog: [40, 120], light: ['#f0f9ff', '#fcd34d', 1.0], sun: 1.9, ground: '#fcd34d', track: '#fde68a', water: '#0ea5e9', props: ['cc0-palm-tree', 'rock', 'cc0-boat-row', 'gen3d-sandcastle', 'gen3d-surfboard', 'gen3d-lighthouse'], tint: ['#16a34a', '#a8a29e'], skyTop: '#1f8fe0', horizon: '#cdeefd', sunColor: '#fff0d0', sunDir: [0.5, 0.75, -0.4], exposure: 0.95, glow: 1 },
  ocean: { sky: '#7dd3fc', fog: [30, 100], light: ['#f0f9ff', '#0369a1', 1.0], sun: 1.7, ground: '#0284c7', track: '#0c4a6e', water: '#0369a1', props: ['cc0-boat-row', 'buoy', 'rock', 'gen3d-sailboat', 'gen3d-lighthouse'], tint: ['#ef4444', '#64748b'], skyTop: '#1f7fd0', horizon: '#c2e6fb', sunColor: '#fff1d6', sunDir: [0.5, 0.75, -0.4], exposure: 0.95, glow: 1 },
  // Pod vodou je nahoře světlejší hladina, ne tmavší zenit.
  underwater: { sky: '#0e7490', fog: [8, 45], light: ['#67e8f9', '#164e63', 1.0], sun: 0.8, ground: '#155e75', track: '#0f766e', water: '#083344', props: ['coral', 'cc0-clownfish', 'seaweed', 'cc0-tang', 'rock', 'gen3d-jellyfish', 'gen3d-seahorse', 'gen3d-octopus'], tint: ['#fb7185', '#22c55e'], skyTop: '#3fb6cf', horizon: '#0e7490', sunColor: '#bff4ff', sunDir: OVERHEAD, exposure: 1, glow: 0 },
  // Ukázka B (`D:/caches/p32-style/page.html`, `renderVariant('B')`): obloha, polokoule, slunce 2,2 a expozice 0,9.
  snow: { sky: '#e0f2fe', fog: [25, 80], light: ['#bcd6ff', '#7d8ea8', 0.9], sun: 2.2, ground: '#f8fafc', track: '#cbd5e1', water: '#7dd3fc', props: ['pine', 'penguin', 'iceblock', 'cc0-sled', 'gen3d-ice-igloo', 'gen3d-snowman-with-hat', 'gen3d-iceberg'], tint: ['#e2e8f0', '#7dd3fc'], block: ['#cbd5e1', '#f8fafc'], skyTop: '#3d7bd9', horizon: '#e4eef8', sunColor: '#ffe9cc', sunDir: BEHIND_LEFT, exposure: 0.9, glow: 1 },
  cave: { sky: '#1c1917', fog: [8, 40], light: ['#a8a29e', '#0c0a09', 0.8], sun: 0.7, ground: '#44403c', track: '#292524', water: '#155e75', props: ['rock', 'crystal', 'cc0-torch-lit', 'cc0-rock-moss', 'gen3d-crystal-cluster', 'gen3d-mine-cart'], tint: ['#2dd4bf', '#57534e'], block: ['#292524', '#57534e'], skyTop: '#0c0a09', horizon: '#292524', sunColor: '#ffd9a8', sunDir: OVERHEAD, exposure: 1.05, glow: 0 },
  volcano: { sky: '#7c2d12', fog: [15, 60], light: ['#fdba74', '#450a0a', 0.9], sun: 1.2, ground: '#292524', track: '#44403c', water: '#ea580c', props: ['volcano', 'rock', 'crystal', 'gen3d-volcano', 'gen3d-crystal-cluster'], tint: ['#1c1917', '#f97316'], skyTop: '#2a0e0a', horizon: '#a4431d', sunColor: '#ffb27a', sunDir: [0.4, 0.7, -0.45], exposure: 1, glow: 0.6 },
  space: { sky: '#020617', fog: [40, 140], light: ['#e2e8f0', '#7f1d1d', 0.7], sun: 1.6, ground: '#b45309', track: '#7c2d12', water: '#0f172a', props: ['cc0-asteroid', 'crystal', 'rocket', 'rock', 'gen3d-moon-lander', 'gen3d-satellite-radar-dish', 'gen3d-space-colony-dome'], tint: ['#22d3ee', '#78350f'], skyTop: '#01030c', horizon: '#0b1730', sunColor: '#fff6e8', sunDir: [0.6, 0.55, -0.5], exposure: 1, glow: 1 },
  castle: { sky: '#bfdbfe', fog: [30, 90], light: ['#eff6ff', '#3f6212', 0.9], sun: 1.5, ground: '#4d7c0f', track: '#78716c', water: '#1d4ed8', props: ['tower', 'stone-wall', 'cc0-torch-lit', 'cc0-barrel', 'gen3d-drawbridge', 'gen3d-stone-water-well'], tint: ['#a8a29e', '#dc2626'], block: ['#57534e', '#a8a29e'], skyTop: '#3f7fd4', horizon: '#d6e6f7', sunColor: '#fff0d2', sunDir: [0.5, 0.75, -0.4], exposure: 1, glow: 1 },
  // Noc: slunce je měsíc – studené, slabé, záře nízko.
  graveyard: { sky: '#0f172a', fog: [10, 50], light: ['#94a3b8', '#1e293b', 0.7], sun: 0.6, ground: '#1e293b', track: '#334155', water: '#0c4a6e', props: ['grave', 'pine', 'cc0-pumpkin', 'cc0-skull-candle', 'gen3d-gravestone'], tint: ['#64748b', '#14532d'], skyTop: '#060b16', horizon: '#1e2a3d', sunColor: '#c9d8ee', sunDir: [0.45, 0.7, -0.45], exposure: 1, glow: 0.6 },
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
  ['beach', /beach|coast|shore|island|tropic/],
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

/** Sada, jak ji scéna kreslí: `lookOf` plus místo z věty (zem, hladina pod závodem). */
export function sceneLook(theme: { readonly setting: string; readonly mood: string; readonly look?: LookId }): Look {
  const look = LOOKS[lookOf(theme)];
  const setting = theme.setting.toLowerCase();
  const ground = PLACE_GROUNDS.find(([pattern]) => pattern.test(setting))?.[1] ?? look.ground;
  const afloat = WATERWAY.test(setting);
  return ground === look.ground && !afloat ? look : { ...look, ground, afloat };
}
