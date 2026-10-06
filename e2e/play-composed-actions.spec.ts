import { expect, test } from '@playwright/test';
import { ALLOWED, assemblyOfCell } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';
import { capture, openNative, replayState, ticks } from './play-native-input';
import { arcadeWorldOf } from '../src/play/arcade/compile';
import { runBot, verifyArcade } from '../src/play/arcade/verify';

for (const id of ['drive.reach+shoot+collect', 'walk.escape+collect+guard', 'roam.catch', 'voyage.race']) {
  test(`${id}: all declared actions render, accept input and replay`, async ({ page, request }, info) => {
    const cell = ALLOWED.find(cell => cell.id === id)!;
    const spec = compileRecipe(assemblyOfCell(cell));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const { stage, world } = await openNative(page, request, 'staged', spec, '');
    await page.evaluate(() => {
      const probe = window.__playShell as unknown as { start(): void; tickByHand(): void };
      probe.start(); probe.tickByHand();
    });
    await expect(stage.locator('canvas')).toBeVisible();
    await stage.focus();
    await page.keyboard.down('ArrowRight');
    await ticks(page, 6);
    await page.keyboard.up('ArrowRight');
    expect((await capture(page)).inputs.length).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath(`${id}-start.png`) });
    if (id === 'roam.catch') {
      await expect(stage).toHaveAttribute('data-threat-edge', /^(left|right|top|bottom)$/);
      const pursuit = runBot(world);
      await page.evaluate(({ inputs, until }) => {
        const probe = window.__playShell as unknown as { tick(): number; hold(axis: number): void; press(buttons: number): void; tickByHand(): void };
        for (let tick = probe.tick(); tick < until; tick++) {
          const input = inputs.find(input => input.tick === tick); probe.hold(input?.axis ?? 0); probe.press(input?.buttons ?? 0); probe.tickByHand();
        }
      }, { inputs: pursuit.inputs, until: Math.floor(pursuit.tick * 0.9) });
      await page.waitForTimeout(500); // Let the render-only camera settle after manual ticks.
      await page.screenshot({ path: info.outputPath('pursuit.png') });
    }
    const end = await page.evaluate(() => (window.__playShell as unknown as { handPlay(until: 'end'): { runState: string } }).handPlay('end'));
    expect(end.runState).toBe('won');
    await replayState(world, await capture(page));
    const made = arcadeWorldOf(spec, world.seed);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    for (const verb of [cell.recipe.move, cell.recipe.objective, ...cell.recipe.actions, ...cell.recipe.threats]) {
      expect(verdict.witnesses.some(witness => witness.verb === verb), verb).toBe(true);
    }
    expect(errors).toEqual([]);
  });
}
