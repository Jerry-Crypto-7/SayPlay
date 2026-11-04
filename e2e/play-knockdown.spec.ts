import { expect, test } from '@playwright/test';
import { nativeSpec } from '../src/play/compose/native';
import { capture, openNative, replayState } from './play-native-input';
import { BODY, COUNTER, FLAG, HEADER, ROLE, bodyBase } from '../src/play/arcade/contract';
import { ALLOWED, assemblyOfCell } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';

// A completed human-input replay creates a Dare. Respect its one-per-10s
// server window when several very short deterministic games finish in a row.
test.beforeEach(async () => { await new Promise(resolve => setTimeout(resolve, 10_500)); });

async function startScene(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const probe = window.__playShell as unknown as { start(): void; tickByHand(): void };
    probe.start(); probe.tickByHand();
  });
  // Karta startu je pryč; podle `testid`, text výzvy je od P70C T2 na desktopu „Click …“.
  await expect(page.getByTestId('play-first-prompt')).toBeHidden();
}

for (const id of ['run.escape', 'jump.escape', 'flap.collect']) test(`P41 ${id} renders and wins with exact browser replay`, async ({ page, request }, info) => {
  const cell = ALLOWED.find(cell => cell.id === id)!;
  const spec = compileRecipe(assemblyOfCell(cell));
  const { world } = await openNative(page, request, 'staged', spec, '');
  await startScene(page);
  await page.screenshot({ path: info.outputPath(`${id}-before.png`) });
  const end = await page.evaluate(() => (window.__playShell as unknown as { handPlay(until: 'end'): { runState: string } }).handPlay('end'));
  expect(end.runState).toBe('won');
  await replayState(world, await capture(page));
});

test('P41 staged physical pins render and fall with exact browser replay', async ({ page, request }, info) => {
  const spec = nativeSpec({ move: 'ball', actions: [], objective: 'defeat', threats: [] },
    { genre: 'throw', mode: 'default', hero: 'penguin', setting: 'bowling alley', counts: { target: 3 }, cast: [{ label: 'pin', does: 'throw_at' }] });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`); });
  const { world } = await openNative(page, request, 'staged', spec, '');
  await startScene(page);
  await page.screenshot({ path: info.outputPath('pins-before.png') });
  const outcome = await page.evaluate(() => (window.__playShell as unknown as { handPlay(until: 'end'): { runState: string } }).handPlay('end'));
  expect(outcome.runState).toBe('won');
  const state = await replayState(world, await capture(page));
  expect(state[HEADER.counters + COUNTER.score]).toBe(3);
  for (let body = 0; body < state[HEADER.bodyCount]!; body++) {
    const b = bodyBase(body);
    if (state[b + BODY.role] === ROLE.target) expect(state[b + BODY.flags]! & FLAG.alive).toBe(0);
  }
  expect(errors).toEqual([]);
});
