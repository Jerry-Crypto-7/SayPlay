import { expect, test, type Page } from '@playwright/test';

/**
 * Anglická měď PLAY (P23-C T8): `/play`, hra, obrazovka po dohrání
 * i otevřený panel „How this game works“ projdou týmž lexikálním filtrem
 * jako `e2e/interface-language.spec.ts`.
 *
 * **Filtr je kopie, ne import.** Ten spec `CZECH_LETTERS` ani seznam slov
 * neexportuje, a import ze spec souboru by do tohohle běhu zaregistroval
 * i jeho testy. Když se jedna kopie pohne, druhá se má pohnout s ní.
 */

const CZECH_LETTERS = /[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u;
const CZECH_WORDS = ['stavba', 'pravidla', 'cil', 'tik', 'stav', 'nic', 'hrac', 'svet', 'spojitou', 'dynamiku', 'hybnost'];

function findCzech(html: string): readonly string[] {
  const found: string[] = [];
  for (const word of html.split(/[^\p{L}]+/u)) {
    if (word === '') continue;
    if (CZECH_LETTERS.test(word) || CZECH_WORDS.includes(word.toLowerCase())) found.push(word);
  }
  return [...new Set(found)];
}

async function expectEnglish(page: Page, what: string): Promise<void> {
  const html = await page.locator('body').evaluate((node) => node.outerHTML);
  expect(findCzech(html), `${what} nese české řetězce`).toEqual([]);
  const ids = await page.locator('[data-testid]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''));
  expect(ids.filter((id) => !/^[a-z0-9_-]+$/i.test(id)), `${what}: data-testid mimo ASCII`).toEqual([]);
}

test('every PLAY screen speaks English: create, game, after the run, lab', async ({ page, request }) => {
  await page.goto('/play');
  await expectEnglish(page, '/play');

  const response = await request.post('/api/play/games', { data: { sentence: 'Press red and blue but not green to open the door.' } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  const { url } = (await response.json()) as { url: string };

  await page.goto(url);
  await expect(page.getByTestId('play-goal')).toBeVisible();
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  await expectEnglish(page, 'hra');

  // Od P33 T7 je „How to play“ oddíl listu „About this game“; list se před dohráním zavře.
  await page.getByTestId('play-info').click();
  await expect(page.getByTestId('play-lab')).toContainText('Rules checked');
  await expectEnglish(page, 'Lab');
  await page.keyboard.press('Escape');

  const outcome = await page.evaluate(() => window.__playShell!.playWitness());
  expect(outcome.runState).toBe('won');
  await expect(page.getByTestId('play-postrun')).toBeVisible();
  await expectEnglish(page, 'po dohrání');

  await page.goto('/play/deadbeef');
  await expectEnglish(page, '404');
});
