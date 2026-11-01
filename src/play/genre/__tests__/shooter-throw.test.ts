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
import { baseControlOf } from '@/play/arcade/addons';
import { arcadeWorldOf, compileArcade } from '@/play/arcade/compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, HIT_GRACE, ROLE, bodyBase } from '@/play/arcade/contract';
import { hashArcade, instantiate, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { type MarchEntry, shooterRules } from '@/play/arcade/pieces/shooter';
import { runBot } from '@/play/arcade/verify';
import { draftGameSpecWithMeta, draftGenreFor } from '@/play/draft';
import { classifyGenre } from '@/play/genre/classify';
import { compileGenre } from '@/play/genre';
import { type GenreModule, type GenreSpec, castFor } from '@/play/genre/contract';
import { compileWith } from '@/play/genre/index';
import { shooterGenre } from '@/play/genre/shooter';
import { ammoOf, throwClock, throwGenre } from '@/play/genre/throw';
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
  const spec = edit(legacySpec(sentence));
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

/**
 * Rychlost nepřátel podle pořadí příchodu (jednotek za tik), z počátečního stavu světa. Nepřítel držený za
 * branou (pochod průběhu P45C T13) vyjde v tiku `at` rychlostí z pochodu; předlohy (ostřelovač, výstřely) nežijí.
 */
function enemySpeeds(world: ArcadeWorld): number[] {
  const state = instantiate(world);
  const march = (baseControlOf(world.control).params.march ?? []) as MarchEntry[];
  const enemies: { arrive: number; speed: number }[] = [];
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.role] !== ROLE.enemy || ((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const held = march.find((entry) => entry.body === i);
    const speed = -(held?.vz ?? (state[base + BODY.vz] as number));
    enemies.push({ arrive: (held?.at ?? 0) + (state[base + BODY.z] as number) / speed, speed });
  }
  return enemies.sort((a, b) => a.arrive - b.arrive).map((enemy) => enemy.speed);
}

const livesOf = (world: ArcadeWorld): number => instantiate(world)[HEADER.counters + COUNTER.health] as number;

describe('shooter and throw sentences pick their genre (P36A T10)', () => {
  it.each(SHOOT)('"%s" → shooter', (sentence) => {
    const drafted = draftGameSpecWithMeta(sentence, 1);
    if (sentence.startsWith('a spaceship ')) {
      expect(drafted.composition?.recipe.move).toBe('glide');
      expect(drafted.composition?.recipe.actions).toContain('shoot');
      expect(drafted.spec.control).toBe('glide');
      expect(drafted.spec.addons).toContain('shoot');
    } else {
      expect(drafted.genre?.genre).toBe('shooter');
      expect(drafted.spec.control).toBe('shooter');
    }
  });

  // P68 T9: „mini golf …“ od zapojení minigolfu hraje minigolf (`vozidla-sport/integration.md`), ne hod.
  it.each(THROW)('"%s" → throw', (sentence) => {
    const drafted = draftGameSpecWithMeta(sentence, 1);
    expect(drafted.genre?.genre).toBe(sentence.startsWith('mini golf ') ? 'minigolf' : 'throw');
    if (!sentence.startsWith('mini golf ')) expect(drafted.spec.control).toBe('throw');
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
    const genre = draftGameSpecWithMeta(sentence, 1).genre!;
    // P39 T14: co se hází, je náboj (`ammoOf`), ne věc ke sběru.
    expect(ammoOf(genre)?.label).toBe(thrown);
    expect(castFor(genre, 'collect')).toBeUndefined();
    expect(castFor(genre, 'throw_at')?.label).toBe(target);
    expect(genre.setting).not.toBe(target);
  });

  // Věta bez věci před „at/into“: předmět za předložkou je terč, ne ještě jednou to, co se hází.
  it.each([
    ['throwing at a spinning log', 'spinning log'],
    ['toss into the bucket', 'bucket'],
  ])('"%s" does not throw the %s at itself', (sentence, target) => {
    const genre = draftGameSpecWithMeta(sentence, 1).genre!;
    expect(castFor(genre, 'throw_at')?.label).toBe(target);
    expect(ammoOf(genre)?.label).not.toBe(target);
  });
});

// P39 T7: co věta střílí, je nepřítel vln; druhá střílená věc stojí na střelnici. Hod míří na terč, hází, co se sbírá.
describe('shooter and throw read the cast', () => {
  const roleOf = (game: GameSpecV1, id: string) => game.roles.find((role) => role.id === id)?.label;

  it('the shooter takes the thing it shoots as the enemy, not the first thing named', () => {
    const game = shooterGenre.compile({ genre: 'shooter', mode: 'default', hero: 'ranger', setting: 'forest', cast: [{ label: 'wolf', does: 'avoid' }, { label: 'bat', does: 'shoot_at' }] });
    expect(roleOf(game, 'enemy')).toBe('bat');
  });

  it('a second thing to shoot stands on the range', () => {
    const game = shooterGenre.compile({ genre: 'shooter', mode: 'default', hero: 'ranger', setting: 'fair', cast: [{ label: 'zombie', does: 'shoot_at' }, { label: 'bottle', does: 'shoot_at' }] });
    expect(roleOf(game, 'enemy')).toBe('zombie');
    expect(roleOf(game, 'target')).toBe('bottle');
  });

  // P39 T14: „collect coins, dodge ghosts and shoot bats in a haunted mansion“ střílelo netopýry a na střelnici
  // stály holé terče – mince ani duchové ve hře nebyli. Volné místo terče bere další věc z věty, nejbližší role první.
  it('a thing to collect or dodge stands on the range instead of a bare bullseye', () => {
    const shooter = (cast: GenreSpec['cast']) => shooterGenre.compile({ genre: 'shooter', mode: 'default', hero: 'kid', setting: 'haunted mansion', cast });
    const mansion = shooter([{ label: 'bat', does: 'shoot_at' }, { label: 'ghost', does: 'avoid' }, { label: 'coin', does: 'collect' }]);
    expect(roleOf(mansion, 'enemy')).toBe('bat');
    expect(roleOf(mansion, 'target')).toBe('coin');
    expect(roleOf(shooter([{ label: 'bat', does: 'shoot_at' }, { label: 'ghost', does: 'avoid' }]), 'target')).toBe('ghost');
    // P61 T3: jediný protivník věty stojí i na střelnici – holé kotouče soudce četl jako střelnici bez vlka.
    expect(roleOf(shooter([{ label: 'wolf', does: 'chase_me' }]), 'target')).toBe('wolf');
    // Kotouč zůstane jen hře, kde věta nejmenuje nic.
    expect(roleOf(shooter([]), 'target')).toBe('target');
    const drafted = draftGameSpecWithMeta('collect coins, dodge ghosts and shoot bats in a haunted mansion', 1).spec;
    expect(drafted.roles.map((role) => role.label)).toEqual(expect.arrayContaining(['bat', 'coin']));
  });

  it('the throw hits the thing it is thrown at with the thing it collects', () => {
    const game = throwGenre.compile({ genre: 'throw', mode: 'default', hero: 'kid', setting: 'park', cast: [{ label: 'snowball', does: 'collect' }, { label: 'snowman', does: 'throw_at' }] });
    expect(roleOf(game, 'target')).toBe('snowman');
    expect(roleOf(game, 'ball')).toBe('snowball');
  });

  // P39 T14: co hrdina hází, je náboj, ne věc ke sběru. „grabs acorns … throws pinecones“ házelo v AI verzi žaludy,
  // protože náboj i žalud byly v obsazení `collect` a hod vzal první.
  it('casts what the hero throws as its ammo, not as a thing to collect', () => {
    const drafted = draftGameSpecWithMeta('a squirrel grabs acorns, dodges owls and throws pinecones at a fox', 1);
    expect(drafted.genre?.genre).toBe('throw');
    expect(drafted.genre?.cast).toContainEqual({ label: 'pinecone', does: 'scenery', verb: 'throw' });
    expect(drafted.genre?.cast?.filter((item) => item.does === 'collect').map((item) => item.label)).toEqual(['acorn']);
    expect(roleOf(drafted.spec, 'ball')).toBe('pinecone');
  });

  it('the throw throws its ammo even when a thing to collect comes first', () => {
    const cast = [{ label: 'acorn', does: 'collect' as const }, { label: 'pinecone', does: 'scenery' as const, verb: 'throw' }, { label: 'fox', does: 'throw_at' as const }];
    const game = throwGenre.compile({ genre: 'throw', mode: 'default', hero: 'squirrel', setting: 'forest', cast });
    expect(roleOf(game, 'ball')).toBe('pinecone');
    expect(roleOf(game, 'target')).toBe('fox');
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

  // Rozpočet a hodiny jsou dvě pole uložené hry: remix „only 40 seconds“ přepíše jen hodiny (review F5).
  // Koš s rozpočtem 48 hraje 8 kol 43–45 s; ve 40 s se vejdou 2 kola.
  it('a remix that shortens only the clock still plays its rounds inside it', () => {
    const shorter = (spec: GameSpecV1): GameSpecV1 => ({
      ...spec,
      mechanics: spec.mechanics.map((mechanic) => (mechanic.id === 'timer' ? { ...mechanic, params: { ...mechanic.params, seconds: 40 } } : mechanic)),
    });
    const game = publish('basketball free throws', shorter);
    expect(game.spec.controlParams).toMatchObject({ budget: 48 });
    expect(game.world.rules.some((rule) => rule.id === 'throw_rounds')).toBe(true);
    expect(game.winSeconds).toBeLessThanOrEqual(40);
    expect(game.idle.outcome).toBe('lost');
  });

  // Hodiny 180 s (časovač je dovolí) jádro ořízne na 90 s horizontu: rozpočet 90 kol se plánuje do 90 s, ne do 180 s.
  // Bez ořezu by 180 s dalo rozpočet 90 a 12 kol, která robot ve hře s hodinami 90 s nestihne s rezervou.
  it('a clock beyond the verification horizon plans the rounds into the 90 s the kernel keeps', () => {
    const clocked = (seconds: number) => (spec: GameSpecV1): GameSpecV1 => ({
      ...spec,
      controlParams: { ...(spec.controlParams as Record<string, unknown>), budget: 90 },
      mechanics: spec.mechanics.map((mechanic) => (mechanic.id === 'timer' ? { ...mechanic, params: { ...mechanic.params, seconds } } : mechanic)),
    });
    const game = publish('basketball free throws', clocked(180));
    expect(game.world.rules.some((rule) => rule.id === 'throw_rounds')).toBe(true);
    expect(game.world).toEqual(publish('basketball free throws', clocked(90)).world);
    expect(game.winSeconds).toBeLessThanOrEqual(90);
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
  it.each(['angry birds but with cats and cardboard boxes', 'bowling in a haunted alley', 'slingshot fruit at a giant blender'])('"%s": the robot wins, an idle player loses on the clock', (sentence) => {
    const game = publish(sentence);
    expect(game.idle.outcome).toBe('lost');
    expect(game.idle.seconds).toBeLessThanOrEqual(90);
    expect(game.world.rules.find((rule) => rule.id === 'shot_hit')?.params).toHaveProperty('combo');
  });
});

/** Frozen pre-P41 mechanics: routing to new movement families is tested separately. */
function legacySpec(sentence: string): GameSpecV1 {
  const pick = classifyGenre(sentence, null).ranked[0];
  const genre = draftGenreFor(sentence, pick.genre, pick.mode);
  if (genre === null) throw new Error(`missing legacy fixture: ${sentence}`);
  return compileGenre(genre);
}
