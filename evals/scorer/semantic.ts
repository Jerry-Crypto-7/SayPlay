/**
 * Strojový sémantický scorer verdiktu `FULFILLED` (T16).
 *
 * ## Co tenhle soubor rozhoduje
 *
 * Jestli emise **splnila kontrakt svého promptu** — vlastnosti grafu i chování
 * za běhu — nebo jestli jen nespadla. Protokol ty dva verdikty odděluje
 * (`reportSeparation`) a celý smysl P1 stojí na tom rozdílu: dřívější headline
 * „73/116" obsahoval 42 promptů s prázdným vektorem požadavků, které prošly
 * čímkoli.
 *
 * ## Tři pravidla, bez kterých by to zase začalo nadhodnocovat
 *
 * 1. **Kontrakty se čtou VÝHRADNĚ z `evals/frozen/contracts.v1.jsonl`.** Jediné
 *    místo v celém `evals/scorer/`, které nějaký kontrakt otevírá, je
 *    `CONTRACTS_PATH` níž. Kontrakty vznikly v T1, tedy dřív než scorer; kdyby
 *    směl číst i něco autorovaného vedle sebe, napsaly by se testy kolem
 *    implementace (nález review v2 nad T14).
 * 2. **`verdictCeiling` je strop, ne návrh.** Záznam se `scoreAs:
 *    "ROBUST_ONLY"` nedostane `FULFILLED` nikdy — ani s certifikovaným svědkem,
 *    ani se schema-validním grafem.
 * 3. **Brány platí i pro záznamy, které je nedeklarují.** Prázdné chování,
 *    fallback, insta-win a prázdný vektor požadavků končí `ROBUST` bez ohledu
 *    na to, co kontrakt vyjmenoval. Insta-win je tu zvlášť důležitý: naměřeno
 *    v T15, že `verifyWitness` ho **certifikuje** (svět vyhraje v tiku 0 a
 *    kontrola triviální výhry ve verifikátoru není), takže kdyby se scorer
 *    spolehl na verifikátor, pustil by ho dál.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { changedLeafEffects, type ChangedLeaf } from '../../src/patch/scope';
import { findDanglingReferences } from '../../src/ir/references';
import { canonical } from '../../src/ir/worlddoc';
import type { TraceInput } from '../../src/sim/interpreter';
import { resolvePolicy, TIER_POLICY, type Tier } from '../../src/verify/tiers';
import {
  buildRuntimeWorld,
  compare,
  conditionKindsOf,
  evaluate,
  isInstaWin,
  replay,
  ruleBodies,
  actionsOf,
  verifyWitness,
  type BuiltWorld,
  type ExprContext,
  type Moment,
} from './world';

/**
 * Jediný zdroj kontraktů v celém scoreru. Zmrazeno v T1, tag `evals-frozen-v2`.
 *
 * Cesta se skládá z `process.cwd()`, ne z `import.meta.url`. Offline řetězec
 * (T17) tenhle modul volá z Playwrightu, který projektové `.ts` překládá do
 * CommonJS — a `import.meta` je tam **syntaktická** chyba, tedy i v modulu, ze
 * kterého by se nic nevolalo. Je to táž konvence, na které stojí produkční čtení
 * zmrazeného korpusu (`FROZEN_DIR` v `src/model/client.ts`); obě sady se
 * spouštějí z kořene repozitáře a `semantic.test.ts` tu cestu pinuje.
 */
export const CONTRACTS_PATH = join(process.cwd(), 'evals', 'frozen', 'contracts.v1.jsonl');

export type Verdict = 'FULFILLED' | 'ROBUST' | 'NO_FIT' | 'FAULT';

export interface AllowedPath {
  readonly op: 'add' | 'remove' | 'replace';
  readonly path: string;
}

export interface Requirement {
  readonly rid: string;
  readonly layer: 'graph' | 'runtime' | 'edit' | 'outcome';
  readonly kind: string;
  readonly value?: unknown;
}

export interface Contract {
  readonly id: string;
  readonly kind: 'create' | 'edit';
  readonly verdictCeiling: Verdict;
  readonly scoreAs: 'FULFILLABLE' | 'ROBUST_ONLY';
  readonly nonVacuous: boolean;
  readonly requirements: readonly Requirement[];
  readonly scoreAsReason?: string;
  readonly expectedOutcome?: Verdict;
  readonly editClass?: string;
  readonly baseWorld?: string;
  readonly allowedPaths?: readonly AllowedPath[];
}

export function loadContracts(): readonly Contract[] {
  return readFileSync(CONTRACTS_PATH, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Contract);
}

// ---------------------------------------------------------------------------
// Důkazní materiál
// ---------------------------------------------------------------------------

/**
 * Co se s promptem doopravdy stalo. Scorer si to nezjišťuje sám — dodává mu to
 * potrubí (T13/T14 emisní a editační cesta, offline řetězec T17), protože verdikt
 * `NO_FIT` i `FAULT` jsou rozhodnutí systému, ne vlastnost kontraktu.
 */
export type Evidence =
  | {
      readonly kind: 'create';
      readonly outcome: 'emitted';
      readonly doc: unknown;
      readonly sceneBuilt: boolean;
    }
  | {
      readonly kind: 'create';
      /** Poctivý fallback: něco se postavilo, ale kontrakt to neplnilo. */
      readonly outcome: 'fallback' | 'declined' | 'fault';
      readonly sceneBuilt: boolean;
      readonly detail?: string;
    }
  | {
      readonly kind: 'edit';
      readonly outcome: 'committed';
      readonly before: unknown;
      readonly after: unknown;
      readonly sceneBuilt: boolean;
    }
  | {
      readonly kind: 'edit';
      readonly outcome: 'fallback' | 'declined' | 'fault';
      readonly sceneBuilt: boolean;
      readonly detail?: string;
    };

export interface RequirementResult {
  readonly rid: string;
  readonly kind: string;
  readonly layer: Requirement['layer'];
  readonly met: boolean;
  readonly detail: string;
}

export interface ScoreResult {
  readonly id: string;
  readonly verdict: Verdict;
  readonly ceiling: Verdict;
  readonly requirements: readonly RequirementResult[];
  /** Proč se strop uplatnil, i když by požadavky sedly. Prázdné = neuplatnil. */
  readonly gates: readonly string[];
}

/**
 * Odkaz do prázdna je brána, ne požadavek.
 *
 * Produkční editační cesta (`src/app/api/edit/commit.ts`, `certifySim`) takový
 * dokument **necommitne** — kontrolu dělá dřív, než se cokoli sníží do IR,
 * protože povrchová jména se do IR nedostanou. Scorer, který by ho ohodnotil
 * jako `FULFILLED`, by tvrdil splněný kontrakt o světě, který systém nikdy
 * nepřijme. Zmrazený `E11` je přesně ten tvar: nová entita bez AABB a pravidlo
 * mířící na neexistující soket.
 */
function danglingGate(doc: unknown): string | null {
  const dangling = findDanglingReferences(doc);
  if (dangling.length === 0) return null;
  return `osiřelý odkaz: ${dangling[0].where} nepojmenovává deklarovaný ${dangling[0].namespace} ${dangling[0].name}`;
}

const met = (r: Requirement, detail: string): RequirementResult => ({ ...r, met: true, detail });
const unmet = (r: Requirement, detail: string): RequirementResult => ({ ...r, met: false, detail });

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function simOf(doc: unknown): unknown {
  return record(doc).sim;
}

// ---------------------------------------------------------------------------
// Vrstva grafu — čte POVRCHOVÝ `sim`, ne snížené IR
// ---------------------------------------------------------------------------

function actionKinds(sim: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  for (const rule of Object.values(ruleBodies(sim))) for (const action of actionsOf(rule)) {
    if (typeof action.kind === 'string') out.add(action.kind);
  }
  return out;
}

function eventKinds(sim: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  for (const rule of Object.values(ruleBodies(sim))) {
    const kind = record(record(rule).event).kind;
    if (typeof kind === 'string') out.add(kind);
  }
  return out;
}

function stateBag(sim: unknown, bag: string): Record<string, unknown> {
  return record(record(record(sim).state)[bag]);
}

function scoreGraph(req: Requirement, sim: unknown): RequirementResult {
  const value = req.value;
  const spec = record(value);
  switch (req.kind) {
    case 'requiresEvent':
      return eventKinds(sim).has(String(value)) ? met(req, `událost ${String(value)} je v grafu`) : unmet(req, `událost ${String(value)} v grafu není`);
    case 'requiresAction':
      return actionKinds(sim).has(String(value)) ? met(req, `akce ${String(value)} je v grafu`) : unmet(req, `akce ${String(value)} v grafu není`);
    case 'forbidsAction':
      return actionKinds(sim).has(String(value)) ? unmet(req, `zakázaná akce ${String(value)} je v grafu`) : met(req, `akce ${String(value)} v grafu není`);
    case 'requiresCondition':
      return conditionKindsOf(sim).has(String(value)) ? met(req, `podmínka ${String(value)} je v grafu`) : unmet(req, `podmínka ${String(value)} v grafu není`);
    case 'requiresCounter': {
      const id = typeof spec.id === 'string' ? spec.id : null;
      const counters = stateBag(sim, 'counters');
      const entries = id === null ? Object.entries(counters) : Object.entries(counters).filter(([key]) => key === id);
      const hit = entries.find(([, decl]) => {
        const body = record(decl);
        return (
          (spec.min === undefined || body.min === spec.min) && (spec.max === undefined || body.max === spec.max)
        );
      });
      return hit === undefined ? unmet(req, `čítač ${id ?? '(libovolný)'} s deklarovanými mezemi chybí`) : met(req, `čítač ${hit[0]} sedí`);
    }
    case 'requiresTimer': {
      const id = typeof spec.id === 'string' ? spec.id : null;
      const timers = stateBag(sim, 'timers');
      const entries = id === null ? Object.entries(timers) : Object.entries(timers).filter(([key]) => key === id);
      const hit = entries.find(
        ([, decl]) => spec.durationTicks === undefined || record(decl).durationTicks === spec.durationTicks,
      );
      return hit === undefined ? unmet(req, `timer ${id ?? '(libovolný)'} s deklarovanou dobou chybí`) : met(req, `timer ${hit[0]} sedí`);
    }
    case 'requiresFlag': {
      const id = typeof spec.id === 'string' ? spec.id : null;
      const flags = stateBag(sim, 'flags');
      const found = id === null ? Object.keys(flags).length > 0 : Object.hasOwn(flags, id);
      return found ? met(req, `flag ${id ?? '(libovolný)'} je deklarovaný`) : unmet(req, `flag ${id ?? '(libovolný)'} chybí`);
    }
    case 'requiresInventorySlots': {
      const declared = record(record(sim).state).slots;
      const count = typeof declared === 'number' ? declared : 0;
      const want = typeof spec.count === 'number' ? spec.count : 0;
      return count >= want ? met(req, `${count} inventárních slotů`) : unmet(req, `${count} inventárních slotů, kontrakt žádá ${want}`);
    }
    case 'requiresMemorySlots': {
      const declared = record(record(sim).state).memory;
      const count = typeof declared === 'number' ? declared : Object.keys(record(declared)).length;
      const want = typeof spec.count === 'number' ? spec.count : 0;
      return count >= want ? met(req, `${count} paměťových slotů`) : unmet(req, `${count} paměťových slotů, kontrakt žádá ${want}`);
    }
    case 'minEntitiesByRole': {
      const role = String(spec.role);
      const want = typeof spec.min === 'number' ? spec.min : 0;
      const count = Object.values(record(record(sim).entities)).filter((decl) => record(decl).role === role).length;
      return count >= want ? met(req, `${count} entit v roli ${role}`) : unmet(req, `${count} entit v roli ${role}, kontrakt žádá ${want}`);
    }
    case 'minRules': {
      const want = typeof spec.min === 'number' ? spec.min : 0;
      const count = Object.keys(ruleBodies(sim)).length;
      return count >= want ? met(req, `${count} pravidel`) : unmet(req, `${count} pravidel, kontrakt žádá ${want}`);
    }
    case 'minDistinctSockets': {
      const want = typeof spec.min === 'number' ? spec.min : 0;
      const count = Object.keys(record(record(sim).sockets)).length;
      return count >= want ? met(req, `${count} soketů`) : unmet(req, `${count} soketů, kontrakt žádá ${want}`);
    }
    case 'layoutTypeIs': {
      const kind = record(record(sim).layout).kind;
      return kind === value ? met(req, `layout je ${String(value)}`) : unmet(req, `layout je ${String(kind)}, kontrakt žádá ${String(value)}`);
    }
    default:
      return unmet(req, `druh ${req.kind} není ve zmrazeném slovníku vrstvy graph`);
  }
}

// ---------------------------------------------------------------------------
// Vrstva běhu
// ---------------------------------------------------------------------------

interface RuntimeContext {
  readonly sim: unknown;
  readonly doc: unknown;
  readonly world: BuiltWorld | null;
  readonly buildIssue: string | null;
  readonly horizonTicks: number;
  readonly moments: {
    readonly setup: Moment | null;
    readonly won: Moment | null;
    readonly lost: Moment | null;
    readonly final: Moment | null;
    readonly captured: ReadonlyMap<number, Moment>;
  };
  readonly runState: string;
  readonly faulted: boolean;
  /**
   * Nejkratší **prefix svědka**, po kterém svět prohraje, když hráč přestane
   * jednat — nebo `null`, když takový prefix není.
   *
   * Tohle je celá odpověď P1 na „existuje stopa, která skončí `lose()`". Hledání
   * prohry je hledání a to protokol z garance vynechává (§6, `heuristicSearch`),
   * takže se prohledávají jen stopy, které **deklaroval sám svět**: nečinnost
   * a každý prefix jeho svědka. `C02` prohraje hned na nečinnosti (zaplaví ho
   * časovač), `C03` až na prefixu — hráč vejde do osvětlené zóny a zůstane v ní.
   */
  readonly losing: { readonly how: string; readonly moment: Moment | null } | null;
}

function observation(req: Requirement, ctx: RuntimeContext, moment: Moment | null, where: string): RequirementResult {
  const spec = record(req.value);
  const expr = String(spec.expr);
  if (moment === null) return unmet(req, `${where} nenastal, ${expr} se nedá přečíst`);
  const read = evaluate(expr, { sim: ctx.sim, doc: ctx.doc, moment } satisfies ExprContext);
  if (!read.ok) return unmet(req, read.reason);
  return compare(read.value, String(spec.op), spec.rhs)
    ? met(req, `${expr} = ${canonical(read.value)} ${where}`)
    : unmet(req, `${expr} = ${canonical(read.value)} ${where}, kontrakt žádá ${String(spec.op)} ${canonical(spec.rhs)}`);
}

/**
 * Existuje ve svědkovi vstup, bez kterého se v témže rozpočtu tiků nevyhraje?
 *
 * `removeWitnessOps` je v korpusu **česká věta** („poslední onPickup klíče"), ne
 * strojový selektor — kontrakty autoroval člověk (§7 zakazuje, aby si je psal
 * model). Scorer proto kontroluje existenční tvar téhož tvrzení: odebere každý
 * vstup zvlášť a požaduje, aby aspoň jeden z nich výhru zrušil. Slabší než
 * jmenovaný vstup, ale je to jediné čtení, které nevyžaduje rozumět té větě —
 * a insta-win ani svět vyhrávající bez zásahu hráče jím neprojdou, protože tam
 * není příčinný vstup žádný.
 */
function counterfactual(req: Requirement, ctx: RuntimeContext): RequirementResult {
  if (ctx.world === null) return unmet(req, ctx.buildIssue ?? 'svět se nepostavil');
  const trace = ctx.world.trace;
  if (trace.length === 0) return unmet(req, 'svědek nemá jediný vstup, takže žádný nemůže být příčinný');
  if (verifyWitness(ctx.world, trace).verdict !== 'CERTIFIED')
    return unmet(req, 'plný svědek necertifikuje, kontrafaktuál by byl vakuózní');

  for (let i = 0; i < trace.length; i += 1) {
    const without: TraceInput[] = [...trace.slice(0, i), ...trace.slice(i + 1)];
    const result = verifyWitness(ctx.world, without);
    if (result.verdict !== 'CERTIFIED') return met(req, `bez vstupu ${i} se nevyhraje (${result.reason})`);
  }
  return unmet(req, 'výhra nastane i po odebrání kteréhokoli jednotlivého vstupu — žádný není příčinný');
}

function scoreRuntime(req: Requirement, ctx: RuntimeContext): RequirementResult {
  const spec = record(req.value);
  switch (req.kind) {
    case 'witnessCertifies': {
      if (ctx.world === null) return unmet(req, ctx.buildIssue ?? 'svět se nepostavil');
      const result = verifyWitness(ctx.world, ctx.world.trace);
      if (result.verdict !== 'CERTIFIED') return unmet(req, `svědek necertifikuje: ${result.reason} — ${result.detail}`);
      const want = spec.tier as Tier | undefined;
      return want === undefined || result.tier === want
        ? met(req, `certifikováno v tieru ${result.tier}, L_witness ${result.witnessLength}`)
        : unmet(req, `certifikováno v tieru ${result.tier}, kontrakt žádá ${want}`);
    }
    case 'notWinnableAtSetup': {
      if (ctx.world === null) return unmet(req, ctx.buildIssue ?? 'svět se nepostavil');
      return isInstaWin(ctx.world) ? unmet(req, 'svět vyhrává bez jediného vstupu') : met(req, 'výhra při setupu neplatí');
    }
    case 'noRuntimeFault':
      if (ctx.world === null) return unmet(req, ctx.buildIssue ?? 'svět se nepostavil');
      return ctx.faulted ? unmet(req, 'replay svědka skončil v runtimeFault') : met(req, 'replay bez runtimeFault');
    case 'observationAtTick': {
      const tick = typeof spec.tick === 'number' ? spec.tick : 0;
      // Za koncem běhu se stav nemění, takže tik po výhře nebo prohře čte
      // poslední okamžik. Kdyby to bylo „nevím", hlásil by kontrakt mezeru tam,
      // kde je odpověď jednoznačná — svět prostě stojí.
      const captured =
        ctx.moments.captured.get(tick) ??
        (ctx.runState !== 'running' && ctx.moments.final !== null && tick >= ctx.moments.final.tick
          ? ctx.moments.final
          : null);
      return observation(req, ctx, captured, `v tiku ${tick}`);
    }
    case 'observationAtWin':
      return observation(req, ctx, ctx.moments.won, 'v tiku výhry');
    case 'observationAtLose':
      // Svědek dochází do VÝHRY, takže prohru vydá jen prohrávající běh. Kdyby
      // se četla z replaye svědka, nemohl by mít `observationAtLose` a
      // `witnessCertifies` současně žádný svět.
      return observation(req, ctx, ctx.moments.lost ?? ctx.losing?.moment ?? null, 'v tiku prohry');
    case 'reachesLose': {
      if (ctx.world === null) return unmet(req, ctx.buildIssue ?? 'svět se nepostavil');
      const within = typeof spec.within === 'number' ? spec.within : ctx.horizonTicks;
      if (ctx.losing === null) return unmet(req, `žádná deklarovaná stopa neskončí prohrou uvnitř ${within} tiků`);
      const at = ctx.losing.moment?.tick ?? Infinity;
      return at <= within
        ? met(req, `prohra nastane v tiku ${at} po ${ctx.losing.how}`)
        : unmet(req, `prohra nastane až v tiku ${at}, kontrakt žádá uvnitř ${within}`);
    }
    case 'randomNotOnWinPath': {
      const read = evaluate('randomNotOnWinPath()', { sim: ctx.sim, doc: ctx.doc, moment: null });
      if (!read.ok) return unmet(req, read.reason);
      return read.value === true ? met(req, 'výhra nečte stav psaný náhodou') : unmet(req, 'výhra závisí na seedované náhodě');
    }
    case 'counterfactual':
      return counterfactual(req, ctx);
    default:
      return unmet(req, `druh ${req.kind} není ve zmrazeném slovníku vrstvy runtime`);
  }
}

// ---------------------------------------------------------------------------
// Vrstva editace
// ---------------------------------------------------------------------------

/** Systémové obálkové pole. Revize hlídá `revisionBumped`, ne dosah patche. */
const ENVELOPE = ['irVersion', 'simRevision', 'lookRevision', 'simHash'];

function withoutEnvelope(doc: unknown): unknown {
  const body = { ...record(doc) };
  for (const key of ENVELOPE) delete body[key];
  return body;
}

function coveredBy(leaf: ChangedLeaf, allowed: readonly AllowedPath[]): boolean {
  return allowed.some((entry) => leaf.effect === entry.op && (leaf.path === entry.path || leaf.path.startsWith(`${entry.path}/`)));
}

interface EditContext {
  readonly before: unknown;
  readonly after: unknown;
  readonly beforeWorld: BuiltWorld | null;
  readonly afterWorld: BuiltWorld | null;
  readonly afterSetup: Moment | null;
  readonly beforeFinal: Moment | null;
  readonly afterFinal: Moment | null;
  readonly buildIssue: string | null;
}

function scoreEdit(req: Requirement, contract: Contract, ctx: EditContext): RequirementResult {
  const spec = record(req.value);
  switch (req.kind) {
    case 'changedLeavesWithin': {
      const allowed = contract.allowedPaths ?? [];
      const leaves = changedLeafEffects(withoutEnvelope(ctx.before), withoutEnvelope(ctx.after));
      const stray = leaves.filter((leaf) => !coveredBy(leaf, allowed));
      return stray.length === 0
        ? met(req, `${leaves.length} změněných listů, všechny uvnitř allowedPaths`)
        : unmet(req, `mimo allowedPaths: ${stray.map((leaf) => `${leaf.effect} ${leaf.path}`).join(', ')}`);
    }
    case 'postcondition': {
      const expr = String(spec.expr);
      const read = evaluate(expr, { sim: simOf(ctx.after), doc: ctx.after, moment: ctx.afterSetup });
      if (!read.ok) return unmet(req, read.reason);
      return compare(read.value, String(spec.op), spec.rhs)
        ? met(req, `${expr} = ${canonical(read.value)}`)
        : unmet(req, `${expr} = ${canonical(read.value)}, kontrakt žádá ${String(spec.op)} ${canonical(spec.rhs)}`);
    }
    case 'protectedObservation': {
      const expr = String(spec.expr);
      const before = evaluate(expr, { sim: simOf(ctx.before), doc: ctx.before, moment: ctx.beforeFinal });
      const after = evaluate(expr, { sim: simOf(ctx.after), doc: ctx.after, moment: ctx.afterFinal });
      // Obě strany „nevím" jsou si rovné, a to je přesně ten vakuózní průchod,
      // kvůli kterému je nezodpověditelnost vlastní výsledek, ne `false`.
      if (!before.ok) return unmet(req, `před úpravou: ${before.reason}`);
      if (!after.ok) return unmet(req, `po úpravě: ${after.reason}`);
      return canonical(before.value) === canonical(after.value)
        ? met(req, `${expr} zůstalo ${canonical(after.value)}`)
        : unmet(req, `${expr} se změnilo z ${canonical(before.value)} na ${canonical(after.value)}`);
    }
    case 'witnessPreserved': {
      if (ctx.afterWorld === null) return unmet(req, ctx.buildIssue ?? 'upravený svět se nepostavil');
      const trace = ctx.beforeWorld?.trace ?? [];
      const certified = verifyWitness(ctx.afterWorld, trace).verdict === 'CERTIFIED';
      return certified === (req.value === true)
        ? met(req, certified ? 'starý svědek dál dochází do výhry' : 'starý svědek přestal platit, jak kontrakt žádá')
        : unmet(req, certified ? 'starý svědek dál platí, kontrakt žádá nového' : 'starý svědek přestal dojít do výhry');
    }
    case 'revisionBumped': {
      const which = spec.which === 'look' ? 'lookRevision' : 'simRevision';
      const other = which === 'simRevision' ? 'lookRevision' : 'simRevision';
      const by = typeof spec.by === 'number' ? spec.by : 1;
      const from = Number(record(ctx.before)[which] ?? 0);
      const to = Number(record(ctx.after)[which] ?? 0);
      if (to - from !== by) return unmet(req, `${which} ${from} → ${to}, kontrakt žádá +${by}`);
      const otherFrom = Number(record(ctx.before)[other] ?? 0);
      const otherTo = Number(record(ctx.after)[other] ?? 0);
      return otherFrom === otherTo
        ? met(req, `${which} +${by}, ${other} beze změny`)
        : unmet(req, `${other} se posunula z ${otherFrom} na ${otherTo}, měla zůstat`);
    }
    case 'entityCountUnchanged': {
      const before = Object.keys(record(record(simOf(ctx.before)).entities)).length;
      const after = Object.keys(record(record(simOf(ctx.after)).entities)).length;
      return before === after ? met(req, `${after} entit beze změny`) : unmet(req, `entit ${before} → ${after}`);
    }
    case 'notNoOp':
      return canonical(simOf(ctx.before)) === canonical(simOf(ctx.after))
        ? unmet(req, 'patch nechal hashovanou část beze změny — nulový behaviorální efekt')
        : met(req, 'patch pohnul hashovanou částí');
    default:
      return unmet(req, `druh ${req.kind} není ve zmrazeném slovníku vrstvy edit`);
  }
}

// ---------------------------------------------------------------------------
// Vrstva výsledku
// ---------------------------------------------------------------------------

function scoreOutcome(req: Requirement, evidence: Evidence, outcomeVerdict: Verdict): RequirementResult {
  switch (req.kind) {
    case 'expectedOutcome':
      return outcomeVerdict === req.value
        ? met(req, `výsledek je ${outcomeVerdict}`)
        : unmet(req, `výsledek je ${outcomeVerdict}, kontrakt žádá ${String(req.value)}`);
    case 'sceneMustBuild':
      return evidence.sceneBuilt ? met(req, 'scéna se postavila') : unmet(req, 'scéna se nepostavila — prázdná obrazovka je chyba (§13.4)');
    default:
      return unmet(req, `druh ${req.kind} není ve zmrazeném slovníku vrstvy outcome`);
  }
}

// ---------------------------------------------------------------------------
// Sestavení běhového kontextu
// ---------------------------------------------------------------------------

function horizonOf(world: BuiltWorld): number {
  return resolvePolicy(world.certification)?.maxHorizonTicks ?? TIER_POLICY[world.certification.tier].maxHorizonTicks;
}

/**
 * Nejkratší stopa z **deklarované abecedy světa**, která skončí prohrou.
 *
 * Prohledávají se dvě rodiny, obě konečné a obě složené jen z toho, co svět sám
 * deklaruje: každý prefix jeho svědka (hráč přestane jednat) a jeden kanonický
 * `moveTo` na každý deklarovaný soket. Nic z toho není heuristika nad prostorem
 * stavů — `heuristicSearch` v protokolu připouští falešné negativy, takže svět,
 * který prohrát jde, ale jinou stopou, se poctivě vykáže jako nenalezený.
 */
function losingRun(world: BuiltWorld, within: number): { readonly how: string; readonly moment: Moment | null } | null {
  for (let prefix = 0; prefix <= world.trace.length; prefix += 1) {
    const run = replay(world, world.trace.slice(0, prefix), within);
    if (run.runState === 'lost') return { how: `${prefix} vstupech svědka`, moment: run.lost };
  }
  const actor = world.trace[0]?.actor ?? world.ir.entities.find((entity) => entity.role === 'actor')?.stableId;
  if (actor === undefined) return null;
  for (const socket of Object.keys(world.space.sockets).sort()) {
    const run = replay(world, [{ tick: 0, actor, actionId: 'moveTo', target: socket }], within);
    if (run.runState === 'lost') return { how: `moveTo ${socket}`, moment: run.lost };
  }
  return null;
}

function runtimeContext(doc: unknown, requirements: readonly Requirement[]): RuntimeContext {
  const sim = simOf(doc);
  const built = buildRuntimeWorld(sim);
  if (!built.ok) {
    return {
      sim,
      doc,
      world: null,
      buildIssue: `svět se nepostavil (${built.reason}): ${built.issues.join('; ')}`,
      horizonTicks: 0,
      moments: { setup: null, won: null, lost: null, final: null, captured: new Map() },
      runState: 'notBuilt',
      faulted: false,
      losing: null,
    };
  }

  const world = built.world;
  const horizonTicks = horizonOf(world);
  const captureTicks = requirements
    .filter((req) => req.kind === 'observationAtTick')
    .map((req) => (typeof record(req.value).tick === 'number' ? (record(req.value).tick as number) : 0));
  const run = replay(world, world.trace, horizonTicks, captureTicks);

  // Prohrávající běh stojí až K+1 replayů, takže se hledá jen když se na něj
  // některý požadavek doopravdy ptá.
  const wantsLose = requirements.some((req) => req.kind === 'reachesLose' || req.kind === 'observationAtLose');
  // Rozpočet hledání je ten největší, který si kterýkoli požadavek vyžádal —
  // `within` je vlastní mez `reachesLose`, ne certifikační horizont, a `C02` ho
  // má o jeden tik nad ním schválně (časovač na 1200 dopadne až v 1201.).
  const within = Math.max(
    horizonTicks,
    ...requirements
      .filter((req) => req.kind === 'reachesLose')
      .map((req) => (typeof record(req.value).within === 'number' ? (record(req.value).within as number) : 0)),
  );

  return {
    sim,
    doc,
    world,
    buildIssue: null,
    horizonTicks,
    moments: { setup: run.setup, won: run.won, lost: run.lost, final: run.final, captured: run.captured },
    runState: run.runState,
    faulted: run.runState === 'runtimeFault',
    losing: wantsLose ? losingRun(world, within) : null,
  };
}

function editContext(before: unknown, after: unknown): EditContext {
  const beforeBuilt = buildRuntimeWorld(simOf(before));
  const afterBuilt = buildRuntimeWorld(simOf(after));
  const beforeWorld = beforeBuilt.ok ? beforeBuilt.world : null;
  const afterWorld = afterBuilt.ok ? afterBuilt.world : null;
  // Diferenciální replay: TÁŽ stopa proti oběma světům. Kdyby každý běžel po
  // svém svědkovi, porovnávaly by se dva různé pokusy, ne dopad úpravy.
  const trace = beforeWorld?.trace ?? afterWorld?.trace ?? [];
  const horizon = afterWorld !== null ? horizonOf(afterWorld) : beforeWorld !== null ? horizonOf(beforeWorld) : 0;

  return {
    before,
    after,
    beforeWorld,
    afterWorld,
    afterSetup: afterWorld === null ? null : replay(afterWorld, trace, 0).setup,
    beforeFinal: beforeWorld === null ? null : replay(beforeWorld, trace, horizon).final,
    afterFinal: afterWorld === null ? null : replay(afterWorld, trace, horizon).final,
    buildIssue: afterBuilt.ok ? null : `upravený svět se nepostavil (${afterBuilt.reason}): ${afterBuilt.issues.join('; ')}`,
  };
}

// ---------------------------------------------------------------------------
// Verdikt
// ---------------------------------------------------------------------------

function outcomeVerdictOf(evidence: Evidence): Verdict {
  if (evidence.outcome === 'fault') return 'FAULT';
  if (evidence.outcome === 'declined') return 'NO_FIT';
  return 'FULFILLED';
}

/**
 * Ohodnotí jeden případ proti jeho zmrazenému kontraktu.
 *
 * Verdikt vzniká ve dvou krocích a v tomhle pořadí: nejdřív se změří požadavky,
 * pak se na výsledek položí stropy. Obráceně by se strop dal obejít tím, že se
 * požadavek prohlásí za nepodstatný.
 */
export function scoreCase(contract: Contract, evidence: Evidence): ScoreResult {
  const outcomeVerdict = outcomeVerdictOf(evidence);
  const ceiling = contract.verdictCeiling;
  const gates: string[] = [];

  const outcomeReqs = contract.requirements.filter((req) => req.layer === 'outcome');
  const substantive = contract.requirements.filter((req) => req.layer !== 'outcome' && req.kind !== 'sceneMustBuild');

  const results: RequirementResult[] = outcomeReqs.map((req) => scoreOutcome(req, evidence, outcomeVerdict));

  if (evidence.outcome === 'emitted' || evidence.outcome === 'committed') {
    if (evidence.kind === 'create') {
      const ctx = runtimeContext(evidence.doc, substantive);
      if (ctx.world === null) gates.push(ctx.buildIssue ?? 'svět se nepostavil');
      else if (isInstaWin(ctx.world)) gates.push('insta-win: svět vyhrává v tiku 0 bez jediného vstupu');
      const dangling = danglingGate(evidence.doc);
      if (dangling !== null) gates.push(dangling);
      if (Object.keys(ruleBodies(ctx.sim)).length === 0) gates.push('graf nemá jediné pravidlo — prázdné chování');

      for (const req of substantive) {
        results.push(req.layer === 'graph' ? scoreGraph(req, ctx.sim) : scoreRuntime(req, ctx));
      }
    } else {
      const ctx = editContext(evidence.before, evidence.after);
      if (ctx.afterWorld === null) gates.push(ctx.buildIssue ?? 'upravený svět se nepostavil');
      else if (isInstaWin(ctx.afterWorld)) gates.push('insta-win: upravený svět vyhrává v tiku 0 bez jediného vstupu');
      const dangling = danglingGate(evidence.after);
      if (dangling !== null) gates.push(dangling);

      for (const req of substantive) {
        results.push(
          req.layer === 'graph'
            ? scoreGraph(req, simOf(evidence.after))
            : req.layer === 'runtime'
              ? scoreRuntime(req, runtimeContext(evidence.after, [req]))
              : scoreEdit(req, contract, ctx),
        );
      }
    }
  } else {
    for (const req of substantive) {
      results.push(unmet(req, `emise skončila jako ${evidence.outcome}, požadavek se neměřil`));
    }
  }

  if (contract.scoreAs === 'ROBUST_ONLY') gates.push(`strop ROBUST: ${contract.scoreAsReason ?? 'záznam se skóruje jen jako ROBUST'}`);
  if (substantive.length === 0) gates.push('prázdný vektor požadavků — není co splnit');
  if (evidence.outcome === 'fallback') gates.push('fallback: použitelný výsledek, ale ne splněný kontrakt');

  if (outcomeVerdict !== 'FULFILLED') return { id: contract.id, verdict: outcomeVerdict, ceiling, requirements: results, gates };

  const allMet = results.every((result) => result.met);
  const verdict: Verdict = allMet && gates.length === 0 && ceiling === 'FULFILLED' ? 'FULFILLED' : 'ROBUST';
  return { id: contract.id, verdict, ceiling, requirements: results, gates };
}
