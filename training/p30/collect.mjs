/**
 * Sběr SFT sady P30C T3 (expert iteration, jedna generace).
 *
 * Pro každou trénovací větu (`evals/play/train/sentences.jsonl`) napíše lokální
 * gpt-oss-20b K kandidátů produkční cestou: `direct(…, { compact: true })`
 * s produkčním promptem a čtením odpovědi, jen bez opravných kol – učí se
 * první odpověď. Kandidát 0 je produkční nastavení (teplota 0), další vzorkují
 * s vlastním semínkem. Kandidáta, kterého režisér přijal bez náhradního
 * důvodu, zkontroluje robot publikace (`playabilityIssues` na semínkách jako
 * dveře `/api/play/games`) a ohodnotí offline řetěz věrnosti nad kontrolním
 * seznamem věty. Do sady jde nejlepší kandidát, který robotem prošel
 * (`read + drawn`, pak `inSpec`, pak nižší K).
 *
 * Model je jen lokální llama.cpp na loopbacku s gpt-oss-20b – jiný koncový bod
 * skript odmítne (podmínky OpenAI: výstupy astry se na trénink nesmí použít).
 * Stav po každé větě do `collect-state.json`; nový běh naváže.
 *
 *   node --experimental-strip-types training/p30/collect.mjs [--key-file <soubor s klíčem llama-server>]
 *     [--endpoint http://127.0.0.1:8792] [--k 4] [--temperature 0.8] [--limit N] [--build-only]
 *
 * Výstup: `sft.jsonl` (chat formát pro gpt-oss, `source: "gpt-oss-20b-local"`)
 * a `collect-report.json` (každý kandidát bez textu odpovědi) v `evals/play/train/`.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

await import('./loader.mjs');
const { direct } = await import('../../src/play/director/index.ts');
const { COMPACT_PROMPT_VERSION } = await import('../../src/play/director/compact.ts');
const { upstreamBranch } = await import('../../src/server/upstream.ts');
const { derivedSeeds, playabilityIssues, seedFrom } = await import('../../src/app/api/play/_publish.ts');
const { preloadPhysics } = await import('../../src/play/arcade/compile.ts');
const { fidelityChain } = await import('../../src/play/fidelity/chain.ts');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TRAIN = join(ROOT, 'evals', 'play', 'train');
const STATE = join(TRAIN, 'collect-state.json');
const SOURCE = 'gpt-oss-20b-local';

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : (process.argv[at + 1] ?? fallback);
}
const flag = (name) => process.argv.includes(`--${name}`);

const endpoint = arg('endpoint', 'http://127.0.0.1:8792').replace(/\/+$/, '');
const K = Number(arg('k', '4'));
const TEMPERATURE = Number(arg('temperature', '0.8'));
const LIMIT = arg('limit') === null ? Infinity : Number(arg('limit'));
const keyFile = arg('key-file');
const apiKey = keyFile === null ? '' : readFileSync(keyFile, 'utf8').trim();

const sentences = readFileSync(join(TRAIN, 'sentences.jsonl'), 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
/** Semínko vzorkování kandidáta: deterministicky z věty a pořadí, 1..2^31−1. */
const seedOf = (id, k) => (fnv1a(`${id}:${String(k)}`) % 0x7ffffffe) + 1;

const writeJson = (path, value) => {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(`${path}.tmp`, path);
};

/** Jen gpt-oss-20b na loopbacku; cokoli jiného by do sady pustilo cizí model. */
async function localModel() {
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error(`refusing ${endpoint}: only a loopback llama.cpp may write training data`);
  const headers = apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` };
  const response = await fetch(`${endpoint}/v1/models`, { headers });
  if (!response.ok) throw new Error(`${endpoint}/v1/models answered ${String(response.status)}`);
  const id = (await response.json())?.data?.[0]?.id;
  if (typeof id !== 'string' || !/gpt-oss-20b/i.test(id)) throw new Error(`refusing model ${String(id)}: the training data must come from gpt-oss-20b`);
  return basename(id);
}

async function healthy() {
  try {
    return (await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5_000) })).ok;
  } catch {
    return false;
  }
}

/** Větev llama.cpp s produkčním transportem; mění jen vzorkování a zachytí, co model viděl a napsal. */
function samplingBranch(model, sampling, seen) {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.system = body.messages[0].content;
    seen.user = body.messages[1].content;
    const response = await fetch(url, { ...init, body: JSON.stringify({ ...body, ...sampling }) });
    if (response.ok) {
      const payload = await response.clone().json();
      const message = payload?.choices?.[0]?.message ?? {};
      seen.content = typeof message.content === 'string' ? message.content : null;
      seen.thinking = typeof message.reasoning_content === 'string' ? message.reasoning_content : null;
      seen.completionTokens = payload?.usage?.completion_tokens ?? null;
    }
    return response;
  };
  return upstreamBranch(
    {
      endpoint: `llamacpp:${endpoint}`,
      apiKey,
      model,
      effort: 'low',
      pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
      maxOutputTokens: 4000,
      timeoutMs: 120_000,
      profile: 'subscription',
      callCap: null,
    },
    fetchImpl,
  );
}

function scoreOf(spec, checklist) {
  const items = fidelityChain(spec, checklist);
  const count = (pick) => items.filter(pick).length;
  return { items: items.length, inSpec: count((item) => item.inSpec), read: count((item) => item.read), drawn: count((item) => item.drawn) };
}

async function candidate(model, sentence, k) {
  const seed = seedOf(sentence.id, k);
  const temperature = k === 0 ? 0 : TEMPERATURE;
  const seen = {};
  const started = performance.now();
  const directed = await direct(sentence.text, { branch: samplingBranch(model, { temperature, seed }, seen), now: Date.now, compact: true, maxRepairRounds: 0 });
  const ms = Math.round(performance.now() - started);
  const row = {
    k,
    seed,
    temperature,
    ms,
    source: directed.source,
    fallbackReason: directed.fallbackReason,
    control: directed.spec.control ?? 'tap_go',
    completionTokens: seen.completionTokens ?? null,
    robot: null,
    score: scoreOf(directed.spec, sentence.checklist),
  };
  if (directed.source !== 'authored' || directed.fallbackReason !== null) return row;
  await preloadPhysics(directed.spec);
  const issues = playabilityIssues(directed.spec, derivedSeeds(seedFrom(sentence.text.trim())));
  row.robot = issues.length === 0 ? 'pass' : [...new Set(issues.map((issue) => issue.code))].join(',');
  if (row.robot === 'pass') Object.assign(row, { system: seen.system, user: seen.user, content: seen.content, thinking: seen.thinking });
  return row;
}

const rank = (row) => [row.score.read + row.score.drawn, row.score.inSpec, -row.k];
function best(candidates) {
  let chosen = null;
  for (const row of candidates) {
    if (row.robot !== 'pass' || typeof row.content !== 'string') continue;
    if (chosen === null) chosen = row;
    else {
      const [a, b] = [rank(row), rank(chosen)];
      const better = a.findIndex((value, i) => value !== b[i]);
      if (better >= 0 && a[better] > b[better]) chosen = row;
    }
  }
  return chosen;
}

function build(state) {
  const rows = [];
  const report = [];
  for (const sentence of sentences) {
    const done = state.sentences[sentence.id];
    if (done === undefined) continue;
    const chosen = best(done.candidates);
    report.push({
      id: sentence.id,
      family: sentence.family,
      chosen: chosen?.k ?? null,
      candidates: done.candidates.map(({ system: _s, user: _u, content: _c, thinking: _t, ...rest }) => rest),
    });
    if (chosen === null) continue;
    const assistant = chosen.thinking === null ? { role: 'assistant', content: chosen.content } : { role: 'assistant', content: chosen.content, thinking: chosen.thinking };
    rows.push({
      id: sentence.id,
      source: SOURCE,
      model: state.model,
      endpoint: state.endpoint,
      seed: chosen.seed,
      temperature: chosen.temperature,
      candidate: chosen.k,
      promptVersion: state.promptVersion,
      family: sentence.family,
      control: chosen.control,
      score: chosen.score,
      messages: [{ role: 'system', content: chosen.system }, { role: 'user', content: chosen.user }, assistant],
    });
  }
  writeFileSync(join(TRAIN, 'sft.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''));

  const all = report.flatMap((entry) => entry.candidates);
  const passed = (pick) => all.filter((row) => pick(row) && row.robot === 'pass').length;
  const ms = all.map((row) => row.ms).sort((a, b) => a - b);
  const tally = (values) => Object.fromEntries([...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]));
  const summary = {
    sentences: report.length,
    withPassingCandidate: rows.length,
    candidates: all.length,
    robotPass: { greedy: `${String(passed((row) => row.k === 0))}/${String(all.filter((row) => row.k === 0).length)}`, sampled: `${String(passed((row) => row.k > 0))}/${String(all.filter((row) => row.k > 0).length)}` },
    fallbackReasons: tally(all.filter((row) => row.fallbackReason !== null).map((row) => row.fallbackReason)),
    robotFailures: tally(all.filter((row) => row.robot !== null && row.robot !== 'pass').map((row) => row.robot)),
    chosenFrom: tally(rows.map((row) => (row.candidate === 0 ? 'greedy' : 'sampled'))),
    msP50: ms[Math.floor(ms.length / 2)] ?? null,
    msP90: ms[Math.floor(ms.length * 0.9)] ?? null,
    chosenControls: tally(rows.map((row) => row.control)),
    families: Object.fromEntries(Object.entries(tally(report.map((entry) => entry.family))).map(([family, count]) => [family, `${String(rows.filter((row) => row.family === family).length)}/${String(count)}`])),
    chosenScore: rows.reduce((sum, row) => ({ items: sum.items + row.score.items, inSpec: sum.inSpec + row.score.inSpec, read: sum.read + row.score.read, drawn: sum.drawn + row.score.drawn }), { items: 0, inSpec: 0, read: 0, drawn: 0 }),
  };
  writeJson(join(TRAIN, 'collect-report.json'), {
    about: 'P30C T3: K candidates per training sentence from the local gpt-oss-20b (compact director, no repair rounds), robot of /api/play/games, offline fidelity chain. Text of the answers lives in sft.jsonl (chosen) and the ignored collect-state.json. See README.md.',
    model: state.model,
    endpoint: state.endpoint,
    promptVersion: state.promptVersion,
    k: state.k,
    temperature: state.temperature,
    summary,
    sentences: report,
  });
  return summary;
}

async function main() {
  const model = await localModel();
  const fresh = { endpoint: `llamacpp:${endpoint}`, model, promptVersion: COMPACT_PROMPT_VERSION, k: K, temperature: TEMPERATURE };
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { ...fresh, sentences: {} };
  for (const key of Object.keys(fresh)) {
    if (state[key] !== fresh[key]) throw new Error(`collect-state.json was made with ${key}=${String(state[key])}, this run has ${String(fresh[key])}; move it away to start over`);
  }
  if (!flag('build-only')) {
    let ran = 0;
    for (const sentence of sentences) {
      if (state.sentences[sentence.id] !== undefined) continue;
      if (ran >= LIMIT) break;
      const candidates = [];
      for (let k = 0; k < K; k += 1) {
        const row = await candidate(model, sentence, k);
        // Bez odpovědi věta není změřená, ne neúspěšná: neuloží se a příští běh ji zkusí znovu.
        // Model živý, ale pomalý = karta obsazená jinou prací (měřeno 27. 9.: ComfyUI, 13 kandidátů po 120 s).
        if (row.fallbackReason === 'MODEL_UNAVAILABLE') {
          writeJson(STATE, state);
          const why = (await healthy()) ? 'answers /health but not in time (GPU busy?)' : 'stopped answering';
          console.error(`HALT: ${endpoint} ${why} at ${sentence.id} k=${String(k)}; ${sentence.id} not saved, rerun to resume`);
          process.exit(3);
        }
        candidates.push(row);
      }
      state.sentences[sentence.id] = { candidates };
      writeJson(STATE, state);
      ran += 1;
      const chosen = best(candidates);
      console.log(`${sentence.id} ${sentence.family} ${candidates.map((row) => `${row.robot === 'pass' ? '+' : '-'}${String(Math.round(row.ms / 1000))}s`).join(' ')} -> ${chosen === null ? 'none' : `k${String(chosen.k)} ${chosen.control}`} (${String(Object.keys(state.sentences).length)}/${String(sentences.length)})`);
    }
  }
  console.log(JSON.stringify(build(state), null, 1));
}

await main();
