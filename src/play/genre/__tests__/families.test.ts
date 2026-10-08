/**
 * Rodiny sloves P37A T3 na větách vývojové sady `evals/play/p37a/dev-150.json`.
 * Věty rodin jsou vypsané ručně (sloveso checklistu), ne vybrané modulem
 * rodin – vypnutá rodina tak test shodí, místo aby ho vyprázdnila.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import { castFor } from '@/play/genre/contract';
import type { HeroAction } from '@/play/spec';

import dev from '../../../../evals/play/p37a/dev-150.json';
import { measureSentence } from '../../../../evals/play/p36/depth';

type Expect = { readonly genre: string; readonly mode: string; readonly heroAction: HeroAction; readonly object: 'collectible' | 'target' | 'none'; readonly ids: readonly string[] };

const FAMILY_SENTENCES: Readonly<Record<string, Expect>> = {
  clean: { genre: 'arena', mode: 'collect', heroAction: 'sweep', object: 'collectible', ids: ['u09', 'u11', 'u12', 'u13', 'u14', 'u15', 'u26', 'u28', 'u34', 'u36', 'u50', 'n21', 'm13'] },
  cook: { genre: 'quest', mode: 'station', heroAction: 'stir', object: 'target', ids: ['u03', 'u04', 'u43', 'u44', 'u52', 'n31', 'f14', 'm04', 'm12', 'm19', 'f30'] },
  chop: { genre: 'quest', mode: 'spatial', heroAction: 'chop', object: 'target', ids: ['u19', 'u20', 'u21', 'u22', 'u30', 'u31', 'f13', 'm15'] },
  // P37A T4.
  craft: { genre: 'rhythm', mode: 'default', heroAction: 'knit', object: 'none', ids: ['u01', 'u02', 'u16', 'u17', 'u41', 'u59', 'n05', 'm17'] },
  'garden (water)': { genre: 'quest', mode: 'spatial', heroAction: 'water', object: 'target', ids: ['u06'] },
  'garden (plant, dig)': { genre: 'quest', mode: 'spatial', heroAction: 'dig', object: 'target', ids: ['u07'] },
  fix: { genre: 'quest', mode: 'station', heroAction: 'fix', object: 'target', ids: ['u23', 'u25', 'n39'] },
  paint: { genre: 'quest', mode: 'spatial', heroAction: 'paint', object: 'target', ids: ['u18', 'u53'] },
  care: { genre: 'quest', mode: 'station', heroAction: 'carry', object: 'target', ids: ['u32', 'u49'] },
  spray: { genre: 'shooter', mode: 'default', heroAction: 'spray', object: 'none', ids: ['u45'] },
  herd: { genre: 'arena', mode: 'collect', heroAction: 'throw', object: 'collectible', ids: ['u05', 'u33', 'f09'] },
  perform: { genre: 'rhythm', mode: 'default', heroAction: 'none', object: 'none', ids: ['u37', 'u38', 'n11'] },
  'perform (juggle)': { genre: 'rhythm', mode: 'default', heroAction: 'throw', object: 'none', ids: ['u35'] },
  paperwork: { genre: 'timing', mode: 'stack', heroAction: 'stack', object: 'none', ids: ['n01', 'n04', 'n06', 'n09', 'n24', 'n34', 'm14'] },
};

const TEXT = new Map(dev.sentences.map((sentence) => [sentence.id, sentence.text]));
const textOf = (id: string): string => TEXT.get(id)!;

/** Popisek role je z věty: aspoň jedno jeho slovo (bez množného „s“) ve větě stojí. */
const fromSentence = (label: string | undefined, text: string): boolean =>
  label !== undefined && label.toLowerCase().split(' ').some((word) => word.length > 2 && text.toLowerCase().includes(word.replace(/s$/, '')));

beforeAll(async () => {
  await loadRapier();
});

describe.each(Object.entries(FAMILY_SENTENCES))('family %s on dev-150', (_family, want) => {
  const rows = want.ids.map((id) => {
    const text = textOf(id);
    const meta = draftGameSpecWithMeta(text, 1);
    const genre = meta.genre;
    const label = genre == null ? undefined : want.object === 'collectible' ? castFor(genre, 'collect')?.label : castFor(genre, 'reach', 'throw_at')?.label;
    return {
      id,
      genre: `${genre?.genre}.${genre?.mode}`,
      heroAction: meta.spec.heroAction,
      label,
      fits: genre?.genre === want.genre && genre.mode === want.mode && meta.spec.heroAction === want.heroAction && (want.object === 'none' || fromSentence(label, text)),
    };
  });

  it('plays the family genre with the hero action and the sentence object in ≥ 90 % of its sentences', () => {
    const misses = rows.filter((row) => !row.fits);
    expect(rows.length - misses.length, JSON.stringify(misses)).toBeGreaterThanOrEqual(Math.ceil(rows.length * 0.9));
  });

  it('fills the hero action in every sentence of the family', () => {
    expect(rows.map((row) => [row.id, row.heroAction])).toEqual(want.ids.map((id) => [id, want.heroAction]));
  });

  it('is won by the robot and lost by an idle player', () => {
    for (const id of want.ids) {
      const row = measureSentence({ set: 'dev', id, text: textOf(id) });
      expect([id, row.bot.end, row.idle.end]).toEqual([id, 'won', 'lost']);
    }
  }, 120_000);
});

// P41: digging and searching are separate actions. The live collect recipe can
// play the carrots; a quest stand-in must not claim to have dug tunnels.
// P42 takes an unstated movement from the reading (roaming), the walker only from a stated walk.
it('u08 collects the named carrots and admits the missing digging action', () => {
  const meta = draftGameSpecWithMeta(textOf('u08'), 1);
  expect(meta.composition?.recipe).toMatchObject({ move: 'roam', objective: 'collect' });
  expect(castFor(meta.genre!, 'collect')?.label).toBe('carrot');
  expect(meta.spec.heroAction).toBe('dig');
  expect(meta.composition?.unmet).toContainEqual({ actor: 'mole', verb: 'dig', object: 'tunnel' });
  const row = measureSentence({ set: 'dev', id: 'u08', text: textOf('u08') });
  expect([row.bot.end, row.idle.end]).toEqual(['won', 'lost']);
});

describe('outside the families', () => {
  it.each([
    ['clean as an adjective', 'clean towels pile up in the laundry room'],
    ['water as a noun', 'a duck swims across the water to its nest'],
    ['a herd as a noun', 'a herd of cows blocks the road to the farm'],
    ['an iron sword', 'a knight swings an iron sword at the gate'],
    ['a burrow as a home', 'A penguin flees a hungry seal across the ice to reach its burrow.'],
    ['sea spray', 'a surfer dodges sea spray and sharks near the reef'],
    ['oil drums', 'a forklift dodges rolling oil drums in a warehouse'],
    ['a fishing lure', 'a cat steals a fishing lure from the tackle box'],
    ['a washing machine', 'a sock trying to climb out of a washing machine'],
    ['sweep as a patrol', 'Last 90 seconds on a rooftop while drones sweep the area.'],
    ['a game verb', 'a knight fights a dragon in a castle'],
  ])('leaves heroAction out (%s)', (_why, text) => {
    expect(draftGameSpecWithMeta(text, 1).spec.heroAction).toBeUndefined();
  });
});
