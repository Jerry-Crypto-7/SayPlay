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
