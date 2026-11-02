import { beforeEach, describe, expect, it, vi } from 'vitest';
import { driveSpec } from '@/play/compose/drive';
import { actionEvidence, lostActions } from '@/play/fidelity/action-evidence';
import { extractIntent } from '@/play/intent/extract';
import type { GameSpecV1 } from '@/play/spec';
import { memoryVersionStore, type PublishedGame, type VersionStore } from '@/play/version';
import { publishReadSpec } from '../_publish';
import { __resetUpgrades, upgradeOf, type UpgradeRequest } from '../_upgrade';

// Only the external director result is controlled; publication, witnesses,
// the persisted worlds and the upgrade gate all run their real implementations.
const director = vi.hoisted(() => ({ candidate: null as GameSpecV1 | null, calls: 0 }));
vi.mock('../_director', async original => ({
  ...await original<typeof import('../_director')>(),
  getDirector: () => async () => { director.calls++; return { spec: director.candidate!, source: 'model' }; },
}));

const sentence = 'A car drives, races and shoots zombies.';
const request = (): UpgradeRequest => ({ sentence, seed: 1, ackMs: null, draftReadyMs: null, startedAt: Date.now(), caller: 'upgrade-action-test' });
const spec = (race: boolean, shoot: boolean) => driveSpec(
  { move: 'drive', objective: race ? 'race' : 'reach', actions: shoot ? ['shoot'] : [], threats: race ? ['rival'] : [] },
  { genre: 'voyage', mode: 'race', hero: 'car', setting: 'city', cast: [{ label: 'zombie', does: 'shoot_at' }] },
);
async function save(store: VersionStore, game: GameSpecV1, parent: PublishedGame | null = null) {
  const published = await publishReadSpec(store, game, [1], parent?.version.versionId ?? null,
    parent === null ? { origin: { sentence, seed: 1 } } : { relation: 'upgrade' });
  if (!published.ok) throw new Error(`Fixture failed real publication: ${JSON.stringify(published.issues)}`);
  const saved = await store.get(published.value.game.version.versionId);
  expect(saved).not.toBeNull();
  return saved!;
}
beforeEach(() => { __resetUpgrades(); director.calls = 0; director.candidate = null; });

describe('upgrade preserves played actions from the stored quick version', () => {
  it('rejects a winning same-car candidate that loses race and shoot, and remembers ACTION_LOST', async () => {
    const store = memoryVersionStore(), quick = await save(store, spec(true, true));
    director.candidate = spec(false, false);
    const before = await actionEvidence(quick.spec, quick.version.seed, quick.arcade);
    const after = await actionEvidence(director.candidate, 1);
    expect(lostActions(extractIntent(sentence), before, after).map(action => action.verb)).toEqual(expect.arrayContaining(['race', 'shoot']));
    expect(await upgradeOf(store, quick, request())).toEqual({ status: 'draft-final', reason: 'ACTION_LOST' });
    expect(await store.childrenOf(quick.version.versionId)).toEqual([]);
    expect(await store.upgradeVerdict(quick.version.versionId)).toBe('ACTION_LOST');
    __resetUpgrades();
    expect(await upgradeOf(store, quick, request())).toEqual({ status: 'draft-final', reason: 'ACTION_LOST' });
    expect(director.calls).toBe(1);
  });

  it('does not return a cached child that lost actions after process memory is reset', async () => {
    const store = memoryVersionStore(), quick = await save(store, spec(true, true));
    const cached = await save(store, spec(false, false), quick);
    director.candidate = cached.spec;
    __resetUpgrades();
    expect(await upgradeOf(store, quick, request())).toEqual({ status: 'draft-final', reason: 'ACTION_LOST' });
    expect(director.calls).toBe(1);
    expect(await store.get(cached.version.versionId)).not.toBeNull();
  });

  it('publishes a candidate that preserves drive and race and adds real shooting', async () => {
    const store = memoryVersionStore(), quick = await save(store, spec(true, false));
    director.candidate = spec(true, true);
    const result = await upgradeOf(store, quick, request());
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    const child = (await store.get(result.versionId))!;
    expect(child.relation).toBe('upgrade');
    expect(child.version.parentId).toBe(quick.version.versionId);
    expect(await actionEvidence(child.spec, child.version.seed, child.arcade)).toContainEqual(expect.objectContaining({ verb: 'shoot', evidence: 'projectile-hit' }));
  });

  it('reuses a cached preserving upgrade without another director call', async () => {
    const store = memoryVersionStore(), quick = await save(store, spec(true, false));
    const cached = await save(store, spec(true, true), quick);
    __resetUpgrades();
    expect(await upgradeOf(store, quick, request())).toEqual({ status: 'ready', versionId: cached.version.versionId });
    expect(director.calls).toBe(0);
  });

  // P68 R8: AI verze stavěná na hře ze čtení drží akce té hry, akci rychlé hry ztratit smí. Hledání v úložišti ji dřív
  // měřilo jen rychlou hrou, odmítlo ji a po restartu procesu zaplatilo režiséra znovu.
  it('reuses a cached upgrade that keeps the stored reading game actions though it loses the quick ones', async () => {
    const store = memoryVersionStore(), quick = await save(store, spec(true, true));
    const read = await publishReadSpec(store, spec(false, false), [1], quick.version.versionId, { relation: 'reading', origin: { sentence, seed: 1, readBy: 'model' } });
    if (!read.ok) throw new Error(`Reading fixture failed real publication: ${JSON.stringify(read.issues)}`);
    const cached = await save(store, { ...spec(false, false), title: 'Zombie Errand' }, quick);
    expect(lostActions(extractIntent(sentence), await actionEvidence(quick.spec, quick.version.seed, quick.arcade), await actionEvidence(cached.spec, cached.version.seed, cached.arcade))).not.toEqual([]);
    director.candidate = spec(false, false);
    __resetUpgrades();
    expect(await upgradeOf(store, quick, request())).toEqual({ status: 'ready', versionId: cached.version.versionId });
    expect(director.calls).toBe(0);
  });
});
