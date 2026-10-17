/**
 * Hra režiséra, kterou kontrola odmítla (P46E T6, demo 15. 10.): běžec ani auto nehrají honičku, zóny a zdraví,
 * které režisér vybral, a AI verze dřív skončila `UNREPAIRED`, ač boss a vzhled odpovědi se na rychlou hru
 * složit dají. Nahrávky jsou odmítnuté specy z dema (`__fixtures__/p46-live-rejected`); dvojník je jen režisér.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DirectedGame, DirectorFailure } from '@/play/director';
import { draftGameSpecWithMeta } from '@/play/draft';
import { memoryVersionStore } from '@/play/version';

import { derivedSeeds, publishReadSpec, seedFrom } from '../_publish';
import { directUpgrade } from '../_upgrade';

interface RejectedFixture {
  readonly sentence: string;
  readonly failure: DirectorFailure;
}

const fixture = (id: string): RejectedFixture =>
  JSON.parse(readFileSync(join(process.cwd(), 'src/play/director/__fixtures__/p46-live-rejected', `${id}.json`), 'utf8')) as RejectedFixture;

async function upgrade(sentence: string, failure: DirectorFailure) {
  const store = memoryVersionStore();
  const quick = await publishReadSpec(store, draftGameSpecWithMeta(sentence, 1).spec, derivedSeeds(seedFrom(sentence)), null, { origin: { sentence, seed: null } });
  if (!quick.ok) throw new Error(`quick version did not publish: ${JSON.stringify(quick.issues)}`);
  const draft = quick.value.game;
  // Návrat režiséra na návrh, jak ho vrátí `direct()` po neprošlé kontrole.
  const rejected = { ok: true, spec: draft.spec, source: 'draft', repairRounds: 0, fallbackReason: failure.reason, failure, warnings: [], ms: 0, calls: 1 } as unknown as DirectedGame;
  const outcome = await directUpgrade(store, draft, { sentence, seed: null, ackMs: null, draftReadyMs: null, startedAt: Date.now(), caller: 'upgrade-rejected-test' }, () => async () => ({ ...rejected, callerLimited: false }));
  const child = outcome.status === 'ready' ? await store.get(outcome.versionId) : null;
  return { draft, outcome, child };
}

describe('a director game the checks rejected still upgrades on the quick game (P46E T6)', () => {
  it.each([['o01', true], ['o04', true], ['o05', true], ['n02', false]] as const)('%s keeps the quick genre (director boss: %s)', async (id, boss) => {
    const { sentence, failure } = fixture(id);
    const { draft, outcome, child } = await upgrade(sentence, failure);
    expect(outcome.status).toBe('ready');
    expect(child!.spec.control).toBe(draft.spec.control);
    expect(child!.spec.mechanics).toEqual(draft.spec.mechanics);
    expect(child!.spec.rules?.length ?? 0).toBeGreaterThanOrEqual(draft.spec.rules?.length ?? 0);
    if (!boss) return;
    expect(outcome).toMatchObject({ adds: expect.arrayContaining(['boss']) });
    expect(child!.spec.boss?.name).toBe((failure.raw as { boss: { name: string } }).boss.name);
  }, 180_000);

  it('stays draft-final with the director reason when the rejected answer is not a game', async () => {
    const { sentence, failure } = fixture('o01');
    const { outcome } = await upgrade(sentence, { ...failure, raw: { not: 'a game' } });
    expect(outcome).toEqual({ status: 'draft-final', reason: 'UNREPAIRED' });
  }, 180_000);
});
