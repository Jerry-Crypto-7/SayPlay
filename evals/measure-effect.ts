/**
 * **Změní druhá věta doopravdy svět?** (P15 T40, zachráněno z P10.)
 *
 * Přihláška bude tvrdit, že druhá věta *chirurgicky mění běžící svět*. Do dneška
 * za tím tvrzením nestálo jediné číslo. Tenhle skript ho vyrobí: vezme sadu
 * druhých vět, protáhne je **stávajícím** patch řetězem (`routePatch` →
 * `commitRoutedParts`) a u každé se zeptá, jestli se po dvaceti ticích liší
 * **hashovaný stav** běhu proti nezměněnému světu.
 *
 * ## Co se počítá za „svět se změnil"
 *
 * Výhradně `hashHex(runtime.state)`, tedy FNV-1a nad `Uint32Array` sloty
 * interpretu. Nic jiného — částice, zvuk, kamera a tweeny stojí podle
 * `CLAUDE.md` mimo hashovaný stav, takže by měřidlo postavené na nich hlásilo
 * pohyb tam, kde se simulace nehnula. Ze stejného důvodu se **neporovnává
 * `simHash` dokumentu**: ten se hne při každé změně `sim` části, i když se
 * chování běhu nezmění o bit. Rozdíl mezi těmi dvěma čísly je v sadě vidět na
 * případu `gate-open`.
 *
 * ## Proč zrovna dvacet tiků a proč základní svět nedoběhne
 *
 * Horizont předepisuje AC úlohy. Základní svět je schválně tak velký, že v něm
 * dvacet tiků **nedoběhne do výhry** (vyhrává až v tiku 32): kdyby doběhl, dvě
 * různé cesty by se sešly v témž koncovém stavu a měřidlo by hlásilo nulu tam,
 * kde se svět prokazatelně změnil. Horizont pod koncem běhu je tedy podmínka
 * citlivosti, ne kosmetika.
 *
 * ## Negativní dvojice není volitelná
 *
 * Měřidlo, které porovnává objekt sám se sebou, vrátí stoprocentní shodu a
 * vypadá jako skvělý výsledek. Sada proto obsahuje tři **vzhledové** změny
 * (operace do `/look`: paleta, světlo, atmosféra, modul). Kontrakt druhé věty
 * (`src/model/worldstream-refine.ts`) o nich tvrdí, že runtime hash pohnout
 * **nesmějí** — hráč by jinak přišel o rozehraný stav kvůli změně barvy. Když
 * některá z nich vyjde nenulová, měřidlo nebo produkt lže a sada zčervená.
 *
 * ## Fixtury jsou emise, ne moje patche
 *
 * Každý případ je surová odpověď refineru a prochází produkčním
 * `readRefineEmission()`. Kdybych psal `RefinePlan` rovnou, měřil bych sadu
 * operací, které by refiner nikdy nepustil ven — číslo by pak platilo o něčem
 * jiném než o druhé větě.
 *
 * ## Report nemá časové razítko schválně
 *
 * `measuredAt` by se hnulo při každém běhu, aniž by se hnul jediný verdikt.
 * Tenhle repozitář má s takovými artefakty naměřenou zkušenost (`CLAUDE.md`,
 * Konvence): commitnutý soubor se pak rozchází s realitou a nikdo neví, jestli
 * je to nová hodnota nebo jen nový čas. `evals/effect-rate.json` je proto
 * čistě funkce kódu a fixtur, takže se dá porovnat bajt po bajtu.
 *
 * Spuštění: `node --experimental-strip-types evals/measure-effect.ts`
 */

import { existsSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { Operation } from 'rfc6902';

import type { LookPart, SimPart, WorldDoc } from '../src/ir/worlddoc';
import type { RefinePlan } from '../src/model/worldstream-refine';
import type { SemanticObject } from '../src/worldstream/schema';

/**
 * Node neumí rozlišit dva tvary specifikátorů, které `src/**` používá:
 * bezpříponové relativní cesty (`../ir/build`) a alias `@/` z `tsconfig.json`.
 * Vitest i bundler je umí, samostatný Node ne — a AC úlohy předepisuje právě
 * samostatný Node. Přepsat kvůli měřidlu importy v celém `src/**` by byla
 * nesrovnatelně vyšší cena než těchhle patnáct řádků.
 *
 * `module.registerHooks` je synchronní (Node 22.15+), takže stačí zaregistrovat
 * ho **před** prvním dynamickým importem níž. Statické importy nahoře jsou buď
 * typové (mizí při odstranění typů), nebo z `node:`. Pod vitestem je hook mrtvý
 * kód — moduly tam rozlišuje vite a k Nodu se ta otázka nedostane.
 */
const SRC_ROOT = new URL('../src/', import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith('.') && context.parentURL !== undefined;
    if (relative || specifier.startsWith('@/')) {
      const base = relative
        ? new URL(specifier, context.parentURL)
        : new URL(specifier.slice('@/'.length), SRC_ROOT);
      if (!/\.[cm]?[jt]sx?$/.test(specifier)) {
        for (const suffix of ['.ts', '/index.ts']) {
          const candidate = new URL(base.href + suffix);
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
        }
      }
      if (!relative) return { url: base.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { commitRoutedParts } = await import('../src/app/api/edit/commit');
const { buildRuntimeWorld } = await import('../src/ir/build');
const { sealSimHash, WORLD_DOC_VERSION } = await import('../src/ir/worlddoc');
const { readRefineEmission } = await import('../src/model/worldstream-refine');
const { routePatch } = await import('../src/patch/router');
const { hashHex } = await import('../src/sim/hash');
const { createRuntime, step } = await import('../src/sim/interpreter');

export const REPORT_PATH = 'evals/effect-rate.json';

/** Horizont měření v ticích. Číslo je z AC T40, ne z pohodlí. */
export const HORIZON_TICKS = 20;

/* ------------------------------------------------------------------ *
 * Základní svět.
 * ------------------------------------------------------------------ */

/**
 * Ruční svět, ne `synthWorld()` ze `src/ir/__fixtures__`.
 *
 * Generátor fixtur dělá mřížky do 12×12, ve kterých chůze na východ trvá pod
 * dvacet tiků — a svět, který do horizontu **doběhne**, měřidlo otupí (viz
 * hlavička). Tenhle je 24×12 se startem v rohu a východem v protilehlém, takže
 * v tiku 20 chodec pořád jde a stav je citlivý na cokoli, co s ním hne.
 *
 * `gate` je tu jako objekt, o kterém **žádné pravidlo nemluví**. Je to jediný
 * způsob, jak se v sadě dá položit otázka „změna, kterou nikdo nečte" — a
 * odpověď na ni je nejzajímavější řádek celého reportu.
 */
function baseSim(): SimPart {
  return {
    layout: { kind: 'grid', width: 24, height: 12, levels: 1, portals: [] },
    grid: { cell: 1 },
    sockets: { spawn: [1, 1], gate: [12, 1], exit: [22, 10] },
    collisionAabb: { walker: [1, 1, 1, 1], gate: [12, 1, 1, 1], exit: [22, 10, 1, 1] },
    entities: {
      walker: { role: 'actor', socket: 'spawn', state: 'idle' },
      gate: { role: 'prop', socket: 'gate', state: 'shut', locked: true },
      exit: { role: 'goal', socket: 'exit', state: 'closed', locked: true },
    },
    rules: {
      win: {
        id: 'win',
        phase: 0,
        priority: 0,
        event: { kind: 'onEnterZone', entity: 'walker', zone: 'exit' },
        condition: null,
        actions: [{ kind: 'win' }],
      },
    },
    state: { counters: { keys: { min: 0, max: 9, init: 1 } }, flags: {}, timers: {}, slots: 8 },
    witness: {
      tier: 'short',
      H_cert: 600,
      L_witness: 60,
      K_input: 1,
      ops: [{ tick: 0, actionId: 'moveTo', target: 'exit' }],
    },
  };
}

/**
 * Vzhled pojmenovává jen deklarované entity. Modul nad nedeklarovaným jménem
 * shodí commit na `DANGLING_REFERENCE` — a shodil by ho i u vzhledové změny,
 * takže by negativní dvojice měřila překlep, ne kontrakt.
 */
function baseLook(): LookPart {
  return {
    modules: {
      walker: { family: 'actor', params: { height: 1.8 } },
      exit: { family: 'panel', params: { thickness: 0.2 } },
    },
    palette: 'slate',
    lightRig: 'key',
    atmosphere: 'none',
    materialRoles: {},
    camera: { kind: 'orbit' },
    audio: {},
  };
}

export function baseWorld(): WorldDoc {
  return sealSimHash({
    irVersion: WORLD_DOC_VERSION,
    simRevision: 0,
    lookRevision: 0,
    simHash: '',
    sim: baseSim(),
    look: baseLook(),
  });
}

/* ------------------------------------------------------------------ *
 * Sada druhých vět.
 * ------------------------------------------------------------------ */

/** Cíl věty. `source` je kompozice, protože žádný případ nemění hrdinský tvar. */
function objectOf(stableId: string, label: string, role: SemanticObject['role']): SemanticObject {
  return {
    stableId,
    label,
    synonyms: [],
    role,
    source: { kind: 'geom', node: 0 },
    targetBounds: { min: [-1, 0, -1], max: [1, 2, 1] },
    importance: 2,
  };
}

const OBJECTS = {
  walker: objectOf('walker', 'the walker', 'hero'),
  gate: objectOf('gate', 'the gate', 'prop'),
  exit: objectOf('exit', 'the exit', 'architecture'),
} as const;

/**
 * `moves` = věta, která má svět rozhýbat. `inert` = negativní dvojice, tedy
 * změna, po které se runtime hash pohnout **nesmí**.
 */
export type Intent = 'moves' | 'inert';

export interface EffectCase {
  readonly id: string;
  /** Druhá věta, jak by ji napsal porotce. Do měření nevstupuje, do reportu ano. */
  readonly sentence: string;
  readonly intent: Intent;
  readonly target: SemanticObject;
  /** Surová odpověď refineru. Prochází produkčním `readRefineEmission()`. */
  readonly emission: Record<string, unknown>;
  /** Proč případ dopadá, jak dopadá. Píše se jen tam, kde to není zřejmé. */
  readonly note?: string;
}

function behavior(summary: string, operations: readonly Operation[]): Record<string, unknown> {
  return { summary, behavior: operations, appearance: [] };
}

function appearance(summary: string, operations: readonly Operation[]): Record<string, unknown> {
  return { summary, behavior: [], appearance: operations };
}

export const CASES: readonly EffectCase[] = [
  {
    id: 'keys-init',
    sentence: 'The walker starts with four keys instead of one.',
    intent: 'moves',
    target: OBJECTS.walker,
    emission: behavior('the walker starts with four keys', [
      { op: 'replace', path: '/sim/state/counters/keys/init', value: 4 },
    ]),
  },
  {
    id: 'exit-socket',
    sentence: 'Move the exit up against the north wall.',
    intent: 'moves',
    target: OBJECTS.exit,
    emission: behavior('the exit stands six cells further north', [
      { op: 'replace', path: '/sim/sockets/exit', value: [22, 4] },
    ]),
  },
  {
    id: 'spawn-socket',
    sentence: 'The walker sets out from the far corner instead.',
    intent: 'moves',
    target: OBJECTS.walker,
    emission: behavior('the walker starts in the southern corner', [
      { op: 'replace', path: '/sim/sockets/spawn', value: [1, 9] },
    ]),
  },
  {
    id: 'exit-unlocked',
    sentence: 'The exit is standing open from the start.',
    intent: 'moves',
    target: OBJECTS.exit,
    emission: behavior('the exit is no longer locked', [
      { op: 'replace', path: '/sim/entities/exit/locked', value: false },
    ]),
  },
  {
    id: 'gate-tally',
    sentence: 'Passing the gate should hand the walker another key.',
    intent: 'moves',
    target: OBJECTS.gate,
    emission: behavior('crossing the gate adds a key', [
      {
        op: 'add',
        path: '/sim/rules/tally',
        value: {
          id: 'tally',
          phase: 0,
          priority: 0,
          event: { kind: 'onEnterZone', entity: 'walker', zone: 'gate' },
          condition: null,
          actions: [{ kind: 'addCounter', counter: 'keys', by: 1 }],
        },
      },
    ]),
  },
  {
    id: 'gate-open',
    sentence: 'The gate stands open.',
    intent: 'moves',
    target: OBJECTS.gate,
    emission: behavior('the gate is open, not shut', [
      { op: 'replace', path: '/sim/entities/gate/state', value: 'open' },
    ]),
    note:
      'Dokument se změní a `simHash` se hne, běh ne. Žádné pravidlo stav brány nečte, ' +
      'takže se simulace chová stejně — a navíc se stav ukládá jako index do tabulky ' +
      'symbolů odvozené z dokumentu, takže i přejmenování jediného stavu dá tentýž index. ' +
      'Je to případ, kterým se pozná měřidlo stavěné na runtime hashi od měřidla ' +
      'stavěného na `simHash`.',
  },
  {
    id: 'palette',
    sentence: 'Make the whole place sand-coloured.',
    intent: 'inert',
    target: OBJECTS.walker,
    emission: appearance('the palette goes to sand', [
      { op: 'replace', path: '/look/palette', value: 'sand' },
    ]),
  },
  {
    id: 'light-and-air',
    sentence: 'Light it from behind and fill the air with haze.',
    intent: 'inert',
    target: OBJECTS.exit,
    emission: appearance('rim light and haze', [
      { op: 'replace', path: '/look/lightRig', value: 'rim' },
      { op: 'replace', path: '/look/atmosphere', value: 'fog' },
    ]),
  },
  {
    id: 'gate-module',
    sentence: 'Give the gate a heavy slab of a body.',
    intent: 'inert',
    target: OBJECTS.gate,
    emission: appearance('the gate gets its own look module', [
      { op: 'add', path: '/look/modules/gate', value: { family: 'panel', params: { thickness: 0.4 } } },
    ]),
  },
];

/* ------------------------------------------------------------------ *
 * Měření.
 * ------------------------------------------------------------------ */

/**
 * Fixtura protažená produkčním čtečem emisí. Vadná fixtura je **chyba sady**,
 * ne naměřený výsledek — proto výjimka, ne řádek reportu s nulou.
 */
export function planOf(entry: EffectCase): RefinePlan {
  const read = readRefineEmission(entry.emission, entry.target);
  if (!read.ok) throw new Error(`case ${entry.id} is not a legal refine emission: ${read.reason} — ${read.detail}`);
  return read.value;
}

export interface RunSnapshot {
  /** Hash slotů interpretu po horizontu. Tohle je jediná měřená veličina. */
  readonly hash: string;
  readonly runState: string;
  /** Kolik tiků běh doopravdy udělal, než skončil nebo došel na horizont. */
  readonly tick: number;
}

/**
 * Stav po `ticks` ticích. Vstupy se berou ze **svědka** dokumentu, protože to je
 * podle `src/sim/interpreter.ts` jediná cesta, kterou se svět dozví o hráči —
 * a jsou to tytéž vstupy pro obě strany srovnání, takže rozdíl může vyrobit jen
 * změna světa.
 *
 * Wall-clock se tu nevyskytuje: `SimClock` se nepumpuje, krokuje se rovnou
 * `step()`. Simulovaný tik je jediná jednotka (`CLAUDE.md`, determinismus).
 */
export function stateAfter(doc: WorldDoc, ticks: number = HORIZON_TICKS): RunSnapshot {
  const built = buildRuntimeWorld(doc.sim);
  if (!built.ok) throw new Error(`the world does not lower to IR: ${built.reason} — ${built.issues[0] ?? 'no detail'}`);

  const runtime = createRuntime(built.world);
  for (let i = 0; i < ticks && runtime.runState === 'running'; i += 1) {
    const tick = runtime.tick;
    step(runtime, built.world.trace.filter((input) => input.tick === tick));
  }

  return { hash: hashHex(runtime.state), runState: runtime.runState, tick: runtime.tick };
}

/** Hnul se hashovaný stav po horizontu? Tohle je celé srovnání, na jednom místě. */
export function movedAfterHorizon(before: WorldDoc, after: WorldDoc): boolean {
  return stateAfter(before).hash !== stateAfter(after).hash;
}

export interface CaseMeasurement {
  readonly id: string;
  readonly sentence: string;
  readonly intent: Intent;
  readonly stableId: string;
  readonly facet: { readonly behavior: number; readonly appearance: number };
  /** Verdikt patch řetězu. Odmítnutá změna svět nezmění a je to naměřený výsledek. */
  readonly outcome: string;
  readonly rejection: string | null;
  readonly snapshot: RunSnapshot | null;
  readonly moved: boolean;
  readonly note?: string;
}

/**
 * Jeden případ: emise → plán → **stávající** patch řetěz → dvacet tiků → hash.
 *
 * `before` je parametr, ne konstanta uvnitř, aby šlo měřidlo zkusit i proti
 * světu, který se nezměnil. Bez toho seamu by tvrzení „srovnání sebe se sebou
 * dá nulu" neměl jak dokázat žádný test a mutace, která obě strany srovnání
 * slije do jedné, by přežila.
 */
export function measureCase(entry: EffectCase, before: WorldDoc): CaseMeasurement {
  const plan = planOf(entry);
  const head = {
    id: entry.id,
    sentence: entry.sentence,
    intent: entry.intent,
    stableId: plan.stableId,
    facet: { behavior: plan.behavior.length, appearance: plan.appearance.length },
    ...(entry.note === undefined ? {} : { note: entry.note }),
  };

  const operations = [...plan.behavior, ...plan.appearance];
  const routing = routePatch({ operations }, before);
  if (routing.verdict === 'REJECTED')
    return { ...head, outcome: 'ROUTE_REJECTED', rejection: `${routing.reason} at ${routing.pointer}`, snapshot: null, moved: false };

  const committed = commitRoutedParts(
    before,
    routing.patches.map((routed) => ({
      part: routed.part,
      baseRevision: routed.part === 'sim' ? before.simRevision : before.lookRevision,
      operations: routed.operations,
    })),
  );

  if (committed.outcome !== 'CERTIFIED') {
    const first = committed.rejections[0];
    return {
      ...head,
      outcome: committed.outcome,
      rejection: first === undefined ? 'no detail' : `${first.reason} at ${first.pointer}: ${first.detail}`,
      snapshot: null,
      moved: false,
    };
  }

  const snapshot = stateAfter(committed.after);
  return {
    ...head,
    outcome: 'CERTIFIED',
    rejection: null,
    snapshot,
    moved: snapshot.hash !== stateAfter(before).hash,
  };
}

export interface IntentTally {
  readonly total: number;
  readonly moved: number;
  readonly rate: number;
}

export interface EffectReport {
  readonly horizonTicks: number;
  readonly total: number;
  readonly moved: number;
  /**
   * Podíl **celé sady**, jejíž hashovaný stav se po horizontu pohnul. Negativní
   * dvojice je ve jmenovateli schválně: číslo, které se počítá jen z případů,
   * u kterých se pohyb čeká, se dá vyleštit vyhozením nepohodlného řádku.
   * Do trychtýře přihlášky patří `byIntent.moves.rate`, ne tohle.
   */
  readonly visibleChangeRate: number;
  readonly byIntent: { readonly moves: IntentTally; readonly inert: IntentTally };
  readonly baseline: RunSnapshot;
  readonly cases: readonly CaseMeasurement[];
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000) / 10_000;
}

function tally(cases: readonly CaseMeasurement[], intent: Intent): IntentTally {
  const mine = cases.filter((entry) => entry.intent === intent);
  const moved = mine.filter((entry) => entry.moved).length;
  return { total: mine.length, moved, rate: rate(moved, mine.length) };
}

export function measureEffect(set: readonly EffectCase[] = CASES): EffectReport {
  const before = baseWorld();
  const cases = set.map((entry) => measureCase(entry, before));
  const moved = cases.filter((entry) => entry.moved).length;

  return {
    horizonTicks: HORIZON_TICKS,
    total: cases.length,
    moved,
    visibleChangeRate: rate(moved, cases.length),
    byIntent: { moves: tally(cases, 'moves'), inert: tally(cases, 'inert') },
    baseline: stateAfter(before),
    cases,
  };
}

function main(): void {
  const report = measureEffect();
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  process.stdout.write(
    `${REPORT_PATH}: visibleChangeRate ${report.visibleChangeRate} (${report.moved}/${report.total}), ` +
      `moves ${report.byIntent.moves.moved}/${report.byIntent.moves.total}, ` +
      `inert ${report.byIntent.inert.moved}/${report.byIntent.inert.total}\n`,
  );
}

// Zápis se pouští jen při přímém spuštění. Pod vitestem je `argv[1]` běžec sady,
// takže import tohohle modulu commitnutý report nepřepíše — a nestane se z něj
// třetí artefakt, který se hýbe sám od sebe.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
