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

export type SectionId = 'stavba' | 'pravidla' | 'cil';

/** Pořadí je pořadí výpisu. */
export const SECTIONS: readonly SectionId[] = ['stavba', 'pravidla', 'cil'];

export const SECTION_TITLES: Readonly<Record<SectionId, string>> = {
  stavba: 'Tvar stavby',
  pravidla: 'Pravidla',
  cil: 'Cíl',
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
  return value === null ? '?' : `„${value}“`;
}

/** Množné číslo česky — 1 kotva, 2 kotvy, 5 kotev. */
function plural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return `${String(count)} ${one}`;
  if (count >= 2 && count <= 4) return `${String(count)} ${few}`;
  return `${String(count)} ${many}`;
}

function listOf(names: readonly string[], limit = 6): string {
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} a další ${String(names.length - limit)}`;
}

// ---------------------------------------------------------------------------
// Slovník — události, podmínky, akce
// ---------------------------------------------------------------------------

const ROLE_NAMES: Readonly<Record<string, string>> = {
  actor: 'postava',
  collectible: 'sběratelský předmět',
  goal: 'cíl',
  obstacle: 'překážka',
  agent: 'agent',
  prop: 'rekvizita',
};

function roleName(role: string, count: number): string {
  const known = ROLE_NAMES[role];
  if (known === undefined) return `${String(count)}× ${role}`;
  if (count === 1) return known;
  return `${String(count)}× ${known}`;
}

const COMPARE_WORDS: Readonly<Record<string, string>> = {
  '=': 'je',
  '==': 'je',
  '===': 'je',
  '!=': 'není',
  '!==': 'není',
  '>': 'je víc než',
  '>=': 'je aspoň',
  '<': 'je míň než',
  '<=': 'je nejvýš',
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
      return 'Na začátku';
    case 'onClick':
      return `Když se klikne na ${name(firstName(event, 'entity', 'target'))}`;
    case 'onEnterZone':
      return `Když ${firstName(event, 'entity') ?? 'hráč'} vejde do zóny ${name(asString(event.zone))}`;
    case 'onExitZone':
      return `Když ${firstName(event, 'entity') ?? 'hráč'} opustí zónu ${name(asString(event.zone))}`;
    case 'onCollide':
      return `Když do sebe narazí ${name(asString(event.a))} a ${name(asString(event.b))}`;
    case 'onPickup': {
      const named = firstName(event, 'entity', 'item', 'target');
      const role = asString(event.role);
      if (named !== null) return `Když hráč sebere ${named}`;
      if (role !== null) return `Když hráč sebere ${ROLE_NAMES[role] ?? role}`;
      return 'Když hráč něco sebere';
    }
    case 'onDrop':
      return `Když hráč odloží ${name(firstName(event, 'item', 'entity', 'target'))}`;
    case 'onTimerEnd':
      return `Když doběhne časovač ${name(firstName(event, 'timer', 'ref'))}`;
    case 'onCounterReaches': {
      const threshold = firstNumber(event, 'threshold', 'n');
      return `Když ${name(firstName(event, 'ref', 'counter'))} dosáhne ${
        threshold === null ? '?' : String(threshold)
      }`;
    }
    case 'onStateEnter':
      return `Když ${name(firstName(event, 'entity', 'target'))} přejde do stavu ${quoted(
        firstName(event, 'state', 'value'),
      )}`;
    case 'onSignal':
      return `Když přijde signál ${name(firstName(event, 'name', 'signal'))}`;
    case 'onSeen':
      return `Když ${name(asString(event.agent))} uvidí ${name(asString(event.target))}`;
    case 'onAction':
      return `Když hráč použije ${name(asString(event.actionId))} na ${asString(event.target) ?? 'cokoli'}`;
    case 'onCommandComplete':
      return `Když ${name(firstName(event, 'entity', 'target'))} dokončí ${name(asString(event.commandId))}`;
    default:
      return kind === null ? 'Bez události' : `Při ${kind}`;
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
      return `vlaječka ${name(firstName(node, 'ref', 'flag'))} je ${node.value === false ? 'vypnutá' : 'zapnutá'}`;
    case 'timerRunning':
      return `časovač ${name(firstName(node, 'ref', 'timer'))} běží`;
    case 'stateIs':
      return `${name(firstName(node, 'target', 'entity'))} je ${quoted(firstName(node, 'value', 'state'))}`;
    case 'lockedIs':
      return `${name(firstName(node, 'target', 'entity'))} je ${
        node.value === false || node.locked === false ? 'odemčený' : 'zamčený'
      }`;
    case 'inZone':
      return `${firstName(node, 'entity') ?? 'hráč'} je v zóně ${name(asString(node.zone))}`;
    case 'hasItem':
      return `hráč má ${name(asString(node.item))}`;
    case 'countInZone': {
      const rhs = asNumber(node.value);
      return `v zóně ${name(asString(node.zone))} ${compareWord(node.op)} ${
        rhs === null ? '?' : String(rhs)
      } objektů s tagem ${name(asString(node.tag))}`;
    }
    case 'allOf':
    case 'anyOf': {
      const parts = asArray(node.operands ?? node.of ?? node.clauses)
        .map((operand) => describeCondition(operand))
        .filter((part): part is string => part !== null);
      if (parts.length === 0) return null;
      return parts.join(kind === 'allOf' ? ' a zároveň ' : ' nebo ');
    }
    case 'not': {
      const inner = describeCondition(node.operand ?? node.of);
      return inner === null ? null : `neplatí, že ${inner}`;
    }
    default:
      return kind === null ? null : `podmínka ${kind}`;
  }
}

/** Akce → věta. Aliasy polí kopírují `lowerAction`. */
function describeAction(value: unknown): string {
  const action = asRecord(value);
  const kind = asString(action.kind);

  switch (kind) {
    case 'setState':
      return `přepni ${name(firstName(action, 'target', 'entity'))} na ${quoted(
        firstName(action, 'value', 'state'),
      )}`;
    case 'setLocked':
      return `${action.locked === true || action.value === true ? 'zamkni' : 'odemkni'} ${name(
        firstName(action, 'target', 'entity'),
      )}`;
    case 'setFlag':
      return `${action.value === false ? 'vypni' : 'zapni'} vlaječku ${name(firstName(action, 'ref', 'flag'))}`;
    case 'addCounter': {
      const slot = name(firstName(action, 'ref', 'counter'));
      const delta = firstNumber(action, 'by', 'delta');
      if (delta === null) return `změň ${slot}`;
      return delta < 0 ? `${slot} −${String(Math.abs(delta))}` : `${slot} +${String(delta)}`;
    }
    case 'startTimer': {
      const slot = name(firstName(action, 'ref', 'timer'));
      const ticks = asNumber(action.durationTicks);
      return ticks === null ? `spusť časovač ${slot}` : `spusť časovač ${slot} na ${String(ticks)} tiků`;
    }
    case 'stopTimer':
      return `zastav časovač ${name(firstName(action, 'ref', 'timer'))}`;
    case 'spawn':
      return `postav ${name(firstName(action, 'poolTag', 'tag'))} na ${name(asString(action.socket))}`;
    case 'despawn':
      return `odstraň ${name(firstName(action, 'target', 'entity'))}`;
    case 'moveTo':
      return `přesuň ${name(firstName(action, 'target', 'entity'))} na ${name(asString(action.socket))}`;
    case 'freeze':
      return `zmraz ${name(firstName(action, 'target', 'entity'))}`;
    case 'giveItem':
      return `dej ${name(asString(action.item))}`;
    case 'takeItem':
      return `seber ${name(asString(action.item))}`;
    case 'emit':
      return `vyšli signál ${name(firstName(action, 'signal', 'name'))}`;
    case 'playEffect':
      return `přehraj efekt ${name(firstName(action, 'id', 'effectId'))}`;
    case 'win':
      return 'výhra';
    case 'lose':
      return 'prohra';
    default:
      return kind === null ? 'neznámá akce' : `akce ${kind}`;
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
  return condition === null ? when : `${when}, a ${condition}`;
}

function describeRule(rule: Rule): string {
  const actions = asArray(rule.body.actions).map((action) => describeAction(action));
  return `${conditionSentence(rule)} → ${actions.length === 0 ? 'nic' : actions.join('; ')}`;
}

/** „Když hráč…" uvnitř věty musí začínat malým písmenem. */
function lowerFirst(text: string): string {
  const stripped = text.startsWith('Když ') ? text.slice('Když '.length) : text;
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
      'stavba',
      'stavba/mrizka',
      `Mřížka ${String(width)} × ${String(height)} buněk${
        levels > 1 ? `, ${plural(levels, 'patro', 'patra', 'pater')}` : ''
      }`,
    );

  const sockets = Object.keys(asRecord(sim.sockets));
  if (sockets.length > 0)
    push('stavba', 'stavba/kotvy', `${plural(sockets.length, 'kotva', 'kotvy', 'kotev')}: ${listOf(sockets)}`);

  const entities = asRecord(sim.entities);
  const byRole = new Map<string, string[]>();
  for (const id of Object.keys(entities)) {
    const role = asString(asRecord(entities[id]).role) ?? 'bez role';
    byRole.set(role, [...(byRole.get(role) ?? []), id]);
  }
  for (const [role, ids] of [...byRole.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    push('stavba', `stavba/role/${role}`, `${roleName(role, ids.length)}: ${listOf(ids)}`);

  const state = asRecord(sim.state);
  for (const [slot, body] of Object.entries(asRecord(state.counters))) {
    const counter = asRecord(body);
    const min = asNumber(counter.min);
    const max = asNumber(counter.max);
    const range = min !== null && max !== null ? ` ${String(min)}–${String(max)}` : '';
    push('stavba', `stavba/counter/${slot}`, `Čítač ${slot}${range}, začíná na ${String(asNumber(counter.init) ?? 0)}`);
  }
  for (const [slot, body] of Object.entries(asRecord(state.timers))) {
    const ticks = asNumber(asRecord(body).durationTicks);
    push('stavba', `stavba/timer/${slot}`, `Časovač ${slot}${ticks === null ? '' : ` na ${String(ticks)} tiků`}`);
  }
  const flags = Object.keys(asRecord(state.flags));
  if (flags.length > 0) push('stavba', 'stavba/flags', `Vlaječky: ${listOf(flags)}`);

  // Vzhled patří ke stavbě: je to druhá větev téže emise, ne cizí dokument.
  const modules = asRecord(look.modules);
  const families = Object.keys(modules).map((id) => `${id} → ${name(asString(asRecord(modules[id]).family))}`);
  if (families.length > 0) push('stavba', 'stavba/moduly', `Vzhled: ${listOf(families)}`);

  const palette = asString(look.palette);
  const lightRig = asString(look.lightRig);
  if (palette !== null || lightRig !== null)
    push('stavba', 'stavba/paleta', `Paleta ${name(palette)}, světlo ${name(lightRig)}`);

  // --- Pravidla ------------------------------------------------------------
  const rules = rulesInOrder(sim);
  rules.forEach((rule, index) => {
    push('pravidla', `pravidla/${rule.id}`, `${String(index + 1)}. ${describeRule(rule)}`);
  });
  if (rules.length === 0) push('pravidla', 'pravidla/zadna', 'Svět nemá žádné pravidlo.');

  // --- Cíl -----------------------------------------------------------------
  const outcome = (op: string): Rule | undefined =>
    rules.find((rule) => asArray(rule.body.actions).some((action) => asString(asRecord(action).kind) === op));

  const winning = outcome('win');
  push(
    'cil',
    'cil/vyhra',
    winning === undefined
      ? 'Žádné pravidlo nevede k výhře.'
      : `Vyhraješ, když ${lowerFirst(conditionSentence(winning))}.`,
  );

  const losing = outcome('lose');
  if (losing !== undefined) push('cil', 'cil/prohra', `Prohraješ, když ${lowerFirst(conditionSentence(losing))}.`);

  const witness = asRecord(sim.witness);
  const ops = asArray(witness.ops);
  const at = asNumber(witness.L_witness);
  const horizon = asNumber(witness.H_cert);
  if (ops.length > 0)
    push(
      'cil',
      'cil/svedek',
      `Systém k tomu nese stopu: ${plural(ops.length, 'tah', 'tahy', 'tahů')}, výhra v tiku ${String(at ?? 0)}${
        horizon === null ? '' : ` z ${String(horizon)}`
      }.`,
    );

  return lines;
}

/**
 * Emise → řádky. Emise, ve které `sim` není, není chyba: model ji smí odmítnout
 * (§13.4) a panel to má říct, ne spadnout.
 */
export function describeEmission(emission: unknown): readonly ProgramLine[] {
  const body = asRecord(emission);
  const sim = body.sim;
  if (sim === null || sim === undefined)
    return [{ id: 'stavba/zadny', section: 'stavba', text: 'Model na tuhle větu svět nenapsal.' }];

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
