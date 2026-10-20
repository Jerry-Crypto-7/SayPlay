/**
 * Worker náhledu (P54A T4): pro hru bez uloženého `preview` spočte týž
 * náhled, jaký by uložila publikace – stejný hash v `endTick`.
 */

import { describe, expect, it } from 'vitest';

import flapFixture from '@/play/arcade/__fixtures__/flap.json';
import runnerFixture from '@/play/arcade/__fixtures__/runner.json';
import throwFixture from '@/play/arcade/__fixtures__/throw.json';
import { compileArcade, preloadPhysics } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { readGameSpec } from '@/play/spec';
import { previewFor, reportFor } from '@/app/api/play/_report';

import { handleBotJob, previewForWorld } from '../bot-worker';

describe.each([
  ['runner', runnerFixture],
  ['flap', flapFixture],
  ['throw', throwFixture],
])('bot worker (%s)', (_name, raw) => {
  it('computes the same preview the publish check stores', async () => {
    const spec = readGameSpec(raw);
    if (!spec.ok) throw new Error(spec.issues.join('; '));
    await preloadPhysics(spec.value, loadRapier);
    const compiled = [1, 2, 3, 4].map((seed) => compileArcade(spec.value, seed)).find((result) => result.ok);
    if (compiled === undefined || !compiled.ok || compiled.value.arcade === undefined) throw new Error('does not compile');
    expect(reportFor(compiled.value).publishEligible).toBe(true);
    const stored = previewFor(compiled.value);
    expect(stored).not.toBeNull();
    // Svět z úložiště je JSON: worker dostane kopii, ne objekt, ke kterému si kompilace pamatuje běh robota.
    const world = JSON.parse(JSON.stringify(compiled.value.arcade));
    expect(await previewForWorld(world)).toEqual(stored);
    expect(await handleBotJob({ versionId: 'v1', world })).toEqual({ versionId: 'v1', preview: stored });
  });
});

it('reports a broken world as an error instead of throwing', async () => {
  const response = await handleBotJob({ versionId: 'v2', world: { bot: { id: 'nobody', params: {} } } as never });
  expect(response).toMatchObject({ versionId: 'v2', error: expect.any(String) });
});
