import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, type Browser, devices, expect, test } from '@playwright/test';

import { GENRES, type GenreId } from '../src/play/genre/contract';
import { compileGenre, GENRE_MODULES, readGenreSpec } from '../src/play/genre/index';

/**
 * Rámování na výšku (P61 T6): kolik obrazu zabírá hrdina a jestli je vidět nejbližší cíl – týž telefon na výšku
 * a na šířku, všech 19 žánrů. Telefon dává projekt (`pixel7-touch` = Pixel 7, `iphone-touch` = iPhone 15), na šířku
 * jeho `landscape` z Playwrightu. Hra a průběh jako `p58a-framing`: robot („Show me how“) hraje 180 tiků ručními
 * hodinami, každý šestý tik se čte `__playFrame()`.
 *
 * Podíl hrdiny = plocha jeho promítnutého obdélníku (oříznutého plátnem) / plocha plátna, medián přes snímky.
 * Plocha, ne výška: telefon je na výšku i na šířku tatáž obrazovka, plocha se dá porovnat přímo. Výška by na výšku
 * chtěla 2,3× větší postavu (a uřízlý svět do stran), šířka by snesla i čtvrtinovou.
 * Cíl v obraze = podíl snímků, kde střed nejbližšího cíle leží na plátně (scéna bez kandidáta se nepočítá).
 *
 * `P61_PORTRAIT=before|after` zapíše čísla do `evals/play/p61/portrait.json`. Kontrola: opravené žánry (`FIXED`)
 * mají na výšku aspoň 0,9 podílu na šířku; ostatní se proti `before` nezmenšily (`KEEP`) a cíl v obraze neztratil
 * víc než `FOE_SLACK`.
 */

const OUT = 'evals/play/p61/portrait.json';
const PHASE = process.env.P61_PORTRAIT ?? '';
/** Složka pro snímek konce měření (oko na opravené žánry), prázdná = bez snímků. */
const SHOTS = process.env.P61_SHOTS ?? '';
const TICKS = 180;
const EVERY = 6;
/** Opravené žánry (T6): dva s nejmenším podílem hrdiny na výšku na obou telefonech (`before`). */
const FIXED: readonly GenreId[] = ['timing', 'push'];
const PORTRAIT_FLOOR = 0.9;
/**
 * Ostatní žánry: podíl hrdiny na výšku nejmíň tolik násobků `before`. Šum mezi běhy (26. 10.): 17 žánrů do 3 %,
 * plavba na Pixelu 7 0,094–0,119 a chytání na iPhonu 0,070–0,088 – `before` leží u spodní meze.
 */
const KEEP = 0.8;
const FOE_SLACK = 0.1;

const PHONES: Readonly<Record<string, string>> = { 'pixel7-touch': 'Pixel 7', 'iphone-touch': 'iPhone 15' };

interface Cell {
  readonly id: string;
  readonly spec: unknown;
}
/** Hry `p58a-framing` podle žánru; žánry, které tam nejsou, se složí z věty bez modelu (`draftFill`, jako `play-touch`). */
const FRAMING = JSON.parse(readFileSync('evals/play/p58a/framing-cells.json', 'utf8')) as Record<string, Cell>;
const SENTENCES: Readonly<Partial<Record<GenreId, string>>> = {
  voyage: 'a pirate ship races between islands to the treasure',
  slice: 'a sushi chef slashes the fish flung into the air with his knife but leaves the spiky sea mines alone',
  crowd: 'one tiny lemming dashes down a cave tunnel, go through the right doors to turn him into 10, 50, 200 lemmings, avoid the saws, then swarm the huge troll at the end',
  merge: 'a cat knocks yarn balls into a basket, two matching ones squish together into a bigger ball, keep the heap from reaching the top',
};

function specOf(genre: GenreId): Cell {
  const cell = FRAMING[genre];
  if (cell !== undefined) return cell;
  const sentence = SENTENCES[genre]!;
  const read = readGenreSpec({ hero: 'fox', ...(GENRE_MODULES[genre].draftFill(sentence, null) as object) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return { id: 'draft', spec: compileGenre(read.value) };
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly behind: boolean;
}
interface Sample {
  readonly hero: Box | null;
  readonly target: Box | null;
  readonly targets: number;
}
interface Orientation {
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  /** Medián podílu plochy plátna, který zabírá hrdina; `null` = hrdina v žádném snímku. */
  readonly heroShare: number | null;
  /** Totéž pro nejbližší cíl. */
  readonly foeShare: number | null;
  /** Podíl snímků se středem nejbližšího cíle na plátně; `null` = scéna nemá kandidáta na cíl. */
  readonly foeSeen: number | null;
}
interface GenreResult {
  readonly cell: string;
  readonly portrait: Orientation;
  readonly landscape: Orientation;
  /** Podíl hrdiny na výšku / na šířku. */
  readonly ratio: number | null;
}
type Results = Record<string, Record<string, Record<string, GenreResult>>>;

/** Robot hraje (`p58a-framing`): ruční hodiny, tik po tiku se snímkem, každý `EVERY`. tik sonda záběru. */
interface HandProbe {
  byHand(on: boolean): void;
  tickByHand(): { readonly runState: string };
}

const span = (low: number, high: number): number => Math.max(0, Math.min(1, high) - Math.max(-1, low)) / 2;
const areaOf = (box: Box): number => span(box.minX, box.maxX) * span(box.minY, box.maxY);
const onCanvas = (box: Box | null): boolean => box !== null && !box.behind && Math.abs(box.x) <= 1 && Math.abs(box.y) <= 1;
const round = (value: number): number => Math.round(value * 10_000) / 10_000;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

async function measure(browser: Browser, device: string, baseURL: string, url: string, shot: string): Promise<Orientation> {
  const { defaultBrowserType: _browser, ...use } = devices[device]!;
  const context = await browser.newContext({ ...use, baseURL });
  try {
    const page = await context.newPage();
    await page.goto(url);
    await page.locator('canvas').first().waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => typeof (window.__playShell as unknown as HandProbe | undefined)?.byHand === 'function' && typeof window.__playFrame === 'function', undefined, { timeout: 60_000 });
    await page.evaluate(() => (window.__playShell as unknown as HandProbe).byHand(true));
    await page.getByTestId('play-pause').click();
    await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
    const { samples, width, height } = await page.evaluate(
      async ({ ticks, every }) => {
        const frame = () => new Promise((done) => requestAnimationFrame(() => done(undefined)));
        const out: Sample[] = [];
        let size = { width: 0, height: 0 };
        for (let tick = 1; tick <= ticks; tick += 1) {
          const state = (window.__playShell as unknown as HandProbe).tickByHand();
          await frame();
          if (tick % every === 0) {
            const report = window.__playFrame!();
            const at = (box: typeof report.hero): Box | null => (box === null ? null : { x: box.x, y: box.y, minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY, behind: box.behind });
            out.push({ hero: at(report.hero), target: at(report.target), targets: report.targets });
            size = { width: report.width, height: report.height };
          }
          if (state.runState !== 'running') break;
        }
        return { samples: out, ...size };
      },
      { ticks: TICKS, every: EVERY },
    );
    if (SHOTS !== '') {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `${shot}.png`) });
    }
    const withFoe = samples.filter((sample) => sample.targets > 0);
    return {
      width,
      height,
      samples: samples.length,
      heroShare: median(samples.flatMap((sample) => (sample.hero === null || sample.hero.behind ? [] : [areaOf(sample.hero)]))),
      foeShare: median(withFoe.flatMap((sample) => (sample.target === null || sample.target.behind ? [] : [areaOf(sample.target)]))),
      foeSeen: withFoe.length === 0 ? null : round(withFoe.filter((sample) => onCanvas(sample.target)).length / withFoe.length),
    };
  } finally {
    await context.close();
  }
}

const readResults = (): Results => (existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as { results?: Results }).results ?? {} : {});

/** Výsledek žánru do `portrait.json` – po každém testu, ať pád jednoho nesmaže ostatní; žánry v pořadí `GENRES`. */
function record(phone: string, genre: GenreId, result: GenreResult): void {
  const results = readResults();
  const byPhone = ((results[PHASE] ??= {})[phone] ??= {});
  byPhone[genre] = result;
  results[PHASE]![phone] = Object.fromEntries(GENRES.filter((id) => byPhone[id] !== undefined).map((id) => [id, byPhone[id]!]));
  const about = {
    plan: 'P61 T6',
    measure: 'e2e/p61-portrait.spec.ts',
    heroShare: 'median share of the canvas area covered by the hero box (clipped), robot play, 180 ticks, every 6th',
    foeSeen: 'share of frames with the nearest target centre on the canvas; null = no target in the scene',
    fixed: FIXED,
  };
  writeFileSync(OUT, `${JSON.stringify({ about, results }, null, 1)}\n`);
}

test.describe('portrait framing on the phone', () => {
  test.setTimeout(300_000);

  for (const genre of GENRES) {
    test(`${genre}: the hero keeps its share of the screen in portrait`, async ({ browser, request }, testInfo) => {
      const phone = PHONES[testInfo.project.name];
      test.skip(phone === undefined, 'phone projects only');
      // Kostra P66 (T2) hru nepostaví; řádek dostane úloha žánru (T5–T9) se svou buňkou.
      test.skip(GENRE_MODULES[genre].availability('default' as never) === 'staged', 'staged genre');
      const cell = specOf(genre);
      const url = await publish(request, cell.spec);
      const baseURL = testInfo.project.use.baseURL!;
      const portrait = await measure(browser, phone!, baseURL, url, `${testInfo.project.name}-${genre}-portrait`);
      const landscape = await measure(browser, `${phone!} landscape`, baseURL, url, `${testInfo.project.name}-${genre}-landscape`);
      const ratio = portrait.heroShare === null || landscape.heroShare === null || landscape.heroShare === 0 ? null : round(portrait.heroShare / landscape.heroShare);
      const result = { cell: cell.id, portrait, landscape, ratio };
      console.log(`${phone!} ${genre}: hero ${String(portrait.heroShare)} portrait / ${String(landscape.heroShare)} landscape (×${String(ratio)}), foe seen ${String(portrait.foeSeen)} / ${String(landscape.foeSeen)}`);
      if (PHASE !== '') record(phone!, genre, result);

      expect(portrait.samples).toBeGreaterThan(0);
      if (FIXED.includes(genre)) expect(ratio, 'portrait hero share against landscape').toBeGreaterThanOrEqual(PORTRAIT_FLOOR);
      const before = readResults().before?.[phone!]?.[genre];
      if (before === undefined) return;
      if (before.portrait.heroShare !== null) expect(portrait.heroShare ?? 0, 'portrait hero share against before').toBeGreaterThanOrEqual(KEEP * before.portrait.heroShare);
      if (before.portrait.foeSeen !== null) expect(portrait.foeSeen ?? 0, 'portrait foe in frame against before').toBeGreaterThanOrEqual(before.portrait.foeSeen - FOE_SLACK);
    });
  }
});

async function publish(request: APIRequestContext, spec: unknown): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}
