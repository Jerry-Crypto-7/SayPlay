import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { compileGenre, readGenreSpec } from '../src/play/genre/index';
import { voyageGenre } from '../src/play/genre/voyage';

/**
 * Galerie kulis draftu (P28D T5, F-28): deset vět zmrazené sady `judge-10.json`
 * projde skutečnými dveřmi `POST /api/play/games` (draft bez modelu) a každá
 * hra se vyfotí po usazení scény. Snímky jsou podklad pro lidské oko – žádný
 * atribut tu nerozhoduje, jestli kulisa vypadá rozbitě.
 *
 * P46G T7: navíc jedna věta na žánr arkády (`evals/play/p46g/genres.json`) – zem,
 * vegetace, nálada a kulisa za mlhou v každé scéně. U nich test hlídá, že věta
 * opravdu dala čekané ovládání a scéna kreslí (`__playRender`), jinak by snímek
 * tiše ukázal jiný žánr.
 *
 * **Běží jen na zavolání:** bez `P28_SCENERY_DIR` se přeskočí.
 */

const DIR = process.env.P28_SCENERY_DIR ?? '';

interface Sentence {
  readonly id: string;
  readonly text: string;
  /** Ovládání, které věta dá (`data-control` plochy); jen věty žánrů. */
  readonly control?: string;
}

const read = (path: string): { sentences: Sentence[] } => JSON.parse(readFileSync(join(process.cwd(), path), 'utf8')) as { sentences: Sentence[] };

// Navíc věta ze snímků auditu (`custom-dragon-*.png`) a jedna hra gridu – ta kreslí svět přes `buildProxyWorldFrom`.
const SENTENCES: readonly Sentence[] = [
  ...read('evals/play/fidelity/judge-10.json').sentences.map(({ id, text }) => ({ id, text })),
  { id: 'x-dragon', text: 'A knight rides a dragon over a burning castle and must pop ten balloons.' },
  { id: 'x-grid', text: 'Collect five glowing mushrooms then open a portal.' },
  ...read('evals/play/p46g/genres.json').sentences.map(({ id, text, control }) => ({ id, text, control })),
];

/**
 * Scény, které rychlá věta tohoto serveru nedá, jako hotový spec: agar (uložená hra bez
 * velikosti hráče, `__fixtures__/arena.json` jako `play-setting`) a plavba po moři
 * (modul Plavby jako `p32-voyage`; rychlá věta o pirátech jede po silnici).
 */
const PIRATE = 'A pirate ship dodges cannonballs while sailing between islands to find buried treasure';
function pirateSpec(): unknown {
  const read = readGenreSpec(voyageGenre.draftFill(PIRATE, null));
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}
function agarSpec(): unknown {
  const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__/arena.json'), 'utf8')) as { theme: Record<string, unknown> } & Record<string, unknown>;
  return { ...base, title: 'grow in a forest', theme: { ...base.theme, setting: 'a forest clearing' } };
}
const SPECS: readonly (Sentence & { readonly spec: () => unknown })[] = [
  { id: 'g-agar-legacy', text: 'agar fixture in a forest clearing', control: 'move_free', spec: agarSpec },
  { id: 'g-sea', text: PIRATE, control: 'steer', spec: pirateSpec },
];

test.describe('draft scenery gallery', () => {
  test.skip(DIR === '', 'set P28_SCENERY_DIR to the directory the snapshots go to');

  const games: readonly (Sentence & { readonly spec?: () => unknown })[] = [...SENTENCES, ...SPECS];
  for (const sentence of games) {
    test(`${sentence.id} – ${sentence.text}`, async ({ page, request }) => {
      mkdirSync(DIR, { recursive: true });
      const data = sentence.spec === undefined ? { sentence: sentence.text } : { spec: sentence.spec() };
      const response = await request.post('/api/play/games', { data });
      expect(response.status(), await response.text()).toBeLessThan(300);
      const { url } = (await response.json()) as { url: string };
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(url);
      await page.locator('canvas').first().waitFor({ timeout: 60_000 });
      if (sentence.control !== undefined) {
        await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-control', sentence.control);
        await page.waitForFunction(() => (window.__playRender?.().calls ?? 0) > 0, undefined, { timeout: 60_000 });
      }
      await page.waitForTimeout(3000);
      await page.screenshot({ path: join(DIR, `${sentence.id}.png`) });
    });
  }
});
