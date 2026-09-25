/**
 * Kompaktní první odpověď režiséra (P27D T2). Kompozice nesmí vymyslet nic,
 * co model neřekl, ani pustit nic, co hra neukáže: doplněk mimo tabulku
 * schopností a neznámá role se zahodí, neznámé ovládání je `MALFORMED`.
 */

import { describe, expect, it } from 'vitest';

import { answered, fakeBranch } from '../director/__fixtures__/branch';
import { COMPACT_ANSWER_SCHEMA, COMPACT_PROMPT_VERSION, buildCompactRequest, compactSystemPrompt, composeCompact } from '../director/compact';
import { direct } from '../director/index';
import { DIRECTOR_PROMPT_VERSION } from '../director/prompt';
import { draftGameSpec } from '../draft';

const SENTENCE = 'a penguin jumps over icebergs and shoots snowballs';

const answer = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  plan: 'platformer on ice',
  control: 'platform',
  addons: ['shoot'],
  look: 'snow',
  setting: 'frozen iceberg field',
  title: 'Penguin Iceberg Jump',
  labels: [
    { role: 'player', label: 'penguin' },
    { role: 'coin', label: 'fish' },
  ],
  goal: 'Hop the icebergs to the igloo.',
  ...overrides,
});

describe('composeCompact', () => {
  it('builds a playable spec on the chosen control with the named labels', () => {
    const read = composeCompact(SENTENCE, answer());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.spec.control).toBe('platform');
    expect(read.spec.addons).toEqual(['shoot']);
    expect(read.spec.theme).toMatchObject({ setting: 'frozen iceberg field', look: 'snow' });
    expect(read.spec.roles.find((role) => role.id === 'player')?.label).toBe('penguin');
    expect(read.spec.roles.find((role) => role.id === 'coin')?.label).toBe('fish');
    expect(read.spec.tutorial.goalLine).toBe('Hop the icebergs to the igloo.');
  });

  it('drops an addon the control does not take and a role the template does not have', () => {
    const read = composeCompact(SENTENCE, answer({ control: 'duel', addons: ['shoot', 'collect'], labels: [{ role: 'dragon', label: 'dragon' }, { role: 'rival', label: 'walrus' }] }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.spec.control).toBe('duel');
    expect(read.spec.addons).toBeUndefined();
    expect(read.spec.roles.map((role) => role.label)).not.toContain('dragon');
    expect(read.spec.roles.find((role) => role.id === 'rival')?.label).toBe('walrus');
  });

  it('refuses an unknown control and a non-object', () => {
    expect(composeCompact(SENTENCE, answer({ control: 'golf' }))).toMatchObject({ ok: false, reason: 'MALFORMED_SPEC' });
    expect(composeCompact(SENTENCE, 'platform')).toMatchObject({ ok: false, reason: 'NOT_AN_OBJECT' });
  });

  it('composes the grid when the model picks tap_go', () => {
    const read = composeCompact('find the key and open the door', answer({ control: 'tap_go', addons: [], look: null, labels: [{ role: 'player', label: 'janitor' }] }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.spec.control).toBeUndefined();
    expect(read.spec.roles.find((role) => role.id === 'player')?.label).toBe('janitor');
  });
});

describe('compact request', () => {
  it('stays under the 12 700 B prompt budget and has its own cache version', () => {
    const request = buildCompactRequest(SENTENCE, draftGameSpec(SENTENCE));
    expect(Buffer.byteLength(request.system + request.user, 'utf8')).toBeLessThanOrEqual(12_700);
    expect(request.outputSchema).toBe(COMPACT_ANSWER_SCHEMA);
    expect(COMPACT_PROMPT_VERSION).not.toBe(DIRECTOR_PROMPT_VERSION);
    expect(compactSystemPrompt()).toContain('"duel"');
  });

  it('direct() in compact mode sends the compact request and authors the composed spec', async () => {
    const branch = fakeBranch([answered(answer())]);
    let tick = 0;
    const game = await direct(SENTENCE, { branch, now: () => (tick += 250), compact: true });
    expect(branch.calls[0]?.request.outputSchema).toBe(COMPACT_ANSWER_SCHEMA);
    expect(game).toMatchObject({ source: 'authored', fallbackReason: null, calls: 1 });
    expect(game.spec.control).toBe('platform');
  });

  it('direct() in compact mode falls back to the draft on an unreadable answer', async () => {
    const branch = fakeBranch([answered(answer({ control: 'golf' }))]);
    let tick = 0;
    const game = await direct(SENTENCE, { branch, now: () => (tick += 250), compact: true });
    expect(game).toMatchObject({ source: 'draft', fallbackReason: 'MALFORMED' });
  });
});
