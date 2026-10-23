import { type CDPSession, expect, type Page, test } from '@playwright/test';

import { AXIS_MAX, BUTTON, type ArcadeInput } from '../src/play/arcade/contract';
import { DIRECTIONS, directionOfAxis } from '../src/play/arcade/pieces/arena';
import { arenaGenre } from '../src/play/genre/arena';
import { compileGenre, readGenreSpec } from '../src/play/genre/index';
import { platformerGenre } from '../src/play/genre/platformer';
import { questGenre } from '../src/play/genre/quest';
import { runnerGenre } from '../src/play/genre/runner';
import { voyageGenre } from '../src/play/genre/voyage';
import type { GameSpecV1 } from '../src/play/spec';

/**
 * Každý žánr jde na telefonu dohrát jen prstem (P36C T4). Pixel 7 s dotykem,
 * žádná klávesnice. Kam jít, říká robot ověřovače přes sondu (`bot-hand.ts`):
 * co by teď stiskl, to test zahraje skutečným gestem přes CDP (tah, ťuk, držení,
 * druhý prst) a odtiká tik. Hodiny jsou ruční, takže běh nezávisí na zátěži
 * stroje; převod gesto → vstup je ten, který má hráč. Hra vyhraje, nebo
 * dojde aspoň do půlky trati.
 *
 * Musí zčervenat na kódu před T1: tam dotyk běžce skočil už při položení
 * prstu, takže každý tah do pruhu byl i skok.
 */

const GAMES = [
  { genre: 'runner', control: 'runner', module: runnerGenre, sentence: 'a fox runs through a forest dodging logs and rocks' },
  { genre: 'platformer', control: 'platform', module: platformerGenre, sentence: 'a frog hops across platforms to reach the flag' },
  { genre: 'arena', control: 'move_free', module: arenaGenre, sentence: 'a cat collects fish in a garden while dogs chase it' },
  { genre: 'quest', control: 'move_free', module: questGenre, sentence: 'a knight lights the torches in a dark castle' },
  { genre: 'voyage', control: 'steer', module: voyageGenre, sentence: 'a pirate ship races between islands to the treasure' },
] as const;

type Wants = ArcadeInput;
interface Tick {
  readonly runState: string;
  readonly tick: number;
  readonly progress: number;
  readonly wants: Wants | null;
}
/** Sonda hry gesty (`ArcadePlay.tsx`, P36C T4). */
interface HandProbe {
  byHand(on: boolean): void;
  botWants(): Wants | null;
  tickByHand(): Omit<Tick, 'wants'>;
  inputs(): readonly unknown[];
}

function gameSpecOf(game: (typeof GAMES)[number]): GameSpecV1 {
  const read = readGenreSpec({ hero: 'fox', ...(game.module.draftFill(game.sentence, null) as object) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

/**
 * Prsty na skle: CDP dostane vždy celou sadu, co se změnilo, dopočítá sám. WebKit CDP nemá (P58C T4) –
 * tam jde každý prst jako dotykové `PointerEvent` na prvek pod ním, tytéž události, které hra čte.
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
  where(id: number): { x: number; y: number } | undefined {
    return this.down.get(id);
  }
  private points() {
    return [...this.down].map(([id, at]) => ({ id, x: at.x, y: at.y }));
  }
  /** Dotyk drží cíl z položení prstu (implicitní zachycení), proto pohyb i zvednutí jdou tam, ne pod prst. */
  private pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', id: number, x: number, y: number): Promise<void> {
    return this.page.evaluate(
      ({ type, id, x, y }) => {
        const own = window as unknown as { __fingers?: Map<number, Element> };
        if (own.__fingers === undefined) {
          // Skutečný prst je aktivní ukazatel; syntetický WebKit nezná a `setPointerCapture` (držené tlačítko akce)
          // by na něm hodil `NotFoundError`. Zachycení tu dělá sám ovladač – pohyb a zvednutí jdou na cíl položení.
          const capture = Element.prototype.setPointerCapture;
          Element.prototype.setPointerCapture = function (this: Element, pointerId: number) {
            if (!own.__fingers?.has(pointerId)) capture.call(this, pointerId);
          };
        }
        const held = (own.__fingers ??= new Map());
        const target = type === 'pointerdown' ? document.elementFromPoint(x, y) : held.get(id);
        if (target == null) return;
        if (type === 'pointerdown') held.set(id, target);
        if (type === 'pointerup') held.delete(id);
        const isPrimary = type === 'pointerdown' ? held.size === 1 : [...held.keys()][0] === id;
        target.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true }));
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
    // `touchEnd` pustí v Chromu všechny prsty: po ťuku druhým palcem by běžící palec plošinovky „zvedl“ i ten
    // držený a hra by stála (prohra na čas ve 39 %). Prst, který zbývá na skle, pošle CDP jako `touchMove`
    // – chybějící bod pak pustí sám (rozdíl proti předchozí události).
    const rest = this.points();
    await this.cdp.send('Input.dispatchTouchEvent', rest.length === 0 ? { type: 'touchEnd', touchPoints: [] } : { type: 'touchMove', touchPoints: rest });
  }
  async tap(id: number, x: number, y: number): Promise<void> {
    await this.press(id, x, y);
    await this.lift(id);
  }
}

const MOVE = 1;
const SECOND = 2;
const ACTION = 3;

/** Jedno přání robota → gesta žánru. Prst `MOVE` drží pohyb, `SECOND` je druhý palec, `ACTION` tlačítko na ploše. */
async function playWants(page: Page, fingers: Fingers, control: string, wants: Wants, stage: { x: number; y: number; width: number; height: number }): Promise<void> {
  const at = (fx: number, fy: number) => [stage.x + stage.width * fx, stage.y + stage.height * fy] as const;
  const [cx, cy] = at(0.5, 0.45);
  if (control === 'runner') {
    // Tah 45 px rozhodne pruh nebo skluz, ťuk (puštění hned) skočí.
    const swipe = async (dx: number, dy: number) => {
      await fingers.press(MOVE, cx, cy);
      await fingers.move(MOVE, cx + dx, cy + dy);
      await fingers.lift(MOVE);
    };
    if ((wants.buttons & BUTTON.LEFT) !== 0) await swipe(-45, 0);
    else if ((wants.buttons & BUTTON.RIGHT) !== 0) await swipe(45, 0);
    else if ((wants.buttons & BUTTON.DOWN) !== 0) await swipe(0, 45);
    else if ((wants.buttons & (BUTTON.TAP | BUTTON.UP)) !== 0) await fingers.tap(MOVE, cx, cy);
    return;
  }
  if (control === 'platform') {
    // Levá čtvrtina běží vlevo, druhá vpravo, pravá půlka skáče; prst zná jen plný běh.
    const side = Math.abs(wants.axis) < AXIS_MAX / 4 ? 0 : Math.sign(wants.axis);
    const [rx, ry] = at(side < 0 ? 0.12 : 0.37, 0.45);
    if (side === 0) await fingers.lift(MOVE);
    else if (fingers.where(MOVE)?.x !== rx) {
      await fingers.lift(MOVE);
      await fingers.press(MOVE, rx, ry);
    }
    if ((wants.buttons & BUTTON.TAP) !== 0) await fingers.tap(SECOND, ...at(0.8, 0.45));
    return;
  }
  if (control === 'steer') {
    // Tah do strany: plný rejd po 90 px; druhý prst brzdí.
    if (!fingers.has(MOVE)) await fingers.press(MOVE, cx, cy);
    await fingers.move(MOVE, Math.round(cx + (wants.axis / AXIS_MAX) * 90), cy);
    if ((wants.buttons & BUTTON.DOWN) !== 0) {
      if (!fingers.has(SECOND)) await fingers.press(SECOND, ...at(0.5, 0.2));
    } else await fingers.lift(SECOND);
    return;
  }
  // Aréna a úkol: plovoucí joystick – tah 70 px ve směru osy; tlačítko akce drží `ACTION`.
  const hold = wants.buttons & (BUTTON.INTERACT | BUTTON.ATTACK);
  if (hold !== 0) {
    await fingers.lift(MOVE);
    if (!fingers.has(ACTION)) {
      const button = page.getByTestId((hold & BUTTON.INTERACT) !== 0 ? 'arcade-use' : 'arcade-attack');
      const box = (await button.boundingBox())!;
      await fingers.press(ACTION, box.x + box.width / 2, box.y + box.height / 2);
    }
    return;
  }
  await fingers.lift(ACTION);
  if (wants.axis === 0) {
    await fingers.lift(MOVE);
    if ((wants.buttons & BUTTON.TAP) !== 0) await fingers.tap(SECOND, cx, cy);
    return;
  }
  const dir = DIRECTIONS[directionOfAxis(wants.axis)]!;
  const [tx, ty] = [Math.round(cx + dir.dx * 70), Math.round(cy - dir.dz * 70)];
  if (!fingers.has(MOVE)) await fingers.press(MOVE, cx, cy);
  await fingers.move(MOVE, tx, ty);
}

test.describe('touch only', () => {
  test.setTimeout(300_000);

  for (const game of GAMES) {
    test(`${game.genre}: won with gestures alone, or at least half the way`, async ({ page, request, context, browserName }) => {
      const response = await request.post('/api/play/games', { data: { spec: gameSpecOf(game) } });
      expect(response.status(), await response.text()).toBeLessThan(300);
      const { url } = (await response.json()) as { url: string };
      await page.goto(url);
      await page.waitForFunction(() => window.__playFrame?.().hero != null && window.__playShell !== undefined, undefined, { timeout: 90_000 });
      const stageEl = page.getByTestId('arcade-stage');
      await expect(stageEl).toHaveAttribute('data-control', game.control);
      const stage = (await stageEl.boundingBox())!;
      const fingers = new Fingers(browserName === 'chromium' ? await context.newCDPSession(page) : null, page);
      const wants0 = await page.evaluate(() => {
        const shell = window.__playShell as unknown as HandProbe;
        shell.byHand(true);
        return shell.botWants();
      });
      let last: Tick = { runState: 'running', tick: 0, progress: 0, wants: wants0 };
      // 6 000 tiků = 100 s, nad nejdelší hru (90 s).
      while (last.runState === 'running' && last.tick < 6000 && last.wants !== null) {
        await playWants(page, fingers, game.control, last.wants, stage);
        last = await page.evaluate(() => {
          const shell = window.__playShell as unknown as HandProbe;
          const now = shell.tickByHand();
          return { ...now, wants: now.runState === 'running' ? shell.botWants() : null };
        });
      }
      // Hrál prst: do záznamu vstupů nepíše robot ani klávesnice, jen gesta.
      const recorded = await page.evaluate(() => (window.__playShell as unknown as HandProbe).inputs().length);
      console.log(`${game.genre}: ${last.runState} at tick ${last.tick}, progress ${last.progress} %, ${recorded} inputs`);
      expect(recorded).toBeGreaterThan(0);
      if (game.control === 'runner') {
        // T1: tah do pruhu nebo dolů není skok. Před T1 položení prstu skočilo, takže tah nesl i TAP – robot to
        // na téhle trati dorovná a vyhraje, proto se to hlídá přímo v záznamu.
        const swipes = await page.evaluate(() => (window.__playShell as unknown as { inputs(): readonly { tick: number; buttons: number }[] }).inputs());
        const jumpy = swipes.filter((input) => (input.buttons & (BUTTON.LEFT | BUTTON.RIGHT | BUTTON.DOWN)) !== 0 && (input.buttons & BUTTON.TAP) !== 0);
        expect(jumpy, `swipes that also jumped: ${JSON.stringify(jumpy)}`).toEqual([]);
      }
      expect(last.runState === 'won' || last.progress >= 50, `${last.runState} at tick ${last.tick}, ${last.progress} % of the way`).toBe(true);
    });
  }
});

// P58C T6: souboj ukáže zóny „Dodge“ a „Strike“ na výšce, kde stál i přepínač Quick | Full detail – porotce
// ovládání neviděl (T5, 3/3 soudci). Překryv je vidět jen s dotykem: bez něj zóny nejsou.
test('duel: the Quick | Full detail switch leaves the touch zones readable', async ({ page, request }) => {
  const created = await request.post('/api/play/games', { data: { sentence: 'A knight fights a three-headed hydra at the castle gates.' } });
  expect(created.status(), await created.text()).toBeLessThan(300);
  const { url } = (await created.json()) as { url: string };
  await page.route('**/api/play/games/*/upgrade', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { status: 'pending', deadlineAt: new Date(Date.now() + 285_000).toISOString() } }) : route.continue(),
  );
  await page.goto(url);
  await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-control', 'duel', { timeout: 90_000 });
  const notice = page.getByTestId('upgrade-state');
  await expect(notice).toHaveAttribute('data-kind', 'working', { timeout: 15_000 });
  const zones = page.locator('.play-touch-zone');
  await expect(zones).toHaveCount(2);
  // Karta „Tap to start“ se staví podle hrdiny každý snímek tiku 0 – pod hrdinou na přepínač ani zóny nesmí.
  await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-prompt-at', /.+/, { timeout: 15_000 });
  await page.waitForTimeout(500);
  const named = async (name: string, locator: typeof notice) => ({ name, ...(await locator.boundingBox())! });
  const pieces = [await named('switch', notice), await named('Tap to start', page.getByTestId('play-first-prompt'))];
  for (const zone of await zones.all()) pieces.push(await named(`zone ${String(await zone.textContent())}`, zone));
  for (const [i, a] of pieces.entries()) {
    for (const b of pieces.slice(i + 1)) {
      const overlaps = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlaps, `${a.name} ${JSON.stringify(a)} overlaps ${b.name} ${JSON.stringify(b)}`).toBe(false);
    }
  }
  // Cíl souboje (69 znaků) uťala na telefonu výpustka uprostřed pokynu („Beat 9 three-…“) – celý se vejde do dvou řádků.
  const goal = page.getByTestId('play-goal');
  await expect(goal).toContainText('three-headed');
  // Výpustka jednoho řádku ořízne do šířky, dvou řádků do výšky – celý text nepřeteče ani jedním směrem.
  const fits = await goal.evaluate((el) => `${String(el.scrollWidth)}×${String(el.scrollHeight)} in ${String(el.clientWidth)}×${String(el.clientHeight)}: ${String(el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)}`);
  expect(fits).toMatch(/true$/);
});
