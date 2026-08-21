/**
 * Nepřátelská věta a nikdy prázdná scéna (P11 T20).
 *
 * ## Co se měří
 *
 * Celá nepřátelská podmnožina zmrazené sady — koše `contradictory`, `nonsense`
 * a `other_language`, dohromady 70 vět — se protáhne **produkční zárukou světa**
 * (`src/game/guarantee.ts`) a zapíše se, co z každé věty vzniklo. Sledují se tři
 * poruchy, které AC T20 zakazuje mít nenulové:
 *
 *   1. **prázdná scéna** — svět bez jediné entity, nebo žádný svět;
 *   2. **neošetřená výjimka** — cokoli, co ze záruky vyletí ven;
 *   3. **čekání nad 20 s** — věta, kterou systém nestihne obsloužit.
 *
 * ## Podmnožina se odvozuje, nepíše podruhé
 *
 * Koše se berou z `corpus-v3/lock.mjs` (`HOSTILE_BUCKETS`), který je zároveň
 * zamyká. Vypsat sem sedmdesát id ručně by znamenalo dvě čísla o téže věci, a
 * ta se rozejdou — v `CLAUDE.md` je to naměřený případ, ne obava.
 *
 * ## Zámek korpusu se tu NEkontroluje
 *
 * Nedrží se to zpátky z lenosti: kontrolu, kterou tenhle soubor umí provést,
 * neumí nikdo dokázat. Vrácené prázdné pole a napevno zapsané prázdné pole
 * vypadají zvenčí stejně, takže by aserce nad ním byla dekorace — mutace, která
 * ho nahradí konstantou, přežije. Že se korpus od zamčení nehnul, dokazuje
 * `evals/__tests__/corpus-v3-frozen.test.ts` tím, že ho vědomě rozbije a čeká
 * červenou, a report s hashem manifestu si předepisuje AC T21. Druhá, nedokázaná
 * kopie téhož tvrzení by na tomhle místě jen ubírala na váze té dokázané.
 *
 * ## Co je „prázdná scéna"
 *
 * Počet entit **postaveného** světa, ne délka pole v JSONu. Emise, kterou
 * `buildRuntimeWorld` odmítne, by na plátně skončila prázdnem, i kdyby v ní
 * entit stálo deset — proto se scéna počítá až za snížením.
 *
 * ## `winnable` je odečet, ne brána
 *
 * Vedle poruch se u každého světa spustí `verifyWitness` nad jeho vlastní
 * stopou. AC T20 dohratelnost nežádá a tenhle skript ji proto nevynucuje;
 * je tu jako číslo do reportu, aby se nedalo tvrdit „scéna není prázdná" o
 * místnosti, ve které se nedá dojít do konce. Kdyby to byla brána, T21 by
 * měřilo přes ni místo přes korpus.
 *
 * Spuštění: `npm run measure:hostile`
 */

import { guaranteeWorld } from '../src/game/guarantee';
import { verifyWitness } from '../src/verify/witness';

import { HOSTILE_BUCKETS, readCorpus, type Prompt } from './corpus-v3/lock.mjs';

export const REPORT_PATH = 'evals/hostile-report.json';

/** Strop čekání na jednu větu. Číslo je z AC T20. */
export const WAIT_BUDGET_MS = 20_000;

export interface HostileCase {
  readonly id: string;
  readonly bucket: string;
  readonly text: string;
  /** Odkud svět přišel; `null` znamená, že záruka vyhodila výjimku. */
  readonly kind: 'shape' | 'seed' | null;
  readonly shapeId: string | null;
  /** Proč z věty svět nevznikl. `null` u rozpoznaného tvaru. */
  readonly fault: string | null;
  readonly entities: number;
  readonly emptyScene: boolean;
  /** Došla vlastní stopa světa do výhry? Odečet, ne podmínka. */
  readonly winnable: boolean;
  /** Text výjimky, která vyletěla ze záruky. `null`, když nic nevyletělo. */
  readonly threw: string | null;
  readonly ms: number;
  readonly overBudget: boolean;
}

export interface Violations {
  readonly emptyScene: readonly string[];
  readonly threw: readonly string[];
  readonly overBudget: readonly string[];
}

export interface HostileReport {
  readonly source: string;
  readonly buckets: readonly string[];
  readonly waitBudgetMs: number;
  readonly total: number;
  /** Kolik vět obsloužil rozpoznaný tvar a kolik náhradní místnost. */
  readonly byOrigin: Readonly<Record<'shape' | 'seed' | 'threw', number>>;
  readonly byBucket: Readonly<Record<string, { readonly shape: number; readonly seed: number }>>;
  /** Histogram vad, kvůli kterým se sáhlo po náhradní místnosti. */
  readonly faults: Readonly<Record<string, number>>;
  readonly winnable: number;
  readonly slowestMs: number;
  readonly violations: Violations;
  readonly cases: readonly HostileCase[];
}

/** Nepřátelské věty zmrazené sady, v pořadí, ve kterém v korpusu stojí. */
export function hostilePrompts(): readonly Prompt[] {
  return readCorpus().prompts.filter((prompt) => HOSTILE_BUCKETS.includes(prompt.bucket));
}

function measureOne(prompt: Prompt): HostileCase {
  const base = { id: prompt.id, bucket: prompt.bucket, text: prompt.text };
  const started = performance.now();

  try {
    const guaranteed = guaranteeWorld(prompt.text);
    const ms = performance.now() - started;
    const entities = guaranteed.world.ir.entities.length;
    const certified = verifyWitness(guaranteed.world, guaranteed.world.trace);

    return {
      ...base,
      kind: guaranteed.kind,
      shapeId: guaranteed.shapeId,
      fault: guaranteed.fault,
      entities,
      emptyScene: entities === 0,
      winnable: certified.verdict === 'CERTIFIED',
      threw: null,
      ms,
      overBudget: ms > WAIT_BUDGET_MS,
    };
  } catch (thrown) {
    // Výjimka **je** naměřený výsledek, ne pád měření: kdyby ji tenhle blok
    // nechal proletět, běh by skončil na první vadné větě a o zbylých by report
    // neřekl nic. Zákaz z AC drží běžec nad hotovým reportem.
    const ms = performance.now() - started;
    return {
      ...base,
      kind: null,
      shapeId: null,
      fault: null,
      entities: 0,
      emptyScene: true,
      winnable: false,
      threw: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
      ms,
      overBudget: ms > WAIT_BUDGET_MS,
    };
  }
}

/**
 * Tři zakázané poruchy, každá jako seznam id.
 *
 * Je to samostatná funkce, aby šla zkusit nad vymyšleným případem — brána,
 * která umí selhat jen nad skutečným během, se nedá dokázat, že kouše.
 */
export function violationsOf(cases: readonly HostileCase[]): Violations {
  const idsWhere = (holds: (entry: HostileCase) => boolean): readonly string[] =>
    cases.filter(holds).map((entry) => entry.id);

  return {
    emptyScene: idsWhere((entry) => entry.emptyScene),
    threw: idsWhere((entry) => entry.threw !== null),
    overBudget: idsWhere((entry) => entry.overBudget),
  };
}

function histogram(keys: readonly string[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const key of keys) tally[key] = (tally[key] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(tally).sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1])),
  );
}

export function measureHostile(): HostileReport {
  const prompts = hostilePrompts();
  const cases = prompts.map(measureOne);

  const byBucket: Record<string, { shape: number; seed: number }> = {};
  for (const bucket of HOSTILE_BUCKETS) byBucket[bucket] = { shape: 0, seed: 0 };
  for (const entry of cases) {
    if (entry.kind !== null) byBucket[entry.bucket][entry.kind] += 1;
  }

  const count = (kind: HostileCase['kind']): number => cases.filter((entry) => entry.kind === kind).length;

  return {
    source: 'evals/corpus-v3/prompts.json',
    buckets: [...HOSTILE_BUCKETS],
    waitBudgetMs: WAIT_BUDGET_MS,
    total: cases.length,
    byOrigin: { shape: count('shape'), seed: count('seed'), threw: count(null) },
    byBucket,
    faults: histogram(cases.map((entry) => entry.fault).filter((fault): fault is string => fault !== null)),
    winnable: cases.filter((entry) => entry.winnable).length,
    slowestMs: cases.reduce((worst, entry) => Math.max(worst, entry.ms), 0),
    violations: violationsOf(cases),
    cases,
  };
}
