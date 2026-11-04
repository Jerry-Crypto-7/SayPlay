import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { BASE_ENTRIES } from '../src/play/assets/entries/base';
import { CATALOG_ENTRIES } from '../src/play/assets/entries/catalog';
import { RIGGED_P32_ENTRIES } from '../src/play/assets/entries/rigged-p32';
import { startGame } from './play-start';

/**
 * Spouštěcí věta P39 (T15) v prohlížeči: „jumping and shooting game in the forest
 * against animals“. Před P39 v ní hráč střílel do robotů. Test ji připíchne napořád:
 *
 * - karta „Tap to start“ (od P39 T10 vypisuje `tutorial.controlsHint`) jmenuje skok i střelbu,
 * - tělesa, do kterých hráč střílí (`itemTagOf` = `enemy` v `World.tsx`), kreslí model
 *   zvířete z manifestu, ne `robot` – v rychlé verzi i v AI verzi po přepnutí na „Full detail“.
 *
 * AI verze je podvržená stejně jako v `play-upgrade.spec.ts`: `GET …/upgrade` řekne
 * `ready` a míří na publikovanou hru `AI_SPEC` – odpověď živého režiséra na tuhle větu
 * z druhého slepého kola P39 (5. 10. 2026, `scripts/play-p39-blind.mjs`). Server proto
 * nepotřebuje model ani žádnou proměnnou: `next start` z `npm run build`.
 *
 * Model těla scéna nikam do DOM nepíše. Test ho čte ze stromu Reactu: háček
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__` (ten, přes který se připojují React DevTools)
 * dostane od React DOM i od rendereru `@react-three/fiber` každý potvrzený strom.
 * Skupina těla nese `userData.item` z `itemTagOf`, její model je `id` pro `FittedModel`
 * (výsledek `modelIdOf`) nebo `character` pro `RiggedModel`.
 *
 * Snímek AI verze jde do `evals/play/p39/trigger.png` – zvířata v něm musí být vidět.
 */

const SENTENCE = 'jumping and shooting game in the forest against animals';
const SHOT = join(process.cwd(), 'evals', 'play', 'p39', 'trigger.png');

/** AI verze věty: spec, který živý režisér vrátil ve slepém kole P39 r2 (`trigger-after.json`). */
const AI_SPEC = {
  addons: ['shoot'],
  archetype: 'hazard_crossing',
  budgets: { maxEntities: 40, maxRules: 120, maxTriangles: 200000 },
  control: 'platform',
  controlParams: { checkpoints: true, tuning: { feel: 2, sections: 3 } },
  genre: { compilerVersion: 'genre.v1', id: 'platformer', mode: 'default' },
  mechanics: [{ id: 'health', params: { max: 3 } }],
  objective: { description: 'Jump across the platforms to the flag without touching a spike.', kind: 'reach', role: 'finish' },
  roles: [
    { count: 1, id: 'player', kind: 'player', label: 'fox' },
    { count: 5, id: 'spikes', kind: 'hazard', label: 'spikes' },
    { count: 1, id: 'coin', kind: 'collectible', label: 'acorn' },
    { count: 1, id: 'finish', kind: 'exit', label: 'flag' },
    { count: 1, id: 'enemy', kind: 'hazard', label: 'animal' },
  ],
  schema: 'gamespec.v1',
  scoring: {},
  targetDurationSec: 60,
  theme: { look: 'forest', mood: 'playful', setting: 'forest' },
  title: 'Fox Jump',
  tutorial: { controlsHint: 'Arrows or A/D to move, Space or tap to jump. F or Fire to shoot.', goalLine: 'Reach the flag. Jump over gaps and hazards.' },
  verification: [{ assert: { runState: 'won' }, id: 'winnable', kind: 'reachability' }],
};

/** Třída modelu podle id manifestu; pořadí jako `MANIFEST` v `models.ts`, první záznam vyhrává. */
const CLASS_OF = new Map<string, string>();
for (const entry of [...BASE_ENTRIES, ...RIGGED_P32_ENTRIES, ...CATALOG_ENTRIES]) if (!CLASS_OF.has(entry.id)) CLASS_OF.set(entry.id, entry.class);
const classOf = (model: string): string | undefined => CLASS_OF.get(model.replace(/^rigged:/, ''));

interface Created {
  readonly url: string;
  readonly versionId: string;
  readonly upgrade: string;
}

async function draftFromSentence(request: APIRequestContext): Promise<Created> {
  const created = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
  expect(created.status(), await created.text()).toBeLessThan(300);
  return (await created.json()) as Created;
}

async function publishAiVersion(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec: AI_SPEC } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { versionId: string }).versionId;
}

/** Náhrada háčku React DevTools: sbírá potvrzené kořeny stromů do `window.__castRoots`. */
function collectFiberRoots(): void {
  const roots = new Set<unknown>();
  const renderers = new Map<number, unknown>();
  Object.assign(window, {
    __castRoots: roots,
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true,
      isDisabled: false,
      renderers,
      inject: (renderer: unknown): number => {
        renderers.set(renderers.size + 1, renderer);
        return renderers.size;
      },
      onCommitFiberRoot: (_renderer: number, root: unknown): void => {
        roots.add(root);
      },
      onCommitFiberUnmount: (): void => undefined,
      onPostCommitFiberRoot: (): void => undefined,
      checkDCE: (): void => undefined,
    },
  });
}

interface ShotBodies {
  /** Model každého těla, do kterého hráč střílí (`rigged:` + id u postavy s klipy). */
  readonly models: readonly string[];
  /** Kolik z nich už má načtený model místo náhradního kvádru. */
  readonly loaded: number;
}

/** Tělesa s `userData.item === 'enemy'` v potvrzeném stromu scény a model, který kreslí. */
async function shotBodies(page: Page): Promise<ShotBodies> {
  return page.evaluate(() => {
    interface Fiber {
      readonly child: Fiber | null;
      readonly sibling: Fiber | null;
      readonly type: unknown;
      readonly memoizedProps: Record<string, unknown> | null;
      readonly stateNode: unknown;
    }
    interface Node3D {
      readonly isMesh?: boolean;
      readonly userData: Record<string, unknown>;
      readonly geometry?: { readonly type: string };
      traverse(visit: (node: Node3D) => void): void;
    }
    const roots = (window as unknown as { __castRoots?: Set<{ current: Fiber }> }).__castRoots ?? new Set();
    const below = function* (fiber: Fiber | null): Generator<Fiber> {
      for (let at = fiber; at !== null; at = at.sibling) {
        yield at;
        yield* below(at.child);
      }
    };
    const modelOf = (group: Fiber): string | undefined => {
      for (const fiber of below(group.child)) {
        const props = fiber.memoizedProps ?? {};
        const character = props.character as { id?: unknown; path?: unknown } | undefined;
        if (typeof character?.id === 'string' && typeof character.path === 'string') return `rigged:${character.id}`;
        if (typeof fiber.type === 'function' && typeof props.id === 'string') return props.id;
      }
      return undefined;
    };
    // R3F 9 drží v `stateNode` obal instance (`object` = objekt three), starší verze objekt přímo.
    const objectOf = (fiber: Fiber): Node3D => {
      const node = fiber.stateNode as { object?: Node3D } & Node3D;
      return node.object ?? node;
    };
    const hasModel = (group: Node3D): boolean => {
      let found = false;
      group.traverse((node) => {
        if (node.isMesh === true && node.userData.ink === undefined && node.geometry?.type !== 'BoxGeometry') found = true;
      });
      return found;
    };
    const models: string[] = [];
    let loaded = 0;
    for (const root of roots) {
      for (const fiber of below(root.current.child)) {
        const userData = fiber.memoizedProps?.userData as { item?: unknown } | undefined;
        if (fiber.type !== 'group' || userData?.item !== 'enemy') continue;
        models.push(modelOf(fiber) ?? '(none)');
        if (hasModel(objectOf(fiber))) loaded += 1;
      }
    }
    return { models, loaded };
  });
}

/** Karta startu jmenuje skok i střelbu (P39 T10); na desktopu se kliká, „Tap to start“ je jen na dotyku (P70C T2). */
async function expectJumpAndShoot(page: Page): Promise<void> {
  const card = page.getByTestId('play-first-prompt');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByTestId('play-first-prompt-start')).toHaveText(/^Click (?:or press Space|to start)$/);
  await expect(page.getByTestId('play-first-prompt-more')).toContainText([/\bjump\b/i, /\bshoot\b/i]);
}

/** Všechna tělesa ke střelbě kreslí zvíře z manifestu, žádné robota; vrací jejich modely. */
async function expectAnimalsToShoot(page: Page): Promise<readonly string[]> {
  await expect.poll(async () => (await shotBodies(page)).models.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const { models } = await shotBodies(page);
  for (const model of models) {
    expect(model, `shot body model: ${models.join(', ')}`).not.toMatch(/robot/);
    expect(classOf(model), `class of ${model}`).toBe('animal');
  }
  // Model se opravdu načetl – ne náhradní kvádr, když by GLB chybělo.
  await expect.poll(async () => (await shotBodies(page)).loaded, { timeout: 60_000 }).toBe(models.length);
  return models;
}

test('the trigger sentence shows jump and shoot on the start card and has the player shoot animals, not robots', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.addInitScript(collectFiberRoots);
  const draft = await draftFromSentence(request);
  const target = await publishAiVersion(request);
  await page.route(`**${draft.upgrade}`, (route) => route.fulfill({ json: { status: 'ready', versionId: target }, headers: { 'cache-control': 'no-store' } }));

  // Rychlá verze: návrh ze slov věty.
  await page.goto(draft.url);
  await expectJumpAndShoot(page);
  await expectAnimalsToShoot(page);

  // AI verze: proužek nabídne „Full detail“, klik přepne hru.
  await startGame(page);
  const banner = page.getByTestId('upgrade-state');
  await expect(banner).toHaveAttribute('data-kind', 'ready', { timeout: 15_000 });
  await page.getByTestId('upgrade-action').click();
  await page.waitForURL(`**/play/${target}`);
  await expectJumpAndShoot(page);
  await expectAnimalsToShoot(page);

  // Zvíře ke střelbě je na startu v záběru – snímek ho musí ukázat.
  await expect
    .poll(async () => {
      const box = (await page.evaluate(() => window.__playFrame?.().items.enemy?.box ?? null)) as { behind: boolean; minX: number; maxX: number; minY: number; maxY: number } | null;
      return box !== null && !box.behind && box.maxX > -1 && box.minX < 1 && box.maxY > -1 && box.minY < 1;
    }, { timeout: 30_000 })
    .toBe(true);
  mkdirSync(join(SHOT, '..'), { recursive: true });
  await page.screenshot({ path: SHOT });
});
