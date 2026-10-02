/**
 * Střílečka a hod zpátky jako žánry (P36A T10): věty „shoot …“ a „throw …“
 * z poptávky dostanou svůj žánr místo Úkolu, střílečka má životy s milostí,
 * vlny na 30–90 s, které zrychlují, a kombo; hod má hodiny, takže nečinný
 * hráč prohraje, a kombo.
 *
 * Co by vypadalo dobře a bylo špatně: žánr existuje, ale klasifikátor posílá
 * „shoot“ dál do Úkolu; střílečka má tři životy, které padnou v jednom
 * dotyku vlny; vlny jsou, ale každá stejně rychlá; hod na nečinného hráče
 * čeká do konce horizontu. A uložená střelnice bez nových polí by se po
 * změně přehrála jinak. Hra se staví stejnou cestou jako z `/play` – rychlý
 * návrh, semínka publikace, robot a nečinný hráč.
 */

import { describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { compileArcade } from '@/play/arcade/compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, COUNTER, HEADER, HIT_GRACE, ROLE, bodyBase } from '@/play/arcade/contract';
import { instantiate, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { shooterRules } from '@/play/arcade/pieces/shooter';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

/** Věty poptávky (`evals/play/demand/corpus.json`), kde hráč střílí. */
const SHOOT = [
  'A space marine shoots alien bugs in a mining colony',
  'shooting game',
  'zombie shooter in a mall',
  'shoot balloons with a bow before they fly away',
  'a spaceship shooting asteroids and ufos, retro vibes',
  'shooting range with bottles and targets',
  'fps where u shoot paint at robots',
  'shoot the ghosts in a haunted carnival shooting gallery',
];

/** Věty poptávky, kde hráč hází, odpaluje nebo kutálí. */
const THROW = [
  'angry birds but with cats and cardboard boxes',
  'ragdoll falling down stairs and breaking bones for points',
  'knock down towers with a wrecking ball',
  'slingshot fruit at a giant blender',
  'mini golf with windmills and loops',
  'bowling in a haunted alley',
  'pool billiards trick shots',
];

interface Published {
  readonly spec: GameSpecV1;
  readonly world: ArcadeWorld;
  readonly winSeconds: number;
  readonly idle: { readonly outcome: string; readonly seconds: number };
}

/** Jako dveře publikace: první semínko, na kterém robot vyhraje. */
function publish(sentence: string, edit: (spec: GameSpecV1) => GameSpecV1 = (spec) => spec): Published {
  const spec = edit(draftGameSpecWithMeta(sentence, 1).spec);
  for (const seed of derivedSeeds(seedFrom(sentence))) {
    const compiled = compileArcade(spec, seed);
    if (!compiled.ok) continue;
    const { arcade: world, winsAtTick } = compiled.value;
    if (world == null || winsAtTick === null) continue;
    const idle = replay(world, [], ARCADE_LIBRARY);
    return { spec, world, winSeconds: winsAtTick / ARCADE_HZ, idle: { outcome: idle.outcome, seconds: idle.tick / ARCADE_HZ } };
  }
  throw new Error(`${sentence}: no seed publishes`);
}

/** Rychlost nepřátel podle pořadí příchodu (jednotek za tik), z počátečního stavu světa. */
function enemySpeeds(world: ArcadeWorld): number[] {
  const state = instantiate(world);
  const enemies: { arrive: number; speed: number }[] = [];
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.role] !== ROLE.enemy) continue;
    const speed = -(state[base + BODY.vz] as number);
    enemies.push({ arrive: (state[base + BODY.z] as number) / speed, speed });
  }
  return enemies.sort((a, b) => a.arrive - b.arrive).map((enemy) => enemy.speed);
}

const livesOf = (world: ArcadeWorld): number => instantiate(world)[HEADER.counters + COUNTER.health] as number;

describe('shooter and throw sentences pick their genre (P36A T10)', () => {
  it.each(SHOOT)('"%s" → shooter', (sentence) => {
    const drafted = draftGameSpecWithMeta(sentence, 1);
    expect(drafted.genre?.genre).toBe('shooter');
    expect(drafted.spec.control).toBe('shooter');
  });

  it.each(THROW)('"%s" → throw', (sentence) => {
    const drafted = draftGameSpecWithMeta(sentence, 1);
    expect(drafted.genre?.genre).toBe('throw');
    expect(drafted.spec.control).toBe('throw');
  });

  it('popping, smashing and zapping stay a quest', () => {
    expect(draftGameSpecWithMeta('pop the balloons at the fair', 1).genre?.genre).toBe('quest');
  });

  // Co se hází a na co: špatně přečtená věta dá hratelnou hru s polenem místo nože – na snímku by to nikdo nehledal.
  it.each([
    ['knife throwing at a spinning log', 'knife', 'spinning log'],
    ['throwing snowballs at kids behind a snow fort', 'snowball', 'kid'],
    ['throw a basketball into a hoop from crazy angles', 'basketball', 'hoop'],
    ['angry birds but with cats and cardboard boxes', undefined, 'cardboard box'],
  ])('"%s" throws %s at the %s', (sentence, thrown, target) => {
    const genre = draftGameSpecWithMeta(sentence, 1).genre;
    expect(genre?.collectible).toBe(thrown);
    expect(genre?.target?.label).toBe(target);
    expect(genre?.setting).not.toBe(target);
  });
});

describe('the shooter genre has depth', () => {
  it.each(['A space marine shoots alien bugs in a mining colony', 'zombie shooter in a mall', 'shoot the ghosts in a haunted carnival shooting gallery'])(
    '"%s": the robot wins in 30–90 s, an idle player loses, three lives',
    (sentence) => {
      const game = publish(sentence);
      expect(game.winSeconds).toBeGreaterThanOrEqual(30);
      expect(game.winSeconds).toBeLessThanOrEqual(90);
      expect(game.idle.outcome).toBe('lost');
      expect(livesOf(game.world)).toBe(3);
    },
  );

  it('each later wave walks in faster than the one before', () => {
    const speeds = enemySpeeds(publish('zombie shooter in a mall').world);
    expect(speeds.length).toBeGreaterThan(3);
    expect(speeds.at(-1)!).toBeGreaterThan(speeds[0]!);
    for (let k = 1; k < speeds.length; k += 1) expect(speeds[k]!).toBeGreaterThanOrEqual(speeds[k - 1]!);
  });

  it('an enemy that reaches the player takes one life and a moment of grace', () => {
    const rules = publish('zombie shooter in a mall').world.rules;
    expect(rules).toContainEqual({ id: 'hit', params: { role: 'enemy', effect: 'damage', grace: HIT_GRACE } });
  });

  it('hits in a row build a combo and the run ends with a bonus', () => {
    const rules = publish('zombie shooter in a mall').world.rules;
    expect(rules.find((rule) => rule.id === 'shot_hit')?.params).toHaveProperty('combo');
    expect(rules.some((rule) => rule.id === 'score_bonus')).toBe(true);
  });

  it('a stored shooter range without the new fields keeps its rules', () => {
    expect(shooterRules({ difficulty: 'normal', moving: true }, 3)).toContainEqual({ id: 'hit', params: { role: 'enemy', effect: 'damage' } });
  });
});

describe('the throw genre has a clock', () => {
  it.each(['angry birds but with cats and cardboard boxes', 'bowling in a haunted alley', 'mini golf with windmills and loops'])('"%s": the robot wins, an idle player loses on the clock', (sentence) => {
    const game = publish(sentence);
    expect(game.idle.outcome).toBe('lost');
    expect(game.idle.seconds).toBeLessThanOrEqual(90);
    expect(game.world.rules.find((rule) => rule.id === 'shot_hit')?.params).toHaveProperty('combo');
  });
});
