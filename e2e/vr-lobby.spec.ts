import { join } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import type { PanelReport, XrReport } from '../src/components/play/xr/XrRig';
import { BUILD_FAILED, IDEAS, STARTERS } from '../src/components/play/starters';

/**
 * VR lobby (P67 T2) v emulátoru IWER: hra z věty bez sundání brýlí. „Enter VR“ v liště domova `/play` začne relaci
 * s 3D kartou lobby: šest karet vět, „More ideas“, „Type“ (3D klávesnice) a „Make it!“. Hlavní tvrzení: navigace
 * `/play` → `/play/<id>`, kterou „Make it!“ udělá, relaci neukončí – brýle zůstanou ve VR a kreslí novou hru.
 * Relace je tatáž: stránka si o ni řekla jednou a žádná neskončila (`end`).
 *
 * Panely se ovládají jako v `vr-hud.spec.ts`: paprsek pravé ruky na střed tlačítka, spoušť dolů a nahoru. Sonda
 * `__playXr().panels` říká, co na kartě stojí a kde jsou tlačítka. Hlava stojí rovně a dívá se ~19° dolů, kde
 * lobby visí (metr před hráčem, horní hrana v úrovni očí).
 *
 * „Say it“ (P67 T3) diktuje větu rozpoznávačem prohlížeče, tady podvrženým (`withSpeech`); bez Web Speech tlačítko
 * není (`withoutSpeech`).
 */

const IWER_BUNDLE = join(process.cwd(), 'node_modules/iwer/build/iwer.min.js');

/** Karty lobby v pevném pořadí: nápady domova, pak startovní věty. */
const POOL = [...IDEAS.map((idea) => idea.sentence), ...STARTERS.map((starter) => starter.sentence)];
/** Nejmenší text panelu od očí (rad): 0,9° z pravidel plánu (komfort Mety). Měří se nejmenším písmem kitu (13 px). */
const COMFORT = (0.9 * Math.PI) / 180;
/** Pohled dolů na lobby (rad). */
const PITCH = (19 * Math.PI) / 180;
type Hand = readonly [number, number, number];
/** Pravá ruka před tělem, odkud paprsek míří na lobby. */
const HAND: Hand = [0.2, 1.2, -0.25];

interface Pose {
  readonly position: { set(x: number, y: number, z: number): void };
  readonly quaternion: { set(x: number, y: number, z: number, w: number): void };
  updateButtonValue(id: string, value: number): void;
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
  __lobbyRequests: number;
  __lobbyEnded: number;
}
interface Shell {
  handPlay(until: 'score' | 'end'): { readonly runState: string };
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
      // Levá ruka u těla s paprskem k zemi: rovně dopředu by její paprsek ležel na spodní řadě lobby a držel tam tlačítko pod sebou.
      device.controllers.left?.position.set(-0.3, 1.1, -0.4);
      device.controllers.left?.quaternion.set(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      self.__quest = device;
      self.__lobbyRequests = 0;
      self.__lobbyEnded = 0;
      const xr = navigator.xr!;
      const request = xr.requestSession.bind(xr);
      xr.requestSession = async (...args) => {
        const session = await request(...args);
        self.__lobbyRequests += 1;
        session.addEventListener('end', () => {
          self.__lobbyEnded += 1;
        });
        return session;
      };
    },
    { pitch: PITCH, hand: HAND },
  );
}

/** Přepis podvrženého rozpoznávače (AC T3). */
const SPOKEN = 'zombies attack my house';
/** Co „prohlížeč“ dopošle po `stop()`: zrušený poslech to do náhledu dát nesmí. */
const LATE = 'heard after cancel';
/** Co podvržený rozpoznávač udělá po `start()`: přepis, zamítnutý mikrofon, nebo poslouchá, dokud ho nikdo nezastaví. */
type SpeechMode = 'text' | 'error' | 'hold';
interface SpeechWindow {
  __speechMode: SpeechMode;
  __speechStarts: number;
}
interface FakeResult {
  readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }> & { readonly isFinal: boolean }>;
}

/**
 * Rozpoznávač řeči prohlížeče podvržený jako v `play-voice.spec.ts` (`webkitSpeechRecognition`, jako Chrome a
 * prohlížeč Questu). Odpovídá až po chvíli, ať je „Listening…“ vidět; po `stop()` dopošle, co „slyšel“, jako Chrome.
 */
async function withSpeech(page: Page): Promise<void> {
  await page.addInitScript(
    ({ spoken, late }) => {
      const self = window as unknown as SpeechWindow;
      self.__speechMode = 'text';
      self.__speechStarts = 0;
      const result = (transcript: string): FakeResult => ({ results: [Object.assign([{ transcript }], { isFinal: true })] });
      class FakeRecognition {
        lang = '';
        continuous = true;
        interimResults = true;
        onresult: ((event: FakeResult) => void) | null = null;
        onerror: ((event: { readonly error: string }) => void) | null = null;
        onend: (() => void) | null = null;
        private ended = false;
        start(): void {
          self.__speechStarts += 1;
          const mode = self.__speechMode;
          if (mode === 'hold') return;
          setTimeout(() => {
            if (mode === 'error') this.onerror?.({ error: 'not-allowed' });
            else this.onresult?.(result(spoken));
            this.end();
          }, 300);
        }
        stop(): void {
          setTimeout(() => {
            if (this.ended) return;
            this.onresult?.(result(late));
            this.end();
          }, 50);
        }
        private end(): void {
          this.ended = true;
          this.onend?.();
        }
      }
      Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: FakeRecognition });
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
    },
    { spoken: SPOKEN, late: LATE },
  );
}

/** Prohlížeč bez Web Speech (Firefox; Chromium testů rozhraní má, i když nepřepisuje). */
async function withoutSpeech(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
  });
}

const speechMode = (page: Page, mode: SpeechMode): Promise<void> =>
  page.evaluate((mode) => {
    (window as unknown as SpeechWindow).__speechMode = mode;
  }, mode);

const xr = (page: Page): Promise<XrReport | null> => page.evaluate(() => window.__playXr?.() ?? null);
const ids = async (page: Page): Promise<string[]> => ((await xr(page))?.panels ?? []).map((panel) => panel.id).sort();
const sessions = (page: Page): Promise<{ readonly requests: number; readonly ended: number }> =>
  page.evaluate(() => {
    const self = window as unknown as QuestWindow;
    return { requests: self.__lobbyRequests, ended: self.__lobbyEnded };
  });

/** Panel `id`, jakmile ho scéna kreslí a písmo je načtené; hledá se ve stránce každý snímek (jako `vr-hud`). */
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

/** Text karty jako jedna věta: řádky zalomené rozvržením zpátky za sebou. */
const textOf = async (page: Page, id: string): Promise<string> => ((await xr(page))?.panels.find((panel) => panel.id === id)?.text ?? []).join(' ');
const labelsOf = (panel: PanelReport): string[] => panel.buttons.map((button) => button.label);

/** Celý panel v obraze obou očí (ne za okem) a nejmenší text nad mezí komfortu. */
function expectSeen(panel: PanelReport): void {
  expect(panel.eyes, `${panel.id}: both eyes`).toHaveLength(2);
  for (const eye of panel.eyes) {
    expect(eye, `${panel.id}: drawn`).not.toBeNull();
    const { minX, maxX, minY, maxY, behind } = eye!;
    expect({ id: panel.id, behind, inside: minX >= -1 && maxX <= 1 && minY >= -1 && maxY <= 1 }, JSON.stringify(eye)).toEqual({ id: panel.id, behind: false, inside: true });
  }
  expect(panel.smallest, `${panel.id}: smallest text from the eyes (rad)`).toBeGreaterThanOrEqual(COMFORT);
}

function expectEnglish(panel: PanelReport): void {
  const words = [...panel.text, ...labelsOf(panel)].join(' ');
  expect(words, `${panel.id} copy`).not.toMatch(/[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u);
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

/** Snímek po snímku čeká na stav tlačítka (jako `vr-hud`); `release` pustí spoušť hned ve snímku stisku. */
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

/** Klik paprskem na tlačítko panelu `id`; poloha tlačítka se čte čerstvě (karta mění výšku s náhledem věty). */
async function click(page: Page, id: string, button: string): Promise<void> {
  const panel = await panelOf(page, id);
  const target = panel.buttons.find((candidate) => candidate.id === button);
  if (target === undefined) throw new Error(`${id} has no ${button} button: ${JSON.stringify(panel.buttons.map((candidate) => candidate.id))}`);
  await aim(page, target.at);
  await untilState(page, id, button, 'aimed');
  await untilState(page, id, button, 'pressed', { trigger: 1, release: true });
  // Paprsek z tlačítka pryč: další klik na totéž tlačítko začne znovu od `aimed`. Tlačítko, které klik schoval
  // („Type“, „Done“, „New game“), stav už nehlásí.
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

/** Rozvržení se po kliku překreslí v dalším snímku: čekat na text panelu. */
const expectText = (page: Page, id: string, timeout = 10_000) => expect.poll(() => textOf(page, id), { timeout });

async function drawnInVr(page: Page): Promise<void> {
  await expect.poll(async () => (await xr(page))?.calls ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
}

/** Nová hra z „Make it!“ běží ve VR: adresa `/play/<id>`, HUD hry místo lobby, stav hry, kreslené snímky. */
async function gameRunsInVr(page: Page, before: string): Promise<string> {
  await page.waitForURL((url) => /^\/play\/[a-f0-9]+$/.test(url.pathname) && url.pathname !== before, { timeout: 30_000 });
  const path = new URL(page.url()).pathname;
  await expect.poll(() => ids(page), { timeout: 30_000 }).toEqual(['hud']);
  const report = await xr(page);
  expect(report?.presenting).toBe(true);
  expect(report?.heroAt, 'the new game has a hero in its state').not.toBeNull();
  await drawnInVr(page);
  // Tatáž relace: o žádnou další si stránka neřekla a žádná neskončila.
  expect(await sessions(page)).toEqual({ requests: 1, ended: 0 });
  return path;
}

/** Těla skriptů, které stránka stáhla (jako `vr-enter`): kód lobby smí být jen v chunku XR. */
function scriptsOf(page: Page): () => Promise<string[]> {
  const bodies: Promise<string>[] = [];
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script') bodies.push(response.text().catch(() => ''));
  });
  return () => Promise.all(bodies);
}

test.beforeEach(() => {
  // Vstup do VR, klávesnice, dvě hry z věty a jedna dohraná se do výchozích 30 s nevejdou.
  test.setTimeout(240_000);
});

test('a browser without immersive-vr gets no Enter VR on /play and downloads no lobby code', async ({ page }) => {
  const scripts = scriptsOf(page);
  await page.goto('/play');
  await expect(page.locator('.play-hero')).toBeVisible();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page.locator('.play-appbar').getByTestId('enter-vr')).toHaveCount(0);
  const bodies = await scripts();
  expect(bodies.length).toBeGreaterThan(0);
  // „More ideas“ žije jen v `XrLobby.tsx`.
  expect(bodies.filter((body) => body.includes('More ideas'))).toHaveLength(0);
});

test('Enter VR on /play opens the lobby; Type, a sentence card and Make it! start the game in the same XR session, New game makes another', async ({ page }) => {
  await withQuest2(page);
  // Bez Web Speech lobby „Say it“ nemá (P67 T3): řada tlačítek níž je přesně „More ideas“, „Type“, „Make it!“.
  await withoutSpeech(page);
  await page.goto('/play');
  const enter = page.locator('.play-appbar').getByTestId('enter-vr');
  await expect(enter).toBeVisible({ timeout: 30_000 });
  await enter.click();
  await expect.poll(async () => (await xr(page))?.presenting, { timeout: 15_000 }).toBe(true);

  // Lobby místo HUD hry z feedu: šest karet z nápadů a startovních vět v pevném pořadí, „More ideas“, „Type“, „Make it!“.
  const lobby = await panelOf(page, 'lobby');
  console.log(`lobby ${JSON.stringify({ text: lobby.text, eyes: lobby.eyes, smallest: lobby.smallest })}`);
  expect(await ids(page)).toEqual(['lobby']);
  expect(lobby.buttons.map((button) => button.id)).toEqual(['idea-0', 'idea-1', 'idea-2', 'idea-3', 'idea-4', 'idea-5', 'comfort', 'more', 'type', 'make']);
  expect(labelsOf(lobby)).toEqual([...POOL.slice(0, 6), 'Comfort', 'More ideas', 'Type', 'Make it!']);
  expect(lobby.text.join(' ')).toContain('Say it in one sentence');
  expectSeen(lobby);
  expectEnglish(lobby);

  // „More ideas“ listuje dál a dokola zpátky na první stránku.
  await click(page, 'lobby', 'more');
  await expect.poll(async () => labelsOf(await panelOf(page, 'lobby')).slice(0, 6)).toEqual(POOL.slice(6, 12));
  await click(page, 'lobby', 'more');
  await expect.poll(async () => labelsOf(await panelOf(page, 'lobby')).slice(0, 6)).toEqual(POOL.slice(0, 6));

  // „Type“: klávesnice pod kartou; písmena, mezera (dvakrát = jednou), mazání; náhled a počítadlo na kartě lobby.
  await click(page, 'lobby', 'type');
  const keyboard = await panelOf(page, 'keyboard');
  console.log(`keyboard ${JSON.stringify({ eyes: keyboard.eyes, smallest: keyboard.smallest })}`);
  expect(keyboard.buttons).toHaveLength(43);
  expect(labelsOf(keyboard).slice(10, 20).join('')).toBe('qwertyuiop');
  expect(labelsOf(keyboard).slice(-3)).toEqual(['Space', 'Delete', 'Done']);
  expectSeen(keyboard);
  expectEnglish(keyboard);
  for (const key of ['key-c', 'key-a', 'key-t', 'space', 'space', 'key-s', 'delete']) await click(page, 'keyboard', key);
  await expectText(page, 'lobby').toContain('Cat |');
  await expectText(page, 'lobby').toContain('4/140');
  await click(page, 'keyboard', 'done');
  await expect.poll(() => ids(page)).toEqual(['lobby']);
  await expectText(page, 'lobby').toContain('Say it in one sentence Cat');

  // „Comfort“ (P67 T9): panel pohodlí místo karty, „Done“ vrátí lobby i s rozepsanou větou.
  await click(page, 'lobby', 'comfort');
  await expect.poll(() => ids(page)).toEqual(['comfort']);
  expectEnglish(await panelOf(page, 'comfort'));
  await click(page, 'comfort', 'done');
  await expect.poll(() => ids(page)).toEqual(['lobby']);
  await expectText(page, 'lobby').toContain('Say it in one sentence Cat');

  // Karta větu jen vloží do náhledu (kit: klepnutí nespouští stavbu).
  await click(page, 'lobby', 'idea-0');
  await expectText(page, 'lobby').toContain(POOL[0]!);
  expect(new URL(page.url()).pathname).toBe('/play');

  // Dveře hru nepostaví: chyba kitu na kartě, lobby zůstane.
  let fail = true;
  let hold = false;
  await page.route('**/api/play/games', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (fail) {
      fail = false;
      return route.fulfill({ status: 422, json: { error: { code: 'NOT_PLAYABLE', message: 'no playable game' } } });
    }
    // Druhé odeslání chvíli podrží, ať je „Making…“ vidět.
    if (hold) await new Promise((resolve) => setTimeout(resolve, 1500));
    return route.fallback();
  });
  await click(page, 'lobby', 'make');
  await expectText(page, 'lobby').toContain(BUILD_FAILED);
  expect(await ids(page)).toEqual(['lobby']);

  // „Make it!“: „Making…“, pak navigace na `/play/<id>` – a brýle zůstanou ve VR s novou hrou.
  hold = true;
  await click(page, 'lobby', 'make');
  await expect.poll(async () => labelsOf(await panelOf(page, 'lobby')).at(-1), { timeout: 5_000 }).toBe('Making…');
  const first = await gameRunsInVr(page, '/play');

  // Konec hry → „New game“ na výsledku → lobby → další karta → další hra, pořád tatáž relace.
  const end = await page.evaluate(() => (window.__playShell as unknown as Shell).handPlay('end'));
  expect(['won', 'lost']).toContain(end.runState);
  const result = await panelOf(page, 'result');
  expect(labelsOf(result)).toEqual(['New game', 'Exit VR', 'Comfort', 'Share', 'Next', 'Again']);
  expectEnglish(result);
  await click(page, 'result', 'new');
  await expect.poll(() => ids(page), { timeout: 10_000 }).toEqual(['lobby']);
  await click(page, 'lobby', 'idea-1');
  await expectText(page, 'lobby').toContain(POOL[1]!);
  await click(page, 'lobby', 'make');
  await gameRunsInVr(page, first);
});

test('Say it dictates the sentence into the lobby preview with no request of its own: Listening…, Cancel, a blocked microphone, then Make it! makes the game', async ({ page }) => {
  await withQuest2(page);
  await withSpeech(page);
  await page.goto('/play');
  const enter = page.locator('.play-appbar').getByTestId('enter-vr');
  await expect(enter).toBeVisible({ timeout: 30_000 });
  await enter.click();
  await expect.poll(async () => (await xr(page))?.presenting, { timeout: 15_000 }).toBe(true);

  // Prohlížeč diktuje: „Say it“ mezi „Type“ a „Make it!“, celé v obraze, anglicky.
  const lobby = await panelOf(page, 'lobby');
  expect(lobby.buttons.map((button) => button.id).slice(-4)).toEqual(['more', 'type', 'mic', 'make']);
  expect(labelsOf(lobby).slice(-4)).toEqual(['More ideas', 'Type', 'Say it', 'Make it!']);
  expectSeen(lobby);
  expectEnglish(lobby);
  await page.screenshot({ path: test.info().outputPath('lobby-say-it.png') });

  // Od teď až po přepis nesmí stránka nic poslat ani stáhnout: přepis dělá prohlížeč, ne naše API ani placená služba.
  // Výjimka jsou soubory scény z našeho serveru (modely `/assets/`, chunky): hra feedu za lobby si je dotahuje,
  // kdy potřebuje, a přepis jimi odejít nemůže (P67 T14: modely přišly uprostřed diktování na studeném serveru).
  const requests: string[] = [];
  const sceneFile = (request: { method(): string; url(): string }): boolean => {
    const url = new URL(request.url());
    return request.method() === 'GET' && url.origin === new URL(page.url()).origin && /^\/(assets|_next\/static)\//.test(url.pathname);
  };
  const watch = (request: { method(): string; url(): string }) => {
    if (!sceneFile(request)) requests.push(`${request.method()} ${request.url()}`);
  };
  page.on('request', watch);

  // „Listening…“ místo titulku a „Cancel“ na tlačítku; „Cancel“ poslech ukončí a co prohlížeč dopošle, zahodí.
  await speechMode(page, 'hold');
  await click(page, 'lobby', 'mic');
  await expectText(page, 'lobby').toContain('Listening…');
  expect(labelsOf(await panelOf(page, 'lobby')).slice(-2)).toEqual(['Cancel', 'Make it!']);
  await click(page, 'lobby', 'mic');
  await expectText(page, 'lobby').toContain('Say it in one sentence');
  await expect.poll(async () => labelsOf(await panelOf(page, 'lobby')).slice(-2)).toEqual(['Say it', 'Make it!']);
  await page.waitForTimeout(500);
  expect(await textOf(page, 'lobby')).not.toContain(LATE);

  // Zamítnutý mikrofon: věta kitu na kartě, tlačítko zpátky na „Say it“.
  await speechMode(page, 'error');
  await click(page, 'lobby', 'mic');
  await expectText(page, 'lobby').toContain('The microphone is blocked for this page. You can type instead.');
  await expect.poll(async () => labelsOf(await panelOf(page, 'lobby')).slice(-2)).toEqual(['Say it', 'Make it!']);

  // Přepis do náhledu (chyba zmizí); hru spustí až „Make it!“.
  await speechMode(page, 'text');
  await click(page, 'lobby', 'mic');
  await expectText(page, 'lobby').toContain(`Say it in one sentence ${SPOKEN}`);
  expect(await textOf(page, 'lobby')).not.toContain('microphone is blocked');
  expect(new URL(page.url()).pathname).toBe('/play');
  page.off('request', watch);
  expect(requests, 'requests while dictating').toEqual([]);
  expect(await page.evaluate(() => (window as unknown as SpeechWindow).__speechStarts)).toBe(3);

  await click(page, 'lobby', 'make');
  await gameRunsInVr(page, '/play');
});
