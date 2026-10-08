/**
 * Vyhledání v tabulce sloves P44C (T6). Špatně odtržená koncovka vrátí `null` a hra vypadá jako
 * před P44C – chyba je neviditelná, proto test pinuje tvary i cíle.
 */
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { vocabVerb } from '../index';

afterEach(() => vi.unstubAllEnvs());

const target = (word: string) => {
  const hit = vocabVerb(word);
  return hit === null ? null : `${hit.axis}:${hit.id}`;
};

describe('vocabVerb', () => {
  it('maps the probe verbs onto their intent axis', () => {
    expect(target('stab')).toBe('action:fight');
    expect(target('sprint')).toBe('move:run');
    expect(vocabVerb('lug')).toMatchObject({ axis: 'action', id: 'deliver', hero: 'carry' });
  });

  it('reads regular inflections back to the lemma', () => {
    for (const form of ['stabs', 'stabbing', 'stabbed', 'Stab']) expect(target(form), form).toBe('action:fight');
    for (const form of ['sprints', 'sprinting', 'sprinted']) expect(target(form), form).toBe('move:run');
    expect(vocabVerb('whisking')?.hero).toBe('stir');
    // Lemma s „e“ na konci: „hurling“ → „hurl“, ale „escaping“ → „escape“.
    expect(target('escaping')).toBe('objective:escape');
    expect(target('escaped')).toBe('objective:escape');
  });

  it('gives a pose without an axis when only the pose maps', () => {
    expect(vocabVerb('whisk')).toEqual({ axis: null, id: null, hero: 'stir', score: 1 });
  });

  it('leaves verbs that are not game actions alone', () => {
    for (const verb of ['explain', 'write', 'worry', 'explaining', 'xyzzy', '']) expect(vocabVerb(verb), verb).toBeNull();
  });

  it('agrees with the hand table on a verb it already knows', () => {
    expect(target('shoot')).toBe('action:shoot');
  });

  it('is off with PLAY_VOCAB=off', () => {
    vi.stubEnv('PLAY_VOCAB', 'off');
    expect(vocabVerb('stab')).toBeNull();
  });

  it('keeps the table on the server: only lookup.ts imports verbs.json, components never import vocab', () => {
    // git grep: procházet celé `src/` přes fs pod souběžnou sadou trvá desítky sekund.
    const grep = (pattern: string, path: string): string[] => {
      const run = spawnSync('git', ['grep', '-lE', pattern, '--', `${path}/*.ts`, `${path}/*.tsx`], { encoding: 'utf8' });
      return run.stdout.split('\n').filter((line) => line !== '' && !line.includes('__tests__'));
    };
    expect(grep(String.raw`verbs\.json['"]`, 'src')).toEqual(['src/play/vocab/lookup.ts']);
    expect(grep(`from ['"][^'"]*vocab`, 'src/components')).toEqual([]);
  });
});
