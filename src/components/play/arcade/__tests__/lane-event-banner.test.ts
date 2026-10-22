import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { NO_INPUT, type InputEvent } from '@/play/arcade/contract';
import { instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { planLaneEvents } from '@/play/arcade/pieces/lane-events';
import { runBot } from '@/play/arcade/verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';

import { createLaneEventWatch, laneEventViewOf } from '../LaneEventBanner';

describe('lane event banner (P55)', () => {
  it.each(['catch', 'whack', 'slice', 'defense'])('%s: announces events as their bonuses come into view, the first within 10 s', (genre) => {
    const cell = liveCells().find((candidate) => candidate.id === `${genre}.default`)!;
    const made = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const world = made.world;
    const view = laneEventViewOf(world.rules);
    expect(view).not.toBeNull();
    const inputs = runBot(world).inputs;
    const program = loadProgram(world, ARCADE_LIBRARY);
    const state = instantiate(world);
    const watch = createLaneEventWatch(view!);
    const starts: { tick: number; kind: string }[] = [];
    let last: string | null = null;
    let next = 0;
    for (let tick = 0; outcomeOf(state) === 'running' && tick < 5400; tick += 1) {
      while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
      step(state, inputs[next]?.tick === tick ? (inputs[next] as InputEvent) : NO_INPUT, program);
      const shown = watch.see(state);
      if (shown !== null && shown !== last) starts.push({ tick, kind: shown });
      last = shown;
    }
    expect(starts[0]!.tick).toBeLessThanOrEqual(600);
    expect(starts.some((start) => start.kind === 'rush')).toBe(true);
    if (genre === 'catch') {
      // Série je jedno ohlášení, ne jedno za bonus: ohlášení nejvýš tolik, kolik je naplánovaných událostí.
      expect(starts.length).toBeLessThanOrEqual(planLaneEvents(1, 5400).length);
    }
  });

  it('a genre without lane events gets no banner', () => {
    expect(laneEventViewOf([])).toBeNull();
  });
});
