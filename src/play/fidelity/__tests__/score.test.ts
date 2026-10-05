/**
 * Brána upgradu (P37A T8): AI verze se nabídne, jen když proti návrhu na témž
 * seznamu zvedne věrnost aspoň o `MIN_UPGRADE_GAIN` = 0,05. Práh se drží
 * přesně – jedna položka z 20 projde, z 21 ne – a horší i stejně věrná verze
 * neprojde nikdy.
 */

import { describe, expect, it } from 'vitest';

import { draftGameSpec } from '../../draft';
import type { GameSpecV1 } from '../../spec';
import type { ChecklistEntry } from '../chain';
import { MIN_UPGRADE_GAIN, specFidelity, upgradeGain } from '../score';

const WALRUS = 'a walrus chef stirs a big pot of soup on an iceberg';
const draft = draftGameSpec(WALRUS);
/** Táž hra se sadou sněhu: ledovec v popisku prostředí teď scéna ukáže, takže ho ovládání čte. */
const snowy: GameSpecV1 = { ...draft, theme: { ...draft.theme, look: 'snow' } };

const ICEBERG: ChecklistEntry = { item: 'iceberg', slot: 'setting', match: ['iceberg'] };
/** `n` položek, které nečte žádná verze – jmenovatel bez vlivu na čitatel. */
const unread = (n: number): ChecklistEntry[] => Array.from({ length: n }, (_, index) => ({ item: `thing ${String(index)}`, slot: 'role', match: [`zzz${String(index)}`] }));

describe('upgradeGain', () => {
  it('the snow set makes the iceberg read: one item more of four is +0.25', () => {
    expect(specFidelity(draft, [ICEBERG]).score).toBe(0);
    expect(specFidelity(snowy, [ICEBERG]).score).toBe(1);
    expect(upgradeGain(draft, snowy, [ICEBERG, ...unread(3)])).toEqual({ draft: 0, ai: 0.25, gain: 0.25, better: true });
  });

  it('holds the threshold exactly: one item of 20 passes, one of 21 does not', () => {
    expect(MIN_UPGRADE_GAIN).toBe(0.05);
    expect(upgradeGain(draft, snowy, [ICEBERG, ...unread(19)])).toMatchObject({ gain: 0.05, better: true });
    expect(upgradeGain(draft, snowy, [ICEBERG, ...unread(20)])).toMatchObject({ gain: 0.048, better: false });
  });

  it('an equally faithful or a worse version never passes', () => {
    expect(upgradeGain(draft, draft, [ICEBERG, ...unread(3)])).toEqual({ draft: 0, ai: 0, gain: 0, better: false });
    expect(upgradeGain(snowy, draft, [ICEBERG, ...unread(3)])).toEqual({ draft: 0.25, ai: 0, gain: -0.25, better: false });
  });

  it('an empty checklist gives no gain and no upgrade', () => {
    expect(upgradeGain(draft, snowy, [])).toEqual({ draft: 0, ai: 0, gain: 0, better: false });
  });

  // Rozdíl dvou zaokrouhlených podílů nese chybu plovoucí čárky (0,85 − 0,8 = 0,0499…); zisk se zaokrouhlí stejně jako skóre.
  it('rounds the gain like the scores, so 0.8 → 0.85 is exactly the threshold', () => {
    const chefs: ChecklistEntry[] = Array.from({ length: 16 }, (_, index) => ({ item: `chef ${String(index)}`, slot: 'hero', match: ['chef'] }));
    const gain = upgradeGain(draft, snowy, [...chefs, ICEBERG, ...unread(3)]);
    expect(gain).toEqual({ draft: 0.8, ai: 0.85, gain: 0.05, better: true });
    expect(gain.ai - gain.draft).toBeLessThan(0.05);
  });
});
