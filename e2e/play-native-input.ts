import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { HEADER, NO_INPUT, RUN_STATE, type ArcadeWorld, type InputEvent } from '../src/play/arcade/contract';
import { hashArcade, instantiate, loadProgram, step } from '../src/play/arcade/kernel';
import { ARCADE_LIBRARY } from '../src/play/arcade/library';
import { loadRapier } from '../src/play/arcade/physics/world';
import { releasePhysics } from '../src/play/arcade/physics/step';
import type { GameSpecV1 } from '../src/play/spec';

export type Capture = { inputs: InputEvent[]; tick: number; hash: string };
type Probe = { byHand(on: boolean): void; tickByHand(): unknown; capture(): Capture; physicsReady(): boolean };
export async function ticks(page: Page, count: number) {
  await page.evaluate(n => { for (let i = 0; i < n; i++) (window.__playShell as unknown as Probe).tickByHand(); }, count);
}
export async function capture(page: Page): Promise<Capture> {
  return page.evaluate(() => (window.__playShell as unknown as Probe).capture());
}
export async function openNative(page: Page, request: APIRequestContext, phase: 'staged' | 'live', spec: GameSpecV1, sentence: string) {
  if (phase === 'staged') {
    const response = await request.post('/api/play/games', { data: { spec } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    await page.goto((await response.json() as { url: string }).url);
  } else {
    await page.goto('/play');
    await page.getByLabel('Say it in one sentence').fill(sentence);
    await page.getByTestId('play-create').click();
    await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/, { timeout: 60_000 });
  }
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toHaveAttribute('data-control', spec.control!);
  await expect(stage).toHaveAttribute('data-player-x', /.+/, { timeout: 60_000 });
  await expect(stage.locator('canvas')).toBeVisible();
  await page.waitForFunction(() => window.__playShell !== undefined);
  if (spec.control === 'ball') await page.waitForFunction(() => (window.__playShell as unknown as Probe).physicsReady());
  await page.evaluate(() => (window.__playShell as unknown as Probe).byHand(true));
  const response = await request.get(`/api/play/games/${new URL(page.url()).pathname.split('/').at(-1)!}`);
  expect(response.status()).toBe(200);
  return { stage, world: (await response.json() as { arcade: ArcadeWorld }).arcade };
}

/** Reconstruct only recorded human inputs; exact browser hash guards every slot. */
export async function replayState(world: ArcadeWorld, recorded: Capture) {
  if (world.control.id === 'ball') await loadRapier();
  const state = instantiate(world), program = loadProgram(world, ARCADE_LIBRARY);
  let next = 0;
  try {
    for (let tick = 0; tick < recorded.tick && state[HEADER.runState] === RUN_STATE.running; tick++) {
      while (next < recorded.inputs.length && recorded.inputs[next]!.tick < tick) next++;
      const event = recorded.inputs[next];
      step(state, event?.tick === tick ? event : NO_INPUT, program);
    }
    expect(state[HEADER.tick]).toBe(recorded.tick);
    expect(hashArcade(state)).toBe(recorded.hash);
    return state.slice();
  } finally { releasePhysics(state); }
}
