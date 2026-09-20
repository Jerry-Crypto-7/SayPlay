/**
 * Čipy „CHANGE ONE THING" (P23-C) – **lokální dvojník remixu z P23-B**.
 *
 * Skutečný remix napíše model jako `remixPatch`; P23-D ho sem přepne. Do té
 * doby jsou čipy deterministické úpravy specu **jen přes pole schématu** –
 * žádný text pro model, žádná náhoda: týž rodič, týž čip a týž seed dají
 * bajtově týž spec, a proto i tutéž verzi (druhý klik na čip je `exists`).
 *
 * Výsledek se nevaliduje tady – route ho pošle přes `readGameSpec` jako
 * cokoli jiného od cizího, takže chyba v čipu je 422, ne pád.
 */

import { ARCHETYPES, type MechanicId } from '../registry';
import type { GameMechanic, GameRole, GameSpecV1 } from '../spec';

export const CHIPS = ['harder', 'twist', 'swap_enemy', 'reskin'] as const;
export type Chip = (typeof CHIPS)[number];

/** Text čipu na stránce, doslova z `docs/play/pack/PRODUCT_COPY.md`. */
export const CHIP_LABELS: Readonly<Record<Chip, string>> = {
  harder: 'Make it harder',
  twist: 'Add a twist',
  swap_enemy: 'Swap the enemy',
  reskin: 'Change the world, keep the rules',
};

const TITLE_MAX = 80;
const COUNT_MAX = 50;
const COLLECTIBLE_MAX = 20;
const SECONDS_MIN = 5;

const SPEEDS = ['slow', 'normal', 'fast'] as const;
const DISPOSITIONS = ['bold', 'wary', 'restless'] as const;

const ENEMY_LABELS = ['shadow wolf', 'rusty drone', 'angry goose', 'clockwork spider', 'runaway shopping cart'] as const;

const SETTINGS: readonly (readonly [string, string])[] = [
  ['abandoned space station', 'eerie'],
  ['sunlit rooftop garden', 'cheerful'],
  ['flooded subway tunnel', 'tense'],
  ['candy factory floor', 'playful'],
  ['frozen harbour at dawn', 'quiet'],
];

/** Titulek s příponou, oříznutý zleva tak, aby přípona zůstala celá. */
function retitle(title: string, suffix: string): string {
  return `${title.slice(0, TITLE_MAX - suffix.length)}${suffix}`;
}

function pick<T>(list: readonly T[], seed: number, avoid?: T): T {
  const candidates = list.filter((item) => item !== avoid);
  return candidates[seed % candidates.length];
}

function withParams(mechanic: GameMechanic, patch: Record<string, unknown>): GameMechanic {
  return { ...mechanic, params: { ...mechanic.params, ...patch } };
}

/** Rychlejší pronásledovatel, kratší čas, víc k sesbírání; bez ničeho z toho kratší hra. */
function harder(spec: GameSpecV1): GameSpecV1 {
  let changed = false;
  let objective = spec.objective;
  let roles = spec.roles;
  const mechanics = spec.mechanics.map((mechanic) => {
    if (mechanic.id === 'chaser') {
      const speed = mechanic.params.speed as (typeof SPEEDS)[number];
      if (speed === 'fast') return mechanic;
      changed = true;
      return withParams(mechanic, { speed: SPEEDS[SPEEDS.indexOf(speed) + 1] });
    }
    if (mechanic.id === 'timer') {
      const seconds = Math.max(SECONDS_MIN, Math.round((mechanic.params.seconds as number) * 0.8));
      if (seconds === mechanic.params.seconds) return mechanic;
      changed = true;
      if (objective.kind === 'survive') objective = { ...objective, seconds: Math.max(SECONDS_MIN, seconds) };
      return withParams(mechanic, { seconds });
    }
    if (mechanic.id === 'collectible') {
      const count = Math.min(COLLECTIBLE_MAX, (mechanic.params.count as number) + 2);
      if (count === mechanic.params.count) return mechanic;
      changed = true;
      const role = mechanic.params.role as string;
      roles = roles.map((entry) => (entry.id === role ? { ...entry, count: Math.min(COUNT_MAX, count) } : entry));
      if (objective.kind === 'collect' && objective.role === role) objective = { ...objective, count };
      return withParams(mechanic, { count });
    }
    return mechanic;
  });
  const targetDurationSec = changed ? spec.targetDurationSec : Math.max(30, Math.round(spec.targetDurationSec * 0.8));
  return { ...spec, title: retitle(spec.title, ' – harder'), mechanics, roles, objective, targetDurationSec };
}

/** Koření bez odkazu na roli, s výchozími parametry a jedním keypointem, který ho dokazuje. */
const TWISTS: readonly { readonly id: MechanicId; readonly params: Record<string, unknown>; readonly proof: GameSpecV1['verification'][number] }[] = [
  {
    id: 'timer',
    params: { id: 'twist_clock', seconds: 60, onEnd: 'lose' },
    proof: { id: 'twist_timer', kind: 'keypoint', mechanic: 'timer', ticks: 60 * 20 + 1, assert: { runState: 'lost', firedMechanics: ['timer'] } },
  },
  {
    id: 'health',
    params: { max: 3 },
    proof: { id: 'twist_health', kind: 'keypoint', mechanic: 'health', ticks: 0, assert: { runState: 'running' } },
  },
  {
    id: 'counter',
    params: { id: 'twist_count', min: 0, max: 10, initial: 0 },
    proof: { id: 'twist_counter', kind: 'keypoint', mechanic: 'counter', ticks: 0, assert: { counters: { twist_count: 0 } } },
  },
];

function twist(spec: GameSpecV1): GameSpecV1 {
  const present = new Set(spec.mechanics.map((mechanic) => mechanic.id));
  const allowed = ARCHETYPES[spec.archetype].allowedMechanics;
  const added = TWISTS.find((entry) => allowed.includes(entry.id) && !present.has(entry.id));
  // Všechno koření už tam je – jediná další změna přes pole schématu je čas.
  if (added === undefined) return harder(spec);
  return {
    ...spec,
    title: retitle(spec.title, ' – with a twist'),
    mechanics: [...spec.mechanics, { id: added.id, params: added.params }],
    verification: [...spec.verification, added.proof],
  };
}

/** Jiné jméno a povaha nepřítele; hra bez nepřítele zpřísní místo toho. */
function swapEnemy(spec: GameSpecV1, seed: number): GameSpecV1 {
  const enemy = spec.roles.find((role) => role.kind === 'chaser' || role.kind === 'patrol');
  if (enemy === undefined) return harder(spec);
  const label = pick(ENEMY_LABELS, seed, enemy.label as (typeof ENEMY_LABELS)[number]);
  const roles: GameRole[] = spec.roles.map((role) => (role.id === enemy.id ? { ...role, label } : role));
  const mechanics = spec.mechanics.map((mechanic) => {
    if (mechanic.id !== 'patrol' || mechanic.params.role !== enemy.id) return mechanic;
    const disposition = pick(DISPOSITIONS, seed, mechanic.params.disposition as (typeof DISPOSITIONS)[number]);
    return withParams(mechanic, { disposition });
  });
  return { ...spec, title: retitle(spec.title, ` – vs. ${label}`), roles, mechanics };
}

/** Jiné místo a nálada, tatáž pravidla. */
function reskin(spec: GameSpecV1, seed: number): GameSpecV1 {
  const [setting, mood] = pick(SETTINGS, seed, SETTINGS.find(([name]) => name === spec.theme.setting));
  return { ...spec, title: retitle(spec.title, ` – ${setting}`), theme: { setting, mood } };
}

export function applyChip(parent: GameSpecV1, chip: Chip, seed: number): GameSpecV1 {
  switch (chip) {
    case 'harder':
      return harder(parent);
    case 'twist':
      return twist(parent);
    case 'swap_enemy':
      return swapEnemy(parent, seed);
    case 'reskin':
      return reskin(parent, seed);
  }
}
