import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { parseSegments } from '../scripts/video-check.mjs';
import { closeAbout, openAbout } from './play-start';

/**
 * Surové klipy pro video (P44D T14): pro každou scénu z `docs/video-script.md`
 * jeden klip na desktopu a jeden na telefonu do `videos/raw/<scéna>-<profil>.webm`
 * (gitignorované). Jména scén se čtou ze scénáře; scéna bez natáčení tady test
 * shodí, ať se scénář a natáčení nerozejdou. Pod `@measure`, běžná sada ho přeskočí:
 *   E2E_PORT=3217 FALLBACK_SMOKE_URL=http://127.0.0.1:3217 npx playwright test e2e/demo-capture.spec.ts --grep @measure
 * Proti nasazenému demu `FALLBACK_SMOKE_URL=<demoUrl>`; jen tam má AI verze klíče.
 *
 * Hraje robot ověřovače „rukou“, jeden tik na snímek, takže na klipu je vidět
 * skutečné hraní ve skutečném čase. Stříhá člověk; klipy jsou delší než scéna.
 */

const SCENES = parseSegments(readFileSync(join(process.cwd(), 'docs', 'video-script.md'), 'utf-8')).map((segment) => segment.beat);
const OUT = join(process.cwd(), 'videos', 'raw');

const PROFILES = [
  { name: 'desktop', viewport: { width: 1920, height: 1080 }, mobile: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true },
] as const;
type Profile = (typeof PROFILES)[number];

/** Věty ze scénáře: hry, které QA P71 (5. 11.) označila „ok“; mimo kategorii `evals/play/p37a/dev-150.json` n19. */
const KNIGHT = 'a knight fights goblins in an arena';
const OFF_CATEGORY = 'a long queue at the pharmacy on a friday afternoon';
const MONTAGE = [
  'a fox runs through the city dodging cars',
  'cowboy duel at high noon, first to shoot wins',
  'a ninja slices flying watermelons',
  'a black hole swallows the cars in the city',
] as const;

interface HandProbe {
  start(): void;
  byHand(on: boolean): void;
  botWants(): { readonly axis: number; readonly buttons: number } | null;
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): { readonly runState: string };
  handPlay(until: 'end', lag?: number): { readonly runState: string };
}

/** Každý „člověk“ z vlastní adresy: strop `/api/play/*` je 50 požadavků za 10 s a výzva 1 za 10 s na adresu. */
let people = 0;
const nextAddress = () => `198.51.100.${String(120 + (people += 1))}`;

interface Take {
  readonly context: BrowserContext;
  readonly page: Page;
}

/** Okno jednoho člověka; `record` zapne nahrávání. Nabídku sdílení systému kamera nenatočí, odkaz proto jde do schránky („Link copied“). */
async function open(browser: Browser, profile: Profile, record = true): Promise<Take> {
  const context = await browser.newContext({
    viewport: profile.viewport,
    isMobile: profile.mobile,
    hasTouch: profile.mobile,
    ...(record ? { recordVideo: { dir: join(OUT, 'tmp'), size: profile.viewport } } : {}),
    extraHTTPHeaders: { 'x-forwarded-for': nextAddress() },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  });
  return { context, page: await context.newPage() };
}

/** Zavře okno a uloží klip pod jménem scény; klip menší než 100 kB je prázdné plátno. */
async function keep(take: Take, name: string): Promise<void> {
  const video = take.page.video()!;
  await take.context.close();
  const file = join(OUT, `${name}.webm`);
  await video.saveAs(file);
  await video.delete();
  expect(statSync(file).size, file).toBeGreaterThan(100_000);
}

/** Věta do pole na `/play` po písmenech, „Make it!“ a čekání na běžící hru. */
async function say(page: Page, sentence: string, delay = 45): Promise<string> {
  await page.goto('/play');
  const field = page.getByTestId('play-sentence');
  await field.click();
  await field.pressSequentially(sentence, { delay });
  await page.getByTestId('play-create').click();
  await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/, { timeout: 30_000 });
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  return page.url();
}

/** Robot hraje rukou ve skutečném čase, dokud běh neskončí nebo neuplyne `ms`; vrátí stav běhu. */
async function playFor(page: Page, ms: number): Promise<string> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  return page.evaluate(
    (limit) =>
      new Promise<string>((resolve) => {
        const shell = window.__playShell as unknown as HandProbe;
        shell.start();
        shell.byHand(true);
        const until = performance.now() + limit;
        const frame = () => {
          const wants = shell.botWants();
          if (wants !== null) {
            shell.hold(wants.axis);
            shell.press(wants.buttons);
          }
          const { runState } = shell.tickByHand();
          if (runState === 'running' && performance.now() < until) {
            requestAnimationFrame(frame);
            return;
          }
          shell.byHand(false);
          resolve(runState);
        };
        requestAnimationFrame(frame);
      }),
    ms,
  );
}

/**
 * Hraní na kameru nejvýš `visible` ms, zbytek běhu do výhry naráz. `slower` dohraje se
 * stisky o pár tiků později, ať ji kamarád může porazit; v souboji na načasování (rytíř
 * a hydra) pozdní stisk prohraje, proto se zpoždění zkracuje, dokud běh nevyhraje.
 */
async function win(page: Page, visible = 40_000, slower = false): Promise<void> {
  const state = await playFor(page, visible);
  if (state !== 'won') {
    const end = await page.evaluate(
      (lags) => {
        const shell = window.__playShell as unknown as HandProbe;
        let last = 'running';
        for (const lag of lags) {
          last = shell.handPlay('end', lag).runState;
          if (last === 'won') break;
        }
        return last;
      },
      slower ? [60, 30, 15, 8, 4, 2, 1, 0] : [0],
    );
    expect(end).toBe('won');
  }
  await expect(page.getByTestId('play-postrun')).toBeVisible();
}

/** Hráč A vyhraje pomaleji a pošle výzvu; vrátí odkaz výzvy, jak ho dostane kamarád. */
async function dare(page: Page): Promise<string> {
  const id = page.url().split('/').at(-1)!;
  const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST');
  await win(page, 6_000, true);
  const { dareId } = (await (await posted).json()) as { dareId: string };
  await page.waitForTimeout(1_500);
  await page.getByTestId('play-share').click();
  await expect(page.getByText('Link copied. Go dare someone.')).toBeVisible();
  await page.waitForTimeout(3_000);
  return `/play/${id}?via=share&dare=${dareId}`;
}

/** Kamarád otevře odkaz výzvy (cíl výzvy na kartě startu) a hraje proti duchovi do konce. */
async function friendPlays(friend: Take, link: string): Promise<void> {
  await friend.page.goto(link);
  await expect(friend.page.getByTestId('play-dare-goal')).toBeVisible({ timeout: 60_000 });
  await friend.page.waitForTimeout(2_000);
  await win(friend.page);
  await friend.page.waitForTimeout(3_000);
}

type Shoot = (browser: Browser, profile: Profile) => Promise<void>;

const SHOOT: Record<string, Shoot> = {
  'say-to-play': async (browser, profile) => {
    const take = await open(browser, profile);
    await say(take.page, KNIGHT);
    await playFor(take.page, 10_000);
    await keep(take, `say-to-play-${profile.name}`);
  },

  'ai-version': async (browser, profile) => {
    const take = await open(browser, profile);
    const quick = await say(take.page, KNIGHT, 20);
    await playFor(take.page, 6_000);
    // AI verze pracuje (`working`), dokud neskončí; bez klíčů skončí jinak než `ready`, nebo se proužek vůbec neukáže.
    const state = take.page.getByTestId('upgrade-state');
    let kind = 'none';
    await expect
      .poll(async () => (kind = (await state.count()) === 0 ? 'none' : ((await state.first().getAttribute('data-kind')) ?? 'none')), { timeout: 120_000 })
      .not.toBe('working');
    if (kind === 'ready') {
      await take.page.waitForTimeout(2_000);
      await take.page.getByTestId('upgrade-action').click();
      await expect(take.page).not.toHaveURL(quick, { timeout: 30_000 });
    } else {
      console.log('AI version unavailable – re-run after deploy');
      await take.page.reload();
    }
    await win(take.page);
    await take.page.waitForTimeout(3_000);
    await keep(take, `ai-version-${profile.name}`);
  },

  // Dva lidé: klip hráče, který výzvu posílá, a vedle něj `-friend` kamaráda na telefonu.
  'dare-friend': async (browser, profile) => {
    const take = await open(browser, profile);
    await say(take.page, KNIGHT, 20);
    const link = await dare(take.page);
    await keep(take, `dare-friend-${profile.name}`);
    const friend = await open(browser, profile);
    await friendPlays(friend, link);
    await keep(friend, `dare-friend-${profile.name}-friend`);
  },

  // Žebříček po výhře kamaráda přinese P44B; do té doby klip ukáže jen obrazovku po výhře.
  leaderboard: async (browser, profile) => {
    const host = await open(browser, profile, false);
    await say(host.page, KNIGHT, 0);
    const link = await dare(host.page);
    await host.context.close();

    const take = await open(browser, profile);
    await friendPlays(take, link);
    const board = take.page.getByText(/You're #\d+ of \d+/);
    if ((await board.count()) > 0) await board.first().scrollIntoViewIfNeeded();
    else console.log('Leaderboard not on this build – re-run after P44B is merged');
    await take.page.waitForTimeout(5_000);
    await keep(take, `leaderboard-${profile.name}`);
  },

  remix: async (browser, profile) => {
    const take = await open(browser, profile);
    const parent = await say(take.page, KNIGHT, 20);
    await win(take.page, 6_000);
    await take.page.waitForTimeout(1_500);
    await take.page.getByRole('button', { name: 'Remix it' }).click();
    await take.page.waitForTimeout(1_500);
    await take.page.getByTestId('play-chip-harder').click();
    await expect(take.page).not.toHaveURL(parent, { timeout: 30_000 });
    await openAbout(take.page);
    await expect(take.page.getByTestId('play-lineage')).toContainText('Remixed from');
    await take.page.waitForTimeout(3_000);
    await closeAbout(take.page);
    await playFor(take.page, 8_000);
    await keep(take, `remix-${profile.name}`);
  },

  'off-category': async (browser, profile) => {
    const take = await open(browser, profile);
    await say(take.page, OFF_CATEGORY);
    console.log(`off-category goal: ${(await take.page.getByTestId('play-goal').first().textContent()) ?? '?'}`);
    await playFor(take.page, 12_000);
    await keep(take, `off-category-${profile.name}`);
  },

  'more-sentences': async (browser, profile) => {
    const take = await open(browser, profile);
    for (const sentence of MONTAGE) {
      await say(take.page, sentence, 25);
      await playFor(take.page, 6_000);
    }
    await keep(take, `more-sentences-${profile.name}`);
  },

  // Titulek a adresu dodá střih; klip je klidná úvodní stránka pod nimi.
  close: async (browser, profile) => {
    const take = await open(browser, profile);
    await take.page.goto('/play');
    await expect(take.page.getByTestId('play-sentence')).toBeVisible();
    await take.page.waitForTimeout(6_000);
    await keep(take, `close-${profile.name}`);
  },
};

test.describe('demo clips for the video @measure', () => {
  test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

  test('every scene of the video script has a recording', () => {
    expect(SCENES.filter((scene) => SHOOT[scene] === undefined)).toEqual([]);
  });

  for (const profile of PROFILES) {
    for (const scene of SCENES) {
      test(`${profile.name} ${scene}`, async ({ browser }) => {
        test.setTimeout(300_000);
        await SHOOT[scene]!(browser, profile);
      });
    }
  }
});
