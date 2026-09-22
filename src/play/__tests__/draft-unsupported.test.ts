/**
 * Poctivá hláška (P25E T1) – pin nad korpusem poptávky
 * (`evals/play/demand/corpus.json`, 200 vět se štítkem ovládání `verb`).
 * Naměřeno 22. 9. 2026: neumíme 38/38 (manipulate 15, build_place 12,
 * idle 8, sandbox 3), chráněné štítky 0/74, jinde jediná s126 („merge
 * watermelons like suika game“, štítek timing – slučování je poctivě idle).
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

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

function flagged(verbs: readonly string[]): { readonly hit: number; readonly total: number; readonly ids: string[] } {
  const entries = corpus.filter((entry) => verbs.includes(entry.verb));
  const ids = entries.filter((entry) => unsupportedGame(entry.text, draftGameSpec(entry.text)) !== null).map((entry) => entry.id);
  return { hit: ids.length, total: entries.length, ids };
}

describe('unsupportedGame over the demand corpus', () => {
  it('flags every sentence the control library cannot play', () => {
    const result = flagged(UNSUPPORTED);
    expect(result.total).toBe(38);
    expect(result.hit).toBe(38);
    expect(result.hit / result.total).toBeGreaterThanOrEqual(0.8);
  });

  it('never flags a runner, platform, flap or tap-to-go sentence', () => {
    const result = flagged(PROTECTED);
    expect(result.total).toBe(74);
    expect(result.ids).toEqual([]);
  });

  it('flags nothing else but the merge game', () => {
    const others = corpus.filter((entry) => !UNSUPPORTED.includes(entry.verb) && !PROTECTED.includes(entry.verb)).map((entry) => entry.verb);
    const result = flagged([...new Set(others)]);
    expect(result.ids.map((id) => corpus.find((entry) => entry.id === id)?.text)).toEqual(['merge watermelons like suika game']);
  });
});

describe('unsupportedGame', () => {
  it('names the game the draft built instead', () => {
    const sentence = 'a match 3 game with fruits';
    expect(unsupportedGame(sentence, draftGameSpec(sentence))).toEqual({
      kind: 'manipulate',
      reason: 'Swapping, sorting and sliding pieces around is not something we can build yet.',
      closest: 'a collect-and-escape game',
    });
  });

  it('calls a runner draft an endless runner', () => {
    expect(unsupportedGame('tower defense runner', { archetype: 'hazard_crossing', control: 'runner' })?.closest).toBe('an endless runner');
  });

  it('puts an open world before the building inside it', () => {
    const sentence = 'A multiplayer city where I build my house';
    expect(unsupportedGame(sentence, draftGameSpec(sentence))?.kind).toBe('sandbox');
  });
});
