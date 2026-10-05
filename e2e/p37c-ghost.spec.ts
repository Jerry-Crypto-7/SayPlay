import { expect, test, type Page } from '@playwright/test';

/**
 * Duch výzvy (P37C T3): hráč vyhraje „rukou“ a server uloží běh výzvy; dva
 * další prohlížeče (jiné adresy) otevřou zkušební scénu `/play/lab/ghost`
 * s touž výzvou. Duch se v obou hýbe vedle ukázky robota se štítkem
 * „Friend“, v každém tiku stojí na témž místě a dojede k týmž tiku a hashi,
 * které server spočítal při ověření výzvy.
 *
 * Server potřebuje `PLAY_LAB=1` (zkušební scény jsou jinak 404).
 */

const SENTENCE = 'endless runner with a lot of obstacles';

interface HandProbe {
  readonly handPlay: (until: 'score' | 'end', lag?: number) => { readonly runState: string; readonly tick: number; readonly score: number };
}

interface GhostProbe {
  readonly tick: number;
  readonly shown: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface GhostEnd {
  readonly tick: number;
  readonly outcome: string;
  readonly hash: string;
}

type Trace = Record<string, readonly [number, number, number]>;

interface LabWindow {
  readonly __playGhost?: () => GhostProbe;
  readonly __ghostLab?: { trace(): Trace; finish(): GhostEnd | null };
  readonly __playShell?: unknown;
}

/** Každý „člověk“ z vlastní adresy: strop výzev i čtení drží volajícího podle adresy. */
const person = (n: number) => ({ extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(n)}` } });

/** Robot dohraje „rukou“: lidský běh, jen takový posílá výzvu (vzor `p36-dare.spec.ts`). */
async function winByHand(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as LabWindow).__playShell !== undefined, undefined, { timeout: 60_000 });
  const end = await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    return ((window as LabWindow).__playShell as HandProbe).handPlay('end');
  });
  expect(end.runState).toBe('won');
}

const ghostOf = (page: Page): Promise<GhostProbe> => page.evaluate(() => (window as LabWindow).__playGhost!());

test.describe('ghost of a dare (P37C T3)', () => {
  test('two browsers race the same ghost the same way, to the end the server verified', async ({ browser, request }) => {
    test.setTimeout(240_000);
    const published = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
    expect(published.status(), await published.text()).toBeLessThan(300);
    const url = ((await published.json()) as { url: string }).url;
    const id = url.split('/').at(-1)!;

    const author = await browser.newContext(person(31));
    const play = await author.newPage();
    await play.goto(url);
    const posted = play.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST');
    await winByHand(play);
    const response = await posted;
    expect([200, 201]).toContain(response.status());
    const { dareId } = (await response.json()) as { dareId: string };
    await author.close();

    const stored = await request.get(`/api/play/games/${id}/dare/${dareId}`, { headers: person(32).extraHTTPHeaders });
    expect(stored.status()).toBe(200);
    const record = (await stored.json()) as { ticks: number; hash: string; replay: unknown };
    expect(record.replay).not.toBeNull();

    const runs: { trace: Trace; end: GhostEnd | null }[] = [];
    for (const n of [33, 34]) {
      const context = await browser.newContext(person(n));
      const lab = await context.newPage();
      await lab.goto(`/play/lab/ghost?game=${id}&dare=${dareId}`);
      await expect(lab.getByTestId('ghost-lab')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });

      // Duch je vidět, se štítkem, a jede s hráčem: o vteřinu později je dál po trati.
      await lab.waitForFunction(() => {
        const ghost = (window as LabWindow).__playGhost?.();
        return ghost !== undefined && ghost.shown && ghost.tick > 30;
      });
      await expect(lab.getByTestId('play-ghost-tag')).toHaveText('Friend');
      await expect(lab.getByTestId('play-ghost-tag')).toBeVisible();
      const first = await ghostOf(lab);
      await lab.waitForFunction((tick) => ((window as LabWindow).__playGhost?.().tick ?? 0) > tick + 60, first.tick);
      const later = await ghostOf(lab);
      expect(later.z).toBeGreaterThan(first.z);

      await lab.waitForFunction(() => Object.keys((window as LabWindow).__ghostLab?.trace() ?? {}).length > 150, undefined, { timeout: 60_000 });
      const trace = await lab.evaluate(() => (window as LabWindow).__ghostLab!.trace());
      const end = await lab.evaluate(() => (window as LabWindow).__ghostLab!.finish());
      runs.push({ trace, end });
      await context.close();
    }

    for (const run of runs) expect(run.end).toEqual({ tick: record.ticks, outcome: 'won', hash: record.hash });
    const [a, b] = runs as [(typeof runs)[number], (typeof runs)[number]];
    const common = Object.keys(a.trace).filter((tick) => tick in b.trace);
    expect(common.length).toBeGreaterThan(60);
    for (const tick of common) expect(b.trace[tick], `tick ${tick}`).toEqual(a.trace[tick]);
    // Shoda dvou stojících bodů by nic nedokazovala: duch po trati opravdu jede.
    const zs = common.map((tick) => a.trace[tick]![2]);
    expect(Math.max(...zs)).toBeGreaterThan(Math.min(...zs));
  });
});
