#!/usr/bin/env node
/**
 * Slepý soud P56C T16: řetěz s mutátory proti témuž řetězu bez nich, 12 dev vět.
 *
 * Obě strany z téhož buildu: server `--base` staví s mutátory, server `--base-plain` běží s `PLAY_CHAIN_MUTATORS=0`.
 * Stejná věta = stejné semínko = stejná kola i rozložení (mutátory se losují až nad hotovými koly, `buildChain`),
 * takže se strany liší jen mutátory. Klip (`chainClip`), list (`sheet`), otázka a soudce (`pairwise`, Codex v prázdném
 * `mkdtemp`) jako T14; strana vlevo losem `JUDGE_SEED`. Pod `TARGET` → `CHAIN_MUTATORS = false` (AC T16).
 *
 *   node evals/play/p56c/judge-mutators.mjs --base http://127.0.0.1:3111 --base-plain http://127.0.0.1:3112 [--no-judge]
 *
 * Strana s mutátory potřebuje build se `CHAIN_MUTATORS = true` (po soudu 21. 10. vypnuto). Přepíše `mutators.md`
 * včetně ručně psaného oddílu „Rozhodnutí“.
 *
 * Věty: první čtyři z každé rodiny, kterou route posílá do řetězu (`decide.md`), vybrané před soudem.
 * Zapíše `mutators.json` a `mutators.md`; snímky a listy leží v `evals/play/fidelity/runs/` (gitignored).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && !process.features.typescript) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const RUNS = join(ROOT, 'evals', 'play', 'fidelity', 'runs');

export const IDS = ['d01', 'd02', 'd04', 'd05', 'd23', 'd24', 'd25', 'd26', 'd33', 'd34', 'd35', 'd36'];
/** Brána T16: podíl výher řetězu s mutátory z rozhodnutých párů. */
export const TARGET = 0.6;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
const round3 = (value) => Math.round(value * 1000) / 1000;

function options() {
  const out = {};
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i += 1) if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1]?.startsWith('--') === false ? list[++i] : true;
  return out;
}

export function summaryOf(pairs) {
  const count = (winner) => pairs.filter((pair) => pair.winner === winner).length;
  const mutatorWins = count('mutators');
  const plainWins = count('plain');
  const decided = mutatorWins + plainWins;
  return {
    n: pairs.length,
    mutatorWins,
    plainWins,
    ties: count('tie'),
    decided,
    mutatorShareDecided: decided === 0 ? null : round3(mutatorWins / decided),
    leftWinShare: decided === 0 ? null : round3(pairs.filter((pair) => pair.winner === pair.left).length / decided),
  };
}

function markdown(judged) {
  const s = judged.summary;
  const verdict = judged.skipped ? `přeskočeno (${judged.reason})` : judged.met ? 'splněno' : 'nesplněno';
  const keys = (rounds) => (rounds === null ? 'není řetěz' : rounds.join(' → '));
  return [
    '# P56C T16 – slepý soud: řetěz s mutátory proti řetězu bez nich',
    '',
    `Změřeno ${judged.date} na \`${judged.commit}\` \`judge-mutators.mjs\`: ${String(IDS.length)} dev vět (první čtyři z rodin \`multi_verb\`, \`no_verb\`, \`world_only\`, které route posílá do řetězu), obě strany ze stejného buildu, druhý server s \`PLAY_CHAIN_MUTATORS=0\`. Stejné semínko = stejná kola i rozložení, liší se jen mutátory kol 2 až N−1. Klip ${String(judged.frames)} snímků jen plátna přes všechna kola, robot kola; soudce Codex nad listem v prázdném adresáři, strana vlevo losem (\`JUDGE_SEED\` ${String(judged.seed)}). Otázka stejná jako T14.`,
    '',
    '| Kontrola | Cíl | Výsledek |',
    '|---|---|---|',
    `| řetěz s mutátory vyhraje z rozhodnutých párů | ≥ ${String(TARGET)} | ${judged.skipped ? '–' : `${String(s.mutatorWins)}/${String(s.decided)} = ${String(s.mutatorShareDecided)}`} (${verdict}) |`,
    `| remízy | – | ${String(s.ties)} |`,
    `| podíl výher levého sloupce (zkreslení soudce) | ~0,5 | ${String(s.leftWinShare)} |`,
    '',
    '## Páry',
    '',
    '| id | kola s mutátory | vlevo | vítěz | proč (soudce) |',
    '|---|---|---|---|---|',
    ...judged.pairs.map((pair) => `| ${pair.id} | ${keys(pair.mutatorKeys)} | ${pair.left} | ${pair.winner} | ${String(pair.why ?? '').replaceAll('|', '/')} |`),
    '',
    ...(judged.notChain.length === 0 ? [] : [`Věty, které server neposlal do řetězu (bez páru): ${judged.notChain.join(', ')}.`, '']),
  ].join('\n');
}

async function main() {
  const opts = options();
  const base = typeof opts.base === 'string' ? opts.base : 'http://127.0.0.1:3111';
  const basePlain = typeof opts['base-plain'] === 'string' ? opts['base-plain'] : 'http://127.0.0.1:3112';
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const run = typeof opts.run === 'string' ? opts.run : 'p56c-t16-mutators';
  const sides = { plain: { base: basePlain, dir: `${run}-plain` }, mutators: { base, dir: `${run}-twisted` } };
  for (const side of Object.values(sides)) mkdirSync(join(RUNS, side.dir), { recursive: true });
  const sentences = readJson(join(HERE, 'dev.json')).sentences.filter((sentence) => IDS.includes(sentence.id));

  const { publish, gameOf, chainClip, sheet, QUESTION, FRAMES, JUDGE_SEED } = await import('./judge.mjs');
  const { pairwise } = await import('../../../scripts/play-fidelity.mjs');
  const { ask } = await import('../../../scripts/p37d/judge-sheet.mjs');
  const { chromium } = createRequire(import.meta.url)('@playwright/test');
  const angle = opts.software === true ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-gl=angle', '--use-angle=d3d11'];

  const browser = await chromium.launch({ args: angle });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    for (const sentence of sentences) {
      for (const [name, side] of Object.entries(sides)) {
        const file = join(RUNS, side.dir, `${sentence.id}.json`);
        if (existsSync(file)) continue;
        const versionId = await publish(side.base, { sentence: sentence.text });
        const game = await gameOf(side.base, versionId);
        const keys = game.chain?.rounds.map((round) => (round.mutator === undefined ? round.key : `${round.key} + ${round.mutator}`)) ?? null;
        const clip = keys === null ? null : await chainClip(page, `${side.base}/play/${versionId}`, join(RUNS, side.dir, sentence.id));
        writeJson(file, { id: sentence.id, versionId, keys, pace: clip });
        console.log(`${sentence.id} ${name} ${keys === null ? 'NOT A CHAIN' : `${keys.join(' > ')} · ${String(clip.frames.length)} frames · ${clip.outcome}`}`);
      }
    }
    await page.close();
  } finally {
    await browser.close();
  }

  const keysOf = (name, id) => readJson(join(RUNS, sides[name].dir, `${id}.json`)).keys;
  const notChain = IDS.filter((id) => keysOf('plain', id) === null || keysOf('mutators', id) === null);
  const head = { schema: 'p56c-judge-mutators.v1', date: new Date().toISOString().slice(0, 10), commit, base, basePlain, a: sides.plain.dir, b: sides.mutators.dir, seed: JUDGE_SEED, frames: FRAMES, question: QUESTION, target: `mutators win >= ${String(TARGET)} of decided pairs`, notChain };
  let judged;
  if (opts['no-judge'] === true) {
    judged = { ...head, skipped: true, reason: '--no-judge (dry run)', pairs: [], summary: summaryOf([]) };
  } else {
    const composer = await chromium.launch();
    try {
      const sheetPage = await composer.newPage({ viewport: { width: 1100, height: 800 } });
      const verdict = await pairwise(
        { a: sides.plain.dir, b: sides.mutators.dir, seed: JUDGE_SEED, out: join(RUNS, `${run}-pairwise.json`), runsDir: RUNS, 'a-commit': commit, 'b-commit': commit, concurrency: 1 },
        { ask: (sheetFile, schemaFile, answerFile) => ask(sheetFile, schemaFile, answerFile, QUESTION), compose: (left, right, path) => sheet(sheetPage, left, right, path) },
      );
      const side = (letter) => (letter === 'b' ? 'mutators' : letter === 'a' ? 'plain' : 'tie');
      const pairs = verdict.pairs.map((pair) => ({ id: pair.id, mutatorKeys: keysOf('mutators', pair.id), left: side(pair.left), winner: side(pair.winner), why: pair.why }));
      const summary = summaryOf(pairs);
      judged = { ...head, skipped: false, summary, met: summary.mutatorShareDecided !== null && summary.mutatorShareDecided >= TARGET, pairs };
    } catch (error) {
      judged = { ...head, skipped: true, reason: error.message.slice(0, 400), pairs: [], summary: summaryOf([]) };
    } finally {
      await composer.close();
    }
  }
  writeJson(join(HERE, 'mutators.json'), judged);
  writeFileSync(join(HERE, 'mutators.md'), `${markdown(judged)}\n`);
  const s = judged.summary;
  console.log(judged.skipped ? `judge skipped: ${judged.reason}` : `judge: mutators ${String(s.mutatorWins)}/${String(s.decided)} decided (${String(s.mutatorShareDecided)}, target ${String(TARGET)}) ties ${String(s.ties)}`);
}

if (isMain) await main();
