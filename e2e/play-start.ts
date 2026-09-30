import type { Page } from '@playwright/test';

/**
 * Každá hra PLAY čeká na první dotek (P33 T11). Test, který potřebuje běžící
 * hodiny a o vstup hráče mu nejde, hru pustí sondou – jako ťuk na prázdnou
 * scénu, bez zápisu do záznamu vstupů.
 */
export async function startGame(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  await page.evaluate(() => window.__playShell!.start());
}

/**
 * Karta pauzy HUD kitu (P34 T5). Zvuk, „About this game“, „Show me how“ a Quit
 * jsou od té doby na ní, ne ve sloupci vedle hry – test je najde až po pauze.
 */
export async function openPause(page: Page): Promise<void> {
  await page.getByTestId('play-pause').click();
  await page.getByTestId('play-paused').waitFor();
}

/** List „About this game“ přes kartu pauzy. */
export async function openAbout(page: Page): Promise<void> {
  await openPause(page);
  await page.getByTestId('play-info').click();
}

/** Zavře list „About“ (Esc vrátí kartu pauzy) a pustí hru (druhé Esc kartu zavře). */
export async function closeAbout(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.getByTestId('play-paused').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('play-paused').waitFor({ state: 'detached' });
}
