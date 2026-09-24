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
] as const;
export type PropKind = (typeof PROP_KINDS)[number];

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
  readonly props: readonly PropKind[];
  /** Hlavní a doplňková barva rekvizit. */
  readonly tint: readonly [string, string];
}

export const LOOKS: Readonly<Record<LookId, Look>> = {
  meadow: { sky: '#bae6fd', fog: [30, 90], light: ['#e0f2fe', '#166534', 0.9], sun: 1.6, ground: '#15803d', track: '#334155', water: '#0284c7', props: ['tree', 'rock'], tint: ['#16a34a', '#78716c'] },
  city: { sky: '#cbd5e1', fog: [25, 80], light: ['#f1f5f9', '#475569', 0.9], sun: 1.4, ground: '#64748b', track: '#1f2937', water: '#0369a1', props: ['building', 'lamp'], tint: ['#94a3b8', '#fbbf24'] },
  mall: { sky: '#fef3c7', fog: [20, 70], light: ['#fffbeb', '#d6d3d1', 1.1], sun: 1.1, ground: '#e7e5e4', track: '#d6d3d1', water: '#38bdf8', props: ['shelf', 'lamp'], tint: ['#f97316', '#0ea5e9'] },
  supermarket: { sky: '#f1f5f9', fog: [20, 70], light: ['#ffffff', '#cbd5e1', 1.1], sun: 1.0, ground: '#e2e8f0', track: '#cbd5e1', water: '#38bdf8', props: ['shelf', 'crate'], tint: ['#dc2626', '#16a34a'] },
  living_room: { sky: '#fde68a', fog: [18, 60], light: ['#fff7ed', '#a16207', 1.0], sun: 1.1, ground: '#b45309', track: '#92400e', water: '#0ea5e9', props: ['sofa', 'lamp'], tint: ['#0f766e', '#f59e0b'] },
  factory: { sky: '#a8a29e', fog: [20, 70], light: ['#e7e5e4', '#44403c', 0.8], sun: 1.3, ground: '#57534e', track: '#292524', water: '#155e75', props: ['chimney', 'crate'], tint: ['#78716c', '#ea580c'] },
  forest: { sky: '#bbf7d0', fog: [20, 70], light: ['#dcfce7', '#14532d', 0.8], sun: 1.3, ground: '#166534', track: '#78350f', water: '#0e7490', props: ['pine', 'tree', 'rock'], tint: ['#14532d', '#57534e'] },
  jungle: { sky: '#a7f3d0', fog: [15, 60], light: ['#ecfdf5', '#064e3b', 0.9], sun: 1.2, ground: '#065f46', track: '#713f12', water: '#0f766e', props: ['palm', 'tree'], tint: ['#15803d', '#65a30d'] },
  desert: { sky: '#fde68a', fog: [40, 120], light: ['#fffbeb', '#b45309', 1.0], sun: 2.0, ground: '#d97706', track: '#b45309', water: '#0891b2', props: ['cactus', 'rock'], tint: ['#65a30d', '#92400e'] },
  beach: { sky: '#7dd3fc', fog: [40, 120], light: ['#f0f9ff', '#fcd34d', 1.0], sun: 1.9, ground: '#fcd34d', track: '#fde68a', water: '#0ea5e9', props: ['palm', 'rock'], tint: ['#16a34a', '#a8a29e'] },
  ocean: { sky: '#7dd3fc', fog: [30, 100], light: ['#f0f9ff', '#0369a1', 1.0], sun: 1.7, ground: '#0284c7', track: '#0c4a6e', water: '#0369a1', props: ['buoy', 'rock'], tint: ['#ef4444', '#64748b'] },
  underwater: { sky: '#0e7490', fog: [8, 45], light: ['#67e8f9', '#164e63', 1.0], sun: 0.8, ground: '#155e75', track: '#0f766e', water: '#083344', props: ['coral', 'seaweed', 'rock'], tint: ['#fb7185', '#22c55e'] },
  snow: { sky: '#e0f2fe', fog: [25, 80], light: ['#ffffff', '#bae6fd', 1.1], sun: 1.4, ground: '#f8fafc', track: '#cbd5e1', water: '#7dd3fc', props: ['pine', 'iceblock'], tint: ['#e2e8f0', '#7dd3fc'] },
  cave: { sky: '#1c1917', fog: [8, 40], light: ['#a8a29e', '#0c0a09', 0.8], sun: 0.7, ground: '#44403c', track: '#292524', water: '#155e75', props: ['rock', 'crystal'], tint: ['#2dd4bf', '#57534e'] },
  volcano: { sky: '#7c2d12', fog: [15, 60], light: ['#fdba74', '#450a0a', 0.9], sun: 1.2, ground: '#292524', track: '#44403c', water: '#ea580c', props: ['rock', 'crystal'], tint: ['#1c1917', '#f97316'] },
  space: { sky: '#020617', fog: [40, 140], light: ['#e2e8f0', '#7f1d1d', 0.7], sun: 1.6, ground: '#b45309', track: '#7c2d12', water: '#0f172a', props: ['crystal', 'rock'], tint: ['#22d3ee', '#78350f'] },
  castle: { sky: '#bfdbfe', fog: [30, 90], light: ['#eff6ff', '#3f6212', 0.9], sun: 1.5, ground: '#4d7c0f', track: '#78716c', water: '#1d4ed8', props: ['tower', 'rock'], tint: ['#a8a29e', '#dc2626'] },
  graveyard: { sky: '#0f172a', fog: [10, 50], light: ['#94a3b8', '#1e293b', 0.7], sun: 0.6, ground: '#1e293b', track: '#334155', water: '#0c4a6e', props: ['grave', 'pine'], tint: ['#64748b', '#14532d'] },
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
