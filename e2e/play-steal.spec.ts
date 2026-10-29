import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type CDPSession, expect, type Page, test } from '@playwright/test';

import type { ArcadeWorld } from '../src/play/arcade/contract';
import { BUTTON } from '../src/play/arcade/contract';
import { UPGRADE_PICK_BUTTONS } from '../src/play/arcade/hooks/contract';
import { LEGIBLE_CAP, LEGIBLE_SHARE } from '../src/play/arcade/models';
import { DIRECTIONS, directionOfAxis } from '../src/play/arcade/pieces/arena';
import { HUD_COUNTER_LABELS } from './hud-labels';
import { type Capture, replayState } from './play-native-input';

/**
 * Krádež na telefonu i na desktopu (P66 T7): hra z ručního specu `genre.v6` (`e2e/fixtures/p66-steal-spec.json`,
 * kočka krade ryby a hlídají psi – věty k žánru vede až T12) se otevře, hrdina je čitelný (`LEGIBLE_SHARE.hero`,
 * po zvětšení na strop `LEGIBLE_CAP` aspoň 8 % × strop jako `play-hero-size`), a dá se dohrát:
 * - na `pixel7-touch` prstem – joystick arény (tah `DRAG` px ve směru, který chce robot) a klepnutí na kartu vylepšení;
 * - na `chromium` klávesnicí – šipky (8 směrů, robot si cestu přepočítá každý tik) a klávesy 1/2/3 na kartu.
 * Kam jít, říká robot ověřovače přes sondu (`bot-hand.ts`), hodiny jsou ruční. Hra skončí kartou výhry nebo prohry,
 * v konzoli žádná chyba a záznam z prohlížeče přehraný v Node dá týž hash. Snímky pro oko do `D:/caches/p66/steal/`
 * (`P66_STEAL_SHOTS` cestu přepíše): start, nesená kořist, výběr vylepšení, výsledek.
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p66-steal-spec.json');
const SHOTS = process.env.P66_STEAL_SHOTS ?? 'D:/caches/p66/steal';
const DRAG = 160;
const MOVE = 1;
/** Hrdina bez zvětšení na strop aspoň `LEGIBLE_SHARE.hero`, na stropu aspoň podlaha P36C (8 %) × strop. */
const CAPPED_HERO_SHARE = 0.08 * LEGIBLE_CAP;
/**
 * Hláška Chromia, ne krádeže (vzor `play-segments.spec.ts`): na telefonu hlídač kvality přepne úroveň a s ní rozlišení
 * plátna a rekordér klipu (`clip.ts`, MP4 `avc1`) to zaloguje jako chybu.
 */
const CLIP_RESOLUTION_WARNING = 'When using "avc1" for mp4 encoding, the codec description is not supposed to change';

interface Wants {
  readonly buttons: number;
  readonly axis: number;
}
interface Tick {
  readonly runState: string;
  readonly tick: number;
  readonly score: number;
  readonly items: number;
  readonly health: number;
}
interface HandProbe {
  byHand(on: boolean): void;
  botWants(): Wants | null;
  tickByHand(): Tick;
  capture(): Capture;
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

/** Šipky, které k směru osy drží klávesnice: složka nad sinem 22,5° = šipka té strany. */
function arrowsOf(axis: number): Set<string> {
  const keys = new Set<string>();
  if (axis === 0) return keys;
  const dir = DIRECTIONS[directionOfAxis(axis)]!;
  if (dir.dx > 383) keys.add('ArrowRight');
  if (dir.dx < -383) keys.add('ArrowLeft');
  if (dir.dz > 383) keys.add('ArrowUp');
  if (dir.dz < -383) keys.add('ArrowDown');
  return keys;
}

const twoFrames = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));

async function publish(page: Page): Promise<{ readonly url: string; readonly world: ArcadeWorld }> {
  const spec = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
  const response = await page.request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  const { url } = (await response.json()) as { url: string };
  const id = url.split('/').at(-1)!;
  const world = ((await (await page.request.get(`/api/play/games/${id}`)).json()) as { arcade: ArcadeWorld }).arcade;
  return { url, world };
}

test('steal: the game opens, plays to its result card by touch or keys, the record replays (P66 T7)', async ({ page }, info) => {
  test.setTimeout(480_000);
  const touch = info.project.name === 'pixel7-touch';
  mkdirSync(SHOTS, { recursive: true });
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}.png`) });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith(CLIP_RESOLUTION_WARNING)) errors.push(`console: ${message.text()}`);
  });

  const { url, world } = await publish(page);
  expect(world.control.id).toBe('steal');
  await page.goto(url);
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toBeVisible({ timeout: 90_000 });
  await expect(stage).toHaveAttribute('data-control', 'steal');
  await page.waitForFunction(() => window.__playFrame?.().hero != null && window.__playShell !== undefined && window.__playRender !== undefined, undefined, { timeout: 90_000 });

  // HUD: kořist kola 0/3, tři životy, jen popisky ze seznamu.
  await expect(page.getByTestId('hud-counter-collected')).toHaveAttribute('data-count', '0');
  await expect(page.getByTestId('hud-counter-collected')).toContainText('0/3');
  await expect(page.getByTestId('hud-counter-lives')).toHaveAttribute('data-count', '3');
  const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
  for (const label of shown) expect(HUD_COUNTER_LABELS).toContain(label);

  // Hrdina čitelný, až se modely dotáhnou (počet sítí se 1,5 s nezmění); domov ve spodní polovině obrazu.
  let meshes = -1;
  let since = Date.now();
  const deadline = Date.now() + 20_000;
  while (Date.now() - since < 1500 && Date.now() < deadline) {
    const now = await page.evaluate(() => window.__playRender!().meshes);
    if (now !== meshes) [meshes, since] = [now, Date.now()];
    await page.waitForTimeout(250);
  }
  const frame = await page.evaluate(() => {
    const report = window.__playFrame!();
    return { share: (report.hero!.maxY - report.hero!.minY) / 2, legible: report.legible.hero, behind: report.hero!.behind, home: report.items.home?.box ?? null, guards: report.items.guard?.count ?? 0 };
  });
  console.log(`steal ${info.project.name}: hero ${(frame.share * 100).toFixed(1)} % of the height at ${frame.legible.toFixed(2)}x`);
  expect(frame.behind).toBe(false);
  expect(frame.share).toBeGreaterThanOrEqual(frame.legible >= LEGIBLE_CAP ? CAPPED_HERO_SHARE : LEGIBLE_SHARE.hero);
  expect(frame.home, 'the home base is in the frame at the start').not.toBeNull();
  if (touch) expect(frame.home!.y, 'home sits in the lower half on a phone').toBeLessThan(0);
  await shot('start');

  // Hra rukou: robot řekne, co chce, prst nebo klávesy to zahrají, tik odtiká ruční hodiny.
  const box = (await stage.boundingBox())!;
  const [cx, cy] = [Math.round(box.x + box.width * 0.5), Math.round(box.y + box.height * 0.62)];
  const fingers = touch ? new Fingers(await page.context().newCDPSession(page)) : null;
  const held = new Set<string>();
  let wants = await page.evaluate(() => {
    const shell = window.__playShell as unknown as HandProbe;
    shell.byHand(true);
    return shell.botWants();
  });
  let last: Tick = { runState: 'running', tick: 0, score: 0, items: 0, health: 3 };
  let heldAxis = 0;
  let carriedShot = false;
  let picks = 0;
  while (last.runState === 'running' && last.tick < 6000) {
    let changed = false;
    const pick = wants === null ? -1 : UPGRADE_PICK_BUTTONS.findIndex((button) => (wants!.buttons & button) !== 0);
    if (pick >= 0) {
      // Výběr vylepšení: karta v zóně palce, na desktopu klávesa.
      const card = page.getByTestId(`upgrade-card-${String(pick)}`);
      await expect(card).toBeVisible();
      if (picks === 0) await shot('upgrade');
      if (touch) {
        await fingers!.lift(MOVE);
        await card.tap();
      } else {
        for (const key of held) await page.keyboard.up(key);
        held.clear();
        await page.keyboard.press(String(pick + 1));
      }
      picks += 1;
      heldAxis = 0;
      changed = true;
    } else if (wants !== null && (wants.buttons & BUTTON.TAP) !== 0) {
      throw new Error('the steal bot never taps');
    } else if (touch) {
      const axis = wants?.axis ?? 0;
      if (axis !== 0) {
        const dir = DIRECTIONS[directionOfAxis(axis)]!;
        if (!fingers!.has(MOVE)) await fingers!.press(MOVE, cx, cy);
        await fingers!.move(MOVE, Math.round(cx + (dir.dx * DRAG) / 1000), Math.round(cy - (dir.dz * DRAG) / 1000));
      } else await fingers!.lift(MOVE);
      changed = axis !== heldAxis;
      heldAxis = axis;
    } else {
      const want = arrowsOf(wants?.axis ?? 0);
      for (const key of [...held]) if (!want.has(key)) {
        await page.keyboard.up(key);
        held.delete(key);
        changed = true;
      }
      for (const key of want) if (!held.has(key)) {
        await page.keyboard.down(key);
        held.add(key);
        changed = true;
      }
    }
    // Prohlížeč pohyb prstu doručí se snímkem: po změně gesta dva snímky, než tik padne.
    if (changed) await twoFrames(page);
    const next = await page.evaluate(() => {
      const shell = window.__playShell as unknown as HandProbe;
      const now = shell.tickByHand();
      return { now, wants: now.runState === 'running' ? shell.botWants() : null };
    });
    last = next.now;
    wants = next.wants;
    if (!carriedShot && last.tick % 20 === 0 && (await page.getByTestId('steal-home').isVisible())) {
      carriedShot = true;
      await twoFrames(page);
      await shot('carrying');
    }
  }
  if (touch) await fingers!.lift(MOVE);
  for (const key of held) await page.keyboard.up(key);
  console.log(`steal ${info.project.name}: ${last.runState} at tick ${last.tick}, score ${last.score}, ${last.health} lives, ${picks} upgrade picks`);
  expect(['won', 'lost']).toContain(last.runState);
  expect(carriedShot, 'the Home tag showed while the hero carried loot').toBe(true);
  expect(picks, 'an upgrade pick between rounds').toBeGreaterThanOrEqual(1);

  // Záznam z prohlížeče přehraný v Node skončí v témž stavu.
  const recorded = await page.evaluate(() => (window.__playShell as unknown as HandProbe).capture());
  expect(recorded.inputs.length).toBeGreaterThan(0);
  await replayState(world, recorded);

  // Karta výsledku: výhra nebo prohra, anglicky podle kitu.
  await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('play-postrun')).toContainText(last.runState === 'won' ? 'You did it!' : 'So close.');
  await shot('result');
  expect(errors).toEqual([]);
});
