/**
 * Snížení **povrchové** části `sim` do běhové podoby, kterou čte verifikátor.
 *
 * Do T13 tahle cesta neexistovala: `lower.ts` umí snížit jednu událost, ale celý
 * dokument nikdo nesnižoval a všechny běhové fixtury byly ručně psané
 * `WorldDocRuntime`. Emisní endpoint ale musí vzít to, co model doopravdy vydal,
 * a protáhnout to až k replayi — jinak se AC „projde verifikátorem svědka" splnit
 * nedá a `evals/frozen/responses/` by zůstalo jen datovým souborem.
 *
 * Slovník vlastní `./surface`; tenhle soubor z něj skládá dokument, dopočítá meze
 * a přiloží svědka. **Systémová vazba pohybu** je tady, protože jako jediná
 * nevzniká z ničeho, co model napsal: `inputBoundary.practice` ve zmrazeném
 * protokolu říká *„pohyb je kvantizovaný po mřížce v souřadnicích `sim`"*, takže
 * je to povinnost runtimu, ne pravidlo, které má napsat model. Pro každou entitu
 * na deklarovaném soketu vzniká pravidlo `sys.moveTo.<entita>`, které kanonickou
 * akci `moveTo` promění v efekt `moveTo` na její soket.
 */

import type { SpaceDecl, TraceInput, WorldDocRuntime } from '../sim/interpreter';
import { TIER_POLICY, isTier, type CertificationRequest } from '../verify/tiers';
import { lowerEvent, predicateIdFor, type SurfaceEventSpec } from './lower';
import { validateIrDoc } from './schema';
import {
  Builder,
  asArray,
  asInt,
  asRecord,
  asString,
  buildZones,
  collectItems,
  collectStates,
  entitiesWithRole,
  expandEvent,
  lowerAction,
  lowerCondition,
  type World,
} from './surface';
import { IR_VERSION, type EntityDecl, type IrDoc, type NodeIndex } from './types';

/** Proč se dokument nepodařilo snížit. Je to verdikt, ne výjimka. */
export type BuildReason =
  /** Povrchový tvar neodpovídá kontraktu — chybí kontejner, jméno není řetězec. */
  | 'MALFORMED_SIM'
  /** Tvar, který `world-ir-v1` neumí vyjádřit. Pojmenovaná mezera, ne tichý no-op. */
  | 'UNSUPPORTED_SURFACE'
  /** Snížení proběhlo, ale výsledek neprošel `validateIrDoc`. */
  | 'INVALID_IR';

export interface BuildFailure {
  readonly ok: false;
  readonly reason: BuildReason;
  readonly issues: readonly string[];
}

export interface BuildSuccess {
  readonly ok: true;
  readonly world: WorldDocRuntime & { readonly certification: CertificationRequest };
}

export type BuildResult = BuildSuccess | BuildFailure;

/**
 * Strop spuštění na tik.
 *
 * Musí pokrýt každé pravidlo, které v jednom tiku spustí, **i** počet efektů
 * uvnitř jednoho pravidla — obě smyčky ve `step()` se omezují touž hodnotou.
 * Počet pravidel je horní mez obojího; šestnáctka je jen podlaha pro malé světy,
 * ať se rozpočet nedostane pod počet efektů, které jedno pravidlo unese.
 */
const MIN_FIRINGS_PER_TICK = 16;

/** Kanonické vstupy tiku plus signály z minulého tiku. */
const QUEUE_DEPTH = 64;

/**
 * Poolový tag entity: `spawn(poolTag)` i `countInZone(tag)` se ptají tímhle
 * jménem.
 *
 * Pool má přednost před rolí, protože ho korpus deklaruje výslovně
 * (`state.pool.<jméno> = { size, tag }`) a jeho členy pojmenovává prefixem
 * (`target0`, `cube0`). Kde pool není, je tagem role — tak se ptá C05
 * (`countInZone{tag:"agent"}`) a role je jediné, co o skupině entit povrch říká.
 */
function buildTags(
  entityIds: readonly string[],
  rolesById: ReadonlyMap<string, string>,
  pool: unknown,
): Record<string, string> {
  const pools = Object.entries(asRecord(pool)).map(([name, raw]) => ({
    name,
    tag: asString(asRecord(raw).tag) ?? name,
  }));
  const tags: Record<string, string> = {};
  for (const id of entityIds) {
    const member = pools.find((entry) => id.startsWith(entry.name));
    tags[id] = member?.tag ?? rolesById.get(id) ?? id;
  }
  return tags;
}

export function buildRuntimeWorld(sim: unknown): BuildResult {
  const part = asRecord(sim);
  const builder = new Builder();

  const layout = asRecord(part.layout);
  const gridWidth = asInt(layout.width);
  const gridHeight = asInt(layout.height);
  if (gridWidth === null || gridHeight === null || gridWidth < 1 || gridHeight < 1)
    return { ok: false, reason: 'MALFORMED_SIM', issues: ['layout has no positive integer width and height'] };

  const sockets: Record<string, readonly [number, number]> = {};
  for (const [name, cell] of Object.entries(asRecord(part.sockets))) {
    const pair = asArray(cell).map(asInt);
    if (pair.length !== 2 || pair[0] === null || pair[1] === null) continue;
    sockets[name] = [pair[0], pair[1]];
  }

  const state = asRecord(part.state);
  const zones = buildZones(sockets, state.zones);

  const timerDurations = new Map<string, number>();
  for (const [id, raw] of Object.entries(asRecord(state.counters))) {
    const decl = asRecord(raw);
    const min = asInt(decl.min) ?? 0;
    const max = asInt(decl.max);
    if (max === null) {
      builder.fail(`counter ${id} declares no integer max`);
      continue;
    }
    builder.slots.push({
      space: 'counter',
      id,
      min,
      max,
      initial: asInt(decl.init) ?? asInt(decl.initial) ?? min,
    });
  }
  for (const [id, raw] of Object.entries(asRecord(state.flags))) {
    const decl = asRecord(raw);
    builder.slots.push({
      space: 'flag',
      id,
      initial: raw === true || decl.init === true || decl.initial === true,
    });
  }
  for (const [id, raw] of Object.entries(asRecord(state.timers))) {
    const decl = asRecord(raw);
    const maxTicks = asInt(decl.durationTicks) ?? asInt(decl.max);
    if (maxTicks === null || maxTicks < 1) {
      builder.fail(`timer ${id} declares no positive durationTicks`);
      continue;
    }
    const initial = asInt(decl.init) ?? asInt(decl.initial) ?? 0;
    timerDurations.set(id, maxTicks);
    builder.slots.push({ space: 'timer', id, maxTicks, initial: Math.min(Math.max(initial, 0), maxTicks) });
  }

  const surfaceRules = Object.entries(asRecord(part.rules)).map(([key, value]) => ({ key, rule: asRecord(value) }));
  const ruleBodies = surfaceRules.map((entry) => entry.rule);
  const declaredStates = collectStates(ruleBodies);

  const entityIds: string[] = [];
  const rolesById = new Map<string, string>();
  const socketOf = new Map<string, string>();
  for (const [stableId, raw] of Object.entries(asRecord(part.entities))) {
    const decl = asRecord(raw);
    const role = asString(decl.role) ?? 'prop';
    const socket = asString(decl.socket) ?? '';
    const initialState = asString(decl.state) ?? asString(decl.initialState) ?? 'idle';
    entityIds.push(stableId);
    rolesById.set(stableId, role);
    socketOf.set(stableId, socket);
    const entity: EntityDecl = {
      stableId,
      role,
      socket,
      states: [...new Set<string>([initialState, ...(declaredStates.get(stableId) ?? [])])],
      initialState,
      initialLocked: decl.locked === true,
    };
    builder.entities.push(entity);
  }

  const actor = entityIds.find((id) => rolesById.get(id) === 'actor') ?? entityIds[0] ?? null;

  const inventorySlots: string[] = [];
  for (const [id, items] of [...collectItems(ruleBodies)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    inventorySlots.push(id);
    // `empty` je v `values` schválně, i když `enumTable` v interpretu svůj vlastní
    // `empty` stejně předsazuje: `validateIrDoc` žádá `values.includes(initial)`
    // a golden set (`V20`) tenhle tvar pinuje. Duplicita indexů je bezvýznamná —
    // obě čtou týž symbol.
    builder.slots.push({ space: 'inventory', id, values: ['empty', ...items], initial: 'empty' });
  }

  const world: World = { actor, entityIds, rolesById, socketOf, zones, inventorySlots };

  for (const { key, rule } of surfaceRules) {
    const where = `rule ${key}`;
    const specs = expandEvent(asRecord(rule.event), world, builder);
    if (specs === null) {
      builder.fail(`${where}: event ${String(asRecord(rule.event).kind)} has no lowering`);
      continue;
    }

    const lowered = specs.map((spec) => lowerEvent(spec, builder.table, world));
    const became = lowered[0].became;
    if (lowered.some((each) => each.became !== became)) {
      builder.fail(`${where}: expansion mixes rising and falling edges`);
      continue;
    }
    const expr = builder.anyOf(
      lowered.map((each) => each.expr),
      where,
    );
    if (expr === null) continue;

    const source = specs[0].event;
    const predicate = builder.predicate(
      specs.length === 1 ? predicateIdFor(specs[0]) : `p.${source}.${key}`,
      source,
      expr,
    );

    let guard: NodeIndex | null = null;
    if (rule.condition !== null && rule.condition !== undefined) {
      guard = lowerCondition(rule.condition, world, builder, `${where}.condition`);
      if (guard === null) continue;
    }

    const effects: number[] = [];
    const actions = asArray(rule.actions);
    for (let i = 0; i < actions.length; i += 1) {
      const effect = lowerAction(asRecord(actions[i]), timerDurations, builder, `${where}.actions[${i}]`);
      if (effect !== null) effects.push(builder.effect(effect));
    }
    if (effects.length === 0) {
      builder.fail(`${where}: no usable action`);
      continue;
    }

    builder.rules.push({
      ruleId: key,
      phase: asInt(rule.phase) ?? 0,
      priority: asInt(rule.priority) ?? 0,
      trigger: { kind: 'onEdge', predicate, became },
      guard,
      effects,
    });
  }

  if (actor !== null) {
    for (const target of entityIds) {
      const socket = socketOf.get(target);
      if (socket === undefined || !(socket in sockets)) continue;
      const spec: SurfaceEventSpec = { event: 'onAction', actor, actionId: 'moveTo', target };
      const { expr, became } = lowerEvent(spec, builder.table, world);
      builder.rules.push({
        ruleId: `sys.moveTo.${target}`,
        // Nejzazší priorita v nulté fázi. Efekt jen postaví příkaz pohybu, který
        // spotřebuje až `settle`, takže na pořadí vůči pravidlům modelu nezáleží
        // — a nejzazší priorita to říká nahlas místo aby se to tvářilo jako volba.
        phase: 0,
        priority: 255,
        trigger: { kind: 'onEdge', predicate: builder.predicate(predicateIdFor(spec), 'onAction', expr), became },
        guard: null,
        effects: [builder.effect({ op: 'moveTo', entity: actor, socket, ticks: 1 })],
      });
    }
  }

  if (builder.issues.length > 0) return { ok: false, reason: 'UNSUPPORTED_SURFACE', issues: builder.issues };

  const ir: IrDoc = {
    irVersion: IR_VERSION,
    limits: {
      maxEntities: Math.max(asInt(part.entityCap) ?? 0, builder.entities.length, 1),
      // Zóny jsou sokety plus deklarované obdélníky, takže jich bývá **víc než
      // entit** — proto vlastní mez, ne `maxEntities`. Viz `IrLimits.maxZones`.
      maxZones: Math.max(Object.keys(zones.rects).length, 1),
      maxSlots: Math.max(builder.slots.length, 1),
      maxRules: Math.max(builder.rules.length, 1),
      maxRuleFiringsPerTick: Math.max(MIN_FIRINGS_PER_TICK, builder.rules.length),
      maxQueueDepth: QUEUE_DEPTH,
      maxAgents: entitiesWithRole(world, 'agent').length,
      memorySlotsPerAgent: 0,
      gridWidth,
      gridHeight,
    },
    slots: builder.slots,
    entities: builder.entities,
    nodes: builder.table.list(),
    predicates: builder.predicates,
    effects: builder.effects,
    rules: builder.rules,
  };

  const validation = validateIrDoc(ir);
  if (!validation.ok) return { ok: false, reason: 'INVALID_IR', issues: validation.issues };

  const witness = asRecord(part.witness);
  const tier = asString(witness.tier);
  if (!isTier(tier))
    return { ok: false, reason: 'MALFORMED_SIM', issues: [`witness declares no known tier: ${String(tier)}`] };

  const trace: TraceInput[] = [];
  const ops = asArray(witness.ops);
  for (let i = 0; i < ops.length; i += 1) {
    const op = asRecord(ops[i]);
    const tick = asInt(op.tick);
    const actionId = asString(op.actionId);
    if (tick === null || actionId === null || actor === null)
      return {
        ok: false,
        reason: 'MALFORMED_SIM',
        issues: [`witness op ${i} has no tick or actionId, or the world declares no entity to perform it`],
      };
    const target = asString(op.target);
    trace.push(target === null ? { tick, actor, actionId } : { tick, actor, actionId, target });
  }

  const space: SpaceDecl = {
    sockets,
    zones: zones.rects,
    // Neprůchodné buňky povrch nedeklaruje; validátor layoutu je až P5 T505
    // (`knownGapsDuringP1`), takže se tu nic nedomýšlí.
    blocked: [],
    tags: buildTags(entityIds, rolesById, state.pool),
  };

  return {
    ok: true,
    world: {
      ir,
      space,
      trace,
      certification: {
        tier,
        // Horizont deklaruje SYSTÉM. `witness.H_cert` je přání dokumentu; přání
        // nad stropem tieru se podle protokolu odmítá jako `NO_FIT`, takže se sem
        // předává nezměněné a rozhodne `resolvePolicy`.
        horizonTicks: asInt(witness.H_cert) ?? TIER_POLICY[tier].maxHorizonTicks,
      },
    },
  };
}
