import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, type CDPSession, expect, type Page, test } from '@playwright/test';

import { UPGRADE_PICK_BUTTONS } from '../src/play/arcade/hooks/contract';
import { LEGIBLE_CAP, LEGIBLE_SHARE } from '../src/play/arcade/models';
import { DIRECTIONS, directionOfAxis } from '../src/play/arcade/pieces/arena';
import { HUD_COUNTER_LABELS } from './hud-labels';

/**
 * Přežití ve vlnách na telefonu i na desktopu (P66 T5). Hra z ručního specu `e2e/fixtures/p66-survivor-spec.json`
 * (rytíř proti zombiím v rozbitém městě, `genre.v6`; věty k žánru vede až T12):
 * - telefon (`pixel7-touch`): celou hru dohraje prst – tah od místa dotyku je směr joysticku arény, kam ho vede robot
 *   ověřovače (`bot-hand.ts`, `botWants`), karty vylepšení ťuk; konec kartou výhry;
 * - desktop (`chromium`): šipky hýbou hrdinou, karta klávesou 1–3, zbytek hry dohraje záznam robota cestou klávesnice
 *   (`handPlay`), konec kartou výsledku;
 * - obojí: hrdina čitelný (`LEGIBLE_SHARE.hero`), popisky počítadel z uzavřeného seznamu, žádná chyba stránky; nečinný
 *   hráč prohraje.
 * Snímky pro oko do `D:/caches/p66/survivor/` (`P66_SURVIVOR_SHOTS` cestu přepíše).
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p66-survivor-spec.json');
const SHOTS = process.env.P66_SURVIVOR_SHOTS ?? 'D:/caches/p66/survivor';
/** Tah prstu od místa dotyku (px): dost na plný směr, zaokrouhlení na pixely nepřehodí sousední z 32. */
const DRAG = 120;
const MOVE = 1;
const PICK_MASK = UPGRADE_PICK_BUTTONS.reduce((mask: number, button) => mask | button, 0);

interface Wants {
  readonly buttons: number;
  readonly axis: number;
}
interface Now {
  readonly runState: string;
  readonly tick: number;
  readonly score: number;
  readonly health: number;
}
/** Arkádová sonda `__playShell` (`ArcadePlay.tsx`); globální typ je mřížkový. */
interface ArcadeProbe {
  byHand(on: boolean): void;
  botWants(): Wants | null;
  tickByHand(): Now;
  handPlay(until: 'score' | 'end'): { readonly runState: string; readonly tick: number };
  idleRun(): { readonly runState: string; readonly tick: number };
  bodies(role: string): number;
}

async function publishFixture(request: APIRequestContext): Promise<string> {
  const spec = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/** Chyby stránky a konzole od otevření; 404 modelu by tu byla taky. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** Počet sítí se 1,5 s nezměnil = modely dotažené; pak změř hrdinu (podíl výšky plátna a měřítko čitelnosti). */
async function heroOnScreen(page: Page): Promise<{ readonly share: number; readonly legible: number }> {
  await page.waitForFunction(() => window.__playRender !== undefined && window.__playFrame?.().hero != null, undefined, { timeout: 90_000 });
  let last = -1;
  let since = Date.now();
  const deadline = Date.now() + 20_000;
  while (Date.now() - since < 1500 && Date.now() < deadline) {
    const meshes = await page.evaluate(() => window.__playRender!().meshes);
    if (meshes !== last) [last, since] = [meshes, Date.now()];
    await page.waitForTimeout(250);
  }
  return page.evaluate(() => {
    const frame = window.__playFrame!();
    return { share: (frame.hero!.maxY - frame.hero!.minY) / 2, legible: frame.legible.hero };
  });
}

/** Prsty na skle: CDP dostane vždy celou sadu bodů (vzor `play-push.spec.ts`). */
class Fingers {
  private readonly down = new Map<number, { x: number; y: number }>();
  constructor(private readonly cdp: CDPSession) {}
  has(id: number): boolean {
    return this.down.has(id);
  }
  private points() {
    return [...this.down].map(([id, at]) => ({ id, x: at.x, y: at.y }));
  }
  async press(id: number, x: number, y: number): Promise<void> {
    this.down.set(id, { x, y });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: this.points() });
  }
  async move(id: number, x: number, y: number): Promise<void> {
    const at = this.down.get(id);
    if (at === undefined || (at.x === x && at.y === y)) return;
    this.down.set(id, { x, y });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: this.points() });
  }
  async lift(id: number): Promise<void> {
    if (!this.down.delete(id)) return;
    const rest = this.points();
    await this.cdp.send('Input.dispatchTouchEvent', rest.length === 0 ? { type: 'touchEnd', touchPoints: [] } : { type: 'touchMove', touchPoints: rest });
  }
}

const frames = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
/** Hrdina na obrazovce: x promítnutého temene v NDC, jak ho scéna píše do `data-player-x`. */
const heroX = async (page: Page): Promise<number> => Number(await page.getByTestId('arcade-stage').getAttribute('data-player-x'));

test.describe('survivor (P66 T5)', () => {
  let url = '';

  test.beforeAll(async ({ request }) => {
    url = await publishFixture(request);
  });

  test('survivor: the game opens, plays to a win or a loss by touch and keys (P66 T5)', async ({ page }, info) => {
    test.setTimeout(600_000);
    const touch = info.project.name === 'pixel7-touch';
    mkdirSync(SHOTS, { recursive: true });
    const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}.png`) });
    const errors = watchErrors(page);

    await page.goto(url);
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toHaveAttribute('data-control', 'survivor', { timeout: 60_000 });
    await page.waitForFunction(() => window.__playShell !== undefined && window.__playHooks !== undefined, undefined, { timeout: 90_000 });

    // Hrdina z věty čitelný: aspoň 20 % výšky obrazu, nebo zvětšený na strop a pak aspoň 8 % × strop.
    const hero = await heroOnScreen(page);
    if (hero.legible < LEGIBLE_CAP) expect(hero.share, `hero ${JSON.stringify(hero)}`).toBeGreaterThanOrEqual(LEGIBLE_SHARE.hero);
    else expect(hero.share, `hero ${JSON.stringify(hero)}`).toBeGreaterThanOrEqual(0.08 * LEGIBLE_CAP);
    const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
    for (const label of shown) expect(HUD_COUNTER_LABELS).toContain(label);
    await expect(page.getByTestId('hud-counter-lives')).toHaveAttribute('data-count', '3');
    await shot('start');

    if (touch) {
      // Celá hra prstem: tah ve směru, který chce robot ověřovače; karta vylepšení ťukem.
      const box = (await stage.boundingBox())!;
      const [cx, cy] = [Math.round(box.x + box.width * 0.3), Math.round(box.y + box.height * 0.72)];
      const fingers = new Fingers(await page.context().newCDPSession(page));
      let wants = await page.evaluate(() => {
        const shell = window.__playShell as unknown as ArcadeProbe;
        shell.byHand(true);
        return shell.botWants();
      });
      let last: Now = { runState: 'running', tick: 0, score: 0, health: 3 };
      let held = 0;
      let taps = 0;
      const seen = new Set<string>();
      while (last.runState === 'running' && last.tick < 6000) {
        if (wants !== null && (wants.buttons & PICK_MASK) !== 0) {
          await fingers.lift(MOVE);
          held = 0;
          const card = UPGRADE_PICK_BUTTONS.findIndex((button) => (wants!.buttons & button) !== 0);
          const element = page.getByTestId(`upgrade-card-${String(card)}`);
          await expect(element).toBeVisible();
          const at = (await element.boundingBox())!;
          expect(at.y, 'card in the bottom 45 % of the screen').toBeGreaterThanOrEqual(page.viewportSize()!.height * 0.55);
          if (taps === 0) await shot('upgrade');
          await element.tap();
          taps += 1;
          await frames(page);
        } else if (wants !== null && wants.axis !== 0 && wants.axis !== held) {
          const dir = DIRECTIONS[directionOfAxis(wants.axis)]!;
          if (!fingers.has(MOVE)) await fingers.press(MOVE, cx, cy);
          await fingers.move(MOVE, Math.round(cx + (dir.dx * DRAG) / 1000), Math.round(cy - (dir.dz * DRAG) / 1000));
          held = wants.axis;
          await frames(page);
        } else if (wants !== null && wants.axis === 0 && held !== 0) {
          await fingers.lift(MOVE);
          held = 0;
          await frames(page);
        }
        // Dokud robot chce totéž, prst stojí a tiky běží v jednom volání.
        const next = await page.evaluate((hold) => {
          const shell = window.__playShell as unknown as ArcadeProbe;
          let now = shell.tickByHand();
          for (let k = 0; k < 40 && now.runState === 'running'; k += 1) {
            const w = shell.botWants();
            if (w === null || w.buttons !== 0 || w.axis !== hold) return { now, wants: w };
            now = shell.tickByHand();
          }
          return { now, wants: now.runState === 'running' ? shell.botWants() : null };
        }, held);
        last = next.now;
        wants = next.wants;
        const round = await page.evaluate(() => document.querySelector('[data-testid="hook-round-banner"]')?.textContent ?? null);
        if (round !== null && !seen.has(round)) {
          seen.add(round);
          if (round.startsWith('Round 2')) await shot('mid');
          if (/Round (\d) of \1/.test(round)) await shot('boss-round');
        }
      }
      await fingers.lift(MOVE);
      expect(taps, 'every upgrade offer got a tapped card').toBe(3);
      expect(last.runState, `ended at tick ${String(last.tick)} with ${String(last.health)} lives`).toBe('won');
    } else {
      // Šipka doprava pohne hrdinou doprava i na obrazovce (na šířku kamera do stran skoro nejede).
      await page.evaluate(() => (window.__playShell as unknown as { start(): void }).start());
      const before = await heroX(page);
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(700);
      await page.keyboard.up('ArrowRight');
      await expect.poll(() => heroX(page), { timeout: 5_000 }).toBeGreaterThan(before + 0.05);
      // Karta klávesou: nabídka z první přestávky, volba „3“ = karta 2.
      expect(await page.evaluate(() => window.__playHooks!.playUntil('upgrade_offer'))).not.toBeNull();
      await expect(page.getByTestId('upgrade-pick')).toBeVisible();
      await shot('upgrade');
      const picks = await page.evaluate(() => window.__playHooks!.seen().upgrade_pick ?? 0);
      await page.keyboard.press('3');
      await expect.poll(() => page.evaluate(() => window.__playHooks!.seen().upgrade_pick ?? 0)).toBeGreaterThan(picks);
      expect((await page.evaluate(() => window.__playHooks!.last('upgrade_pick'))) as { card: number }).toMatchObject({ card: 2 });
      expect(await page.evaluate(() => window.__playHooks!.playUntil('boss_enter'))).not.toBeNull();
      await page.waitForTimeout(400);
      await shot('boss-round');
      const end = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).handPlay('end'));
      expect(end.runState).toBe('won');
    }

    await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
    await expect(page.getByTestId('play-found')).toBeVisible();
    await shot('result');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('survivor: an idle player is overrun and loses', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
    const end = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).idleRun());
    expect(end.runState).toBe('lost');
    await expect(page.getByTestId('play-postrun')).toContainText('So close.', { timeout: 30_000 });
  });
});
