/**
 * Absurdní přenos P37A T5 na 40 větách mimo hry z vývojové sady
 * `evals/play/p37a/dev-150.json` (skupina `non-game`, n01–n40).
 *
 * „Hrdina nebo položka z věty viditelně ve hře“ = položka seznamu (hrdina,
 * role, věc) je v řetězu věrnosti `read` – roli z věty čte ovládání. Model
 * (`drawn`) se tu jen počítá: soupeř a věc bez modelu jsou kostka, dokud je
 * nepřevezme nejbližší model (T6).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { compileGame } from '@/play/compile';
import { readGenreAnswer } from '@/play/director/read';
import { draftGameSpecWithMeta } from '@/play/draft';
import { twistGoalFor } from '@/play/draft/draft';
import { twistOf } from '@/play/draft/twist';
import { fidelityChain, type ChecklistEntry } from '@/play/fidelity/chain';
import { GENRE_MODULES } from '@/play/genre/index';
import type { Reading } from '@/play/read/schema';

import dev from '../../../../evals/play/p37a/dev-150.json';
import { measureSentence } from '../../../../evals/play/p36/depth';

const OFF_TOPIC = dev.sentences.filter((sentence) => sentence.group === 'non-game');

/** Uzavřený anglický vzor cíle přenosu (`GOALS` v `twist.ts`); skupiny jsou popisky rolí. */
const GOAL = /^(?:Dodge the (.+)!|Grab the (.+) and dodge the (.+)!|Collect the (.+)!|Stack the (.+)!|Hit the (.+) on the beat!|Out-talk the (.+)!)$/;

/** Popisek cíle je z věty: aspoň jedno jeho slovo bez množného čísla ve větě stojí („long queues“, „support agents“ z „customer support line“). */
const inSentence = (label: string, text: string): boolean =>
  label
    .split(' ')
    .some((word) => word.length > 1 && new RegExp(`\\b${word.replace(/ies$/, 'y').replace(/(?<=[^s])e?s$/, '').replace(/-/g, '[- ]')}`).test(text.toLowerCase()));

const rows = OFF_TOPIC.map((sentence) => {
  const meta = draftGameSpecWithMeta(sentence.text, 1);
  const items = fidelityChain(meta.spec, sentence.checklist as readonly ChecklistEntry[]).filter((item) => item.slot !== 'verb' && item.slot !== 'setting');
  return { id: sentence.id, text: sentence.text, meta, read: items.some((item) => item.read), drawn: items.some((item) => item.drawn) };
});

beforeAll(async () => {
  await loadRapier();
});

describe('off-topic sentences on dev-150 (n01–n40)', () => {
  it('covers the 40 non-game sentences', () => {
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 40 }, (_, index) => `n${String(index + 1).padStart(2, '0')}`));
  });

  it('plays every sentence as a genre game that compiles and has more than the hero', () => {
    for (const row of rows) {
      const roles = row.meta.spec.roles ?? [];
      expect([row.id, row.meta.fellBack, row.meta.genre === null, compileGame(row.meta.spec, 1).ok, roles.some((role) => role.kind !== 'player')]).toEqual([row.id, false, false, true, true]);
    }
  });

  it('is won by the robot and lost by an idle player in every sentence', () => {
    for (const row of rows) {
      const depth = measureSentence({ set: 'dev', id: row.id, text: row.text });
      expect([row.id, depth.bot.end, depth.idle.end]).toEqual([row.id, 'won', 'lost']);
    }
  }, 120_000);

  it('reads a hero or an item from the sentence in ≥ 80 % of the sentences', () => {
    const read = rows.filter((row) => row.read).length;
    const drawn = rows.filter((row) => row.drawn).length;
    console.log(`off-topic: read ${read}/40, drawn by a model ${drawn}/40 (models for the rest come with T6)`);
    expect(read, JSON.stringify(rows.filter((row) => !row.read).map((row) => row.id))).toBeGreaterThanOrEqual(32);
  });

  it('says the goal in the words of the sentence in most sentences, and only words the sentence says', () => {
    const twisted = rows.filter((row) => GOAL.test(row.meta.spec.tutorial?.goalLine ?? ''));
    for (const row of twisted) {
      const labels = GOAL.exec(row.meta.spec.tutorial!.goalLine!)!.slice(1).filter((label) => label !== undefined);
      expect([row.id, labels.every((label) => inSentence(label, row.text))], `${row.id}: ${row.meta.spec.tutorial!.goalLine} ← ${row.text}`).toEqual([row.id, true]);
    }
    expect(twisted.length, JSON.stringify(rows.filter((row) => !twisted.includes(row)).map((row) => `${row.id}: ${row.meta.spec.tutorial?.goalLine}`))).toBeGreaterThanOrEqual(28);
  });
});

describe('the absurd twist', () => {
  const play = (text: string) => {
    const meta = draftGameSpecWithMeta(text, 1);
    // Obsazení (P39): protivník, věc ke sběru a cíl jsou první položky s tou rolí.
    const of = (...does: string[]) => meta.genre?.cast?.find((item) => does.includes(item.does))?.label;
    return { game: `${meta.genre?.genre}.${meta.genre?.mode}`, hero: meta.genre?.hero, enemy: of('chase_me', 'avoid', 'fight', 'shoot_at'), collectible: of('collect'), target: of('reach', 'throw_at'), goal: meta.spec.tutorial?.goalLine };
  };

  it('chases the pet with what it refuses (n13)', () => {
    expect(twistOf('my cat refusing to take her medicine')).toEqual({ hero: 'cat', foe: null, person: 'cat', thing: 'medicine' });
    expect(play('my cat refusing to take her medicine')).toMatchObject({ game: 'arena.escape', hero: 'cat', enemy: 'medicine', goal: 'Dodge the medicines!' });
  });

  it('dodges the people the sentence hides from, in their own plural (n38)', () => {
    const sentence = 'hide from my in-laws at the family reunion';
    expect(play(sentence)).toMatchObject({ game: 'quest.spatial', enemy: 'in-law' });
    const meta = draftGameSpecWithMeta(sentence);
    expect(meta.composition?.recipe).toMatchObject({ move: 'walk', threats: ['guard'] });
    expect(meta.composition?.witnesses).toContainEqual(expect.objectContaining({ verb: 'guard', actor: expect.objectContaining({ label: 'in-law' }) }));
  });

  it('stacks the paper the sentence pays (n09)', () => {
    expect(play('pay the electricity bill on my laptop')).toMatchObject({ game: 'timing.stack', collectible: 'electricity bill', goal: 'Stack the electricity bills!' });
  });

  it('argues with the first person of the sentence, not the one talked about (n40)', () => {
    expect(twistOf('argue with my wife about a name for our baby')?.person).toBe('wife');
    expect(play('argue with my wife about a name for our baby')).toMatchObject({ game: 'duel.default', enemy: 'wife', goal: 'Out-talk the wife!' });
  });

  it('stacks the homework, not the table it is done at (n24)', () => {
    expect(play('help my kid with science homework at the kitchen table')).toMatchObject({ game: 'timing.stack', collectible: 'homework', goal: 'Stack the homework!' });
  });

  it('dodges a dread the sentence only names (no verb)', () => {
    expect(play('a long queue at the pharmacy on a friday afternoon')).toMatchObject({ game: 'arena.escape', enemy: 'long queue', goal: 'Dodge the long queues!' });
    expect(play('toaster tornado')).toMatchObject({ game: 'arena.escape', hero: 'toaster', enemy: 'tornado' });
  });

  it('collects with the hero of a verbless sentence and keeps the module goal when nothing to collect is said', () => {
    const grandma = play('explain quantum physics to my grandma');
    expect(grandma).toMatchObject({ game: 'arena.collect', hero: 'grandma' });
    expect(grandma.goal).not.toMatch(GOAL);
  });

  it('drops measures and ordinals before the object', () => {
    expect(play('meal prep a week of lunches in plastic containers').target).toBe('lunch');
    expect(play('catch the last bus home after a night shift at the hospital').collectible).toMatch(/^bus\b/);
    expect(play('fold a mountain of clean towels on the couch').collectible).toBe('clean towel');
  });

  it('says the same goal in the AI version the director keeps', () => {
    const text = 'a long queue at the pharmacy on a friday afternoon';
    const draft = draftGameSpecWithMeta(text, 1);
    const read = readGenreAnswer({ plan: 'keep', spec: draft.genre }, GENRE_MODULES, text);
    expect(read.ok && read.spec.tutorial?.goalLine).toBe('Dodge the long queues!');
    // Model, který větu přečetl, má své role – cíl přenosu se nepřidá.
    expect(twistGoalFor(text, draft.genre!, { roles: [] } as unknown as Reading)).toBeNull();
  });

  it('leaves sentences without a known noun, game asks and game verbs alone', () => {
    expect(twistOf('my first day at a new office job')).toBeNull();
    expect(play('a cozy game about paying the electricity bill').goal).not.toMatch(GOAL);
    expect(play('a knight fights a dragon in a castle').goal).not.toMatch(GOAL);
  });
});
