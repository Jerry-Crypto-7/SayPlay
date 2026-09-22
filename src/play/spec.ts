/**
 * `GameSpec v1` – **záměr hry**, vrstva nad `WorldDoc` (P23).
 *
 * `WorldDoc` odpovídá na otázku *jak přesně tahle instance běží* (entity,
 * sokety, pravidla, svědek). `GameSpec` odpovídá na otázku *co je to za hru*:
 * archetyp, cíl, mechaniky z uzavřeného registru, role, ověřovací tvrzení a
 * rozpočty. Model od P23 píše **jen tohle** – deterministický kompilátor
 * (`src/play/compile`, plán P23-A) z něj postaví `WorldstreamBlueprint`.
 *
 * ## Proč uzavřená gramatika
 *
 * Runtime je mřížkový a deterministický (`src/sim`), hráč se hýbe příkazem
 * `moveTo` na soket, sbírá `pickup`, používá `use`. Mechaniky tady jsou proto
 * jen ty, které se na tenhle runtime **snižují beze změny jeho tvaru** –
 * projektil, skok ani pohyblivá plošina v registru nejsou a `readGameSpec`
 * neznámou mechaniku odmítá (fail closed), místo aby ji tiše zahodila.
 *
 * ## Co drží schéma a co registr
 *
 * Schéma soudí tvar jednoho pole. Registr (`./registry`) soudí celek: zda
 * mechanika patří k archetypu, zda její parametry projdou vlastním schématem,
 * zda role, na které mechaniky odkazují, existují, a zda součet nákladů
 * mechanik nepřekročí rozpočty. `readGameSpec` dělá obojí v jednom kroku.
 */

import { z } from 'zod';

import { ID_PATTERN } from '@/ir/types';
import { canonicalHash } from '@/ir/worlddoc';

import { OBSTACLE_KINDS, RUNNER_DENSITIES, RUNNER_SPEEDS, RUNNER_TRACK } from './arcade/pieces/runner';
import { ARCHETYPES, MECHANICS, type ArchetypeId, type MechanicEntry, type MechanicId, estimateCost } from './registry';

export const GAME_SPEC_SCHEMA = 'gamespec.v1' as const;

/** Ohraničený identifikátor – tentýž vzor, jaký mají entity a sloty v IR. */
export const gameId = z.string().regex(ID_PATTERN, 'identifier: letter, then letters/digits/_/. (max 64)');
const text = z.string().min(1).max(200);

/**
 * Druhy rolí. Role je **sémantická**: kompilátor z ní odvodí entitu, soket,
 * zónu a vizuální vazbu; hráč ji uvidí pod `label`. Právě jedna role je `player`.
 */
export const ROLE_KINDS = [
  'player',
  'exit',
  'collectible',
  'key',
  'door',
  'switch',
  'hazard',
  'chaser',
  'patrol',
  'item',
  'destination',
  'checkpoint',
  'target',
  'prop',
  'zone',
] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

/** Výchozí stav entity podle druhu role; adaptéry stavy přepínají `setState`. */
export const ROLE_INITIAL_STATE: Readonly<Record<RoleKind, string>> = {
  player: 'idle',
  exit: 'open',
  collectible: 'present',
  key: 'present',
  door: 'closed',
  switch: 'off',
  hazard: 'on',
  chaser: 'hunting',
  patrol: 'walking',
  item: 'present',
  destination: 'waiting',
  checkpoint: 'pending',
  target: 'alive',
  prop: 'idle',
  zone: 'idle',
};

export const OBJECTIVE_KINDS = ['reach', 'collect', 'survive', 'checkpoints', 'deliver', 'puzzle', 'defeat_targets'] as const;
export type ObjectiveKind = (typeof OBJECTIVE_KINDS)[number];

export const VERIFICATION_KINDS = ['reachability', 'keypoint', 'termination', 'count', 'relation', 'replay'] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export const roleSchema = z
  .object({
    id: gameId,
    kind: z.enum(ROLE_KINDS),
    /** Anglické podstatné jméno pro vizuál a titulky (`"Roomba"`, `"glowing mushroom"`). */
    label: text.max(60),
    count: z.int().min(1).max(50).default(1),
  })
  .strict();
export type GameRole = z.infer<typeof roleSchema>;

export const mechanicSchema = z
  .object({
    id: z.enum(Object.keys(MECHANICS) as [MechanicId, ...MechanicId[]]),
    /** Parametry soudí schéma mechaniky v registru, ne tohle pole. */
    params: z.record(z.string(), z.unknown()),
  })
  .strict();
export type GameMechanic = z.infer<typeof mechanicSchema>;

export const objectiveSchema = z
  .object({
    kind: z.enum(OBJECTIVE_KINDS),
    /** Jedna anglická věta pro hráče: co má udělat. */
    description: text.max(120),
    count: z.int().min(1).max(50).optional(),
    seconds: z.int().min(5).max(180).optional(),
    /** Role cíle (`exit`, `destination`) nebo sbíraná role. */
    role: gameId.optional(),
  })
  .strict();
export type GameObjective = z.infer<typeof objectiveSchema>;

/** Jedna herní akce ve stopě – stejný slovník jako svědek (`moveTo`, `pickup`, `use`). */
export const playActionSchema = z
  .object({ actionId: z.enum(['moveTo', 'pickup', 'use']), target: gameId })
  .strict();

/**
 * Tvrzení o stavu po krocích. Klíče jsou ID rolí nebo slotů z `GameSpec`,
 * ne entity z `WorldDoc` – kompilátor je přeloží; kdo píše spec, nezná
 * pojmenování entit.
 */
export const stateAssertSchema = z
  .object({
    runState: z.enum(['running', 'won', 'lost']).optional(),
    counters: z.record(gameId, z.int()).optional(),
    flags: z.record(gameId, z.boolean()).optional(),
    entityStates: z.record(gameId, z.string().max(32)).optional(),
    locked: z.record(gameId, z.boolean()).optional(),
    /** Mechaniky, jejichž pravidlo během kroků vystřelilo právě jednou. */
    firedMechanics: z.array(gameId).max(8).optional(),
    replayEqual: z.literal(true).optional(),
  })
  .strict();

/** Vstřik stavu před keypointem – jen deklarované sloty a legální umístění. */
export const stateSetupSchema = z
  .object({
    counters: z.record(gameId, z.int()).optional(),
    flags: z.record(gameId, z.boolean()).optional(),
    entityStates: z.record(gameId, z.string().max(32)).optional(),
    locked: z.record(gameId, z.boolean()).optional(),
    /** Role → role, u které má stát (kompilátor přeloží na soket). */
    placeAt: z.record(gameId, gameId).optional(),
  })
  .strict();

export const verificationSchema = z
  .object({
    id: gameId,
    kind: z.enum(VERIFICATION_KINDS),
    /** Mechanika, kterou tvrzení dokazuje; `keypoint` ji musí mít. */
    mechanic: gameId.optional(),
    setup: stateSetupSchema.optional(),
    actions: z.array(playActionSchema).max(32).optional(),
    /** Kolik tiků nechat po akcích doběhnout (výchozí volí verifikátor). */
    ticks: z.int().min(0).max(3600).optional(),
    assert: stateAssertSchema,
  })
  .strict();
export type VerificationAssertion = z.infer<typeof verificationSchema>;

export const budgetsSchema = z
  .object({
    maxEntities: z.int().min(2).max(64),
    maxRules: z.int().min(1).max(200),
    maxTriangles: z.int().min(1000).max(1_000_000),
  })
  .strict();
export type GameBudgets = z.infer<typeof budgetsSchema>;

export const themeSchema = z
  .object({
    /** Kde se to děje – vstup pro výběr assetů a palety (`"supermarket at night"`). */
    setting: text.max(80),
    mood: text.max(40),
  })
  .strict();

export const tutorialSchema = z
  .object({
    /** Do 80 znaků, anglicky, zobrazí se před první akcí. */
    goalLine: text.max(80),
    controlsHint: text.max(80),
  })
  .strict();

/**
 * Ovládání (P25A). `tap_go` = dnešní mřížka (`src/sim`), `runner` = arkádové
 * jádro (`src/play/arcade`). Pole je volitelné a **bez výchozí hodnoty**:
 * default by ho vepsal do každého přečteného specu a pohnul `specHash` všech
 * dnešních her.
 */
export const CONTROLS = ['tap_go', 'runner'] as const;
export type ControlId = (typeof CONTROLS)[number];

/** Parametry běžce; co chybí, doplní generátor tratě svým výchozím. */
export const runnerParamsSchema = z
  .object({
    speed: z.enum(RUNNER_SPEEDS).optional(),
    density: z.enum(RUNNER_DENSITIES).optional(),
    lengthM: z.int().min(RUNNER_TRACK.minLengthM).max(RUNNER_TRACK.maxLengthM).optional(),
    obstacles: z.array(z.enum(OBSTACLE_KINDS)).min(1).max(OBSTACLE_KINDS.length).optional(),
  })
  .strict();
export type RunnerParams = z.infer<typeof runnerParamsSchema>;

export const gameSpecSchema = z
  .object({
    schema: z.literal(GAME_SPEC_SCHEMA),
    control: z.enum(CONTROLS).optional(),
    controlParams: runnerParamsSchema.optional(),
    title: text.max(80),
    archetype: z.enum(Object.keys(ARCHETYPES) as [ArchetypeId, ...ArchetypeId[]]),
    targetDurationSec: z.int().min(30).max(180),
    theme: themeSchema,
    objective: objectiveSchema,
    /** Právě jedna nesmí chybět; nad pěti se hra přestává vysvětlit jednou větou. */
    mechanics: z.array(mechanicSchema).min(1).max(5),
    roles: z.array(roleSchema).min(2).max(30),
    tutorial: tutorialSchema,
    verification: z.array(verificationSchema).min(1).max(20),
    budgets: budgetsSchema,
  })
  .strict();

export type GameSpecV1 = z.infer<typeof gameSpecSchema>;

export type GameSpecReason =
  /** Tvar neodpovídá schématu. */
  | 'MALFORMED_SPEC'
  /** Mechanika nepatří k archetypu, nebo parametry neprošly jejím schématem. */
  | 'MECHANIC_REJECTED'
  /** Odkaz na roli, mechaniku nebo slot, který spec nedeklaruje; nebo chybí právě jeden `player`. */
  | 'DANGLING_REFERENCE'
  /** Cíl neodpovídá archetypu, nebo mu chybí `count`/`seconds`/`role`, které jeho druh žádá. */
  | 'OBJECTIVE_MISMATCH'
  /** Odhad nákladů mechanik a rolí překračuje rozpočty specu nebo strop registru. */
  | 'BUDGET_EXCEEDED';

export type GameSpecResult =
  | { readonly ok: true; readonly value: GameSpecV1; readonly specHash: string }
  | { readonly ok: false; readonly reason: GameSpecReason; readonly issues: readonly string[] };

/** Hash záměru – FNV-1a nad kanonickou serializací, tatáž rodina jako `simHashOf`. */
export function gameSpecHash(spec: GameSpecV1): string {
  return canonicalHash(spec);
}

const OBJECTIVE_NEEDS: Readonly<Record<ObjectiveKind, readonly ('count' | 'seconds' | 'role')[]>> = {
  reach: ['role'],
  collect: ['count', 'role'],
  survive: ['seconds'],
  checkpoints: ['count', 'role'],
  deliver: ['role'],
  puzzle: ['role'],
  defeat_targets: ['count', 'role'],
};

/**
 * Přečte a **celý** posoudí spec. Vrací verdikt, ne výjimku – volá se nad
 * odpovědí modelu i nad ručními fixturami a v obou případech je odmítnutí
 * s důvodem to, co volající potřebuje pro opravné kolo.
 */
export function readGameSpec(input: unknown): GameSpecResult {
  const parsed = gameSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'MALFORMED_SPEC',
      issues: parsed.error.issues.map((issue) => `/${issue.path.join('/')}: ${issue.message}`),
    };
  }
  const spec = parsed.data;
  if (spec.controlParams !== undefined && spec.control !== 'runner') {
    return { ok: false, reason: 'MALFORMED_SPEC', issues: ['/controlParams: only a runner game takes control parameters'] };
  }
  const archetype = ARCHETYPES[spec.archetype];
  const roleIds = new Set(spec.roles.map((role) => role.id));
  const issues: string[] = [];

  if (roleIds.size !== spec.roles.length) issues.push('/roles: duplicate role id');
  if (spec.roles.filter((role) => role.kind === 'player').length !== 1) issues.push('/roles: exactly one role of kind player');
  const mechanicIds = new Set<string>();
  spec.mechanics.forEach((mechanic, index) => {
    if (mechanicIds.has(mechanic.id)) issues.push(`/mechanics/${index}: mechanic ${mechanic.id} declared twice`);
    mechanicIds.add(mechanic.id);
  });
  if (issues.length > 0) return { ok: false, reason: 'DANGLING_REFERENCE', issues };

  for (const required of archetype.requiredMechanics) {
    if (!mechanicIds.has(required)) issues.push(`/mechanics: archetype ${spec.archetype} requires ${required}`);
  }
  spec.mechanics.forEach((mechanic, index) => {
    const entry = MECHANICS[mechanic.id] as MechanicEntry<unknown>;
    if (!archetype.allowedMechanics.includes(mechanic.id)) {
      issues.push(`/mechanics/${index}: ${mechanic.id} is not allowed in ${spec.archetype}`);
      return;
    }
    const params = entry.params.safeParse(mechanic.params);
    if (!params.success) {
      for (const issue of params.error.issues) issues.push(`/mechanics/${index}/params/${issue.path.join('/')}: ${issue.message}`);
      return;
    }
    for (const [field, roleId] of entry.roleRefs(params.data)) {
      if (!roleIds.has(roleId)) issues.push(`/mechanics/${index}/params/${field}: unknown role ${roleId}`);
    }
  });
  if (issues.length > 0) return { ok: false, reason: 'MECHANIC_REJECTED', issues };

  // `property_transform.from`, který role nemá od startu a žádná mechanika ho
  // nenastaví, je mrtvé pravidlo: spec by prošel a transformace nevystřelila.
  const reachable = new Map(spec.roles.map((role) => [role.id, new Set([ROLE_INITIAL_STATE[role.kind]])]));
  const parsedParams = spec.mechanics.map((mechanic) => (MECHANICS[mechanic.id] as MechanicEntry<unknown>).params.parse(mechanic.params));
  spec.mechanics.forEach((mechanic, index) => {
    const entry = MECHANICS[mechanic.id] as MechanicEntry<unknown>;
    for (const [roleId, state] of entry.setsStates?.(parsedParams[index]) ?? []) reachable.get(roleId)?.add(state);
  });
  spec.mechanics.forEach((mechanic, index) => {
    if (mechanic.id !== 'property_transform') return;
    const { role, from } = parsedParams[index] as { role: string; from: string };
    if (!reachable.get(role)?.has(from)) {
      issues.push(`/mechanics/${index}/params/from: role ${role} is never in state ${from} (reachable: ${[...(reachable.get(role) ?? [])].join(', ')})`);
    }
  });
  if (issues.length > 0) return { ok: false, reason: 'MECHANIC_REJECTED', issues };

  if (spec.objective.kind !== archetype.objective) {
    issues.push(`/objective/kind: ${spec.archetype} expects ${archetype.objective}, got ${spec.objective.kind}`);
  }
  for (const field of OBJECTIVE_NEEDS[spec.objective.kind]) {
    if (spec.objective[field] === undefined) issues.push(`/objective/${field}: required for ${spec.objective.kind}`);
  }
  if (spec.objective.role !== undefined && !roleIds.has(spec.objective.role)) {
    issues.push(`/objective/role: unknown role ${spec.objective.role}`);
  }
  if (issues.length > 0) return { ok: false, reason: 'OBJECTIVE_MISMATCH', issues };

  spec.verification.forEach((assertion, index) => {
    if (assertion.kind === 'keypoint' && assertion.mechanic === undefined) {
      issues.push(`/verification/${index}/mechanic: keypoint must name the mechanic it proves`);
    }
    if (assertion.mechanic !== undefined && !mechanicIds.has(assertion.mechanic)) {
      issues.push(`/verification/${index}/mechanic: unknown mechanic ${assertion.mechanic}`);
    }
    for (const action of assertion.actions ?? []) {
      if (!roleIds.has(action.target)) issues.push(`/verification/${index}/actions: unknown role ${action.target}`);
    }
    for (const [from, at] of Object.entries(assertion.setup?.placeAt ?? {})) {
      if (!roleIds.has(from) || !roleIds.has(at)) issues.push(`/verification/${index}/setup/placeAt: unknown role ${from} or ${at}`);
    }
    for (const id of assertion.assert.firedMechanics ?? []) {
      if (!mechanicIds.has(id)) issues.push(`/verification/${index}/assert/firedMechanics: unknown mechanic ${id}`);
    }
  });
  if (issues.length > 0) return { ok: false, reason: 'DANGLING_REFERENCE', issues };

  const cost = estimateCost(spec.mechanics, spec.roles);
  if (cost.entities > spec.budgets.maxEntities) {
    issues.push(`/budgets/maxEntities: estimate ${cost.entities} exceeds ${spec.budgets.maxEntities}`);
  }
  if (cost.rules > spec.budgets.maxRules) issues.push(`/budgets/maxRules: estimate ${cost.rules} exceeds ${spec.budgets.maxRules}`);
  if (issues.length > 0) return { ok: false, reason: 'BUDGET_EXCEEDED', issues };

  return { ok: true, value: spec, specHash: gameSpecHash(spec) };
}
