import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import type { PanelReport, XrReport } from '../src/components/play/xr/XrRig';
import { IDEAS, STARTERS } from '../src/components/play/starters';

/**
 * Celá smyčka Sayplay v jedné XR relaci (P67 T14) v emulátoru IWER: hráč brýle nesundá od prvního „Enter VR“
 * do QR kódu sdílení. Hlavní tvrzení: stránka si o relaci řekla jednou, žádná neskončila a renderer celou dobu
 * kreslí přes tentýž objekt `XRSession` (jeho `requestAnimationFrame` dostává snímky po každém kroku).
 *
 * Pořadí kroků dává produkt: feed žije jen na `/play` a ve VR z hry na `/play/<id>` zpátky do feedu cesta není
 * („New game“ otevře lobby nad hrou, „Make it!“ vede dál na další hru). Smyčka proto začíná ve feedu, kam vede
 * „Enter VR“ z karty, a do lobby jde přes „New game“ – všechno od vstupu do VR dělají ovladače:
 *
 * 1. feed → kolo karty → „Enter VR“; robot kolo vyhraje (sonda `handPlay`) → „Again“ → nové kolo od tiku 0;
 * 2. „Next“ na výsledku → další karta, páčka dolů → předchozí karta;
 * 3. „New game“ → lobby → karta s větou → „Make it!“ → hra;
 * 4. konec kola → „New game“ → „Type“ → klávesnice „zombies attack my house“ → „Make it!“ → hra;
 * 5. AI verze té hry z fixtures (podvržené `GET …/upgrade`, jako `vr-enter`) → „Play it“ na panelu
 *    „AI version ready“ → výhra → „Share“ → karta s QR kódem odkazu na výzvu.
 *
 * Útrata 0: feed a AI verze jsou hry z fixtur, každý dotaz na AI verzi (`…/upgrade`) odpovídá test, takže práci
 * režiséra nikdo nespustí; kromě čtení smí stránka jen postavit dvě rychlé hry z vět, uložit výzvu a poslat události.
 * Ovládání panelů je totéž jako ve `vr-lobby` a `vr-feed`: paprsek pravé ruky na střed tlačítka, spoušť dolů a nahoru.
 */

const IWER_BUNDLE = join(process.cwd(), 'node_modules/iwer/build/iwer.min.js');

/** Karty feedu a AI verze: hotové specy z fixtur, tituly je od sebe (a od ostatních testů) odliší. */
const FEED = [
  ['runner.json', 'VR loop runner through the canyon'],
  ['flap.json', 'VR loop flap between the pipes'],
] as const;
const AI_VERSION = ['runner.json', 'VR loop AI version of the zombie house'] as const;
/** Karty lobby v pevném pořadí, jako `vr-lobby`. */
const POOL = [...IDEAS.map((idea) => idea.sentence), ...STARTERS.map((starter) => starter.sentence)];
/** Věta z klávesnice (AC T14); klávesnice píše první písmeno velké. */
const TYPED = 'zombies attack my house';

/** Pohled dolů na lobby a stůl dioramy (rad), jako `vr-lobby`. */
const PITCH = (19 * Math.PI) / 180;
type Hand = readonly [number, number, number];
/** Pravá ruka před tělem, odkud paprsek míří na panely. */
const HAND: Hand = [0.2, 1.2, -0.25];

interface Row {
  readonly versionId: string;
  readonly title: string;
  readonly archetype: string;
  readonly createdAt: string;
  readonly parentId: null;
  readonly remixes: number;
}

interface FeedProbe {
  readonly versionId: string | null;
  readonly mode: 'preview' | 'still' | 'play' | 'result';
  readonly tick: number;
}

interface Pose {
  readonly position: { set(x: number, y: number, z: number): void };
  readonly quaternion: { set(x: number, y: number, z: number, w: number): void };
  updateButtonValue(id: string, value: number): void;
  updateAxes(id: string, x: number, y: number): void;
}
interface Quest {
  installRuntime(options?: { forceInstall?: boolean }): void;
  stereoEnabled: boolean;
  readonly position: { set(x: number, y: number, z: number): void };
  readonly quaternion: { set(x: number, y: number, z: number, w: number): void };
  readonly controllers: { readonly left?: Pose; readonly right?: Pose };
}
/** Okno s emulátorem; typy `IWER` deklarují jiné spec soubory jinak, proto přes přetypování. */
interface QuestWindow {
  readonly IWER: { XRDevice: new (config: unknown) => Quest; metaQuest2: unknown };
  __quest: Quest;
  /** Kolikrát si stránka řekla o relaci, kolik relací skončilo a kolik snímků renderer vyžádal od té jediné. */
  __loopRequests: number;
  __loopEnded: number;
  __loopFrames: number;
}
interface Shell {
  handPlay(until: 'score' | 'end'): { readonly runState: string };
  byHand(on: boolean): void;
  tick(): number;
}

async function publish(request: APIRequestContext, fixture: string, title: string, index: number): Promise<Row> {
  const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', fixture), 'utf8')) as Record<string, unknown>;
  const response = await request.post('/api/play/games', { data: { spec: { ...base, title } } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  const body = (await response.json()) as { versionId: string; archetype: string };
  return { versionId: body.versionId, title, archetype: body.archetype, createdAt: new Date(Date.now() - index * 1000).toISOString(), parentId: null, remixes: 0 };
}

async function withQuest2(page: Page): Promise<void> {
  await page.addInitScript({ path: IWER_BUNDLE });
  await page.addInitScript(
    ({ pitch, hand }) => {
      const self = window as unknown as QuestWindow;
      const device = new self.IWER.XRDevice(self.IWER.metaQuest2);
      device.stereoEnabled = true;
      device.installRuntime({ forceInstall: true });
      device.position.set(0, 1.6, 0);
      device.quaternion.set(-Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
      // Paprsek pravé ruky svisle nahoru: na nic nemíří, dokud ho test nenamíří.
      device.controllers.right?.position.set(...hand);
      device.controllers.right?.quaternion.set(Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      // Levá ruka u těla s paprskem k zemi (jako `vr-lobby`): nedrží žádné tlačítko lobby.
      device.controllers.left?.position.set(-0.3, 1.1, -0.4);
      device.controllers.left?.quaternion.set(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      self.__quest = device;
      self.__loopRequests = 0;
      self.__loopEnded = 0;
      self.__loopFrames = 0;
      const xr = navigator.xr!;
      const request = xr.requestSession.bind(xr);
      xr.requestSession = async (...args) => {
        const session = await request(...args);
        self.__loopRequests += 1;
        session.addEventListener('end', () => {
          self.__loopEnded += 1;
        });
        // Snímky, o které si renderer řekne přímo u tohoto objektu relace: rostou-li po každém kroku, kreslí se
        // pořád do něj, ne do jiné relace.
        const frame = session.requestAnimationFrame.bind(session);
        session.requestAnimationFrame = (callback) =>
          frame((time, xrFrame) => {
            self.__loopFrames += 1;
            callback(time, xrFrame);
          });
        return session;
      };
    },
    { pitch: PITCH, hand: HAND },
  );
}

const xr = (page: Page): Promise<XrReport | null> => page.evaluate(() => window.__playXr?.() ?? null);
const feed = (page: Page): Promise<FeedProbe> => page.evaluate(() => window.__playFeed!());
/** Robot dohraje kolo (sonda `handPlay`) a vrátí, jak skončilo. */
const robotEnds = async (page: Page): Promise<string> => (await page.evaluate(() => (window.__playShell as unknown as Shell).handPlay('end'))).runState;
const tickOf = (page: Page): Promise<number> => page.evaluate(() => (window.__playShell as unknown as Shell).tick());
/** Hodiny kola stojí (sonda `byHand`): kolo končí jen `handPlay` testu. */
const holdClock = (page: Page): Promise<void> => page.evaluate(() => (window.__playShell as unknown as Shell).byHand(true));
const ids = async (page: Page): Promise<string[]> => ((await xr(page))?.panels ?? []).map((panel) => panel.id).sort();
const labelsOf = (panel: PanelReport): string[] => panel.buttons.map((button) => button.label);
const textOf = async (page: Page, id: string): Promise<string> => ((await xr(page))?.panels.find((panel) => panel.id === id)?.text ?? []).join(' ');
const expectText = (page: Page, id: string, timeout = 10_000) => expect.poll(() => textOf(page, id), { timeout });

/** Tatáž relace: jediná vyžádaná, žádná neskončila, a renderer od ní po tomto kroku dál bere snímky. */
async function sameSession(page: Page, step: string): Promise<void> {
  const counts = () =>
    page.evaluate(() => {
      const self = window as unknown as QuestWindow;
      return { requests: self.__loopRequests, ended: self.__loopEnded, frames: self.__loopFrames };
    });
  const before = await counts();
  expect({ requests: before.requests, ended: before.ended }, `${step}: one XR session`).toEqual({ requests: 1, ended: 0 });
  await expect.poll(async () => (await counts()).frames, { message: `${step}: frames of the same session`, timeout: 10_000 }).toBeGreaterThan(before.frames);
  expect((await xr(page))?.presenting, `${step}: presenting`).toBe(true);
}

/** Panel `id`, jakmile ho scéna kreslí a písmo je načtené (jako `vr-lobby`). */
async function panelOf(page: Page, id: string): Promise<PanelReport> {
  const panel = await page.evaluate(async (id) => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const find = () => window.__playXr?.().panels.find((candidate) => candidate.id === id) ?? null;
    const until = performance.now() + 20_000;
    while (find() === null && performance.now() < until) await frame();
    await frame();
    await frame();
    return find();
  }, id);
  expect(panel, `${id} panel in the scene`).not.toBeNull();
  return panel!;
}

type Point = PanelReport['buttons'][number]['at'];
type KeyState = PanelReport['buttons'][number]['state'];

/** Pravá ruka v `HAND`, paprsek na bod `at` (`null` = svisle nahoru, mimo panely). */
async function aim(page: Page, at: Point | null): Promise<void> {
  await page.evaluate(
    ({ at, from }) => {
      const right = (window as unknown as QuestWindow).__quest.controllers.right!;
      right.position.set(...from);
      if (at === null) {
        right.quaternion.set(Math.SQRT1_2, 0, 0, Math.SQRT1_2);
        return;
      }
      const length = Math.hypot(at.x - from[0], at.y - from[1], at.z - from[2]);
      const [x, y, z] = [(at.x - from[0]) / length, (at.y - from[1]) / length, (at.z - from[2]) / length];
      // Otočení, které dá −z (směr paprsku) na (x, y, z).
      const q = [y, -x, 0, 1 - z];
      const norm = Math.hypot(...q);
      right.quaternion.set(q[0]! / norm, q[1]! / norm, q[2]! / norm, q[3]! / norm);
    },
    { at, from: HAND },
  );
}

/** Snímek po snímku čeká na stav tlačítka; `release` pustí spoušť hned ve snímku stisku (jako `vr-lobby`). */
async function untilState(page: Page, panel: string, button: string, want: KeyState, options: { readonly trigger?: 0 | 1; readonly release?: boolean } = {}): Promise<void> {
  const seen = await page.evaluate(
    async ({ panel, button, want, trigger, release }) => {
      const right = (window as unknown as QuestWindow).__quest.controllers.right!;
      const state = () => window.__playXr?.().panels.find((candidate) => candidate.id === panel)?.buttons.find((candidate) => candidate.id === button)?.state ?? null;
      if (trigger !== undefined) right.updateButtonValue('trigger', trigger);
      const until = performance.now() + 5_000;
      while (state() !== want && performance.now() < until) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const last = state();
      if (release === true && last === want) right.updateButtonValue('trigger', 0);
      return last;
    },
    { panel, button, want, trigger: options.trigger, release: options.release },
  );
  expect(seen, `${panel}:${button}`).toBe(want);
}

/** Klik paprskem na tlačítko panelu `id` a paprsek zase pryč (jako `vr-lobby`). */
async function click(page: Page, id: string, button: string): Promise<void> {
  const panel = await panelOf(page, id);
  const target = panel.buttons.find((candidate) => candidate.id === button);
  if (target === undefined) throw new Error(`${id} has no ${button} button: ${JSON.stringify(panel.buttons.map((candidate) => candidate.id))}`);
  await aim(page, target.at);
  await untilState(page, id, button, 'aimed');
  await untilState(page, id, button, 'pressed', { trigger: 1, release: true });
  await aim(page, null);
  const left = await page.evaluate(
    async ({ id, button }) => {
      const state = () => window.__playXr?.().panels.find((candidate) => candidate.id === id)?.buttons.find((candidate) => candidate.id === button)?.state ?? null;
      const until = performance.now() + 5_000;
      while (state() !== null && state() !== 'rest' && performance.now() < until) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return state();
    },
    { id, button },
  );
  expect([null, 'rest'], `${id}:${button} after the click`).toContain(left);
}

/** Mávnutí pravou páčkou (Gamepad API: nahoru = záporné y) a návrat do středu (jako `vr-feed`). */
async function flick(page: Page, direction: 'up' | 'down'): Promise<void> {
  await page.evaluate(async (y) => {
    const right = (window as unknown as QuestWindow).__quest.controllers.right!;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    right.updateAxes('thumbstick', 0, y);
    for (let at = 0; at < 6; at += 1) await frame();
    right.updateAxes('thumbstick', 0, 0);
    for (let at = 0; at < 6; at += 1) await frame();
  }, direction === 'up' ? -1 : 1);
}

/** Spoušť pravé ruky s paprskem mimo panely: na náhledu robota hru převezme (jako `vr-feed`). */
async function pullTrigger(page: Page): Promise<void> {
  await aim(page, null);
  await page.evaluate(async () => {
    const right = (window as unknown as QuestWindow).__quest.controllers.right!;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    right.updateButtonValue('trigger', 1);
    for (let at = 0; at < 6; at += 1) await frame();
    right.updateButtonValue('trigger', 0);
    for (let at = 0; at < 6; at += 1) await frame();
  });
}

/** Aktivní karta je `row`, hraje náhled robota a tik roste (jako `vr-feed`). */
async function expectPreview(page: Page, row: Row): Promise<void> {
  await expect.poll(async () => (await feed(page)).versionId, { timeout: 10_000 }).toBe(row.versionId);
  await expect.poll(async () => (await feed(page)).mode, { timeout: 30_000 }).toBe('preview');
  const first = (await feed(page)).tick;
  await expect.poll(async () => (await feed(page)).tick, { timeout: 10_000 }).toBeGreaterThan(first);
}

/** Konec kola rukou robota → výsledek karty feedu ve VR. */
async function endFeedRound(page: Page, want?: 'won'): Promise<PanelReport> {
  const end = await robotEnds(page);
  if (want === undefined) expect(['won', 'lost']).toContain(end);
  else expect(end).toBe(want);
  await expect.poll(async () => (await feed(page)).mode, { timeout: 15_000 }).toBe('result');
  return panelOf(page, 'result');
}

/** Hra z „Make it!“ běží ve VR: adresa `/play/<id>` jiná než `before`, HUD hry, hrdina ve stavu, kreslené snímky. */
async function gameRunsInVr(page: Page, before: string): Promise<string> {
  await page.waitForURL((url) => /^\/play\/[a-f0-9]+$/.test(url.pathname) && url.pathname !== before, { timeout: 30_000 });
  const path = new URL(page.url()).pathname;
  await expect.poll(async () => (await ids(page)).filter((id) => id !== 'notice'), { timeout: 30_000 }).toEqual(['hud']);
  expect((await xr(page))?.heroAt, 'the new game has a hero in its state').not.toBeNull();
  await expect.poll(async () => (await xr(page))?.calls ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  return path;
}

/** Klávesnice lobby: písmena `key-<a…z>`, mezera `space`. */
const keysOf = (sentence: string): string[] => [...sentence].map((char) => (char === ' ' ? 'space' : `key-${char}`));

let rows: Row[] = [];
let aiVersion: Row | null = null;

test.beforeAll(async ({ request }) => {
  rows = [];
  for (const [index, [fixture, title]] of FEED.entries()) rows.push(await publish(request, fixture, title, index));
  aiVersion = await publish(request, AI_VERSION[0], AI_VERSION[1], FEED.length);
});

test('the whole loop in one XR session: feed, Again, Next and Prev, lobby card, keyboard, AI version, Share QR', async ({ page }) => {
  // Feed, tři hry z lobby a AI verze, kola a výzva se do výchozích 30 s nevejdou.
  test.setTimeout(420_000);
  const started = Date.now();
  const marks: Record<string, number> = {};
  const mark = (step: string) => {
    marks[step] = Date.now() - started;
  };

  // Útrata: každý dotaz na API se zapíše; dotaz na AI verzi odpovídá test (`pending`, dokud AI verze „nedorazí“).
  const api: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/')) api.push(`${request.method()} ${pathname}`);
  });
  let aiReadyFor: string | null = null;
  let upgradeAnswers = 0;
  await page.route('**/api/play/games/*/upgrade', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    upgradeAnswers += 1;
    const id = /\/games\/([a-f0-9]+)\/upgrade$/.exec(new URL(route.request().url()).pathname)?.[1] ?? null;
    const ready = id !== null && id === aiReadyFor;
    const body = ready ? { status: 'ready', versionId: aiVersion!.versionId } : { status: 'pending', deadlineAt: new Date(Date.now() + 285_000).toISOString() };
    await route.fulfill({ json: body, headers: { 'cache-control': 'no-store' } });
  });
  await page.route('**/api/play/games?recent=*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ games: rows, next: null }) }));
  await withQuest2(page);

  // 1. Feed → kolo karty → „Enter VR“ (jediné klepnutí mimo VR); hodiny kola stojí, konec dá robot.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/play?g=${rows[0]!.versionId}`);
  await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
  await expectPreview(page, rows[0]!);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await feed(page)).mode).toBe('play');
  await holdClock(page);
  const enter = page.getByTestId('feed-current').getByTestId('enter-vr');
  await expect(enter).toBeVisible({ timeout: 30_000 });
  await enter.click();
  await expect.poll(async () => (await xr(page))?.presenting, { timeout: 15_000 }).toBe(true);
  expect((await xr(page))?.eyes).toBe(2);
  await expect.poll(async () => (await xr(page))?.heroWorld ?? null, { timeout: 15_000 }).not.toBeNull();
  await sameSession(page, 'enter VR from the feed');
  mark('enter');

  // Robot kolo vyhraje → „Again“ → nové kolo téže karty od tiku 0.
  const won = await endFeedRound(page, 'won');
  expect(labelsOf(won)).toEqual(['New game', 'Exit VR', 'Comfort', 'Share', 'Next', 'Again']);
  await click(page, 'result', 'again');
  await expect.poll(() => ids(page), { timeout: 10_000 }).toEqual(['hud']);
  expect(await tickOf(page)).toBe(0);
  expect(await feed(page)).toMatchObject({ versionId: rows[0]!.versionId, mode: 'play' });
  await sameSession(page, 'Again');
  mark('again');

  // 2. „Next“ → další karta, páčka dolů → zpátky na předchozí.
  await endFeedRound(page);
  await click(page, 'result', 'next');
  await expectPreview(page, rows[1]!);
  await sameSession(page, 'Next');
  await flick(page, 'down');
  await expectPreview(page, rows[0]!);
  await sameSession(page, 'Prev');
  mark('next-prev');

  // 3. Spoušť převezme kolo, robot ho dohraje, „New game“ → lobby → karta s větou → „Make it!“ → hra.
  await pullTrigger(page);
  await expect.poll(async () => (await feed(page)).mode, { timeout: 10_000 }).toBe('play');
  await holdClock(page);
  await endFeedRound(page);
  await click(page, 'result', 'new');
  await expect.poll(() => ids(page), { timeout: 10_000 }).toEqual(['lobby']);
  await click(page, 'lobby', 'idea-0');
  await expectText(page, 'lobby').toContain(POOL[0]!);
  await click(page, 'lobby', 'make');
  const fromCard = await gameRunsInVr(page, '/play');
  await sameSession(page, 'lobby card → game');
  mark('card-game');

  // 4. Konec kola → „New game“ → „Type“ → klávesnice → „Make it!“ → další hra.
  expect(['won', 'lost']).toContain(await robotEnds(page));
  await click(page, 'result', 'new');
  await expect.poll(() => ids(page), { timeout: 10_000 }).toEqual(['lobby']);
  await click(page, 'lobby', 'type');
  await panelOf(page, 'keyboard');
  for (const key of keysOf(TYPED)) await click(page, 'keyboard', key);
  const typed = TYPED[0]!.toUpperCase() + TYPED.slice(1);
  await expectText(page, 'lobby').toContain(`${typed}|`);
  await click(page, 'lobby', 'make');
  const fromKeyboard = await gameRunsInVr(page, fromCard);
  await sameSession(page, 'keyboard → game');
  mark('keyboard-game');

  // 5. AI verze dorazí: panel „AI version ready“ → „Play it“ → AI verze (hra z fixtur) běží v téže relaci.
  aiReadyFor = fromKeyboard.slice('/play/'.length);
  const notice = await panelOf(page, 'notice');
  expect(notice.text.join(' ')).toContain('AI version ready');
  await click(page, 'notice', 'open');
  await page.waitForURL(`**/play/${aiVersion!.versionId}`, { timeout: 20_000 });
  await expect.poll(async () => (await xr(page))?.heroAt ?? null, { timeout: 30_000 }).not.toBeNull();
  await expect.poll(() => ids(page), { timeout: 30_000 }).toEqual(['hud']);
  await sameSession(page, 'AI version');
  mark('ai-version');

  // Výhra → „Share“ → karta s QR kódem odkazu na výzvu hrané AI verze. Výsledek 2D výzvu po výhře uložil a strop
  // 1 výzva / 10 s ji VR může chvíli odmítat – karta to zkouší znovu (až ~12 s, `docs/vr/README.md`).
  await holdClock(page);
  expect(await robotEnds(page)).toBe('won');
  const result = await panelOf(page, 'result');
  expect(labelsOf(result)).toEqual(['New game', 'Exit VR', 'Comfort', 'Share', 'Again']);
  await click(page, 'result', 'share');
  await expect.poll(async () => (await panelOf(page, 'share')).qr, { timeout: 25_000 }).not.toBeNull();
  const shared = await panelOf(page, 'share');
  const origin = new URL(page.url()).origin;
  expect(shared.qr).toMatch(new RegExp(`^${origin.replace(/[.:/]/g, '\\$&')}/play/${aiVersion!.versionId}\\?via=share&dare=[^&\\s]+$`));
  expect(shared.text).toEqual(['Share', 'Scan with your phone']);
  await page.screenshot({ path: test.info().outputPath('vr-loop-share-qr.png') });
  await sameSession(page, 'Share QR');
  mark('share-qr');
  console.log(`vr-loop ms ${JSON.stringify(marks)}`);

  // Útrata 0: dvě rychlé hry z vět, výzva a události; AI verzi nikdo u serveru nespustil (každý dotaz odpověděl test).
  expect(upgradeAnswers, 'the AI version answered by the test').toBeGreaterThan(0);
  expect(api.filter((line) => line === 'POST /api/play/games')).toHaveLength(2);
  expect(api.filter((line) => !line.startsWith('GET ') && line !== 'POST /api/play/games' && line !== 'POST /api/play/events' && !/^POST \/api\/play\/games\/[a-f0-9]+\/dare$/.test(line))).toEqual([]);
  expect(api.filter((line) => line.startsWith('GET ') && line.endsWith('/upgrade')).length).toBe(upgradeAnswers);
});
