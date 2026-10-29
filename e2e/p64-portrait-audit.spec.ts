import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, type Browser, devices, expect, type Page, test } from '@playwright/test';

import { P64_CELLS } from './p64-cells';

/**
 * Audit hry na výšku (P64 T1): každý žánr (a tři ovládání bez žánru, `p64-cells.ts`) na telefonu projektu
 * (`pixel7-touch` 412 × 839, `iphone-touch` 393 × 659) na výšku a pro srovnání na šířku. Hra a průběh jako
 * `p61-portrait`: robot („Show me how“) hraje 180 tiků ručními hodinami, každý šestý tik se čte `__playFrame()`
 * a obdélníky HUD a ovládání z DOM.
 *
 * - `playRect` = plátno bez horního pásu HUD (spodní hrana `.play-hud-progress`, `.play-hud-corner`, `.play-hud-goal`
 *   – tytéž lišty jako `hudBars` v `ArcadeStage.tsx`) a dolního pásu (horní hrana dolní řady, štítků zón a tlačítek).
 * - `fill` = medián svislého rozsahu `spread` (hrdina a všechny živé cíle a nebezpečí před kamerou), oříznutého na
 *   `playRect`, jako podíl jeho výšky.
 * - `cropped` = podíl snímků, kde má některé tělo střed mimo plátno do stran (`spread.outX > 0`).
 * - `underHud` = podíl snímků, kde obdélník hrdiny nebo nejbližšího cíle protíná horní lištu HUD nebo dolní ovládání.
 * - `heroShare`, `foeSeen` jako `p61-portrait` (plocha hrdiny oříznutá plátnem / plocha plátna; cíl na plátně).
 * - `hud` a `controls` – nejhorší snímek: uříznuté pilulky, řádky cíle, výška horního pásu, překryvy; obdélníky
 *   ovládání, jejich střed v dolní zóně palce (spodních 45 % výšky), kroužek v klidu, překryv s lištou feedu a nápovědou.
 *
 * `P64_AUDIT=write` zapíše `evals/play/p64/audit.json` (oddíl podle `P64_PHASE`, výchozí `before`), `P64_SHOTS=<složka>`
 * nafotí 1 s a 3 s hry. `P64_CHECK=1` porovná na výšku s cíli žánrů (`TARGETS`, doplní T3–T5).
 */

const OUT = 'evals/play/p64/audit.json';
const WRITE = process.env.P64_AUDIT === 'write';
const PHASE = process.env.P64_PHASE ?? 'before';
const CHECK = process.env.P64_CHECK === '1';
const SHOTS = process.env.P64_SHOTS ?? '';
const TICKS = 180;
const EVERY = 6;
/** Tik snímku „1 s“ (60 Hz). */
const SHOT_TICK = 60;
/** Dolní zóna palce: střed ovládání ve spodních 45 % výšky. */
const THUMB_FROM = 0.55;

const PHONES: Readonly<Record<string, { readonly device: string; readonly dir: string }>> = {
  'pixel7-touch': { device: 'Pixel 7', dir: 'pixel7' },
  'iphone-touch': { device: 'iPhone 15', dir: 'iphone15' },
};

/**
 * Cíle žánru na výšku (P64 T3–T5, tabulka „Rodiny a cíle“ v README T1); žánr bez záznamu se jen měří. `cropped`
 * chybí u posuvných světů, kde další úsek trati leží mimo záběr i na šířku. Ke každému cíli platí z plánu i
 * `heroShare` ≥ 0,9 × T1 a `foeSeen` ≥ T1 − 0,05 proti oddílu `before` v `audit.json` téhož telefonu.
 */
interface Target {
  readonly fill?: number;
  readonly cropped?: number;
  readonly underHud?: number;
}
const TARGETS: Readonly<Record<string, Target>> = {
  // T3 – deskové. `fill` 0,55 nejde u čtyř žánrů změřit tak, jak je definovaný (README T3, „Cíle, které neplatily“):
  // bouchání a krájení – v mediánovém snímku je vidět jen hrdina (robot cíl trefí do ~10–15 tiků, další přijde za
  // 80–175), takže `fill` je výška hrdiny; slučování – sonda vidí jen dávkovač (předměty v nádobě jsou instance bez
  // `frame`); vytlačování – celý ring musí do šíře (P61 T6) a postavy v něm nikdy nezaberou víc než jeho průmět.
  catch: { fill: 0.55, cropped: 0, underHud: 0.05 },
  whack: { fill: 0.3, cropped: 0, underHud: 0.05 },
  defense: { fill: 0.6, cropped: 0, underHud: 0.05 },
  slice: { fill: 0.17, cropped: 0, underHud: 0.05 },
  merge: { fill: 0.2, cropped: 0, underHud: 0.05 },
  push: { fill: 0.15, cropped: 0, underHud: 0.05 },
  // T4 – deskové a jevištní. `fill` přeskákání, davu a načasování je strop ze šíře, která se na výšku musí vejít
  // (pole, brány, kyv jezdce), ne 0,55 – rozsah sondy tam tvoří hrdina a nejvýš jedno blízké tělo (README → T4).
  hop: { fill: 0.09, cropped: 0, underHud: 0.05 },
  crowd: { fill: 0.19, cropped: 0, underHud: 0.05 },
  duel: { fill: 0.55, cropped: 0, underHud: 0.05 },
  quest: { fill: 0.9, underHud: 0.1 },
  timing: { fill: 0.18, cropped: 0, underHud: 0.05 },
  rhythm: { fill: 0.6, cropped: 0, underHud: 0.05 },
  // T5 – honičky a tratě. Plavba: sonda vidí jen loď (brány závodu jsou `checkpoint`), `fill` je tak výška lodi a tu
  // čitelnost drží na 21–26 % plátna – 0,25 hlídá, že se loď nezmenší. Střílečka: nejbližší vrána na iPhonu ~7 px pod
  // lištou cíle v 7 z 30 snímků (`main` 15 z 30); pod lištu by ji dostalo jen couvnutí o ~2 m, hrdina pak 0,048 < 0,9 × T1.
  runner: { fill: 0.6, cropped: 0, underHud: 0.05 },
  platformer: { fill: 0.6, underHud: 0.05 },
  flap: { fill: 0.55, underHud: 0.05 },
  voyage: { fill: 0.25, cropped: 0, underHud: 0.05 },
  shooter: { fill: 0.9, underHud: 0.25 },
  throw: { fill: 0.6, cropped: 0, underHud: 0.05 },
  // Aréna: `fill` 0,8 platil pro `playRect` z T1 (477 px na Pixelu); po T7 má 593 px a záběr 0,78 je 465 px proti 406.
  arena: { fill: 0.75, cropped: 0, underHud: 0.1 },
  'control:steer': { fill: 0.5, cropped: 0, underHud: 0.05 },
  'control:walker': { fill: 0.55, underHud: 0.05 },
  'control:ball': { fill: 0.45, cropped: 0, underHud: 0.05 },
};
/** `heroShare` na výšku ≥ tento násobek T1. */
const HERO_KEEP = 0.9;
/** `foeSeen` na výšku smí klesnout proti T1 nejvýš o tolik. */
const FOE_SLACK = 0.05;

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
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
interface Spread {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly bodies: number;
  readonly outX: number;
  readonly outY: number;
}
interface Control {
  readonly name: string;
  readonly rect: Rect;
  readonly shown: boolean;
}
interface Sample {
  readonly tick: number;
  readonly hero: Box | null;
  readonly target: Box | null;
  readonly targets: number;
  readonly spread: Spread | null;
  readonly canvas: Rect;
  readonly top: readonly Control[];
  readonly bottom: readonly Control[];
  readonly clipped: readonly string[];
  readonly goalLines: number;
  readonly rail: Rect | null;
  readonly hint: Rect | null;
  readonly stick: Control | null;
}

interface Orientation {
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  readonly playRect: { readonly top: number; readonly bottom: number; readonly height: number };
  readonly heroShare: number | null;
  readonly foeSeen: number | null;
  readonly fill: number | null;
  readonly cropped: number | null;
  readonly underHud: number;
  readonly hud: { readonly clipped: readonly string[]; readonly goalLines: number; readonly topPx: number; readonly overlaps: readonly string[] };
  readonly controls: {
    readonly items: readonly { readonly name: string; readonly rect: Rect; readonly inThumb: boolean }[];
    readonly stickAtRest: boolean | null;
    readonly overRail: readonly string[];
    readonly overHint: readonly string[];
  };
}
interface CellResult {
  readonly cell: string;
  readonly portrait: Orientation;
  readonly landscape: Orientation;
}
type Results = Record<string, Record<string, Record<string, CellResult>>>;

/** Robot hraje (`p58a-framing`): ruční hodiny, tik po tiku se snímkem. */
interface HandProbe {
  byHand(on: boolean): void;
  tickByHand(): { readonly runState: string };
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;
const span = (low: number, high: number): number => Math.max(0, Math.min(1, high) - Math.max(-1, low)) / 2;
const areaOf = (box: Box): number => span(box.minX, box.maxX) * span(box.minY, box.maxY);
const onCanvas = (box: Box | null): boolean => box !== null && !box.behind && Math.abs(box.x) <= 1 && Math.abs(box.y) <= 1;
const overlap = (a: Rect, b: Rect): number => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Obdélník těla v px stránky z NDC sondy. */
const rectOf = (box: Box, canvas: Rect): Rect => {
  const w = canvas.right - canvas.left;
  const h = canvas.bottom - canvas.top;
  return { left: canvas.left + ((box.minX + 1) / 2) * w, right: canvas.left + ((box.maxX + 1) / 2) * w, top: canvas.top + ((1 - box.maxY) / 2) * h, bottom: canvas.top + ((1 - box.minY) / 2) * h };
};

/** Pásy HUD v px stránky: spodní hrana horních lišt a horní hrana dolních prvků (jen viditelné). */
function bandsOf(sample: Sample): { top: number; bottom: number } {
  const top = Math.max(sample.canvas.top, ...sample.top.filter((c) => c.shown).map((c) => c.rect.bottom));
  const bottom = Math.min(sample.canvas.bottom, ...sample.bottom.filter((c) => c.shown).map((c) => c.rect.top));
  return { top, bottom: Math.max(top, bottom) };
}

/** Jeden snímek: sonda záběru a obdélníky DOM. Běží ve stránce. */
function sampleInPage(tick: number): Sample {
  const report = window.__playFrame!();
  const canvasEl = document.querySelector<HTMLElement>('[data-testid="arcade-stage"] canvas') ?? document.querySelector<HTMLElement>('canvas')!;
  const rectOfEl = (el: Element): { left: number; top: number; right: number; bottom: number } => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  const shownEl = (el: HTMLElement): boolean => {
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05 && r.width > 0 && r.height > 0;
  };
  const controls = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].map((el) => ({ name: `${el.className}`.split(' ').filter((c) => c.startsWith('play-')).join('.') || el.tagName.toLowerCase(), rect: rectOfEl(el), shown: shownEl(el) }));
  const box = (b: typeof report.hero) => (b === null ? null : { x: b.x, y: b.y, minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY, behind: b.behind });
  const goal = document.querySelector<HTMLElement>('.play-hud-goal');
  const lineHeight = goal === null ? 0 : parseFloat(getComputedStyle(goal).lineHeight) || parseFloat(getComputedStyle(goal).fontSize) * 1.2;
  const pills = [...document.querySelectorAll<HTMLElement>('.play-hud .sp-hud-pill, .play-hud-count, .play-hud-progress, .play-hud-timer')];
  const rail = document.querySelector('.play-pager-rail');
  const hint = document.querySelector('[data-testid="ball-dribble-hint"]');
  const stick = document.querySelector<HTMLElement>('.play-stick');
  return {
    tick,
    hero: box(report.hero),
    target: box(report.target),
    targets: report.targets,
    spread: report.spread,
    canvas: rectOfEl(canvasEl),
    top: controls('.play-hud-progress, .play-hud-corner, .play-hud-goal'),
    bottom: controls('.play-hud-bottom, .play-hud > :is(.play-upgrade-status, .play-upgrade-toast), .play-touch-zone, .play-fire, .play-action, .play-ability'),
    clipped: pills.filter((el) => shownEl(el) && el.scrollWidth > el.clientWidth + 1).map((el) => (el.textContent ?? '').trim().slice(0, 40)),
    goalLines: goal === null || !shownEl(goal) || lineHeight === 0 ? 0 : Math.round(goal.getBoundingClientRect().height / lineHeight),
    rail: rail === null ? null : rectOfEl(rail),
    hint: hint === null ? null : rectOfEl(hint),
    stick: stick === null ? null : { name: 'play-stick', rect: rectOfEl(stick), shown: shownEl(stick) },
  };
}

function summarize(samples: readonly Sample[], width: number, height: number): Orientation {
  const last = samples.at(-1)!;
  const band = bandsOf(last);
  const playHeight = band.bottom - band.top;
  const withFoe = samples.filter((s) => s.targets > 0);
  const fills = samples.flatMap((s) => {
    if (s.spread === null) return [];
    const b = bandsOf(s);
    const h = s.canvas.bottom - s.canvas.top;
    const topPx = s.canvas.top + ((1 - s.spread.maxY) / 2) * h;
    const bottomPx = s.canvas.top + ((1 - s.spread.minY) / 2) * h;
    const inside = Math.max(0, Math.min(bottomPx, b.bottom) - Math.max(topPx, b.top));
    return b.bottom > b.top ? [inside / (b.bottom - b.top)] : [];
  });
  const covered = samples.filter((s) => {
    const bars = [...s.top, ...s.bottom].filter((c) => c.shown).map((c) => c.rect);
    const bodies = [s.hero, s.target].filter((b): b is Box => b !== null && !b.behind).map((b) => rectOf(b, s.canvas));
    return bodies.some((body) => bars.some((bar) => overlap(body, bar) > 0));
  });
  const atShot = samples.find((s) => s.tick >= SHOT_TICK) ?? last;
  const shownTop = (s: Sample) => s.top.filter((c) => c.shown);
  const overlaps = new Set<string>();
  for (const s of samples) {
    const pieces = shownTop(s);
    for (const [i, a] of pieces.entries()) for (const b of pieces.slice(i + 1)) if (overlap(a.rect, b.rect) > 1) overlaps.add(`${a.name} × ${b.name}`);
  }
  const items = atShot.bottom.filter((c) => c.shown && !c.name.includes('play-hud-bottom')).map((c) => ({ name: c.name, rect: c.rect, inThumb: (c.rect.top + c.rect.bottom) / 2 >= THUMB_FROM * height }));
  return {
    width,
    height,
    samples: samples.length,
    playRect: { top: Math.round(band.top), bottom: Math.round(band.bottom), height: Math.round(playHeight) },
    heroShare: median(samples.flatMap((s) => (s.hero === null || s.hero.behind ? [] : [areaOf(s.hero)]))),
    foeSeen: withFoe.length === 0 ? null : round(withFoe.filter((s) => onCanvas(s.target)).length / withFoe.length),
    fill: median(fills),
    cropped: samples.some((s) => s.spread !== null) ? round(samples.filter((s) => (s.spread?.outX ?? 0) > 0).length / samples.length) : null,
    underHud: round(covered.length / samples.length),
    hud: {
      clipped: [...new Set(samples.flatMap((s) => s.clipped))],
      goalLines: Math.max(0, ...samples.map((s) => s.goalLines)),
      topPx: Math.round(Math.max(0, ...samples.map((s) => bandsOf(s).top - s.canvas.top))),
      overlaps: [...overlaps],
    },
    controls: {
      items: items.map((c) => ({ ...c, rect: { left: Math.round(c.rect.left), top: Math.round(c.rect.top), right: Math.round(c.rect.right), bottom: Math.round(c.rect.bottom) } })),
      stickAtRest: atShot.stick === null ? null : atShot.stick.shown,
      overRail: atShot.rail === null ? [] : items.filter((c) => overlap(c.rect, atShot.rail!) > 0).map((c) => c.name),
      overHint: atShot.hint === null ? [] : items.filter((c) => overlap(c.rect, atShot.hint!) > 0).map((c) => c.name),
    },
  };
}

async function playTo(page: Page, from: number, to: number): Promise<{ samples: Sample[]; ended: boolean }> {
  return page.evaluate(
    async ({ from, to, every, sample }) => {
      // eslint-disable-next-line no-new-func -- funkce snímku jde do stránky jako text, ať je jedna pro obě strany
      const take = new Function(`return (${sample})`)() as (tick: number) => Sample;
      const frame = () => new Promise((done) => requestAnimationFrame(() => done(undefined)));
      const out: Sample[] = [];
      for (let tick = from; tick <= to; tick += 1) {
        const state = (window.__playShell as unknown as HandProbe).tickByHand();
        await frame();
        if (tick % every === 0) out.push(take(tick));
        if (state.runState !== 'running') return { samples: out, ended: true };
      }
      return { samples: out, ended: false };
    },
    { from, to, every: EVERY, sample: sampleInPage.toString() },
  );
}

async function measure(browser: Browser, device: string, baseURL: string, url: string, shot: string | null): Promise<Orientation> {
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
    const first = await playTo(page, 1, SHOT_TICK);
    if (shot !== null) await page.screenshot({ path: `${shot}-1s.png` });
    const rest = first.ended ? { samples: [] } : await playTo(page, SHOT_TICK + 1, TICKS);
    if (shot !== null) await page.screenshot({ path: `${shot}-3s.png` });
    const viewport = page.viewportSize()!;
    return summarize([...first.samples, ...rest.samples], viewport.width, viewport.height);
  } finally {
    await context.close();
  }
}

const readResults = (): Results => (existsSync(OUT) ? ((JSON.parse(readFileSync(OUT, 'utf8')) as { results?: Results }).results ?? {}) : {});

/** Výsledek buňky do `audit.json` po každém testu, ať pád jednoho nesmaže ostatní; buňky v pořadí `P64_CELLS`. */
function record(phone: string, key: string, result: CellResult): void {
  const results = readResults();
  const byPhone = ((results[PHASE] ??= {})[phone] ??= {});
  byPhone[key] = result;
  results[PHASE]![phone] = Object.fromEntries(P64_CELLS.filter((c) => byPhone[c.key] !== undefined).map((c) => [c.key, byPhone[c.key]!]));
  const about = {
    plan: 'P64 T1',
    measure: 'e2e/p64-portrait-audit.spec.ts',
    run: 'robot demo by hand clock, 180 ticks, a sample every 6th tick',
    playRect: 'canvas minus the top HUD bars (.play-hud-progress, .play-hud-corner, .play-hud-goal) and the bottom row, zone labels and buttons',
    fill: 'median vertical extent of the spread (hero + live targets and hazards in front of the camera) clipped to playRect, share of its height',
    cropped: 'share of frames with any body centre off the canvas sideways',
    underHud: 'share of frames where the hero or nearest target box intersects a top HUD bar or a bottom control',
    heroShare: 'median canvas area share of the hero box (p61-portrait)',
    foeSeen: 'share of frames with the nearest target centre on the canvas (p61-portrait)',
    thumbZone: `control centre in the bottom ${String(Math.round((1 - THUMB_FROM) * 100))} % of the height`,
  };
  writeFileSync(OUT, `${JSON.stringify({ about, results }, null, 1)}\n`);
}

async function publish(request: APIRequestContext, spec: unknown): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

test.describe('P64 portrait audit', () => {
  test.setTimeout(300_000);

  for (const cell of P64_CELLS) {
    test(`${cell.key}: portrait framing, HUD and thumb controls`, async ({ browser, request }, testInfo) => {
      const phone = PHONES[testInfo.project.name];
      test.skip(phone === undefined, 'phone projects only');
      const url = await publish(request, cell.spec);
      const baseURL = testInfo.project.use.baseURL!;
      const dir = SHOTS === '' ? null : join(SHOTS, phone!.dir);
      if (dir !== null) mkdirSync(dir, { recursive: true });
      const name = cell.key.replace(':', '-');
      const portrait = await measure(browser, phone!.device, baseURL, url, dir === null ? null : join(dir, `${name}-portrait`));
      const landscape = await measure(browser, `${phone!.device} landscape`, baseURL, url, dir === null ? null : join(dir, `${name}-landscape`));
      console.log(`${phone!.device} ${cell.key}: fill ${String(portrait.fill)} / ${String(landscape.fill)}, cropped ${String(portrait.cropped)}, underHud ${String(portrait.underHud)}, hero ${String(portrait.heroShare)}, foe ${String(portrait.foeSeen)}`);
      if (WRITE) record(testInfo.project.name, cell.key, { cell: cell.id, portrait, landscape });

      expect(portrait.samples).toBeGreaterThan(0);
      const target = TARGETS[cell.key];
      if (!CHECK || target === undefined) return;
      if (target.fill !== undefined) expect(portrait.fill ?? 0, 'portrait fill').toBeGreaterThanOrEqual(target.fill);
      if (target.cropped !== undefined) expect(portrait.cropped ?? 0, 'portrait cropped').toBeLessThanOrEqual(target.cropped);
      if (target.underHud !== undefined) expect(portrait.underHud, 'portrait under HUD').toBeLessThanOrEqual(target.underHud);
      const before = readResults().before?.[testInfo.project.name]?.[cell.key]?.portrait;
      expect(before, `T1 audit of ${cell.key} in ${OUT}`).toBeDefined();
      if (before!.heroShare !== null) expect(portrait.heroShare ?? 0, 'portrait heroShare vs T1').toBeGreaterThanOrEqual(HERO_KEEP * before!.heroShare);
      if (before!.foeSeen !== null) expect(portrait.foeSeen ?? 0, 'portrait foeSeen vs T1').toBeGreaterThanOrEqual(before!.foeSeen - FOE_SLACK);
    });
  }
});
