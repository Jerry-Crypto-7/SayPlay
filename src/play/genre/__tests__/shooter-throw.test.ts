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
import throwFixture from '@/play/arcade/__fixtures__/throw.json';
import { arcadeWorldOf, compileArcade } from '@/play/arcade/compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, COUNTER, HEADER, HIT_GRACE, ROLE, bodyBase } from '@/play/arcade/contract';
import { hashArcade, instantiate, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { shooterRules } from '@/play/arcade/pieces/shooter';
import { runBot } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GenreModule, GenreSpec } from '@/play/genre/contract';
import { compileWith } from '@/play/genre/index';
import { throwClock, throwGenre } from '@/play/genre/throw';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

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

/**
 * Hod v kolech (P36A F5): jedno pole robot vyčistí za 5–13 s, takže hra bez
 * kol je mimo pásmo 30–90 s. Co by vypadalo dobře a bylo špatně: kola
 * existují v kusu jádra, ale žánr mu rozpočet nepošle; nebo pošle a hodiny
 * zůstanou 30 s, takže robot prohraje na čase; nebo čas z věty hodiny přepíše
 * až po překladu a kola se do něj nevejdou.
 */
describe('the throw genre comes in rounds', () => {
  it.each(['bowling in a haunted alley', 'basketball free throws', 'angry birds but with cats and cardboard boxes'])(
    '"%s": the robot wins in 30–90 s over several rounds, an idle player loses',
    (sentence) => {
      const game = publish(sentence);
      expect(game.winSeconds).toBeGreaterThanOrEqual(30);
      expect(game.winSeconds).toBeLessThanOrEqual(90);
      expect(game.world.rules.some((rule) => rule.id === 'throw_rounds')).toBe(true);
      expect(game.idle.outcome).toBe('lost');
    },
  );

  // Hodiny z věty: kola se plánují do nich, ne do výchozích 87 s.
  it('seconds from the sentence are the clock the rounds fit into', () => {
    expect(throwClock(undefined)).toEqual({ budget: 48, seconds: 87 });
    expect(throwClock(45)).toEqual({ budget: 20, seconds: 45 });
    expect(throwClock(20)).toEqual({ budget: 3, seconds: 20 });
    // Jako odpověď režiséra s `timeLimit`: hodiny jdou do modulu před překladem.
    const genre = draftGameSpecWithMeta('bowling in a haunted alley', 1).genre as GenreSpec;
    const game = publish('bowling in a haunted alley', () => compileWith(throwGenre as GenreModule, { ...genre, params: { ...genre.params, timeLimit: 45 } }));
    expect(game.spec.controlParams).toMatchObject({ budget: 20 });
    expect(game.spec.mechanics).toContainEqual({ id: 'timer', params: { id: 'clock', seconds: 45, onEnd: 'lose' } });
    expect(game.winSeconds).toBeLessThanOrEqual(45);
  });
});

/**
 * Uložené hry hodu bez rozpočtu (P36A F5) staví týž svět – počáteční stav,
 * tik a hash výhry robota i hash nečinného hráče změřené na `79a412a9` (před
 * koly). Hodiny 30 s jako hra žánru z T10, `fixture` bez hodin jako hra před P36A.
 */
const STORED_THROW = [
  ['fixture', '57cde84e', 777, 'ff0295d0', '4ca5d739'],
  ['target.easy', '6cecfe2a', 140, 'd6697f17', '6ca536b4'],
  ['hoop.easy', 'e563a0de', 157, '56eeb72e', '2666a3c0'],
  ['tower.easy', '33273ea8', 278, '0d54a3c3', 'fc2873a6'],
  ['target.normal', '2f524ba8', 256, '9a0184c4', '5b0a1e22'],
  ['hoop.normal', '1e0e1598', 281, 'd99ef966', 'b63d58f6'],
  ['tower.normal', 'c6efecf8', 803, 'fca4394f', 'ca546d8e'],
  ['target.hard', '7e53de2c', 281, 'bdeb1a93', '4500899a'],
  ['hoop.hard', '9241eb88', 298, 'fa41fac4', 'dabf171a'],
  ['tower.hard', '0c4954d8', 1166, 'bd7a9c04', 'c0d0f6ba'],
] as const;

describe('stored throw games without a budget build the world they had before rounds', () => {
  it.each(STORED_THROW)('%s', (name, initial, tick, won, idle) => {
    const [goal, difficulty] = name.split('.');
    const clock = difficulty !== undefined;
    const spec = readGameSpec({
      ...throwFixture,
      controlParams: clock ? { difficulty, goal } : { difficulty: 'normal' },
      mechanics: clock ? [{ id: 'timer', params: { id: 'clock', seconds: 30, onEnd: 'lose' } }] : [],
    });
    if (!spec.ok) throw new Error(spec.issues.join('; '));
    const made = arcadeWorldOf(spec.value, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const bot = runBot(made.world);
    expect(hashArcade(instantiate(made.world))).toBe(initial);
    expect(bot.tick).toBe(tick);
    expect(bot.hash).toBe(won);
    expect(replay(made.world, [], ARCADE_LIBRARY).hash).toBe(idle);
    expect(made.world.rules.some((rule) => rule.id === 'throw_rounds')).toBe(false);
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
