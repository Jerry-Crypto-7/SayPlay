import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';
import sharp from 'sharp';

import type { FrameReport } from '../src/components/play/arcade/ArcadeStage';
import { arenaGenre } from '../src/play/genre/arena';
import { compileGenre, readGenreSpec } from '../src/play/genre/index';
import type { GameSpecV1 } from '../src/play/spec';

/**
 * Aréna ve stylu B (P32E T5): kočka sbírá ryby na zamrzlém jezeře a honí ji
 * lední medvěd. Věta z přijímací sady P32 jde přes `draftFill` modulu arény
 * (rychlá verze bez modelu) a `compileGenre` na `GameSpecV1`, který se
 * publikuje jako každá jiná hra.
 *
 * Na desktopu 1280×720 i na Pixel 7 se 4× pomalejším CPU snímky do
 * `evals/play/p32/arena/`: start, probuzení medvěda, honička uprostřed běhu
 * a výhra. Snímky posuzuje autor v O10; test hlídá, co jde změřit:
 * - hrdina má aspoň 4 % výšky obrazu,
 * - pronásledovatel je na prvním snímku v záběru,
 * - při probuzení svítí vykřičník (`data-alerts`),
 * - podlaha je led (sada `snow`), žádná fialová,
 * - FPS Pixel 7 se 4× CPU aspoň 30.
 *
 * Souboj rytířů (P32E T6, věta `knights`) na týchž zařízeních: nápřah soupeře
 * (hráč stojí, soupeř chystá úder), zásah (hra člověka klávesnicí – jen ta
 * pustí částice sběrnice efektů), prohra (hráč stojí, rytíř padne klipem
 * `die`) a KO soupeře (robot „rukou“ dohraje k výhře). Test hlídá sondu scény
 * `data-fight` (nápřah rudne, zásah bliká, poražený leží), klipy riggovaných
 * postav, lišty HP pro čtečku (`role="meter"`) a FPS Pixel 7.
 */

const SENTENCES = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p32/sentences.json'), 'utf8')) as { sentences: { id: string; text: string; hero: string }[] }).sentences;

/** Rychlá verze bez modelu; hrdinu, kterého slovník věty nenajde („Two knights“), doplní přijímací sada. */
function arenaSpec(id: 'cat' | 'knights'): GameSpecV1 {
  const sentence = SENTENCES.find((entry) => entry.id === id)!;
  const read = readGenreSpec({ hero: sentence.hero, ...arenaGenre.draftFill(sentence.text, null) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

async function publishSpec(request: APIRequestContext, spec: unknown): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

const SHOTS = join(process.cwd(), 'evals/play/p32/arena');

/** Nad plátnem nic: HUD a „+1“ se mění jinak než scéna (jako `p32-penguin`). */
const ONLY_CANVAS = 'body * { visibility: hidden !important; } [data-testid="arcade-stage"] canvas, .play-threat-edge { visibility: visible !important; }';

/** Tvar arkádové sondy `__playShell` (`ArcadePlay.tsx`); globální typ je mřížkový. */
type ArcadeProbe = {
  readonly tick: () => number;
  readonly playWitness: () => { readonly runState: string; readonly tick: number };
  readonly handPlay: (until: 'score' | 'end') => { readonly runState: string; readonly tick: number };
};

const press = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((testId) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    button?.click();
    return button !== null;
  }, id);

/**
 * „Show me how“ od tiku 0: běžící ukázku nejdřív zastaví, po konci běhu „znovu“.
 * Tlačítko je od P34 na kartě pauzy – když není vidět, otevře ji.
 */
async function startDemo(page: Page): Promise<void> {
  if (await press(page, 'play-demo-stop')) await page.locator('[data-testid="play-demo"]').waitFor({ state: 'detached' });
  const deadline = Date.now() + 15_000;
  while (!(await press(page, 'play-demo-start'))) {
    expect(Date.now(), 'tlačítko „Show me how“').toBeLessThan(deadline);
    if (!(await press(page, 'play-demo-yours')) && !(await press(page, 'play-replay'))) await press(page, 'play-pause');
    await page.waitForTimeout(200);
  }
  // `attached`: nad plátnem je všechno skryté (`ONLY_CANVAS`).
  await page.locator('[data-testid="play-demo"]').waitFor({ state: 'attached' });
}

/** Hra běží do tiku `at`, pak ji skrytá záložka pozastaví a obraz stojí (postup `p32-split`). */
function freezeAt(page: Page, at: number): Promise<number> {
  return page.evaluate(
    (target) =>
      new Promise<number>((resolve) => {
        const showTab = (state: 'visible' | 'hidden'): void => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
          document.dispatchEvent(new Event('visibilitychange'));
        };
        showTab('visible');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
        const wait = (): void => {
          const tick = (window.__playShell as unknown as ArcadeProbe).tick();
          if (tick < target) {
            requestAnimationFrame(wait);
            return;
          }
          showTab('hidden');
          resolve(tick);
        };
        requestAnimationFrame(wait);
      }),
    at,
  );
}

/** Robot dohraje „rukou“: lidský běh, takže sběrnice vydá i konfety výhry. */
function playToEnd(page: Page): Promise<{ readonly runState: string; readonly tick: number }> {
  return page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    return (window.__playShell as unknown as ArcadeProbe).handPlay('end');
  });
}

/** Podíl fialových pixelů: odstín 250–320°, HSV S ≥ 0,25, V ≥ 0,2 (`rules/design-output.md`). */
async function purpleShare(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let purple = 0;
  for (let at = 0; at < info.width * info.height * 3; at += 3) {
    const r = data[at]! / 255;
    const g = data[at + 1]! / 255;
    const b = data[at + 2]! / 255;
    const max = Math.max(r, g, b);
    const span = max - Math.min(r, g, b);
    if (max < 0.2 || span / max < 0.25) continue;
    const hue = max === r ? (60 * ((g - b) / span) + 360) % 360 : max === g ? 60 * ((b - r) / span) + 120 : 60 * ((r - g) / span) + 240;
    if (hue >= 250 && hue <= 320) purple += 1;
  }
  return purple / (info.width * info.height);
}

interface Shot {
  readonly name: string;
  readonly frame: FrameReport;
  /** Výška hrdiny jako podíl výšky obrazu; `null` mimo záběr. */
  readonly heroShare: number | null;
  /** Hrozba (pronásledovatel, soupeř souboje) v záběru: střed jejího obdélníku uvnitř obrazu. */
  readonly chaserInView: boolean;
  readonly alerts: number;
  readonly purple: number;
  /** Sonda souboje `data-fight` (`tinted`, `flashing`, `down`, `hits`, `swing`); mimo souboj prázdná. */
  readonly fight: Readonly<Record<string, number>>;
  /** Klip, který riggovaný hrdina a soupeř opravdu hrají (`null` = model bez klipů). */
  readonly heroClip: string | null;
  readonly rivalClip: string | null;
  /** Strana okraje, kde šipka ukazuje hrozbu mimo záběr (`data-threat-edge`, P35 T2); prázdná = žádná. */
  readonly threatEdge: string;
}

async function shoot(page: Page, name: string, tick: number, threat: 'chaser' | 'enemy' = 'chaser'): Promise<Shot> {
  const frame = await page.evaluate(() => window.__playFrame!());
  const stage = page.getByTestId('arcade-stage');
  const alerts = Number((await stage.getAttribute('data-alerts')) ?? '0');
  const tier = await stage.getAttribute('data-quality');
  const fight = Object.fromEntries(((await stage.getAttribute('data-fight')) ?? '').split(' ').filter(Boolean).map((pair) => [pair.split(':')[0]!, Number(pair.split(':')[1])]));
  const heroClip = await stage.getAttribute('data-anim-clip');
  const rivalClip = await stage.getAttribute('data-rival-clip');
  const threatEdge = (await stage.getAttribute('data-threat-edge')) ?? '';
  const png = await page.locator('[data-testid="arcade-stage"] canvas').first().screenshot({ path: join(SHOTS, `${name}.png`), scale: 'css' });
  const hero = frame.hero !== null && !frame.hero.behind ? frame.hero : null;
  const chaser = frame.items[threat]?.box ?? null;
  const shot: Shot = {
    name,
    frame,
    heroShare: hero === null ? null : hero.heightPx / frame.height,
    chaserInView: chaser !== null && !chaser.behind && Math.abs(chaser.x) < 1 && Math.abs(chaser.y) < 1,
    alerts,
    purple: await purpleShare(png),
    fight,
    heroClip,
    rivalClip,
    threatEdge,
  };
  const pct = (share: number | null): string => (share === null ? '–' : `${(share * 100).toFixed(1)} %`);
  const at = chaser === null ? '–' : `(${chaser.x.toFixed(2)}, ${chaser.y.toFixed(2)})`;
  const fought = threat === 'enemy' ? `, souboj ${JSON.stringify(fight)}, klip hrdiny ${String(heroClip)}, soupeře ${String(rivalClip)}` : '';
  const line = `${name} (tik ${tick}, ${frame.width}×${frame.height}, úroveň ${String(tier)}): hrdina ${pct(shot.heroShare)} výšky, hrozba ${shot.chaserInView ? 'v záběru' : 'mimo'} ${at}, šipka ${threatEdge || '–'}, vykřičníky ${alerts}, fialová ${pct(shot.purple)}${fought}`;
  test.info().annotations.push({ type: 'shot', description: line });
  console.log(line);
  return shot;
}

/** Start: pár desetin sekundy ukázky. Probuzení: ochrana (120 tiků) dobíhá, vykřičník svítí posledních 45 tiků. */
const START_TICK = 30;
const WAKE_TICK = 105;
const BEFORE_FINISH = 30;

/** Start, probuzení, honička (půlka běhu robota) a výhra. `warmUpMs`: ukázka předem, ať si telefon vybere úroveň kvality. */
async function shootChase(page: Page, prefix: string, warmUpMs = 0): Promise<readonly Shot[]> {
  mkdirSync(SHOTS, { recursive: true });
  await page.addStyleTag({ content: ONLY_CANVAS });
  const bot = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).playWitness());
  expect(bot.runState, 'záznam robota vyhraje').toBe('won');
  if (warmUpMs > 0) {
    await startDemo(page);
    await page.waitForTimeout(warmUpMs);
  }
  await startDemo(page);
  const shots: Shot[] = [];
  for (const [name, tick] of [['start', START_TICK], ['wake', WAKE_TICK], ['chase', Math.round(bot.tick / 2)]] as const) {
    const at = await freezeAt(page, tick);
    await page.waitForTimeout(800);
    shots.push(await shoot(page, `${prefix}-${name}`, at));
  }
  await freezeAt(page, bot.tick - BEFORE_FINISH);
  const end = await playToEnd(page);
  expect(end.runState, 'robot „rukou“ vyhraje').toBe('won');
  await page.waitForTimeout(500);
  shots.push(await shoot(page, `${prefix}-win`, end.tick));
  return shots;
}

/**
 * Kolik výšky obrazu hrdina zabírá aspoň (P35 T2): v O10 měla kočka a čaroděj
 * kolem 4,7 % a astra je naslepo nepoznala. Telefon víc – obraz je menší.
 * Telefon 0,09 → 0,08 (P36A T12, naměřeno 2. 10. 2026): útěk jde od T4 ve
 * vlnách a honič vstupuje od okraje arény, takže start kočky (tik 30) kamera
 * odtáhne až k němu – hrdina 8,4 % výšky (probuzení 11,4 %, honička 13,7 %).
 * Pořád ~1,8× nad 4,7 %; kameru dělá P36C a po sloučení se přeměří.
 */
const HERO_SHARE = { desktop: 0.07, phone: 0.08 } as const;

/**
 * Pronásledovatel, který se s velkým hrdinou do záběru nevejde, ukazuje šipka
 * na okraji (`data-threat-edge`) – hráč ho vidí dřív, než ho chytí.
 */
function expectChase(shots: readonly Shot[], minShare: number): void {
  for (const shot of shots) {
    expect(shot.purple, `${shot.name}: podíl fialových pixelů`).toBeLessThan(0.001);
    if (!shot.name.endsWith('-win')) expect(shot.heroShare, `${shot.name}: hrdina v záběru`).not.toBeNull();
    if (shot.heroShare !== null) expect(shot.heroShare, `${shot.name}: podíl výšky obrazu, který hrdina zabírá`).toBeGreaterThanOrEqual(minShare);
  }
  const [start, wake] = shots;
  for (const shot of [start!, wake!]) expect(shot.chaserInView || shot.threatEdge !== '', `${shot.name}: pronásledovatel v záběru, nebo ho ukazuje šipka na okraji`).toBe(true);
  expect(wake!.alerts, `${wake!.name}: vykřičník nad probouzejícím se medvědem`).toBeGreaterThanOrEqual(1);
}

/** Hra načtená, modely stažené (bez nich by snímek ukázal náhradní tvary); zamrzlé jezero kočky = sada `snow`, podlaha led. */
async function openGame(page: Page, url: string, look: string | null = 'snow'): Promise<void> {
  await page.goto(url);
  // Hra stojí na tiku 0 pod „Tap to start“ (P33 T11); snímky pouští ukázka.
  await page.waitForFunction(() => window.__playShell !== undefined && window.__playFrame !== undefined, undefined, { timeout: 60_000 });
  if (look !== null) await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-look', look);
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Souboj rytířů (P32E T6)

/**
 * Snímek nápřahu: soupeř chystá úder tolik tiků z 30 (záklon je celý, červeň sílí).
 * Robot ukázky vyhraje za ~1,5 s a každý nápřah do 9 tiků přeruší úderem, proto
 * nápřah hraje člověk, který stojí: soupeř dojde a chystá úder celých 30 tiků.
 */
const WIND_UP_TICKS = 18;

/** Skrytá záložka hru zastaví (`p32-split`); `visible` + klávesa ji pustí dál. */
function installTab(page: Page): Promise<void> {
  return page.evaluate(() => {
    (window as unknown as { __showTab: (state: string) => void }).__showTab = (state) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
}

/** Hra člověka od tiku 0: ukázku pustit a hned zastavit – restart čeká na první dotek hráče. */
async function humanFromStart(page: Page): Promise<void> {
  await startDemo(page);
  expect(await press(page, 'play-demo-stop'), 'ukázka běží').toBe(true);
  await page.locator('[data-testid="play-demo"]').waitFor({ state: 'detached' });
}

/** Hráč hru pustí (J – souboj první stisk spolkne) a stojí; když soupeř chystá úder `ticks` tiků v kuse (svítí nad ním vykřičník), skrytá záložka hru zastaví. */
function freezeInWindUp(page: Page, ticks: number): Promise<number> {
  return page.evaluate(
    (into) =>
      new Promise<number>((resolve, reject) => {
        const show = (window as unknown as { __showTab: (state: string) => void }).__showTab;
        const stage = document.querySelector<HTMLElement>('[data-testid="arcade-stage"]')!;
        const shell = window.__playShell as unknown as { tick: () => number };
        show('visible');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'j' }));
        const deadline = performance.now() + 60_000;
        let from = -1;
        const wait = (): void => {
          const tick = shell.tick();
          if (stage.dataset.alerts === undefined || stage.dataset.alerts === '0') from = -1;
          else if (from < 0) from = tick;
          if (from >= 0 && tick - from >= into) {
            show('hidden');
            resolve(tick);
          } else if (performance.now() > deadline) reject(new Error('the rival never wound up long enough'));
          else requestAnimationFrame(wait);
        };
        requestAnimationFrame(wait);
      }),
    ticks,
  );
}

/**
 * Hra člověka klávesnicí – jen v ní sběrnice efektů pustí částice a otřes. Hrdina
 * jde šipkami k soupeři podle sondy záběru (scéna zrcadlí x jádra) a v dosahu
 * stojí. `hit`: seká J a první zásah (`__playFx().hit`) hru skrytou záložkou
 * zastaví. `stand`: jen dojde a nechá se bít – daleko od stěny, která by
 * poraženého hrdinu kameře zakryla.
 */
function humanApproach(page: Page, mode: 'hit' | 'stand'): Promise<number> {
  return page.evaluate(
    (attack) =>
      new Promise<number>((resolve, reject) => {
        const show = (window as unknown as { __showTab: (state: string) => void }).__showTab;
        const shell = window.__playShell as unknown as { tick: () => number };
        const hits = (): number => window.__playFx?.().hit ?? 0;
        const send = (type: 'keydown' | 'keyup', key: string): boolean => window.dispatchEvent(new KeyboardEvent(type, { key }));
        const held = new Set<string>();
        const hold = (key: string, on: boolean): void => {
          if (on === held.has(key)) return;
          if (on) held.add(key);
          else held.delete(key);
          send(on ? 'keydown' : 'keyup', key);
        };
        const release = (): void => {
          for (const key of [...held]) hold(key, false);
        };
        show('visible');
        const before = hits();
        // První stisk hru jen pustí (souboj první stisk spolkne).
        send('keydown', 'j');
        send('keyup', 'j');
        const deadline = performance.now() + 60_000;
        let frame = 0;
        const step = (): void => {
          frame += 1;
          if (attack && hits() > before) {
            release();
            show('hidden');
            resolve(shell.tick());
            return;
          }
          if (performance.now() > deadline) {
            release();
            reject(new Error(`no ${attack ? 'hit' : 'approach'} within 60 s of keyboard play`));
            return;
          }
          const offset = window.__playFrame!().offset;
          if (offset !== null) {
            const near = Math.hypot(offset.x, offset.z) < 1.5;
            hold('ArrowRight', !near && offset.x < -0.3);
            hold('ArrowLeft', !near && offset.x > 0.3);
            hold('ArrowUp', !near && offset.z > 0.3);
            hold('ArrowDown', !near && offset.z < -0.3);
            if (near && !attack) {
              resolve(shell.tick());
              return;
            }
            if (near && frame % 3 === 0) {
              send('keydown', 'j');
              send('keyup', 'j');
            }
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    mode === 'hit',
  );
}

/** Popisky měřidel HP pro čtečku, v pořadí těl (hrdina první). */
const meterLabels = (page: Page): Promise<string[]> =>
  page.locator('[data-testid="fight-health"] [role="meter"]').evaluateAll((meters) => meters.map((meter) => meter.getAttribute('aria-label') ?? ''));

/** Nápřah, zásah a prohra (hra člověka) a KO soupeře (robot „rukou“ k výhře). `warmUpMs`: ukázka předem, ať si telefon vybere úroveň kvality. */
async function shootFight(page: Page, prefix: string, warmUpMs = 0): Promise<readonly Shot[]> {
  mkdirSync(SHOTS, { recursive: true });
  await installTab(page);
  // HP pro čtečku, dokud je stránka vidět: „Knight health 5 of 5“ a soupeř pod jménem modelu, který scéna kreslí.
  await expect.poll(() => meterLabels(page)).toEqual(['Knight health 5 of 5', expect.stringMatching(/^Rival [a-z ]+ health 3 of 3$/)]);
  await expect(page.getByRole('meter', { name: 'Knight health 5 of 5' })).toBeAttached();
  await page.addStyleTag({ content: ONLY_CANVAS });
  const bot = await page.evaluate(() => (window.__playShell as unknown as ArcadeProbe).playWitness());
  expect(bot.runState, 'záznam robota vyhraje').toBe('won');
  if (warmUpMs > 0) {
    await startDemo(page);
    await page.waitForTimeout(warmUpMs);
  }
  const shots: Shot[] = [];
  await humanFromStart(page);
  const windUp = await freezeInWindUp(page, WIND_UP_TICKS);
  await page.waitForTimeout(800);
  shots.push(await shoot(page, `${prefix}-telegraph`, windUp, 'enemy'));

  await humanFromStart(page);
  const hit = await humanApproach(page, 'hit');
  await page.waitForTimeout(800);
  shots.push(await shoot(page, `${prefix}-hit`, hit, 'enemy'));

  // Hráč, který dojde k soupeři a stojí, prohraje: soupeř ho srazí na 0 HP a riggovaný rytíř padne klipem `die`.
  await humanFromStart(page);
  await humanApproach(page, 'stand');
  await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-anim-clip', 'die', { timeout: 60_000 });
  const lost = await page.evaluate(() => (window.__playShell as unknown as { tick: () => number }).tick());
  await page.waitForTimeout(1_800);
  shots.push(await shoot(page, `${prefix}-lose`, lost, 'enemy'));

  await startDemo(page);
  await freezeAt(page, bot.tick - BEFORE_FINISH);
  const end = await playToEnd(page);
  expect(end.runState, 'robot „rukou“ vyhraje').toBe('won');
  // Konec běhu kreslí ještě 1,5 s naplno (klip pádu), pak stojí.
  await page.waitForTimeout(1_800);
  shots.push(await shoot(page, `${prefix}-ko`, end.tick, 'enemy'));
  const labels = await meterLabels(page);
  test.info().annotations.push({ type: 'meters', description: labels.join(' | ') });
  // Souboj jde od P36A T4 ve vlnách: soupeři vlny se číslují a každá vlna má o 1 HP víc (3 → 7 v páté).
  // Mez měřidla je nejvyšší HP, které obrazovka od skoku na `bot.tick - BEFORE_FINISH` viděla. Ve `genre.v6` (P66 T10)
  // si robot před poslední vlnou vezme `fire_rate`, takže soupeř může mít první ránu za sebou už ve chvíli skoku (6 ze 7).
  expect(labels[1], 'HP soupeře po KO pro čtečku').toMatch(/^Rival [a-z ]+ \d+ health 0 of [67]$/);
  return shots;
}

function expectFight(shots: readonly Shot[], minShare: number): void {
  for (const shot of shots) {
    expect(shot.purple, `${shot.name}: podíl fialových pixelů`).toBeLessThan(0.001);
    expect(shot.heroShare, `${shot.name}: hrdina v záběru`).not.toBeNull();
    expect(shot.heroShare!, `${shot.name}: podíl výšky obrazu, který hrdina zabírá`).toBeGreaterThanOrEqual(minShare);
    expect(shot.chaserInView, `${shot.name}: soupeř v záběru`).toBe(true);
  }
  const [windUp, hit, lose, ko] = shots as [Shot, Shot, Shot, Shot];
  expect(windUp.alerts, 'nápřah: vykřičník nad soupeřem').toBeGreaterThanOrEqual(1);
  expect(windUp.fight.tinted, 'nápřah: soupeř rudne').toBeGreaterThanOrEqual(1);
  expect(hit.fight.flashing, 'zásah: zasažené tělo bliká').toBeGreaterThanOrEqual(1);
  expect(hit.fight.hits, 'zásah: scéna ho viděla').toBeGreaterThanOrEqual(1);
  expect(lose.fight.down, 'prohra: hrdina leží').toBeGreaterThanOrEqual(1);
  expect(lose.heroClip, 'prohra: riggovaný rytíř hraje klip die').toBe('die');
  expect(ko.fight.down, 'KO: soupeř leží').toBeGreaterThanOrEqual(1);
  // Riggovaný soupeř padá klipem `die`; model katalogu (dnes „robot“, viz README) padá procedurálně a klip nehlásí.
  if (ko.rivalClip !== null) expect(ko.rivalClip, 'KO: riggovaný soupeř hraje klip die').toBe('die');
}

test.describe('arena chase, desktop 1280×720', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('cat: start, wake-up, chase and win shots', async ({ page, request }) => {
    test.setTimeout(180_000);
    await openGame(page, await publishSpec(request, arenaSpec('cat')));
    expectChase(await shootChase(page, 'cat-desktop'), HERO_SHARE.desktop);
  });

  test('knights: wind-up, hit and KO shots', async ({ page, request }) => {
    test.setTimeout(240_000);
    await openGame(page, await publishSpec(request, arenaSpec('knights')), null);
    expectFight(await shootFight(page, 'knights-desktop'), HERO_SHARE.desktop);
  });
});

/** Snímků za sekundu po celých sekundách (rAF), `seconds` dlouho (z `p32-look`). */
function sampleFps(page: Page, seconds: number): Promise<number[]> {
  return page.evaluate(
    (span) =>
      new Promise<number[]>((resolve) => {
        const samples: number[] = [];
        let frames = 0;
        let from = performance.now();
        const end = from + span * 1000;
        const frame = (now: number): void => {
          frames += 1;
          if (now - from >= 1000) {
            samples.push((frames * 1000) / (now - from));
            frames = 0;
            from = now;
          }
          if (now < end) requestAnimationFrame(frame);
          else resolve(samples);
        };
        requestAnimationFrame(frame);
      }),
    seconds,
  );
}

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

// Bez `defaultBrowserType`: ten ve skupině testů Playwright nepovolí (vynutil by nový worker).
const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];

/** Medián FPS po 20 s ukázky robota (postup `p32-penguin`); ukázka se po konci pouští znovu. */
async function demoFps(page: Page, name: string): Promise<void> {
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toHaveAttribute('data-quality', /^(high|medium|low)$/, { timeout: 60_000 });
  const sampling = sampleFps(page, 20);
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if ((await page.locator('[data-testid="play-demo"]').count()) === 0) await startDemo(page);
    await page.waitForTimeout(500);
  }
  const samples = await sampling;
  const tier = await stage.getAttribute('data-quality');
  const fps = `medián ${median(samples).toFixed(1)} FPS, úroveň ${String(tier)}, vzorky ${samples.map((value) => value.toFixed(0)).join(' ')}`;
  test.info().annotations.push({ type: 'fps', description: fps });
  console.log(`${name}: ${fps}`);
  expect(samples.length).toBeGreaterThanOrEqual(15);
  expect(median(samples), `medián FPS (úroveň ${String(tier)})`).toBeGreaterThanOrEqual(30);
}

test.describe('arena chase, Pixel 7 with CPU 4× slower', () => {
  test.use(PIXEL_7);

  /** 30 FPS pod ukázkou robota, pak znovu načíst a snímky ve stejném zpomalení. */
  test('cat: holds 30 FPS, then start, wake-up, chase and win shots', async ({ page, request, context }) => {
    test.setTimeout(300_000);
    const url = await publishSpec(request, arenaSpec('cat'));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await openGame(page, url);
    await demoFps(page, 'cat-pixel7');

    await openGame(page, url);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    expectChase(await shootChase(page, 'cat-pixel7', 5_000), HERO_SHARE.phone);
  });

  test('knights: holds 30 FPS, then wind-up, hit and KO shots', async ({ page, request, context }) => {
    test.setTimeout(300_000);
    const url = await publishSpec(request, arenaSpec('knights'));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await openGame(page, url, null);
    await demoFps(page, 'knights-pixel7');

    await openGame(page, url, null);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    expectFight(await shootFight(page, 'knights-pixel7', 5_000), HERO_SHARE.phone);
  });
});
