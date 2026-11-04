import { expect, test } from '@playwright/test';
import { ALLOWED, assemblyOfCell } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';
import { BODY, FLAG, bodyBase } from '../src/play/arcade/contract';
import { capture, openNative, replayState } from './play-native-input';

test.beforeEach(async () => { await new Promise(resolve => setTimeout(resolve, 10_500)); });

for (const id of ['drive.reach', 'glide.reach', 'walk.reach', 'runner.default']) {
  test(`P41 phases and key-before-gate render and replay: ${id}`, async ({ page, request }, info) => {
    const cell = ALLOWED.find(cell => cell.id === id)!;
    const spec = compileRecipe({ ...assemblyOfCell(cell),
      phases: [{ start: 0, speedPercent: 100 }, { start: 500, speedPercent: 110 }],
      dependsOn: [
        { goal: 'brass_key', action: 'collect', label: 'brass key', prerequisites: [] },
        { goal: 'garage_gate', action: 'open', label: 'garage gate', prerequisites: ['brass_key'] },
      ],
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const { stage, world } = await openNative(page, request, 'staged', spec, '');
    await page.evaluate(() => {
      const probe = window.__playShell as unknown as { start(): void; tickByHand(): void };
      probe.start(); probe.tickByHand();
    });
    // Karta startu je pryč; podle `testid`, text výzvy je od P70C T2 na desktopu „Click …“.
    await expect(page.getByTestId('play-first-prompt')).toBeHidden();
    await expect(stage).toHaveAttribute('data-drawn', /thing/);
    await page.screenshot({ path: info.outputPath(`${id}-progression.png`) });
    const end = await page.evaluate(() => (window.__playShell as unknown as { handPlay(until: 'end'): { runState: string } }).handPlay('end'));
    expect(end.runState).toBe('won');
    const state = await replayState(world, await capture(page));
    const order = world.rules.find(rule => rule.id === 'objective_order')!.params as { nodes: { body: number; goal: string; prerequisites: string[] }[] };
    expect(order.nodes.map(node => node.goal)).toEqual(['brass_key', 'garage_gate', '__finish']);
    expect(order.nodes[2]!.prerequisites).toEqual(['brass_key', 'garage_gate']);
    for (const node of order.nodes.filter(node => node.goal !== '__finish')) expect(state[bodyBase(node.body) + BODY.flags]! & FLAG.alive).toBe(0);
    expect(errors).toEqual([]);
  });
}
