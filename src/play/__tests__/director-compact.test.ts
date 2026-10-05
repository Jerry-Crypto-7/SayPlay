/**
 * Kompaktní první odpověď režiséra (P27D T2; na žánrech od P32B T4). Model
 * vybírá žánr, režim a role; hru skládá modul žánru, takže kompozice nevymyslí
 * nic, co model neřekl, a nepustí nic, co hra neukáže. Režim jiného žánru
 * nebo odpověď ve starém tvaru je `MALFORMED` a hraje návrh.
 */

import { describe, expect, it } from 'vitest';

import { answered, fakeBranch } from '../director/__fixtures__/branch';
import { GENRE_ANSWER_SCHEMA } from '../director/answer-schema';
import { COMPACT_PROMPT_VERSION, buildCompactRequest, compactSystemPrompt } from '../director/compact';
import { direct } from '../director/index';
import { DIRECTOR_PROMPT_VERSION, genrePromptLines } from '../director/prompt';
import { draftGameSpecWithMeta } from '../draft';

// Bez „shoots“ (T5b): u skutečných modulů je úkol `ready` a střelba ho vybere – věta
// s hlavním slovesem skoku hraje plošinovku, o kterou tu jde.
const SENTENCE = 'a penguin jumps over icebergs and grabs fish';

const answer = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  plan: 'platformer on ice',
  spec: { genre: 'platformer', mode: 'default', hero: 'penguin', enemy: 'iceberg', collectible: 'fish', target: null, setting: 'frozen iceberg field', palette: 'snow', params: null, ...overrides },
});

describe('compact request', () => {
  it('stays under the 12 700 B prompt budget, asks for a GenreSpec and has its own cache version', () => {
    const request = buildCompactRequest(SENTENCE, draftGameSpecWithMeta(SENTENCE).genre);
    expect(Buffer.byteLength(request.system + request.user, 'utf8')).toBeLessThanOrEqual(12_700);
    expect(request.outputSchema).toBe(GENRE_ANSWER_SCHEMA);
    expect(request.user).toContain('Starting point (a keyword guess, replace what it got wrong): {"genre":"platformer"');
    expect(COMPACT_PROMPT_VERSION).not.toBe(DIRECTOR_PROMPT_VERSION);
    expect(compactSystemPrompt()).toContain(genrePromptLines());
  });

  it('direct() in compact mode sends the compact request and authors the game the genre module builds', async () => {
    const branch = fakeBranch([answered(answer())]);
    let tick = 0;
    const game = await direct(SENTENCE, { branch, now: () => (tick += 250), compact: true });
    expect(branch.calls[0]?.request.outputSchema).toBe(GENRE_ANSWER_SCHEMA);
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, calls: 1 });
    expect(game.spec.genre?.id).toBe('platformer');
    expect(game.spec.control).toBe('platform');
    expect(game.spec.roles.find((role) => role.kind === 'player')?.label).toBe('penguin');
    expect(game.spec.theme).toMatchObject({ setting: 'frozen iceberg field', look: 'snow' });
  });

  it('direct() in compact mode falls back to the draft on a mode of another genre or the old answer shape', async () => {
    for (const body of [answer({ mode: 'race' }), { plan: 'old', control: 'platform', addons: [], labels: [] }]) {
      const branch = fakeBranch([answered(body)]);
      let tick = 0;
      const game = await direct(SENTENCE, { branch, now: () => (tick += 250), compact: true });
      expect(game).toMatchObject({ source: 'draft', fallbackReason: 'MALFORMED' });
    }
  });
});
