/**
 * Dash a štít ve složené hře, která nemá čím ublížit (P47B T5). Závod se soupeři: soupeřova
 * auta nenarážejí a svodidla (`steer_crash`) robot objíždí jako kraj silnice, takže štít neměl
 * co zastavit a věta ho ztratila (`VERB_UNPROVED:shield`). Hra teď dostane nepřátele na trati
 * jako bez svodidel (`addFoes`, náraz `hit`), robot intermediate do nich najede se štítem a
 * ověření sloveso dokáže. Padající díl na řízení nejde – auto pod ním projede (T4).
 *
 * Sběr mušlí v aréně pronásledovatele má (přijdou ve vlnách) a dokázal štít už před T5:
 * hra, která má čím ublížit, zůstane, jak byla. Hra bez dashe a štítu nové tělo nedostane.
 */

import { createHash } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '../../../draft';
import type { GameSpecV1 } from '../../../spec';
import { arcadeWorldOf } from '../../compile';
import { ARCADE_LIMITS, type ArcadeWorld, BUTTON, HEADER, type InputEvent, NO_INPUT, underlyingRule } from '../../contract';
import { instantiate, loadProgram, outcomeOf, step } from '../../kernel';
import { ARCADE_LIBRARY } from '../../library';
import { loadRapier } from '../../physics/world';
import { runBot, verifyArcade } from '../../verify';

const SEEDS = [1, 2, 3, 4];

beforeAll(async () => {
  // Návrh věty ověřuje svět robotem: fyzika načtená dřív, jako na živé cestě.
  await loadRapier();
});

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Kolikrát pravidlo `rule` při vstupech `inputs` nechalo tělo zmizet. */
function despawnsBy(world: ArcadeWorld, inputs: readonly InputEvent[], rule: string): number {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const ids = world.rules.map((ref) => underlyingRule(ref).id);
  const byTick = new Map(inputs.map((event) => [event.tick, event]));
  let count = 0;
  for (let tick = 0; tick < ARCADE_LIMITS.maxTicks && outcomeOf(state) === 'running'; tick += 1) {
    step(state, byTick.get(tick) ?? NO_INPUT, program, (index, effect) => {
      if (ids[index] === rule && effect.kind === 'despawn') count += 1;
    });
  }
  return count;
}

// Věty psané pro tenhle test, ne ze sad měření.
const SENTENCES = [
  ['steer', 'a car races and blocks rivals'],
  ['move_free', 'a kid shields herself while collecting shells'],
] as const;

describe('P47B T5: a shield sentence keeps its action when the game has something to stop', () => {
  it.each(SENTENCES)('%s ("%s"): the intermediate bot blocks a body with the shield and the verb is proved', (control, text) => {
    for (const seed of SEEDS) {
      const { spec, composition } = draftGameSpecWithMeta(text, seed);
      expect(spec.control).toBe(control);
      expect(spec.abilities, `seed ${seed}: ${(composition?.issues ?? []).join(' | ')}`).toEqual(['shield']);
      const world = worldOf(spec, seed);
      const run = runBot(world, undefined, { profile: 'intermediate' });
      expect(run.inputs.some((event) => (event.buttons & BUTTON.ACTION_A) !== 0), `seed ${seed}: never pressed`).toBe(true);
      expect(despawnsBy(world, run.inputs, 'ability_shield'), `seed ${seed}: the shield never blocked`).toBeGreaterThan(0);
      const verdict = verifyArcade(world);
      expect(verdict.failures, `seed ${seed}`).toEqual([]);
      expect(verdict.verbs.find((proof) => proof.verb === 'shield')?.changed, `seed ${seed}`).toBe(true);
    }
  }, 300_000);

  it('the race gets foes on the track with a hit, guarded by the shield next to the barriers', () => {
    const world = worldOf(draftGameSpecWithMeta('a car races and blocks rivals', 1).spec, 1);
    const rules = world.rules.map(underlyingRule);
    expect(rules.find((rule) => rule.id === 'hit')?.params).toMatchObject({ role: 'enemy' });
    expect(rules.find((rule) => rule.id === 'ability_shield')?.params.roles).toEqual(['obstacle', 'enemy']);
    expect(world.kinds).toContain('enemy');
  });

  it('a level with no place for a foe gets an issue, not a silent drop', () => {
    // Uložená aréna bez vln: sběr bez pronásledovatelů, a aréna nepřátele ovládání nemá kam dát.
    const { spec } = draftGameSpecWithMeta('a kid shields herself while collecting shells', 1);
    const made = arcadeWorldOf({ ...spec, controlParams: { generator: 'arena_collect', tuning: { items: 10 } } } as GameSpecV1, 1);
    expect(made.ok).toBe(false);
    expect(made.ok ? [] : made.issues).toContain('abilities: the level has no place for an enemy to strike');
  });
});

/**
 * Otisk světa: `JSON.stringify` přes SHA-256, prvních 16 znaků. Bez férového startu (`fairStart`, P70A T3 `genre.v8`):
 * test hlídá, že štít svět nezmění, a férový start nese každá nová hra.
 */
const fingerprint = ({ fairStart: _fair, ...world }: ArcadeWorld): string => createHash('sha256').update(JSON.stringify(world)).digest('hex').slice(0, 16);

// Změřeno s `abilities/index.ts` před T5 (158b8262), návrh i svět na semínku 1. Sběr mušlí po sloučení
// s P47A (`genre.v4`, nápor v aréně) přeměřen na samotné P47A: týž otisk jako sloučená větev.
// P51 (`genre.v5`: finále, tep pole) dává nové hře nový otisk; uložená `genre.v4` staví dál 3eaf0928… a 327f61dd…
// (piny uložených světů P51 ve `stored-v4-p51.json`). Přeotisknuto při slučování P51 do main, ať main nezůstane červený.
// P66 T10 (`genre.v6`): přeotisknuto – nová hra má pravidlo háčků (létající skóre, u chytání vzácnost a počítadlo).
// T10a: sběr se štítem má jen létající skóre, počítadlo nedostane.
const HARMFUL = [
  ['a kid shields herself while collecting shells', 'd47d70edab3d9193'],
  ['a squirrel runs and blocks falling acorns', '875b1bae1efbac1c'],
] as const;

describe('P47B T5: a game that already has something harmful builds the world it had before', () => {
  it.each(HARMFUL)('"%s"', (text, before) => {
    const { spec } = draftGameSpecWithMeta(text, 1);
    expect(spec.abilities).toEqual(['shield']);
    expect(fingerprint(worldOf(spec, 1))).toBe(before);
  });
});

// [věta, počet těl na semínkách 1–4] – změřeno s `abilities/index.ts` před T5 (158b8262).
// Krádež v závodě: kořist (turbo) má, nepřátele nedostane a ublížit může jen svodidly – jako závod se štítem před T5.
const PLAIN = [
  ['a car races rivals', [137, 141, 132, 134]],
  ['a car races rivals and shoots them', [142, 146, 137, 139]],
  ['a car races rivals and grabs turbo', [138, 142, 133, 135]],
  // Po sloučení s P47A (`genre.v4`): o 7 těl víc přidá nápor arény, ne akce – na samotné P47A týž počet.
  // P66 T10 (`genre.v6`): +1 tělo – počítadlo háčků kol sběru; uchopení má jen létající skóre a tělo navíc nemá (T10a).
  // P83A T3: sběr první minuty (`FIRST_MINUTE`) – 8 věcí první vlny místo 10, o 2 těla méně.
  ['a kid collects shells', [26, 27, 25, 27]],
  ['a kid grabs shells', [25, 26, 24, 26]],
] as const;

describe('P47B T5: a game without dash or shield gets no extra body', () => {
  it.each(PLAIN)('"%s"', (text, counts) => {
    const built = SEEDS.map((seed) => {
      const { spec } = draftGameSpecWithMeta(text, seed);
      expect(spec.abilities ?? []).not.toContain('dash');
      expect(spec.abilities ?? []).not.toContain('shield');
      return instantiate(worldOf(spec, seed))[HEADER.bodyCount];
    });
    expect(built).toEqual(counts);
  }, 120_000);
});
