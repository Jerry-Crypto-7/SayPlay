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

/** Co o světě víme před rozvržením: horní mez buněk mřížky a počty instancí podle druhu role. */
export interface CostWorld {
  readonly maxCells: number;
  /** Horní mez šířky + výšky mřížky (sloupce a řádky, P25D T1). */
  readonly maxSpan: number;
  readonly kindCount: (kind: string) => number;
}

/**
 * Mřížka rozvržení (`compile/layout.ts`). Bydlí tady, aby odhad ceny znal
 * horní mez buněk dřív, než kompilátor hodí kostkou.
 */
export const LAYOUT_GRID = {
  minWidth: 8,
  minHeight: 6,
  maxWidth: 24,
  maxHeight: 16,
  /** Kolik buněk mřížky připadá na jednu instanci role. */
  cellsPerInstance: 5,
} as const;

/** Rozměr mřížky pro `instances` instancí; `dw` ∈ 0..2 a `dh` ∈ 0..1 hodí kompilátor. */
export function layoutGridSize(instances: number, dw: number, dh: number): { width: number; height: number } {
  const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
  const area = Math.max(LAYOUT_GRID.minWidth * LAYOUT_GRID.minHeight, instances * LAYOUT_GRID.cellsPerInstance);
  const width = clamp(Math.ceil(Math.sqrt(area * 1.5)) + dw, LAYOUT_GRID.minWidth, LAYOUT_GRID.maxWidth);
  const height = clamp(Math.ceil(area / width) + dh, LAYOUT_GRID.minHeight, LAYOUT_GRID.maxHeight);
  return { width, height };
}

/** Největší plocha mřížky přes všechny hody kompilátoru. */
export function maxLayoutCells(instances: number): number {
  let max = 0;
  for (let dw = 0; dw <= 2; dw += 1) {
    for (let dh = 0; dh <= 1; dh += 1) {
      const { width, height } = layoutGridSize(instances, dw, dh);
      max = Math.max(max, width * height);
    }
  }
  return max;
}

/** Největší šířka + výška mřížky přes všechny hody kompilátoru. */
export function maxLayoutSpan(instances: number): number {
  let max = 0;
  for (let dw = 0; dw <= 2; dw += 1) {
    for (let dh = 0; dh <= 1; dh += 1) {
      const { width, height } = layoutGridSize(instances, dw, dh);
      max = Math.max(max, width + height);
    }
  }
  return max;
}

export interface MechanicEntry<P = unknown> {
  /** Shodné s klíčem v `MECHANICS`; test to drží. */
  readonly id: string;
  readonly params: z.ZodType<P>;
  /** Dvojice `[jméno pole, ID role]` pro každý odkaz na roli v parametrech. */
  readonly roleRefs: (params: P) => readonly (readonly [string, string])[];
  readonly capabilities: RuntimeCapabilities;
  /** Horní mez: kompilátor smí vydat méně pravidel, nikdy víc (`registry-cost.test.ts`). */
  readonly cost: (params: P, roleCount: (roleId: string) => number, world: CostWorld) => MechanicCost;
  /** Jedna anglická věta pro hráče a pro kritika: co mechanika dělá. */
  readonly explanation: string;
  /**
   * Dvojice `[ID role, stav]` pro každý `setState`, který kompilátor vydá na
   * instance role. `readGameSpec` z nich pozná `property_transform.from`, který
   * nikdy nenastane; `registry-cost.test.ts` drží shodu s adaptéry.
   */
  readonly setsStates?: (params: P) => readonly (readonly [string, string])[];
}

function entry<P>(definition: MechanicEntry<P>): MechanicEntry<P> {
  return definition;
}

const collectibleParams = z
  .object({
    role: roleRef,
    count: z.int().min(1).max(20),
    counter: roleRef.default('collected'),
    /**
     * Skrýše (P25D T2): i-tý předmět leží schovaný v i-té instanci této role
     * a není vidět, dokud hráč do skrýše nevstoupí. Skrýší smí být víc (prázdné).
     */
    hiddenIn: roleRef.optional(),
  })
  .strict();
const counterParams = z
  .object({ id: roleRef, min: z.int().min(0).max(999), max: z.int().min(1).max(999), initial: z.int().min(0).max(999) })
  .strict();
const timerParams = z
  .object({
    id: roleRef,
    seconds,
    onEnd: z.enum(['win', 'lose', 'signal']),
    signal: roleRef.optional(),
    /**
     * Fáze (P25D T1, „červená–zelená“): světlo se střídá `goSeconds` zelená a
     * `stopSeconds` červená podle tiků. Krok hráče v červené prohraje.
     * `watcher` je role, která to hlídá (panenka, animatronik): v zelené je
     * ve stavu `away`, v červené `watching`.
     */
    phases: z
      .object({ goSeconds: z.int().min(2).max(20), stopSeconds: z.int().min(1).max(10), watcher: roleRef.optional() })
      .strict()
      .optional(),
  })
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
    /**
     * Pořadí (P25B T4): žádané spínače jdou zapnout jen v pořadí `required`;
     * spínač mimo pořadí vypne všechny žádané a dveře zamkne.
     */
    ordered: z.boolean().optional(),
    /**
     * Bedny (P25B T4): i-tá žádaná deska dostane i-tou instanci této role.
     * `use` na bednu ji posune o úsek cesty k desce (nejvýš `PUSH_STEPS`
     * úseků); deska se zapne, když na ni bedna dojede, ne stiskem.
     */
    crateRole: roleRef.optional(),
  })
  .strict();
/** Na kolik úseků se dělí cesta bedny na desku (`switch.crateRole`). */
export const PUSH_STEPS = 3;
const hazardZoneParams = z
  .object({
    role: roleRef,
    effect: z.enum(['lose', 'damage']),
    /** Pulzování: `onSeconds` aktivní, `offSeconds` bezpečná. Bez toho je nebezpečí stálé. */
    /** `alternate` (P25D T3, pohyblivá zeď): liché instance svítí, když sudé nesvítí. */
    pulse: z.object({ onSeconds: seconds, offSeconds: seconds, alternate: z.boolean().optional() }).strict().optional(),
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
    /**
     * Plížení (P25B T3): hlídka vidí po úseku trasy, který právě jde. Hráč na
     * témže úseku prohraje. Úseky se vyhnou cestě svědka, takže hra jde vyhrát.
     */
    sight: z.boolean().optional(),
  })
  .strict();
const carryParams = z
  .object({
    itemRole: roleRef,
    destinationRole: roleRef,
    fragile: z.boolean(),
    /**
     * Objednávky (P25B T5): role jídel. i-tý zákazník (instance `destinationRole`)
     * chce jídlo `menu[i mod délka]`; správné doručení přičte `orders_served`,
     * obsloužení všech vyhraje. Bez menu se nese jedna věc do cíle.
     */
    menu: z.array(roleRef).min(1).max(4).optional(),
  })
  .strict();
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
    /** Délka časovače pro `trigger: 'timer'`; jinak se nečte. */
    afterSeconds: seconds.default(10),
  })
  .strict();
/** Životy 1–9 (P36A T2: věta smí říct „with 7 lives“, `LIVES_RANGE` arkády). */
const healthParams = z.object({ max: z.int().min(1).max(9) }).strict();
const defeatParams = z.object({ role: roleRef, count: z.int().min(1).max(12), hitsPerTarget: z.int().min(1).max(3) }).strict();

export const MECHANICS = {
  collectible: entry({
    id: 'collectible',
    params: collectibleParams,
    roleRefs: (p) => [['role', p.role], ...(p.hiddenIn === undefined ? [] : [['hiddenIn', p.hiddenIn] as const])],
    capabilities: { events: ['onPickup', 'onCounterReaches', 'onStart', 'onEnterZone'], actions: ['addCounter', 'emit', 'despawn', 'spawn'] },
    /** Skrýše: jedno schování na startu a odhalení na předmět. */
    cost: (p, count) => ({
      entities: p.count + (p.hiddenIn === undefined ? 0 : count(p.hiddenIn)),
      rules: count(p.role) + 1 + (p.hiddenIn === undefined ? 0 : count(p.role) + 1),
    }),
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
    roleRefs: (p) => (p.phases?.watcher === undefined ? [] : [['phases.watcher', p.phases.watcher]]),
    capabilities: {
      events: ['onStart', 'onTimerEnd', 'onEnterZone'],
      actions: ['startTimer', 'win', 'lose', 'emit', 'setFlag', 'setState'],
    },
    /** Fáze: dvě přepnutí a krok v červené na každý sloupec a řádek mřížky. */
    cost: (p, count, world) => ({
      entities: p.phases?.watcher === undefined ? 0 : count(p.phases.watcher),
      rules: 2 + (p.phases === undefined ? 0 : 2 + world.maxSpan),
    }),
    setsStates: (p) => (p.phases?.watcher === undefined ? [] : [[p.phases.watcher, 'away'], [p.phases.watcher, 'watching']]),
    explanation: 'A countdown that ends the game or fires a signal; with phases, moving on red loses.',
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
    setsStates: (p) => [[p.role, 'passed']],
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
    cost: (p, count) => ({ entities: p.keysNeeded + 1, rules: count(p.keyRole) + 1 }),
    setsStates: (p) => [[p.doorRole, 'open']],
    explanation: 'Collecting enough keys unlocks a door.',
  }),
  switch: entry({
    id: 'switch',
    params: switchParams,
    roleRefs: (p) => [
      ...p.switchRoles.map((role) => ['switchRoles', role] as const),
      ['doorRole', p.doorRole] as const,
      ...(p.crateRole === undefined ? [] : [['crateRole', p.crateRole] as const]),
    ],
    capabilities: {
      events: ['onAction', 'onStateEnter', 'onEnterZone'],
      actions: ['setState', 'setLocked', 'setFlag', 'moveTo', 'addCounter'],
    },
    /**
     * Na spínač čtyři pravidla: zapnout, vypnout, odemknout a zamknout podle
     * kombinace „po přepnutí“. V pořadí navíc pravidlo „mimo pořadí“ na každý
     * žádaný spínač; bedna přidá `PUSH_STEPS` posunů a dvě pravidla příjezdu.
     */
    cost: (p, count) => {
      const instances = (roles: readonly string[]): number => [...new Set(roles)].reduce((sum, role) => sum + count(role), 0);
      const crates = p.crateRole === undefined ? 0 : count(p.crateRole);
      return {
        entities: p.switchRoles.length + 1 + crates,
        rules: 4 * instances(p.switchRoles) + (p.ordered === true ? instances(p.required) : 0) + crates * (PUSH_STEPS + 2),
      };
    },
    setsStates: (p) => p.switchRoles.flatMap((role) => [[role, 'on'] as const, [role, 'off'] as const]),
    explanation: 'Using switches toggles them; the right combination opens the door.',
  }),
  hazard_zone: entry({
    id: 'hazard_zone',
    params: hazardZoneParams,
    roleRefs: (p) => [['role', p.role]],
    capabilities: { events: ['onEnterZone', 'onTimerEnd', 'onStart'], actions: ['lose', 'addCounter', 'setState', 'startTimer'] },
    /** `enter` + `start` na instanci, s pulzem navíc `catch` a dvě pravidla přepnutí, střídání ještě vypnutí na startu. */
    cost: (p, count) => ({ entities: count(p.role), rules: count(p.role) * (p.pulse ? 3 : 2) + (p.pulse ? 2 : 0) + (p.pulse?.alternate ? 1 : 0) }),
    setsStates: (p) => (p.pulse ? [[p.role, 'on'], [p.role, 'off']] : []),
    explanation: 'Standing in a hazard hurts or ends the run; hazards may pulse on and off.',
  }),
  chaser: entry({
    id: 'chaser',
    params: chaserParams,
    roleRefs: (p) => [['role', p.role]],
    capabilities: { events: ['onSeen', 'onCollide', 'onEnterZone'], actions: ['moveTo', 'lose', 'addCounter'] },
    /** Pravidlo pohybu na každou buňku mřížky plus `start` a `touch` na instanci. */
    cost: (p, count, world) => ({ entities: count(p.role), rules: count(p.role) * (world.maxCells + 2) }),
    explanation: 'A pursuer heads for the player whenever it sees them; touching it hurts.',
  }),
  patrol: entry({
    id: 'patrol',
    params: patrolParams,
    roleRefs: (p) => [['role', p.role]],
    capabilities: { events: ['onCollide', 'onEnterZone', 'onStart'], actions: ['moveTo', 'lose', 'addCounter'], agents: true },
    /**
     * Mysl `1 + stops × 3` (`sim/agents.ts`) plus `touch` na instanci; výhled
     * dvě pravidla na úsek (`stops + 1` úseků) a jedno startovní.
     */
    cost: (p, count) => ({ entities: count(p.role), rules: count(p.role) * (p.stops * 3 + 2 + (p.sight === true ? 2 * (p.stops + 1) + 1 : 0)) }),
    explanation: 'A character walks a fixed route; its temperament decides how. With sight, being on its current stretch loses.',
  }),
  carry: entry({
    id: 'carry',
    params: carryParams,
    roleRefs: (p) => [
      ['itemRole', p.itemRole],
      ['destinationRole', p.destinationRole],
      ...(p.menu ?? []).map((role) => ['menu', role] as const),
    ],
    capabilities: {
      events: ['onPickup', 'onDrop', 'onEnterZone', 'onCollide', 'onAction', 'onCounterReaches'],
      actions: ['giveItem', 'takeItem', 'addCounter', 'win', 'lose'],
    },
    /**
     * Na předmět sběr, sběr v cíli, doručení do každého cíle a u křehkého
     * rozbití o každého chodce. Menu: sběr na jídlo, obsluha na zákazníka a výhra.
     */
    cost: (p, count, world) => ({
      entities: p.menu === undefined ? 2 : 2 + p.menu.length + count(p.destinationRole),
      rules:
        count(p.itemRole) * (2 + count(p.destinationRole) + (p.fragile ? world.kindCount('patrol') + world.kindCount('chaser') : 0)) +
        (p.menu === undefined ? 0 : [...new Set(p.menu)].reduce((sum, role) => sum + count(role), 0) + count(p.destinationRole) + 1),
    }),
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
    capabilities: { events: ['onStart', 'onTimerEnd', 'onEnterZone'], actions: ['spawn', 'startTimer', 'setState', 'addCounter'] },
    /** Start, opakování a oživení; s `defeat` na téže roli navíc `revive` na instanci. */
    cost: (p, count) => ({ entities: p.poolSize, rules: 3 + count(p.role) }),
    setsStates: (p) => [[p.role, 'alive']],
    explanation: 'Knocked-out things of this role come back on a schedule, fresh, up to a limit.',
  }),
  property_transform: entry({
    id: 'property_transform',
    params: propertyTransformParams,
    roleRefs: (p) => [['role', p.role]],
    capabilities: { events: ['onAction', 'onSignal', 'onTimerEnd'], actions: ['setState'] },
    cost: (p, count) => ({ entities: 0, rules: count(p.role) }),
    setsStates: (p) => [[p.role, p.to]],
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
    /** `hit` + `down` na cíl bez ohledu na `hitsPerTarget`, plus výhra. */
    cost: (p, count) => ({ entities: p.count, rules: 2 * count(p.role) + 1 }),
    setsStates: (p) => [[p.role, 'down']],
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
  roles: readonly { readonly id: string; readonly kind: string; readonly count: number }[],
): MechanicCost {
  const countOf = (roleId: string): number => roles.find((role) => role.id === roleId)?.count ?? 0;
  const instances = roles.reduce((sum, role) => sum + role.count, 0);
  const world: CostWorld = {
    maxCells: maxLayoutCells(instances),
    maxSpan: maxLayoutSpan(instances),
    kindCount: (kind) => roles.filter((role) => role.kind === kind).reduce((sum, role) => sum + role.count, 0),
  };
  const paidRoles = new Set<string>();
  let entities = 0;
  /** Systémová pravidla pohybu `sys.moveTo.*` – jedno na entitu se soketem. */
  let rules = 0;
  for (const mechanic of mechanics) {
    const registered = MECHANICS[mechanic.id] as MechanicEntry<unknown>;
    const params = registered.params.parse(mechanic.params);
    const cost = registered.cost(params, countOf, world);
    entities += cost.entities;
    rules += cost.rules;
    for (const [, roleId] of registered.roleRefs(params)) paidRoles.add(roleId);
  }
  for (const role of roles) if (!paidRoles.has(role.id)) entities += role.count;
  return { entities, rules: rules + entities };
}
