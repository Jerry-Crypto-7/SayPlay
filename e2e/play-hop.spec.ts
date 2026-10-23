import { type CDPSession, devices, expect, test } from '@playwright/test';

import { type ArcadeWorld, BUTTON } from '../src/play/arcade/contract';
import { HOP } from '../src/play/arcade/pieces/hop-course';
import { assemblyOfCell, liveCells } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';
import { HUD_COUNTER_LABELS } from './hud-labels';
import { type Capture, replayState } from './play-native-input';

/**
 * Přeskákání silnice na telefonu (P54C T9, G4/G5/G8/G9): hra buňky `hop.default` (věty k žánru vede až T13b,
 * proto hru publikuje spec buňky) se na Pixelu 7 dohraje jen prstem. Kdy skočit, říká robot ověřovače přes sondu
 * (`bot-hand.ts`): test ťukne doprostřed plátna (skok vpřed), nebo táhne prstem do strany (skok o sloupec).
 * Hodiny jsou ruční. Výhra pošle výzvu (Dare), server ji přehraje a odkaz s ní otevře hru s cílem kamaráda;
 * záznam prstu přehraný v Node dá týž hash jako Chromium. Nečinného hráče vezme orel.
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
  capture(): Capture;
  idleRun(): { readonly runState: string; readonly tick: number };
}

const cell = liveCells().find((candidate) => candidate.id === 'hop.default');
if (cell === undefined) throw new Error('hop.default is not a live cell');
const SPEC = compileRecipe(assemblyOfCell(cell));
const NEED = (SPEC.controlParams as { readonly tuning: { readonly rows: number } }).tuning.rows;
const CZECH = /[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u;
/** Tah prstu do strany (px): víc než práh tahu `SWIPE_PX` v `hop-input.ts`. */
const SWIPE = 80;

/** Každý „člověk“ z vlastní adresy: strop výzev je 1 za 10 s na volajícího (P36B T5r3). */
const person = (n: number) => ({ ...PIXEL_7, extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(80 + n)}` } });

/** Jeden prst na skle: ťuk a tah, CDP dostane vždy celou sadu bodů. */
class Finger {
  constructor(private readonly cdp: CDPSession) {}
  async tap(x: number, y: number): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  async swipe(x: number, y: number, dx: number, dy: number): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x + dx / 2, y: y + dy / 2 }] });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x + dx, y: y + dy }] });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

test.describe('hop on a phone (P54C T9)', () => {
  let url = '';
  let id = '';

  test.beforeAll(async ({ request }) => {
    const response = await request.post('/api/play/games', { data: { spec: SPEC } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    url = ((await response.json()) as { url: string }).url;
    id = url.split('/').at(-1)!;
  });

  test('won with a finger alone, the HUD counts the rows, the record replays in Node and the Dare opens', async ({ browser, request }, info) => {
    test.setTimeout(420_000);
    const context = await browser.newContext(person(1));
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__playFrame?.().hero != null && window.__playShell !== undefined, undefined, { timeout: 90_000 });
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toHaveAttribute('data-control', 'hop');
    await expect(page.getByTestId('hud-counter-collected')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('hud-counter-collected')).toContainText(`0/${NEED}`);
    await expect(page.getByTestId('hud-counter-lives')).toHaveAttribute('data-count', String(HOP.lives));
    const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
    for (const label of shown) expect(HUD_COUNTER_LABELS).toContain(label);
    // Hra čeká na dotek, ale provoz, který první tik předjede, je vidět už teď.
    await expect.poll(async () => (await page.evaluate(() => window.__playFrame!())).items.obstacle?.count ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath('hop-phone-start.png') });

    const box = (await stage.boundingBox())!;
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height * 0.55);
    const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST', { timeout: 120_000 });
    const cdp = await context.newCDPSession(page);
    const finger = new Finger(cdp);
    let wants = await page.evaluate(() => {
      const shell = window.__playShell as unknown as HandProbe;
      shell.byHand(true);
      return shell.botWants();
    });
    let last: ReturnType<HandProbe['tickByHand']> = { runState: 'running', tick: 0, score: 0, items: 0, health: HOP.lives };
    let gestures = 0;
    // 6 000 tiků = 100 s, nad nejdelší hru.
    while (last.runState === 'running' && last.tick < 6000) {
      const buttons = wants?.buttons ?? 0;
      if ((buttons & BUTTON.TAP) !== 0) await finger.tap(x, y);
      else if ((buttons & BUTTON.LEFT) !== 0) await finger.swipe(x, y, -SWIPE, 0);
      else if ((buttons & BUTTON.RIGHT) !== 0) await finger.swipe(x, y, SWIPE, 0);
      else if ((buttons & BUTTON.DOWN) !== 0) await finger.swipe(x, y, 0, SWIPE);
      if (buttons !== 0) gestures += 1;
      const next = await page.evaluate(() => {
        const shell = window.__playShell as unknown as HandProbe;
        const now = shell.tickByHand();
        return { now, wants: now.runState === 'running' ? shell.botWants() : null };
      });
      last = next.now;
      wants = next.wants;
      if (last.tick === 900) await page.screenshot({ path: info.outputPath('hop-phone-playing.png') });
    }
    console.log(`hop: ${last.runState} at tick ${last.tick}, ${last.items} rows, score ${last.score}, ${last.health} lives, ${gestures} gestures`);
    expect(last.runState).toBe('won');
    expect(last.items).toBe(NEED);
    expect(last.tick / 60).toBeGreaterThanOrEqual(30);
    expect(last.tick / 60).toBeLessThanOrEqual(90);

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
    console.log(`hop: ${report.meshes} meshes, ${report.calls} calls, ${report.triangles} triangles`);
    expect(report.meshes).toBeLessThanOrEqual(200);
    expect(report.triangles, 'models of the hero and the traffic are drawn').toBeGreaterThan(1000);
    await context.close();
  });

  test('an idle player crosses no row and the eagle takes him', async ({ browser }) => {
    const context = await browser.newContext(person(3));
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
    const end = await page.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun());
    expect(end).toEqual({ runState: 'lost', tick: HOP.eagle });
    await expect(page.getByTestId('hud-counter-collected')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('hud-counter-lives')).toHaveAttribute('data-count', String(HOP.lives));
    // Prohra bez jediného bodu (P56A T9) říká „Try again!“, ne „So close.“.
    await expect(page.getByTestId('play-postrun')).toContainText('Try again!', { timeout: 30_000 });
    await context.close();
  });
});
