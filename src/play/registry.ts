/**
 * Registr archetypů a mechanik (P23).
 *
 * Každá mechanika říká čtyři věci najednou: **jak vypadají její parametry**
 * (zod), **na které role odkazuje** (aby `readGameSpec` odhalil osiřelý
 * odkaz), **co z runtimu potřebuje** (povrchové události a akce z
 * `src/ir/types.ts` – kompilátor nesmí sáhnout na nic mimo tento seznam)
 * a **kolik stojí** (entity a pravidla, aby rozpočet šel spočítat před
 * kompilací, ne až po ní).
 *
 * Registr je uzavřený: mechanika, která tu není, neexistuje. Projektil,
 * skok a pohyblivá plošina tu chybějí schválně – runtime je mřížkový a hráč
 * se hýbe příkazem na soket; tyhle tři by chtěly jiný tik, a to je mimo P23.
 *
 * Kompilační a verifikační adaptéry se **registrují zvenčí** (`src/play/compile`,
 * `src/play/verify`), aby tento soubor nezávisel na ničem z kompilátoru
 * a mohl ho importovat i model (`src/play/director`) a klient.
 */

import { z } from 'zod';

import { ID_PATTERN, type SurfaceEventName } from '@/ir/types';

const roleRef = z.string().regex(ID_PATTERN);
const seconds = z.int().min(1).max(180);
const smallCount = z.int().min(1).max(12);

/** Povrchové akce, které kompilátor smí vydat. Tentýž slovník jako `lowerAction`. */
export const RUNTIME_ACTIONS = [
  'setState',
  'setLocked',
  'setFlag',
  'addCounter',
  'startTimer',
  'stopTimer',
  'spawn',
  'despawn',
  'moveTo',
  'freeze',
  'giveItem',
  'takeItem',
  'emit',
  'playEffect',
  'win',
  'lose',
] as const;
export type RuntimeAction = (typeof RUNTIME_ACTIONS)[number];

export interface RuntimeCapabilities {
  readonly events: readonly SurfaceEventName[];
  readonly actions: readonly RuntimeAction[];
  /** Mechanika potřebuje mysl postavy (`sim.state.agents`). */
  readonly agents?: true;
}

export interface MechanicCost {
  readonly entities: number;
  readonly rules: number;
}

export interface MechanicEntry<P = unknown> {
  /** Shodné s klíčem v `MECHANICS`; test to drží. */
  readonly id: string;
  readonly params: z.ZodType<P>;
  /** Dvojice `[jméno pole, ID role]` pro každý odkaz na roli v parametrech. */
  readonly roleRefs: (params: P) => readonly (readonly [string, string])[];
  readonly capabilities: RuntimeCapabilities;
  readonly cost: (params: P, roleCount: (roleId: string) => number) => MechanicCost;
  /** Jedna anglická věta pro hráče a pro kritika: co mechanika dělá. */
  readonly explanation: string;
}

function entry<P>(definition: MechanicEntry<P>): MechanicEntry<P> {
  return definition;
}

const collectibleParams = z
  .object({ role: roleRef, count: z.int().min(1).max(20), counter: roleRef.default('collected') })
  .strict();
const counterParams = z
  .object({ id: roleRef, min: z.int().min(0).max(999), max: z.int().min(1).max(999), initial: z.int().min(0).max(999) })
  .strict();
const timerParams = z
  .object({ id: roleRef, seconds, onEnd: z.enum(['win', 'lose', 'signal']), signal: roleRef.optional() })
  .strict();
const zoneTriggerParams = z
  .object({ role: roleRef, when: z.enum(['enter', 'exit']), effect: z.enum(['win', 'lose', 'signal']), signal: roleRef.optional() })
  .strict();
const checkpointParams = z.object({ role: roleRef, count: z.int().min(2).max(8), ordered: z.boolean() }).strict();
const lockKeyParams = z.object({ keyRole: roleRef, doorRole: roleRef, keysNeeded: z.int().min(1).max(10) }).strict();
const switchParams = z
  .object({
    switchRoles: z.array(roleRef).min(1).max(6),
    doorRole: roleRef,
    /** Spínače, které musí být `on`; ostatní z `switchRoles` musí zůstat `off`. */
    required: z.array(roleRef).min(1).max(6),
  })
  .strict();
const hazardZoneParams = z
  .object({
    role: roleRef,
    effect: z.enum(['lose', 'damage']),
    /** Pulzování: `onSeconds` aktivní, `offSeconds` bezpečná. Bez toho je nebezpečí stálé. */
    pulse: z.object({ onSeconds: seconds, offSeconds: seconds }).strict().optional(),
  })
  .strict();
const chaserParams = z
  .object({
    role: roleRef,
    /** Tiky na jedno pole – `slow` 12, `normal` 8, `fast` 5. */
    speed: z.enum(['slow', 'normal', 'fast']),
    catchEffect: z.enum(['lose', 'damage']),
  })
  .strict();
const patrolParams = z
  .object({
    role: roleRef,
    disposition: z.enum(['bold', 'wary', 'restless']),
    stops: z.int().min(3).max(6),
    touchEffect: z.enum(['lose', 'damage', 'none']),
  })
  .strict();
const carryParams = z.object({ itemRole: roleRef, destinationRole: roleRef, fragile: z.boolean() }).strict();
const stunParams = z
  .object({ targetRole: roleRef, seconds: z.int().min(1).max(10), uses: z.int().min(0).max(10) })
  .strict();
const spawnWaveParams = z
  .object({ role: roleRef, poolSize: smallCount, everySeconds: z.int().min(3).max(60), maxAlive: smallCount })
  .strict();
const propertyTransformParams = z
  .object({
    role: roleRef,
    from: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/),
    to: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/),
    trigger: z.enum(['use', 'signal', 'timer']),
    signal: roleRef.optional(),
  })
  .strict();
const healthParams = z.object({ max: z.int().min(1).max(5) }).strict();
const defeatParams = z.object({ role: roleRef, count: z.int().min(1).max(12), hitsPerTarget: z.int().min(1).max(3) }).strict();

export const MECHANICS = {
  collectible: entry({
    id: 'collectible',
    params: collectibleParams,
    roleRefs: (p) => [['role', p.role]],
    capabilities: { events: ['onPickup', 'onCounterReaches'], actions: ['addCounter', 'emit'] },
    cost: (p) => ({ entities: p.count, rules: 2 }),
    explanation: 'Picking up an item of this role advances a counter.',
  }),
  counter: entry({
    id: 'counter',
    params: counterParams,
    roleRefs: () => [],
    capabilities: { events: ['onCounterReaches'], actions: ['addCounter'] },
    cost: () => ({ entities: 0, rules: 1 }),
    explanation: 'A bounded number the game tracks.',
  }),
  timer: entry({
    id: 'timer',
    params: timerParams,
    roleRefs: () => [],
    capabilities: { events: ['onStart', 'onTimerEnd'], actions: ['startTimer', 'win', 'lose', 'emit'] },
    cost: () => ({ entities: 0, rules: 2 }),
    explanation: 'A countdown that ends the game or fires a signal.',
  }),
  zone_trigger: entry({
    id: 'zone_trigger',
    params: zoneTriggerParams,
    roleRefs: (p) => [['role', p.role]],
    capabilities: { events: ['onEnterZone', 'onExitZone'], actions: ['win', 'lose', 'emit'] },
    cost: (p, count) => ({ entities: count(p.role), rules: count(p.role) }),
    explanation: 'Entering or leaving a zone wins, loses or signals.',
  }),
  checkpoint: entry({
    id: 'checkpoint',
    params: checkpointParams,
    roleRefs: (p) => [['role', p.role]],
    capabilities: { events: ['onEnterZone', 'onCounterReaches'], actions: ['addCounter', 'setState', 'win'] },
    cost: (p) => ({ entities: p.count, rules: p.count + 1 }),
    explanation: 'Pass through checkpoints, in order when required.',
  }),
  lock_key: entry({
    id: 'lock_key',
    params: lockKeyParams,
    roleRefs: (p) => [
      ['keyRole', p.keyRole],
      ['doorRole', p.doorRole],
    ],
    capabilities: { events: ['onPickup', 'onCounterReaches'], actions: ['addCounter', 'setLocked', 'setState'] },
    cost: (p) => ({ entities: p.keysNeeded + 1, rules: 2 }),
    explanation: 'Collecting enough keys unlocks a door.',
  }),
  switch: entry({
    id: 'switch',
    params: switchParams,
    roleRefs: (p) => [...p.switchRoles.map((role) => ['switchRoles', role] as const), ['doorRole', p.doorRole] as const],
    capabilities: { events: ['onAction', 'onStateEnter'], actions: ['setState', 'setLocked', 'setFlag'] },
    cost: (p) => ({ entities: p.switchRoles.length + 1, rules: p.switchRoles.length * 2 + 1 }),
    explanation: 'Using switches toggles them; the right combination opens the door.',
  }),
  hazard_zone: entry({
    id: 'hazard_zone',
    params: hazardZoneParams,
    roleRefs: (p) => [['role', p.role]],
    capabilities: { events: ['onEnterZone', 'onTimerEnd', 'onStart'], actions: ['lose', 'addCounter', 'setState', 'startTimer'] },
    cost: (p, count) => ({ entities: count(p.role), rules: count(p.role) + (p.pulse ? 3 : 0) }),
    explanation: 'Standing in a hazard hurts or ends the run; hazards may pulse on and off.',
  }),
  chaser: entry({
    id: 'chaser',
    params: chaserParams,
    roleRefs: (p) => [['role', p.role]],
    capabilities: { events: ['onSeen', 'onCollide', 'onEnterZone'], actions: ['moveTo', 'lose', 'addCounter'] },
    /** Jedno pravidlo pohybu na zónu, ve které může hráč stát; kompilátor je vyrábí, strop drží rozpočet. */
    cost: (p, count) => ({ entities: count(p.role), rules: 12 * count(p.role) + 1 }),
    explanation: 'A pursuer heads for the player whenever it sees them; touching it hurts.',
  }),
  patrol: entry({
    id: 'patrol',
    params: patrolParams,
    roleRefs: (p) => [['role', p.role]],
    capabilities: { events: ['onCollide', 'onEnterZone'], actions: ['moveTo', 'lose', 'addCounter'], agents: true },
    cost: (p, count) => ({ entities: count(p.role), rules: count(p.role) * (p.stops * 3 + 1) }),
    explanation: 'A character walks a fixed route; its temperament decides how.',
  }),
  carry: entry({
    id: 'carry',
    params: carryParams,
    roleRefs: (p) => [
      ['itemRole', p.itemRole],
      ['destinationRole', p.destinationRole],
    ],
    capabilities: { events: ['onPickup', 'onDrop', 'onEnterZone', 'onCollide'], actions: ['giveItem', 'takeItem', 'win', 'lose'] },
    cost: (p) => ({ entities: 2, rules: p.fragile ? 4 : 3 }),
    explanation: 'Pick up an item and bring it to the destination; a fragile one breaks on contact.',
  }),
  stun: entry({
    id: 'stun',
    params: stunParams,
    roleRefs: (p) => [['targetRole', p.targetRole]],
    capabilities: { events: ['onAction'], actions: ['freeze', 'addCounter'] },
    cost: () => ({ entities: 0, rules: 2 }),
    explanation: 'Using the target while next to it freezes it for a while.',
  }),
  spawn_wave: entry({
    id: 'spawn_wave',
    params: spawnWaveParams,
    roleRefs: (p) => [['role', p.role]],
    capabilities: { events: ['onStart', 'onTimerEnd'], actions: ['spawn', 'startTimer'] },
    cost: (p) => ({ entities: p.poolSize, rules: 3 }),
    explanation: 'New things of this role appear on a schedule from a bounded pool.',
  }),
  property_transform: entry({
    id: 'property_transform',
    params: propertyTransformParams,
    roleRefs: (p) => [['role', p.role]],
    capabilities: { events: ['onAction', 'onSignal', 'onTimerEnd'], actions: ['setState'] },
    cost: (p, count) => ({ entities: 0, rules: count(p.role) }),
    explanation: 'Something changes its state when used, signalled or timed.',
  }),
  health: entry({
    id: 'health',
    params: healthParams,
    roleRefs: () => [],
    capabilities: { events: ['onCounterReaches'], actions: ['addCounter', 'lose'] },
    cost: () => ({ entities: 0, rules: 1 }),
    explanation: 'The player survives this many hits before losing.',
  }),
  defeat: entry({
    id: 'defeat',
    params: defeatParams,
    roleRefs: (p) => [['role', p.role]],
    capabilities: { events: ['onAction', 'onCounterReaches'], actions: ['addCounter', 'despawn', 'setState', 'win'] },
    cost: (p) => ({ entities: p.count, rules: p.count * p.hitsPerTarget + 1 }),
    explanation: 'Using a target while next to it lands a hit; enough hits remove it.',
  }),
} as const;

export type MechanicId = keyof typeof MECHANICS;
export const MECHANIC_IDS = Object.keys(MECHANICS) as readonly MechanicId[];

export interface ArchetypeEntry {
  /** Shodné s klíčem v `ARCHETYPES`; test to drží. */
  readonly id: string;
  readonly objective: 'reach' | 'collect' | 'survive' | 'checkpoints' | 'deliver' | 'puzzle' | 'defeat_targets';
  readonly requiredMechanics: readonly MechanicId[];
  readonly allowedMechanics: readonly MechanicId[];
  /** Jedna věta pro režiséra: kdy archetyp zvolit. */
  readonly pitch: string;
}

/** Mechaniky přípustné v každém archetypu jako koření – neurčují cíl, ale rytmus. */
const SPICE: readonly MechanicId[] = ['timer', 'hazard_zone', 'patrol', 'stun', 'spawn_wave', 'property_transform', 'health', 'counter'];

function archetype(definition: ArchetypeEntry): ArchetypeEntry {
  return definition;
}

export const ARCHETYPES = {
  collect_exit: archetype({
    id: 'collect_exit',
    objective: 'collect',
    requiredMechanics: ['collectible', 'zone_trigger'],
    allowedMechanics: ['collectible', 'zone_trigger', 'lock_key', 'chaser', ...SPICE],
    pitch: 'Gather a set number of things, then reach the exit they open.',
  }),
  chase_escape: archetype({
    id: 'chase_escape',
    objective: 'reach',
    requiredMechanics: ['chaser', 'zone_trigger'],
    allowedMechanics: ['chaser', 'zone_trigger', 'collectible', 'lock_key', ...SPICE],
    pitch: 'Something hunts the player; reach the exit before it catches you.',
  }),
  survival_timer: archetype({
    id: 'survival_timer',
    objective: 'survive',
    requiredMechanics: ['timer'],
    allowedMechanics: ['timer', 'hazard_zone', 'chaser', 'collectible', ...SPICE],
    pitch: 'Stay alive until the clock runs out while the world turns against you.',
  }),
  checkpoint_race: archetype({
    id: 'checkpoint_race',
    objective: 'checkpoints',
    requiredMechanics: ['checkpoint'],
    allowedMechanics: ['checkpoint', 'zone_trigger', ...SPICE],
    pitch: 'Pass every gate, in order, before time or hazards stop you.',
  }),
  delivery: archetype({
    id: 'delivery',
    objective: 'deliver',
    requiredMechanics: ['carry'],
    allowedMechanics: ['carry', 'zone_trigger', 'chaser', ...SPICE],
    pitch: 'Carry one thing from here to there without dropping or breaking it.',
  }),
  switch_puzzle: archetype({
    id: 'switch_puzzle',
    objective: 'puzzle',
    requiredMechanics: ['switch', 'zone_trigger'],
    allowedMechanics: ['switch', 'zone_trigger', 'lock_key', ...SPICE],
    pitch: 'Find the switch combination that opens the way out.',
  }),
  hazard_crossing: archetype({
    id: 'hazard_crossing',
    objective: 'reach',
    requiredMechanics: ['hazard_zone', 'zone_trigger'],
    allowedMechanics: ['hazard_zone', 'zone_trigger', 'checkpoint', ...SPICE],
    pitch: 'Cross a field of pulsing hazards to reach the far side.',
  }),
  combat_lite: archetype({
    id: 'combat_lite',
    objective: 'defeat_targets',
    requiredMechanics: ['defeat'],
    allowedMechanics: ['defeat', 'chaser', 'zone_trigger', ...SPICE],
    pitch: 'Get next to targets and knock them out one by one.',
  }),
} as const;

export type ArchetypeId = keyof typeof ARCHETYPES;
export const ARCHETYPE_IDS = Object.keys(ARCHETYPES) as readonly ArchetypeId[];

/**
 * Stropy registru – tvrdší než `budgets` ve specu, protože `WorldstreamBlueprint`
 * nese nejvýš 64 objektů a IR má strop pravidel odvozený z `IrLimits`.
 */
export const REGISTRY_LIMITS = { maxEntities: 64, maxRules: 200 } as const;

/**
 * Součet nákladů mechanik plus role, které žádná mechanika nezaplatila (hráč,
 * kulisy). Odhad shora: kompilátor smí vydat méně, nikdy víc.
 */
export function estimateCost(
  mechanics: readonly { readonly id: MechanicId; readonly params: unknown }[],
  roles: readonly { readonly id: string; readonly count: number }[],
): MechanicCost {
  const countOf = (roleId: string): number => roles.find((role) => role.id === roleId)?.count ?? 0;
  const paidRoles = new Set<string>();
  let entities = 0;
  /** Systémová pravidla pohybu `sys.moveTo.*` – jedno na entitu se soketem. */
  let rules = 0;
  for (const mechanic of mechanics) {
    const registered = MECHANICS[mechanic.id] as MechanicEntry<unknown>;
    const params = registered.params.parse(mechanic.params);
    const cost = registered.cost(params, countOf);
    entities += cost.entities;
    rules += cost.rules;
    for (const [, roleId] of registered.roleRefs(params)) paidRoles.add(roleId);
  }
  for (const role of roles) if (!paidRoles.has(role.id)) entities += role.count;
  return { entities, rules: rules + entities };
}
