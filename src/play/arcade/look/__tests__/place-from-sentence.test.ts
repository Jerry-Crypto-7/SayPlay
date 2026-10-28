/**
 * P62 T10: rychlá hra kreslí místo, které věta jmenuje. Štítky T9 (`evals/play/p62/place-labels.json`) říkají, ve
 * kterých sadách by divák místo poznal; kreslená sada jde ze dveří `/api/play/games` (`quickGame`, kolo 1 řetězu nebo
 * návrh ze slov). Špatné místo vypadá jako hezká scéna, na pohled se nepozná – proto počet ze štítků.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { quickGame } from '../../../../../evals/play/p62/audit.mjs';
import { labelsById, openSentences, placeRow } from '../../../../../evals/play/p62/place-audit.mjs';
import { loadRapier } from '../../physics/world';
import { lookOf } from '..';

/** Špatná místa auditu T9 (`bdac9958`): 26 z 206 vět, které místo jmenují. Jiná věta špatně = zhoršení. */
const WRONG_AT_T9 = [
  'p30/dev:h03', 'p30/dev:j02', 'p30/dev:d04', 'p58b/holdout:s42', 'p56c/chain-sentences:d10', 'p56c/chain-sentences:d11',
  'p56c/dev:d13', 'p56c/dev:d34', 'p56c/dev:d35', 'p56c/holdout:h03', 'p56c/holdout:h04', 'p56c/holdout:h06',
  'p56c/holdout:h08', 'p56c/holdout:h10', 'p56c/holdout:h13', 'p56c/holdout:h21', 'p61/holdout:h14', 'p61/holdout:h19',
  'p61/holdout:h23', 'p62/holdout:p07', 'p62/holdout:p08', 'p62/holdout:p14', 'p62/holdout:p18', 'p62/holdout:p22',
  'p62/holdout:p23', 'p62/holdout:p24',
];

type Drawn = { id: string; text: string; drawn: string; verdict: string };

describe('P62 T10: the scene draws the place the sentence names', () => {
  let rows: Drawn[] = [];

  beforeAll(async () => {
    await loadRapier();
    const labels = labelsById();
    rows = openSentences()
      .filter((sentence) => labels.get(sentence.id)?.place !== null)
      .map((sentence) => placeRow(sentence, labels.get(sentence.id)!, lookOf(quickGame(sentence.text).spec.theme)));
  }, 300_000);

  it('labels the same 206 sentences that name a place as T9 did', () => {
    expect(rows).toHaveLength(206);
    expect(rows.filter((row) => WRONG_AT_T9.includes(row.id))).toHaveLength(WRONG_AT_T9.length);
  });

  it('draws no place wrong that T9 drew right', () => {
    expect(rows.filter((row) => row.verdict === 'wrong' && !WRONG_AT_T9.includes(row.id)).map((row) => `${row.id} → ${row.drawn}: ${row.text}`)).toEqual([]);
  });

  it('draws at most half of the T9 wrong places wrong', () => {
    const wrong = rows.filter((row) => row.verdict === 'wrong');
    expect(wrong.length, wrong.map((row) => `${row.id} → ${row.drawn}`).join('\n')).toBeLessThanOrEqual(13);
  });

  it('reads the compound places of the T7 losses whole, not word by word', () => {
    const drawnOf = (id: string) => rows.find((row) => row.id === id)?.drawn;
    expect(drawnOf('p62/holdout:p24')).toBe('city'); // night market, ne supermarket
    expect(drawnOf('p62/holdout:p18')).toBe('meadow'); // soccer pitch, ne hradby obrany
    expect(['city', 'factory']).toContain(drawnOf('p62/holdout:p23')); // post office sorting room, ne obývák
  });
});
