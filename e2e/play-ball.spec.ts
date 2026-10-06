import { expect, test } from '@playwright/test';
import { BODY, BUTTON, HEADER, bodyBase } from '../src/play/arcade/contract';
import { nativeSpec } from '../src/play/compose/native';
import { capture, openNative, replayState, ticks } from './play-native-input';

const SENTENCE = 'a penguin plays football against a walrus';
const SPEC = nativeSpec({ move: 'ball', actions: ['kick'], objective: 'score', threats: ['rival'] },
  { genre: 'voyage', mode: 'race', hero: 'penguin', setting: 'football pitch', cast: [{ label: 'football goal', does: 'throw_at' }, { label: 'walrus', does: 'fight' }] });
for (const phase of ['staged', 'live'] as const) test.describe(`P41 ball ${phase}`, () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  for (const input of ['keyboard', 'touch'] as const) test(`${input} charges and launches a physical ball with exact replay`, async ({ page, request, context }, info) => {
    test.setTimeout(90_000);
    const { stage, world } = await openNative(page, request, phase, SPEC, SENTENCE);
    if (input === 'keyboard') {
      await page.keyboard.down('ArrowRight'); await page.keyboard.up('ArrowRight');
      await page.keyboard.down('Space'); await ticks(page, 25); await page.keyboard.up('Space');
    } else {
      const cdp = await context.newCDPSession(page), box = (await stage.boundingBox())!;
      const finger = { id: 1, x: box.x + box.width * .4, y: box.y + box.height * .4 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger] });
      finger.x += 35; finger.y += 90;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [finger] });
      await ticks(page, 25);
      const charged = await replayState(world, await capture(page));
      expect(charged[bodyBase(charged[HEADER.player]!) + BODY.aux1]).toBeGreaterThan(0);
      await page.screenshot({ path: info.outputPath(`ball-${phase}-charged.png`) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    }
    await ticks(page, 6);
    const recorded = await capture(page), state = await replayState(world, recorded);
    expect(recorded.inputs.some(e => (e.buttons & BUTTON.HOLD) !== 0)).toBe(true);
    expect(recorded.inputs.some(e => e.axis > 0 && (e.buttons & BUTTON.TAP) !== 0)).toBe(true);
    const ball = bodyBase(state[HEADER.spawnBase]!);
    expect(state[ball + BODY.vx]).toBeGreaterThan(0);
    expect(state[ball + BODY.vz]).toBeGreaterThan(0);
    expect(state[ball + BODY.z]).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath(`ball-${phase}-${input}.png`) });
  });
});
