import { expect, test } from '@playwright/test';
import { BODY, BUTTON, HEADER, bodyBase } from '../src/play/arcade/contract';
import { nativeSpec } from '../src/play/compose/native';
import { capture, openNative, replayState, ticks } from './play-native-input';

const SENTENCE = 'a fish swims through a coral reef';
const SPEC = nativeSpec({ move: 'glide', actions: [], objective: 'reach', threats: [] },
  { genre: 'voyage', mode: 'race', hero: 'fish', setting: 'coral reef', cast: [] });
for (const phase of ['staged', 'live'] as const) test.describe(`P41 glide ${phase}`, () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  for (const input of ['keyboard', 'touch'] as const) test(`${input} changes actual height and side and replays exactly`, async ({ page, request, context }, info) => {
    test.setTimeout(90_000);
    const { stage, world } = await openNative(page, request, phase, SPEC, SENTENCE);
    const before = await replayState(world, await capture(page));
    if (input === 'keyboard') {
      await page.keyboard.down('ArrowRight'); await page.keyboard.down('ArrowUp');
      await ticks(page, 15);
      await page.keyboard.up('ArrowUp'); await page.keyboard.up('ArrowRight');
    } else {
      const cdp = await context.newCDPSession(page), box = (await stage.boundingBox())!;
      const first = { id: 1, x: box.x + box.width * .3, y: box.y + box.height * .65 };
      const second = { id: 2, x: box.x + box.width * .8, y: first.y };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
      first.x += 60; first.y -= 60;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [first] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] });
      await ticks(page, 8);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [second] });
      await ticks(page, 7);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    }
    const recorded = await capture(page), after = await replayState(world, recorded), p = bodyBase(after[HEADER.player]!);
    expect(recorded.inputs.some(e => e.axis > 0 && (e.buttons & BUTTON.UP) !== 0)).toBe(true);
    if (input === 'touch') expect(recorded.inputs.slice(-7).every(e => e.axis > 0 && (e.buttons & BUTTON.UP) !== 0 && (e.buttons & BUTTON.HOLD) === 0)).toBe(true);
    expect(after[p + BODY.x]).toBeGreaterThan(before[p + BODY.x]!);
    expect(after[p + BODY.y]).toBeGreaterThan(before[p + BODY.y]!);
    await page.screenshot({ path: info.outputPath(`glide-${phase}-${input}.png`) });
  });
});
