#!/usr/bin/env node
/**
 * Sada věrnosti `/play` (P26 T1): věta → návrh a AI verze → snímky → tři čísla.
 *
 * - **úspěšnost vylepšení** – kolik vět dostalo AI verzi;
 * - **věrnost ve specifikaci** – podíl položek kontrolního seznamu, které
 *   spec nese *a* ovládání je podle `src/play/capabilities.ts` čte;
 * - **poznatelnost na snímku** – model s obrázkem (`codex exec -i`) odpoví
 *   ano/ne na každou položku; soudí jen plátno, text stránky je skrytý.
 *
 * Kontrolní seznam každé věty je v `evals/play/fidelity/corpus.json`, psaný
 * předem: 2–4 podstatná jména a jedno sloveso.
 *
 * Kroky jdou pouštět zvlášť a běh jde přerušit – hotová věta se přeskočí
 * (Node 22 potřebuje `--experimental-strip-types` kvůli tabulce v TypeScriptu):
 *   node --experimental-strip-types scripts/play-fidelity.mjs run    [--base http://127.0.0.1:3100] [--run <id>] [--only s039,h01]
 *   node --experimental-strip-types scripts/play-fidelity.mjs judge  [--run <id>]
 *   node --experimental-strip-types scripts/play-fidelity.mjs report [--run <id>]
 *
 * Offline mapa ztrát (P27A T2) – slovní draft a kompilace bez sítě a bez
 * modelu, zapíše `evals/play/fidelity/draft-chain.json`:
 *   node --experimental-strip-types scripts/play-fidelity.mjs --offline
 *
 * Server musí být `next start` se živou větví a
 * `PLAY_DIRECTOR_CALLS_PER_CALLER` ≥ 30, jinak denní strop volajícího utne běh
 * po dvanácti větách. Snímky a surová data leží v `evals/play/fidelity/runs/`
 * (gitignored), commituje se `report.json`.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Řetěz věrnosti (P27A T1) je modul aplikace: holý Node ho načte přes zavaděč
// `ts-paths.mjs` (cesty `@/`, přípony, JSON), vitest sám.
if (!process.env.VITEST) await import('./ts-paths.mjs');
const { fidelityChain } = await import('../src/play/fidelity/chain.ts');
const { draftGameSpec } = await import('../src/play/draft/index.ts');
const { compileGame } = await import('../src/play/compile/index.ts');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'evals', 'play', 'fidelity');

export const SLOTS = ['hero', 'role', 'any', 'setting', 'verb'];

/** Nálezy nad korpusem; prázdné pole = korpus platí. */
export function checkCorpus(corpus) {
  const issues = [];
  const seen = new Set();
  for (const sentence of corpus.sentences ?? []) {
    const where = sentence.id ?? '(no id)';
    if (seen.has(where)) issues.push(`${where}: duplicate id`);
    seen.add(where);
    if (typeof sentence.text !== 'string' || sentence.text.trim() === '') issues.push(`${where}: no text`);
    const list = Array.isArray(sentence.checklist) ? sentence.checklist : [];
    const nouns = list.filter((entry) => entry.slot !== 'verb');
    const verbs = list.filter((entry) => entry.slot === 'verb');
    if (nouns.length < 2 || nouns.length > 4) issues.push(`${where}: ${nouns.length} nouns, needs 2–4`);
    if (verbs.length !== 1) issues.push(`${where}: ${verbs.length} verbs, needs exactly 1`);
    for (const entry of list) {
      if (!SLOTS.includes(entry.slot)) issues.push(`${where}/${entry.item}: unknown slot ${entry.slot}`);
      if (entry.slot === 'verb' && !Array.isArray(entry.controls)) issues.push(`${where}/${entry.item}: a verb needs controls`);
      if (entry.slot !== 'verb' && !(Array.isArray(entry.match) && entry.match.length > 0)) issues.push(`${where}/${entry.item}: a noun needs match words`);
    }
  }
  if (seen.size === 0) issues.push('corpus has no sentences');
  return issues;
}

/**
 * Položky seznamu nad jedním specem (`src/play/fidelity/chain.ts`): `inSpec` =
 * spec ji nese, `read` = nese ji místem, které ovládání čte, `drawn` = scéna ji
 * nakreslí. `score` = podíl `read`, `drawnScore` = podíl `drawn`.
 */
export function specFidelity(spec, checklist) {
  const items = fidelityChain(spec, checklist);
  const share = (pick) => (items.length === 0 ? 0 : Math.round((items.filter(pick).length / items.length) * 1000) / 1000);
  return { control: spec.control ?? 'tap_go', items, score: share((item) => item.read), drawnScore: share((item) => item.drawn) };
}

const mean = (values) => (values.length === 0 ? null : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000);
const quantile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

/** Verze, kterou hráč uvidí: AI verze, když vznikla, jinak návrh. */
const finalOf = (result) => (result.ai ? 'ai' : 'draft');

/** Poznatelnost jedné verze po slotech: `{ items, hero, setting }` jako `{ hit, of }`. */
function recognition(results, pick) {
  const tally = { items: { hit: 0, of: 0 }, hero: { hit: 0, of: 0 }, setting: { hit: 0, of: 0 }, judged: 0 };
  for (const result of results) {
    const version = pick(result);
    const verdict = version && result.judge?.[version];
    if (!verdict) continue;
    tally.judged += 1;
    for (const entry of result.checklist) {
      tally.items.of += 1;
      if (verdict[entry.item] === true) tally.items.hit += 1;
    }
    for (const slot of ['hero', 'setting']) {
      const entries = result.checklist.filter((entry) => entry.slot === slot);
      if (entries.length === 0) continue;
      tally[slot].of += 1;
      if (entries.every((entry) => verdict[entry.item] === true)) tally[slot].hit += 1;
    }
  }
  return tally;
}

/** Výsledky vět → metriky reportu. Chybějící část (nesouzený snímek) se počítá jako `judged` menší než `n`. */
export function summarize(results) {
  const ready = results.filter((result) => result.ai);
  const reasons = {};
  for (const result of results) {
    if (result.ai) continue;
    const reason = result.upgrade?.reason ?? result.upgrade?.status ?? 'UNKNOWN';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  const upgradeSeconds = results.map((result) => result.upgrade?.ms).filter((ms) => typeof ms === 'number').map((ms) => ms / 1000);
  const draftMs = results.map((result) => result.draft?.ms).filter((ms) => typeof ms === 'number');
  return {
    n: results.length,
    upgradeSuccess: { ok: ready.length, of: results.length, failures: reasons },
    specFidelity: {
      final: mean(results.map((result) => specFidelity(result[finalOf(result)].spec, result.checklist).score)),
      draft: mean(results.map((result) => specFidelity(result.draft.spec, result.checklist).score)),
      ai: mean(ready.map((result) => specFidelity(result.ai.spec, result.checklist).score)),
      inSpecFinal: mean(results.map((result) => {
        const items = specFidelity(result[finalOf(result)].spec, result.checklist).items;
        return items.filter((item) => item.inSpec).length / items.length;
      })),
      // P27A T1: podíl položek, které scéna nakreslí – vedle `inSpec` a `read`, nenahrazuje je.
      drawnFinal: mean(results.map((result) => specFidelity(result[finalOf(result)].spec, result.checklist).drawnScore)),
    },
    recognizable: {
      final: recognition(results, finalOf),
      draft: recognition(results, () => 'draft'),
    },
    timing: {
      draftMsP50: quantile(draftMs, 0.5),
      upgradeSecondsP50: quantile(upgradeSeconds, 0.5),
      upgradeSecondsP90: quantile(upgradeSeconds, 0.9),
    },
  };
}

// ---------------------------------------------------------------- offline mapa ztrát (P27A T2)

/** Kolik příčin ztráty mapa vypíše. */
const CAUSES = 5;

const share = (hit, of) => (of === 0 ? 0 : Math.round((hit / of) * 1000) / 1000);

/**
 * Korpus přes slovní draft a kompilaci, bez sítě: každá položka se všemi
 * stupni řetězu, souhrn a nejčetnější příčiny ztráty (`why` × ovládání × slot)
 * podle počtu postižených vět. Deterministické – časové razítko přidá až zápis.
 */
export function offlineChain(sentences) {
  const rows = sentences.map((sentence) => {
    const spec = draftGameSpec(sentence.text);
    return {
      id: sentence.id,
      text: sentence.text,
      control: spec.control ?? 'tap_go',
      addons: spec.addons ?? [],
      compiled: compileGame(spec, 1).ok,
      items: fidelityChain(spec, sentence.checklist),
    };
  });
  const items = rows.flatMap((row) => row.items);
  const count = (pick) => items.filter(pick).length;
  const groups = new Map();
  for (const row of rows) {
    for (const item of row.items) {
      if (item.why === 'ok') continue;
      const key = `${item.why}|${row.control}|${item.slot}`;
      const group = groups.get(key) ?? { why: item.why, control: row.control, slot: item.slot, ids: new Set() };
      group.ids.add(row.id);
      groups.set(key, group);
    }
  }
  const causes = [...groups.values()]
    .map((group) => ({ why: group.why, control: group.control, slot: group.slot, sentences: group.ids.size, ids: [...group.ids].sort() }))
    .sort((a, b) => b.sentences - a.sentences || `${a.why}|${a.control}|${a.slot}`.localeCompare(`${b.why}|${b.control}|${b.slot}`))
    .slice(0, CAUSES);
  return {
    summary: {
      sentences: rows.length,
      compiled: rows.filter((row) => row.compiled).length,
      items: items.length,
      inSpec: share(count((item) => item.inSpec), items.length),
      read: share(count((item) => item.read), items.length),
      drawn: share(count((item) => item.drawn), items.length),
    },
    causes,
    sentences: rows,
  };
}

function offline() {
  const body = offlineChain(loadCorpus());
  const header = {
    about: 'P27A T2 offline loss map: the fidelity corpus through the word draft and the compiler, no network, no model. See README.md.',
    measuredAt: new Date().toISOString(),
    commit: commit(),
  };
  writeJson(join(DIR, 'draft-chain.json'), { header, ...body });
  console.log(JSON.stringify({ summary: body.summary, causes: body.causes.map((cause) => `${cause.sentences}× ${cause.why} ${cause.control}/${cause.slot}`) }, null, 1));
}

// ---------------------------------------------------------------- běh

function args() {
  const out = { _: [] };
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1]?.startsWith('--') === false ? list[++i] : true;
    else out._.push(list[i]);
  }
  return out;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
const commit = () => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function loadCorpus(only) {
  const corpus = readJson(join(DIR, 'corpus.json'));
  const issues = checkCorpus(corpus);
  if (issues.length > 0) throw new Error(`corpus.json is invalid:\n${issues.join('\n')}`);
  const ids = typeof only === 'string' ? new Set(only.split(',')) : null;
  return corpus.sentences.filter((sentence) => ids === null || ids.has(sentence.id));
}

async function gameOf(base, id) {
  const body = await (await fetch(`${base}/api/play/games/${id}`, { cache: 'no-store' })).json();
  return body.game ?? body;
}

async function shoot(page, base, id, path) {
  await page.goto(`${base}/play/${id}`);
  await page.locator('canvas').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${path}.png` });
  // Soudce vidí jen scénu: text stránky (název, věta, HUD) by mu napověděl.
  await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${path}-scene.png` });
}

async function runOne(sentence, base, runDir, page) {
  const started = Date.now();
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: sentence.text }) });
  const created = await response.json();
  const draftMs = Date.now() - started;
  if (!created.versionId) throw new Error(`${sentence.id}: POST ${response.status} ${JSON.stringify(created).slice(0, 200)}`);
  let upgrade;
  for (;;) {
    await sleep(4000);
    upgrade = await (await fetch(`${base}/api/play/games/${created.versionId}/upgrade`, { cache: 'no-store' })).json();
    if (upgrade.status !== 'pending') break;
    if (Date.now() - started > 330_000) {
      upgrade = { status: 'timeout' };
      break;
    }
  }
  const upgradeMs = Date.now() - started;
  const draft = await gameOf(base, created.versionId);
  const ai = upgrade.versionId ? await gameOf(base, upgrade.versionId) : null;
  // Surová odpověď modelu existuje, jen když ji server zapsal (P26 T3).
  const failure = join(ROOT, 'data', 'play', 'failures', `${created.versionId}.json`);
  const result = {
    id: sentence.id,
    text: sentence.text,
    source: sentence.source,
    checklist: sentence.checklist,
    draft: { versionId: created.versionId, ms: draftMs, spec: draft.spec },
    upgrade: { ...upgrade, ms: upgradeMs },
    ai: ai ? { versionId: upgrade.versionId, spec: ai.spec } : null,
    raw: existsSync(failure) ? readJson(failure) : null,
  };
  await shoot(page, base, created.versionId, join(runDir, `${sentence.id}-draft`));
  if (ai) await shoot(page, base, upgrade.versionId, join(runDir, `${sentence.id}-ai`));
  return result;
}

async function run(options) {
  const base = options.base ?? 'http://127.0.0.1:3100';
  const runId = options.run ?? `${new Date().toISOString().slice(0, 10)}-${commit()}`;
  const runDir = join(DIR, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const require = createRequire(import.meta.url);
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    for (const sentence of loadCorpus(options.only)) {
      const path = join(runDir, `${sentence.id}.json`);
      if (existsSync(path)) continue;
      const result = await runOne(sentence, base, runDir, page);
      writeJson(path, result);
      console.log(`${sentence.id} ${result.ai ? 'ai' : `draft (${result.upgrade.reason ?? result.upgrade.status})`} ${Math.round(result.upgrade.ms / 1000)} s`);
    }
  } finally {
    await browser.close();
  }
  console.log(`run ${runId} -> ${runDir}`);
}

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['item', 'visible', 'why'], properties: { item: { type: 'string' }, visible: { type: 'boolean' }, why: { type: 'string' } } },
    },
  },
};

function contract(checklist) {
  const nouns = checklist.filter((entry) => entry.slot !== 'verb').map((entry) => `- "${entry.item}" (${entry.slot === 'setting' ? 'place / environment' : 'character or object'})`);
  const verbs = checklist.filter((entry) => entry.slot === 'verb').map((entry) => `- "${entry.item}" (action)`);
  return [
    'You are judging one screenshot of a 3D game scene. You know nothing else about the game.',
    'Do not use web search. Do not run any tool, command or skill. Look only at the attached image.',
    '',
    'For each item below decide `visible`:',
    '- true only if a person who read no description would, from the picture alone, name that thing or clearly recognise it;',
    '- a generic figure, a cube, a capsule, a target board, a coloured blob or a plain field does NOT count as a specific character, object or place;',
    '- a place counts only if the environment itself looks like it (a mall interior, snow, Mars red rocks), not if it is a neutral ground plane;',
    '- an action counts only if the picture shows that this is what the game is about (for "shoot": a gun, a crosshair or projectiles);',
    '- when unsure, answer false.',
    '',
    'Items:',
    ...nouns,
    ...verbs,
    '',
    'Answer with JSON only: {"items":[{"item":"<item exactly as written>","visible":true|false,"why":"<at most 12 words>"}]}.',
  ].join('\n');
}

function codexScript() {
  return process.env.WORLDSMITH_CODEX_JS ?? (process.platform === 'win32' ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : 'codex');
}

function judgeShot(image, checklist, runDir, tag) {
  const contractPath = join(runDir, `${tag}-judge.md`);
  const schemaPath = join(runDir, 'judge-schema.json');
  const outPath = join(runDir, `${tag}-judge.out`);
  writeFileSync(contractPath, contract(checklist));
  writeJson(schemaPath, JUDGE_SCHEMA);
  const script = codexScript();
  const command = script.endsWith('.js') ? [process.execPath, script] : [script];
  const model = process.env.FIDELITY_JUDGE_MODEL;
  const cli = [
    ...command.slice(1),
    'exec',
    '--skip-git-repo-check',
    '-s', 'read-only',
    '-c', 'tools.web_search=false',
    '-c', 'model_reasoning_effort="medium"',
    ...(model ? ['-m', model] : []),
    `--image=${image}`,
    '--output-schema', schemaPath,
    '-o', outPath,
    `Read the file ${contractPath} and do exactly what it says.`,
  ];
  const done = spawnSync(command[0], cli, { cwd: runDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000, encoding: 'utf8' });
  if (!existsSync(outPath)) throw new Error(`${tag}: codex wrote no answer (exit ${done.status}): ${(done.stderr ?? '').slice(-400)}`);
  const text = readFileSync(outPath, 'utf8');
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const verdict = {};
  for (const entry of checklist) verdict[entry.item] = json.items.some((answer) => answer.item.toLowerCase() === entry.item.toLowerCase() && answer.visible === true);
  return { verdict, answers: json.items };
}

function judge(options) {
  const runDir = latestRun(options.run);
  for (const file of readdirSync(runDir).filter((name) => /^[a-z]\d+\.json$/.test(name))) {
    const path = join(runDir, file);
    const result = readJson(path);
    result.judge ??= {};
    result.judgeWhy ??= {};
    for (const version of ['draft', 'ai']) {
      if (version === 'ai' && !result.ai) continue;
      if (result.judge[version]) continue;
      const image = join(runDir, `${result.id}-${version}-scene.png`);
      const { verdict, answers } = judgeShot(image, result.checklist, runDir, `${result.id}-${version}`);
      result.judge[version] = verdict;
      result.judgeWhy[version] = answers;
      writeJson(path, result);
      console.log(`${result.id} ${version}: ${Object.values(verdict).filter(Boolean).length}/${result.checklist.length}`);
    }
  }
}

function latestRun(run) {
  const runs = join(DIR, 'runs');
  if (typeof run === 'string') return join(runs, run);
  const names = readdirSync(runs).sort();
  if (names.length === 0) throw new Error('no run yet – start with `run`');
  return join(runs, names.at(-1));
}

function report(options) {
  const runDir = latestRun(options.run);
  const runId = runDir.split(/[\\/]/).at(-1);
  const results = readdirSync(runDir)
    .filter((name) => /^[a-z]\d+\.json$/.test(name))
    .map((name) => readJson(join(runDir, name)));
  const metrics = summarize(results);
  const path = join(DIR, 'report.json');
  const previous = existsSync(path) ? readJson(path) : { runs: [] };
  const entry = { runId, measuredAt: new Date().toISOString(), commit: commit(), note: typeof options.note === 'string' ? options.note : undefined, metrics };
  const sentences = results.map((result) => {
    const version = finalOf(result);
    return {
      id: result.id,
      text: result.text,
      controls: { draft: result.draft.spec.control ?? 'tap_go', ai: result.ai ? (result.ai.spec.control ?? 'tap_go') : null },
      upgrade: result.ai ? 'ai' : (result.upgrade.reason ?? result.upgrade.status),
      upgradeSeconds: Math.round(result.upgrade.ms / 1000),
      fidelity: { draft: specFidelity(result.draft.spec, result.checklist).score, ai: result.ai ? specFidelity(result.ai.spec, result.checklist).score : null },
      recognized: result.judge?.[version] ? Object.entries(result.judge[version]).filter(([, seen]) => seen).map(([item]) => item) : null,
      missing: specFidelity(result[version].spec, result.checklist).items.filter((item) => !item.read).map((item) => `${item.item}${item.inSpec ? ' (in spec, not read)' : ''}`),
    };
  });
  writeJson(path, { runs: [...previous.runs.filter((old) => old.runId !== runId), entry], latest: { runId, sentences } });
  console.log(JSON.stringify(metrics, null, 1));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = args();
  const step = options._[0];
  if (options.offline) offline();
  else if (step === 'run') await run(options);
  else if (step === 'judge') judge(options);
  else if (step === 'report') report(options);
  else {
    console.error('usage: node scripts/play-fidelity.mjs run|judge|report [--run <id>] [--base <url>] [--only <ids>] [--note <text>] | --offline');
    process.exit(2);
  }
}
