/**
 * Emise → čitelné řádky (P11 T14).
 *
 * ## Proč to není `JSON.stringify`
 *
 * Porotce má vidět, **co model doopravdy napsal**, ne důkaz, že něco přišlo.
 * Nastrouhaný JSON obojí zaměňuje: je v něm sice všechno, ale nedá se z něj za
 * dvě sekundy přečíst, jestli ten svět dělá to, co si člověk přál. Panel proto
 * emisi převádí na věty — tvar stavby, pravidla v pořadí vykonání, a cíl.
 *
 * ## Čte se stejnými aliasy, jakými emisi čte snížení
 *
 * Zdrojem pravdy o tom, které pole se doopravdy použije, je `src/ir/surface.ts`:
 * korpus píše `{ref}` i `{counter}`, `{target}` i `{entity}`, `{value}` i
 * `{state}`, a snížení bere první, které je. Kdyby panel četl jen jedno z nich,
 * ukazoval by u poloviny pravidel prázdno u věci, kterou interpret vidí — tedy
 * by o běžícím světě **lhal**, a to je horší než nic neukázat.
 *
 * ## Emise je vstup zvenčí
 *
 * Píše ji model. Nic se proto nepředpokládá: chybějící pole, špatný typ i cizí
 * `kind` jsou normální vstup, ne výjimka. Kde věta nejde složit, vypíše se
 * syrové jméno tvaru; nikdy se nespadne a nikdy se nevymýšlí význam.
 *
 * ## Identita řádku, ne jeho text, nese porovnání
 *
 * Každý řádek má stabilní `id` (`pravidla/unlock`, `stavba/counter/keysHeld`).
 * Druhá věta se s první porovnává přes ně, takže pravidlo, kterému se změnil
 * práh, je **jeden změněný řádek** — ne jeden zmizelý a jeden nový. Porovnávat
 * texty by z každé přepsané číslovky udělalo dvojici a rozdíl by se v ní ztratil.
 */

import { SOURCE_LABEL, type EmissionSource } from '@/model/source';

export type SectionId = 'build' | 'rules' | 'goal';

/** Pořadí je pořadí výpisu. */
export const SECTIONS: readonly SectionId[] = ['build', 'rules', 'goal'];

export const SECTION_TITLES: Readonly<Record<SectionId, string>> = {
  build: 'What is built',
  rules: 'Rules',
  goal: 'Goal',
};

export interface ProgramLine {
  /** Stabilní napříč emisemi — nese porovnání. */
  readonly id: string;
  readonly section: SectionId;
  readonly text: string;
}

export type Change = 'same' | 'added' | 'removed' | 'changed';

export interface DiffLine {
  readonly line: ProgramLine;
  readonly change: Change;
}

// ---------------------------------------------------------------------------
// Čtení emise — nic se nepředpokládá
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** První jméno, které v záznamu je. Kopíruje pořadí aliasů ze `surface.ts`. */
function firstName(record: Record<string, unknown>, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const found = asString(record[key]);
    if (found !== null) return found;
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, ...keys: readonly string[]): number | null {
  for (const key of keys) {
    const found = asNumber(record[key]);
    if (found !== null) return found;
  }
  return null;
}

/** Jméno, nebo `?` když chybí. `?` je poctivější než vynechaný kus věty. */
function name(value: string | null): string {
  return value ?? '?';
}

function quoted(value: string | null): string {
  return value === null ? '?' : `“${value}”`;
}

/**
 * Množné číslo. Anglické má dva tvary, ne tři jako české — s překladem
 * rozhraní (T27r) tedy odpadl prostřední tvar pro dvě až čtyři.
 */
function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function listOf(names: readonly string[], limit = 6): string {
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} and ${String(names.length - limit)} more`;
}

// ---------------------------------------------------------------------------
// Slovník — události, podmínky, akce
// ---------------------------------------------------------------------------

const ROLE_NAMES: Readonly<Record<string, string>> = {
  actor: 'character',
  collectible: 'collectible',
  goal: 'goal',
  obstacle: 'obstacle',
  agent: 'agent',
  prop: 'prop',
};

function roleName(role: string, count: number): string {
  const known = ROLE_NAMES[role];
  if (known === undefined) return `${String(count)}× ${role}`;
  if (count === 1) return known;
  return `${String(count)}× ${known}`;
}

const COMPARE_WORDS: Readonly<Record<string, string>> = {
  '=': 'is',
  '==': 'is',
  '===': 'is',
  '!=': 'is not',
  '!==': 'is not',
  '>': 'is more than',
  '>=': 'is at least',
  '<': 'is less than',
  '<=': 'is at most',
};

function compareWord(value: unknown): string {
  const raw = asString(value) ?? '=';
  return COMPARE_WORDS[raw] ?? raw;
}

/** Událost → věta. Aliasy polí kopírují `lowerEvent`. */
function describeEvent(value: unknown): string {
  const event = asRecord(value);
  const kind = asString(event.kind);

  switch (kind) {
    case 'onStart':
      return 'At the start';
    case 'onClick':
      return `When ${name(firstName(event, 'entity', 'target'))} is clicked`;
    case 'onEnterZone':
      return `When ${firstName(event, 'entity') ?? 'the player'} enters zone ${name(asString(event.zone))}`;
    case 'onExitZone':
      return `When ${firstName(event, 'entity') ?? 'the player'} leaves zone ${name(asString(event.zone))}`;
    case 'onCollide':
      return `When ${name(asString(event.a))} and ${name(asString(event.b))} collide`;
    case 'onPickup': {
      const named = firstName(event, 'entity', 'item', 'target');
      const role = asString(event.role);
      if (named !== null) return `When the player picks up ${named}`;
      if (role !== null) return `When the player picks up a ${ROLE_NAMES[role] ?? role}`;
      return 'When the player picks something up';
    }
    case 'onDrop':
      return `When the player drops ${name(firstName(event, 'item', 'entity', 'target'))}`;
    case 'onTimerEnd':
      return `When timer ${name(firstName(event, 'timer', 'ref'))} runs out`;
    case 'onCounterReaches': {
      const threshold = firstNumber(event, 'threshold', 'n');
      return `When ${name(firstName(event, 'ref', 'counter'))} reaches ${
        threshold === null ? '?' : String(threshold)
      }`;
    }
    case 'onStateEnter':
      return `When ${name(firstName(event, 'entity', 'target'))} enters state ${quoted(
        firstName(event, 'state', 'value'),
      )}`;
    case 'onSignal':
      return `When signal ${name(firstName(event, 'name', 'signal'))} arrives`;
    case 'onSeen':
      return `When ${name(asString(event.agent))} sees ${name(asString(event.target))}`;
    case 'onAction':
      return `When the player uses ${name(asString(event.actionId))} on ${asString(event.target) ?? 'anything'}`;
    case 'onCommandComplete':
      return `When ${name(firstName(event, 'entity', 'target'))} finishes ${name(asString(event.commandId))}`;
    default:
      return kind === null ? 'No event' : `On ${kind}`;
  }
}

/** Podmínka → věta. `null` znamená „bez podmínky", ne prázdný řetězec. */
function describeCondition(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const node = asRecord(value);
  const kind = asString(node.kind);

  switch (kind) {
    case 'counterIs': {
      const rhs = asNumber(node.value);
      return `${name(firstName(node, 'ref', 'counter'))} ${compareWord(node.op)} ${
        rhs === null ? '?' : String(rhs)
      }`;
    }
    case 'flagIs':
      return `flag ${name(firstName(node, 'ref', 'flag'))} is ${node.value === false ? 'off' : 'on'}`;
    case 'timerRunning':
      return `timer ${name(firstName(node, 'ref', 'timer'))} is running`;
    case 'stateIs':
      return `${name(firstName(node, 'target', 'entity'))} is ${quoted(firstName(node, 'value', 'state'))}`;
    case 'lockedIs':
      return `${name(firstName(node, 'target', 'entity'))} is ${
        node.value === false || node.locked === false ? 'unlocked' : 'locked'
      }`;
    case 'inZone':
      return `${firstName(node, 'entity') ?? 'the player'} is in zone ${name(asString(node.zone))}`;
    case 'hasItem':
      return `the player has ${name(asString(node.item))}`;
    case 'countInZone': {
      const rhs = asNumber(node.value);
      return `zone ${name(asString(node.zone))} ${compareWord(node.op)} ${
        rhs === null ? '?' : String(rhs)
      } objects tagged ${name(asString(node.tag))}`;
    }
    case 'allOf':
    case 'anyOf': {
      const parts = asArray(node.operands ?? node.of ?? node.clauses)
        .map((operand) => describeCondition(operand))
        .filter((part): part is string => part !== null);
      if (parts.length === 0) return null;
      return parts.join(kind === 'allOf' ? ' and ' : ' or ');
    }
    case 'not': {
      const inner = describeCondition(node.operand ?? node.of);
      return inner === null ? null : `it is not true that ${inner}`;
    }
    default:
      return kind === null ? null : `condition ${kind}`;
  }
}

/** Akce → věta. Aliasy polí kopírují `lowerAction`. */
function describeAction(value: unknown): string {
  const action = asRecord(value);
  const kind = asString(action.kind);

  switch (kind) {
    case 'setState':
      return `set ${name(firstName(action, 'target', 'entity'))} to ${quoted(
        firstName(action, 'value', 'state'),
      )}`;
    case 'setLocked':
      return `${action.locked === true || action.value === true ? 'lock' : 'unlock'} ${name(
        firstName(action, 'target', 'entity'),
      )}`;
    case 'setFlag':
      return `turn flag ${name(firstName(action, 'ref', 'flag'))} ${action.value === false ? 'off' : 'on'}`;
    case 'addCounter': {
      const slot = name(firstName(action, 'ref', 'counter'));
      const delta = firstNumber(action, 'by', 'delta');
      if (delta === null) return `change ${slot}`;
      return delta < 0 ? `${slot} −${String(Math.abs(delta))}` : `${slot} +${String(delta)}`;
    }
    case 'startTimer': {
      const slot = name(firstName(action, 'ref', 'timer'));
      const ticks = asNumber(action.durationTicks);
      return ticks === null ? `start timer ${slot}` : `start timer ${slot} for ${String(ticks)} ticks`;
    }
    case 'stopTimer':
      return `stop timer ${name(firstName(action, 'ref', 'timer'))}`;
    case 'spawn':
      return `place ${name(firstName(action, 'poolTag', 'tag'))} at ${name(asString(action.socket))}`;
    case 'despawn':
      return `remove ${name(firstName(action, 'target', 'entity'))}`;
    case 'moveTo':
      return `move ${name(firstName(action, 'target', 'entity'))} to ${name(asString(action.socket))}`;
    case 'freeze':
      return `freeze ${name(firstName(action, 'target', 'entity'))}`;
    case 'giveItem':
      return `give ${name(asString(action.item))}`;
    case 'takeItem':
      return `take ${name(asString(action.item))}`;
    case 'emit':
      return `emit signal ${name(firstName(action, 'signal', 'name'))}`;
    case 'playEffect':
      return `play effect ${name(firstName(action, 'id', 'effectId'))}`;
    case 'win':
      return 'win';
    case 'lose':
      return 'lose';
    default:
      return kind === null ? 'unknown action' : `action ${kind}`;
  }
}

// ---------------------------------------------------------------------------
// Pravidla v pořadí vykonání
// ---------------------------------------------------------------------------

interface Rule {
  readonly id: string;
  readonly body: Record<string, unknown>;
}

/**
 * Pravidla seřazená tak, jak je vykoná interpret — `phase`, pak `priority`, pak
 * jméno. Je to totéž řazení, jaké dělá `compareRules` v `src/sim/interpreter.ts`.
 * Vypsat je v pořadí klíčů objektu by ukázalo pořadí zápisu, ne pořadí běhu.
 */
function rulesInOrder(sim: Record<string, unknown>): readonly Rule[] {
  const rules = asRecord(sim.rules);
  const collected = Object.keys(rules).map((id) => ({ id, body: asRecord(rules[id]) }));

  return collected.sort((a, b) => {
    const phase = (asNumber(a.body.phase) ?? 0) - (asNumber(b.body.phase) ?? 0);
    if (phase !== 0) return phase;
    const priority = (asNumber(a.body.priority) ?? 0) - (asNumber(b.body.priority) ?? 0);
    if (priority !== 0) return priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Věta „kdy" bez části „→ co se stane". Cíl popisuje spouštěč, ne následek. */
function conditionSentence(rule: Rule): string {
  const condition = describeCondition(rule.body.condition);
  const when = describeEvent(rule.body.event);
  return condition === null ? when : `${when}, and ${condition}`;
}

function describeRule(rule: Rule): string {
  const actions = asArray(rule.body.actions).map((action) => describeAction(action));
  return `${conditionSentence(rule)} → ${actions.length === 0 ? 'nothing' : actions.join('; ')}`;
}

/** „When the player…" uvnitř věty musí začínat malým písmenem. */
function lowerFirst(text: string): string {
  const stripped = text.startsWith('When ') ? text.slice('When '.length) : text;
  return stripped.charAt(0).toLowerCase() + stripped.slice(1);
}

// ---------------------------------------------------------------------------
// Sekce
// ---------------------------------------------------------------------------

function buildLines(sim: Record<string, unknown>, look: Record<string, unknown>): ProgramLine[] {
  const lines: ProgramLine[] = [];
  const push = (section: SectionId, id: string, text: string): void => {
    lines.push({ id, section, text });
  };

  // --- Tvar stavby ---------------------------------------------------------
  const layout = asRecord(sim.layout);
  const width = asNumber(layout.width);
  const height = asNumber(layout.height);
  const levels = asNumber(layout.levels) ?? 1;
  if (width !== null && height !== null)
    push(
      'build',
      'build/grid',
      `Grid ${String(width)} × ${String(height)} cells${
        levels > 1 ? `, ${plural(levels, 'level', 'levels')}` : ''
      }`,
    );

  const sockets = Object.keys(asRecord(sim.sockets));
  if (sockets.length > 0)
    push('build', 'build/sockets', `${plural(sockets.length, 'socket', 'sockets')}: ${listOf(sockets)}`);

  const entities = asRecord(sim.entities);
  const byRole = new Map<string, string[]>();
  for (const id of Object.keys(entities)) {
    const role = asString(asRecord(entities[id]).role) ?? 'no role';
    byRole.set(role, [...(byRole.get(role) ?? []), id]);
  }
  for (const [role, ids] of [...byRole.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    push('build', `build/role/${role}`, `${roleName(role, ids.length)}: ${listOf(ids)}`);

  const state = asRecord(sim.state);
  for (const [slot, body] of Object.entries(asRecord(state.counters))) {
    const counter = asRecord(body);
    const min = asNumber(counter.min);
    const max = asNumber(counter.max);
    const range = min !== null && max !== null ? ` ${String(min)}–${String(max)}` : '';
    push('build', `build/counter/${slot}`, `Counter ${slot}${range}, starts at ${String(asNumber(counter.init) ?? 0)}`);
  }
  for (const [slot, body] of Object.entries(asRecord(state.timers))) {
    const ticks = asNumber(asRecord(body).durationTicks);
    push('build', `build/timer/${slot}`, `Timer ${slot}${ticks === null ? '' : ` for ${String(ticks)} ticks`}`);
  }
  const flags = Object.keys(asRecord(state.flags));
  if (flags.length > 0) push('build', 'build/flags', `Flags: ${listOf(flags)}`);

  // Vzhled patří ke stavbě: je to druhá větev téže emise, ne cizí dokument.
  const modules = asRecord(look.modules);
  const families = Object.keys(modules).map((id) => `${id} → ${name(asString(asRecord(modules[id]).family))}`);
  if (families.length > 0) push('build', 'build/modules', `Look: ${listOf(families)}`);

  const palette = asString(look.palette);
  const lightRig = asString(look.lightRig);
  if (palette !== null || lightRig !== null)
    push('build', 'build/palette', `Palette ${name(palette)}, light ${name(lightRig)}`);

  // --- Pravidla ------------------------------------------------------------
  const rules = rulesInOrder(sim);
  rules.forEach((rule, index) => {
    push('rules', `rules/${rule.id}`, `${String(index + 1)}. ${describeRule(rule)}`);
  });
  if (rules.length === 0) push('rules', 'rules/none', 'This world has no rules.');

  // --- Cíl -----------------------------------------------------------------
  const outcome = (op: string): Rule | undefined =>
    rules.find((rule) => asArray(rule.body.actions).some((action) => asString(asRecord(action).kind) === op));

  const winning = outcome('win');
  push(
    'goal',
    'goal/win',
    winning === undefined
      ? 'No rule leads to a win.'
      : `You win when ${lowerFirst(conditionSentence(winning))}.`,
  );

  const losing = outcome('lose');
  if (losing !== undefined) push('goal', 'goal/lose', `You lose when ${lowerFirst(conditionSentence(losing))}.`);

  const witness = asRecord(sim.witness);
  const ops = asArray(witness.ops);
  const at = asNumber(witness.L_witness);
  const horizon = asNumber(witness.H_cert);
  if (ops.length > 0)
    push(
      'goal',
      'goal/witness',
      `The system carries a trace for it: ${plural(ops.length, 'move', 'moves')}, win at tick ${String(at ?? 0)}${
        horizon === null ? '' : ` of ${String(horizon)}`
      }.`,
    );

  return lines;
}

/**
 * Prázdná emise → věta, která **jmenuje skutečného původce**.
 *
 * Do 3. 9. 2026 tu stálo tvrzení o modelu pro všechny čtyři cesty, a u tří
 * z nich to byla nepravda: rozpoznávač jsou regulární výrazy, zmrazený korpus
 * je soubor a zaručená místnost je konstanta — žádná z nich model nevolá.
 * Panel je na hlavní cestě (`src/app/page.tsx` → `Program.tsx`) a porotce ho
 * čte v zásuvce Inspect; nepravdivá věta se přitom čte úplně stejně dobře jako
 * pravdivá, takže tuhle vadu neodhalí nic než tvrzení o původci.
 *
 * `source === null` znamená „ještě žádná věta nepadla" — pak se nejmenuje
 * nikdo, protože se nikdo nepokoušel.
 */
function nothingWritten(source: EmissionSource | null): string {
  return source === null
    ? 'No world was written for this sentence.'
    : `The ${SOURCE_LABEL[source]} wrote no world for this sentence.`;
}

/**
 * Emise → řádky. Emise, ve které `sim` není, není chyba: původce ji smí
 * odmítnout (§13.4) a panel to má říct, ne spadnout.
 *
 * `source` je **pravdivý původ toho dokumentu**, ne přání. Chodí sem z téhož
 * stavu, jaký nese odznak panelu (`Program.tsx`), takže věta a odznak nemůžou
 * tvrdit každý něco jiného.
 */
export function describeEmission(
  emission: unknown,
  source: EmissionSource | null = null,
): readonly ProgramLine[] {
  const body = asRecord(emission);
  const sim = body.sim;
  if (sim === null || sim === undefined)
    return [{ id: 'build/none', section: 'build', text: nothingWritten(source) }];

  return buildLines(asRecord(sim), asRecord(body.look));
}

/**
 * Rozdíl proti předchozí emisi.
 *
 * Bez předchozí emise je všechno `same` — první svět není samá novinka, jen
 * první svět. Označit ho celý jako přidaný by z rozdílu udělalo dekoraci, která
 * svítí vždycky.
 */
export function diffPrograms(
  previous: readonly ProgramLine[] | null,
  next: readonly ProgramLine[],
): readonly DiffLine[] {
  if (previous === null) return next.map((line) => ({ line, change: 'same' as const }));

  const before = new Map(previous.map((line) => [line.id, line]));
  const kept = new Set(next.map((line) => line.id));

  const changed: DiffLine[] = next.map((line) => {
    const old = before.get(line.id);
    if (old === undefined) return { line, change: 'added' };
    return { line, change: old.text === line.text ? 'same' : 'changed' };
  });

  // Zmizelé řádky se vypisují na konci. Nechat je zmizet potichu by zamlčelo
  // přesně tu půlku změny, kterou nejde uhodnout z toho, co zbylo.
  const removed: DiffLine[] = previous
    .filter((line) => !kept.has(line.id))
    .map((line) => ({ line, change: 'removed' as const }));

  return [...changed, ...removed];
}
