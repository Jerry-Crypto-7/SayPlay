import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';

/**
 * Řetěz mikroher v prohlížeči (P56C T13), nad `next build` + `next start`: věta, která žádá o kola, dá
 * řetěz, jehož kolo 1 poslouchá do 1,5 s od navigace, mezi koly ukáže kartu se slovesem, index kola
 * roste, prohrané kolo vezme srdce, výhra skončí hvězdami a Dare, jehož odkaz otevře ducha kamaráda.
 * Kola hraje sonda `__playShell.playRound` (stisky robota kola tik po tiku cestou klávesnice), takže
 * záznam je hráčův a výzvu z něj přehraje server (`replayChain`). Běží v `chromium` i `pixel7-touch`.
 */

interface ChainProbe {
  readonly tick: () => number;
  readonly round: () => number;
  readonly card: () => number;
  readonly lives: () => number;
  readonly outcome: () => string;
  readonly start: () => void;
  readonly playRound: (how: 'bot' | 'idle') => { readonly runState: string; readonly round: number; readonly lives: number; readonly outcome: string; readonly tick: number };
}

/** Dev `d01` (`multi_verb`) s přáním kol: od P70A T2 řetěz jen na výslovné přání (`CHAIN_CUES`). */
const SENTENCE = 'a penguin mail carrier slides down icy hills dodging snowballs, then tosses letters into chimneys, in three rounds';

/** První kolo musí poslouchat do 1,5 s od navigace (cíl plánu); telefon jen zapíše. */
const FIRST_PLAYABLE_MS = 1500;

/** Každý „člověk“ z vlastní adresy: strop výzev je 1 za 10 s na volajícího. */
const person = (n: number) => ({ extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(n)}` } });

async function publish(request: APIRequestContext, sentence: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

const probeReady = (page: Page) => page.waitForFunction(() => (window.__playShell as unknown as Partial<ChainProbe> | undefined)?.playRound !== undefined, undefined, { timeout: 60_000 });

const playRound = (page: Page, how: 'bot' | 'idle') => page.evaluate((h) => (window.__playShell as unknown as ChainProbe).playRound(h), how);

/** Kolo `round` (od 1) běží: karta dohrála a hraje se jeho relace. */
async function roundOpen(page: Page, round: number): Promise<void> {
  await page.waitForFunction((r) => {
    const probe = window.__playShell as unknown as ChainProbe;
    return probe.round() === r - 1 && probe.card() === 0;
  }, round, { timeout: 20_000 });
  await expect(page.locator('main[data-chain-round]')).toHaveAttribute('data-chain-round', String(round));
}

/** Skutečné stisky (telefon ťuk, desktop klávesa), dokud kolo 1 nezapíše první vstup; ms od začátku navigace. */
async function firstPlayable(page: Page, info: TestInfo): Promise<number> {
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toBeVisible({ timeout: 60_000 });
  for (let attempt = 0; attempt < 600 && (await stage.getAttribute('data-input-at')) === null; attempt += 1) {
    if (info.project.use.hasTouch === true) await stage.tap({ force: true });
    else await page.keyboard.press('Space');
  }
  const at = Number(await stage.getAttribute('data-input-at'));
  return page.evaluate((stamp) => stamp - performance.timeOrigin, at);
}

test.describe('/play/[id] – a microgame chain (P56C T13)', () => {
  test('two verbs → chain: playable round 1, verb card, rounds, hearts, stars, dare and its ghost', async ({ browser, request }, info) => {
    test.setTimeout(180_000);
    const url = await publish(request, SENTENCE);
    const id = url.split('/').at(-1)!;
    // Telefon podle dotyku, ne podle jména projektu: `iphone-touch` (P58C T4) je telefon stejně jako Pixel 7.
    const phone = info.project.use.hasTouch === true;
    const a = await browser.newContext(person(phone ? 72 : 71));
    const page = await a.newPage();
    // Čerstvě spuštěný `next start` staví stránku hry při prvním požadavku líně (měřeno 1581 ms proti 1,1 s
    // v druhém běhu); 1,5 s platí pro řetěz, ne pro první požadavek serveru.
    expect((await request.get(url)).status()).toBe(200);
    await page.goto(url);
    await expect(page.locator('main[data-chain-round]')).toHaveAttribute('data-chain-round', '1', { timeout: 60_000 });

    const playable = await firstPlayable(page, info);
    info.annotations.push({ type: 'first-playable-ms', description: String(Math.round(playable)) });
    // Strop je změřený na Chromiu. WebKit na Windows není build ani grafika Safari, čas jen zapíše (`evals/play/p58c/webkit.md`).
    if (!phone && browser.browserType().name() === 'chromium') expect(playable).toBeLessThanOrEqual(FIRST_PLAYABLE_MS);

    await probeReady(page);
    const rounds = Number((await page.getByTestId('hud-counter-round').textContent())!.split('/').at(-1));
    expect(rounds).toBeGreaterThanOrEqual(3);

    // Mutátory (T16): karta ukáže mutátor kola 2 z uloženého řetězu pod slovesem; vypnuté (`CHAIN_MUTATORS`) = žádný.
    // Zelené s mutátorem 21. 10. (chromium 2/2, pixel7-touch 1/1: d01 kolo 2 „Tiny hero!“) před vypnutím po slepém soudu.
    const stored = (await (await request.get(`/api/play/games/${id}`)).json()) as { chain: { rounds: { card: string; twist?: string }[] } };
    const twist = stored.chain.rounds[1]!.twist;

    // Kolo 1 vyhraje robot kola; karta ukáže sloveso kola 2 (a jeho mutátor) a zmizí.
    let end = await playRound(page, 'bot');
    expect(end).toMatchObject({ runState: 'won', round: 1, lives: 3, outcome: 'running' });
    const card = page.getByTestId('play-chain-card');
    await expect(card).toHaveAttribute('data-round', '2');
    await expect(card).toContainText(stored.chain.rounds[1]!.card);
    if (twist === undefined) await expect(page.getByTestId('play-chain-twist')).toHaveCount(0);
    else await expect(page.getByTestId('play-chain-twist')).toHaveText(twist);
    await roundOpen(page, 2);
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('hud-counter-round')).toContainText(`2/${String(rounds)}`);

    // Kolo 2 bez stisku: prohra stojí srdce a řetěz jede dál.
    end = await playRound(page, 'idle');
    expect(end).toMatchObject({ runState: 'lost', round: 2, lives: 2, outcome: 'running' });
    await expect(page.getByTestId('hud-counter-lives')).toContainText('2');

    // Zbytek řetězu robot; výhra pošle záznam s globálními tiky jako výzvu.
    const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST');
    for (let round = 3; round <= rounds; round += 1) {
      await roundOpen(page, round);
      end = await playRound(page, 'bot');
      expect(end.runState, `round ${String(round)}`).toBe('won');
    }
    expect(end).toMatchObject({ outcome: 'won', round: rounds, lives: 2 });
    const response = await posted;
    expect([200, 201]).toContain(response.status());
    const dare = (await response.json()) as { dareId: string; ticks: number };
    // Server přehrál týž běh (`replayChain`): stejný počet globálních tiků jako hráč.
    expect(dare.ticks).toBe(end.tick);

    const result = page.getByTestId('play-postrun');
    await expect(result).toBeVisible();
    await expect(page.getByTestId('play-stars')).toHaveAttribute('data-stars', /^[123]$/);
    await a.close();

    // Odkaz výzvy otevře řetěz s duchem kamaráda v kole 1.
    const b = await browser.newContext(person(phone ? 74 : 73));
    const friend = await b.newPage();
    await friend.goto(`${url}?via=share&dare=${dare.dareId}`);
    await probeReady(friend);
    await friend.evaluate(() => (window.__playShell as unknown as ChainProbe).start());
    await expect(friend.getByTestId('play-ghost-tag')).toHaveText('Friend', { timeout: 30_000 });
    await expect(friend.getByTestId('play-ghost-tag')).toBeVisible({ timeout: 30_000 });
    await b.close();
  });
});

/**
 * P58E T3: řetěz dostane čtení věty na pozadí; vyjde-li z něj jedna hra, konec `CHAIN` nese `reading`. Atrapa čtečky
 * je podvržený `…/upgrade` řetězu: první 3 s `pending` bez čtení, pak konec – s hrou ze čtení (skutečně publikovanou
 * hrou jiného žánru), nebo bez ní. Skutečné dítě `relation: 'reading'` řetězu veřejné API nevyrobí (čtečka v e2e není);
 * jeho přepínač (Quick zpátky na řetěz, žádná věta o konci) pinuje `upgrade-banner.test.ts`.
 */
test.describe('/play/[id] – a chain moves to the reading game (P58E T3)', () => {
  const READING_AFTER_MS = 3_000;
  /** Toast konce bez AI verze trvá 3 s (`TOAST_MS`); po něm i po dalším dotazu musí být řetěz pořád bez ničeho. */
  const TOAST_AND_MARGIN_MS = 3_000 + 2_500;
  /** P70A T2: rozehraný řetěz = první dotyk (hodiny se pohnuly), pak hra ze čtení už jen nabízí. */
  const COMMITTED_TICKS = 1;

  /** Snímek do složky testu (oracle úlohy – člověk je prohlédne), přiložený i k výsledku. */
  async function snap(page: Page, info: TestInfo, name: string): Promise<void> {
    const path = info.outputPath(`${name}.png`);
    await page.screenshot({ path });
    await info.attach(name, { path, contentType: 'image/png' });
  }

  async function chainAndReading(page: Page, request: APIRequestContext, reads: 'game' | 'chain'): Promise<{ url: string; reading: string; arrive: () => void; asked: () => number }> {
    const created = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
    expect(created.status(), await created.text()).toBeLessThan(300);
    const body = (await created.json()) as { url: string; versionId: string; upgrade?: string };
    expect(body.upgrade).toBe(`/api/play/games/${body.versionId}/upgrade`);
    const spec = JSON.parse(readFileSync(join(process.cwd(), 'src/play/__fixtures__/collect_exit.json'), 'utf8')) as unknown;
    const published = await request.post('/api/play/games', { data: { spec } });
    expect(published.status(), await published.text()).toBeLessThan(300);
    const reading = ((await published.json()) as { versionId: string }).versionId;
    const end = reads === 'game' ? { status: 'draft-final', reason: 'CHAIN', reading: { versionId: reading } } : { status: 'draft-final', reason: 'CHAIN' };
    let arrived = false;
    let asked = 0;
    await page.route(`**${body.upgrade}`, async (route) => {
      asked += 1;
      await route.fulfill({ json: arrived ? end : { status: 'pending', deadlineAt: new Date(Date.now() + 285_000).toISOString() }, headers: { 'cache-control': 'no-store' } });
    });
    return { url: body.url, reading, arrive: () => (arrived = true), asked: () => asked };
  }

  test('chain sentence → chain → the reading game, within one poll, for a player not into the chain yet', async ({ page, request }, info) => {
    const { url, reading, arrive } = await chainAndReading(page, request, 'game');
    await page.goto(url);
    await probeReady(page);
    // Dokud čtení běží, řetěz nic neslibuje: žádné Full detail, žádná tečka.
    await expect(page.getByTestId('upgrade-state')).toHaveCount(0);
    await snap(page, info, 'chain-while-reading');
    await page.waitForTimeout(READING_AFTER_MS);
    arrive();
    const arrivedAt = Date.now();
    await page.waitForURL(`**/play/${reading}`, { timeout: 15_000 });
    // Jeden dotaz po 2 s + odpověď a navigace; rezerva na emulovaný telefon.
    expect(Date.now() - arrivedAt).toBeLessThan(2_000 + 3_000);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    await expect(page.locator('main[data-chain-round]')).toHaveCount(0);
    await snap(page, info, 'reading-game');
  });

  test('the reading keeps the chain: nothing offered, no error, the chain plays on', async ({ page, request }, info) => {
    const { url, arrive, asked } = await chainAndReading(page, request, 'chain');
    arrive();
    await page.goto(url);
    await probeReady(page);
    await expect.poll(asked, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(TOAST_AND_MARGIN_MS);
    await expect(page.getByTestId('upgrade-state')).toHaveCount(0);
    await expect(page.getByText(/run of rounds/)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(url);
    await snap(page, info, 'chain-kept');
  });

  test('after the first touch the chain offers the reading game and is not swapped', async ({ page, request }, info) => {
    const { url, reading, arrive } = await chainAndReading(page, request, 'game');
    await page.goto(url);
    await probeReady(page);
    await page.evaluate(() => (window.__playShell as unknown as ChainProbe).start());
    await page.waitForFunction(
      (ticks) => {
        const probe = window.__playShell as unknown as ChainProbe;
        return probe.tick() >= ticks || probe.outcome() !== 'running';
      },
      COMMITTED_TICKS,
      { timeout: 60_000 },
    );
    arrive();
    const offer = page.getByTestId('reading-action');
    await expect(offer).toBeVisible({ timeout: 10_000 });
    await expect(offer).toHaveText('Matched');
    await expect(page.getByTestId('upgrade-state')).toHaveAttribute('data-reading', 'offer');
    await expect(page.getByTestId('upgrade-action')).toHaveCount(0);
    await snap(page, info, 'chain-offer');
    await page.waitForTimeout(2_500);
    expect(new URL(page.url()).pathname).toBe(url);
    await offer.click();
    await page.waitForURL(`**/play/${reading}`);
  });
});
