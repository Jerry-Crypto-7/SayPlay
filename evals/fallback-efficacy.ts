/**
 * Nevakuózní účinnost fallbacku (P2 T205a).
 *
 * ## Co se tady měří
 *
 * Jestli fallback nad **zmrazenými** prompty dělá něco užitečného, nebo jestli
 * jen stabilně odmítá. Podlahy si P2 nesmí nastavit sám — jsou zmrazené v
 * `evals/frozen/protocol.v1.json` → `fallbackFloors` a čtou se odtamtud, nikdy
 * se nepíšou do konstanty vedle testu.
 *
 * ## Proč tenhle soubor leží v `evals/`, a ne v `src/fallback/__tests__/`
 *
 * Plán T205a měl v `Files:` test `src/fallback/__tests__/efficacy.test.ts`, což
 * je v přímém rozporu s vlastní větou téhož AC — *„scorer je importovaný jen v
 * `evals/`, nikdy v `src/fallback/`"* — a hlavně s **T204**. Sémantický scorer
 * sahá na `src/ir`, `src/sim`, `src/verify` i `src/patch`; kdyby ho importoval
 * jakýkoli soubor pod `src/fallback/`, spadl by do tranzitivního obalu jádra a
 * `scripts/prove-fallback-isolation.mjs` by skončil na *„fallback sahá na
 * jádro"*. Měření tedy patří sem: `evals/` na jádro sahat smí, protože je to
 * měřicí nástroj, ne runtime.
 *
 * ## Směr důkazu
 *
 * Nic se netvrdí o tom, co fallback *umí* — přehraje se, co skutečně udělá:
 *  1. router dostane zmrazený prompt a rozhodne;
 *  2. u archetypu se postaví partie a **přehraje se stopa řešitele**, takže
 *     „hratelné" je doběhnutá výhra, ne deklarace;
 *  3. scéna se **postaví z kitu a změří** (`measureScene`), takže `sceneBuilt`
 *     je naměřený nenulový počet draw callů, ne napevno zapsané `true`;
 *  4. výsledek se předá **zmrazenému scoreru z T16** jako `Evidence`.
 *
 * Krok 4 je ten, na kterém celé měření stojí: verdikt nepočítá tenhle soubor,
 * počítá ho scorer, který vznikl dřív a o fallbacku nic neví.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildLayoutScene, measureScene } from '../src/kit';
import { layoutById } from '../src/kit/layouts';
import { runTrace } from '../src/fallback/loop';
import { routePrompt } from '../src/fallback/router';
import { sessionFor } from '../src/fallback/session';

import { loadContracts, scoreCase, type Contract, type Evidence, type Verdict } from './scorer/semantic';

export const PROTOCOL_PATH = join(process.cwd(), 'evals', 'frozen', 'protocol.v1.json');
export const PROMPTS_PATH = join(process.cwd(), 'evals', 'frozen', 'prompts.v1.jsonl');

/**
 * Zmrazené podlahy. Čtou se ze souboru pokaždé znovu — kdyby se načetly do
 * modulové konstanty, šlo by je v testu přebít a věta „P2 si je nesmí nastavit
 * sám" by přestala platit.
 */
export interface FallbackFloors {
  readonly denominator: { readonly promptSetInP1: string; readonly minDenominator: number };
  readonly minFulfilled: number;
  readonly maxNoFitShare: number;
}

export function loadFloors(): FallbackFloors {
  const protocol = JSON.parse(readFileSync(PROTOCOL_PATH, 'utf8')) as { fallbackFloors?: FallbackFloors };
  const floors = protocol.fallbackFloors;
  if (floors === undefined) throw new Error('protocol.v1.json nemá fallbackFloors — bez podlah se měření nesmí spustit');
  return floors;
}

export function loadPrompts(): ReadonlyMap<string, string> {
  const rows = readFileSync(PROMPTS_PATH, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { id: string; prompt: string });
  return new Map(rows.map((row) => [row.id, row.prompt]));
}

/**
 * Jmenovatel má dvě čtení a bere se **to přísnější**.
 *
 * `fallbackFloors.denominator.rule` popisuje podmnožinu slovy „neprázdný vektor
 * požadavků" (to je všech 15 create kontraktů), ale `promptSetInP1` ukazuje na
 * `createNonVacuous`, tedy na příznak `nonVacuous: true`, a těch je 11. Rozdíl
 * je jen ve stropu `NO_FIT`: 2 z 11 proti 3 z 15. Platí 11 a volba jde do
 * výstupu měření, ne do komentáře, aby ji šlo v reportu přečíst.
 */
export function denominatorOf(contracts: readonly Contract[]): readonly Contract[] {
  return contracts.filter((contract) => contract.kind === 'create' && contract.nonVacuous);
}

export type FallbackOutcome = 'declined' | 'fallback' | 'fault';

export interface CaseMeasurement {
  readonly id: string;
  readonly prompt: string;
  /** Co fallback udělal, než to scorer viděl. */
  readonly decision: 'archetype' | 'no_fit';
  readonly archetype: string;
  readonly sceneLayout: string;
  /** Naměřené draw cally scény z kitu. Nula = prázdná obrazovka = chyba §13.4. */
  readonly drawCalls: number;
  readonly playedToWin: boolean;
  readonly outcome: FallbackOutcome;
  readonly verdict: Verdict;
  /** Proč scorer nedal `FULFILLED`, jeho vlastními slovy. */
  readonly gates: readonly string[];
  readonly detail: string;
}

/**
 * `sceneBuilt` je naměřená veličina.
 *
 * Kdyby se sem napsalo `true`, prošel by i fallback, který nevykreslí nic — a
 * `sceneMustBuild` v kontraktech by přestal být kontrola. Scéna se proto
 * doopravdy postaví z kitu a spočítají se draw cally.
 */
export function sceneDrawCalls(layoutId: string): number {
  const layout = layoutById(layoutId);
  if (layout === undefined) return 0;
  return measureScene(buildLayoutScene(layout)).drawCalls;
}

/**
 * Jeden zmrazený prompt fallbackem od začátku do konce.
 *
 * `outcome` se **nevolí**, odvozuje se z toho, co se stalo:
 *  - router odmítl → `declined`, což je ve slovníku scoreru `NO_FIT`;
 *  - archetyp doběhl do výhry → `fallback`, tedy „použitelný výsledek, ale ne
 *    splněný kontrakt". Fallback nemá WorldDoc, takže výš než `ROBUST` se
 *    dostat nemůže a tvrdit opak by znamenalo podstrčit scoreru dokument, který
 *    fallback nikdy nevyrobil;
 *  - archetyp nedoběhl nebo scéna je prázdná → `fault`.
 */
export function measureCase(contract: Contract, prompt: string): CaseMeasurement {
  const decision = routePrompt(prompt);
  const drawCalls = sceneDrawCalls(decision.sceneLayout);

  if (decision.kind === 'no_fit') {
    const evidence: Evidence = { kind: 'create', outcome: 'declined', sceneBuilt: drawCalls > 0 };
    const score = scoreCase(contract, evidence);
    return {
      id: contract.id,
      prompt,
      decision: 'no_fit',
      archetype: decision.nearest,
      sceneLayout: decision.sceneLayout,
      drawCalls,
      playedToWin: false,
      outcome: 'declined',
      verdict: score.verdict,
      gates: score.gates,
      detail: decision.reason,
    };
  }

  const session = sessionFor(decision, prompt);
  const played = session.solution === null ? null : runTrace(session.game, session.seed, session.solution);
  const playedToWin = played !== null && played.view.phase === 'won';
  const outcome: FallbackOutcome = playedToWin && drawCalls > 0 ? 'fallback' : 'fault';
  const detail =
    outcome === 'fault'
      ? session.solution === null
        ? 'řešitel archetypu nenašel vítěznou stopu'
        : drawCalls === 0
          ? `scéna ${decision.sceneLayout} se nepostavila`
          : `stopa řešitele skončila ve fázi ${played?.view.phase}`
      : `${decision.archetype}, n-tice ${session.tupleIndex}, výhra v ${played?.ticks} ticích`;

  const evidence: Evidence = { kind: 'create', outcome, sceneBuilt: drawCalls > 0, detail };
  const score = scoreCase(contract, evidence);

  return {
    id: contract.id,
    prompt,
    decision: 'archetype',
    archetype: decision.archetype,
    sceneLayout: decision.sceneLayout,
    drawCalls,
    playedToWin,
    outcome,
    verdict: score.verdict,
    gates: score.gates,
    detail,
  };
}

export interface EfficacyReport {
  readonly promptSet: string;
  readonly denominator: number;
  readonly cases: readonly CaseMeasurement[];
  readonly fulfilled: number;
  readonly robust: number;
  readonly noFit: number;
  readonly fault: number;
  readonly noFitShare: number;
  readonly floors: FallbackFloors;
  readonly passes: { readonly denominator: boolean; readonly minFulfilled: boolean; readonly maxNoFitShare: boolean };
  readonly passed: boolean;
}

export function measureEfficacy(): EfficacyReport {
  const floors = loadFloors();
  const prompts = loadPrompts();
  const denominator = denominatorOf(loadContracts());

  const cases = denominator.map((contract) => {
    const prompt = prompts.get(contract.id);
    if (prompt === undefined) throw new Error(`zmrazený kontrakt ${contract.id} nemá prompt v prompts.v1.jsonl`);
    return measureCase(contract, prompt);
  });

  const count = (verdict: Verdict): number => cases.filter((entry) => entry.verdict === verdict).length;
  const fulfilled = count('FULFILLED');
  const noFit = count('NO_FIT');
  const noFitShare = cases.length === 0 ? 1 : noFit / cases.length;

  const passes = {
    denominator: cases.length >= floors.denominator.minDenominator,
    minFulfilled: fulfilled >= floors.minFulfilled,
    maxNoFitShare: noFitShare <= floors.maxNoFitShare,
  };

  return {
    promptSet: floors.denominator.promptSetInP1,
    denominator: cases.length,
    cases,
    fulfilled,
    robust: count('ROBUST'),
    noFit,
    fault: count('FAULT'),
    noFitShare,
    floors,
    passes,
    passed: passes.denominator && passes.minFulfilled && passes.maxNoFitShare,
  };
}
