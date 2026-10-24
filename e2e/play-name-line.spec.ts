import { expect, test } from '@playwright/test';

import { arenaGenre } from '../src/play/genre/arena';
import { compileGenre, readGenreSpec } from '../src/play/genre/index';

/**
 * Popisek jména (P58A T5) v běžící hře: po řádku se slovesem ukáže jméno hrdiny
 * a pak protivníka z věty, každé jednou, a nikdy současně s řádkem se slovesem.
 */

test.setTimeout(120_000);

test('names the hero, then the foe, after the verb line', async ({ page, request }, info) => {
  const read = readGenreSpec(arenaGenre.draftFill('a cat collects fish in a garden while dogs chase it', null) as object);
  if (!read.ok) throw new Error(read.issues.join('; '));
  const response = await request.post('/api/play/games', { data: { spec: compileGenre(read.value) } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  const { url } = (await response.json()) as { url: string };
  await page.goto(url);
  await expect(page.getByTestId('play-first-prompt')).toBeVisible({ timeout: 60_000 });
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.7);

  const seen: string[] = [];
  const tag = page.getByTestId('play-name-line');
  const deadline = Date.now() + 9_000;
  while (Date.now() < deadline) {
    const [verb, shown] = await Promise.all([page.getByTestId('play-verb-line').count(), tag.isVisible()]);
    expect(verb > 0 && shown, 'verb line and name line on screen together').toBe(false);
    const name = shown ? await tag.textContent() : null;
    if (name !== null && seen.at(-1) !== name) {
      seen.push(name);
      await page.screenshot({ path: info.outputPath(`name-${seen.length}.png`) });
    }
    await page.waitForTimeout(100);
  }
  // Štítek protivníka visí nad nejbližším tělem, které věta jmenuje: rybou, nebo psem – nikdy nad kočkou.
  expect(seen[0]).toBe('Cat');
  expect(seen.slice(1).length).toBeGreaterThan(0);
  for (const name of seen.slice(1)) expect(['Fish', 'Dog', 'Dogs']).toContain(name);
});
