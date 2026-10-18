/**
 * Oznámení nativních finále P51 (T9). Chodec, klouzání, míč a chytání mají finále, které staví generátor (stezka
 * jisker k východu, tunel kruhů, soupeř-boss za terči, kořist na tři chycení) – pravidlo `pacing` má jen hodiny,
 * takže banner P47A je dřív neohlásil vůbec. Pin hraje vyhrané běhy robota intermediate na větách dev sady P51,
 * vede banner (`createPacingBannerWatch`) tik po tiku a vedle něj čte svět: nápis přijde jednou, anglicky, před
 * výhrou a v tiku, kdy změna ve světě opravdu nastala (míč: padl poslední terč a soupeř žije; chytání: kořist
 * právě ztratila první HP; chodec a klouzání: v posledních vteřinách hry). Uložená hra bez značky nové hry
 * (`segments`) nemá co ohlásit, jako dřív.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { PACING_BANNER_LABELS, createPacingBannerWatch, pacingBannerLabel } from '@/components/play/arcade/PacingBanner';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

import { arcadeWorldOf, preloadPhysics } from '../compile';
import { ARCADE_HZ, type ArcadeState, type ArcadeWorld, BODY, FLAG, HEADER, ROLE, bodyBase, bodyHp } from '../contract';
import { instantiate } from '../kernel';
import { loadRapier } from '../physics/world';
import { CATCH_FINALE } from '../pieces/arena-catch';
import { BALL_FINALE } from '../pieces/ball';
import { play } from '../pieces/behaviours/__tests__/harness';
import { type PacingBeat, pacingBeatOrderOf } from '../pieces/pacing';
import { runBot } from '../verify';

/** Věty dev sady P51 (`evals/play/p51/dev.json`) a co jejich finále ohlásí; `within` = nejvýš sekund před výhrou. */
const CASES: readonly { readonly id: string; readonly text: string; readonly beat: 'exit' | 'rings' | 'boss' | 'prey'; readonly within?: number }[] = [
  { id: 'w01', text: 'a lost cat sneaks through a dark hedge maze to find its way home', beat: 'exit', within: 10 },
  { id: 'w02', text: 'a mouse walks through the cellar maze avoiding the sleeping guard dogs', beat: 'exit', within: 10 },
  { id: 'g01', text: 'a snowboarder glides down the mountain slope past pine trees', beat: 'rings', within: 12 },
  { id: 'b02', text: 'a goat scores penalty kicks against a llama goalkeeper', beat: 'boss' },
  { id: 'b03', text: 'a frog plays volleyball with a crab on a sunny island', beat: 'boss' },
  { id: 'k02', text: 'a dog catches frisbees in the park', beat: 'prey' },
  { id: 'k03', text: 'a puppy catches soap bubbles in the backyard', beat: 'prey' },
];
const SEEDS = [1, 2] as const;

const alive = (state: ArcadeState, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;
const bodiesOf = (state: ArcadeState, role: number): number[] =>
  Array.from({ length: state[HEADER.bodyCount] as number }, (_, body) => body).filter((body) => state[bodyBase(body) + BODY.role] === role);
const worldOf = (spec: GameSpecV1, seed: number): ArcadeWorld => {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
};
/** Tatáž hra bez značky nové hry (uložený spec před P51 T3/T4) – kdekoli ve specu ji nese. */
const storedOf = (spec: GameSpecV1): GameSpecV1 => JSON.parse(JSON.stringify(spec, (key, value: unknown) => (key === 'segments' ? undefined : value))) as GameSpecV1;

beforeAll(async () => {
  await loadRapier();
});

describe('P51 T9: native finales are announced in the scene', () => {
  for (const { id, text, beat, within } of CASES) {
    it(`${id}: "${PACING_BANNER_LABELS[beat]}" comes once, before the win, when the world changes; a stored game announces nothing`, async () => {
      const spec = draftGameSpecWithMeta(text, 1).spec;
      await preloadPhysics(spec, loadRapier);
      for (const seed of SEEDS) {
        const world = worldOf(spec, seed);
        expect(pacingBeatOrderOf(world), `${id}/${seed}`).toContain(beat);
        const run = runBot(world, undefined, { profile: 'intermediate' });
        expect(run.outcome, `${id}/${seed}`).toBe('won');
        const watch = createPacingBannerWatch(world);
        const start = instantiate(world);
        const rival = bodiesOf(start, ROLE.enemy).find((body) => bodyHp(start, body) === BALL_FINALE.hp);
        const shown: [PacingBeat, number, boolean][] = [];
        let last: PacingBeat | null = null;
        let preyHp: number = CATCH_FINALE.hp;
        play(world, run.inputs, (state, tick) => {
          const now = watch.see(state);
          // Změna ve světě čtená zvlášť: míč = žádný živý terč a soupeř žije, chytání = kořist právě ztratila první HP.
          const hp = beat === 'prey' ? bodyHp(state, 1) : preyHp;
          const changed = beat === 'boss' ? rival !== undefined && alive(state, rival) && bodiesOf(state, ROLE.target).every((body) => !alive(state, body)) : beat === 'prey' ? hp < preyHp && preyHp === CATCH_FINALE.hp : true;
          preyHp = hp;
          if (now !== null && now !== last) shown.push([now, tick, changed]);
          last = now;
        });
        const finale = shown.filter(([seen]) => seen === beat);
        expect(finale, `${id}/${seed}: ${JSON.stringify(shown)}`).toHaveLength(1);
        const [, at, changed] = finale[0]!;
        expect(changed, `${id}/${seed}: the banner starts in the tick of the change`).toBe(true);
        expect(at, `${id}/${seed}: before the win`).toBeLessThan(run.tick!);
        if (within !== undefined) expect((run.tick! - at) / ARCADE_HZ, `${id}/${seed}: right before the end`).toBeLessThanOrEqual(within);
        expect(pacingBannerLabel(world, beat, 'llama'), `${id}/${seed}`).toBe(beat === 'boss' ? 'Boss: Llama' : PACING_BANNER_LABELS[beat]);
        expect(pacingBeatOrderOf(worldOf(storedOf(spec), seed)), `${id}/${seed}: stored`).toEqual([]);
      }
    }, 120_000);
  }
});
