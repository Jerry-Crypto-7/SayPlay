import { type CDPSession, devices, expect, test } from '@playwright/test';

import { BUTTON, type ArcadeWorld } from '../src/play/arcade/contract';
import { LANES, laneOfAxis } from '../src/play/arcade/pieces/lanes';
import { assemblyOfCell, liveCells } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';
import { HUD_COUNTER_LABELS } from './hud-labels';
import { type Capture, replayState } from './play-native-input';

/**
 * Obrana pruhů na telefonu (P54C T7, G4/G5/G8/G9): hra buňky `defense.default` (věta k žánru vede až po
 * klasifikátoru T13, proto hru publikuje spec buňky) se na Pixelu 7 dohraje jen prstem. Kam střelit a kde
 * držet, říká robot ověřovače přes sondu (`bot-hand.ts`): test ťukne prstem do pruhu, kam robot střílí,
 * a prst podrží v pruhu, kde robot staví obránce. Hodiny jsou ruční. Výhra pošle výzvu (Dare), server ji
 * přehraje a odkaz s ní otevře hru s cílem kamaráda; záznam prstu přehraný v Node dá týž hash jako Chromium.
 */

const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];

interface Wants {
  readonly buttons: number;
  readonly axis: number;
}
interface HandProbe {
  byHand(on: boolean): void;
  botWants(): Wants | null;
  tickByHand(): { readonly runState: string; readonly tick: number; readonly score: number; readonly items: number; readonly health: number };
  inputs(): readonly unknown[];
  capture(): Capture;
  idleRun(): { readonly runState: string; readonly tick: number };
}

const cell = liveCells().find((candidate) => candidate.id === 'defense.default');
if (cell === undefined) throw new Error('defense.default is not a live cell');
const SPEC = compileRecipe(assemblyOfCell(cell));
const NEED = (SPEC.controlParams as { readonly tuning: { readonly enemies: number } }).tuning.enemies;
const CZECH = /[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u;

/** Každý „člověk“ z vlastní adresy: strop výzev je 1 za 10 s na volajícího (P36B T5r3). */
const person = (n: number) => ({ ...PIXEL_7, extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(90 + n)}` } });

/** Jeden prst na skle: ťuk = položit a zvednout, držení = položit a nechat; CDP dostane vždy celou sadu bodů. */
class Finger {
  private down: { readonly x: number; readonly y: number } | null = null;
  constructor(private readonly cdp: CDPSession) {}
  async tap(x: number, y: number): Promise<void> {
    await this.lift();
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  /** Prst leží v bodě; už leží jinde → zvednout a položit znovu (držení počítá od nuly). */
  async hold(x: number, y: number): Promise<void> {
    if (this.down?.x === x && this.down.y === y) return;
    await this.lift();
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
    this.down = { x, y };
  }
  async lift(): Promise<void> {
    if (this.down === null) return;
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    this.down = null;
  }
}

test.describe('lane defense on a phone (P54C T7)', () => {
  let url = '';
  let id = '';

  test.beforeAll(async ({ request }) => {
    const response = await request.post('/api/play/games', { data: { spec: SPEC } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    url = ((await response.json()) as { url: string }).url;
    id = url.split('/').at(-1)!;
  });

  test('won with a finger alone, the HUD counts the downed enemies, the record replays in Node and the Dare opens', async ({ browser, request }, info) => {
    test.setTimeout(420_000);
    const context = await browser.newContext(person(1));
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__playFrame?.().hero != null && window.__playShell !== undefined, undefined, { timeout: 90_000 });
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toHaveAttribute('data-control', 'lanes');
    await expect(stage).toHaveAttribute('data-lane-edges', /^[\d.]+(?:,[\d.]+){3}$/, { timeout: 30_000 });
    await expect(page.getByTestId('hud-counter-collected')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('hud-counter-collected')).toContainText(`0/${NEED}`);
    await expect(page.getByTestId('hud-counter-lives')).toHaveAttribute('data-count', '3');
    const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
    for (const label of shown) expect(HUD_COUNTER_LABELS).toContain(label);

    const box = (await stage.boundingBox())!;
    const edges = ((await stage.getAttribute('data-lane-edges')) ?? '').split(',').map(Number);
    const bounds = [0, ...edges, 1];
    const laneCenter = (lane: number): number => Math.round(box.x + box.width * (((bounds[lane] as number) + (bounds[lane + 1] as number)) / 2));
    expect(edges).toHaveLength(LANES.count - 1);
    // Pět pruhů se na výšku vejde do šíře plátna: krajní hranice nejsou u okraje ani za ním.
    expect(edges[0]).toBeGreaterThan(0.08);
    expect(edges.at(-1)).toBeLessThan(0.92);
    const fingerY = Math.round(box.y + box.height * 0.55);

    const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST', { timeout: 120_000 });
    const cdp = await context.newCDPSession(page);
    const finger = new Finger(cdp);
    let wants = await page.evaluate(() => {
      const shell = window.__playShell as unknown as HandProbe;
      shell.byHand(true);
      return shell.botWants();
    });
    let last = { runState: 'running', tick: 0, score: 0, items: 0, health: 3 };
    let drawn = false;
    let held = 0;
    // 6 000 tiků = 100 s, nad nejdelší hru.
    while (last.runState === 'running' && last.tick < 6000) {
      if (wants !== null && (wants.buttons & BUTTON.TAP) !== 0) {
        if (!drawn) {
          // Nepřítel, na kterého robot střílí, je ve scéně opravdu vidět.
          await page.waitForFunction(() => (window.__playFrame?.().items.chaser?.count ?? 0) > 0, undefined, { timeout: 10_000 });
          await page.screenshot({ path: info.outputPath('defense-phone-playing.png') });
          drawn = true;
        }
        await finger.tap(laneCenter(laneOfAxis(wants.axis)), fingerY);
      } else if (wants !== null && (wants.buttons & BUTTON.HOLD) !== 0) {
        await finger.hold(laneCenter(laneOfAxis(wants.axis)), fingerY);
        held += 1;
      } else await finger.lift();
      const next = await page.evaluate(() => {
        const shell = window.__playShell as unknown as HandProbe;
        const now = shell.tickByHand();
        return { now, wants: now.runState === 'running' ? shell.botWants() : null };
      });
      last = next.now;
      wants = next.wants;
    }
    await finger.lift();
    console.log(`defense: ${last.runState} at tick ${last.tick}, ${last.items} downed, score ${last.score}, ${last.health} lives, ${held} held ticks`);
    expect(drawn).toBe(true);
    expect(held, 'the finger placed guards by holding').toBeGreaterThanOrEqual(30);
    expect(last.runState).toBe('won');
    // Každý nepřítel buď padl, nebo prošel hradbou a vzal život.
    expect(last.items + (3 - last.health)).toBe(NEED);
    expect(last.health).toBeGreaterThanOrEqual(1);
    expect(last.tick / 60).toBeGreaterThanOrEqual(45);
    expect(last.tick / 60).toBeLessThanOrEqual(90);
    await expect(page.getByTestId('hud-counter-collected')).toHaveAttribute('data-count', String(last.items));

    // G4: záznam prstu z Chromia přehraný v Node skončí v témž stavu (hash celého stavu).
    const recorded = await page.evaluate(() => (window.__playShell as unknown as HandProbe).capture());
    expect(recorded.inputs.length).toBeGreaterThan(0);
    const world = ((await (await request.get(`/api/play/games/${id}`)).json()) as { arcade: ArcadeWorld }).arcade;
    await replayState(world, recorded);

    // G5 + G9: výsledek kitu, hvězdy proti paru, anglicky.
    await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
    expect(Number(await page.getByTestId('play-stars').getAttribute('data-stars'))).toBeGreaterThanOrEqual(1);
    expect(CZECH.test(await page.locator('body').innerText())).toBe(false);

    // G5: výzva – server běh přehrál a odkaz s ní otevře hru s cílem kamaráda.
    const response = await posted;
    expect([200, 201]).toContain(response.status());
    const dare = (await response.json()) as { dareId: string; score: number; ticks: number };
    expect({ score: dare.score, ticks: dare.ticks }).toEqual({ score: last.score, ticks: last.tick });
    await context.close();
    const friend = await browser.newContext(person(2));
    const other = await friend.newPage();
    await other.goto(`${url}?via=share&dare=${dare.dareId}`);
    await expect(other.getByTestId('play-dare-goal')).toContainText('Beat', { timeout: 60_000 });
    await friend.close();
  });

  // G8: na telefonu se 4× pomalejším CPU drží scéna strop sítí kočičí arény z `p35-perf.spec.ts` (200) a kreslí modely.
  test('the scene stays within the phone mesh budget of p35-perf', async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext(person(4));
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(url);
    await page.waitForFunction(() => window.__playRender !== undefined && window.__playRender().calls > 0, undefined, { timeout: 90_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
    let last = -1;
    let since = Date.now();
    const deadline = Date.now() + 20_000;
    let report = await page.evaluate(() => window.__playRender!());
    while (Date.now() < deadline && (report.meshes !== last || Date.now() - since < 1500)) {
      if (report.meshes !== last) {
        last = report.meshes;
        since = Date.now();
      }
      await page.waitForTimeout(250);
      report = await page.evaluate(() => window.__playRender!());
    }
    console.log(`defense: ${report.meshes} meshes, ${report.calls} calls, ${report.triangles} triangles`);
    expect(report.meshes).toBeLessThanOrEqual(200);
    expect(report.triangles, 'the hero model is drawn').toBeGreaterThan(1000);
    await context.close();
  });

  test('an idle player loses and downs nobody', async ({ browser }) => {
    const context = await browser.newContext(person(3));
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
    const end = await page.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun());
    expect(end.runState).toBe('lost');
    await expect(page.getByTestId('hud-counter-collected')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('play-postrun')).toContainText('So close.', { timeout: 30_000 });
    await context.close();
  });
});
