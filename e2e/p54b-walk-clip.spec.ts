import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import { AXIS_MAX } from '../src/play/arcade/contract';

/**
 * Chůze riggované postavy v běžící plošinovce (P54B T5): pomalý krok (páčka na
 * třetinu, 2 m/s) hraje klip chůze, plný běh (6,6 m/s) klip běhu. Postava bez
 * klipu chůze by tiše běžela nebo stála a klouzala – z obrázku se klip nepřečte,
 * proto atribut `data-anim-clip`. Hrdinou je rytíř KayKit, jehož GLB chůzi nově nese.
 */

interface HandProbe {
  start(): void;
  byHand(on: boolean): void;
  hold(axis: number): void;
  tickByHand(): { readonly runState: string };
}

/** Fixture plošinovky s hrdinou z věty. */
function platformSpec(hero: string): unknown {
  const spec = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__/platform.json'), 'utf8')) as { roles: { kind: string; label: string }[] };
  return { ...spec, roles: spec.roles.map((role) => (role.kind === 'player' ? { ...role, label: hero } : role)) };
}

/** Páčka drží `axis`, robot odtiká `ticks` tiků po snímku; vrací klip hrdiny na začátku každého snímku. */
function clipsWhileHolding(page: Page, axis: number, ticks: number): Promise<string[]> {
  return page.evaluate(
    ([axis, ticks]) =>
      new Promise<string[]>((resolve) => {
        const shell = window.__playShell as unknown as HandProbe;
        const stage = document.querySelector('[data-testid="arcade-stage"]') as HTMLElement;
        const seen: string[] = [];
        shell.hold(axis);
        let left = ticks;
        const frame = () => {
          seen.push(stage.dataset.animClip ?? '');
          if (left === 0) {
            resolve(seen);
            return;
          }
          shell.tickByHand();
          left -= 1;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    [axis, ticks] as const,
  );
}

test('a rigged knight walks at a slow pace and runs at full speed in the platformer', async ({ page, request }) => {
  test.setTimeout(180_000);
  const response = await request.post('/api/play/games', { data: { spec: platformSpec('knight') } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  const { url } = (await response.json()) as { url: string };

  await page.goto(url);
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toHaveAttribute('data-control', 'platform');
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  // Postava s klipy je načtená, až ohlásí první klip.
  await expect(stage).toHaveAttribute('data-anim-clip', 'idle', { timeout: 60_000 });
  await page.evaluate(() => {
    const shell = window.__playShell as unknown as HandProbe;
    shell.start();
    shell.byHand(true);
  });

  const slow = await clipsWhileHolding(page, Math.round(AXIS_MAX * 0.3), 40);
  test.info().annotations.push({ type: 'slow', description: slow.join(',') });
  expect(slow.slice(-10)).toEqual(Array.from({ length: 10 }, () => 'walk'));

  const fast = await clipsWhileHolding(page, AXIS_MAX, 20);
  test.info().annotations.push({ type: 'fast', description: fast.join(',') });
  expect(fast).toContain('run');
});
