#!/usr/bin/env node
/**
 * Otevřený slovník P44C: sloveso → kus hry z Open English WordNet 2024 a kotev (`src/play/vocab/anchors.ts`).
 *
 *   node scripts/vocab/build.mjs --evaluate   změří tři metody na zlaté sadě → evals/play/p44c/method.json,
 *                                             vybranou variantu a práh zapíše do config.json
 *
 * Metody (T4): A = cesta hyperonym WordNetu ke kotevnímu synsetu; B = embedding „to <verb>“ proti kotevním
 * slovesům nad prahem; C = A, a kde A nic nedá, B. Všechny tři: kotevní sloveso = svůj cíl; dominantní
 * význam v souboru `filterLexfiles`, jehož cesta ke kotvě nevede → `null`.
 * Osy záměru (move/action/objective) a póza hrdiny (hero) se mapují zvlášť – sloveso může mít obojí.
 * Embeddingy běží v `embed.py` na CPU z offline mezipaměti (`P37A_PYTHON`).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

// anchors.ts je TypeScript: bez odstraňování typů se skript spustí znovu s ním.
if (!process.execArgv.includes('--experimental-strip-types')) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

const here = (relative) => new URL(relative, import.meta.url);
const CONFIG_URL = here('./config.json');
const config = JSON.parse(readFileSync(CONFIG_URL, 'utf8'));
const { ANCHORS } = await import(pathToFileURL(fileURLToPath(here('../../src/play/vocab/anchors.ts'))).href);

const round3 = (value) => Math.round(value * 1000) / 1000;
const isHero = (target) => target.startsWith('hero:');
const GROUPS = { axis: (target) => !isHero(target), hero: isHero };

// ---------------------------------------------------------------------------------------------
// OEWN

function loadOewn() {
  const bytes = readFileSync(config.oewn.file);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== config.oewn.sha256) throw new Error(`OEWN SHA-256 mismatch – run scripts/vocab/fetch-oewn.mjs (${sha})`);
  const xml = gunzipSync(bytes).toString('utf8');
  /** lemma → synsety v pořadí významů (první = nejčastější). */
  const verbs = new Map();
  for (const [, body] of xml.matchAll(/<LexicalEntry [^>]*>([\s\S]*?)<\/LexicalEntry>/g)) {
    const lemma = body.match(/<Lemma writtenForm="([^"]+)" partOfSpeech="v"/)?.[1];
    if (lemma === undefined || !/^[a-z]+$/.test(lemma)) continue;
    const senses = [...body.matchAll(/<Sense [^>]*synset="([^"]+)"/g)].map((match) => match[1]);
    verbs.set(lemma, [...(verbs.get(lemma) ?? []), ...senses]);
  }
  /** synset → { lexfile, hyper }. */
  const synsets = new Map();
  for (const [, attrs, body] of xml.matchAll(/<Synset ([^>]*partOfSpeech="v"[^>]*)>([\s\S]*?)<\/Synset>/g)) {
    const hyper = [...body.matchAll(/<SynsetRelation (?:relType="hypernym" target="([^"]+)"|target="([^"]+)" relType="hypernym")/g)].map((match) => match[1] ?? match[2]);
    synsets.set(attrs.match(/id="([^"]+)"/)[1], { lexfile: attrs.match(/lexfile="([^"]+)"/)?.[1], hyper });
  }
  return { sha, verbs, synsets };
}

// ---------------------------------------------------------------------------------------------
// Metody

/** Kotvy jedné skupiny: synset → cíl a sloveso → cíl. */
function anchorIndex(inGroup) {
  const bySynset = new Map();
  const byVerb = new Map();
  for (const [target, anchor] of Object.entries(ANCHORS)) {
    if (!inGroup(target)) continue;
    for (const synset of anchor.synsets) bySynset.set(synset, target);
    for (const verb of anchor.verbs) if (!byVerb.has(verb)) byVerb.set(verb, target);
  }
  return { bySynset, byVerb };
}

/** Nejbližší kotvy od synsetu po hyperonymech: [[cíl, hloubka]] na nejmenší hloubce, nebo []. */
function nearestAnchors(synset, oewn, bySynset) {
  let frontier = [synset];
  const seen = new Set(frontier);
  for (let depth = 0; depth <= config.wordnet.maxDepth && frontier.length > 0; depth += 1) {
    const hits = [...new Set(frontier.filter((id) => bySynset.has(id)).map((id) => bySynset.get(id)))];
    if (hits.length > 0) return hits.map((target) => [target, depth]);
    frontier = frontier.flatMap((id) => oewn.synsets.get(id)?.hyper ?? []).filter((id) => !seen.has(id) && seen.add(id));
  }
  return [];
}

/** Nejlepší [cíl, skóre] z mapy skóre; shoda skóre → abecedně. */
const best = (scores) => [...scores].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] ?? null;

/**
 * A: každý význam (váha 1/(pořadí+1)) hlasuje pro nejbližší kotvu s útlumem `decay^hloubka`;
 * skóre = podíl z celkové váhy významů. Dominantní význam ve filtrovaném souboru bez kotvy → null.
 */
function wordnetTarget(verb, oewn, index) {
  const senses = oewn.verbs.get(verb) ?? [];
  if (senses.length === 0) return null;
  const votes = new Map();
  let total = 0;
  senses.forEach((synset, rank) => {
    const weight = 1 / (rank + 1);
    total += weight;
    const hits = nearestAnchors(synset, oewn, index.bySynset);
    for (const [target, depth] of hits) votes.set(target, (votes.get(target) ?? 0) + (weight * config.wordnet.decay ** depth) / hits.length);
  });
  const dominant = oewn.synsets.get(senses[0]);
  if (config.wordnet.filterLexfiles.includes(dominant?.lexfile) && nearestAnchors(senses[0], oewn, index.bySynset).length === 0) return null;
  const top = best(votes.entries());
  return top === null ? null : [top[0], round3(top[1] / total)];
}

/** B: nejpodobnější kotevní cíl skupiny podle embeddingu. */
function embedTarget(verb, embeddings, inGroup) {
  const top = best(Object.entries(embeddings[verb] ?? {}).filter(([target]) => inGroup(target)));
  return top === null ? null : [top[0], round3(top[1])];
}

function filtered(verb, oewn) {
  const senses = oewn.verbs.get(verb) ?? [];
  return senses.length > 0 && config.wordnet.filterLexfiles.includes(oewn.synsets.get(senses[0])?.lexfile);
}

/**
 * Předpověď jedné skupiny (`axis` / `hero`) variantou s prahy `{ wordnet, embed }`; `null` = sloveso nemapuje.
 * Práh WordNetu odřízne sloveso, jehož kotvu nese jen vedlejší význam.
 */
function predict({ variant, wordnet, embed }, verb, ctx, group) {
  const index = ctx.indexes[group];
  if (index.byVerb.has(verb)) return [index.byVerb.get(verb), 1];
  const viaWordnet = () => {
    const hit = wordnetTarget(verb, ctx.oewn, index);
    return hit !== null && hit[1] >= wordnet ? hit : null;
  };
  const viaEmbed = () => {
    if (filtered(verb, ctx.oewn)) return null;
    const hit = embedTarget(verb, ctx.embeddings, GROUPS[group]);
    return hit !== null && hit[1] >= embed ? hit : null;
  };
  if (variant === 'A') return viaWordnet();
  if (variant === 'B') return viaEmbed();
  return viaWordnet() ?? viaEmbed();
}

function embedAll(words) {
  const anchors = Object.entries(ANCHORS).flatMap(([target, anchor]) => anchor.verbs.map((text) => ({ target, text })));
  const run = spawnSync(process.env.P37A_PYTHON ?? 'python', [fileURLToPath(here('./embed.py'))], {
    input: JSON.stringify({ words, anchors, revision: config.embed.revision }),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '', HF_HOME: process.env.HF_HOME ?? 'D:/caches/huggingface', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
  if (run.status !== 0) throw new Error(`embed.py failed: ${run.stderr}`);
  const result = JSON.parse(run.stdout);
  if (result.model !== config.embed.model) throw new Error(`embed.py model ${result.model} != ${config.embed.model}`);
  return result.scores;
}

// ---------------------------------------------------------------------------------------------
// --evaluate

const GATE = { precision: 0.9, falseMapped: 2 };
const WORDNET_THRESHOLDS = Array.from({ length: 13 }, (_, i) => round3(i * 0.05));
const EMBED_THRESHOLDS = Array.from({ length: 13 }, (_, i) => round3(0.3 + i * 0.05));

/** Všechny měřené konfigurace: A přes prahy WordNetu, B přes prahy embeddingu, C přes jejich mřížku. */
const CONFIGS = [
  ...WORDNET_THRESHOLDS.map((wordnet) => ({ variant: 'A', wordnet, embed: null })),
  ...EMBED_THRESHOLDS.map((embed) => ({ variant: 'B', wordnet: null, embed })),
  ...WORDNET_THRESHOLDS.flatMap((wordnet) => EMBED_THRESHOLDS.map((embed) => ({ variant: 'C', wordnet, embed }))),
];
const label = (method) => `${method.variant}@${method.wordnet ?? '-'}/${method.embed ?? '-'}`;

function score(method, gold, ctx) {
  let predicted = 0;
  let correct = 0;
  let falseMapped = 0;
  const errors = [];
  for (const { verb, target } of gold) {
    const axis = predict(method, verb, ctx, 'axis')?.[0] ?? null;
    const hero = predict(method, verb, ctx, 'hero')?.[0] ?? null;
    if (target === null) {
      if (axis !== null || hero !== null) {
        falseMapped += 1;
        errors.push({ verb, gold: null, got: axis ?? hero });
      }
      continue;
    }
    const got = isHero(target) ? hero : axis;
    if (got === null) continue;
    predicted += 1;
    if (got === target) correct += 1;
    else errors.push({ verb, gold: target, got });
  }
  const positives = gold.filter((pair) => pair.target !== null).length;
  return {
    ...method,
    precision: predicted === 0 ? 0 : round3(correct / predicted),
    coverage: round3(correct / positives),
    correct,
    predicted,
    falseMapped,
    errors,
  };
}

function evaluate() {
  const gold = JSON.parse(readFileSync(here('../../src/play/vocab/__fixtures__/gold-verbs.json'), 'utf8')).pairs;
  const oewn = loadOewn();
  const words = [...new Set([...gold.map((pair) => pair.verb), ...config.probes])].sort();
  const ctx = { oewn, embeddings: embedAll(words), indexes: { axis: anchorIndex(GROUPS.axis), hero: anchorIndex(GROUPS.hero) } };

  const runs = CONFIGS.map((method) => score(method, gold, ctx));
  const passes = (run) => run.precision >= GATE.precision && run.falseMapped <= GATE.falseMapped;
  const order = { A: 0, C: 1, B: 2 };
  // Nejvyšší pokrytí, které bránu splní; shoda → přesnější, jednodušší varianta, přísnější prahy.
  const passing = runs
    .filter(passes)
    .sort((a, b) => b.coverage - a.coverage || b.precision - a.precision || order[a.variant] - order[b.variant] || (b.wordnet ?? 0) - (a.wordnet ?? 0) || (b.embed ?? 0) - (a.embed ?? 0));
  const fallback = [...runs].sort((a, b) => b.precision - a.precision || a.falseMapped - b.falseMapped || b.coverage - a.coverage);
  const chosen = passing[0] ?? fallback[0];
  const method = { variant: chosen.variant, wordnet: chosen.wordnet, embed: chosen.embed };
  const probes = Object.fromEntries(config.probes.map((verb) => [verb, { axis: predict(method, verb, ctx, 'axis')?.[0] ?? null, hero: predict(method, verb, ctx, 'hero')?.[0] ?? null }]));
  const bestOf = (variant) => runs.filter((run) => run.variant === variant).sort((a, b) => Number(passes(b)) - Number(passes(a)) || b.coverage - a.coverage || b.precision - a.precision)[0];

  const summary = ({ errors, ...rest }) => rest;
  const report = {
    about: 'P44C T4: three verb-mapping methods on the dev gold set (src/play/vocab/__fixtures__/gold-verbs.json). Written by scripts/vocab/build.mjs --evaluate.',
    oewnSha256: oewn.sha,
    gold: { pairs: gold.length, positives: gold.filter((pair) => pair.target !== null).length, negatives: gold.filter((pair) => pair.target === null).length },
    gate: GATE,
    bestPerVariant: Object.fromEntries(['A', 'B', 'C'].map((variant) => [variant, { ...summary(bestOf(variant)), passesGate: passes(bestOf(variant)) }])),
    selected: { ...summary(chosen), passesGate: passes(chosen) },
    selectedErrors: chosen.errors,
    probes,
    variants: runs.map(summary),
  };
  writeFileSync(here('../../evals/play/p44c/method.json'), `${JSON.stringify(report, null, 1)}\n`);
  writeFileSync(CONFIG_URL, `${JSON.stringify({ ...config, method: { ...method, passesGate: passes(chosen) } }, null, 2)}\n`);
  for (const variant of ['A', 'B', 'C']) {
    const run = bestOf(variant);
    console.log(`  best ${label(run)} p=${run.precision} cov=${run.coverage} fm=${run.falseMapped} gate=${passes(run)}`);
  }
  console.log(`selected ${label(chosen)} gate ${passes(chosen) ? 'PASS' : 'FAIL'}; probes ${JSON.stringify(probes)}`);
  if (process.env.VOCAB_DEBUG) for (const error of runs.find((run) => label(run) === process.env.VOCAB_DEBUG).errors) console.log(JSON.stringify(error));
}

if (process.argv.includes('--evaluate')) evaluate();
else {
  console.error('usage: node scripts/vocab/build.mjs --evaluate');
  process.exit(2);
}
