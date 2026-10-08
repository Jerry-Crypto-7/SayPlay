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
 *   node --experimental-strip-types scripts/play-fidelity.mjs run    [--base http://127.0.0.1:3100] [--run <id>] [--only s039,h01] [--set judge-10.json]
 *   node --experimental-strip-types scripts/play-fidelity.mjs judge  [--run <id>]
 *   node --experimental-strip-types scripts/play-fidelity.mjs report [--run <id>]
 *   node --experimental-strip-types scripts/play-fidelity.mjs summary [--run <id>]   (souhrn do runs/<id>.json, report.json nechá)
 *
 * Sloveso z klipu (P37A T2): `run --clip` k snímku přidá tři snímky plátna po
 * 0,5 s hry, zatímco hru hraje robot; `judge --clip` je pošle soudci najednou a
 * sloveso soudí podle toho, co se mezi nimi pohne. `run --draft-only` na AI
 * verzi nečeká (baseline návrhu ze slov), `run --gpu` kreslí přes grafickou
 * kartu místo swiftshaderu, `judge --only` dělí soudce na víc procesů.
 *
 * Offline mapa ztrát (P27A T2) – slovní draft a kompilace bez sítě a bez
 * modelu, zapíše `evals/play/fidelity/draft-chain.json`:
 *   node --experimental-strip-types scripts/play-fidelity.mjs --offline [--set dev] [--out evals/play/p39/offline.json]   (P39: `read`, `drawn`, `role` i po žánrech)
 * S `--run <id>` zapíše korpus i zamčenou sadu `judge-10.json` zvlášť do
 * `runs/<id>.json` a `draft-chain.json` nechá (P28D).
 *
 * Férové srovnání modelů (P30A T7) – každý model na vlastním `next start` nad
 * týmž buildem, publikace robotem jako v produkci, první hratelný snímek
 * v prohlížeči, cena za hru; souhrn do `evals/play/p30/compare-<id>.json`:
 *   npm run build && node --experimental-strip-types scripts/play-fidelity.mjs --models astra,oss20b --set dev [--concurrency 2]
 *
 * Server musí být `next start` se živou větví a
 * `PLAY_DIRECTOR_CALLS_PER_CALLER` ≥ 30, jinak denní strop volajícího utne běh
 * po dvanácti větách. Snímky a surová data leží v `evals/play/fidelity/runs/`
 * (gitignored), commituje se `report.json`.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Řetěz věrnosti (P27A T1) je modul aplikace: holý Node ho načte přes zavaděč
// `ts-paths.mjs` (cesty `@/`, přípony, JSON), vitest sám.
if (!process.env.VITEST) await import('./ts-paths.mjs');
const { fidelityChain } = await import('../src/play/fidelity/chain.ts');
const { specFidelity } = await import('../src/play/fidelity/score.ts');
const { draftForControl, draftGameSpec } = await import('../src/play/draft/index.ts');
const { compileGame } = await import('../src/play/compile/index.ts');
const { readSentence } = await import('../src/play/read/client.ts');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'evals', 'play', 'fidelity');
const P30 = join(ROOT, 'evals', 'play', 'p30');
const P44E = join(ROOT, 'evals', 'play', 'p44e');
const P43 = join(ROOT, 'evals', 'play', 'p43');
const P45 = join(ROOT, 'evals', 'play', 'p45');
/** Zapečetěné sady podle `source` věty: kam se zapíše jejich jediné otevření. */
const SEALS = { test: { dir: P30, file: 'test-opened.json' }, 'sealed-p43': { dir: P43, file: 'sealed-opened.json' }, 'sealed-p44e': { dir: P44E, file: 'sealed-opened.json' }, 'sealed-p45': { dir: P45, file: 'sealed-opened.json' } };

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
    // Soudce vrací verdikt podle názvu položky – dvě stejné by se přepsaly.
    if (new Set(list.map((entry) => entry.item)).size !== list.length) issues.push(`${where}: duplicate checklist item`);
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
 * Položky seznamu nad jedním specem: `score` = podíl `read`, `drawnScore` =
 * podíl `drawn`. Jádro je od P37A T8 v `src/play/fidelity/score.ts` – volá ho
 * i brána upgradu na serveru; skript ho jen vystavuje dál.
 */
export { specFidelity };

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
    // Pozdní = hotovo až po `deadlineAt`, kdy se klient přestal ptát; zůstává v `n`.
    late: { any: results.filter((result) => result.upgrade?.late === true).length, ai: ready.filter((result) => result.upgrade?.late === true).length },
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
      drawnDraft: mean(results.map((result) => specFidelity(result.draft.spec, result.checklist).drawnScore)),
      // P39 T2: podíl položek ve správné roli (`ChecklistEntry.does`).
      roleFinal: mean(results.map((result) => specFidelity(result[finalOf(result)].spec, result.checklist).roleScore)),
      roleDraft: mean(results.map((result) => specFidelity(result.draft.spec, result.checklist).roleScore)),
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

/** Ovládání → žánr (P39): hra žánru s generátorem nese žánr v jeho jménu, ostatní ovládáním. */
const CONTROL_GENRE = { runner: 'runner', platform: 'platformer', shooter: 'shooter', throw: 'throw', timing: 'timing', rhythm: 'rhythm', duel: 'duel', flap: 'flap', steer: 'voyage', move_free: 'arena', tap_go: 'grid' };
const GENERATOR_GENRE = { arena_escape: 'arena', arena_collect: 'arena', fight: 'arena', voyage_race: 'voyage', voyage_land: 'voyage', quest_spatial: 'quest', quest_station: 'quest' };

export function genreOfSpec(spec) {
  const generator = spec.controlParams?.generator;
  return GENERATOR_GENRE[generator] ?? CONTROL_GENRE[spec.control ?? 'tap_go'] ?? spec.control;
}

/** `read`, `drawn` a `role` po žánrech (P39 T3): průměr podílů položek přes věty žánru. */
export function stagesByGenre(rows) {
  const groups = new Map();
  for (const row of rows) groups.set(row.genre, [...(groups.get(row.genre) ?? []), row]);
  const mean = (values) => Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
  const part = (row, stage) => (row.items.length === 0 ? 0 : row.items.filter((item) => item[stage]).length / row.items.length);
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([genre, list]) => [genre, { sentences: list.length, read: mean(list.map((row) => part(row, 'read'))), drawn: mean(list.map((row) => part(row, 'drawn'))), role: mean(list.map((row) => part(row, 'role'))) }]),
  );
}

/**
 * Korpus přes slovní draft a kompilaci, bez sítě: každá položka se všemi
 * stupni řetězu, souhrn a nejčetnější příčiny ztráty (`why` × ovládání × slot)
 * podle počtu postižených vět. Deterministické – časové razítko přidá až zápis.
 */
export function offlineChain(sentences, draftOf = (sentence) => draftGameSpec(sentence.text)) {
  const rows = sentences.map((sentence) => {
    const spec = draftOf(sentence);
    return {
      id: sentence.id,
      text: sentence.text,
      genre: genreOfSpec(spec),
      control: spec.control ?? 'tap_go',
      addons: spec.addons ?? [],
      compiled: compileGame(spec, 1).ok,
      items: fidelityChain(spec, sentence.checklist),
    };
  });
  const items = rows.flatMap((row) => row.items);
  const named = sentences.flatMap((sentence, index) => rows[index].items.filter((_, at) => sentence.checklist[at].does !== undefined));
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
      role: share(count((item) => item.role), items.length),
      // Jen věci, kterým sada dala očekávanou roli (`does`) – tam, kde se role může minout.
      roleNamed: share(named.filter((item) => item.role).length, named.length),
    },
    byGenre: stagesByGenre(rows),
    causes,
    sentences: rows,
  };
}

/**
 * `--offline --run <id>` (P28D T1): obě sady zvlášť – 30 vět korpusu a
 * zamčená porotcovská sada `judge-10.json` – do `runs/<id>.json`;
 * `draft-chain.json` zůstane.
 */
function offlineRun(runId) {
  const header = {
    about: 'P28D offline loss map over two sets reported separately: corpus.json (30) and the frozen judge-10.json (10). See README.md.',
    runId,
    measuredAt: new Date().toISOString(),
    commit: commit(),
  };
  const corpus = offlineChain(loadSet());
  const judge10 = offlineChain(loadSet('judge-10.json'));
  const path = join(DIR, 'runs', `${runId}.json`);
  writeJson(path, { header, corpus, judge10 });
  console.log(JSON.stringify({ corpus: corpus.summary, judge10: judge10.summary }, null, 1));
  console.log(`offline -> ${path}`);
}

// ---------------------------------------------------------------- čtečka proti klíčovým slovům (P29B T3)

/**
 * Rozhodovací pravidlo T3, napsané předem: čtečka jde do draftu jen když na
 * judge-10 zvedne `read` aspoň o 0,10 proti klíčovým slovům a p95 latence
 * čtení je do 1500 ms (rozpočet `PLAY_READER_BUDGET_MS`). Jinak zůstane
 * vypnutá za přepínačem.
 */
export const READER_GATE = { minGain: 0.1, maxP95Ms: 1500 };

export function readerDecision({ reader, regex, p95Ms }) {
  // Tolerance na zaokrouhlení podílů na tři místa (`share`).
  return reader + 1e-9 >= regex + READER_GATE.minGain && p95Ms <= READER_GATE.maxP95Ms ? 'draft' : 'off';
}

/**
 * Draft pro měření T3: ovládání z čtení, zbytek z klíčových slov
 * (`draftForControl`). Role a počty z čtení přidává až T4 v `draft.ts`;
 * tohle měří největší páku – volbu ovládání – bez zásahu do produkční cesty.
 */
export function readerDraft(text, reading) {
  if (reading === null) return draftGameSpec(text);
  return draftForControl(text, reading.control) ?? draftGameSpec(text);
}

/** Přečte věty jednu po druhé (server má jeden slot) a změří latenci každé. */
async function readAll(sentences, endpoint, timeoutMs) {
  const out = new Map();
  for (const sentence of sentences) {
    const started = performance.now();
    const reading = await readSentence(sentence.text, { endpoint, timeoutMs });
    out.set(sentence.id, { reading, ms: Math.round(performance.now() - started) });
  }
  return out;
}

const quantileOf = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

/**
 * `--offline --reader <url> [--run <id>]`: korpus i judge-10 přes čtečku a
 * stejné věty přes klíčová slova, vedle sebe. Timeout čtení je tady štědrý
 * (10 s), aby pomalá odpověď byla v latenci vidět místo tichého `null`.
 */
async function offlineReaderRun(runId, endpoint) {
  const sets = { corpus: loadSet(), judge10: loadSet('judge-10.json') };
  const result = {};
  const latencies = [];
  let unread = 0;
  for (const [name, sentences] of Object.entries(sets)) {
    const readings = await readAll(sentences, endpoint, 10_000);
    for (const { reading, ms } of readings.values()) {
      latencies.push(ms);
      if (reading === null) unread += 1;
    }
    const reader = offlineChain(sentences, (sentence) => readerDraft(sentence.text, readings.get(sentence.id).reading));
    for (const row of reader.sentences) Object.assign(row, readings.get(row.id));
    result[name] = { reader, regex: offlineChain(sentences) };
  }
  const p95Ms = quantileOf(latencies, 0.95);
  const decision = readerDecision({ reader: result.judge10.reader.summary.read, regex: result.judge10.regex.summary.read, p95Ms });
  const header = {
    about: 'P29B T3: the local reader against the keyword draft on corpus.json (30) and the frozen judge-10.json (10). Reader = control from the reading, the rest from keywords. See evals/play/read/README.md.',
    runId,
    endpoint,
    measuredAt: new Date().toISOString(),
    commit: commit(),
    latencyMs: { p50: quantileOf(latencies, 0.5), p95: p95Ms, max: Math.max(...latencies) },
    unread,
    gate: READER_GATE,
    decision,
  };
  const path = join(DIR, 'runs', `${runId}.json`);
  writeJson(path, { header, ...result });
  const summaries = Object.fromEntries(Object.entries(result).map(([name, pair]) => [name, { reader: pair.reader.summary, regex: pair.regex.summary }]));
  console.log(JSON.stringify({ latencyMs: header.latencyMs, unread, decision, ...summaries }, null, 1));
  console.log(`reader -> ${path}`);
}

/** Souhrn řádků `{ genre, items, checklist }`: podíly stupňů, `roleNamed` jen nad věcmi s očekávanou rolí, a po žánrech. */
function stageSummary(rows) {
  const items = rows.flatMap((row) => row.items);
  const named = rows.flatMap((row) => row.items.filter((_, at) => row.checklist[at].does !== undefined));
  const part = (list, stage) => share(list.filter((item) => item[stage]).length, list.length);
  return {
    summary: { sentences: rows.length, items: items.length, read: part(items, 'read'), drawn: part(items, 'drawn'), role: part(items, 'role'), roleNamed: part(named, 'role') },
    byGenre: stagesByGenre(rows),
  };
}

/**
 * `roles --run <id> [--set dev] --out <path>` (P39 T3/T13): `read`, `drawn` a `role` po žánrech
 * třikrát – rychlá verze offline, rychlá verze ze serveru a výsledná verze živého běhu
 * (AI verze, když vyšla, jinak rychlá). Seznam se bere ze sady, ne z uloženého běhu.
 */
function roles(options) {
  if (typeof options.run !== 'string' || typeof options.out !== 'string') throw new Error('roles needs --run <id> and --out <path>');
  const sentences = loadSet(typeof options.set === 'string' ? options.set : 'dev');
  const offlineBody = offlineChain(sentences);
  const runDir = join(DIR, 'runs', options.run);
  const results = sentences.filter((sentence) => existsSync(join(runDir, `${sentence.id}.json`))).map((sentence) => ({ sentence, result: readJson(join(runDir, `${sentence.id}.json`)) }));
  const rowsOf = (pick) =>
    results.map(({ sentence, result }) => {
      const spec = pick(result);
      return { id: sentence.id, genre: genreOfSpec(spec), checklist: sentence.checklist, items: specFidelity(spec, sentence.checklist).items };
    });
  const draftRows = rowsOf((result) => result.draft.spec);
  const finalRows = rowsOf((result) => (result.ai ? result.ai.spec : result.draft.spec));
  const header = {
    about: 'P39 role fidelity: read, drawn and role (the thing plays the role the sentence gives it) per genre, offline quick version and a live run through the director. See README.md.',
    set: typeof options.set === 'string' ? options.set : 'dev',
    runId: options.run,
    measuredAt: new Date().toISOString(),
    commit: commit(),
  };
  const body = {
    header,
    offline: { summary: offlineBody.summary, byGenre: offlineBody.byGenre },
    live: {
      measured: results.length,
      aiPublished: results.filter(({ result }) => result.ai !== null).length,
      draft: stageSummary(draftRows),
      final: stageSummary(finalRows),
    },
    sentences: finalRows.map((row, index) => ({
      id: row.id,
      genre: { draft: draftRows[index].genre, final: row.genre },
      ai: results[index].result.ai !== null,
      lost: row.items.filter((item) => !item.role).map((item) => `${item.item}: ${item.why === 'ok' ? 'wrong-role' : item.why}`),
    })),
  };
  writeJson(resolve(ROOT, options.out), body);
  console.log(JSON.stringify({ offline: body.offline.summary, live: { measured: body.live.measured, aiPublished: body.live.aiPublished, draft: body.live.draft.summary, final: body.live.final.summary } }, null, 1));
}

/** `--offline [--set dev] [--out <path>]`: mapa ztrát nad sadou (bez `--set` korpus do `draft-chain.json`). */
function offline({ set, out } = {}) {
  const name = typeof set === 'string' ? set : undefined;
  const body = offlineChain(loadSet(name));
  const header = {
    about: `P27A T2 offline loss map: ${name ?? 'the fidelity corpus'} through the word draft and the compiler, no network, no model. See README.md.`,
    measuredAt: new Date().toISOString(),
    commit: commit(),
  };
  writeJson(typeof out === 'string' ? resolve(ROOT, out) : join(DIR, 'draft-chain.json'), { header, ...body });
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

/** Věta pro porovnání sad (P30A T1): malá písmena, bez interpunkce, jedna mezera. */
export function normalizeSentence(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

/**
 * Pečeť testovací sady (P30A T1). Rozhoduje obsah, ne cesta: věta se
 * `source: "test"` otevře sadu jen s `--open-test-once` a jen jednou –
 * `test-opened.json` se zapíše dřív, než odejde první věta.
 */
function breakSeal(file, { openTestOnce, runId, sealDir, sealFile }) {
  const seal = join(sealDir, sealFile);
  if (existsSync(seal)) {
    const opened = readJson(seal);
    throw new Error(`test set already opened by run ${opened.runId} at ${opened.openedAt} (${seal}); a second opening would tune on it`);
  }
  if (!openTestOnce) throw new Error('test set is sealed; pass --open-test-once (or --open-sealed-once) for the one final measurement');
  const sha256 = createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  writeJson(seal, { openedAt: new Date().toISOString(), runId, commit: commit(), sha256 });
}

/**
 * Sada podle `--set`: `dev` a `test` jsou sady P30A v `evals/play/p30/`, jiný
 * název je soubor ve `fidelity/` (`judge-10.json`), bez názvu korpus.
 */
const setFile = (name) => (name === 'dev' ? join(P30, 'dev.json') : name === 'test' ? join(P30, 'test-200.json') : name === 'p43-sealed' ? join(P43, 'sealed-100.json') : name === 'p44e-sealed' ? join(P44E, 'sealed-200.json') : name === 'p45-sealed' ? join(P45, 'sealed-100.json') : resolve(DIR, name ?? 'corpus.json'));
const picked = (sentences, only) => {
  const ids = typeof only === 'string' ? new Set(only.split(',')) : null;
  return sentences.filter((sentence) => ids === null || ids.has(sentence.id));
};

export function loadSet(name, { only, openTestOnce = false, runId = null, sealDir } = {}) {
  const file = setFile(name);
  const corpus = readJson(file);
  const issues = checkCorpus(corpus);
  if (issues.length > 0) throw new Error(`${file} is invalid:\n${issues.join('\n')}`);
  const sealed = Object.entries(SEALS).find(([source]) => corpus.sentences.some((sentence) => sentence.source === source));
  if (sealed !== undefined) breakSeal(file, { openTestOnce, runId, sealDir: sealDir ?? sealed[1].dir, sealFile: sealed[1].file });
  return picked(corpus.sentences, only);
}

/** Kolik vět běh změří, bez pečeti: strop se ověří dřív, než odmítnutý běh spotřebuje jediné otevření testovací sady (P30A T7b). */
export function setSize(name, only) {
  return picked(readJson(setFile(name)).sentences, only).length;
}

async function gameOf(base, id, fetchImpl = fetch) {
  const body = await (await fetchImpl(`${base}/api/play/games/${id}`, { cache: 'no-store' })).json();
  return body.game ?? body;
}

/**
 * Počká na vlastní panorama (P29C), ať soudce vidí prostředí, které hráč uvidí po chvíli hraní.
 * Hra se na něj ptá každých 5 s; bez čekání fotí měření knihovní oblohu, i když panorama vzniká.
 */
async function envOf(base, id) {
  const until = Date.now() + 120_000;
  for (;;) {
    const response = await fetch(`${base}/api/play/games/${id}/env`, { cache: 'no-store' });
    const status = response.ok ? (await response.json()).status : `http ${response.status}`;
    if (status !== 'pending') return status;
    if (Date.now() > until) return 'pending';
    await sleep(3000);
  }
}

// Soudce vidí jen scénu: text stránky (název, věta, HUD) by mu napověděl.
const SCENE_ONLY = { content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' };

async function shoot(page, base, id, path) {
  const env = await envOf(base, id);
  await page.goto(`${base}/play/${id}`);
  await page.locator('canvas').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${path}.png` });
  await page.addStyleTag(SCENE_ONLY);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${path}-scene.png` });
  return env;
}

/** Klip soudce slovesa (P37A T2): `frames` snímků po `gapTicks` tiků arkády (60 Hz), první `leadTicks` po startu robota. */
export const CLIP = { frames: 3, gapTicks: 30, leadTicks: 90, hz: 60 };

/**
 * Robot („Show me how“, záznam, kterým verze prošla publikací) hraje a tři
 * snímky jen plátna ukážou pohyb. Čas hry odtiká skript ručními hodinami sondy
 * (`byHand`, P36C T4), takže odstup snímků je 0,5 s hry, i když swiftshader
 * kreslí snímek 14 s. Hra bez sondy arkády (mřížka) se fotí po 0,5 s skutečného
 * času a nese `robot: false`, ať ji souhrn nepočítá za odehranou.
 */
async function clip(page, base, id, path) {
  await page.goto(`${base}/play/${id}`);
  await page.locator('canvas').first().waitFor({ timeout: 30_000 });
  const robot = await page.waitForFunction(() => typeof window.__playShell?.byHand === 'function', undefined, { timeout: 30_000 }).then(
    () => true,
    () => false,
  );
  if (robot) {
    await page.evaluate(() => window.__playShell.byHand(true));
    await page.getByTestId('play-pause').click();
    await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
  }
  await page.addStyleTag(SCENE_ONLY);
  const frames = [];
  for (let index = 0; index < CLIP.frames; index += 1) {
    const ticks = index === 0 ? CLIP.leadTicks : CLIP.gapTicks;
    if (robot) {
      await page.evaluate(async (count) => {
        for (let tick = 0; tick < count; tick += 1) if (window.__playShell.tickByHand().runState !== 'running') break;
        // Dva snímky prohlížeče: scéna nakreslí stav po posledním tiku dřív, než ji screenshot vezme.
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      }, ticks);
    } else {
      await page.waitForTimeout((ticks * 1000) / CLIP.hz);
    }
    const frame = `${path}-clip-${index + 1}.png`;
    await page.screenshot({ path: frame });
    frames.push(basename(frame));
  }
  return { robot, frames };
}

async function runOne(sentence, base, runDir, page, { clip: withClip = false, draftOnly = false } = {}) {
  const started = Date.now();
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: sentence.text }) });
  const created = await response.json();
  const draftMs = Date.now() - started;
  if (!created.versionId) throw new Error(`${sentence.id}: POST ${response.status} ${JSON.stringify(created).slice(0, 200)}`);
  let upgrade = { status: 'skipped' };
  // Klient se po `deadlineAt` přestane ptát (P27C T1); měření se ptá dál, aby
  // pozdní výsledek zůstal ve jmenovateli a nesl značku `late`.
  let deadlineAt = null;
  while (!draftOnly) {
    await sleep(4000);
    upgrade = await (await fetch(`${base}/api/play/games/${created.versionId}/upgrade`, { cache: 'no-store' })).json();
    if (upgrade.status === 'pending' && deadlineAt === null && typeof upgrade.deadlineAt === 'string') deadlineAt = Date.parse(upgrade.deadlineAt);
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
    upgrade: { ...upgrade, ms: upgradeMs, deadlineAt: deadlineAt === null ? null : new Date(deadlineAt).toISOString(), late: deadlineAt !== null && started + upgradeMs > deadlineAt },
    ai: ai ? { versionId: upgrade.versionId, spec: ai.spec } : null,
    raw: existsSync(failure) ? readJson(failure) : null,
  };
  result.draft.env = await shoot(page, base, created.versionId, join(runDir, `${sentence.id}-draft`));
  if (withClip) result.draft.clip = await clip(page, base, created.versionId, join(runDir, `${sentence.id}-draft`));
  if (ai) result.ai.env = await shoot(page, base, upgrade.versionId, join(runDir, `${sentence.id}-ai`));
  if (ai && withClip) result.ai.clip = await clip(page, base, upgrade.versionId, join(runDir, `${sentence.id}-ai`));
  return result;
}

async function run(options) {
  const base = options.base ?? 'http://127.0.0.1:3100';
  const runId = options.run ?? `${new Date().toISOString().slice(0, 10)}-${commit()}`;
  // Sada před složkou a prohlížečem: odmítnutá pečeť nesmí nechat stopu běhu.
  // `--set judge-10.json` / `dev` / `test` se vykazují ve vlastním `--run`.
  const sentences = loadSet(typeof options.set === 'string' ? options.set : undefined, { only: options.only, openTestOnce: options['open-test-once'] === true || options['open-sealed-once'] === true, runId });
  const runDir = join(DIR, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const require = createRequire(import.meta.url);
  const { chromium } = require('@playwright/test');
  // `--gpu` (P37A T2): screenshot za 0,2 s místo 14 s pod swiftshaderem; obsah snímku je týž.
  const angle = options.gpu === true ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const browser = await chromium.launch({ args: angle });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    for (const sentence of sentences) {
      const path = join(runDir, `${sentence.id}.json`);
      if (existsSync(path)) continue;
      const result = await runOne(sentence, base, runDir, page, { clip: options.clip === true, draftOnly: options['draft-only'] === true });
      writeJson(path, result);
      const robot = result.draft.clip ? ` robot ${result.draft.clip.robot ? 'yes' : 'no'}` : '';
      console.log(`${sentence.id} ${result.ai ? 'ai' : `draft (${result.upgrade.reason ?? result.upgrade.status})`} ${Math.round(result.upgrade.ms / 1000)} s env ${result.ai?.env ?? result.draft.env}${robot}`);
    }
  } finally {
    await browser.close();
  }
  console.log(`run ${runId} -> ${runDir}`);
}

// ---------------------------------------------------------------- férové srovnání modelů (P30A T7)

/**
 * Modely srovnání a odkud se berou jejich proměnné (`src/server/upstream.ts`):
 * `primary` = `WORLDSMITH_MODEL_*` (gpt-oss-20b přes Together), `fallback` =
 * `WORLDSMITH_FALLBACK_*` (astra přes OpenAI API). `expect` hlídá, že pod
 * jménem běží opravdu ten model – v konfiguraci i v účtenkách serveru.
 */
export const COMPARE_MODELS = {
  oss20b: { source: 'primary', expect: /gpt-oss-20b/i },
  astra: { source: 'fallback', expect: /astra/i },
};

/** Kolik režií pustí dveře `play` na jedné instanci (`DOOR_CEILING.play` v `src/server/paid-slots.ts`, test drží shodu). */
export const PLAY_DOOR_SLOTS = 2;

/** Proměnná primáru a její dvojče u zálohy. */
const MODEL_VARS = [
  ['WORLDSMITH_MODEL_ENDPOINT', 'WORLDSMITH_FALLBACK_ENDPOINT'],
  ['WORLDSMITH_MODEL', 'WORLDSMITH_FALLBACK_MODEL'],
  ['WORLDSMITH_MODEL_KEY', 'WORLDSMITH_FALLBACK_KEY'],
  ['WORLDSMITH_MODEL_EFFORT', 'WORLDSMITH_FALLBACK_EFFORT'],
  ['WORLDSMITH_USD_PER_MTOK_IN', 'WORLDSMITH_FALLBACK_USD_PER_MTOK_IN'],
  ['WORLDSMITH_USD_PER_MTOK_OUT', 'WORLDSMITH_FALLBACK_USD_PER_MTOK_OUT'],
  ['WORLDSMITH_MAX_OUTPUT_TOKENS', 'WORLDSMITH_FALLBACK_MAX_OUTPUT_TOKENS'],
  ['WORLDSMITH_UPSTREAM_TIMEOUT_MS', 'WORLDSMITH_FALLBACK_TIMEOUT_MS'],
];

/**
 * Prostředí `next start` pro jeden model: měřený model jako JEDINÝ primár, bez
 * zálohy (hru napíše ten, kdo se měří), oba přes týž transport `openai:` a týž
 * strop. Prázdný řetězec je schválně: `@next/env` doplní z `.env.local` jen
 * klíč, který v prostředí chybí, takže `''` hodnotu z `.env.local` přebije.
 * Sdílené úložiště se vypíná – každý server má vlastní hry, cache i knihu, jinak
 * by druhý model dostal hotové hry prvního. `VERCEL_ENV=production` dá knihu
 * procesu (`ledgerFromEnv`): lokální server je jediný proces, strop tedy drží.
 */
export function modelEnv(name, env, capUsd, concurrency = 1, sentences = 1) {
  // Nad sloty dveří by režii odmítly dveře, ne model, a souhrn by návrh připsal
  // modelu – pomalejšímu víc, protože drží slot déle (revize hranice fáze 2).
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > PLAY_DOOR_SLOTS)
    throw new Error(`--concurrency must be an integer 1–${PLAY_DOOR_SLOTS}: one next start is one instance, and its play door runs ${PLAY_DOOR_SLOTS} director calls at once – more judges would measure the door, not the model`);
  const profile = COMPARE_MODELS[name];
  if (profile === undefined) throw new Error(`unknown model ${name}; known: ${Object.keys(COMPARE_MODELS).join(', ')}`);
  const overlay = {};
  for (const [primary, fallback] of MODEL_VARS) overlay[primary] = env[profile.source === 'primary' ? primary : fallback] ?? '';
  const from = (primary) => MODEL_VARS.find(([own]) => own === primary)[profile.source === 'primary' ? 0 : 1];
  if (!/^openai:https?:\/\/\S+$/.test(overlay.WORLDSMITH_MODEL_ENDPOINT)) throw new Error(`${name}: ${from('WORLDSMITH_MODEL_ENDPOINT')} must be an openai: endpoint – both models go through the same hosted transport`);
  if (!profile.expect.test(overlay.WORLDSMITH_MODEL)) throw new Error(`${name}: ${from('WORLDSMITH_MODEL')} is "${overlay.WORLDSMITH_MODEL}", not ${profile.expect}`);
  for (const primary of ['WORLDSMITH_MODEL_KEY', 'WORLDSMITH_USD_PER_MTOK_IN', 'WORLDSMITH_USD_PER_MTOK_OUT']) {
    if (overlay[primary].trim() === '') throw new Error(`${name}: ${from(primary)} is missing`);
  }
  // Strop rezervuje nejhorší případ každého volání v letu; menší strop by volání
  // odmítal a srovnání by to přičetlo modelu (suchý běh 27. 9.: astra 1 ze 3 při
  // 0,1 USD a dvou porotcích). ×1,5 kryje vstupní tokeny vedle výstupních.
  const maxOut = Number(overlay.WORLDSMITH_MAX_OUTPUT_TOKENS) > 0 ? Number(overlay.WORLDSMITH_MAX_OUTPUT_TOKENS) : 8000;
  const worstUsd = ((maxOut * Number(overlay.WORLDSMITH_USD_PER_MTOK_OUT)) / 1e6) * 1.5;
  if (!(capUsd >= concurrency * worstUsd)) throw new Error(`${name}: ${capUsd} USD per model is under ${concurrency} concurrent worst-case calls (${(concurrency * worstUsd).toFixed(3)} USD); raise --cap-usd`);
  // Kniha sčítá útratu celého běhu, ne jen volání v letu: vyčerpaná uprostřed by
  // zbytek vět odmítla a běh by skončil neplatný (revize hranice fáze 2, nález B).
  if (!(capUsd >= sentences * worstUsd))
    throw new Error(`${name}: ${capUsd} USD per model is under ${sentences} sentences × one worst-case call (${(sentences * worstUsd).toFixed(3)} USD); raise --cap-usd or lower ${from('WORLDSMITH_MAX_OUTPUT_TOKENS')}`);
  return {
    ...overlay,
    WORLDSMITH_BRANCH: 'live',
    WORLDSMITH_MODEL_PROFILE: 'metered',
    WORLDSMITH_FALLBACK_ENDPOINT: '',
    KV_REST_API_URL: '',
    KV_REST_API_TOKEN: '',
    WORLDSMITH_SPEND_STORE_URL: '',
    WORLDSMITH_SPEND_STORE_TOKEN: '',
    VERCEL_ENV: 'production',
    WORLDSMITH_SPEND_CAP_USD: String(capUsd),
    // Drží dolarový strop; počty by utnuly měření dřív než peníze.
    WORLDSMITH_CALL_CAP: '100000',
    PLAY_DIRECTOR_CALLS_PER_CALLER: '100000',
    // Hlas a panoramata model neovlivní; knihovna panoramat je cesta dema bez PC.
    PLAY_VOICE_ENDPOINT: '',
    PLAY_ENV_ENDPOINT: '',
  };
}

const BILLED = /\[play\] director call billed model=(\S+) usd=(\d+(?:\.\d+)?)/g;

/** Účtenky z logu serveru (`billedLine` v `src/app/api/play/_director.ts`): co strhl strop, u volání bez účtenky celá rezervace. */
export function billedFromLog(text) {
  return [...text.matchAll(BILLED)].map((match) => ({ model: match[1], usd: Number(match[2]) }));
}

const ENDED = /\[play\] upgrade of (\S+) ended ([^\r\n]*)/g;
const ATTEMPT = /\[play\] upgrade attempt (started|settled) (\S+)/g;
/** Odmítnutí dveřmi `play` (hlavní slot i slot placené zálohy) a stropem útraty nebo volání (`src/app/api/play/_director.ts`). */
const DOOR_REFUSAL = /no free (?:play )?slot/;
const CAP_REFUSAL = /spend cap refused the call|daily director calls are used up/;

/**
 * Příčiny neúspěšných pokusů o upgrade jednoho návrhu z logu serveru
 * (`upgradeEndedLine` v `src/app/api/play/_upgrade.ts`), po řadě: `door`,
 * `cap`, jinak `model` (P30A T7b).
 */
export function upgradeEnds(log, draftId) {
  return [...log.matchAll(ENDED)].filter((match) => match[1] === draftId).map((match) => (DOOR_REFUSAL.test(match[2]) ? 'door' : CAP_REFUSAL.test(match[2]) ? 'cap' : 'model'));
}

/** Kolik pokusů o upgrade návrhu server začal a ještě nedokončil (`upgradeAttemptLine`). */
export function attemptsInFlight(log, draftId) {
  let open = 0;
  for (const match of log.matchAll(ATTEMPT)) if (match[2] === draftId) open += match[1] === 'started' ? 1 : -1;
  return open;
}

/**
 * Jedna věta jako porotce: POST věty, návrh v prohlížeči, čekání na AI verzi
 * (ta prošla publikační kontrolou robotem, jinak by `ready` nebyla) a její
 * první hratelný snímek. Časy běží od odeslání věty; snímek hlásí `openGame`,
 * až je hra v prohlížeči hratelná – ne odpověď POST.
 *
 * Než věta skončí, stránka odejde (`leave`, `about:blank`) a skript počká, až
 * server dokončí každý rozběhnutý pokus o upgrade, nejvýš `settleMs`: stránka
 * návrhu se ptá každé 2 s a dotaz po přechodném konci spustí nový pokus, který
 * by držel slot dveří a další věta by dostala návrh od dveří (revize hranice
 * fáze 2, nález A). `cause` pak říká, proč věta nemá AI verzi: `door`, `cap`
 * (ty o modelu nic neříkají), nebo `model`; u publikované hry `null`, pokud
 * cestou nenarazila na dveře nebo strop.
 */
export async function measureSentence(sentence, { base, openGame, leave, log, fetchImpl = fetch, now = Date.now, wait = sleep, pollMs = 1000, timeoutMs = 330_000, settleMs = 300_000 }) {
  const started = now();
  const frame = async (id) => {
    try {
      await openGame(`${base}/play/${id}`);
      return { frameMs: now() - started, frameError: null };
    } catch (thrown) {
      return { frameMs: null, frameError: thrown.message.slice(0, 200) };
    }
  };
  const response = await fetchImpl(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence: sentence.text }) });
  const created = await response.json();
  if (!created.versionId) throw new Error(`POST ${response.status} ${JSON.stringify(created).slice(0, 200)}`);
  const draftFrame = await frame(created.versionId);
  let upgrade;
  for (;;) {
    upgrade = await (await fetchImpl(`${base}/api/play/games/${created.versionId}/upgrade`, { cache: 'no-store' })).json();
    if (upgrade.status !== 'pending') break;
    if (now() - started > timeoutMs) {
      upgrade = { status: 'timeout' };
      break;
    }
    await wait(pollMs);
  }
  const upgradeMs = now() - started;
  await leave();
  const draft = await gameOf(base, created.versionId, fetchImpl);
  const ai = upgrade.status === 'ready' ? await gameOf(base, upgrade.versionId, fetchImpl) : null;
  const aiFrame = ai === null ? null : await frame(upgrade.versionId);
  if (aiFrame !== null) await leave();
  const settleBy = now() + settleMs;
  while (attemptsInFlight(log(), created.versionId) > 0 && now() < settleBy) await wait(pollMs);
  const published = ai?.report?.publishEligible === true;
  return {
    id: sentence.id,
    text: sentence.text,
    checklist: sentence.checklist,
    draft: { versionId: created.versionId, spec: draft.spec, ...draftFrame },
    upgrade: { status: upgrade.status, reason: upgrade.reason ?? null, ms: upgradeMs },
    cause: upgradeEnds(log(), created.versionId).find((end) => end !== 'model') ?? (published ? null : 'model'),
    ai: ai === null ? null : { versionId: upgrade.versionId, spec: ai.spec, published, source: ai.timings?.source ?? null, ...aiFrame },
  };
}

/** Věta, kterou odmítly dveře nebo strop: o modelu nic neříká (P30A T7b). */
const refusedCause = (result) => result.cause === 'door' || result.cause === 'cap';

const round = (value, places) => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places);

/**
 * Souhrn jednoho modelu; hra, kterou robot nepustil, se počítá jako návrh.
 * Věta odmítnutá dveřmi nebo stropem (`cause`) jde do `refused` a ven z podílu,
 * věrnosti i časů – selhání modelu jsou jen `model` (P30A T7b).
 */
function modelSummary(name, { results, billed, concurrency }) {
  const wrong = billed.find((call) => !COMPARE_MODELS[name].expect.test(call.model));
  if (wrong !== undefined) throw new Error(`${name}: the server billed ${wrong.model} – it did not measure ${name}`);
  const authored = results.filter((result) => result.ai?.published === true && result.ai.source === 'authored').length;
  if (authored > 0 && billed.length === 0) throw new Error(`${name}: ${authored} authored games but no billed call in the server log – the cost would read as zero`);
  const refused = { door: results.filter((result) => result.cause === 'door').length, cap: results.filter((result) => result.cause === 'cap').length };
  const scored = results.filter((result) => !refusedCause(result));
  const played = scored.filter((result) => result.error === undefined);
  const published = played.filter((result) => result.ai?.published === true);
  const failures = {};
  for (const result of scored) {
    if (result.ai?.published === true) continue;
    const reason = result.error !== undefined ? 'ERROR' : result.ai !== null ? 'UNPUBLISHED' : (result.upgrade.reason ?? result.upgrade.status);
    failures[reason] = (failures[reason] ?? 0) + 1;
  }
  const finals = played.map((result) => specFidelity(result.ai?.published === true ? result.ai.spec : result.draft.spec, result.checklist));
  const inSpec = (final) => final.items.filter((item) => item.inSpec).length / final.items.length;
  const frames = (pick) => played.map(pick).filter((ms) => typeof ms === 'number');
  const usd = billed.reduce((sum, call) => sum + call.usd, 0);
  return {
    n: results.length,
    concurrency,
    errors: scored.length - played.length,
    refused,
    published: { ok: published.length, of: scored.length, share: share(published.length, scored.length), failures },
    sources: { authored, cached: published.filter((result) => result.ai.source === 'cached').length },
    fidelity: { inSpec: mean(finals.map(inSpec)), read: mean(finals.map((final) => final.score)), drawn: mean(finals.map((final) => final.drawnScore)), role: mean(finals.map((final) => final.roleScore)) },
    firstPlayableFrameMs: {
      aiP50: quantile(frames((result) => (result.ai?.published === true ? result.ai.frameMs : null)), 0.5),
      aiP95: quantile(frames((result) => (result.ai?.published === true ? result.ai.frameMs : null)), 0.95),
      draftP50: quantile(frames((result) => result.draft.frameMs), 0.5),
      draftP95: quantile(frames((result) => result.draft.frameMs), 0.95),
    },
    cost: {
      calls: billed.length,
      usd: round(usd, 6),
      perSentence: results.length === 0 ? null : round(usd / results.length, 6),
      perPublished: published.length === 0 ? null : round(usd / published.length, 6),
    },
  };
}

/**
 * Souhrn srovnání. Férovost se kontroluje, ne předpokládá: jiný build nebo jiné
 * věty u některého modelu srovnání odmítnou. `buildId` je razítko z hlavičky,
 * čtené před během – přestavba během prvního modelu dá oběma modelům totéž nové
 * razítko a bez hlavičky by prošla.
 */
export function compareSummary(runs, buildId) {
  const names = Object.keys(runs);
  const builds = [...new Set([buildId, ...names.map((name) => runs[name].buildId)])];
  if (builds.length !== 1) throw new Error(`the models ran on different builds: ${builds.join(', ')}`);
  const sets = new Set(names.map((name) => runs[name].results.map((result) => result.id).sort().join(',')));
  if (sets.size !== 1) throw new Error('the models ran different sentences');
  return Object.fromEntries(names.map((name) => [name, modelSummary(name, runs[name])]));
}

/**
 * Platí běh? Jediná věta odmítnutá dveřmi nebo stropem znamená, že čísla měří
 * instanci nebo rozpočet, ne model – souhrn nese `valid: false` s důvodem
 * a běh končí nenulovým kódem; taková čísla se necitují (P30A T7b).
 */
export function compareVerdict(models) {
  const reasons = Object.entries(models)
    .filter(([, summary]) => summary.refused.door + summary.refused.cap > 0)
    .map(([name, summary]) => `${name}: ${summary.refused.door} sentences refused by the play door, ${summary.refused.cap} by the spend or call cap`);
  return reasons.length === 0 ? { valid: true, reason: null, exitCode: 0 } : { valid: false, reason: `${reasons.join('; ')} – these numbers describe the instance or the budget, not the model; do not cite them`, exitCode: 1 };
}

/** Hra je v prohlížeči hratelná: sonda hry připojená (`window.__playShell`), plátno na stránce a jeden snímek vykreslený navíc. */
async function playableFrame(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => window.__playShell !== undefined && document.querySelector('canvas') !== null, undefined, { timeout: 60_000 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(undefined)))));
}

const reachable = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
};

/** `next start` nad hotovým `.next` s prostředím jednoho modelu; zastavuje se podle PID. */
async function startServer(port, overlay) {
  const base = `http://127.0.0.1:${port}`;
  if (await reachable(base)) throw new Error(`port ${port} already serves something – stop it, or the run would measure a foreign server`);
  // Bez Upstash by server četl hry a AI verze z `data/play/store` (P40 T3), tedy
  // i ty, které napsal model před ním: každý server dostane prázdné úložiště.
  const store = mkdtempSync(join(tmpdir(), 'play-store-'));
  const child = spawn(process.execPath, [join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port)], { cwd: ROOT, env: { ...process.env, ...overlay, PLAY_STORE_DIR: store }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', (chunk) => (log += chunk));
  const exited = new Promise((done) => child.once('exit', done));
  const stop = async () => {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
    await exited;
  };
  const until = Date.now() + 90_000;
  while (!(await reachable(base))) {
    if (child.exitCode !== null || Date.now() > until) {
      await stop();
      throw new Error(`next start did not come up on ${port}:\n${log.slice(-800)}`);
    }
    await sleep(500);
  }
  return { base, log: () => log, stop };
}

const commitMs = () => Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, encoding: 'utf8' }).trim()) * 1000;

/**
 * Razítko buildu `.next`: obsah `BUILD_ID` a čas jeho zápisu. Samotné `BUILD_ID`
 * je bez `WORLDSMITH_BUILD_TREE` vždycky `unbuilt` a nic nerozliší (revize
 * hranice fáze 2). Build starší než poslední commit by měřil starý kód pod
 * hlavičkou nového commitu, proto se odmítne.
 */
export function buildStamp(nextDir, commitMs) {
  const file = join(nextDir, 'BUILD_ID');
  if (!existsSync(file)) throw new Error('no .next build – run `npm run build` first');
  const builtMs = statSync(file).mtimeMs;
  if (builtMs < commitMs) throw new Error(`the .next build (${new Date(builtMs).toISOString()}) is older than the last commit – run \`npm run build\` again`);
  return `${readFileSync(file, 'utf8').trim()}@${new Date(builtMs).toISOString()}`;
}

/** Věty přes `concurrency` porotců naráz; každý má vlastní kontext prohlížeče. `log` = log serveru, ze kterého se čtou příčiny. */
async function measureAll(sentences, base, concurrency, log) {
  const require = createRequire(import.meta.url);
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const results = new Map();
  let next = 0;
  const judge = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      while (next < sentences.length) {
        const sentence = sentences[next++];
        let result;
        try {
          result = await measureSentence(sentence, { base, openGame: (url) => playableFrame(page, url), leave: () => page.goto('about:blank'), log });
        } catch (thrown) {
          // Odmítnutá věta pod souběhem (429, 503) je výsledek měření, ne pád běhu.
          result = { id: sentence.id, text: sentence.text, checklist: sentence.checklist, error: thrown.message.slice(0, 300) };
        }
        results.set(sentence.id, result);
        console.log(`${sentence.id} ${result.error ?? (result.ai?.published ? `ai ${result.ai.frameMs === null ? `no frame: ${result.ai.frameError}` : `${Math.round(result.ai.frameMs / 1000)} s`}` : `draft (${result.upgrade.reason ?? result.upgrade.status})`)}${refusedCause(result) ? ` – refused by the ${result.cause}` : ''}`);
      }
    } finally {
      await context.close();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, sentences.length) }, judge));
  } finally {
    await browser.close();
  }
  return sentences.map((sentence) => results.get(sentence.id));
}

/**
 * `--models astra,oss20b --set dev [--concurrency 2] [--cap-usd 3] [--port 3331] [--run <id>]`:
 * každý model po řadě na vlastním `next start` nad TÝMŽ `.next` (nejdřív
 * `npm run build`), tytéž věty, tatáž publikace robotem jako produkce. Surová
 * data do `fidelity/runs/compare-<id>/`, souhrn do `evals/play/p30/compare-<id>.json`.
 * Strop `--cap-usd` se dělí rovným dílem mezi modely.
 */
async function compare(options) {
  const names = options.models.split(',').map((name) => name.trim()).filter((name) => name !== '');
  const concurrency = options.concurrency === undefined ? 1 : Number(options.concurrency);
  const capUsd = options['cap-usd'] === undefined ? 3 : Number(options['cap-usd']);
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error('--cap-usd must be a positive number');
  const runId = typeof options.run === 'string' ? options.run : `${new Date().toISOString().slice(0, 10)}-${commit()}-c${concurrency}`;
  // Klíče a koncové body z `.env.local` jako `next start`; všechno se ověří dřív, než se cokoli zaplatí.
  createRequire(import.meta.url)('@next/env').loadEnvConfig(ROOT, false, { info() {}, error: console.error });
  const size = setSize(typeof options.set === 'string' ? options.set : undefined, options.only);
  const envs = Object.fromEntries(names.map((name) => [name, modelEnv(name, process.env, capUsd / names.length, concurrency, size)]));
  // Build před sadou: zastaralý build nesmí spotřebovat jediné otevření testovací sady.
  const nextDir = join(ROOT, '.next');
  const buildId = buildStamp(nextDir, commitMs());
  const sentences = loadSet(typeof options.set === 'string' ? options.set : undefined, { only: options.only, openTestOnce: options['open-test-once'] === true || options['open-sealed-once'] === true, runId });
  const port = options.port === undefined ? 3331 : Number(options.port);
  const rawDir = join(DIR, 'runs', `compare-${runId}`);
  mkdirSync(rawDir, { recursive: true });
  const runs = {};
  for (const name of names) {
    const server = await startServer(port, envs[name]);
    try {
      const results = await measureAll(sentences, server.base, concurrency, server.log);
      runs[name] = { buildId: null, concurrency, results, billed: billedFromLog(server.log()) };
    } finally {
      await server.stop();
      writeFileSync(join(rawDir, `${name}-server.log`), server.log());
    }
    // Zaplacená data na disk dřív, než čtení razítka může vyhodit (chybějící `BUILD_ID`).
    writeJson(join(rawDir, `${name}.json`), runs[name]);
    // Razítko znovu po běhu: přestavba během běhu se v souhrnu ukáže jako jiný build.
    runs[name].buildId = buildStamp(nextDir, 0);
    writeJson(join(rawDir, `${name}.json`), runs[name]);
  }
  const header = {
    about: 'P30A T7 fair model comparison: each model alone on its own next start over the same build and set, production publish check, first playable frame in the browser, cost from the server billed log. See evals/play/p30/README.md.',
    runId,
    measuredAt: new Date().toISOString(),
    commit: commit(),
    buildId,
    set: typeof options.set === 'string' ? options.set : 'corpus',
    n: sentences.length,
    concurrency,
    capUsd,
    models: Object.fromEntries(names.map((name) => [name, { model: envs[name].WORLDSMITH_MODEL, endpoint: envs[name].WORLDSMITH_MODEL_ENDPOINT, effort: envs[name].WORLDSMITH_MODEL_EFFORT || null }])),
  };
  const sentenceRows = sentences.map((sentence) => ({
    id: sentence.id,
    ...Object.fromEntries(
      names.map((name) => {
        const result = runs[name].results.find((row) => row.id === sentence.id);
        if (result.error !== undefined) return [name, { error: result.error }];
        const final = specFidelity(result.ai?.published === true ? result.ai.spec : result.draft.spec, result.checklist);
        return [name, { outcome: result.ai?.published === true ? result.ai.source : (result.upgrade.reason ?? result.upgrade.status), cause: result.cause, aiFrameMs: result.ai?.frameMs ?? null, draftFrameMs: result.draft.frameMs, read: final.score, drawn: final.drawnScore, role: final.roleScore }];
      }),
    ),
  }));
  const models = compareSummary(runs, buildId);
  const verdict = compareVerdict(models);
  const path = join(P30, `compare-${runId}.json`);
  writeJson(path, { header, valid: verdict.valid, invalid: verdict.reason, models, sentences: sentenceRows });
  console.log(`compare -> ${path}`);
  if (!verdict.valid) console.error(`INVALID RUN: ${verdict.reason}`);
  return verdict.exitCode;
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

/**
 * Zadání soudce. Jeden snímek = dnešní znění beze změny (srovnatelnost se
 * staršími běhy); klip (P37A T2) = snímky v pořadí po `CLIP.gapTicks` tiků a sloveso
 * podle toho, co se mezi nimi pohne – na stojícím obraze ho vidět nejde
 * (`evals/play/p30b/losses.md` #3, #7).
 */
export function contract(checklist, frames = 1) {
  const nouns = checklist.filter((entry) => entry.slot !== 'verb').map((entry) => `- "${entry.item}" (${entry.slot === 'setting' ? 'place / environment' : 'character or object'})`);
  const verbs = checklist.filter((entry) => entry.slot === 'verb').map((entry) => `- "${entry.item}" (action)`);
  const opening =
    frames === 1
      ? ['You are judging one screenshot of a 3D game scene. You know nothing else about the game.', 'Do not use web search. Do not run any tool, command or skill. Look only at the attached image.']
      : [
          `You are judging ${frames} frames of a 3D game while it is being played, in order, taken ${CLIP.gapTicks / CLIP.hz} s apart. You know nothing else about the game.`,
          'Do not use web search. Do not run any tool, command or skill. Look only at the attached images.',
        ];
  const action =
    frames === 1
      ? '- an action counts only if the picture shows that this is what the game is about (for "shoot": a gun, a crosshair or projectiles);'
      : '- an action counts only if the frames show that this is what the game is about – judge it from what moves or changes between the frames (for "throw": a ball flying further in each frame; for "stir": a spoon at a different place in the pot), not from one frame alone;';
  return [
    ...opening,
    '',
    'For each item below decide `visible`:',
    `- true only if a person who read no description would, from the ${frames === 1 ? 'picture' : 'frames'} alone, name that thing or clearly recognise it;`,
    '- a generic figure, a cube, a capsule, a target board, a coloured blob or a plain field does NOT count as a specific character, object or place;',
    '- a place counts only if the environment itself looks like it (a mall interior, snow, Mars red rocks), not if it is a neutral ground plane;',
    action,
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

/**
 * Jeden hovor soudce nad snímkem nebo klipem (`images` v pořadí); `verdict` = položka → viděl ji.
 *
 * Soudce musí být slepý (nález P37D): `codex exec` čte jméno obrázku i soubory
 * ve svém `cwd`, a ve složce běhu leží spec hry (`heroAction`, žánr, věta).
 * Proto běží v prázdném dočasném adresáři, kde jsou jen snímky pod neutrálním
 * jménem (`frame-1.png` …), zadání a schéma; zadání a odpověď se pak zkopírují
 * do složky běhu jako záznam.
 */
export function judgeShot(images, checklist, runDir, tag) {
  const blind = mkdtempSync(join(tmpdir(), 'judge-'));
  const contractPath = join(blind, 'contract.md');
  const schemaPath = join(blind, 'schema.json');
  const outPath = join(blind, 'answer.json');
  const shown = images.map((image, index) => {
    const copy = join(blind, `frame-${index + 1}.png`);
    copyFileSync(image, copy);
    return copy;
  });
  writeFileSync(contractPath, contract(checklist, images.length));
  writeJson(schemaPath, JUDGE_SCHEMA);
  copyFileSync(contractPath, join(runDir, `${tag}-judge.md`));
  try {
    const text = askJudge(shown, { contractPath, schemaPath, outPath, cwd: blind, tag });
    writeFileSync(join(runDir, `${tag}-judge.out`), text);
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const verdict = {};
    for (const entry of checklist) verdict[entry.item] = json.items.some((answer) => answer.item.toLowerCase() === entry.item.toLowerCase() && answer.visible === true);
    return { verdict, answers: json.items };
  } finally {
    rmSync(blind, { recursive: true, force: true });
  }
}

/** Pustí `codex exec` nad snímky a vrátí text odpovědi. */
function askJudge(images, { contractPath, schemaPath, outPath, cwd, tag }) {
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
    ...images.map((image) => `--image=${image}`),
    '--output-schema', schemaPath,
    '-o', outPath,
    `Read the file ${contractPath} and do exactly what it says.`,
  ];
  const done = spawnSync(command[0], cli, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000, encoding: 'utf8' });
  if (!existsSync(outPath)) throw new Error(`${tag}: codex wrote no answer (exit ${done.status}): ${(done.stderr ?? '').slice(-400)}`);
  return readFileSync(outPath, 'utf8');
}

export function judge(options) {
  const runDir = latestRun(options.run);
  const withClip = options.clip === true;
  const ids = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
  for (const file of readdirSync(runDir).filter((name) => /^[a-z]\d+\.json$/.test(name))) {
    if (ids !== null && !ids.has(file.slice(0, -'.json'.length))) continue;
    const path = join(runDir, file);
    const result = readJson(path);
    result.judge ??= {};
    result.judgeWhy ??= {};
    // Kolik snímků verdikt viděl: klip a jeden snímek se nesmí tiše zaměnit.
    result.judgeFrames ??= {};
    for (const version of ['draft', 'ai']) {
      if (version === 'ai' && !result.ai) continue;
      const frames = result[version].clip?.frames;
      if (withClip && !frames) throw new Error(`${result.id} ${version}: no clip in this run – run it with --clip first`);
      const images = withClip ? frames.map((frame) => join(runDir, frame)) : [join(runDir, `${result.id}-${version}-scene.png`)];
      if (result.judge[version] && (result.judgeFrames[version] ?? 1) === images.length) continue;
      const { verdict, answers } = judgeShot(images, result.checklist, runDir, `${result.id}-${version}${withClip ? '-clip' : ''}`);
      result.judge[version] = verdict;
      result.judgeWhy[version] = answers;
      result.judgeFrames[version] = images.length;
      writeJson(path, result);
      console.log(`${result.id} ${version}: ${Object.values(verdict).filter(Boolean).length}/${result.checklist.length}`);
    }
  }
}

function latestRun(run) {
  const runs = join(DIR, 'runs');
  // Id běhu, nebo celá cesta ke složce běhu (test soudce).
  if (typeof run === 'string') return resolve(runs, run);
  // Souhrn běhu (`<id>.json`, krok `summary`) leží vedle složek běhů a běh to není.
  const names = readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
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

/**
 * Souhrn jednoho běhu do `runs/<id>.json` (P27D T1) – vedle `report.json`,
 * který zůstává nedotčený. Nese build SHA, konfiguraci modelu a každé selhání.
 */
function summary(options) {
  const runDir = latestRun(options.run);
  const runId = runDir.split(/[\\/]/).at(-1);
  const results = readdirSync(runDir)
    .filter((name) => /^[a-z]\d+\.json$/.test(name))
    .map((name) => readJson(join(runDir, name)));
  const config = Object.fromEntries(
    ['WORLDSMITH_BRANCH', 'WORLDSMITH_MODEL_ENDPOINT', 'WORLDSMITH_MODEL', 'WORLDSMITH_MODEL_EFFORT', 'WORLDSMITH_MODEL_PROFILE', 'WORLDSMITH_UPSTREAM_TIMEOUT_MS', 'PLAY_DIRECTOR_MODE'].map((key) => [key, process.env[key] ?? null]),
  );
  const sentences = results.map((result) => {
    const final = specFidelity(result[finalOf(result)].spec, result.checklist);
    return {
      id: result.id,
      upgrade: result.ai ? 'ai' : (result.upgrade.reason ?? result.upgrade.status),
      upgradeSeconds: Math.round(result.upgrade.ms / 1000),
      late: result.upgrade.late === true,
      controls: { draft: result.draft.spec.control ?? 'tap_go', ai: result.ai ? (result.ai.spec.control ?? 'tap_go') : null },
      final: {
        inSpec: Math.round((final.items.filter((item) => item.inSpec).length / final.items.length) * 1000) / 1000,
        read: final.score,
        drawn: final.drawnScore,
        role: final.roleScore,
      },
      lost: final.items.filter((item) => item.why !== 'ok').map((item) => `${item.item}: ${item.why}`),
    };
  });
  const path = join(DIR, 'runs', `${runId}.json`);
  const header = { about: 'P27D T1 live fidelity run summary. report.json is left untouched. See README.md.', runId, measuredAt: new Date().toISOString(), commit: commit(), config };
  writeJson(path, { header, metrics: summarize(results), sentences });
  console.log(`summary -> ${path}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = args();
  const step = options._[0];
  if (options.offline && typeof options.reader === 'string') await offlineReaderRun(typeof options.run === 'string' ? options.run : 'p29b-reader', options.reader);
  else if (options.offline && typeof options.run === 'string') offlineRun(options.run);
  else if (options.offline) offline(options);
  else if (typeof options.models === 'string') process.exitCode = await compare(options);
  else if (step === 'run') await run(options);
  else if (step === 'judge') judge(options);
  else if (step === 'report') report(options);
  else if (step === 'summary') summary(options);
  else if (step === 'roles') roles(options);
  else {
    console.error('usage: node scripts/play-fidelity.mjs run|judge|report|summary [--run <id>] [--base <url>] [--only <ids>] [--set dev|test|judge-10.json] [--open-test-once] [--clip] [--draft-only] [--gpu] [--note <text>] | --offline | --models astra,oss20b --set dev [--concurrency 2] [--cap-usd 3] [--port 3331]');
    process.exit(2);
  }
}
