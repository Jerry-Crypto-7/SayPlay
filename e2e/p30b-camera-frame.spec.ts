import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Hrdina a položky z věty v záběru (P30B T5). Deset vět korpusu se zmrazeným
 * AI specem (`evals/play/p30b/live.json`), jedna na každé arkádové ovládání,
 * které popisky kreslí (aréna je nečte – `losses.md`). Na prvním hratelném
 * snímku – po úvodním průletu kamery, u ovládání s ťukem na start hned po
 * startu – `window.__playFrame()` promítne hrdinu a každou položku věty
 * skutečnou kamerou scény. Položka = role, jejíž popisek scéna kreslí na těle
 * (`userData.item` v `ArcadeStage.tsx`); v záběru je, když aspoň jedno její
 * tělo leží středem uvnitř |x|, |y| ≤ 0,95 NDC a ne za kamerou.
 *
 * Výsledek jde do `evals/play/p30b/camera-frame.json` (`off-camera` u každé
 * položky mimo záběr, `absent`, když scéna tělo té role nekreslí vůbec).
 * Brána: hrdina 10/10 a položky ≥ 90 % na telefonu i na počítači.
 */

const SENTENCES = ['h10', 's006', 's022', 's035', 's058', 's039', 'h03', 's099', 's144', 'h05'] as const;

/** Stejná množina jako `TAP_TO_START` v ArcadePlay.tsx; mezerník je u všech pěti start a ukončí průlet. */
const TAP_TO_START = new Set(['flap', 'shooter', 'timing', 'rhythm', 'duel']);
/** Úvodní průlet kamery (`look/intro.ts` `INTRO_S` = 1,5 s) a rezerva na dotažení modelů. */
const INTRO_MS = 1700;
const AFTER_TAP_MS = 500;

/** Role, jejichž popisek scéna kreslí na těle – `PROP_ROLES` v `src/play/arcade/models.ts` plus nepřítel a pronásledovatel. */
const PROP_ROLES = new Set(['coin', 'obstacle', 'target', 'rival', 'barrier', 'note', 'block']);

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const EDGE = 0.95;
const HERO_GATE = 1;
const ITEM_GATE = 0.9;
const OUT = join(process.cwd(), 'evals/play/p30b/camera-frame.json');

interface Box {
  readonly x: number;
  readonly y: number;
  readonly heightPx: number;
  readonly behind: boolean;
}
interface Report {
  readonly control: string;
  readonly hero: Box | null;
  readonly items: Readonly<Record<string, { readonly count: number; readonly box: Box | null }>>;
}
interface Role {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
}
interface Sentence {
  readonly id: string;
  readonly spec: { readonly roles: readonly Role[] } & Record<string, unknown>;
}

type Why = 'ok' | 'off-camera' | 'absent';
interface ItemResult {
  readonly role: string;
  readonly label: string;
  readonly bodies: number;
  readonly why: Why;
  readonly x: number | null;
  readonly y: number | null;
}
interface SentenceResult {
  readonly id: string;
  readonly viewport: string;
  readonly control: string;
  readonly hero: { readonly label: string; readonly why: Why; readonly x: number | null; readonly y: number | null; readonly heightShare: number | null };
  readonly items: readonly ItemResult[];
}

const LIVE = JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p30b/live.json'), 'utf8')) as { sentences: Sentence[] };

/** Tag těla, které kreslí popisek role (`itemTagOf` v ArcadeStage.tsx); role mimo tuhle množinu scéna podle popisku nekreslí. */
const tagOf = (role: Role): string | null => (role.id === 'enemy' ? 'enemy' : role.kind === 'chaser' ? 'chaser' : PROP_ROLES.has(role.id) ? role.id : null);

const round = (value: number): number => Math.round(value * 100) / 100;
const inFrame = (box: Box): boolean => !box.behind && Math.abs(box.x) <= EDGE && Math.abs(box.y) <= EDGE;
const whyOf = (box: Box | null): Why => (box === null ? 'absent' : inFrame(box) ? 'ok' : 'off-camera');

const probe = (page: Page): Promise<Report> => page.evaluate(() => window.__playFrame!() as unknown as Report);

const results: SentenceResult[] = [];

test.describe.configure({ mode: 'serial' });

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const id of SENTENCES) {
      test(`${id}: hero and sentence items in frame`, async ({ page, request }) => {
        const sentence = LIVE.sentences.find((entry) => entry.id === id);
        expect(sentence, `${id} missing from live.json`).toBeDefined();
        const response = await request.post('/api/play/games', { data: { spec: sentence!.spec } });
        expect(response.status(), await response.text()).toBeLessThan(300);
        await page.goto(((await response.json()) as { url: string }).url);
        const stage = page.getByTestId('arcade-stage');
        await expect(stage).toBeVisible();
        await page.waitForFunction(() => typeof window.__playFrame === 'function');
        const control = (await stage.getAttribute('data-control')) ?? '';
        if (TAP_TO_START.has(control)) await page.keyboard.press('Space');
        await page.waitForFunction(() => window.__playFrame!().hero !== null, undefined, { timeout: 10_000 }).catch(() => undefined);
        await page.waitForTimeout(TAP_TO_START.has(control) ? AFTER_TAP_MS : INTRO_MS);
        const report = await probe(page);
        await stage.screenshot({ path: test.info().outputPath(`${id}-${control}-${viewport.name}.png`) });

        const roles = sentence!.spec.roles;
        const heroRole = roles.find((role) => role.kind === 'player');
        const items = roles.flatMap((role): ItemResult[] => {
          const tag = tagOf(role);
          if (tag === null || role.kind === 'player') return [];
          const seen = report.items[tag];
          const box = seen?.box ?? null;
          return [{ role: role.id, label: role.label, bodies: seen?.count ?? 0, why: whyOf(box), x: box === null ? null : round(box.x), y: box === null ? null : round(box.y) }];
        });
        const hero = report.hero;
        results.push({
          id,
          viewport: viewport.name,
          control,
          hero: {
            label: heroRole?.label ?? '',
            why: whyOf(hero),
            x: hero === null ? null : round(hero.x),
            y: hero === null ? null : round(hero.y),
            heightShare: hero === null ? null : round(hero.heightPx / viewport.height),
          },
          items,
        });
        await test.info().attach('frame.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
        expect.soft(whyOf(hero), `${id} ${viewport.name}: hero ${JSON.stringify(hero)}`).toBe('ok');
      });
    }
  });
}

test.afterAll(() => {
  if (results.length === 0) return;
  const summary = Object.fromEntries(
    VIEWPORTS.map(({ name }) => {
      const rows = results.filter((row) => row.viewport === name);
      const items = rows.flatMap((row) => row.items);
      return [name, { hero: `${rows.filter((row) => row.hero.why === 'ok').length}/${rows.length}`, items: `${items.filter((item) => item.why === 'ok').length}/${items.length}` }];
    }),
  );
  const offCamera = results.flatMap((row) => [
    ...(row.hero.why === 'ok' ? [] : [`${row.viewport} ${row.id} hero ${row.hero.label}: ${row.hero.why}`]),
    ...row.items.filter((item) => item.why !== 'ok').map((item) => `${row.viewport} ${row.id} ${item.role} ${item.label}: ${item.why}`),
  ]);
  const sorted = [...results].sort((a, b) => a.viewport.localeCompare(b.viewport) || SENTENCES.indexOf(a.id as (typeof SENTENCES)[number]) - SENTENCES.indexOf(b.id as (typeof SENTENCES)[number]));
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        about: 'P30B T5: hero and sentence items projected by the real scene camera on the first playable frame (e2e/p30b-camera-frame.spec.ts). Frozen AI specs from live.json; in frame = centre within 0.95 NDC and not behind the camera.',
        gate: { hero: HERO_GATE, items: ITEM_GATE },
        summary,
        offCamera,
        sentences: sorted,
      },
      null,
      1,
    )}\n`,
  );
  // Brána až nad celou sadou: položky se počítají dohromady, hrdina u každé věty zvlášť výše.
  if (results.length === SENTENCES.length * VIEWPORTS.length) {
    for (const { name } of VIEWPORTS) {
      const items = results.filter((row) => row.viewport === name).flatMap((row) => row.items);
      const share = items.filter((item) => item.why === 'ok').length / Math.max(1, items.length);
      expect(share, `${name}: sentence items in frame ${summary[name]!.items} – ${offCamera.join('; ')}`).toBeGreaterThanOrEqual(ITEM_GATE);
    }
  }
});
