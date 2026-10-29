import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import type { PanelReport, XrReport } from '../src/components/play/xr/XrRig';

/**
 * Feed ve VR (P67 T4) v emulátoru IWER: listování her bez sundání brýlí. Aktivní karta feedu kreslí do plátna XR
 * relace (`StageHost` dá ve VR hostitele z layoutu), „Next“ na panelu výsledku a mávnutí pravou páčkou listují,
 * spoušť na náhledu robota hru převezme, „Again“ začne nové kolo. Hlavní tvrzení: po celou dobu jedna relace
 * (stránka si o ni řekla jednou a žádná neskončila) a brýle kreslí vždy hru aktivní karty.
 *
 * Hry jdou do feedu jako v `play-feed-reels.spec.ts`: hotový spec z fixtur, řádky feedu přes `page.route`, detail
 * skutečnými dveřmi (nese náhled robota z publikace). Panely se ovládají jako ve `vr-lobby.spec.ts`: paprsek pravé
 * ruky na střed tlačítka, spoušť dolů a nahoru.
 */

const IWER_BUNDLE = join(process.cwd(), 'node_modules/iwer/build/iwer.min.js');

const FIXTURES = [
  ['runner.json', 'VR feed runner through the canyon'],
  ['flap.json', 'VR feed flap between the pipes'],
  ['platform.json', 'VR feed platform over the rooftops'],
] as const;

/** Pohled dolů na stůl dioramy (rad), jako `vr-lobby`. */
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
  /** Kolikrát si stránka řekla o relaci a kolik relací skončilo. */
  __feedRequests: number;
  __feedEnded: number;
}
interface Shell {
  handPlay(until: 'score' | 'end'): { readonly runState: string };
  byHand(on: boolean): void;
  tick(): number;
}

async function publish(request: APIRequestContext): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [index, [fixture, title]] of FIXTURES.entries()) {
    const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', fixture), 'utf8')) as Record<string, unknown>;
    const response = await request.post('/api/play/games', { data: { spec: { ...base, title } } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    const body = (await response.json()) as { versionId: string; archetype: string };
    rows.push({ versionId: body.versionId, title, archetype: body.archetype, createdAt: new Date(Date.now() - index * 1000).toISOString(), parentId: null, remixes: 0 });
  }
  return rows;
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
      device.controllers.left?.position.set(-0.3, 1.1, -0.4);
      device.controllers.left?.quaternion.set(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      self.__quest = device;
      self.__feedRequests = 0;
      self.__feedEnded = 0;
      const xr = navigator.xr!;
      const request = xr.requestSession.bind(xr);
      xr.requestSession = async (...args) => {
        const session = await request(...args);
        self.__feedRequests += 1;
        session.addEventListener('end', () => {
          self.__feedEnded += 1;
        });
        return session;
      };
    },
    { pitch: PITCH, hand: HAND },
  );
}

const xr = (page: Page): Promise<XrReport | null> => page.evaluate(() => window.__playXr?.() ?? null);
const feed = (page: Page): Promise<FeedProbe> => page.evaluate(() => window.__playFeed!());
/** Hodiny kola stojí (sonda `byHand`): snímky čas neposouvají, kolo končí jen `handPlay` testu. */
const holdClock = (page: Page): Promise<void> => page.evaluate(() => (window.__playShell as unknown as Shell).byHand(true));
const tickOf = (page: Page): Promise<number> => page.evaluate(() => (window.__playShell as unknown as Shell).tick());
const ids = async (page: Page): Promise<string[]> => ((await xr(page))?.panels ?? []).map((panel) => panel.id).sort();
const sessions = (page: Page): Promise<{ readonly requests: number; readonly ended: number }> =>
  page.evaluate(() => {
    const self = window as unknown as QuestWindow;
    return { requests: self.__feedRequests, ended: self.__feedEnded };
  });
const labelsOf = (panel: PanelReport): string[] => panel.buttons.map((button) => button.label);

/** Panel celý v obraze obou očí (jako `vr-hud`). */
function expectInView(panel: PanelReport): void {
  expect(panel.eyes, `${panel.id}: both eyes`).toHaveLength(2);
  for (const eye of panel.eyes) {
    expect(eye, `${panel.id}: drawn`).not.toBeNull();
    const { minX, maxX, minY, maxY, behind } = eye!;
    expect({ behind, inside: minX >= -1 && maxX <= 1 && minY >= -1 && maxY <= 1 }, JSON.stringify(eye)).toEqual({ behind: false, inside: true });
  }
}

/** `count` snímků stránky. */
const frames = (page: Page, count: number): Promise<void> =>
  page.evaluate(async (count) => {
    for (let at = 0; at < count; at += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, count);

/** Aktivní karta je `row`, hraje náhled robota a tik roste (jako `play-feed-reels`). */
async function expectPreview(page: Page, row: Row): Promise<void> {
  await expect.poll(async () => (await feed(page)).versionId, { timeout: 10_000 }).toBe(row.versionId);
  await expect.poll(async () => (await feed(page)).mode, { timeout: 30_000 }).toBe('preview');
  const first = (await feed(page)).tick;
  await expect.poll(async () => (await feed(page)).tick, { timeout: 10_000 }).toBeGreaterThan(first);
}

/** Brýle kreslí hru aktivní karty: hrdina je ve scéně relace, snímky přibývají, relace je pořád tatáž. */
async function drawnInVr(page: Page): Promise<void> {
  await expect.poll(async () => (await xr(page))?.heroWorld ?? null, { timeout: 15_000 }).not.toBeNull();
  const before = (await xr(page))!.frames;
  await expect.poll(async () => (await xr(page))?.frames ?? 0, { timeout: 15_000 }).toBeGreaterThan(before);
  const report = await xr(page);
  expect(report?.presenting).toBe(true);
  expect(report?.calls).toBeGreaterThan(0);
  expect(await sessions(page)).toEqual({ requests: 1, ended: 0 });
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
      const q = [y, -x, 0, 1 - z];
      const norm = Math.hypot(...q);
      right.quaternion.set(q[0]! / norm, q[1]! / norm, q[2]! / norm, q[3]! / norm);
    },
    { at, from: HAND },
  );
}

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

/** Klik paprskem na tlačítko panelu `id`. */
async function click(page: Page, id: string, button: string): Promise<void> {
  const panel = await panelOf(page, id);
  const target = panel.buttons.find((candidate) => candidate.id === button);
  if (target === undefined) throw new Error(`${id} has no ${button} button: ${JSON.stringify(panel.buttons.map((candidate) => candidate.id))}`);
  await aim(page, target.at);
  await untilState(page, id, button, 'aimed');
  await untilState(page, id, button, 'pressed', { trigger: 1, release: true });
  await aim(page, null);
}

/** Mávnutí pravou páčkou (Gamepad API: nahoru = záporné y) a návrat do středu. */
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

/** Spoušť pravé ruky s paprskem mimo panely: stisk a puštění. */
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

/**
 * Feed → hra hráče → „Enter VR“. Ve 2D převezme náhled klávesa (jako `play-feed-reels`), „Enter VR“ je v HUD hry.
 * Hodiny kola stojí (`byHand`), ať runner neprohraje dřív, než test kolo ukončí sám.
 */
async function enterVrFromFeed(page: Page, rows: readonly Row[]): Promise<void> {
  await withQuest2(page);
  await page.route('**/api/play/games?recent=*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ games: rows, next: null }) }));
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
}

/** Konec kola rukou robota (lidský běh) → panel výsledku ve VR. */
async function endRound(page: Page): Promise<PanelReport> {
  const end = await page.evaluate(() => (window.__playShell as unknown as Shell).handPlay('end'));
  expect(['won', 'lost']).toContain(end.runState);
  await expect.poll(async () => (await feed(page)).mode, { timeout: 15_000 }).toBe('result');
  return panelOf(page, 'result');
}

let rows: Row[] = [];

test.beforeAll(async ({ request }) => {
  rows = await publish(request);
});

test.beforeEach(() => {
  // Vstup do VR, tři karty a dvě dohraná kola se do výchozích 30 s nevejdou.
  test.setTimeout(240_000);
});

test('the feed in VR: Next, Prev and Again in one XR session; the right stick pages only outside a round', async ({ page }) => {
  const details = new Set<string>();
  page.on('request', (request) => {
    const found = /^\/api\/play\/games\/([a-f0-9]+)$/.exec(new URL(request.url()).pathname);
    if (found !== null) details.add(found[1]!);
  });

  // 1. Feed → kolo → „Enter VR“: kolo karty kreslí plátno relace.
  await enterVrFromFeed(page, rows);
  await drawnInVr(page);
  expect(await ids(page)).toEqual(['hud']);
  expect(await feed(page)).toMatchObject({ versionId: rows[0]!.versionId, mode: 'play' });

  // V kole patří páčka hře: mávnutí nahoru feed neposune.
  await flick(page, 'up');
  await frames(page, 10);
  expect(await feed(page)).toMatchObject({ versionId: rows[0]!.versionId, mode: 'play' });

  // Výsledek ve feedu: „Next“ vedle „Again“ (jediná rajčatová akce), „Share“ v mřížce (T5), anglicky.
  const result = await endRound(page);
  expect(labelsOf(result)).toEqual(['New game', 'Exit VR', 'Comfort', 'Share', 'Next', 'Again']);
  expect([...result.text, ...labelsOf(result)].join(' ')).not.toMatch(/[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u);
  // Další karta je načtená dopředu: její detail přišel dřív, než ji hráč chce.
  expect(details.has(rows[1]!.versionId), 'next card loaded ahead').toBe(true);

  // 2. „Next“ → jiná hra, v téže relaci.
  await click(page, 'result', 'next');
  await expectPreview(page, rows[1]!);
  await drawnInVr(page);

  // 3. Páčka dolů na náhledu robota → zpátky na původní hru.
  await flick(page, 'down');
  await expectPreview(page, rows[0]!);
  await drawnInVr(page);

  // Spoušť mimo panely převezme náhled jako ťuk ve 2D: hraje hráč.
  await pullTrigger(page);
  await expect.poll(async () => (await feed(page)).mode, { timeout: 10_000 }).toBe('play');
  await holdClock(page);
  expect((await feed(page)).versionId).toBe(rows[0]!.versionId);

  // 4. „Again“ → nové kolo téže hry od tiku 0.
  await endRound(page);
  await click(page, 'result', 'again');
  await expect.poll(() => ids(page), { timeout: 10_000 }).toEqual(['hud']);
  expect(await tickOf(page)).toBe(0);
  expect(await feed(page)).toMatchObject({ versionId: rows[0]!.versionId, mode: 'play' });
  await drawnInVr(page);

  // Páčka nahoru na výsledku → další karta.
  await endRound(page);
  await flick(page, 'up');
  await expectPreview(page, rows[1]!);
  await drawnInVr(page);

  // 5. Po celou dobu jedna relace.
  expect(await sessions(page)).toEqual({ requests: 1, ended: 0 });
});

/**
 * Sdílení z VR (P67 T5): výhra → „Share“ → karta s QR kódem odkazu na výzvu. Odkaz se skládá z hrané verze a id
 * výzvy, které server vrátil – tatáž výzva, kterou po výhře uložil výsledek 2D. Produkce pustí volajícího na 1 výzvu
 * za 10 s (`rate-limit.ts`), takže první poslání z VR tam server odmítne; tady to dělá podvržená odpověď 429
 * (lokální server volajícího nerozezná). Od „Share“ dál smí stránka jen uložit výzvu a ohlásit sdílení – žádné dveře,
 * které volají režiséra (útrata 0).
 */
test('Share from VR: a won round shows the dare link as a QR code, Share link only where the browser can share, and nothing calls the director', async ({ page }) => {
  // Nabídka sdílení prohlížeče podvržená: test řídí, jestli ji prohlížeč má, a vidí, co do ní odešlo.
  await page.addInitScript(() => {
    const self = window as unknown as { __shared: ShareData[] };
    self.__shared = [];
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: ShareData) => {
        self.__shared.push(data);
      },
    });
  });
  const dares: string[] = [];
  /** Odpovědi dveří výzvy po pořadí (stav), ať je při chybě vidět, co server řekl. */
  const answered: number[] = [];
  let posted = 0;
  await page.route('**/api/play/games/*/dare', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted += 1;
    if (posted === 2) {
      answered.push(429);
      return route.fulfill({ status: 429, json: { error: { code: 'RATE_LIMITED', message: 'too many requests from this client' } } });
    }
    const response = await route.fetch();
    answered.push(response.status());
    const body = (await response.json()) as { dareId?: unknown };
    if (typeof body.dareId === 'string') dares.push(body.dareId);
    return route.fulfill({ response });
  });

  await enterVrFromFeed(page, rows);
  await drawnInVr(page);
  const end = await page.evaluate(() => (window.__playShell as unknown as Shell).handPlay('end'));
  expect(end.runState).toBe('won');
  await expect.poll(async () => (await feed(page)).mode, { timeout: 15_000 }).toBe('result');
  expect(labelsOf(await panelOf(page, 'result'))).toEqual(['New game', 'Exit VR', 'Comfort', 'Share', 'Next', 'Again']);
  // Výsledek 2D poslal výzvu hned po výhře. Lokální server dělí strop výzev mezi všechny testy (jeden volající),
  // takže po výhrách předchozího testu ji smí odmítnout – VR ji pak uloží sama.
  await expect.poll(() => answered.length, { timeout: 10_000 }).toBe(1);

  const requests: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/')) requests.push(`${request.method()} ${pathname}`);
  });

  // „Share“: výzva se ukládá (první poslání odmítnuté), karta to řekne a kód zatím nemá.
  await click(page, 'result', 'share');
  const pending = await panelOf(page, 'share');
  expect(pending.text).toEqual(['Share', 'Getting your link…']);
  expect(pending.qr).toBeNull();
  expect(await ids(page)).toEqual(['share']);

  // Další pokus po 3 s uspěje; id výzvy je hash běhu, takže každé úspěšné poslání vrátilo totéž. Odkaz míří na hranou
  // verzi feedu.
  await expect.poll(async () => (await panelOf(page, 'share')).qr, { timeout: 20_000 }).not.toBeNull();
  const shared = await panelOf(page, 'share');
  expect(dares.length, `dare answers ${JSON.stringify(answered)}`).toBeGreaterThanOrEqual(1);
  expect(new Set(dares)).toEqual(new Set([dares[0]]));
  const link = `${new URL(page.url()).origin}/play/${rows[0]!.versionId}?via=share&dare=${dares[0]!}`;
  expect(shared.qr).toBe(link);
  expect(shared.qr).toContain('dare=');
  expect(shared.text).toEqual(['Share', 'Scan with your phone']);
  expect(labelsOf(shared)).toEqual(['Share link', 'Done']);
  expect([...shared.text, ...labelsOf(shared)].join(' ')).not.toMatch(/[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u);
  expectInView(shared);
  await page.screenshot({ path: test.info().outputPath('vr-share-qr.png') });

  // „Share link“ pošle tentýž odkaz do nabídky sdílení prohlížeče.
  await click(page, 'share', 'link');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: ShareData[] }).__shared.map((data) => data.url))).toEqual([link]);

  // „Done“ vrátí výsledek. Prohlížeč bez nabídky sdílení: karta má jen kód a „Done“.
  await click(page, 'share', 'done');
  await expect.poll(() => ids(page), { timeout: 10_000 }).toEqual(['result']);
  await page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }));
  await click(page, 'result', 'share');
  await expect.poll(async () => (await panelOf(page, 'share')).qr, { timeout: 20_000 }).toBe(link);
  expect(labelsOf(await panelOf(page, 'share'))).toEqual(['Done']);

  // Otevřená karta drží výsledek déle než 10 s nečinnosti, po kterých se karta feedu vrací do náhledu robota.
  await page.waitForTimeout(11_000);
  expect(await feed(page)).toMatchObject({ versionId: rows[0]!.versionId, mode: 'result' });
  expect((await panelOf(page, 'share')).qr).toBe(link);

  // Útrata 0: kromě čtení (GET) jen uložení výzvy a událost sdílení – režisér nedostal nic.
  expect(requests.filter((line) => line.startsWith('POST /api/play/games/') && line.endsWith('/dare')).length).toBeGreaterThanOrEqual(2);
  expect(requests.filter((line) => !line.startsWith('GET ') && !/^POST \/api\/play\/games\/[a-f0-9]+\/dare$/.test(line) && line !== 'POST /api/play/events')).toEqual([]);
  expect(await sessions(page)).toEqual({ requests: 1, ended: 0 });
});

test('measure: Next in VR to the first frame of the next game, median of 5', async ({ page }) => {
  await enterVrFromFeed(page, rows);
  await drawnInVr(page);
  await endRound(page);
  const samples: number[] = [];
  for (let at = 0; at < 5; at += 1) {
    const target = rows[at % 2 === 0 ? 1 : 0]!;
    // Od mávnutí páčkou po první snímek relace, ve kterém je hrdina nové karty ve scéně (a aspoň jeden snímek po něm).
    const ms = await page.evaluate(
      async ({ target, y }) => {
        const right = (window as unknown as QuestWindow).__quest.controllers.right!;
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const start = performance.now();
        right.updateAxes('thumbstick', 0, y);
        let released = false;
        let seen: number | null = null;
        try {
          while (performance.now() - start < 20_000) {
            await frame();
            if (!released && performance.now() - start > 100) {
              right.updateAxes('thumbstick', 0, 0);
              released = true;
            }
            const report = window.__playXr?.();
            if (window.__playFeed?.().versionId !== target || report === undefined || report.heroWorld === null) continue;
            if (seen === null) seen = report.frames;
            else if (report.frames > seen) return performance.now() - start;
          }
          return null;
        } finally {
          right.updateAxes('thumbstick', 0, 0);
        }
      },
      { target: target.versionId, y: at % 2 === 0 ? -1 : 1 },
    );
    expect(ms, `transition ${String(at + 1)}`).not.toBeNull();
    samples.push(Math.round(ms!));
    // Další mávnutí až z náhledu robota nové karty (mimo kolo).
    await expectPreview(page, target);
  }
  const median = [...samples].sort((a, b) => a - b)[2]!;
  console.log(`vr-feed next→first frame ms ${JSON.stringify(samples)} median ${String(median)}`);
  expect(await sessions(page)).toEqual({ requests: 1, ended: 0 });
});
