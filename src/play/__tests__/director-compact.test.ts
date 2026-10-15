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
  spec: { genre: 'platformer', mode: 'default', hero: 'penguin', cast: [{ label: 'iceberg', does: 'avoid' }, { label: 'fish', does: 'collect' }], setting: 'frozen iceberg field', palette: 'snow', params: null, ...overrides },
});

describe('compact request', () => {
  // P46E T3: řádek novinek AI verze s příkladem na každý hlavní žánr – 12 701 B; strop 12 800 B.
  it('stays under the 12 800 B prompt budget, asks for a live recipe and has its own cache version', () => {
    const request = buildCompactRequest(SENTENCE, draftGameSpecWithMeta(SENTENCE).genre);
    expect(Buffer.byteLength(request.system + request.user, 'utf8')).toBeLessThanOrEqual(12_800);
    expect(request.outputSchema).toBe(GENRE_ANSWER_SCHEMA);
    expect(request.system).toContain('LIVE COMBINATIONS');
    expect(request.system).toContain('unmet');
    expect(request.user).toContain('Starting point (a keyword guess, replace what it got wrong): {"genre":"platformer"');
    expect(COMPACT_PROMPT_VERSION).not.toBe(DIRECTOR_PROMPT_VERSION);
    expect(compactSystemPrompt()).toContain(genrePromptLines());
  });

  it('direct() sends the compact contract, retains named roles and proves the obstacle through a harmful-contact probe', async () => {
    const branch = fakeBranch([answered(answer())]);
    let tick = 0;
    const game = await direct(SENTENCE, { branch, now: () => (tick += 250), compact: true });
    expect(branch.calls[0]?.request.outputSchema).toBe(GENRE_ANSWER_SCHEMA);
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, calls: 1, unmet: [] });
    expect(game.failure).toBeUndefined();
    expect(branch.calls).toHaveLength(1);
    expect(branch.calls[0]?.request.system).toBe(compactSystemPrompt());
    expect(branch.calls[0]?.request.user).toContain('FULL INTENT:');
    expect(game.spec.roles).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'fish', kind: 'collectible' }), expect.objectContaining({ label: 'iceberg', kind: 'hazard' })]));
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
