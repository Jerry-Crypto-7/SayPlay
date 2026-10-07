import { describe, expect, it, vi } from 'vitest';

import { publishReadSpec } from '@/app/api/play/_publish';
import * as arcade from '@/play/arcade/compile';
import { compileGenre } from '@/play/genre';
import { memoryVersionStore } from '@/play/version';

import { honestyForSpec, honestyOf } from '../unsupported';

const SENTENCE = 'a robot runs and shoots zombies';
const running = () => compileGenre({ genre: 'runner', mode: 'default', hero: 'robot', setting: 'forest' });
const shooting = () => compileGenre({ genre: 'runner', mode: 'default', hero: 'robot', setting: 'forest', cast: [{ label: 'zombie', does: 'shoot_at' }] });

describe('P41 honesty follows witnesses of the final game', () => {
  it('lists every unsupported essential action while retaining witnessed movement', async () => {
    const honesty = await honestyForSpec('a robot runs and shoots zombies and knits a scarf', running(), 7);
    expect(honesty).toMatchObject({
      kind: 'actions',
      unmet: [
        { actor: 'robot', verb: 'shoot', object: 'zombie' },
        { actor: 'robot', verb: 'knit', object: 'scarf' },
      ],
    });
    expect(honesty!.unmet).toHaveLength(2);
  });

  it('requires the actual target identity, not only a shooting mechanic', async () => {
    const spec = shooting();
    expect(await honestyForSpec(SENTENCE, spec, 7)).toBeNull();
    const changed = { ...spec, roles: spec.roles.map(role => role.label === 'zombie' ? { ...role, label: 'skeleton' } : role) };
    expect(await honestyForSpec(SENTENCE, changed, 7)).toMatchObject({
      kind: 'actions',
      unmet: [{ actor: 'robot', verb: 'shoot', object: 'zombie' }],
    });
  });

  it('an authored final spec clears its parent admission only after providing the action', async () => {
    const store = memoryVersionStore();
    const parent = await publishReadSpec(store, running(), [7], null, { origin: { sentence: SENTENCE, seed: 12345 } });
    if (!parent.ok) throw new Error('parent fixture did not publish');
    expect(await honestyOf(store, parent.value.game)).toMatchObject({
      unmet: [{ actor: 'robot', verb: 'shoot', object: 'zombie' }],
    });
    const child = await publishReadSpec(store, shooting(), [7], parent.value.game.version.versionId, { relation: 'upgrade' });
    if (!child.ok) throw new Error('child fixture did not publish');
    expect(child.value.game.origin).toBeUndefined();
    expect(await honestyOf(store, child.value.game)).toBeNull();
    // Reading the child cannot mutate or retroactively bless its parent's game.
    expect(await honestyOf(store, parent.value.game)).toMatchObject({
      unmet: [{ actor: 'robot', verb: 'shoot', object: 'zombie' }],
    });
  });

  it('uses the published seed and spec instead of the requested seed or a fresh draft', async () => {
    const store = memoryVersionStore();
    const published = await publishReadSpec(store, shooting(), [19], null, { origin: { sentence: SENTENCE, seed: 12345 } });
    if (!published.ok) throw new Error('fixture did not publish');
    const compile = vi.spyOn(arcade, 'arcadeWorldOf');
    try {
      expect(await honestyOf(store, published.value.game)).toBeNull();
      expect(compile).not.toHaveBeenCalled();
      // Older records without a serialized arcade world still use the sealed
      // version seed, never the caller's requested seed in origin.
      const { arcade: _storedWorld, ...withoutWorld } = published.value.game;
      expect(await honestyOf(store, withoutWorld)).toBeNull();
      expect(compile).toHaveBeenCalledWith(published.value.game.spec, published.value.game.version.seed);
      expect(compile.mock.calls.every(([, seed]) => seed === 19)).toBe(true);
    } finally {
      compile.mockRestore();
    }
  });

  it('plays the serialized world of a historical publication before trusting new compiler capabilities', async () => {
    const store = memoryVersionStore();
    const old = await publishReadSpec(store, running(), [7], null);
    const current = await publishReadSpec(store, shooting(), [7], null, { origin: { sentence: SENTENCE, seed: 7 } });
    if (!old.ok || !current.ok || old.value.game.arcade === undefined) throw new Error('fixtures did not publish');
    // A historical compiler omitted shooting even though its stored spec asked
    // for it. Recompiling with today's compiler would hide that omission.
    const historical = { ...current.value.game, arcade: old.value.game.arcade };
    expect(await honestyOf(store, historical)).toMatchObject({
      unmet: [{ actor: 'robot', verb: 'shoot', object: 'zombie' }],
    });
    expect(await honestyOf(store, current.value.game)).toBeNull();
  });
});
