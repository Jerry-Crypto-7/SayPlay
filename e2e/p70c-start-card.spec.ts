import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';

import { ARCADE_HZ } from '../src/play/arcade/contract';
import { compileGenre, GENRE_MODULES, readGenreSpec } from '../src/play/genre/index';
import { HUD_COUNTER_LABELS } from './hud-labels';

/**
 * Karta před startem a cíl, který nezmizí (P70C T2, AC 4). Osm žánrů přes `POST /api/play/games`: šest složených
 * z věty registrem žánrů bez modelu (`draftFill` → `compileGenre`, cesta `p64-cells.ts` pro žánr bez buňky rámování –
 * buňky P58A mají tratě 60 m, robot je dojede za 6 s), minigolf a střelnice z očí z ručních speců P68:
 * - karta na tiku 0 má tři řádky – jak vyhrát (`goalLine`), jak prohrát (`loseLineOf`; všech osm žánrů prohrát jde,
 *   řádek tedy chybět nesmí), ovládání – a výzvu startu: na desktopu „Click or press Space“ / „Click to start“, na
 *   telefonu „Tap to start“;
 * - hra běží 10 s ručními hodinami (sonda `__playShell`, jako `p64-portrait-hud`): cíl je pak vidět
 *   (`data-shown=true`, nenulový obdélník) jako pilulka na jeden řádek (`data-compact=true`);
 * - telefon (dotyk, `pointer: coarse`) na 375 × 667 a 430 × 900: cíl nepřekrývá pilulku postupu, časovač, pauzu ani
 *   přepínač Quick/Full; přepínač má jen hra z věty, proto zvláštní test běžce z věty s podvrženou AI verzí.
 * Text karty a postupu cíle se vypisuje do logu (`p70c`), ať je vidět, co hráč čte.
 */

const GENRES = ['runner', 'flap', 'duel', 'rhythm', 'minigolf', 'railfps', 'arena', 'catch'] as const;
type Genre = (typeof GENRES)[number];

/** „V 10. sekundě“ hry: tolik tiků ručních hodin. */
const PLAY_TICKS = 10 * ARCADE_HZ;

/**
 * Jak hru udržet naživu 10 s. `bot` = robot ověřovače hraje za hráče (`botWants`), `idle` = hráč nic nedělá.
 * Žánr, ve kterém robot vyhraje dřív než za 10 s, hraje nečinně. Konce běhu naměřené 4. 11. (tik, 60 Hz),
 * robot / nečinný: runner výhra 3510 / prohra 757, flap 2375 / 38, duel 3242 / 286, rhythm 2123 / 458,
 * minigolf 280 / 5400, railfps 2476 / 1234, arena 2400 / 593, catch 1975 / 535.
 */
const KEEP_ALIVE: Readonly<Record<Genre, 'bot' | 'idle'>> = {
  runner: 'bot',
  flap: 'bot',
  duel: 'bot',
  rhythm: 'bot',
  // Robot jamku dohraje za 4,7 s; nečinného hráče prohra čeká až po 90 s.
  minigolf: 'idle',
  railfps: 'bot',
  arena: 'bot',
  catch: 'bot',
};

const PHONE_SIZES = [
  { width: 375, height: 667 },
  { width: 430, height: 900 },
] as const;

const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];

interface Wants {
  readonly buttons: number;
  readonly axis: number;
}
/** Arkádová sonda `__playShell` (`ArcadePlay.tsx`); globální typ je mřížkový. */
interface HandProbe {
  byHand(on: boolean): void;
  botWants(): Wants | null;
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): { readonly runState: string; readonly tick: number };
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Věty žánrů složených registrem; žánr určuje modul, věta jen obsazení a cíl. */
const SENTENCES: Readonly<Record<Exclude<Genre, 'minigolf' | 'railfps'>, string>> = {
  runner: 'a fox runs through the forest and jumps over logs',
  flap: 'a little bird flaps between the pipes',
  duel: 'A knight fights a three-headed hydra at the castle gates.',
  rhythm: 'a cat drums to the beat of the song',
  arena: 'Survive in an arena full of slimes.',
  catch: 'a frog catches falling flies and dodges the bombs',
};

/** Tělo `POST /api/play/games` hry žánru: minigolf nese i seed (`play-minigolf.spec.ts`), střelnice holý spec. */
function gameOf(genre: Genre): { readonly spec: unknown; readonly seed?: number } {
  if (genre === 'minigolf') {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), 'e2e/fixtures/p68-minigolf-spec.json'), 'utf8')) as { spec: unknown; seed: number };
    return { spec: fixture.spec, seed: fixture.seed };
  }
  if (genre === 'railfps') return { spec: JSON.parse(readFileSync(join(process.cwd(), 'e2e/fixtures/p68-railfps-spec.json'), 'utf8')) as unknown };
  // Věta bez místa nechá `setting` prázdné; prostředí doplní jako `p35-perf.spec.ts`.
  const fill = GENRE_MODULES[genre].draftFill(SENTENCES[genre], null) as { setting?: string };
  const read = readGenreSpec({ hero: 'fox', ...fill, setting: fill.setting ?? 'garden' });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return { spec: compileGenre(read.value) };
}

async function publish(request: APIRequestContext, data: unknown): Promise<{ url: string; upgrade?: string }> {
  const response = await request.post('/api/play/games', { data });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return (await response.json()) as { url: string; upgrade?: string };
}

const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** Hra načtená a na tiku 0 pod kartou; ruční hodiny zapnuté, ať 10 s hry nezávisí na rychlosti stroje. */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator('[data-testid="arcade-stage"] canvas').first().waitFor({ timeout: 60_000 });
  await expect(page.getByTestId('play-building')).toHaveCount(0, { timeout: 60_000 });
  await page.waitForFunction(() => typeof (window.__playShell as unknown as HandProbe | undefined)?.byHand === 'function', undefined, { timeout: 60_000 });
  await page.evaluate(() => (window.__playShell as unknown as HandProbe).byHand(true));
  await expect(page.getByTestId('play-first-prompt')).toBeVisible({ timeout: 60_000 });
}

interface Card {
  readonly goal: string;
  readonly lose: string;
  readonly action: string;
  readonly start: string;
}

/** Tři řádky karty v pořadí cíl → prohra → ovládání a výzva startu pod nimi. */
async function readCard(page: Page, at: string): Promise<Card> {
  const card = page.getByTestId('play-first-prompt');
  const lines = ['play-first-prompt-goal', 'play-first-prompt-lose', 'play-first-prompt-action', 'play-first-prompt-start'];
  for (const id of lines) await expect(card.getByTestId(id), `${at}: ${id}`).toHaveText(/\S/);
  const order = await card.evaluate((el, ids) => ids.map((id) => [...el.children].findIndex((child) => child.getAttribute('data-testid') === id)), lines);
  expect(order, `${at}: goal, lose, action, start in this order`).toEqual([...order].sort((a, b) => a - b));
  const text = async (id: string): Promise<string> => ((await card.getByTestId(id).textContent()) ?? '').trim();
  return { goal: await text('play-first-prompt-goal'), lose: await text('play-first-prompt-lose'), action: await text('play-first-prompt-action'), start: await text('play-first-prompt-start') };
}

/** Hraje do `PLAY_TICKS` ručními hodinami; vrátí stav běhu na konci. */
async function playTenSeconds(page: Page, keep: 'bot' | 'idle'): Promise<{ runState: string; tick: number }> {
  const end = await page.evaluate(
    ({ to, bot }) => {
      const probe = window.__playShell as unknown as HandProbe;
      for (;;) {
        const wants = bot ? probe.botWants() : null;
        probe.hold(wants?.axis ?? 0);
        probe.press(wants?.buttons ?? 0);
        const now = probe.tickByHand();
        if (now.runState !== 'running' || now.tick >= to) return { runState: now.runState, tick: now.tick };
      }
    },
    { to: PLAY_TICKS, bot: keep === 'bot' },
  );
  await frames(page);
  return end;
}

/** Cíl v 10. sekundě: vidět, nenulový obdélník, sbalený na jeden řádek; vrátí jeho obdélník a text postupu. */
async function checkGoalKept(page: Page, at: string): Promise<{ box: Rect; progress: string | null; text: string }> {
  await expect(page.getByTestId('play-first-prompt'), `${at}: the card is gone once the game runs`).toHaveCount(0);
  const goal = page.getByTestId('play-goal');
  await expect(goal, `${at}: goal shown`).toHaveAttribute('data-shown', 'true');
  await expect(goal, `${at}: goal compact`).toHaveAttribute('data-compact', 'true');
  await expect(goal, `${at}: goal visible`).toBeVisible();
  const box = await goal.boundingBox();
  expect(box, `${at}: goal box`).not.toBeNull();
  expect(box!.width > 0 && box!.height > 0, `${at}: goal box ${JSON.stringify(box)}`).toBe(true);
  const chip = goal.getByTestId('play-goal-progress');
  const progress = (await chip.count()) === 0 ? null : ((await chip.textContent()) ?? '').trim();
  // Slova postupu („88 m / 598 m“, „7 hits“) jsou popisky HUD: anglicky a z uzavřeného seznamu (`interface-language`).
  for (const word of (progress ?? '').split(/[^\p{L}]+/u).filter((entry) => entry !== '')) expect(HUD_COUNTER_LABELS, `${at}: "${word}" in "${progress ?? ''}"`).toContain(word);
  return { box: box!, progress, text: ((await goal.textContent()) ?? '').trim() };
}

const intersect = (a: Rect, b: Rect): number => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** Cíl proti kusům HUD, které na výšku stojí kolem něj; kus, který hra nemá nebo je skrytý, se přeskočí. */
async function checkNoOverlap(page: Page, at: string): Promise<void> {
  const goal = (await page.getByTestId('play-goal').boundingBox())!;
  const pieces = [
    ['progress pill', page.getByTestId('play-progress-pill')],
    ['timer', page.getByTestId('play-timer')],
    ['pause', page.getByTestId('play-pause')],
    ['Quick/Full switch', page.locator('.play-version-switch')],
  ] as const;
  for (const [name, locator] of pieces) {
    if ((await locator.count()) === 0 || !(await locator.first().isVisible())) continue;
    const box = (await locator.first().boundingBox())!;
    expect.soft(intersect(goal, box), `${at}: goal ${JSON.stringify(goal)} over the ${name} ${JSON.stringify(box)}`).toBe(0);
  }
}

test.describe('P70C start card on desktop', () => {
  test.setTimeout(180_000);

  for (const genre of GENRES) {
    test(`${genre}: the card says how to win, how to lose and the controls, then Click; the goal stays at 10 s`, async ({ page, request }) => {
      await open(page, (await publish(request, gameOf(genre))).url);
      const card = await readCard(page, genre);
      console.log(`p70c ${genre} desktop card: goal "${card.goal}" · lose "${card.lose}" · action "${card.action}" · start "${card.start}"`);
      expect(card.start, `${genre}: desktop start line`).toMatch(/^Click (?:or press Space|to start)$/);

      const end = await playTenSeconds(page, KEEP_ALIVE[genre]);
      expect(end, `${genre}: the run still going at 10 s (${KEEP_ALIVE[genre]})`).toEqual({ runState: 'running', tick: PLAY_TICKS });
      const kept = await checkGoalKept(page, genre);
      console.log(`p70c ${genre} desktop 10 s: progress ${kept.progress === null ? '–' : `"${kept.progress}"`} · goal "${kept.text}"`);
    });
  }
});

test.describe('P70C start card on a phone', () => {
  test.use(PIXEL_7);
  test.setTimeout(180_000);

  for (const genre of GENRES) {
    test(`${genre}: Tap to start, and at 10 s the goal chip clears the pill, timer and pause at 375×667 and 430×900`, async ({ page, request }) => {
      await page.setViewportSize(PHONE_SIZES[0]);
      await open(page, (await publish(request, gameOf(genre))).url);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'coarse pointer').toBe(true);
      const card = await readCard(page, genre);
      console.log(`p70c ${genre} phone card: goal "${card.goal}" · lose "${card.lose}" · action "${card.action}" · start "${card.start}"`);
      expect(card.start, `${genre}: phone start line`).toBe('Tap to start');

      const end = await playTenSeconds(page, KEEP_ALIVE[genre]);
      expect(end, `${genre}: the run still going at 10 s (${KEEP_ALIVE[genre]})`).toEqual({ runState: 'running', tick: PLAY_TICKS });
      for (const size of PHONE_SIZES) {
        await page.setViewportSize(size);
        await frames(page);
        const at = `${genre} ${String(size.width)}×${String(size.height)}`;
        const kept = await checkGoalKept(page, at);
        console.log(`p70c ${at} 10 s: progress ${kept.progress === null ? '–' : `"${kept.progress}"`} · goal box ${JSON.stringify(kept.box)}`);
        await checkNoOverlap(page, at);
      }
    });
  }

  /** Přepínač Quick/Full ukáže jen hra z věty s AI verzí v běhu; server odpovídá podvrhem (jako `p64-portrait-hud`). */
  test('runner from a sentence: at 10 s the goal chip clears the Quick/Full switch at 375×667 and 430×900', async ({ page, request }) => {
    const draft = await publish(request, { sentence: 'endless runner with a lot of obstacles' });
    expect(draft.upgrade, 'the sentence game has an AI version on the way').toBeTruthy();
    await page.route(`**${draft.upgrade!}`, (route) => route.fulfill({ json: { status: 'pending', deadlineAt: new Date(Date.now() + 285_000).toISOString() } }));
    await page.setViewportSize(PHONE_SIZES[0]);
    await open(page, draft.url);
    await expect(page.getByTestId('upgrade-state')).toHaveAttribute('data-kind', 'working', { timeout: 15_000 });
    const end = await playTenSeconds(page, 'bot');
    expect(end).toEqual({ runState: 'running', tick: PLAY_TICKS });
    for (const size of PHONE_SIZES) {
      await page.setViewportSize(size);
      await frames(page);
      const at = `sentence runner ${String(size.width)}×${String(size.height)}`;
      await expect(page.locator('.play-version-switch'), `${at}: the switch is shown`).toBeVisible();
      await checkGoalKept(page, at);
      await checkNoOverlap(page, at);
    }
  });
});
