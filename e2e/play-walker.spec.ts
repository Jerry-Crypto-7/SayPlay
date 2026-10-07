import { expect, test } from '@playwright/test';
import { BUTTON } from '../src/play/arcade/contract';
import { nativeSpec } from '../src/play/compose/native';
import { capture, openNative, replayState, ticks } from './play-native-input';

const SENTENCE = 'a cat sneaks past guards to steal a fish';
const SPEC = nativeSpec({ move: 'walk', actions: [], objective: 'collect', threats: ['guard'] },
  { genre: 'voyage', mode: 'race', hero: 'cat', setting: 'castle', cast: [{ label: 'fish', does: 'collect' }, { label: 'guard', does: 'chase_me' }] });
for (const phase of ['staged', 'live'] as const) test.describe(`P41 walker ${phase}`, () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('all eight keyboard directions and diagonal touch reach the core and replay exactly', async ({ page, request, context }, info) => {
    test.setTimeout(90_000);
    const { stage, world } = await openNative(page, request, phase, SPEC, SENTENCE);
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
      const keys = [...(x ? [x > 0 ? 'ArrowRight' : 'ArrowLeft'] : []), ...(z ? [z > 0 ? 'ArrowUp' : 'ArrowDown'] : [])];
      for (const key of keys) await page.keyboard.down(key);
      await ticks(page, 2);
      const recorded = await capture(page), last = recorded.inputs.at(-1)!;
      expect(Math.sign(last.axis)).toBe(x);
      expect(last.buttons & (BUTTON.UP | BUTTON.DOWN)).toBe(z! > 0 ? BUTTON.UP : z! < 0 ? BUTTON.DOWN : 0);
      for (const key of keys) await page.keyboard.up(key);
    }
    const cdp = await context.newCDPSession(page), box = (await stage.boundingBox())!;
    const finger = { id: 1, x: box.x + box.width * .4, y: box.y + box.height * .65 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger] });
    finger.x += 50; finger.y -= 50;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [finger] });
    await ticks(page, 4);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    const recorded = await capture(page);
    expect(recorded.inputs.slice(-4).every(e => e.axis > 0 && (e.buttons & BUTTON.UP) !== 0)).toBe(true);
    await replayState(world, recorded);
    await page.screenshot({ path: info.outputPath(`walker-${phase}.png`) });
  });
});
