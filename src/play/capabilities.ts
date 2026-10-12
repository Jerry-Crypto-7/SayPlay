/**
 * Tabulka schopností ovládání (P26 T5) – jediný zdroj pravdy o tom, co hra
 * z GameSpecu **opravdu použije**. Pravidlo P26: co AI napíše, musí být vidět
 * nebo hrát, jinak to napsat nesmí.
 *
 * Z tabulky se vyrábí:
 * 1. kontrola kritika – položka, kterou ovládání nečte, je nález, ne tiché zahození;
 * 2. věrnost ve specifikaci v sadě `evals/play/fidelity` (`scripts/play-fidelity.mjs`).
 *
 * Zadání modelu ovládání od P32B T4 nevyjmenovává: režisér vybírá žánr
 * (`director/prompt.ts`) a ovládání určí modul žánru.
 *
 * Každou buňku „čte“ drží test `__tests__/capabilities.test.ts`: změna položky
 * změní svět (hash) nebo model, který vykreslení zvolí; buňka „nečte“ naopak nic.
 *
 * Soubor má jen typové importy – skript sady věrnosti ho načítá holým Nodem.
 */

import type { MechanicId } from './registry';
import type { AbilityId, AddonId, ControlId, GameRole, GameSpecV1 } from './spec';

export interface ControlCapability {
  /** Narážky, podle kterých model ovládání pozná (žánr, známé hry). */
  readonly cues: string;
  /** Id rolí, které jádro kromě `player` a `finish` zná – jen popisek do obálky, pokud je nečte `labels`. */
  readonly roles: readonly string[];
  /** Vyhrává se dojetím do role `finish`. */
  readonly finish: boolean;
  /** Co model musí dodržet navíc (archetyp, cíl). */
  readonly note?: string;
  /** Popisky rolí, podle kterých vykreslení volí model: `'all'`, nebo role hráče a id rolí (`enemy`, `coin`, `obstacle`, `target` – P26 T12; `barrier`, `note`, `block` – P30B T4; `finish` – P35 T3; nástrahy `spikes`, `pipe`, `hazard` – P39 T9). */
  readonly labels: 'all' | readonly ('player' | 'enemy' | 'coin' | 'obstacle' | 'target' | 'rival' | 'barrier' | 'turbo' | 'note' | 'block' | 'finish' | 'spikes' | 'pipe' | 'hazard' | 'glide_rival' | 'glide_pursuer' | 'guard' | 'chaser' | 'goalkeeper')[];
  /** Mechaniky, které kompilátor čte – mění svět. */
  readonly mechanics: 'all' | readonly MechanicId[];
  /** Počty rolí (`count`) mění svět. */
  readonly counts: boolean;
  /** Prostředí (`theme.setting` / `theme.look`) mění scénu – u arkády sada z `arcade/look` (P26 T11). */
  readonly setting: boolean;
  /** Kolik rolí má smysl napsat. */
  readonly maxRoles: number;
  /** Doplňky (P26D), které jádro k ovládání přidá a robot s nimi vyhraje. */
  readonly addons: readonly AddonId[];
  /** Akce hrdiny (P46A), které ovládání bere; zbylá ovládání je dostanou v T9. */
  readonly abilities: readonly AbilityId[];
}

const LIVES_AND_TIMER: readonly MechanicId[] = ['health', 'timer'];

/** Doplňky ovládání s tratí k cíli: běh, skákání, poletování (aréna sbírá už sama – potrava). */
const ROAMING: readonly AddonId[] = ['shoot', 'collect', 'lives'];

/** Všech 5 akcí: běžec, skákačka a řízení (P46A T3–T6). */
const ALL_ABILITIES: readonly AbilityId[] = ['shoot', 'strike', 'dash', 'shield', 'grab'];

const arcade = (
  entry: Omit<ControlCapability, 'counts' | 'setting' | 'maxRoles' | 'addons' | 'abilities'> & { readonly setting?: boolean; readonly counts?: boolean; readonly addons?: readonly AddonId[]; readonly abilities?: readonly AbilityId[] },
): ControlCapability => ({
  ...entry,
  counts: entry.counts ?? false,
  setting: entry.setting ?? false,
  maxRoles: 1 + (entry.finish ? 1 : 0) + entry.roles.length,
  // Životy jen tam, kde ovládání čte `health` – jinak by doplněk nic neubral.
  addons: entry.addons ?? (entry.mechanics === 'all' || entry.mechanics.includes('health') ? ['lives'] : []),
  abilities: entry.abilities ?? [],
});

export const CAPABILITIES: Readonly<Record<ControlId, ControlCapability>> = {
  glide: arcade({ setting: true, cues: 'swim or fly in three dimensions', roles: ['glide_ring', 'glide_reef'], finish: true, labels: ['player', 'enemy', 'finish', 'glide_rival', 'glide_pursuer'], mechanics: ['timer'], addons: ['shoot'] }),
  walker: arcade({ setting: true, cues: 'walk through a maze', roles: ['wall', 'coin', 'guard', 'chaser'], finish: true, labels: ['player', 'coin', 'finish', 'guard', 'chaser'], mechanics: ['health', 'timer'], addons: ['lives'] }),
  ball: arcade({ setting: true, cues: 'aim and shoot a ball', roles: ['target', 'goalkeeper'], finish: true, labels: ['player', 'goalkeeper'], mechanics: ['timer'], addons: [] }),
  tap_go: { cues: 'tap-to-move grid', roles: [], finish: false, labels: 'all', mechanics: 'all', counts: true, setting: true, maxRoles: 12, addons: [], abilities: [] },
  // P26D T9: počty od 2 čte generátor – běžec mince a řady překážek, plošinovka a poletování mince, střelnice terče a nepřátele.
  runner: arcade({ setting: true, counts: true, cues: 'endless runner, subway surfers', roles: ['obstacle', 'coin'], finish: true, labels: ['player', 'obstacle', 'coin'], mechanics: LIVES_AND_TIMER, addons: [...ROAMING, 'chaser'], abilities: ALL_ABILITIES }),
  // P35 T3: cíl na konci úrovně kreslí model z popisku („moon“, „battery“), jinak vlajku.
  platform: arcade({ setting: true, counts: true, cues: 'platformer, mario, obby', roles: ['spikes', 'coin'], finish: true, labels: ['player', 'coin', 'finish', 'spikes'], mechanics: LIVES_AND_TIMER, addons: [...ROAMING, 'chaser'], abilities: ALL_ABILITIES }),
  flap: arcade({ setting: true, counts: true, cues: 'flappy bird, pipe gaps', roles: ['pipe', 'coin'], finish: true, labels: ['player', 'coin', 'pipe'], mechanics: LIVES_AND_TIMER, addons: ROAMING }),
  // P27A T3: závod a aréna kreslí kulisy sady prostředí mimo dráhu a za hranou arény.
  steer: arcade({ setting: true, cues: 'racing, fly a plane', roles: ['barrier', 'rival', 'turbo'], finish: true, labels: ['player', 'rival', 'barrier', 'hazard', 'finish', 'turbo'], mechanics: ['timer'], addons: ['shoot', 'chaser'], abilities: ALL_ABILITIES }),
  move_free: arcade({
    setting: true,
    cues: 'agar.io, eat smaller, grow',
    roles: ['hunter', 'coin'],
    finish: false,
    note: 'archetype survival_timer; timer onEnd lose = outgrow in time, win = survive 20-80 s',
    labels: [],
    mechanics: LIVES_AND_TIMER,
    addons: ['shoot', 'chaser', 'lives'],
  }),
  // P39 T14: terč střelnice nese věc z věty (mince, duch) a kreslí se jejím modelem.
  shooter: arcade({ setting: true, counts: true, cues: 'tap = shoot', roles: ['enemy'], finish: false, note: 'archetype combat_lite', labels: ['player', 'enemy', 'target'], mechanics: LIVES_AND_TIMER }),
  throw: arcade({ setting: true, cues: 'hold, release', roles: ['target'], finish: false, note: 'archetype combat_lite', labels: ['player', 'target'], mechanics: ['timer'] }),
  // P27A T4: načasování, rytmus a souboj kreslí kulisy za hrací plochou; soupeř souboje a závodu nese model z popisku.
  // P30B T4: díl věže („pancakes“), nota rytmu („lily pads“) a mantinel závodu („crocodiles“) taky.
  timing: arcade({ setting: true, cues: 'stack, stop the bar', roles: ['block', 'miss'], finish: false, labels: ['block'], mechanics: LIVES_AND_TIMER }),
  rhythm: arcade({ setting: true, cues: 'tap on the beat', roles: ['note', 'miss'], finish: false, labels: ['player', 'note'], mechanics: LIVES_AND_TIMER }),
  duel: arcade({ setting: true, cues: 'fight, boxing', roles: ['rival'], finish: false, labels: ['player', 'rival'], mechanics: LIVES_AND_TIMER }),
};

export const controlOf = (spec: Pick<GameSpecV1, 'control'>): ControlId => spec.control ?? 'tap_go';

/** Čte vykreslení popisek téhle role? */
export function readsLabel(control: ControlId, role: Pick<GameRole, 'id' | 'kind'>): boolean {
  const { labels } = CAPABILITIES[control];
  if (labels === 'all') return true;
  if (role.kind === 'player') return labels.includes('player');
  return (labels as readonly string[]).includes(role.id);
}

/**
 * Generátory režimů žánru, které čtou mechaniku navíc proti svému ovládání:
 * plavba (`steer`) bere životy, závod `steer_track` ne (P36A T2).
 */
const GENERATOR_MECHANICS: Readonly<Record<string, readonly MechanicId[]>> = {
  voyage_race: ['health'],
  voyage_land: ['health'],
};

/** Čte kompilátor tuhle mechaniku? `generator` = `controlParams.generator` hry žánru. */
export function readsMechanic(control: ControlId, id: string, generator?: string): boolean {
  const { mechanics } = CAPABILITIES[control];
  if (mechanics === 'all' || (mechanics as readonly string[]).includes(id)) return true;
  return generator !== undefined && Object.hasOwn(GENERATOR_MECHANICS, generator) && (GENERATOR_MECHANICS[generator] as readonly string[]).includes(id);
}

/** Generátor režimu, který spec deleguje (`controlParams.generator`), nebo `undefined`. */
export const generatorOfSpec = (spec: Pick<GameSpecV1, 'controlParams'>): string | undefined => {
  const generator = (spec.controlParams as { readonly generator?: unknown } | undefined)?.generator;
  return typeof generator === 'string' ? generator : undefined;
};

/** Položka specu, kterou ovládání nepoužije. */
export interface UnreadItem {
  readonly path: string;
  readonly kind: 'mechanic' | 'label';
  readonly what: string;
}

/** Co spec nese a hra z toho nic neukáže – vstup kritika. */
export function unreadItems(spec: Pick<GameSpecV1, 'control' | 'mechanics' | 'roles'> & Partial<Pick<GameSpecV1, 'controlParams'>>): UnreadItem[] {
  const control = controlOf(spec);
  const generator = generatorOfSpec(spec);
  const items: UnreadItem[] = [];
  spec.mechanics.forEach((mechanic, index) => {
    if (!readsMechanic(control, mechanic.id, generator)) items.push({ path: `/mechanics/${String(index)}`, kind: 'mechanic', what: mechanic.id });
  });
  spec.roles.forEach((role, index) => {
    if (!readsLabel(control, role)) items.push({ path: `/roles/${String(index)}/label`, kind: 'label', what: role.label });
  });
  return items;
}
