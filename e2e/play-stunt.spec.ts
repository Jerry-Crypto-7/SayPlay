import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, type CDPSession, expect, type Page, test, type TestInfo } from '@playwright/test';

import { P68V_HUD_LABELS } from '../evals/play/p68/vozidla-sport/hud-labels-request';
import { stuntDragPx } from '../src/components/play/arcade/genres/stunt/stunt-touch';
import { BUTTON } from '../src/play/arcade/contract';
import { LEGIBLE_CAP, LEGIBLE_SHARE } from '../src/play/arcade/models';
import { HUD_COUNTER_LABELS } from './hud-labels';

/**
 * Závod s triky na telefonu i na desktopu (P68V T5). Hra z ručního specu `e2e/fixtures/p68-stunt-spec.json` (monster
 * truck, bedny, poušť; seed v JSON) přes `POST /api/play/games` – publikační brána s robotem projde. Pak:
 * - telefon (`pixel7-touch`, `iphone-touch`): celou hru dohraje prst – tah palcem ve spodní polovině scény o
 *   `stuntDragPx(osa)` od místa stisku, brzda = držet tlačítko `stunt-brake`; vede ho robot ověřovače (`botWants`
 *   sondy `__playShell`); počítadla `Smash` a `Air` v DOM vyrostou nad 0, konec kartou výhry;
 * - desktop (`chromium`): šipky řídí a `↓` brzdí (vstup v záznamu, auto se na obrazovce pohne), zbytek dohraje záznam
 *   robota cestou klávesnice (`handPlay`), konec kartou výsledku;
 * - obojí: nečinný hráč prohraje („So close.“), auto čitelné (`LEGIBLE_SHARE.hero`), popisky počítadel
 *   ⊂ `HUD_COUNTER_LABELS` ∪ `hud-labels-request.ts`, žádná chyba stránky; záznam robota přehraný od tiku 0
 *   v prohlížeči (`playWitness`) dá otisk z Node (`stunt-hash.json`, drží ho `stunt-replay.test.ts`);
 * - FPS: 10 s hry (ukázka robota v reálném čase), doby snímků z `requestAnimationFrame` ve stránce →
 *   `evals/play/p68/vozidla-sport/fps-stunt.json`; brána medián ≥ 40 FPS a p95 ≤ 33,3 ms jen na `chromium` (hostitel),
 *   emulované telefony se zapíšou bez brány.
 * Snímky pro oko (na výšku i na šířku, ve skoku a v nárazu) do `D:/caches/p68/v/stunt/` (`P68_STUNT_SHOTS` přepíše).
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p68-stunt-spec.json');
const LANE = join(process.cwd(), 'evals/play/p68/vozidla-sport');
const HASH_FILE = join(LANE, 'stunt-hash.json');
const FPS_FILE = join(LANE, 'fps-stunt.json');
const SHOTS = process.env.P68_STUNT_SHOTS ?? 'D:/caches/p68/v/stunt';
const LABELS: readonly string[] = [...HUD_COUNTER_LABELS, ...P68V_HUD_LABELS];
/** Prsty: palec řízení a palec na brzdě. */
const STEER = 1;
const BRAKE = 2;
/** Osa, o kterou se smí přání robota lišit od drženého tahu, než prst popojede (‰ z `AXIS_MAX`); robot dorovná sám. */
const AXIS_SLACK = 40;
/** Brána FPS P68-I (hostitel): medián aspoň tolik snímků za sekundu, p95 doby snímku nejvýš tolik ms. */
const FPS_GATE = { medianFps: 40, p95Ms: 33.3 } as const;
const FPS_WINDOW_MS = 10_000;
/** Snímek „v nárazu“ tolik tiků po rozbití hromady: trosky už letí. */
const SMASH_SHOT_DELAY = 6;
/** Druhý snímek nárazu: trosky letí před autem. */
const DEBRIS_SHOT_DELAY = 24;
/** Snímek cíle tolik tiků před průjezdem v běhu robota: brána před autem. */
const FINISH_SHOT_LEAD = 45;
/** Snímek nárazu do mantinelu tolik tiků po ztrátě života. */
const CRASH_SHOT_DELAY = 2;

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
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): Now;
  tick(): number;
  start(): void;
  physicsReady(): boolean;
  capture(): { readonly inputs: readonly { tick: number; buttons: number; axis: number }[]; readonly tick: number; readonly hash: string };
  playWitness(): { readonly runState: string; readonly tick: number };
  handPlay(until: 'score' | 'end' | number): { readonly runState: string; readonly tick: number; readonly score: number };
  idleRun(): { readonly runState: string; readonly tick: number };
}
interface Pinned {
  readonly seed: number;
  readonly node: { readonly hash: string; readonly outcome: string; readonly tick: number; readonly inputs: number };
  readonly moments: { readonly jumpPeak: number; readonly jumpLanded: number; readonly smash: number; readonly idleCrash: number };
}

const pinned = (): Pinned => JSON.parse(readFileSync(HASH_FILE, 'utf8')) as Pinned;

/** Zápis výsledku projektu do souboru pruhu (čtení, doplnění klíče, zápis – projekty běží po jednom). */
function record(file: string, project: string, entry: object): void {
  const doc = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) as { browser?: Record<string, object> };
  doc.browser = { ...(doc.browser ?? {}), [project]: entry };
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

async function publishFixture(request: APIRequestContext): Promise<string> {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { seed: number; spec: unknown };
  const body = { data: { spec: fixture.spec, seed: fixture.seed } };
  let response = await request.post('/api/play/games', body);
  // `specNeedsPhysics` hru `stunt` nezná: první POST po startu serveru může dostat 422, než se Rapier dočte
  // (prosba v `integration.md`). Jednou znovu.
  if (response.status() === 422) response = await request.post('/api/play/games', body);
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/** Hláška Chromia, ne závodu (vzor `play-survivor.spec.ts`): rekordér klipu při změně rozlišení plátna. */
const CLIP_RESOLUTION_WARNING = 'When using "avc1" for mp4 encoding, the codec description is not supposed to change';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith(CLIP_RESOLUTION_WARNING)) errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** Počet sítí se 1,5 s nezměnil = modely dotažené; pak změř auto (podíl výšky plátna a měřítko čitelnosti). */
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

/**
 * Prsty na skle. Chromium: CDP dostane vždy celou sadu bodů (vzor `play-touch.spec.ts`). WebKit CDP nemá – tam jde
 * každý prst jako dotykové `PointerEvent` na prvek pod ním; implicitní zachycení skutečného prstu (pohyb a zvednutí
 * jdou na prvek položení, `hasPointerCapture` platí) dělá ovladač sám.
 */
class Fingers {
  /** Prst: kde je teď (`x`, `y`) a kde se položil (`ox`, `oy`). */
  private readonly down = new Map<number, { x: number; y: number; ox: number; oy: number }>();
  constructor(
    private readonly cdp: CDPSession | null,
    private readonly page: Page,
  ) {}
  has(id: number): boolean {
    return this.down.has(id);
  }
  private points() {
    return [...this.down].map(([id, at]) => ({ id, x: at.x, y: at.y }));
  }
  private pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', id: number, x: number, y: number): Promise<void> {
    return this.page.evaluate(
      ({ type, id, x, y }) => {
        const own = window as unknown as { __fingers?: Map<number, Element> };
        if (own.__fingers === undefined) {
          const capture = Element.prototype.setPointerCapture;
          const has = Element.prototype.hasPointerCapture;
          Element.prototype.setPointerCapture = function (this: Element, pointerId: number) {
            if (!own.__fingers?.has(pointerId)) capture.call(this, pointerId);
          };
          Element.prototype.hasPointerCapture = function (this: Element, pointerId: number) {
            return own.__fingers?.has(pointerId) === true ? own.__fingers.get(pointerId) === this : has.call(this, pointerId);
          };
        }
        const held = (own.__fingers ??= new Map());
        const target = type === 'pointerdown' ? document.elementFromPoint(x, y) : held.get(id);
        if (target == null) return;
        if (type === 'pointerdown') held.set(id, target);
        const isPrimary = type === 'pointerdown' ? held.size === 1 : [...held.keys()][0] === id;
        const event = new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true });
        target.dispatchEvent(event);
        if (type === 'pointerup') held.delete(id);
      },
      { type, id, x, y },
    );
  }
  async press(id: number, x: number, y: number): Promise<void> {
    this.down.set(id, { x, y, ox: x, oy: y });
    if (this.cdp === null) return this.pointer('pointerdown', id, x, y);
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: this.points() });
  }
  async move(id: number, x: number, y: number): Promise<void> {
    const at = this.down.get(id);
    if (at === undefined || (at.x === x && at.y === y)) return;
    this.down.set(id, { ...at, x, y });
    if (this.cdp === null) return this.pointer('pointermove', id, x, y);
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: this.points() });
  }
  async lift(id: number): Promise<void> {
    const at = this.down.get(id);
    if (!this.down.delete(id)) return;
    if (this.cdp === null) return this.pointer('pointerup', id, at!.x, at!.y);
    // `touchEnd` pustí v Chromu všechny prsty. `touchMove` bez zvednutého bodu ho spolehlivě nepustí (naměřeno 1. 11.:
    // brzda zvednutá pod drženým palcem řízení zůstala držet do konce hry), proto: pustit vše a zbylé prsty položit
    // znovu na místo jejich stisku a dotáhnout tam, kde byly – tah palce se počítá od místa stisku a zůstane týž.
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    if (this.down.size === 0) return;
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [...this.down].map(([key, point]) => ({ id: key, x: point.ox, y: point.oy })) });
    if ([...this.down.values()].some((point) => point.x !== point.ox || point.y !== point.oy)) {
      await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: this.points() });
    }
  }
}

const frames = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
/** Auto na obrazovce: x promítnutého středu v NDC, jak ho scéna píše do `data-player-x`. */
const heroX = async (page: Page): Promise<number> => Number(await page.getByTestId('arcade-stage').getAttribute('data-player-x'));
const shooter = (page: Page, info: TestInfo) => async (name: string) => {
  await frames(page);
  await frames(page);
  await page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}.png`) });
};

/** Stránka hry: plátno závodu, sonda, Rapier v prohlížeči. */
async function openGame(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-control', 'stunt', { timeout: 60_000 });
  await page.waitForFunction(() => window.__playShell !== undefined && (window.__playShell as unknown as ArcadeProbe).physicsReady(), undefined, { timeout: 90_000 });
}

/**
 * Robot ověřovače hraje sondou (`hold` / `press` = tatáž cesta jako klávesnice) až do tiku `until` – snímky
 * v přesných chvílích běhu robota. Volat po `byHand(true)` na tiku 0.
 */
const driveTo = (page: Page, until: number) =>
  page.evaluate((stop) => {
    const shell = window.__playShell as unknown as ArcadeProbe;
    let now = { runState: 'running', tick: shell.tick() } as { runState: string; tick: number };
    while (now.runState === 'running' && now.tick < stop) {
      const wants = shell.botWants();
      shell.hold(wants?.axis ?? 0);
      shell.press(wants?.buttons ?? 0);
      now = shell.tickByHand();
    }
    return now;
  }, until);

/** Restart na tik 0 bez hraní: `handPlay` s prahem −1 skončí hned po restartu (skóre 0 > −1). */
const restart = (page: Page) => page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).handPlay(-1));

const counts = (page: Page) =>
  page.evaluate(() => ({
    smash: Number(document.querySelector('[data-testid="hud-counter-smash"]')?.getAttribute('data-count') ?? -1),
    air: Number(document.querySelector('[data-testid="hud-counter-air"]')?.getAttribute('data-count') ?? -1),
  }));

test.describe('stunt (P68V T5)', () => {
  let url = '';

  test.beforeAll(async ({ request }) => {
    url = await publishFixture(request);
    mkdirSync(SHOTS, { recursive: true });
  });

  test('stunt: the game opens, plays to a win by touch and keys, smashes and jumps (P68V T5)', async ({ page, context, browserName }, info) => {
    test.setTimeout(600_000);
    const touch = info.project.name !== 'chromium';
    const shot = shooter(page, info);
    const errors = watchErrors(page);
    const moments = pinned().moments;

    await openGame(page, url);
    // Auto z věty čitelné: aspoň 20 % výšky obrazu, nebo zvětšené na strop a pak aspoň 8 % × strop.
    const hero = await heroOnScreen(page);
    if (hero.legible < LEGIBLE_CAP) expect(hero.share, `hero ${JSON.stringify(hero)}`).toBeGreaterThanOrEqual(LEGIBLE_SHARE.hero);
    else expect(hero.share, `hero ${JSON.stringify(hero)}`).toBeGreaterThanOrEqual(0.08 * LEGIBLE_CAP);
    const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
    expect(shown).toEqual(expect.arrayContaining(['smash', 'air']));
    for (const label of shown) expect(LABELS).toContain(label);
    await shot('start');

    if (touch) {
      // Brzda: v dolních 45 % obrazovky a aspoň `--sp-size-touch-min` v obou rozměrech.
      const brake = page.getByTestId('stunt-brake');
      await expect(brake).toBeVisible();
      const at = (await brake.boundingBox())!;
      const viewport = page.viewportSize()!;
      const touchMin = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sp-size-touch-min')));
      expect(touchMin).toBeGreaterThan(0);
      expect(at.y, 'brake in the bottom 45 % of the screen').toBeGreaterThanOrEqual(viewport.height * 0.55);
      expect(Math.min(at.width, at.height), 'brake at least --sp-size-touch-min').toBeGreaterThanOrEqual(touchMin);
      const [bx, by] = [Math.round(at.x + at.width / 2), Math.round(at.y + at.height / 2)];
      // Palec řízení: levá třetina plochy palce (spodní polovina scény), daleko od brzdy vpravo.
      const pad = (await page.getByTestId('stunt-touch').boundingBox())!;
      const [cx, cy] = [Math.round(pad.x + pad.width * 0.3), Math.round(pad.y + pad.height * 0.45)];
      const fingers = new Fingers(browserName === 'chromium' ? await context.newCDPSession(page) : null, page);

      let wants = await page.evaluate(() => {
        const shell = window.__playShell as unknown as ArcadeProbe;
        shell.byHand(true);
        return shell.botWants();
      });
      let last: Now = { runState: 'running', tick: 0, score: 0, health: 3 };
      let held = 0;
      let braking = false;
      let gestures = 0;
      let brakes = 0;
      const most = { smash: 0, air: 0 };
      const due = [
        { tick: moments.smash + SMASH_SHOT_DELAY, name: 'portrait-smash' },
        { tick: moments.smash + DEBRIS_SHOT_DELAY, name: 'portrait-debris' },
        { tick: moments.jumpPeak, name: 'portrait-jump' },
        { tick: pinned().node.tick - FINISH_SHOT_LEAD, name: 'portrait-finish' },
      ].sort((a, b) => a.tick - b.tick);
      while (last.runState === 'running' && last.tick < 6000) {
        // Přání robota → gesta: brzda = druhý prst na tlačítku, osa = tah palce od místa stisku.
        const wantBrake = wants !== null && (wants.buttons & BUTTON.DOWN) !== 0;
        const wantAxis = wants?.axis ?? 0;
        let moved = false;
        if (wantBrake !== braking) {
          if (wantBrake) {
            await fingers.press(BRAKE, bx, by);
            brakes += 1;
          } else await fingers.lift(BRAKE);
          braking = wantBrake;
          moved = true;
        }
        if (wantAxis === 0 && held !== 0) {
          await fingers.lift(STEER);
          held = 0;
          moved = true;
        } else if (wantAxis !== 0 && (held === 0 || Math.sign(wantAxis) !== Math.sign(held) || Math.abs(wantAxis - held) > AXIS_SLACK)) {
          if (!fingers.has(STEER)) await fingers.press(STEER, cx, cy);
          await fingers.move(STEER, cx + stuntDragPx(wantAxis), cy);
          held = wantAxis;
          gestures += 1;
          moved = true;
        }
        if (moved) await frames(page);
        // Dokud robot chce totéž (v toleranci), prsty stojí a tiky běží v jednom volání; stojí se i u tiku snímku.
        const stopAt = due[0]?.tick ?? Number.MAX_SAFE_INTEGER;
        const next = await page.evaluate(
          ({ hold, brake, stop, slack, down }) => {
            const shell = window.__playShell as unknown as ArcadeProbe;
            const same = (w: Wants | null): boolean =>
              w !== null && ((w.buttons & down) !== 0) === brake && (w.axis === 0) === (hold === 0) && Math.sign(w.axis) === Math.sign(hold) && Math.abs(w.axis - hold) <= slack;
            let now = shell.tickByHand();
            for (let k = 0; k < 40 && now.runState === 'running' && now.tick < stop; k += 1) {
              const w = shell.botWants();
              if (!same(w)) return { now, wants: w };
              now = shell.tickByHand();
            }
            return { now, wants: now.runState === 'running' ? shell.botWants() : null };
          },
          { hold: held, brake: braking, stop: stopAt, slack: AXIS_SLACK, down: BUTTON.DOWN },
        );
        last = next.now;
        wants = next.wants;
        const seen = await counts(page);
        most.smash = Math.max(most.smash, seen.smash);
        most.air = Math.max(most.air, seen.air);
        while (due[0] !== undefined && last.tick >= due[0].tick) {
          await shot(due.shift()!.name);
        }
      }
      await fingers.lift(STEER);
      await fingers.lift(BRAKE);
      const end = await counts(page);
      most.smash = Math.max(most.smash, end.smash);
      most.air = Math.max(most.air, end.air);
      test.info().annotations.push({ type: 'touch-run', description: JSON.stringify({ ...last, gestures, brakes, most }) });
      expect(gestures, 'the thumb steered').toBeGreaterThan(10);
      expect(brakes, 'the brake button was held at least once').toBeGreaterThan(0);
      expect(most.smash, 'Smash counter in the DOM grew above 0').toBeGreaterThan(0);
      expect(most.air, 'Air counter in the DOM grew above 0').toBeGreaterThan(0);
      expect(last.runState, `ended at tick ${String(last.tick)} with ${String(last.health)} lives`).toBe('won');
    } else {
      // Šipky řídí: vstup v záznamu a auto se na obrazovce pohne doprava; ↓ brzdí (`BUTTON.DOWN` v záznamu).
      await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).start());
      const before = await heroX(page);
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(700);
      await page.keyboard.up('ArrowRight');
      await expect.poll(() => heroX(page), { timeout: 5_000 }).toBeGreaterThan(before + 0.05);
      await page.keyboard.down('ArrowDown');
      await page.waitForTimeout(400);
      await page.keyboard.up('ArrowDown');
      const keyed = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).capture().inputs);
      expect(keyed.some((event) => event.axis > 0), 'ArrowRight reached the record as a right axis').toBe(true);
      expect(keyed.some((event) => (event.buttons & BUTTON.DOWN) !== 0), 'ArrowDown = BUTTON.DOWN (brake)').toBe(true);

      // Snímky na šířku v přesných chvílích běhu robota: rozbitá hromada, vrchol prvního skoku.
      await restart(page);
      await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).byHand(true));
      expect((await driveTo(page, moments.smash + SMASH_SHOT_DELAY)).runState).toBe('running');
      await shot('landscape-smash');
      const smashed = await counts(page);
      expect(smashed.smash, 'Smash counter after the pile hit').toBeGreaterThan(0);
      expect((await driveTo(page, moments.smash + DEBRIS_SHOT_DELAY)).runState).toBe('running');
      await shot('landscape-debris');
      expect((await driveTo(page, moments.jumpPeak)).runState).toBe('running');
      await shot('landscape-jump');
      // Skok se počítá po dopadu (účetnictví tiku po přistání).
      expect((await driveTo(page, moments.jumpLanded + 3)).runState).toBe('running');
      await frames(page);
      const landed = await counts(page);
      expect(landed.smash, 'Smash counter after the jump').toBeGreaterThan(0);
      expect(landed.air, 'Air counter after the first landing').toBeGreaterThan(0);
      expect((await driveTo(page, pinned().node.tick - FINISH_SHOT_LEAD)).runState).toBe('running');
      await shot('landscape-finish');
      await page.evaluate(() => {
        const shell = window.__playShell as unknown as ArcadeProbe;
        shell.byHand(false);
        shell.hold(0);
        shell.press(0);
      });
      const end = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).handPlay('end'));
      expect(end.runState).toBe('won');
    }

    await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
    await shot(touch ? 'portrait-result' : 'landscape-result');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('stunt: an idle player hits the wall and loses (P68V T5)', async ({ page }, info) => {
    test.setTimeout(300_000);
    const touch = info.project.name !== 'chromium';
    const shot = shooter(page, info);
    const errors = watchErrors(page);
    const moments = pinned().moments;
    // Telefon tady na šířku: snímky skoku a nárazu na šířku (na výšku jsou v testu výš).
    if (touch) {
      const size = page.viewportSize()!;
      await page.setViewportSize({ width: Math.max(size.width, size.height), height: Math.min(size.width, size.height) });
    }
    await openGame(page, url);
    await heroOnScreen(page);
    const prefix = touch ? 'landscape' : 'desktop';
    if (touch) {
      await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).byHand(true));
      expect((await driveTo(page, moments.jumpPeak)).runState).toBe('running');
      await shot(`${prefix}-jump`);
      await restart(page);
    }
    // Nečinné auto: tiky bez vstupu až po náraz do mantinelu v první zatáčce.
    await page.evaluate(() => {
      const shell = window.__playShell as unknown as ArcadeProbe;
      shell.byHand(true);
      shell.hold(0);
      shell.press(0);
    });
    const crashed = await page.evaluate((until) => {
      const shell = window.__playShell as unknown as ArcadeProbe;
      let now = shell.tickByHand();
      while (now.runState === 'running' && now.tick < until) now = shell.tickByHand();
      return now;
    }, moments.idleCrash + CRASH_SHOT_DELAY);
    expect(crashed.health, 'the idle car lost a life at the wall').toBe(2);
    await shot(`${prefix}-wall-crash`);
    const end = await page.evaluate(() => {
      const shell = window.__playShell as unknown as ArcadeProbe;
      shell.byHand(false);
      return shell.idleRun();
    });
    expect(end.runState).toBe('lost');
    // Karta prohry. Nadpis „So close.“ z plánu dává sdílený `runResult` jen prohře s body; nečinné auto nemá bod
    // (0 bodů = „Try again!“, P56A T9) – ten tu je.
    const postrun = page.getByTestId('play-postrun');
    await expect(postrun).toBeVisible({ timeout: 30_000 });
    await expect(postrun).toContainText('Try again!');
    await expect(postrun).not.toContainText('You did it!');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('stunt: the bot record replayed from tick 0 in the browser gives the Node hash (P68V T5)', async ({ page }, info) => {
    test.setTimeout(300_000);
    const node = pinned().node;
    await openGame(page, url);
    const browser = await page.evaluate(() => {
      const shell = window.__playShell as unknown as ArcadeProbe;
      const end = shell.playWitness();
      const captured = shell.capture();
      return { hash: captured.hash, outcome: end.runState, tick: end.tick };
    });
    record(HASH_FILE, info.project.name, { ...browser, equal: browser.hash === node.hash });
    expect(browser).toEqual({ hash: node.hash, outcome: node.outcome, tick: node.tick });
  });

  test('stunt: 10 s of play stay smooth on the host (P68V T5, FPS gate on chromium)', async ({ page }, info) => {
    test.setTimeout(300_000);
    const gated = info.project.name === 'chromium';
    await openGame(page, url);
    await heroOnScreen(page);
    // Hraje ukázka robota v reálném čase (karta pauzy → „Show me how“), tatáž cesta kreslení jako hráč.
    await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).start());
    await page.getByTestId('play-pause').click();
    await page.getByTestId('play-demo-start').click();
    await page.waitForFunction(() => (window.__playShell as unknown as ArcadeProbe).tick() > 30, undefined, { timeout: 30_000 });
    const measured = await page.evaluate(async (windowMs) => {
      const shell = window.__playShell as unknown as ArcadeProbe;
      const fromTick = shell.tick();
      const intervals: number[] = [];
      await new Promise<void>((resolve) => {
        let started = 0;
        let last = 0;
        const frame = (now: number) => {
          if (started === 0) started = now;
          else intervals.push(now - last);
          last = now;
          if (now - started < windowMs) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
      const gl = document.createElement('canvas').getContext('webgl2');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        intervals,
        ticks: shell.tick() - fromTick,
        gpu: gl && debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
        viewport: { width: innerWidth, height: innerHeight },
        dpr: devicePixelRatio,
        quality: document.querySelector('[data-testid="arcade-stage"]')?.getAttribute('data-quality') ?? null,
      };
    }, FPS_WINDOW_MS);
    const sorted = [...measured.intervals].sort((a, b) => a - b);
    const quantile = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    const medianMs = quantile(0.5);
    const p95Ms = quantile(0.95);
    const entry = {
      gated,
      frames: measured.intervals.length,
      windowMs: FPS_WINDOW_MS,
      ticksPlayed: measured.ticks,
      medianFrameMs: Number(medianMs.toFixed(2)),
      medianFps: Number((1000 / medianMs).toFixed(1)),
      p95FrameMs: Number(p95Ms.toFixed(2)),
      maxFrameMs: Number(sorted.at(-1)!.toFixed(2)),
      gate: gated ? FPS_GATE : null,
      pass: gated ? 1000 / medianMs >= FPS_GATE.medianFps && p95Ms <= FPS_GATE.p95Ms : null,
      gpu: measured.gpu,
      viewport: measured.viewport,
      dpr: measured.dpr,
      quality: measured.quality,
    };
    record(FPS_FILE, info.project.name, entry);
    // Hra opravdu běžela: 10 s ukázky ≈ 600 tiků (aspoň polovina).
    expect(measured.ticks, 'the demo ran during the window').toBeGreaterThan(300);
    if (gated) {
      expect(entry.medianFps, `median FPS ${JSON.stringify(entry)}`).toBeGreaterThanOrEqual(FPS_GATE.medianFps);
      expect(entry.p95FrameMs, `p95 frame ms ${JSON.stringify(entry)}`).toBeLessThanOrEqual(FPS_GATE.p95Ms);
    }
  });
});
