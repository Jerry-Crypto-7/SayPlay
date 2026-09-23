/**
 * Oprava specu (P23-B T6): nejdřív deterministicky z tabulky nález → oprava,
 * teprve potom model, a to nejvýš `MAX_REPAIR_ROUNDS` kol RFC 6902 operací
 * (`docs/play/pack/repair.md`: nejmenší legální záplata, nic jiného).
 *
 * Deterministická tabulka bere jak důvod odmítnutí čtečky (`MECHANIC_REJECTED`,
 * `DANGLING_REFERENCE`, `BUDGET_EXCEEDED`, …) nad **surovým** tělem, tak
 * nálezy kritika nad už platným specem. Pracuje nad volným klonem, a výsledek
 * vždy znovu projde `readGameSpec` – jinak `null` a slovo má model.
 *
 * Model vrací jen pole operací; `applyRepairAnswer` je aplikuje nad kopií,
 * odmítne operaci na `/schema` i jakoukoli, která selže, a výsledek znovu
 * přečte. Špatná odpověď je `ok:false` s důvodem, nikdy výjimka.
 */

import { applyPatch, type Operation } from 'rfc6902';

import { EMISSION_MODEL, type UpstreamRequest } from '@/model/prompt';

import chaseEscape from '../__fixtures__/chase_escape.json';
import checkpointRace from '../__fixtures__/checkpoint_race.json';
import collectExit from '../__fixtures__/collect_exit.json';
import combatLite from '../__fixtures__/combat_lite.json';
import delivery from '../__fixtures__/delivery.json';
import hazardCrossing from '../__fixtures__/hazard_crossing.json';
import survivalTimer from '../__fixtures__/survival_timer.json';
import switchPuzzle from '../__fixtures__/switch_puzzle.json';
import { controlOf, readsMechanic } from '../capabilities';
import { ARCHETYPES, MECHANICS, MECHANIC_IDS, type ArchetypeId, type MechanicEntry, type MechanicId, estimateCost } from '../registry';
import { readGameSpec, type GameSpecReason, type GameSpecV1, type VerificationAssertion } from '../spec';

import type { CriticIssue } from './critic';
import { renderRegistry } from './prompt';
import type { DirectorReadReason } from './read';

export const MAX_REPAIR_ROUNDS = 2;

/** Doslova `docs/play/pack/repair.md`; test drží shodu se souborem. */
export const REPAIR_RULES =
  'Given failing subtree, registry context and issues, return RFC6902 operations only. Make the smallest legal patch; preserve unrelated fields and explicit intent. Never return executable code.';

/** Co model vymyslí a čím se to nahradí; `null` = vypustit. */
export const NEAREST_MECHANIC: Readonly<Record<string, MechanicId | null>> = {
  projectile: 'defeat',
  shoot: 'defeat',
  jump: 'checkpoint',
  moving_platform: 'hazard_zone',
};

export type Loose = Record<string, unknown>;
export type LooseMechanic = { id: string; params: Loose };
type LooseRole = { id: string; kind: string; label: string; count?: number };

const TEMPLATES: readonly GameSpecV1[] = [collectExit, chaseEscape, survivalTimer, checkpointRace, delivery, switchPuzzle, hazardCrossing, combatLite] as GameSpecV1[];

function isRecord(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mechanicsOf(spec: Loose): LooseMechanic[] {
  return Array.isArray(spec.mechanics) ? (spec.mechanics.filter((m) => isRecord(m) && typeof m.id === 'string' && isRecord(m.params)) as LooseMechanic[]) : [];
}

function rolesOf(spec: Loose): LooseRole[] {
  return Array.isArray(spec.roles) ? (spec.roles.filter((r) => isRecord(r) && typeof r.id === 'string') as LooseRole[]) : [];
}

function archetypeOf(spec: Loose): ArchetypeId | null {
  return typeof spec.archetype === 'string' && spec.archetype in ARCHETYPES ? (spec.archetype as ArchetypeId) : null;
}

function dropVerificationOf(spec: Loose, mechanicId: string): void {
  if (Array.isArray(spec.verification)) spec.verification = spec.verification.filter((v) => !isRecord(v) || v.mechanic !== mechanicId);
}

/** Vyjme mechaniky, které zvolené ovládání nehraje (P26 T5, nález `UNSUPPORTED` s blokem). */
function dropUnread(spec: Loose, applied: string[]): void {
  const control = controlOf(spec as Pick<GameSpecV1, 'control'>);
  spec.mechanics = mechanicsOf(spec).filter((mechanic) => {
    if (readsMechanic(control, mechanic.id)) return true;
    applied.push(`dropped ${mechanic.id} (control ${control} does not play it)`);
    dropVerificationOf(spec, mechanic.id);
    return false;
  });
  // Arkádu ověřuje robot nad tratí; schéma chce aspoň jedno tvrzení.
  if (Array.isArray(spec.verification) && spec.verification.length === 0) {
    spec.verification = [{ id: 'wins', kind: 'reachability', assert: { runState: 'won' } }];
  }
}

function defaultParams(id: MechanicId, spec: Loose): Loose | null {
  const roles = rolesOf(spec);
  const player = roles.find((role) => role.kind === 'player')?.id ?? 'player';
  const firstOf = (kind: string): string | undefined => roles.find((role) => role.kind === kind)?.id;
  switch (id) {
    case 'defeat':
      return { role: firstOf('target') ?? firstOf('chaser') ?? firstOf('patrol') ?? player, count: 3, hitsPerTarget: 1 };
    case 'checkpoint':
      return { role: firstOf('checkpoint') ?? firstOf('prop') ?? player, count: 3, ordered: false };
    case 'hazard_zone':
      return { role: firstOf('hazard') ?? firstOf('prop') ?? player, effect: 'lose', pulse: { onSeconds: 2, offSeconds: 4 } };
    default:
      return null;
  }
}

/** Neznámé mechaniky přes `NEAREST_MECHANIC`, cizí a nevalidní pryč, když nejsou povinné. */
function fixMechanics(spec: Loose, applied: string[]): boolean {
  const archetype = archetypeOf(spec);
  if (archetype === null) return false;
  const entry = ARCHETYPES[archetype];
  const known = new Set<string>(MECHANIC_IDS);
  const next: LooseMechanic[] = [];
  for (const mechanic of mechanicsOf(spec)) {
    if (known.has(mechanic.id)) {
      next.push(mechanic);
      continue;
    }
    const nearest = NEAREST_MECHANIC[mechanic.id] ?? null;
    const already = next.some((m) => m.id === nearest) || mechanicsOf(spec).some((m) => m.id === nearest);
    const params = nearest === null || !entry.allowedMechanics.includes(nearest) || already ? null : defaultParams(nearest, spec);
    if (nearest !== null && params !== null) {
      next.push({ id: nearest, params });
      applied.push(`replaced ${mechanic.id} with ${nearest}`);
    } else {
      applied.push(`dropped unknown mechanic ${mechanic.id}`);
    }
    dropVerificationOf(spec, mechanic.id);
  }
  const kept: LooseMechanic[] = [];
  const seen = new Set<string>();
  for (const mechanic of next) {
    const id = mechanic.id as MechanicId;
    const required = entry.requiredMechanics.includes(id);
    const registered = MECHANICS[id] as MechanicEntry<unknown>;
    const valid = registered.params.safeParse(mechanic.params).success;
    if (seen.has(id) || (!required && (!entry.allowedMechanics.includes(id) || !valid))) {
      applied.push(`dropped ${id} (${seen.has(id) ? 'duplicate' : !entry.allowedMechanics.includes(id) ? `not allowed in ${archetype}` : 'invalid params'})`);
      dropVerificationOf(spec, id);
      continue;
    }
    seen.add(id);
    kept.push(mechanic);
  }
  spec.mechanics = kept;
  return true;
}

function ensurePlayer(spec: Loose, applied: string[]): void {
  const roles = rolesOf(spec);
  if (roles.some((role) => role.kind === 'player')) return;
  const id = roles.some((role) => role.id === 'player') ? 'hero' : 'player';
  spec.roles = [{ id, kind: 'player', label: 'player', count: 1 }, ...roles];
  applied.push(`added player role ${id}`);
}

/** Srazí počty rolí a mechanik poměrně, dokud odhad nesedí do `share` rozpočtu. */
function fitBudget(spec: Loose, share: number, applied: string[]): boolean {
  const budgets = spec.budgets;
  if (!isRecord(budgets) || typeof budgets.maxEntities !== 'number' || typeof budgets.maxRules !== 'number') return false;
  const roles = rolesOf(spec);
  const mechanics = mechanicsOf(spec) as { id: MechanicId; params: Loose }[];
  for (let round = 0; round < 12; round += 1) {
    let cost;
    try {
      cost = estimateCost(mechanics, roles.map((role) => ({ id: role.id, kind: role.kind, count: role.count ?? 1 })));
    } catch {
      return false;
    }
    if (cost.entities <= budgets.maxEntities * share && cost.rules <= budgets.maxRules * share) {
      if (round > 0) applied.push(`scaled counts to fit ${String(cost.entities)} entities / ${String(cost.rules)} rules`);
      return true;
    }
    const factor = Math.min((budgets.maxEntities * share) / cost.entities, (budgets.maxRules * share) / cost.rules, 0.9);
    let moved = false;
    for (const role of roles) {
      const count = role.count ?? 1;
      const next = Math.max(1, Math.floor(count * factor));
      if (next < count) {
        role.count = next;
        moved = true;
      }
    }
    for (const mechanic of mechanics) {
      for (const [key, floor] of [
        ['count', mechanic.id === 'checkpoint' ? 2 : 1],
        ['poolSize', 1],
        ['maxAlive', 1],
      ] as const) {
        const value = mechanic.params[key];
        if (typeof value === 'number') {
          const next = Math.max(floor, Math.floor(value * factor));
          if (next < value) {
            mechanic.params[key] = next;
            moved = true;
          }
        }
      }
    }
    if (!moved) return false;
  }
  return false;
}

function syncObjective(spec: Loose, applied: string[]): void {
  const objective = spec.objective;
  if (!isRecord(objective)) return;
  for (const mechanic of mechanicsOf(spec)) {
    if (['collectible', 'defeat', 'checkpoint'].includes(mechanic.id) && typeof mechanic.params.count === 'number' && objective.count !== undefined && objective.count !== mechanic.params.count) {
      objective.count = mechanic.params.count;
      applied.push(`objective.count set to ${String(mechanic.params.count)} from ${mechanic.id}`);
    }
    if (mechanic.id === 'timer' && typeof mechanic.params.seconds === 'number' && objective.seconds !== undefined && objective.seconds !== mechanic.params.seconds) {
      objective.seconds = mechanic.params.seconds;
      applied.push(`objective.seconds set to ${String(mechanic.params.seconds)} from timer`);
    }
    if (mechanic.id === 'switch' && Array.isArray(mechanic.params.switchRoles) && Array.isArray(mechanic.params.required)) {
      const all = mechanic.params.switchRoles as string[];
      const inside = (mechanic.params.required as string[]).filter((role) => all.includes(role));
      if (inside.length !== (mechanic.params.required as string[]).length) {
        mechanic.params.required = inside.length > 0 ? inside : all.slice(0, 1);
        applied.push('switch.required trimmed to switchRoles');
      }
    }
  }
}

function ensureWin(spec: Loose, applied: string[]): void {
  const archetype = archetypeOf(spec);
  if (archetype === null || !ARCHETYPES[archetype].allowedMechanics.includes('zone_trigger')) return;
  const mechanics = mechanicsOf(spec);
  const zone = mechanics.find((mechanic) => mechanic.id === 'zone_trigger');
  if (zone !== undefined) {
    zone.params.effect = 'win';
    zone.params.when = 'enter';
    applied.push('zone_trigger effect set to win');
    return;
  }
  const roles = rolesOf(spec);
  let exit = roles.find((role) => role.kind === 'exit' || role.kind === 'destination');
  if (exit === undefined) {
    exit = { id: roles.some((role) => role.id === 'exit') ? 'exit_zone' : 'exit', kind: 'exit', label: 'exit', count: 1 };
    spec.roles = [...roles, exit];
    applied.push(`added exit role ${exit.id}`);
  }
  spec.mechanics = [...mechanics, { id: 'zone_trigger', params: { role: exit.id, when: 'enter', effect: 'win' } }];
  applied.push(`added zone_trigger win on ${exit.id}`);
}

/** Keypoint z fixtury, která mechaniku ověřuje, s rolemi a čítači přepsanými na tenhle spec. */
export function keypointFor(spec: Loose, mechanic: LooseMechanic): VerificationAssertion | null {
  const id = mechanic.id as MechanicId;
  const player = rolesOf(spec).find((role) => role.kind === 'player')?.id ?? 'player';
  for (const template of TEMPLATES) {
    const source = template.mechanics.find((m) => m.id === id);
    const assertion = template.verification.find((v) => v.kind === 'keypoint' && v.mechanic === id);
    if (source === undefined || assertion === undefined) continue;
    const registered = MECHANICS[id] as MechanicEntry<unknown>;
    const params = registered.params.safeParse(mechanic.params);
    if (!params.success) return null;
    const map = new Map<string, string>([[template.roles.find((role) => role.kind === 'player')?.id ?? 'player', player]]);
    const from = registered.roleRefs(source.params);
    const to = registered.roleRefs(params.data);
    from.forEach(([, role], index) => map.set(role, to[index]?.[1] ?? role));
    const counterFrom = (source.params as Loose).counter;
    const counterTo = mechanic.params.counter;
    if (typeof counterFrom === 'string' && typeof counterTo === 'string') map.set(counterFrom, counterTo);
    const rename = (key: string): string => map.get(key) ?? key;
    // Čítače šablony stojí na jejím počtu (4 → 5); přepočítají se na počet tohohle specu.
    const fromCount = (source.params as Loose).count;
    const toCount = mechanic.params.count;
    const recount = (value: number): number =>
      typeof fromCount === 'number' && typeof toCount === 'number' && (value === fromCount || value === fromCount - 1) ? toCount - (fromCount - value) : value;
    const remap = <T>(record: Record<string, T> | undefined): Record<string, T> | undefined =>
      record === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(record).map(([key, value]) => [rename(key), typeof value === 'string' ? (rename(value) as T) : typeof value === 'number' ? (recount(value) as T) : value]),
          );
    const copy = JSON.parse(JSON.stringify(assertion)) as VerificationAssertion;
    const existing = new Set((Array.isArray(spec.verification) ? spec.verification : []).map((v) => (isRecord(v) ? v.id : undefined)));
    const result: VerificationAssertion = {
      ...copy,
      id: existing.has(copy.id) ? `${copy.id}_${id}` : copy.id,
      setup: copy.setup === undefined ? undefined : { ...copy.setup, counters: remap(copy.setup.counters), entityStates: remap(copy.setup.entityStates), locked: remap(copy.setup.locked), placeAt: remap(copy.setup.placeAt) },
      actions: copy.actions?.map((action) => ({ ...action, target: rename(action.target) })),
      assert: { ...copy.assert, counters: remap(copy.assert.counters), entityStates: remap(copy.assert.entityStates), locked: remap(copy.assert.locked) },
    };
    return JSON.parse(JSON.stringify(result)) as VerificationAssertion;
  }
  // Bez šablony aspoň důkaz, že pravidlo mechaniky vystřelí.
  return { id: `${id}_fires`, kind: 'keypoint', mechanic: id, ticks: 30, assert: { firedMechanics: [id] } };
}

function ensureVerified(spec: Loose, applied: string[]): void {
  const verification = Array.isArray(spec.verification) ? spec.verification : [];
  const verified = new Set(verification.map((v) => (isRecord(v) ? v.mechanic : undefined)));
  for (const mechanic of mechanicsOf(spec)) {
    if (verified.has(mechanic.id)) continue;
    const keypoint = keypointFor(spec, mechanic);
    if (keypoint === null) continue;
    verification.push(keypoint);
    applied.push(`added keypoint for ${mechanic.id}`);
  }
  spec.verification = verification;
}

function simplify(spec: Loose, applied: string[]): void {
  const archetype = archetypeOf(spec);
  if (archetype === null) return;
  const required = ARCHETYPES[archetype].requiredMechanics as readonly string[];
  let mechanics = mechanicsOf(spec);
  while (mechanics.length > 4) {
    const index = mechanics.map((m) => m.id).lastIndexOf(mechanics.filter((m) => !required.includes(m.id)).at(-1)?.id ?? '');
    if (index < 0) break;
    applied.push(`dropped ${mechanics[index].id} (too complex)`);
    dropVerificationOf(spec, mechanics[index].id);
    mechanics = mechanics.filter((_, i) => i !== index);
  }
  spec.mechanics = mechanics;
  const referenced = new Set<string>();
  for (const mechanic of mechanics) {
    const registered = MECHANICS[mechanic.id as MechanicId] as MechanicEntry<unknown>;
    const params = registered.params.safeParse(mechanic.params);
    if (params.success) for (const [, role] of registered.roleRefs(params.data)) referenced.add(role);
  }
  let roles = rolesOf(spec);
  while (roles.length > 12) {
    const index = roles.map((role) => !referenced.has(role.id) && role.kind !== 'player').lastIndexOf(true);
    if (index < 0) break;
    applied.push(`dropped role ${roles[index].id} (too complex)`);
    roles = roles.filter((_, i) => i !== index);
  }
  spec.roles = roles;
}

export interface DeterministicRepair {
  readonly spec: GameSpecV1;
  readonly applied: readonly string[];
}

/**
 * Tabulka nález → oprava. `issues` je buď důvod čtečky nad surovým tělem,
 * nebo nálezy kritika nad platným specem. `null` = nic se nepodařilo.
 */
export function repairDeterministically(spec: unknown, issues: readonly CriticIssue[] | DirectorReadReason): DeterministicRepair | null {
  if (!isRecord(spec)) return null;
  const work = JSON.parse(JSON.stringify(spec)) as Loose;
  const applied: string[] = [];
  const codes = new Set(typeof issues === 'string' ? [issues] : issues.map((issue) => issue.code));

  if (codes.has('WRONG_DOCUMENT') || codes.has('NOT_AN_OBJECT')) return null;
  if (codes.has('MECHANIC_REJECTED') || codes.has('MALFORMED_SPEC')) {
    if (!fixMechanics(work, applied)) return null;
  }
  if (typeof issues !== 'string' && issues.some((issue) => issue.code === 'UNSUPPORTED' && issue.severity === 'block')) dropUnread(work, applied);
  if (codes.has('DANGLING_REFERENCE')) ensurePlayer(work, applied);
  if (codes.has('BUDGET_EXCEEDED') && !fitBudget(work, 1, applied)) return null;
  if (codes.has('BUDGET') && !fitBudget(work, 0.8, applied)) return null;
  if (codes.has('NO_TERMINATION') || codes.has('NO_AGENCY')) ensureWin(work, applied);
  if (codes.has('CONTRADICTION')) syncObjective(work, applied);
  if (codes.has('TOO_COMPLEX')) simplify(work, applied);
  if (codes.has('UNFAIR_SPAWN')) {
    const chaser = mechanicsOf(work).find((mechanic) => mechanic.id === 'chaser');
    if (chaser !== undefined) {
      chaser.params.speed = 'normal';
      applied.push('chaser speed set to normal');
    }
  }
  if (codes.has('DEAD_TIME')) {
    work.targetDurationSec = 120;
    applied.push('targetDurationSec set to 120');
  }
  if (codes.has('GOAL_UNCLEAR') && isRecord(work.tutorial) && isRecord(work.objective) && typeof work.objective.description === 'string') {
    if (work.tutorial.goalLine === work.title) {
      work.tutorial.goalLine = work.objective.description.slice(0, 80);
      applied.push('goalLine rewritten from the objective');
    }
  }
  // Po každé opravě může chybět důkaz mechaniky; doplňuje se vždy, i bez nálezu.
  ensureVerified(work, applied);
  // Sražené počty musí zůstat v souladu s cílem, jinak by kritik vrátil CONTRADICTION.
  syncObjective(work, applied);

  if (applied.length === 0) return null;
  const result = readGameSpec(work);
  return result.ok ? { spec: result.value, applied } : null;
}

const REPAIR_ANSWER_LINE =
  'Answer with a JSON array of RFC 6902 operations ({"op":"replace"|"add"|"remove","path":"/json/pointer","value":...}) and nothing else. Never touch /schema. Keep every field the issues do not mention.';

export function buildRepairRequest(spec: GameSpecV1, issues: readonly CriticIssue[]): UpstreamRequest {
  return {
    model: EMISSION_MODEL,
    system: [REPAIR_RULES, REPAIR_ANSWER_LINE, renderRegistry()].join('\n\n'),
    user: `SPEC:\n${JSON.stringify(spec)}\n\nISSUES:\n${JSON.stringify(issues.map(({ code, path, evidence, repairHint }) => ({ code, path, evidence, repairHint })))}`,
  };
}

export type RepairAnswerReason = 'NOT_AN_ARRAY' | 'BAD_OPERATION' | 'SCHEMA_TOUCHED' | 'PATCH_FAILED' | GameSpecReason;

const OPERATIONS = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test']);

export function applyRepairAnswer(spec: GameSpecV1, body: unknown): { ok: true; spec: GameSpecV1 } | { ok: false; reason: RepairAnswerReason; detail: string } {
  if (!Array.isArray(body)) return { ok: false, reason: 'NOT_AN_ARRAY', detail: `answer is ${typeof body}` };
  for (const operation of body) {
    if (!isRecord(operation) || typeof operation.op !== 'string' || !OPERATIONS.has(operation.op) || typeof operation.path !== 'string') {
      return { ok: false, reason: 'BAD_OPERATION', detail: JSON.stringify(operation).slice(0, 120) };
    }
    const paths = [operation.path, ...(typeof operation.from === 'string' ? [operation.from] : [])];
    const touched = paths.some((path) => path === '/schema' || path === '' || path === '/');
    if (touched) return { ok: false, reason: 'SCHEMA_TOUCHED', detail: operation.path };
  }
  const work = JSON.parse(JSON.stringify(spec)) as unknown;
  const errors = applyPatch(work, body as Operation[]);
  const failed = errors.findIndex((error) => error !== null);
  if (failed >= 0) return { ok: false, reason: 'PATCH_FAILED', detail: `operation ${String(failed)}: ${errors[failed]?.message ?? 'failed'}` };
  const result = readGameSpec(work);
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.issues.join('; ') };
  return { ok: true, spec: result.value };
}
