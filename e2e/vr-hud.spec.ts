import { join } from 'node:path';

import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import type { PanelReport, XrReport } from '../src/components/play/xr/XrRig';
import { assemblyOfCell, liveCells } from '../src/play/compose/allowed';
import { compileRecipe } from '../src/play/compose/compile';
import { COMFORT_KEY, SEATED_DROP } from '../src/play/xr/comfort';
import { TABLE } from '../src/play/xr/diorama-scale';

import { HUD_COUNTER_LABELS, counterLabelsFor } from './hud-labels';

/**
 * HUD ve VR (P65 T5) v emulátoru IWER: DOM se v relaci nekreslí (emulátor stránku překryje plátnem brýlí, Quest ji
 * nekreslí vůbec), cíl, počítadla, výsledek a „AI version ready“ jsou 3D panely a ovládají se paprskem pravého
 * ovladače a spouští – stejně jako na Questu. Sonda `__playXr().panels` říká, co na panelu stojí, kde jsou tlačítka
 * a kam panel padne do obrazu obou očí; „je vidět“ = celý panel uvnitř snímku obou očí, ne jen „panel existuje“.
 * Panely se kreslí přes scénu, takže je nic nezakryje. Čitelnost: nejmenší text panelu má od očí aspoň úhel textu
 * kitu 13 px na 1 m (`KIT_PX`).
 *
 * Hlava stojí jako hráč u stolu (T4): oči 1,6 m, pohled na střed desky. U VR-nativních her hráč zvedne levé zápěstí
 * před sebe a podívá se na ně. Klik = paprsek pravé ruky na střed tlačítka, spoušť dolů a nahoru.
 */

const IWER_BUNDLE = join(process.cwd(), 'node_modules/iwer/build/iwer.min.js');

/**
 * Věta s počtem (P61 T5): počítadlo cíle nese slovo věty. Hra z ní je quest na stole; sběr klíčů v aréně
 * (`interface-language.spec.ts`) se od P67 T6 hraje kolem hráče, ne na stole.
 */
const COUNTED = 'A knight must light three candles in a haunted castle';
const QUICK = 'A hamster escapes a supermarket while a giant Roomba hunts it.';

/** Nejmenší text panelu od očí (rad): text kitu 13 px na 1 m je 0,026 rad. */
const READABLE = 0.025;
/** Panel „Comfort“ stojí před hráčem jako lobby: nejmenší text aspoň 0,9° (pravidla plánu P67, komfort Mety). */
const COMFORT_TEXT = (0.9 * Math.PI) / 180;
type Hand = readonly [number, number, number];
/** Pravá ruka, odkud paprsek míří na tlačítka u stolu. */
const HAND: Hand = [0.2, 1.2, -0.25];
/** Pravá ruka zvednutá k obličeji, míří dolů na levé zápěstí zepředu (panel je natočený k hlavě). */
const TO_WRIST: Hand = [0.15, 1.42, -0.2];

interface Counters {
  readonly runState: string;
  readonly tick: number;
}
interface HandProbe {
  byHand(on: boolean): void;
  tickByHand(): Counters;
  tick(): number;
  inputs(): readonly unknown[];
  capture(): { readonly inputs: readonly { readonly tick: number; readonly buttons: number }[] };
  handPlay(until: 'score' | 'end'): Counters;
  idleRun(): Counters;
}
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
/** Okno s emulátorem; typy `IWER` a `__iwerSession` deklarují jiné spec soubory jinak, proto přes přetypování. */
interface QuestWindow {
  readonly IWER: { XRDevice: new (config: unknown) => Quest; metaQuest2: unknown };
  __quest: Quest;
  __hudSession?: XRSession;
}

/** Jak hráč stojí: sklon hlavy dolů (rad) a levé zápěstí. */
interface Stance {
  readonly pitch: number;
  readonly left: readonly [number, number, number];
}
/** U stolu: pohled na střed desky (T4), levá ruka dole u stolu. */
const AT_DESK: Stance = { pitch: Math.atan2(1.6 - TABLE.top, -TABLE.z), left: [-0.3, 1.1, -0.4] };
/** VR-nativní hra: hráč zvedne levé zápěstí před sebe a podívá se na něj (hlava o 25° dolů). */
const WRIST_UP: Stance = { pitch: (25 * Math.PI) / 180, left: [-0.06, 1.3, -0.36] };

async function withQuest2(page: Page, stance: Stance): Promise<void> {
  await page.addInitScript({ path: IWER_BUNDLE });
  await page.addInitScript(
    ({ stance, hand }) => {
      const self = window as unknown as QuestWindow;
      const device = new self.IWER.XRDevice(self.IWER.metaQuest2);
      device.stereoEnabled = true;
      device.installRuntime({ forceInstall: true });
      device.position.set(0, 1.6, 0);
      device.quaternion.set(-Math.sin(stance.pitch / 2), 0, 0, Math.cos(stance.pitch / 2));
      // Paprsek pravé ruky svisle nahoru: na nic nemíří, dokud ho test nenamíří.
      device.controllers.right?.position.set(...hand);
      device.controllers.right?.quaternion.set(Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      device.controllers.left?.position.set(...stance.left);
      device.controllers.left?.quaternion.set(0, 0, 0, 1);
      self.__quest = device;
      const xr = navigator.xr!;
      const request = xr.requestSession.bind(xr);
      xr.requestSession = async (...args) => {
        const session = await request(...args);
        self.__hudSession = session;
        return session;
      };
    },
    { stance, hand: HAND },
  );
}

interface Created {
  readonly url: string;
  readonly versionId: string;
  readonly upgrade?: string;
}

async function publish(request: APIRequestContext, data: Record<string, unknown>): Promise<Created> {
  const response = await request.post('/api/play/games', { data });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return (await response.json()) as Created;
}

function specOf(id: string) {
  const cell = liveCells().find((candidate) => candidate.id === id);
  if (cell === undefined) throw new Error(`${id} is not a live cell`);
  return compileRecipe(assemblyOfCell(cell));
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 90_000 });
  await page.evaluate(() => (window.__playShell as unknown as HandProbe).byHand(true));
}

const xr = (page: Page): Promise<XrReport | null> => page.evaluate(() => window.__playXr?.() ?? null);

async function enterVr(page: Page): Promise<void> {
  await page.getByTestId('enter-vr').click();
  await expect.poll(async () => (await xr(page))?.presenting, { timeout: 15_000 }).toBe(true);
}

const ids = async (page: Page): Promise<string[]> => ((await xr(page))?.panels ?? []).map((panel) => panel.id).sort();

/**
 * Panel `id`, jakmile ho scéna kreslí (a písmo je načtené – rozvržení se pak ustálí). Hledá se ve stránce každý
 * snímek: dotazy testu chodí po 100 ms až 1 s a krátký panel („AI version ready“ na 3 s) by pod zátěží minuly.
 */
async function panelOf(page: Page, id: string): Promise<PanelReport> {
  const panel = await page.evaluate(async (id) => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const find = () => window.__playXr?.().panels.find((candidate) => candidate.id === id) ?? null;
    const until = performance.now() + 15_000;
    while (find() === null && performance.now() < until) await frame();
    // Dva snímky na dokreslení po rozvržení s načteným písmem.
    await frame();
    await frame();
    return find();
  }, id);
  expect(panel, `${id} panel in the scene`).not.toBeNull();
  return panel!;
}

/** Celý panel v obraze obou očí (ne za okem) a nejmenší text čitelný jako text kitu na 1 m. */
function expectSeen(panel: PanelReport): void {
  expect(panel.eyes, `${panel.id}: both eyes`).toHaveLength(2);
  for (const eye of panel.eyes) {
    expect(eye, `${panel.id}: drawn`).not.toBeNull();
    const { minX, maxX, minY, maxY, behind } = eye!;
    expect({ id: panel.id, behind, inside: minX >= -1 && maxX <= 1 && minY >= -1 && maxY <= 1 }, JSON.stringify(eye)).toEqual({ id: panel.id, behind: false, inside: true });
  }
  expect(panel.smallest, `${panel.id}: smallest text from the eyes (rad)`).toBeGreaterThanOrEqual(READABLE);
}

/** Text panelů anglicky: žádná česká písmena (jako `interface-language.spec.ts`). */
function expectEnglish(panel: PanelReport): void {
  const words = [...panel.text, ...panel.buttons.map((button) => button.label)].join(' ');
  expect(words, `${panel.id} copy`).not.toMatch(/[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u);
}

const buttonOf = (panel: PanelReport, id: string): PanelReport['buttons'][number] => {
  const button = panel.buttons.find((candidate) => candidate.id === id);
  if (button === undefined) throw new Error(`${panel.id} has no ${id} button: ${JSON.stringify(panel.buttons)}`);
  return button;
};

type Point = PanelReport['buttons'][number]['at'];

/** Pár snímků stránky: ovladače čte hra v `useFrame`. */
const frames = (page: Page, count = 6): Promise<void> =>
  page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const next = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => next(left - 1)));
        next(count);
      }),
    count,
  );

/** Pravá ruka v `from`, paprsek na bod `at` (`null` = svisle nahoru, mimo panely). */
async function aim(page: Page, at: Point | null, from: Hand = HAND): Promise<void> {
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
    { at, from },
  );
}

const trigger = (page: Page, value: 0 | 1): Promise<void> =>
  page.evaluate((value) => (window as unknown as QuestWindow).__quest.controllers.right!.updateButtonValue('trigger', value), value);

type KeyState = PanelReport['buttons'][number]['state'];

/**
 * Snímek po snímku ve stránce čeká, až tlačítko hlásí stav `want` (`aimed` = paprsek na něm, `pressed` = spoušť na něm
 * dole). `trigger` nastaví spoušť pravé ruky před čekáním; `release` ji pustí hned ve snímku, kdy tlačítko stisk
 * ohlásí – klik je stisk a puštění na tlačítku do 1 s (`clickThresholdMs` v `XrRoot`) a dotazy testu po 100 ms
 * až 1 s by puštění pod zátěží odsunuly za tu mez.
 */
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

/** Paprsek na tlačítko a počkat, až ho tlačítko ucítí; pak spoušť dolů a počkat na stisk. */
async function press(page: Page, panel: PanelReport, button: string, from: Hand = HAND): Promise<void> {
  await aim(page, buttonOf(panel, button).at, from);
  await untilState(page, panel.id, button, 'aimed');
  await untilState(page, panel.id, button, 'pressed', { trigger: 1 });
}

/** Klik paprskem: stisk na tlačítku a puštění spouště na něm, hned jak tlačítko stisk ohlásí. */
async function click(page: Page, panel: PanelReport, button: string, from: Hand = HAND): Promise<void> {
  await aim(page, buttonOf(panel, button).at, from);
  await untilState(page, panel.id, button, 'aimed');
  await untilState(page, panel.id, button, 'pressed', { trigger: 1, release: true });
}

/** Jeden tik ručními hodinami; vrací, kolik vstupů hra zatím dostala. */
const tickInputs = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const shell = window.__playShell as unknown as HandProbe;
    shell.tickByHand();
    return shell.capture().inputs.length;
  });
const handPlayEnd = (page: Page): Promise<Counters> => page.evaluate(() => (window.__playShell as unknown as HandProbe).handPlay('end'));
const fresh = (page: Page): Promise<readonly number[]> =>
  page.evaluate(() => {
    const shell = window.__playShell as unknown as HandProbe;
    return [shell.tick(), shell.inputs().length];
  });

test.beforeEach(async () => {
  // Hra z věty, vstup do VR, dvě dohrané hry a návrat do 2D se do výchozích 30 s nevejdou.
  test.setTimeout(180_000);
});

test('table-top: the goal board is in view, a bot win shows You did it!, Again restarts, Exit VR returns the 2D result to share and remix', async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const game = await publish(request, { sentence: COUNTED });
  await withQuest2(page, AT_DESK);
  await page.goto(`${game.url}?vr=1`);
  await ready(page);
  const goalLine = ((await page.getByTestId('play-goal').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  expect(goalLine.length).toBeGreaterThan(0);
  const domLabels = await page.locator('[data-testid^="hud-counter-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.slice('hud-counter-'.length)));
  await enterVr(page);
  await expect.poll(async () => (await xr(page))?.desk?.scale ?? null, { timeout: 15_000 }).not.toBeNull();

  // Tabule cíle: cíl hry, počítadlo se slovem věty a „Exit VR“; celá v obou očích a čitelná.
  const hud = await panelOf(page, 'hud');
  console.log(`hud ${JSON.stringify({ text: hud.text, eyes: hud.eyes, smallest: hud.smallest })}`);
  expect(hud.text.join(' ')).toContain(goalLine);
  expect(hud.text).toContain('0/3 candles');
  expect(buttonOf(hud, 'exit').label).toBe('Exit VR');
  expectSeen(hud);
  expectEnglish(hud);
  // Popisky počítadel tytéž jako v DOM HUD: z uzavřeného seznamu, navíc jen slovo věty.
  const allowed = counterLabelsFor(COUNTED);
  for (const label of hud.labels) expect(allowed, `${label} mimo seznam`).toContain(label);
  expect(hud.labels.filter((label) => !HUD_COUNTER_LABELS.includes(label))).toEqual(['candles']);
  expect([...hud.labels].sort()).toEqual([...domLabels].sort());

  // Spoušť stisknutá s paprskem na tlačítku patří panelu: paprsek z tlačítka sjede, spoušť se pustí jinde (žádný klik)
  // a hra nedostane nic. Týž stisk s paprskem mimo panely do hry jde – kontrola, že test měří spoušť.
  await press(page, hud, 'exit');
  await aim(page, null);
  await untilState(page, 'hud', 'exit', 'rest');
  await trigger(page, 0);
  await frames(page);
  expect(await tickInputs(page)).toBe(0);
  expect((await xr(page))?.presenting).toBe(true);
  await trigger(page, 1);
  await frames(page);
  const reached = await tickInputs(page);
  await trigger(page, 0);
  expect(reached, 'the trigger off the panels reaches the game').toBeGreaterThan(0);

  // Výhra robota: výsledek „You did it!“ stojí na stole, tabule HUD zmizí.
  expect((await handPlayEnd(page)).runState).toBe('won');
  const won = await panelOf(page, 'result');
  console.log(`result ${JSON.stringify({ text: won.text, eyes: won.eyes, smallest: won.smallest })}`);
  expect(won.text).toContain('You did it!');
  // „New game“ (P67 T2) vede do VR lobby, „Comfort“ (P67 T9) na panel pohodlí, „Share“ (P67 T5) na kartu s QR kódem;
  // vedlejší akce stojí nad „Again“.
  expect(won.buttons.map((button) => button.label)).toEqual(['New game', 'Exit VR', 'Comfort', 'Share', 'Again']);
  expectSeen(won);
  expectEnglish(won);
  expect(await ids(page)).not.toContain('hud');

  // „Again“ začne hru znovu: tik 0, žádný vstup (spoušť kliku do hry nešla), výsledek pryč, tabule zpět.
  await click(page, won, 'again');
  await expect.poll(() => ids(page), { timeout: 10_000 }).toEqual(['hud']);
  expect(await fresh(page)).toEqual([0, 0]);

  // Druhá výhra a „Exit VR“: relace skončí a stránka ukáže 2D výsledek.
  expect((await handPlayEnd(page)).runState).toBe('won');
  const again = await panelOf(page, 'result');
  await click(page, again, 'exit');
  await expect.poll(async () => (await xr(page))?.presenting, { timeout: 15_000 }).toBe(false);
  const postRun = page.getByTestId('play-postrun');
  await expect(postRun).toBeVisible();
  await expect(postRun).toContainText('You did it!');

  // Z 2D výsledku jde sdílet (odkaz ve schránce) i remixovat (list „Change one thing“).
  const share = page.getByTestId('play-share');
  await expect(share).toBeEnabled({ timeout: 15_000 });
  await share.click();
  await expect(page.getByText('Link copied. Go dare someone.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(game.url);
  await page.getByRole('button', { name: 'Remix it' }).click();
  await expect(page.getByRole('dialog', { name: 'Change one thing' })).toBeVisible();
  await expect(page.getByTestId('remix-input')).toBeVisible();
});

/**
 * Panel „Comfort“ (P67 T9) z výsledku hry na stole. Volba, která se uloží a nepoužije, vypadá funkčně – proto se
 * měří, co rig postavil: výška a měřítko desky a hrdina na ní ze sondy, vypínače, které čte hra, a po novém načtení
 * stránky stůl pořád nízko.
 */
test('Comfort from the result: Seated lowers the table and stays after a reload, Large enlarges the world, Recenter turns it to the view, Haptics and Vignette switch off', async ({ page, request }) => {
  const game = await publish(request, { sentence: COUNTED });
  await withQuest2(page, AT_DESK);
  await page.goto(`${game.url}?vr=1`);
  await ready(page);
  await enterVr(page);
  await expect.poll(async () => (await xr(page))?.desk?.top ?? -1, { timeout: 15_000 }).toBeCloseTo(TABLE.top, 6);
  expect((await xr(page))?.switches).toEqual({ haptics: true, vignette: true });

  // Výsledek → „Comfort“: karta místo výsledku, celá v obraze obou očí i od stolu, text aspoň 0,9°, anglicky.
  expect((await handPlayEnd(page)).runState).toBe('won');
  await click(page, await panelOf(page, 'result'), 'comfort');
  const comfort = await panelOf(page, 'comfort');
  console.log(`comfort ${JSON.stringify({ text: comfort.text, eyes: comfort.eyes, smallest: comfort.smallest })}`);
  expect(await ids(page)).toEqual(['comfort']);
  expect(comfort.text).toEqual(['Comfort']);
  expect(comfort.buttons.map((button) => button.label)).toEqual(['Standing', 'Seated', 'Recenter', 'Small', 'Medium', 'Large', 'Haptics on', 'Vignette on', 'Done']);
  for (const eye of comfort.eyes) expect(eye !== null && !eye.behind && eye.minX >= -1 && eye.maxX <= 1 && eye.minY >= -1 && eye.maxY <= 1, JSON.stringify(eye)).toBe(true);
  expect(comfort.smallest).toBeGreaterThanOrEqual(COMFORT_TEXT);
  expectEnglish(comfort);

  // „Seated“: stůl o 40 cm níž a svět na něm s ním – hrdina klesne stejně a na desce stojí, kde stál.
  const before = (await xr(page))!;
  await click(page, comfort, 'seated');
  await expect.poll(async () => (await xr(page))?.desk?.top ?? -1).toBeCloseTo(TABLE.top - SEATED_DROP, 6);
  const seated = (await xr(page))!;
  expect(seated.heroWorld!.y).toBeCloseTo(before.heroWorld!.y - SEATED_DROP, 3);
  for (const axis of ['x', 'y', 'z'] as const) expect(seated.heroOnDesk![axis]).toBeCloseTo(before.heroOnDesk![axis], 3);

  // „Large“: svět na stole 1,25× větší.
  await click(page, comfort, 'large');
  await expect.poll(async () => (await xr(page))?.desk?.scale ?? -1).toBeCloseTo(before.desk!.scale * 1.25, 6);

  // „Haptics“ a „Vignette“ vypnuté: popisek nese stav a hra čte vypnuté vypínače.
  await click(page, comfort, 'haptics');
  await click(page, comfort, 'vignette');
  await expect.poll(async () => (await xr(page))?.switches).toEqual({ haptics: false, vignette: false });
  expect((await panelOf(page, 'comfort')).buttons.map((button) => button.label).slice(6, 8)).toEqual(['Haptics off', 'Vignette off']);
  const saved = await page.evaluate((key) => localStorage.getItem(key), COMFORT_KEY);
  expect(JSON.parse(saved ?? 'null')).toEqual({ stance: 'seated', size: 'large', haptics: false, vignette: false });

  // „Recenter“ s hlavou otočenou o čtvrt kruhu doleva: stůl stojí před ní (na −x) a je k ní otočený; vsedě zůstane.
  await page.evaluate(() => (window as unknown as QuestWindow).__quest.quaternion.set(0, Math.SQRT1_2, 0, Math.SQRT1_2));
  await click(page, comfort, 'recenter');
  await expect.poll(async () => (await xr(page))?.desk?.yaw ?? -1).toBeCloseTo(Math.PI / 2, 3);
  const turned = (await xr(page))!.desk!;
  expect(turned.x).toBeCloseTo(TABLE.z, 3);
  expect(turned.z).toBeCloseTo(0, 3);
  expect(turned.top).toBeCloseTo(TABLE.top - SEATED_DROP, 6);

  // „Done“: zpátky výsledek (karta pohodlí se po „Recenter“ postavila před otočenou hlavu).
  await click(page, await panelOf(page, 'comfort'), 'done');
  await expect.poll(() => ids(page)).toEqual(['result']);

  // Nové načtení: uložené volby platí od prvního snímku; „Recenter“ patří relaci, stůl je zase na −z.
  await page.reload();
  await ready(page);
  await enterVr(page);
  await expect.poll(async () => (await xr(page))?.desk?.top ?? -1, { timeout: 15_000 }).toBeCloseTo(TABLE.top - SEATED_DROP, 6);
  const reloaded = (await xr(page))!;
  expect(reloaded.desk!.yaw).toBeCloseTo(0, 6);
  expect(reloaded.switches).toEqual({ haptics: false, vignette: false });
});

test('VR-native: the HUD rides the left wrist, a loss shows So close., Again restarts', async ({ page, request }) => {
  const game = await publish(request, { spec: specOf('shooter.default') });
  await withQuest2(page, WRIST_UP);
  await page.goto(`${game.url}?vr=1`);
  await ready(page);
  await enterVr(page);

  const hud = await panelOf(page, 'hud');
  console.log(`wrist hud ${JSON.stringify({ text: hud.text, eyes: hud.eyes, smallest: hud.smallest })}`);
  expect(hud.text.some((line) => line.endsWith('shots left'))).toBe(true);
  expectSeen(hud);
  expectEnglish(hud);
  // Na zápěstí: panel je u levé ruky (do 0,3 m), ne u stolu.
  const exit = buttonOf(hud, 'exit').at;
  expect(Math.hypot(exit.x - WRIST_UP.left[0], exit.y - WRIST_UP.left[1], exit.z - WRIST_UP.left[2])).toBeLessThan(0.3);

  expect((await page.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun())).runState).toBe('lost');
  const lost = await panelOf(page, 'result');
  console.log(`wrist result ${JSON.stringify({ text: lost.text, eyes: lost.eyes, smallest: lost.smallest })}`);
  expect(lost.text).toContain('So close.');
  expectSeen(lost);
  expect(await ids(page)).not.toContain('hud');

  await click(page, lost, 'again', TO_WRIST);
  await expect.poll(() => ids(page), { timeout: 10_000 }).toEqual(['hud']);
  expect(await fresh(page)).toEqual([0, 0]);
  expect((await xr(page))?.presenting).toBe(true);
});

/** Podvržený `GET …/upgrade` jako v `play-upgrade.spec.ts`: odpověď podle `answer()`, bez modelu a bez útraty. */
async function fakeUpgrade(page: Page, quick: Created, answer: () => Record<string, unknown>): Promise<void> {
  await page.route(`**${quick.upgrade!}`, async (route) => {
    await route.fulfill({ json: answer(), headers: { 'cache-control': 'no-store' } });
  });
}

const pending = (): Record<string, unknown> => ({ status: 'pending', deadlineAt: new Date(Date.now() + 285_000).toISOString() });

test('the full-detail version ready: an AI version ready panel offers Play it, and the game swaps without leaving VR', async ({ page, request }) => {
  const quick = await publish(request, { sentence: QUICK });
  const full = await publish(request, { spec: specOf('runner.default') });
  let done = false;
  await fakeUpgrade(page, quick, () => (done ? { status: 'ready', versionId: full.versionId } : pending()));
  await withQuest2(page, AT_DESK);
  await page.goto(`${quick.url}?vr=1`);
  await ready(page);
  await enterVr(page);
  await panelOf(page, 'hud');

  done = true;
  const offer = await panelOf(page, 'notice');
  console.log(`notice ${JSON.stringify({ text: offer.text, eyes: offer.eyes })}`);
  expect(offer.text).toEqual(['AI version ready']);
  expect(offer.buttons.map((button) => button.label)).toEqual(['Play it']);
  expectSeen(offer);

  await click(page, offer, 'open');
  await page.waitForURL(`**/play/${full.versionId}`, { timeout: 20_000 });
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  expect((await xr(page))?.presenting).toBe(true);
  const goalLine = specOf('runner.default').tutorial.goalLine.replace(/\s+/g, ' ').trim();
  await expect.poll(async () => ((await xr(page))?.panels.find((panel) => panel.id === 'hud')?.text ?? []).join(' '), { timeout: 15_000 }).toContain(goalLine);
  await expect.poll(() => ids(page)).toEqual(['hud']);
});

test('the game switches to the one that matches the idea: AI version ready shows briefly in VR', async ({ page, request }) => {
  const quick = await publish(request, { sentence: QUICK });
  const matched = await publish(request, { spec: specOf('runner.default') });
  // Čtení dorazí až v relaci: přechod před vstupem do VR by panel (3 s od příchodu hry) odbyl ještě ve 2D.
  let read = false;
  await fakeUpgrade(page, quick, () => (read ? { ...pending(), reading: { versionId: matched.versionId } } : pending()));
  await withQuest2(page, AT_DESK);
  await page.goto(`${quick.url}?vr=1`);
  await ready(page);
  await enterVr(page);

  read = true;
  await page.waitForURL(`**/play/${matched.versionId}`, { timeout: 20_000 });
  const notice = await panelOf(page, 'notice');
  expect(notice.text).toEqual(['AI version ready']);
  expect(notice.buttons).toEqual([]);
  expectSeen(notice);
  expect((await xr(page))?.presenting).toBe(true);
  // Krátce: po 3 s (`TOAST_MS`) panel zmizí, HUD nové hry zůstane.
  await expect.poll(() => ids(page), { timeout: 10_000 }).toEqual(['hud']);
});
