import { devices, expect, test, type Page } from '@playwright/test';

/**
 * Celý okruh výzvy (P37C T8): kamarád na počítači vyhraje a výzva odejde na
 * server; hráč na telefonu (jiná adresa) si běh přečte, zkušební scéna ducha
 * ho přehraje i po novém načtení stránky k týmž tiku a hashi, které server
 * spočítal při ověření, a pak sám hraje odkaz výzvy proti kamarádovu skóre.
 *
 * Server potřebuje `PLAY_LAB=1` (zkušební scény jsou jinak 404). Dort jako
 * v `p36-dare.spec.ts`: robot o 60 tiků později pořád vyhraje, takže hráč
 * na telefonu bez zpoždění vyhraje rychleji.
 */

const SENTENCE = 'Carry a fragile cake across a kitchen to a party table.';

interface HandProbe {
  readonly handPlay: (until: 'score' | 'end', lag?: number) => { readonly runState: string; readonly tick: number; readonly score: number };
}

interface GhostEnd {
  readonly tick: number;
  readonly outcome: string;
  readonly hash: string;
}

interface RoundTripWindow {
  readonly __playShell?: unknown;
  readonly __playGhost?: () => { readonly tick: number; readonly shown: boolean };
  readonly __ghostLab?: { trace(): Record<string, unknown>; finish(): GhostEnd | null };
}

/** Každý „člověk“ z vlastní adresy: strop výzev je 1 za 10 s na volajícího. */
const person = (n: number) => ({ extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(n)}` } });

/** Robot dohraje „rukou“: lidský běh, jen takový posílá výzvu. `lag` = stisky o tolik tiků později. */
async function winByHand(page: Page, lag = 0): Promise<{ readonly tick: number; readonly score: number }> {
  await page.waitForFunction(() => (window as RoundTripWindow).__playShell !== undefined, undefined, { timeout: 60_000 });
  const end = await page.evaluate((late) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    return ((window as RoundTripWindow).__playShell as HandProbe).handPlay('end', late);
  }, lag);
  expect(end.runState).toBe('won');
  await expect(page.getByTestId('play-postrun')).toBeVisible();
  return end;
}

test.describe('dare round trip, desktop → phone (P37C T8)', () => {
  test('the friend’s run replays to the verified hash after a reload, then the phone beats it', async ({ browser, request }) => {
    test.setTimeout(300_000);
    const published = await request.post('/api/play/games', { data: { sentence: SENTENCE }, headers: person(40).extraHTTPHeaders });
    expect(published.status(), await published.text()).toBeLessThan(300);
    const url = ((await published.json()) as { url: string }).url;
    const id = url.split('/').at(-1)!;

    // Kamarád na počítači.
    const desktop = await browser.newContext({ ...devices['Desktop Chrome'], ...person(41) });
    const pageA = await desktop.newPage();
    await pageA.goto(url);
    const posted = pageA.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST');
    const endA = await winByHand(pageA, 60);
    const response = await posted;
    // 201 nová výzva; 200, když tentýž robotí běh už výzvou je (druhý průchod nad týmž serverem).
    expect([200, 201]).toContain(response.status());
    const dare = (await response.json()) as { dareId: string; score: number; ticks: number };
    expect({ score: dare.score, ticks: dare.ticks }).toEqual({ score: endA.score, ticks: endA.tick });
    await desktop.close();

    // Hráč na telefonu: jiný prohlížeč, jiná adresa.
    const phone = await browser.newContext({ ...devices['Pixel 7'], ...person(42) });
    const pageB = await phone.newPage();
    const stored = await pageB.request.get(`/api/play/games/${id}/dare/${dare.dareId}`);
    expect(stored.status()).toBe(200);
    const record = (await stored.json()) as { score: number; ticks: number; hash: string; replay: unknown };
    expect({ score: record.score, ticks: record.ticks }).toEqual({ score: dare.score, ticks: dare.ticks });
    expect(record.replay).not.toBeNull();

    // Záznam přežije nové načtení: duch se po reloadu přehraje k témuž konci jako ověření na serveru.
    await pageB.goto(`/play/lab/ghost?game=${id}&dare=${dare.dareId}`);
    await expect(pageB.getByTestId('ghost-lab')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await pageB.reload();
    await expect(pageB.getByTestId('ghost-lab')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await pageB.waitForFunction(() => {
      const ghost = (window as RoundTripWindow).__playGhost?.();
      return ghost !== undefined && ghost.shown && ghost.tick > 30;
    });
    await expect(pageB.getByTestId('play-ghost-tag')).toHaveText('Friend');
    await pageB.waitForFunction(() => Object.keys((window as RoundTripWindow).__ghostLab?.trace() ?? {}).length > 150, undefined, { timeout: 60_000 });
    const end = await pageB.evaluate(() => (window as RoundTripWindow).__ghostLab!.finish());
    expect(end).toEqual({ tick: record.ticks, outcome: 'won', hash: record.hash });

    // A pak odkaz výzvy: cíl kamaráda na startu, rychlejší výhra → výsledek proti němu.
    await pageB.goto(`${url}?via=share&dare=${dare.dareId}`);
    await expect(pageB.getByTestId('play-dare-goal')).toContainText('Beat');
    const endB = await winByHand(pageB);
    expect(endB.tick).toBeLessThan(endA.tick);
    await expect(pageB.getByTestId('play-postrun')).toContainText('You beat it!');
    await expect(pageB.getByTestId('play-dare-result')).toHaveAttribute('data-beat', 'true');
    await phone.close();
  });
});
