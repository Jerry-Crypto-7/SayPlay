#!/usr/bin/env node
/**
 * P66 T1: slepé štítky žánrů. Každá věta sady 200 (`p30/test-200.json`) a otevřených sad dostane od slepého soudce
 * textu nejlepší žánr (`best`, nebo `none` pro větu, ve které není žádná hra) a 1–3 přijatelné žánry (`acceptable`)
 * ze seznamu 24 typů her (19 dnešních + survivor, díra, krádež, třídění, šipky). Štítky se zmrazí dřív, než P66
 * změní klasifikátor; `genre-route.mjs` z nich počítá podíl špatného žánru a dosah nových žánrů.
 *
 *   node evals/play/p66/genre-labels.mjs [--out evals/play/p66/genre-labels.json] [--limit <dávek>]
 *
 * Soudce `claude -p --safe-mode --tools ""` v prázdném `mkdtemp`: vidí jen očíslované věty a popis 24 typů slovy pod
 * neutrálními klíči G01–G24 (pořadí klíčů losuje seed). Žádné id z kódu, jméno produktu ani jméno cizí hry.
 * Dávky po 20 větách, souběh 1. Pořadí vět (a tím dávek) = Fisher–Yates `pure-rand` xoroshiro128plus ze `SEED`,
 * zapsaného v JSON. Hotové dávky se zapisují po každé dávce; další běh je přeskočí (`--fresh` začne znovu).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAY = path.resolve(HERE, '..');
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

export const SEED = 66028;
export const BATCH = 20;
export const MODEL = 'claude-opus-5-5';

/** Sada 200 a otevřené sady (cesty od `evals/play`); `p56c/*.json` = každý soubor složky, který je sadou vět. */
export const TEST_SET = 'p30/test-200.json';
const OPEN_FIXED = ['p30/dev.json', 'p58b/holdout.json', 'p61/holdout.json', 'p62/holdout.json', 'p62/holdout-b.json', 'p63/holdout.json', 'p63/read-set.json', 'p63/reread-set.json'];

/** Stejné jako `normalizeSentence` v `scripts/play-fidelity.mjs` (pečeť P63): malá písmena, bez interpunkce. */
export const normalize = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

/** Věty sady jako `textsOf` v `p58b/seal.ts`: pole `{ id?, text }` nebo `{ sentences: [...] }`; jiný soubor nic. */
export function rowsOf(set) {
  const json = JSON.parse(readFileSync(path.join(PLAY, set), 'utf8'));
  const rows = Array.isArray(json) ? json : json?.sentences;
  return Array.isArray(rows) && rows.length > 0 && rows.every((row) => typeof row?.text === 'string') ? rows.map((row, i) => ({ id: typeof row.id === 'string' ? row.id : String(i), text: row.text })) : [];
}

export function openSets() {
  const p56c = readdirSync(path.join(PLAY, 'p56c')).filter((name) => name.endsWith('.json')).map((name) => `p56c/${name}`);
  return [...OPEN_FIXED.slice(0, 1), ...p56c, ...OPEN_FIXED.slice(1)].filter((set) => existsSync(path.join(PLAY, set)) && rowsOf(set).length > 0);
}

/** Jedinečné věty (podle `normalize`) sady 200 a otevřených sad; věta nese všechna místa, kde stojí. */
export function loadSentences() {
  const byKey = new Map();
  for (const set of [TEST_SET, ...openSets()]) {
    for (const row of rowsOf(set)) {
      const key = normalize(row.text);
      const entry = byKey.get(key) ?? { key, text: row.text, sets: [] };
      entry.sets.push({ set, id: row.id });
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

/**
 * Popis 24 typů her vlastními slovy (Pravidla běhu: žádné id z kódu, jméno produktu ani jméno cizí hry). Klíč je
 * id žánru jen pro tento skript; soudce ho nevidí.
 */
export const DESCRIPTIONS = {
  runner: 'Endless run: the hero runs forward on its own down a track, street or slope (also skiing, skating, surfing, sledding), switching lanes and jumping or sliding to dodge obstacles while picking things up on the way.',
  platformer: 'Platform jumping: the hero runs and jumps from ledge to ledge over gaps and climbs upward, side view, to reach the end of the level.',
  arena: 'Open-area roaming seen from above: the hero moves freely around one place to gather scattered things, to run away from chasers, or to brawl with several opponents.',
  voyage: 'Steering a craft: sail, fly, drive or ride a ship, plane, car, broom or rocket along a course between obstacles to a destination, or bring a craft down for a soft landing.',
  quest: 'Doing a job on objects: go to things in a place and act on each one – light, put out, cook, flip, repair, free, water, paint – often while something chases you, or work a station like a stove before orders pile up.',
  shooter: 'Aim and shoot: point at targets or enemies that come at you and shoot them down, like a shooting gallery or a wave of attackers.',
  throw: 'Throwing at a target: aim and throw, toss or launch something (a ball into a hoop, a golf shot, a slingshot or catapult, bowling) to hit a goal.',
  timing: 'One-tap timing: something swings back and forth and a single tap stops it at the right moment – dropping blocks onto a growing tower, stopping a needle on a mark, laying a plank across a gap.',
  rhythm: 'Rhythm: tap in time with the beats of the music as notes arrive (drums, dancing, piano).',
  duel: 'One-on-one duel: face a single opponent at a time, dodge when they wind up and strike back in the opening – a showdown or a fight against a rival.',
  flap: 'Flapping flight: every tap gives a small lift; keep the flyer in the air and steer it through gaps between obstacles.',
  catch: 'Catching what falls: slide left and right along the bottom to catch things falling from above and let the dangerous ones pass.',
  whack: 'Whack the pop-ups: things pop out of holes or hiding spots for a moment and you hit them before they disappear again.',
  defense: 'Lane defense: waves of enemies march down lanes toward your base or wall and you shoot them before they reach it.',
  slice: 'Slicing: things are tossed up into the air and you swipe to cut them, leaving the bombs alone.',
  hop: 'Road crossing: hop forward step by step across lanes of traffic, rivers or rails to reach the far side without getting hit.',
  crowd: 'Growing crowd: run through gates that multiply or shrink a crowd of followers, dodge what thins it out, and throw the whole crowd at a big boss at the end.',
  merge: 'Drop and merge: drop things into a container where two identical ones combine into a bigger one; keep the heap from reaching the top.',
  push: 'Push out of the ring: shove rivals off a platform or out of a ring while staying on it yourself.',
  survivor: 'Survive the horde: move the hero around with a stick while it attacks automatically; ever larger swarms close in, between waves you pick one of three upgrades, and a big boss comes at the end.',
  hole: 'Growing hole: steer a hole in the ground around a place (a city, a farm, a kitchen); it swallows everything smaller than itself and grows, so bigger and bigger things fit in.',
  steal: 'Grab and run: get into someone else\'s place, grab a valuable thing and carry it back to your own base while guards chase you; upgrades between rounds.',
  sort: 'Sorting: tap to move items or colours between containers – tubes, shelves, boxes, cars – until every container holds just one kind; short puzzle rounds.',
  arrows: 'Tap-away puzzle: a tight pack of pieces each pointing one way; a tapped piece slides off in its direction only if its path is clear, so you clear the board in the right order.',
};
export const GENRE_IDS = Object.keys(DESCRIPTIONS);
export const NEW_GENRES = ['survivor', 'hole', 'steal', 'sort', 'arrows'];

/** Fisher–Yates `pure-rand` xoroshiro128plus jedním proudem: nejdřív klíče typů, pak pořadí vět. */
export function plan(sentences, seed = SEED) {
  const rng = xoroshiro128plus(seed);
  const shuffle = (list) => {
    const out = list.slice();
    for (let k = out.length - 1; k > 0; k -= 1) {
      const j = uniformInt(rng, 0, k);
      [out[k], out[j]] = [out[j], out[k]];
    }
    return out;
  };
  const genres = shuffle(GENRE_IDS);
  const keys = Object.fromEntries(genres.map((genre, i) => [`G${String(i + 1).padStart(2, '0')}`, genre]));
  const order = shuffle(sentences.map((s) => s.key));
  const batches = [];
  for (let i = 0; i < order.length; i += BATCH) batches.push(order.slice(i, i + BATCH));
  return { keys, batches };
}

export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['labels'],
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'best', 'acceptable'],
        properties: { n: { type: 'integer' }, best: { type: 'string' }, acceptable: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
};

export function questionFor(texts, keys) {
  const types = Object.entries(keys).map(([key, genre]) => `${key}: ${DESCRIPTIONS[genre]}`);
  const lines = texts.map((text, i) => `${i + 1}. ${text}`);
  return [
    'Each sentence below was typed by a person who wants a short game for a phone made from it. For every sentence choose, from the game types listed, the one that would fit the sentence best, and the types that would all be acceptable readings of it.',
    '',
    'GAME TYPES:',
    ...types,
    '',
    'RULES:',
    '- best: the one type key that fits the sentence best. Use NONE only when the sentence asks for no playable action at all (a question, an essay, a chore, a request for information) so that no type could reasonably be read into it.',
    '- acceptable: 1 to 3 type keys, best included, under which a player would still recognise their sentence. Empty only when best is NONE.',
    '- Judge only from the sentence text. Do not use any tools or search the web.',
    'Answer only as JSON per the schema, one entry per sentence number n.',
    '',
    'SENTENCES:',
    ...lines,
  ].join('\n');
}

/** Odpověď platí, když každé číslo 1..n má právě jeden řádek, klíče jsou ze seznamu a `acceptable` má 0–3 klíče. */
export function readAnswer(value, count, keys) {
  if (!Array.isArray(value?.labels)) return null;
  const known = new Set(Object.keys(keys));
  const out = [];
  for (let n = 1; n <= count; n += 1) {
    const rows = value.labels.filter((row) => row?.n === n);
    if (rows.length !== 1) return null;
    const { best, acceptable } = rows[0];
    if (typeof best !== 'string' || !Array.isArray(acceptable)) return null;
    const bestKey = best.trim().toUpperCase();
    if (bestKey !== 'NONE' && !known.has(bestKey)) return null;
    const acc = [...new Set(acceptable.map((key) => String(key).trim().toUpperCase()))].filter((key) => known.has(key));
    // Nejlepší typ je vždy přijatelný; soudce, který ho zapomene zopakovat, ho dostane na první místo.
    const merged = bestKey === 'NONE' ? [] : [bestKey, ...acc.filter((key) => key !== bestKey)].slice(0, 3);
    out.push({ best: bestKey === 'NONE' ? 'none' : keys[bestKey], acceptable: merged.map((key) => keys[key]) });
  }
  return out;
}

const CLAUDE = process.platform === 'win32' ? path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : 'claude';

/** Jedna slepá otázka: prázdný `mkdtemp` jako cwd, bez nástrojů, bez CLAUDE.md, hooků a paměti (`--safe-mode`). */
export function ask(question, schema = ANSWER_SCHEMA) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'labels-'));
  const args = ['-p', '--safe-mode', '--strict-mcp-config', '--tools', '', '--no-session-persistence', '--model', MODEL, '--output-format', 'json', '--json-schema', JSON.stringify(schema), question];
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(CLAUDE, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { stderr += error.message; });
    child.on('close', (code) => {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch { /* prázdný adresář v tempu nevadí */ }
      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        envelope = undefined;
      }
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      if (code !== 0 || envelope?.is_error) return done({ error: `${code}: ${(envelope?.result ?? stdout ?? '').toString().slice(-300)} ${stderr.slice(-200)}`, seconds });
      let answer = envelope?.structured_output;
      if (answer === undefined && typeof envelope?.result === 'string') {
        const text = envelope.result;
        try {
          answer = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        } catch { /* žádný JSON */ }
      }
      done({ answer, seconds });
    });
  });
}

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

async function main() {
  const out = path.resolve(flag('--out', path.join(HERE, 'genre-labels.json')));
  const limit = Number(flag('--limit', 'Infinity'));
  const sentences = loadSentences();
  const { keys, batches } = plan(sentences);
  const prior = !process.argv.includes('--fresh') && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  const done = new Map(Object.entries(prior?.batchResults ?? {}));
  const calls = { total: prior?.calls?.total ?? 0, failed: prior?.calls?.failed ?? 0, seconds: prior?.calls?.seconds ?? 0 };
  const byKey = new Map(sentences.map((s) => [s.key, s]));
  const write = () => {
    const labels = new Map();
    for (const [, rows] of done) for (const row of rows) labels.set(row.key, row);
    const rows = sentences.map((s) => ({ text: s.text, sets: s.sets, ...(labels.has(s.key) ? { best: labels.get(s.key).best, acceptable: labels.get(s.key).acceptable, batch: labels.get(s.key).batch } : { best: null, acceptable: null, batch: null }) }));
    const sets = Object.fromEntries([TEST_SET, ...openSets()].map((set) => [set, rowsOf(set).length]));
    writeFileSync(out, `${JSON.stringify({
      schema: 'p66-genre-labels.v1',
      about: 'Blind text judge labels per unique sentence (normalized text) of the 200 set and the open sets: best genre (or none = no game in the sentence) and 1-3 acceptable genres out of 24 (19 current + survivor, hole, steal, sort, arrows). Frozen before P66 changes the classifier.',
      judge: `${MODEL} (claude -p --safe-mode --tools "" in an empty mkdtemp; sees only numbered sentences and the 24 plain-word type descriptions under keys G01-G24)`,
      seed: SEED,
      generator: 'pure-rand xoroshiro128plus + uniformInt, Fisher-Yates: first the G-key order of the 24 types, then the sentence order; batches = consecutive 20',
      batchSize: BATCH,
      keys,
      descriptions: DESCRIPTIONS,
      sets,
      unique: sentences.length,
      batches: batches.length,
      batchesDone: done.size,
      calls,
      batchResults: Object.fromEntries(done),
      sentences: rows,
    }, null, 1)}\n`);
  };
  let ran = 0;
  for (let b = 0; b < batches.length && ran < limit; b += 1) {
    if (done.has(String(b))) continue;
    const texts = batches[b].map((key) => byKey.get(key).text);
    const question = questionFor(texts, keys);
    let rows = null;
    for (let attempt = 0; attempt < 2 && rows === null; attempt += 1) {
      const result = await ask(question);
      calls.total += 1;
      calls.seconds = Math.round((calls.seconds + result.seconds) * 10) / 10;
      rows = result.error === undefined ? readAnswer(result.answer, texts.length, keys) : null;
      if (rows === null) {
        calls.failed += 1;
        console.log(`batch ${b} attempt ${attempt}: ${result.error ?? 'answer does not fit the schema'} (${result.seconds} s)`);
      } else console.log(`batch ${b}/${batches.length}: ok (${result.seconds} s)`);
    }
    ran += 1;
    if (rows === null) continue;
    done.set(String(b), rows.map((row, i) => ({ key: batches[b][i], batch: b, ...row })));
    write();
  }
  write();
  console.log(`DONE batches ${done.size}/${batches.length}, calls ${calls.total} (failed ${calls.failed})`);
}

if (isMain) await main();
