import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { P68_GENRES, handSpec } from '../src/play/genre/p68-contract';
import { startGame } from './play-start';

interface HandProbe {
  readonly handPlay: (until: 'score' | 'end' | number) => { readonly runState: string; readonly tick: number; readonly score: number };
  readonly idleRun: () => { readonly runState: string; readonly tick: number };
}

/** Nabídka sdílení se v e2e nedá obsluhovat – zachytí se, co by dostala (i s klipem běhu, `canShare`). */
async function captureShare(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const shared: ShareData[] = [];
    (window as unknown as { __shared: ShareData[] }).__shared = shared;
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => void shared.push(data) });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  });
}

/** Robot dohraje „rukou“ (lidský běh – jen ten posílá výzvu), vzor `p36-dare.spec.ts`. */
async function winByHand(page: Page): Promise<{ readonly tick: number; readonly score: number }> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  const end = await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    return (window.__playShell as unknown as HandProbe).handPlay('end');
  });
  expect(end.runState).toBe('won');
  await expect(page.getByTestId('play-postrun')).toBeVisible();
  return end;
}

/** Každý „člověk“ z vlastní adresy: strop výzev je 1 za 10 s na volajícího. */
const person = (n: number) => ({ extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(n)}` } });

/**
 * Sdílený odkaz (P23-C T7): cizí prohlížeč bez cookies a bez úložiště jde
 * rovnou do hry, odkaz nese náhled (`og:title`, `og:image` jako PNG) a
 * neznámá hra dá 404 s větou – stránka i obrázek.
 */

test.describe('/play/[id] – share landing', () => {
  let url = '';
  let id = '';
  let gameTitle = '';

  test.beforeAll(async ({ request }) => {
    const response = await request.post('/api/play/games', { data: { sentence: 'Race through five neon gates in order.' } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    ({ url, title: gameTitle } = (await response.json()) as { url: string; title: string });
    id = url.split('/').at(-1)!;
  });

  test('a fresh browser context lands straight in the game', async ({ browser }) => {
    const context = await browser.newContext();
    expect(await context.cookies()).toEqual([]);
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.getByTestId('play-goal')).toBeVisible();
    await expect(page.getByTestId('play-sentence')).toHaveCount(0);
    await context.close();
  });

  test('the page carries the game title and a PNG preview image', async ({ page, request }) => {
    await page.goto(url);
    const title = await page.locator('meta[property="og:title"]').getAttribute('content');
    // Titulek píše návrh ze slov, ne opis věty – náhled nese ten, který dveře vrátily.
    expect(gameTitle).not.toBe('');
    expect(title).toContain(gameTitle);
    expect(title).toContain('sayplay');
    await expect(page).toHaveTitle(/sayplay/);
    const image = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(image).toMatch(new RegExp(`/api/play/games/${id}/og$`));

    const png = await request.get(`/api/play/games/${id}/og`);
    expect(png.status()).toBe(200);
    expect(png.headers()['content-type']).toBe('image/png');
    // P27B T6: náhled kreslí hru (ne paletová záloha), 1200×630, na verzi natrvalo.
    expect(png.headers()['x-og-fallback']).toBeUndefined();
    expect(png.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    const bytes = await png.body();
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(await page.locator('meta[property="og:image:alt"]').getAttribute('content')).toBe(`${gameTitle} – cover image`);
    // P58C T2: Messenger a WhatsApp čtou `og:image` s rozměry, X velkou kartu z `twitter:*`.
    expect(await page.locator('meta[property="og:image:width"]').getAttribute('content')).toBe('1200');
    expect(await page.locator('meta[property="og:image:height"]').getAttribute('content')).toBe('630');
    expect(await page.locator('meta[name="twitter:card"]').getAttribute('content')).toBe('summary_large_image');
    expect(await page.locator('meta[name="twitter:image"]').getAttribute('content')).toBe(image);
  });

  // P58C T2: náhled kreslí vlastní rastr. Kdyby trasa znovu sáhla po `next/og`, Next přibalí do
  // stopy funkce `@vercel/og` (satori, resvg.wasm – MPL-2.0); stopa `*.nft.json` je to, co se nasadí.
  test('the production build ships no @vercel/og, satori or resvg', () => {
    const server = join(process.cwd(), '.next', 'server');
    expect(existsSync(server), 'e2e runs over `npm run build`').toBe(true);
    const traced: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/resvg|satori/i.test(entry.name) || (entry.name.endsWith('.nft.json') && /compiled\/@vercel\/og|resvg|satori/.test(readFileSync(path, 'utf8')))) traced.push(path);
      }
    };
    walk(server);
    expect(traced).toEqual([]);
  });

  test('sharing mid-game keeps the game running and a second browser opens the same version (P27B T5)', async ({ browser }) => {
    const first = await browser.newContext();
    // Nabídka sdílení prohlížeče se v e2e nedá obsluhovat – zachytí se, co by dostala.
    await first.addInitScript(() => {
      const shared: ShareData[] = [];
      (window as unknown as { __shared: ShareData[] }).__shared = shared;
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => void shared.push(data) });
    });
    const page = await first.newPage();
    await page.goto(url);
    await startGame(page);
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 20, undefined, { timeout: 60_000 });
    const inputs = await page.evaluate(() => window.__playShell!.inputs().length);
    // Od P34 T7 otevře kolo sdílení v HUD list kitu; odkaz pošle jeho „Dare a friend“.
    await page.getByTestId('play-share').click();
    await page.getByTestId('play-share-dare').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared.length)).toBe(1);
    const data = await page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared[0]);
    expect(data.url).toMatch(new RegExp(`/play/${id}\\?via=share$`));
    expect(data.title).toBe(gameTitle);
    // Stisk do hry nepropadl: žádný nový vstup, hodiny běží dál, pauza nenastala.
    const tick = await page.evaluate(() => window.__playShell!.tick());
    await expect.poll(() => page.evaluate(() => window.__playShell!.tick())).toBeGreaterThan(tick);
    expect(await page.evaluate(() => window.__playShell!.inputs().length)).toBe(inputs);
    await expect(page.getByTestId('play-paused')).toHaveCount(0);
    // Otisk světa, jak ho dostal tento prohlížeč: spec, blueprint i arkádový svět verze.
    const worldOf = (target: typeof page) =>
      target.evaluate(async (versionId) => {
        const game = (await (await fetch(`/api/play/games/${versionId}`)).json()) as Record<string, unknown>;
        return JSON.stringify([game.spec, game.blueprint ?? null, game.arcade ?? null]);
      }, id);
    const world = await worldOf(page);

    const second = await browser.newContext();
    const other = await second.newPage();
    let generated = 0;
    other.on('request', (request) => {
      // Události smyčky (P27D T4) jsou POST, ale nic negenerují.
      if (request.method() === 'POST' && !request.url().includes('/api/play/events')) generated += 1;
    });
    await other.goto(data.url!);
    await expect(other).toHaveURL(new RegExp(`/play/${id}\\?via=share$`));
    await other.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    await expect(other.getByTestId('play-goal')).toBeVisible();
    expect(await worldOf(other)).toBe(world);
    expect(generated).toBe(0);
    await first.close();
    await second.close();
  });

  test('without a share sheet the HUD button copies the link to this version', async ({ browser }) => {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    });
    const page = await context.newPage();
    await page.goto(url);
    // Od P34 T7 otevře kolo v HUD list sdílení: Dare a friend bez nabídky prohlížeče odkaz zkopíruje a list zavře.
    await page.getByTestId('play-share').click();
    await expect(page.getByRole('dialog', { name: 'Share this game' })).toBeVisible();
    // Trvalost odkazu ověřuje tlačítko až po stisku dotazem na dveře – na jeho odpověď se čeká.
    const lasting = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}`) && response.request().method() === 'GET');
    await page.getByTestId('play-share-dare').click();
    await expect(page.getByRole('dialog', { name: 'Share this game' })).toHaveCount(0);
    // P34 T6: toast mluví kitem („Link copied. Go dare someone.“ místo „Link copied“).
    await expect(page.getByText('Link copied. Go dare someone.')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`^https?://[^/]+/play/${id}\\?via=share$`));
    // E2e server píše od P40 do souborového úložiště (`PLAY_STORE_DIR`, `x-play-store: file`):
    // odkaz přežije restart, varování paměťového úložiště (P27D T5) se tedy nesmí ukázat.
    expect((await lasting).headers()['x-play-store']).toBe('file');
    await expect(page.getByText('the link stops working when it restarts')).toHaveCount(0);
    await context.close();
  });

  // P66 T11: výhra pošle svoje skóre jako cíl („Beat my …!“) odkazem výzvy, tenhle prohlížeč si ho pamatuje
  // jako rekord („Best …“) a kamarád z odkazu vidí „Beat …“; běh proti výzvě soudí výsledek.
  test('a win dares its score: Best N here, Beat N for the friend, then So close. or You beat it! (P66 T11)', async ({ browser }) => {
    test.setTimeout(180_000);
    const first = await browser.newContext(person(61));
    await captureShare(first);
    const page = await first.newPage();
    await page.goto(url);
    const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST');
    await winByHand(page);
    const dare = (await (await posted).json()) as { dareId: string; score: number; ticks: number };
    const target = dare.score > 0 ? dare.score.toLocaleString('en-US') : `${(dare.ticks / 60).toFixed(1)}s`;
    await page.getByTestId('play-share').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared.length)).toBe(1);
    const shared = await page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared[0]!);
    expect(shared.url).toMatch(new RegExp(`/play/${id}\\?via=share&dare=${dare.dareId}$`));
    expect(shared.text!.split('\n')).toContain(`Beat my ${target}!`);
    // Další běh v tomhle prohlížeči má výhru jako rekord k překonání v HUD.
    await page.getByTestId('play-replay').click();
    await expect(page.getByTestId('hud-counter-best')).toHaveText(`Best ${target}`);
    await first.close();

    const second = await browser.newContext(person(62));
    const other = await second.newPage();
    await other.goto(`${url}?via=share&dare=${dare.dareId}`);
    await expect(other.getByTestId('play-dare-goal')).toContainText(`Beat ${target}`, { timeout: 60_000 });
    await expect(other.getByTestId('hud-counter-dare')).toHaveText(`Beat ${target}`);
    await other.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    const lost = await other.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun());
    expect(lost.runState).toBe('lost');
    await expect(other.locator('.play-result-title')).toHaveText('So close.');
    await expect(other.getByTestId('play-dare-result')).toHaveAttribute('data-beat', 'false');
    // Výhra proti výzvě: týž robot je shoda (So close.), rychlejší nebo s víc body by byl You beat it!.
    await winByHand(other);
    const beat = await other.getByTestId('play-dare-result').getAttribute('data-beat');
    await expect(other.locator('.play-result-title')).toHaveText(beat === 'true' ? 'You beat it!' : 'So close.');
    expect(await other.locator('body').innerText()).not.toMatch(/NaN|undefined/);
    await second.close();
  });

  // P66 T11: přebitý rekord za běhu ohlásí hláška vrstvy háčků (i ve hře bez háčků) a pilulka „Best“ ustoupí.
  test('beating the record mid-run calls out New best! and the Best pill gives way', async ({ browser }) => {
    const context = await browser.newContext();
    await context.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ score: 1, ticks: 1, stars: 0 })), `sp-best:${id}`);
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.getByTestId('hud-counter-best')).toHaveText('Best 1', { timeout: 60_000 });
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    // Robot „rukou“ do bodů nad rekordem: běh dál běží, body už rekord přebily.
    const run = await page.evaluate(() => (window.__playShell as unknown as HandProbe).handPlay(1));
    expect(run.runState).toBe('running');
    expect(run.score).toBeGreaterThan(1);
    const callout = page.getByTestId('hook-callout');
    await expect(callout).toHaveText('New best!');
    await expect(callout).toHaveAttribute('data-callout', 'new_best');
    await expect(page.getByTestId('hud-counter-best')).toHaveCount(0);
    // Hláška zhasne (1,2 s) a v tomhle běhu se nevrátí.
    await expect(callout).toHaveCount(0, { timeout: 5_000 });
    await page.waitForTimeout(1_000);
    await expect(callout).toHaveCount(0);
    await context.close();
  });

  // Okraj odkazu (P66 T11): `dare=` nese id výzvy, kterou server přehrál – holé číslo ani nesmysl cílem nejsou.
  test('a dare that is a bare number or junk opens the plain game without a target', async ({ page }) => {
    test.setTimeout(180_000);
    for (const junk of ['1240', '-1', '99999999999', 'NaN']) {
      await page.goto(`${url}?via=share&dare=${junk}`);
      await expect(page.getByTestId('play-first-prompt')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('play-dare-goal')).toHaveCount(0);
      await expect(page.getByTestId('hud-counter-dare')).toHaveCount(0);
      expect(await page.locator('body').innerText()).not.toMatch(/NaN/);
    }
  });

  // Soukromé okno (P66 T11): už sáhnout na `localStorage` hází – hra se dohraje, výhra nespadne a rekord nevznikne.
  test('a private window without storage plays to the result and shows no Best pill', async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext(person(63));
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await winByHand(page);
    await expect(page.locator('.play-result-title')).toHaveText('You did it!');
    await page.getByTestId('play-replay').click();
    await expect(page.getByTestId('play-first-prompt')).toBeVisible();
    await expect(page.getByTestId('hud-counter-best')).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  test('an unknown game is a 404 with a sentence, for the page and the image', async ({ page, request }) => {
    const response = await page.goto('/play/deadbeef');
    expect(response?.status()).toBe(404);
    await expect(page.getByText('This game does not exist or has expired.')).toBeVisible();
    await expect(page.locator('a[href="/play"]')).toBeVisible();

    const image = await request.get('/api/play/games/deadbeef/og');
    expect(image.status()).toBe(404);
    expect(((await image.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

/**
 * Výzva nové hry P68 (P68-I T6): hra z ručního specu `e2e/fixtures/p68-<id>-spec.json`, výhra „rukou“ pošle výzvu,
 * kamarád otevře její odkaz, dohraje a dostane výsledek proti ní. Server přehraje i jeho běh: týž běh robota je táž
 * výzva (200, týž `dareId`), takže záznam z prohlížeče dal na serveru týž hash konce. Hra bez specu se přeskočí –
 * dnes všech pět, spec dodá kategorie. Jede v `chromium` i `pixel7-touch`.
 */
test.describe("P68 games – a new game's dare (T6)", () => {
  for (const [index, genre] of P68_GENRES.entries()) {
    const fixture = join(process.cwd(), 'e2e', 'fixtures', `p68-${genre}-spec.json`);
    test(`${genre}: open its dare, play it out, see the result (P68 T6)`, async ({ browser, request }, info) => {
      test.skip(!existsSync(fixture), `no hand spec e2e/fixtures/p68-${genre}-spec.json yet`);
      test.setTimeout(240_000);
      const published = await request.post('/api/play/games', { data: { spec: handSpec(JSON.parse(readFileSync(fixture, 'utf8')) as unknown) } });
      expect(published.status(), await published.text()).toBeLessThan(300);
      const { url } = (await published.json()) as { url: string };
      const id = url.split('/').at(-1)!;
      const isDare = (response: { url(): string; request(): { method(): string } }): boolean => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST';
      // Každá hra a projekt z vlastních adres: strop výzev je 1 za 10 s na volajícího.
      const caller = 70 + (info.project.name === 'pixel7-touch' ? 20 : 0) + 2 * index;

      const author = await browser.newContext(person(caller));
      const page = await author.newPage();
      await page.goto(url);
      const posted = page.waitForResponse(isDare);
      await winByHand(page);
      const made = await posted;
      // Ruční spec je pokaždé táž verze: druhý projekt na témž serveru najde týž běh uložený (200), první ho uloží (201).
      expect([200, 201], await made.text()).toContain(made.status());
      const dare = (await made.json()) as { dareId: string; score: number; ticks: number };
      await author.close();

      const friend = await browser.newContext(person(caller + 1));
      const other = await friend.newPage();
      await other.goto(`${url}?via=share&dare=${dare.dareId}`);
      const target = dare.score > 0 ? dare.score.toLocaleString('en-US') : `${(dare.ticks / 60).toFixed(1)}s`;
      await expect(other.getByTestId('play-dare-goal')).toContainText(`Beat ${target}`, { timeout: 60_000 });
      const replayed = other.waitForResponse(isDare);
      const end = await winByHand(other);
      expect({ score: end.score, ticks: end.tick }).toEqual({ score: dare.score, ticks: dare.ticks });
      const again = await replayed;
      expect(again.status(), await again.text()).toBe(200);
      expect(((await again.json()) as { dareId: string }).dareId).toBe(dare.dareId);
      const beat = await other.getByTestId('play-dare-result').getAttribute('data-beat');
      await expect(other.locator('.play-result-title')).toHaveText(beat === 'true' ? 'You beat it!' : 'So close.');
      expect(await other.locator('body').innerText()).not.toMatch(/NaN|undefined/);
      await friend.close();
    });
  }
});
