import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';

/**
 * Řetěz mikroher v prohlížeči (P56C T13), nad `next build` + `next start`: věta se dvěma slovesy dá
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

/** Dev `d01` (`multi_verb`): `chainOrSingle` ji pošle do řetězu (T8). */
const SENTENCE = 'a penguin mail carrier slides down icy hills dodging snowballs, then tosses letters into chimneys';

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
    if (info.project.name === 'pixel7-touch') await stage.tap({ force: true });
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
    const phone = info.project.name === 'pixel7-touch';
    const a = await browser.newContext(person(phone ? 72 : 71));
    const page = await a.newPage();
    // Čerstvě spuštěný `next start` staví stránku hry při prvním požadavku líně (měřeno 1581 ms proti 1,1 s
    // v druhém běhu); 1,5 s platí pro řetěz, ne pro první požadavek serveru.
    expect((await request.get(url)).status()).toBe(200);
    await page.goto(url);
    await expect(page.locator('main[data-chain-round]')).toHaveAttribute('data-chain-round', '1', { timeout: 60_000 });

    const playable = await firstPlayable(page, info);
    info.annotations.push({ type: 'first-playable-ms', description: String(Math.round(playable)) });
    if (!phone) expect(playable).toBeLessThanOrEqual(FIRST_PLAYABLE_MS);

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
