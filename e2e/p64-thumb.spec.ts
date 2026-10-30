import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, type Browser, devices, expect, test } from '@playwright/test';

import { P64_CELLS } from './p64-cells';

/**
 * Ovládání palce na výšku (P64 T7): na telefonu projektu (`pixel7-touch` 412 × 839, `iphone-touch` 393 × 659)
 * leží ovládání v dolní zóně palce. Měří se obdélníky DOM na tiku 30 hry hráče (ruční hodiny, zóny plošinovky
 * ještě svítí) na každé buňce `p64-cells.ts` a na dvou hrách navíc: sloupec tří kol (střelba doplňku, Dash, Shield
 * – vzor `play-abilities.spec.ts`) a míč z dílů s nápovědou (`ball-dribble-hint`). Zvlášť karta souboje ve feedu:
 * tlačítko vlevo od lišty `.play-pager-rail`.
 *
 * Na výšku:
 * - střed každého prvku (`.play-fire` = střelba, úder, použití, akce; štítky `.play-touch-zone`; kroužek
 *   `.play-stick`) ve spodních 45 % výšky;
 * - žádný překryv mezi prvky ani s horní lištou HUD a dolní řadou (`.play-hud-bottom`);
 * - každé tlačítko aspoň `--sp-size-touch-min`;
 * - kroužek joysticku vidět v klidu;
 * - nápověda míče pod horní lištou, ve spodních 45 %, nejvýš dva řádky, bez věty o klávesnici.
 *
 * Na šířku (týž telefon otočený) beze změny: kroužek v klidu skrytý, tlačítka 72 px, nápověda vlevo nahoře celá.
 * `P64_THUMB_SHOTS=<složka>` nafotí obě orientace.
 */

const SHOTS = process.env.P64_THUMB_SHOTS ?? '';
/** Dolní zóna palce: střed ve spodních 45 % výšky (jako `THUMB_FROM` auditu T1). */
const THUMB_FROM = 0.55;
const TICKS = 30;
const MAX_HINT_LINES = 2;
/** Kolo tlačítka na desktopu a na šířku (`.play-fire` v `play.css`). */
const LANDSCAPE_BUTTON_PX = 72;

const PHONES: Readonly<Record<string, { readonly device: string; readonly dir: string }>> = {
  'pixel7-touch': { device: 'Pixel 7', dir: 'pixel7' },
  'iphone-touch': { device: 'iPhone 15', dir: 'iphone15' },
};

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
interface Piece {
  readonly name: string;
  readonly rect: Rect;
  readonly shown: boolean;
}
interface Reading {
  readonly width: number;
  readonly height: number;
  readonly touchMin: number;
  readonly stage: Rect;
  readonly controls: readonly Piece[];
  readonly bars: readonly Piece[];
  readonly hint: { readonly rect: Rect; readonly lines: number; readonly text: string } | null;
}

/** Běží ve stránce. */
function readInPage(): Reading {
  const rectOf = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  const shownOf = (el: HTMLElement): boolean => {
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05 && r.width > 0 && r.height > 0;
  };
  const pieces = (selector: string): Piece[] =>
    [...document.querySelectorAll<HTMLElement>(selector)].map((el) => ({
      name: `${el.getAttribute('data-testid') ?? el.className.split(' ').find((c) => c.startsWith('play-')) ?? el.tagName} "${(el.textContent ?? '').trim().slice(0, 20)}"`,
      rect: rectOf(el),
      shown: shownOf(el),
    }));
  const hint = document.querySelector<HTMLElement>('[data-testid="ball-dribble-hint"]');
  const hintStyle = hint === null ? null : getComputedStyle(hint);
  const stage = document.querySelector('[data-testid="arcade-stage"]')!;
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    touchMin: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sp-size-touch-min')),
    stage: rectOf(stage),
    controls: pieces('[data-testid="arcade-stage"] > .play-fire, .play-touch-zone, .play-stick'),
    bars: pieces('.play-hud-progress, .play-hud-corner, .play-hud-goal, .play-hud-bottom, .play-pager-rail'),
    hint:
      hint === null || hintStyle === null
        ? null
        : {
            rect: rectOf(hint),
            lines: Math.round((hint.clientHeight - parseFloat(hintStyle.paddingTop) - parseFloat(hintStyle.paddingBottom)) / parseFloat(hintStyle.lineHeight)),
            text: hint.innerText,
          },
  };
}

const overlap = (a: Rect, b: Rect): boolean => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
const middleY = (r: Rect): number => (r.top + r.bottom) / 2;

let people = 0;

async function publish(request: APIRequestContext, data: Readonly<Record<string, unknown>>): Promise<string> {
  // Každá hra z vlastní adresy: strop `/api/play/*` počítá požadavky na adresu.
  const response = await request.post('/api/play/games', { data, headers: { 'x-forwarded-for': `198.51.100.${String(40 + (people += 1))}` } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

interface HandProbe {
  byHand(on: boolean): void;
  start(): void;
  tickByHand(): unknown;
  physicsReady?(): boolean;
}

async function read(browser: Browser, device: string, baseURL: string, url: string, shot: string | null): Promise<Reading> {
  const { defaultBrowserType: _browser, ...use } = devices[device]!;
  const context = await browser.newContext({ ...use, baseURL });
  try {
    const page = await context.newPage();
    await page.goto(url);
    await page.locator('canvas').first().waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => window.__playFrame?.().hero != null && typeof (window.__playShell as unknown as HandProbe | undefined)?.byHand === 'function', undefined, { timeout: 90_000 });
    await page.waitForFunction(() => (window.__playShell as unknown as HandProbe).physicsReady?.() ?? true, undefined, { timeout: 60_000 });
    const reading = await page.evaluate(
      async ({ ticks, sample }) => {
        const shell = window.__playShell as unknown as HandProbe;
        shell.byHand(true);
        shell.start();
        for (let tick = 0; tick < ticks; tick += 1) shell.tickByHand();
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        // eslint-disable-next-line no-new-func -- funkce čtení jde do stránky jako text
        return (new Function(`return (${sample})`)() as () => Reading)();
      },
      { ticks: TICKS, sample: readInPage.toString() },
    );
    if (shot !== null) await page.screenshot({ path: shot });
    return reading;
  } finally {
    await context.close();
  }
}

function expectPortrait(at: string, r: Reading): void {
  const shown = r.controls.filter((c) => c.shown);
  const bars = r.bars.filter((b) => b.shown);
  for (const c of shown) {
    expect.soft(middleY(c.rect), `${at}: ${c.name} centre in the bottom 45 % (${JSON.stringify(c.rect)})`).toBeGreaterThanOrEqual(THUMB_FROM * r.height);
    for (const bar of bars) expect.soft(overlap(c.rect, bar.rect), `${at}: ${c.name} over ${bar.name}`).toBe(false);
  }
  for (const [i, a] of shown.entries()) for (const b of shown.slice(i + 1)) expect.soft(overlap(a.rect, b.rect), `${at}: ${a.name} over ${b.name}`).toBe(false);
  for (const c of shown.filter((c) => c.name.startsWith('arcade-'))) {
    expect.soft(Math.min(c.rect.right - c.rect.left, c.rect.bottom - c.rect.top), `${at}: ${c.name} at least the touch minimum`).toBeGreaterThanOrEqual(r.touchMin);
    expect.soft(c.rect.right, `${at}: ${c.name} on the screen`).toBeLessThanOrEqual(r.width);
  }
  const stick = r.controls.find((c) => c.name.startsWith('touch-stick'));
  if (stick !== undefined) expect.soft(stick.shown, `${at}: joystick ring visible at rest`).toBe(true);
  if (r.hint !== null) {
    expect.soft(middleY(r.hint.rect), `${at}: ball hint in the bottom 45 %`).toBeGreaterThanOrEqual(THUMB_FROM * r.height);
    expect.soft(r.hint.lines, `${at}: ball hint lines`).toBeLessThanOrEqual(MAX_HINT_LINES);
    expect.soft(r.hint.text, `${at}: ball hint is the touch sentence only`).not.toContain('Keyboard');
    expect.soft(r.hint.text).toContain('Left side');
    for (const piece of [...bars, ...shown]) expect.soft(overlap(r.hint.rect, piece.rect), `${at}: ball hint over ${piece.name}`).toBe(false);
  }
}

function expectLandscape(at: string, r: Reading): void {
  const stick = r.controls.find((c) => c.name.startsWith('touch-stick'));
  if (stick !== undefined) expect.soft(stick.shown, `${at}: joystick ring hidden at rest`).toBe(false);
  for (const c of r.controls.filter((c) => c.shown && c.name.startsWith('arcade-'))) expect.soft(Math.round(c.rect.right - c.rect.left), `${at}: ${c.name} keeps its size`).toBe(LANDSCAPE_BUTTON_PX);
  if (r.hint !== null) {
    expect.soft(Math.round(r.hint.rect.top - r.stage.top), `${at}: ball hint stays top left`).toBe(12);
    expect.soft(r.hint.text, `${at}: ball hint keeps the keyboard sentence`).toContain('Keyboard');
  }
}

/** Tři kola ve sloupci (`play-abilities.spec.ts`, GUNNER): střelba doplňku, Dash a Shield. */
const COLUMN = (() => {
  const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__/runner.json'), 'utf8')) as Record<string, unknown>;
  return { ...base, title: 'a knight runs, shoots, dashes and blocks', addons: ['shoot'], abilities: ['dash', 'shield'] };
})();

/**
 * Míč z dílů (`assembly_control`) – jen ten má nápovědu `ball-dribble-hint`. Věta z `ball-composed.test.ts`, hru
 * z ní složí server (rychlá verze, jako domovská obrazovka): skládání míče potřebuje načtený Rapier.
 */
const BALL_SENTENCE = 'kick the ball into the net, a dog chases you';

const GAMES: readonly { readonly key: string; readonly data: Readonly<Record<string, unknown>> }[] = [
  ...P64_CELLS.map((cell) => ({ key: cell.key, data: { spec: cell.spec } })),
  { key: 'column: Fire, Dash, Shield', data: { spec: COLUMN } },
  { key: 'ball hint', data: { sentence: BALL_SENTENCE } },
];

test.describe('P64 thumb zone', () => {
  test.setTimeout(240_000);

  for (const game of GAMES) {
    test(`${game.key}: controls in the bottom thumb zone`, async ({ browser, request }, testInfo) => {
      const phone = PHONES[testInfo.project.name];
      test.skip(phone === undefined, 'phone projects only');
      const url = await publish(request, game.data);
      const baseURL = testInfo.project.use.baseURL!;
      const dir = SHOTS === '' ? null : join(SHOTS, phone!.dir);
      if (dir !== null) mkdirSync(dir, { recursive: true });
      const name = game.key.replace(/[^a-z0-9]+/gi, '-');
      const portrait = await read(browser, phone!.device, baseURL, url, dir === null ? null : join(dir, `${name}-portrait.png`));
      const landscape = await read(browser, `${phone!.device} landscape`, baseURL, url, dir === null ? null : join(dir, `${name}-landscape.png`));
      const shown = (r: Reading) => r.controls.filter((c) => c.shown).map((c) => `${c.name} [${[c.rect.left, c.rect.top, c.rect.right, c.rect.bottom].map(Math.round).join(',')}]`);
      console.log(`${phone!.device} ${game.key}: portrait ${String(portrait.width)}×${String(portrait.height)} ${JSON.stringify(shown(portrait))}${portrait.hint === null ? '' : ` hint ${String(portrait.hint.lines)} lines`}; landscape ${JSON.stringify(shown(landscape))}`);
      expectPortrait(`${phone!.device} portrait`, portrait);
      expectLandscape(`${phone!.device} landscape`, landscape);
      if (game.key === 'ball hint') expect(portrait.hint, 'the composed ball game shows the hint').not.toBeNull();
      if (game.key.startsWith('column')) expect(portrait.controls.filter((c) => c.shown && c.name.startsWith('arcade-'))).toHaveLength(3);
    });
  }

  // Feed (vestavěný pool): první karta souboje (`fight`, 4. karta) má tlačítko úderu – ve hře leží vlevo od lišty
  // feedu a nad dolní řadou, kroužek vlevo dole. Na stránce hry lišta není, proto zvlášť.
  test('feed: the thumb column stays left of the pager rail', async ({ page }, testInfo) => {
    test.skip(PHONES[testInfo.project.name] === undefined, 'phone projects only');
    await page.goto('/play');
    await page.getByTestId('feed-current').waitFor({ timeout: 60_000 });
    await page.evaluate(() => document.querySelector('[data-testid="feed-reel"]')?.scrollIntoView({ block: 'start' }));
    const stage = page.getByTestId('feed-current').getByTestId('arcade-stage');
    const shownId = () => page.evaluate(() => window.__playFeed?.().versionId ?? null);
    for (let card = 0; card < 8 && (await stage.getAttribute('data-control', { timeout: 60_000 })) !== 'fight'; card += 1) {
      const before = await shownId();
      await page.getByTestId('feed-next').tap();
      await expect.poll(shownId, { timeout: 60_000 }).not.toBe(before);
    }
    await expect(stage).toHaveAttribute('data-control', 'fight');
    // Karta dosedla v okně feedu (`expectSnapped` z `play-feed-phone.spec.ts`), jinak se měří uprostřed posunu.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const reel = document.querySelector('[data-testid="feed-reel"]');
          const active = reel?.querySelector('[data-active="true"]');
          if (reel == null || active == null) return Number.NaN;
          return Math.abs(active.getBoundingClientRect().top - reel.getBoundingClientRect().top - reel.clientTop);
        }),
      )
      .toBeLessThan(1);
    const box = (await stage.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 3, box.y + box.height / 2);
    await expect(stage.locator(':scope > .play-fire').first()).toBeVisible({ timeout: 30_000 });
    const r = await page.evaluate(() => {
      const rect = (el: Element | null): Rect | null => {
        if (el === null) return null;
        const b = el.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      };
      return {
        height: window.innerHeight,
        rail: rect(document.querySelector('.play-pager-rail')),
        row: rect(document.querySelector('[data-testid="feed-current"] .play-hud-bottom')),
        buttons: [...document.querySelectorAll('[data-testid="feed-current"] [data-testid="arcade-stage"] > .play-fire')].map((el) => rect(el)!),
      };
    });
    console.log(`${testInfo.project.name} feed fight card: ${JSON.stringify(r)}`);
    expect(r.rail, 'the feed rail').not.toBeNull();
    for (const button of r.buttons) {
      expect.soft(overlap(button, r.rail!), `button ${JSON.stringify(button)} over the rail`).toBe(false);
      if (r.row !== null) expect.soft(overlap(button, r.row), `button ${JSON.stringify(button)} over the bottom row`).toBe(false);
      expect.soft(middleY(button), 'button centre in the bottom 45 %').toBeGreaterThanOrEqual(THUMB_FROM * r.height);
      expect.soft(button.bottom, 'button on the screen').toBeLessThanOrEqual(Math.min(r.height, r.rail!.bottom));
    }
    expect(r.row, 'the bottom row of the card').not.toBeNull();
  });
});
