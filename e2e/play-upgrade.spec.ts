import { expect, test } from '@playwright/test';

/**
 * Progresivní hra (P23-D T2) bez modelu: věta dá návrh hned, dotaz na
 * upgrade skončí `draft-final` s důvodem, proužek „custom version“ se
 * nezobrazí a hra dál běží. S modelem se tahle cesta měří v T6.
 */

const SENTENCE = 'A hamster escapes a supermarket while a giant Roomba hunts it.';

test('without a model the draft stays final, no upgrade banner, the game keeps running', async ({ page, request }) => {
  const created = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
  expect(created.status(), await created.text()).toBeLessThan(300);
  const body = (await created.json()) as { url: string; versionId: string; upgrade: string };
  expect(body.upgrade).toBe(`/api/play/games/${body.versionId}/upgrade`);

  await expect
    .poll(async () => ((await (await request.get(body.upgrade)).json()) as { status: string }).status, { timeout: 30_000 })
    .toBe('draft-final');
  const final = (await (await request.get(body.upgrade)).json()) as { reason?: string };
  expect(final.reason).toBe('MODEL_UNAVAILABLE');

  await page.goto(body.url);
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 0, undefined, { timeout: 60_000 });
  const first = await page.evaluate(() => window.__playShell?.tick() ?? 0);
  // Dvě kola dotazování klienta (po 2 s) – proužek by se ukázal na prvním `ready`.
  await page.waitForTimeout(4_500);
  await expect(page.getByTestId('play-upgrade')).toHaveCount(0);
  expect(await page.evaluate(() => window.__playShell?.tick() ?? 0)).toBeGreaterThan(first);
});
