import { expect, test } from '@playwright/test';
import { ALLOWED, assemblyOfCell } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';
import { BODY, FLAG, HEADER, bodyBase } from '../src/play/arcade/contract';
import { capture, openNative, replayState } from './play-native-input';

test('physical cargo delivery renders and replays from ordinary driving input', async ({ page, request }, info) => {
  const cell = ALLOWED.find(cell => cell.id === 'drive.reach+deliver')!;
  const spec = compileRecipe(assemblyOfCell(cell, { ...cell.preset!, cast: [{ label: 'pizza', does: 'reach' }] }));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { stage, world } = await openNative(page, request, 'staged', spec, '');
  await page.evaluate(() => {
    const probe = window.__playShell as unknown as { start(): void; tickByHand(): void };
    probe.start(); probe.tickByHand();
  });
  await expect(stage.locator('canvas')).toBeVisible();
  await page.screenshot({ path: info.outputPath('cargo-before-pickup.png') });
  const end = await page.evaluate(() => (window.__playShell as unknown as { handPlay(until: 'end'): { runState: string } }).handPlay('end'));
  expect(end.runState).toBe('won');
  const state = await replayState(world, await capture(page));
  expect(world.rules.some(rule => rule.params.id === 'p41_deliver')).toBe(true);
  const cargoKind = world.kinds.indexOf('thing:cargo');
  expect(cargoKind).toBeGreaterThanOrEqual(0);
  const cargo = Array.from({ length: world.initial[HEADER.bodyCount]! }, (_, index) => index)
    .find(index => world.initial[bodyBase(index) + BODY.kind] === cargoKind);
  expect(cargo).toBeDefined();
  expect(state[bodyBase(cargo!) + BODY.flags]! & FLAG.alive).toBe(0);
  expect(errors).toEqual([]);
});
