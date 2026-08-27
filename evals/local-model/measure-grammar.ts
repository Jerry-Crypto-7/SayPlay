/**
 * Měření: udrží malý model běžící v prohlížeči **vynucený tvar výstupu**?
 *
 * Tohle je vstup pro rozhodnutí v T6, ne produkční cesta. Odpovídá na jednu
 * otázku, kterou nejde uhodnout: když se dekódování sváže gramatikou na tvar
 * emise, kolik z toho, co Qwen3-1.7B napíše, **projde produkčním validátorem** —
 * a nespadne přitom celý běh.
 *
 * ## Proč se soudí produkčním schématem, a ne opisem
 *
 * `classifyOutput()` volá `worldEmissionSchema` a `declinedEmissionSchema`
 * z `src/ir/worlddoc.ts` — tytéž, kterými emisi soudí `/api/emit`
 * (`src/app/api/emit/chain.ts:113` a `:144`). Vlastní kopie schématu v měřicím
 * skriptu by měřila shodu s kopií, ne s tím, co systém doopravdy přijme.
 *
 * ## Proč se odmítnutí počítá zvlášť
 *
 * `NO_FIT` je platný tvar emise, takže by se do `schemaValid` započítal. Model,
 * který odmítne všech čtyřicet vět, by tím dostal stoprocentní skóre — přesně ta
 * vakuózní past, kterou u fallbacku popisuje rozpor 9 v `CLAUDE.md`. Report proto
 * vede `declined` jako samostatné číslo a `fulfilled` jako počet skutečně
 * postavených světů; `decision.md` v T6 nemá kam schovat běh, který jen odmítá.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { declinedEmissionSchema, peelEnvelope, worldEmissionSchema } from '../../src/ir/worlddoc';
import { frozenGrammar } from '../../src/model/client';
import { deriveCollisionAabb } from '../../src/model/local/aabb';
import { stripThinking } from '../../src/model/local/emit';
import { recognize } from '../../src/model/local/shapes';
import { repairEmission } from '../../src/model/repair';
import {
  completionRequest,
  FORCED_SHAPE_SCHEMA,
  LARGE_MODEL,
  MAX_OUTPUT_TOKENS,
  SMALL_MODEL,
} from '../../src/model/local/engine';
import { buildEmissionRequest } from '../../src/model/prompt';

/**
 * Konstanty požadavku se **berou z produkce**, neopisují se.
 *
 * Naměřená hodnota `schemaValid` popisuje produkci jen tehdy, když měření posílá
 * týž požadavek jako ona: tentýž svázaný tvar, tentýž strop tokenů, tytéž váhy.
 * Vlastní kopie by se rozešla a číslo by pak platilo o něčem, co uživatel nikdy
 * nedostane. Zdroj je `src/model/local/engine.ts`.
 */
export { FORCED_SHAPE_SCHEMA, MAX_OUTPUT_TOKENS } from '../../src/model/local/engine';
export { stripThinking } from '../../src/model/local/emit';

/** Produkční požadavek rozšířený pouze o diagnostický rozpad latence. */
export function measurementRequest(system: string, user: string): Record<string, unknown> {
  const request = completionRequest(system, user);
  const extraBody =
    request.extra_body !== null && typeof request.extra_body === 'object' && !Array.isArray(request.extra_body)
      ? (request.extra_body as Record<string, unknown>)
      : {};
  return { ...request, extra_body: { ...extraBody, enable_latency_breakdown: true } };
}

/** Kolik vět se měří. AC úlohy T5 říká prvních 40 z `corpus-v3`. */
export const MEASURED_SENTENCES = 40;

/** Model, na kterém stojí hlavní cesta (`CLAUDE.md`, tech stack P11). */
export const PRIMARY_MODEL = LARGE_MODEL;

/**
 * Model z hlášení `mlc-ai/web-llm#807`. Měří se **jen když hlavní model spadne**,
 * a jen proto, aby se dalo napsat, jestli je ten pád tahle známá chyba, nebo něco
 * jiného. Hlášení jmenuje přesně tuhle váhu — a je to táž, na kterou padne větev
 * `small`, takže je napsaná jednou.
 */
export const REPRODUCTION_MODEL = SMALL_MODEL;

export const REPORT_PATH = join('evals', 'local-model', 'grammar-report.json');

export interface MeasuredSentence {
  readonly id: string;
  readonly text: string;
  readonly system: string;
  readonly user: string;
}

interface CorpusFile {
  readonly prompts: readonly { readonly id: string; readonly text: string }[];
}

/**
 * Prvních `limit` vět ze zmrazené sady, každá už s hotovou dvojicí zpráv.
 *
 * Prompt staví **produkční** `buildEmissionRequest()` nad slovníkem ze
 * zmrazeného protokolu. Kdyby si měření psalo prompt vlastní, výsledek by nešlo
 * srovnat se serverovou větví, protože by každá odpovídala na jinou otázku.
 */
export function loadSentences(limit: number = MEASURED_SENTENCES): MeasuredSentence[] {
  const grammar = frozenGrammar();
  if (!grammar.ok) throw new Error(`slovník ze zmrazeného protokolu se nenačetl: ${grammar.reason}`);

  const corpus = JSON.parse(readFileSync(join('evals', 'corpus-v3', 'prompts.json'), 'utf8')) as CorpusFile;
  return corpus.prompts.slice(0, limit).map((entry) => {
    const request = buildEmissionRequest(entry.text, grammar.value);
    return { id: entry.id, text: entry.text, system: request.system, user: request.user };
  });
}

export type OutcomeKind = 'fulfilled' | 'declined' | 'invalid' | 'unparsable';

export interface Outcome {
  readonly kind: OutcomeKind;
  readonly detail: string;
}

/** Kolik rozporů se vypíše jmenovitě, než se zbytek shrne do počtu. */
export const LISTED_ISSUES = 4;

/**
 * Všechny cesty, na kterých schéma selhalo — ne jen první.
 *
 * Zod sám hlásí jen důvod (`expected nonoptional, received undefined`), a ten je
 * u čtyřiceti vět čtyřicetkrát stejný. Bez cesty report říká, že něco chybí, a
 * zamlčuje co — což je přesně ta otázka, na kterou se T6 ptá.
 *
 * A jen první cesta nestačí: `issues[0]` z chybějícího celého dokumentu vybere
 * jedno pole a devět dalších zamlčí, takže report vypadá, jako by emisi scházel
 * jediný detail. Proto se vypisuje seznam a počet.
 */
function describeIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  const byPath = new Map<string, string>();
  for (const issue of issues) {
    const path = issue.path.map(String).join('.');
    if (!byPath.has(path)) byPath.set(path, path ? `${path}: ${issue.message}` : issue.message);
  }
  if (byPath.size === 0) return 'neznámý rozpor se schématem';

  const listed = [...byPath.values()].slice(0, LISTED_ISSUES);
  const rest = byPath.size - listed.length;
  const tail = rest > 0 ? ` (+${rest} dalších)` : '';
  return `${byPath.size}× rozpor — ${listed.join('; ')}${tail}`;
}

/** Přijal by produkční validátor tohle jako emisi? */
export function classifyOutput(raw: string): Outcome {
  let body: unknown;
  try {
    body = JSON.parse(stripThinking(raw));
  } catch (thrown) {
    return { kind: 'unparsable', detail: (thrown as Error).message };
  }

  const peeled = peelEnvelope(body);
  if (!peeled) return { kind: 'invalid', detail: 'tělo emise není JSON objekt' };

  const rawSim = peeled.document.sim;
  const document =
    rawSim !== null && typeof rawSim === 'object' && !Array.isArray(rawSim)
      ? { ...peeled.document, sim: deriveCollisionAabb(rawSim as Record<string, unknown>) }
      : peeled.document;

  // Táž oprava, jakou mezi odvozením AABB a certifikací volá produkční
  // `emitLocally()`. Bez ní by `schemaValid` popisovalo řetěz, který v
  // prohlížeči neběží — a od 26. 8. 2026 by ho popisovalo špatně: prompt
  // svědka modelu výslovně zakazuje, zatímco schéma emise ho vyžaduje, protože
  // ho dodává systém.
  const world = worldEmissionSchema.safeParse(repairEmission(document).document);
  if (world.success) return { kind: 'fulfilled', detail: '' };

  if (declinedEmissionSchema.safeParse(document).success) {
    return { kind: 'declined', detail: 'sim je poctivě null' };
  }

  return { kind: 'invalid', detail: describeIssues(world.error.issues) };
}

/**
 * Je tenhle pád `mlc-ai/web-llm#807`?
 *
 * Hlášení má jednu doslovnou signaturu: `GrammarMatcher` v xgrammar dostane
 * záporné id tokenu a WASM runtime se ukončí — *„Check failed: (token_id >= 0 &&
 * token_id < tokenizer_info_.GetVocabSize()) is false: Invalid token id"*.
 * Rozpoznává se **tahle věta**, ne obecné `Aborted()`: kdyby stačil obecný pád,
 * report by ohlásil reprodukci pokaždé, když dojde paměť, a tvrzení o známé
 * chybě by nic neznamenalo. Neznámé pády se zapisují doslova do `crashDetails`,
 * aby šly přečíst i tak.
 */
export function isBug807(message: string): boolean {
  return message.includes('Invalid token id') || message.includes('GetVocabSize');
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * Kam v jedné odpovědi teče čas.
 *
 * ## Na jakou otázku to je
 *
 * `latencyMs` říká, že odpověď trvala 37 sekund. Neříká, jestli je pomalý
 * **model**, nebo **kontrola, která ho svazuje** — a to jsou dvě úplně různá
 * rozhodnutí: první se řeší menším modelem, druhé se řeší tím, že se kontrola
 * zlevní nebo zruší. Bez rozpadu se to dá jen hádat, a hádalo se.
 *
 * ## Odkud čísla jsou
 *
 * Z `usage.extra`, které WebLLM vrací u každé odpovědi. Nic se tu neměří vlastní
 * stopkou: `performance.now()` kolem volání vidí jen součet, kdežto knihovna
 * měří zevnitř smyčky, token po tokenu. Rozpad po tokenech (`perTokenMs`,
 * `grammarMs`, `sampleMs`) je podmíněný `extra_body.enable_latency_breakdown`
 * v požadavku — bez něj knihovna ta pole neplní.
 *
 * ## Co která hodnota kryje, protože se to jinak snadno přečte obráceně
 *
 * `perTokenMs` je **veškerá práce mezi dvěma tokeny** — sestavení masky
 * povolených tokenů, vzorkování, přijetí tokenu — ale **ne** samotný průchod
 * modelem. Rozdíl `e2eMs - timeToFirstTokenMs - perTokenMs` je tedy zhruba to,
 * co spotřeboval model sám. Když je `perTokenMs` velký podíl `e2eMs`, je úzkým
 * hrdlem obsluha kolem modelu, ne model.
 *
 * `grammarMs` je z toho jen sestavení a nasazení masky. **Nekryje** přijetí
 * tokenu gramatikou, které padá do `perTokenMs`, takže je to spodní odhad ceny
 * vynuceného tvaru, ne její celek.
 */
export interface AttemptTiming {
  /** Tokenů v zadání. Skutečný počet od modelu, ne odhad ze znaků. */
  readonly promptTokens: number;
  /** Tokenů, které model napsal. */
  readonly completionTokens: number;
  /** Celý požadavek, od odeslání po poslední token. */
  readonly e2eMs: number;
  /** Do prvního tokenu, tedy hlavně přečtení zadání. */
  readonly timeToFirstTokenMs: number;
  /** Součet přes všechny tokeny: práce mezi tokeny, mimo průchod modelem. */
  readonly perTokenMs: number;
  /** Součet přes všechny tokeny: sestavení a nasazení masky vynuceného tvaru. */
  readonly grammarMs: number;
  /** Součet přes všechny tokeny: samotné vzorkování tokenu z logitů. */
  readonly sampleMs: number;
  /** Jednou za požadavek: sestavení kontroly tvaru. */
  readonly grammarInitMs: number;
}

/** Jeden pokus tak, jak ho vrátil prohlížeč. */
export interface AttemptRecord {
  readonly id: string;
  readonly latencyMs: number;
  readonly finishReason: string;
  readonly raw: string;
  /** Prázdný řetězec znamená, že pokus doběhl. Cokoli jiného je pád. */
  readonly error: string;
  /**
   * Rozpad latence. Chybí u pokusů, které obsloužil rozpoznávač (žádný model
   * neběžel) a u pádů (žádná odpověď nevznikla).
   */
  readonly timing?: AttemptTiming;
}

/**
 * Rozpad latence za celý běh.
 *
 * **Podíly jsou součty, ne mediány podílů.** Medián podílu odpovídá na „jak to
 * vypadalo u prostřední věty", což je jiná otázka než „kam šel čas toho běhu" —
 * a ta druhá je ta, kvůli které měření vzniklo. Součet navíc obchází past
 * v `median()`: ta u sudého počtu zaokrouhluje na celé číslo, což je u
 * milisekund neškodné a u podílu mezi 0 a 1 by to bylo zničující.
 *
 * `decodeTokensPerS` se počítá stejně — celkem napsaných tokenů děleno celkovým
 * časem psaní, ne průměr rychlostí. Průměr rychlostí by dal krátkým odpovědím
 * stejnou váhu jako dlouhým.
 */
export interface TimingSummary {
  /** Kolik pokusů rozpad neslo. Bez tohohle čísla se zbytek nedá číst. */
  readonly samples: number;
  readonly medianE2eMs: number;
  readonly medianPromptTokens: number;
  readonly medianCompletionTokens: number;
  /** Tokenů za sekundu při psaní. Tohle je číslo, kvůli kterému měření vzniklo. */
  readonly decodeTokensPerS: number;
  /** Podíl běhu strávený prací mezi tokeny místo průchodů modelem. 0 až 1. */
  readonly perTokenShare: number;
  /** Podíl běhu strávený sestavením a nasazením masky vynuceného tvaru. 0 až 1. */
  readonly grammarShare: number;
  /**
   * Podíl běhu strávený vzorkováním tokenu z logitů. 0 až 1.
   *
   * Je tu proto, že bez něj `perTokenShare` odpovídá jen půlku otázky: naměřeno
   * 25. 8. 2026, že režie mezi tokeny je 80 % běhu a vynucený tvar z toho 0,9 %,
   * takže zbývalo 79 % bez jména. Vzorkování je jediný další velký kandidát —
   * WebLLM stahuje logity celého slovníku z GPU do paměti procesoru a čeká na
   * synchronizaci, a to jednou za každý napsaný token.
   */
  readonly sampleShare: number;
}

export interface RunSummary {
  readonly model: string;
  readonly attempts: number;
  readonly fulfilled: number;
  readonly declined: number;
  readonly invalid: number;
  readonly unparsable: number;
  readonly truncated: number;
  readonly crashes: number;
  readonly schemaValid: number;
  readonly medianLatencyMs: number;
  /** Kam v tom čase teklo. `samples: 0` znamená, že rozpad nedorazil. */
  readonly timing: TimingSummary;
  /** Kolik pokusů obsloužil rozpoznávač z T7 místo modelu. */
  readonly shapesHandled: number;
  readonly bug807: boolean;
  readonly crashDetails: readonly string[];
  readonly perSentence: readonly {
    readonly id: string;
    readonly kind: OutcomeKind | 'crash';
    readonly detail: string;
    /** Začátek syrové odpovědi. U pádu prázdný — žádná odpověď nevznikla. */
    readonly rawExcerpt: string;
  }[];
}

/**
 * Kolik znaků syrové odpovědi si report nechá.
 *
 * Dost na to, aby bylo vidět, jak model začíná a kde se láme, a málo na to, aby
 * jedna zacyklená odpověď (strop je 1400 tokenů) nafoukla report na megabajty.
 */
export const RAW_EXCERPT_LIMIT = 600;

/**
 * Začátek toho, co model **doopravdy napsal** — včetně případného bloku `<think>`.
 *
 * Neoříznává se tu nic kromě délky: kdyby report ukazoval až uklizený text, nešlo
 * by z něj poznat, že model před JSON přidal ještě něco vlastního.
 */
export function rawExcerpt(raw: string): string {
  return raw.length <= RAW_EXCERPT_LIMIT ? raw : `${raw.slice(0, RAW_EXCERPT_LIMIT)}`;
}

export const RAW_ARCHIVE_PATH = join('evals', 'local-model', 'grammar-raw.json');

export interface RawArchive {
  readonly measuredAt: string;
  readonly runs: readonly {
    readonly model: string;
    readonly outputs: readonly {
      readonly id: string;
      readonly raw: string;
      /**
       * Rozpad latence té jedné odpovědi. Do archivu patří ze stejného důvodu
       * jako syrový text: souhrn odpovídá na otázku, která se kladla při psaní
       * skriptu, a každá další otázka nad týmž během by jinak stála dalších
       * třináct minut na GPU. Naměřeno, že stojí — 25. 8. 2026 chyběl v archivu
       * podíl vzorkování a musel se kvůli němu pustit celý běh znovu.
       */
      readonly timing?: AttemptTiming;
    }[];
  }[];
}

/**
 * Syrové odpovědi celé, vedle reportu.
 *
 * Běh trvá půl hodiny na skutečném GPU, takže každá otázka, na kterou report
 * neodpovídá, jinak stojí další půlhodinu. Ukázka v reportu je oříznutá schválně
 * (`RAW_EXCERPT_LIMIT`); archiv drží text celý, aby se dala klasifikace přepočítat
 * offline. Pád se do něj nezapisuje — žádná odpověď nevznikla.
 */
export function buildRawArchive(
  measuredAt: string,
  runs: readonly { readonly model: string; readonly records: readonly AttemptRecord[] }[],
): RawArchive {
  return {
    measuredAt,
    runs: runs.map((run) => ({
      model: run.model,
      outputs: run.records
        .filter((record) => !record.error)
        .map((record) => ({ id: record.id, raw: record.raw, timing: record.timing })),
    })),
  };
}

/**
 * Značka v `finishReason` pro pokus, který obsloužil rozpoznávač.
 *
 * Je to `finishReason`, a ne další pole záznamu, schválně: záznam je tvar, který
 * přichází z prohlížeče, a přidat do něj pole, které prohlížeč nikdy nevyplní,
 * by bylo pozvání k tomu ho někde tiše minout. Report ho pak vede jako
 * `shapesHandled`, takže z čísla `schemaValid` je vždycky vidět, kolik z něj je
 * rozpoznávač a kolik model.
 */
export const SHAPES_MARKER = 'shapes';

/**
 * Rozdělí věty na ty, které obslouží rozpoznávač, a na zbytek pro model.
 *
 * Tohle je **produkční pořadí** (`src/model/local/emit.ts`: rozpoznávač první),
 * takže report měří to, co uživatel dostane. Kdyby se měřil jen model, měřila by
 * se cesta, kterou produkt nepoužívá.
 */
export function splitByRecognizer(sentences: readonly MeasuredSentence[]): {
  readonly handled: AttemptRecord[];
  readonly forModel: MeasuredSentence[];
} {
  const handled: AttemptRecord[] = [];
  const forModel: MeasuredSentence[] = [];
  for (const sentence of sentences) {
    const world = recognize(sentence.text);
    if (world === null) forModel.push(sentence);
    else
      handled.push({
        id: sentence.id,
        latencyMs: 0,
        finishReason: SHAPES_MARKER,
        raw: JSON.stringify(world),
        error: '',
      });
  }
  return { handled, forModel };
}

/** Sloučí obě poloviny běhu zpátky do pořadí korpusu. */
export function mergeRecords(
  sentences: readonly MeasuredSentence[],
  records: readonly AttemptRecord[],
): AttemptRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  return sentences.map((sentence) => byId.get(sentence.id)).filter((record): record is AttemptRecord => record !== undefined);
}

/** Podíl na tři desetinná místa. Nula ve jmenovateli je odpověď, ne pád. */
function share(part: number, whole: number): number {
  return whole === 0 ? 0 : Number((part / whole).toFixed(3));
}

/**
 * Sečte rozpady latence do jednoho obrázku o běhu.
 *
 * Pokusy bez rozpadu (rozpoznávač, pády) se **vynechají celé**, ne že by se
 * započetly jako nula: nula sekund u věty, kterou model nikdy neviděl, by
 * stáhla každý podíl dolů a tvrdila by, že je režie menší, než je.
 */
export function summarizeTiming(records: readonly AttemptRecord[]): TimingSummary {
  const timings = records
    .map((record) => record.timing)
    .filter((timing): timing is AttemptTiming => timing !== undefined);

  const total = (pick: (timing: AttemptTiming) => number): number =>
    timings.reduce((sum, timing) => sum + pick(timing), 0);

  const e2eMs = total((timing) => timing.e2eMs);
  // Čas psaní je celý požadavek bez čekání na první token. Ten první token nese
  // přečtení zadání, které s rychlostí psaní nemá co dělat.
  const decodeMs = e2eMs - total((timing) => timing.timeToFirstTokenMs);
  const completionTokens = total((timing) => timing.completionTokens);

  return {
    samples: timings.length,
    medianE2eMs: median(timings.map((timing) => timing.e2eMs)),
    medianPromptTokens: median(timings.map((timing) => timing.promptTokens)),
    medianCompletionTokens: median(timings.map((timing) => timing.completionTokens)),
    decodeTokensPerS: decodeMs <= 0 ? 0 : Number((completionTokens / (decodeMs / 1000)).toFixed(1)),
    perTokenShare: share(total((timing) => timing.perTokenMs), e2eMs),
    grammarShare: share(total((timing) => timing.grammarMs), e2eMs),
    sampleShare: share(total((timing) => timing.sampleMs), e2eMs),
  };
}

export function summarize(model: string, records: readonly AttemptRecord[]): RunSummary {
  const counts: Record<OutcomeKind, number> = { fulfilled: 0, declined: 0, invalid: 0, unparsable: 0 };
  const crashDetails: string[] = [];
  const perSentence: { id: string; kind: OutcomeKind | 'crash'; detail: string; rawExcerpt: string }[] = [];
  const latencies: number[] = [];
  let truncated = 0;

  for (const record of records) {
    if (record.error) {
      crashDetails.push(`${record.id}: ${record.error}`);
      perSentence.push({ id: record.id, kind: 'crash', detail: record.error, rawExcerpt: '' });
      continue;
    }
    // Latence rozpoznávače se do mediánu nepočítá. Je nulová, takže by ho
    // stáhla dolů a číslo by přestalo být srovnatelné s během bez rozpoznávače —
    // a přitom právě to srovnání je v AC T7.
    if (record.finishReason !== SHAPES_MARKER) latencies.push(record.latencyMs);
    if (record.finishReason === 'length') truncated += 1;
    const outcome = classifyOutput(record.raw);
    counts[outcome.kind] += 1;
    perSentence.push({ id: record.id, kind: outcome.kind, detail: outcome.detail, rawExcerpt: rawExcerpt(record.raw) });
  }

  const attempts = records.length;
  // Odmítnutí je platný tvar, takže se do `schemaValid` počítá — a `declined`
  // vedle toho říká, kolik jich bylo, aby se za tím číslem nedal schovat běh,
  // který jen odmítá.
  const accepted = counts.fulfilled + counts.declined;
  return {
    model,
    attempts,
    fulfilled: counts.fulfilled,
    declined: counts.declined,
    invalid: counts.invalid,
    unparsable: counts.unparsable,
    truncated,
    crashes: crashDetails.length,
    schemaValid: attempts === 0 ? 0 : Number((accepted / attempts).toFixed(4)),
    medianLatencyMs: median(latencies),
    timing: summarizeTiming(records),
    shapesHandled: records.filter((record) => record.finishReason === SHAPES_MARKER).length,
    bug807: crashDetails.some(isBug807),
    crashDetails,
    perSentence,
  };
}

export interface GrammarReport extends RunSummary {
  readonly measuredAt: string;
  readonly corpusVersion: string;
  readonly forcedShapeSchema: string;
  readonly maxOutputTokens: number;
  readonly adapter: string;
  readonly bug807Reproduced: boolean;
  readonly reproduction: RunSummary | null;
}

export function buildReport(input: {
  readonly primary: RunSummary;
  readonly reproduction: RunSummary | null;
  readonly adapter: string;
  readonly measuredAt: string;
}): GrammarReport {
  return {
    ...input.primary,
    measuredAt: input.measuredAt,
    corpusVersion: 'v3',
    forcedShapeSchema: FORCED_SHAPE_SCHEMA,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    adapter: input.adapter,
    bug807Reproduced: input.primary.bug807 || (input.reproduction?.bug807 ?? false),
    reproduction: input.reproduction,
  };
}

/**
 * Proč tohle existuje jako funkce a ne jako aserce uvnitř testu: AC žádá, aby
 * `npm run measure:grammar` **skončil nenulově**, když se nezměřilo všech 40 vět.
 * Zelený běh nad devatenácti větami by byl report, který se dá citovat a je
 * přitom o něčem jiném, než tvrdí jeho jméno.
 */
export function measurementShortfall(report: GrammarReport): string | null {
  if (report.attempts < MEASURED_SENTENCES) {
    return `změřeno ${report.attempts} vět z požadovaných ${MEASURED_SENTENCES}`;
  }
  return null;
}
