/**
 * Remix (P23-B T8). Reskin, který sáhne na mechaniku, vypadá stejně jako
 * reskin – proto se drží bajtová shoda `mechanics`/`objective`/`verification`;
 * `harder` drží „právě jeden parametr mechaniky", `remixPatch` stejný seed →
 * stejné operace.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ARCHETYPE_IDS, type ArchetypeId } from '../registry';
import { REMIX_CHIPS, REMIX_CHIP_LABELS, applyRemix, buildRemixRequest, chipOf, classifyRemix, remixPatch } from '../director/remix';
import { blockingIssues, critique } from '../director/critic';
import { draftGameSpec, draftGenreFor } from '../draft';
import { compileGenre } from '../genre';
import { classifyGenre } from '../genre/classify';
import { readGameSpec, type GameSpecV1 } from '../spec';

const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const COPY = readFileSync(fileURLToPath(new URL('../../../docs/play/pack/PRODUCT_COPY.md', import.meta.url)), 'utf8');

function base(id: ArchetypeId): GameSpecV1 {
  const result = readGameSpec(JSON.parse(readFileSync(`${FIXTURES}${id}.json`, 'utf8')));
  if (!result.ok) throw new Error(`${id}: ${result.reason}`);
  return result.value;
}

/** Listy parametrů mechanik jako `/mechanics/i/params/...: hodnota`. */
function paramLeaves(spec: GameSpecV1): Map<string, string> {
  const leaves = new Map<string, string>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}/${key}`);
    } else {
      leaves.set(path, JSON.stringify(value));
    }
  };
  spec.mechanics.forEach((mechanic, index) => walk(mechanic.params, `/mechanics/${String(index)}/params`));
  return leaves;
}

function changedLeaves(before: GameSpecV1, after: GameSpecV1): string[] {
  const a = paramLeaves(before);
  const b = paramLeaves(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key));
}

describe('remix chips', () => {
  it('labels are the four chips of PRODUCT_COPY.md', () => {
    expect(REMIX_CHIPS).toEqual(['harder', 'twist', 'swap_enemy', 'reskin']);
    expect(COPY).toContain(Object.values(REMIX_CHIP_LABELS).join(' / '));
    expect(chipOf('Add a twist')).toBe('twist');
    expect(chipOf(' REskin ')).toBe('reskin');
    expect(chipOf('make it harder please')).toBeNull();
  });

  it('every chip applies to every archetype fixture (32/32) and leaves no blocking issue', () => {
    let applied = 0;
    for (const id of ARCHETYPE_IDS) {
      for (const chip of REMIX_CHIPS) {
        const result = applyRemix(base(id), remixPatch(chip, base(id), 1));
        expect(result.ok, `${chip} on ${id}: ${result.ok ? '' : result.reason}`).toBe(true);
        if (!result.ok) continue;
        expect(blockingIssues(critique(result.spec)), `${chip} on ${id}`).toEqual([]);
        applied += 1;
      }
    }
    expect(applied).toBe(32);
  });

  it('harder changes exactly one mechanic parameter on every fixture', () => {
    for (const id of ARCHETYPE_IDS) {
      const parent = base(id);
      const result = applyRemix(parent, remixPatch('harder', parent, 1));
      if (!result.ok) throw new Error(id);
      expect(changedLeaves(parent, result.spec), id).toHaveLength(1);
    }
    const chase = applyRemix(base('chase_escape'), remixPatch('harder', base('chase_escape'), 1));
    expect(chase.ok && chase.spec.mechanics[0].params.speed).toBe('fast');
    const survive = applyRemix(base('survival_timer'), remixPatch('harder', base('survival_timer'), 1));
    expect(survive.ok && survive.spec.mechanics[0].params.seconds).toBe(48);
    expect(survive.ok && survive.spec.objective.seconds).toBe(48);
  });

  // P32B T5b: hra žánru nese parametry generátoru režimu – `harder` posune právě jeden a počet, který cíl slibuje, dorovná.
  it('harder on a genre game moves one generator parameter and keeps the promised count in step', () => {
    const own = (spec: GameSpecV1): Record<string, unknown> => {
      const { generator: _generator, tuning, ...rest } = spec.controlParams as Record<string, unknown> & { tuning?: Record<string, unknown> };
      return { ...rest, ...tuning };
    };
    const cases: [string, string, string, unknown][] = [
      ['a cat runs from dogs in a park', 'arena_escape', 'chaserSpeed', 80],
      ['Collect five glowing mushrooms in a moonlit forest', 'arena_collect', 'items', 7],
      ['boxing a kangaroo in the australian outback', 'fight', 'enemyHp', 4],
      ['A pizza delivery scooter races through traffic to deliver before the pizza gets cold', 'quest_spatial', 'rocks', 4],
      ['a chef flips pancakes in a busy kitchen', 'quest_station', 'window', 45],
      // Obtížnost plavby soudí schéma ovládání `steer` – posune se v `controlParams`, ne v `tuning`.
      ['a pirate ship sails the sea', 'voyage_race', 'difficulty', 'hard'],
    ];
      for (const [sentence, generator, key, value] of cases) {
        // Exercise each named legacy generator's remix contract; the new
        // composer may correctly prioritize a different action in this sentence.
        const pick = classifyGenre(sentence, null).ranked[0];
        const parent = compileGenre(draftGenreFor(sentence, pick.genre, pick.mode)!);
      expect(parent.controlParams, sentence).toMatchObject({ generator });
      const result = applyRemix(parent, remixPatch('harder', parent));
      if (!result.ok) throw new Error(`${sentence}: ${result.reason}`);
      const before = own(parent);
      const after = own(result.spec);
      expect(Object.keys(after).filter((name) => after[name] !== before[name]), sentence).toEqual([key]);
      expect(after[key], sentence).toBe(value);
    }
    const mushrooms = compileGenre(draftGenreFor('Collect five glowing mushrooms in a moonlit forest', 'arena', 'collect')!);
    const harder = applyRemix(mushrooms, remixPatch('harder', mushrooms));
    if (!harder.ok) throw new Error(harder.reason);
    expect(harder.spec.roles.find((role) => role.kind === 'collectible')?.count).toBe(7);
    expect(harder.spec.objective).toMatchObject({ count: 7, description: expect.stringMatching(/\b7\b/) });
    expect(harder.spec.tutorial.goalLine).toMatch(/\b7\b/);
    // Na stropu generátoru čip nemá co přitvrdit.
    const top: GameSpecV1 = { ...mushrooms, controlParams: { generator: 'arena_collect', tuning: { items: 30 } } };
    expect(remixPatch('harder', top)).toEqual([]);
  });

  it('reskin leaves mechanics, objective and verification byte-identical and changes theme, title and every label', () => {
    for (const id of ARCHETYPE_IDS) {
      const parent = base(id);
      const result = applyRemix(parent, remixPatch('reskin', parent, 1));
      if (!result.ok) throw new Error(id);
      expect(JSON.stringify(result.spec.mechanics)).toBe(JSON.stringify(parent.mechanics));
      expect(JSON.stringify(result.spec.objective)).toBe(JSON.stringify(parent.objective));
      expect(JSON.stringify(result.spec.verification)).toBe(JSON.stringify(parent.verification));
      expect(result.spec.theme).not.toEqual(parent.theme);
      expect(result.spec.title).not.toBe(parent.title);
      result.spec.roles.forEach((role, index) => expect(role.label).not.toBe(parent.roles[index].label));
    }
  });

  it('twist adds exactly one allowed mechanic with a verification keypoint', () => {
    for (const id of ARCHETYPE_IDS) {
      const parent = base(id);
      const result = applyRemix(parent, remixPatch('twist', parent, 1));
      if (!result.ok) throw new Error(id);
      expect(result.spec.mechanics, id).toHaveLength(parent.mechanics.length + 1);
      const added = result.spec.mechanics[result.spec.mechanics.length - 1];
      expect(parent.mechanics.map((m) => m.id)).not.toContain(added.id);
      expect(result.spec.verification.some((v) => v.mechanic === added.id), `${id}: ${added.id}`).toBe(true);
    }
  });

  // Zdraví přidané k lávě, která rovnou zabíjí, nikdy nevystřelí: keypoint
  // `health_fires` neprošel a čip vracel 422 (odkryto 22. 9. 2026 novým losem).
  it('twist adds health only where something deals damage', () => {
    for (const id of ARCHETYPE_IDS) {
      const parent = base(id);
      for (let seed = 1; seed <= 40; seed += 1) {
        const result = applyRemix(parent, remixPatch('twist', parent, seed));
        if (!result.ok || result.spec.mechanics.length === parent.mechanics.length || result.spec.mechanics.at(-1)?.id !== 'health') continue;
        const damaging = result.spec.mechanics.some((m) => Object.values(m.params as Record<string, unknown>).includes('damage'));
        expect(damaging, `${id} seed ${seed}`).toBe(true);
      }
    }
  });

  it('swap_enemy renames the chaser or patrol, and falls back to harder without an enemy', () => {
    const chase = applyRemix(base('chase_escape'), remixPatch('swap_enemy', base('chase_escape'), 1));
    expect(chase.ok && chase.spec.roles.find((r) => r.kind === 'chaser')?.label).not.toBe('Roomba');
    expect(chase.ok && JSON.stringify(chase.spec.mechanics)).toBe(JSON.stringify(base('chase_escape').mechanics));

    const delivery = applyRemix(base('delivery'), remixPatch('swap_enemy', base('delivery'), 1));
    expect(delivery.ok && delivery.spec.mechanics[1].params.disposition).not.toBe('bold');

    const collect = base('collect_exit');
    expect(remixPatch('swap_enemy', collect, 1)).toEqual(remixPatch('harder', collect, 1));
    const fallen = applyRemix(collect, remixPatch('swap_enemy', collect, 1));
    expect(fallen.ok && fallen.spec.mechanics[0].params.count).toBe(7);
    expect(fallen.ok && fallen.spec.objective.count).toBe(7);
  });

  it('the same seed gives the same operations; another seed may differ', () => {
    for (const chip of REMIX_CHIPS) {
      expect(remixPatch(chip, base('chase_escape'), 1)).toEqual(remixPatch(chip, base('chase_escape'), 1));
    }
    expect(remixPatch('reskin', base('chase_escape'), 1)).not.toEqual(remixPatch('reskin', base('chase_escape'), 2));
  });

  it('applyRemix refuses a patch that fails or breaks the schema', () => {
    const parent = base('collect_exit');
    expect(applyRemix(parent, [{ op: 'remove', path: '/mechanics/9' }]).ok).toBe(false);
    const broken = applyRemix(parent, [{ op: 'replace', path: '/objective/count', value: 999 }]);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toBe('MALFORMED_SPEC');
  });
});

describe('classifyRemix', () => {
  const parent = base('chase_escape');
  it.each([
    ['Keep gameplay identical but make it neon sci-fi.', 'presentation'],
    ['Make the Roomba twice as fast.', 'parameter'],
    ['Make shopping carts stun the pursuer.', 'mechanic'],
    ['Make the supermarket a maze with more rooms.', 'topology'],
    ['Win by reaching the roof instead of the exit.', 'objective'],
    ['Give me 30 seconds less.', 'parameter'],
    ['Turn the whole thing into an underwater theme.', 'presentation'],
    ['Something else entirely.', 'mechanic'],
    ['Make it harder', 'parameter'],
    ['Add a twist', 'mechanic'],
    ['Swap the enemy', 'parameter'],
    ['Change the world, keep the rules', 'presentation'],
  ])('%s → %s', (sentence, expected) => {
    expect(classifyRemix(sentence, parent)).toBe(expected);
  });

  it('buildRemixRequest asks for RFC 6902 ops over the parent and names the class', () => {
    const request = buildRemixRequest('Make shopping carts stun the pursuer.', parent);
    expect(request.system).toContain('RFC6902');
    expect(request.system).toContain('MECHANICS (');
    expect(request.user).toContain(JSON.stringify(parent));
    expect(request.user).toContain('(mechanic)');
  });
});
