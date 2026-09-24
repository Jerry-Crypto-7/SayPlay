/**
 * Tabulka schopností ovládání (P26 T5) – jediný zdroj pravdy o tom, co hra
 * z GameSpecu **opravdu použije**. Pravidlo P26: co AI napíše, musí být vidět
 * nebo hrát, jinak to napsat nesmí.
 *
 * Z tabulky se vyrábí:
 * 1. řádek ovládání v zadání modelu (`controlPromptLine` v `director/prompt.ts`);
 * 2. kontrola kritika – položka, kterou ovládání nečte, je nález, ne tiché zahození;
 * 3. věrnost ve specifikaci v sadě `evals/play/fidelity` (`scripts/play-fidelity.mjs`).
 *
 * Každou buňku „čte“ drží test `__tests__/capabilities.test.ts`: změna položky
 * změní svět (hash) nebo model, který vykreslení zvolí; buňka „nečte“ naopak nic.
 *
 * Soubor má jen typové importy – skript sady věrnosti ho načítá holým Nodem.
 */

import type { MechanicId } from './registry';
import type { AddonId, ControlId, GameRole, GameSpecV1 } from './spec';

export interface ControlCapability {
  /** Narážky, podle kterých model ovládání pozná (žánr, známé hry). */
  readonly cues: string;
  /** Id rolí, které jádro kromě `player` a `finish` zná – jen popisek do obálky, pokud je nečte `labels`. */
  readonly roles: readonly string[];
  /** Vyhrává se dojetím do role `finish`. */
  readonly finish: boolean;
  /** Co model musí dodržet navíc (archetyp, cíl). */
  readonly note?: string;
  /** Popisky rolí, podle kterých vykreslení volí model: `'all'`, nebo role hráče a id rolí (`enemy`, `coin`, `obstacle`, `target` – P26 T12). */
  readonly labels: 'all' | readonly ('player' | 'enemy' | 'coin' | 'obstacle' | 'target')[];
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
}

const LIVES_AND_TIMER: readonly MechanicId[] = ['health', 'timer'];

/** Doplňky ovládání s tratí k cíli: běh, skákání, poletování (aréna sbírá už sama – potrava). */
const ROAMING: readonly AddonId[] = ['shoot', 'collect', 'lives'];

const arcade = (
  entry: Omit<ControlCapability, 'counts' | 'setting' | 'maxRoles' | 'addons'> & { readonly setting?: boolean; readonly addons?: readonly AddonId[] },
): ControlCapability => ({
  ...entry,
  counts: false,
  setting: entry.setting ?? false,
  maxRoles: 1 + (entry.finish ? 1 : 0) + entry.roles.length,
  // Životy jen tam, kde ovládání čte `health` – jinak by doplněk nic neubral.
  addons: entry.addons ?? (entry.mechanics === 'all' || entry.mechanics.includes('health') ? ['lives'] : []),
});

export const CAPABILITIES: Readonly<Record<ControlId, ControlCapability>> = {
  tap_go: { cues: 'tap-to-move grid', roles: [], finish: false, labels: 'all', mechanics: 'all', counts: true, setting: true, maxRoles: 12, addons: [] },
  runner: arcade({ setting: true, cues: 'endless runner, subway surfers', roles: ['obstacle', 'coin'], finish: true, labels: ['player', 'obstacle', 'coin'], mechanics: LIVES_AND_TIMER, addons: [...ROAMING, 'chaser'] }),
  platform: arcade({ setting: true, cues: 'platformer, mario, obby', roles: ['spikes', 'coin'], finish: true, labels: ['player', 'coin'], mechanics: LIVES_AND_TIMER, addons: [...ROAMING, 'chaser'] }),
  flap: arcade({ setting: true, cues: 'flappy bird, pipe gaps', roles: ['pipe', 'coin'], finish: true, labels: ['player', 'coin'], mechanics: LIVES_AND_TIMER, addons: ROAMING }),
  steer: arcade({ cues: 'racing, fly a plane', roles: ['barrier', 'rival', 'turbo'], finish: true, labels: ['player'], mechanics: ['timer'] }),
  move_free: arcade({
    cues: 'agar.io, eat smaller, grow',
    roles: ['hunter', 'coin'],
    finish: false,
    note: 'archetype survival_timer; timer onEnd lose = outgrow in time, win = survive 20-80 s',
    labels: [],
    mechanics: LIVES_AND_TIMER,
    addons: ['shoot', 'chaser', 'lives'],
  }),
  shooter: arcade({ setting: true, cues: 'tap = shoot', roles: ['enemy'], finish: false, note: 'archetype combat_lite', labels: ['player', 'enemy'], mechanics: LIVES_AND_TIMER }),
  throw: arcade({ setting: true, cues: 'hold, release', roles: ['target'], finish: false, note: 'archetype combat_lite', labels: ['player', 'target'], mechanics: ['timer'] }),
  timing: arcade({ cues: 'stack, stop the bar', roles: ['block', 'miss'], finish: false, labels: [], mechanics: LIVES_AND_TIMER }),
  rhythm: arcade({ cues: 'tap on the beat', roles: ['note', 'miss'], finish: false, labels: [], mechanics: LIVES_AND_TIMER }),
  duel: arcade({ cues: 'fight, boxing', roles: ['rival'], finish: false, labels: [], mechanics: LIVES_AND_TIMER }),
};

export const controlOf = (spec: Pick<GameSpecV1, 'control'>): ControlId => spec.control ?? 'tap_go';

/** Čte vykreslení popisek téhle role? */
export function readsLabel(control: ControlId, role: Pick<GameRole, 'id' | 'kind'>): boolean {
  const { labels } = CAPABILITIES[control];
  if (labels === 'all') return true;
  if (role.kind === 'player') return labels.includes('player');
  return (labels as readonly string[]).includes(role.id);
}

/** Čte kompilátor tuhle mechaniku? */
export function readsMechanic(control: ControlId, id: string): boolean {
  const { mechanics } = CAPABILITIES[control];
  return mechanics === 'all' || (mechanics as readonly string[]).includes(id);
}

/** Položka specu, kterou ovládání nepoužije. */
export interface UnreadItem {
  readonly path: string;
  readonly kind: 'mechanic' | 'label';
  readonly what: string;
}

/** Co spec nese a hra z toho nic neukáže – vstup kritika. */
export function unreadItems(spec: Pick<GameSpecV1, 'control' | 'mechanics' | 'roles'>): UnreadItem[] {
  const control = controlOf(spec);
  const items: UnreadItem[] = [];
  spec.mechanics.forEach((mechanic, index) => {
    if (!readsMechanic(control, mechanic.id)) items.push({ path: `/mechanics/${String(index)}`, kind: 'mechanic', what: mechanic.id });
  });
  spec.roles.forEach((role, index) => {
    if (!readsLabel(control, role)) items.push({ path: `/roles/${String(index)}/label`, kind: 'label', what: role.label });
  });
  return items;
}
