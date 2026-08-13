/**
 * Povrchový slovník korpusu → tři IR primitiva.
 *
 * **Jediné místo, které zná sémantiku události, je `lowerEvent` v `lower.ts`.**
 * Tenhle soubor povrchové tvary jen *rozkládá* na jednu nebo víc
 * `SurfaceEventSpec` a spojuje je disjunkcí. Druhá tabulka sémantiky by byla
 * přesně ten kruhový oracle, kvůli kterému vzniklo T8b: dvě ručně psané tabulky,
 * které se shodnou spolu navzájem a s `DESIGN-BOOK.md` §5 ne.
 *
 * Rozklad je nutný, protože zmrazený korpus a signatury §5 nemají tentýž tvar:
 * `onPickup` je v korpusu klíčovaný **rolí** (`{role:"collectible"}`), zatímco
 * §5 ho podepisuje jako `onPickup(item)`. Kanonickým vstupem sběru je akce
 * `pickup` proti té entitě, takže snížení na `hasItem` by čekalo na `giveItem`,
 * které v C01 žádné pravidlo nedělá — svět by se jevil jako nevyhratelný a vina
 * by padla na model.
 *
 * **Cíl kanonické akce musí být entita.** `PULSE_FACTS.acted` má třetí argument
 * jako `entityOrNone` a `validateIrDoc` ho rozpouští, takže vstup mířící na
 * soket (`{actionId:"moveTo", target:"k1"}`) v IR pojmenovat nejde. Verifikátor
 * ho na vstupní hranici jako dosažitelný uzná (`witness.ts:114`), ale žádné
 * pravidlo ho nemůže pozorovat. Není to opomenutí, je to hranice `world-ir-v1`
 * a je tu napsaná, ne obejitá.
 */

import { NodeTable, type SurfaceEventSpec } from './lower';
import {
  MAX_OPERANDS,
  NO_TARGET,
  type CompareOp,
  type EntityDecl,
  type IrEffect,
  type IrRule,
  type NodeIndex,
  type PredicateDecl,
  type SlotDecl,
  type SurfaceEventName,
} from './types';

// ---------------------------------------------------------------------------
// Čtení povrchu — je to vstup zvenčí, takže se nic nepředpokládá
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * Kanonický zápis indexu inventárního slotu.
 *
 * Korpus adresuje sloty číslem (`{slot: 0}`), ale `ID_PATTERN` žádá jméno
 * začínající písmenem — `"0"` by neprošlo schématem ani jako `SlotDecl.id`, ani
 * jako argument faktu `hasItem`.
 */
export function slotId(index: unknown): string | null {
  const parsed = asInt(index);
  return parsed === null || parsed < 0 ? null : `slot${parsed}`;
}

/**
 * Operátory korpusu proti `CompareOp`.
 *
 * Korpus píše rovnost jako `==` (C05 `countInZone`), IR jako `=`. `!=` vlastní
 * uzel nemá a skládá se jako `not(compare '=')`.
 */
const COMPARE_ALIASES: Readonly<Record<string, CompareOp>> = {
  '=': '=',
  '==': '=',
  '===': '=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
};

// ---------------------------------------------------------------------------
// Prostor
// ---------------------------------------------------------------------------

export interface Zones {
  /** Běhové zóny: jméno → jeden obdélník. */
  readonly rects: Record<string, readonly [number, number, number, number]>;
  /** Povrchové jméno zóny → běhová jména, na která se rozložilo. */
  readonly aliases: ReadonlyMap<string, readonly string[]>;
}

/**
 * Soketový prostor korpusu: `sim.sockets` sjednocené se `state.zones`.
 *
 * Dvě systémové vazby v jedné funkci, obě vynucené korpusem:
 *
 * 1. **Soket je zóna.** `onEnterZone(player, exit)` míří na jméno, které je
 *    soketem, ne deklarovanou zónou — `references.ts:163` proto socketový prostor
 *    skládá ze `sim.sockets` sjednocených se `state.zones`. Kdyby se rozpouštění
 *    lišilo mezi kontrolou odkazů a snížením, jedno z nich by lhalo.
 * 2. **Zóna o víc obdélnících se rozloží.** `SpaceDecl.zones` drží jeden
 *    obdélník na jméno, korpus jich má až tři (`lit`, `plates`). Rozklad je
 *    `jmeno`, `jmeno.r1`, … a `inZone` nad nimi je `anyOf`. Ohraničující obdélník
 *    by byl tišší, ale změnil by význam: `lit` by pokrylo i neosvětlené buňky
 *    mezi svými dvěma ostrovy.
 */
export function buildZones(
  sockets: Readonly<Record<string, readonly [number, number]>>,
  declared: unknown,
): Zones {
  const rects: Record<string, readonly [number, number, number, number]> = {};
  const aliases = new Map<string, string[]>();

  for (const [name, cell] of Object.entries(sockets)) {
    rects[name] = [cell[0], cell[1], 1, 1];
    aliases.set(name, [name]);
  }

  for (const [name, value] of Object.entries(asRecord(declared))) {
    const list = asArray(value);
    const names = aliases.get(name) ?? [];
    for (let i = 0; i < list.length; i += 1) {
      const rect = asArray(list[i]).map(asInt);
      if (rect.length !== 4 || rect.includes(null)) continue;
      // Holé jméno smí obsadit jen obdélník, který nepřepíše soket téhož jména —
      // jinak by deklarovaná zóna soket tiše nahradila a `moveTo` by mířilo jinam.
      const runtimeName = i === 0 && !(name in rects) ? name : `${name}.r${i}`;
      rects[runtimeName] = rect as [number, number, number, number];
      names.push(runtimeName);
    }
    aliases.set(name, names);
  }

  return { rects, aliases };
}

// ---------------------------------------------------------------------------
// Akumulátor snížení
// ---------------------------------------------------------------------------

export class Builder {
  readonly table = new NodeTable();
  readonly slots: SlotDecl[] = [];
  readonly entities: EntityDecl[] = [];
  readonly predicates: PredicateDecl[] = [];
  readonly effects: IrEffect[] = [];
  readonly rules: IrRule[] = [];
  readonly issues: string[] = [];
  /** Výraz → `predicateId`, aby dvě pravidla nad touž událostí sdílela predikát. */
  private readonly predicateByExpr = new Map<string, string>();

  fail(message: string): void {
    this.issues.push(message);
  }

  literal(value: number | boolean | string): NodeIndex {
    return this.table.add({ kind: 'literal', value });
  }

  /**
   * Spojí výrazy disjunkcí. Jeden operand se vrací sám — `anyOf` nad jediným
   * prvkem by byl uzel navíc a `MAX_OPERANDS` je těsný strop, ne rezerva.
   */
  anyOf(operands: readonly NodeIndex[], where: string): NodeIndex | null {
    if (operands.length === 0) {
      this.fail(`${where}: nothing to observe — the disjunction is empty`);
      return null;
    }
    if (operands.length === 1) return operands[0];
    if (operands.length > MAX_OPERANDS) {
      this.fail(`${where}: ${operands.length} operands is above MAX_OPERANDS ${MAX_OPERANDS}`);
      return null;
    }
    return this.table.add({ kind: 'anyOf', operands });
  }

  /**
   * Zaregistruje predikát pod stabilním jménem a vrátí ho.
   *
   * Dvě pravidla nad touž událostí musí sdílet jeden predikát: `validateIrDoc`
   * odmítá duplicitní `predicateId`, a dva predikáty nad týmž výrazem by byly
   * dvě jména pro jednu věc.
   */
  predicate(preferredId: string, source: SurfaceEventName, expr: NodeIndex): string {
    const key = `${source}#${expr}`;
    const existing = this.predicateByExpr.get(key);
    if (existing !== undefined) return existing;

    let id = preferredId;
    let suffix = 1;
    while (this.predicates.some((declared) => declared.predicateId === id)) {
      id = `${preferredId}.${suffix}`;
      suffix += 1;
    }
    this.predicates.push({ predicateId: id, source, expr });
    this.predicateByExpr.set(key, id);
    return id;
  }

  effect(effect: IrEffect): number {
    this.effects.push(effect);
    return this.effects.length - 1;
  }
}

/** Deklarace, proti kterým se povrchová jména rozpouštějí. */
export interface World {
  readonly actor: string | null;
  readonly entityIds: readonly string[];
  readonly rolesById: ReadonlyMap<string, string>;
  readonly socketOf: ReadonlyMap<string, string>;
  readonly zones: Zones;
  readonly inventorySlots: readonly string[];
}

export function entitiesWithRole(world: World, role: string): string[] {
  return world.entityIds.filter((id) => world.rolesById.get(id) === role);
}

// ---------------------------------------------------------------------------
// Události
// ---------------------------------------------------------------------------

/**
 * Povrchová událost → jeden nebo víc `SurfaceEventSpec`.
 *
 * `null` znamená tvar, který `world-ir-v1` nevyjádří — nikdy prázdný seznam,
 * protože ten by z nespustitelného pravidla udělal ticho.
 */
export function expandEvent(
  event: Record<string, unknown>,
  world: World,
  builder: Builder,
): SurfaceEventSpec[] | null {
  const kind = asString(event.kind);
  const actor = world.actor;

  switch (kind) {
    case 'onStart':
      return [{ event: 'onStart' }];

    case 'onClick': {
      const entity = asString(event.entity) ?? asString(event.target);
      return entity === null ? null : [{ event: 'onClick', entity }];
    }

    case 'onEnterZone':
    case 'onExitZone': {
      const entity = asString(event.entity) ?? actor;
      const zone = asString(event.zone);
      if (entity === null || zone === null) return null;
      const names = world.zones.aliases.get(zone);
      if (names === undefined || names.length === 0) {
        builder.fail(`event ${kind}: zone ${zone} resolves to no rectangle`);
        return null;
      }
      return names.map((name): SurfaceEventSpec => ({ event: kind, entity, zone: name }));
    }

    case 'onCollide': {
      const a = asString(event.a);
      const b = asString(event.b);
      return a === null || b === null ? null : [{ event: 'onCollide', a, b }];
    }

    case 'onPickup': {
      if (actor === null) return null;
      const role = asString(event.role);
      const named = asString(event.entity) ?? asString(event.item) ?? asString(event.target);
      const targets = named !== null ? [named] : role !== null ? entitiesWithRole(world, role) : [];
      if (targets.length === 0) {
        builder.fail(`event onPickup: no entity matches role ${String(role)}`);
        return null;
      }
      return targets.map((target): SurfaceEventSpec => ({ event: 'onAction', actor, actionId: 'pickup', target }));
    }

    case 'onDrop': {
      const item = asString(event.item);
      const socket = asString(event.socket);
      if (item !== null && socket !== null) return [{ event: 'onDrop', item, socket }];
      const target = asString(event.entity) ?? asString(event.target);
      if (actor === null || target === null) return null;
      return [{ event: 'onAction', actor, actionId: 'drop', target }];
    }

    case 'onTimerEnd': {
      const timer = asString(event.timer) ?? asString(event.ref);
      return timer === null ? null : [{ event: 'onTimerEnd', timer }];
    }

    case 'onCounterReaches': {
      const counter = asString(event.ref) ?? asString(event.counter);
      const n = asInt(event.threshold) ?? asInt(event.n);
      return counter === null || n === null ? null : [{ event: 'onCounterReaches', counter, n }];
    }

    case 'onStateEnter': {
      const entity = asString(event.entity) ?? asString(event.target);
      const state = asString(event.state) ?? asString(event.value);
      return entity === null || state === null ? null : [{ event: 'onStateEnter', entity, state }];
    }

    case 'onSignal': {
      const name = asString(event.name) ?? asString(event.signal);
      return name === null ? null : [{ event: 'onSignal', name }];
    }

    case 'onSeen': {
      const agent = asString(event.agent);
      const target = asString(event.target);
      return agent === null || target === null ? null : [{ event: 'onSeen', agent, target }];
    }

    case 'onAction': {
      const who = asString(event.actor) ?? actor;
      const actionId = asString(event.actionId);
      if (who === null || actionId === null) return null;
      const target = asString(event.target);
      if (target !== null) return [{ event: 'onAction', actor: who, actionId, target }];
      // Bez cíle je to „ta akce proti čemukoli". Rozsah je konečný a deklarovaný:
      // kanonický zástupce za nepřítomný cíl plus každá entita. Sokety mezi nimi
      // nejsou — `acted` je má jako `entityOrNone` a osiřelý argument by shodil
      // `validateIrDoc`.
      return [NO_TARGET, ...world.entityIds].map(
        (each): SurfaceEventSpec => ({ event: 'onAction', actor: who, actionId, target: each }),
      );
    }

    case 'onCommandComplete': {
      const entity = asString(event.entity) ?? asString(event.target);
      const commandId = asString(event.commandId);
      if (entity === null || commandId === null) return null;
      // `result` korpus neuvádí. Kanonický výsledek je `done`; jiné výsledky
      // nemá v P1 kdo vyrobit, protože příkazovou choreografii staví až P5.
      return [{ event: 'onCommandComplete', entity, commandId, result: asString(event.result) ?? 'done' }];
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Podmínky
// ---------------------------------------------------------------------------

export function lowerCondition(value: unknown, world: World, builder: Builder, where: string): NodeIndex | null {
  const node = asRecord(value);
  const kind = asString(node.kind);
  if (kind === null) {
    builder.fail(`${where}: condition has no kind`);
    return null;
  }

  const compareTo = (lhs: NodeIndex, rawOp: unknown, rhs: NodeIndex): NodeIndex | null => {
    const raw = asString(rawOp) ?? '=';
    if (raw === '!=' || raw === '!==') {
      const equal = builder.table.add({ kind: 'compare', lhs, op: '=', rhs });
      return builder.table.add({ kind: 'not', operand: equal });
    }
    const op = COMPARE_ALIASES[raw];
    if (op === undefined) {
      builder.fail(`${where}: unknown comparison operator ${raw}`);
      return null;
    }
    return builder.table.add({ kind: 'compare', lhs, op, rhs });
  };

  switch (kind) {
    case 'counterIs': {
      const slot = asString(node.ref) ?? asString(node.counter);
      const rhs = asInt(node.value);
      if (slot === null || rhs === null) break;
      return compareTo(builder.table.add({ kind: 'ref', ref: { space: 'counter', slot } }), node.op, builder.literal(rhs));
    }

    case 'flagIs': {
      const slot = asString(node.ref) ?? asString(node.flag);
      if (slot === null) break;
      return compareTo(
        builder.table.add({ kind: 'ref', ref: { space: 'flag', slot } }),
        '=',
        builder.literal(node.value !== false),
      );
    }

    case 'timerRunning': {
      const slot = asString(node.ref) ?? asString(node.timer);
      if (slot === null) break;
      return builder.table.add({
        kind: 'compare',
        lhs: builder.table.add({ kind: 'ref', ref: { space: 'timer', slot } }),
        op: '>',
        rhs: builder.literal(0),
      });
    }

    case 'stateIs': {
      const entity = asString(node.target) ?? asString(node.entity);
      const state = asString(node.value) ?? asString(node.state);
      if (entity === null || state === null) break;
      return compareTo(
        builder.table.add({ kind: 'ref', ref: { space: 'entityState', entity } }),
        '=',
        builder.literal(state),
      );
    }

    case 'lockedIs': {
      const entity = asString(node.target) ?? asString(node.entity);
      if (entity === null) break;
      return compareTo(
        builder.table.add({ kind: 'ref', ref: { space: 'locked', entity } }),
        '=',
        builder.literal(node.value !== false && node.locked !== false),
      );
    }

    case 'inZone': {
      const entity = asString(node.entity) ?? world.actor;
      const zone = asString(node.zone);
      if (entity === null || zone === null) break;
      const operands = (world.zones.aliases.get(zone) ?? []).map((name) =>
        builder.table.add({ kind: 'ref', ref: { space: 'observed', fact: 'inZone', args: [entity, name] } }),
      );
      return builder.anyOf(operands, `${where}: inZone ${zone}`);
    }

    case 'hasItem': {
      const slot = slotId(node.slot);
      const item = asString(node.item);
      if (slot === null || item === null) break;
      return builder.table.add({ kind: 'ref', ref: { space: 'observed', fact: 'hasItem', args: [slot, item] } });
    }

    case 'countInZone': {
      const zone = asString(node.zone);
      const tag = asString(node.tag);
      const rhs = asInt(node.value);
      if (zone === null || tag === null || rhs === null) break;
      const names = world.zones.aliases.get(zone) ?? [];
      if (names.length !== 1) {
        // `query` počítá nad JEDNÍM obdélníkem a IR nemá sčítání, takže agregace
        // přes rozloženou zónu se vyjádřit nedá. Ohraničující obdélník by počítal
        // i entity mimo zónu — tichá odpověď na otázku, na kterou tahle
        // reprezentace odpověď nemá, je horší než pojmenovaná mezera.
        builder.fail(
          `${where}: countInZone over ${zone} spans ${names.length} rectangles and world-ir-v1 has no summation`,
        );
        return null;
      }
      return compareTo(
        builder.table.add({ kind: 'query', query: 'countInZone', zone: names[0], tag }),
        node.op,
        builder.literal(rhs),
      );
    }

    case 'allOf':
    case 'anyOf': {
      const operands = asArray(node.operands ?? node.of ?? node.clauses)
        .map((child, index) => lowerCondition(child, world, builder, `${where}.${kind}[${index}]`))
        .filter((index): index is NodeIndex => index !== null);
      if (operands.length === 0) {
        builder.fail(`${where}: ${kind} has no usable operands`);
        return null;
      }
      if (operands.length === 1) return operands[0];
      if (operands.length > MAX_OPERANDS) {
        builder.fail(`${where}: ${kind} has ${operands.length} operands, above MAX_OPERANDS`);
        return null;
      }
      return builder.table.add({ kind, operands });
    }

    case 'not': {
      const operand = lowerCondition(node.operand ?? node.of, world, builder, `${where}.not`);
      return operand === null ? null : builder.table.add({ kind: 'not', operand });
    }

    default:
      builder.fail(`${where}: unknown condition ${kind}`);
      return null;
  }

  builder.fail(`${where}: condition ${kind} is missing a required argument`);
  return null;
}

// ---------------------------------------------------------------------------
// Akce
// ---------------------------------------------------------------------------

export function lowerAction(
  action: Record<string, unknown>,
  timers: ReadonlyMap<string, number>,
  builder: Builder,
  where: string,
): IrEffect | null {
  const kind = asString(action.kind);
  switch (kind) {
    case 'setState': {
      const entity = asString(action.target) ?? asString(action.entity);
      const state = asString(action.value) ?? asString(action.state);
      if (entity === null || state === null) break;
      return { op: 'assign', ref: { space: 'entityState', entity }, value: builder.literal(state) };
    }
    case 'setLocked': {
      const entity = asString(action.target) ?? asString(action.entity);
      if (entity === null) break;
      return {
        op: 'assign',
        ref: { space: 'locked', entity },
        value: builder.literal(action.locked === true || action.value === true),
      };
    }
    case 'setFlag': {
      const slot = asString(action.ref) ?? asString(action.flag);
      if (slot === null) break;
      return { op: 'assign', ref: { space: 'flag', slot }, value: builder.literal(action.value !== false) };
    }
    case 'addCounter': {
      const slot = asString(action.ref) ?? asString(action.counter);
      const delta = asInt(action.by) ?? asInt(action.delta);
      if (slot === null || delta === null) break;
      return { op: 'addCounter', slot, delta };
    }
    case 'startTimer': {
      const slot = asString(action.ref) ?? asString(action.timer);
      if (slot === null) break;
      // Trvání nese **deklarace časovače**, ne akce: korpus píše `startTimer`
      // bez parametru a `state.timers.<id>.durationTicks` je to jediné číslo,
      // které o délce něco tvrdí.
      const declared = asInt(action.durationTicks) ?? timers.get(slot) ?? null;
      if (declared === null || declared < 1) break;
      return { op: 'startTimer', slot, durationTicks: declared };
    }
    case 'stopTimer': {
      const slot = asString(action.ref) ?? asString(action.timer);
      if (slot === null) break;
      return { op: 'stopTimer', slot };
    }
    case 'spawn': {
      const poolTag = asString(action.poolTag) ?? asString(action.tag);
      const socket = asString(action.socket);
      if (poolTag === null || socket === null) break;
      return { op: 'spawn', poolTag, socket, selection: 'lowest-inactive' };
    }
    case 'despawn': {
      const entity = asString(action.target) ?? asString(action.entity);
      if (entity === null) break;
      return { op: 'despawn', entity };
    }
    case 'moveTo': {
      const entity = asString(action.target) ?? asString(action.entity);
      const socket = asString(action.socket);
      const ticks = asInt(action.ticks);
      if (entity === null || socket === null || ticks === null || ticks < 1) break;
      return { op: 'moveTo', entity, socket, ticks };
    }
    case 'freeze': {
      const entity = asString(action.target) ?? asString(action.entity);
      const ticks = asInt(action.ticks);
      if (entity === null || ticks === null || ticks < 1) break;
      return { op: 'freeze', entity, ticks };
    }
    case 'giveItem':
    case 'takeItem': {
      const slot = slotId(action.slot);
      const item = asString(action.item);
      if (slot === null || item === null) break;
      return { op: kind, slot, item };
    }
    case 'emit': {
      const signal = asString(action.signal) ?? asString(action.name);
      if (signal === null) break;
      return { op: 'emit', signal };
    }
    case 'playEffect': {
      const effectId = asString(action.id) ?? asString(action.effectId);
      if (effectId === null) break;
      return { op: 'playEffect', effectId, target: asString(action.target) };
    }
    case 'win':
      return { op: 'win' };
    case 'lose':
      return { op: 'lose' };
    default:
      builder.fail(`${where}: unknown action ${String(kind)}`);
      return null;
  }
  builder.fail(`${where}: action ${String(kind)} is missing a required argument`);
  return null;
}

// ---------------------------------------------------------------------------
// Symboly, které povrch deklaruje jen tím, že je používá
// ---------------------------------------------------------------------------

/**
 * Stavy entity nejsou v povrchu deklarované — plynou z toho, co je do nich
 * zapisuje a co se na ně ptá.
 *
 * `enumTable` v interpretu neznámý symbol tiše mapuje na `none`, takže
 * nesesbíraný stav by se zapsal jako `none` a stráž `stateIs` by přestala platit
 * beze stopy. Sbírá se proto obojí — zápisy i dotazy.
 */
export function collectStates(rules: readonly Record<string, unknown>[]): Map<string, Set<string>> {
  const states = new Map<string, Set<string>>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const node = asRecord(value);
    if (Object.keys(node).length === 0) return;
    const kind = asString(node.kind);
    if (kind === 'stateIs' || kind === 'setState' || kind === 'onStateEnter') {
      const entity = asString(node.target) ?? asString(node.entity);
      const symbol = asString(node.value) ?? asString(node.state);
      if (entity !== null && symbol !== null) {
        const set = states.get(entity) ?? new Set<string>();
        set.add(symbol);
        states.set(entity, set);
      }
    }
    for (const child of Object.values(node)) walk(child);
  };

  for (const rule of rules) {
    walk(rule.event);
    walk(rule.condition);
    walk(rule.actions);
  }
  return states;
}

/**
 * Položky podle slotu. Slot, o kterém dokument nikde nemluví, se nedeklaruje —
 * `slotSchema` žádá neprázdné `values` a vymýšlet je by byla deklarace bez opory.
 */
export function collectItems(rules: readonly Record<string, unknown>[]): Map<string, Set<string>> {
  const items = new Map<string, Set<string>>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const node = asRecord(value);
    if (Object.keys(node).length === 0) return;
    const kind = asString(node.kind);
    if (kind === 'hasItem' || kind === 'giveItem' || kind === 'takeItem') {
      const slot = slotId(node.slot);
      const item = asString(node.item);
      if (slot !== null && item !== null) {
        const set = items.get(slot) ?? new Set<string>();
        set.add(item);
        items.set(slot, set);
      }
    }
    for (const child of Object.values(node)) walk(child);
  };
  for (const rule of rules) {
    walk(rule.condition);
    walk(rule.actions);
  }
  return items;
}
