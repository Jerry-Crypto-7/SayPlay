/**
 * P73C T1: how much of the director's time is its answer schema.
 *
 * Every sentence of `evals/play/p73/reziser/sentences.txt` (never run before, so no director cache) goes to the
 * director's first call in two variants, interleaved A,B / B,A per sentence:
 *   (a) `full`   – today's schema, exactly as `upstream.ts` sends it (`codexSchemaOf`: recipe schema, strict);
 *   (b) `narrow` – the same schema with every choice list (enum) cut to what the sentence's words, its intent and
 *                  the quick version's recipe name, plus safe defaults, at most 30 values each.
 * Optional `--ceiling N`: the first N sentences once more with no schema at all (c), the upper bound of what any
 * schema change could save.
 *
 * The call runs through the real `direct()` with a branch that spawns `codex exec` itself, so each JSON event of
 * the turn gets a timestamp; `maxRepairRounds: 0` makes the verdict "the first answer passed reading, the critic
 * and the robot" without a repair round. `codex exec --json` does not stream tokens: "first output" is the first
 * item event of the turn (a reasoning or message item), the closest observable stand-in for time to first token.
 *
 * Provider: Groq when `GROQ_API_KEY` is set (not implemented – the run writes `reached:false`), else the codex-cli
 * subscription path of `.claude/start-demo.cmd` (model gpt-6-astra, effort medium). Subscription calls cost no
 * dollars; they are not Groq numbers and the report says so.
 *
 * Usage: node --experimental-strip-types --no-warnings scripts/play/p73-schema-latency.mjs [--limit N] [--ceiling N] [--parallel 2]
 * Writes evals/play/p73/reziser/latency.json (raw) and prints EXIT=0 when done.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('../ts-paths.mjs', import.meta.url);

const { direct } = await import('../../src/play/director/index.ts');
const { codexArgs, openaiStrictSchema, CODEX_SCHEMA_FILE } = await import('../../src/server/upstream.ts');
const { extractIntent } = await import('../../src/play/intent/extract.ts');
const { compose } = await import('../../src/play/compose/compose.ts');

const ROOT = new URL('../../', import.meta.url);
const OUT_DIR = new URL('evals/play/p73/reziser/', ROOT);
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const LIMIT = arg('limit', Infinity);
const CEILING = arg('ceiling', 0);
const PARALLEL = arg('parallel', 2);
const MODEL = process.env.WORLDSMITH_MODEL ?? 'gpt-6-astra';
const EFFORT = process.env.WORLDSMITH_MODEL_EFFORT ?? 'medium';
const TIMEOUT_MS = 240_000;
const MAX_ENUM = 30;

const sentences = readFileSync(new URL('sentences.txt', OUT_DIR), 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, LIMIT);

// ---- (b) the narrowed schema -------------------------------------------------------------------------------------

const stem = (word) => word.toLowerCase().replace(/[^a-z_]/g, '').replace(/(ing|ed|es|s)$/, '');

/** Values a sentence can point at: its words, its intent verbs, the quick version's recipe and look. */
function sentencePicks(sentence) {
  const intent = extractIntent(sentence);
  let recipe = null;
  try {
    recipe = compose(intent, 1, null).recipe;
  } catch {
    recipe = null;
  }
  const picks = new Set(sentence.split(/\s+/).map(stem));
  for (const item of intent.items) picks.add(stem(item.verb));
  if (intent.setting !== null) picks.add(stem(intent.setting));
  for (const value of [recipe?.move, recipe?.objective, ...(recipe?.actions ?? []), ...(recipe?.threats ?? []), recipe?.content?.palette, recipe?.content?.heroAction]) if (typeof value === 'string') picks.add(stem(value));
  return picks;
}

/** Defaults every narrowed list keeps, so the director always has somewhere to fall back. */
const SAFE = new Set(['none', 'collect', 'reach', 'run', 'survive', 'chaser', 'obstacle', 'hero', 'avoid', 'scenery', 'meadow']);

function narrowSchema(schema, sentence) {
  const picks = sentencePicks(sentence);
  let before = 0;
  let after = 0;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node.enum)) {
      before += node.enum.length;
      // Short lists (counters, sides, two-value switches) are structure, not a catalogue: kept whole.
      if (node.enum.length < 8) {
        after += node.enum.length;
        return node;
      }
      const kept = node.enum.filter((value) => typeof value !== 'string' || picks.has(stem(value)) || SAFE.has(value)).slice(0, MAX_ENUM);
      const values = kept.length === 0 ? node.enum.slice(0, 3) : kept;
      after += values.length;
      return { ...node, enum: values };
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value)]));
  };
  const narrowed = walk(schema);
  return { schema: narrowed, enumBefore: before, enumAfter: after };
}

// ---- the measuring codex branch ----------------------------------------------------------------------------------

const ENV_ALLOWLIST = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'CODEX_HOME'];

function codexScript() {
  return process.env.WORLDSMITH_CODEX_JS ?? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
}

/** One `codex exec` with a timestamp on every JSON event. */
function timedCodex(input, schema) {
  const cwd = mkdtempSync(join(tmpdir(), 'p73-codex-'));
  if (schema !== undefined) writeFileSync(join(cwd, CODEX_SCHEMA_FILE), JSON.stringify(schema));
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [codexScript(), ...codexArgs(MODEL, EFFORT, cwd, schema !== undefined)], {
      cwd,
      env: Object.fromEntries(ENV_ALLOWLIST.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
      windowsHide: true,
    });
    const events = [];
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (child.exitCode === null) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === '') continue;
        try {
          events.push({ at: Date.now() - started, event: JSON.parse(line) });
        } catch {
          events.push({ at: Date.now() - started, event: { type: 'unparsed', line: line.slice(0, 200) } });
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        rmSync(cwd, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        /* leftover temp dir */
      }
      resolve({ code, events, stderr: stderr.slice(0, 600), totalMs: Date.now() - started });
    });
  });
}

function timingOf(run) {
  const turnStarted = run.events.find(({ event }) => event.type === 'turn.started')?.at ?? null;
  const firstItem = run.events.find(({ event }) => typeof event.type === 'string' && event.type.startsWith('item.'))?.at ?? null;
  const firstDone = run.events.find(({ event }) => event.type === 'item.completed')?.at ?? null;
  const message = run.events.find(({ event }) => event.type === 'item.completed' && event.item?.type === 'agent_message')?.at ?? null;
  const usage = run.events.find(({ event }) => event.type === 'turn.completed')?.event.usage ?? null;
  const trace = run.events.map(({ at, event }) => `${event.type}${event.item?.type === undefined ? '' : `:${event.item.type}`}@${at}`);
  return { turnStartedMs: turnStarted, firstOutputMs: firstItem, firstItemDoneMs: firstDone, messageMs: message, usage, trace };
}

function measuringBranch(variant, sentence, log) {
  return {
    id: 'upstream',
    pricing: { inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
    worstCaseUsd: () => 0,
    async generate(call) {
      const base = openaiStrictSchema(call.request.codexOutputSchema ?? call.request.outputSchema);
      const narrowed = variant === 'narrow' ? narrowSchema(base, sentence) : null;
      const schema = variant === 'none' ? undefined : (narrowed?.schema ?? base);
      const input = `${call.request.system}\n\n${call.request.user}`;
      const run = await timedCodex(input, schema);
      const timing = timingOf(run);
      log.call = {
        exit: run.code,
        totalMs: run.totalMs,
        ...timing,
        inputChars: input.length,
        schemaChars: schema === undefined ? 0 : JSON.stringify(schema).length,
        ...(narrowed === null ? {} : { enumBefore: narrowed.enumBefore, enumAfter: narrowed.enumAfter }),
        ...(run.code === 0 ? {} : { stderr: run.stderr }),
      };
      const failed = run.events.find(({ event }) => event.type === 'turn.failed' || event.type === 'error');
      if (failed !== undefined) return { ok: false, reason: 'UPSTREAM_REJECTED', detail: JSON.stringify(failed.event).slice(0, 300), usage: null };
      const text = [...run.events].reverse().find(({ event }) => event.type === 'item.completed' && event.item?.type === 'agent_message')?.event.item.text;
      if (typeof text !== 'string') return { ok: false, reason: 'UPSTREAM_UNAVAILABLE', detail: `no message, exit ${run.code}`, usage: null };
      try {
        const body = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, ''));
        log.call.parsed = true;
        return { ok: true, body, usage: null, provenance: { branch: 'upstream', source: 'codex-cli', synthetic: false, model: MODEL } };
      } catch (thrown) {
        log.call.parsed = false;
        return { ok: false, reason: 'MALFORMED_RESPONSE', detail: String(thrown), usage: null, raw: text };
      }
    },
  };
}

async function measure(sentence, variant) {
  const log = { sentence, variant, call: null };
  const started = Date.now();
  const game = await direct(sentence, { branch: measuringBranch(variant, sentence, log), now: Date.now, compact: true, maxRepairRounds: 0, seed: 1 });
  log.directMs = Date.now() - started;
  log.source = game.source;
  log.fallbackReason = game.fallbackReason;
  log.failure = game.failure === undefined ? null : { stage: game.failure.stage, reason: game.failure.reason, detail: String(game.failure.detail).slice(0, 300) };
  // Passed reading = an answer the director could read into a game; passed critic = no fallback to the quick version.
  log.validated = game.failure?.stage !== 'read' && game.failure?.stage !== 'model' && log.call?.parsed === true;
  log.criticPassed = game.source === 'authored' && game.fallbackReason === null;
  return log;
}

// ---- run -----------------------------------------------------------------------------------------------------------

if (process.env.GROQ_API_KEY !== undefined && process.env.GROQ_API_KEY !== '') {
  console.log('GROQ_API_KEY is set, but the Groq path of this script is not implemented; measuring the subscription path.');
}

const jobs = [];
sentences.forEach((sentence, index) => {
  const pair = index % 2 === 0 ? ['full', 'narrow'] : ['narrow', 'full'];
  for (const variant of pair) jobs.push({ sentence, variant });
});
sentences.slice(0, CEILING).forEach((sentence) => jobs.push({ sentence, variant: 'none' }));

const results = [];
const outFile = new URL('latency.json', OUT_DIR);
const save = () => writeFileSync(outFile, `${JSON.stringify({ date: new Date().toISOString(), provider: 'codex-cli (ChatGPT subscription)', groq: { reached: false, reason: 'GROQ_API_KEY not in the environment' }, model: MODEL, effort: EFFORT, results }, null, 2)}\n`);
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const log = await measure(job.sentence, job.variant).catch((thrown) => ({ ...job, error: String(thrown?.stack ?? thrown).slice(0, 400) }));
    results.push(log);
    save();
    console.log(`${results.length}/${jobs.length} ${job.variant.padEnd(6)} ${String(log.call?.totalMs ?? '-').padStart(6)} ms in=${log.call?.usage?.input_tokens ?? '-'} out=${log.call?.usage?.output_tokens ?? '-'} valid=${log.validated} critic=${log.criticPassed} ${log.fallbackReason ?? ''} | ${job.sentence}`);
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));
save();
console.log('EXIT=0');
