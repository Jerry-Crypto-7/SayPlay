/**
 * Vyhledání v tabulce sloves P44C (T6). Špatně odtržená koncovka vrátí `null` a hra vypadá jako
 * před P44C – chyba je neviditelná, proto test pinuje tvary i cíle.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path.replace(/\\/g, '/')] : [];
      });
    const importers = files('src').filter((path) => /verbs\.json['"]/.test(readFileSync(path, 'utf8')) && !path.includes('__tests__'));
    expect(importers).toEqual(['src/play/vocab/lookup.ts']);
    const clients = files('src/components').filter((path) => /from ['"][^'"]*vocab/.test(readFileSync(path, 'utf8')));
    expect(clients).toEqual([]);
  });
});
