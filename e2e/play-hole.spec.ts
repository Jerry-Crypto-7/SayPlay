import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type CDPSession, expect, type Page, test } from '@playwright/test';

import type { ArcadeWorld } from '../src/play/arcade/contract';
import { LEGIBLE_SHARE } from '../src/play/arcade/models';
import { DIRECTIONS, directionOfAxis } from '../src/play/arcade/pieces/arena';
import { HOLE } from '../src/play/arcade/pieces/hole';
import { HUD_COUNTER_LABELS } from './hud-labels';
import { type Capture, replayState } from './play-native-input';

/**
 * Díra na telefonu i na desktopu (P66 T6): hra z ručního specu `e2e/fixtures/p66-hole-spec.json` („a black hole
 * swallows cars and people in a busy city“, `genre.v6`, bez klasifikátoru – narážky dopíše T12) se otevře, auta a lidé
 * z věty stojí ve městě, díra je čitelná (`LEGIBLE_SHARE.hero`) a hra se dohraje jen prstem (`pixel7-touch`) nebo jen
 * šipkami (`chromium`) – kam jet, říká robot ověřovače přes sondu (`bot-hand.ts`), tah a klávesy jsou skutečné vstupy.
 * Tři kola s bannerem, díra roste, výsledek s nálezy podle vzácnosti, záznam z prohlížeče přehraný v Node dá týž hash.
 * Nečinný hráč prohraje na hodinách prvního kola. Bez chyby v konzoli.
 *
 * Snímky pro oko do `D:/caches/p66/hole/` (`P66_HOLE_SHOTS` cestu přepíše): start, polovina hry, výsledek.
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p66-hole-spec.json');
const SHOTS = process.env.P66_HOLE_SHOTS ?? 'D:/caches/p66/hole';
const CZECH = /[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u;
/** Hláška rekordéru klipu na telefonu, ne díry: hlídač kvality přepne rozlišení plátna (viz `play-segments.spec.ts`). */
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
}
interface HandProbe {
  byHand(on: boolean): void;
  botWants(): Wants | null;
  tickByHand(): Tick;
  capture(): Capture;
  idleRun(): { readonly runState: string; readonly tick: number };
}

/** Prsty na skle: CDP dostane vždy celou sadu bodů (vzor `play-push.spec.ts`). */
class Finger {
  private at: { x: number; y: number } | null = null;
  constructor(private readonly cdp: CDPSession) {}
  get down(): boolean {
    return this.at !== null;
  }
  async press(x: number, y: number): Promise<void> {
    this.at = { x, y };
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
  }
  async move(x: number, y: number): Promise<void> {
    if (this.at === null || (this.at.x === x && this.at.y === y)) return;
    this.at = { x, y };
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x, y }] });
  }
  async lift(): Promise<void> {
    if (this.at === null) return;
    this.at = null;
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

/** Tah od místa dotyku (px): zaokrouhlení na celé pixely nepřehodí směr do sousedního z 32. */
const DRAG = 180;
/** Šipky: směr z 32 → kombinace šipek (osm směrů; robot hraje dál podle toho, kam díra opravdu jede). */
const LEAN = 383;
const ARROWS = { right: 'ArrowRight', left: 'ArrowLeft', up: 'ArrowUp', down: 'ArrowDown' } as const;
function arrowsOf(axis: number): ReadonlySet<string> {
  const direction = directionOfAxis(axis);
  if (direction < 0) return new Set();
  const { dx, dz } = DIRECTIONS[direction]!;
  const keys = new Set<string>();
  if (dx > LEAN) keys.add(ARROWS.right);
  if (dx < -LEAN) keys.add(ARROWS.left);
  if (dz > LEAN) keys.add(ARROWS.up);
  if (dz < -LEAN) keys.add(ARROWS.down);
  return keys;
}

const twoFrames = (page: Page): Promise<unknown> => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));

async function publish(page: Page): Promise<{ readonly url: string; readonly world: ArcadeWorld }> {
  const spec = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
  const response = await page.request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  const url = ((await response.json()) as { url: string }).url;
  const world = ((await (await page.request.get(`/api/play/games/${url.split('/').at(-1)!}`)).json()) as { arcade: ArcadeWorld }).arcade;
  return { url, world };
}

/** Počet sítí se 1,5 s nezměnil = modely dotažené. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__playRender !== undefined && window.__playFrame?.().hero != null, undefined, { timeout: 90_000 });
  let last = -1;
  let since = Date.now();
  const deadline = Date.now() + 20_000;
  while (Date.now() - since < 1500 && Date.now() < deadline) {
    const meshes = await page.evaluate(() => window.__playRender!().meshes);
    if (meshes !== last) [last, since] = [meshes, Date.now()];
    await page.waitForTimeout(250);
  }
}

test('hole: the city of the sentence, played to a win by touch or keys alone (P66 T6)', async ({ page }, info) => {
  test.setTimeout(420_000);
  const touch = info.project.name === 'pixel7-touch';
  mkdirSync(SHOTS, { recursive: true });
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}.png`) });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  const { url, world } = await publish(page);
  await page.goto(url);
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toHaveAttribute('data-control', 'hole', { timeout: 60_000 });
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playHooks !== undefined, undefined, { timeout: 90_000 });
  await settled(page);
  // Strop sítí telefonu z `p35-perf.spec.ts` (200): každá věc pole je jedna slitá síť.
  const render = await page.evaluate(() => window.__playRender!());
  console.log(`hole ${info.project.name}: ${String(render.meshes)} meshes, ${String(render.calls)} calls, ${String(render.triangles)} triangles`);
  expect(render.meshes).toBeLessThanOrEqual(200);

  await shot('start');
  // Věc věty ve městě: auta (`item1`) a lidé (`item2`) jsou vidět, největší věc (finále) taky.
  const frame = await page.evaluate(() => window.__playFrame!());
  console.log(`hole ${info.project.name}: ${String(frame.width)}×${String(frame.height)}, hole ${frame.hero?.widthPx.toFixed(0) ?? '?'}×${frame.hero?.heightPx.toFixed(0) ?? '?'} px, legible ${String(frame.legible.hero)}`);
  expect(frame.items.item1?.count ?? 0, 'cars of the sentence').toBeGreaterThan(0);
  expect(frame.items.item2?.count ?? 0, 'people of the sentence').toBeGreaterThan(0);
  expect(frame.items.finale?.count ?? 0, 'the biggest thing').toBe(1);
  // Díra je hrdina sondy a je čitelná bez zvětšení čitelností (průměr kreslí jádro, ne vizuální měřítko).
  const hero = frame.hero!;
  expect(hero.behind).toBe(false);
  expect((hero.maxY - hero.minY) / 2, 'hole share of the frame height').toBeGreaterThanOrEqual(LEGIBLE_SHARE.hero);
  expect(frame.legible.hero, 'the hole drawn at its kernel size').toBe(1);
  // Pilulka postupu: cíl kola v bodech, popisky z uzavřeného seznamu.
  const need = Number((world.rules.find((rule) => rule.id === 'finish_collected')?.params as { need: number }).need);
  await expect(page.getByTestId('hud-counter-collected')).toContainText(`0/${String(need)}`);
  const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
  for (const label of shown) expect(HUD_COUNTER_LABELS).toContain(label);

  // Hra jen prstem (telefon) nebo jen šipkami (desktop); kam, říká robot ověřovače.
  const box = (await stage.boundingBox())!;
  const [cx, cy] = [Math.round(box.x + box.width * 0.5), Math.round(box.y + box.height * 0.5)];
  const finger = touch ? new Finger(await page.context().newCDPSession(page)) : null;
  const held = new Set<string>();
  let wants = await page.evaluate(() => {
    const shell = window.__playShell as unknown as HandProbe;
    shell.byHand(true);
    return shell.botWants();
  });
  let last: Tick = { runState: 'running', tick: 0, score: 0, items: 0 };
  let tiers = new Set<string>();
  let midShot = false;
  let seen: Partial<Record<string, number>> = {};
  // 10 800 tiků = tři kola po 60 s, nad nejdelší hru robota.
  while (last.runState === 'running' && last.tick < 3 * HOLE.seconds.default * 60) {
    let changed = false;
    if (finger !== null) {
      if (wants !== null && wants.axis !== 0) {
        const dir = DIRECTIONS[directionOfAxis(wants.axis)]!;
        if (!finger.down) await finger.press(cx, cy);
        const before = `${String(dir.dx)}:${String(dir.dz)}`;
        await finger.move(Math.round(cx + (dir.dx * DRAG) / 1000), Math.round(cy - (dir.dz * DRAG) / 1000));
        changed = held.size !== 1 || !held.has(before);
        held.clear();
        held.add(before);
      } else if (finger.down) {
        await finger.lift();
        held.clear();
        changed = true;
      }
    } else {
      const keys = arrowsOf(wants?.axis ?? 0);
      for (const key of [...held]) {
        if (keys.has(key)) continue;
        await page.keyboard.up(key);
        held.delete(key);
        changed = true;
      }
      for (const key of keys) {
        if (held.has(key)) continue;
        await page.keyboard.down(key);
        held.add(key);
        changed = true;
      }
    }
    // Prohlížeč pohyb prstu doručí až se snímkem (sloučené pointermove): po změně gesta dva snímky, než tik padne.
    if (changed) await twoFrames(page);
    const next = await page.evaluate(() => {
      const shell = window.__playShell as unknown as HandProbe;
      const now = shell.tickByHand();
      const tier = document.querySelector<HTMLElement>('[data-testid="arcade-stage"]')?.dataset.holeTier ?? '';
      // Zprávy háčků do konce běhu: vrstva háčků s výsledkem zmizí.
      const hooks = now.runState === 'running' ? null : (window.__playHooks?.seen() ?? null);
      return { now, wants: now.runState === 'running' ? shell.botWants() : null, tier, hooks };
    });
    last = next.now;
    wants = next.wants;
    if (next.hooks !== null) seen = next.hooks;
    tiers = new Set([...tiers, next.tier]);
    if (!midShot && next.tier === '2') {
      midShot = true;
      await twoFrames(page);
      await page.waitForTimeout(400);
      await shot('mid');
    }
  }
  if (finger !== null) await finger.lift();
  for (const key of held) if (key.startsWith('Arrow')) await page.keyboard.up(key);
  console.log(`hole ${info.project.name}: ${last.runState} at tick ${String(last.tick)}, score ${String(last.score)}, tiers ${[...tiers].sort().join(',')}`);
  expect(last.runState).toBe('won');
  // Díra rostla po stupních až do největšího.
  expect([...tiers].sort()).toEqual(['0', '1', '2', '3', '4']);
  // Tři kola s bannerem a hodinami, polknuté věci se vzácností.
  expect(seen.round_start).toBe(3);
  expect(seen.round_clear).toBe(3);
  expect(seen.score_pop ?? 0).toBeGreaterThan(10);

  // Záznam z prohlížeče přehraný v Node skončí v témž stavu.
  const recorded = await page.evaluate(() => (window.__playShell as unknown as HandProbe).capture());
  expect(recorded.inputs.length).toBeGreaterThan(0);
  await replayState(world, recorded);

  // Výsledek: karta výhry kitu, nálezy podle vzácnosti, anglicky.
  await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
  await expect(page.getByTestId('play-found')).toContainText(/\d+ common \d+ rare \d+ epic/);
  expect(CZECH.test(await page.locator('body').innerText())).toBe(false);
  await shot('result');
  expect(errors.filter((error) => !error.startsWith(CLIP_RESOLUTION_WARNING))).toEqual([]);
});

test('hole: an idle player loses when the first round clock runs out (P66 T6)', async ({ page }) => {
  test.setTimeout(180_000);
  const { url, world } = await publish(page);
  // Hodiny kola už podělené horizontem ověření (`holeSeconds`), jak je svět nese.
  const seconds = Number((world.rules.find((rule) => rule.id === 'hole_round')?.params as { seconds: number }).seconds);
  await page.goto(url);
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
  await expect(page.getByTestId('hole-clock')).toHaveAttribute('data-left', String(seconds), { timeout: 60_000 });
  const end = await page.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun());
  expect(end.runState).toBe('lost');
  expect(end.tick).toBe(seconds * 60 + 1);
  await expect(page.getByTestId('play-postrun')).toContainText('Try again', { timeout: 30_000 });
  await expect(page.getByTestId('hud-counter-collected')).toHaveAttribute('data-count', '0');
});
