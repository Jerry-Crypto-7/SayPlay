import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { devices, expect, type Page, test } from '@playwright/test';

import { ARCADE_HZ } from '../../../src/play/arcade/contract';

/**
 * P70A T4, AC 1: šest vět z věty do hry v prohlížeči (`next build` + `next start`, telefon 430 × 900 s dotykem).
 * Každá věta musí dát jednu hru – uložená hra bez `chain`, stránka bez `main[data-chain-round]`. Pak průchod
 * „začátečníka“: první klepnutí na scénu hru pustí, dál hraje to, co by stiskl vítězný robot (`botWants`, sonda
 * `__playShell`), jenže o 400 ms (24 tiků) později – hráč, který vidí, co má udělat, a reaguje pozdě. Stisky jdou
 * cestou klávesnice a dotyku (`press` / `hold` relace), čas běží ručními hodinami, aby výsledek nezávisel na rychlosti
 * stroje. Přežití ≥ 20 s se tu jen zapisuje (`browser.json`); verdikt i výjimky s důvodem píše `result.md`.
 */

const SENTENCES = [
  { id: 'rabbit-jump', text: 'help the rabbit jump' },
  { id: 'rabbit-feed', text: 'feed the rabbits' },
  { id: 'cat-boxes', text: 'a cat jumps over boxes and eats fish' },
  { id: 'flap', text: 'a little bird flaps between the pipes' },
  { id: 'rhythm', text: 'a cat drums to the beat of the song' },
  { id: 'runner', text: 'a fox runs through the forest and jumps over logs' },
] as const;

/** Zpoždění hráče: 400 ms při 60 Hz. */
const LAG_TICKS = Math.round(0.4 * ARCADE_HZ);
const SURVIVE_TICKS = 20 * ARCADE_HZ;
/** Horizont běhu jako `beginner.ts` (90 s). */
const HORIZON_TICKS = 90 * ARCADE_HZ;

const DIR = join(process.cwd(), 'evals', 'play', 'p70a');
const SHOTS = join(DIR, 'shots');

interface Wants {
  readonly buttons: number;
  readonly axis: number;
}
interface Now {
  readonly runState: string;
  readonly tick: number;
  readonly health: number;
}
interface HandProbe {
  byHand(on: boolean): void;
  botWants(): Wants | null;
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): Now;
}
interface Leg {
  readonly runState: string;
  readonly tick: number;
  readonly health: number;
  readonly firstLifeLostTick: number | null;
  /** Tik prvního ubraného života (pokles `health`); `null` = život neubyl ani při prohře. */
  readonly lifeLostTick: number | null;
}

export interface BrowserRow {
  readonly id: string;
  readonly text: string;
  readonly genre: string;
  readonly chain: boolean;
  readonly outcome: string;
  readonly endS: number;
  readonly firstLifeLostS: number | null;
  /** Čím prohrál: ubraný život před koncem (`lives`), nebo konec bez ubraného života – hodiny či cíl (`clock-or-goal`). */
  readonly lostOn: 'lives' | 'clock-or-goal' | null;
  readonly survived20: boolean;
  readonly shots: readonly string[];
}

const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];
test.use({ ...PIXEL_7, viewport: { width: 430, height: 900 } });

const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/**
 * Odehraje ručními hodinami do `to` tiků nebo do konce běhu. Fronta zpožděných přání žije ve stránce mezi voláními
 * (`__p70aLag`), takže druhý úsek běhu navazuje na první.
 */
const playUntil = (page: Page, to: number): Promise<Leg> =>
  page.evaluate(
    ({ until, lag }) => {
      const probe = window.__playShell as unknown as HandProbe;
      const store = window as unknown as { __p70aLag?: { queue: Wants[]; health: number | null; lost: number | null } };
      const memo = (store.__p70aLag ??= { queue: [], health: null, lost: null });
      for (;;) {
        memo.queue.push(probe.botWants() ?? { buttons: 0, axis: 0 });
        const late = memo.queue.length > lag ? memo.queue.shift()! : { buttons: 0, axis: 0 };
        probe.hold(late.axis);
        probe.press(late.buttons);
        const now = probe.tickByHand();
        if (memo.health !== null && now.health < memo.health && memo.lost === null) memo.lost = now.tick;
        memo.health = now.health;
        if (now.runState !== 'running' || now.tick >= until) {
          return { runState: now.runState, tick: now.tick, health: now.health, firstLifeLostTick: memo.lost ?? (now.runState === 'lost' ? now.tick : null), lifeLostTick: memo.lost };
        }
      }
    },
    { until: to, lag: LAG_TICKS },
  );

const rows: BrowserRow[] = [];

test.describe('P70A T4: one game per sentence, a late beginner in the browser', () => {
  test.setTimeout(180_000);

  SENTENCES.forEach((sentence, index) => {
    test(`${sentence.id}: "${sentence.text}" → one game, beginner 400 ms late`, async ({ page, request }) => {
      const created = await request.post('/api/play/games', { data: { sentence: sentence.text }, headers: { 'x-forwarded-for': `198.51.100.${String(110 + index)}` } });
      expect(created.status(), await created.text()).toBeLessThan(300);
      const { url } = (await created.json()) as { url: string };
      const id = url.split('/').at(-1)!;
      const stored = (await (await request.get(`/api/play/games/${id}`)).json()) as { chain?: unknown; spec?: { genre?: { id?: string } } };
      const genre = stored.spec?.genre?.id ?? 'unknown';
      const chain = stored.chain !== undefined;
      expect(chain, `${sentence.id}: one game, not a chain`).toBe(false);

      await page.goto(url);
      await page.locator('[data-testid="arcade-stage"] canvas').first().waitFor({ timeout: 60_000 });
      await expect(page.getByTestId('play-building')).toHaveCount(0, { timeout: 60_000 });
      await expect(page.locator('main[data-chain-round]'), `${sentence.id}: no chain round on the page`).toHaveCount(0);
      await page.waitForFunction(() => typeof (window.__playShell as unknown as HandProbe | undefined)?.byHand === 'function', undefined, { timeout: 60_000 });
      await page.evaluate(() => (window.__playShell as unknown as HandProbe).byHand(true));
      await expect(page.getByTestId('play-first-prompt')).toBeVisible({ timeout: 60_000 });

      mkdirSync(SHOTS, { recursive: true });
      const shot = async (name: string): Promise<string> => {
        const file = `${sentence.id}-${name}.jpg`;
        await frames(page);
        await page.screenshot({ path: join(SHOTS, file), type: 'jpeg', quality: 70 });
        return file;
      };
      const shots = [await shot('card')];

      // Skutečné klepnutí hru pustí (první dotyk); dál hraje zpožděný robot.
      await page.getByTestId('arcade-stage').tap({ force: true });
      let leg = await playUntil(page, SURVIVE_TICKS);
      shots.push(await shot(leg.runState === 'running' ? '20s' : 'end'));
      if (leg.runState === 'running') {
        leg = await playUntil(page, HORIZON_TICKS);
        shots.push(await shot('end'));
      }

      const lostAt = leg.runState === 'lost' ? leg.tick : null;
      const row: BrowserRow = {
        id: sentence.id,
        text: sentence.text,
        genre,
        chain,
        outcome: leg.runState,
        endS: Math.round((leg.tick / ARCADE_HZ) * 100) / 100,
        firstLifeLostS: leg.firstLifeLostTick === null ? null : Math.round((leg.firstLifeLostTick / ARCADE_HZ) * 100) / 100,
        lostOn: lostAt === null ? null : leg.lifeLostTick === null ? 'clock-or-goal' : 'lives',
        survived20: lostAt === null || lostAt >= SURVIVE_TICKS,
        shots,
      };
      rows.push(row);
      console.log(`p70a ${JSON.stringify(row)}`);
    });
  });

  test.afterAll(() => {
    if (rows.length === 0) return;
    const order = SENTENCES.map((sentence) => sentence.id as string);
    const sorted = [...rows].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const doc = { schema: 'p70a-browser.v1', measuredAt: new Date().toISOString(), viewport: '430x900 touch', lagMs: 400, surviveS: 20, horizonS: 90, rows: sorted };
    writeFileSync(join(DIR, 'browser.json'), `${JSON.stringify(doc, null, 1)}\n`);
  });
});
