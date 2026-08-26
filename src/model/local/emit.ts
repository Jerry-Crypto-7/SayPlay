/**
 * Emise v prohlížeči — věta dovnitř, certifikovaný verdikt ven.
 *
 * ## Tentýž verdikt jako ze serveru, ne jeho obdoba
 *
 * Souzení dělá `../certify.ts`, tedy **týž kód**, který stojí za `POST
 * /api/emit`. Prohlížeč proto nemůže přijmout svět, který by server odmítl:
 * není kde se rozejít. Vlastní je tu jen zdroj emise — místo zaznamenané
 * odpovědi ze zmrazeného korpusu ji píše model běžící na WebGPU.
 *
 * ## Rozpoznávač vět je před modelem, ne za ním
 *
 * `recognize` je deterministická cesta z T7. Když větu pozná, model se
 * **nespustí vůbec** — je to rychlejší, levnější a hlavně to nezávisí na tom,
 * jestli model zrovna udrží tvar. Naměřená hodnota `schemaValid` z T5 říká, že
 * se na model spolehnout nedá (`evals/local-model/decision.md`), takže tohle
 * pořadí není optimalizace, ale hlavní cesta.
 *
 * ## Gramatika se bere ze zmrazeného protokolu
 *
 * Slovník událostí, podmínek a akcí čte server z `evals/frozen/protocol.v1.json`.
 * Prohlížeč si ho nemůže přečíst z disku, ale opsat ho do konstanty by znamenalo
 * druhý slovník, který se s tím prvním rozejde — a model by pak dostal jiná
 * pravidla, než jakými se jeho odpověď soudí. Soubor se proto importuje a
 * vytáhne se z něj totéž, co vytahuje `frozenGrammar()`.
 */

import protocol from '../../../evals/frozen/protocol.v1.json';
import { certifySteps, type ProgressSink, type Rejection, type Verdict } from '../certify';
import { buildEmissionRequest, isExampleEmission, type Grammar, type UpstreamRequest } from '../prompt';
import { repairEmission } from '../repair';

import { deriveCollisionAabb, isRecord } from './aabb';
import { contextFromEmission, retryRequest, retrySystem } from './rejection-prompt';
import { recognize as recognizeShape } from './shapes';

import type { ChatEngine } from './engine';

export type { Verdict } from '../certify';

/**
 * Výsledek prohlížečové emise.
 *
 * Má tytéž dvě větve jako serverová cesta (`EmissionOutcome` v
 * `src/app/api/emit/chain.ts`) a **sdílí s ní `Verdict`**: rozbité prostředí
 * není verdikt o světě a nesmí se do něj počítat.
 */
export type LocalOutcome =
  /** Model se nespustil nebo spadl. O takovém běhu se nesmí nic skórovat. */
  | ({ readonly kind: 'unavailable'; readonly detail: string } & Rounds)
  | (Verdict & Rounds);

/**
 * Jedno kolo opravné smyčky. Nese verdikt kola a jeho cenu v milisekundách,
 * protože obojí jde porotci na obrazovku (T5) a do měření (T4).
 */
export interface Round {
  /** 1 pro první pokus. Kola se počítají od jedničky, ne od nuly. */
  readonly attempt: number;
  /** `null` znamená, že tohle kolo prošlo. Je nanejvýš jedno takové a je poslední. */
  readonly rejection: Rejection | null;
  readonly ms: number;
}

interface Rounds {
  /** Vždy aspoň jedno kolo — i rozpoznaná věta je kolo, jen se v něm nespustí model. */
  readonly rounds: readonly Round[];
}

/**
 * Strop kol. **Pevný, ne konfigurovatelný.**
 *
 * Tři je kompromis mezi „model tu vadu opraví" a „porotce čeká". Naměřeno na
 * zmrazených 200 větách (`evals/corpus-report.json`): jedna emise má medián
 * 33 715 ms, p90 35 906 ms a maximum 54 175 ms, takže tři kola stojí v nejhorším
 * případě přes dvě a půl minuty. Čtvrté by tu cenu zvedlo o třetinu za čím dál
 * menší šanci — model, který vadu neopravil dvakrát, ji obvykle neopraví ani
 * potřetí, a od toho je zastavení na nepohnutém odmítnutí níž.
 */
export const MAX_ROUNDS = 3;

/**
 * Rozpočet celého řetězu, ne jednoho kola.
 *
 * ⚠ **Plán vlny 2 tu psal 20 000 ms a to číslo je vyvrácené měřením.** Při
 * mediánu 33 715 ms na jednu emisi by rozpočet 20 s neuzavřel ani první kolo,
 * takže smyčka by nikdy neproběhla a AC T3 by se nedalo splnit žádnou
 * implementací. 150 000 ms pokrývá tři kola i na p90 (3 × 35,9 s ≈ 108 s) s
 * rezervou a zastaví jen řetěz, který se zasekl.
 *
 * Kontroluje se **před začátkem** dalšího kola, ne uprostřed: rozběhnutou emisi
 * na GPU nejde přerušit, a přerušit ji na půl cesty by zahodilo práci, která už
 * je zaplacená.
 */
export const ROUND_BUDGET_MS = 150_000;

/** Slovník ze zmrazeného protokolu, týž, jaký vydává `frozenGrammar()` na serveru. */
export function localGrammar(): Grammar {
  return {
    surfaceEvents: protocol.grammar.surfaceEvents,
    conditions: protocol.grammar.conditions,
    actions: protocol.grammar.actions,
    simFields: protocol.worldDoc.sim.fields,
    lookFields: protocol.worldDoc.look.fields,
  };
}

/**
 * Deterministický rozpoznávač tvarů vět (T7). Vrátí tělo emise, nebo `null`,
 * když větu nezná — `null` není chyba, je to předání slova modelu.
 */
export type Recognizer = (sentence: string) => unknown | null;

export interface LocalEmitInput {
  readonly sentence: string;
  readonly engine: ChatEngine;
  /**
   * Rozpoznávač. Výchozí je ten z `./shapes` — tak to podle `decision.md` jede
   * v produkci. Test, který chce cestu přes model, musí předat `() => null`,
   * aby nezáležel na tom, jestli zrovna některý tvar na jeho větu sedne.
   */
  readonly recognize?: Recognizer;
  readonly onProgress?: ProgressSink;
  /**
   * Hodiny pro měření kol. Výchozí `Date.now`. **Není to replay cesta** —
   * emise běží na wall-clocku a `ms` v kole je zpráva pro člověka, ne vstup do
   * hashe. Injektuje se, aby test smyčky nezávisel na tom, jak rychle běží.
   */
  readonly now?: () => number;
}

/**
 * Prožene větu celou cestou: rozpoznávač nebo model, pak certifikace.
 *
 * `promptId` verdiktu nese samotnou větu. Serverová cesta sem dává id
 * zmrazeného promptu, protože jiné nemá; tady je věta to jediné, čím se vstup
 * dá pojmenovat, a ve stopě je pak vidět, co porotce napsal.
 */
export async function emitLocally(input: LocalEmitInput): Promise<LocalOutcome> {
  // `buildEmissionRequest()` píše do požadavku serverový model (`EMISSION_MODEL`),
  // protože ho psal server. Tady se prohodí za váhy, které doopravdy odpovídaly —
  // jinak by verdikt připsal svět modelu, který se ho ani nedotkl.
  const upstream = { ...buildEmissionRequest(input.sentence, localGrammar()), model: input.engine.modelId };
  const clock = input.now ?? Date.now;

  // Rozpoznaná věta se neopakuje. Rozpoznávač je deterministický: druhé kolo by
  // vrátilo bajt po bajtu totéž a jen spálilo čas.
  const recognized = (input.recognize ?? recognizeShape)(input.sentence);
  if (recognized !== null) {
    const startedAt = clock();
    const verdict = certifyOnce(input, upstream, recognized, { source: 'shapes' });
    return { ...verdict, rounds: [round(1, verdict, clock() - startedAt)] };
  }

  const rounds: Round[] = [];
  const chainStartedAt = clock();
  let previous: unknown = null;
  let last: Verdict | null = null;

  for (let attempt = 1; attempt <= MAX_ROUNDS; attempt += 1) {
    const startedAt = clock();

    // Kolo 1 dostane holý požadavek, další kola k němu přiloží vlastní vadu a
    // předchozí odpověď. Gramatika se mezi koly **nemění** — je to totéž, čím
    // se emise soudí. Mizí jedině ukázka syntaxe, a to z naměřeného důvodu:
    // předchozí emise a ukázka se do okna 4 096 tokenů nevejdou obě a odpověď
    // se pak usekne (`retrySystem()` v `./rejection-prompt.ts`).
    const repairing = attempt > 1 && last !== null && last.body.rejection !== null;
    const system = repairing ? retrySystem(upstream.system) : upstream.system;
    const user = repairing
      ? retryRequest(input.sentence, previous, last!.body.rejection!, contextFromEmission(previous))
      : upstream.user;

    let completion;
    try {
      completion = await input.engine.complete(system, user);
    } catch (thrown) {
      // Rozbité prostředí není verdikt o světě. Kola, která už proběhla, se
      // ale nezahazují — porotce má právo vidět, kam se to dostalo.
      const message = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
      return { kind: 'unavailable', detail: message, rounds };
    }

    let body: unknown;
    try {
      body = JSON.parse(stripThinking(completion.raw));
    } catch {
      // Nerozpársovatelná odpověď **je** verdikt o emisi, ne rozbité prostředí:
      // model odpověděl, jen ne JSONem. Certifikace ho odmítne jako `NOT_A_DOCUMENT`.
      body = completion.raw;
    }

    const provenance = { source: 'model', model: upstream.model, finishReason: completion.finishReason };
    // Verdikt nese požadavek **toho kola**, ne prvního. Vlna 0 zakazuje tvrdit
    // o modelu něco, co nedostal, a od opravného kola se obojí liší.
    const verdict = certifyOnce(input, { ...upstream, system, user }, body, provenance);
    rounds.push(round(attempt, verdict, clock() - startedAt));

    if (verdict.body.rejection === null) return { ...verdict, rounds };

    // Nepohnuté odmítnutí: táž fáze a týž seznam vad znamená, že model tuhle
    // vadu opravit neumí. Další kolo by stálo dalších ~34 s za nic.
    if (last !== null && sameFault(last.body.rejection, verdict.body.rejection)) return { ...verdict, rounds };

    previous = body;
    last = verdict;

    // Rozpočet se čte PŘED dalším kolem — rozběhnutou emisi na GPU nejde
    // přerušit a přerušit ji uprostřed by zahodilo práci, která už je zaplacená.
    if (clock() - chainStartedAt >= ROUND_BUDGET_MS) return { ...verdict, rounds };
  }

  // Strop došel. `last` tu nemůže být `null`: smyčka proběhla aspoň jednou a
  // každý průchod ho nastaví, nebo se z ní vrátí dřív.
  return { ...(last as Verdict), rounds };
}

/** Dvě odmítnutí, mezi kterými se nic nepohnulo. */
function sameFault(before: Rejection | null, after: Rejection): boolean {
  if (before === null) return false;
  return (
    before.stage === after.stage &&
    before.reason === after.reason &&
    before.issues.length === after.issues.length &&
    before.issues.every((issue, at) => issue === after.issues[at])
  );
}

function round(attempt: number, verdict: Verdict, ms: number): Round {
  return { attempt, rejection: verdict.body.rejection, ms };
}

/**
 * Jedna emise skrz opravu a certifikaci. Je to **tělo jednoho kola**, ne celá
 * cesta: smyčka nad ním je v `emitLocally()`.
 */
function certifyOnce(
  input: LocalEmitInput,
  upstream: UpstreamRequest & { readonly model: string },
  emitted: unknown,
  provenance: Record<string, unknown>,
): Verdict {
  let body = emitted;

  // Zúžení strážcem, ne přetypováním. Přetypování tvrdí tvar, který nikdo
  // neověřil — a nad odpovědí modelu to tvrzení neplatí.
  if (isRecord(body) && isRecord(body.sim)) {
    const sim = deriveCollisionAabb(body.sim);
    if (sim !== body.sim) body = { ...body, sim };
  }

  // Doslovná ukázka je výukový tah, ne odpověď na novou větu. První ruční HALT
  // ji po opravě renderu dostal dvakrát (podruhé i s výslovným zákazem kopie),
  // zatímco sdílený certifikátor poctivě ověřil jen její tvar a dohratelnost.
  // Lokální hranice proto kopii zastaví ještě před certifikací a zachová ji ve
  // verdiktu jako auditovatelnou emisi; zmrazené protokoly se tím nemění.
  //
  // Od vlny 2 je to odmítnutí jako každé jiné, takže dostane další kolo —
  // „opsal jsi ukázku" je vada, kterou model umí opravit, když se mu to řekne.
  if (provenance.source === 'model' && isExampleEmission(body)) {
    input.onProgress?.('emitted');
    return {
      kind: 'verdict',
      body: {
        promptId: input.sentence,
        upstream,
        provenance,
        annotations: {},
        emission: body,
        outcome: 'REJECTED',
        certificate: null,
        rejection: {
          stage: 'request',
          reason: 'EXAMPLE_COPY',
          detail: 'the model copied the syntax example instead of answering the request',
          issues: [],
          atStep: null,
        },
        doc: null,
      },
    };
  }

  // Oprava stojí PŘED certifikací a certifikátor se jí nedotýká — soudí dál
  // týž kód, jaký soudí server. Smí jen zásahy, které nemění význam; co dělá a
  // proč, je v `../repair.ts`.
  const repaired = repairEmission(body);

  const steps = certifySteps({ promptId: input.sentence, upstream, provenance, body: repaired.document });
  let next = steps.next();
  while (!next.done) {
    input.onProgress?.(next.value);
    next = steps.next();
  }

  // Emise ve verdiktu je to, co doopravdy poslal model. Opravený dokument běží
  // na plátně, ale tvrdit o něm, že ho napsal model, by byla vada vlny 0.
  return {
    kind: 'verdict',
    body: { ...next.value.body, emission: body, repairedEmission: repaired.document, repairs: repaired.notes },
  };
}

/**
 * Qwen3 umí odpověď uvést blokem `<think>`. Šablona ho vkládá i tam, kde je
 * prázdný, takže by `JSON.parse` spadl na uvozujícím textu a emise, která tvar
 * udržela, by se odmítla. Blok se proto odřízne, a jen on — cokoli jiného před
 * `{` je skutečná vada odpovědi a nechá se být.
 */
export function stripThinking(raw: string): string {
  return raw.replace(/^\s*<think>[\s\S]*?<\/think>/, '').trim();
}
