/**
 * P68V T1: pruh nesmí krást věty, dokud ho P68-I nezapojí. `route-before.json` je žánr rychlé hry
 * (`classifyGenre(věta, null).ranked[0]`, bez modelu) na všech 200 větách sady P30 na čerstvé větvi po kostře;
 * test spočítá totéž teď. Hlídač, který neporovná všech 200 vět, by vypadal jako ochrana a nechal krádež projít.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { classifyGenre } from '@/play/genre/classify';

import { routeChanges, routeRows } from '../route-snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');

interface Row { id: string; text: string; genre: string; mode: string }

const before = JSON.parse(readFileSync(join(HERE, '..', 'route-before.json'), 'utf8')) as { rows: Row[] };
const test200 = JSON.parse(readFileSync(join(ROOT, 'evals/play/p30/test-200.json'), 'utf8')) as { sentences: { id: string; text: string }[] };

describe('P68V routing guard', () => {
  it('the snapshot covers all 200 sentences of the sealed P30 set', () => {
    expect(test200.sentences).toHaveLength(200);
    expect(before.rows.map((row) => row.id)).toEqual(test200.sentences.map((s) => s.id));
  });

  it('no sentence changes its quick-game genre or mode on this branch', () => {
    const now = routeRows(classifyGenre, test200.sentences) as Row[];
    // P85A T2: klání je souboj („jousts“) – t123 jde na souboj, který mu štítky P66 dávají jako nejlepší; tu větu
    // hlídá `evals/play/p85/__tests__/noun-not-verb.test.ts`. Jen tenhle přesun s tímhle cílem, jiný stráž shodí.
    const allowed = (change: { id: string; after: string | null }): boolean => change.id === 't123' && change.after === 'duel/default';
    expect(routeChanges(before.rows, now).filter((change: { id: string; after: string | null }) => !allowed(change))).toEqual([]);
  });

  it('flags a single changed genre and a missing sentence', () => {
    const rows: Row[] = [
      { id: 'a', text: 'race over the dunes', genre: 'voyage', mode: 'default' },
      { id: 'b', text: 'putt into the hole', genre: 'ball', mode: 'default' },
    ];
    const stolen = [rows[0] as Row, { ...(rows[1] as Row), genre: 'minigolf' }];
    expect(routeChanges(rows, stolen)).toEqual([{ id: 'b', text: 'putt into the hole', before: 'ball/default', after: 'minigolf/default' }]);
    expect(routeChanges(rows, [rows[0] as Row])).toEqual([{ id: 'b', text: 'putt into the hole', before: 'ball/default', after: null }]);
  });
});
