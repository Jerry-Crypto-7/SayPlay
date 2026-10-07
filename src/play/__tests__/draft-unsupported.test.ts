import { loadRapier } from '@/play/arcade/physics/world';
/**
 * Poctivá hláška (P25E T1) – pin nad korpusem poptávky
 * (`evals/play/demand/corpus.json`, 200 vět se štítkem ovládání `verb`).
 * Naměřeno 22. 9. 2026: neumíme 38/38 (manipulate 15, build_place 12,
 * idle 8, sandbox 3), chráněné štítky 0/74, jinde jediná s126 („merge
 * watermelons like suika game“, štítek timing – slučování je poctivě idle).
 */

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { draftGameSpec } from '../draft';
import { unsupportedGame } from '../draft/unsupported';

interface DemandEntry {
  readonly id: string;
  readonly text: string;
  readonly verb: string;
}

const corpus = JSON.parse(readFileSync(new URL('../../../evals/play/demand/corpus.json', import.meta.url), 'utf8')) as DemandEntry[];

const UNSUPPORTED = ['manipulate', 'build_place', 'idle', 'sandbox'];
const PROTECTED = ['runner', 'platform', 'flap', 'tap_go'];

describe('unsupportedGame over the demand corpus', () => {
  const unsupported = corpus.filter((entry) => UNSUPPORTED.includes(entry.verb));
  const protectedEntries = corpus.filter((entry) => PROTECTED.includes(entry.verb));
  const others = corpus.filter((entry) => !UNSUPPORTED.includes(entry.verb) && !PROTECTED.includes(entry.verb));

  it('keeps the corpus coverage counts', () => {
    expect(unsupported).toHaveLength(38);
    expect(protectedEntries).toHaveLength(74);
    expect(others.filter((entry) => entry.text === 'merge watermelons like suika game')).toHaveLength(1);
  });

  it.each(unsupported)('flags unsupported $id: $text', (entry) => {
    expect(unsupportedGame(entry.text, draftGameSpec(entry.text))).not.toBeNull();
  });

  it.each(protectedEntries)('never flags protected $id: $text', (entry) => {
    expect(unsupportedGame(entry.text, draftGameSpec(entry.text))).toBeNull();
  });

  it.each(others)('flags only the merge game among other controls, $id: $text', (entry) => {
    const flagged = unsupportedGame(entry.text, draftGameSpec(entry.text)) !== null;
    expect(flagged).toBe(entry.text === 'merge watermelons like suika game');
  });
});

// P28D T4 (R-12): věta bez herního slovesa dostane hru o svém tématu a řekne to – od P36A T11 sběr v Aréně, běžec až poslední.
describe('a sentence without a game verb', () => {
  it('plays an arena collect about its longest noun and says so, with two example verbs', () => {
    const sentence = 'Explain quantum physics to my grandma.';
    const spec = draftGameSpec(sentence);
    expect(spec.genre).toMatchObject({ id: 'arena', mode: 'collect' });
    expect(spec.roles.find((role) => role.kind === 'player')?.label).toBe('grandma');
    expect(unsupportedGame(sentence, spec)).toEqual({
      kind: 'no_verb',
      reason: 'No game verb found – here is a collecting game about grandma. Try: ‘Dodge …’, ‘Collect …’',
      closest: 'a collecting game',
    });
    expect(unsupportedGame('a romantic dinner date on the moon', draftGameSpec('a romantic dinner date on the moon'))?.reason).toContain('collecting game about dinner');
    // Hra bez žánru (uložená před P32) je dál běžec a hláška to tak řekne.
    expect(unsupportedGame(sentence, { archetype: 'hazard_crossing', control: 'runner' })?.reason).toContain('an endless runner about grandma');
    // Běžec žánrového modulu uložený před P36A T11 hlášku neztratí.
    expect(unsupportedGame(sentence, { archetype: 'hazard_crossing', control: 'runner', genre: { id: 'runner', mode: 'default', compilerVersion: 'play-compiler-v4' } })?.reason).toContain('an endless runner about grandma');
  });

  it('stays quiet for a sentence with a verb, a noun cue, or once the AI version is another game', () => {
    for (const sentence of ['pop ten balloons at a birthday party', 'a dragon in my garden', 'endless runner in a neon city', 'a knight collects keys in a castle']) {
      expect(unsupportedGame(sentence, draftGameSpec(sentence)), sentence).toBeNull();
    }
    expect(unsupportedGame('Explain quantum physics to my grandma.', { archetype: 'combat_lite', control: 'shooter' })).toBeNull();
  });
});

describe('unsupportedGame', () => {
  it('names the game the draft built instead', () => {
    const sentence = 'a match 3 game with fruits';
    // P32B T2: „match 3“ jde do Úkolu na místě, ne do běžce bez narážky.
    expect(unsupportedGame(sentence, draftGameSpec(sentence))).toEqual({
      kind: 'manipulate',
      reason: 'Swapping, sorting and sliding pieces around is not something we can build yet.',
      closest: 'a quest',
    });
  });

  it('calls a runner draft an endless runner', () => {
    expect(unsupportedGame('tower defense runner', { archetype: 'hazard_crossing', control: 'runner' })?.closest).toBe('an endless runner');
  });

  // Všechny arkádové šablony mají archetyp `hazard_crossing`, takže podle něj
  // by hláška plošinovce i letu slibovala přecházení silnice. P32B T2: jméno dává žánr.
  it('names the game the player actually got, not the template archetype', () => {
    for (const [sentence, closest] of [
      ['a tower defense platformer where you jump between ledges', 'a platformer'],
      ['an idle clicker where a bird flaps through pipes', 'a flappy game'],
    ] as const) {
      const draft = draftGameSpec(sentence);
      expect(draft.archetype, sentence).toBe('hazard_crossing');
      expect(unsupportedGame(sentence, draft)?.closest, sentence).toBe(closest);
    }
  });

  // Revize fáze P25E: obecná slova (empire, protect, mirrors, craft) patří i hrám, které umíme.
  it('leaves playable sentences with common words alone', () => {
    for (const sentence of [
      'escape the galactic empire on a hoverboard',
      'protect the princess while running',
      'a thief sneaks through a hall of mirrors',
      'craft a raft and cross the river',
      'sort of a racing game with pipes everywhere',
      'defend the goal in a quick soccer shootout',
    ]) {
      expect(unsupportedGame(sentence, draftGameSpec(sentence)), sentence).toBeNull();
    }
  });

  it('puts an open world before the building inside it', () => {
    const sentence = 'A multiplayer city where I build my house';
    expect(unsupportedGame(sentence, draftGameSpec(sentence))?.kind).toBe('sandbox');
  });
});

// Composition now executes physical ball witnesses even in synchronous draft tests.
beforeAll(async () => { await loadRapier(); });
