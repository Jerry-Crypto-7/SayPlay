import { afterEach, describe, expect, it } from 'vitest';
import { clearSessions, peekChange, putChange } from '@/worldstream/sessions';
import { resetRateWindows } from '@/server/rate-limit';
import { resetConcurrency } from '../sessions/route';
import { createChange } from '../sessions/[sessionId]/changes/route';
import { POST as commit } from '../sessions/[sessionId]/changes/[changeId]/commit/route';
import { generated } from './world-fixture';

afterEach(() => { clearSessions(); resetRateWindows(); resetConcurrency(); });
const motion = { op: 'add' as const, path: '/sim/entities/mastBase/motion', value: { kind: 'sway', amplitude: 0.1 } };
const request = () => new Request('http://localhost/changes', { method: 'POST',
  body: JSON.stringify({ prompt: 'make the mast taller and sway', stableId: 'ironMast' }) });

describe('public runtime motion capability', () => {
  it('offers only shape with an explicit limitation and commits exactly that reviewed scope', async () => {
    const stored = await generated();
    const before = structuredClone(stored.blueprint!);
    const response = await createChange(request(), stored.session.sessionId, async () => ({
      summary: 'The mast gets taller and sways.', shape: before.shapes[0],
      behavior: [motion, { op: 'add', path: '/sim/entities/mastBase/extra', value: true }], appearance: [],
    }));
    const preview = await response.json();
    expect(response.status).toBe(200);
    expect(preview.scope).toEqual({ shape: true, behavior: 0, appearance: 0 });
    expect(preview.summary).toContain('Only the shape');
    expect(preview.summary).toContain('not supported');
    expect(preview.summary).toContain('Behavior stays unchanged');
    expect(stored.blueprint).toEqual(before);
    expect(peekChange(stored, preview.changeId)!.plan.behavior).toEqual([]);
    const accepted = await commit(new Request('http://localhost/commit', { method: 'POST' }), {
      params: Promise.resolve({ sessionId: stored.session.sessionId, changeId: preview.changeId }),
    });
    expect(await accepted.json()).toMatchObject({ outcome: 'COMMITTED', summary: preview.summary });
    expect(stored.blueprint!.world).toEqual(before.world);
  });

  it('refuses motion alone without storing a misleading preview', async () => {
    const stored = await generated();
    const before = stored.blueprint;
    const response = await createChange(request(), stored.session.sessionId, async () => ({
      summary: 'The mast sways.', shape: null, behavior: [motion], appearance: [],
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'MOTION_UNSUPPORTED' } });
    expect(stored.blueprint).toBe(before);
    expect(stored.changes.size).toBe(0);
  });

  it.each(['direct', 'staged', 'array'] as const)('refuses stored mixed motion without changing accepted scope: %s', async mode => {
    const stored = await generated();
    const before = structuredClone(stored.blueprint!);
    const revision = stored.session.revisionOf('ironMast')!;
    const entity = { type: 'actor', motion: motion.value };
    const behavior = mode === 'direct' ? [motion] : [
      { op: 'add' as const, path: '/sim/entities/mastBase/staged', value: mode === 'array' ? [entity] : entity },
      { op: 'copy' as const, from: `/sim/entities/mastBase/staged${mode === 'array' ? '/0' : ''}`, path: '/sim/entities/mastBase' },
    ];
    putChange(stored, { changeId: 'old-motion', plan: { stableId: 'ironMast', summary: 'taller and swaying',
      shape: before.shapes[0], behavior, appearance: [] },
      basedOn: { representation: revision, sim: before.world.simRevision, look: before.world.lookRevision } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await commit(new Request('http://localhost/commit', { method: 'POST' }), {
        params: Promise.resolve({ sessionId: stored.session.sessionId, changeId: 'old-motion' }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: 'MOTION_UNSUPPORTED' } });
      expect(stored.blueprint).toEqual(before);
      expect(stored.session.revisionOf('ironMast')).toBe(revision);
      expect(peekChange(stored, 'old-motion')).not.toBeNull();
    }
  });
});
