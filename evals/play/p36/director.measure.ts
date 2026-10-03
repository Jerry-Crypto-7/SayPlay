/**
 * Režisér s poli hloubky (P36A T9): kompaktní režisér (`direct(…, { compact: true })`)
 * na lokálním modelu z `ops/llm/start.ps1 -Role fallback`, stejně jako P29B T9
 * (`evals/play/local-director.measure.ts`), aby šla čísla porovnat.
 *
 * Tři sady:
 * - **korpus** – 30 vět `evals/play/fidelity/corpus.json` (výchozí stav 28/30, p50 4,5 s);
 * - **vývojová** – `d01–d20` z `evals/play/p30/dev.json`;
 * - **mechaniky** – 20 vlastních vět `mechanics.json`, které říkají životy, cílové
 *   skóre, časový limit nebo chování nepřítele. U každé se hra rychlého návrhu
 *   i hra režiséra postaví cestou publikace (první semínko `derivedSeeds`, na
 *   kterém `compileArcade` projde) a měří se, jestli svět nese, co věta říká.
 *
 * Bez dostupného modelu se změří jen strana rychlého návrhu a `director` zůstane
 * `null` s důvodem – řídicí session měření doplní. Běží pod vitestem (cesta
 * publikace `_publish.ts` táhne `next/server`, holý Node ji nenačte); model a
 * adresa z `P36_DIRECTOR_MODEL` / `P36_DIRECTOR_ENDPOINT`. Pod zámkem GPU:
 *   node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p36/director.cmd
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { compileArcade } from '@/play/arcade/compile';
import type { ArcadeWorld } from '@/play/arcade/contract';
import { loadRapier } from '@/play/arcade/physics/world';
import { direct } from '@/play/director';
import { GENRE_ANSWER_SCHEMA } from '@/play/director/answer-schema';
import { COMPACT_PROMPT_VERSION, compactSystemPrompt } from '@/play/director/compact';
import { directorSystemPrompt } from '@/play/director/prompt';
import { draftGameSpec } from '@/play/draft';
import { fidelityChain, type ChecklistEntry } from '@/play/fidelity/chain';
import type { EnemyMove } from '@/play/genre/contract';
import type { GameSpecV1 } from '@/play/spec';
import { upstreamBranch, type UpstreamConfig } from '@/server/upstream';

import { livesOf, scoreGoalOf } from './depth';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = join(ROOT, 'evals', 'play', 'p36', 'director.json');

interface Sentence {
  readonly id: string;
  readonly text: string;
  readonly checklist: readonly ChecklistEntry[];
}

interface Expect {
  readonly lives?: number;
  readonly score?: number;
  readonly seconds?: number;
  readonly enemy?: EnemyMove;
}

interface MechanicSentence {
  readonly id: string;
  readonly text: string;
  readonly expect: Expect;
}

type Field = keyof Expect;
const FIELDS: readonly Field[] = ['lives', 'score', 'seconds', 'enemy'];

const readJson = (...path: string[]): unknown => JSON.parse(readFileSync(join(ROOT, ...path), 'utf8'));
const quantile = (values: readonly number[], q: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const share = (hit: number, of: number) => (of === 0 ? 0 : Math.round((hit / of) * 1000) / 1000);
const genreOf = (spec: GameSpecV1): string => (spec.genre === undefined ? `control:${String(spec.control)}` : spec.genre.mode === 'default' ? spec.genre.id : `${spec.genre.id}.${spec.genre.mode}`);

// ---------------------------------------------------------------------------
// Co svět nese

/**
 * Chování nepřítele ze světa: střelba hráče (`blaster`), hlídka (`ChaseParams.patrol`),
 * pronásledovatel kdekoli v ovládání nebo pravidlech, jinak nikdo nehoní. Úkol se
 * `still` má honiče od 2. kola (T8), takže se tu čte jako `chase` – tak se hraje.
 */
function enemyOf(world: ArcadeWorld): EnemyMove {
  if (world.rules.some((ref) => ref.id === 'blaster')) return 'shoot';
  const json = JSON.stringify([world.control, world.rules]);
  if (json.includes('"patrol"')) return 'patrol';
  return /"chaser?"/.test(json) ? 'chase' : 'still';
}

/** Svět cestou publikace: první odvozené semínko, na kterém `compileArcade` projde (robot vyhraje, nečinný ne). */
function publishedWorld(text: string, spec: GameSpecV1): { readonly world: ArcadeWorld; readonly seed: number } | { readonly world: null; readonly why: string } {
  let why = 'no seed';
  for (const seed of derivedSeeds(seedFrom(text.trim()))) {
    const built = compileArcade(spec, seed);
    if (built.ok && built.value.arcade !== undefined) return { world: built.value.arcade, seed };
    why = built.ok ? 'not an arcade game' : `${built.reason}: ${built.issues.join('; ')}`;
  }
  return { world: null, why };
}

function carriedBy(text: string, spec: GameSpecV1, expect: Expect) {
  const made = publishedWorld(text, spec);
  const genre = genreOf(spec);
  if (made.world === null) return { genre, seed: null, why: made.why, got: null, carried: Object.fromEntries(FIELDS.filter((field) => expect[field] !== undefined).map((field) => [field, false])) };
  const { world } = made;
  const seconds = world.rules.flatMap((ref) => (ref.id === 'time_limit' || ref.id === 'survive_time' ? [(ref.params as { readonly seconds: number }).seconds] : []));
  const got = { lives: livesOf(world).lives, score: scoreGoalOf(world.rules)?.points ?? null, seconds, enemy: enemyOf(world), specTarget: spec.scoring?.target ?? null };
  const hit: Record<Field, boolean> = {
    lives: got.lives === expect.lives,
    score: got.score === expect.score,
    seconds: expect.seconds !== undefined && seconds.includes(expect.seconds),
    enemy: got.enemy === expect.enemy,
  };
  return { genre, seed: made.seed, why: null, got, carried: Object.fromEntries(FIELDS.filter((field) => expect[field] !== undefined).map((field) => [field, hit[field]])) };
}

// ---------------------------------------------------------------------------
// Režisér

async function directed(text: string, config: UpstreamConfig | null) {
  if (config === null) return null;
  const started = performance.now();
  const game = await direct(text, { branch: upstreamBranch(config), now: Date.now, compact: true });
  return { game, ms: Math.round(performance.now() - started) };
}

function fidelityOf(spec: GameSpecV1, checklist: readonly ChecklistEntry[]) {
  const items = fidelityChain(spec, checklist);
  return { items: items.length, read: items.filter((item) => item.read).length, drawn: items.filter((item) => item.drawn).length };
}

type Fidelity = ReturnType<typeof fidelityOf>;
interface DraftRow {
  readonly id: string;
  readonly draft: Fidelity;
}
interface DirectedRow extends DraftRow {
  readonly ms: number;
  readonly source: string;
  readonly fallbackReason: string | null;
  readonly repairRounds: number;
  readonly calls: number;
  readonly genre: string;
  readonly final: Fidelity;
}

async function measureSet(sentences: readonly Sentence[], config: UpstreamConfig | null) {
  const rows: (DraftRow | DirectedRow)[] = [];
  for (const sentence of sentences) {
    const run = await directed(sentence.text, config);
    const draft = fidelityOf(draftGameSpec(sentence.text), sentence.checklist);
    if (run === null) {
      rows.push({ id: sentence.id, draft });
      continue;
    }
    const { game, ms } = run;
    rows.push({ id: sentence.id, ms, source: game.source, fallbackReason: game.fallbackReason, repairRounds: game.repairRounds, calls: game.calls, genre: genreOf(game.spec), final: fidelityOf(game.spec, sentence.checklist), draft });
    console.log(`${sentence.id} ${String(ms)} ms ${game.source}${game.fallbackReason === null ? '' : ` ${String(game.fallbackReason)}`} ${genreOf(game.spec)}`);
  }
  if (config === null) return { summary: null, rows };
  const timed = rows.filter((row): row is DirectedRow => 'ms' in row);
  const sum = (pick: (row: DirectedRow) => number) => timed.reduce((total, row) => total + pick(row), 0);
  const items = sum((row) => row.final.items);
  const authored = timed.filter((row) => row.source === 'authored').length;
  const reasons: Record<string, number> = {};
  for (const row of timed) if (row.fallbackReason !== null) reasons[row.fallbackReason] = (reasons[row.fallbackReason] ?? 0) + 1;
  const ms = timed.map((row) => row.ms);
  return {
    summary: {
      sentences: timed.length,
      valid: { hit: authored, of: timed.length, share: share(authored, timed.length) },
      latencyMs: { p50: quantile(ms, 0.5), p90: quantile(ms, 0.9), max: Math.max(...ms) },
      read: share(sum((row) => row.final.read), items),
      drawn: share(sum((row) => row.final.drawn), items),
      draftRead: share(sum((row) => row.draft.read), items),
      draftDrawn: share(sum((row) => row.draft.drawn), items),
      fallbackReasons: reasons,
    },
    rows,
  };
}

type Carried = ReturnType<typeof carriedBy>;
interface MechanicRow {
  readonly id: string;
  readonly text: string;
  readonly expect: Expect;
  readonly draft: Carried;
  readonly director: (Carried & { readonly ms: number; readonly source: string; readonly fallbackReason: string | null }) | null;
}

async function measureMechanics(sentences: readonly MechanicSentence[], config: UpstreamConfig | null) {
  const rows: MechanicRow[] = [];
  for (const sentence of sentences) {
    const draft = carriedBy(sentence.text, draftGameSpec(sentence.text), sentence.expect);
    const run = await directed(sentence.text, config);
    const director = run === null ? null : { ms: run.ms, source: run.game.source, fallbackReason: run.game.fallbackReason, ...carriedBy(sentence.text, run.game.spec, sentence.expect) };
    rows.push({ id: sentence.id, text: sentence.text, expect: sentence.expect, draft, director });
    const marks = (side: { readonly carried: Record<string, boolean> } | null) => (side === null ? '-' : Object.entries(side.carried).map(([field, hit]) => `${field}${hit ? '+' : '-'}`).join(' '));
    console.log(`${sentence.id} draft ${draft.genre} ${marks(draft)} | director ${director === null ? '-' : `${director.genre} ${marks(director)} ${String(director.ms)} ms ${director.source}`}`);
  }
  const tally = (side: 'draft' | 'director') => {
    const present = rows.filter((row) => row[side] !== null);
    if (present.length === 0) return null;
    const perField = Object.fromEntries(
      FIELDS.map((field) => {
        const said = present.filter((row) => row.expect[field] !== undefined);
        const hit = said.filter((row) => row[side]?.carried[field] === true).length;
        return [field, { said: said.length, carried: hit, share: share(hit, said.length) }];
      }),
    );
    const said = present.reduce((total, row) => total + Object.keys(row.expect).length, 0);
    const carried = present.reduce((total, row) => total + Object.values(row[side]?.carried ?? {}).filter(Boolean).length, 0);
    const whole = present.filter((row) => Object.values(row[side]?.carried ?? {}).every(Boolean)).length;
    return { perField, fields: { said, carried, share: share(carried, said) }, sentencesFullyCarried: { hit: whole, of: present.length, share: share(whole, present.length) } };
  };
  return { summary: { draft: tally('draft'), director: tally('director') }, rows };
}

// ---------------------------------------------------------------------------

async function reachable(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

it('writes evals/play/p36/director.json', async () => {
  const endpoint = process.env.P36_DIRECTOR_ENDPOINT ?? 'http://127.0.0.1:8792';
  const model = process.env.P36_DIRECTOR_MODEL ?? 'gpt-oss-20b';
  const up = await reachable(endpoint);
  const config: UpstreamConfig | null = up
    ? {
        endpoint: `llamacpp:${endpoint}`,
        apiKey: '',
        model,
        effort: 'low',
        pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
        maxOutputTokens: 4000,
        // Strop jednoho volání jako `WORLDSMITH_FALLBACK_TIMEOUT_MS` v produkci (výchozí 120 s), stejně jako P29B T9.
        timeoutMs: 120_000,
        profile: 'subscription',
        callCap: null,
      }
    : null;
  if (!up) console.log(`model not reachable at ${endpoint}/health – measuring the draft side only`);
  await loadRapier();

  const corpus = (readJson('evals', 'play', 'fidelity', 'corpus.json') as { readonly sentences: readonly Sentence[] }).sentences;
  const dev = (readJson('evals', 'play', 'p30', 'dev.json') as { readonly sentences: readonly (Sentence & { readonly source: string })[] }).sentences.filter((sentence) => sentence.source === 'dev');
  const mechanics = (readJson('evals', 'play', 'p36', 'mechanics.json') as { readonly sentences: readonly MechanicSentence[] }).sentences;

  const report: Record<string, unknown> = {
    about: 'P36A T9: compact director with the depth fields (lives, targetScore, timeLimit, enemyMoves) on a local model; corpus = evals/play/fidelity/corpus.json (30), dev = d01-d20 of evals/play/p30/dev.json, mechanics = evals/play/p36/mechanics.json. See evals/play/p36/README.md.',
    measuredAt: new Date().toISOString(),
    commit: execFileSync('git', ['--no-replace-objects', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    model,
    endpoint,
    director: up ? 'measured' : `not measured – no model at ${endpoint}`,
    sizes: {
      compactPromptBytes: Buffer.byteLength(compactSystemPrompt()),
      fullPromptBytes: Buffer.byteLength(directorSystemPrompt()),
      answerSchemaBytes: Buffer.byteLength(JSON.stringify(GENRE_ANSWER_SCHEMA)),
      promptVersion: COMPACT_PROMPT_VERSION,
    },
  };
  // Zápis po každé sadě: na vytížené kartě trvá věta desítky sekund a přerušený běh nemá přijít o hotové sady.
  const save = () => writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
  report.corpus = await measureSet(corpus, config);
  save();
  report.dev = await measureSet(dev, config);
  save();
  report.mechanics = await measureMechanics(mechanics, config);
  save();
}, 3 * 60 * 60_000);
