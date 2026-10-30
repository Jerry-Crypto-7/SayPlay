import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { devices, expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';

import { browserRenderer } from '../scripts/browser-renderer';

/**
 * Feed `/play` na telefonu proti běžícímu `next start` (P54A T15): prázdné úložiště,
 * jen vestavěný pool – žádné `page.route`, řádky i detaily jdou skutečnými dveřmi.
 *
 * Pixel 7 (412×915, dotyk) s CPU ×4 přes CDP: deset tahů karty nahoru skutečným
 * dotykem (CDP), u každé karty čeká na běžící náhled robota (`mode: 'preview'`,
 * tik roste, kreslí se), změří dosednutí → náhled a FPS a uloží snímek obrazovky.
 * Třetí kartu ťukem převezme, 5 s ji hraje gesty jejího ovládání (`data-control`)
 * a pak „Next“. Totéž na desktopu 1440×900 kolečkem, klikem a klávesami.
 *
 * Výstup `evals/play/feed/phone-check-2026-10-20/` (snímky + `report.json`). Pouští
 * se proti už běžícímu serveru (README `evals/play/feed/`):
 *
 *   FALLBACK_SMOKE_URL=http://127.0.0.1:3291 npx playwright test e2e/play-feed-phone.spec.ts
 *
 * Tvrdí oracle T15: každá karta jiná hra v běžícím náhledu, jedno plátno feedu
 * (`contexts === 1`), ťuk → `play`, hra po gestech reaguje (vstupy přibyly, tik běží)
 * a feed při hraní stojí – na telefonu ani po svislém tahu po kroužku joysticku (P64 T7) –, scéna se mezi dvěma
 * snímky mění (prázdné plátno ne),
 * na obrazovce žádný český řetězec. Časy se zapisují a porovnávají s `after-t8.json`.
 */

// Vlastní `launchOptions` přepíše ty z konfigurace – bez `browserRenderer()` by plátno kreslil SwiftShader (~3 FPS)
// a bez `--disable-features=OpenXR` by Chromium na počítači s runtime VR (SteamVR) hlásil brýle (P67 T4a).
test.use({ launchOptions: { args: [...browserRenderer().args, '--disable-features=OpenXR'] } });

const OUT = join('evals', 'play', 'feed', 'phone-check-2026-10-20');
const SWIPES = 10;
/** Třetí karta (index 2) se ťukem převezme a hraje. */
const PLAY_AT = 2;
const PLAY_MS = 5_000;
const FPS_MS = 2_000;
/** Na náhled jedné karty se čeká nejvýš tolik (T8 na telefonu max 9 s). */
const PREVIEW_TIMEOUT_MS = 45_000;
/**
 * Podíl pixelů plátna, které se proti prvnímu snímku změnily (některý kanál o > 16), větší ze dvou
 * odstupů 1 s a 2 s. Snímky jsou bez vrstev nad plátnem (`CANVAS_ONLY`) – odpočet v HUD by jinak
 * „hýbal“ i zamrzlým plátnem (s HUD dal rytmus 0,28 %, skoro jen číslice). Rytmus s řídkými notami
 * dal za 1 s jen 0,18 %, proto dva odstupy. Prázdné nebo zamrzlé plátno = 0.
 */
const MIN_CHANGED_SHARE = 0.0005;
const SCENE_GAP_MS = 1_000;
/** Při snímku pro `sceneChange` skryje vše nad plátnem: HUD, výzvu, okraj feedu, lištu (plátno leží ve slotu aktivní scény). */
const CANVAS_ONLY = '[data-testid="feed-current"] *:not(canvas):not(:has(canvas)), [data-testid="feed-rail"], .play-tabbar { visibility: hidden !important; }';
/** Cíle T8 (`evals/play/feed/README.md`): dosednutí → běžící náhled, p50. */
const T8_TARGET_MS = { desktop: 300, phone: 500 } as const;

// Kopie lexikálního filtru `play-language.spec.ts` (ten ho neexportuje a import ze specu by zaregistroval jeho testy).
const CZECH_LETTERS = /[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u;
const CZECH_WORDS = ['stavba', 'pravidla', 'cil', 'tik', 'stav', 'nic', 'hrac', 'svet', 'spojitou', 'dynamiku', 'hybnost'];
const findCzech = (text: string): string[] => [...new Set(text.split(/[^\p{L}]+/u).filter((word) => word !== '' && (CZECH_LETTERS.test(word) || CZECH_WORDS.includes(word.toLowerCase()))))];

interface Fps {
  readonly fpsP50: number | null;
  readonly fpsP5: number | null;
  readonly drawnFps: number;
}

/** Jeden přechod viděný ve stránce po snímcích (časy `performance.now()`). */
interface Swap {
  readonly from: string | null;
  readonly to: string | null;
  readonly startedAt: number;
  /** Poslední puštění prstu / myši nebo kolečko po začátku sledování. */
  readonly releaseAt: number | null;
  readonly clickAt: number | null;
  /** `scrollend` feedu před přepnutím aktivní karty – dosednutí po tahu. */
  readonly scrollendAt: number | null;
  /** Sonda feedu ukázala jinou hru. */
  readonly switchedAt: number | null;
  /** Karta nové hry v `preview` s připojenou hrou. */
  readonly shownAt: number | null;
  /** První snímek, ve kterém se tik náhledu posunul a kreslilo se. */
  readonly runningAt: number | null;
  readonly timedOut: boolean;
}

interface PhoneProbe {
  lastDrawAt: number;
  /** Různé WebGL kontexty za dobu stránky (obal `getContext`). */
  glContexts: number;
  swap: Promise<Swap> | null;
  watch(from: string | null, timeoutMs: number): void;
  fps(ms: number): Promise<Fps>;
}

declare global {
  interface Window {
    __feedPhone?: PhoneProbe;
  }
}

/** Běží v prohlížeči před kódem stránky. Musí být soběstačný – serializuje se jako text. */
function installPhoneProbe(): void {
  const seen = new WeakSet<object>();
  let drawsThisFrame = 0;
  const marks = { release: null as number | null, click: null as number | null, scrollend: null as number | null };
  const probe: PhoneProbe = {
    lastDrawAt: 0,
    glContexts: 0,
    swap: null,
    watch(from, timeoutMs) {
      marks.release = null;
      marks.click = null;
      marks.scrollend = null;
      probe.swap = new Promise<Swap>((resolve) => {
        const startedAt = performance.now();
        let to: string | null = null;
        let switchedAt: number | null = null;
        let scrollendAt: number | null = null;
        let shown: { at: number; tick: number } | null = null;
        const done = (runningAt: number | null) =>
          resolve({ from, to, startedAt, releaseAt: marks.release, clickAt: marks.click, scrollendAt, switchedAt, shownAt: shown?.at ?? null, runningAt, timedOut: runningAt === null });
        const frame = () => {
          const t = performance.now();
          const now = window.__playFeed?.();
          if (now !== undefined && switchedAt === null && now.versionId !== null && now.versionId !== from) {
            switchedAt = t;
            to = now.versionId;
            scrollendAt = marks.scrollend;
          }
          if (now !== undefined && switchedAt !== null && shown === null && now.versionId === to && now.mode === 'preview' && document.querySelector('[data-testid="feed-current"] .play-shell') !== null) {
            shown = { at: t, tick: now.tick };
          }
          if (now !== undefined && shown !== null && now.versionId === to && now.tick > shown.tick && probe.lastDrawAt > shown.at) {
            done(probe.lastDrawAt);
            return;
          }
          if (t - startedAt > timeoutMs) done(null);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    },
    fps(ms) {
      return new Promise<Fps>((resolve) => {
        const intervals: number[] = [];
        let drawn = 0;
        let last = 0;
        const started = performance.now();
        const quantile = (q: number) => {
          if (intervals.length === 0) return null;
          const sorted = [...intervals].sort((a, b) => a - b);
          return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
        };
        drawsThisFrame = 0;
        const tick = (now: number) => {
          if (last > 0) intervals.push(now - last);
          if (drawsThisFrame > 0) drawn += 1;
          drawsThisFrame = 0;
          last = now;
          if (now - started < ms) {
            requestAnimationFrame(tick);
            return;
          }
          const p50 = quantile(0.5);
          const p95 = quantile(0.95);
          resolve({ fpsP50: p50 === null ? null : 1000 / p50, fpsP5: p95 === null ? null : 1000 / p95, drawnFps: (drawn * 1000) / (now - started) });
        };
        requestAnimationFrame(tick);
      });
    },
  };
  for (const kind of ['touchend', 'pointerup', 'wheel']) window.addEventListener(kind, (event) => void (marks.release = event.timeStamp), { capture: true, passive: true });
  window.addEventListener('click', (event) => void (marks.click = event.timeStamp), true);
  window.addEventListener(
    'scrollend',
    (event) => {
      if (event.target instanceof Element && event.target.getAttribute('data-testid') === 'feed-reel') marks.scrollend = event.timeStamp;
    },
    true,
  );
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    const context = (getContext as (...args: unknown[]) => unknown).call(this, kind, ...rest);
    if ((kind === 'webgl2' || kind === 'webgl') && context !== null && typeof context === 'object' && !seen.has(context)) {
      seen.add(context);
      probe.glContexts += 1;
    }
    return context;
  } as typeof HTMLCanvasElement.prototype.getContext;
  for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype] as unknown as Record<string, (...args: unknown[]) => unknown>[]) {
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const original = proto[name];
      if (typeof original !== 'function') continue;
      proto[name] = function (this: object, ...args: unknown[]) {
        drawsThisFrame += 1;
        probe.lastDrawAt = performance.now();
        return original.apply(this, args);
      };
    }
  }
  window.__feedPhone = probe;
}

const feedProbe = (page: Page) => page.evaluate(() => window.__playFeed!());
const stage = (page: Page): Locator => page.getByTestId('feed-current').getByTestId('arcade-stage');

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('no box');
  return box;
}

/** Aktivní karta dosedla v okně feedu (jako `play-feed-reels.spec.ts`). */
async function expectSnapped(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const reel = document.querySelector('[data-testid="feed-reel"]');
        const card = reel?.querySelector('[data-active="true"]');
        if (reel === null || reel === undefined || card === null || card === undefined) return Number.NaN;
        // `clientTop` je celé číslo, rámeček feedu 2,5 px – dosednutá karta je do 1 px.
        return Math.abs(card.getBoundingClientRect().top - reel.getBoundingClientRect().top - reel.clientTop);
      }),
    )
    .toBeLessThan(1);
}

/** Prsty na skle přes CDP (zkrácený `Fingers` z `play-touch.spec.ts`): CDP dostane vždy celou sadu. */
class Fingers {
  private readonly down = new Map<number, { x: number; y: number }>();
  constructor(private readonly cdp: CDPSession) {}
  private send(type: 'touchStart' | 'touchMove') {
    return this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...this.down].map(([id, at]) => ({ id, ...at })) });
  }
  async press(id: number, x: number, y: number): Promise<void> {
    this.down.set(id, { x, y });
    await this.send('touchStart');
  }
  async move(id: number, x: number, y: number): Promise<void> {
    if (!this.down.has(id)) return;
    this.down.set(id, { x, y });
    await this.send('touchMove');
  }
  async lift(id: number): Promise<void> {
    if (!this.down.delete(id)) return;
    // `touchEnd` pustí v Chromu všechny prsty; zbývající prst jde jako `touchMove` (vzor `play-touch.spec.ts`).
    if (this.down.size === 0) await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    else await this.send('touchMove');
  }
  async tap(id: number, x: number, y: number): Promise<void> {
    await this.press(id, x, y);
    await this.lift(id);
  }
  async liftAll(): Promise<void> {
    for (const id of [...this.down.keys()]) await this.lift(id);
  }
}

/**
 * Tah karty nahoru po scéně. Prst před puštěním 200 ms stojí – `touchEnd` hned po posledním
 * `touchMove` nechá Chromium přes CDP stát na půl cesty (změřeno v `play-feed-reels.spec.ts`).
 */
async function swipeUp(page: Page, fingers: Fingers): Promise<void> {
  const box = await boxOf(stage(page));
  const x = box.x + box.width / 3;
  const from = box.y + box.height * 0.75;
  const to = box.y + box.height * 0.2;
  await fingers.press(1, x, from);
  for (let step = 1; step <= 8; step += 1) await fingers.move(1, x, from + ((to - from) * step) / 8);
  await page.waitForTimeout(200);
  await fingers.lift(1);
}

/**
 * Pět sekund hry prstem podle ovládání karty – gesta, která má hráč dnes (`play-touch.spec.ts`):
 * běžec tah do pruhu a ťuk = skok, plošinovka drží běh vpravo a druhým palcem skáče, řízení drží
 * a táhne do stran, aréna a úkol drží plovoucí joystick a točí směr, ostatní (poletování, rytmus,
 * načasování, střelnice…) ťukají.
 */
async function playByTouch(page: Page, fingers: Fingers, control: string, ms: number): Promise<void> {
  const box = await boxOf(stage(page));
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
  const [cx, cy] = at(0.45, 0.5);
  const end = Date.now() + ms;
  for (let beat = 0; Date.now() < end; beat += 1) {
    if (control === 'runner') {
      const dx = [-45, 45, 0][beat % 3]!;
      await fingers.press(1, cx, cy);
      if (dx !== 0) await fingers.move(1, cx + dx, cy);
      await fingers.lift(1);
    } else if (control === 'platform') {
      if (beat === 0) await fingers.press(1, ...at(0.37, 0.5));
      await fingers.tap(2, ...at(0.8, 0.5));
    } else if (control === 'steer') {
      if (beat === 0) await fingers.press(1, cx, cy);
      await fingers.move(1, cx + (beat % 2 === 0 ? 90 : -90), cy);
    } else if (control === 'move_free' || control === 'fight') {
      const [dx, dy] = ([[70, 0], [0, -70], [-70, 0], [0, 70]] as const)[beat % 4]!;
      if (beat === 0) await fingers.press(1, cx, cy);
      await fingers.move(1, cx + dx, cy + dy);
    } else {
      await fingers.tap(1, cx, cy);
    }
    await page.waitForTimeout(400);
  }
  await fingers.liftAll();
}

/** Desktop: totéž klávesami – šipky a mezerník podle ovládání. */
async function playByKeys(page: Page, control: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  const held = control === 'platform' ? 'ArrowRight' : null;
  if (held !== null) await page.keyboard.down(held);
  for (let beat = 0; Date.now() < end; beat += 1) {
    if (control === 'runner') await page.keyboard.press(['ArrowLeft', 'ArrowRight', 'Space'][beat % 3]!);
    else if (control === 'platform') await page.keyboard.press('Space');
    else if (control === 'steer' || control === 'move_free' || control === 'fight') {
      const key = (control === 'steer' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown'])[beat % (control === 'steer' ? 2 : 4)]!;
      await page.keyboard.down(key);
      await page.waitForTimeout(350);
      await page.keyboard.up(key);
    } else await page.keyboard.press('Space');
    await page.waitForTimeout(250);
  }
  if (held !== null) await page.keyboard.up(held);
}

/** Podíl pixelů, které se mezi dvěma snímky změnily, a průměrná směrodatná odchylka kanálů prvního. */
async function sceneChange(a: Buffer, b: Buffer): Promise<{ changedShare: number; stdev: number }> {
  const [x, y] = await Promise.all([a, b].map((png) => sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
  const stats = await sharp(a).removeAlpha().stats();
  const stdev = stats.channels.reduce((sum, channel) => sum + channel.stdev, 0) / stats.channels.length;
  if (x!.info.width !== y!.info.width || x!.info.height !== y!.info.height) return { changedShare: 1, stdev };
  const pixels = x!.info.width * x!.info.height;
  let changed = 0;
  for (let i = 0; i < pixels; i += 1) {
    const o = i * 3;
    if (Math.abs(x!.data[o]! - y!.data[o]!) > 16 || Math.abs(x!.data[o + 1]! - y!.data[o + 1]!) > 16 || Math.abs(x!.data[o + 2]! - y!.data[o + 2]!) > 16) changed += 1;
  }
  return { changedShare: changed / pixels, stdev };
}

const round = (value: number | null, digits = 1) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);
const stats = (values: readonly (number | null)[], digits = 1) => {
  const numbers = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const mid = Math.floor(numbers.length / 2);
  const p50 = numbers.length % 2 === 1 ? numbers[mid]! : (numbers[mid - 1]! + numbers[mid]!) / 2;
  return { p50: round(p50, digits), min: round(numbers[0]!, digits), max: round(numbers[numbers.length - 1]!, digits) };
};

type Via = 'load' | 'swipe' | 'wheel' | 'next';

interface Card {
  n: number;
  via: Via;
  versionId: string;
  title: string;
  control: string | null;
  /** Puštění prstu / kolečko / klik → dosednutí. */
  releaseToSettleMs: number | null;
  /** Čím se dosednutí určilo: `scrollend` feedu, klik na „Next“ (aktivní karta se přepne hned), přepnutí sondy, načtení stránky. */
  settledBy: 'scrollend' | 'click' | 'switch' | 'navigation';
  settleToShownMs: number | null;
  settleToPreviewMs: number | null;
  releaseToPreviewMs: number | null;
  contexts: number;
  glContexts: number;
  canvases: number;
  fps: Fps;
  changedShare: number;
  stageStdev: number;
  czech: string[];
  screenshot: string;
}

function timings(swap: Swap, via: Via): Pick<Card, 'releaseToSettleMs' | 'settledBy' | 'settleToShownMs' | 'settleToPreviewMs' | 'releaseToPreviewMs'> {
  const release = via === 'next' ? swap.clickAt : swap.releaseAt;
  const [settledBy, settleAt] =
    via === 'load' ? (['navigation', 0] as const) : via === 'next' ? (['click', swap.clickAt] as const) : swap.scrollendAt !== null ? (['scrollend', swap.scrollendAt] as const) : (['switch', swap.switchedAt] as const);
  const since = (from: number | null, to: number | null) => (from === null || to === null ? null : round(to - from));
  return {
    releaseToSettleMs: via === 'load' || via === 'next' ? null : since(release, settleAt),
    settledBy,
    settleToShownMs: since(settleAt, swap.shownAt),
    settleToPreviewMs: since(settleAt, swap.runningAt),
    releaseToPreviewMs: via === 'load' ? null : since(release, swap.runningAt),
  };
}

/** Přidá výsledek profilu do `report.json` (desktop a telefon jdou jako dva testy za sebou). */
function writeReport(profile: string, result: Record<string, unknown>): void {
  const file = join(OUT, 'report.json');
  const report = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  const t8 = JSON.parse(readFileSync(join('evals', 'play', 'feed', 'after-t8.json'), 'utf8')) as { results: Record<string, { summary: Record<string, unknown> }> };
  const results = { ...((report.results as Record<string, unknown> | undefined) ?? {}), [profile]: result };
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        version: 'p54a-feed-phone-v1',
        note:
          'Built app (next start, webpack), empty PLAY_STORE_DIR, built-in pool only, real GPU. Phone = Pixel 7 emulation 412×915 with touch, CPU ×4 via CDP; desktop 1440×900, CPU ×1. Per card: release of the finger/wheel/click → settle (scrollend of the feed; for Next the click, the active card switches at once) → card in preview (settleToShownMs) → first frame with an advancing preview tick and a draw call (settleToPreviewMs, comparable to T8 swapToPreviewMs). FPS = 2 s of the running bot preview. changedShare = share of canvas pixels changed against the first shot, the larger of 1 s and 2 s later, overlays (HUD, hint, rail) hidden; stageStdev = colour spread of the first shot.',
        t8: {
          source: 'evals/play/feed/after-t8.json',
          targetSettleToPreviewP50Ms: T8_TARGET_MS,
          desktop: { swapToPreviewMs: t8.results.desktop?.summary.swapToPreviewMs, fpsP50: t8.results.desktop?.summary.fpsP50, contextsCreated: t8.results.desktop?.summary.contextsCreated },
          phone: { swapToPreviewMs: t8.results['pixel7-cpu4']?.summary.swapToPreviewMs, fpsP50: t8.results['pixel7-cpu4']?.summary.fpsP50, contextsCreated: t8.results['pixel7-cpu4']?.summary.contextsCreated },
        },
        results,
      },
      null,
      2,
    )}\n`,
  );
}

async function feedCheck(page: Page, profile: 'phone' | 'desktop', cpu: number): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(installPhoneProbe);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  const fingers = new Fingers(cdp);
  const cards: Card[] = [];
  let play: Record<string, unknown> | null = null;
  const result = () => {
    const moved = cards.filter((card) => card.via !== 'load');
    const settled = cards.filter((card) => card.via === 'swipe' || card.via === 'wheel');
    const p50 = stats(settled.map((card) => card.settleToPreviewMs))?.p50 ?? null;
    return {
      profile,
      viewport: page.viewportSize(),
      cpuThrottle: cpu,
      measuredAt: new Date().toISOString(),
      summary: {
        cards: cards.length,
        distinctGames: new Set(cards.map((card) => card.versionId)).size,
        settleTransitions: settled.length,
        releaseToSettleMs: stats(settled.map((card) => card.releaseToSettleMs)),
        settleToShownMs: stats(settled.map((card) => card.settleToShownMs)),
        settleToPreviewMs: stats(settled.map((card) => card.settleToPreviewMs)),
        releaseToPreviewMs: stats(settled.map((card) => card.releaseToPreviewMs)),
        allTransitionsSettleToPreviewMs: stats(moved.map((card) => card.settleToPreviewMs)),
        t8TargetP50Ms: T8_TARGET_MS[profile],
        t8TargetHolds: p50 === null ? null : p50 <= T8_TARGET_MS[profile],
        contextsMax: Math.max(0, ...cards.map((card) => card.contexts)),
        glContextsMax: Math.max(0, ...cards.map((card) => card.glContexts)),
        canvasesMax: Math.max(0, ...cards.map((card) => card.canvases)),
        fpsP50: stats(cards.map((card) => card.fps.fpsP50)),
        fpsP5: stats(cards.map((card) => card.fps.fpsP5)),
        drawnFps: stats(cards.map((card) => card.fps.drawnFps)),
        changedShare: stats(cards.map((card) => card.changedShare), 4),
        czech: [...new Set(cards.flatMap((card) => card.czech))],
      },
      play,
      cards,
      errors,
    };
  };

  /** Karta dosedla, náhled běží: změří, vyfotí a zapíše. */
  const record = async (swap: Swap, via: Via): Promise<Card> => {
    const n = cards.length + 1;
    expect(swap.timedOut, `card ${String(n)} (${via}): no running preview of ${String(swap.to)} within ${String(PREVIEW_TIMEOUT_MS)} ms`).toBe(false);
    await expectSnapped(page);
    await expect(page.getByTestId('feed-hint')).toBeVisible();
    const fps = await page.evaluate((ms) => window.__feedPhone!.fps(ms), FPS_MS);
    const now = await feedProbe(page);
    expect(now.versionId).toBe(swap.to);
    expect(now.mode).toBe('preview');
    const shots: Buffer[] = [];
    for (let shot = 0; shot < 3; shot += 1) {
      if (shot > 0) await page.waitForTimeout(SCENE_GAP_MS);
      shots.push(await stage(page).screenshot({ scale: 'css', style: CANVAS_ONLY }));
    }
    const [early, late] = await Promise.all([sceneChange(shots[0]!, shots[1]!), sceneChange(shots[0]!, shots[2]!)]);
    const scene = { changedShare: Math.max(early.changedShare, late.changedShare), stdev: early.stdev };
    const title = (await page.locator('[data-testid="feed-card"][data-active="true"]').getAttribute('aria-label')) ?? '';
    const name = `${profile}-${String(n).padStart(2, '0')}-${via}.png`;
    await page.screenshot({ path: join(OUT, name), scale: 'css' });
    const counts = await page.evaluate(() => ({ glContexts: window.__feedPhone!.glContexts, canvases: document.querySelectorAll('canvas').length, text: document.body.innerText }));
    const card: Card = {
      n,
      via,
      versionId: now.versionId!,
      title,
      control: await stage(page).getAttribute('data-control'),
      ...timings(swap, via),
      contexts: now.contexts,
      glContexts: counts.glContexts,
      canvases: counts.canvases,
      fps: { fpsP50: round(fps.fpsP50), fpsP5: round(fps.fpsP5), drawnFps: round(fps.drawnFps)! },
      changedShare: Math.round(scene.changedShare * 10_000) / 10_000,
      stageStdev: round(scene.stdev)!,
      czech: findCzech(counts.text),
      screenshot: name,
    };
    cards.push(card);
    console.log(`[feed-phone] ${profile} #${String(n)} ${via} ${card.title} (${String(card.control)}): settle→preview ${String(card.settleToPreviewMs)} ms, fps ${String(card.fps.fpsP50)}, changed ${String(card.changedShare)}`);
    expect(now.contexts, `card ${String(n)}: canvases the feed ever showed`).toBe(1);
    expect(card.canvases).toBe(1);
    expect(card.changedShare, `card ${String(n)}: the scene did not change between two shots (blank or frozen canvas)`).toBeGreaterThan(MIN_CHANGED_SHARE);
    expect(card.czech, `card ${String(n)}: Czech text on screen`).toEqual([]);
    return card;
  };

  /** Přechod: sledovat od teď, provést gesto, počkat na běžící náhled nové hry. */
  const move = async (via: Via, gesture: () => Promise<void>) => {
    const from = (await feedProbe(page)).versionId;
    await page.evaluate(({ from, timeout }) => window.__feedPhone!.watch(from, timeout), { from, timeout: PREVIEW_TIMEOUT_MS });
    await gesture();
    const swap = await page.evaluate(() => window.__feedPhone!.swap!);
    return record(swap, via);
  };

  try {
    await page.goto('/play');
    // Feed stojí pod polem pro větu; hra hraje, jen když je feed aspoň z poloviny vidět (`onScreen`).
    await page.getByTestId('feed-current').waitFor({ timeout: 60_000 });
    await page.evaluate(({ timeout }) => window.__feedPhone!.watch(null, timeout), { timeout: PREVIEW_TIMEOUT_MS });
    await page.evaluate(() => document.querySelector('[data-testid="feed-reel"]')?.scrollIntoView({ block: 'start' }));
    await record(await page.evaluate(() => window.__feedPhone!.swap!), 'load');

    const wheel = async () => {
      const box = await boxOf(stage(page));
      await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
      await page.mouse.wheel(0, 500);
    };
    for (let swipe = 0; swipe < SWIPES; swipe += 1) {
      if (cards.length - 1 === PLAY_AT) {
        // Třetí karta: ťuk převezme hru, 5 s hraní gesty jejího ovládání, pak „Next“.
        const control = (await stage(page).getAttribute('data-control')) ?? '';
        const versionId = (await feedProbe(page)).versionId;
        const scrollTop = () => page.getByTestId('feed-reel').evaluate((reel) => reel.scrollTop);
        const top = await scrollTop();
        const box = await boxOf(stage(page));
        const tappedAt = Date.now();
        if (profile === 'phone') await page.touchscreen.tap(box.x + box.width / 3, box.y + box.height / 2);
        else await page.mouse.click(box.x + box.width / 3, box.y + box.height / 2);
        await expect.poll(async () => (await feedProbe(page)).mode).toBe('play');
        const tapToPlayMs = Date.now() - tappedAt;
        await expect(page.getByTestId('feed-hint')).toBeHidden();
        const inputsAfterTap = await page.evaluate(() => window.__playShell!.inputs().length);
        const tickAfterTap = (await feedProbe(page)).tick;
        if (profile === 'phone') {
          // P64 T7: kroužek joysticku stojí v klidu vlevo dole; svislý tah po něm (nahoru i dolů) hru řídí a kartu
          // feedu nepřetočí. Třetí karta vestavěného poolu je aréna (`move_free`).
          expect(['move_free', 'fight'], 'the played card has a joystick').toContain(control);
          const ring = stage(page).getByTestId('touch-stick');
          await expect(ring).toBeVisible();
          const home = await boxOf(ring);
          const [x, y] = [home.x + home.width / 2, home.y + home.height / 2];
          for (const reach of [-0.5, 0.15]) {
            await fingers.press(1, x, y);
            for (let step = 1; step <= 8; step += 1) await fingers.move(1, x, y + (box.height * reach * step) / 8);
            await page.waitForTimeout(200);
            await fingers.lift(1);
          }
          await page.waitForTimeout(500);
          expect((await feedProbe(page)).versionId, 'a vertical drag on the ring turned the card').toBe(versionId);
          expect(await scrollTop(), 'a vertical drag on the ring scrolled the feed').toBe(top);
          await playByTouch(page, fingers, control, PLAY_MS);
        } else await playByKeys(page, control, PLAY_MS);
        const after = await feedProbe(page);
        const inputsAfterPlay = await page.evaluate(() => window.__playShell!.inputs().length);
        const topAfter = await scrollTop();
        const shot = `${profile}-${String(cards.length).padStart(2, '0')}-played-5s.png`;
        await page.screenshot({ path: join(OUT, shot), scale: 'css' });
        const text = await page.evaluate(() => document.body.innerText);
        play = { n: cards.length, versionId, control, tapToPlayMs, inputsAfterTap, inputsAfterPlay, tickAfterTap, tickAfterPlay: after.tick, modeAfterPlay: after.mode, feedMoved: topAfter !== top || after.versionId !== versionId, contexts: after.contexts, czech: findCzech(text), screenshot: shot };
        console.log(`[feed-phone] ${profile} play ${control}: ${JSON.stringify(play)}`);
        expect(after.versionId, 'the feed moved while the game was played').toBe(versionId);
        expect(topAfter, 'the feed scrolled while the game was played').toBe(top);
        expect(['play', 'result']).toContain(after.mode);
        expect(inputsAfterPlay, 'the game took no input from the gestures').toBeGreaterThan(inputsAfterTap);
        expect(after.tick).toBeGreaterThan(tickAfterTap);
        expect(after.contexts).toBe(1);
        expect(findCzech(text)).toEqual([]);
        await move('next', () => (profile === 'phone' ? page.getByTestId('feed-next').tap() : page.getByTestId('feed-next').click()));
      }
      await move(profile === 'phone' ? 'swipe' : 'wheel', profile === 'phone' ? () => swipeUp(page, fingers) : wheel);
    }

    expect(new Set(cards.map((card) => card.versionId)).size, 'every card is a different game').toBe(cards.length);
    expect(new Set(cards.map((card) => card.title)).size, 'every card has its own title').toBe(cards.length);
    expect(cards.filter((card) => card.via === 'swipe' || card.via === 'wheel')).toHaveLength(SWIPES);
    expect(errors).toEqual([]);
    if (profile === 'desktop') {
      // T8 cíl na desktopu splnil (165 ms) – tady platí taky. Telefon cíl ≤ 500 ms v T8 nesplnil (894 ms,
      // dlouhé snímky smyčky R3F – kompilace shaderů, P54B); report zapíše `t8TargetHolds` a test na něm nepadá.
      expect(result().summary.settleToPreviewMs?.p50 ?? Infinity, 'T8: settle → running preview p50 on desktop').toBeLessThanOrEqual(T8_TARGET_MS.desktop);
    }
  } finally {
    writeReport(profile, result());
  }
}

test.describe('/play feed on a phone and a desktop, built-in pool (P54A T15)', () => {
  test.describe('phone', () => {
    // Pixel 7 bez `defaultBrowserType` (ve skupině nastavit nejde); okno 412×915 jako měření T8.
    const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7'];
    test.use({ ...pixel7, viewport: { width: 412, height: 915 } });

    test('Pixel 7, CPU ×4: ten swipes up, each card a running preview, the third one played by touch', async ({ page }) => {
      test.setTimeout(15 * 60_000);
      await feedCheck(page, 'phone', 4);
    });
  });

  test('desktop 1440×900: ten wheel moves, each card a running preview, the third one played by keys', async ({ page }) => {
    test.setTimeout(10 * 60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await feedCheck(page, 'desktop', 1);
  });
});
