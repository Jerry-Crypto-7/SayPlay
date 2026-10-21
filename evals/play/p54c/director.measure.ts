/**
 * Režisér nad dev sadou P54C (T14): zvolí žánr klasifikátoru nebo očekávaný žánr a postaví hru, kterou robot
 * vyhraje – nebo spadne na rychlou verzi s důvodem?
 *
 * Každá věta jde jednou kompaktnímu režisérovi (`direct(…, { compact: true, maxRepairRounds: 0 })`, cesta
 * produkce bez příkladů a bez opravného kola – právě jedno volání modelu na větu). První odpověď modelu se uloží
 * do `director-answers.json` (s modelem, verzí promptu a tokeny) a souhrn s řádky do `director.json`. Holdout se
 * nečte. Živý běh pod zámkem GPU (gpt-oss-20b na llama.cpp, `director.cmd`), skupiny a strop volání z prostředí:
 *
 *   P54C_GROUPS=catch,whack,defense,slice,trap P54C_CALL_BUDGET=48 node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p54c/director.cmd
 *
 * - `P54C_GROUPS`: žánry dev sady (`catch`, `whack`, … `push`) a `trap`; bez ní (a bez `P54C_IDS`) všech 80 vět.
 * - `P54C_IDS`: jednotlivé věty navíc k `P54C_GROUPS` (T14b: vzorek žánrů pruhů, `c01,c02,…`).
 * - `P54C_CALL_BUDGET`: kolik volání smí běh udělat; víc vybraných vět, než strop pustí, běh odmítne před prvním
 *   voláním a větev nad stropem nic neodešle.
 * - `P54C_JUDGE_ONLY=1`: bez modelu – nahrané odpovědi znovu projdou `direct()` (po změně cesty čtení) a souhrn se
 *   přepíše; nic se nevolá.
 * - `P54C_DIRECTOR_ENDPOINT` / `P54C_DIRECTOR_MODEL`: jiný model (výchozí `llamacpp:http://127.0.0.1:8792`, `gpt-oss-20b`).
 *
 * Cena za hru je z tokenů volání a ceníku Groq pro gpt-oss-20b (0,075 / 0,30 USD za 1M tokenů vstupu / výstupu,
 * `docs/specs/2026-09-29-sladeni-dokumentace.md`). Rychlá verze (`draftGameSpecWithMeta`) se měří nad celou sadou bez modelu.
 *
 * T14b (nový prompt, režisér nabízí i žánry fáze 3): odpovědi a souhrn T14 (prompt `b830dc2d`, všech 80 vět) leží
 * v `director-answers-t14.json` a `director-t14.json`; souhrn T14 se do `director.json` opisuje jako `t14Summary`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { arcadeWorldOf, preloadPhysics } from '../../../src/play/arcade/compile';
import { loadRapier } from '../../../src/play/arcade/physics/world';
import { verifyArcade } from '../../../src/play/arcade/verify';
import { liveCells } from '../../../src/play/compose/allowed';
import { recipeKey, type Recipe } from '../../../src/play/compose/recipe';
import { direct } from '../../../src/play/director';
import { buildCompactRequest, COMPACT_PROMPT_VERSION } from '../../../src/play/director/compact';
import { draftGameSpecWithMeta } from '../../../src/play/draft/draft';
import type { GameSpecV1 } from '../../../src/play/spec';
import type { GenerationBranch, GenerationOutcome } from '../../../src/server/pipeline';
import { upstreamBranch, type UpstreamConfig } from '../../../src/server/upstream';

import { rowOf } from './rows';

const DIR = join(process.cwd(), 'evals', 'play', 'p54c');
const ANSWERS = join(DIR, 'director-answers.json');
const OUT = join(DIR, 'director.json');
/** Souhrn běhu T14 (prompt `b830dc2d`) – T14b ho nechává vedle, ať čísla MVP zůstanou čitelná. */
const T14 = join(DIR, 'director-t14.json');
/** Ceník Groq pro gpt-oss-20b, USD za 1M tokenů (P30: `docs/specs/2026-09-29-sladeni-dokumentace.md`). */
const GROQ = { usdPerMTokIn: 0.075, usdPerMTokOut: 0.3 } as const;
/** Brána T14: podíl vět, u kterých režisér zvolí žánr klasifikátoru nebo očekávaný žánr. */
const GATE = 0.8;
const SEED = 1;

interface DevSentence { readonly id: string; readonly family: string; readonly expect: string; readonly text: string }
interface Recorded {
  readonly id: string;
  readonly sentence: string;
  readonly recordedAt: string;
  readonly ms: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly outcome: { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly reason: string; readonly detail: string };
}
interface AnswerFile { readonly model: string; readonly endpoint: string; readonly promptVersion: string; readonly answers: Record<string, Recorded> }

const genreOf = (value: string | null): string | null => (value === null ? null : value.split('.')[0]!);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Žánr, který odpověď jmenuje: recept → žánr jeho živé buňky, starý tvar → pole `genre`. */
function answerGenre(body: unknown): { readonly format: 'recipe' | 'legacy' | 'none'; readonly genre: string | null; readonly recipe?: string } {
  const spec = isRecord(body) && isRecord(body.spec) ? body.spec : body;
  if (!isRecord(spec)) return { format: 'none', genre: null };
  if (isRecord(spec.recipe)) {
    const recipe = spec.recipe as unknown as Recipe;
    const key = Array.isArray(recipe.actions) && Array.isArray(recipe.threats) ? recipeKey(recipe) : 'unreadable';
    return { format: 'recipe', genre: liveCells().find((cell) => recipeKey(cell.recipe) === key)?.preset.genre ?? null, recipe: key };
  }
  return { format: typeof spec.genre === 'string' ? 'legacy' : 'none', genre: typeof spec.genre === 'string' ? spec.genre : null };
}

const quantile = (values: readonly number[], q: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
};
const round = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;
const usdOf = (usage: Recorded['usage']) => (usage === null ? null : round((usage.inputTokens * GROQ.usdPerMTokIn + usage.outputTokens * GROQ.usdPerMTokOut) / 1e6));

/** Větev, která po `budget` voláních nic neodešle a každé volání si zapíše (první výsledek, čas, tokeny). */
function budgeted(inner: GenerationBranch, budget: { left: number; used: number }): GenerationBranch & { first: GenerationOutcome | null; ms: number } {
  const branch = {
    id: inner.id,
    pricing: inner.pricing,
    first: null as GenerationOutcome | null,
    ms: 0,
    worstCaseUsd: (call: Parameters<GenerationBranch['worstCaseUsd']>[0]) => inner.worstCaseUsd(call),
    async generate(call: Parameters<GenerationBranch['generate']>[0], signal?: AbortSignal): Promise<GenerationOutcome> {
      if (budget.left <= 0) return { ok: false, reason: 'UPSTREAM_REJECTED', detail: 'P54C T14 call budget spent – nothing was sent', usage: null };
      budget.left -= 1;
      budget.used += 1;
      const started = performance.now();
      const outcome = await inner.generate(call, signal);
      if (branch.first === null) {
        branch.first = outcome;
        branch.ms = Math.round(performance.now() - started);
      }
      return outcome;
    },
  };
  return branch;
}

/** Větev bez modelu: vrátí nahranou první odpověď; `seen.bytes` = délka požadavku, jak by šel modelu (systém + zpráva). */
function replaying(recorded: Recorded, seen: { bytes: number | null }): GenerationBranch {
  return {
    id: 'p54c-replay',
    pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
    worstCaseUsd: () => 0,
    generate: (call) => {
      seen.bytes ??= Buffer.byteLength(call.request.system + call.request.user);
      return Promise.resolve(recorded.outcome.ok ? { ok: true, body: recorded.outcome.body, usage: recorded.usage, provenance: { branch: 'p54c-replay' } } : { ok: false, reason: recorded.outcome.reason as 'UPSTREAM_UNAVAILABLE', detail: recorded.outcome.detail, usage: null });
    },
  };
}

/** Robot světa (G1) nad hrou, kterou režisér vrátil: vyhraje, nečinný prohraje, replay sedí. */
async function botOf(spec: GameSpecV1) {
  await preloadPhysics(spec, loadRapier);
  const made = arcadeWorldOf(spec, SEED);
  if (!made.ok) return { botWins: false, seconds: null, idleLoses: false, replayEqual: false, failures: made.issues.slice(0, 3) };
  const verdict = verifyArcade(made.world, undefined, made.roleBindings);
  return { botWins: verdict.bot.outcome === 'won', seconds: round(verdict.bot.tick / 60, 1), idleLoses: verdict.idle.outcome !== 'won', replayEqual: verdict.replayEqual, failures: verdict.failures.slice(0, 3) };
}

/** Řádek věty: kam ji dává klasifikátor a návrh, co jmenuje odpověď a co `direct()` z odpovědi vrátí. */
async function judge(sentence: DevSentence, recorded: Recorded) {
  const where = rowOf(sentence.id, sentence.text);
  const seen = { bytes: null as number | null };
  const game = await direct(sentence.text, { branch: replaying(recorded, seen), now: Date.now, compact: true, maxRepairRounds: 0, seed: SEED });
  const named = recorded.outcome.ok ? answerGenre(recorded.outcome.body) : { format: 'none' as const, genre: null };
  const accepted = new Set([genreOf(where.classify), genreOf(sentence.expect)]);
  const played = game.spec.genre?.id ?? null;
  return {
    id: sentence.id,
    family: sentence.family,
    expect: sentence.expect,
    classify: where.classify,
    draft: where.draft,
    answer: { ...named, ok: named.genre !== null && accepted.has(named.genre) },
    game: {
      source: game.source,
      fallbackReason: game.fallbackReason,
      ...(game.failure === undefined ? {} : { failure: `${game.failure.reason}: ${game.failure.detail}`.slice(0, 240) }),
      genre: played === null ? null : `${played}.${game.spec.genre!.mode}`,
      control: game.spec.control,
      ok: played !== null && accepted.has(played),
      bot: game.source === 'draft' ? null : await botOf(game.spec),
    },
    ms: recorded.ms,
    requestBytes: seen.bytes,
    tokens: recorded.usage,
    usd: usdOf(recorded.usage),
  };
}
type Judged = Awaited<ReturnType<typeof judge>>;

it('measures the compact director over the P54C dev set (T14)', async () => {
  await loadRapier();
  const dev = (JSON.parse(readFileSync(join(DIR, 'dev.json'), 'utf8')) as { sentences: DevSentence[] }).sentences;
  const groups = process.env.P54C_GROUPS?.split(',').map((group) => group.trim()) ?? null;
  const ids = process.env.P54C_IDS?.split(',').map((id) => id.trim()) ?? null;
  const picked = dev.filter((sentence) => (groups === null && ids === null) || (groups?.includes(sentence.family === 'trap' ? 'trap' : genreOf(sentence.expect)!) ?? false) || (ids?.includes(sentence.id) ?? false));
  const judgeOnly = process.env.P54C_JUDGE_ONLY === '1';
  const endpoint = process.env.P54C_DIRECTOR_ENDPOINT ?? 'llamacpp:http://127.0.0.1:8792';
  const model = process.env.P54C_DIRECTOR_MODEL ?? 'gpt-oss-20b';
  const stored: AnswerFile = existsSync(ANSWERS) ? (JSON.parse(readFileSync(ANSWERS, 'utf8')) as AnswerFile) : { model, endpoint, promptVersion: COMPACT_PROMPT_VERSION, answers: {} };
  if (!judgeOnly && stored.promptVersion !== COMPACT_PROMPT_VERSION && Object.keys(stored.answers).length > 0) throw new Error(`director-answers.json is from prompt ${stored.promptVersion}, today ${COMPACT_PROMPT_VERSION} – move it away before a new live run`);
  const budget = { left: judgeOnly ? 0 : Number(process.env.P54C_CALL_BUDGET ?? 0), used: 0 };
  const todo = judgeOnly ? [] : picked.filter((sentence) => stored.answers[sentence.id] === undefined);
  if (!judgeOnly && todo.length > budget.left) throw new Error(`${String(todo.length)} sentences to call, budget ${String(budget.left)} – raise P54C_CALL_BUDGET or narrow P54C_GROUPS`);
  const config: UpstreamConfig = { endpoint, apiKey: '', model, effort: 'low', pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 }, maxOutputTokens: 4000, timeoutMs: 120_000, profile: 'subscription', callCap: null };
  const answers: Record<string, Recorded> = { ...stored.answers };

  for (const sentence of todo) {
    const branch = budgeted(upstreamBranch(config), budget);
    await direct(sentence.text, { branch, now: Date.now, compact: true, maxRepairRounds: 0, seed: SEED });
    const first = branch.first;
    answers[sentence.id] = {
      id: sentence.id,
      sentence: sentence.text,
      recordedAt: new Date().toISOString(),
      ms: branch.ms,
      usage: first === null ? null : first.usage,
      outcome: first === null ? { ok: false, reason: 'NO_CALL', detail: 'direct() did not call the model' } : first.ok ? { ok: true, body: first.body } : { ok: false, reason: first.reason, detail: first.detail.slice(0, 300) },
    };
    // Po každé větě na disk: přerušený běh nepřijde o zaplacená volání.
    writeFileSync(ANSWERS, `${JSON.stringify({ model, endpoint, promptVersion: COMPACT_PROMPT_VERSION, answers }, null, 1)}\n`);
    console.log(`${sentence.id} ${String(branch.ms)} ms ${first?.ok === true ? JSON.stringify(answerGenre(first.body)) : (first?.reason ?? 'no call')}`);
  }

  // Řádky ze všech nahraných odpovědí dev sady (i z dřívějších běhů), cestou produkce znovu bez modelu.
  const rows: Judged[] = [];
  for (const sentence of dev.filter((each) => answers[each.id] !== undefined)) rows.push(await judge(sentence, answers[sentence.id]!));

  // Rychlá verze nad celou sadou bez modelu: první průchod studený (jako `rowOf`), druhý zahřátý.
  const draftMs = (texts: readonly string[]) => texts.map((text) => {
    const started = performance.now();
    draftGameSpecWithMeta(text, SEED);
    return performance.now() - started;
  });
  const cold = draftMs(dev.map((sentence) => sentence.text));
  const warm = draftMs(dev.map((sentence) => sentence.text));
  const system = Buffer.byteLength(buildCompactRequest('x', null).system);
  const bytes = rows.flatMap((row) => (row.requestBytes === null ? [] : [row.requestBytes]));

  const share = (pick: (row: (typeof rows)[number]) => boolean, of = rows) => ({ hit: of.filter(pick).length, of: of.length, share: of.length === 0 ? null : round(of.filter(pick).length / of.length, 3) });
  const groupOf = (row: (typeof rows)[number]) => (row.family === 'trap' ? 'trap' : genreOf(row.expect)!);
  const priced = rows.filter((row) => row.usd !== null);
  const directed = rows.filter((row) => row.game.source !== 'draft');
  const summary = {
    gate: GATE,
    answerGenreOk: share((row) => row.answer.ok),
    gameGenreOk: share((row) => row.game.ok),
    byGroup: Object.fromEntries([...new Set(rows.map(groupOf))].map((group) => {
      const of = rows.filter((row) => groupOf(row) === group);
      return [group, { answer: share((row) => row.answer.ok, of), game: share((row) => row.game.ok, of), answerGenres: Object.fromEntries([...new Set(of.map((row) => row.answer.genre ?? 'none'))].map((genre) => [genre, of.filter((row) => (row.answer.genre ?? 'none') === genre).length])) }];
    })),
    formats: Object.fromEntries(['recipe', 'legacy', 'none'].map((format) => [format, rows.filter((row) => row.answer.format === format).length])),
    games: {
      authored: directed.length,
      botWins: directed.filter((row) => row.game.bot?.botWins === true).length,
      botFailures: directed.filter((row) => row.game.bot?.botWins !== true).map((row) => `${row.id}: ${row.game.bot?.failures.join('; ') ?? 'not verified'}`),
      quickVersion: rows.filter((row) => row.game.source === 'draft').length,
      fallbackReasons: Object.fromEntries([...new Set(rows.map((row) => row.game.fallbackReason ?? 'none'))].map((reason) => [reason, rows.filter((row) => (row.game.fallbackReason ?? 'none') === reason).length])),
    },
    directorMs: { p50: quantile(rows.map((row) => row.ms), 0.5), p95: quantile(rows.map((row) => row.ms), 0.95), max: Math.max(...rows.map((row) => row.ms)), label: 'local RTX 3090, llama.cpp gpt-oss-20b – not Groq' },
    cost: {
      pricing: GROQ,
      perGameUsd: { mean: priced.length === 0 ? null : round(priced.reduce((sum, row) => sum + row.usd!, 0) / priced.length), max: priced.length === 0 ? null : Math.max(...priced.map((row) => row.usd!)) },
      tokens: { inMean: priced.length === 0 ? null : Math.round(priced.reduce((sum, row) => sum + row.tokens!.inputTokens, 0) / priced.length), outMean: priced.length === 0 ? null : Math.round(priced.reduce((sum, row) => sum + row.tokens!.outputTokens, 0) / priced.length) },
    },
    // Požadavek, jak šel modelu: systém + věta, seznam, výchozí bod, průběh a FULL INTENT (bez příkladů, jako produkce).
    prompt: { version: COMPACT_PROMPT_VERSION, systemBytes: system, requestBytes: { mean: bytes.length === 0 ? null : Math.round(bytes.reduce((sum, value) => sum + value, 0) / bytes.length), max: bytes.length === 0 ? null : Math.max(...bytes) }, budgetBytes: 15_000 },
    quickDraftMs: { cold: { p95: round(quantile(cold, 0.95)!, 1), max: round(Math.max(...cold), 1) }, warm: { p95: round(quantile(warm, 0.95)!, 1), max: round(Math.max(...warm), 1) }, sentences: dev.length },
  };
  writeFileSync(
    OUT,
    `${JSON.stringify({
      schema: 'p54c-director.v1',
      about: 'P54C T14/T14b: first answer of the compact director (one call per sentence, no repair round, no examples) over evals/play/p54c/dev.json; answers in director-answers.json. answer.ok = the genre the answer names is the classifier genre or the expected genre; game = what direct() returned, botWins from verifyArcade on that game. t14Summary = the T14 run (prompt b830dc2d, all 80 sentences, director-t14.json). See README.md (T14, T14b).',
      commit: execFileSync('git', ['--no-replace-objects', 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
      model: stored.model === model || Object.keys(stored.answers).length === 0 ? model : stored.model,
      endpoint,
      liveCalls: Object.keys(answers).length,
      summary,
      ...(existsSync(T14) ? { t14Summary: (JSON.parse(readFileSync(T14, 'utf8')) as { summary: unknown }).summary } : {}),
      rows,
    }, null, 1)}\n`,
  );
  console.log(`answer genre ${String(summary.answerGenreOk.hit)}/${String(summary.answerGenreOk.of)} · game genre ${String(summary.gameGenreOk.hit)}/${String(summary.gameGenreOk.of)} · calls this run ${String(budget.used)}`);
}, 4 * 60 * 60_000);
