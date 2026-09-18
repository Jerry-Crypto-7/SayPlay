import { afterEach, describe, expect, it } from 'vitest';
import { clearSessions, peekChange, putChange } from '@/worldstream/sessions';
import { resetRateWindows } from '@/server/rate-limit';
import { resetConcurrency } from '../sessions/route';
import { createChange } from '../sessions/[sessionId]/changes/route';
import { POST as commit } from '../sessions/[sessionId]/changes/[changeId]/commit/route';
import { generated } from './world-fixture';

afterEach(() => { clearSessions(); resetRateWindows(); resetConcurrency(); });
const appearance = [{ op: 'replace' as const, path: '/look/palette', value: 'sand' }];
describe('public renderer appearance capability', () => {
  it('refuses invisible appearance preview before storing a change', async () => {
    const stored = await generated();
    const before = stored.blueprint;
    const response = await createChange(new Request('http://localhost/changes', {
      method: 'POST', body: JSON.stringify({ prompt: 'make the mast warmer', stableId: 'ironMast' }),
    }), stored.session.sessionId, async () => ({ summary: 'warmer mast', shape: null, behavior: [], appearance }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'APPEARANCE_UNSUPPORTED',
      message: expect.stringContaining('not supported in this renderer') } });
    expect(stored.blueprint).toBe(before);
  });
  it.each(['appearance', 'mixed', 'mislabelled'] as const)('refuses stored appearance atomically: %s', async mode => {
    const stored = await generated();
    const before = stored.blueprint!;
    const revision = stored.session.revisionOf('ironMast')!;
    putChange(stored, { changeId: 'legacy-look', plan: { stableId: 'ironMast', summary: 'warmer mast', shape: null, addition: null,
      appearance: mode === 'mislabelled' ? [] : appearance,
      behavior: mode === 'mixed' ? [{ op: 'replace', path: '/sim/entities', value: {} }] : mode === 'mislabelled' ? appearance : [] },
      basedOn: { representation: revision, sim: before.world.simRevision, look: before.world.lookRevision } });
    for (let retry = 0; retry < 2; retry++) {
      const response = await commit(new Request('http://localhost/commit', { method: 'POST' }), {
        params: Promise.resolve({ sessionId: stored.session.sessionId, changeId: 'legacy-look' }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: 'APPEARANCE_UNSUPPORTED' } });
      expect(stored.blueprint).toBe(before);
      expect(stored.session.revisionOf('ironMast')).toBe(revision);
      expect(peekChange(stored, 'legacy-look')).not.toBeNull();
    }
  });
});
