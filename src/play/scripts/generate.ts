/**
 * Úroveň ze skriptu v AI verzi (P68 T13, pilot, jen za `PLAY_SCRIPTS=on`; výchozí vypnuto).
 *
 * Model (astra – konfigurace placené zálohy režiséra `WORLDSMITH_FALLBACK_*` z `src/server/upstream.ts`, útrata z vlastní
 * knihy `PLAY_SCRIPTS_SPEND_CAP_USD`) napíše k větě `build(api)`. Sandbox ho spustí, `validate.ts` rozhodne (zdroj,
 * data úrovně, řešitelnost robotem). Neprošlý pokus dostane jedno opravné kolo s výpisem chyb; druhé selhání = AI verze
 * bez skriptu (šablona). Uloží se `{ levelData, codeDigest, runtimeVersion }` ve specu verze; hraje se z dat
 * důvěryhodným runtimem, VM se při hraní nespouští. Jen na serveru (`node:crypto`).
 */

import { createHash } from 'node:crypto';

import { generatorOf } from '@/play/arcade/compile';
import type { GameSpecV1 } from '@/play/spec';
import type { GenerationCall } from '@/server/pipeline';
import { killState } from '@/server/kill-switch';
import { costUsd, processScriptsSpendCap } from '@/server/spend-cap';
import { chatConfigFromEnv, upstreamBranch } from '@/server/upstream';

import type { ScriptGame } from './api';
import { runScriptIsolated } from './isolated';
import { SCRIPT_RUNTIME_VERSION } from './sandbox';
import { scriptLevelFromRecording, scriptSourceIssues, scriptedSpecIssues } from './validate';

type Env = Record<string, string | undefined>;

/** Přepínač pilotu: jen přesně `on`. */
export function scriptsEnabled(env: Env = process.env): boolean {
  return env.PLAY_SCRIPTS === 'on';
}

export interface ScriptRequest {
  readonly sentence: string;
  readonly game: ScriptGame;
  readonly params: Readonly<Record<string, number>>;
  /** Opravné kolo: předchozí kód a jeho chyby; `null` = první pokus. */
  readonly repair: { readonly code: string; readonly issues: readonly string[] } | null;
  /** Kolik ms smí volání trvat: zbytek okna trasy (revize T13), ne pevná mez písaře. */
  readonly timeoutMs: number;
}

/** Odpověď písaře: kód a útrata volání; `null` = nic nepřišlo (strop, vypínač, výpadek). */
export interface ScriptAnswer {
  readonly code: string;
  readonly costUsd: number;
}
export type ScriptWriter = (request: ScriptRequest) => Promise<ScriptAnswer | null>;

export interface ScriptAttempt {
  readonly code: string | null;
  readonly issues: readonly string[];
  /** Kroky interpretu (`polls`), `null` = do VM nedošlo. */
  readonly polls: number | null;
  readonly ms: number;
}

export interface ScriptedOutcome {
  /** Spec s `scriptLevel`, nebo `null` = zůstává šablona. */
  readonly spec: GameSpecV1 | null;
  readonly attempts: readonly ScriptAttempt[];
  readonly spentUsd: number;
  /** Proč skript nebyl: hra bez skriptu, písař nic nevrátil, na volání písaře nezbyl čas, nebo dvakrát neprošel. */
  readonly reason: 'ok' | 'unsupported' | 'no-answer' | 'no-time' | 'invalid';
}

/** Hra, pro kterou skript píše, a její parametry; `null` = spec takovou hru nehraje. */
export function scriptGameOf(spec: GameSpecV1): { readonly game: ScriptGame; readonly params: { readonly rows: number } } | null {
  if (spec.control !== 'hop' || generatorOf(spec) !== 'hop_rows') return null;
  const rows = (spec.controlParams as { readonly tuning?: { readonly rows?: unknown } } | undefined)?.tuning?.rows;
  return { game: 'hop', params: { rows: typeof rows === 'number' ? rows : 50 } };
}

export const scriptDigest = (code: string): string => createHash('sha256').update(code).digest('hex');

/** Jeden pokus: zdroj, sandbox, data úrovně, svět a robot. */
async function attempt(code: string, spec: GameSpecV1, seed: number, target: NonNullable<ReturnType<typeof scriptGameOf>>): Promise<{ readonly spec: GameSpecV1 | null; readonly attempt: ScriptAttempt }> {
  const started = performance.now();
  const done = (issues: readonly string[], polls: number | null, scripted: GameSpecV1 | null = null) => ({ spec: scripted, attempt: { code, issues, polls, ms: Math.round(performance.now() - started) } });
  const source = scriptSourceIssues(code);
  if (source.length > 0) return done(source, null);
  const run = await runScriptIsolated(code, { game: target.game, params: target.params, seed });
  if (!run.ok) return done([`${run.error.kind}: ${run.error.message}`], run.polls);
  const level = scriptLevelFromRecording(target.game, run.recording, target.params);
  if (!level.ok) return done(level.issues, run.polls);
  const scripted: GameSpecV1 = { ...spec, scriptLevel: { levelData: level.levelData, codeDigest: scriptDigest(code), runtimeVersion: SCRIPT_RUNTIME_VERSION } };
  const issues = scriptedSpecIssues(scripted, seed);
  return issues.length > 0 ? done(issues, run.polls) : done([], run.polls, scripted);
}

/** Okno volání písaře: do `deadline` (ms epochy) a jen se zbytkem aspoň `minCallMs`. */
export interface ScriptWindow {
  readonly deadline: number;
  readonly minCallMs: number;
}

/**
 * Úroveň ze skriptu pro `spec` na semínku `seed`: první pokus, při neúspěchu jedno opravné kolo s chybami.
 * Hra, pro kterou skript nepíše, se nezkouší (písař se nevolá). Písař se nevolá ani se zbytkem okna pod `minCallMs`
 * (revize T13) a timeout volání je zbytek do `deadline`; bez okna (offline pilot) čas nerozhoduje.
 */
export async function scriptedLevel(spec: GameSpecV1, seed: number, sentence: string, writer: ScriptWriter, window: ScriptWindow = { deadline: Number.POSITIVE_INFINITY, minCallMs: 0 }): Promise<ScriptedOutcome> {
  const target = scriptGameOf(spec);
  if (target === null) return { spec: null, attempts: [], spentUsd: 0, reason: 'unsupported' };
  const attempts: ScriptAttempt[] = [];
  let spentUsd = 0;
  let repair: ScriptRequest['repair'] = null;
  for (let round = 0; round < 2; round += 1) {
    const timeoutMs = window.deadline - Date.now();
    if (timeoutMs < window.minCallMs) return { spec: null, attempts, spentUsd, reason: 'no-time' };
    const answer = await writer({ sentence, game: target.game, params: target.params, repair, timeoutMs });
    if (answer === null) return { spec: null, attempts, spentUsd, reason: 'no-answer' };
    spentUsd += answer.costUsd;
    const tried = await attempt(answer.code, spec, seed, target);
    attempts.push(tried.attempt);
    if (tried.spec !== null) return { spec: tried.spec, attempts, spentUsd, reason: 'ok' };
    repair = { code: answer.code, issues: tried.attempt.issues };
  }
  return { spec: null, attempts, spentUsd, reason: 'invalid' };
}

// ---------------------------------------------------------------------------
// Placený písař

/** Zadání písaře: API vlastními slovy, mřížka a pravidla trati `hop`, tvar odpovědi. */
export const SCRIPT_SYSTEM_PROMPT = [
  'You write one JavaScript function, build(api), that lays out a level for a hopping game: the hero hops forward row by row across a grid 9 columns wide (x = 0..8) and api.param("rows") rows long (z = 0..rows). Rows 0, 1 and 2 and the goal row (z = rows) stay grass.',
  'api.place(kind, x, z) turns row z into kind "road" (cars), "river" (logs to ride) or "rail" (a train). x is the column traffic comes from: 0..3 from the left, 5..8 from the right, 4 lets the game choose. Neighbouring rows of one kind form a band: a road band is at most 5 rows, a river band at most 3, a rail band at most 2. Two bands need at least one grass row between them. Every row you do not place stays grass.',
  'api.rng.int(a, b) returns a whole number from a to b (the only randomness; it is seeded per game). api.param("rows") is the course length. All arguments are whole numbers.',
  'Make the level fit the sentence (which obstacles, how many, in what order) and keep it playable: the course must be crossable within 90 seconds by a careful player, so leave grass rows to rest on. No Date, no Math.random, no timers, no network, no imports. The function runs once, synchronously, with a strict step budget.',
  'Answer with JSON {"code": "<the JavaScript source defining function build(api)>"} and nothing else.',
].join('\n');

const SCRIPT_SCHEMA = { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false } as const;

/** Zpráva pro písaře: věta, délka trati a v opravném kole předchozí kód s chybami. */
export function scriptUserMessage(request: ScriptRequest): string {
  const lines = [`Sentence: ${request.sentence}`, `Game: ${request.game}, rows = ${String(request.params.rows)}`];
  if (request.repair !== null) lines.push('Your previous build(api) failed validation. Fix it.', `Errors:\n- ${request.repair.issues.join('\n- ')}`, `Previous code:\n${request.repair.code}`);
  return lines.join('\n');
}

/**
 * Písař přes astru: konfigurace `WORLDSMITH_FALLBACK_*` (placená záloha režiséra), útrata z knihy
 * `PLAY_SCRIPTS_SPEND_CAP_USD` (chybí = 0, pak nevolá nikdy), vypínač upstreamu platí i tady.
 */
export function paidScriptWriter(env: Env = process.env): ScriptWriter {
  return async (request) => {
    const config = chatConfigFromEnv(env, 'WORLDSMITH_FALLBACK', { localModel: 'local-fallback', localMaxOutputTokens: 4096, hostedMaxOutputTokens: 4096, timeoutMs: 60_000 });
    if (config === null) return null;
    const call: GenerationCall = { prompt: request.sentence, request: { model: config.model, system: SCRIPT_SYSTEM_PROMPT, user: scriptUserMessage(request), outputSchema: SCRIPT_SCHEMA } };
    // Timeout zkrácený na zbytek okna trasy (revize T13): `WORLDSMITH_FALLBACK_TIMEOUT_MS` smí být delší než celé okno.
    const branch = upstreamBranch({ ...config, timeoutMs: Math.min(config.timeoutMs, request.timeoutMs) }, fetch);
    if ((await killState(env, fetch).then((state) => state.upstream, () => true)) === true) return null;
    const reservation = await processScriptsSpendCap().reserve(branch.worstCaseUsd(call));
    if (!reservation.ok) return null;
    const outcome = await branch.generate(call).catch(() => null);
    const spent = await reservation.settle(outcome === null || outcome.usage === null ? 'unknown' : costUsd(outcome.usage, config.pricing));
    const code = outcome?.ok === true ? (outcome.body as { readonly code?: unknown } | null)?.code : undefined;
    return typeof code === 'string' ? { code, costUsd: spent } : null;
  };
}
