/**
 * Power-upy a kombo P46C na panelu P45 (robot intermediate, táž hra jako `fun.measure`):
 * `npx vitest run --config vitest.measure.mts evals/play/p46c/powerups.measure.ts`.
 * Zapíše `evals/play/p46c/after.json` bez času, takže běh beze změny kódu nechá git čistý.
 */

import { writeFileSync } from 'node:fs';

import { it } from 'vitest';

import { ARCADE_LIMITS, type ArcadeWorld, BODY, FLAG, HEADER, NO_INPUT, ROLE, bodyBase, underlyingRule } from '@/play/arcade/contract';
import { instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { runBot } from '@/play/arcade/verify';

import { funSentences, publishedWorld } from '../p45/fun';

const keeperOf = (world: ArcadeWorld): number | undefined =>
  world.rules.map(underlyingRule).map((ref) => (ref.params as { readonly combo?: number }).combo).find((combo) => combo !== undefined);

function played(world: ArcadeWorld): { readonly placed: number; readonly picked: number; readonly bestMultiplier: number } {
  const run = runBot(world, undefined, { profile: 'intermediate' });
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const keeper = keeperOf(world);
  const powerups: number[] = [];
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) if (state[bodyBase(i) + BODY.role] === ROLE.powerup) powerups.push(i);
  let next = 0;
  let best = keeper === undefined ? 0 : 1;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    while (next < run.inputs.length && (run.inputs[next] as { tick: number }).tick < tick) next += 1;
    const event = run.inputs[next];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program);
    if (keeper !== undefined) best = Math.max(best, state[bodyBase(keeper) + BODY.aux0] as number);
  }
  const picked = powerups.filter((body) => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) === 0).length;
  return { placed: powerups.length, picked, bestMultiplier: best };
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

it('measures power-ups and combo on the P45 panel', async () => {
  const rows = [];
  for (const sentence of funSentences('panel')) {
    const { genre, playable, world } = await publishedWorld(sentence.text);
    rows.push({ id: sentence.id, genre, playable, ...(world === null || !playable ? {} : played(world)) });
  }
  const live = rows.filter((row) => row.playable && 'picked' in row) as (typeof rows[number] & { picked: number; placed: number; bestMultiplier: number })[];
  const summary = {
    n: rows.length,
    playable: live.length,
    withPowerups: live.filter((row) => row.placed > 0).length,
    pickedShare: Math.round((live.filter((row) => row.picked > 0).length / live.length) * 100) / 100,
    bestMultiplierMedian: median(live.map((row) => row.bestMultiplier)),
  };
  writeFileSync('evals/play/p46c/after.json', `${JSON.stringify({ schema: 'p46c-powerups.v1', set: 'panel', profile: 'intermediate', summary, rows }, null, 1)}\n`);
}, 1_800_000);
