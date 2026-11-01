#!/usr/bin/env node
/**
 * Herní brána P68 (T5): pro každou větu postaví svět hry a vyhodnotí požadované akce z
 * `evals/play/p68/assertions.json` nad stopou stavu (`src/play/arcade/gameplay-assert.ts`), ne nad efekty pravidel.
 *
 *   node --experimental-strip-types scripts/measure/gameplay-gate.mjs <specs.json> [--out <report.json>]
 *
 * `specs.json`: pole (nebo `{ "entries": [...] }`) položek `{ game, sentence, spec, seed? }` – `spec` je GameSpecV1,
 * svět z něj staví `arcadeWorldOf` (týž překlad jako `compileArcade`, bez jeho robota) se `seed` (výchozí 1); místo
 * `spec` smí položka nést hotový svět `world`.
 *
 * Výstup JSON: `results` po hře a větě – `win` (robot vyhraje do 5400 tiků), `lose` (nečinný hráč i slabý robot
 * prohrají), `actions` (všechny požadované akce hry prošly), `assertions` (`{ id, run, pass, evidence }`), `failed`
 * (překlad nebo běh spadl, důvod; jinak `null`) – a `games`: počty po hře, kde se do jmenovatele `n` počítá i `failed`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// `ts-paths.mjs` (cesty `@/`, přípony, JSON), vitest sám.
if (!process.env.VITEST) await import('../ts-paths.mjs');
const { P68_ASSERTIONS, assertGame } = await import('../../src/play/arcade/gameplay-assert.ts');
const { arcadeWorldOf } = await import('../../src/play/arcade/compile.ts');
const { worldHasPhysics } = await import('../../src/play/arcade/kernel.ts');
const { loadRapier } = await import('../../src/play/arcade/physics/world.ts');

const EVERY = new Set(P68_ASSERTIONS.every.map((requirement) => requirement.id));

const message = (error) => (error instanceof Error ? error.message : String(error));

async function worldOf(entry) {
  if (entry.world !== undefined) return entry.world;
  const made = arcadeWorldOf(entry.spec, entry.seed ?? 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Jedna věta: překlad, tři běhy, verdikt. Pád překladu i běhu je `failed`, ne výjimka celé brány. */
export async function gateEntry(entry) {
  const base = { game: entry.game, sentence: entry.sentence ?? null, seed: entry.seed ?? 1 };
  let world;
  try {
    world = await worldOf(entry);
    if (worldHasPhysics(world)) await loadRapier();
  } catch (error) {
    return { ...base, failed: `compile: ${message(error)}`, win: false, lose: false, actions: false, assertions: [] };
  }
  try {
    const assertions = assertGame(entry.game, world);
    const passed = (id) => assertions.find((result) => result.id === id)?.pass === true;
    return {
      ...base,
      failed: null,
      win: passed('bot-wins'),
      lose: passed('idle-loses') && passed('weak-loses'),
      actions: assertions.filter((result) => !EVERY.has(result.id)).every((result) => result.pass),
      assertions,
    };
  } catch (error) {
    return { ...base, failed: `run: ${message(error)}`, win: false, lose: false, actions: false, assertions: [] };
  }
}

export async function gate(entries) {
  const results = [];
  for (const entry of entries) results.push(await gateEntry(entry));
  const games = {};
  for (const result of results) {
    const row = (games[result.game] ??= { n: 0, failed: 0, win: 0, lose: 0, actions: 0, pass: 0 });
    row.n += 1;
    if (result.failed !== null) row.failed += 1;
    if (result.win) row.win += 1;
    if (result.lose) row.lose += 1;
    if (result.actions) row.actions += 1;
    if (result.win && result.lose && result.actions) row.pass += 1;
  }
  return { maxTicks: P68_ASSERTIONS.maxTicks, games, results };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args[outAt + 1] : undefined;
  const input = args.find((arg, index) => !arg.startsWith('--') && (outAt < 0 || index !== outAt + 1));
  if (input === undefined) {
    console.error('usage: node --experimental-strip-types scripts/measure/gameplay-gate.mjs <specs.json> [--out <report.json>]');
    process.exit(2);
  }
  const parsed = JSON.parse(readFileSync(input, 'utf8'));
  const report = await gate(Array.isArray(parsed) ? parsed : parsed.entries);
  const text = `${JSON.stringify(report, null, 1)}\n`;
  if (out !== undefined) writeFileSync(out, text);
  else process.stdout.write(text);
}
