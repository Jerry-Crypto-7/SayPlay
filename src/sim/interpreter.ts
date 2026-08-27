/**
 * Interpret s fázovaným tikem a **totální** přechodovou funkcí.
 *
 * `DESIGN-BOOK.md` §6 na totalitě staví celou garanci: *„Deterministický
 * simulátor, který se zasekne při zpracování událostí, neověří nic."* Totalita
 * je ale tvrzení o **všech** vstupech, a to vzorkování nikdy nedokáže. Fuzzing
 * ani patologické fixture ji proto v tomhle souboru nedokazují — jsou to
 * detektory regresí nad důkazem, který nese konstrukce:
 *
 * 1. **Monotónní rozpočet.** `budget` uvnitř tiku jen klesá; jediné místo, kde
 *    roste, je `resetBudget` na hranici tiku.
 * 2. **Dvojitý buffer front.** Fronta zapisovaná během tiku je jiný objekt než
 *    fronta, ze které se čerpá. `onSignal(A) → emit(A)` tak fyzicky nemůže
 *    dočerpat vlastní emisi v témže tiku.
 * 3. **Vyčerpanost přechodů.** Přepínače končí `never` větví, kterou ověří
 *    překladač.
 * 4. **Ohraničenost fáze zvenčí.** Každá fáze má mez v počtu položek z
 *    `IrLimits` (`phaseBound`), nikdy ze vstupu.
 * 5. **Ohraničenost primitiva zevnitř.** Každá vnitřní smyčka má mez přímo v
 *    podmínce — buď klesající `budget`, nebo `sightBound` / `pathBound` /
 *    `phaseBound`. Proto jsou tu indexované smyčky a ne `for…of` ani
 *    `forEach`/`map`: iterace bez podmínky nemá kam mez napsat a statická
 *    kontrola v `__tests__/totality.test.ts` je odmítá.
 *
 * Hašuje se **mimo** `step()`. Hash je pozorování stavu, ne krok přechodu, a
 * kdyby se počítal uvnitř, protáhl by do dosahu totality smyčku přes délku pole,
 * jejíž mez neplyne z mezí světa.
 */

import { atTickBoundary, evalBool, evalNode, factKey, type Observation } from '../ir/eval';
import type { EntityDecl, IrDoc, IrEffect, IrLimits, IrRule, SlotDecl, StateRef } from '../ir/types';
import { pairBound, pathBound, phaseBound, sightBound, type Phase } from './phases';
import { createState, defineLayout, readSlot, writeSlot, type SlotSpec, type StateLayout } from './state';

// ---------------------------------------------------------------------------
// Prostorová deklarace
//
// Mřížka, sockety a zóny žijí v povrchové části `sim`, ne v IR — IR je snížená
// verifikační reprezentace a `world-ir-v1` je vědomě neobsahuje. Validátor
// layoutu (kolize socketů, souvislost mřížky, dosažitelnost) je podle protokolu
// `knownGapsDuringP1` až P5 T505; tady se čte jako daná deklarace.
// ---------------------------------------------------------------------------

export interface SpaceDecl {
  /** Jméno socketu → buňka mřížky. */
  readonly sockets: Readonly<Record<string, readonly [number, number]>>;
  /** Jméno zóny → obdélník `[x, y, šířka, výška]` v buňkách. */
  readonly zones: Readonly<Record<string, readonly [number, number, number, number]>>;
  /** Neprůhledné a neprůchodné buňky. */
  readonly blocked: readonly (readonly [number, number])[];
  /** `stableId` entity → tag poolu, pro `countInZone` a `spawn`. */
  readonly tags: Readonly<Record<string, string>>;
}

/** Kanonický vstup jednoho tiku. Je to jediná cesta, kterou se svět dozví o hráči. */
export interface TraceInput {
  readonly tick: number;
  readonly actor: string;
  readonly actionId: string;
  readonly target?: string;
}

export interface WorldDocRuntime {
  readonly ir: IrDoc;
  readonly space: SpaceDecl;
  /** Zaznamenaná stopa vstupů — svědek. */
  readonly trace: readonly TraceInput[];
  /** Tik, ve kterém má stopa dojít do výhry. Kontroluje ho AC T9. */
  readonly winsAtTick?: number;
}

// ---------------------------------------------------------------------------
// Běhový stav
// ---------------------------------------------------------------------------

/**
 * Verze runtimu, kterou zaznamenává certifikát svědka.
 *
 * Není to kosmetika: certifikát tvrdí „tenhle svědek dojde do výhry", a to
 * tvrzení platí jen proti konkrétní sémantice tiku. Změna pořadí fází, tvaru
 * pulzních událostí nebo mezí musí tuhle konstantu zvednout, jinak by staré
 * certifikáty dál vypadaly platně nad runtimem, který je nikdy neověřil.
 */
export const RUNTIME_VERSION = 'sim-runtime-v1';

export type RunState = 'running' | 'won' | 'lost' | 'runtimeFault';

/** Proč tik atomicky spadl. Je to definovaný přechod runtimu, ne výjimka. */
export type FaultReason = 'budget-exhausted' | 'queue-overflow' | 'entity-cap';

/**
 * Kolik položek která fáze v tomhle tiku skutečně zpracovala.
 *
 * Je to instrumentace pro podmínku 4, ne stav: do hashe nevstupuje a čte se
 * výhradně z `StepResult`. Bez ní by se aserce „iterací je nejvýš tolik, kolik
 * deklarují meze světa" dala napsat jen přes proxy metriku, tedy přes něco, co
 * s počtem iterací pouze koreluje.
 */
export type PhaseCounts = Readonly<Record<Phase, number>>;

function zeroCounts(): Record<Phase, number> {
  return { sense: 0, trigger: 0, apply: 0, settle: 0 };
}

export interface StepResult {
  readonly runState: RunState;
  readonly tick: number;
  readonly fault: FaultReason | null;
  /** Kolik spuštění pravidel tik spotřeboval. Instrumentace pro podmínku 1. */
  readonly firings: number;
  /** Počet iterací po fázích. Instrumentace pro podmínku 4. */
  readonly iterations: PhaseCounts;
  /**
   * `ruleId` pravidel, jejichž efekty tenhle tik **doopravdy provedl** — v pořadí
   * vykonání. Čte to `fireCount()` sémantického scoreru (T16): kontrakt `C06`
   * žádá „pravidlo spustilo právě jednou" a to je jediná vlastnost, kterou zvenčí
   * nejde dopočítat ze stavu — dva průchody týmž pravidlem umí skončit ve stejném
   * stavu.
   *
   * **Spuštěné, ne jen odpálené.** Pravidlo, na které se kvůli stropu nedostalo,
   * tu není, protože jeho efekty neproběhly. A tik ukončený `runtimeFault` vrací
   * prázdné pole: stav se atomicky vrátil na začátek tiku, takže se nestalo nic.
   */
  readonly fired: readonly string[];
}

const SYMBOL_NONE = 'none';
const SYMBOL_EMPTY = 'empty';

interface EnumTable {
  readonly values: readonly string[];
  readonly index: ReadonlyMap<string, number>;
}

function enumTable(values: readonly string[]): EnumTable {
  const index = new Map<string, number>();
  const bound = values.length;
  for (let i = 0; i < bound; i += 1) {
    index.set(values[i], i);
  }
  return { values, index };
}

/**
 * Klesající rozpočet práce.
 *
 * Je to objekt, ne číslo, aby `spend` šlo předat dovnitř primitiva a aby
 * statická kontrola měla jméno, které v podmínkách smyček hledá. Roste výhradně
 * v `resetBudget` — a to má v `src/sim/` právě jedno volání, na hranici tiku.
 */
export interface Budget {
  remaining: number;
}

function resetBudget(budget: Budget, limits: IrLimits): void {
  budget.remaining = limits.maxRuleFiringsPerTick;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface Runtime {
  readonly doc: WorldDocRuntime;
  readonly layout: StateLayout;
  readonly limits: IrLimits;
  readonly entityOrder: readonly string[];
  readonly entityDecls: ReadonlyMap<string, EntityDecl>;
  readonly entityStates: ReadonlyMap<string, EnumTable>;
  readonly slotEnums: ReadonlyMap<string, EnumTable>;
  readonly ruleOrder: readonly IrRule[];
  /** Predikáty adresované jménem. Vyhledání je `Map.get`, ne průchod polem. */
  readonly predicateIndex: ReadonlyMap<string, number>;
  /** Jména zón se čtou z deklarace jednou, ne v každém tiku. */
  readonly zoneNames: readonly string[];
  readonly budget: Budget;
  state: Uint32Array;
  runState: RunState;
  fault: FaultReason | null;
  tick: number;
  /** Fronta, ze které tik ČERPÁ. Naplnil ji předchozí tik. */
  drainQueue: string[];
  /** Fronta, do které tik ZAPISUJE. Doručí se až v příštím tiku. */
  writeQueue: string[];
  /** Pozorování na začátku tiku — `onEdge` proti němu čte pre-stav. */
  previous: Observation;
}

const ENTITY_FIELDS = ['state', 'locked', 'x', 'y', 'active', 'freeze', 'moveTo', 'moveTicks'] as const;

function entitySlotId(stableId: string, field: (typeof ENTITY_FIELDS)[number]): string {
  return `e:${stableId}:${field}`;
}

function slotIdOf(decl: SlotDecl): string {
  switch (decl.space) {
    case 'counter':
      return `c:${decl.id}`;
    case 'flag':
      return `f:${decl.id}`;
    case 'timer':
      return `t:${decl.id}`;
    case 'inventory':
      return `i:${decl.id}`;
    case 'memory':
      return `m:${decl.agent}#${decl.index}`;
    default: {
      const exhaustive: never = decl;
      return exhaustive;
    }
  }
}

/** Pořadí vykonání je explicitní `(phase, priority, ruleId)` — §7 krok 1. */
function compareRules(a: IrRule, b: IrRule): number {
  if (a.phase !== b.phase) return a.phase - b.phase;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
}

export function createRuntime(doc: WorldDocRuntime): Runtime {
  const ir = doc.ir;
  const specs: SlotSpec[] = [];
  const slotEnums = new Map<string, EnumTable>();

  const slotCount = ir.slots.length;
  for (let i = 0; i < slotCount; i += 1) {
    const decl = ir.slots[i];
    const id = slotIdOf(decl);
    switch (decl.space) {
      case 'counter':
        specs.push({ id, kind: 'counter', min: decl.min, max: decl.max, initial: decl.initial });
        break;
      case 'flag':
        specs.push({ id, kind: 'flag', min: 0, max: 1, initial: decl.initial ? 1 : 0 });
        break;
      case 'timer':
        specs.push({ id, kind: 'timer', min: 0, max: decl.maxTicks, initial: decl.initial });
        break;
      case 'inventory':
      case 'memory': {
        const table = enumTable([SYMBOL_EMPTY, ...decl.values]);
        slotEnums.set(id, table);
        specs.push({
          id,
          kind: 'enum',
          min: 0,
          max: table.values.length - 1,
          initial: table.index.get(decl.initial) ?? 0,
        });
        break;
      }
      default: {
        const exhaustive: never = decl;
        throw new Error(`unreachable slot space: ${String(exhaustive)}`);
      }
    }
  }

  const entityOrder: string[] = [];
  const entityDecls = new Map<string, EntityDecl>();
  const entityStates = new Map<string, EnumTable>();
  const entityCount = ir.entities.length;
  for (let i = 0; i < entityCount; i += 1) {
    const entity = ir.entities[i];
    const table = enumTable([SYMBOL_NONE, ...entity.states]);
    entityOrder.push(entity.stableId);
    entityDecls.set(entity.stableId, entity);
    entityStates.set(entity.stableId, table);
    const cell = doc.space.sockets[entity.socket] ?? [0, 0];
    specs.push({
      id: entitySlotId(entity.stableId, 'state'),
      kind: 'enum',
      min: 0,
      max: table.values.length - 1,
      initial: table.index.get(entity.initialState) ?? 0,
    });
    specs.push({
      id: entitySlotId(entity.stableId, 'locked'),
      kind: 'flag',
      min: 0,
      max: 1,
      initial: entity.initialLocked ? 1 : 0,
    });
    specs.push({ id: entitySlotId(entity.stableId, 'x'), kind: 'counter', min: 0, max: ir.limits.gridWidth, initial: cell[0] });
    specs.push({ id: entitySlotId(entity.stableId, 'y'), kind: 'counter', min: 0, max: ir.limits.gridHeight, initial: cell[1] });
    specs.push({ id: entitySlotId(entity.stableId, 'active'), kind: 'flag', min: 0, max: 1, initial: 1 });
    specs.push({ id: entitySlotId(entity.stableId, 'freeze'), kind: 'timer', min: 0, max: 0xffff, initial: 0 });
    specs.push({ id: entitySlotId(entity.stableId, 'moveTo'), kind: 'counter', min: 0, max: 0xffff, initial: 0 });
    specs.push({ id: entitySlotId(entity.stableId, 'moveTicks'), kind: 'timer', min: 0, max: 0xffff, initial: 0 });
  }

  const layout = defineLayout(specs);
  const ruleOrder = [...ir.rules].sort(compareRules);

  const predicateIndex = new Map<string, number>();
  const predicateCount = ir.predicates.length;
  for (let i = 0; i < predicateCount; i += 1) {
    predicateIndex.set(ir.predicates[i].predicateId, ir.predicates[i].expr);
  }

  return {
    doc,
    layout,
    limits: ir.limits,
    entityOrder,
    entityDecls,
    entityStates,
    slotEnums,
    ruleOrder,
    predicateIndex,
    zoneNames: Object.keys(doc.space.zones),
    budget: { remaining: ir.limits.maxRuleFiringsPerTick },
    state: createState(layout),
    runState: 'running',
    fault: null,
    tick: 0,
    drainQueue: [],
    writeQueue: [],
    previous: emptyObservation(),
  };
}

/**
 * Je entita deklarovaná **a aktivní**?
 *
 * Vstupní hranice podle `DESIGN-BOOK.md` §13.1: kanonická akce se čte proti
 * deklarovanému `sim`, nikdy proti kameře ani vykreslené geometrii. Verifikátor
 * se tím ptá, jestli k-tý krok svědka vůbec šlo udělat — jednat despawnutou
 * entitou hráč nemohl, takže taková stopa není záznam hry.
 */
export function entityActive(runtime: Runtime, stableId: string): boolean {
  if (!runtime.entityDecls.has(stableId)) return false;
  return readSlot(runtime.layout, runtime.state, entitySlotId(stableId, 'active')) === 1;
}

/** Kde entita v tuhle chvíli stojí a v jakém je stavu. Čtení, ne krok přechodu. */
export interface EntityPlacement {
  readonly stableId: string;
  readonly x: number;
  readonly y: number;
  readonly active: boolean;
  readonly state: string;
  readonly locked: boolean;
}

/**
 * Poloha všech entit v pořadí deklarace.
 *
 * Existuje proto, že `Observation` polohu nenese — `sense` si `x` a `y` čte,
 * ale ven z tiku posílá jen odvozené fakty (`inZone`, `overlapping`). Vykreslení
 * přitom potřebuje přesně tu buňku, a jediná alternativa by byla zopakovat
 * konvenci jmen slotů (`e:<id>:x`) ve vykreslovací vrstvě — tedy druhý zdroj
 * pravdy pro privátní kódování, které se tiše rozejde.
 *
 * **Mimo tikovou cestu a mimo hash.** Nic nezapisuje a nikdo z `step()` ji
 * nevolá. Smyčka přesto nese mez `limits.maxEntities` v podmínce, aby se
 * nemusela zapisovat na pinutý seznam výjimek v `__tests__/totality.test.ts` —
 * ohraničená smyčka je levnější než výjimka, kterou musí někdo hlídat.
 */
export function entityPlacements(runtime: Runtime): EntityPlacement[] {
  const placements: EntityPlacement[] = [];
  const order = runtime.entityOrder;

  for (let i = 0; i < runtime.limits.maxEntities && i < order.length; i += 1) {
    const id = order[i];
    const table = runtime.entityStates.get(id);
    placements.push({
      stableId: id,
      x: readSlot(runtime.layout, runtime.state, entitySlotId(id, 'x')),
      y: readSlot(runtime.layout, runtime.state, entitySlotId(id, 'y')),
      active: readSlot(runtime.layout, runtime.state, entitySlotId(id, 'active')) === 1,
      state: table?.values[readSlot(runtime.layout, runtime.state, entitySlotId(id, 'state'))] ?? SYMBOL_NONE,
      locked: readSlot(runtime.layout, runtime.state, entitySlotId(id, 'locked')) === 1,
    });
  }

  return placements;
}

function emptyObservation(): Observation {
  return {
    counters: {},
    flags: {},
    timers: {},
    inventory: {},
    memory: {},
    entityStates: {},
    locked: {},
    facts: new Set<string>(),
    pulses: new Set<string>(),
    zoneCounts: {},
  };
}

// ---------------------------------------------------------------------------
// Fáze 1 — sense
// ---------------------------------------------------------------------------

function isBlocked(space: SpaceDecl, x: number, y: number, limits: IrLimits): boolean {
  const bound = limits.gridWidth * limits.gridHeight;
  const cells = space.blocked;
  for (let i = 0; i < bound && i < cells.length; i += 1) {
    if (cells[i][0] === x && cells[i][1] === y) return true;
  }
  return false;
}

/** Výsledek jednoho průchodu mřížkou i s počtem iterací, které stál. */
export interface SightTrace {
  readonly visible: boolean;
  readonly steps: number;
}

/**
 * Viditelnost průchodem mřížkou.
 *
 * Mez je `sightBound`, tedy `šířka + výška`, a je **v podmínce smyčky**.
 * Degenerovaný paprsek — obě entity ve stejné kvantované buňce — vrací hned na
 * první iteraci: to je přesně ten případ, kterým review P1 kolo 2 prostřelilo
 * první čtyři podmínky totality, protože počet položek fáze omezovaly, ale
 * práci uvnitř jedné položky ne.
 *
 * `steps` je exportovaná instrumentace, ne ozdoba: „vrátí v jedné iteraci" je
 * tvrzení o vnitřku primitiva a zvenčí — z faktu `visible` nebo z doby běhu —
 * se nedá pozorovat.
 */
export function traceSight(
  space: SpaceDecl,
  limits: IrLimits,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): SightTrace {
  const bound = sightBound(limits);
  let x = ax;
  let y = ay;
  const dx = Math.abs(bx - ax);
  const dy = Math.abs(by - ay);
  const stepX = ax < bx ? 1 : -1;
  const stepY = ay < by ? 1 : -1;
  let error = dx - dy;
  for (let i = 0; i < bound; i += 1) {
    if (x === bx && y === by) return { visible: true, steps: i + 1 };
    if ((x !== ax || y !== ay) && isBlocked(space, x, y, limits)) return { visible: false, steps: i + 1 };
    const doubled = error * 2;
    if (doubled > -dy) {
      error -= dy;
      x += stepX;
    }
    if (doubled < dx) {
      error += dx;
      y += stepY;
    }
  }
  return { visible: false, steps: bound };
}

function hasLineOfSight(
  space: SpaceDecl,
  limits: IrLimits,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  return traceSight(space, limits, ax, ay, bx, by).visible;
}

function inRect(rect: readonly [number, number, number, number], x: number, y: number): boolean {
  return x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3];
}

function sense(runtime: Runtime, counts: Record<Phase, number>): Observation {
  const { doc, layout, limits, entityOrder } = runtime;
  const counters: Record<string, number> = {};
  const flags: Record<string, boolean> = {};
  const timers: Record<string, number> = {};
  const inventory: Record<string, string> = {};
  const memory: Record<string, string> = {};
  const states: Record<string, string> = {};
  const locked: Record<string, boolean> = {};
  const facts = new Set<string>();
  const zoneCounts: Record<string, number> = {};

  // Mez je deklarovaná (`maxSlots`), ne délka vstupního pole. Bez ní by práce
  // fáze rostla s dokumentem — tik by terminoval, ohraničený by nebyl.
  const slotBound = limits.maxSlots;
  const slotCount = doc.ir.slots.length;
  for (let i = 0; i < slotBound && i < slotCount; i += 1) {
    counts.sense += 1;
    const decl = doc.ir.slots[i];
    const id = slotIdOf(decl);
    const raw = readSlot(layout, runtime.state, id);
    switch (decl.space) {
      case 'counter':
        counters[decl.id] = raw;
        break;
      case 'flag':
        flags[decl.id] = raw === 1;
        break;
      case 'timer':
        timers[decl.id] = raw;
        break;
      case 'inventory':
        inventory[decl.id] = runtime.slotEnums.get(id)?.values[raw] ?? SYMBOL_EMPTY;
        break;
      case 'memory':
        memory[`${decl.agent}#${decl.index}`] = runtime.slotEnums.get(id)?.values[raw] ?? SYMBOL_EMPTY;
        break;
      default: {
        const exhaustive: never = decl;
        throw new Error(`unreachable slot space: ${String(exhaustive)}`);
      }
    }
  }

  facts.add(factKey('started', []));

  // Inventář drží položky po slotech; `socketHolds` je jeho protějšek u socketu.
  const invCount = doc.ir.slots.length;
  for (let i = 0; i < slotBound && i < invCount; i += 1) {
    counts.sense += 1;
    const decl = doc.ir.slots[i];
    if (decl.space !== 'inventory') continue;
    const held = inventory[decl.id];
    if (held !== SYMBOL_EMPTY) facts.add(factKey('hasItem', [decl.id, held]));
  }

  const entityBound = limits.maxEntities;
  const zoneNames = runtime.zoneNames;
  for (let i = 0; i < entityBound && i < entityOrder.length; i += 1) {
    counts.sense += 1;
    const id = entityOrder[i];
    if (readSlot(layout, runtime.state, entitySlotId(id, 'active')) !== 1) continue;
    const table = runtime.entityStates.get(id);
    states[id] = table?.values[readSlot(layout, runtime.state, entitySlotId(id, 'state'))] ?? SYMBOL_NONE;
    locked[id] = readSlot(layout, runtime.state, entitySlotId(id, 'locked')) === 1;
    const x = readSlot(layout, runtime.state, entitySlotId(id, 'x'));
    const y = readSlot(layout, runtime.state, entitySlotId(id, 'y'));
    for (let z = 0; z < limits.maxZones && z < zoneNames.length; z += 1) {
      counts.sense += 1;
      const zone = zoneNames[z];
      if (!inRect(doc.space.zones[zone], x, y)) continue;
      facts.add(factKey('inZone', [id, zone]));
      const tag = doc.space.tags[id] ?? id;
      const key = `${zone}#${tag}`;
      zoneCounts[key] = (zoneCounts[key] ?? 0) + 1;
    }
  }

  // Párové fakty. Mez je `maxEntities²` a je v podmínce obou smyček.
  const pairLimit = pairBound(limits);
  let pairs = 0;
  for (let i = 0; i < entityBound && i < entityOrder.length; i += 1) {
    for (let j = 0; j < entityBound && j < entityOrder.length && pairs < pairLimit; j += 1) {
      counts.sense += 1;
      if (i === j) continue;
      pairs += 1;
      const a = entityOrder[i];
      const b = entityOrder[j];
      if (readSlot(layout, runtime.state, entitySlotId(a, 'active')) !== 1) continue;
      if (readSlot(layout, runtime.state, entitySlotId(b, 'active')) !== 1) continue;
      const ax = readSlot(layout, runtime.state, entitySlotId(a, 'x'));
      const ay = readSlot(layout, runtime.state, entitySlotId(a, 'y'));
      const bx = readSlot(layout, runtime.state, entitySlotId(b, 'x'));
      const by = readSlot(layout, runtime.state, entitySlotId(b, 'y'));
      if (ax === bx && ay === by) facts.add(factKey('overlapping', [a, b]));
      if (hasLineOfSight(doc.space, limits, ax, ay, bx, by)) facts.add(factKey('visible', [a, b]));
    }
  }

  return {
    counters,
    flags,
    timers,
    inventory,
    memory,
    entityStates: states,
    locked,
    facts,
    pulses: new Set<string>(runtime.drainQueue),
    zoneCounts,
  };
}

// ---------------------------------------------------------------------------
// Fáze 3 — apply
// ---------------------------------------------------------------------------

function writeRef(runtime: Runtime, ref: StateRef, value: number | boolean | string): void {
  const { layout } = runtime;
  switch (ref.space) {
    case 'counter':
      writeSlot(layout, runtime.state, `c:${ref.slot}`, Number(value));
      break;
    case 'flag':
      writeSlot(layout, runtime.state, `f:${ref.slot}`, value === true ? 1 : 0);
      break;
    case 'timer':
      writeSlot(layout, runtime.state, `t:${ref.slot}`, Number(value));
      break;
    case 'inventory': {
      const id = `i:${ref.slot}`;
      writeSlot(layout, runtime.state, id, runtime.slotEnums.get(id)?.index.get(String(value)) ?? 0);
      break;
    }
    case 'memory': {
      const id = `m:${ref.agent}#${ref.index}`;
      writeSlot(layout, runtime.state, id, runtime.slotEnums.get(id)?.index.get(String(value)) ?? 0);
      break;
    }
    case 'entityState': {
      const table = runtime.entityStates.get(ref.entity);
      writeSlot(layout, runtime.state, entitySlotId(ref.entity, 'state'), table?.index.get(String(value)) ?? 0);
      break;
    }
    case 'locked':
      writeSlot(layout, runtime.state, entitySlotId(ref.entity, 'locked'), value === true ? 1 : 0);
      break;
    case 'observed':
    case 'pulse':
      // Protokol je ze `ASSIGNABLE_SPACES` vynechává: odvozený fakt se odvozuje,
      // nezapisuje. Zápis do něj je tichý no-op, ne výjimka — schéma ho odmítne
      // dřív, než se sem dostane.
      break;
    default: {
      const exhaustive: never = ref;
      throw new Error(`unreachable ref space: ${String(exhaustive)}`);
    }
  }
}

/** Jeden krok po mřížce směrem k cíli. Mez je `pathBound` a je v podmínce. */
function stepToward(runtime: Runtime, entity: string, targetX: number, targetY: number): void {
  const { layout, limits, doc } = runtime;
  const x = readSlot(layout, runtime.state, entitySlotId(entity, 'x'));
  const y = readSlot(layout, runtime.state, entitySlotId(entity, 'y'));
  const bound = pathBound(limits);
  const candidates: readonly (readonly [number, number])[] = [
    [x + Math.sign(targetX - x), y],
    [x, y + Math.sign(targetY - y)],
  ];
  for (let i = 0; i < bound && i < candidates.length; i += 1) {
    const [nx, ny] = candidates[i];
    if (nx === x && ny === y) continue;
    if (nx < 0 || ny < 0 || nx > limits.gridWidth || ny > limits.gridHeight) continue;
    if (isBlocked(doc.space, nx, ny, limits)) continue;
    writeSlot(layout, runtime.state, entitySlotId(entity, 'x'), nx);
    writeSlot(layout, runtime.state, entitySlotId(entity, 'y'), ny);
    return;
  }
}

/** Nejnižší neaktivní ID z poolu, deterministicky (§5). */
function lowestInactive(runtime: Runtime, poolTag: string): string | null {
  const { layout, limits, doc, entityOrder } = runtime;
  const bound = limits.maxEntities;
  for (let i = 0; i < bound && i < entityOrder.length; i += 1) {
    const id = entityOrder[i];
    if ((doc.space.tags[id] ?? id) !== poolTag) continue;
    if (readSlot(layout, runtime.state, entitySlotId(id, 'active')) === 0) return id;
  }
  return null;
}

function activeCount(runtime: Runtime): number {
  const { layout, limits, entityOrder } = runtime;
  const bound = limits.maxEntities;
  let total = 0;
  for (let i = 0; i < bound && i < entityOrder.length; i += 1) {
    if (readSlot(layout, runtime.state, entitySlotId(entityOrder[i], 'active')) === 1) total += 1;
  }
  return total;
}

type EffectOutcome = 'ok' | 'won' | 'lost' | FaultReason;

function applyEffect(runtime: Runtime, effect: IrEffect, obs: Observation): EffectOutcome {
  const { layout, limits, doc } = runtime;
  switch (effect.op) {
    case 'assign':
      writeRef(runtime, effect.ref, evalNode(doc.ir, effect.value, obs));
      return 'ok';
    case 'addCounter': {
      const id = `c:${effect.slot}`;
      writeSlot(layout, runtime.state, id, readSlot(layout, runtime.state, id) + effect.delta);
      return 'ok';
    }
    case 'startTimer':
      writeSlot(layout, runtime.state, `t:${effect.slot}`, effect.durationTicks);
      return 'ok';
    case 'stopTimer':
      writeSlot(layout, runtime.state, `t:${effect.slot}`, 0);
      return 'ok';
    case 'spawn': {
      if (activeCount(runtime) >= limits.maxEntities) return 'entity-cap';
      const id = lowestInactive(runtime, effect.poolTag);
      if (id === null) return 'ok';
      const cell = doc.space.sockets[effect.socket] ?? [0, 0];
      writeSlot(layout, runtime.state, entitySlotId(id, 'active'), 1);
      writeSlot(layout, runtime.state, entitySlotId(id, 'x'), cell[0]);
      writeSlot(layout, runtime.state, entitySlotId(id, 'y'), cell[1]);
      return 'ok';
    }
    case 'despawn':
      writeSlot(layout, runtime.state, entitySlotId(effect.entity, 'active'), 0);
      return 'ok';
    case 'moveTo': {
      const cell = doc.space.sockets[effect.socket];
      if (cell === undefined) return 'ok';
      writeSlot(layout, runtime.state, entitySlotId(effect.entity, 'moveTo'), cell[0] * (limits.gridHeight + 1) + cell[1] + 1);
      writeSlot(layout, runtime.state, entitySlotId(effect.entity, 'moveTicks'), effect.ticks);
      return 'ok';
    }
    case 'freeze':
      writeSlot(layout, runtime.state, entitySlotId(effect.entity, 'freeze'), effect.ticks);
      return 'ok';
    case 'giveItem':
      writeRef(runtime, { space: 'inventory', slot: effect.slot }, effect.item);
      return 'ok';
    case 'takeItem':
      writeRef(runtime, { space: 'inventory', slot: effect.slot }, SYMBOL_EMPTY);
      return 'ok';
    case 'emit':
      // Zapisuje se do fronty, ze které se v TOMHLE tiku nečerpá. Přetečení je
      // odmítnutí, ne zahození — tichá ztráta události by rozbila replay.
      if (runtime.writeQueue.length >= limits.maxQueueDepth) return 'queue-overflow';
      runtime.writeQueue.push(factKey('signalled', [effect.signal]));
      return 'ok';
    case 'playEffect':
      // Mimo hashovaný stav (`CLAUDE.md`, determinismus): částice a zvuk běží
      // na wall-clocku a do stavu nesmí zasáhnout.
      return 'ok';
    case 'win':
      return 'won';
    case 'lose':
      return 'lost';
    default: {
      const exhaustive: never = effect;
      throw new Error(`unreachable effect: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fáze 4 — settle
// ---------------------------------------------------------------------------

function settle(runtime: Runtime, counts: Record<Phase, number>): void {
  const { layout, limits, doc, entityOrder } = runtime;

  // Časovače jsou SLOTY, takže mez je `maxSlots`. Mez odvozená z entit by tuhle
  // smyčku uřízla uprostřed deklarované tabulky a časovač za řezem by se nikdy
  // nesnížil — tik by dál terminoval, `onTimerEnd` by nikdy nenastalo a svět by
  // zamrznul beze stopy. Je to táž vada, kvůli které v téhle úloze vzniklo
  // `maxSlots`, jen v sesterské smyčce.
  const slotCount = doc.ir.slots.length;
  const timerBound = limits.maxSlots;
  for (let i = 0; i < timerBound && i < slotCount; i += 1) {
    counts.settle += 1;
    const decl = doc.ir.slots[i];
    if (decl.space !== 'timer') continue;
    const id = `t:${decl.id}`;
    const left = readSlot(layout, runtime.state, id);
    if (left > 0) writeSlot(layout, runtime.state, id, left - 1);
  }

  // Zmrazení a příkazy pohybu jsou ENTITY, takže mez je `maxEntities`.
  const entityBound = limits.maxEntities;
  for (let i = 0; i < entityBound && i < entityOrder.length; i += 1) {
    counts.settle += 1;
    const id = entityOrder[i];
    const frozen = readSlot(layout, runtime.state, entitySlotId(id, 'freeze'));
    if (frozen > 0) {
      writeSlot(layout, runtime.state, entitySlotId(id, 'freeze'), frozen - 1);
      continue;
    }
    const packed = readSlot(layout, runtime.state, entitySlotId(id, 'moveTo'));
    if (packed === 0) continue;
    const wait = readSlot(layout, runtime.state, entitySlotId(id, 'moveTicks'));
    if (wait > 0) {
      writeSlot(layout, runtime.state, entitySlotId(id, 'moveTicks'), wait - 1);
      continue;
    }
    const targetX = Math.floor((packed - 1) / (limits.gridHeight + 1));
    const targetY = (packed - 1) % (limits.gridHeight + 1);
    stepToward(runtime, id, targetX, targetY);
    const x = readSlot(layout, runtime.state, entitySlotId(id, 'x'));
    const y = readSlot(layout, runtime.state, entitySlotId(id, 'y'));
    if (x === targetX && y === targetY) writeSlot(layout, runtime.state, entitySlotId(id, 'moveTo'), 0);
  }
}

// ---------------------------------------------------------------------------
// Přechodová funkce
// ---------------------------------------------------------------------------

/**
 * Jeden tik. **Vrací definovaný stav na každé výstupní cestě a nikdy nevyhazuje**
 * — `runtimeFault` je zotavitelný stav runtimu, ne výjimka, takže `step()`
 * zavolaný po pádu vrátí tentýž stav a svět se dá dál pozorovat.
 *
 * Vyčerpání rozpočtu nebo přetečení fronty tik **atomicky přeruší**: zápisy,
 * které do té chvíle proběhly, se zahodí obnovením stavu z kopie pořízené na
 * začátku tiku. Bez toho by po pádu zůstal poloviční tik a replay by nesouhlasil.
 */
export function step(runtime: Runtime, inputs: readonly TraceInput[]): StepResult {
  const counts = zeroCounts();
  if (runtime.runState !== 'running') {
    return {
      runState: runtime.runState,
      tick: runtime.tick,
      fault: runtime.fault,
      firings: 0,
      iterations: counts,
      fired: [],
    };
  }

  const limits = runtime.limits;
  resetBudget(runtime.budget, limits);
  const snapshot = runtime.state.slice();
  const before = runtime.budget.remaining;

  // Kanonické vstupy tiku se doručují do ČERPANÉ fronty: hráčův stisk je
  // událost tohoto tiku, ne odvozená událost vyrobená pravidlem.
  //
  // Kontrola je PŘED smyčkou, protože smyčka má mez `maxQueueDepth` a víc vstupů
  // by za ní prostě zůstalo — tedy tiše zahozených. Přetečení je odmítnutí, ne
  // zahození: ztracená událost rozbije replay a svědek přestane platit.
  if (runtime.drainQueue.length + inputs.length > limits.maxQueueDepth) {
    runtime.state = snapshot;
    runtime.runState = 'runtimeFault';
    runtime.fault = 'queue-overflow';
    return {
      runState: 'runtimeFault',
      tick: runtime.tick,
      fault: 'queue-overflow',
      firings: 0,
      iterations: counts,
      fired: [],
    };
  }

  const inputBound = limits.maxQueueDepth;
  for (let i = 0; i < inputBound && i < inputs.length; i += 1) {
    const input = inputs[i];
    runtime.drainQueue.push(factKey('acted', [input.actor, input.actionId, input.target ?? 'none']));
  }

  const observation = sense(runtime, counts);

  // Fáze 2 — spouštěče a stráže proti PRE-STAVU tiku.
  const triggerBound = phaseBound('trigger' satisfies Phase, limits);
  const fired: IrRule[] = [];
  for (let i = 0; i < triggerBound && i < runtime.ruleOrder.length; i += 1) {
    counts.trigger += 1;
    const rule = runtime.ruleOrder[i];
    const expr = runtime.predicateIndex.get(rule.trigger.predicate);
    if (expr === undefined) continue;
    const was = evalBool(runtime.doc.ir, expr, atTickBoundary(runtime.previous));
    const now = evalBool(runtime.doc.ir, expr, observation);
    const edge = rule.trigger.became ? !was && now : was && !now;
    if (!edge) continue;
    if (rule.guard !== null && !evalBool(runtime.doc.ir, rule.guard, observation)) continue;
    fired.push(rule);
  }

  // Fáze 3 — akce ve stabilním pořadí, každá za jednotku klesajícího rozpočtu.
  // Mez SPUŠTĚNÍ, ne mez fáze: `phaseBound('apply')` je součet přes vnější
  // i vnitřní smyčku, a dosadit ho sem by strop spuštění zvedl na kvadrát.
  const applyBound = limits.maxRuleFiringsPerTick;
  let outcome: RunState = 'running';
  let fault: FaultReason | null = null;
  const applied: string[] = [];
  for (let i = 0; i < applyBound && i < fired.length && runtime.budget.remaining > 0; i += 1) {
    counts.apply += 1;
    runtime.budget.remaining -= 1;
    const rule = fired[i];
    applied.push(rule.ruleId);
    const effectBound = limits.maxRuleFiringsPerTick;
    for (let e = 0; e < effectBound && e < rule.effects.length && fault === null; e += 1) {
      counts.apply += 1;
      const result = applyEffect(runtime, runtime.doc.ir.effects[rule.effects[e]], observation);
      if (result === 'won') outcome = 'won';
      else if (result === 'lost') outcome = 'lost';
      else if (result !== 'ok') fault = result;
    }
    if (fault !== null) break;
  }

  if (fault === null && fired.length > applyBound) fault = 'budget-exhausted';

  if (fault !== null) {
    // Atomické přerušení: stav se vrátí na začátek tiku, fronty se nepřenesou.
    runtime.state = snapshot;
    runtime.writeQueue = [];
    runtime.runState = 'runtimeFault';
    runtime.fault = fault;
    return {
      runState: 'runtimeFault',
      tick: runtime.tick,
      fault,
      firings: before - runtime.budget.remaining,
      iterations: counts,
      fired: [],
    };
  }

  settle(runtime, counts);

  // Prohození bufferů. Fronta zapisovaná tímhle tikem se čerpá až tím příštím —
  // tohle je to, co `onSignal(A) → emit(A)` znemožňuje strukturálně.
  runtime.drainQueue = runtime.writeQueue;
  runtime.writeQueue = [];
  runtime.previous = observation;
  runtime.tick += 1;
  runtime.runState = outcome;

  return {
    runState: outcome,
    tick: runtime.tick,
    fault: null,
    firings: before - runtime.budget.remaining,
    iterations: counts,
    fired: applied,
  };
}

/**
 * Odkrokuje nejvýš `maxTicks` tiků nebo dokud běh neskončí. Mez je **v podmínce**
 * a pochází z argumentu volajícího, ne ze světa — je to replay, ne přechodová
 * funkce, takže do dosahu totality nepatří a statická kontrola sem nesahá.
 */
export function run(runtime: Runtime, maxTicks: number): RunState {
  for (let i = 0; i < maxTicks && runtime.runState === 'running'; i += 1) {
    const tick = runtime.tick;
    const inputs = runtime.doc.trace.filter((entry) => entry.tick === tick);
    step(runtime, inputs);
  }
  return runtime.runState;
}

/**
 * Svět, který vyhraje bez jediného vstupu, je odmítnut.
 *
 * Oracle je **spuštění**, ne čtení pravidel: jeden tik s prázdnou stopou. Kdyby
 * se hledal tvar („existuje pravidlo `onStart → win`"), minul by každý svět,
 * který k témuž dojde přes stráž, která je pravdivá už při setupu — a přesně to
 * je zmrazená vada M25.
 */
export function isInstaWin(doc: WorldDocRuntime): boolean {
  const probe = createRuntime(doc);
  step(probe, []);
  return probe.runState === 'won';
}
