import { describe, expect, it } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { draftGameSpecWithMeta } from '@/play/draft/draft';
import { IDEAS } from '../../starters';
import { tracked } from '../ArcadePlay';

// Review fáze 1 P70C: hra bez trati (délka světa 0) nemá „of the way“ – jinak postup 0 % a každá prohra „Try again!“.
const trackOf = (genre: string): boolean => {
  const idea = IDEAS.find((entry) => entry.genre === genre);
  if (idea === undefined) throw new Error(`no idea for ${genre}`);
  const spec = draftGameSpecWithMeta(idea.sentence).spec;
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return tracked(spec, made.world);
};

describe('tracked', () => {
  it.each(['railfps', 'minigolf', 'drawsave'])('%s has no track to measure', (genre) => {
    expect(trackOf(genre)).toBe(false);
  });

  it('a runner measures how far it got', () => {
    expect(trackOf('runner')).toBe(true);
  });
});
