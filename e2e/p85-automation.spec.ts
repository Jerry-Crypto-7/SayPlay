import { expect, test } from '@playwright/test';

/**
 * Cesta pro automat (P85): věta → hra → prohra a výhra → sdílení → týž odkaz v čistém prohlížeči, jen přes
 * `data-testid`, `data-state` a `data-outcome` – tak, jak ji projde robot, který plátno nevidí. Běží proti už
 * běžícímu serveru (`FALLBACK_SMOKE_URL`). Žádné pevné čekání: jen lokátory, `expect.poll` a `waitForURL`.
 *
 * Výsledek zrychlí sonda `__playShell`, jinak by se na něj čekalo v reálném čase: prohra = běh hráče bez
 * jediného stisku až do konce (`idleRun`), výhra = vítězný běh robota ověřovače zahraný tik po tiku jako
 * vstupy hráče (`handPlay`). Oba jsou běhy hráče, takže karta výsledku, výzva i odkaz jsou tytéž jako po hraní.
 */

// Aréna sběru (`move_free`): bez stisku prohraje na časový limit, robot ověřovače vyhraje.
const SENTENCE = 'A bee visits ten flowers and returns to the hive';
const GAME_PAGE = /\/play\/([a-f0-9]+)$/;

interface HandProbe {
  readonly handPlay: (until: 'end') => { readonly runState: string };
  readonly idleRun: () => { readonly runState: string };
}

test('sentence → running game → loss and win → share → the same game in a fresh browser', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  // Bez nabídky sdílení jde odkaz do schránky; s oprávněním se neukáže ruční pole.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  const at: Record<string, number> = {};

  // 1. Věta a „Make it!“. Počítadlo znaků se přepíše až po hydrataci – teprve pak odeslání nejde jako obyčejný formulář.
  await page.goto('/play');
  await page.getByTestId('play-sentence').fill(SENTENCE);
  await expect(page.getByTestId('play-counter')).toHaveText(`${String(SENTENCE.length)}/140`);
  at.make = Date.now();
  await page.getByTestId('play-create').click();
  await page.waitForURL(GAME_PAGE, { timeout: 120_000 });
  at.page = Date.now();

  // 2. Hra se načte (`loading`), čeká na první dotek (`ready`), klávesa ji pustí (`running`) a tik v DOM roste.
  const game = page.getByTestId('play-game');
  await expect(game).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  at.ready = Date.now();
  await page.keyboard.press('ArrowUp');
  await expect(game).toHaveAttribute('data-state', 'running');
  await expect.poll(async () => Number(await page.getByTestId('play-tick').getAttribute('data-tick'))).toBeGreaterThan(0);
  // Po prvním vstupu se hra sama nevymění: verze v DOM je verze v adrese. Cíl arény nemá postup, text se během hry nemění.
  const id = (await game.getAttribute('data-version-id'))!;
  expect(page.url()).toMatch(new RegExp(`/play/${id}$`));
  const goal = (await page.getByTestId('play-goal').textContent())!;

  // 3. Prohra: stav hry `lost`, pak karta výsledku s `data-outcome="lost"`.
  const lost = await page.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun());
  expect(lost.runState).toBe('lost');
  await expect(game).toHaveAttribute('data-state', 'lost');
  const outcome = page.getByTestId('play-outcome');
  await expect(outcome).toHaveAttribute('data-outcome', 'lost');

  // 4. „Try again“ z karty: nový běh čeká na dotek. Výhra: stav `won`, karta s `data-outcome="won"`.
  await outcome.getByTestId('play-replay').click();
  await expect(game).toHaveAttribute('data-state', 'ready');
  await expect(outcome).toHaveCount(0);
  const won = await page.evaluate(() => (window.__playShell as unknown as HandProbe).handPlay('end'));
  expect(won.runState).toBe('won');
  await expect(game).toHaveAttribute('data-state', 'won');
  await expect(outcome).toHaveAttribute('data-outcome', 'won');

  // 5. Sdílení: hlavní akce výhry („Dare a friend“) počká na ověřenou výzvu a odkaz nechá v `data-share-url`.
  const share = outcome.getByTestId('play-share');
  await share.click();
  await expect(share).toHaveAttribute('data-share-url', new RegExp(`/play/${id}\\?via=share(&dare=[a-f0-9]{32})?$`));
  const link = (await share.getAttribute('data-share-url'))!;

  // 6. Čistý prohlížeč (bez cookies a úložiště): táž verze a týž cíl, hra se dá pustit a zůstane tatáž.
  const friend = await browser.newContext();
  const other = await friend.newPage();
  at.open = Date.now();
  await other.goto(link);
  const theirs = other.getByTestId('play-game');
  await expect(theirs).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
  at.openReady = Date.now();
  await expect(theirs).toHaveAttribute('data-version-id', id);
  if (link.includes('&dare=')) await expect(other.getByTestId('play-dare-strip')).toBeVisible();
  await other.keyboard.press('ArrowUp');
  await expect(theirs).toHaveAttribute('data-state', 'running');
  await expect(theirs).toHaveAttribute('data-version-id', id);
  await expect(other.getByTestId('play-goal')).toHaveText(goal);

  // Časy pro `docs/submission/automation.md` (hlavní relace je přepíše z měřeného běhu).
  console.log(
    `p85 timings ${JSON.stringify({ makeToGamePageMs: at.page! - at.make!, gamePageToReadyMs: at.ready! - at.page!, sharedLinkToReadyMs: at.openReady! - at.open!, dare: link.includes('&dare=') })}`,
  );
  await friend.close();
  await context.close();
});
