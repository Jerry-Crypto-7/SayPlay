import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { startGame } from './play-start';

/**
 * Progresivní hra (P23-D T2, P27C T2) bez modelu: věta dá návrh hned a nad
 * hrou stojí proužek se stavem AI verze. Server v e2e model nemá, takže sám
 * umí jen `draft-final` s `MODEL_UNAVAILABLE`; `working → ready` a
 * `working → final` se podvrhnou přes `page.route` na `GET …/upgrade`
 * a `ready` míří na skutečně publikovanou hru. S modelem se cesta měří v P27D.
 */

const SENTENCE = 'A hamster escapes a supermarket while a giant Roomba hunts it.';

interface Created {
  readonly url: string;
  readonly versionId: string;
  readonly upgrade: string;
}

async function draftFromSentence(request: APIRequestContext): Promise<Created> {
  const created = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
  expect(created.status(), await created.text()).toBeLessThan(300);
  const body = (await created.json()) as Created;
  expect(body.upgrade).toBe(`/api/play/games/${body.versionId}/upgrade`);
  return body;
}

async function publishedSpec(request: APIRequestContext): Promise<string> {
  const spec = JSON.parse(readFileSync(join(process.cwd(), 'src/play/__fixtures__/collect_exit.json'), 'utf8')) as unknown;
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { versionId: string }).versionId;
}

/** Podvržený server: `answer(n)` je odpověď na n-tý dotaz (od 1); vrací počítadlo dotazů. */
async function fakeUpgrade(page: Page, draft: Created, answer: (asked: number) => Record<string, unknown>): Promise<() => number> {
  let asked = 0;
  await page.route(`**${draft.upgrade}`, async (route) => {
    asked += 1;
    await route.fulfill({ json: answer(asked), headers: { 'cache-control': 'no-store' } });
  });
  return () => asked;
}

const pending = { status: 'pending', deadlineAt: new Date(Date.now() + 285_000).toISOString() };

async function running(page: Page): Promise<number> {
  await startGame(page);
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 0, undefined, { timeout: 60_000 });
  return page.evaluate(() => window.__playShell?.tick() ?? 0);
}

// Vědomá změna chování (P27C T2): dřív se při `draft-final` neukázalo nic
// (`toHaveCount(0)`) a hráč nevěděl, že AI verze nepřijde. Teď proužek řekne
// proč a nabídne nový pokus; hra pod ním běží dál.
test('without a model the draft stays final, the banner says the AI is busy, the game keeps running', async ({ page, request }) => {
  const body = await draftFromSentence(request);
  await expect
    .poll(async () => ((await (await request.get(body.upgrade)).json()) as { status: string }).status, { timeout: 30_000 })
    .toBe('draft-final');
  const final = (await (await request.get(body.upgrade)).json()) as { reason?: string };
  expect(final.reason).toBe('MODEL_UNAVAILABLE');

  await page.goto(body.url);
  const first = await running(page);
  const banner = page.getByTestId('upgrade-state');
  await expect(banner).toHaveAttribute('data-kind', 'final', { timeout: 15_000 });
  await expect(banner).toContainText("Couldn't make the full-detail version right now");
  await expect(page.getByTestId('upgrade-action')).toHaveText('Try again');
  expect(await page.evaluate(() => window.__playShell?.tick() ?? 0)).toBeGreaterThan(first);
  expect(new URL(page.url()).pathname).toBe(body.url);
});

test('working → ready: the banner counts seconds, then offers the AI version without swapping the game', async ({ page, request }) => {
  const draft = await draftFromSentence(request);
  const target = await publishedSpec(request);
  await fakeUpgrade(page, draft, (asked) => (asked < 3 ? pending : { status: 'ready', versionId: target }));

  await page.goto(draft.url);
  await running(page);
  const banner = page.getByTestId('upgrade-state');
  await expect(banner).toHaveAttribute('data-kind', 'working');
  // Přepínač Quick | Full detail (P38) je pilulka `.sp-status`; věta kitu (`11-voice-copy.md`) jde
  // čtečce – bez počítadla sekund, protože kromě pulzující tečky se nic nehýbe samo. Full detail
  // je během práce neaktivní, hotová verze ho rozsvítí.
  await expect(banner).toContainText('Quick version · the full-detail one is on its way');
  await expect(banner).toHaveClass(/sp-status/);
  await expect(banner).not.toContainText('%');
  await expect(page.getByTestId('upgrade-action')).toBeDisabled();

  await expect(banner).toHaveAttribute('data-kind', 'ready', { timeout: 15_000 });
  await expect(banner).toContainText('Full-detail version ready');
  await expect(page.getByTestId('upgrade-action')).toHaveText('Full detail');
  await expect(page.getByTestId('upgrade-action')).toBeEnabled();
  // Hotová verze hru sama nevymění – hráč pořád hraje návrh.
  await page.waitForTimeout(2_500);
  expect(new URL(page.url()).pathname).toBe(draft.url);

  await page.getByTestId('upgrade-action').click();
  await page.waitForURL(`**/play/${target}`);
});
// P56B T5: toast konce bez AI verze ležel přes spodní třetinu celou hru. Teď 3 s mimo prostřední
// třetinu plátna, pak tečka a „Try again“ v přepínači verze.
for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`final toast clears the middle third and hides into the version switch within 3 s at ${String(viewport.width)}×${String(viewport.height)}`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const draft = await draftFromSentence(request);
    await fakeUpgrade(page, draft, () => ({ status: 'draft-final', reason: 'MODEL_UNAVAILABLE' }));

    await page.goto(draft.url);
    await running(page);
    const banner = page.getByTestId('upgrade-state');
    await expect(banner).toHaveClass(/sp-toast/, { timeout: 15_000 });
    const shownAt = Date.now();
    const canvas = await page.locator('canvas').first().boundingBox();
    const toast = await banner.boundingBox();
    if (canvas === null || toast === null) throw new Error('canvas or toast has no box');
    const [middleTop, middleBottom] = [canvas.y + canvas.height / 3, canvas.y + (canvas.height * 2) / 3];
    expect(toast.y + toast.height <= middleTop || toast.y >= middleBottom, `toast ${String(toast.y)}–${String(toast.y + toast.height)} vs middle third ${String(middleTop)}–${String(middleBottom)}`).toBe(true);

    await expect(banner).toHaveClass(/play-version-switch/, { timeout: 3_200 });
    expect(Date.now() - shownAt).toBeLessThanOrEqual(3_200);
    await expect(banner).toHaveAttribute('data-kind', 'final');
    await expect(banner).not.toHaveClass(/sp-toast/);
    const retry = banner.getByTestId('upgrade-action');
    await expect(retry).toHaveText('Try again');
    await expect(retry).toBeEnabled();
  });
}

test('working → final: the banner says why, and one double-clicked retry asks the server once', async ({ page, request }) => {
  const draft = await draftFromSentence(request);
  const asked = await fakeUpgrade(page, draft, (count) => (count < 2 ? pending : count === 2 ? { status: 'draft-final', reason: 'NOT_PLAYABLE' } : { status: 'draft-final', reason: 'MODEL_UNAVAILABLE' }));

  await page.goto(draft.url);
  await running(page);
  const banner = page.getByTestId('upgrade-state');
  await expect(banner).toHaveAttribute('data-kind', 'final', { timeout: 15_000 });
  // Text od P33 T5 (od P34 T8 slovníkem kitu): co se stalo a co zůstává, bez obviňování.
  await expect(banner).toContainText("The full-detail version wasn't playable in a test run. The quick one stays.");
  // Verdikt o větě: nový pokus by dopadl stejně, tlačítko nic neslibuje.
  await expect(page.getByTestId('upgrade-action')).toHaveCount(0);

  await page.unrouteAll();
  const retried = await fakeUpgrade(page, draft, (count) => (count === 1 ? { status: 'draft-final', reason: 'MODEL_UNAVAILABLE' } : pending));
  await page.reload();
  await running(page);
  await expect(banner).toContainText("Couldn't make the full-detail version right now", { timeout: 15_000 });
  expect(retried()).toBe(1);
  await page.getByTestId('upgrade-action').dblclick();
  await expect(banner).toHaveAttribute('data-kind', 'working');
  await page.waitForTimeout(3_000);
  // Dvojí klik = jedno nové sledování = jeden dotaz za první 2 s intervalu.
  expect(retried()).toBe(2);
  expect(asked()).toBe(2);
});

// P58D T3: hra ze čtení přijde v `pending` ~3 s po větě. Atrapa čtečky je podvržený `…/upgrade`: první 3 s bez čtení,
// pak `reading` míří na skutečně publikovanou hru jiného žánru. Skutečné dítě `relation: 'reading'` (přepínač
// Quick | Matched | Full detail na hře ze čtení) veřejné API nevyrobí – tu cestu měří živá kontrola P58D T4.
const READING_AFTER_MS = 3_000;

async function readingGame(page: Page, request: APIRequestContext): Promise<{ draft: Created; reading: string; arrive: () => void }> {
  const draft = await draftFromSentence(request);
  const reading = await publishedSpec(request);
  let arrived = false;
  await page.route(`**${draft.upgrade}`, async (route) => {
    await route.fulfill({ json: arrived ? { ...pending, reading: { versionId: reading } } : pending, headers: { 'cache-control': 'no-store' } });
  });
  return { draft, reading, arrive: () => (arrived = true) };
}

test('the reading game arrives: a player who has not pressed anything moves to it within one poll', async ({ page, request }) => {
  const { draft, reading, arrive } = await readingGame(page, request);
  await page.goto(draft.url);
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  const quickTitle = await page.locator('h1').first().textContent();
  await page.waitForTimeout(READING_AFTER_MS);
  arrive();
  const arrivedAt = Date.now();
  await page.waitForURL(`**/play/${reading}`, { timeout: 15_000 });
  // Jeden dotaz po 2 s + odpověď a navigace; rezerva na emulovaný telefon.
  expect(Date.now() - arrivedAt).toBeLessThan(2_000 + 3_000);
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  await expect(page.locator('h1').first()).not.toHaveText(quickTitle ?? '');
});

test('the reading game arrives after six seconds of play: the switch offers it and the game is not swapped', async ({ page, request }) => {
  const { draft, reading, arrive } = await readingGame(page, request);
  await page.goto(draft.url);
  await running(page);
  await page.waitForTimeout(6_500);
  arrive();
  const offer = page.getByTestId('reading-action');
  await expect(offer).toBeVisible({ timeout: 10_000 });
  await expect(offer).toHaveText('Matched');
  await expect(page.getByTestId('upgrade-state')).toHaveAttribute('data-reading', 'offer');
  await page.waitForTimeout(2_500);
  expect(new URL(page.url()).pathname).toBe(draft.url);
  await offer.click();
  await page.waitForURL(`**/play/${reading}`);
});
