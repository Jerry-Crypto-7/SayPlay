/**
 * Neznámé sloveso přes tabulku P44C (T7). Namapované sloveso bez značky `mapped` by vypadalo
 * jako přesná shoda a hra by přestala přiznávat přiblížení – proto test pinuje značku i osu.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { essentialTriples, type Intent } from '../contract';
import { extractIntent } from '../extract';

afterEach(() => vi.unstubAllEnvs());

describe('unknown verbs through the vocab table', () => {
  it('lands a mapped verb on its axis with the canonical verb, the said word and a mapped mark', () => {
    const intent = extractIntent('a knight stabs the goblins');
    expect(intent.items).toContainEqual({ actor: 'knight', verb: 'fight', object: 'goblin', axis: 'action', essential: true, said: 'stabs', mapped: true });
    expect(intent.items.some((item) => item.axis === 'unknown')).toBe(false);
    expect(essentialTriples(intent)).toContainEqual({ actor: 'knight', verb: 'fight', object: 'goblin' });
  });

  it('reads a gerund game the same way', () => {
    const intent = extractIntent('a stabbing game');
    expect(intent.items).toContainEqual(expect.objectContaining({ axis: 'action', verb: 'fight', said: 'stabbing', mapped: true }));
  });

  it('reads a gerund that dropped its e from the said word, not the stem', () => {
    // gerundBase dá „straf“ – tabulka zná jen „strafe“; vyhledání tvaru umí -ing samo.
    const intent = extractIntent('a strafing game');
    expect(intent.items).toContainEqual(expect.objectContaining({ axis: 'action', verb: 'fight', said: 'strafing', mapped: true }));
  });

  it('leaves a verb that is no game action unknown', () => {
    const intent = extractIntent('explain how volcanoes erupt');
    expect(intent.items.some((item) => item.mapped === true)).toBe(false);
  });

  it('keeps hand-table verbs unmarked', () => {
    const intent = extractIntent('a knight fights the goblins');
    expect(intent.items).toContainEqual({ actor: 'knight', verb: 'fight', object: 'goblin', axis: 'action', essential: true, said: 'fights' });
  });

  it('leaves a verb of a hand-written family to the family', () => {
    const intent = extractIntent('a cowboy lassos wild chickens on a dusty ranch');
    expect(intent.items).toContainEqual(expect.objectContaining({ axis: 'unknown', verb: 'lasso' }));
  });

  it('drops a mapped verb under negation', () => {
    // „without stabbing anyone“ detektor neznámých sloves jako sloveso vůbec nečte (T13 rozpad nepoznané / nenamapované).
    const intent = extractIntent('a fox sprints and never stabs the goblins');
    expect(intent.items.some((item) => item.verb === 'fight')).toBe(false);
    expect(intent.negated).toContain('fight');
  });

  it('gives the pre-P44C intent byte for byte with PLAY_VOCAB=off on every baseline sentence', () => {
    vi.stubEnv('PLAY_VOCAB', 'off');
    const baseline = JSON.parse(readFileSync('evals/play/p44c/baseline.json', 'utf8')) as {
      sets: Record<string, readonly { sentence: string; intent: Intent }[]>;
    };
    const rows = Object.values(baseline.sets).flat();
    expect(rows.length).toBeGreaterThan(200);
    for (const row of rows) expect(JSON.stringify(extractIntent(row.sentence)), row.sentence).toBe(JSON.stringify(row.intent));
  });
});
