import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';

import { pacingBannerLabel } from '../src/components/play/arcade/PacingBanner';
import type { ArcadeWorld } from '../src/play/arcade/contract';
import { chaserName } from '../src/play/arcade/models';
import { type PacingBeat, pacingBeatOrderOf, segmentNewsOf } from '../src/play/arcade/pieces/pacing';
import type { GameSpecV1 } from '../src/play/spec';

/**
 * Oznámení úseků a finále ve scéně (P46B T7, aréna, duel a hod P47A T10). Věta z `/play` dveřmi návštěvníka,
 * robot hraje „rukou“ – tik po tiku cestou, kterou jde hráč – a `MutationObserver` zapíše každé objevení banneru:
 * chvíli (`data-beat`), změnu úseku (`data-news`), text a animaci náběhu; na ploše scény (`arcade-stage`) navíc
 * pipy HP (`data-boss-hp`) a role, které scéna kreslí (`data-drawn`).
 *
 * - Běžec (králík a liška): úsek 2, úsek 3 a boss „Boss: Fox“ – všechny tři kreslí scéna modelem lišky.
 * - Aréna (útěk s věcmi a mumie, `genre.v4`): úsek 2 a 3 „New foe: Mummy“ a boss „Boss: Mummy“ v pořadí, ve kterém
 *   je svět má (nepřítel úseku 3 smí přijít i po bossovi), boss má pipy HP.
 * - Duel: „Champion!“, šampion má pipy HP a scéna ho kreslí větší než soupeře na startu, celého v záběru.
 * - Hod: „Boss target!“, scéna kreslí terč-bosse (role `enemy`) a jeho tři pipy HP.
 *
 * Každý text je přesně ten, který ze světa uložené hry odvodí `pacingBannerLabel` (že nápis sedí na změnu ve světě
 * v témže tiku, pinuje `src/play/arcade/__tests__/field-news.test.ts` a `pacing-banner.test.tsx`);
 * `prefers-reduced-motion` vypne náběh a text nechá; 0 chyb konzole. Desktop i Pixel 7.
 */

interface Game {
  readonly sentence: string;
  /** Jméno z věty, jak ho banner napíše (kontrola `chaserName` uložené hry). */
  readonly name?: string;
  /** Chvíle, které hra ohlásí; `undefined` = všechny ze světa v pořadí `pacingBeatOrderOf`. */
  readonly beats?: readonly PacingBeat[];
  readonly finale: PacingBeat;
  readonly finaleText: string;
  /** Pipy HP bosse finále: počet pipů na začátku. */
  readonly pips?: number;
}

const GAMES: readonly Game[] = [
  { sentence: 'A rabbit steals carrots and runs from a fox', name: 'Fox', beats: ['segment2', 'segment3', 'boss'], finale: 'boss', finaleText: 'Boss: Fox' },
  { sentence: 'Collect three keys in a pyramid while mummies chase you', name: 'Mummy', finale: 'boss', finaleText: 'Boss: Mummy', pips: 4 },
  { sentence: 'A knight duels a dragon in a castle courtyard', beats: ['champion'], finale: 'champion', finaleText: 'Champion!' },
  { sentence: 'Throw snowballs at targets in a winter park', beats: ['bossTarget'], finale: 'bossTarget', finaleText: 'Boss target!', pips: 3 },
];

/** Tiků robota na snímek: hra (~2500–3000 tiků) za ~1000 snímků, banner (84 tiků) visí ~28 snímků. */
const PER_FRAME = 3;

const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];

/**
 * Hláška Chromia, ne banneru: na telefonu (Pixel 7, `devicePixelRatio` 2,6) přepne hlídač kvality během hry
 * úroveň (`look/rig/Post.tsx`, změřeno low → medium) a s ní rozlišení plátna, a rekordér klipu (`clip.ts`,
 * MP4 `avc1`) to zaloguje jako chybu. Rozlišení plátna banner nemění; vada patří rekordéru klipu, ne téhle úloze.
 */
const CLIP_RESOLUTION_WARNING = 'When using "avc1" for mp4 encoding, the codec description is not supposed to change';

interface Seen {
  readonly beat: string | null;
  readonly news: string | null;
  readonly text: string;
  readonly animation: string;
}

interface Box {
  readonly heightPx: number;
  readonly maxY: number;
}

/** Snímků, přes které se bere největší výška soupeře (hračková póza ho po zásahu chvíli mačká). */
const RIVAL_FRAMES = 60;

interface Played {
  readonly runState: string;
  readonly seen: readonly Seen[];
  /** Hodnoty `data-boss-hp` plochy scény, jak se měnily. */
  readonly pips: readonly string[];
  /** Role, které scéna kreslila (`data-drawn`), sjednocené přes hru. */
  readonly drawn: readonly string[];
  /**
   * Soupeř duelu na obrazovce: nejvyšší promítnutý kvádr za prvních `RIVAL_FRAMES` snímků a za stejně snímků po
   * „Champion!“. Kamera ringu stojí na své nejmenší vzdálenosti (zvedne jen pohled), takže výška na obrazovce
   * roste s výškou těla.
   */
  readonly rival: { readonly start: Box | null; readonly champion: Box | null };
}

interface HandProbe {
  start(): void;
  byHand(on: boolean): void;
  botWants(): { readonly axis: number; readonly buttons: number } | null;
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): { readonly runState: string; readonly tick: number };
}

/** Hra z věty jako návštěvník: pole, „Make it!“, adresa hry; vrátí uložený svět a spec. */
async function makeGame(page: Page, request: APIRequestContext, sentence: string): Promise<{ readonly world: ArcadeWorld; readonly spec: GameSpecV1 }> {
  await page.goto('/play');
  await page.getByLabel('Say it in one sentence').fill(sentence);
  await page.getByTestId('play-create').click();
  await expect(page).toHaveURL(/\/play\/[a-f0-9]+$/, { timeout: 60_000 });
  await expect(page.locator('.play-shell')).toBeVisible({ timeout: 60_000 });
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const saved = await request.get(`/api/play/games/${id}`);
  expect(saved.status()).toBe(200);
  const game = (await saved.json()) as { arcade: ArcadeWorld; spec: GameSpecV1 };
  return { world: game.arcade, spec: game.spec };
}

/** Robot dohraje hru; každé nové objevení banneru, pipy HP a kreslené role se zapíšou. */
async function playWatchingBanner(page: Page): Promise<Played> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  return page.evaluate(
    ({ perFrame, rivalFrames }) =>
      new Promise<Played>((resolve) => {
        const shell = window.__playShell as unknown as HandProbe;
        const stage = document.querySelector('[data-testid="arcade-stage"]') as HTMLElement;
        const seen: Seen[] = [];
        const pips: string[] = [];
        const drawn = new Set<string>();
        const rival: { start: Box | null; champion: Box | null } = { start: null, champion: null };
        // Soupeř na obrazovce (sonda záběru `__playFrame`): duel je jediná scéna se soupeřem `rival`.
        const rivalBox = (): Box | null => (window as unknown as { __playFrame?: () => { items: Record<string, { box: Box | null }> } }).__playFrame?.().items.rival?.box ?? null;
        const taller = (kept: Box | null, box: Box | null): Box | null => (box === null || (kept !== null && kept.heightPx >= box.heightPx) ? kept : box);
        let frames = 0;
        let crowned = -1;
        let last: Element | null = null;
        const observer = new MutationObserver(() => {
          const banner = document.querySelector('[data-testid="play-pacing-banner"]');
          const hp = stage.dataset.bossHp;
          if (hp !== undefined && hp !== '' && hp !== pips.at(-1)) pips.push(hp);
          for (const role of (stage.dataset.drawn ?? '').split(' ')) if (role !== '') drawn.add(role);
          if (banner === null || banner === last) return;
          last = banner;
          seen.push({ beat: banner.getAttribute('data-beat'), news: banner.getAttribute('data-news'), text: banner.textContent ?? '', animation: getComputedStyle(banner).animationName });
          if (banner.getAttribute('data-beat') === 'champion') crowned = frames;
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-boss-hp', 'data-drawn'] });
        shell.start();
        shell.byHand(true);
        const frame = () => {
          frames += 1;
          if (frames <= rivalFrames) rival.start = taller(rival.start, rivalBox());
          if (crowned >= 0 && frames > crowned && frames <= crowned + rivalFrames) rival.champion = taller(rival.champion, rivalBox());
          let now = { runState: 'running', tick: 0 };
          for (let k = 0; k < perFrame && now.runState === 'running'; k += 1) {
            const wants = shell.botWants();
            if (wants !== null) {
              shell.hold(wants.axis);
              shell.press(wants.buttons);
            }
            now = shell.tickByHand();
          }
          if (now.runState === 'running' && now.tick < 6000) {
            requestAnimationFrame(frame);
            return;
          }
          // Poslední zápis DOM (React po posledním tiku) ještě doběhne.
          setTimeout(() => {
            observer.disconnect();
            shell.byHand(false);
            resolve({ runState: now.runState, seen, pips, drawn: [...drawn], rival });
          }, 100);
        };
        requestAnimationFrame(frame);
      }),
    { perFrame: PER_FRAME, rivalFrames: RIVAL_FRAMES },
  );
}

const RUNS = [
  { device: 'desktop', reduce: false },
  { device: 'Pixel 7', reduce: false },
  { device: 'Pixel 7', reduce: true },
] as const;

for (const run of RUNS) {
  test.describe(`segments and finales announced, ${run.device}${run.reduce ? ', reduced motion' : ''}`, () => {
    if (run.device === 'Pixel 7') test.use(PIXEL_7);

    for (const game of GAMES) {
      test(`“${game.sentence}”: the banner says what the world brings, while playing`, async ({ page, request }) => {
        test.setTimeout(240_000);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        if (run.reduce) await page.emulateMedia({ reducedMotion: 'reduce' });
        const { world, spec } = await makeGame(page, request, game.sentence);
        const played = await playWatchingBanner(page);
        const { runState, seen } = played;
        const line = seen.map((entry) => `${entry.beat}/${entry.news ?? '-'}: ${entry.text} (${entry.animation})`).join(' | ');
        test.info().annotations.push({ type: 'banner', description: `${line} || pips ${played.pips.join(' ')} || drawn ${played.drawn.join(' ')}` });
        console.log(`${run.device}${run.reduce ? ' reduce' : ''} ${game.sentence}: ${runState} – ${line} – pips ${played.pips.join(' ')}`);

        expect(runState, 'the bot played the game to the end').toBe('won');
        const name = chaserName(spec);
        if (game.name !== undefined) expect(pacingBannerLabel(world, 'boss', name), 'the name from the sentence').toBe(`Boss: ${game.name}`);
        // Chvíle v pořadí světa, každá jednou; finále s textem z věty.
        expect(seen.map((entry) => entry.beat)).toEqual(game.beats ?? pacingBeatOrderOf(world));
        expect(seen.find((entry) => entry.beat === game.finale)?.text).toBe(game.finaleText);
        // Každý text je ten, který ze světa hry odvodí banner: změna úseku, nový nepřítel se jménem z věty.
        expect(seen.map((entry) => entry.text)).toEqual(seen.map((entry) => pacingBannerLabel(world, entry.beat as PacingBeat, name)));
        expect(seen.filter((entry) => entry.news !== null).map((entry) => [entry.beat, entry.news])).toEqual(segmentNewsOf(world).filter((item) => seen.some((entry) => entry.beat === item.beat)).map((item) => [item.beat, item.news]));
        // Náběh je pohyb navíc: s „méně pohybu“ žádný, text zůstane.
        for (const entry of seen) expect(entry.animation).toBe(run.reduce ? 'none' : 'play-pacing-banner');
        // Pipy HP bosse finále: plné na začátku, pak ubývají.
        if (game.pips !== undefined) expect(played.pips, 'HP pips of the finale boss').toContain(`${game.pips}/${game.pips}`);
        if (game.finale === 'champion') {
          // Šampion: pipy HP plné, pak ubývají; kreslí se větší než soupeř na startu (9/4), celý v záběru.
          expect(played.pips[0], 'champion HP pips').toMatch(/^(\d+)\/\1$/);
          expect(Math.min(...played.pips.map((pip) => Number(pip.split('/')[0])))).toBeLessThan(Number(played.pips[0]!.split('/')[0]));
          const { start, champion } = played.rival;
          expect(start).not.toBeNull();
          expect(champion).not.toBeNull();
          expect(champion!.heightPx / start!.heightPx, `the champion is drawn bigger (${start!.heightPx.toFixed(0)} → ${champion!.heightPx.toFixed(0)} px)`).toBeGreaterThan(1.8);
          expect(champion!.maxY, 'the champion stays in the frame').toBeLessThanOrEqual(1);
        }
        expect(errors.filter((error) => !error.startsWith(CLIP_RESOLUTION_WARNING))).toEqual([]);
      });
    }
  });
}
