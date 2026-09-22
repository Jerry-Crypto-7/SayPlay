/**
 * Hra od modelu, která neprojde kontrolou, spadne na návrh ze slov (nález
 * revize T1): hráč za placenou vadu nedostane 422, když návrh sám projde.
 * Režisér je podvržený – vrací `authored` spec, jehož keypoint neprojde.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import switchPuzzle from '@/play/__fixtures__/switch_puzzle.json';
import { draftGameSpec } from '@/play/draft';
import { readGameSpec } from '@/play/spec';
import { __resetProcessVersionStore } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

const SENTENCE = 'Collect five glowing mushrooms then open a portal.';

vi.mock('../_director', () => ({
  getDirector: () => async () => {
    const broken = structuredClone(switchPuzzle) as { mechanics: { id: string; params: Record<string, unknown> }[] };
    broken.mechanics.find((mechanic) => mechanic.id === 'switch')!.params.required = ['red', 'blue', 'green'];
    const read = readGameSpec(broken);
    if (!read.ok) throw new Error('fixture');
    return { ok: true, spec: read.value, source: 'authored', repairRounds: 0, fallbackReason: null, warnings: [], ms: 1, calls: 1 };
  },
}));

const { POST: createGame } = await import('../games/route');
const { GET: readGame } = await import('../games/[id]/route');

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
});

describe('autorská hra, která neprošla', () => {
  it('publikuje se návrh ze slov, ne 422', async () => {
    const response = await createGame(
      new Request('http://play.test/api/play/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ sentence: SENTENCE }),
      }),
    );
    expect(response.status).toBe(201);
    const { versionId } = await response.json();
    const game = await (await readGame(new Request(`http://play.test/api/play/games/${versionId}`), { params: Promise.resolve({ id: versionId }) })).json();
    expect(game.spec).toEqual(draftGameSpec(SENTENCE));
  });
});
