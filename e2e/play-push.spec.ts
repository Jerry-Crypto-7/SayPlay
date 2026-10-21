import { type CDPSession, devices, expect, test } from '@playwright/test';

import type { ArcadeWorld } from '../src/play/arcade/contract';
import { BUTTON } from '../src/play/arcade/contract';
import { DIRECTIONS, directionOfAxis } from '../src/play/arcade/pieces/arena';
import { PUSH } from '../src/play/arcade/pieces/push-ring';
import { assemblyOfCell, liveCells } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';
import { HUD_COUNTER_LABELS } from './hud-labels';
import { type Capture, replayState } from './play-native-input';

/**
 * Vytlačování z ringu na telefonu (P54C T12, G4/G5/G8/G9): hra buňky `push.default` (věty k žánru vede až T13b,
 * proto hru publikuje spec buňky) se na Pixelu 7 dohraje jen prstem. Kam jít a kdy vypadnout, říká robot ověřovače
 * přes sondu (`bot-hand.ts`): prst táhne joystick arény (tah `DRAG` px ve směru osy od místa dotyku) a výpad je ťuk
 * druhým prstem. Hodiny jsou ruční. Výhra pošle výzvu (Dare), server ji přehraje a odkaz s ní otevře hru s cílem
 * kamaráda; záznam prstu přehraný v Node dá týž hash jako Chromium (Rapier počítá v obou totéž). Nečinný hráč nikoho
 * nevystrčí a prohraje.
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

const cell = liveCells().find((candidate) => candidate.id === 'push.default');
if (cell === undefined) throw new Error('push.default is not a live cell');
const SPEC = compileRecipe(assemblyOfCell(cell));
const CZECH = /[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u;

/** Každý „člověk“ z vlastní adresy: strop výzev je 1 za 10 s na volajícího (P36B T5r3). */
const person = (n: number) => ({ ...PIXEL_7, extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(130 + n)}` } });

/** Prsty na skle: CDP dostane vždy celou sadu bodů (vzor `play-touch.spec.ts`). */
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
  async tap(id: number, x: number, y: number): Promise<void> {
    await this.press(id, x, y);
    await this.lift(id);
  }
}

const MOVE = 1;
const LUNGE = 2;
const DRAG = 180;

test.describe('push on a phone (P54C T12)', () => {
  let url = '';
  let id = '';

  test.beforeAll(async ({ request }) => {
    const response = await request.post('/api/play/games', { data: { spec: SPEC } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    url = ((await response.json()) as { url: string }).url;
    id = url.split('/').at(-1)!;
  });

  test('won with a finger alone, the HUD counts the pushed-out rivals, the record replays in Node and the Dare opens', async ({ browser, request }, info) => {
    test.setTimeout(480_000);
    const world = ((await (await request.get(`/api/play/games/${id}`)).json()) as { arcade: ArcadeWorld }).arcade;
    const need = Number((world.rules.find((rule) => rule.id === 'finish_collected')?.params as { need: number }).need);
    expect(need).toBe(PUSH.rivals.default);
    const context = await browser.newContext(person(1));
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__playFrame?.().hero != null && window.__playShell !== undefined, undefined, { timeout: 90_000 });
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toHaveAttribute('data-control', 'push');
    await expect(page.getByTestId('hud-counter-collected')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('hud-counter-collected')).toContainText(`0/${need}`);
    await expect(page.getByTestId('hud-counter-lives')).toHaveAttribute('data-count', String(PUSH.lives));
    const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
    for (const label of shown) expect(HUD_COUNTER_LABELS).toContain(label);
    // Ring, hrdina a soupeři prvního kola jsou ve scéně už před prvním dotekem.
    await expect.poll(async () => (await page.evaluate(() => window.__playFrame!())).items.rival?.count ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath('push-phone-start.png') });

    const box = (await stage.boundingBox())!;
    const [cx, cy] = [Math.round(box.x + box.width * 0.5), Math.round(box.y + box.height * 0.45)];
    const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST', { timeout: 120_000 });
    const cdp = await context.newCDPSession(page);
    const fingers = new Fingers(cdp);
    let wants = await page.evaluate(() => {
      const shell = window.__playShell as unknown as HandProbe;
      shell.byHand(true);
      return shell.botWants();
    });
    let last: ReturnType<HandProbe['tickByHand']> = { runState: 'running', tick: 0, score: 0, items: 0, health: PUSH.lives };
    let lunges = 0;
    // 6 000 tiků = 100 s, nad nejdelší hru.
    let held = 0;
    while (last.runState === 'running' && last.tick < 6000) {
      let changed = false;
      if (wants !== null && (wants.buttons & BUTTON.TAP) !== 0) {
        // Výpad: joystick pustit a ťuknout – ťuk bez tahu je výpad ve směru, kam hrdina naposled šel.
        await fingers.lift(MOVE);
        await fingers.tap(LUNGE, cx, cy);
        lunges += 1;
        held = 0;
        changed = true;
      } else if (wants !== null && wants.axis !== 0) {
        // Tah dlouhý `DRAG` px: zaokrouhlení na celé pixely nepřehodí směr do sousedního z 32 (výpad míří tam, kam hrdina čelí).
        const dir = DIRECTIONS[directionOfAxis(wants.axis)]!;
        if (!fingers.has(MOVE)) await fingers.press(MOVE, cx, cy);
        await fingers.move(MOVE, Math.round(cx + (dir.dx * DRAG) / 1000), Math.round(cy - (dir.dz * DRAG) / 1000));
        changed = held !== wants.axis;
        held = wants.axis;
      } else {
        changed = fingers.has(MOVE);
        await fingers.lift(MOVE);
        held = 0;
      }
      // Prohlížeč pohyb prstu doručí až se snímkem (sloučené pointermove): po změně gesta dva snímky, než tik padne.
      if (changed) await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
      const next = await page.evaluate(() => {
        const shell = window.__playShell as unknown as HandProbe;
        const now = shell.tickByHand();
        return { now, wants: now.runState === 'running' ? shell.botWants() : null };
      });
      last = next.now;
      wants = next.wants;
      if (last.tick === 900 || last.tick === 2400) {
        await page.waitForTimeout(300);
        await page.screenshot({ path: info.outputPath(`push-phone-${String(last.tick)}.png`) });
      }
    }
    await fingers.lift(MOVE);
    console.log(`push: ${last.runState} at tick ${last.tick}, ${last.items} pushed out, score ${last.score}, ${last.health} lives, ${lunges} finger lunges`);
    expect(last.runState).toBe('won');
    expect(last.items).toBe(need);
    expect(last.health).toBeGreaterThanOrEqual(1);
    expect(last.tick / 60).toBeGreaterThanOrEqual(30);
    expect(last.tick / 60).toBeLessThanOrEqual(90);

    // G4: záznam prstu z Chromia přehraný v Node skončí v témž stavu (hash celého stavu, Rapier v obou).
    const recorded = await page.evaluate(() => (window.__playShell as unknown as HandProbe).capture());
    expect(recorded.inputs.length).toBeGreaterThan(0);
    await replayState(world, recorded);

    // G5 + G9: výsledek kitu, hvězdy proti paru, anglicky.
    await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
    await page.screenshot({ path: info.outputPath('push-phone-won.png') });
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
    let lastMeshes = -1;
    let since = Date.now();
    const deadline = Date.now() + 20_000;
    let report = await page.evaluate(() => window.__playRender!());
    while (Date.now() < deadline && (report.meshes !== lastMeshes || Date.now() - since < 1500)) {
      if (report.meshes !== lastMeshes) {
        lastMeshes = report.meshes;
        since = Date.now();
      }
      await page.waitForTimeout(250);
      report = await page.evaluate(() => window.__playRender!());
    }
    console.log(`push: ${report.meshes} meshes, ${report.calls} calls, ${report.triangles} triangles`);
    expect(report.meshes).toBeLessThanOrEqual(200);
    expect(report.triangles, 'models of the hero and the rivals are drawn').toBeGreaterThan(1000);
    await context.close();
  });

  test('an idle player pushes nobody out and the game is lost', async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext(person(3));
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
    const end = await page.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun());
    expect(end.runState).toBe('lost');
    expect(end.tick).toBeLessThanOrEqual(PUSH.seconds * 60 + 1);
    await expect(page.getByTestId('hud-counter-collected')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('play-postrun')).toContainText('So close.', { timeout: 30_000 });
    await context.close();
  });
});
