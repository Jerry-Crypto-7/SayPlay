#!/usr/bin/env node
/**
 * Střídavé měření A/B času do hratelnosti (P50 T1): dva servery, stejné cíle,
 * běhy těsně po sobě, ať zatížení stroje dopadne na obě strany stejně.
 *
 *   node scripts/measure/first-playable-ab.mjs <config.json>
 *
 * Config: `a`, `b` (základní URL, např. `http://127.0.0.1:3282`), volitelně
 * `labelA`/`labelB` (co na nich běží), `sentences` (věta → hra na `/play`),
 * `sharedSentences` (z každé skript vytvoří hru přes `POST /api/play/games` na
 * obou serverech a měří otevření `/play/<id>`), `profiles` (`desktop` |
 * `pixel7-cpu4`), `runs`, `pauseMs` (nejméně 5000), `timeoutMs`, `rawDir` (HAR
 * a průběžné `runs.jsonl`, mimo repo), `out` (souhrn JSON).
 *
 * Pořadí: opakování je vnější smyčka, takže se tři běhy jednoho cíle rozloží
 * přes celé měření; každý cíl dostane dvojici A+B hned po sobě a strana, která
 * jde první, se po dvojicích střídá (AB, BA, AB …) – kdyby druhý běh dvojice
 * těžil z teplé cache disku, dopadne to na obě strany stejně.
 * Každý běh spouští vlastní prohlížeč i kontext (`measure`), takže žádný nesdílí
 * cache ani úložiště s předchozím.
 * Běh, který hratelný nebyl, je selhání: do časů se nepočítá, jen do `failed` –
 * a do `gate.failedTotal`, takže shodí `gate.pass` (P68I T4).
 * `diffMedian` = medián B − medián A; `pairedDiffMedian` = medián rozdílů B − A
 * uvnitř dvojic, kde hrály obě strany (citlivější na pomalé výkyvy stroje).
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { measure } from './time-to-playable.mjs';

export const MIN_PAUSE_MS = 5000;

/** Profily prohlížeče: desktop jako v P49, telefon jako `e2e/p35-perf.spec.ts`. */
export const PROFILES = {
  desktop: { viewport: { width: 1280, height: 720 } },
  'pixel7-cpu4': { device: 'Pixel 7', cpuThrottle: 4 },
};

const SENTENCE_PROBE = {
  promptSelector: '[data-testid=play-sentence]',
  submitSelector: '[data-testid=play-create]',
  waitForUrl: '/play/[a-f0-9]+(\\?|$)',
};

/** Pořadí běhů: opakování → profil → cíl → dvojice A/B se střídavým začátkem. */
export function schedule({ targets, runs, profiles }) {
  const jobs = [];
  let pair = 0;
  for (let run = 1; run <= runs; run += 1) {
    for (const profile of profiles) {
      for (const target of targets) {
        const sides = pair % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
        for (const side of sides) jobs.push({ run, profile, target, side, pair });
        pair += 1;
      }
    }
  }
  return jobs;
}

export function stats(values) {
  if (values.length === 0) return { n: 0, median: null, min: null, max: null };
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { n: sorted.length, median, min: sorted[0], max: sorted[sorted.length - 1] };
}

/** Hodnota běhu pro metriku; selhání (nehratelný běh nebo chybějící hodnota) je `null`. */
const valueOf = (result, metric) => (result.playable && typeof result[metric] === 'number' ? result[metric] : null);

function sideStats(results, side, metric) {
  const values = results.filter((result) => result.side === side).map((result) => valueOf(result, metric));
  return { failed: values.filter((value) => value === null).length, ...stats(values.filter((value) => value !== null)) };
}

function compare(results, metric) {
  const A = sideStats(results, 'A', metric);
  const B = sideStats(results, 'B', metric);
  const pairs = new Map();
  for (const result of results) {
    const value = valueOf(result, metric);
    if (value !== null) pairs.set(result.pair, { ...pairs.get(result.pair), [result.side]: value });
  }
  const deltas = [...pairs.values()].filter((pair) => pair.A !== undefined && pair.B !== undefined).map((pair) => pair.B - pair.A);
  return {
    A,
    B,
    diffMedian: A.median === null || B.median === null ? null : B.median - A.median,
    pairedDiffMedian: stats(deltas).median,
  };
}

function groupBy(results, keyOf) {
  const groups = new Map();
  for (const result of results) {
    const key = keyOf(result);
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return [...groups.values()];
}

/**
 * Souhrn metriky (`ms` = čas do hratelnosti, `firstFrameMs` = první snímek) po
 * cíli a profilu (`byTarget`), po druhu cíle a profilu (`byKind`) a po profilu
 * přes oba druhy (`byProfile`).
 */
export function summarize(results, metric = 'ms') {
  return {
    byTarget: groupBy(results, (result) => `${result.profile}\u0000${result.kind}\u0000${result.target}`).map((group) => ({
      profile: group[0].profile,
      kind: group[0].kind,
      target: group[0].target,
      ...compare(group, metric),
    })),
    byKind: groupBy(results, (result) => `${result.profile}\u0000${result.kind}`).map((group) => ({ profile: group[0].profile, kind: group[0].kind, ...compare(group, metric) })),
    byProfile: groupBy(results, (result) => result.profile).map((group) => ({ profile: group[0].profile, ...compare(group, metric) })),
  };
}

/** Meze brány času do hratelnosti (P68I T4, G4 plánu). */
export const GATE = { medianBMaxMs: 3000, medianBProfiles: ['desktop'], pairedDiffMaxMs: 200, pairedDiffProfiles: ['desktop', 'pixel7-cpu4'] };

/**
 * Brána nad časem do hratelnosti: `pass` jen bez jediného selhání A ani B,
 * s mediánem B do 3 000 ms na desktopu a párovým rozdílem B − A do 200 ms na
 * desktopu i telefonu. Selhaný běh v mediánech chybí, proto ho nese
 * `failedTotal`. Profil, který se neměřil, má hodnotu `null` a bránu shodí –
 * chybějící číslo není splněná mez.
 */
export function gate(results) {
  const failedOf = (side) => results.filter((result) => result.side === side && valueOf(result, 'ms') === null).length;
  const failed = { A: failedOf('A'), B: failedOf('B') };
  const failedTotal = failed.A + failed.B;
  const byProfile = summarize(results).byProfile;
  const rowOf = (profile) => byProfile.find((row) => row.profile === profile);
  const check = (name, profile, value, limit) => ({ name, profile, value, limit, pass: value !== null && value <= limit });
  const checks = [
    check('failedTotal', null, failedTotal, 0),
    ...GATE.medianBProfiles.map((profile) => check('medianB', profile, rowOf(profile)?.B.median ?? null, GATE.medianBMaxMs)),
    ...GATE.pairedDiffProfiles.map((profile) => check('pairedDiffMedian', profile, rowOf(profile)?.pairedDiffMedian ?? null, GATE.pairedDiffMaxMs)),
  ];
  return { failedTotal, failed, checks, pass: checks.every((item) => item.pass) };
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Sdílená hra z věty na daném serveru; vrací adresu `/play/<id>`. */
async function publish(base, sentence) {
  const response = await fetch(`${base}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence }) });
  if (!response.ok) throw new Error(`POST ${base}/api/play/games "${sentence}" → ${response.status} ${await response.text()}`);
  const { versionId } = await response.json();
  return `${base}/play/${versionId}`;
}

async function main(config) {
  const bases = { A: config.a, B: config.b };
  const profiles = config.profiles ?? Object.keys(PROFILES);
  for (const profile of profiles) if (!PROFILES[profile]) throw new Error(`unknown profile ${profile}; known: ${Object.keys(PROFILES).join(', ')}`);
  const pauseMs = Math.max(MIN_PAUSE_MS, config.pauseMs ?? MIN_PAUSE_MS);
  const timeoutMs = config.timeoutMs ?? 120_000;
  mkdirSync(config.rawDir, { recursive: true });
  const log = join(config.rawDir, 'runs.jsonl');

  // Zahřátí: věta se před měřením publikuje na obou serverech (stejné tělo jako
  // `CreateGame`), takže každý její běh na obou stranách najde hotovou hru – první
  // běh žádné strany nenese stavbu ani studený server.
  for (const sentence of config.sentences ?? []) for (const base of [bases.A, bases.B]) await publish(base, sentence);
  const targets = (config.sentences ?? []).map((sentence, index) => ({ kind: 'sentence', key: `s${index + 1}-${slug(sentence)}`, sentence }));
  const games = {};
  for (const [index, sentence] of (config.sharedSentences ?? []).entries()) {
    const key = `g${index + 1}-${slug(sentence)}`;
    targets.push({ kind: 'shared', key, sentence });
    games[key] = { A: await publish(bases.A, sentence), B: await publish(bases.B, sentence) };
  }

  const jobs = schedule({ targets, runs: config.runs ?? 3, profiles });
  const results = [];
  for (const [index, job] of jobs.entries()) {
    if (index > 0) await wait(pauseMs);
    const har = join(config.rawDir, `${job.profile}-${job.target.key}-r${job.run}-${job.side}.har`);
    const probe =
      job.target.kind === 'sentence'
        ? { url: `${bases[job.side]}/play`, sentence: job.target.sentence, ...SENTENCE_PROBE }
        : { url: games[job.target.key][job.side] };
    const outcome = await measure({ ...probe, ...PROFILES[job.profile], surfaceSelector: 'canvas', timeoutMs, harPath: har });
    const result = { profile: job.profile, kind: job.target.kind, target: job.target.key, side: job.side, run: job.run, pair: job.pair, playable: outcome.playable, ms: outcome.playable ? outcome.ms : null, firstFrameMs: outcome.firstFrameMs, note: outcome.note, attempts: outcome.attempts, har, t0: outcome.t0, tPlayable: outcome.tPlayable, url: outcome.gameUrl };
    results.push(result);
    appendFileSync(log, `${JSON.stringify(result)}\n`);
    process.stderr.write(`[${index + 1}/${jobs.length}] ${job.profile} ${job.target.key} r${job.run} ${job.side}: ${result.playable ? `${result.ms} ms (first frame ${result.firstFrameMs} ms)` : `FAIL ${result.note}`}\n`);
  }

  const report = {
    about: 'Interleaved A/B time to first playable on /play: the same sentences and shared games on two servers, runs paired back to back. Method: evals/play/first-playable/README.md.',
    measuredAt: new Date().toISOString(),
    a: { url: bases.A, label: config.labelA ?? null },
    b: { url: bases.B, label: config.labelB ?? null },
    probe: 'scripts/measure/time-to-playable.mjs via scripts/measure/first-playable-ab.mjs',
    profiles: Object.fromEntries(profiles.map((profile) => [profile, PROFILES[profile]])),
    runs: config.runs ?? 3,
    pauseMs,
    sentences: config.sentences ?? [],
    sharedSentences: config.sharedSentences ?? [],
    summary: { ...summarize(results), gate: gate(results) },
    summaryFirstFrame: summarize(results, 'firstFrameMs'),
    results: results.map(({ har: _har, ...rest }) => rest),
  };
  if (config.out) writeFileSync(config.out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ gate: report.summary.gate, playable: report.summary.byProfile, firstFrame: report.summaryFirstFrame.byProfile })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node scripts/measure/first-playable-ab.mjs <config.json>');
    process.exit(2);
  }
  await main(JSON.parse(readFileSync(path, 'utf8')));
}
