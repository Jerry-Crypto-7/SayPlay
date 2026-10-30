import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import { P64_CELLS } from './p64-cells';

/**
 * HUD na výšku (P64 T6): na telefonu na výšku sedí HUD nahoře a nezakrývá hru. Měří se obdélníky DOM
 * (vzor `play-phone.spec.ts`), ne od oka, na každé buňce `p64-cells.ts` a na čtyřech výřezech: 360 × 780,
 * 390 × 844, 412 × 915 a výřez zařízení projektu (Pixel 7 412 × 839, iPhone 15 393 × 659 – ty měřil audit T1).
 *
 * - Horní pás HUD (spodní hrana `.play-hud-progress`, `.play-hud-corner`, `.play-hud-goal` od horní hrany plátna,
 *   jako `bandsOf` v `p64-portrait-audit.spec.ts`) ≤ 18 % výšky, na tiku 0, kdy je vidět i řádek cíle.
 * - Řádek cíle nejvýš dva řádky textu: výška obsahu bez odsazení / výška řádku. (Audit T1 dělil celou výšku
 *   rámečku, takže počítal o řádek víc.)
 * - Žádná pilulka uříznutá (`scrollWidth ≤ clientWidth`) ani za okrajem obrazovky; „Change one thing“ dole taky.
 * - Počítadla, časovač, pauza, řádek cíle a odznak power-upů a komba (`PowerupBadge`) se nepřekrývají. Odznak
 *   se objeví až se sebraným power-upem; jeho místo určuje jen CSS, takže se na chvíli vloží tentýž DOM.
 * - Štítek ukázky robota (`.play-demo-note`, `.play-upgrade-…`, `.play-live`) neleží v prostřední třetině ani
 *   přes hrdinu; řádek se slovesem a popisek jména (`VerbLine`, `NameLine`) leží celý pod horním pásem.
 * - Výsledek (výhra robota, prohra nečinného hráče) se vejde bez posunu listu i stránky a hlavní akce leží
 *   celá na obrazovce, střed ve spodní polovině.
 *
 * Desktop (`chromium`): HUD na 1280 × 720 na tiku 0 a karta prohry pixelově proti referenci z `main`
 * (`e2e/__screenshots__/p64-portrait-hud/`); plátno je skryté, ruční hodiny stojí.
 * `P64_HUD_SHOTS=<složka>` nafotí každou buňku na 360 × 780 pro oko.
 */

const SHOTS = process.env.P64_HUD_SHOTS ?? '';
const AC_SIZES = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
] as const;
const MAX_BAND = 0.18;
const MAX_GOAL_LINES = 2;
/** Tiky běhu hráče, ve kterých se čte řádek se slovesem a popisek jména (sloveso 0–3 s, jména 1,5 s po něm). */
const CUE_TICKS = [30, 90, 150, 200, 240, 290, 330];
/** Tik ukázky robota, ve kterém se měří její štítek. */
const DEMO_TICK = 60;

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface HudReading {
  readonly width: number;
  readonly height: number;
  readonly coarse: boolean;
  /** Spodní hrana horních kusů HUD od horní hrany plátna, px. */
  readonly band: number;
  readonly goalLines: number;
  readonly goalCut: boolean;
  readonly goal: string;
  readonly clipped: readonly string[];
  readonly overlaps: readonly string[];
  readonly pills: string;
}

/** Odečet HUD ve stránce. `boost` vloží na dobu měření odznak power-upu a komba (`PowerupBadge`), když ho hra nemá. */
function readHud(boost: boolean): HudReading {
  const shown = (el: Element): boolean => {
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05 && r.width > 0 && r.height > 0;
  };
  const nameOf = (el: Element): string => [...el.classList].filter((c) => c.startsWith('play-')).join('.') || el.tagName.toLowerCase();
  const stage = document.querySelector('[data-testid="arcade-stage"]');
  let probe: HTMLElement | null = null;
  if (boost && stage !== null && document.querySelector('.play-boosts') === null) {
    probe = document.createElement('div');
    probe.className = 'play-boosts';
    probe.dataset.p64Probe = 'true';
    probe.innerHTML = '<span class="play-boost"><svg class="play-boost-ring" viewBox="0 0 48 48"></svg></span><span class="sp-hud-pill sp-hud-pill--sun play-boost-combo">×3</span>';
    stage.append(probe);
  }
  try {
    const canvas = document.querySelector('[data-testid="arcade-stage"] canvas') ?? document.querySelector('canvas');
    const top = canvas?.getBoundingClientRect().top ?? 0;
    const bars = [...document.querySelectorAll('.play-hud-progress, .play-hud-corner, .play-hud-goal')].filter(shown);
    const band = Math.max(top, ...bars.map((el) => el.getBoundingClientRect().bottom)) - top;
    const goal = document.querySelector<HTMLElement>('.play-hud-goal');
    let goalLines = 0;
    let goalCut = false;
    if (goal !== null && shown(goal)) {
      const style = getComputedStyle(goal);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      goalLines = Math.round((goal.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / line);
      goalCut = goal.scrollHeight > goal.clientHeight + 1;
    }
    const pills = [...document.querySelectorAll('.play-hud .sp-hud-pill, .play-hud-count, .play-hud-progress, .play-hud-timer, .play-hud-change, .play-boost-combo')].filter(shown);
    const clipped = pills
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return el.scrollWidth > el.clientWidth || r.left < -0.5 || r.right > window.innerWidth + 0.5;
      })
      .map((el) => `${nameOf(el)} "${(el.textContent ?? '').trim().slice(0, 30)}" ${String(el.scrollWidth)}/${String(el.clientWidth)}`);
    const pieces = [...document.querySelectorAll('.play-hud-progress, .play-hud-count, .play-hud-timer, .play-hud-pause, .play-hud-goal, .play-hud-phase, .play-boost, .play-boost-combo')].filter(shown);
    const overlaps: string[] = [];
    for (const [i, a] of pieces.entries()) {
      for (const b of pieces.slice(i + 1)) {
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const area = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)) * Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
        if (area > 1) overlaps.push(`${nameOf(a)} × ${nameOf(b)} (${String(Math.round(area))} px²)`);
      }
    }
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      coarse: matchMedia('(pointer: coarse)').matches,
      band: Math.round(band),
      goalLines,
      goalCut,
      goal: (goal?.textContent ?? '').trim(),
      clipped,
      overlaps,
      pills: pills.map((el) => `${nameOf(el)} ${String(Math.round(el.getBoundingClientRect().width))}`).join(', '),
    };
  } finally {
    probe?.remove();
  }
}

interface CueReading {
  readonly band: number;
  readonly cues: readonly { readonly name: string; readonly top: number; readonly text: string }[];
}

/** Řádek se slovesem a popisek jména, který `NameAnchor` právě ukazuje, proti spodní hraně horních kusů HUD. */
function readCues(): CueReading {
  const shown = (el: Element): boolean => {
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05 && r.width > 0 && r.height > 0;
  };
  const bars = [...document.querySelectorAll('.play-hud-progress, .play-hud-corner, .play-hud-goal')].filter(shown);
  const band = Math.max(0, ...bars.map((el) => el.getBoundingClientRect().bottom));
  const cues = [...document.querySelectorAll<HTMLElement>('.play-verb-line, .play-name-line')]
    .filter((el) => shown(el) && (!el.classList.contains('play-name-line') || el.style.visibility === 'visible'))
    .map((el) => ({ name: el.classList.contains('play-name-line') ? 'name' : 'verb', top: Math.round(el.getBoundingClientRect().top), text: (el.textContent ?? '').trim() }));
  return { band: Math.round(band), cues };
}

interface NoticeReading {
  readonly height: number;
  /** Spodní hrana horních kusů HUD, px stránky. */
  readonly band: number;
  readonly hero: Rect | null;
  readonly notices: readonly { readonly name: string; readonly rect: Rect }[];
}

/** Štítky nad hrou (ukázka robota, stav AI verze, hotový remix, pole živé změny) a obdélník hrdiny ze sondy záběru. */
function readNotices(): NoticeReading {
  const shown = (el: Element): boolean => {
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05 && r.width > 0 && r.height > 0;
  };
  const bars = [...document.querySelectorAll('.play-hud-progress, .play-hud-corner, .play-hud-goal')].filter(shown);
  const band = Math.max(0, ...bars.map((el) => el.getBoundingClientRect().bottom));
  const canvas = (document.querySelector('[data-testid="arcade-stage"] canvas') ?? document.querySelector('canvas'))!.getBoundingClientRect();
  const box = window.__playFrame?.().hero ?? null;
  const hero =
    box === null || box.behind
      ? null
      : {
          left: canvas.left + ((box.minX + 1) / 2) * canvas.width,
          right: canvas.left + ((box.maxX + 1) / 2) * canvas.width,
          top: canvas.top + ((1 - box.maxY) / 2) * canvas.height,
          bottom: canvas.top + ((1 - box.minY) / 2) * canvas.height,
        };
  const notices = [...document.querySelectorAll('.play-hud > :is(.play-demo-note, .play-upgrade-status, .play-upgrade-toast, .play-upgrade, .play-live)')].filter(shown).map((el) => {
    const r = el.getBoundingClientRect();
    return { name: [...el.classList].filter((c) => c.startsWith('play-')).join('.'), rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
  });
  return { height: window.innerHeight, band, hero, notices };
}

/**
 * Štítek nad hrou na výšku: pod horním pásem HUD, mimo prostřední třetinu a mimo hrdinu. Hrdinu, kterého kamera
 * drží v horní třetině (dnes úkol pod lištou a shazovač slučování – `underHud` auditu T1, kamery T3 a T4),
 * štítek pod pásem minout nemůže: překryv se jen vypíše a hlídá ho audit.
 */
function checkNotices(seen: NoticeReading, at: string): void {
  const third = { left: -1e6, right: 1e6, top: seen.height / 3, bottom: (2 * seen.height) / 3 };
  const heroLow = seen.hero !== null && (seen.hero.top + seen.hero.bottom) / 2 >= seen.height / 3;
  for (const notice of seen.notices) {
    const overHero = seen.hero === null ? 0 : overlapOf(notice.rect, seen.hero);
    console.log(`${at} notice ${notice.name}: ${String(Math.round(notice.rect.top))}–${String(Math.round(notice.rect.bottom))}, band ${String(Math.round(seen.band))}${seen.hero === null ? '' : `, hero ${String(Math.round(seen.hero.top))}–${String(Math.round(seen.hero.bottom))}${heroLow ? '' : ' (top third)'}`}${overHero > 0 ? ` – over the hero ${String(Math.round(overHero))} px²` : ''}`);
    expect.soft(notice.rect.top, `${at}: ${notice.name} under the top HUD band`).toBeGreaterThanOrEqual(seen.band);
    expect.soft(overlapOf(notice.rect, third), `${at}: ${notice.name} in the middle third`).toBe(0);
    if (heroLow) expect.soft(overHero, `${at}: ${notice.name} over the hero`).toBe(0);
  }
}

interface ResultReading {
  readonly height: number;
  readonly outcome: string;
  readonly sheetScroll: number;
  readonly pageScroll: number;
  readonly main: (Rect & { readonly text: string }) | null;
  readonly offscreen: readonly string[];
}

/** Karta výsledku: přetečení listu a stránky, hlavní (rajčatová) akce a akce mimo obrazovku. */
function readResult(): ResultReading {
  const sheet = document.querySelector<HTMLElement>('.play-result-sheet')!;
  const page = document.scrollingElement ?? document.documentElement;
  const primary = document.querySelector<HTMLElement>('.play-result-actions [data-variant="primary"]');
  const rect = primary?.getBoundingClientRect();
  const offscreen = [...document.querySelectorAll<HTMLElement>('.play-result-actions .sp-btn')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && (r.top < 0 || r.bottom > window.innerHeight + 0.5);
    })
    .map((el) => (el.textContent ?? '').trim());
  return {
    height: window.innerHeight,
    outcome: document.querySelector('[data-testid="play-outcome"]')?.getAttribute('data-outcome') ?? '',
    sheetScroll: sheet.scrollHeight - sheet.clientHeight,
    pageScroll: page.scrollHeight - window.innerHeight,
    main: rect === undefined ? null : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, text: (primary!.textContent ?? '').trim() },
    offscreen,
  };
}

/** Sonda ruční hry (`ArcadePlay.tsx`): ruční hodiny, robot za hráče a tik po tiku. */
interface HandProbe {
  byHand(on: boolean): void;
  botWants(): { readonly buttons: number; readonly axis: number } | null;
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): { readonly runState: string; readonly tick: number };
  handPlay(until: 'score' | 'end'): { readonly runState: string };
  idleRun(): { readonly runState: string };
}

const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

async function publish(request: APIRequestContext, spec: unknown): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  await expect(page.getByTestId('play-building')).toHaveCount(0, { timeout: 60_000 });
  await page.waitForFunction(() => typeof (window.__playShell as unknown as HandProbe | undefined)?.byHand === 'function' && typeof window.__playFrame === 'function', undefined, { timeout: 60_000 });
  await page.evaluate(() => (window.__playShell as unknown as HandProbe).byHand(true));
}

/** Robot hraje za hráče tik po tiku do `to` (nebo konce běhu); vrátí, jestli běh ještě běží. */
async function playTo(page: Page, to: number): Promise<boolean> {
  return page.evaluate((to) => {
    const probe = window.__playShell as unknown as HandProbe;
    for (;;) {
      const wants = probe.botWants();
      probe.hold(wants?.axis ?? 0);
      probe.press(wants?.buttons ?? 0);
      const now = probe.tickByHand();
      if (now.runState !== 'running') return false;
      if (now.tick >= to) return true;
    }
  }, to);
}

/**
 * Karta výsledku na výšku. Na výřezech AC se vejde celá: list se neposouvá, všechny akce na obrazovce. Na nižším
 * výřezu zařízení (iPhone 393 × 659) smí list posouvat obsah, ale stránka ne a hlavní akce zůstane celá vidět.
 * Hlavní akce má střed ve spodní polovině (palec).
 */
function checkResult(result: ResultReading, at: string, strict: boolean): void {
  console.log(`${at} ${result.outcome} card: sheet +${String(result.sheetScroll)}, page +${String(result.pageScroll)}, main "${result.main?.text ?? '–'}" ${result.main === null ? '' : `${String(Math.round(result.main.top))}–${String(Math.round(result.main.bottom))}`}`);
  expect.soft(result.pageScroll, `${at} ${result.outcome}: the page scrolls`).toBeLessThanOrEqual(1);
  if (strict) {
    expect.soft(result.sheetScroll, `${at} ${result.outcome}: the result sheet scrolls`).toBeLessThanOrEqual(1);
    expect.soft(result.offscreen, `${at} ${result.outcome}: actions off the screen`).toEqual([]);
  }
  expect(result.main, `${at} ${result.outcome}: main action`).not.toBeNull();
  expect.soft(result.main!.top >= 0 && result.main!.bottom <= result.height + 0.5, `${at} ${result.outcome}: main action on the screen`).toBe(true);
  expect.soft((result.main!.top + result.main!.bottom) / 2, `${at} ${result.outcome}: main action in the bottom half`).toBeGreaterThanOrEqual(result.height / 2);
}

const overlapOf = (a: Rect, b: Rect): number => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

const PHONES: Readonly<Record<string, { readonly width: number; readonly height: number; readonly dir: string }>> = {
  'pixel7-touch': { width: 412, height: 839, dir: 'pixel7' },
  'iphone-touch': { width: 393, height: 659, dir: 'iphone15' },
};

test.describe('P64 portrait HUD', () => {
  test.setTimeout(240_000);

  for (const cell of P64_CELLS) {
    test(`${cell.key}: the HUD fits the top of a portrait phone and never covers the hero`, async ({ page, request }, testInfo) => {
      const phone = PHONES[testInfo.project.name];
      test.skip(phone === undefined, 'phone projects only');
      const sizes = [...AC_SIZES, { width: phone!.width, height: phone!.height }];
      const dir = SHOTS === '' ? null : join(SHOTS, phone!.dir);
      if (dir !== null) mkdirSync(dir, { recursive: true });
      const name = cell.key.replace(':', '-');
      const shot = async (what: string): Promise<void> => {
        if (dir !== null) await page.screenshot({ path: join(dir, `${name}-${what}.png`) });
      };
      const resize = async (size: { width: number; height: number }): Promise<void> => {
        await page.setViewportSize(size);
        await frames(page);
      };
      const at = (size: { width: number; height: number }): string => `${cell.key} ${String(size.width)}×${String(size.height)}`;

      await page.setViewportSize(sizes[0]!);
      await open(page, await publish(request, cell.spec));

      // Tik 0: hra čeká na první dotek, řádek cíle je vidět – horní pás je nejvyšší.
      for (const size of sizes) {
        await resize(size);
        const hud = await page.evaluate(readHud, true);
        console.log(`${at(size)} hud: band ${String(hud.band)} px (${(hud.band / hud.height * 100).toFixed(1)} %), goal ${String(hud.goalLines)} lines${hud.goalCut ? ' cut' : ''} "${hud.goal}", pills ${hud.pills}`);
        expect(hud.coarse, `${at(size)}: coarse pointer`).toBe(true);
        expect.soft(hud.clipped, `${at(size)}: clipped pills`).toEqual([]);
        expect.soft(hud.overlaps, `${at(size)}: HUD overlaps`).toEqual([]);
        expect.soft(hud.goalLines, `${at(size)}: goal lines "${hud.goal}"`).toBeLessThanOrEqual(MAX_GOAL_LINES);
        expect.soft(hud.band / hud.height, `${at(size)}: top HUD band ${String(hud.band)} px`).toBeLessThanOrEqual(MAX_BAND);
        if (size === sizes[0]) await shot('hud');
      }

      // Ukázka robota: štítek nad hrou ani přes hrdinu, ani v prostřední třetině.
      await page.getByTestId('play-pause').click();
      await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
      const demoRuns = await playTo(page, DEMO_TICK);
      // Štítek naskočí (`sp-pop-in`); ruční hodiny stojí, takže čekání hru neposune.
      await page.waitForTimeout(600);
      if (demoRuns) {
        for (const size of sizes) {
          await resize(size);
          const seen = await page.evaluate(readNotices);
          expect(seen.notices.map((notice) => notice.name), `${at(size)}: the demo notice is shown`).toContain('play-demo-note');
          checkNotices(seen, at(size));
          if (size === sizes[0]) await shot('demo');
        }
        await page.getByTestId('play-demo-stop').click();
      }

      // Běh hráče (robot za něj): řádek se slovesem a popisky jmen pod horním pásem.
      await page.evaluate(() => (window.__playShell as unknown as HandProbe).byHand(true));
      let cues = 0;
      for (const tick of CUE_TICKS) {
        if (!(await playTo(page, tick))) break;
        for (const size of sizes) {
          await resize(size);
          const read = await page.evaluate(readCues);
          for (const cue of read.cues) {
            cues += 1;
            console.log(`${at(size)} tick ${String(tick)} ${cue.name} "${cue.text}" top ${String(cue.top)}, band ${String(read.band)}`);
            expect.soft(cue.top, `${at(size)} tick ${String(tick)}: ${cue.name} line "${cue.text}" under the top HUD band`).toBeGreaterThanOrEqual(read.band);
          }
          if (size === sizes[0] && read.cues.some((cue) => cue.name === 'name')) await shot(`cue-${String(tick)}`);
        }
      }
      console.log(`${cell.key}: ${String(cues)} cue readings`);

      // Výsledek: výhra robota a prohra nečinného hráče.
      for (const [outcome, run] of [
        ['won', () => (window.__playShell as unknown as HandProbe).handPlay('end')],
        ['lost', () => (window.__playShell as unknown as HandProbe).idleRun()],
      ] as const) {
        await resize(sizes[0]!);
        const end = await page.evaluate(run);
        if (end.runState !== outcome) {
          console.log(`${cell.key}: ${outcome} run ended ${end.runState}`);
          continue;
        }
        await expect(page.getByTestId('play-outcome')).toHaveAttribute('data-outcome', outcome, { timeout: 30_000 });
        await page.waitForTimeout(1200);
        for (const size of sizes) {
          await resize(size);
          checkResult(await page.evaluate(readResult), at(size), AC_SIZES.some((ac) => ac.width === size.width && ac.height === size.height));
          if (size === sizes[0]) await shot(outcome);
        }
      }
    });
  }
});

/**
 * Stav AI verze na výšku (jako `play-phone.spec.ts`, server odpovídá podvrhem) na hře běžce, jehož hrdina stojí
 * dole: běžící práce i hotová verze leží pod horním pásem HUD, mimo prostřední třetinu a mimo hrdinu. Výzva
 * „Tap to start“ na tiku 0 se stavem nepřekrývá (`PromptSpot` počítá stav mezi dolními lištami). S výsledkem
 * jde stav nahoru do místa, které mu nechá zamrzlá scéna, a karta se i tak vejde.
 */
test('portrait phones: the AI-version notice sits under the top HUD, off the hero, and the result still fits', async ({ page, request }, testInfo) => {
  test.skip(PHONES[testInfo.project.name] === undefined, 'phone projects only');
  const created = await request.post('/api/play/games', { data: { sentence: 'jumping arcade game with a lot of obstacles' } });
  expect(created.status(), await created.text()).toBeLessThan(300);
  const draft = (await created.json()) as { url: string; upgrade: string };
  const other = await request.post('/api/play/games', { data: { sentence: 'Survive in an arena full of slimes.' } });
  const target = ((await other.json()) as { versionId: string }).versionId;
  let ready = false;
  await page.route(`**${draft.upgrade}`, (route) =>
    route.fulfill({ json: ready ? { status: 'ready', versionId: target } : { status: 'pending', deadlineAt: new Date(Date.now() + 285_000).toISOString() } }),
  );
  await page.setViewportSize(AC_SIZES[0]);
  await open(page, draft.url);
  const notice = page.getByTestId('upgrade-state');
  const name = `${PHONES[testInfo.project.name]!.dir}-upgrade`;
  for (const state of ['working', 'ready'] as const) {
    if (state === 'ready') ready = true;
    await expect(notice).toHaveAttribute('data-kind', state, { timeout: 15_000 });
    await page.waitForTimeout(600);
    for (const size of AC_SIZES) {
      await page.setViewportSize(size);
      await frames(page);
      await frames(page);
      const at = `${String(size.width)}×${String(size.height)} ${state}`;
      const seen = await page.evaluate(readNotices);
      expect(seen.notices.map((entry) => entry.name).join(' '), at).toContain('play-upgrade-status');
      checkNotices(seen, at);
      const prompt = await page.getByTestId('play-first-prompt').boundingBox();
      if (prompt !== null) {
        const card = { left: prompt.x, right: prompt.x + prompt.width, top: prompt.y, bottom: prompt.y + prompt.height };
        console.log(`${at} first prompt ${String(Math.round(card.top))}–${String(Math.round(card.bottom))}`);
        for (const entry of seen.notices) expect.soft(overlapOf(card, entry.rect), `${at}: the first prompt under ${entry.name}`).toBe(0);
        expect.soft(card.top, `${at}: the first prompt under the top HUD band`).toBeGreaterThanOrEqual(seen.band);
      }
      if (SHOTS !== '' && size === AC_SIZES[0]) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, `${name}-${state}.png`) });
      }
    }
  }
  await page.evaluate(() => window.__playShell!.playWitness());
  await expect(page.getByTestId('play-outcome')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  for (const size of AC_SIZES) {
    await page.setViewportSize(size);
    await frames(page);
    const at = `${String(size.width)}×${String(size.height)} with the AI-version notice`;
    checkResult(await page.evaluate(readResult), at, true);
    const clash = await page.evaluate(() => {
      const status = document.querySelector('[data-testid="upgrade-state"]')!.getBoundingClientRect();
      return [...document.querySelectorAll('.play-result-badge, .play-result-sheet')].filter((el) => {
        const r = el.getBoundingClientRect();
        return Math.min(r.right, status.right) > Math.max(r.left, status.left) && Math.min(r.bottom, status.bottom) > Math.max(r.top, status.top);
      }).map((el) => el.className);
    });
    expect.soft(clash, `${at}: the notice over the result`).toEqual([]);
    if (SHOTS !== '' && size === AC_SIZES[0]) await page.screenshot({ path: join(SHOTS, `${name}-result.png`) });
  }
});

/**
 * Desktop beze změny: HUD na 1280 × 720 na tiku 0 a karta prohry pixel po pixelu proti referenci z `main`.
 * Plátno je skryté (scéna se hýbe sama), ruční hodiny stojí, animace dojedou (`toHaveScreenshot`).
 */
test('desktop 1280×720: the HUD and the result card match main pixel for pixel', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'desktop reference only');
  const cell = P64_CELLS.find((entry) => entry.key === 'shooter')!;
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, await publish(request, cell.spec));
  await page.addStyleTag({ content: '[data-testid="arcade-stage"] { visibility: hidden !important; }' });
  await frames(page);
  await expect(page.locator('.play-shell')).toHaveScreenshot(['p64-portrait-hud', 'desktop-hud.png'], { maxDiffPixels: 0 });
  await page.evaluate(() => (window.__playShell as unknown as HandProbe).idleRun());
  await expect(page.getByTestId('play-outcome')).toHaveAttribute('data-outcome', 'lost', { timeout: 30_000 });
  await page.waitForTimeout(1200);
  await expect(page.locator('.play-shell')).toHaveScreenshot(['p64-portrait-hud', 'desktop-result.png'], { maxDiffPixels: 0 });
});
