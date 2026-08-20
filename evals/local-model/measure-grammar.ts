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
import { buildEmissionRequest } from '../../src/model/prompt';

/** Kolik vět se měří. AC úlohy T5 říká prvních 40 z `corpus-v3`. */
export const MEASURED_SENTENCES = 40;

/** Model, na kterém stojí hlavní cesta (`CLAUDE.md`, tech stack P11). */
export const PRIMARY_MODEL = 'Qwen3-1.7B-q4f16_1-MLC';

/**
 * Model z hlášení `mlc-ai/web-llm#807`. Měří se **jen když hlavní model spadne**,
 * a jen proto, aby se dalo napsat, jestli je ten pád tahle známá chyba, nebo něco
 * jiného. Hlášení jmenuje přesně tuhle váhu.
 */
export const REPRODUCTION_MODEL = 'Qwen3-0.6B-q4f16_1-MLC';

export const REPORT_PATH = join('evals', 'local-model', 'grammar-report.json');

/**
 * Strop odpovědi. Emise celého světa se do 1400 tokenů vejde (příklad
 * v `src/model/prompt.ts` má řádově stovky tokenů), a co se nevejde, skončí
 * useknuté — což je poctivá odpověď „tvar neudržel", ne vada měření. Bez stropu
 * by jediná zacyklená odpověď spolkla celý běh.
 */
export const MAX_OUTPUT_TOKENS = 1400;

/**
 * Tvar, na který se sváže dekodér.
 *
 * Je to **obálka, kterou vyjmenovává systémový prompt** (`src/model/prompt.ts`:
 * „Its top-level fields are exactly: irVersion, simRevision, lookRevision, sim,
 * look"), ne celé schéma světa. Rozvinout do gramatiky celý `simSchema` by
 * měřilo něco jiného: ne jestli model udrží tvar, ale jestli xgrammar zvládne
 * schéma o stovkách uzlů. Vnitřek `sim` a `look` zůstává na modelu, a právě ten
 * vnitřek pak soudí produkční validátor.
 *
 * `sim` smí být `null` — tak se v tomhle kontraktu píše poctivé odmítnutí.
 */
export const FORCED_SHAPE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    irVersion: { type: 'string' },
    simRevision: { type: 'integer' },
    lookRevision: { type: 'integer' },
    sim: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    look: { type: 'object' },
  },
  required: ['irVersion', 'simRevision', 'lookRevision', 'sim', 'look'],
});

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

/**
 * Qwen3 umí odpověď uvést blokem `<think>`. Šablona ho vkládá i tam, kde je
 * prázdný, takže by `JSON.parse` spadl na uvozujícím textu a měření by hlásilo
 * „neudržel tvar" u odpovědi, která tvar udržela. Blok se proto odřízne, a jen
 * on — cokoli jiného před `{` je skutečná vada odpovědi a nechá se být.
 */
export function stripThinking(raw: string): string {
  return raw.replace(/^\s*<think>[\s\S]*?<\/think>/, '').trim();
}

/**
 * Cesta k poli, na kterém schéma selhalo, před hláškou schématu.
 *
 * Zod sám hlásí jen důvod (`expected nonoptional, received undefined`), a ten je
 * u čtyřiceti vět čtyřicetkrát stejný. Bez cesty report říká, že něco chybí, a
 * zamlčuje co — což je přesně ta otázka, na kterou se T6 ptá.
 */
function describeIssue(
  issue: { readonly path: readonly PropertyKey[]; readonly message: string } | undefined,
): string {
  if (!issue) return 'neznámý rozpor se schématem';
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
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

  const world = worldEmissionSchema.safeParse(peeled.document);
  if (world.success) return { kind: 'fulfilled', detail: '' };

  if (declinedEmissionSchema.safeParse(peeled.document).success) {
    return { kind: 'declined', detail: 'sim je poctivě null' };
  }

  return { kind: 'invalid', detail: describeIssue(world.error.issues[0]) };
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

/** Jeden pokus tak, jak ho vrátil prohlížeč. */
export interface AttemptRecord {
  readonly id: string;
  readonly latencyMs: number;
  readonly finishReason: string;
  readonly raw: string;
  /** Prázdný řetězec znamená, že pokus doběhl. Cokoli jiného je pád. */
  readonly error: string;
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
    latencies.push(record.latencyMs);
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
