import { type CDPSession, devices, expect, test } from '@playwright/test';

import { type ArcadeWorld, bodyHp } from '../src/play/arcade/contract';
import { CROWD } from '../src/play/arcade/pieces/crowd';
import { laneOfAxis } from '../src/play/arcade/pieces/lanes';
import { assemblyOfCell, liveCells } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';
import { HUD_COUNTER_LABELS } from './hud-labels';
import { type Capture, replayState } from './play-native-input';

/**
 * Dav a brány na telefonu (P54C T10, G4/G5/G8/G9): hra buňky `crowd.default` (věty k žánru vede až T13b, proto hru
 * publikuje spec buňky) se na Pixelu 7 dohraje jen prstem. Kam běžet, říká robot ověřovače přes sondu (`bot-hand.ts`):
 * test položí prst do půlky plátna pruhu, který robot chce (vstup pruhů, hranice ze scény `data-lane-edges`), a tahem
 * ho přesune do druhé. Hodiny jsou ruční. Výhra pošle výzvu (Dare), server ji přehraje a odkaz s ní otevře hru s cílem
 * kamaráda; záznam prstu přehraný v Node dá týž hash jako Chromium. Nečinný dav neprojde žádnou branou a zlobr ho porazí.
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

const cell = liveCells().find((candidate) => candidate.id === 'crowd.default');
if (cell === undefined) throw new Error('crowd.default is not a live cell');
const SPEC = compileRecipe(assemblyOfCell(cell));
const CZECH = /[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u;

/** Každý „člověk“ z vlastní adresy: strop výzev je 1 za 10 s na volajícího (P36B T5r3). */
const person = (n: number) => ({ ...PIXEL_7, extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(100 + n)}` } });

/** Jeden prst na skle; CDP dostane vždy celou sadu bodů. */
class Finger {
  private at: { x: number; y: number } | null = null;
  constructor(private readonly cdp: CDPSession) {}
  async put(x: number, y: number): Promise<void> {
    if (this.at !== null && this.at.x === x && this.at.y === y) return;
    const type = this.at === null ? 'touchStart' : 'touchMove';
    this.at = { x, y };
    await this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [{ id: 1, x, y }] });
  }
  async lift(): Promise<void> {
    if (this.at === null) return;
    this.at = null;
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

test.describe('crowd on a phone (P54C T10)', () => {
  let url = '';
  let id = '';

  test.beforeAll(async ({ request }) => {
    const response = await request.post('/api/play/games', { data: { spec: SPEC } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    url = ((await response.json()) as { url: string }).url;
    id = url.split('/').at(-1)!;
  });

  test('won with a finger alone, the HUD counts the gates, the record replays in Node and the Dare opens', async ({ browser, request }, info) => {
    test.setTimeout(420_000);
    const world = ((await (await request.get(`/api/play/games/${id}`)).json()) as { arcade: ArcadeWorld }).arcade;
    const need = Number((world.rules.find((rule) => rule.id === 'finish_collected')?.params as { need: number }).need);
    const stopTick = Math.round(Number(world.control.params.stop) / CROWD.speed);
    expect(need).toBe(CROWD.pairs);
    const context = await browser.newContext(person(1));
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__playFrame?.().hero != null && window.__playShell !== undefined, undefined, { timeout: 90_000 });
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toHaveAttribute('data-control', 'crowd');
    await expect(stage).toHaveAttribute('data-lane-edges', /^[\d.]+(?:,[\d.]+){3}$/, { timeout: 30_000 });
    await expect(page.getByTestId('hud-counter-collected')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('hud-counter-collected')).toContainText(`0/${need}`);
    await expect(page.getByTestId('hud-counter-lives')).toHaveAttribute('data-count', String(CROWD.lives));
    const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
    for (const label of shown) expect(HUD_COUNTER_LABELS).toContain(label);
    // Dav na startu, zlobr s jeho silou a brány před davem jsou ve scéně už před prvním dotekem.
    await expect(page.getByTestId('crowd-count')).toHaveText(String(CROWD.start));
    const boss = Number((world.rules.find((rule) => rule.id === 'crowd_fight')?.params as { boss: number }).boss);
    await expect(page.getByTestId('crowd-boss')).toHaveText(String(bodyHp(Int32Array.from(world.initial), boss)));
    await expect.poll(async () => (await page.evaluate(() => window.__playFrame!())).items.gate?.count ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath('crowd-phone-start.png') });

    const box = (await stage.boundingBox())!;
    const edges = ((await stage.getAttribute('data-lane-edges')) ?? '').split(',').map(Number);
    const middle = edges[0] as number;
    // Hranice pruhů leží uprostřed trati a ta je uprostřed plátna.
    expect(middle).toBeGreaterThan(0.35);
    expect(middle).toBeLessThan(0.65);
    const halfCenter = (lane: number): number => Math.round(box.x + box.width * (lane === 0 ? middle / 2 : (middle + 1) / 2));
    const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST', { timeout: 120_000 });
    const cdp = await context.newCDPSession(page);
    const finger = new Finger(cdp);
    let wants = await page.evaluate(() => {
      const shell = window.__playShell as unknown as HandProbe;
      shell.byHand(true);
      return shell.botWants();
    });
    let last: ReturnType<HandProbe['tickByHand']> = { runState: 'running', tick: 0, score: 0, items: 0, health: CROWD.lives };
    let moves = 0;
    // 6 000 tiků = 100 s, nad nejdelší hru.
    while (last.runState === 'running' && last.tick < 6000) {
      if (wants !== null && wants.axis !== 0) {
        await finger.put(halfCenter(laneOfAxis(wants.axis)), Math.round(box.y + box.height * 0.6));
        moves += 1;
        // P54C T15b: Chromium doručí `pointermove` až se snímkem, ne hned po CDP volání – bez čekání tik občas
        // přečetl starou osu a dav minul bránu (29 z 30 v jednom ze tří běhů).
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      }
      const next = await page.evaluate(() => {
        const shell = window.__playShell as unknown as HandProbe;
        const now = shell.tickByHand();
        return { now, wants: now.runState === 'running' ? shell.botWants() : null };
      });
      last = next.now;
      wants = next.wants;
      // Plátno kreslí na snímek prohlížeče, ruční hodiny tikají rychleji: snímek obrazovky až po vykreslení.
      if (last.tick === 900 || last.tick === stopTick + 25) {
        await page.waitForTimeout(250);
        await page.screenshot({ path: info.outputPath(last.tick === 900 ? 'crowd-phone-gates.png' : 'crowd-phone-fight.png') });
      }
    }
    await finger.lift();
    console.log(`crowd: ${last.runState} at tick ${last.tick}, ${last.items} gates, score ${last.score}, ${last.health} lives, ${moves} finger moves`);
    expect(last.runState).toBe('won');
    expect(last.items).toBe(need);
    expect(last.health).toBe(CROWD.lives);
    expect(last.tick / 60).toBeGreaterThanOrEqual(30);
    expect(last.tick / 60).toBeLessThanOrEqual(90);

    // G4: záznam prstu z Chromia přehraný v Node skončí v témž stavu (hash celého stavu).
    const recorded = await page.evaluate(() => (window.__playShell as unknown as HandProbe).capture());
    expect(recorded.inputs.length).toBeGreaterThan(0);
    await replayState(world, recorded);

    // G5 + G9: výsledek kitu, hvězdy proti paru, anglicky.
    await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
    await page.screenshot({ path: info.outputPath('crowd-phone-won.png') });
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
    console.log(`crowd: ${report.meshes} meshes, ${report.calls} calls, ${report.triangles} triangles`);
    expect(report.meshes).toBeLessThanOrEqual(200);
    expect(report.triangles, 'models of the crowd, the saws and the ogre are drawn').toBeGreaterThan(1000);
    await context.close();
  });

  test('an idle crowd passes no gate and the ogre beats it', async ({ browser }) => {
    const context = await browser.newContext(person(3));
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
    const end = await page.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun());
    expect(end.runState).toBe('lost');
    await expect(page.getByTestId('hud-counter-collected')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('hud-counter-lives')).toHaveAttribute('data-count', String(CROWD.lives));
    // Prohra bez jediného bodu (P56A T9) říká „Try again!“, ne „So close.“.
    await expect(page.getByTestId('play-postrun')).toContainText('Try again!', { timeout: 30_000 });
    await context.close();
  });
});
