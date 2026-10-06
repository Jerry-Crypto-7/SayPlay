import { expect, test, type Page } from '@playwright/test';

import { BUTTON, type ArcadeWorld, type InputEvent } from '../src/play/arcade/contract';
import { replay } from '../src/play/arcade/kernel';
import { ARCADE_LIBRARY } from '../src/play/arcade/library';
import { driveSpec } from '../src/play/compose/drive';

type Capture = { inputs: InputEvent[]; tick: number; hash: string };
type DriveProbe = { byHand(on: boolean): void; tickByHand(): unknown; capture(): Capture };
const OWNER = 'game in a car with shooting and racing';
const STAGED = driveSpec(
  { move: 'drive', actions: ['shoot'], objective: 'race', threats: ['chaser'] },
  { genre: 'voyage', mode: 'race', hero: 'car', setting: 'city', cast: [{ label: 'zombie', does: 'shoot_at' }, { label: 'police car', does: 'chase_me' }] },
);

async function ticks(page: Page, count: number) {
  await page.evaluate(n => {
    const probe = window.__playShell as unknown as DriveProbe;
    for (let i = 0; i < n; i++) probe.tickByHand();
  }, count);
}

for (const phase of ['staged', 'live'] as const) test.describe(`P41 drive ${phase}`, () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  for (const input of ['keyboard', 'two fingers'] as const) test(`${input} steers and shoots together with an identical core replay`, async ({ page, request, context }) => {
    test.setTimeout(90_000);
    if (phase === 'staged') {
      const response = await request.post('/api/play/games', { data: { spec: STAGED } });
      expect(response.status(), await response.text()).toBeLessThan(300);
      await page.goto((await response.json() as { url: string }).url);
    } else {
      await page.goto('/play');
      await page.getByLabel('Say it in one sentence').fill(OWNER);
      await page.getByTestId('play-create').click();
      await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/, { timeout: 60_000 });
    }
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toHaveAttribute('data-control', 'steer');
    await expect(stage).toHaveAttribute('data-player-x', /.+/, { timeout: 60_000 });
    await page.waitForFunction(() => window.__playShell !== undefined);
    await page.evaluate(() => (window.__playShell as unknown as DriveProbe).byHand(true));
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    const savedResponse = await request.get(`/api/play/games/${id}`);
    expect(savedResponse.status()).toBe(200);
    const saved = await savedResponse.json() as { arcade: ArcadeWorld };
    expect(saved.arcade.rules.some(rule => rule.id === 'blaster')).toBe(true);
    const beforeX = await stage.getAttribute('data-player-x');
    if (input === 'keyboard') {
      await page.keyboard.down('ArrowRight');
      await page.keyboard.down('Space');
      await ticks(page, 12);
      await page.keyboard.up('Space');
      await ticks(page, 3);
      await page.keyboard.up('ArrowRight');
    } else {
      const cdp = await context.newCDPSession(page);
      const box = (await stage.boundingBox())!;
      const first = { id: 1, x: box.x + box.width * 0.25, y: box.y + box.height * 0.65 };
      const second = { id: 2, x: box.x + box.width * 0.75, y: first.y };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
      first.x += 50;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [first] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] });
      await ticks(page, 12);
      // Chromium releases the listed contact; an empty list releases all.
      // A touchMove omitting a contact does not produce pointerup.
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [second] });
      await ticks(page, 3);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    }
    const captured = await page.evaluate(() => (window.__playShell as unknown as DriveProbe).capture());
    expect(captured.inputs.some(event => event.axis > 0 && (event.buttons & BUTTON.FIRE) !== 0)).toBe(true);
    expect(captured.inputs.slice(-3).every(event => event.axis > 0 && (event.buttons & BUTTON.FIRE) === 0)).toBe(true);
    expect(replay(saved.arcade, captured.inputs, ARCADE_LIBRARY, captured.tick).hash).toBe(captured.hash);
    await expect(stage).not.toHaveAttribute('data-player-x', beforeX!);
    await expect(stage).toHaveAttribute('data-shots-drawn', /[1-9]/);
    await page.screenshot({ path: `.claude/scratchpads/p41-drive-${phase}-${input.replace(' ', '-')}.png` });
  });
});
