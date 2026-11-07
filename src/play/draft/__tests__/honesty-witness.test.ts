import { describe, expect, it, vi } from 'vitest';

import { publishReadSpec } from '@/app/api/play/_publish';
import * as arcade from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { nativeSpec } from '@/play/compose/native';
import { draftGameSpecWithMeta } from '@/play/draft';
import { compileGenre } from '@/play/genre';
import { extractIntent } from '@/play/intent/extract';
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

  it('credits a basketball thrown through the hoop, never a kick into a goal or a target the game lacks', async () => {
    await loadRapier();
    // P61: the physics hoop game really throws into the hoop; the banner „Throwing isn't here yet“ lied.
    const sentence = 'throw a basketball into a hoop from crazy angles';
    const hoop = draftGameSpecWithMeta(sentence, 1).spec;
    expect(hoop.controlParams).toMatchObject({ goal: 'hoop' });
    expect(await honestyForSpec(sentence, hoop, 1)).toBeNull();
    // The same hoop game has no window to throw at.
    expect(await honestyForSpec('throw a basketball at a window', hoop, 1)).toMatchObject({
      kind: 'actions', unmet: [{ actor: 'hero', verb: 'throw', object: 'window' }],
    });
    // A football scored in a goal is kicked, not thrown – the banner stays.
    const goal = nativeSpec({ move: 'ball', objective: 'score', actions: [], threats: [] }, {
      genre: 'throw', mode: 'default', hero: 'hero', setting: 'stadium',
      cast: [{ label: 'football', does: 'scenery' }, { label: 'goal', does: 'throw_at' }],
    });
    expect(await honestyForSpec('throw a football into a goal', goal, 1)).toMatchObject({
      kind: 'actions', unmet: [{ actor: 'hero', verb: 'throw', object: 'goal' }], reason: "Throwing isn't here yet – here's a ball game.",
    });
  }, 120000);

  it('agrees the banner verb in number with what is missing', async () => {
    // P61 s002 showed „The obstacles isn't here yet“: a threat label is plural even alone.
    expect((await honestyForSpec('a robot runs and dodges ghosts', running(), 7))?.reason).toBe("The obstacles aren't here yet – here's an endless runner.");
    expect((await honestyForSpec(SENTENCE, running(), 7))?.reason).toBe("Shooting isn't here yet – here's an endless runner.");
    expect((await honestyForSpec('a robot runs and shoots zombies and knits a scarf', running(), 7))?.reason).toBe("Shooting and knitting aren't here yet – here's an endless runner.");
  });
});

/** P73A T5: náhrada místa nebo postavy vypadá na snímku hratelně – oko ji nehlídá, proto pin nad větami soupeřů. */
describe('P73A every substitution is said out loud', () => {
  const said = async (sentence: string) => {
    await loadRapier();
    return (await honestyForSpec(sentence, draftGameSpecWithMeta(sentence, 1).spec, 1))?.reason ?? null;
  };

  it.each([
    ['A haunted library where books fly at you and you must find the exit', "The library isn't here yet – it's a spooky forest."],
    ['A cat delivering pizzas across rooftops while avoiding seagulls', "The rooftops aren't here yet – it's a city."],
    ['a wombat races a narwhal', "The wombat isn't here yet – it's a car."],
    ['shoot the wombats in space', "The wombats aren't here yet – they're robots."],
  ])('%s admits the stand-in', async (sentence, line) => {
    expect(await said(sentence)).toContain(line);
  }, 120_000);

  it('a sentence without a verb admits the stand-in before its hint', async () => {
    expect(await said('a wombat runs through the city')).toMatch(/^The wombat isn't here yet – it's an explorer\. No game verb found/);
  }, 120_000);

  it.each(['An underwater race between a turtle and a shark', 'Escape a volcano before the lava reaches you', 'escape a dungeon full of skeletons'])(
    '%s substitutes nothing and says nothing',
    async (sentence) => {
      expect(await said(sentence)).toBeNull();
    },
    120_000,
  );

  // R1 (oracle T7): přiznání slovesa, které si odporuje s hrou, čte se jako pravda – oko ho nehlídá.
  it.each(['stack pancakes as high as you can in the wind', 'jump as high as you can on the clouds', 'run as fast as you can through the forest'])(
    '%s reads no preposition as a verb',
    async (sentence) => {
      expect(extractIntent(sentence).items.map((item) => item.said)).not.toContain(sentence.match(/you can (\w+)/)![1]);
      expect(await said(sentence) ?? '').not.toMatch(/\b(?:inning|oning|throughing)\b/i);
    },
    120_000,
  );

  // R2: stohovací hra věž staví – z položených dílů i jako „into a tower“; vítr v ní opravdu není.
  it.each([
    ['stack pancakes as high as you can in the wind', "The hazards aren't here yet – here's a timing game."],
    ['stack books into a tower', null],
  ])('%s admits no building in a game that builds the tower', async (sentence, line) => {
    expect(await said(sentence)).toBe(line);
  }, 120_000);

  it.each(['A haunted library where books fly at you and you must find the exit', 'escape a haunted library while books fly at you'])(
    '%s admits the missing flyers, not the flight the hero plays',
    async (sentence) => {
      const line = await said(sentence);
      expect(line).toMatch(/^The flying books aren't here yet – here's /);
      expect(line).not.toMatch(/Gliding/);
    },
    120_000,
  );
});
