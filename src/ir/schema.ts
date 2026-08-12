import { z } from 'zod';

import {
  ASSIGNABLE_SPACES,
  BOOLEAN_SPACES,
  COMPARE_OPS,
  ID_PATTERN,
  IR_VERSION,
  NO_TARGET,
  OBSERVED_FACTS,
  PULSE_FACTS,
  SURFACE_EVENTS,
  SYMBOL_PATTERN,
  type ArgRole,
  type IrDoc,
  type IrNode,
  type ObservedFact,
  type PulseFact,
  type StateRef,
} from './types';

/**
 * Schéma je jen tvar. Vazby mezi indexy, jednoznačnost identifikátorů a typová
 * shoda operandů se schématem vyjádřit nedají — ty kontroluje `validateIrDoc`
 * hned za ním. Verdikt nad golden setem je vždycky výsledek obou.
 */

const identifier = z.string().regex(ID_PATTERN);
const symbol = z.string().regex(SYMBOL_PATTERN);
const boundedInt = z.int().min(-1_000_000).max(1_000_000);
const nodeIndex = z.int().min(0).max(4095);
const effectIndex = z.int().min(0).max(4095);

const observedFactName = z.enum(Object.keys(OBSERVED_FACTS) as [ObservedFact, ...ObservedFact[]]);
const pulseFactName = z.enum(Object.keys(PULSE_FACTS) as [PulseFact, ...PulseFact[]]);

const stateRefSchema = z.discriminatedUnion('space', [
  z.object({ space: z.literal('counter'), slot: identifier }).strict(),
  z.object({ space: z.literal('flag'), slot: identifier }).strict(),
  z.object({ space: z.literal('timer'), slot: identifier }).strict(),
  z.object({ space: z.literal('inventory'), slot: identifier }).strict(),
  z.object({ space: z.literal('memory'), agent: identifier, index: z.int().min(0).max(63) }).strict(),
  z.object({ space: z.literal('entityState'), entity: identifier }).strict(),
  z.object({ space: z.literal('locked'), entity: identifier }).strict(),
  z
    .object({ space: z.literal('observed'), fact: observedFactName, args: z.array(identifier).max(3) })
    .strict(),
  z
    .object({ space: z.literal('pulse'), fact: pulseFactName, args: z.array(identifier).max(3) })
    .strict(),
]);

const literalValueSchema = z.union([boundedInt, z.boolean(), symbol]);

/**
 * Plochá tabulka. Potomek je index, ne vnořený objekt — proto tu není jediné
 * rekurzivní odkázání a `cycles: "throw"` nemá na co narazit.
 */
const nodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: literalValueSchema }).strict(),
  z.object({ kind: z.literal('ref'), ref: stateRefSchema }).strict(),
  z
    .object({ kind: z.literal('query'), query: z.literal('countInZone'), zone: identifier, tag: identifier })
    .strict(),
  z.object({ kind: z.literal('compare'), lhs: nodeIndex, op: z.enum(COMPARE_OPS), rhs: nodeIndex }).strict(),
  z.object({ kind: z.literal('allOf'), operands: z.array(nodeIndex).min(1).max(16) }).strict(),
  z.object({ kind: z.literal('anyOf'), operands: z.array(nodeIndex).min(1).max(16) }).strict(),
  z.object({ kind: z.literal('not'), operand: nodeIndex }).strict(),
]);

const slotSchema = z.discriminatedUnion('space', [
  z
    .object({
      space: z.literal('counter'),
      id: identifier,
      min: boundedInt,
      max: boundedInt,
      initial: boundedInt,
    })
    .strict(),
  z.object({ space: z.literal('flag'), id: identifier, initial: z.boolean() }).strict(),
  z
    .object({
      space: z.literal('timer'),
      id: identifier,
      maxTicks: z.int().min(1).max(72_000),
      initial: z.int().min(0).max(72_000),
    })
    .strict(),
  z
    .object({
      space: z.literal('inventory'),
      id: identifier,
      values: z.array(symbol).min(1).max(32),
      initial: symbol,
    })
    .strict(),
  z
    .object({
      space: z.literal('memory'),
      id: identifier,
      agent: identifier,
      index: z.int().min(0).max(63),
      values: z.array(symbol).min(1).max(32),
      initial: symbol,
    })
    .strict(),
]);

const entitySchema = z
  .object({
    stableId: identifier,
    role: identifier,
    socket: identifier,
    states: z.array(symbol).min(1).max(16),
    initialState: symbol,
    initialLocked: z.boolean(),
  })
  .strict();

const predicateSchema = z
  .object({ predicateId: identifier, source: z.enum(SURFACE_EVENTS), expr: nodeIndex })
  .strict();

const effectSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('assign'), ref: stateRefSchema, value: nodeIndex }).strict(),
  z.object({ op: z.literal('addCounter'), slot: identifier, delta: boundedInt }).strict(),
  z
    .object({ op: z.literal('startTimer'), slot: identifier, durationTicks: z.int().min(1).max(72_000) })
    .strict(),
  z.object({ op: z.literal('stopTimer'), slot: identifier }).strict(),
  z
    .object({
      op: z.literal('spawn'),
      poolTag: identifier,
      socket: identifier,
      selection: z.literal('lowest-inactive'),
    })
    .strict(),
  z.object({ op: z.literal('despawn'), entity: identifier }).strict(),
  z
    .object({ op: z.literal('moveTo'), entity: identifier, socket: identifier, ticks: z.int().min(1).max(72_000) })
    .strict(),
  // `freeze` je v ticích. Pole `seconds` neexistuje, takže sekundová emise
  // neprojde schématem — je to jedna z tříd defektů zmrazených v T2.
  z.object({ op: z.literal('freeze'), entity: identifier, ticks: z.int().min(1).max(72_000) }).strict(),
  z.object({ op: z.literal('giveItem'), slot: identifier, item: symbol }).strict(),
  z.object({ op: z.literal('takeItem'), slot: identifier, item: symbol }).strict(),
  z.object({ op: z.literal('emit'), signal: identifier }).strict(),
  z.object({ op: z.literal('playEffect'), effectId: identifier, target: identifier.nullable() }).strict(),
  z.object({ op: z.literal('win') }).strict(),
  z.object({ op: z.literal('lose') }).strict(),
]);

const triggerSchema = z
  .object({ kind: z.literal('onEdge'), predicate: identifier, became: z.boolean() })
  .strict();

const ruleSchema = z
  .object({
    ruleId: identifier,
    phase: z.int().min(0).max(15),
    priority: z.int().min(0).max(255),
    trigger: triggerSchema,
    guard: nodeIndex.nullable(),
    effects: z.array(effectIndex).min(1).max(32),
  })
  .strict();

const limitsSchema = z
  .object({
    maxEntities: z.int().min(1).max(512),
    maxSlots: z.int().min(1).max(256),
    maxRules: z.int().min(1).max(512),
    maxRuleFiringsPerTick: z.int().min(1).max(4096),
    maxQueueDepth: z.int().min(1).max(1024),
    maxAgents: z.int().min(0).max(64),
    memorySlotsPerAgent: z.int().min(0).max(64),
    gridWidth: z.int().min(1).max(256),
    gridHeight: z.int().min(1).max(256),
  })
  .strict();

/**
 * Kořen IR. Vzhledová část dokumentu sem nevstupuje (§5) — nemá tu pole ani
 * variantu a její jediná vazba do simulace je `stableId` entity.
 */
export const worldIr = z
  .object({
    irVersion: z.literal(IR_VERSION),
    limits: limitsSchema,
    slots: z.array(slotSchema).max(256),
    entities: z.array(entitySchema).max(512),
    nodes: z.array(nodeSchema).max(4096),
    predicates: z.array(predicateSchema).max(512),
    effects: z.array(effectSchema).max(1024),
    rules: z.array(ruleSchema).max(512),
  })
  .strict();

// ---------------------------------------------------------------------------
// Strukturální kontrola indexů, vazeb a typů
// ---------------------------------------------------------------------------

export type ValueKind = 'bool' | 'number' | 'symbol';

export function refValueKind(ref: StateRef): ValueKind {
  if ((BOOLEAN_SPACES as readonly string[]).includes(ref.space)) return 'bool';
  if (ref.space === 'counter' || ref.space === 'timer') return 'number';
  return 'symbol';
}

export function nodeValueKind(nodes: readonly IrNode[], index: number): ValueKind {
  const node = nodes[index];
  switch (node.kind) {
    case 'literal':
      return typeof node.value === 'boolean' ? 'bool' : typeof node.value === 'number' ? 'number' : 'symbol';
    case 'ref':
      return refValueKind(node.ref);
    case 'query':
      return 'number';
    default:
      return 'bool';
  }
}

function childIndices(node: IrNode): number[] {
  switch (node.kind) {
    case 'compare':
      return [node.lhs, node.rhs];
    case 'allOf':
    case 'anyOf':
      return [...node.operands];
    case 'not':
      return [node.operand];
    default:
      return [];
  }
}

export interface IrValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/**
 * Ověří to, co schéma neumí: rozsah a monotonii indexů, existenci cílů, typovou
 * shodu operandů a jednoznačnost identifikátorů. Vrací **všechny** nálezy, ne
 * první — nevalidní dokument z golden setu se pozná podle důvodu, ne podle
 * pouhého selhání.
 */
export function validateIrDoc(input: unknown): IrValidation {
  const parsed = worldIr.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `schema:/${issue.path.join('/')}: ${issue.message}`),
    };
  }

  const doc = parsed.data as IrDoc;
  const issues: string[] = [];
  const fail = (message: string) => issues.push(message);

  const duplicates = (values: readonly string[]) =>
    values.filter((value, position) => values.indexOf(value) !== position);

  for (const id of duplicates(doc.slots.map((slot) => slot.id))) fail(`duplicate slot id: ${id}`);
  for (const id of duplicates(doc.entities.map((entity) => entity.stableId)))
    fail(`duplicate stableId: ${id}`);
  for (const id of duplicates(doc.predicates.map((predicate) => predicate.predicateId)))
    fail(`duplicate predicateId: ${id}`);
  for (const id of duplicates(doc.rules.map((rule) => rule.ruleId))) fail(`duplicate ruleId: ${id}`);

  const orderKeys = doc.rules.map((rule) => `${rule.phase}/${rule.priority}/${rule.ruleId}`);
  for (const key of duplicates(orderKeys)) fail(`ambiguous execution order: ${key}`);

  if (doc.entities.length > doc.limits.maxEntities) fail('entity count above limits.maxEntities');
  // Fáze `sense` prochází všechny sloty, takže bez téhle kontroly je `maxSlots`
  // jen deklarace, kterou runtime nemá o co opřít.
  if (doc.slots.length > doc.limits.maxSlots) fail('slot count above limits.maxSlots');
  if (doc.rules.length > doc.limits.maxRules) fail('rule count above limits.maxRules');

  const slotsById = new Map(doc.slots.map((slot) => [slot.id, slot]));
  const entitiesById = new Map(doc.entities.map((entity) => [entity.stableId, entity]));
  const memoryByAddress = new Map(
    doc.slots.filter((slot) => slot.space === 'memory').map((slot) => [`${slot.agent}#${slot.index}`, slot]),
  );
  const agents = new Set(doc.slots.filter((slot) => slot.space === 'memory').map((slot) => slot.agent));
  if (agents.size > doc.limits.maxAgents) fail('distinct memory agents above limits.maxAgents');

  for (const slot of doc.slots) {
    if (slot.space === 'counter') {
      if (slot.min > slot.max) fail(`counter ${slot.id} has min above max`);
      if (slot.initial < slot.min || slot.initial > slot.max)
        fail(`counter ${slot.id} has initial outside bounds`);
    }
    if (slot.space === 'timer' && slot.initial > slot.maxTicks) fail(`timer ${slot.id} starts above maxTicks`);
    if ((slot.space === 'inventory' || slot.space === 'memory') && !slot.values.includes(slot.initial))
      fail(`slot ${slot.id} has initial outside its declared values`);
    if (slot.space === 'memory' && slot.index >= doc.limits.memorySlotsPerAgent)
      fail(`memory slot ${slot.id} above limits.memorySlotsPerAgent`);
  }

  for (const entity of doc.entities) {
    if (!entity.states.includes(entity.initialState))
      fail(`entity ${entity.stableId} has initialState outside its declared states`);
  }

  /**
   * Argumenty odvozeného faktu jsou jména, ne indexy — a jméno, které nikde
   * není deklarované, je osiřelý odkaz. Rozpouštějí se role z `RESOLVED_ARG_ROLES`;
   * zbytek nemá ve `world-ir-v1` deklarační tabulku, viz `ArgRole`.
   */
  const checkFactArgs = (roles: readonly ArgRole[], fact: string, args: readonly string[], where: string) => {
    if (args.length !== roles.length) {
      fail(`${where}: fact ${fact} takes ${roles.length} arguments`);
      return;
    }
    roles.forEach((role, position) => {
      const arg = args[position];
      switch (role) {
        case 'entity':
        case 'entityOrNone':
          if (!(role === 'entityOrNone' && arg === NO_TARGET) && !entitiesById.has(arg))
            fail(`${where}: unknown entity ${arg}`);
          break;
        case 'inventorySlot': {
          const slot = slotsById.get(arg);
          if (!slot) fail(`${where}: unknown slot ${arg}`);
          else if (slot.space !== 'inventory') fail(`${where}: slot ${arg} is not an inventory slot`);
          break;
        }
        default:
          break;
      }
    });
  };

  const checkRef = (ref: StateRef, where: string) => {
    switch (ref.space) {
      case 'counter':
      case 'flag':
      case 'timer':
      case 'inventory': {
        const slot = slotsById.get(ref.slot);
        if (!slot) fail(`${where}: unknown slot ${ref.slot}`);
        else if (slot.space !== ref.space) fail(`${where}: slot ${ref.slot} is not a ${ref.space}`);
        break;
      }
      case 'memory':
        if (!memoryByAddress.has(`${ref.agent}#${ref.index}`))
          fail(`${where}: undeclared memory[${ref.agent}][${ref.index}]`);
        break;
      case 'entityState':
      case 'locked':
        if (!entitiesById.has(ref.entity)) fail(`${where}: unknown entity ${ref.entity}`);
        break;
      case 'observed':
        checkFactArgs(OBSERVED_FACTS[ref.fact], ref.fact, ref.args, where);
        break;
      case 'pulse':
        checkFactArgs(PULSE_FACTS[ref.fact], ref.fact, ref.args, where);
        break;
    }
  };

  // Index potomka musí být menší než index rodiče. **Tohle je jediné místo,
  // kde se acykličnost vynucuje** — tvar schématu ji nedává. `nodeIndex` je
  // obyčejné celé číslo, takže `{ kind: "not", operand: 1 }` na indexu 0 projde
  // `safeParse` bez námitky a cyklus odmítne až tenhle průchod. Plochá tabulka
  // odstraňuje `$ref` rekurzi v JSON Schema, ne cykly v datech.
  doc.nodes.forEach((node, index) => {
    for (const child of childIndices(node)) {
      if (child >= index) fail(`node ${index} references node ${child} at or above itself`);
    }
  });
  if (issues.length > 0) return { ok: false, issues };

  doc.nodes.forEach((node, index) => {
    if (node.kind === 'ref') checkRef(node.ref, `node ${index}`);
    if (node.kind === 'compare') {
      if (doc.nodes[node.rhs].kind !== 'literal') fail(`node ${index}: compare rhs must be a literal`);
      const lhsKind = doc.nodes[node.lhs].kind;
      if (lhsKind !== 'ref' && lhsKind !== 'query' && lhsKind !== 'literal')
        fail(`node ${index}: compare lhs must be a value expression`);
      const left = nodeValueKind(doc.nodes, node.lhs);
      const right = nodeValueKind(doc.nodes, node.rhs);
      if (left !== right) fail(`node ${index}: compare operands are ${left} and ${right}`);
      if (left !== 'number' && node.op !== '=')
        fail(`node ${index}: ${left} operands support only the '=' operator`);
    }
    if (node.kind === 'allOf' || node.kind === 'anyOf') {
      for (const operand of node.operands) {
        if (nodeValueKind(doc.nodes, operand) !== 'bool')
          fail(`node ${index}: operand ${operand} is not boolean`);
      }
    }
    if (node.kind === 'not' && nodeValueKind(doc.nodes, node.operand) !== 'bool')
      fail(`node ${index}: operand ${node.operand} is not boolean`);
  });

  for (const predicate of doc.predicates) {
    if (predicate.expr >= doc.nodes.length) {
      fail(`predicate ${predicate.predicateId}: expr index out of range`);
      continue;
    }
    if (nodeValueKind(doc.nodes, predicate.expr) !== 'bool')
      fail(`predicate ${predicate.predicateId}: expr is not boolean`);
  }

  const predicateIds = new Set(doc.predicates.map((predicate) => predicate.predicateId));

  doc.effects.forEach((effect, index) => {
    const where = `effect ${index}`;
    switch (effect.op) {
      case 'assign': {
        checkRef(effect.ref, where);
        if (!(ASSIGNABLE_SPACES as readonly string[]).includes(effect.ref.space)) {
          fail(`${where}: ${effect.ref.space} is not assignable`);
          break;
        }
        if (effect.value >= doc.nodes.length) {
          fail(`${where}: value index out of range`);
          break;
        }
        const valueNode = doc.nodes[effect.value];
        if (valueNode.kind !== 'literal') {
          fail(`${where}: assign value must be a literal`);
          break;
        }
        if (refValueKind(effect.ref) !== nodeValueKind(doc.nodes, effect.value)) {
          fail(`${where}: assign value type does not match ${effect.ref.space}`);
          break;
        }
        if (effect.ref.space === 'counter') {
          const slot = slotsById.get(effect.ref.slot);
          if (slot?.space === 'counter' && typeof valueNode.value === 'number') {
            if (valueNode.value < slot.min || valueNode.value > slot.max)
              fail(`${where}: assign value outside counter bounds`);
          }
        }
        if (effect.ref.space === 'timer') {
          const slot = slotsById.get(effect.ref.slot);
          if (slot?.space === 'timer' && typeof valueNode.value === 'number') {
            if (valueNode.value < 0 || valueNode.value > slot.maxTicks)
              fail(`${where}: assign value outside timer bounds`);
          }
        }
        if (effect.ref.space === 'entityState') {
          const entity = entitiesById.get(effect.ref.entity);
          if (entity && typeof valueNode.value === 'string' && !entity.states.includes(valueNode.value))
            fail(`${where}: state ${valueNode.value} is not declared on ${effect.ref.entity}`);
        }
        if (effect.ref.space === 'inventory' || effect.ref.space === 'memory') {
          const slot =
            effect.ref.space === 'inventory'
              ? slotsById.get(effect.ref.slot)
              : memoryByAddress.get(`${effect.ref.agent}#${effect.ref.index}`);
          if (
            (slot?.space === 'inventory' || slot?.space === 'memory') &&
            typeof valueNode.value === 'string' &&
            !slot.values.includes(valueNode.value)
          )
            fail(`${where}: value ${valueNode.value} is outside the declared values`);
        }
        break;
      }
      case 'addCounter': {
        const slot = slotsById.get(effect.slot);
        if (slot?.space !== 'counter') fail(`${where}: ${effect.slot} is not a counter`);
        break;
      }
      case 'startTimer':
      case 'stopTimer': {
        const slot = slotsById.get(effect.slot);
        if (slot?.space !== 'timer') fail(`${where}: ${effect.slot} is not a timer`);
        else if (effect.op === 'startTimer' && effect.durationTicks > slot.maxTicks)
          fail(`${where}: durationTicks above the timer maxTicks`);
        break;
      }
      case 'giveItem':
      case 'takeItem': {
        const slot = slotsById.get(effect.slot);
        if (slot?.space !== 'inventory') fail(`${where}: ${effect.slot} is not an inventory slot`);
        else if (!slot.values.includes(effect.item))
          fail(`${where}: item ${effect.item} is outside the declared values`);
        break;
      }
      case 'despawn':
      case 'moveTo':
      case 'freeze':
        if (!entitiesById.has(effect.entity)) fail(`${where}: unknown entity ${effect.entity}`);
        break;
      case 'playEffect':
        if (effect.target !== null && !entitiesById.has(effect.target))
          fail(`${where}: unknown target ${effect.target}`);
        break;
      default:
        break;
    }
  });

  for (const rule of doc.rules) {
    if (!predicateIds.has(rule.trigger.predicate))
      fail(`rule ${rule.ruleId}: unknown predicate ${rule.trigger.predicate}`);
    if (rule.guard !== null) {
      if (rule.guard >= doc.nodes.length) fail(`rule ${rule.ruleId}: guard index out of range`);
      else if (nodeValueKind(doc.nodes, rule.guard) !== 'bool')
        fail(`rule ${rule.ruleId}: guard is not boolean`);
    }
    for (const effect of rule.effects) {
      if (effect >= doc.effects.length) fail(`rule ${rule.ruleId}: effect index ${effect} out of range`);
    }
  }

  return { ok: issues.length === 0, issues };
}
