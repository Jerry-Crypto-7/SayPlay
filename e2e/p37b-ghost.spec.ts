import { expect, test, type Page } from '@playwright/test';

/**
 * Duch ve hře (P37B T8): hráč vyhraje „rukou“ a server uloží běh výzvy.
 * Kamarád otevře odkaz výzvy (`/play/<id>?dare=`) a vedle jeho hrdiny závodí
 * duch se štítkem „Friend“; kdo přijde bez odkazu, závodí s nejlepším během
 * hry („Best run“). Ukázka robota závod není – duch při ní zmizí.
 */

const SENTENCE = 'endless runner with a lot of obstacles';

interface HandProbe {
  readonly handPlay: (until: 'score' | 'end') => { readonly runState: string };
  readonly start: () => void;
}

interface GhostProbe {
  readonly tick: number;
  readonly shown: boolean;
  readonly label: string;
  readonly z: number;
}

interface GameWindow {
  readonly __playShell?: unknown;
  readonly __playGhost?: () => GhostProbe;
}

/** Každý „člověk“ z vlastní adresy: strop výzev i čtení drží volajícího podle adresy. */
const person = (n: number) => ({ extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(n)}` } });

async function shellReady(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as GameWindow).__playShell !== undefined, undefined, { timeout: 60_000 });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

const ghostOf = (page: Page): Promise<GhostProbe | null> => page.evaluate(() => (window as GameWindow).__playGhost?.() ?? null);

/** Duch se štítkem stojí ve hře; po startu běží s hráčem po trati. */
async function racesBeside(page: Page, tag: string, label: string): Promise<void> {
  await expect(page.getByTestId('play-ghost-tag')).toHaveText(tag, { timeout: 30_000 });
  await expect(page.getByTestId('play-ghost-tag')).toBeVisible();
  await page.evaluate(() => ((window as GameWindow).__playShell as HandProbe).start());
  await page.waitForFunction(() => {
    const ghost = (window as GameWindow).__playGhost?.();
    return ghost !== undefined && ghost.shown && ghost.tick > 30;
  });
  const first = (await ghostOf(page))!;
  expect(first.label).toBe(label);
  await page.waitForFunction((tick) => ((window as GameWindow).__playGhost?.().tick ?? 0) > tick + 60, first.tick);
  expect((await ghostOf(page))!.z).toBeGreaterThan(first.z);
}

test.describe('ghost in the game (P37B T8)', () => {
  test("a friend's link races their ghost, a plain visit races the best run, the demo races nobody", async ({ browser, request }) => {
    test.setTimeout(240_000);
    const published = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
    expect(published.status(), await published.text()).toBeLessThan(300);
    const url = ((await published.json()) as { url: string }).url;
    const id = url.split('/').at(-1)!;

    const author = await browser.newContext(person(41));
    const play = await author.newPage();
    await play.goto(url);
    const posted = play.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST');
    await shellReady(play);
    const end = await play.evaluate(() => ((window as GameWindow).__playShell as HandProbe).handPlay('end'));
    expect(end.runState).toBe('won');
    const response = await posted;
    expect([200, 201]).toContain(response.status());
    const { dareId } = (await response.json()) as { dareId: string };
    await author.close();

    const friend = await browser.newContext(person(42));
    const dared = await friend.newPage();
    await dared.goto(`${url}?dare=${dareId}`);
    await shellReady(dared);
    await racesBeside(dared, 'Friend', 'friend');
    await friend.close();

    const stranger = await browser.newContext(person(43));
    const plain = await stranger.newPage();
    await plain.goto(url);
    await shellReady(plain);
    await racesBeside(plain, 'Best run', 'best');

    // Ukázka robota: duch se odmontuje i se sondou.
    await plain.getByTestId('play-pause').click();
    await plain.getByTestId('play-demo-start').click();
    await expect(plain.getByTestId('play-demo')).toBeVisible();
    await expect(plain.getByTestId('play-ghost-tag')).toHaveCount(0);
    expect(await ghostOf(plain)).toBeNull();
    await stranger.close();
  });
});
