import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';

import type { FrameReport } from '../src/components/play/arcade/ArcadeStage';
import { arenaGenre } from '../src/play/genre/arena';
import { compileGenre, readGenreSpec } from '../src/play/genre/index';
import { questGenre } from '../src/play/genre/quest';

/**
 * Hračkový pohyb a `prefers-reduced-motion` v běžící hře (P45D T14). Šest her, po
 * jedné z rodin běžec, plošinovka, aréna, souboj, rytmus a úkol (id v README),
 * hraje robot „rukou“ – tik na snímek – a sonda `__playFrame().heroToy` čte, co
 * `applyToy` hrdinovi nastavil: předklon, úklon, měřítko, poskok a výpad vnitřní
 * skupiny, otočení dílů a deformaci (křídla, ocas, nohy – chůze většiny tříd je
 * jen v ní). Natočení po směru a poloha ve hře jsou hra, ne animace, a sonda je nečte.
 *
 * Bez emulace se póza aspoň u 5 ze 6 her během 30 snímků změní. Pod `reduce`
 * se u žádné nic nepřechází ani nehoupe: kit (`09-motion.md`) žádá okamžitou
 * pózu stavu bez tweenu a uživatel, který si pohyb vypnul, hru jen zavře –
 * nikdo jiný to neuvidí.
 * Profil Pixel 7 se 4× pomalejším CPU jako `p35-perf`.
 */

const SENTENCES = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p32/sentences.json'), 'utf8')) as { sentences: { id: string; text: string; hero: string }[] }).sentences;

/**
 * Fixture ovládání s hrdinou z katalogu modelů. Riggované postavy (pes, kočka, tučňák,
 * robot – `rigged*.json`) hrají chůzi klipem a hračka jim ji záměrně nezdvojí (T13).
 */
function fixtureSpec(fixture: string, hero: string): unknown {
  const spec = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', `${fixture}.json`), 'utf8')) as { roles: { kind: string; label: string }[] };
  return { ...spec, roles: spec.roles.map((role) => (role.kind === 'player' ? { ...role, label: hero } : role)) };
}

function arenaSpec(id: string, hero: string): unknown {
  const sentence = SENTENCES.find((entry) => entry.id === id)!;
  // Hrdina až za návrhem: `draftFill` vrací hrdinu věty a přepsal by ho.
  const read = readGenreSpec({ ...arenaGenre.draftFill(sentence.text, null), hero });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

/** Úkol jako `p32-quest`: prostředí, které rychlá verze ve větě nenajde, doplní les. */
function questSpec(id: string, hero: string): unknown {
  const sentence = SENTENCES.find((entry) => entry.id === id)!;
  const fill = questGenre.draftFill(sentence.text, null);
  const read = readGenreSpec({ ...fill, hero, setting: fill.setting ?? 'forest' });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

/**
 * `warmUp`: tolik tiků robot odehraje, než se začne číst – okno má padnout na chvíli,
 * kdy hra hrdinu hýbe: soupeř souboje poprvé zaútočí kolem tiku 110, první nota
 * rytmu dorazí k liště kolem tiku 220, hrdina úkolu chodí hned a pak stojí u stanoviště.
 */
const GAMES = [
  { id: 'runner-zombie', warmUp: 100, spec: () => fixtureSpec('runner', 'zombie') },
  { id: 'platform-fox', warmUp: 100, spec: () => fixtureSpec('platform', 'fox') },
  { id: 'arena-turtle', warmUp: 100, spec: () => arenaSpec('cat', 'turtle') },
  { id: 'duel-monkey', warmUp: 100, spec: () => fixtureSpec('duel', 'monkey') },
  { id: 'rhythm-bee', warmUp: 210, spec: () => fixtureSpec('rhythm', 'bee') },
  { id: 'quest-elephant', warmUp: 10, spec: () => questSpec('firefighter', 'elephant') },
] as const;

const FRAMES = 30;
/** Změna pod tuhle mez je zaokrouhlení, ne pohyb. */
const STILL = 1e-4;
/**
 * Pod `reduce` se stav ukáže okamžitou pózou (kit): přikrčení v souboji je výška těla
 * v jádře, jako poloha – skočí v jednom snímku a drží. Přechod nebo smyčka by pózu
 * měnily snímek za snímkem; vstup do stavu a výstup z něj jsou nejvýš dvě změny.
 */
const INSTANT_SWITCHES = 2;

type Toy = NonNullable<FrameReport['heroToy']>;

interface HandProbe {
  start(): void;
  byHand(on: boolean): void;
  botWants(): { readonly axis: number; readonly buttons: number } | null;
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): { readonly runState: string };
}

async function publishSpec(request: APIRequestContext, spec: unknown): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/** Robot hraje tik na snímek; po `warmUp` tikách se čte `FRAMES` snímků hračkové pózy hrdiny. */
async function heroToyFrames(page: Page, warmUp: number): Promise<(Toy | null)[]> {
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playFrame?.().hero != null, undefined, { timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  return page.evaluate(
    ([warmUp, frames]) =>
      new Promise<(Toy | null)[]>((resolve) => {
        const shell = window.__playShell as unknown as HandProbe;
        shell.start();
        shell.byHand(true);
        const seen: (Toy | null)[] = [];
        let tick = 0;
        const frame = () => {
          if (tick >= warmUp) seen.push(window.__playFrame!().heroToy);
          const wants = shell.botWants();
          if (wants !== null) {
            shell.hold(wants.axis);
            shell.press(wants.buttons);
          }
          const { runState } = shell.tickByHand();
          tick += 1;
          if (runState === 'running' && seen.length < frames) {
            requestAnimationFrame(frame);
            return;
          }
          shell.byHand(false);
          resolve(seen);
        };
        requestAnimationFrame(frame);
      }),
    [warmUp, FRAMES] as const,
  );
}

/** Ve kolika snímcích se některý kanál pózy změnil proti předchozímu. */
const changes = (frames: readonly Toy[]): number =>
  frames.slice(1).filter((frame, i) => (Object.keys(frame) as (keyof Toy)[]).some((key) => Math.abs(frame[key] - frames[i]![key]) > STILL)).length;

/** Největší rozptyl některého kanálu pózy přes snímky a jeho jméno. */
function spread(frames: readonly Toy[]): { readonly key: string; readonly change: number } {
  const keys = Object.keys(frames[0]!) as (keyof Toy)[];
  return keys
    .map((key) => ({ key, change: Math.max(...frames.map((f) => f[key])) - Math.min(...frames.map((f) => f[key])) }))
    .reduce((best, next) => (next.change > best.change ? next : best));
}

const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];

for (const mode of ['motion', 'reduce'] as const) {
  test.describe.serial(`toy motion ${mode}, Pixel 7 with CPU 4× slower`, () => {
    test.use(PIXEL_7);
    const moved: string[] = [];

    for (const game of GAMES) {
      test(`${game.id}: hero toy pose over ${FRAMES} frames`, async ({ page, request, context }) => {
        test.setTimeout(180_000);
        if (mode === 'reduce') await page.emulateMedia({ reducedMotion: 'reduce' });
        const url = await publishSpec(request, game.spec());
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await page.goto(url);
        const frames = await heroToyFrames(page, game.warmUp);
        const toys = frames.filter((frame): frame is Toy => frame !== null);
        expect(frames.length, 'robot hrál, dokud nebylo přečteno dost snímků').toBe(FRAMES);
        expect(toys.length, 'hrdina má hračkovou skupinu na každém snímku').toBe(FRAMES);
        const { key, change } = spread(toys);
        const switched = changes(toys);
        const line = `${game.id} ${mode}: největší rozptyl pózy ${change.toFixed(4)} (${key}), změna v ${switched} snímcích`;
        test.info().annotations.push({ type: 'toy', description: line });
        console.log(line);
        if (change > STILL) moved.push(game.id);
        if (mode === 'reduce') expect(switched, `pod reduced motion póza jen skočí do stavu, nic se nepřechází ani nehoupe (${key})`).toBeLessThanOrEqual(INSTANT_SWITCHES);
      });
    }

    if (mode === 'motion') {
      test(`at least ${GAMES.length - 1} of ${GAMES.length} heroes move their bodies`, () => {
        expect(moved.length, `hýbe se: ${moved.join(', ')}`).toBeGreaterThanOrEqual(GAMES.length - 1);
      });
    }
  });
}
