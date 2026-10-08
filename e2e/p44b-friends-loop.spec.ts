import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { openAbout } from './play-start';

/**
 * Celá smyčka P44B ve dvou prohlížečích (T14), jako dva lidé na dvou telefonech: A napíše větu,
 * vyhraje, dá si jméno „Ada“ a vyzve kamaráda; B otevře odkaz, vidí, kdo ho vyzývá, vyhraje
 * rychleji, je v žebříčku první a dá si jméno „Bo“; A po novém načtení vidí v „About this game“
 * oba. Nakonec `/play/stats` (lokálně bez klíče) ukáže tenhle den trychtýře.
 *
 * Síť se nezachytává ani nepodvrhuje: zelená smí přijít jen ze skutečných rout, podepsaných cookies
 * a úložiště. Podvržená je jen nabídka sdílení – headless prohlížeč žádnou nemá – a ta jen zapíše,
 * jaký odkaz by odešel. Věta je jen tohohle specu: hra jiného specu nad týmž serverem by nesla jeho
 * žebříček.
 */

/**
 * Změřeno 8. 10. nad `next start` (sonda `handPlay`): robot tuhle hru vyhraje s posunem 0 (359 bodů,
 * tik 3 657) i 60 (354 bodů, tik 3 717). Hra s houbami a portálem s posunem 10 a víc prohraje.
 */
const SENTENCE = 'A cat steals fish from a busy harbour market.';

/** A vyhraje „rukou“ o tolik tiků později než B – pomalejší běh s méně body, B ho porazí. */
const LAG_A = 60;

interface HandProbe {
  readonly handPlay: (until: 'score' | 'end', lag?: number) => { readonly runState: string; readonly tick: number; readonly score: number };
}

interface Captured {
  readonly __shared: ShareData[];
}

/**
 * Každý „člověk“ z vlastní adresy a s vlastními cookies (nový kontext): strop výzev je jedna
 * za 10 s na volajícího a bez hlavičky je každý požadavek na localhostu týž volající.
 */
const person = (n: number) => ({ extraHTTPHeaders: { 'x-forwarded-for': `203.0.113.${String(n)}` } });

/** Nabídka sdílení zapíše odkaz, který by odešel; události smyčky jdou na server beze změny. */
async function shareSheet(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const shared: ShareData[] = [];
    Object.assign(window, { __shared: shared });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => void shared.push(data) });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  });
}

/** Robot dohraje „rukou“ (jen takový běh posílá výzvu); `lag` = stisky o tolik tiků později. */
async function winByHand(page: Page, lag = 0): Promise<{ readonly tick: number; readonly score: number }> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  const end = await page.evaluate((late) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    return (window.__playShell as unknown as HandProbe).handPlay('end', late);
  }, lag);
  expect(end.runState).toBe('won');
  await expect(page.getByTestId('play-postrun')).toBeVisible();
  return end;
}

/** Přes „Change“ pod žebříčkem uloží jméno; list se po uložení zavře. */
async function pickName(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId('play-playing-as')).toContainText('Playing as');
  await page.getByTestId('play-name-change').click();
  await page.getByLabel('Your name on the board').fill(name);
  await page.getByTestId('play-name-save').click();
  await expect(page.getByTestId('play-name-form')).toHaveCount(0);
  await expect(page.getByTestId('play-playing-as')).toContainText(`Playing as ${name}`);
}

/** Řádky žebříčku jako `#1 Bo you`, v pořadí. */
async function boardRows(board: Locator): Promise<string[]> {
  return (await board.getByTestId('play-board-row').allInnerTexts()).map((row) => row.replace(/\s+/g, ' ').trim());
}

/** Číslo stupně v prvním okně (7 dní) `/play/stats`; čerstvé úložiště = jen dnešek. */
async function funnelCount(page: Page, step: string): Promise<number> {
  const row = page.locator('.play-stats-window').first().locator('tr', { has: page.locator('th', { hasText: new RegExp(`^${step}$`) }) });
  return Number((await row.locator('td').first().innerText()).replace(/,/g, ''));
}

test('P44B: Say → Dare → Beat → leaderboard → funnel, in two browsers', async ({ browser }) => {
  test.setTimeout(240_000);

  // A: věta v UI, výhra, jméno, výzva.
  const a = await browser.newContext(person(41));
  await shareSheet(a);
  const pageA = await a.newPage();
  await pageA.goto('/play');
  await pageA.getByLabel('Say it in one sentence').fill(SENTENCE);
  await pageA.getByTestId('play-create').click();
  await expect(pageA).toHaveURL(/\/play\/[a-f0-9]+$/, { timeout: 90_000 });
  const id = new URL(pageA.url()).pathname.split('/').at(-1)!;

  const postedA = pageA.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST');
  const endA = await winByHand(pageA, LAG_A);
  expect((await postedA).status()).toBe(201);
  const resultA = pageA.getByTestId('play-postrun');
  await expect(resultA.getByTestId('play-board')).toBeVisible();
  await pickName(pageA, 'Ada');
  // Nové jméno je v žebříčku hned (žebříček se po uložení načte znovu).
  await expect.poll(() => boardRows(resultA.getByTestId('play-board'))).toEqual([expect.stringMatching(/^#1 Ada you\b/)]);

  await resultA.getByTestId('play-share').click();
  await expect.poll(() => pageA.evaluate(() => (window as unknown as Captured).__shared.length)).toBe(1);
  const link = (await pageA.evaluate(() => (window as unknown as Captured).__shared[0]!)).url!;
  expect(link).toMatch(new RegExp(`/play/${id}\\?via=share&dare=[a-f0-9]{32}$`));

  // B: jiná adresa, jiné cookies; odkaz říká, kdo vyzývá, a rychlejší výhra ho porazí.
  const b = await browser.newContext(person(42));
  await shareSheet(b);
  const pageB = await b.newPage();
  await pageB.goto(link);
  await expect(pageB.getByTestId('play-dare-strip')).toContainText('Ada dares you');
  const endB = await winByHand(pageB);
  expect(endB.tick).toBeLessThan(endA.tick);
  const resultB = pageB.getByTestId('play-postrun');
  await expect(resultB.getByTestId('play-beat-friend')).toHaveText('You beat Ada!');
  await expect(resultB.getByTestId('play-board-standing')).toHaveText("You're #1 of 2");
  await expect.poll(() => boardRows(resultB.getByTestId('play-board'))).toEqual([expect.stringMatching(/ you\b/), expect.stringMatching(/^#2 Ada\b/)]);
  await pickName(pageB, 'Bo');
  await expect.poll(() => boardRows(resultB.getByTestId('play-board'))).toEqual([expect.stringMatching(/^#1 Bo you\b/), expect.stringMatching(/^#2 Ada\b/)]);

  // A znovu načte hru a v „About this game“ vidí Bo první a sebe druhou.
  await pageA.goto(`/play/${id}`);
  await pageA.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  await openAbout(pageA);
  const info = pageA.getByRole('dialog', { name: 'About this game' }).getByTestId('play-board');
  await expect.poll(() => boardRows(info)).toEqual([expect.stringMatching(/^#1 Bo\b(?!.* you\b)/), expect.stringMatching(/^#2 Ada you\b/)]);

  // Trychtýř dne: dvě hraní a dohrání, sdílení, otevřený odkaz a poražená výzva.
  const stats = await a.newPage();
  await stats.goto('/play/stats');
  await expect(stats.getByRole('heading', { name: 'Loop funnel' })).toBeVisible();
  const counts = Object.fromEntries(await Promise.all(['Say', 'Play', 'Finish', 'Share', 'Open', 'Beat'].map(async (step) => [step, await funnelCount(stats, step)] as const)));
  expect(counts.Say).toBeGreaterThanOrEqual(1);
  expect(counts.Play).toBeGreaterThanOrEqual(2);
  expect(counts.Finish).toBeGreaterThanOrEqual(2);
  expect(counts.Share).toBeGreaterThanOrEqual(1);
  expect(counts.Open).toBeGreaterThanOrEqual(1);
  expect(counts.Beat).toBeGreaterThanOrEqual(1);

  await a.close();
  await b.close();
});
