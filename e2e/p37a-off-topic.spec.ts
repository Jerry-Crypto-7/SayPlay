import { expect, test } from '@playwright/test';

/**
 * Věty mimo hry (P37A T5): tři věty z vývojové sady `evals/play/p37a/dev-150.json`
 * (n19, n09, n40) dají přes `/play` hratelnou hru do 1,5 s od „Make it!“ a cíl
 * v HUD řekne slovy věty, co hrát – útěk, skládání a spor.
 *
 * Čas se měří od kliknutí do plátna hry bez stavu „building“, na stránce, která
 * už jednu hru otevřela: první načtení 3D kódu je cena prohlížeče, ne věty.
 */

const SENTENCES = [
  { id: 'n19', text: 'a long queue at the pharmacy on a friday afternoon', goal: 'Dodge the long queues!' },
  { id: 'n09', text: 'pay the electricity bill on my laptop', goal: 'Stack the electricity bills!' },
  { id: 'n40', text: 'argue with my wife about a name for our baby', goal: 'Out-talk the wife!' },
] as const;

/** AC T5: hratelná hra nejvýš za tolik od odeslání věty. */
const BUDGET_MS = 1500;

async function make(page: import('@playwright/test').Page, sentence: string): Promise<number> {
  await page.goto('/play');
  await page.getByTestId('play-sentence').fill(sentence);
  const started = Date.now();
  await page.getByTestId('play-create').click();
  await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/, { timeout: 30_000 });
  await page.locator('[data-testid="arcade-stage"] canvas').first().waitFor({ timeout: 30_000 });
  await expect(page.getByTestId('play-building')).toHaveCount(0, { timeout: 30_000 });
  return Date.now() - started;
}

test('three sentences outside games play in ≤ 1.5 s with the goal in their own words', async ({ page }) => {
  test.setTimeout(180_000);
  // Zahřátí: 3D kód a písma do mezipaměti prohlížeče.
  await make(page, 'a fox collects apples in a meadow');
  const times: string[] = [];
  for (const sentence of SENTENCES) {
    const ms = await make(page, sentence.text);
    times.push(`${sentence.id} ${ms} ms`);
    await expect(page.getByTestId('play-goal'), sentence.id).toHaveText(sentence.goal);
    await expect(page.getByTestId('play-timer'), sentence.id).toBeVisible();
    expect(ms, `${sentence.id}: ${sentence.text}`).toBeLessThanOrEqual(BUDGET_MS);
  }
  console.log(`p37a off-topic: ${times.join(', ')}`);
});
