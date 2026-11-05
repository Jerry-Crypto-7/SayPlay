import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, type CDPSession, expect, type Page, test, type TestInfo } from '@playwright/test';

import { P68V_HUD_LABELS } from '../evals/play/p68/vozidla-sport/hud-labels-request';
import { pullFor } from '../src/components/play/arcade/genres/minigolf/minigolf-touch';
import { BUTTON } from '../src/play/arcade/contract';
import { HUD_COUNTER_LABELS } from './hud-labels';

/**
 * Minigolf na telefonu i na desktopu (P68V T9). Hra z ručního specu `e2e/fixtures/p68-minigolf-spec.json` (jamka do L
 * ve strašidelném domě, tři dýně jako odrazníky, pohyblivá rakev; seed v JSON) přes `POST /api/play/games` –
 * publikační brána s robotem projde. Pak:
 * - telefon (`pixel7-touch`, `iphone-touch`): celou jamku dohraje prst – stisk v herní ploše pod horním pásem HUD,
 *   natažení zpět o `pullFor(osa kamery při stisku, osa, nabití)` (roste tik po tiku, dokud robot ověřovače drží `HOLD`),
 *   puštění = rána, když robot chce `TAP`; vede ho `botWants` sondy `__playShell`; počítadlo `Strokes` v DOM vyroste
 *   aspoň na 1, konec kartou výhry; míček i jamka jsou v záběru na výšku;
 * - desktop (`chromium`): šipky otočí míření a držený mezerník nabije a pustí ránu (vstup v záznamu, `Strokes` = 1),
 *   zbytek dohraje záznam robota cestou klávesnice (`handPlay`), konec kartou výsledku;
 * - obojí: nečinný hráč prohraje, popisky počítadel ⊂ `HUD_COUNTER_LABELS` ∪ `hud-labels-request.ts`, žádná chyba
 *   stránky; záznam robota přehraný od tiku 0 v prohlížeči (`playWitness`) dá otisk z Node (`minigolf-hash.json`,
 *   drží ho `minigolf-replay.test.ts` i s ranami robota);
 * - FPS: 10 s od startu ukázky robota (jamka trvá ~4,7 s, zbytek okna kreslí scénu po výhře), doby snímků
 *   z `requestAnimationFrame` → `evals/play/p68/vozidla-sport/fps-minigolf.json`; brána medián ≥ 40 FPS a p95 ≤ 33,3 ms
 *   jen na `chromium` (hostitel), emulované telefony se zapíšou bez brány.
 * Snímky (míření, valení, jamka; na výšku i na šířku) do `D:/caches/p68/v/minigolf/` (`P68_MINIGOLF_SHOTS` přepíše).
 */

const FIXTURE = join(process.cwd(), 'e2e/fixtures/p68-minigolf-spec.json');
const LANE = join(process.cwd(), 'evals/play/p68/vozidla-sport');
const HASH_FILE = join(LANE, 'minigolf-hash.json');
const FPS_FILE = join(LANE, 'fps-minigolf.json');
const SHOTS = process.env.P68_MINIGOLF_SHOTS ?? 'D:/caches/p68/v/minigolf';
const LABELS: readonly string[] = [...HUD_COUNTER_LABELS, ...P68V_HUD_LABELS];
const FINGER = 1;
/** Brána FPS P68-I (hostitel): medián aspoň tolik snímků za sekundu, p95 doby snímku nejvýš tolik ms. */
const FPS_GATE = { medianFps: 40, p95Ms: 33.3 } as const;
const FPS_WINDOW_MS = 10_000;
/** Snímek míření: tolik tiků nabíjení první rány (natažení i měřič síly vidět). */
const AIM_SHOT_CHARGE = 24;
/** Snímek valení: tolik tiků po první ráně. */
const ROLL_SHOT_DELAY = 12;
/** Kontrola „míček i jamka v záběru“ u poslední rány při tomto nabití (osa už míří na jamku). */
const HOLE_SHOT_CHARGE = 30;
/** Kamera tlumí otočení za mířením (5/s): tolik ms snímků bez tiku, než se usadí. */
const CAMERA_SETTLE_MS = 1200;

interface Wants {
  readonly buttons: number;
  readonly axis: number;
}
interface Now {
  readonly runState: string;
  readonly tick: number;
  readonly score: number;
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
  capture(): { readonly inputs: readonly { tick: number; buttons: number; axis: number }[]; readonly tick: number; readonly hash: string };
  playWitness(): { readonly runState: string; readonly tick: number };
  handPlay(until: 'score' | 'end' | number): { readonly runState: string; readonly tick: number; readonly score: number };
  idleRun(): { readonly runState: string; readonly tick: number };
}
interface Stroke {
  readonly hold: number;
  readonly tap: number;
  readonly axis: number;
  readonly charge: number;
}
interface Pinned {
  readonly seed: number;
  readonly node: { readonly hash: string; readonly outcome: string; readonly tick: number; readonly inputs: number };
  readonly strokes: readonly Stroke[];
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
  const response = await request.post('/api/play/games', { data: { spec: fixture.spec, seed: fixture.seed } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/** Hláška Chromia, ne hry (vzor `play-survivor.spec.ts`): rekordér klipu při změně rozlišení plátna. */
const CLIP_RESOLUTION_WARNING = 'When using "avc1" for mp4 encoding, the codec description is not supposed to change';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith(CLIP_RESOLUTION_WARNING)) errors.push(`console: ${message.text()}`);
  });
  return errors;
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

/** Míček (`frame: 'hero'`) a jamka (`frame: 'target'`) celé v záběru: promítnutý obdélník uvnitř NDC −1…1. */
const inView = (page: Page) =>
  page.evaluate(() => {
    const frame = window.__playFrame!();
    const inside = (box: { minX: number; maxX: number; minY: number; maxY: number } | null): boolean =>
      box !== null && box.minX >= -1 && box.maxX <= 1 && box.minY >= -1 && box.maxY <= 1;
    return { ball: inside(frame.hero), hole: inside(frame.target) };
  });

/**
 * Prst na skle (týž ovladač jako `play-stunt.spec.ts`). Chromium: CDP dostane vždy celou sadu bodů. WebKit CDP nemá –
 * tam jde prst jako dotykové `PointerEvent` na prvek pod ním; implicitní zachycení dělá ovladač sám.
 */
class Fingers {
  private readonly down = new Map<number, { x: number; y: number }>();
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
    this.down.set(id, { x, y });
    if (this.cdp === null) return this.pointer('pointerdown', id, x, y);
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: this.points() });
  }
  async move(id: number, x: number, y: number): Promise<void> {
    const at = this.down.get(id);
    if (at === undefined || (at.x === x && at.y === y)) return;
    this.down.set(id, { x, y });
    if (this.cdp === null) return this.pointer('pointermove', id, x, y);
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: this.points() });
  }
  async lift(id: number): Promise<void> {
    const at = this.down.get(id);
    if (!this.down.delete(id)) return;
    if (this.cdp === null) return this.pointer('pointerup', id, at!.x, at!.y);
    // Jeden prst: `touchEnd` bez bodů ho zvedne (u dvou prstů viz `play-stunt.spec.ts`).
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

const frames = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
const shooter = (page: Page, info: TestInfo) => async (name: string) => {
  await frames(page);
  await frames(page);
  await page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}.png`) });
};

/** Stránka hry: plátno minigolfu a sonda (Rapier minigolf nepotřebuje – míček se kutálí v jádře). */
async function openGame(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-control', 'minigolf', { timeout: 60_000 });
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
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

const strokesShown = (page: Page) => page.evaluate(() => Number(document.querySelector('[data-testid="hud-counter-strokes"]')?.getAttribute('data-count') ?? -1));

/**
 * Snímky v chvílích běhu robota: míření první rány, valení, poslední rána nabitá a zamířená na jamku (kamera se
 * otočí za mířením, `CAMERA_SETTLE_MS`). Na šířku se jamka v záběru jen zapíše – brána je na výšku (`fitTall`).
 */
async function botShots(page: Page, shot: (name: string) => Promise<void>, prefix: string): Promise<void> {
  const strokes = pinned().strokes;
  await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).byHand(true));
  expect((await driveTo(page, strokes[0]!.hold + AIM_SHOT_CHARGE)).runState).toBe('running');
  await shot(`${prefix}-aim`);
  expect((await driveTo(page, strokes[0]!.tap + ROLL_SHOT_DELAY)).runState).toBe('running');
  await shot(`${prefix}-roll`);
  expect((await driveTo(page, strokes.at(-1)!.tap - 1)).runState).toBe('running');
  await page.waitForTimeout(CAMERA_SETTLE_MS);
  test.info().annotations.push({ type: `${prefix}-hole-in-view`, description: JSON.stringify(await inView(page)) });
  await shot(`${prefix}-hole`);
  await restart(page);
}

/** Rány v záznamu sondy (`TAP`). */
const tapsOf = (page: Page) => page.evaluate((tap) => (window.__playShell as unknown as ArcadeProbe).capture().inputs.filter((event) => (event.buttons & tap) !== 0).length, BUTTON.TAP);

test.describe('minigolf (P68V T9)', () => {
  let url = '';

  test.beforeAll(async ({ request }) => {
    url = await publishFixture(request);
    mkdirSync(SHOTS, { recursive: true });
  });

  test('minigolf: the game opens, plays to a win by touch and keys, strokes count (P68V T9)', async ({ page, context, browserName }, info) => {
    test.setTimeout(600_000);
    const touch = info.project.name !== 'chromium';
    const shot = shooter(page, info);
    const errors = watchErrors(page);
    const strokes = pinned().strokes;

    await openGame(page, url);
    await settled(page);
    const shown = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
    expect(shown).toEqual(expect.arrayContaining(['strokes', 'par']));
    for (const label of shown) expect(LABELS).toContain(label);
    expect(await strokesShown(page)).toBe(0);
    expect((await inView(page)).ball, 'the ball is in view at the tee').toBe(true);
    await shot('start');

    if (touch) {
      // Začátek tahu: 50 % šířky, 40 % výšky scény – pod spodní hranou horního pásu HUD, na vrstvě natažení. Štítek
      // ducha „Best run“ (sdílený `Ghost.tsx`) leží nad míčkem a dotyk chytá (`integration.md`); kryje-li bod, prst
      // začne o 10 % výšky níž (tah smí začít kdekoli ve vrstvě) a zakrytí se zapíše.
      const stage = (await page.getByTestId('arcade-stage').boundingBox())!;
      const band = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('.play-hud-progress, .play-hud-corner, .play-hud-goal')].map((node) => node.getBoundingClientRect().bottom)));
      const startAt = () =>
        page.evaluate(
          ({ x, ys }) => {
            let blockedBy: string | null = null;
            for (const y of ys) {
              const hit = document.elementFromPoint(x, y);
              if (hit?.closest('[data-testid="minigolf-pull"]') != null) return { x, y, blockedBy };
              blockedBy ??= hit?.getAttribute('data-testid') ?? hit?.tagName ?? 'nothing';
            }
            return { x, y: ys[0]!, blockedBy };
          },
          { x: Math.round(stage.x + stage.width * 0.5), ys: [0.4, 0.5, 0.6].map((share) => Math.round(stage.y + stage.height * share)) },
        );
      const tee = await startAt();
      expect(tee.y, `pull start below the top HUD band (${String(band)} px)`).toBeGreaterThan(band);
      expect(tee.blockedBy, 'the pull start at the tee lands on the pull layer').toBeNull();
      let [cx, cy] = [tee.x, tee.y];
      const blocked: { readonly putt: number; readonly by: string }[] = [];
      const fingers = new Fingers(browserName === 'chromium' ? await context.newCDPSession(page) : null, page);

      let wants = await page.evaluate(() => {
        const shell = window.__playShell as unknown as ArcadeProbe;
        shell.byHand(true);
        return shell.botWants();
      });
      let last: Now = { runState: 'running', tick: 0, score: 0 };
      /** Osa kamery při stisku (`data-axis` vrstvy, `minigolfCameraAxis`): z míčku na cíl trasy, míření ji nehýbe. */
      let base = 0;
      let axis = 0;
      let charge = 0;
      let putts = 0;
      let most = 0;
      let meterSeen = false;
      let aimShot = false;
      let holeShot = false;
      let rollShotAt = -1;
      while (last.runState === 'running' && last.tick < 6000) {
        const tap = wants !== null && (wants.buttons & BUTTON.TAP) !== 0;
        const hold = wants !== null && (wants.buttons & BUTTON.HOLD) !== 0;
        if (tap && fingers.has(FINGER)) {
          // Robot pouští: prst se zvedne, rána letí s nabitím, které tah držel.
          await fingers.lift(FINGER);
          putts += 1;
          if (rollShotAt < 0) rollShotAt = last.tick + 1 + ROLL_SHOT_DELAY;
          await frames(page);
        } else if (hold) {
          // Robot nabíjí: natažení o jedno nabití dál ve směru jeho osy (od míření při stisku).
          if (!fingers.has(FINGER)) {
            const at = await startAt();
            if (at.blockedBy !== null) blocked.push({ putt: putts + 1, by: at.blockedBy });
            [cx, cy] = [at.x, at.y];
            base = Number(await page.getByTestId('minigolf-pull').getAttribute('data-axis'));
            await fingers.press(FINGER, cx, cy);
            charge = 0;
          }
          axis = wants!.axis;
          charge += 1;
          const pull = pullFor(base, axis, charge);
          await fingers.move(FINGER, cx + pull.dx, cy + pull.dy);
          await frames(page);
          if (charge === AIM_SHOT_CHARGE) {
            await expect(page.getByTestId('minigolf-pull')).toHaveAttribute('data-pulling', 'true');
            meterSeen ||= await page.getByTestId('minigolf-power').isVisible();
            if (!aimShot) {
              await shot('portrait-aim');
              aimShot = true;
            }
          }
          if (charge === HOLE_SHOT_CHARGE && putts === strokes.length - 1 && !holeShot) {
            // Poslední rána z rohu, prst táhne a osa míří na jamku: míček i jamka v záběru na výšku.
            await page.waitForTimeout(CAMERA_SETTLE_MS);
            expect(await inView(page), 'ball and hole in view in portrait while pulling the last putt').toEqual({ ball: true, hole: true });
            await shot('portrait-hole');
            holeShot = true;
          }
        }
        // Tik; dokud robot nic nedrží ani nepouští (míček se valí, robot čeká), tiky běží v jednom volání.
        const stop = rollShotAt > last.tick ? rollShotAt : Number.MAX_SAFE_INTEGER;
        const next = await page.evaluate(
          ({ stop, mask }) => {
            const shell = window.__playShell as unknown as ArcadeProbe;
            let now = shell.tickByHand();
            let w = now.runState === 'running' ? shell.botWants() : null;
            for (let k = 0; k < 60 && now.runState === 'running' && now.tick < stop && (w === null || (w.buttons & mask) === 0); k += 1) {
              now = shell.tickByHand();
              w = now.runState === 'running' ? shell.botWants() : null;
            }
            return { now, wants: w };
          },
          { stop: hold ? -1 : stop, mask: BUTTON.HOLD | BUTTON.TAP },
        );
        last = next.now;
        wants = next.wants;
        most = Math.max(most, await strokesShown(page));
        if (rollShotAt >= 0 && last.tick >= rollShotAt) {
          await shot('portrait-roll');
          rollShotAt = Number.MAX_SAFE_INTEGER;
        }
      }
      await fingers.lift(FINGER);
      most = Math.max(most, await strokesShown(page));
      test.info().annotations.push({ type: 'touch-run', description: JSON.stringify({ ...last, putts, most, meterSeen, holeShot, blocked }) });
      expect(putts, 'the finger pulled back and let go').toBeGreaterThanOrEqual(1);
      expect(meterSeen, 'the power meter showed while pulling').toBe(true);
      expect(holeShot, 'the last putt started with ball and hole in view').toBe(true);
      expect(most, 'Strokes counter in the DOM reached at least 1').toBeGreaterThanOrEqual(1);
      expect(last.runState, `ended at tick ${String(last.tick)}`).toBe('won');
    } else {
      // Klávesy: šipka doprava otočí míření, mezerník držený nabije, puštěný odpálí – vstup v záznamu, Strokes = 1.
      await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).start());
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(300);
      await page.keyboard.up('ArrowRight');
      await page.keyboard.down(' ');
      await expect.poll(() => page.getByTestId('minigolf-power').getAttribute('aria-valuenow').then(Number), { timeout: 5_000 }).toBeGreaterThan(0);
      await page.waitForTimeout(400);
      await page.keyboard.up(' ');
      await expect.poll(() => strokesShown(page), { timeout: 5_000 }).toBe(1);
      const keyed = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).capture().inputs);
      expect(keyed.some((event) => (event.buttons & BUTTON.HOLD) !== 0 && event.axis > 0), 'Space held = HOLD with the turned aim').toBe(true);
      expect(keyed.some((event) => (event.buttons & BUTTON.TAP) !== 0 && event.axis > 0), 'Space let go = TAP with the turned aim').toBe(true);
      await expect(page.getByTestId('play-postrun')).toBeHidden();

      await restart(page);
      await botShots(page, shot, 'landscape');
      await page.evaluate(() => {
        const shell = window.__playShell as unknown as ArcadeProbe;
        shell.byHand(false);
        shell.hold(0);
        shell.press(0);
      });
      const end = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).handPlay('end'));
      expect(end.runState).toBe('won');
      expect(await tapsOf(page), 'the bot record putted as often as in Node').toBe(strokes.length);
    }

    await expect(page.getByTestId('play-postrun')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('play-postrun')).toContainText('You did it!');
    await shot(touch ? 'portrait-result' : 'landscape-result');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('minigolf: an idle player never putts and loses (P68V T9)', async ({ page }, info) => {
    test.setTimeout(300_000);
    const touch = info.project.name !== 'chromium';
    const errors = watchErrors(page);
    // Telefon tady na šířku: snímky míření, valení a jamky na šířku (na výšku jsou v testu výš).
    if (touch) {
      const size = page.viewportSize()!;
      await page.setViewportSize({ width: Math.max(size.width, size.height), height: Math.min(size.width, size.height) });
    }
    await openGame(page, url);
    await settled(page);
    if (touch) await botShots(page, shooter(page, info), 'landscape');
    const end = await page.evaluate(() => {
      const shell = window.__playShell as unknown as ArcadeProbe;
      shell.byHand(false);
      return shell.idleRun();
    });
    expect(end.runState).toBe('lost');
    expect(await tapsOf(page), 'the idle player never putted').toBe(0);
    const postrun = page.getByTestId('play-postrun');
    await expect(postrun).toBeVisible({ timeout: 30_000 });
    await expect(postrun).toContainText(/Try again!|So close\./);
    await expect(postrun).not.toContainText('You did it!');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('minigolf: the bot record replayed from tick 0 in the browser gives the Node hash (P68V T9)', async ({ page }, info) => {
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

  test('minigolf: 10 s from the bot demo stay smooth on the host (P68V T9, FPS gate on chromium)', async ({ page }, info) => {
    test.setTimeout(300_000);
    const gated = info.project.name === 'chromium';
    const node = pinned().node;
    await openGame(page, url);
    await settled(page);
    // Hraje ukázka robota v reálném čase (karta pauzy → „Show me how“), tatáž cesta kreslení jako hráč.
    await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).start());
    await page.getByTestId('play-pause').click();
    await page.getByTestId('play-demo-start').click();
    await page.waitForFunction(() => (window.__playShell as unknown as ArcadeProbe).tick() > 0, undefined, { timeout: 30_000 });
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
        fromTick,
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
      demoTicks: node.tick,
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
    // Ukázka v okně opravdu doběhla: celá jamka robota (`node.tick` tiků od tiku 0) se odehrála uvnitř okna.
    expect(measured.fromTick + measured.ticks, 'the whole demo hole was played inside the window').toBeGreaterThanOrEqual(node.tick);
    if (gated) {
      expect(entry.medianFps, `median FPS ${JSON.stringify(entry)}`).toBeGreaterThanOrEqual(FPS_GATE.medianFps);
      expect(entry.p95FrameMs, `p95 frame ms ${JSON.stringify(entry)}`).toBeLessThanOrEqual(FPS_GATE.p95Ms);
    }
  });
});
