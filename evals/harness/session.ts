/**
 * Tříúpravová relace (T19) — **tři po sobě jdoucí živé editace jednoho světa.**
 *
 * T18 změřil tvorbu: jeden prompt, jeden svět, konec. Editace se takhle změřit
 * nedá, protože to zajímavé na ní je právě to, co se stane **podruhé a potřetí** —
 * jestli druhá úprava rozbije první a jestli třetí ještě vůbec ví, na čem stojí.
 * Sada nezávislých jednotahových měření tuhle vlastnost neuvidí ani omylem.
 *
 * ## Proč to nejde přes `POST /api/edit`, přestože to AC úlohy říká
 *
 * Rozhodnuto 14. 8. 2026 uživatelem, po předložení tří variant. Endpoint tenhle
 * scénář **nemůže obsloužit, a není to jeho vada**:
 *
 * 1. `emitPatch` (`src/model/client.ts`) váže každý zmrazený patch na základní
 *    svět **otiskem obsahu jeho `sim` části**. To je bezpečnostní vazba přidaná
 *    po naměřeném padělání `simHash` a nesmí se uvolnit. Jenže jakmile se první
 *    úprava commitne, `sim` se změní — a druhá úprava dostane
 *    `BASE_WORLD_MISMATCH`, tedy 404. **Řetězení je přes zmrazený korpus zavřené
 *    z principu, ne kvůli chybějícímu řádku.**
 * 2. Endpoint je v P1 celý v režimu záznamu a živý model zavolat neumí vůbec.
 *
 * Zbývaly tři cesty. Uvolnit tu vazbu znamená otevřít zpátky díru, kterou brána
 * nad `f7e153c` našla a zavřela. Naučit endpoint volat poskytovatele znamená
 * pustit konfiguraci modelu a strop útraty do `src/`, tedy do veřejného API
 * kontraktu, kvůli měřicí úloze. Zbývá ta třetí, kterou **T18 už jednou zvolil a
 * napsal si ji do hlavičky `live.ts`**: jet **produkční cestou vedle endpointu**.
 *
 * Není to druhá implementace a není to obcházení kontroly. Tenhle soubor volá
 * přesně ty funkce, které uvnitř sebe volá `route.ts` — `buildEditRequest`,
 * `routePatch`, `commitRoutedParts` — ve stejném pořadí a bez jediné náhrady.
 * Co odpadá, je HTTP obálka a čtení zmrazeného záznamu; a odpadnout musí, protože
 * to druhé je právě ta věc, kvůli které relace nejde poskládat.
 *
 * A záměr, kvůli kterému review v2 endpoint předepsalo, zůstává splněný beze
 * zbytku: *„ručně připravené patche by tenhle test splnily."* Tady žádný ručně
 * připravený patch není. Patch přichází od modelu, přes tentýž router a tentýž
 * commit, a zadání je doslovný text zmrazeného promptu.
 *
 * ## Tichý no-op se pozná chováním, ne diffem
 *
 * AC žádá, aby *„patch s nulovým behaviorálním efektem"* byl selhání. Scorer to
 * měří strukturálně (`notNoOp`: pohnula se hashovaná část?) a to nestačí —
 * přejmenovaná konstanta v pravidle, které nikdy nespustí, diffem pohne a
 * chováním ne.
 *
 * Měří se proto **dvěma sondami nad plným horizontem**, obě nad stopou, kterou
 * svět sám deklaruje:
 *
 * 1. **svědkem** — kanonická vítězná hra;
 * 2. **prázdnou stopou** — svět nechaný běžet bez hráče, aby se projevily
 *    časovače a pravidla, která svědek stihne minout.
 *
 * Podpis běhu je `(runState, fault, koncový tik, počet spuštění po pravidlech)`.
 * Rule id jsou stabilní (§15 klíčuje pravidla jménem), takže podpis je
 * porovnatelný napříč verzemi světa. Shodnou-li se **obě** sondy, úprava
 * pozorovatelně neudělala nic — a to je selhání tahu, ne jeho nízké skóre.
 *
 * ## Úspěšnost relace se měří, nedopočítává
 *
 * AC to říká výslovně a je to celý důvod, proč tenhle soubor existuje. Relace
 * uspěje jedině tehdy, když **všechny tři tahy** na **témž světě** commitly,
 * dostaly `FULFILLED`, pohnuly chováním a nechaly platit, co udělaly ty před
 * nimi. Číslo se počítá z relací, ne z tahů. `independenceEstimate` se vykazuje
 * vedle něj **jen jako kontrast** — je to `p³` z tahové úspěšnosti, tedy přesně
 * ten dopočet, který AC zakazuje, a rozdíl mezi těmi dvěma čísly je nález.
 *
 * ## Co je selhání běhu a co naměřený výsledek
 *
 * `failures` znamená **rozbitý harness** — zmrazený záznam vydávaný za živý,
 * nespojený řetěz hashů, rozejití prohlížeče s Nodem, nedostupný poskytovatel.
 * Neúspěšný tah mezi ně nepatří: model, který úpravu nezvládl, je to, co se tu
 * měří. Kdyby obojí padalo do jedné hromady, `ok: false` by přestalo znamenat
 * „tomuhle běhu se nedá věřit".
 */

import { randomUUID } from 'node:crypto';

import { commitRoutedParts, type CommitOutcome } from '../../src/app/api/edit/commit';
import { buildRuntimeWorld } from '../../src/ir/build';
import type { PartPatch } from '../../src/ir/revision';
import { canonical, type WorldDoc } from '../../src/ir/worlddoc';
import { frozenGrammar } from '../../src/model/client';
import { buildEditRequest } from '../../src/model/edit-prompt';
import type { Grammar, UpstreamRequest } from '../../src/model/prompt';
import { routePatch } from '../../src/patch/router';
import type { TraceInput } from '../../src/sim/interpreter';
import { TIER_POLICY } from '../../src/verify/tiers';
import { verifyWitness, type VerifiableWorld, type VerifyResult } from '../../src/verify/witness';
import { loadContracts, scoreCase, type Contract, type Verdict } from '../scorer/semantic';
import { compare, evaluate, replay, type Moment } from '../scorer/world';
import { chainFailures, editEvidence, ledger, type StageRecord, type StopStage, type Transport } from './chain';
import {
  PreflightError,
  canonicalHash,
  extractJson,
  frozenBodyHashes,
  frozenPromptsOfKind,
  responsesDir,
  storeResponse,
  transportFor,
  worstCaseCostUsd,
  type LiveFailure,
  type LivePrompt,
  type ParsedVia,
  type ProviderTransport,
} from './live';
import {
  costUsd,
  preflight,
  withLiveModel,
  type Env,
  type LiveConfig,
  type ProviderProfile,
  type Usage,
} from './preflight';

/** Kolik tahů má relace. **Tři** — pin z AC úlohy, ne laditelný parametr. */
export const TURNS_PER_SESSION = 3;

// ---------------------------------------------------------------------------
// Výběr relací ze zmrazené sady
// ---------------------------------------------------------------------------

export interface SessionPlan {
  readonly baseWorld: string;
  readonly prompts: readonly LivePrompt[];
}

/**
 * Relace, které zmrazená sada unese — deterministicky a bez výběru na míru.
 *
 * Bere se **každý** svět, ke kterému existují aspoň tři editační prompty, a z něj
 * první tři v pořadí id. Žádné třídění podle toho, které vypadají snáz: výběr
 * podle očekávaného výsledku je ladění metriky, i když se dělá před měřením.
 */
export function editSessions(): readonly SessionPlan[] {
  const byBase = new Map<string, LivePrompt[]>();
  for (const prompt of [...frozenPromptsOfKind('edit')].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (prompt.baseWorld === undefined) continue;
    const bucket = byBase.get(prompt.baseWorld) ?? [];
    bucket.push(prompt);
    byBase.set(prompt.baseWorld, bucket);
  }
  return [...byBase.entries()]
    .filter(([, prompts]) => prompts.length >= TURNS_PER_SESSION)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([baseWorld, prompts]) => ({ baseWorld, prompts: prompts.slice(0, TURNS_PER_SESSION) }));
}

// ---------------------------------------------------------------------------
// Behaviorální podpis
// ---------------------------------------------------------------------------

/** Co z běhu je pozorovatelné a zároveň porovnatelné napříč verzemi světa. */
interface Behaviour {
  readonly runState: string;
  readonly fault: string | null;
  readonly endTick: number;
  readonly fired: readonly (readonly [string, number])[];
}

/**
 * Kolik tiků se sonda dívá — **nejdelší okno, jaké systém kdy odsimuluje.**
 *
 * Není to certifikační horizont světa a nesmí být. Tvrzení, které se tu vyrábí,
 * zní „ta úprava neudělala nic" — a důkaz proti němu se má hledat co nejdéle,
 * ne jen tak dlouho, jak dlouho se hledá výhra. Naměřeno na `C02`: časovač
 * `flood` posunutý z 1200 na 2400 tiků je uvnitř jeho vlastního horizontu
 * (standard, 1200) **nerozeznatelný**, protože se v tom okně neprojeví ani jedna
 * z těch dvou hodnot. Sonda by pak hlásila tichý no-op u úpravy, která je celá
 * o tom časovači — tedy měřila by tier, ne model.
 *
 * `replay()` bere horizont jako argument volajícího právě proto; certifikace se
 * tím nemění, ta zůstává u `verifyWitness` a u svého tieru.
 */
const PROBE_HORIZON_TICKS = TIER_POLICY.long.maxHorizonTicks;

function behaviourOf(sim: unknown, trace: readonly TraceInput[], horizonTicks: number): Behaviour | null {
  const built = buildRuntimeWorld(sim);
  if (!built.ok) return null;
  const run = replay(built.world, trace, horizonTicks);
  return {
    runState: run.runState,
    fault: run.fault,
    endTick: run.final.tick,
    // Setříděno podle id, protože pořadí spuštění je vlastnost běhu, ne podpisu —
    // dvě verze světa, které spustí totéž jinak seřazené, se liší v `endTick`.
    fired: [...run.final.fireCounts].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  };
}

export type BehaviouralEffect =
  /** Aspoň jedna sonda se rozešla — úprava je pozorovatelná. */
  | 'moved'
  /** Obě sondy dopadly identicky — tichý no-op, tedy selhání tahu. */
  | 'silent'
  /** Nedá se říct: jedna ze stran se nepostavila. Není to no-op ani jeho opak. */
  | 'unobservable';

export interface BehaviourVerdict {
  readonly effect: BehaviouralEffect;
  readonly detail: string;
}

/**
 * Porovná chování světa před úpravou a po ní dvěma sondami.
 *
 * Obě sondy jedou nad **stopou před úpravou**, protože se porovnává táž hra
 * na dvou verzích pravidel. Nová stopa by porovnávala dvě různé hry a rozdíl by
 * nedokazoval nic o té úpravě.
 */
export function behaviouralEffect(before: WorldDoc, after: WorldDoc): BehaviourVerdict {
  const built = buildRuntimeWorld(before.sim);
  if (!built.ok) return { effect: 'unobservable', detail: `svět před úpravou se nepostavil: ${built.reason}` };

  const probes: readonly { readonly name: string; readonly trace: readonly TraceInput[] }[] = [
    { name: 'svědek', trace: built.world.trace },
    { name: 'svět bez hráče', trace: [] },
  ];

  for (const probe of probes) {
    const was = behaviourOf(before.sim, probe.trace, PROBE_HORIZON_TICKS);
    const is = behaviourOf(after.sim, probe.trace, PROBE_HORIZON_TICKS);
    if (was === null) return { effect: 'unobservable', detail: 'svět před úpravou se nepostavil' };
    if (is === null) return { effect: 'unobservable', detail: 'svět po úpravě se nepostavil' };
    if (canonical(was) !== canonical(is))
      return {
        effect: 'moved',
        detail: `sonda "${probe.name}" se rozešla: ${was.runState}@${was.endTick} → ${is.runState}@${is.endTick}`,
      };
  }
  return {
    effect: 'silent',
    detail: `obě sondy nad ${PROBE_HORIZON_TICKS} tiky dopadly identicky — patch pohnul dokumentem, ne během`,
  };
}

// ---------------------------------------------------------------------------
// Zachování toho, co udělaly předchozí tahy
// ---------------------------------------------------------------------------

export interface Preservation {
  readonly rid: string;
  /** Tah, jehož požadavek se ověřuje znovu, počítáno od jedné. */
  readonly fromTurn: number;
  readonly held: boolean;
  readonly detail: string;
}

/** Okamžik před prvním tikem — jediné, co `postcondition` nad dokumentem čte. */
function setupMoment(doc: WorldDoc): Moment | null {
  const built = buildRuntimeWorld(doc.sim);
  if (!built.ok) return null;
  return replay(built.world, [], 0).setup;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Drží ještě na konci relace to, co si vymohly dřívější tahy?
 *
 * Ověřuje se **`postcondition`** každého dřívějšího commitnutého tahu proti
 * **finálnímu** dokumentu. To je celý smysl relace: úprava, kterou další tah
 * mlčky přepíše, nebyla úprava, byl to mezikrok.
 *
 * Vedle toho dvě strukturální podmínky, které říkají, že se svět po cestě
 * neresetoval: žádná entita ze základního světa nezmizela a `simRevision`
 * povyrostla přesně o počet commitnutých `sim` tahů. Přeemitovaný svět projde
 * první podmínkou a na druhé spadne, protože revizi si model nevybírá.
 */
export function preservationOf(
  base: WorldDoc,
  final: WorldDoc,
  turns: readonly { readonly index: number; readonly contract: Contract; readonly committedSim: boolean }[],
): readonly Preservation[] {
  const checks: Preservation[] = [];
  const moment = setupMoment(final);

  const baseEntities = Object.keys(asRecord(asRecord(base.sim).entities));
  const finalEntities = new Set(Object.keys(asRecord(asRecord(final.sim).entities)));
  const lost = baseEntities.filter((id) => !finalEntities.has(id));
  checks.push({
    rid: 'session.entitiesSurvive',
    fromTurn: 0,
    held: lost.length === 0,
    detail: lost.length === 0 ? `všech ${baseEntities.length} entit základního světa přežilo` : `zmizely: ${lost.join(', ')}`,
  });

  const expectedBump = turns.filter((turn) => turn.committedSim).length;
  const actualBump = final.simRevision - base.simRevision;
  checks.push({
    rid: 'session.revisionMonotone',
    fromTurn: 0,
    held: actualBump === expectedBump,
    detail: `simRevision ${base.simRevision} → ${final.simRevision} (+${actualBump}), commitnutých sim tahů ${expectedBump}`,
  });

  for (const turn of turns) {
    if (!turn.committedSim) continue;
    for (const requirement of turn.contract.requirements) {
      if (requirement.kind !== 'postcondition') continue;
      const spec = asRecord(requirement.value);
      const expr = String(spec.expr);
      const read = evaluate(expr, { sim: final.sim, doc: final, moment });
      checks.push(
        read.ok
          ? {
              rid: requirement.rid,
              fromTurn: turn.index,
              held: compare(read.value, String(spec.op), spec.rhs),
              detail: `${expr} = ${canonical(read.value)} na konci relace, tah ${turn.index} žádal ${String(spec.op)} ${canonical(spec.rhs)}`,
            }
          : { rid: requirement.rid, fromTurn: turn.index, held: false, detail: `${expr}: ${read.reason}` },
      );
    }
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Jeden tah
// ---------------------------------------------------------------------------

export interface SessionTurn {
  /** Pořadí v relaci, počítáno od jedné. */
  readonly index: number;
  readonly promptId: string;
  readonly editClass: string;
  readonly verdict: Verdict;
  readonly gates: readonly string[];
  readonly unmet: readonly string[];
  readonly committed: boolean;
  readonly stoppedAt: StopStage;
  readonly changedLeaves: readonly string[];
  readonly behaviour: BehaviourVerdict;
  /** Tah uspěl: commitnul, splnil kontrakt a pohnul chováním. Všechno tři. */
  readonly passed: boolean;
  readonly parsedVia: ParsedVia;
  readonly rawHash: string;
  readonly bodyHash: string;
  readonly responsePath: string;
  readonly usage: Usage;
  readonly costUsd: number | null;
  readonly browserReplayed: boolean;
  readonly browserHash: string | null;
  readonly offlineHash: string | null;
  readonly records: readonly StageRecord[];
  readonly failures: readonly LiveFailure[];
}

const hashOf = (result: VerifyResult | null): string | null =>
  result !== null && result.verdict === 'CERTIFIED' ? result.snapshotHash : null;

interface TurnInput {
  readonly index: number;
  readonly prompt: LivePrompt;
  readonly contract: Contract;
  readonly doc: WorldDoc;
  readonly request: UpstreamRequest;
  readonly completion: { readonly raw: unknown; readonly text: string; readonly usage: Usage };
  readonly config: LiveConfig;
  readonly runId: string;
  readonly baseWorld: string;
  readonly replay: Transport['replay'];
  readonly frozenHashes: ReadonlySet<string>;
  /** `undefined` = `evals/live/`. Testy si ho přesměrují mimo repozitář. */
  readonly root: string | undefined;
}

async function runTurn(input: TurnInput): Promise<{ readonly turn: SessionTurn; readonly after: WorldDoc }> {
  const id = input.prompt.id;
  const failures: LiveFailure[] = [];
  const { body, via } = extractJson(input.completion.text);
  const spent = input.config.metered ? costUsd(input.completion.usage, input.config) : null;

  const stored = storeResponse(
    {
      synthetic: false,
      runId: input.runId,
      forPrompt: id,
      branch: 'edit',
      baseWorld: input.baseWorld,
      turn: input.index,
      profile: input.config.profile,
      endpoint: input.config.model.url,
      request: input.request,
      raw: input.completion.raw,
      body,
      parsedVia: via,
      usage: input.completion.usage,
      costUsd: spent,
    },
    input.root,
  );

  // Táž brána jako u tvorby: živý tah nesmí ukazovat na nic ze zmrazeného korpusu.
  for (const [what, hash] of [
    ['odpověď', stored.rawHash],
    ['tělo', stored.bodyHash],
    ['tělo v kanonickém tvaru', canonicalHash(body)],
  ] as const)
    if (input.frozenHashes.has(hash))
      failures.push({
        caseId: id,
        kind: 'frozen-leak',
        detail: `${what} tahu ${input.index} má hash ${hash}, který je ve zmrazeném korpusu — běh čte záznam, ne poskytovatele`,
      });

  const log = ledger(id, randomUUID(), stored.rawHash);

  // 1 — emise patche. Co model poslal, doslova.
  log.write('emit', body, `patch ${input.index}/${TURNS_PER_SESSION} nad ${input.baseWorld}`);

  // 2 — validace: dráhu rozhodují normalizované cesty, ne štítek (T22)
  const routed = routePatch({ operations: body as never });
  log.write(
    'validate',
    routed.verdict === 'ROUTED'
      ? { ok: true, lanes: routed.patches.map((part) => part.lane), parts: routed.patches.map((part) => part.part) }
      : { ok: false, reason: routed.reason, pointer: routed.pointer },
    routed.verdict === 'ROUTED' ? `dráhy ${routed.patches.map((part) => part.lane).join(',')}` : `routing/${routed.reason}`,
  );

  // 3 — mechanická oprava je definovaná nad emisí světa, ne nad patchem
  log.identity('repair', 'mechanická oprava je definovaná nad emisí světa, ne nad patchem');

  // 4 — atomický commit, produkčním `commitRoutedParts`
  const committed: CommitOutcome | null =
    routed.verdict === 'ROUTED'
      ? commitRoutedParts(
          input.doc,
          routed.patches.map(
            (part): PartPatch => ({
              part: part.part,
              baseRevision: part.part === 'sim' ? input.doc.simRevision : input.doc.lookRevision,
              operations: part.operations,
            }),
          ),
        )
      : null;
  log.write(
    'commit',
    committed === null
      ? { committed: false, reason: routed.verdict === 'ROUTED' ? 'unreachable' : routed.reason }
      : { outcome: committed.outcome, applied: committed.applied, changedLeaves: committed.changedLeaves, after: committed.after },
    committed === null
      ? `necommitnuto: routing/${routed.verdict === 'ROUTED' ? 'unreachable' : routed.reason}`
      : `${committed.outcome}, aplikováno ${committed.applied.join('+') || 'nic'}`,
  );

  // 5 — replay v prohlížeči nad světem PO commitu
  const simApplied = committed !== null && committed.applied.includes('sim');
  const after = committed !== null && simApplied ? committed.after : input.doc;
  const built = simApplied ? buildRuntimeWorld(after.sim) : null;
  const world: VerifiableWorld | null = built !== null && built.ok ? built.world : null;
  const offline = world === null ? null : verifyWitness(world, world.trace);
  const browser = world === null ? null : await input.replay(world, world.trace);
  if (browser !== null && offline !== null && canonical(browser) !== canonical(offline))
    failures.push({
      caseId: id,
      kind: 'browser-divergence',
      detail: `prohlížeč ${canonical(browser).slice(0, 160)}, Node ${canonical(offline).slice(0, 160)}`,
    });
  log.write(
    'replay',
    browser ?? { replayed: false, reason: 'sim se necommitla, není co přehrát' },
    browser === null ? 'sim se necommitla, není co přehrát' : `prohlížeč: ${browser.verdict}`,
  );

  const rejection = committed?.rejections[0] ?? null;
  const score = scoreCase(input.contract, editEvidence(input.doc, committed, routed.verdict === 'ROUTED' ? null : routed.reason));
  // Chování se porovnává jedině tam, kde se `sim` doopravdy aplikovala. Bez toho
  // by necommitnutý tah hlásil `silent` — což je pravda o dokumentu a lež o tahu.
  const behaviour: BehaviourVerdict = simApplied
    ? behaviouralEffect(input.doc, after)
    : { effect: 'unobservable', detail: 'sim se necommitla, není co porovnávat' };
  failures.push(...chainFailures(id, log.records, stored.rawHash));

  return {
    after,
    turn: {
      index: input.index,
      promptId: id,
      editClass: input.prompt.editClass ?? input.contract.editClass ?? 'neuveden',
      verdict: score.verdict,
      gates: score.gates,
      unmet: score.requirements.filter((requirement) => !requirement.met).map((requirement) => requirement.rid),
      committed: simApplied,
      stoppedAt: routed.verdict !== 'ROUTED' ? 'routing' : rejection === null ? null : (rejection.stage as StopStage),
      changedLeaves: committed?.changedLeaves ?? [],
      behaviour,
      passed: simApplied && score.verdict === 'FULFILLED' && behaviour.effect === 'moved',
      parsedVia: via,
      rawHash: stored.rawHash,
      bodyHash: stored.bodyHash,
      responsePath: stored.path,
      usage: input.completion.usage,
      costUsd: spent,
      browserReplayed: browser !== null,
      browserHash: hashOf(browser),
      offlineHash: hashOf(offline),
      records: log.records,
      failures,
    },
  };
}

// ---------------------------------------------------------------------------
// Relace a běh
// ---------------------------------------------------------------------------

export interface SessionResult {
  readonly baseWorld: string;
  readonly turns: readonly SessionTurn[];
  readonly preservation: readonly Preservation[];
  /**
   * Relace uspěla: **všechny** tahy prošly a nic z dřívějška se cestou neztratilo.
   * Jedno číslo za celou relaci, ne průměr přes tahy.
   */
  readonly passed: boolean;
  /** Proč relace skončila dřív, než měla. `null` = doběhla všechny tahy. */
  readonly abortedAt: string | null;
}

/**
 * Uspěla relace? **Tři podmínky a všechny musí platit současně.**
 *
 * Stojí to samostatně, protože je to celé rozhodovací pravidlo úlohy a potřebuje
 * vlastní oracle. Uvnitř běhu se nedá dokázat: zmrazený korpus nemá jedinou
 * trojici, která by mohla projít všemi třemi tahy (`E19` má
 * `witnessPreserved: false`, což produkční brána svědka odmítne — `CLAUDE.md`,
 * rozpor 8), takže větev „všechno prošlo" tam nikdy nenastane a mutace v ní by
 * přežila celou sadu.
 */
export function sessionPassed(
  turns: readonly { readonly passed: boolean }[],
  preservation: readonly { readonly held: boolean }[],
): boolean {
  return (
    turns.length === TURNS_PER_SESSION &&
    turns.every((turn) => turn.passed) &&
    preservation.every((check) => check.held)
  );
}

export interface SessionReport {
  readonly runId: string;
  readonly model: string;
  readonly profile: ProviderProfile;
  readonly sessions: readonly SessionResult[];
  readonly records: readonly StageRecord[];
  readonly sessionsPassed: number;
  readonly sessionsCompleted: number;
  readonly sessionsPlanned: number;
  /** Měřeno z relací. `null`, když žádná nedoběhla — ne nula. */
  readonly sessionSuccessRate: number | null;
  readonly turnsPassed: number;
  readonly turnsRun: number;
  readonly turnSuccessRate: number | null;
  /**
   * `turnSuccessRate³` — **kontrast, ne výsledek.**
   *
   * Je to přesně ten dopočet z nezávislosti tahů, který AC úlohy zakazuje.
   * Vykazuje se vedle naměřené hodnoty, protože rozdíl mezi nimi je to, co o
   * editační větvi říká něco nového: kdyby si tahy nepřekážely, čísla by seděla.
   */
  readonly independenceEstimate: number | null;
  readonly counts: Readonly<Record<Verdict, number>>;
  readonly complete: boolean;
  readonly stoppedReason: string | null;
  readonly spentUsd: number | null;
  readonly capUsd: number | null;
  readonly calls: number;
  readonly callCap: number | null;
  readonly browserReplays: number;
  readonly responsesDir: string;
  readonly failures: readonly LiveFailure[];
  readonly ok: boolean;
}

export interface SessionOptions {
  readonly env: Env;
  /** Viz `LiveOptions.provider` — sentinel `'allowlist'` je vědomá volba. */
  readonly provider: ProviderTransport | 'allowlist';
  /** Základní svět se bere produkční emisní cestou, replay jde do prohlížeče. */
  readonly transport: Transport;
  readonly runId?: string;
  /** Podmnožina základních světů. Bez ní jedou všechny, které sada unese. */
  readonly baseWorlds?: readonly string[];
  readonly root?: string;
}

/** Gramatika se čte jednou; nečitelný zmrazený protokol je rozbité prostředí. */
function grammar(): Grammar {
  const read = frozenGrammar();
  if (!read.ok) throw new Error(`zmrazený protokol nejde přečíst: ${read.detail}`);
  return read.value;
}

export async function runEditSessions(options: SessionOptions): Promise<SessionReport> {
  const runId = options.runId ?? randomUUID();
  const root = options.root;

  // PŘED prvním placeným voláním. Selhání tady je odmítnutí startu, ne výsledek.
  const initial = preflight(options.env);
  if (!initial.ok) throw new PreflightError(initial);

  const contracts = new Map(loadContracts().map((contract) => [contract.id, contract]));
  const frozenHashes = frozenBodyHashes();
  const vocabulary = grammar();
  const planned = editSessions().filter(
    (plan) => options.baseWorlds === undefined || options.baseWorlds.includes(plan.baseWorld),
  );

  const sessions: SessionResult[] = [];
  const failures: LiveFailure[] = [];
  let spentUsd = 0;
  let calls = 0;
  let stoppedReason: string | null = null;

  for (const plan of planned) {
    if (stoppedReason !== null) break;

    const emitted = await options.transport.post('/api/emit', { promptId: plan.baseWorld });
    const baseDoc = emitted.status === 200 ? (emitted.body.doc as WorldDoc | null) : null;
    if (baseDoc === null || baseDoc === undefined) {
      failures.push({
        caseId: plan.baseWorld,
        kind: 'transport',
        detail: `základní svět ${plan.baseWorld} nevydal dokument (HTTP ${emitted.status})`,
      });
      sessions.push({ baseWorld: plan.baseWorld, turns: [], preservation: [], passed: false, abortedAt: 'základní svět' });
      continue;
    }

    const turns: SessionTurn[] = [];
    const scored: { index: number; contract: Contract; committedSim: boolean }[] = [];
    let doc = baseDoc;
    let abortedAt: string | null = null;

    for (const prompt of plan.prompts) {
      const gate = preflight(options.env, { usd: spentUsd, calls });
      if (!gate.ok) {
        stoppedReason = `${gate.reason}: ${gate.detail}`;
        abortedAt = `${prompt.id} (rozpočet)`;
        break;
      }

      const contract = contracts.get(prompt.id);
      if (contract === undefined) throw new Error(`prompt ${prompt.id} nemá zmrazený kontrakt`);

      // Požadavek se staví proti **aktuálnímu** dokumentu, ne proti základnímu.
      // To je celá relace: třetí tah vidí, co udělaly první dva.
      const request = withLiveModel(buildEditRequest(prompt.prompt, vocabulary, doc), gate);
      const reserve = gate.metered ? worstCaseCostUsd(request, gate) : 0;
      if (gate.metered && reserve > gate.remainingUsd) {
        stoppedReason = `CAP_RESERVE: zbývá ${gate.remainingUsd.toFixed(5)} USD, ale volání může stát až ${reserve.toFixed(5)} USD`;
        abortedAt = `${prompt.id} (rezerva)`;
        break;
      }

      calls += 1;
      let completion: Awaited<ReturnType<ProviderTransport['complete']>>;
      try {
        const provider = options.provider === 'allowlist' ? transportFor(gate) : options.provider;
        completion = await provider.complete(request, gate);
      } catch (thrown) {
        failures.push({ caseId: prompt.id, kind: 'provider', detail: (thrown as Error).message });
        spentUsd += reserve;
        stoppedReason = `PROVIDER_UNUSABLE: ${prompt.id} — útrata volání je neznámá, rezerva ${reserve.toFixed(5)} USD účtována`;
        abortedAt = `${prompt.id} (poskytovatel)`;
        break;
      }

      const outcome = await runTurn({
        index: turns.length + 1,
        prompt,
        contract,
        doc,
        request,
        completion,
        config: gate,
        runId,
        baseWorld: plan.baseWorld,
        replay: options.transport.replay,
        frozenHashes,
        root,
      });
      spentUsd += outcome.turn.costUsd ?? 0;
      turns.push(outcome.turn);
      scored.push({ index: outcome.turn.index, contract, committedSim: outcome.turn.committed });
      failures.push(...outcome.turn.failures);
      doc = outcome.after;
    }

    const preservation = preservationOf(baseDoc, doc, scored);
    sessions.push({
      baseWorld: plan.baseWorld,
      turns,
      preservation,
      passed: sessionPassed(turns, preservation),
      abortedAt,
    });
  }

  const turnList = sessions.flatMap((session) => session.turns);
  const counts: Record<Verdict, number> = { FULFILLED: 0, ROBUST: 0, NO_FIT: 0, FAULT: 0 };
  for (const turn of turnList) counts[turn.verdict] += 1;

  const completed = sessions.filter((session) => session.turns.length === TURNS_PER_SESSION);
  const sessionsPassed = sessions.filter((session) => session.passed).length;
  const turnsPassed = turnList.filter((turn) => turn.passed).length;
  const turnSuccessRate = turnList.length === 0 ? null : turnsPassed / turnList.length;

  if (stoppedReason === null && completed.length !== planned.length)
    stoppedReason = `INCOMPLETE_SESSIONS: ${planned.length - completed.length} z ${planned.length} relací nedoběhlo všechny tahy`;

  return {
    runId,
    model: initial.model.id,
    profile: initial.profile,
    sessions,
    records: turnList.flatMap((turn) => turn.records),
    sessionsPassed,
    sessionsCompleted: completed.length,
    sessionsPlanned: planned.length,
    sessionSuccessRate: completed.length === 0 ? null : sessionsPassed / completed.length,
    turnsPassed,
    turnsRun: turnList.length,
    turnSuccessRate,
    independenceEstimate: turnSuccessRate === null ? null : turnSuccessRate ** TURNS_PER_SESSION,
    counts,
    // Prázdný plán není úplný běh — `promptIds` s překlepem by jinak vykázal
    // hotové měření, které nezměřilo nic.
    complete: stoppedReason === null && planned.length > 0 && completed.length === planned.length,
    stoppedReason,
    spentUsd: initial.metered ? spentUsd : null,
    capUsd: initial.metered ? initial.capUsd : null,
    calls,
    callCap: initial.metered ? null : initial.callCap,
    browserReplays: turnList.filter((turn) => turn.browserReplayed).length,
    responsesDir: responsesDir(runId, root),
    failures,
    ok: failures.length === 0 && turnList.length > 0,
  };
}
