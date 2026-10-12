import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';

import type { RenderReport } from '../src/components/play/arcade/ArcadeStage';
import { arenaGenre } from '../src/play/genre/arena';
import { compileGenre, readGenreSpec } from '../src/play/genre/index';
import { platformerGenre } from '../src/play/genre/platformer';
import { questGenre } from '../src/play/genre/quest';
import { voyageGenre } from '../src/play/genre/voyage';
import type { GameSpecV1 } from '../src/play/spec';

/**
 * Výkon na telefonu (P35 T4). Přejímka O10 změřila na Pixel 7 se 4× CPU kočičí
 * arénu na 15,5 FPS (ostatní hry 49–60).
 *
 * Příčina: „glowing fish“ kreslí model akvária – 19 sítí, sklo a voda průhledné.
 * `mergeBody` (`look/load.ts`) slévá tělo do jedné sítě, jen když jsou všechny
 * materiály obyčejné; průhledné akvárium nechal celé, takže 14 ryb stálo 266 sítí,
 * ~180 kreslicích volání a ~70 přepnutí programu na snímek (tučňák 58 a 23).
 *
 * Test hlídá počet viditelných sítí scény (`__playRender().meshes`), ne FPS – ty na
 * sdíleném stroji kolísají – a ne `calls`, které mění úroveň kvality (stínový výřez,
 * průchody postprocessingu).
 */

const SENTENCES = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p32/sentences.json'), 'utf8')) as { sentences: { id: string; text: string; hero: string }[] }).sentences;

/** Rychlá verze bez modelu, jako `p32-arena`. */
function arenaSpec(id: 'cat' | 'knights'): GameSpecV1 {
  const sentence = SENTENCES.find((entry) => entry.id === id)!;
  const read = readGenreSpec({ hero: sentence.hero, ...arenaGenre.draftFill(sentence.text, null) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

/** Prostředí úkolu jako `p32-quest`, když ho rychlá verze ve větě nenajde. */
const QUEST_SETTING = { firefighter: 'forest', chef: 'kitchen' } as const;

/** Úkol jako `p32-quest`. */
function questSpec(id: keyof typeof QUEST_SETTING): GameSpecV1 {
  const sentence = SENTENCES.find((entry) => entry.id === id)!;
  const fill = questGenre.draftFill(sentence.text, null);
  const read = readGenreSpec({ hero: sentence.hero, ...fill, setting: fill.setting ?? QUEST_SETTING[id] });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

/** Plavba jako `p32-voyage`. */
function voyageSpec(id: 'dog' | 'rocket'): GameSpecV1 {
  const read = readGenreSpec(voyageGenre.draftFill(SENTENCES.find((entry) => entry.id === id)!.text, null));
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

/** Skákačka z vlastní věty – králík přejímky je zapečetěný; prostředí, které věta nemá, doplní zahrada. */
function platformSpec(sentence: string): GameSpecV1 {
  const fill = platformerGenre.draftFill(sentence, null);
  const read = readGenreSpec({ ...fill, setting: fill.setting ?? 'garden' });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

async function publishSpec(request: APIRequestContext, spec: unknown): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/**
 * Sonda kreslení, až se dotáhnou modely: počet sítí se 1,5 s nezměnil. Hra stojí
 * na tiku 0 pod „Tap to start“, všechny věci leží, pronásledovatel ještě nevyrazil.
 */
async function settledRender(page: Page): Promise<RenderReport> {
  await page.waitForFunction(() => window.__playRender !== undefined && window.__playRender().calls > 0, undefined, { timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  let last = -1;
  let since = Date.now();
  const deadline = Date.now() + 20_000;
  for (;;) {
    const report = await page.evaluate(() => window.__playRender!());
    if (report.meshes !== last) {
      last = report.meshes;
      since = Date.now();
    } else if (Date.now() - since >= 1500 || Date.now() > deadline) return report;
    await page.waitForTimeout(250);
  }
}

/**
 * Strop sítí kočičí arény: po opravě ~155 (akvárium slité po materiálech 6 sítí × 14),
 * před ní ~350. Tučňák, který na telefonu drží 54+ FPS, jich kreslí ~75.
 */
const CAT_MESHES = 200;

const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];
const { defaultBrowserType: _desktopBrowser, ...DESKTOP } = devices['Desktop Chrome'];

test.describe('phone performance, Pixel 7 with CPU 4× slower', () => {
  test.use(PIXEL_7);

  test('cat arena draws each glowing fish as a few merged meshes', async ({ page, request, context }) => {
    test.setTimeout(180_000);
    const url = await publishSpec(request, arenaSpec('cat'));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(url);
    const report = await settledRender(page);
    const tier = await page.getByTestId('arcade-stage').getAttribute('data-quality');
    const line = `cat: ${report.meshes} sítí, ${report.calls} volání, ${report.triangles} trojúhelníků, úroveň ${String(tier)}`;
    test.info().annotations.push({ type: 'render', description: line });
    console.log(line);
    // Modely se opravdu kreslí: náhradní kvádry by strop splnily zadarmo.
    expect(report.triangles, 'modely kočky, medvěda a ryb jsou ve scéně').toBeGreaterThan(5000);
    expect(report.meshes, 'viditelné sítě kočičí arény').toBeLessThanOrEqual(CAT_MESHES);
  });

  /**
   * Hračkový pohyb (P45D T6, T14): hýbající se tělo s díly v `catalog-motion.json` je
   * nejvýš dva díly navíc vedle slitého zbytku, dřív jedna slitá síť. Klokan má díly
   * ocas a nohu (pes taky, ale slovo „dog“ dostane riggovaného psa s klipy, bez dílů).
   * Běžec nepřátele nemá, 20 jich drží aréna; „dnešní počet“ jsou sítě mimo díly.
   */
  test('arena with 20 model enemies adds at most two meshes per moving body with parts', async ({ page, request, context }) => {
    test.setTimeout(180_000);
    const shooter = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__/shooter.json'), 'utf8')) as { roles: { kind: string }[] };
    const pack = { ...shooter, roles: shooter.roles.map((role) => (role.kind === 'hazard' ? { ...role, label: 'kangaroo', count: 20 } : role)) };
    const url = await publishSpec(request, pack);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(url);
    const report = await settledRender(page);
    const { meshes, ink, bodies } = report.toyParts;
    const line = `pack: ${report.meshes} sítí, z toho ${meshes} v dílech ${bodies} těl (${ink} obalů obrysu)`;
    test.info().annotations.push({ type: 'render', description: line });
    console.log(line);
    // Střelnice z 20 nepřátel ukáže najednou první vlny – 15.
    expect(bodies, 'klokani s díly se kreslí').toBeGreaterThanOrEqual(15);
    expect(meshes - ink, 'sítě dílů nad dnešní počet: nejvýš dvě na hýbající se tělo s díly').toBeLessThanOrEqual(2 * bodies);
    // Nepřítel má obrys (`InkOutline`), takže ho dostane i každý díl: nejvýš jeden obal na díl.
    expect(ink, 'obaly obrysu dílů').toBeLessThanOrEqual(meshes - ink);
    expect(report.meshes, 'celá scéna v rozpočtu telefonu jako kočičí aréna').toBeLessThanOrEqual(CAT_MESHES);
  });
});

// ---------------------------------------------------------------------------
// Výzva na startu mimo hrdinu (P35 T6)

/**
 * V přejímce kola 1 výzva „Tap to start“ uprostřed obrazu přesně zakryla hrdinu
 * kočičí arény a úkolu hasiče (astra: „hidden behind the start panel“). Hry
 * pokrývají každé místo, kde hrdina na startu stojí: střed (aréna, úkol), dole
 * (souboj, procházka), vlevo (skákačka) a nahoře (raketa).
 *
 * Přejímka kola 2 (T11): u kuchaře karta seděla přesně přes hrdinu na telefonu. Hra před
 * prvním dotekem kreslí jen na požádání a poslední snímek po dotažení modelu se
 * měřil s maticemi předchozího snímku – karta zůstala u staré polohy hrdiny.
 */
const START_GAMES = [
  { id: 'cat', spec: () => arenaSpec('cat') },
  { id: 'firefighter', spec: () => questSpec('firefighter') },
  { id: 'chef', spec: () => questSpec('chef') },
  { id: 'knights', spec: () => arenaSpec('knights') },
  { id: 'dog', spec: () => voyageSpec('dog') },
  { id: 'bunny', spec: () => platformSpec('A bunny hops over hedges to grab apples') },
  { id: 'rocket', spec: () => voyageSpec('rocket') },
] as const;

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Obdélník karty a promítnutý kvádr hrdiny (sonda `__playFrame`) v pixelech stránky,
 * až hrdina 1,5 s stojí – modely dotažené, kamera usazená. Hra čeká na tiku 0.
 */
async function cardAndHero(page: Page): Promise<{ readonly card: Rect; readonly hero: Rect; readonly stage: Rect; readonly bars: readonly Rect[] }> {
  await page.waitForFunction(() => window.__playFrame?.().hero != null, undefined, { timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  let last = '';
  let since = Date.now();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const hero = await page.evaluate(() => window.__playFrame!().hero);
    const key = hero === null ? '' : [hero.minX, hero.maxX, hero.minY, hero.maxY].map((v) => v.toFixed(3)).join(' ');
    if (key !== last) {
      last = key;
      since = Date.now();
    } else if (Date.now() - since >= 1500) break;
    await page.waitForTimeout(250);
  }
  // Karta se k hrdinovi stěhuje po snímcích; ať je po posledním pohybu kamery na místě.
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const rect = (r: DOMRect) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    const stage = document.querySelector('[data-testid="arcade-stage"] canvas')!.getBoundingClientRect();
    const box = window.__playFrame!().hero!;
    return {
      card: rect(document.querySelector('[data-testid="play-first-prompt"]')!.getBoundingClientRect()),
      hero: {
        left: stage.left + ((box.minX + 1) / 2) * stage.width,
        right: stage.left + ((box.maxX + 1) / 2) * stage.width,
        top: stage.top + ((1 - box.maxY) / 2) * stage.height,
        bottom: stage.top + ((1 - box.minY) / 2) * stage.height,
      },
      stage: rect(stage),
      // Lišty HUD: nahoře postup, hodiny s pauzou a cíl, dole akce.
      bars: [...document.querySelectorAll('.play-hud-progress, .play-hud-corner, .play-hud-goal, .play-hud-bottom')]
        .map((bar) => bar.getBoundingClientRect())
        .filter((r) => r.height > 0)
        .map(rect),
    };
  });
}

const overlaps = (a: Rect, b: Rect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const { defaultBrowserType: _landscapeBrowser, ...PIXEL_7_LANDSCAPE } = devices['Pixel 7 landscape'];

for (const [device, use, games] of [
  ['phone', PIXEL_7, START_GAMES],
  ['desktop', DESKTOP, START_GAMES],
  // Naležato se karta mezi kuchaře a lišty HUD nevejde – zmenší se (T11).
  ['landscape', PIXEL_7_LANDSCAPE, START_GAMES.filter((game) => game.id === 'chef')],
] as const) {
  test.describe(`start card off the hero, ${device}`, () => {
    test.use(use);

    for (const game of games) {
      test(`${game.id}: "Tap to start" does not cover the hero`, async ({ page, request }, info) => {
        test.setTimeout(120_000);
        await page.goto(await publishSpec(request, game.spec()));
        await expect(page.getByTestId('play-first-prompt')).toBeVisible({ timeout: 60_000 });
        const { card, hero, stage, bars } = await cardAndHero(page);
        await page.screenshot({ path: info.outputPath(`${game.id}-${device}.png`) });
        const px = (r: Rect): string => `${Math.round(r.left)}–${Math.round(r.right)} × ${Math.round(r.top)}–${Math.round(r.bottom)}`;
        const line = `${game.id} ${device}: karta ${px(card)}, hrdina ${px(hero)}, plátno ${px(stage)}`;
        test.info().annotations.push({ type: 'start-card', description: line });
        console.log(line);
        expect(overlaps(card, hero), 'karta „Tap to start“ a obdélník hrdiny').toBe(false);
        expect(card.top >= stage.top && card.bottom <= stage.bottom, 'karta celá v obrazu scény').toBe(true);
        expect(bars.filter((bar) => overlaps(card, bar)).map(px), 'lišty HUD pod kartou').toEqual([]);
        if (device === 'landscape') {
          const full = await page.getByTestId('play-first-prompt').evaluate((el) => (el as HTMLElement).offsetHeight);
          expect(card.bottom - card.top, 'karta zmenšená pod plnou výšku').toBeLessThan(full);
        }
      });
    }
  });
}
