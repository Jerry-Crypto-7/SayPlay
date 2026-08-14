/**
 * Běhová a pozorovací vrstva sémantického scoreru (T16).
 *
 * Scorer potřebuje dvě věci, které samotný kontrakt nedává: **postavit svět**
 * z emitovaného `sim` a **přečíst z něj hodnotu** v konkrétním okamžiku. Obojí
 * je tady, aby `./semantic` zůstal o kontraktech a verdiktu.
 *
 * Nic z toho nesmí být druhý interpret. Svět staví `src/ir/build`, tiká
 * `src/sim/interpreter`, certifikuje `src/verify/witness` — tenhle soubor je jen
 * čte. Kdyby si scorer krokoval sám, měřil by svou vlastní představu o světě,
 * ne ten svět, který se hráči doopravdy postaví.
 *
 * ## Výrazový jazyk kontraktů
 *
 * Kontrakty adresují stav řetězcem (`counter('keysHeld')`,
 * `rule('detect').condition.operands[1].negated`). Je to **zmrazená** gramatika:
 * volání s literálovými argumenty a za ním řetěz `.pole` / `[index]`. Žádné
 * operátory, žádné vnořené volání — vyhodnocovač proto není interpret jazyka,
 * ale tabulka čteček.
 *
 * **Nezodpověditelné je vlastní výsledek, ne `false`.** Otázka, na kterou P1
 * nemá čím odpovědět (neexistující pravidlo, pozorování běhu bez běhu), vrací
 * `{ ok: false, reason }`. Kdyby vracela `false`, prošla by chráněná pozorování
 * vakuózně — obě strany „stejně nevím" jsou si rovné a kontrakt by tichl.
 */

import { buildRuntimeWorld, type BuildResult } from '../../src/ir/build';
import { findDanglingReferences } from '../../src/ir/references';
import { canonical, canonicalHash } from '../../src/ir/worlddoc';
import {
  createRuntime,
  isInstaWin,
  step,
  type FaultReason,
  type RunState,
  type Runtime,
  type TraceInput,
  type WorldDocRuntime,
} from '../../src/sim/interpreter';
import { readSlot } from '../../src/sim/state';
import type { CertificationRequest } from '../../src/verify/tiers';
import { verifyWitness, type VerifyResult } from '../../src/verify/witness';

export type BuiltWorld = WorldDocRuntime & { readonly certification: CertificationRequest };

export { buildRuntimeWorld, isInstaWin, verifyWitness };
export type { BuildResult, VerifyResult };

// ---------------------------------------------------------------------------
// Okamžik běhu
// ---------------------------------------------------------------------------

/**
 * Stav světa v jednom tiku plus kolikrát do té chvíle spustilo které pravidlo.
 *
 * `state` je kopie, ne odkaz na živý `runtime.state` — ten se přepisuje na místě
 * a bez kopie by všechny zachycené okamžiky ukazovaly na konec běhu.
 */
export interface Moment {
  readonly tick: number;
  readonly runtime: Runtime;
  readonly state: Uint32Array;
  readonly fireCounts: ReadonlyMap<string, number>;
}

export interface Replay {
  readonly runState: RunState;
  readonly fault: FaultReason | null;
  /** Okamžik před prvním tikem. Tady čte `observationAtTick { tick: 0 }`. */
  readonly setup: Moment;
  readonly won: Moment | null;
  readonly lost: Moment | null;
  readonly final: Moment;
  /** Zachycené okamžiky podle tiku — jen ty, o které si volající řekl. */
  readonly captured: ReadonlyMap<number, Moment>;
}

function snapshot(runtime: Runtime, counts: Map<string, number>): Moment {
  return { tick: runtime.tick, runtime, state: runtime.state.slice(), fireCounts: new Map(counts) };
}

/**
 * Přehraje stopu do konce běhu nebo do horizontu a zachytí požadované okamžiky.
 *
 * Horizont je argument volajícího, ne přání dokumentu — tak to má
 * `verifyWitness` i protokol (`horizonDeclaredBy: "system"`).
 */
export function replay(
  world: WorldDocRuntime,
  trace: readonly TraceInput[],
  horizonTicks: number,
  captureTicks: readonly number[] = [],
): Replay {
  const runtime = createRuntime(world);
  const counts = new Map<string, number>();
  const wanted = new Set(captureTicks);
  const captured = new Map<number, Moment>();

  const setup = snapshot(runtime, counts);
  if (wanted.has(0)) captured.set(0, setup);

  let won: Moment | null = null;
  let lost: Moment | null = null;

  for (let tick = 0; tick < horizonTicks && runtime.runState === 'running'; tick += 1) {
    const inputs = trace.filter((entry) => entry.tick === tick);
    const result = step(runtime, inputs);
    for (const ruleId of result.fired) counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);

    if (wanted.has(runtime.tick)) captured.set(runtime.tick, snapshot(runtime, counts));
    if (result.runState === 'won') won = snapshot(runtime, counts);
    if (result.runState === 'lost') lost = snapshot(runtime, counts);
    if (result.runState !== 'running') break;
  }

  return {
    runState: runtime.runState,
    fault: runtime.fault,
    setup,
    won,
    lost,
    final: snapshot(runtime, counts),
    captured,
  };
}

// ---------------------------------------------------------------------------
// Čtečky stavu
// ---------------------------------------------------------------------------

function slot(moment: Moment, id: string): number | null {
  return moment.runtime.layout.index.has(id) ? readSlot(moment.runtime.layout, moment.state, id) : null;
}

function entityState(moment: Moment, stableId: string): string | null {
  const raw = slot(moment, `e:${stableId}:state`);
  if (raw === null) return null;
  return moment.runtime.entityStates.get(stableId)?.values[raw] ?? null;
}

function position(moment: Moment, stableId: string): readonly [number, number] | null {
  const x = slot(moment, `e:${stableId}:x`);
  const y = slot(moment, `e:${stableId}:y`);
  return x === null || y === null ? null : [x, y];
}

function inventoryHolds(moment: Moment, item: string): boolean {
  for (const decl of moment.runtime.doc.ir.slots) {
    if (decl.space !== 'inventory') continue;
    const id = `i:${decl.id}`;
    const raw = slot(moment, id);
    if (raw !== null && moment.runtime.slotEnums.get(id)?.values[raw] === item) return true;
  }
  return false;
}

function inRect(rect: readonly [number, number, number, number], x: number, y: number): boolean {
  return x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3];
}

/**
 * Kolik entit s daným tagem stojí v zóně.
 *
 * Zóna o víc obdélnících se při stavbě rozloží na `jmeno`, `jmeno.r1`, … (viz
 * `buildZones`), takže se sčítá přes celou rodinu jmen. Ohraničující obdélník by
 * počítal i entity mezi ostrovy zóny.
 */
function countInZone(moment: Moment, zone: string, tag: string): number {
  const space = moment.runtime.doc.space;
  const rects = Object.entries(space.zones).filter(([name]) => name === zone || name.startsWith(`${zone}.r`));
  let total = 0;
  for (const stableId of moment.runtime.entityOrder) {
    if (space.tags[stableId] !== tag) continue;
    if (slot(moment, `e:${stableId}:active`) !== 1) continue;
    const at = position(moment, stableId);
    if (at === null) continue;
    if (rects.some(([, rect]) => inRect(rect, at[0], at[1]))) total += 1;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Výrazy
// ---------------------------------------------------------------------------

export type ExprValue = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string };

const ok = (value: unknown): ExprValue => ({ ok: true, value });
const no = (reason: string): ExprValue => ({ ok: false, reason });

interface ParsedExpr {
  readonly fn: string;
  readonly args: readonly (string | number)[];
  readonly path: readonly (string | number)[];
}

const HEAD = /^([A-Za-z][A-Za-z0-9_]*)\(([^)]*)\)/;
const STEP = /^\.([A-Za-z][A-Za-z0-9_]*)|^\[(\d+)\]/;

export function parseExpr(source: string): ParsedExpr | null {
  const head = HEAD.exec(source);
  if (head === null) return null;

  const args: (string | number)[] = [];
  for (const raw of head[2].split(',')) {
    const token = raw.trim();
    if (token === '') continue;
    if (token.startsWith("'") && token.endsWith("'") && token.length >= 2) args.push(token.slice(1, -1));
    else if (/^-?\d+$/.test(token)) args.push(Number(token));
    else return null;
  }

  const path: (string | number)[] = [];
  let rest = source.slice(head[0].length);
  while (rest.length > 0) {
    const next = STEP.exec(rest);
    if (next === null) return null;
    path.push(next[1] !== undefined ? next[1] : Number(next[2]));
    rest = rest.slice(next[0].length);
  }

  return { fn: head[1], args, path };
}

/** Průchod cestou. Chybějící list je hodnota `undefined`, ne nezodpověditelnost. */
function walk(base: unknown, path: readonly (string | number)[]): unknown {
  let cursor = base;
  for (const token of path) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string | number, unknown>)[token];
  }
  return cursor;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Prochází i `allOf` / `anyOf` / `not`, protože ty jsou operátory, ne podmínky. */
function conditionKinds(node: unknown, out: Set<string>): void {
  const body = record(node);
  const kind = typeof body.kind === 'string' ? body.kind : null;
  if (kind !== null) out.add(kind);
  for (const operand of Array.isArray(body.operands) ? body.operands : []) conditionKinds(operand, out);
  if (body.operand !== undefined) conditionKinds(body.operand, out);
}

export function ruleBodies(sim: unknown): Record<string, unknown> {
  return record(record(sim).rules);
}

export function actionsOf(rule: unknown): Record<string, unknown>[] {
  const list = record(rule).actions;
  return (Array.isArray(list) ? list : []).map(record);
}

export function conditionKindsOf(sim: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  for (const rule of Object.values(ruleBodies(sim))) conditionKinds(record(rule).condition, out);
  return out;
}

/** Kontext jednoho vyhodnocení. `moment` chybí tam, kde se svět nepostavil. */
export interface ExprContext {
  readonly sim: unknown;
  readonly doc: unknown;
  readonly moment: Moment | null;
}

function entitiesWithRole(sim: unknown, role: string): string[] {
  return Object.entries(record(record(sim).entities))
    .filter(([, decl]) => record(decl).role === role)
    .map(([id]) => id);
}

function layoutOf(sim: unknown): Record<string, unknown> {
  return record(record(sim).layout);
}

function portalsOf(sim: unknown): unknown[] {
  const portals = layoutOf(sim).portals;
  return Array.isArray(portals) ? portals : [];
}

function levelCount(sim: unknown): number {
  const levels = layoutOf(sim).levels;
  if (Array.isArray(levels)) return levels.length;
  return typeof levels === 'number' ? levels : 1;
}

/**
 * Sedí každý soket uvnitř deklarovaného prostoru a je každé patro spojené?
 *
 * P1 nemá validátor layoutu — kolize soketů, souvislost navigační mřížky a plnou
 * dosažitelnost vlastní až P5 T505 (`protocol.v1.json`, `knownGapsDuringP1`).
 * Odpovídá se proto na tu půlku, kterou deklarovaný tvar unese: soket mimo
 * mřížku dosažitelný není, a patro navíc bez jediného portálu taky ne.
 */
function allSocketsReachable(sim: unknown): boolean {
  const layout = layoutOf(sim);
  const width = typeof layout.width === 'number' ? layout.width : 0;
  const height = typeof layout.height === 'number' ? layout.height : 0;
  for (const cell of Object.values(record(record(sim).sockets))) {
    if (!Array.isArray(cell) || cell.length < 2) return false;
    const [x, y] = cell as number[];
    if (typeof x !== 'number' || typeof y !== 'number') return false;
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
  }
  return levelCount(sim) <= 1 || portalsOf(sim).length > 0;
}

/**
 * Stojí dvě entity v témže prostoru?
 *
 * Prostor dělí jedině deklarované portály — jiný popis místností `sim` nemá.
 * Když portál není žádný, je prostor jeden a odpověď je „ano"; když nějaký je,
 * umí P1 potvrdit společný prostor jen u entit na témže soketu. Rozklad na
 * oblasti potřebuje navigační mřížku, a ta je P5 T505.
 */
function sameRoom(sim: unknown, a: string, b: string): boolean {
  const entities = record(record(sim).entities);
  const socketA = record(entities[a]).socket;
  const socketB = record(entities[b]).socket;
  if (typeof socketA !== 'string' || typeof socketB !== 'string') return false;
  if (socketA === socketB) return true;
  return portalsOf(sim).length === 0;
}

/** Entity, které začínají zamčené. Zámek je jediná deklarovaná překážka v `sim`. */
function lockedEntities(sim: unknown): string[] {
  return Object.entries(record(record(sim).entities))
    .filter(([, decl]) => record(decl).locked === true)
    .map(([id]) => id);
}

/** Pravidla, která entitu odemykají — `setLocked` s `locked: false`. */
function unlockRules(sim: unknown, stableId: string): [string, unknown][] {
  return Object.entries(ruleBodies(sim)).filter(([, rule]) =>
    actionsOf(rule).some((action) => action.kind === 'setLocked' && action.target === stableId && action.locked === false),
  );
}

/**
 * Dá se k cíli dojít bez vynuceného pořadí?
 *
 * Dvě věci pořadí vynucují a obě jsou v deklaraci vidět: zamčená entita, kterou
 * neodemyká **žádné** pravidlo (ta se neotevře nikdy), a dvě odemykací pravidla
 * visící na **témže čítači s různým prahem** (to druhé musí čekat na první).
 * Cokoli jemnějšího potřebuje průchod grafem stavů, a ten P1 nemá.
 */
function reachableWithoutOrder(sim: unknown): boolean {
  const thresholds = new Map<string, Set<number>>();
  for (const stableId of lockedEntities(sim)) {
    const rules = unlockRules(sim, stableId);
    if (rules.length === 0) return false;
    for (const [, rule] of rules) {
      const guard = record(record(rule).condition);
      const event = record(record(rule).event);
      const ref = typeof guard.ref === 'string' ? guard.ref : typeof event.ref === 'string' ? event.ref : null;
      const value = typeof guard.value === 'number' ? guard.value : typeof event.threshold === 'number' ? event.threshold : null;
      if (ref === null || value === null) continue;
      const seen = thresholds.get(ref) ?? new Set<number>();
      seen.add(value);
      thresholds.set(ref, seen);
    }
  }
  return [...thresholds.values()].every((values) => values.size <= 1);
}

/** Vrací čítač zpátky na deklarované minimum jiné pravidlo, než které ho zvyšuje? */
function counterResetOnMiss(sim: unknown, counterId: string): boolean {
  const min = record(record(record(record(sim).state).counters)[counterId]).min;
  if (typeof min !== 'number') return false;
  return Object.values(ruleBodies(sim)).some((rule) => {
    const actions = actionsOf(rule);
    const raises = actions.some((action) => action.kind === 'addCounter' && action.ref === counterId && Number(action.by) > 0);
    if (raises) return false;
    return actions.some(
      (action) =>
        action.ref === counterId &&
        ((action.kind === 'setCounter' && action.value === min) ||
          (action.kind === 'addCounter' && action.to === min) ||
          action.kind === 'resetCounter'),
    );
  });
}

/** Deklarované hlídkové trasy: pro každého agenta cíle jeho `moveTo`, v pořadí pravidel. */
function agentPatrolRoutes(sim: unknown): Record<string, string[]> {
  const routes: Record<string, string[]> = {};
  for (const agent of entitiesWithRole(sim, 'agent')) routes[agent] = [];
  for (const key of Object.keys(ruleBodies(sim)).sort()) {
    for (const action of actionsOf(ruleBodies(sim)[key])) {
      if (action.kind !== 'moveTo') continue;
      const target = typeof action.target === 'string' ? action.target : null;
      const socket = typeof action.socket === 'string' ? action.socket : null;
      if (target === null || socket === null || routes[target] === undefined) continue;
      routes[target].push(socket);
    }
  }
  return routes;
}

/** Píše nějaká akce s náhodným parametrem stav, který čte cesta k výhře? */
function randomOnWinPath(sim: unknown): boolean {
  const randomised = new Set<string>();
  for (const rule of Object.values(ruleBodies(sim))) {
    for (const action of actionsOf(rule)) {
      if (!Object.values(action).includes('random')) continue;
      for (const [field, value] of Object.entries(action)) {
        if (field !== 'target' && field !== 'ref' && field !== 'poolTag') continue;
        if (typeof value === 'string') randomised.add(value);
      }
    }
  }
  if (randomised.size === 0) return false;

  for (const rule of Object.values(ruleBodies(sim))) {
    if (!actionsOf(rule).some((action) => action.kind === 'win')) continue;
    const read = new Set<string>();
    const collect = (node: unknown): void => {
      const body = record(node);
      for (const field of ['target', 'ref', 'entity', 'tag', 'agent']) {
        const value = body[field];
        if (typeof value === 'string') read.add(value);
      }
      for (const operand of Array.isArray(body.operands) ? body.operands : []) collect(operand);
      if (body.operand !== undefined) collect(body.operand);
    };
    collect(record(rule).condition);
    collect(record(rule).event);
    for (const name of read) {
      // Pool se jmenuje prefixem svých členů (`target` -> `target0`), takže se
      // porovnává i prefixem — jinak by se čtení `target0` s náhodným `target`
      // minulo a celá kontrola by mlčela.
      for (const source of randomised) if (name === source || name.startsWith(source)) return true;
    }
  }
  return false;
}

/**
 * Vyhodnotí zmrazený výraz. `moment` je okamžik běhu, ve kterém se ptáme;
 * statické čtečky ho nepotřebují a fungují i bez postaveného světa.
 */
export function evaluate(source: string, ctx: ExprContext): ExprValue {
  const parsed = parseExpr(source);
  if (parsed === null) return no(`neznámý tvar výrazu: ${source}`);

  const { fn, args, path } = parsed;
  const sim = ctx.sim;
  const named = (index: number): string => String(args[index] ?? '');
  const dynamic = (read: (moment: Moment) => ExprValue): ExprValue =>
    ctx.moment === null ? no(`${source} je pozorování běhu, ale svět se nepostavil`) : read(ctx.moment);

  switch (fn) {
    case 'rule': {
      const rule = ruleBodies(sim)[named(0)];
      if (rule === undefined) return no(`pravidlo ${named(0)} neexistuje`);
      return ok(walk(rule, path));
    }
    case 'layout':
      return ok(walk(layoutOf(sim), path));
    case 'ruleCount':
      return ok(Object.keys(ruleBodies(sim)).length);
    case 'winRuleCount':
      return ok(Object.values(ruleBodies(sim)).filter((rule) => actionsOf(rule).some((a) => a.kind === 'win')).length);
    case 'ruleActionCount': {
      const rule = ruleBodies(sim)[named(0)];
      if (rule === undefined) return no(`pravidlo ${named(0)} neexistuje`);
      return ok(actionsOf(rule).length);
    }
    case 'ruleConditionOperandCount': {
      const rule = ruleBodies(sim)[named(0)];
      if (rule === undefined) return no(`pravidlo ${named(0)} neexistuje`);
      const condition = record(rule).condition;
      if (condition === null || condition === undefined) return ok(0);
      const operands = record(condition).operands;
      return ok(Array.isArray(operands) ? operands.length : 1);
    }
    case 'timerExists':
      return ok(Object.hasOwn(record(record(record(sim).state).timers), named(0)));
    case 'entityCountByRole':
      return ok(entitiesWithRole(sim, named(0)).length);
    case 'levelCount':
      return ok(levelCount(sim));
    case 'portalCount':
      return ok(portalsOf(sim).length);
    case 'layoutTopologyHash':
      return ok(canonicalHash({ layout: layoutOf(sim), sockets: record(record(sim).sockets) }));
    case 'danglingRefCount':
      return ok(findDanglingReferences(ctx.doc).length);
    case 'allSocketsReachable':
      return ok(allSocketsReachable(sim));
    case 'sameRoom':
      return ok(sameRoom(sim, named(0), named(1)));
    case 'reachableWithoutOrder':
      return ok(reachableWithoutOrder(sim));
    case 'counterResetOnMiss':
      return ok(counterResetOnMiss(sim, named(0)));
    case 'agentPatrolRoutes':
      return ok(agentPatrolRoutes(sim));
    case 'randomNotOnWinPath':
      return ok(!randomOnWinPath(sim));

    case 'counter': {
      const decl = record(record(record(sim).state).counters)[named(0)];
      if (decl === undefined) return no(`čítač ${named(0)} neexistuje`);
      if (path.length > 0) return ok(walk(decl, path));
      return dynamic((moment) => {
        const value = slot(moment, `c:${named(0)}`);
        return value === null ? no(`čítač ${named(0)} nemá slot`) : ok(value);
      });
    }
    case 'timer': {
      const decl = record(record(record(sim).state).timers)[named(0)];
      if (decl === undefined) return no(`timer ${named(0)} neexistuje`);
      if (path[0] === 'remainingTicks')
        return dynamic((moment) => {
          const value = slot(moment, `t:${named(0)}`);
          return value === null ? no(`timer ${named(0)} nemá slot`) : ok(value);
        });
      return ok(walk(decl, path));
    }
    case 'entity': {
      const decl = record(record(sim).entities)[named(0)];
      if (decl === undefined) return no(`entita ${named(0)} neexistuje`);
      if (path[0] === 'locked')
        return dynamic((moment) => {
          const value = slot(moment, `e:${named(0)}:locked`);
          return value === null ? ok(record(decl).locked === true) : ok(value === 1);
        });
      if (path[0] === 'state')
        return dynamic((moment) => {
          const value = entityState(moment, named(0));
          return value === null ? no(`entita ${named(0)} nemá stav`) : ok(value);
        });
      return ok(walk(decl, path));
    }
    case 'hasItem':
      return dynamic((moment) => ok(inventoryHolds(moment, named(1))));
    case 'countInZone':
      return dynamic((moment) => ok(countInZone(moment, named(0), named(1))));
    case 'fireCount':
      return dynamic((moment) => ok(moment.fireCounts.get(named(0)) ?? 0));
    case 'distanceToCentre':
      return dynamic((moment) => {
        const at = position(moment, named(0));
        if (at === null) return no(`entita ${named(0)} nemá pozici`);
        const layout = layoutOf(sim);
        const width = typeof layout.width === 'number' ? layout.width : 0;
        const height = typeof layout.height === 'number' ? layout.height : 0;
        return ok(Math.abs(at[0] - Math.floor(width / 2)) + Math.abs(at[1] - Math.floor(height / 2)));
      });

    default:
      return no(`výraz ${fn}() není ve zmrazeném slovníku scoreru`);
  }
}

/** Porovnání dvou hodnot. `==` je kanonická rovnost, ne referenční. */
export function compare(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case '==':
      return canonical(left) === canonical(right);
    case '!=':
      return canonical(left) !== canonical(right);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (typeof left !== 'number' || typeof right !== 'number') return false;
      return op === '<' ? left < right : op === '<=' ? left <= right : op === '>' ? left > right : left >= right;
    }
    default:
      return false;
  }
}
