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
  /** Akce hrdiny (P46A), které ovládání bere; matice s důvody u `ALL_ABILITIES`. */
  readonly abilities: readonly AbilityId[];
}

const LIVES_AND_TIMER: readonly MechanicId[] = ['health', 'timer'];

/** Doplňky ovládání s tratí k cíli: běh, skákání, poletování (aréna sbírá už sama – potrava). */
const ROAMING: readonly AddonId[] = ['shoot', 'collect', 'lives'];

/*
 * Všech 5 akcí: běžec, skákačka a řízení (P46A T3–T6), poletování a klouzání (P46A T9, dash a štít P47B T9).
 * Každou dvojici měří `ability-matrix.test.ts` (robot akci zmáčkne a ověření dokáže sloveso na 4 semínkách).
 * Dash a štít letu: nepřítel v mezeře trubek (obruči) křižuje dráhu, trubky ani útes se nepočítají – robot jimi
 * proletí. Štít poletování dostane jen každého druhého (`guardAbility`), robot poletování výšku k dotyku nesrovnává
 * a trubky nehlídá.
 * Co ostatním ovládáním chybí, má důvod:
 * - walker: všech 5 jen v bludišti (P52 T5 úder, T6 dash, štít a střelba – nepřátelé na cestě ke východu,
 *   `walkerFoeCells`; střela letí směrem chůze), v plížení jen krádež (strážný nebo věc, `generatorTakes`);
 *   v útěku bludištěm robot pronásledovatele do dosahu nepustí (dash, štít VERB_UNPROVED 4/4).
 * - move_free: střelba jen v chytání (P52 T7b, včely na cestě ke kořisti, kterou střela nesebere), jinde zůstává
 *   doplňkem `+shoot` (akce střelby tam sloveso nedokáže, `generatorTakes`); dash a štít
 *   v útěku, kde pronásledovatel chytá (`arena_eat` s `grace`), a v souboji (`fight`, P47B T6), kde
 *   berou úder soupeře – souboj jen je (`FIGHT_ABILITIES`): úder má vlastní Attack a krást není co.
 *   Quest (`quest_spatial`, P52 T5) jen úder: robot s ním dojde k pronásledovateli. Sběr se dvěma akcemi
 *   na pronásledovatele přivede o jednoho víc (`sharedChasers`). Agar takovou hru odmítne a rychlá verze akci zahodí.
 * - shooter, ball (P52 T7): hrdina stojí, střílí vlastní mechanikou a nikam nedojde – štít bere střelu soupeře a krádež
 *   kořist, které k němu zepředu přiletí, jen dokud hra jistě běží (`withIncoming`); míč jen štít (`generatorTakes`).
 * - throw, timing, rhythm: tlačítko je samo mechanika (hod, stop, nota), druhé by s ním soupeřilo.
 * - duel: všech 5 hraje vlastní mechanika duelu (Tap úder, Down úhyb za dash i štít), žádné druhé tlačítko –
 *   akce dá jen sloveso pravidlům (P47B T8). Střelba a krádež (P52 T8) jsou sloveso zásahu soupeře jako úder:
 *   „duels the sheriff, firing a ray gun“ je přestřelka za poledne, „duels a rival to snatch the ticket“ souboj
 *   o věc – žánr zůstane duelem, který věta řekla. tap_go: mřížka bez hrdiny s fyzikou arkády.
 */
const ALL_ABILITIES: readonly AbilityId[] = ['shoot', 'strike', 'dash', 'shield', 'grab'];

/** Akce zásahu soupeře v duelu v pořadí přednosti: úder je vlastní mechanika duelu, střelba a krádež jen jeho sloveso (P52 T8). */
export const DUEL_HITS = ['strike', 'shoot', 'grab'] as const;

/** Akce, kterou v duelu nese zásah soupeře: první z `DUEL_HITS`, kterou hra má. Ostatní zásahy duel nebere (`withAbilities`). */
export const duelHitOf = (ids: readonly AbilityId[]): (typeof DUEL_HITS)[number] | undefined => DUEL_HITS.find((id) => ids.includes(id));

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
  glide: arcade({ setting: true, cues: 'swim or fly in three dimensions', roles: ['glide_ring', 'glide_reef'], finish: true, labels: ['player', 'enemy', 'finish', 'glide_rival', 'glide_pursuer'], mechanics: ['timer'], addons: ['shoot'], abilities: ALL_ABILITIES }),
  walker: arcade({ setting: true, cues: 'walk through a maze', roles: ['wall', 'coin', 'guard', 'chaser'], finish: true, labels: ['player', 'coin', 'finish', 'guard', 'chaser'], mechanics: ['health', 'timer'], addons: ['lives'], abilities: ALL_ABILITIES }),
  ball: arcade({ setting: true, cues: 'aim and shoot a ball', roles: ['target', 'goalkeeper'], finish: true, labels: ['player', 'goalkeeper'], mechanics: ['timer'], addons: [], abilities: ['shield'] }),
  tap_go: { cues: 'tap-to-move grid', roles: [], finish: false, labels: 'all', mechanics: 'all', counts: true, setting: true, maxRoles: 12, addons: [], abilities: [] },
  // P26D T9: počty od 2 čte generátor – běžec mince a řady překážek, plošinovka a poletování mince, střelnice terče a nepřátele.
  runner: arcade({ setting: true, counts: true, cues: 'endless runner, subway surfers', roles: ['obstacle', 'coin'], finish: true, labels: ['player', 'obstacle', 'coin'], mechanics: LIVES_AND_TIMER, addons: [...ROAMING, 'chaser'], abilities: ALL_ABILITIES }),
  // P35 T3: cíl na konci úrovně kreslí model z popisku („moon“, „battery“), jinak vlajku.
  platform: arcade({ setting: true, counts: true, cues: 'platformer, mario, obby', roles: ['spikes', 'coin'], finish: true, labels: ['player', 'coin', 'finish', 'spikes'], mechanics: LIVES_AND_TIMER, addons: [...ROAMING, 'chaser'], abilities: ALL_ABILITIES }),
  flap: arcade({ setting: true, counts: true, cues: 'flappy bird, pipe gaps', roles: ['pipe', 'coin'], finish: true, labels: ['player', 'coin', 'pipe'], mechanics: LIVES_AND_TIMER, addons: ROAMING, abilities: ALL_ABILITIES }),
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
    abilities: ALL_ABILITIES,
  }),
  // P39 T14: terč střelnice nese věc z věty (mince, duch) a kreslí se jejím modelem.
  shooter: arcade({ setting: true, counts: true, cues: 'tap = shoot', roles: ['enemy'], finish: false, note: 'archetype combat_lite', labels: ['player', 'enemy', 'target'], mechanics: LIVES_AND_TIMER, abilities: ['grab', 'shield'] }),
  throw: arcade({ setting: true, cues: 'hold, release', roles: ['target'], finish: false, note: 'archetype combat_lite', labels: ['player', 'target'], mechanics: ['timer'] }),
  // P27A T4: načasování, rytmus a souboj kreslí kulisy za hrací plochou; soupeř souboje a závodu nese model z popisku.
  // P30B T4: díl věže („pancakes“), nota rytmu („lily pads“) a mantinel závodu („crocodiles“) taky.
  timing: arcade({ setting: true, cues: 'stack, stop the bar', roles: ['block', 'miss'], finish: false, labels: ['block'], mechanics: LIVES_AND_TIMER }),
  rhythm: arcade({ setting: true, cues: 'tap on the beat', roles: ['note', 'miss'], finish: false, labels: ['player', 'note'], mechanics: LIVES_AND_TIMER }),
  duel: arcade({ setting: true, cues: 'fight, boxing', roles: ['rival'], finish: false, labels: ['player', 'rival'], mechanics: LIVES_AND_TIMER, abilities: ALL_ABILITIES }),
  // P54C T4: ovládání nových žánrů ještě nemají svět, takže nic nečtou; co jeho svět čte, doplní úloha žánru.
  // T5 chytání: padající věc (`coin`) a bomba (`hazard`) nesou model z popisku, životy berou bomby a propadlé ovoce, scéna kreslí sadu prostředí.
  lanes: arcade({ setting: true, cues: 'five lanes: catch falling things, whack moles, slice fruit, defend the lanes', roles: ['coin', 'hazard'], finish: false, labels: ['player', 'coin', 'hazard'], mechanics: LIVES_AND_TIMER }),
  hop: arcade({ cues: 'hop across busy lanes, crossy road, frogger', roles: [], finish: false, labels: [], mechanics: [] }),
  crowd: arcade({ cues: 'grow a crowd through gates, count masters', roles: [], finish: false, labels: [], mechanics: [] }),
  merge: arcade({ cues: 'drop and merge, suika, 2048', roles: [], finish: false, labels: [], mechanics: [] }),
  push: arcade({ cues: 'push rivals out of the ring, sumo', roles: [], finish: false, labels: [], mechanics: [] }),
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
