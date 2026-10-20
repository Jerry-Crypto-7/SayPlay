import { type CDPSession, devices, expect, test } from '@playwright/test';

import type { ArcadeWorld } from '../src/play/arcade/contract';
import { MERGE, dropLimit, sizeOf, targetOf } from '../src/play/arcade/pieces/merge-drop';
import { assemblyOfCell, liveCells } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';
import { HUD_COUNTER_LABELS } from './hud-labels';
import { type Capture, replayState } from './play-native-input';

/**
 * Pouštění a slučování na telefonu (P54C T11, G4/G5/G8/G9): hra buňky `merge.default` (věty k žánru vede až T13b,
 * proto hru publikuje spec buňky) se na Pixelu 7 dohraje jen prstem. Kam pustit, říká robot ověřovače přes sondu
 * (`bot-hand.ts`): test položí prst nad místo, kam robot míří (vstup slučování, kraje dosahu ze scény
 * `data-drop-edges`), a zvednutím prstu předmět pustí. Hodiny jsou ruční. Výhra pošle výzvu (Dare), server ji
 * přehraje a odkaz s ní otevře hru s cílem kamaráda; záznam prstu přehraný v Node dá týž hash jako Chromium (Rapier
 * počítá v obou totéž). Nečinnému hráči předměty zkamení, nádoba přeteče a prohraje.
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

const cell = liveCells().find((candidate) => candidate.id === 'merge.default');
if (cell === undefined) throw new Error('merge.default is not a live cell');
const SPEC = compileRecipe(assemblyOfCell(cell));
const CZECH = /[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u;
const TAP = 1;
const REACH = dropLimit(sizeOf(1));

/** Každý „člověk“ z vlastní adresy: strop výzev je 1 za 10 s na volajícího (P36B T5r3). */
const person = (n: number) => ({ ...PIXEL_7, extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${String(110 + n)}` } });

/** Jeden prst na skle; CDP dostane vždy celou sadu bodů. */
class Finger {
  private at: { x: number; y: number } | null = null;
  constructor(private readonly cdp: CDPSession) {}
  get down(): boolean {
    return this.at !== null;
  }
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

test.describe('merge on a phone (P54C T11)', () => {
  let url = '';
  let id = '';

  test.beforeAll(async ({ request }) => {
    const response = await request.post('/api/play/games', { data: { spec: SPEC } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    url = ((await response.json()) as { url: string }).url;
    id = url.split('/').at(-1)!;
  });

  test('won with a finger alone, the HUD counts the merges, the record replays in Node and the Dare opens', async ({ browser, request }, info) => {
    test.setTimeout(480_000);
    const world = ((await (await request.get(`/api/play/games/${id}`)).json()) as { arcade: ArcadeWorld }).arcade;
    const need = Number((world.rules.find((rule) => rule.id === 'finish_collected')?.params as { need: number }).need);
    expect(need).toBe(MERGE.need);
    const context = await browser.newContext(person(1));
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__playFrame?.().hero != null && window.__playShell !== undefined, undefined, { timeout: 90_000 });
    const stage = page.getByTestId('arcade-stage');
    await expect(stage).toHaveAttribute('data-control', 'merge');
    await expect(stage).toHaveAttribute('data-drop-edges', /^[\d.]+,[\d.]+$/, { timeout: 30_000 });
    await expect(page.getByTestId('hud-counter-collected')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('hud-counter-collected')).toContainText(`0/${need}`);
    await expect(page.getByTestId('hud-counter-lives')).toHaveAttribute('data-count', String(MERGE.lives));
    const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
    for (const label of shown) expect(HUD_COUNTER_LABELS).toContain(label);
    // Náhled příštího předmětu a jeho štítek jsou ve scéně už před prvním dotekem.
    await expect(page.getByTestId('merge-next')).toHaveText('Next');
    await expect.poll(async () => (await page.evaluate(() => window.__playFrame!())).items.item?.count ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath('merge-phone-start.png') });

    const box = (await stage.boundingBox())!;
    const [left, right] = ((await stage.getAttribute('data-drop-edges')) ?? '').split(',').map(Number) as [number, number];
    // Dosah dávkovače je uprostřed plátna a zabírá skoro celou šíři telefonu.
    expect(left).toBeGreaterThan(0.02);
    expect(right).toBeLessThan(0.98);
    expect(right - left).toBeGreaterThan(0.5);
    const fingerX = (axis: number): number => box.x + box.width * (left + ((targetOf(axis, REACH, 0) + REACH) / (2 * REACH)) * (right - left));
    const fingerY = Math.round(box.y + box.height * 0.5);
    const posted = page.waitForResponse((response) => response.url().endsWith(`/api/play/games/${id}/dare`) && response.request().method() === 'POST', { timeout: 120_000 });
    const cdp = await context.newCDPSession(page);
    const finger = new Finger(cdp);
    let wants = await page.evaluate(() => {
      const shell = window.__playShell as unknown as HandProbe;
      shell.byHand(true);
      return shell.botWants();
    });
    let last: ReturnType<HandProbe['tickByHand']> = { runState: 'running', tick: 0, score: 0, items: 0, health: MERGE.lives };
    let drops = 0;
    // Kam prst naposled mířil: dávkovač tam stojí, i když je prst zvednutý.
    let aimX = fingerX(1);
    // 6 000 tiků = 100 s, nad nejdelší hru.
    while (last.runState === 'running' && last.tick < 6000) {
      if (wants !== null && (wants.buttons & TAP) !== 0) {
        // Zvednutý prst pustí předmět nad místem, kam mířil; robot, který nikam nejede, dostane ťuk na místě.
        if (!finger.down) await finger.put(aimX, fingerY);
        await finger.lift();
        drops += 1;
      } else if (wants !== null && wants.axis !== 0) {
        aimX = fingerX(wants.axis);
        await finger.put(aimX, fingerY);
      }
      const next = await page.evaluate(() => {
        const shell = window.__playShell as unknown as HandProbe;
        const now = shell.tickByHand();
        return { now, wants: now.runState === 'running' ? shell.botWants() : null };
      });
      last = next.now;
      wants = next.wants;
      // Plátno kreslí na snímek prohlížeče, ruční hodiny tikají rychleji: snímek obrazovky až po vykreslení.
      if (last.tick === 900 || last.tick === 2400) {
        await page.waitForTimeout(300);
        await page.screenshot({ path: info.outputPath(`merge-phone-${String(last.tick)}.png`) });
      }
    }
    await finger.lift();
    console.log(`merge: ${last.runState} at tick ${last.tick}, ${last.items} merges, score ${last.score}, ${last.health} lives, ${drops} finger drops`);
    expect(last.runState).toBe('won');
    expect(last.items).toBeGreaterThanOrEqual(need);
    expect(last.health).toBeGreaterThanOrEqual(1);
    expect(last.tick / 60).toBeGreaterThanOrEqual(45);
    expect(last.tick / 60).toBeLessThanOrEqual(90);

    // G4: záznam prstu z Chromia přehraný v Node skončí v témž stavu (hash celého stavu, Rapier v obou).
    const recorded = await page.evaluate(() => (window.__playShell as unknown as HandProbe).capture());
    expect(recorded.inputs.length).toBeGreaterThan(0);
    await replayState(world, recorded);

    // G5 + G9: výsledek kitu, hvězdy proti paru, anglicky.
    await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
    await page.screenshot({ path: info.outputPath('merge-phone-won.png') });
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
    console.log(`merge: ${report.meshes} meshes, ${report.calls} calls, ${report.triangles} triangles`);
    expect(report.meshes).toBeLessThanOrEqual(200);
    expect(report.triangles, 'models of the fruit and the hero are drawn').toBeGreaterThan(1000);
    await context.close();
  });

  test('an idle player merges nothing: the items turn to stone, the container overflows and the game is lost', async ({ browser }) => {
    const context = await browser.newContext(person(3));
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
    const end = await page.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun());
    expect(end.runState).toBe('lost');
    expect(end.tick).toBeLessThan(MERGE.seconds * 60);
    await expect(page.getByTestId('hud-counter-collected')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('hud-counter-lives')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('play-postrun')).toContainText('So close.', { timeout: 30_000 });
    await context.close();
  });
});
